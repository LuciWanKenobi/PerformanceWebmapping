"""HTTP helpers for local raster services (CORS, safe paths, byte ranges)."""
from __future__ import annotations

from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
import re
import threading
import uuid
from collections import OrderedDict
from urllib.parse import unquote, urlsplit, parse_qs

CLIENT_DISCONNECTS = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)


class LocalHTTPServer(ThreadingHTTPServer):
    # Browser tile bursts should queue at accept(), rather than being rejected
    # by the stdlib's five-connection default on Python 3.11/3.13.
    request_queue_size = 256
    daemon_threads = True


class RequestMetrics:
    """Counts raster requests received, independently of browser cache hits."""
    def __init__(self, scoped=False):
        self.lock = threading.Lock()
        self.instance = str(uuid.uuid4())
        self.requests = self.gets = self.ranges = self.completed = self.body_bytes = 0
        self.statuses = {}
        self.aborted = 0
        self.client_disconnected = self.truncated = self.handler_errors = 0
        self.scopes = None if scoped else OrderedDict()

    def scope(self, key):
        if not key or self.scopes is None:
            return None
        with self.lock:
            if key not in self.scopes:
                self.scopes[key] = RequestMetrics(scoped=True)
            self.scopes.move_to_end(key)
            if len(self.scopes) > 512:
                self.scopes.popitem(last=False)
            return self.scopes[key]

    def begin(self, command, ranged, scope=None):
        scoped = self.scope(scope)
        if scoped:
            scoped.begin(command, ranged)
        with self.lock:
            self.requests += 1
            self.gets += command == "GET"
            self.ranges += command == "GET" and bool(ranged)

    def finish(self, status, body_bytes, scope=None, aborted=False,
               client_disconnected=False, truncated=False, handler_error=False):
        scoped = self.scope(scope)
        if scoped:
            scoped.finish(status, body_bytes, aborted=aborted, client_disconnected=client_disconnected,
                          truncated=truncated, handler_error=handler_error)
        with self.lock:
            self.completed += 1
            self.body_bytes += body_bytes
            self.aborted += bool(aborted)
            self.client_disconnected += bool(client_disconnected)
            self.truncated += bool(truncated)
            self.handler_errors += bool(handler_error)
            key = str(status or 0)
            self.statuses[key] = self.statuses.get(key, 0) + 1

    def snapshot(self, scope=None):
        scoped = self.scope(scope)
        if scoped:
            return scoped.snapshot()
        with self.lock:
            return {"schemaVersion": 2, "instance": self.instance,
                    "cacheIsolationSupported": True,
                    "scopedMetricsSupported": True, "disconnectAccountingSupported": True,
                    "abortedRequestCount": self.aborted,
                    "clientDisconnectedRequestCount": self.client_disconnected,
                    "truncatedResponseCount": self.truncated, "handlerErrorCount": self.handler_errors,
                    "requestCount": self.requests, "getRequestCount": self.gets,
                    "rangeGetRequestCount": self.ranges, "completedRequestCount": self.completed,
                    "bodyBytesSent": self.body_bytes, "responseStatuses": dict(self.statuses)}


_metrics_lock = threading.Lock()


def request_metrics(server):
    with _metrics_lock:
        if not hasattr(server, "raster_metrics"):
            server.raster_metrics = RequestMetrics()
        return server.raster_metrics


def is_raster_request(path):
    parsed = urlsplit(path)
    if parsed.path.startswith(("/cog/", "/grib2/", "/tiles/")):
        return True
    params = {key.upper(): value[-1].lower() for key, value in parse_qs(parsed.query).items()}
    return parsed.path == "/wms" and params.get("REQUEST") == "getmap"


class LocalHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = 30  # Bound idle persistent connections and stalled socket IO.
    disable_nagle_algorithm = True

    def connection_policy(self):
        return {"version": 1, "httpProtocol": self.protocol_version,
                "requestQueueSize": self.server.request_queue_size,
                "socketTimeoutSeconds": self.timeout, "tcpNoDelay": self.disable_nagle_algorithm}

    def isolated_request(self):
        return bool(parse_qs(urlsplit(self.path).query).get("_map_request"))

    def handle_one_request(self):
        self._raster_request = False
        self._body_bytes = 0
        self._response_status = None
        self._content_length = None
        self._benchmark_scope = None
        self._server_render_ms = None
        self._headers_sent = self._client_disconnected = self._handler_error = False
        try:
            super().handle_one_request()
        except CLIENT_DISCONNECTS:
            # Includes Windows WSAECONNABORTED (10053). Never try to send an
            # error response down this socket or replace its original status.
            self._client_disconnected = True
            self.close_connection = True
        except Exception:
            self._handler_error = True
            self.close_connection = True
            raise
        finally:
            truncated = (getattr(self, 'command', None) != 'HEAD' and self._response_status not in (None, 204, 205, 304)
                         and self._content_length is not None and self._body_bytes < self._content_length)
            if self._raster_request:
                aborted = self._client_disconnected or truncated
                request_metrics(self.server).finish(self._response_status, self._body_bytes, self._benchmark_scope,
                                                   aborted, self._client_disconnected, truncated, self._handler_error)
            # An underlength/unframed response must not consume the next HTTP
            # response as its body on a persistent connection.
            if truncated or (self._headers_sent and self._content_length is None
                             and self._response_status not in (204, 205, 304)):
                self.close_connection = True

    def parse_request(self):
        valid = super().parse_request()
        if valid and is_raster_request(self.path):
            self._raster_request = True
            scope = parse_qs(urlsplit(self.path).query).get('_benchmark_scope', [None])[-1]
            if scope and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', scope):
                self._benchmark_scope = scope
            request_metrics(self.server).begin(self.command, self.headers.get("Range"), self._benchmark_scope)
        return valid

    def send_response(self, code, message=None):
        self._response_status = code
        super().send_response(code, message)

    def send_header(self, keyword, value):
        if keyword.lower() == "content-length":
            self._content_length = int(value)
        super().send_header(keyword, value)

    def send_error(self, code, message=None, explain=None):
        super().send_error(code, message, explain)
        if self.command != "HEAD" and code >= 200 and code not in (204, 205, 304):
            self._body_bytes += self._content_length

    def server_error(self, message):
        self._handler_error = True
        if self._headers_sent:
            self.close_connection = True
            return
        # Discard unflushed headers from a response which failed to prepare.
        self._headers_buffer = []
        self.send_json({"error": message}, 500)

    def serve_metrics(self):
        if urlsplit(self.path).path != "/metrics":
            return False
        scope = parse_qs(urlsplit(self.path).query).get('scope', [None])[-1]
        if scope and not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', scope):
            self.send_error(400, 'Invalid metrics scope')
            return True
        self.send_json({**request_metrics(self.server).snapshot(scope), "connectionPolicy": self.connection_policy()})
        return True

    def end_headers(self):
        if self._server_render_ms is not None:
            self.send_header('Server-Timing', f'render;dur={self._server_render_ms:.3f}')
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range, If-Range, If-None-Match")
        self.send_header("Access-Control-Expose-Headers",
                         "Accept-Ranges, Content-Range, Content-Length, ETag, Last-Modified, Server-Timing")
        self.send_header("Cache-Control", "no-store" if self.isolated_request() else "no-cache")
        self.send_header("Timing-Allow-Origin", "*")
        if self._content_length is None and self._response_status not in (204, 205, 304):
            self.send_header("Connection", "close")
            self.close_connection = True
        super().end_headers()
        self._headers_sent = True

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        self.do_GET()

    def send_bytes(self, data: bytes, content_type: str, status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)
            self._body_bytes += len(data)

    def send_json(self, value, status=200):
        self.send_bytes(json.dumps(value, allow_nan=False).encode(), "application/json", status)

    def serve_file(self, path: Path, ranges=False):
        with path.open("rb") as stream:
            import os
            stat = os.fstat(stream.fileno())
            size = stat.st_size
            etag = f'"{stat.st_mtime_ns:x}-{size:x}"'
            modified = formatdate(stat.st_mtime, usegmt=True)
            if not self.isolated_request() and self.headers.get("If-None-Match") in (etag, "*"):
                self.send_response(304)
                self.send_header("ETag", etag)
                self.end_headers()
                return
            start, end, status = 0, size - 1, 200
            requested = self.headers.get("Range") if ranges and self.command == "GET" else None
            if_range = self.headers.get("If-Range")
            if if_range and if_range not in (etag, modified):
                requested = None
            # A client can retry unsupported multi-ranges as single-range GETs.
            if requested and "," not in requested:
                match = re.fullmatch(r"bytes=(\d*)-(\d*)", requested.strip())
                try:
                    if not match or not any(match.groups()) or size == 0:
                        raise ValueError
                    first, last = match.groups()
                    if first:
                        start = int(first)
                        end = min(int(last), size - 1) if last else size - 1
                        if start > end:
                            raise ValueError
                    else:
                        length = int(last)
                        if length <= 0:
                            raise ValueError
                        start, end = max(0, size - length), size - 1
                    status = 206
                except ValueError:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
            self.send_response(status)
            self.send_header("Content-Type", "image/tiff" if path.suffix.lower() == ".tif" else
                             mimetypes.guess_type(path.name)[0] or "application/octet-stream")
            self.send_header("Content-Length", str(max(0, end - start + 1)))
            self.send_header("ETag", etag)
            self.send_header("Last-Modified", modified)
            if ranges:
                self.send_header("Accept-Ranges", "bytes")
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            if self.command == "HEAD":
                return
            stream.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = stream.read(min(256 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                self._body_bytes += len(chunk)
                remaining -= len(chunk)


def safe_path(root: Path, url_path: str) -> Path:
    decoded = unquote(url_path)
    if "\\" in decoded or "\x00" in decoded or ":" in decoded:
        raise ValueError("Invalid path.")
    path = (root / decoded.lstrip("/")).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError("Path outside data directory.")
    return path


def run_server(host, port, handler):
    with LocalHTTPServer((host, port), handler) as server:
        print(f"Serving at http://{host}:{server.server_port} (Ctrl+C to stop)", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
