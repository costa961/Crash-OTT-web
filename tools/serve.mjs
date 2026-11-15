// Local server for the browser build: the page (web/dist), the game module (out/web/crashott.wasm)
// and the two file trees the module sees, over HTTP for the page's workers (web/src/host/fs.ts):
//   /fs/game/<path>       the player's game folder, read-only
//   /fs/userdata/<path>   saves and caches (out/userdata by default), read-write
// Cross-origin isolated (COOP/COEP): shared memory needs it. http://localhost is a secure context,
// so WebGPU and SharedArrayBuffer work without HTTPS.
//
//   node tools/serve.mjs --game <dir> [--userdata <dir> | --no-userdata] [--port 8080] [--host 127.0.0.1]
//
// --no-userdata (a server for others, deploy/): no /fs/userdata at all, nothing the players can write. The saves
// are in each player's browser anyway; /fs/userdata only lets the page import an older local build's saves.
//
// File API (the page's synchronous XHRs; paths are looked up case-insensitively, as on the console):
//   GET  ?op=stat                      {type, size, mtimeMs, ino} or 404
//   GET  ?op=list                      [{name, type, size}]
//   GET  (Range: bytes=a-b)            the bytes
//   PUT  ?op=write&pos=N  (body)       writes at N (creates the file)
//   POST ?op=truncate&size=N | op=mkdir | op=unlink | op=rmdir | op=rename&to=<root>/<path>
// /fs-manifest: every file of the game folder {files: [{p, s, m}]} (path, size, mtime), for the page's
// download into the browser's storage (web/src/host/download-worker.ts).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const game = arg('--game');
const noUserdata = argv.includes('--no-userdata');
const userdata = noUserdata ? null : path.resolve(arg('--userdata', path.join(ROOT, 'out', 'userdata')));
const port = Number(arg('--port', 8080)), host = arg('--host', '127.0.0.1');
if (!game || !fs.existsSync(path.join(game, 'default.xex'))) {
  console.error('serve: --game must be the extracted game folder (with default.xex)');
  process.exit(2);
}
const roots = { game: { dir: path.resolve(game), writable: false } };
if (userdata) {
  fs.mkdirSync(userdata, { recursive: true });
  roots.userdata = { dir: userdata, writable: true };
}
const DIST = path.join(ROOT, 'web', 'dist');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.map': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-cache' };

// A path under a root, each component matched case-insensitively when it doesn't exist as spelled.
function resolve(rootDir, rel) {
  let cur = rootDir;
  for (const part of rel.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return null;
    let next = path.join(cur, part);
    if (!fs.existsSync(next)) {
      try { const hit = fs.readdirSync(cur).find(n => n.toLowerCase() === part.toLowerCase()); if (hit) next = path.join(cur, hit); } catch {}
    }
    cur = next;
  }
  return cur.startsWith(rootDir) ? cur : null;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...isolation, ...headers });
  res.end(body);
}
const json = (res, value) => send(res, 200, JSON.stringify(value), { 'Content-Type': 'application/json' });
const readBody = req => new Promise((ok, fail) => { const parts = []; req.on('data', c => parts.push(c)); req.on('end', () => ok(Buffer.concat(parts))); req.on('error', fail); });

async function fileApi(req, res, url) {
  const [, , rootName, ...rest] = url.pathname.split('/');
  const root = Object.hasOwn(roots, rootName) ? roots[rootName] : null;
  if (!root) return send(res, 404, 'no such root');
  const rel = decodeURIComponent(rest.join('/'));
  const p = resolve(root.dir, rel);
  if (!p) return send(res, 400, 'bad path');
  const op = url.searchParams.get('op');
  const code = e => e?.code === 'ENOENT' ? 404 : e?.code === 'EEXIST' ? 409 : e?.code === 'ENOTEMPTY' ? 409 : e?.code === 'EISDIR' ? 409 : 500;
  try {
    if (req.method === 'GET' && op === 'stat') {
      const st = fs.statSync(p);
      return json(res, { type: st.isDirectory() ? 'dir' : 'file', size: st.size, mtimeMs: st.mtimeMs, ino: st.ino });
    }
    if (req.method === 'GET' && op === 'list') {
      return json(res, fs.readdirSync(p, { withFileTypes: true }).map(d => {
        let size = 0; try { size = d.isFile() ? fs.statSync(path.join(p, d.name)).size : 0; } catch {}
        return { name: d.name, type: d.isDirectory() ? 'dir' : 'file', size };
      }));
    }
    if (req.method === 'GET') {
      const st = fs.statSync(p);
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
      if (!m) {
        // a whole file (the page's download): streamed, never held in memory
        res.writeHead(200, { ...isolation, 'Content-Type': 'application/octet-stream', 'Content-Length': st.size });
        fs.createReadStream(p).pipe(res);
        return;
      }
      const start = m ? Number(m[1]) : 0, end = m && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      if (start >= st.size) return send(res, 206, Buffer.alloc(0), { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes */${st.size}` });
      const len = end - start + 1, buf = Buffer.alloc(len), fd = fs.openSync(p, 'r');
      try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
      return send(res, m ? 206 : 200, buf, { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${end}/${st.size}` });
    }
    if (!root.writable) return send(res, 403, 'read-only');
    if (req.method === 'PUT' && op === 'write') {
      const data = await readBody(req), pos = Number(url.searchParams.get('pos') ?? 0);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const fd = fs.openSync(p, fs.existsSync(p) ? 'r+' : 'w+');
      try { fs.writeSync(fd, data, 0, data.length, pos); } finally { fs.closeSync(fd); }
      return send(res, 204);
    }
    if (req.method === 'POST') {
      if (op === 'truncate') { if (!fs.existsSync(p)) fs.writeFileSync(p, ''); fs.truncateSync(p, Number(url.searchParams.get('size') ?? 0)); }
      else if (op === 'mkdir') fs.mkdirSync(p);
      else if (op === 'unlink') fs.unlinkSync(p);
      else if (op === 'rmdir') fs.rmdirSync(p);
      else if (op === 'rename') {
        const [toRoot, ...toRest] = (url.searchParams.get('to') ?? '').split('/');
        if (toRoot !== rootName) return send(res, 400, 'rename across roots');
        const q = resolve(root.dir, toRest.join('/'));
        if (!q) return send(res, 400, 'bad path');
        fs.renameSync(p, q);
      } else return send(res, 400, 'unknown op');
      return send(res, 204);
    }
    return send(res, 405, 'method');
  } catch (e) {
    return send(res, code(e), String(e?.code ?? e));
  }
}

function manifest(dir, prefix = '', out = []) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, d.name), rel = prefix + d.name;
    if (d.isDirectory()) manifest(full, rel + '/', out);
    else if (d.isFile()) { const st = fs.statSync(full); out.push({ p: rel, s: st.size, m: Math.round(st.mtimeMs) }); }
  }
  return out;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/fs-manifest') return json(res, { files: manifest(roots.game.dir) });
  if (url.pathname.startsWith('/fs/')) return fileApi(req, res, url);
  let file;
  if (url.pathname === '/crashott.wasm') file = path.join(ROOT, 'out', 'web', 'crashott.wasm');
  else {
    file = path.join(DIST, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
    if (!file.startsWith(DIST)) return send(res, 400, 'bad path');
  }
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  });
}).listen(port, host, () => {
  console.log(`serve: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/  (game ${roots.game.dir}, userdata ${userdata ?? 'off'})`);
});
