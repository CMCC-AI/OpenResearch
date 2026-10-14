// Keep the native research adapter's private /api URLs working with a prefixed Next app.
const http = require('node:http');
const { spawn } = require('node:child_process');
const prefix = '/deepxiv';
function upstreamPath(url) {
  return /^\/api(?:\/|\?|$)/.test(url) ? prefix + url : url;
}
module.exports = { upstreamPath };
if (require.main === module) {
  const port = Number(process.env.PORT || 3005);
  const innerPort = port + 1;
  const child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(innerPort), HOSTNAME: '127.0.0.1' },
    stdio: 'inherit',
  });
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith(prefix) && !req.url.startsWith('/api/')) {
      res.writeHead(308, { Location: prefix + (req.url === '/' ? '/' : req.url) });
      res.end(); return;
    }
    const upstream = http.request({
      hostname: '127.0.0.1', port: innerPort, path: upstreamPath(req.url),
      method: req.method, headers: req.headers,
    }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end(); });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
  });
  server.listen(port, process.env.HOSTNAME || '127.0.0.1');
  child.on('exit', code => { server.close(); process.exit(code || 1); });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    server.close(); child.kill(signal); setTimeout(() => process.exit(0), 5000).unref();
  });
}
