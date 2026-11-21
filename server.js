'use strict';
// Лёгкий сервер интерактивной доски: HTTP API + WebSocket синхронизация.
// Данные хранятся в JSON-файлах в DATA_DIR.

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const BOARD_DIR = path.join(DATA_DIR, 'boards');
const MAX_UPLOAD = (+process.env.MAX_UPLOAD_MB || 100) * 1024 * 1024;
const SIGNUP = process.env.SIGNUP || 'first'; // first | open | off
const APP_NAME = process.env.APP_NAME || 'Доска';
const SECURE_COOKIE = process.env.SECURE_COOKIE === '1';

for (const d of [DATA_DIR, UPLOAD_DIR, BOARD_DIR]) fs.mkdirSync(d, { recursive: true });

// ---------- helpers ----------
const rid = (n = 12) => crypto.randomBytes(n).toString('base64url');
const now = () => Date.now();

function writeJsonAtomic(file, data) {
  const tmp = file + '.' + rid(4) + '.tmp';
  return fsp.writeFile(tmp, JSON.stringify(data)).then(() => fsp.rename(tmp, file));
}
function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}

const secretFile = path.join(DATA_DIR, 'secret');
let SECRET;
try { SECRET = fs.readFileSync(secretFile, 'utf8').trim(); } catch {
  SECRET = rid(32); fs.writeFileSync(secretFile, SECRET, { mode: 0o600 });
}

// ---------- users ----------
const usersFile = path.join(DATA_DIR, 'users.json');
let users = readJson(usersFile, []);
const saveUsers = () => writeJsonAtomic(usersFile, users);

