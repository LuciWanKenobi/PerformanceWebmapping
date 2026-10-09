#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Download ICON GRIB2 files from DWD (parallel) — performance-tuned

What's new vs your original:
  • Separate network + CPU stages (optional): download first, then decompress in a controlled post-phase.
  • Throttling: limit download bandwidth with --throttle-mbps to keep the PC responsive.
  • Priority: lower process/IO priority with --nice (uses psutil if available).
  • Tunable workers: --net-workers and --cpu-workers (decompression uses a ProcessPool).
  • Optional fsync skip: --no-fsync avoids heavy disk flushes (safer to keep default fsync).
  • Backwards compatible flags still work (e.g., --workers).

Examples (PowerShell):
  # "Calm" mode: 4 download threads, 1 CPU worker, 12 Mbps cap, decompress later
  python .\\download_icon.py --model icon-eu `
    --cycle latest `
    --vars t_2m ps hhl `
    --fcst-range 0 24 3 `
    --levels all `
    --out-dir .\\data\\iconeu `
    --decompress `
    --decompress-phase post `
    --net-workers 4 `
    --cpu-workers 1 `
    --throttle-mbps 12 `
    --nice

  # Legacy behavior but with fewer workers
  python .\\download_icon.py --model icon-eu --cycle 12 --vars t qv u v p t_2m ps hhl \
    --fcst-range 0 120 3 --levels all --out-dir .\\iconeu --decompress \
    --net-workers 4 --cpu-workers 1 --decompress-phase inline
max Speed:
python .\\download_icon.py --model icon-eu --cycle latest --vars ceiling hsurf lpi_con_max clct clch clcm clcl rain_gsp snow_gsp tot_prec vmax_10m vis t_2m ps rain_con snow_con u v p hhl --fcst-range 0 120 3 --levels all --out-dir .\\iconeu --decompress --decompress-phase post --net-workers 16 --cpu-workers $(Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors --no-fsync

calm:
python .\\download_icon.py --model icon-eu --cycle latest --vars ceiling hsurf lpi_con_max clct clch clcm clcl rain_gsp snow_gsp tot_prec vmax_10m vis t_2m ps rain_con snow_con u v p hhl --fcst-range 0 120 3 --levels all --out-dir .\\iconeu --decompress --decompress-phase post --net-workers 4 --cpu-workers 1 --throttle-mbps 12 --nice

"""

import argparse
import bz2
from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor, as_completed
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import threading
import tempfile
from typing import Dict, List, Optional, Set, Tuple
from urllib.parse import urlparse, urlunparse, quote
import time
import subprocess

import requests
from bs4 import BeautifulSoup

try:
    from tqdm import tqdm
except Exception:
    tqdm = None

# robust retries (optional)
try:
    from urllib3.util.retry import Retry
    from requests.adapters import HTTPAdapter
except Exception:
    Retry = None
    HTTPAdapter = None

# --------------------------------------------------------------------
# Model config
# --------------------------------------------------------------------
BASE_URL = ""
MODEL_NAME = "icon-eu"
MODEL_LABEL = "ICON-EU"
MODEL_USER_AGENT = "icon-eu-downloader/1.4 (+contact@example.com)"
VAR_RE = r"(?P<var>[A-Za-z0-9_\-]+)"
RE_MODEL = re.compile(r"$^")
RE_SINGLE = re.compile(r"$^")
RE_TIMEINV_PROFILE = re.compile(r"$^")
RE_TIMEINV_2D = re.compile(r"$^")
RE_PRESSURE = re.compile(r"$^")
TIMEINV_2D_VARS: Set[str] = set()


CLASSIC_MODEL_CONFIGS: Dict[str, Dict[str, object]] = {
    "icon-d2": {
        "label": "ICON-D2",
        "base_url": "https://opendata.dwd.de/weather/nwp/icon-d2/grib/{cycle}/{var}/",
        "filename_prefix": "icon-d2_germany_regular-lat-lon",
        "single_has_2d": True,
        "timeinv_profile_has_fcst": True,
        "timeinv_2d_has_fcst_level": True,
        "pressure_level_digits": "1,3",
        "user_agent": "icon-d2-downloader/1.4 (+contact@example.com)",
        "single_level_vars": {
            "u_10m", "v_10m", "relhum_2m", "ceiling", "lpi_max", "lpi", "dbz_cmax", "dbz_ctmax", "dbz_850",
            "clch", "clcm", "clcl", "clct", "clct_mod", "cldepth", "prg_gsp", "prr_gsp", "prs_gsp", "rain_con",
            "snow_con", "rain_gsp", "snow_gsp", "grau_gsp", "hail_gsp", "ww", "tot_prec", "vmax_10m", "vis", "t_2m", "tmax_2m", "tmin_2m", "ps", "cape_ml", "h_snow", "hzerocl",
            "rho_snow", "hbas_sc", "htop_sc", "pmsl", "snowlmt", "tqv_dia", "echotop", "sdi_2",
            "synmsg_bt_cl_ir10.8", "td_2m", 
        },
        "timeinv_2d_vars": {"hsurf"},
    },
    "icon-eu": {
        "label": "ICON-EU",
        "base_url": "https://opendata.dwd.de/weather/nwp/icon-eu/grib/{cycle}/{var}/",
        "filename_prefix": "icon-eu_europe_regular-lat-lon",
        "single_has_2d": False,
        "timeinv_profile_has_fcst": False,
        "timeinv_2d_has_fcst_level": False,
        "pressure_level_digits": "1,4",
        "user_agent": "icon-eu-downloader/1.4 (+contact@example.com)",
        "single_level_vars": {
            "u_10m", "v_10m", "relhum_2m", "ceiling", "lpi_con_max",
            "clch", "clcm", "clcl", "clct", "clct_mod", "cldepth", "rain_gsp", "snow_gsp", "rain_con",
            "snow_con", "ww", "tot_prec", "vmax_10m", "vis", "t_2m", "tmax_2m", "tmin_2m", "ps", "cape_ml", "h_snow", "hzerocl",
            "rho_snow", "cape_con", "hbas_con", "htop_con", "pmsl", "snowlmt", "tqv",
            "synmsg_bt_cl_ir10.8", "td_2m", "aswdifd_s", "aswdifu_s", "aswdir_s", "athb_s", "t_g",
        },
        "timeinv_2d_vars": {"hsurf"},
    },
    "icon": {
        "label": "ICON",
        "base_url": "https://opendata.dwd.de/weather/nwp/icon/grib/{cycle}/{var}/",
        "filename_prefix": "icon_global_icosahedral",
        "single_has_2d": False,
        "timeinv_profile_has_fcst": False,
        "timeinv_2d_has_fcst_level": False,
        "pressure_level_digits": "1,4",
        "user_agent": "icon-downloader/1.4 (+contact@example.com)",
        "single_level_vars": {
            "u_10m", "v_10m", "relhum_2m", "ceiling", "lpi_con_max",
            "clch", "clcm", "clcl", "clct", "clct_mod", "cldepth", "rain_gsp",
            "snow_gsp", "rain_con", "snow_con", "ww", "tot_prec", "vmax_10m",
            "vis", "t_2m", "tmax_2m", "tmin_2m", "ps", "cape_ml", "h_snow", "hzerocl", "pmsl",
            "snowlmt", "tqv", "synmsg_bt_cl_ir10.8", "td_2m", "hbas_con", "htop_con"
        },
        "timeinv_2d_vars": {"hsurf", "clat", "clon"},
    },
}


# --------------------------------------------------------------------
# Variable category mapping
# --------------------------------------------------------------------
MODEL_LEVEL_VARS = {"t", "qv", "u", "v", "p", "tke", "clc"}
SINGLE_LEVEL_VARS: Set[str] = set()
TIME_INVAR_VARS = {"hhl", "hsurf", "clat", "clon"}
PRESSURE_LEVEL_VARS = {"fi", "omega", "t", "relhum", "clc", "u", "v"}
PRESSURE_LEVELS_STANDARD = {
    1000,
    950,
    850,
    700,
    600,
    500,
    400,
    300,
    250,
    200,
}

# --------------------------------------------------------------------
# Tunables / globals (set from args in main)
# --------------------------------------------------------------------
CHUNK_SIZE = 1 << 17  # 128 KiB
DO_FSYNC = True
THROTTLE_BPS: Optional[float] = None  # bytes/sec, None for unlimited
RUN_STAMP_RE = re.compile(r"_(\d{10})_")

# --------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------
print_lock = threading.Lock()
_thread_local = threading.local()


def _compile_classic_regexes(prefix: str, config: Dict[str, object]) -> Tuple[re.Pattern, re.Pattern, re.Pattern, re.Pattern, re.Pattern]:
    escaped_prefix = re.escape(prefix)
    level_digits = str(config["pressure_level_digits"])
    single_extra = r"\s*2d_\s*" if bool(config["single_has_2d"]) else ""
    if bool(config["timeinv_profile_has_fcst"]):
        timeinv_profile_middle = r"(?P<run>\d{10})_\s*(?P<fcst>\d{3})_\s*(?P<level>\d{1,3})_"
    else:
        timeinv_profile_middle = r"(?P<run>\d{10})_\s*(?P<level>\d{1,3})_"
    if bool(config["timeinv_2d_has_fcst_level"]):
        timeinv_2d_middle = r"(?P<run>\d{10})_\s*(?P<fcst>\d{3})_\s*(?P<level>\d{1,3})_"
    else:
        timeinv_2d_middle = r"(?P<run>\d{10})_"

    return (
        re.compile(
            rf"""^{escaped_prefix}_model-level_
                (?P<run>\d{{10}})_
                (?P<fcst>\d{{3}})_
                (?P<level>\d{{1,3}})_
                {VAR_RE}\.grib2(?:\.bz2)?$""",
            re.VERBOSE,
        ),
        re.compile(
            rf"""^{escaped_prefix}_single-level_
                (?P<run>\d{{10}})_
                (?P<fcst>\d{{3}})_
                {single_extra}
                {VAR_RE}\.grib2(?:\.bz2)?$""",
            re.VERBOSE,
        ),
        re.compile(
            rf"""^{escaped_prefix}_time-invariant_
                {timeinv_profile_middle}
                {VAR_RE}\.grib2(?:\.bz2)?$""",
            re.VERBOSE,
        ),
        re.compile(
            rf"""^{escaped_prefix}_time-invariant_
                {timeinv_2d_middle}
                {VAR_RE}\.grib2(?:\.bz2)?$""",
            re.VERBOSE,
        ),
        re.compile(
            rf"""^{escaped_prefix}_pressure-level_
                (?P<run>\d{{10}})_
                (?P<fcst>\d{{3}})_
                (?P<level>\d{{{level_digits}}})_
                {VAR_RE}\.grib2(?:\.bz2)?$""",
            re.VERBOSE,
        ),
    )


def configure_classic_model(model: str) -> None:
    model_key = str(model).strip().lower()
    if model_key not in CLASSIC_MODEL_CONFIGS:
        supported = ", ".join(sorted(CLASSIC_MODEL_CONFIGS))
        raise ValueError(f"unsupported model '{model}'. Supported: {supported}")
    config = CLASSIC_MODEL_CONFIGS[model_key]
    prefix = str(config["filename_prefix"])

    global BASE_URL, MODEL_NAME, MODEL_LABEL, MODEL_USER_AGENT
    global SINGLE_LEVEL_VARS, TIMEINV_2D_VARS
    global RE_MODEL, RE_SINGLE, RE_TIMEINV_PROFILE, RE_TIMEINV_2D, RE_PRESSURE

    BASE_URL = str(config["base_url"])
    MODEL_NAME = model_key
    MODEL_LABEL = str(config["label"])
    MODEL_USER_AGENT = str(config["user_agent"])
    SINGLE_LEVEL_VARS = set(config["single_level_vars"])  # type: ignore[arg-type]
    TIMEINV_2D_VARS = set(config["timeinv_2d_vars"])  # type: ignore[arg-type]
    RE_MODEL, RE_SINGLE, RE_TIMEINV_PROFILE, RE_TIMEINV_2D, RE_PRESSURE = _compile_classic_regexes(prefix, config)


def categories_for_var(var: str) -> List[str]:
    v = var.lower()
    categories: List[str] = []
    if v in MODEL_LEVEL_VARS:
        categories.append("model")
    if v in SINGLE_LEVEL_VARS:
        categories.append("single")
    if v in TIME_INVAR_VARS:
        categories.append("timeinv")
    if v in PRESSURE_LEVEL_VARS:
        categories.append("plevel")
    if categories:
        return categories
    raise ValueError(
        f"Unknown variable '{var}'. Add it to MODEL_LEVEL_VARS, SINGLE_LEVEL_VARS, "
        f"TIME_INVAR_VARS, or PRESSURE_LEVEL_VARS."
    )


def download_categories_for_var(var: str, *, skip_pressure_levels: bool = False) -> List[str]:
    """Return the categories that should be downloaded for ``var``.

    Several ICON variables (notably t/u/v/clc) exist in both model-level and
    pressure-level products.  Filtering the category list, instead of dropping
    the variable, keeps the model-level product available to Zarr-only
    pipelines while avoiding the additional pressure-level downloads.
    """
    # Static 2-D fields can also appear in broad single-level catalogues for
    # some models. The Zarr builders consume only the time-invariant product.
    if var.lower() in TIMEINV_2D_VARS:
        categories = ["timeinv"]
    else:
        categories = categories_for_var(var)
    if skip_pressure_levels:
        return [category for category in categories if category != "plevel"]
    return categories


def category_for_var(var: str) -> str:
    return categories_for_var(var)[0]


def regex_for_category(var: str, cat: str):
    if cat == "model":
        return RE_MODEL
    if cat == "single":
        return RE_SINGLE
    if cat == "timeinv":
        return RE_TIMEINV_2D if var.lower() in TIMEINV_2D_VARS else RE_TIMEINV_PROFILE
    if cat == "plevel":
        return RE_PRESSURE
    return RE_MODEL


def regex_for_var(var: str):
    return regex_for_category(var, category_for_var(var))


def _build_proxy_map(proxy_url: Optional[str], proxy_userpass: Optional[str]) -> Dict[str, str]:
    """
    Build a requests proxies dict for both http and https.
    - proxy_url should include scheme, host, and port (e.g. http://1.2.3.4:8080)
    - proxy_userpass is 'USER:PASS' (optional). If provided, credentials are injected (URL-encoded).
    """
    if not proxy_url:
        return {}
    try:
        parsed = urlparse(proxy_url)
        if not parsed.scheme or not parsed.hostname:
            raise ValueError("Invalid --proxy URL")
        netloc = parsed.netloc
        # If creds provided separately and not already in URL, inject them (URL-encoded)
        if proxy_userpass and "@" not in netloc:
            if ":" in proxy_userpass:
                user, pwd = proxy_userpass.split(":", 1)
            else:
                user, pwd = proxy_userpass, ""
            cred = f"{quote(user)}:{quote(pwd)}"
            hostport = parsed.hostname
            if parsed.port:
                hostport += f":{parsed.port}"
            netloc = f"{cred}@{hostport}"
        full = urlunparse((parsed.scheme, netloc, parsed.path or "", "", "", ""))
        return {"http": full, "https": full}
    except Exception:
        # Fallback naive injection
        if proxy_userpass and "@" not in proxy_url:
            parts = proxy_url.split("://", 1)
            if len(parts) == 2:
                scheme, rest = parts
                full = f"{scheme}://{proxy_userpass}@{rest}"
                return {"http": full, "https": full}
        return {"http": proxy_url, "https": proxy_url}


def make_session(proxy_url: Optional[str] = None, proxy_userpass: Optional[str] = None) -> requests.Session:
    s = requests.Session()
    if Retry and HTTPAdapter:
        retry = Retry(
            total=5,
            backoff_factor=0.6,
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=["GET", "HEAD"],
            raise_on_status=False,
        )
        adapter = HTTPAdapter(max_retries=retry, pool_connections=64, pool_maxsize=64)
        s.mount("https://", adapter)
        s.mount("http://", adapter)
    s.headers.update({"User-Agent": MODEL_USER_AGENT})

    proxies = _build_proxy_map(proxy_url, proxy_userpass)
    if proxies:
        s.proxies.update(proxies)

    return s


def thread_session(base_session: requests.Session) -> requests.Session:
    """Create/reuse a per-thread session (safer than sharing one Session across threads)."""
    if getattr(_thread_local, "s", None) is None:
        ts = requests.Session()
        ts.headers.update(base_session.headers)
        for prefix, adapter in base_session.adapters.items():
            ts.mount(prefix, adapter)
        ts.proxies.update(base_session.proxies)
        _thread_local.s = ts
    return _thread_local.s


def list_dir(session: requests.Session, url: str) -> List[str]:
    r = session.get(url, timeout=30)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    files = []
    for a in soup.find_all("a"):
        href = a.get("href") or ""
        if href.endswith("/") or href.startswith("?"):
            continue
        if not (href.endswith(".grib2") or href.endswith(".grib2.bz2")):
            continue
        files.append(href)
    return files


def _find_aria2c_binary(custom_path: Optional[str]) -> Optional[str]:
    if custom_path:
        p = Path(custom_path).expanduser()
        if p.exists():
            return str(p.resolve())
    for candidate in ("aria2c", "aria2c.exe"):
        found = shutil.which(candidate)
        if found:
            return found
    return None


def _format_aria2c_rate_limit(bps: float) -> str:
    if bps >= 1_000_000:
        return f"{max(1, int(bps / 1_000_000))}M"
    if bps >= 1_000:
        return f"{max(1, int(bps / 1_000))}K"
    return str(max(1, int(bps)))


def _fetch_index_for_var(base_session: requests.Session, cycle: str, var: str) -> Tuple[str, str, List[str], Optional[str]]:
    url = BASE_URL.format(cycle=cycle, var=var)
    try:
        s = thread_session(base_session)
        files = list_dir(s, url)
        return (var, url, files, None)
    except Exception as e:
        return (var, url, [], str(e))


def _probe_cycle_run(
    base_session: requests.Session,
    var: str,
    cycle: str,
    latest_run_hour_divisor: int = 0,
) -> Optional[Tuple[str, str, str]]:
    url = BASE_URL.format(cycle=cycle, var=var)
    try:
        s = thread_session(base_session)
        files = list_dir(s, url)
    except Exception:
        return None
    if not files:
        return None
    rx = regex_for_var(var)
    latest_run = pick_latest_run(files, rx, latest_run_hour_divisor=latest_run_hour_divisor)
    if not latest_run:
        return None
    return (latest_run, cycle, var)


def parse_levels_arg(levels: List[str]) -> Optional[Set[int]]:
    """None -> implicit defaults ("all"), else explicit set."""
    expanded: List[str] = []
    for raw in levels:
        for part in str(raw).split(","):
            token = part.strip()
            if token:
                expanded.append(token)

    if len(expanded) == 1 and expanded[0].lower() == "all":
        return None
    if any(tok.lower() == "all" for tok in expanded):
        raise ValueError('"all" cannot be combined with explicit levels')

    s: Set[int] = set()
    for tok in expanded:
        if "-" in tok:
            a, b = tok.split("-", 1)
            lo, hi = sorted((int(a), int(b)))
            s.update(range(lo, hi + 1))
        else:
            s.add(int(tok))
    if not s:
        raise ValueError("no valid levels parsed")
    return s


def wanted_fcst_from_args(fcst_hours: List[int], fcst_range: Optional[List[int]]) -> Optional[Set[str]]:
    """
    Returns None => do not filter by forecast hour (i.e., ALL).
    Otherwise returns set of zero-padded hours like {'000','003',...}.
    """
    if fcst_range:
        if len(fcst_range) != 3:
            raise ValueError("--fcst-range needs START END STEP, e.g. 0 24 3")
        start, end, step = map(int, fcst_range)
        vals = list(range(start, end + 1, step))
    elif fcst_hours:
        vals = fcst_hours
    else:
        return None  # ALL forecast hours
    return {f"{h:03d}" for h in vals}


def run_matches_hour_divisor(run_id: str, latest_run_hour_divisor: int) -> bool:
    if latest_run_hour_divisor <= 0:
        return True
    if not re.fullmatch(r"\d{10}", run_id):
        return False
    return int(run_id[8:10]) % latest_run_hour_divisor == 0


def pick_latest_run(
    files: List[str],
    rx: re.Pattern,
    latest_run_hour_divisor: int = 0,
) -> Optional[str]:
    runs = []
    for f in files:
        m = rx.match(f)
        if not m:
            continue
        run_id = m.group("run")
        if run_matches_hour_divisor(run_id, latest_run_hour_divisor):
            runs.append(run_id)
    return max(runs) if runs else None


def filter_files(
    files: List[str],
    rx: re.Pattern,
    var: str,
    latest_run: str,
    wanted_fcst: Optional[Set[str]],
    wanted_model_levels: Optional[Set[int]],
    wanted_pressure_levels: Optional[Set[int]],
    category: Optional[str] = None,
) -> List[str]:
    keep = []
    cat = category or category_for_var(var)
    if cat == "plevel":
        effective_levels = wanted_pressure_levels
        if wanted_pressure_levels is None:
            # "all" for pressure-level variables maps to the standard pressure set.
            effective_levels = PRESSURE_LEVELS_STANDARD
    else:
        effective_levels = wanted_model_levels
    for f in files:
        m = rx.match(f)
        if not m:
            continue
        if m.group("run") != latest_run:
            continue

        if cat in ("model", "plevel"):
            lvl = int(m.group("level"))
            if (effective_levels is not None) and (lvl not in effective_levels):
                continue
            if (wanted_fcst is None) or (m.group("fcst") in wanted_fcst):
                keep.append(f)

        elif cat == "single":
            # no level filter; forecast-hour applies
            if (wanted_fcst is None) or (m.group("fcst") in wanted_fcst):
                keep.append(f)

        else:  # time-invariant (HHL is vertical; HSURF is a single static field)
            level = m.groupdict().get("level")
            if (
                var.lower() == "hsurf"
                or level is None
                or (wanted_model_levels is None)
                or (int(level) in wanted_model_levels)
            ):
                keep.append(f)

    return sorted(keep)


def _parse_grib_filename_meta(filename: str) -> Optional[Dict[str, object]]:
    for cat, rx in (
        ("model", RE_MODEL),
        ("single", RE_SINGLE),
        ("timeinv", RE_TIMEINV_PROFILE),
        ("timeinv", RE_TIMEINV_2D),
        ("plevel", RE_PRESSURE),
    ):
        m = rx.match(filename)
        if not m:
            continue
        gd = m.groupdict()
        out: Dict[str, object] = {
            "category": cat,
            "run": str(gd.get("run") or ""),
            "forecast_hour": int(str(gd.get("fcst") or "0")),
            "var": str(gd.get("var") or "").lower(),
            "level": None,
            "compressed": filename.endswith(".bz2"),
        }
        lvl = gd.get("level")
        if lvl is not None:
            out["level"] = int(lvl)
        return out
    return None


def _summarize_download_tree(out_dir: Path, by_init_dir: bool) -> Dict[str, Dict[str, object]]:
    runs: Dict[str, Dict[str, object]] = {}
    for p in out_dir.rglob("*.grib2*"):
        if not p.is_file():
            continue
        meta = _parse_grib_filename_meta(p.name)
        if meta is None:
            continue

        run = str(meta["run"])
        run_entry = runs.get(run)
        if run_entry is None:
            run_path = (out_dir / run) if by_init_dir else p.parent
            run_entry = {
                "path": run_path.as_posix(),
                "file_count_total": 0,
                "file_count_grib2": 0,
                "file_count_bz2": 0,
                "vars": {},
            }
            runs[run] = run_entry

        run_entry["file_count_total"] = int(run_entry["file_count_total"]) + 1
        if bool(meta["compressed"]):
            run_entry["file_count_bz2"] = int(run_entry["file_count_bz2"]) + 1
        else:
            run_entry["file_count_grib2"] = int(run_entry["file_count_grib2"]) + 1

        var = str(meta["var"])
        vars_map = run_entry["vars"]  # type: ignore[index]
        var_entry = vars_map.get(var)  # type: ignore[union-attr]
        if var_entry is None:
            var_entry = {
                "category": str(meta["category"]),
                "forecast_hours": set(),
                "levels": set(),
                "file_count_total": 0,
                "file_count_grib2": 0,
                "file_count_bz2": 0,
            }
            vars_map[var] = var_entry  # type: ignore[index]

        var_entry["file_count_total"] = int(var_entry["file_count_total"]) + 1
        if bool(meta["compressed"]):
            var_entry["file_count_bz2"] = int(var_entry["file_count_bz2"]) + 1
        else:
            var_entry["file_count_grib2"] = int(var_entry["file_count_grib2"]) + 1
        var_entry["forecast_hours"].add(int(meta["forecast_hour"]))
        lvl = meta.get("level")
        if lvl is not None:
            var_entry["levels"].add(int(lvl))

    # Convert sets to sorted lists for JSON.
    out: Dict[str, Dict[str, object]] = {}
    for run, run_entry in sorted(runs.items(), key=lambda kv: kv[0]):
        vars_in = run_entry["vars"]  # type: ignore[index]
        vars_out: Dict[str, object] = {}
        for var, var_entry in sorted(vars_in.items(), key=lambda kv: kv[0]):  # type: ignore[union-attr]
            vars_out[var] = {
                "category": var_entry["category"],
                "forecast_hours": sorted(int(x) for x in var_entry["forecast_hours"]),
                "levels": sorted(int(x) for x in var_entry["levels"]),
                "file_count_total": int(var_entry["file_count_total"]),
                "file_count_grib2": int(var_entry["file_count_grib2"]),
                "file_count_bz2": int(var_entry["file_count_bz2"]),
            }
        out[run] = {
            "path": run_entry["path"],
            "file_count_total": int(run_entry["file_count_total"]),
            "file_count_grib2": int(run_entry["file_count_grib2"]),
            "file_count_bz2": int(run_entry["file_count_bz2"]),
            "vars": vars_out,
        }
    return out


def write_status_json(
    out_dir: Path,
    *,
    by_init_dir: bool,
    stage: str,
    cycle_requested: str,
    cycle_selected: str,
    run_policy: str,
    pinned_run_id: Optional[str],
    resolved_global_run: Optional[str],
    selected_runs: Set[str],
    planned_downloads: int,
    successful_downloads: int,
    failed_downloads: int,
    planned_decompress: int,
    successful_decompress: int,
    failed_decompress: int,
) -> None:
    try:
        runs = _summarize_download_tree(out_dir, by_init_dir=by_init_dir)
        latest_candidates = set(runs.keys())
        latest_candidates.update(str(x) for x in selected_runs if x)
        if pinned_run_id:
            latest_candidates.add(str(pinned_run_id))
        if resolved_global_run:
            latest_candidates.add(str(resolved_global_run))
        latest_run = max(latest_candidates) if latest_candidates else None

        status = {
            "schema_version": 1,
            "updated_utc": datetime.now(timezone.utc).isoformat(),
            "stage": stage,
            "out_dir": out_dir.as_posix(),
            "layout": "by_init_dir" if by_init_dir else "flat",
            "cycle_requested": str(cycle_requested),
            "cycle_selected": str(cycle_selected),
            "run_policy": str(run_policy),
            "pinned_run_id": pinned_run_id,
            "resolved_global_run": resolved_global_run,
            "latest_initstamp": latest_run,
            "selected_initstamps": sorted(selected_runs),
            "runs": runs,
            "progress": {
                "planned_downloads": int(planned_downloads),
                "successful_downloads": int(successful_downloads),
                "failed_downloads": int(failed_downloads),
                "planned_decompress": int(planned_decompress),
                "successful_decompress": int(successful_decompress),
                "failed_decompress": int(failed_decompress),
            },
        }
        path = out_dir / "status.json"
        tmp = out_dir / "status.json.tmp"
        tmp.write_text(json.dumps(status, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(path)
    except Exception as e:
        print(f"[Warn] failed to write status.json: {e}")


def print_dry_plan_timing_summary(
    *,
    cycle: str,
    vars_requested: List[str],
    vars_with_matches: int,
    index_errors: int,
    planned_files: int,
    index_workers: int,
    net_workers: int,
    cpu_workers: int,
    chunk_size_kib: int,
    download_engine: str,
    timings: Dict[str, float],
) -> None:
    print("\n=== Dry Plan Timing ===")
    print(f"Cycle: {cycle}")
    print(f"Vars requested: {len(vars_requested)}")
    print(f"Vars with matches: {vars_with_matches}")
    print(f"Index errors: {index_errors}")
    print(f"Planned downloads: {planned_files}")
    print(f"Engine={download_engine} index_workers={index_workers} net_workers={net_workers} cpu_workers={cpu_workers} chunk_kib={chunk_size_kib}")
    print(f"Timing cycle_resolve_s={timings.get('cycle_resolve_s', 0.0):.3f}")
    print(f"Timing index_fetch_s={timings.get('index_fetch_s', 0.0):.3f}")
    print(f"Timing filter_plan_s={timings.get('filter_plan_s', 0.0):.3f}")
    print(f"Timing total_plan_s={timings.get('total_plan_s', 0.0):.3f}")
    print("Note: dry-plan mode does not download or decompress files.")


# ----------------------- Priority helpers -----------------------

def set_low_priority(enable: bool) -> None:
    if not enable:
        return
    try:
        import psutil  # type: ignore
        p = psutil.Process()
        if os.name == "nt":
            try:
                p.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
            except Exception:
                pass
            # Best effort IO priority
            try:
                p.ionice(psutil.IOPRIO_CLASS_IDLE)
            except Exception:
                pass
        else:
            try:
                os.nice(10)
            except Exception:
                pass
            try:
                p.ionice(psutil.IOPRIO_CLASS_IDLE)
            except Exception:
                pass
    except Exception:
        # Fallback on Linux: try ionice via subprocess
        if os.name != "nt":
            try:
                subprocess.run(["ionice", "-c", "3", "-p", str(os.getpid())], check=False,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except Exception:
                pass


# ----------------------- Atomic I/O helpers -----------------------

def throttled_iter(iterable, throttle_bps: Optional[float]):
    if not throttle_bps or throttle_bps <= 0:
        for chunk in iterable:
            yield chunk
        return
    start = time.monotonic()
    bytes_seen = 0
    for chunk in iterable:
        if not chunk:
            continue
        bytes_seen += len(chunk)
        yield chunk
        elapsed = time.monotonic() - start
        if elapsed <= 0:
            continue
        # allowed bytes so far
        budget = throttle_bps * elapsed
        if bytes_seen > budget:
            sleep_s = (bytes_seen - budget) / throttle_bps
            if sleep_s > 0:
                time.sleep(min(sleep_s, 0.5))


def _atomic_write(path: Path, data_iter, do_fsync: bool = True):
    """Write to path+'.part' then atomically replace. data_iter yields bytes."""
    tmp = path.with_suffix(path.suffix + ".part")
    with open(tmp, "wb") as f:
        for chunk in data_iter:
            if chunk:
                f.write(chunk)
        if do_fsync:
            f.flush()
            os.fsync(f.fileno())
    os.replace(tmp, path)


def _read_magic(path: Path, n: int) -> bytes:
    with open(path, "rb") as f:
        return f.read(n)


def _validate_grib_file(path: Path) -> None:
    """Validate complete, contiguous GRIB1/GRIB2 messages without decoding fields."""
    size = path.stat().st_size
    if size < 16:
        raise IOError(f"{path.name}: file is too short to contain a GRIB message")

    message_count = 0
    offset = 0
    with open(path, "rb") as f:
        while offset < size:
            f.seek(offset)
            header = f.read(16)
            if len(header) < 16 or header[:4] != b"GRIB":
                raise IOError(f"{path.name}: invalid GRIB message header at byte {offset}")

            edition = header[7]
            if edition == 2:
                message_size = int.from_bytes(header[8:16], byteorder="big")
                minimum_size = 20
            elif edition == 1:
                message_size = int.from_bytes(header[4:7], byteorder="big")
                minimum_size = 12
            else:
                raise IOError(f"{path.name}: unsupported GRIB edition {edition} at byte {offset}")

            if message_size < minimum_size:
                raise IOError(f"{path.name}: invalid GRIB message size {message_size} at byte {offset}")
            if offset + message_size > size:
                raise IOError(f"{path.name}: truncated GRIB message at byte {offset}")

            f.seek(offset + message_size - 4)
            if f.read(4) != b"7777":
                raise IOError(f"{path.name}: missing GRIB end marker at byte {offset}")

            message_count += 1
            offset += message_size

    if message_count == 0:
        raise IOError(f"{path.name}: no GRIB messages found")


def _is_valid_grib(path: Path) -> bool:
    try:
        if not path.exists():
            return False
        _validate_grib_file(path)
        return True
    except Exception:
        return False


def _is_valid_bz2(path: Path) -> bool:
    try:
        if not path.exists() or path.stat().st_size < 16:
            return False
        if _read_magic(path, 3) != b"BZh":
            return False
        with bz2.BZ2File(path, "rb") as f:
            while f.read(CHUNK_SIZE):
                pass
        return True
    except Exception:
        return False


def _extract_run_stamp(name: str) -> Optional[str]:
    m = RUN_STAMP_RE.search(name)
    return m.group(1) if m else None


def purge_nonlatest_files(root: Path, keep_run: str, *, older_only: bool = False) -> int:
    removed = 0
    if not root.exists():
        return 0

    # In the default by-init layout, drop complete obsolete runs before new data
    # is downloaded so old and new GRIB datasets do not coexist on disk.
    for p in root.iterdir():
        if (
            not p.is_dir()
            or not re.fullmatch(r"\d{10}", p.name)
            or p.name == keep_run
            or (older_only and p.name > keep_run)
        ):
            continue
        try:
            shutil.rmtree(p)
            removed += 1
        except Exception as e:
            print(f"[Warn] failed to remove obsolete run directory {p}: {e}")

    # Preserve support for legacy flat layouts and stale partial files.
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        # Always clean stale partial artifacts
        if p.suffix == ".part":
            try:
                p.unlink()
                removed += 1
            except Exception:
                pass
            continue
        run = _extract_run_stamp(p.name)
        if run and run != keep_run and (not older_only or run < keep_run):
            try:
                p.unlink()
                removed += 1
            except Exception:
                pass
    return removed


def _decompress_bz2(src_bz2: Path, dst_grib2: Path, keep_bz2: bool, do_fsync: bool, retries: int = 1) -> None:
    """Stream-decompress bz2 -> grib2 with retry and atomic rename."""
    tmp = dst_grib2.with_suffix(dst_grib2.suffix + ".part")
    attempt = 0
    while True:
        attempt += 1
        try:
            with bz2.BZ2File(src_bz2, "rb") as bi, open(tmp, "wb") as bo:
                while True:
                    chunk = bi.read(CHUNK_SIZE)
                    if not chunk:
                        break
                    bo.write(chunk)
                if do_fsync:
                    bo.flush()
                    os.fsync(bo.fileno())
            if tmp.stat().st_size == 0:
                raise IOError("zero-size output after decompression")
            try:
                _validate_grib_file(tmp)
            except Exception:
                if not keep_bz2:
                    try:
                        src_bz2.unlink()
                    except Exception:
                        pass
                raise
            os.replace(tmp, dst_grib2)
            if not keep_bz2:
                try:
                    src_bz2.unlink()
                except Exception:
                    pass
            return
        except Exception:
            try:
                if tmp.exists():
                    tmp.unlink()
            except Exception:
                pass
            if attempt <= retries:
                time.sleep(0.5 * attempt)
                continue
            raise


# ----------------------- Worker -----------------------

def run_aria2c_downloads(
    download_plan: List[Tuple[str, Path]],
    *,
    aria2c_bin: str,
    net_workers: int,
    split: int,
    max_conn_per_server: int,
    proxy_url: Optional[str],
    proxy_user: Optional[str],
    throttle_bps: Optional[float],
) -> List[Tuple[str, bool, Optional[str]]]:
    if not download_plan:
        return []

    with tempfile.NamedTemporaryFile("w", delete=False, encoding="utf-8", suffix=".aria2.txt") as tf:
        input_file = Path(tf.name)
        for url, dest in download_plan:
            tf.write(url + "\n")
            tf.write(f" dir={dest.parent.as_posix()}\n")
            tf.write(f" out={dest.name}\n")

    cmd = [
        aria2c_bin,
        "--allow-overwrite=true",
        "--auto-file-renaming=false",
        "--continue=true",
        "--file-allocation=none",
        "--check-certificate=true",
        "--max-tries=5",
        "--retry-wait=2",
        "--summary-interval=0",
        "--console-log-level=warn",
        "--max-concurrent-downloads", str(max(1, int(net_workers))),
        "--split", str(max(1, int(split))),
        "--max-connection-per-server", str(max(1, int(max_conn_per_server))),
        "--input-file", str(input_file),
    ]

    if throttle_bps and throttle_bps > 0:
        cmd.extend(["--max-overall-download-limit", _format_aria2c_rate_limit(throttle_bps)])

    if proxy_url:
        cmd.extend(["--all-proxy", proxy_url])
        if proxy_user:
            if ":" in proxy_user:
                user, pwd = proxy_user.split(":", 1)
            else:
                user, pwd = proxy_user, ""
            cmd.extend(["--all-proxy-user", user, "--all-proxy-passwd", pwd])

    print(" ".join(cmd))
    proc = subprocess.run(cmd, check=False)
    if proc.returncode != 0:
        print(f"[Warn] aria2c exited with code {proc.returncode}; validating downloaded files")

    results: List[Tuple[str, bool, Optional[str]]] = []
    for _, dest in download_plan:
        is_bz2 = "".join(dest.suffixes).endswith(".grib2.bz2")
        valid = _is_valid_bz2(dest) if is_bz2 else _is_valid_grib(dest)
        if valid:
            results.append((dest.name, True, None))
        else:
            err = "missing or invalid file after aria2c"
            if dest.exists():
                try:
                    dest.unlink()
                except Exception:
                    pass
            results.append((dest.name, False, err))

    try:
        input_file.unlink()
    except Exception:
        pass
    return results

def download_one(base_session: requests.Session, url: str, dest: Path, decompress: bool) -> Tuple[str, bool, Optional[str]]:
    """
    Download to 'dest' atomically. If decompress=True and dest endswith .bz2,
    ensure corresponding .grib2 exists, creating it atomically. If .bz2 already
    exists but .grib2 is missing, attempt decompression without re-downloading.
    """
    try:
        s = thread_session(base_session)
        dest.parent.mkdir(parents=True, exist_ok=True)

        is_bz2 = "".join(dest.suffixes).endswith(".grib2.bz2")
        final_grib2 = Path(str(dest)[:-4]) if is_bz2 else dest

        # 1) Skip if we already have the final desired artifact
        if decompress and is_bz2 and final_grib2.exists():
            if _is_valid_grib(final_grib2):
                return (final_grib2.name, True, None)
            try:
                final_grib2.unlink()
            except Exception:
                pass
        if not decompress and dest.exists():
            if (_is_valid_bz2(dest) if is_bz2 else _is_valid_grib(dest)):
                return (dest.name, True, None)
            try:
                dest.unlink()
            except Exception:
                pass

        # 2) If decompress requested and a .bz2 already exists, try to decompress it first
        if decompress and is_bz2 and dest.exists() and not final_grib2.exists():
            try:
                _decompress_bz2(dest, final_grib2, keep_bz2=getattr(download_one, "keep_bz2", False), do_fsync=DO_FSYNC)
                return (final_grib2.name, True, None)
            except Exception:
                pass  # fall through to re-download

        # 3) Download fresh (atomically)
        with s.get(url, stream=True, timeout=60) as r:
            r.raise_for_status()
            clen = r.headers.get("Content-Length")
            data_iter = r.iter_content(chunk_size=CHUNK_SIZE)
            data_iter = throttled_iter(data_iter, THROTTLE_BPS)
            _atomic_write(dest, data_iter, do_fsync=DO_FSYNC)
        if clen is not None:
            try:
                clen_i = int(clen)
                if dest.stat().st_size != clen_i:
                    raise IOError(f"size mismatch (got {dest.stat().st_size}, expected {clen_i})")
            except ValueError:
                pass  # ignore non-integer header

        # 4) Decompress if requested
        if decompress and is_bz2:
            try:
                _decompress_bz2(dest, final_grib2, keep_bz2=getattr(download_one, "keep_bz2", False), do_fsync=DO_FSYNC)
                return (final_grib2.name, True, None)
            except Exception as e:
                # Keep .bz2 so user can retry; report failure
                return (dest.name, False, f"decompress failed: {e}")

        # 5) Otherwise validate the downloaded artifact before accepting it.
        if not (_is_valid_bz2(dest) if is_bz2 else _is_valid_grib(dest)):
            try:
                dest.unlink()
            except Exception:
                pass
            raise IOError(f"{dest.name}: downloaded file failed integrity validation")
        return (dest.name, True, None)

    except Exception as e:
        return (dest.name, False, str(e))


# --------------------------------------------------------------------
# Auto-select latest cycle
# --------------------------------------------------------------------

CYCLE_LIST = [f"{h:02d}" for h in (21, 18, 15, 12, 9, 6, 3, 0)]  # check descending


def resolve_latest_cycle(
    session: requests.Session,
    vars_requested: List[str],
    workers: int = 8,
    latest_run_hour_divisor: int = 0,
) -> Tuple[str, str, str]:
    """
    Returns (cycle, latest_run, probe_var).
    Scans all cycle folders for a probe variable and picks the highest run (YYYYMMDDHH).
    """
    # choose a probe variable that is widely present
    probe_candidates = [v.lower() for v in vars_requested] + ["t_2m", "t", "ps"]
    seen = set()
    probe_candidates = [v for v in probe_candidates if not (v in seen or seen.add(v))]

    best: Optional[Tuple[str, str, str]] = None  # (run, cycle, var)
    tasks: List[Tuple[str, str]] = []
    for var in probe_candidates:
        for cycle in CYCLE_LIST:
            tasks.append((var, cycle))

    max_workers = max(1, int(workers))
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futs = [
            ex.submit(_probe_cycle_run, session, var, cycle, latest_run_hour_divisor)
            for (var, cycle) in tasks
        ]
        for fut in as_completed(futs):
            result = fut.result()
            if not result:
                continue
            latest_run, cycle, var = result
            if (best is None) or (latest_run > best[0]):  # lexicographic ok for YYYYMMDDHH
                best = (latest_run, cycle, var)

    if not best:
        raise RuntimeError("Could not determine latest cycle (no listings found for any probe var).")

    run, cycle, var = best
    return cycle, run, var


# ----------------------- Post-phase decompression -----------------------

def _decompress_job(args: Tuple[Path, Path, bool, bool]) -> Tuple[str, bool, Optional[str]]:
    src_bz2, dst_grib2, keep_bz2, do_fsync = args
    try:
        _decompress_bz2(src_bz2, dst_grib2, keep_bz2=keep_bz2, do_fsync=do_fsync)
        return (dst_grib2.name, True, None)
    except Exception as e:
        return (src_bz2.name, False, str(e))


# --------------------------------------------------------------------
# Main
# --------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Download ICON-D2 or ICON-EU GRIB2 files from DWD")
    ap.add_argument(
        "--model",
        required=True,
        choices=sorted(CLASSIC_MODEL_CONFIGS),
        help="Model to download",
    )
    ap.add_argument("--cycle", required=True, help='Model cycle (00 03 06 09 12 15 18 21, or "latest")')
    ap.add_argument("--vars", nargs="+", required=True, help="Vars, e.g.: t qv u v p t_2m ps hhl")
    ap.add_argument("--fcst-hours", nargs="+", type=int, default=[], help="Explicit list: 0 3 6 9 12 ...")
    ap.add_argument("--fcst-range", nargs=3, type=int, help="START END STEP, e.g. 0 24 3")
    ap.add_argument(
        "--levels",
        nargs="+",
        required=True,
        help='model-level selection ("all" or list/ranges), e.g. 0-60',
    )
    ap.add_argument(
        "--pressure-levels",
        nargs="+",
        default=["all"],
        help='pressure-level selection ("all" -> provided standard pressure set, or list/ranges), e.g. 1000 950 850',
    )
    ap.add_argument(
        "--skip-pressure-levels",
        action="store_true",
        help=(
            "Do not download pressure-level products. Variables that also have "
            "model-level products (for example t/u/v/clc) keep their model-level downloads."
        ),
    )
    ap.add_argument("--out-dir", required=True, help="Output folder")
    ap.add_argument(
        "--flat-out-dir",
        action="store_true",
        help="Write files directly into --out-dir (legacy behavior). Default writes into --out-dir/<init_run>/",
    )
    ap.add_argument("--decompress", action="store_true", help="Decompress .bz2 -> .grib2 and delete .bz2")
    ap.add_argument("--keep-bz2", action="store_true", help="Keep .bz2 after successful decompression")
    ap.add_argument(
        "--run-id",
        help=(
            "Optional fixed init run to download (YYYYMMDDHH). "
            "When set, planning enforces this run per variable."
        ),
    )
    ap.add_argument(
        "--run-policy",
        choices=["global", "per-var"],
        default="global",
        help='When --cycle latest: "global" enforces one run across all vars (default), '
             '"per-var" keeps old behavior.',
    )
    ap.add_argument(
        "--latest-run-hour-divisor",
        type=int,
        default=0,
        help=(
            "When --cycle latest, only consider init runs whose HH is divisible by this value "
            "(0 disables; 12 means only 00Z/12Z)."
        ),
    )
    ap.add_argument(
        "--purge-nonlatest",
        action="store_true",
        help="Delete local files in --out-dir that are not tied to the selected latest run.",
    )
    ap.add_argument(
        "--purge-older-before-download",
        action="store_true",
        help=(
            "After resolving a global latest run, delete older local run directories/files "
            "before downloading it. Locally newer runs are preserved."
        ),
    )

    # Parallelism
    ap.add_argument("--workers", type=int, help="(Deprecated) parallelism for downloads; use --net-workers")
    ap.add_argument("--net-workers", type=int, help="Number of concurrent downloads (default: 4)")
    ap.add_argument("--index-workers", type=int, default=8, help="Parallel workers for variable index listing/planning (default: 8)")
    ap.add_argument("--cpu-workers", type=int, default=1, help="Number of concurrent decompressions in post-phase (default: 1)")

    # Behavior & performance
    ap.add_argument(
        "--download-engine",
        choices=["auto", "requests", "aria2c"],
        default="auto",
        help='Download backend: "requests" (default behavior), "aria2c", or "auto" (prefer aria2c if available).',
    )
    ap.add_argument("--aria2c-path", help="Path to aria2c binary (optional)")
    ap.add_argument("--aria2c-split", type=int, default=4, help="aria2c split per file (default: 4)")
    ap.add_argument(
        "--aria2c-max-conn-per-server",
        type=int,
        default=4,
        help="aria2c max connections per server (default: 4)",
    )
    ap.add_argument("--chunk-size-kib", type=int, default=128, help="requests/chunked I/O chunk size in KiB (default: 128)")
    ap.add_argument(
        "--dry-plan-timing",
        action="store_true",
        help="Benchmark planning only (cycle/index/filter timing) and exit before download/decompress.",
    )
    ap.add_argument("--decompress-phase", choices=["inline", "post"], default="inline",
                    help='Decompress inline (legacy) or in a controlled post-phase (recommended for responsiveness)')
    ap.add_argument("--throttle-mbps", type=float, default=0.0,
                    help="Cap download bandwidth in megabits/sec (0 = unlimited)")
    ap.add_argument("--nice", action="store_true", help="Lower CPU/IO priority to keep the system responsive")
    ap.add_argument("--no-fsync", action="store_true", help="Skip fsync to reduce IO stalls (risk data loss on crash)")

    # --- Optional proxy like curl ---
    ap.add_argument("--proxy", help='Proxy URL, e.g. "http://158.32.162.190:80"')
    ap.add_argument("--proxy-user", help='Credentials as "USER:PASS" (optional, like curl --proxy-user)')
    # --------------------------------

    args = ap.parse_args()
    try:
        configure_classic_model(args.model)
    except ValueError as e:
        raise SystemExit(str(e))
    args.vars = [v.lower() for v in args.vars]
    if args.run_id:
        args.run_id = str(args.run_id).strip()
        if not re.fullmatch(r"\d{10}", args.run_id):
            raise SystemExit("--run-id must be YYYYMMDDHH")
    latest_run_hour_divisor = int(args.latest_run_hour_divisor)
    if latest_run_hour_divisor < 0 or latest_run_hour_divisor > 24:
        raise SystemExit("--latest-run-hour-divisor must be 0 or an integer from 1 to 24")
    effective_latest_run_hour_divisor = (
        latest_run_hour_divisor
        if args.cycle.lower() == "latest" and not args.run_id
        else 0
    )
    if latest_run_hour_divisor > 0 and effective_latest_run_hour_divisor == 0:
        print("[Warn] --latest-run-hour-divisor is ignored unless --cycle latest is used without --run-id.")

    try:
        for v in args.vars:
            categories_for_var(v)
    except ValueError as e:
        raise SystemExit(str(e))
    vars_with_download_categories = [
        var
        for var in args.vars
        if download_categories_for_var(
            var,
            skip_pressure_levels=bool(args.skip_pressure_levels),
        )
    ]
    if not vars_with_download_categories:
        raise SystemExit(
            "No downloadable variable categories remain after applying "
            "--skip-pressure-levels."
        )

    # Set globals
    global DO_FSYNC, THROTTLE_BPS, CHUNK_SIZE
    DO_FSYNC = not bool(getattr(args, "no_fsync", False))
    THROTTLE_BPS = None
    if args.throttle_mbps and args.throttle_mbps > 0:
        # Convert megabits/sec to bytes/sec
        THROTTLE_BPS = (args.throttle_mbps * 1_000_000) / 8.0
    CHUNK_SIZE = max(4, int(args.chunk_size_kib)) * 1024

    # Lower priority if requested
    set_low_priority(args.nice)

    # Back-compat for --workers
    net_workers = args.net_workers if args.net_workers is not None else (args.workers if args.workers else 4)
    net_workers = max(1, int(net_workers))
    index_workers = max(1, int(args.index_workers))

    aria2c_bin = _find_aria2c_binary(args.aria2c_path)
    if args.download_engine == "requests":
        download_engine = "requests"
    elif args.download_engine == "aria2c":
        if not aria2c_bin:
            raise SystemExit(
                "download engine 'aria2c' requested but aria2c was not found. "
                "Install aria2c or pass --aria2c-path."
            )
        download_engine = "aria2c"
    else:
        download_engine = "aria2c" if aria2c_bin else "requests"

    # pass flag into worker without changing signature
    setattr(download_one, "keep_bz2", bool(getattr(args, "keep_bz2", False)))

    session = make_session(proxy_url=args.proxy, proxy_userpass=args.proxy_user)
    dry_timings: Dict[str, float] = {}

    # Determine cycle / global run
    t_cycle_start = time.perf_counter()
    global_run: Optional[str] = None
    if args.cycle.lower() == "latest":
        try:
            sel_cycle, sel_run, probe_var = resolve_latest_cycle(
                session,
                vars_with_download_categories,
                workers=index_workers,
                latest_run_hour_divisor=effective_latest_run_hour_divisor,
            )
            cycle = sel_cycle
            global_run = sel_run
            print(f'Auto-selected latest cycle: {cycle} (run {sel_run[:8]} {sel_run[8:]}Z) using var {probe_var}')
        except Exception as e:
            session.close()
            raise SystemExit(f"Failed to resolve latest cycle: {e}")
    else:
        cycle = args.cycle.zfill(2)
        if args.run_policy == "global":
            print("[Warn] --run-policy global is only applied automatically with --cycle latest.")
    dry_timings["cycle_resolve_s"] = time.perf_counter() - t_cycle_start

    out_dir = Path(args.out_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    by_init_dir = not bool(args.flat_out_dir)
    selected_runs: Set[str] = set()
    successful_downloads = 0
    failed_downloads = 0
    planned_decompress = 0
    successful_decompress = 0
    failed_decompress = 0

    try:
        wanted_model_lvls = parse_levels_arg(args.levels)
        wanted_pressure_lvls = parse_levels_arg(args.pressure_levels)
    except ValueError as e:
        raise SystemExit(str(e))
    wanted_fcst = wanted_fcst_from_args(args.fcst_hours, args.fcst_range)
    effective_decompress_phase = args.decompress_phase
    if args.decompress and download_engine == "aria2c" and args.decompress_phase == "inline":
        print("[Warn] --decompress-phase inline is not supported with aria2c backend; switching to post.")
        effective_decompress_phase = "post"

    print(f"Model: {MODEL_LABEL}")
    print(f"Cycle: {cycle}")
    print(f"Vars: {', '.join(args.vars)}")
    print(f"Forecast hours: {'ALL' if wanted_fcst is None else ', '.join(sorted(wanted_fcst))}")
    print(f"Model levels: {'ALL' if wanted_model_lvls is None else 'custom'}")
    if args.skip_pressure_levels:
        print("Pressure levels: skipped")
    else:
        print(
            f"Pressure levels: "
            f"{'ALL (provided standard pressure set)' if wanted_pressure_lvls is None else 'custom'}"
        )
    print(f"Out: {out_dir}")
    print(f"Out layout: {'<out-dir>/<init_run>/' if by_init_dir else '<out-dir>/ (flat)'}")
    print(f"Download engine: {download_engine}" + (f" ({aria2c_bin})" if download_engine == "aria2c" and aria2c_bin else ""))
    print(f"Net workers: {net_workers}")
    print(f"Index workers: {index_workers}")
    print(f"CPU workers: {args.cpu_workers}")
    print(f"Chunk size: {CHUNK_SIZE // 1024} KiB")
    if args.dry_plan_timing:
        print("Dry plan timing: enabled (no download/decompress)")
    if args.decompress:
        print(f"Decompress: enabled ({effective_decompress_phase})")
    if args.keep_bz2:
        print("Keep .bz2: enabled")
    if args.proxy:
        if args.proxy_user:
            print(f"Proxy: {args.proxy} (auth: provided)")
        else:
            print(f"Proxy: {args.proxy}")
    if THROTTLE_BPS:
        print(f"Throttle: {args.throttle_mbps} Mbps")
    if not DO_FSYNC:
        print("fsync: disabled (unsafe on power loss)")
    if args.nice:
        print("Priority: lowered for responsiveness")
    if args.cycle.lower() == "latest":
        print(f"Run policy: {args.run_policy}")
        if effective_latest_run_hour_divisor > 0:
            allowed_hours = [
                f"{hour:02d}"
                for hour in range(24)
                if hour % effective_latest_run_hour_divisor == 0
            ]
            print(
                "Latest run hour divisor: "
                f"{effective_latest_run_hour_divisor} "
                f"(allowed init hours: {', '.join(allowed_hours)}Z)"
            )
    if args.run_id:
        print(f"Pinned run-id: {args.run_id}")

    if args.purge_nonlatest:
        if not (args.cycle.lower() == "latest" and args.run_policy == "global" and global_run):
            session.close()
            raise SystemExit("--purge-nonlatest requires --cycle latest and --run-policy global.")
        removed = purge_nonlatest_files(out_dir, global_run)
        print(f"Purged non-latest local entries: {removed} (kept run {global_run})")
    if args.purge_older_before_download:
        if not (args.cycle.lower() == "latest" and args.run_policy == "global" and global_run):
            session.close()
            raise SystemExit(
                "--purge-older-before-download requires --cycle latest and --run-policy global."
            )
        removed = purge_nonlatest_files(out_dir, global_run, older_only=True)
        print(f"Purged older local entries before download: {removed} (selected run {global_run})")

    t_plan_total_start = time.perf_counter()
    download_plan: List[Tuple[str, Path]] = []
    to_decompress: List[Tuple[Path, Path]] = []  # (src_bz2, dst_grib2)
    vars_for_planning = list(dict.fromkeys(vars_with_download_categories))
    index_cache: Dict[str, Tuple[str, List[str], Optional[str]]] = {}
    index_error_count = 0
    vars_with_matches = 0

    t_index_start = time.perf_counter()
    with ThreadPoolExecutor(max_workers=index_workers) as ex:
        futs = [ex.submit(_fetch_index_for_var, session, cycle, var) for var in vars_for_planning]
        for fut in as_completed(futs):
            var, url, files, err = fut.result()
            index_cache[var] = (url, files, err)
    dry_timings["index_fetch_s"] = time.perf_counter() - t_index_start

    t_filter_start = time.perf_counter()
    for var in vars_for_planning:
        default_url = BASE_URL.format(cycle=cycle, var=var)
        url, files, idx_err = index_cache.get(var, (default_url, [], "index lookup missing"))
        print(f"\n[Index] {url}")
        if idx_err:
            print(f"[Error] cannot read index: {idx_err}")
            index_error_count += 1
            continue
        if not files:
            print("[Note] empty listing")
            continue

        selected_for_var: List[Tuple[str, str]] = []
        categories = download_categories_for_var(
            var,
            skip_pressure_levels=bool(args.skip_pressure_levels),
        )
        multi_category = len(categories) > 1
        for cat in categories:
            label = f"{var}/{cat}" if multi_category else var
            rx = regex_for_category(var, cat)
            latest_run = pick_latest_run(
                files,
                rx,
                latest_run_hour_divisor=effective_latest_run_hour_divisor,
            )
            if not latest_run:
                print(f"[Warn] no basetime detected for var={label}; skipping")
                continue

            selected_run = latest_run
            if args.cycle.lower() == "latest" and args.run_policy == "global" and global_run:
                selected_run = global_run
                has_global = any((m := rx.match(f)) and m.group("run") == global_run for f in files)
                if not has_global:
                    print(
                        f"[Warn] {label}: global latest run {global_run} not present in index; skipping."
                    )
                    continue
            if args.run_id:
                selected_run = args.run_id
                has_pinned = any((m := rx.match(f)) and m.group("run") == args.run_id for f in files)
                if not has_pinned:
                    print(f"[Warn] {label}: pinned run {args.run_id} not present in index; skipping.")
                    continue

            print(f"[Info] selected run for {label}: {selected_run[:8]} {selected_run[8:]} UTC")

            selected = filter_files(
                files,
                rx,
                var,
                selected_run,
                wanted_fcst,
                wanted_model_lvls,
                wanted_pressure_lvls,
                category=cat,
            )
            if not selected:
                print(f"[Note] no matches for var={label} with current filters")
                continue
            selected_runs.add(selected_run)
            vars_with_matches += 1
            selected_for_var.extend((selected_run, fname) for fname in selected)

        if not selected_for_var:
            continue

        for selected_run, fname in selected_for_var:
            # write into init run folder by default (faster retention cleanup by directory delete)
            dest_root = (out_dir / selected_run) if by_init_dir else out_dir
            dest_root.mkdir(parents=True, exist_ok=True)
            file_url = url + fname
            dest = dest_root / fname
            is_bz2_dest = "".join(dest.suffixes).endswith(".grib2.bz2")

            # skip if already have final output when decompressing
            if args.decompress and is_bz2_dest:
                final = Path(str(dest)[:-4])
                if final.exists():
                    if _is_valid_grib(final):
                        continue
                    try:
                        final.unlink()
                    except Exception:
                        pass
                # record for post-phase
                if effective_decompress_phase == "post":
                    to_decompress.append((dest, final))
            if dest.exists():
                if (_is_valid_bz2(dest) if is_bz2_dest else _is_valid_grib(dest)):
                    continue
                try:
                    dest.unlink()
                except Exception:
                    pass

            download_plan.append((file_url, dest))
    dry_timings["filter_plan_s"] = time.perf_counter() - t_filter_start

    total = len(download_plan)
    dry_timings["total_plan_s"] = time.perf_counter() - t_plan_total_start
    write_status_json(
        out_dir,
        by_init_dir=by_init_dir,
        stage="planned",
        cycle_requested=str(args.cycle),
        cycle_selected=str(cycle),
        run_policy=str(args.run_policy),
        pinned_run_id=args.run_id,
        resolved_global_run=global_run,
        selected_runs=selected_runs,
        planned_downloads=total,
        successful_downloads=successful_downloads,
        failed_downloads=failed_downloads,
        planned_decompress=planned_decompress,
        successful_decompress=successful_decompress,
        failed_decompress=failed_decompress,
    )
    if index_error_count or vars_with_matches == 0:
        session.close()
        raise SystemExit(1)
    if args.dry_plan_timing:
        print_dry_plan_timing_summary(
            cycle=cycle,
            vars_requested=vars_for_planning,
            vars_with_matches=vars_with_matches,
            index_errors=index_error_count,
            planned_files=total,
            index_workers=index_workers,
            net_workers=net_workers,
            cpu_workers=max(1, int(args.cpu_workers)),
            chunk_size_kib=CHUNK_SIZE // 1024,
            download_engine=download_engine,
            timings=dry_timings,
        )
        session.close()
        write_status_json(
            out_dir,
            by_init_dir=by_init_dir,
            stage="dry_plan",
            cycle_requested=str(args.cycle),
            cycle_selected=str(cycle),
            run_policy=str(args.run_policy),
            pinned_run_id=args.run_id,
            resolved_global_run=global_run,
            selected_runs=selected_runs,
            planned_downloads=total,
            successful_downloads=successful_downloads,
            failed_downloads=failed_downloads,
            planned_decompress=planned_decompress,
            successful_decompress=successful_decompress,
            failed_decompress=failed_decompress,
        )
        return

    if total == 0:
        print("\nNothing to do (already present or no matches).")
        session.close()
        write_status_json(
            out_dir,
            by_init_dir=by_init_dir,
            stage="idle",
            cycle_requested=str(args.cycle),
            cycle_selected=str(cycle),
            run_policy=str(args.run_policy),
            pinned_run_id=args.run_id,
            resolved_global_run=global_run,
            selected_runs=selected_runs,
            planned_downloads=total,
            successful_downloads=successful_downloads,
            failed_downloads=failed_downloads,
            planned_decompress=planned_decompress,
            successful_decompress=successful_decompress,
            failed_decompress=failed_decompress,
        )
        return

    print(f"\nPlanned downloads: {total}")
    results = []

    # Inline decompression? only if requested
    inline_decompress = bool(args.decompress and effective_decompress_phase == "inline")

    if download_engine == "aria2c":
        assert aria2c_bin is not None
        try:
            results = run_aria2c_downloads(
                download_plan=download_plan,
                aria2c_bin=aria2c_bin,
                net_workers=net_workers,
                split=args.aria2c_split,
                max_conn_per_server=args.aria2c_max_conn_per_server,
                proxy_url=args.proxy,
                proxy_user=args.proxy_user,
                throttle_bps=THROTTLE_BPS,
            )
        except KeyboardInterrupt:
            print("\nInterrupted by user.")
        if tqdm:
            pbar = tqdm(total=total, unit="file", desc="Downloading")
            pbar.update(len(results))
            pbar.close()
    else:
        pbar = tqdm(total=total, unit="file", desc="Downloading") if tqdm else None
        try:
            with ThreadPoolExecutor(max_workers=max(1, net_workers)) as ex:
                futs = [ex.submit(download_one, session, u, d, inline_decompress) for (u, d) in download_plan]
                for fut in as_completed(futs):
                    fname, ok, err = fut.result()
                    results.append((fname, ok, err))
                    if pbar:
                        pbar.update(1)
                    else:
                        with print_lock:
                            if ok:
                                print(f"[ok] {fname}")
                            else:
                                print(f"[err] {fname}: {err}")
        except KeyboardInterrupt:
            print("\nInterrupted by user. Cancelling pending downloads...")
        if pbar:
            pbar.close()

    ok_n = sum(1 for _, ok, _ in results if ok)
    err_items = [(f, e) for f, ok, e in results if not ok]
    successful_downloads = int(ok_n)
    failed_downloads = int(len(err_items))
    print(f"\nDownloads done. Successful: {ok_n}/{total}")
    if err_items:
        print("Errors:")
        for f, e in err_items[:20]:
            print(f"  - {f}: {e}")
        if len(err_items) > 20:
            print(f"  ... and {len(err_items)-20} more.")

    # Post-phase decompression
    post_targets: List[Tuple[Path, Path]] = []
    if args.decompress and effective_decompress_phase == "post":
        # If user launched with 'post', ensure we have a list of bz2 to decompress
        # Add any freshly downloaded .bz2 files as well
        for _, dest in download_plan:
            if "".join(dest.suffixes).endswith(".grib2.bz2"):
                final = Path(str(dest)[:-4])
                post_targets.append((dest, final))
        # Also include those noticed earlier (may include pre-existing .bz2)
        for t in to_decompress:
            if t not in post_targets:
                post_targets.append(t)

        # Filter to those that currently exist and need work
        work: List[Tuple[Path, Path]] = []
        for src, dst in post_targets:
            if not src.exists():
                continue
            if dst.exists() and not _is_valid_grib(dst):
                try:
                    dst.unlink()
                except Exception:
                    pass
            if not dst.exists():
                work.append((src, dst))
        if work:
            planned_decompress = int(len(work))
            print(f"\nDecompressing (post-phase): {len(work)} files with {args.cpu_workers} CPU worker(s)...")
            dbar = tqdm(total=len(work), unit="file", desc="Decompressing") if tqdm else None
            dec_results = []
            try:
                with ProcessPoolExecutor(max_workers=max(1, int(args.cpu_workers))) as pex:
                    futs = [pex.submit(_decompress_job, (src, dst, bool(args.keep_bz2), DO_FSYNC)) for (src, dst) in work]
                    for fut in as_completed(futs):
                        fname, ok, err = fut.result()
                        dec_results.append((fname, ok, err))
                        if dbar:
                            dbar.update(1)
                        else:
                            with print_lock:
                                if ok:
                                    print(f"[ok] {fname}")
                                else:
                                    print(f"[err] {fname}: {err}")
            except KeyboardInterrupt:
                print("\nInterrupted during decompression.")
            if dbar:
                dbar.close()

            ok_d = sum(1 for _, ok, _ in dec_results if ok)
            err_d = [(f, e) for f, ok, e in dec_results if not ok]
            successful_decompress = int(ok_d)
            failed_decompress = int(len(err_d))
            print(f"Decompression done. Successful: {ok_d}/{len(work)}")
            if err_d:
                print("Errors (decompress):")
                for f, e in err_d[:20]:
                    print(f"  - {f}: {e}")
                if len(err_d) > 20:
                    print(f"  ... and {len(err_d)-20} more.")

    session.close()
    write_status_json(
        out_dir,
        by_init_dir=by_init_dir,
        stage="complete",
        cycle_requested=str(args.cycle),
        cycle_selected=str(cycle),
        run_policy=str(args.run_policy),
        pinned_run_id=args.run_id,
        resolved_global_run=global_run,
        selected_runs=selected_runs,
        planned_downloads=total,
        successful_downloads=successful_downloads,
        failed_downloads=failed_downloads,
        planned_decompress=planned_decompress,
        successful_decompress=successful_decompress,
        failed_decompress=failed_decompress,
    )
    if failed_downloads or failed_decompress:
        raise SystemExit(1)


if __name__ == "__main__":
    try:
        os.system("")
    except Exception:
        pass
    main()
