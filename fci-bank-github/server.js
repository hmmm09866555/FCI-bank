'use strict';
/**
 * FCI Bank backend: zero-dependency Node server.
 *  - serves the app from ./public
 *  - JSON document store with realtime sync (Server-Sent Events)
 *  - accounts (scrypt-hashed PINs), signed session tokens, admin password
 *  - server-side ledger rules: ownership, balances, credit limits, price checks
 */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUB = path.join(__dirname, 'public');
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const CORS = process.env.CORS_ORIGIN || '';
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- secrets ----------
function loadOrCreate(file, make) {
  const p = path.join(DATA_DIR, file);
  try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) {}
  const v = make(); fs.writeFileSync(p, v + '\n', { mode: 0o600 }); return v;
}
const SECRET = loadOrCreate('secret.key', () => crypto.randomBytes(32).toString('hex'));
let ADMIN_PW = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_PW) {
  const fresh = !fs.existsSync(path.join(DATA_DIR, 'admin_password.txt'));
  ADMIN_PW = loadOrCreate('admin_password.txt', () => crypto.randomBytes(9).toString('base64url'));
  if (fresh) console.log('\n  Generated admin password: ' + ADMIN_PW + '\n  (saved in ' + path.join(DATA_DIR, 'admin_password.txt') + ', or set ADMIN_PASSWORD)\n');
}
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

// ---------- tokens ----------
function mkToken(k, s, ttl = 12 * 3600e3) {
  const p = Buffer.from(JSON.stringify({ k, s, e: Date.now() + ttl })).toString('base64url');
  return p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
}
function readToken(t, kind) {
  if (!t || typeof t !== 'string' || !t.includes('.')) return null;
  const [p, sig] = t.split('.');
  const good = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.k === kind && o.e > Date.now() ? o.s : null; } catch (e) { return null; }
}
// PINs/recovery words arrive already SHA-256'd by the client; we add a salted scrypt on top.
const wrap = h => { const salt = crypto.randomBytes(16).toString('hex'); return 'scrypt$' + salt + '$' + crypto.scryptSync(String(h), salt, 32).toString('hex'); };
const verify = (h, w) => { try { const [, salt, hex] = String(w).split('$'); return crypto.timingSafeEqual(crypto.scryptSync(String(h), salt, 32), Buffer.from(hex, 'hex')); } catch (e) { return false; } };

// ---------- store ----------
const COLS = ['orders', 'users', 'ledger', 'adminLedger', 'apps', 'appStatus', 'tickets', 'replies', 'points', 'redeem', 'userStatus', 'notifs', 'settings', 'audit'];
const DBF = path.join(DATA_DIR, 'data.json');
const DB = {}; COLS.forEach(c => DB[c] = {});
try { const j = JSON.parse(fs.readFileSync(DBF, 'utf8')); COLS.forEach(c => DB[c] = j[c] || {}); } catch (e) {}
let saveT = null;
function save(now) {
  if (now) { clearTimeout(saveT); saveT = null; } else { if (saveT) return; saveT = setTimeout(() => save(true), 300); return; }
  const tmp = DBF + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(DB)); fs.renameSync(tmp, DBF);
}
const SET = () => ({ timeout: 300, reg: true, selfDep: true, maint: false, maxTx: 100000, dailyLimit: 250000, ...(DB.settings.main || {}) });
const stOf = u => DB.userStatus[u]?.st || 'active';

