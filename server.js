// Static file server for the viewer.
//   node server.js [port]        -> http://localhost:8123
// Also imported by mcp/server.js, which adds /__wraps/ (uploaded wrap files) on top.
const http = require('http'), fs = require('fs'), path = require('path');
const root = __dirname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.png': 'image/png', '.pck': 'application/octet-stream', '.json': 'application/json' };

function start(port, { extraDirs = {}, host = '127.0.0.1', onMiss } = {}) {
  const server = http.createServer(async (req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
    let base = root, rel = p;
    for (const [prefix, dir] of Object.entries(extraDirs)) if (p.startsWith(prefix)) { base = dir; rel = p.slice(prefix.length); }
    let f = path.join(base, rel);
    const blocked = !f.startsWith(base) || f.includes('/.claude') || f.includes('/mcp/');     // checked on the requested path
    if (!blocked && !fs.existsSync(f) && onMiss) {                                            // trusted fallback (e.g. download a pack)
      try { f = (await onMiss(p)) || f; } catch (e) { console.error('[server] onMiss failed:', e.message); }
    }
    if (blocked || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Content-Length': fs.statSync(f).size });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(server)); });
}
module.exports = { start, root };
if (require.main === module) {
  const port = +process.argv[2] || 8123;
  start(port, { host: '0.0.0.0' }).then(() => console.log('Wrap Check on http://localhost:' + port));
}
