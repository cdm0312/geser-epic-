/* 《格斯尔·数智史诗》轻量后端
 * 静态文件服务 + REST API + SQLite 嵌入式数据库
 * 功能：阅读进度记忆、用户笔记（按匿名设备令牌隔离）
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'geser.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS reading_progress (
  device TEXT NOT NULL,
  chapter INTEGER NOT NULL,
  pct REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (device, chapter)
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device TEXT NOT NULL,
  chapter INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const qProgress = db.prepare('SELECT pct FROM reading_progress WHERE device=? AND chapter=?');
const qAllProgress = db.prepare('SELECT chapter, pct FROM reading_progress WHERE device=?');
const upProgress = db.prepare(`INSERT INTO reading_progress (device, chapter, pct, updated_at)
  VALUES (?,?,?,datetime('now'))
  ON CONFLICT(device, chapter) DO UPDATE SET pct=excluded.pct, updated_at=excluded.updated_at`);
const qNotes = db.prepare('SELECT id, chapter, content, created_at FROM notes WHERE device=? AND chapter=? ORDER BY id DESC');
const addNote = db.prepare('INSERT INTO notes (device, chapter, content) VALUES (?,?,?)');
const delNote = db.prepare('DELETE FROM notes WHERE id=? AND device=?');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function getDevice(req, res) {
  const t = String(req.headers['x-device-token'] || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(t)) { send(res, 401, { error: 'missing device token' }); return null; }
  return t;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 65536) { reject(new Error('too large')); req.destroy(); } chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  // 白名单：仅页面、脚本与 assets 目录
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (!(/^\/(index\.html|data\.js|app\.js)$/.test(rel) || rel.startsWith('/assets/'))) { send(res, 404, { error: 'not found' }); return; }
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { send(res, 404, { error: 'not found' }); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const pathname = u.pathname;
  try {
    if (pathname === '/api/health') return send(res, 200, { ok: true, service: 'geser-api' });

    if (pathname === '/api/progress' && req.method === 'GET') {
      const device = getDevice(req, res); if (!device) return;
      const ch = parseInt(u.searchParams.get('ch'), 10);
      if (!(ch >= 0 && ch <= 6)) return send(res, 400, { error: 'bad chapter' });
      const row = qProgress.get(device, ch);
      return send(res, 200, { ch, pct: row ? row.pct : 0 });
    }

    if (pathname === '/api/progress/all' && req.method === 'GET') {
      const device = getDevice(req, res); if (!device) return;
      const rows = qAllProgress.all(device);
      const out = {}; rows.forEach((r) => { out[r.chapter] = r.pct; });
      return send(res, 200, out);
    }

    if (pathname === '/api/progress' && req.method === 'POST') {
      const device = getDevice(req, res); if (!device) return;
      const b = await readBody(req);
      const ch = parseInt(b.ch, 10); const pct = Number(b.pct);
      if (!(ch >= 0 && ch <= 6) || !(pct >= 0 && pct <= 100)) return send(res, 400, { error: 'bad input' });
      upProgress.run(device, ch, pct);
      return send(res, 200, { ok: true, ch, pct });
    }

    if (pathname === '/api/notes' && req.method === 'GET') {
      const device = getDevice(req, res); if (!device) return;
      const ch = parseInt(u.searchParams.get('ch'), 10);
      if (!(ch >= 0 && ch <= 6)) return send(res, 400, { error: 'bad chapter' });
      return send(res, 200, qNotes.all(device, ch));
    }

    if (pathname === '/api/notes' && req.method === 'POST') {
      const device = getDevice(req, res); if (!device) return;
      const b = await readBody(req);
      const ch = parseInt(b.ch, 10); const content = String(b.content || '').trim();
      if (!(ch >= 0 && ch <= 6) || !content || content.length > 500) return send(res, 400, { error: 'bad input' });
      const r = addNote.run(device, ch, content);
      return send(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
    }

    if (pathname === '/api/notes' && req.method === 'DELETE') {
      const device = getDevice(req, res); if (!device) return;
      const id = parseInt(u.searchParams.get('id'), 10);
      if (!(id > 0)) return send(res, 400, { error: 'bad id' });
      const r = delNote.run(id, device);
      return send(res, 200, { ok: true, deleted: r.changes });
    }

    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'unknown api' });
    return serveStatic(req, res, pathname);
  } catch (e) {
    return send(res, 500, { error: 'server error' });
  }
});

server.listen(PORT, () => console.log(`geser app listening on http://localhost:${PORT}`));
