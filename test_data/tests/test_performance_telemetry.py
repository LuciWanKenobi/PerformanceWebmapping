"""Regression checks for trial isolation, aborted responses and process telemetry."""
from collections import namedtuple
from http.client import IncompleteRead
from pathlib import Path
import json
import sys
import unittest
from unittest.mock import patch
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from http_common import LocalHandler, RequestMetrics
from serve_metrics import classify_process, process_snapshot
from test_raster_services import service


class PerformanceTelemetryTest(unittest.TestCase):
    def test_scopes_exclude_other_clients_and_count_aborts_and_failures(self):
        metrics = RequestMetrics()
        baseline = metrics.snapshot('trial-a')
        metrics.begin('GET', True, 'trial-a')
        metrics.finish(206, 10, 'trial-a')
        metrics.begin('GET', False, 'trial-b')
        metrics.finish(200, 1000, 'trial-b')
        metrics.begin('GET', False, 'trial-a')
        metrics.finish(404, 20, 'trial-a')
        metrics.begin('GET', False, 'trial-a')
        metrics.finish(200, 5, 'trial-a', aborted=True)
        current = metrics.snapshot('trial-a')
        self.assertEqual(baseline['instance'], current['instance'])
        self.assertEqual(current['requestCount'], 3)
        self.assertEqual(current['bodyBytesSent'], 35)
        self.assertEqual(current['abortedRequestCount'], 1)
        self.assertEqual(current['responseStatuses'], {'206': 1, '404': 1, '200': 1})
        self.assertEqual(metrics.snapshot()['bodyBytesSent'], 1035)

    def test_http_aborted_body_is_counted_in_the_correct_trial(self):
        class PartialHandler(LocalHandler):
            def do_GET(self):
                if self.serve_metrics():
                    return
                self.send_response(200)
                self.send_header('Content-Length', '1024')
                self._server_render_ms = 12.5
                self.end_headers()
                self.wfile.write(b'partial')
                self._body_bytes += 7
        with service(PartialHandler) as base:
            with urlopen(base + '/cog/partial?_benchmark_scope=trial-a') as response:
                self.assertEqual(response.headers['Server-Timing'], 'render;dur=12.500')
                self.assertEqual(response.headers['Cross-Origin-Resource-Policy'], 'cross-origin')
                with self.assertRaises(IncompleteRead):
                    response.read()
            with urlopen(base + '/metrics?scope=trial-a') as response:
                metrics = json.load(response)
            self.assertEqual(metrics['requestCount'], 1)
            self.assertEqual(metrics['bodyBytesSent'], 7)
            self.assertEqual(metrics['abortedRequestCount'], 1)
            with urlopen(base + '/metrics?scope=trial-b') as response:
                self.assertEqual(json.load(response)['requestCount'], 0)

    def test_process_roles_and_private_command_lines(self):
        self.assertEqual(classify_process('chrome.exe', ['--type=renderer']), 'browser-renderer')
        self.assertEqual(classify_process('msedge.exe', ['--type=gpu-process']), 'browser-gpu-process')
        self.assertEqual(classify_process('python.exe', ['python', 'serve_wms.py']), 'wms-png-server')
        self.assertEqual(classify_process('python.exe', ['python', 'serve_cog.py']), 'cog-grib-server')
        self.assertIsNone(classify_process('unknown.exe', []))
        Times = namedtuple('Times', 'user system')
        Memory = namedtuple('Memory', 'rss')
        class Process:
            info = {'pid': 123, 'name': 'chrome.exe', 'cmdline': ['--type=renderer', '--private=secret'],
                    'create_time': 456, 'cpu_times': Times(2, 3), 'memory_info': Memory(1024)}
        with patch('serve_metrics.psutil.process_iter', return_value=[Process()]):
            result = process_snapshot()
        self.assertEqual(result, [{'identity': '123:456', 'role': 'browser-renderer', 'cpuSeconds': 5, 'rssBytes': 1024}])
        self.assertNotIn('secret', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