// ---------- market (port of the client engine, used to validate trade prices) ----------
const SYMS = {}; [['AURM', 'Aurum Metals', 182, .5, 1.3, '#b8913a', 'Stocks', .0004], ['NVLX', 'Novalux Systems', 428, .8, 2.1, '#3b6df0', 'Stocks', .0004], ['HLXB', 'Helix Biotech', 96, 1.1, .4, '#1f9d76', 'Stocks', .0005], ['ORBT', 'Orbit Aerospace', 61, .9, 4.2, '#7a52d6', 'Stocks', .0005], ['MRDN', 'Meridian Energy', 74, .6, 5.5, '#d6663a', 'Stocks', .0004], ['QNTM', 'Quantum Labs', 134, 1.2, 6.1, '#18a6c9', 'Stocks', .0005], ['VLTC', 'Voltcoin', 2840, 1.8, 3.3, '#e0a21b', 'Crypto', .0012], ['ETHN', 'Etherion', 1620, 1.6, 7.2, '#6b7cff', 'Crypto', .0012], ['SOLR', 'Solaris', 94, 2.2, 8.4, '#a35cf0', 'Crypto', .0015], ['GLDX', 'Gold Futures', 2310, .35, 9.1, '#d8b45a', 'Commodities', .0006], ['CRDX', 'Crude Oil', 78.4, .7, 2.7, '#6a6a6a', 'Commodities', .0007], ['FCI50', 'FCI 50 Index', 5240, .3, 1.9, '#2d8f6f', 'Indices', .0002], ['NXG', 'Nexus 100', 18400, .4, 5.0, '#3a7bd5', 'Indices', .0002]].forEach(([s, n, p, v, ph, col, cat, sp]) => SYMS[s] = { s, n, p, v, ph, col, cat, sp });
const r2 = n => Math.round(n * 100) / 100, r4 = n => Math.round(n * 1e4) / 1e4;
const nz = (k, i) => { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x) - .5 };
function px(o, t) {
  const b = t / 3, i = Math.floor(b), f = b - i, sm = f * f * (3 - 2 * f), n = nz(o.ph, i) * (1 - sm) + nz(o.ph, i + 1) * sm, b2 = t / 37, j = Math.floor(b2), f2 = b2 - j, s2 = f2 * f2 * (3 - 2 * f2), n2 = nz(o.ph + 9, j) * (1 - s2) + nz(o.ph + 9, j + 1) * s2;
  const L = o.v * .06 * (Math.sin(t / 9000 + o.ph) + .6 * Math.sin(t / 2300 + o.ph * 2) + .3 * Math.sin(t / 410 + o.ph * 3)) + .004 * n * o.v + .009 * n2 * o.v + .1 * o.v * Math.sin(t / 604800 + o.ph * 1.7) + .07 * o.v * Math.sin(t / 2505600 + o.ph * .9);
  return +(o.p * Math.exp(L)).toFixed(o.p > 1000 ? 1 : 2);
}
const P = s => px(SYMS[s], Date.now() / 1000);
const ASK = s => +(P(s) * (1 + SYMS[s].sp)).toFixed(SYMS[s].p > 1000 ? 1 : 2), BID = s => +(P(s) * (1 - SYMS[s].sp)).toFixed(SYMS[s].p > 1000 ? 1 : 2);

// ---------- ledger state ----------
const CL = { obsidian: 50000, onyx: 40000, titanium: 30000, platinum: 15000, gold: 25000, rose: 12000, copper: 12000, glacier: 10000, emerald: 10000, midnight: 20000, ruby: 18000, aurora: 20000, sapphire: 22000, sunset: 15000, neon: 20000, holo: 18000, marble: 14000, void: 45000 };
const REW = { 'Food voucher': 200, 'Fuel voucher': 400, 'Cinema night': 300, 'Shopping voucher': 600 };
const ACCT_TYPES = ['Personal Account', 'Premium Account', 'Student Account', 'Savings Account'];
let BAL = {}, HOLD = {};
function applyEntry(e) {
  if (e.to) BAL[e.to] = r2((BAL[e.to] || 0) + e.amt);
  if (e.from) BAL[e.from] = r2((BAL[e.from] || 0) - e.amt);
  if (e.kind === 'trade' && e.user && e.sym) {
    const h = (HOLD[e.user] ??= {});
    h[e.sym] = r4((h[e.sym] || 0) + (e.side === 'buy' ? e.qty : -e.qty));
  }
}
function rebuild() { BAL = {}; HOLD = {}; for (const c of ['ledger', 'adminLedger']) for (const e of Object.values(DB[c])) applyEntry(e); }
rebuild();
const pts = u => Object.values(DB.points).filter(p => p.user === u).reduce((s, p) => s + p.n, 0) - Object.values(DB.redeem).filter(r => r.user === u).reduce((s, r) => s + r.cost, 0);