function hashPass(pass, salt = rid(16)) {
  const h = crypto.scryptSync(pass, salt, 64).toString('base64');
  return { salt, hash: h };
}
function checkPass(u, pass) {
  const h = crypto.scryptSync(pass, u.salt, 64);
  const s = Buffer.from(u.hash, 'base64');
  return h.length === s.length && crypto.timingSafeEqual(h, s);
}
function sign(v) { return crypto.createHmac('sha256', SECRET).update(v).digest('base64url'); }
function makeSession(uid) {
  const exp = now() + 1000 * 60 * 60 * 24 * 60;
  const v = uid + '.' + exp;
  return v + '.' + sign(v);
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function userFromReq(req) {
  const c = parseCookies(req).sid;
  if (!c) return null;
  const parts = c.split('.');
  if (parts.length !== 3) return null;
  const v = parts[0] + '.' + parts[1];
  const sig = Buffer.from(parts[2]);
  const good = Buffer.from(sign(v));
  if (sig.length !== good.length || !crypto.timingSafeEqual(sig, good)) return null;
  if (+parts[1] < now()) return null;
  return users.find(u => u.id === parts[0]) || null;
}
const pubUser = u => u && { id: u.id, name: u.name, email: u.email };

// ---------- boards ----------
// meta index in memory: id -> {id, owner, title, folder, createdAt, updatedAt, shareToken, shareMode}
const metas = new Map();
for (const f of fs.readdirSync(BOARD_DIR)) {
  if (!f.endsWith('.json')) continue;
  const b = readJson(path.join(BOARD_DIR, f), null);
  if (b && b.id) { const { items, ...m } = b; metas.set(b.id, m); }
}
const loaded = new Map(); // id -> board with items
const saveTimers = new Map();

function boardFile(id) { return path.join(BOARD_DIR, id + '.json'); }
function getBoard(id) {
  if (!/^[\w-]{4,40}$/.test(id) || !metas.has(id)) return null;
  let b = loaded.get(id);
  if (!b) {
    b = readJson(boardFile(id), null);
    if (!b) return null;
    b.items = b.items || {};
    loaded.set(id, b);
  }
  return b;
}
function scheduleSave(b, immediate) {
  b.updatedAt = now();
  const { items, ...m } = b; metas.set(b.id, m);
  clearTimeout(saveTimers.get(b.id));
  saveTimers.set(b.id, setTimeout(() => {
    saveTimers.delete(b.id);
    writeJsonAtomic(boardFile(b.id), b).catch(e => console.error('save', e));
    // выгружаем из памяти, если никого нет
    if (!rooms.get(b.id)?.size) loaded.delete(b.id);
  }, immediate ? 0 : 1500));
}
function createBoard(owner, title, folder, items) {
  const id = rid(9);
  const b = {
    id, owner, title: String(title || 'Новая доска').slice(0, 200), folder: String(folder || '').slice(0, 100),
    createdAt: now(), updatedAt: now(), shareToken: rid(12), shareMode: 'edit', items: items || {}
  };
  loaded.set(id, b);
  scheduleSave(b, true);
  return b;
}
const metaOut = m => ({ id: m.id, title: m.title, folder: m.folder, createdAt: m.createdAt, updatedAt: m.updatedAt, shareToken: m.shareToken, shareMode: m.shareMode, cover: m.cover || null });

// role on board: owner | edit | view | null
function roleFor(meta, user, token) {
  if (!meta) return null;
  if (user && meta.owner === user.id) return 'owner';
  if (token && meta.shareMode !== 'off' && token === meta.shareToken) return meta.shareMode === 'view' ? 'view' : 'edit';
  return null;
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2'
};

function send(res, code, body, headers = {}) {
  const isObj = body && typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJsonBody(req) {
  const buf = await readBody(req);
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch { return {}; }
}

async function serveFile(req, res, file, cache) {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) throw 0;
    const ext = path.extname(file).toLowerCase();
    const etag = '"' + st.size.toString(36) + '-' + st.mtimeMs.toString(36) + '"';
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cache || 'no-cache', ETag: etag, 'Accept-Ranges': 'bytes'
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) {
      let start = range[1] ? +range[1] : 0, end = range[2] ? +range[2] : st.size - 1;
      if (!range[1] && range[2]) { start = st.size - +range[2]; end = st.size - 1; }
      if (start >= st.size || end >= st.size || start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  } catch { send(res, 404, 'Not found'); }
}

const loginAttempts = new Map();
function rateLimited(ip) {
  const t = now(); const a = (loginAttempts.get(ip) || []).filter(x => t - x < 10 * 60 * 1000);
  a.push(t); loginAttempts.set(ip, a);
  return a.length > 30;
}
function setSession(res, uid) {
  res.setHeader('Set-Cookie', `sid=${encodeURIComponent(makeSession(uid))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 60}${SECURE_COOKIE ? '; Secure' : ''}`);
}

async function api(req, res, url) {
  const p = url.pathname;
  const user = userFromReq(req);
  const m = req.method;
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

  if (p === '/api/config' && m === 'GET') {
    return send(res, 200, { appName: APP_NAME, signup: SIGNUP === 'open' || (SIGNUP === 'first' && users.length === 0) });
  }
  if (p === '/api/me' && m === 'GET') return send(res, 200, { user: pubUser(user) });

  if (p === '/api/signup' && m === 'POST') {
    const allowed = SIGNUP === 'open' || (SIGNUP === 'first' && users.length === 0);
    if (!allowed) return send(res, 403, { error: 'Регистрация закрыта' });
    if (rateLimited(ip)) return send(res, 429, { error: 'Слишком много попыток' });
    const { email, password, name } = await readJsonBody(req);
    const e = String(email || '').trim().toLowerCase();
    if (!e || !/^\S+@\S+$/.test(e)) return send(res, 400, { error: 'Некорректный email' });
    if (String(password || '').length < 6) return send(res, 400, { error: 'Пароль минимум 6 символов' });
    if (users.some(u => u.email === e)) return send(res, 400, { error: 'Такой пользователь уже есть' });
    const u = { id: rid(8), email: e, name: String(name || e.split('@')[0]).slice(0, 60), ...hashPass(String(password)), createdAt: now() };
    users.push(u); await saveUsers();
    setSession(res, u.id);
    return send(res, 200, { user: pubUser(u) });
  }
  if (p === '/api/login' && m === 'POST') {
    if (rateLimited(ip)) return send(res, 429, { error: 'Слишком много попыток, подождите 10 минут' });
    const { email, password } = await readJsonBody(req);
    const u = users.find(u => u.email === String(email || '').trim().toLowerCase());
    if (!u || !checkPass(u, String(password || ''))) return send(res, 401, { error: 'Неверный email или пароль' });
    setSession(res, u.id);
    return send(res, 200, { user: pubUser(u) });
  }
  if (p === '/api/logout' && m === 'POST') {
    res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
    return send(res, 200, { ok: true });
  }
  if (p === '/api/password' && m === 'POST') {
    if (!user) return send(res, 401, { error: 'Нужен вход' });
    const { oldPassword, newPassword } = await readJsonBody(req);
    if (!checkPass(user, String(oldPassword || ''))) return send(res, 400, { error: 'Старый пароль неверен' });
    if (String(newPassword || '').length < 6) return send(res, 400, { error: 'Пароль минимум 6 символов' });
    Object.assign(user, hashPass(String(newPassword))); await saveUsers();
    return send(res, 200, { ok: true });
  }

  // ---- upload: owner or editor via token ----
  if (p === '/api/upload' && m === 'POST') {
    const meta = metas.get(url.searchParams.get('board') || '');
    const role = roleFor(meta, user, url.searchParams.get('k'));
    if (role !== 'owner' && role !== 'edit') return send(res, 403, { error: 'Нет доступа' });
    let name = decodeURIComponent(req.headers['x-filename'] || 'file');
    let ext = path.extname(name).toLowerCase().replace(/[^.\w]/g, '').slice(0, 8);
    if (!MIME[ext] || ext === '.html' || ext === '.js' || ext === '.svg') ext = ext === '.svg' ? '.svg.txt' : ext;
    if (!MIME[ext]) ext = '.bin';
    let buf;
    try { buf = await readBody(req, MAX_UPLOAD); } catch { return send(res, 413, { error: 'Файл слишком большой' }); }
    const fname = rid(10) + ext;
    await fsp.writeFile(path.join(UPLOAD_DIR, fname), buf);
    return send(res, 200, { url: '/uploads/' + fname, name, size: buf.length });
  }

  // ---- shared board info (for guests) ----
  let mm;
  if ((mm = /^\/api\/boards\/([\w-]+)\/info$/.exec(p)) && m === 'GET') {
    const meta = metas.get(mm[1]);
    const role = roleFor(meta, user, url.searchParams.get('k'));
    if (!role) return send(res, 403, { error: 'Нет доступа к доске' });
    return send(res, 200, { board: { id: meta.id, title: meta.title }, role, user: pubUser(user) });
  }

  if (!user) return send(res, 401, { error: 'Нужен вход' });

  if (p === '/api/boards' && m === 'GET') {
    const list = [...metas.values()].filter(b => b.owner === user.id).sort((a, b) => b.updatedAt - a.updatedAt).map(metaOut);
    return send(res, 200, { boards: list });
  }
  if (p === '/api/boards' && m === 'POST') {
    const { title, folder } = await readJsonBody(req);
    const b = createBoard(user.id, title, folder);
    return send(res, 200, { board: metaOut(b) });
  }
  if (p === '/api/boards/import' && m === 'POST') {
    const data = await readJsonBody(req);
    if (!data || typeof data.items !== 'object') return send(res, 400, { error: 'Неверный файл' });
    const b = createBoard(user.id, data.title || 'Импорт', data.folder, data.items);
    return send(res, 200, { board: metaOut(b) });
  }
  if ((mm = /^\/api\/boards\/([\w-]+)(\/(duplicate|export|rotate-link))?$/.exec(p))) {
    const meta = metas.get(mm[1]);
    if (!meta || meta.owner !== user.id) return send(res, 404, { error: 'Доска не найдена' });
    const action = mm[3];
    if (!action && m === 'PATCH') {
      const body = await readJsonBody(req);
      const b = getBoard(meta.id);
      if (typeof body.title === 'string') b.title = body.title.slice(0, 200);
      if (typeof body.folder === 'string') b.folder = body.folder.slice(0, 100);
      if (['edit', 'view', 'off'].includes(body.shareMode)) b.shareMode = body.shareMode;
      if (typeof body.cover === 'string') b.cover = body.cover.slice(0, 20);
      scheduleSave(b);
      broadcast(b.id, { t: 'meta', title: b.title, shareMode: b.shareMode });
      if (b.shareMode === 'off') kickGuests(b.id);
      return send(res, 200, { board: metaOut(b) });
    }
    if (!action && m === 'DELETE') {
      metas.delete(meta.id); loaded.delete(meta.id);
      clearTimeout(saveTimers.get(meta.id));
      await fsp.rm(boardFile(meta.id), { force: true });
      kickGuests(meta.id, true);
      return send(res, 200, { ok: true });
    }
    if (action === 'duplicate' && m === 'POST') {
      const b = getBoard(meta.id);
      const copy = createBoard(user.id, b.title + ' (копия)', b.folder, JSON.parse(JSON.stringify(b.items)));
      // сбрасываем ответы в упражнениях
      for (const it of Object.values(copy.items)) if (it.state) delete it.state;
      return send(res, 200, { board: metaOut(copy) });
    }
    if (action === 'rotate-link' && m === 'POST') {
      const b = getBoard(meta.id);
      b.shareToken = rid(12); scheduleSave(b); kickGuests(b.id);
      return send(res, 200, { board: metaOut(b) });
    }
    if (action === 'export' && m === 'GET') {
      const b = getBoard(meta.id);
      return send(res, 200, { title: b.title, folder: b.folder, items: b.items }, {
        'Content-Disposition': `attachment; filename="board-${b.id}.json"`
      });
    }
  }
  send(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (p.startsWith('/api/')) return await api(req, res, url);
    if (p.startsWith('/uploads/')) {
      const f = path.basename(p);
      return serveFile(req, res, path.join(UPLOAD_DIR, f), 'public, max-age=31536000, immutable');
    }
    if (p === '/' || p === '/index.html') return serveFile(req, res, path.join(PUBLIC_DIR, 'index.html'));
    if (/^\/b\/[\w-]+$/.test(p)) return serveFile(req, res, path.join(PUBLIC_DIR, 'board.html'));
    const f = path.normalize(path.join(PUBLIC_DIR, p));
    if (!f.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
    return serveFile(req, res, f, 'no-cache');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Ошибка сервера' });
  }
});

// ---------- WebSocket ----------
const rooms = new Map(); // boardId -> Set<ws>
const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024, perMessageDeflate: { threshold: 1024 } });
const COLORS = ['#e5484d', '#f76b15', '#ffb224', '#30a46c', '#12a594', '#0090ff', '#6e56cf', '#d6409f', '#8e4ec6', '#3e63dd'];

