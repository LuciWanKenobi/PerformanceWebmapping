#!/usr/bin/env python3
"""Local system CPU samples for the mapping benchmark (default port 8004)."""
import argparse
from collections import deque
import math
import threading
import time
from urllib.parse import parse_qs, urlsplit

import psutil

from http_common import LocalHandler, run_server


def cpu_counters(times):
    # Linux guest time is already part of user/nice. iowait is idle time.
    total = sum(times) - getattr(times, "guest", 0) - getattr(times, "guest_nice", 0)
    idle = times.idle + getattr(times, "iowait", 0)
    return total, idle


class CpuSampler:
    def __init__(self, period=0.25):
        self.period = period
        self.samples = deque(maxlen=10000)
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        psutil.cpu_percent(interval=None)  # Discard the undefined first reading.
        while not self.stop_event.wait(self.period):
            value = psutil.cpu_percent(interval=None)
            with self.lock:
                self.samples.append({"monotonicMs": time.monotonic() * 1000, "percent": value})

    def snapshot(self, since=None):
        total, idle = cpu_counters(psutil.cpu_times())
        now = time.monotonic() * 1000
        with self.lock:
            samples = [dict(sample) for sample in self.samples
                       if since is not None and since < sample["monotonicMs"] <= now]
        return {"schemaVersion": 1, "scope": "system", "monotonicMs": now,
                "cpuTotalSeconds": total, "cpuIdleSeconds": idle,
                "logicalCpuCount": psutil.cpu_count(), "samplePeriodMs": self.period * 1000,
                "samples": samples}

    def close(self):
        self.stop_event.set()
        self.thread.join(timeout=2)


def make_handler(sampler):
    class MetricsHandler(LocalHandler):
        def do_GET(self):
            parsed = urlsplit(self.path)
            if parsed.path in ("/", "/health"):
                self.send_json({"service": "benchmark-metrics", "cpu": "/cpu", "scope": "system"})
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
