"""Real HTTP framing, keep-alive, bursts and disconnect-accounting regressions."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
from http.client import HTTPConnection, IncompleteRead, RemoteDisconnected
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from http_common import LocalHandler, LocalHTTPServer


@contextmanager
def service(handler):
    class QuietHandler(handler):
        def log_message(self, *args):
            pass
    with LocalHTTPServer(('127.0.0.1', 0), QuietHandler) as server:
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        thread.start()
        try:
            yield server
        finally:
            server.shutdown()
            thread.join()


def metrics(server, scope):
    with closing(HTTPConnection(*server.server_address, timeout=3)) as connection:
        connection.request('GET', '/metrics?scope=' + scope)
        return json.loads(connection.getresponse().read())


class HttpConnectionsTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'tile.png'
        self.payload = b'precomputed PNG bytes' * 100
        self.path.write_bytes(self.payload)

    def handler(self):
        path = self.path
        class Files(LocalHandler):
            def end_headers(self):
                self.send_header('X-Test-Client-Port', str(self.client_address[1]))
                super().end_headers()

            def do_GET(self):
                if self.serve_metrics():
                    return
                self.serve_file(path, ranges=True)
        return Files

    def test_one_connection_frames_full_range_head_options_304_and_416(self):
        with service(self.handler()) as server, closing(HTTPConnection(*server.server_address, timeout=3)) as connection:
            url = '/cog/data.tif?_benchmark_scope=keepalive'
            connection.request('GET', url)
            response = connection.getresponse()
            self.assertEqual(response.version, 11)
            self.assertEqual(response.read(), self.payload)
            port, etag, socket = response.headers['X-Test-Client-Port'], response.headers['ETag'], connection.sock
            for method, headers, status, body in [
                ('GET', {'Range': 'bytes=0-7'}, 206, self.payload[:8]),
                ('HEAD', {}, 200, b''), ('OPTIONS', {}, 204, b''),
                ('GET', {'If-None-Match': etag}, 304, b''),
                ('GET', {'Range': 'bytes=999999-'}, 416, b''), ('GET', {}, 200, self.payload),
            ]:
                connection.request(method, url, headers=headers)
                response = connection.getresponse()
                self.assertEqual(response.status, status)
                self.assertEqual(response.read(), body)
                self.assertEqual(response.headers['X-Test-Client-Port'], port)
                self.assertIs(connection.sock, socket)
            connection.request('GET', '/metrics?scope=keepalive')
            result = json.loads(connection.getresponse().read())
            self.assertEqual(result['requestCount'], 7)
            self.assertEqual(result['completedRequestCount'], 7)
            self.assertEqual(result['abortedRequestCount'], 0)
            self.assertEqual(result['clientDisconnectedRequestCount'], 0)
            self.assertEqual(result['truncatedResponseCount'], 0)
            self.assertEqual(result['connectionPolicy']['httpProtocol'], 'HTTP/1.1')
            self.assertEqual(result['connectionPolicy']['requestQueueSize'], 256)

    def test_twenty_clients_reuse_connections_for_160_independent_file_reads(self):
        barrier = threading.Barrier(20)
        ports = set()
        lock = threading.Lock()
        class Files(self.handler()):
            def serve_file(handler, *args, **kwargs):
                with lock:
                    ports.add(handler.client_address[1])
                return super().serve_file(*args, **kwargs)
        with service(Files) as server:
            def client(index):
                with closing(HTTPConnection(*server.server_address, timeout=5)) as connection:
                    connection.connect()
                    barrier.wait(timeout=5)
                    for layer in range(8):
                        connection.request('GET', f'/tiles/{layer}/5/13/13.png?_map_request={index}-{layer}&_benchmark_scope=burst')
                        response = connection.getresponse()
                        self.assertEqual(response.status, 200)
                        self.assertEqual(response.headers['Cache-Control'], 'no-store')
                        self.assertEqual(response.read(), self.payload)
            with ThreadPoolExecutor(max_workers=20) as pool:
                list(pool.map(client, range(20)))
            result = metrics(server, 'burst')
            self.assertEqual(len(ports), 20)
            self.assertEqual(result['requestCount'], 160)
            self.assertEqual(result['completedRequestCount'], 160)
            self.assertEqual(result['responseStatuses'], {'200': 160})
            self.assertEqual(result['bodyBytesSent'], len(self.payload) * 160)
            self.assertEqual(result['abortedRequestCount'], 0)
            self.assertEqual(result['handlerErrorCount'], 0)

    def test_disconnects_before_headers_or_during_body_preserve_status_and_close_once(self):
        for error in (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            for partial in (False, True):
                with self.subTest(error=error, partial=partial):
                    class Disconnected(LocalHandler):
                        def do_GET(handler):
                            if handler.serve_metrics():
                                return
                            if partial:
                                handler.send_response(200)
                                handler.send_header('Content-Length', '1024')
                                handler.end_headers()
                                handler.wfile.write(b'part')
                                handler._body_bytes += 4
                            raise error(10053, 'client disconnected')
                    with service(Disconnected) as server, closing(HTTPConnection(*server.server_address, timeout=3)) as connection:
                        connection.request('GET', '/tiles/test/5/13/13.png?_benchmark_scope=cancelled')
                        if partial:
                            response = connection.getresponse()
                            self.assertEqual(response.status, 200)
                            with self.assertRaises(IncompleteRead):
                                response.read()
                        else:
                            with self.assertRaises(RemoteDisconnected):
                                connection.getresponse()
                        result = metrics(server, 'cancelled')
                        self.assertEqual(result['requestCount'], 1)
                        self.assertEqual(result['completedRequestCount'], 1)
                        self.assertEqual(result['abortedRequestCount'], 1)
                        self.assertEqual(result['clientDisconnectedRequestCount'], 1)
                        self.assertEqual(result['truncatedResponseCount'], int(partial))
                        self.assertEqual(result['handlerErrorCount'], 0)
                        self.assertEqual(result['responseStatuses'], {'200' if partial else '0': 1})

    def test_genuine_errors_remain_http_errors_and_midstream_errors_are_not_client_cancellations(self):
        class Failed(LocalHandler):
            def do_GET(handler):
                if handler.serve_metrics():
                    return
                if urlsplit(handler.path).path.endswith('missing.png'):
                    handler.send_error(404, 'Missing PNG')
                elif urlsplit(handler.path).path.endswith('stream.png'):
                    handler.send_response(200)
                    handler.send_header('Content-Length', '1024')
                    handler.end_headers()
                    handler.wfile.write(b'part')
                    handler._body_bytes += 4
                    handler.server_error('File read failed after headers')
                else:
                    handler.server_error('File read failed before headers')
        with service(Failed) as server:
            for path, status in [('missing.png', 404), ('failed.png', 500), ('stream.png', 200)]:
                with closing(HTTPConnection(*server.server_address, timeout=3)) as connection:
                    connection.request('GET', '/tiles/' + path + '?_benchmark_scope=failed')
                    response = connection.getresponse()
                    self.assertEqual(response.status, status)
                    if path == 'stream.png':
                        with self.assertRaises(IncompleteRead):
                            response.read()
                    else:
                        self.assertTrue(response.read())
            result = metrics(server, 'failed')
            self.assertEqual(result['responseStatuses'], {'404': 1, '500': 1, '200': 1})
            self.assertEqual(result['handlerErrorCount'], 2)
            self.assertEqual(result['truncatedResponseCount'], 1)
            self.assertEqual(result['clientDisconnectedRequestCount'], 0)


if __name__ == '__main__':
    unittest.main()