// ---------- realtime ----------
const clients = new Set(), dirty = new Set(); let flushT = null;
function snapshot(c) {
  if (c !== 'users') return DB[c];
  const o = {}; for (const [k, v] of Object.entries(DB.users)) { const { pin, rec, ...r } = v; o[k] = r; } return o;
}
const frame = c => 'event: snap\ndata: ' + JSON.stringify({ c, docs: snapshot(c) }) + '\n\n';
function touch(c) {
  dirty.add(c); save();
  if (flushT) return;
  flushT = setTimeout(() => { flushT = null; const cs = [...dirty]; dirty.clear(); for (const col of cs) { const f = frame(col); for (const r of clients) r.write(f); } }, 40);
}

// ---------- rate limits ----------
const hits = new Map();
function limited(key, max, win) {
  const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < win);
  if (a.length >= max) { hits.set(key, a); return true; } a.push(now); hits.set(key, a); return false;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) { const f = a.filter(t => now - t < 3600e3); f.length ? hits.set(k, f) : hits.delete(k); } for (const [k, v] of locks) if (v.exp < now) locks.delete(k); }, 60e3).unref();
const failsOf = new Map();
function lockedOut(u) { const a = (failsOf.get(u) || []).filter(t => Date.now() - t < 10 * 60e3); failsOf.set(u, a); return a.length >= 10; }
const fail = u => { const a = failsOf.get(u) || []; a.push(Date.now()); failsOf.set(u, a); };

// ---------- write rules ----------
const ADMIN_ONLY = new Set(['adminLedger', 'appStatus', 'userStatus', 'points', 'replies', 'settings']);
const CREATE_ONLY = new Set(['ledger', 'adminLedger', 'notifs', 'points', 'redeem', 'replies', 'audit', 'apps', 'tickets']);
const PUBLIC_CREATE = new Set(['apps', 'tickets']);
const sameDayUTC = (a, b) => new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);
const bad = m => [400, { error: m }];

