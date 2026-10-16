#!/usr/bin/env python3
"""Local system/process CPU and process RSS for the mapping benchmark (port 8004)."""
import argparse
from collections import deque
import math
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import psutil

from http_common import LocalHandler, run_server


def cpu_counters(times):
    # Linux guest time is already part of user/nice. iowait is idle time.
    total = sum(times) - getattr(times, "guest", 0) - getattr(times, "guest_nice", 0)
    idle = times.idle + getattr(times, "iowait", 0)
    return total, idle


def classify_process(name, command):
    name = (name or '').lower()
    if name in ('chrome.exe', 'chrome', 'msedge.exe', 'msedge', 'firefox.exe', 'firefox', 'opera.exe', 'opera'):
        if any(arg == '--type=gpu-process' for arg in command):
            return 'browser-gpu-process'
        if any(arg == '--type=renderer' or arg == '-contentproc' for arg in command):
            return 'browser-renderer'
        return 'browser-other'
    scripts = {Path(arg).name for arg in command if isinstance(arg, str)}
    for script, role in (('serve_cog.py', 'cog-grib-server'), ('serve_wms.py', 'wms-png-server'),
                         ('serve_metrics.py', 'metrics-helper')):
        if script in scripts:
            return role
    return None


def process_snapshot():
    entries = []
    for process in psutil.process_iter(['pid', 'name', 'cmdline', 'create_time', 'cpu_times', 'memory_info'], ad_value=None):
        info = process.info
        role = classify_process(info['name'], info['cmdline'] or [])
        if role is None or info['create_time'] is None or info['cpu_times'] is None or info['memory_info'] is None:
            continue
        entries.append({'identity': f"{info['pid']}:{info['create_time']}", 'role': role,
                        'cpuSeconds': info['cpu_times'].user + info['cpu_times'].system,
                        'rssBytes': info['memory_info'].rss})
    return entries


class CpuSampler:
    def __init__(self, period=0.25):
        self.period = period
        self.samples = deque(maxlen=10000)
        self.process_samples = deque(maxlen=10000)
        self.processes = process_snapshot()
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        psutil.cpu_percent(interval=None)  # Discard the undefined first reading.
        previous, previous_time = {item['identity']: item for item in self.processes}, time.monotonic()
        while not self.stop_event.wait(self.period):
            value = psutil.cpu_percent(interval=None)
            now = time.monotonic()
            current = process_snapshot()
            groups = {}
            for item in current:
                group = groups.setdefault(item['role'], {'role': item['role'], 'rssBytes': 0, 'cpuPercent': 0})
                group['rssBytes'] += item['rssBytes']
                old = previous.get(item['identity'])
                if old and now > previous_time:
                    group['cpuPercent'] += max(0, item['cpuSeconds'] - old['cpuSeconds']) / (now - previous_time) * 100
            with self.lock:
                self.samples.append({"monotonicMs": now * 1000, "percent": value})
                self.process_samples.append({'monotonicMs': now * 1000, 'groups': list(groups.values())})
                self.processes = current
            previous, previous_time = {item['identity']: item for item in current}, now

    def snapshot(self, since=None):
        total, idle = cpu_counters(psutil.cpu_times())
        now = time.monotonic() * 1000
        with self.lock:
            samples = [dict(sample) for sample in self.samples
                       if since is not None and since < sample["monotonicMs"] <= now]
            process_samples = [dict(sample) for sample in self.process_samples
                               if since is not None and since < sample['monotonicMs'] <= now]
        return {"schemaVersion": 2, "scope": "system", "monotonicMs": now,
                "cpuTotalSeconds": total, "cpuIdleSeconds": idle,
                "logicalCpuCount": psutil.cpu_count(), "samplePeriodMs": self.period * 1000,
                "samples": samples, 'processes': process_snapshot(), 'processSamples': process_samples}

    def close(self):
        self.stop_event.set()
        self.thread.join(timeout=2)


def make_handler(sampler):
    class MetricsHandler(LocalHandler):
        def do_GET(self):
            parsed = urlsplit(self.path)
            if parsed.path in ("/", "/health"):
                self.send_json({"service": "benchmark-metrics", "cpu": "/cpu", "scope": "system", 'processMetricsSupported': True})
                return
            if parsed.path != "/cpu":
                self.send_error(404, "Use /cpu")
                return
            try:
                since = parse_qs(parsed.query).get("since", [None])[-1]
                if since is not None:
                    since = float(since)
                    if not math.isfinite(since) or since < 0:
                        raise ValueError
                self.send_json(sampler.snapshot(since))
            except ValueError:
                self.send_error(400, "since must be a finite nonnegative monotonic timestamp")
    return MetricsHandler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8004)
    args = parser.parse_args()
    sampler = CpuSampler()
    try:
        run_server(args.host, args.port, make_handler(sampler))
    finally:
        sampler.close()


if __name__ == "__main__":
    main()
