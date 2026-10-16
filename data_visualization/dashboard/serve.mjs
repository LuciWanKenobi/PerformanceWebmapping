import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('./dist/', import.meta.url));
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403); res.end(); return; }
    const body = await readFile(file);
    res.writeHead(200, {'Content-Type':types[path.extname(file)] || 'application/octet-stream', 'Cache-Control':'no-store'});
    res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
});
const initialPort = Number(process.env.PORT) || 4173;
let port = initialPort;
server.on('error', error => {
  if (error.code === 'EADDRINUSE' && !process.env.PORT && port < initialPort + 20) {
    port++;
    server.listen(port, '127.0.0.1');
  } else {
    console.error(`Could not start preview: ${error.message}`);
    process.exitCode = 1;
  }
});
server.on('listening', () => console.log(`Benchmark Lab: http://127.0.0.1:${server.address().port}`));
server.listen(port, '127.0.0.1');