function checkLedger(e, user) {
  if (!user || !DB.users[user]) return 'Sign in required';
  if (!(typeof e.amt === 'number' && isFinite(e.amt) && e.amt > 0 && e.amt === r2(e.amt))) return 'Bad amount';
  if (e.adm) return 'Not allowed';
  if (stOf(user) !== 'active') return 'This account is not active.';
  const u = DB.users[user], cards = u.cards || [], pockets = u.pockets || [], s = SET();
  const isCC = k => typeof k === 'string' && k.startsWith('cc:'), isPK = k => typeof k === 'string' && k.startsWith('pk:');
  const own = k => k === user || (isCC(k) && cards.some(c => 'cc:' + c.id === k)) || (isPK(k) && pockets.some(p => 'pk:' + p.id === k));
  switch (e.kind) {
    case 'deposit': if (e.from != null || e.to !== user) return 'Not allowed'; if (!s.selfDep) return 'Deposits are switched off.'; break;
    case 'advance': if (!(isCC(e.from) && own(e.from) && e.to === user)) return 'Not allowed'; break;
    case 'repay': if (!(e.from === user && isCC(e.to) && own(e.to))) return 'Not allowed'; break;
    case 'p2p': if (e.from !== user || !DB.users[e.to] || e.to === user || stOf(e.to) !== 'active') return 'Not allowed'; break;
    case 'pay': if (!(own(e.from) && (e.from === user || isCC(e.from)) && e.to == null)) return 'Not allowed'; break;
    case 'pocket': if (e.user !== user || !((e.from === user && isPK(e.to) && own(e.to)) || (e.to === user && isPK(e.from) && own(e.from)))) return 'Not allowed'; break;
    case 'trade': {
      const o = SYMS[e.sym]; if (e.user !== user || !o || !(e.qty > 0) || e.qty !== r4(e.qty)) return 'Bad order';
      if (e.side === 'buy') { if (e.from !== user || e.to !== 'MARKET') return 'Bad order'; }
      else if (e.side === 'sell') { if (e.from !== 'MARKET' || e.to !== user) return 'Bad order'; if (((HOLD[user] || {})[e.sym] || 0) + 1e-9 < e.qty) return 'You do not own that many units.'; }
      else return 'Bad order';
      const ref = e.side === 'buy' ? ASK(e.sym) : BID(e.sym);
      if (!(e.px > 0) || Math.abs(e.px - ref) / ref > .08) return 'Price moved. Please try again.';
      if (Math.abs(e.amt - r2(e.qty * e.px)) > .011) return 'Bad total';
      break;
    }
    default: return 'Not allowed';
  }
  if (['p2p', 'pay'].includes(e.kind)) {
    if (e.amt > s.maxTx) return 'Over the per-transaction limit.';
    const today = Object.values(DB.ledger).filter(t => t.from === e.from && ['p2p', 'pay'].includes(t.kind) && sameDayUTC(t.at, Date.now())).reduce((a, t) => a + t.amt, 0);
    if (today + e.amt > s.dailyLimit) return 'Daily limit reached.';
  }
  if (e.from && e.from !== 'MARKET') {
    const have = isCC(e.from) ? (cards.find(c => 'cc:' + c.id === e.from)?.credit || 0) + (BAL[e.from] || 0) : (BAL[e.from] || 0);
    if (have + .004 < e.amt) return isCC(e.from) ? 'Not enough available credit.' : 'Insufficient funds.';
  }
  return null;
}

function checkCards(old, next) {
  if (!Array.isArray(next) || next.length > 12 || next.length < old.length) return 'Bad cards';
  for (const c of next) {
    if (!c || typeof c.id !== 'string' || !/^\d{16}$/.test(String(c.num)) || !['Debit', 'Credit'].includes(c.type)) return 'Bad cards';
    const prev = old.find(x => x.id === c.id);
    if (prev) { if (prev.type !== c.type || prev.credit !== c.credit || prev.num !== c.num || prev.cvv !== c.cvv) return 'Bad cards'; }
    else if (c.type === 'Credit' ? c.credit !== CL[String(c.style).toLowerCase()] : c.credit != null) return 'Bad cards';
  }
  return null;
}