function broadcast(boardId, msg, except) {
  const room = rooms.get(boardId);
  if (!room) return;
  const data = JSON.stringify(msg);
  for (const c of room) if (c !== except && c.readyState === 1) c.send(data);
}
function kickGuests(boardId, all) {
  const room = rooms.get(boardId);
  if (!room) return;
  for (const c of room) if (all || c.role !== 'owner') c.close(4003, 'access revoked');
}
function peersOf(boardId) {
  return [...(rooms.get(boardId) || [])].map(c => ({ id: c.cid, name: c.name, color: c.color, role: c.role }));
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') return socket.destroy();
  const meta = metas.get(url.searchParams.get('board') || '');
  const user = userFromReq(req);
  const role = roleFor(meta, user, url.searchParams.get('k'));
  if (!role) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, ws => {
    ws.boardId = meta.id; ws.role = role; ws.user = user;
    ws.cid = rid(5);
    ws.name = (user ? user.name : String(url.searchParams.get('name') || 'Гость')).slice(0, 40);
    ws.color = COLORS[Math.floor(Math.random() * COLORS.length)];
    wss.emit('connection', ws);
  });
});

const ITEM_TYPES = new Set(['stroke', 'shape', 'text', 'sticky', 'image', 'video', 'audio', 'link', 'frame', 'gaps', 'quiz', 'match', 'order', 'file', 'table', 'timer']);
const STATE_KEYS = new Set(['state']);