function writeUser(id, method, data, ctx) {
  const { user, admin } = ctx, exists = id in DB.users, s = SET();
  if (method === 'PUT' && !exists) {
    if (!/^[a-z0-9_]{3,20}$/.test(id)) return bad('Username: 3-20 letters, numbers or _');
    if (!s.reg && !admin) return [403, { error: 'Registration is currently closed.' }];
    const str = (v, n) => typeof v === 'string' && v.trim().length >= 1 && v.length <= n;
    if (!str(data.name, 40) || !str(data.surname, 40) || !ACCT_TYPES.includes(data.type) || !/^[0-9a-f]{64}$/.test(data.pin) || !/^[0-9a-f]{64}$/.test(data.rec)) return bad('Invalid details');
    if (!Array.isArray(data.cards) || data.cards.length !== 1 || data.cards[0].type !== 'Debit' || data.cards[0].credit != null || checkCards([], data.cards)) return bad('Invalid details');
    DB.users[id] = {
      name: data.name.trim(), surname: data.surname.trim(), type: data.type, style: String(data.style || 'Obsidian').slice(0, 20),
      acct: 'FCI-' + (10000000 + crypto.randomInt(90000000)), pin: wrap(data.pin), rec: wrap(data.rec),
      joined: Date.now(), seen: Date.now(), pockets: [], cards: data.cards
    };
    touch('users'); return [200, { ok: true, utoken: mkToken('u', id) }];
  }
  if (!exists) return [404, { error: 'Not found' }];
  if (method === 'PUT') return [403, { error: 'Not allowed' }];
  if (!admin && user !== id) return [403, { error: 'Not allowed' }];
  const cur = DB.users[id], patch = {};
  for (const [k, v] of Object.entries(data)) {
    if (!admin && !['seen', 'cards', 'pockets', 'watch', 'alerts'].includes(k)) return [403, { error: 'Not allowed' }];
    if (['acct', 'joined'].includes(k)) return [403, { error: 'Not allowed' }];
    if (k === 'pin' || k === 'rec') { if (!/^[0-9a-f]{64}$/.test(v)) return bad('Bad value'); patch[k] = wrap(v); continue; }
    if (k === 'cards') { const m = admin ? null : checkCards(cur.cards || [], v); if (m) return bad(m); }
    if (k === 'pockets' && (!Array.isArray(v) || v.length > 50)) return bad('Bad pockets');
    patch[k] = v;
  }
  DB.users[id] = { ...cur, ...patch }; touch('users'); return [200, { ok: true }];
}

function write(col, id, method, data, ctx) {
  if (!COLS.includes(col)) return [404, { error: 'Unknown collection' }];
  if (!/^[\w.-]{1,80}$/.test(id)) return bad('Bad id');
  if (!data || typeof data !== 'object' || Array.isArray(data) || JSON.stringify(data).length > 65536) return bad('Bad data');
  if (method === 'PATCH' && col !== 'users') return [405, { error: 'Not allowed' }];
  const { user, admin } = ctx, exists = id in DB[col];
  if (!admin && SET().maint) return [503, { error: 'FCI Bank is being updated.' }];
  if (ADMIN_ONLY.has(col) && !admin) return [403, { error: 'Admin only' }];
  if (col === 'users') return writeUser(id, method, data, ctx);
  if (CREATE_ONLY.has(col) && exists) return [409, { error: 'Already exists' }];
  if (!admin && !user && !PUBLIC_CREATE.has(col)) return [401, { error: 'Sign in required' }];
  if (user && !DB.users[user] && !admin) return [401, { error: 'Sign in required' }];

  if (col === 'ledger') {
    const m = checkLedger(data, user); if (m) return [422, { error: m }];
    data.at = Date.now(); DB.ledger[id] = data; applyEntry(data);
  } else if (col === 'adminLedger') {
    if (!(typeof data.amt === 'number' && data.amt > 0 && data.amt === r2(data.amt))) return bad('Bad amount');
    data.at = Date.now(); DB.adminLedger[id] = data; applyEntry(data);
  } else if (col === 'redeem') {
    if (data.user !== user || REW[data.item] !== data.cost) return bad('Bad reward');
    if (pts(user) < data.cost) return [422, { error: 'Not enough points.' }];
    data.at = Date.now(); DB.redeem[id] = data;
  } else if (col === 'orders') {
    const o = SYMS[data.sym], old = DB.orders[id];
    if (data.user !== user || !o || !(data.qty > 0) || !['buy', 'sell'].includes(data.side) || !['limit', 'stop'].includes(data.type) || !(data.price > 0) || !['open', 'filled', 'cancelled', 'rejected'].includes(data.status)) return bad('Bad order');
    if (old && (old.user !== user || old.status !== 'open')) return [403, { error: 'Not allowed' }];
    if (!old && data.status !== 'open') return bad('Bad order');
    DB.orders[id] = data;
  } else if (col === 'notifs') {
    if (typeof data.to !== 'string' || typeof data.t !== 'string') return bad('Bad data');
    data.at = Date.now(); DB.notifs[id] = data;
  } else if (col === 'audit') {
    if (typeof data.a !== 'string') return bad('Bad data');
    data.at = Date.now(); DB.audit[id] = data;
  } else if (col === 'apps' || col === 'tickets') {
    data.at = Date.now(); if (data.user && data.user !== user) data.user = user || null; DB[col][id] = data;
  } else {
    if (col === 'points' || col === 'replies') data.at = Date.now();
    DB[col][id] = data;
  }
  touch(col); return [200, { ok: true, at: data.at }];
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const SEC = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'" + (CORS ? ' ' + CORS : '') + "; frame-ancestors 'none'"
};
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SEC, ...(CORS ? { 'Access-Control-Allow-Origin': CORS } : {}) }); res.end(JSON.stringify(obj)); }
function body(req) {
  return new Promise((ok, no) => {
    let n = 0; const b = [];
    req.on('data', c => { n += c.length; if (n > 1e6) { no(new Error('big')); req.destroy(); } else b.push(c); });
    req.on('end', () => { try { ok(b.length ? JSON.parse(Buffer.concat(b).toString()) : {}); } catch (e) { no(new Error('json')); } });
    req.on('error', no);
  });
}
const ipOf = req => (process.env.TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || '?';
const locks = new Map();

async function api(req, res, u) {
  const p = u.pathname, m = req.method;
  if (CORS && m === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': CORS, 'Access-Control-Allow-Headers': 'Content-Type,X-User-Token,X-Admin-Token,X-Access-Code', 'Access-Control-Allow-Methods': 'GET,PUT,PATCH,POST,OPTIONS', 'Access-Control-Max-Age': '600' }); return res.end(); }
  if (p === '/api/health') return json(res, 200, { ok: true });
  const code = req.headers['x-access-code'] || u.searchParams.get('code') || '';
  const accessOK = !ACCESS_CODE || safeEq(code, ACCESS_CODE);
  if (p === '/api/config') return json(res, 200, { access: !!ACCESS_CODE, ok: accessOK, now: Date.now() });
  if (!accessOK) return json(res, 401, { error: 'access' });
  const ctx = { user: readToken(req.headers['x-user-token'], 'u'), admin: !!readToken(req.headers['x-admin-token'], 'a') };

  if (p === '/api/stream' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SEC, ...(CORS ? { 'Access-Control-Allow-Origin': CORS } : {}) });
    res.write('retry: 2000\n\n'); for (const c of COLS) res.write(frame(c));
    clients.add(res); req.on('close', () => clients.delete(res)); return;
  }
  if (p === '/api/lock' && m === 'POST') {
    const b = await body(req), k = String(b.key || '').slice(0, 120), now = Date.now(), cur = locks.get(k);
    if (!k) return json(res, 400, { error: 'key' });
    if (!cur || cur.exp < now || cur.holder === b.holder) { locks.set(k, { holder: String(b.holder || ''), exp: now + Math.min(+b.ttlMs || 1500, 10000) }); return json(res, 200, { acquired: true }); }
    return json(res, 200, { acquired: false });
  }
  if (p === '/api/login' && m === 'POST') {
    const b = await body(req), name = String(b.user || '').toLowerCase();
    if (limited('login|' + ipOf(req), 30, 60e3) || lockedOut(name)) return json(res, 429, { error: 'Too many unsuccessful attempts. Please try again later.' });
    const us = DB.users[name];
    if (!us || !verify(b.pin, us.pin)) { fail(name); return json(res, 401, { error: 'Incorrect details.' }); }
    if (stOf(name) !== 'active') return json(res, 403, { error: 'This account is not active.' });
    if (SET().maint && !ctx.admin) return json(res, 503, { error: 'FCI Bank is being updated.' });
    failsOf.delete(name); return json(res, 200, { ok: true, utoken: mkToken('u', name) });
  }
  if (p === '/api/recover' && m === 'POST') {
    const b = await body(req), name = String(b.user || '').toLowerCase(), us = DB.users[name];
    if (limited('rec|' + ipOf(req), 10, 60e3) || lockedOut(name)) return json(res, 429, { error: 'Too many attempts.' });
    if (!us || !verify(b.rec, us.rec) || !/^[0-9a-f]{64}$/.test(b.pin)) { fail(name); return json(res, 401, { error: 'Details do not match.' }); }
    us.pin = wrap(b.pin); failsOf.delete(name); touch('users'); return json(res, 200, { ok: true });
  }
  if (p === '/api/change-pin' && m === 'POST') {
    const b = await body(req), name = ctx.user, us = DB.users[name];
    if (!us || String(b.user) !== name) return json(res, 401, { error: 'Sign in required' });
    if (lockedOut(name)) return json(res, 429, { error: 'Too many attempts.' });
    if (!verify(b.old, us.pin) || !/^[0-9a-f]{64}$/.test(b.pin)) { fail(name); return json(res, 401, { error: 'Check your current and new PIN.' }); }
    us.pin = wrap(b.pin); touch('users'); return json(res, 200, { ok: true });
  }
  if (p === '/api/admin/login' && m === 'POST') {
    const b = await body(req);
    if (limited('adm|' + ipOf(req), 8, 10 * 60e3)) return json(res, 429, { error: 'Too many attempts.' });
    if (!safeEq(b.password || '', ADMIN_PW)) return json(res, 401, { error: 'Wrong password.' });
    return json(res, 200, { ok: true, atoken: mkToken('a', 'admin') });
  }
  if (p === '/api/admin/check' && m === 'GET') return ctx.admin ? json(res, 200, { ok: true }) : json(res, 401, { error: 'Not admin' });

  const mm = p.match(/^\/api\/c\/([A-Za-z]+)\/([^/]+)$/);
  if (mm) {
    const col = mm[1], id = decodeURIComponent(mm[2]);
    if (!COLS.includes(col)) return json(res, 404, { error: 'Unknown collection' });
    if (m === 'GET') {
      if (!(id in DB[col])) return json(res, 404, { error: 'Not found' });
      let d = DB[col][id]; if (col === 'users') { const { pin, rec, ...r } = d; d = r; }
      return json(res, 200, { data: d });
    }
    if (m === 'PUT' || m === 'PATCH') {
      if (limited('w|' + ipOf(req), 300, 60e3)) return json(res, 429, { error: 'Slow down.' });
      const [c, out] = write(col, id, m, await body(req), ctx); return json(res, c, out);
    }
  }
  return json(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, u) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel = decodeURIComponent(u.pathname); if (rel === '/') rel = '/index.html';
  const file = path.join(PUB, path.normalize(rel));
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { if (path.extname(rel)) { res.writeHead(404); return res.end('Not found'); } return fs.readFile(path.join(PUB, 'index.html'), (e2, b2) => { if (e2) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache', ...SEC }); res.end(b2); }); }
    const ext = path.extname(file), long = file.includes(path.sep + 'icons' + path.sep);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': long ? 'public, max-age=86400' : 'no-cache', ...SEC });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/api/')) return await api(req, res, u);
    return serveStatic(req, res, u);
  } catch (e) {
    if (!res.headersSent) json(res, e.message === 'big' ? 413 : e.message === 'json' ? 400 : 500, { error: e.message === 'json' ? 'Bad JSON' : 'Server error' });
    else res.end();
  }
});
setInterval(() => { for (const r of clients) r.write(': ping\n\n'); }, 20e3).unref();
server.listen(PORT, () => console.log('FCI Bank listening on http://localhost:' + PORT + (ACCESS_CODE ? '  (access code required)' : '')));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { save(true); } catch (e) {} process.exit(0); });