function sanitizeItem(it) {
  if (!it || typeof it !== 'object' || typeof it.id !== 'string' || it.id.length > 40) return null;
  if (!ITEM_TYPES.has(it.type)) return null;
  return it;
}

wss.on('connection', ws => {
  const b = getBoard(ws.boardId);
  if (!b) return ws.close();
  let room = rooms.get(b.id);
  if (!room) rooms.set(b.id, room = new Set());
  room.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.send(JSON.stringify({
    t: 'init',
    board: { id: b.id, title: b.title, shareMode: b.shareMode, shareToken: ws.role === 'owner' ? b.shareToken : undefined, items: b.items },
    me: { id: ws.cid, name: ws.name, color: ws.color, role: ws.role },
    peers: peersOf(b.id)
  }));
  broadcast(b.id, { t: 'join', peer: { id: ws.cid, name: ws.name, color: ws.color, role: ws.role } }, ws);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const board = getBoard(ws.boardId);
    if (!board) return;
    switch (msg.t) {
      case 'op': {
        if (!Array.isArray(msg.ops)) return;
        const applied = [];
        for (const op of msg.ops.slice(0, 5000)) {
          const cur = op.id ? board.items[op.id] : null;
          const canEdit = ws.role === 'owner' || (ws.role === 'edit' && !(cur && cur.locked));
          if (op.o === 'put') {
            const it = sanitizeItem(op.item);
            if (!it) continue;
            const ex = board.items[it.id];
            if (ws.role === 'owner' || (ws.role === 'edit' && !(ex && ex.locked) && !it.locked)) {
              board.items[it.id] = it; applied.push({ o: 'put', item: it });
            }
          } else if (op.o === 'patch' && cur && op.p && typeof op.p === 'object') {
            let p = op.p;
            if (!canEdit) {
              // ученики (и редакторы на заблокированных объектах) могут менять только ответы в упражнениях
              p = {}; for (const k in op.p) if (STATE_KEYS.has(k)) p[k] = op.p[k];
              if (!Object.keys(p).length) continue;
            }
            if (ws.role !== 'owner' && 'locked' in p) delete p.locked;
            delete p.id; delete p.type;
            for (const k in p) { if (p[k] === null) delete cur[k]; else cur[k] = p[k]; }
            applied.push({ o: 'patch', id: op.id, p });
          } else if (op.o === 'del' && cur && canEdit) {
            delete board.items[op.id]; applied.push({ o: 'del', id: op.id });
          }
        }
        if (applied.length) {
          scheduleSave(board);
          broadcast(board.id, { t: 'op', ops: applied, from: ws.cid }, ws);
        }
        break;
      }
      case 'cursor': case 'laser': case 'ink':
        broadcast(board.id, { ...msg, id: ws.cid }, ws); break;
      case 'view': case 'attention':
        if (ws.role === 'owner' || ws.role === 'edit') broadcast(board.id, { ...msg, id: ws.cid, name: ws.name }, ws);
        break;
      case 'title':
        if (ws.role === 'owner' && typeof msg.title === 'string') {
          board.title = msg.title.slice(0, 200); scheduleSave(board);
          broadcast(board.id, { t: 'meta', title: board.title }, ws);
        }
        break;
      case 'ping': ws.send('{"t":"pong"}'); break;
    }
  });
  ws.on('close', () => {
    room.delete(ws);
    broadcast(ws.boardId, { t: 'leave', id: ws.cid });
    if (!room.size) {
      rooms.delete(ws.boardId);
      if (!saveTimers.has(ws.boardId)) loaded.delete(ws.boardId);
    }
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 30000);

function flushAll() {
  for (const [id, t] of saveTimers) {
    clearTimeout(t);
    const b = loaded.get(id);
    if (b) fs.writeFileSync(boardFile(id), JSON.stringify(b));
  }
}
process.on('SIGTERM', () => { flushAll(); process.exit(0); });
process.on('SIGINT', () => { flushAll(); process.exit(0); });

server.listen(PORT, HOST, () => console.log(`${APP_NAME}: http://${HOST}:${PORT}  (data: ${DATA_DIR})`));
