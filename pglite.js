// Tiny Postgres client with no dependencies: TLS, SCRAM-SHA-256 passwords and parameterised queries.
// Enough for Finders Keepers' accounts. One connection, queries run one at a time, reconnects on drop.
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

const TYPE = { BOOL: 16, INT8: 20, INT2: 21, INT4: 23, JSON: 114, FLOAT4: 700, FLOAT8: 701, NUMERIC: 1700, JSONB: 3802 };

function parseUrl(url) {
  const u = new URL(url);
  const q = Object.fromEntries(u.searchParams);
  return {
    host: u.hostname, port: Number(u.port) || 5432,
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')) || decodeURIComponent(u.username),
    sslmode: q.sslmode || 'require',
  };
}

class PgError extends Error {
  constructor(fields) { super(fields.M || 'Postgres error'); this.code = fields.C; this.detail = fields.D; this.pg = true; }
}

class Connection {
  constructor(cfg) { this.cfg = cfg; this.buf = Buffer.alloc(0); this.waiters = []; this.dead = false; }

  async open() {
    const { cfg } = this;
    let sock = await new Promise((res, rej) => {
      const s = net.connect(cfg.port, cfg.host, () => res(s));
      s.once('error', rej);
      s.setTimeout(15000, () => s.destroy(new Error('Database connection timed out')));
    });
    if (cfg.sslmode !== 'disable') {
      const req = Buffer.alloc(8); req.writeInt32BE(8, 0); req.writeInt32BE(80877103, 4);
      sock.write(req);
      const answer = await new Promise((res, rej) => { sock.once('data', d => res(d)); sock.once('error', rej); });
      if (answer[0] === 0x53) { // 'S'
        // like libpq: "require" encrypts without checking the certificate; verify-ca/verify-full check it
        const verify = cfg.sslmode === 'verify-ca' || cfg.sslmode === 'verify-full';
        sock = await new Promise((res, rej) => {
          const t = tls.connect({ socket: sock, servername: net.isIP(cfg.host) ? undefined : cfg.host, rejectUnauthorized: verify }, () => res(t));
          t.once('error', rej);
        });
      } else if (cfg.sslmode !== 'prefer' && cfg.sslmode !== 'allow') {
        sock.destroy(); throw new Error('Database does not support encrypted connections');
      }
    }
    this.sock = sock;
    sock.setTimeout(0);
    sock.on('data', d => this.onData(d));
    sock.on('error', e => this.fail(e));
    sock.on('close', () => this.fail(new Error('Database connection closed')));

    // startup
    const params = ['user', cfg.user, 'database', cfg.database, 'client_encoding', 'UTF8', 'application_name', 'finders-keepers'];
    const body = Buffer.concat([...params.map(p => cstr(p)), Buffer.from([0])]);
    const head = Buffer.alloc(8); head.writeInt32BE(8 + body.length, 0); head.writeInt32BE(196608, 4);
    sock.write(Buffer.concat([head, body]));
    await this.authenticate();
  }

  async authenticate() {
    let scram = null;
    for (;;) {
      const m = await this.next();
      if (m.type === 'R') {
        const code = m.data.readInt32BE(0);
        if (code === 0) continue; // AuthenticationOk
        if (code === 3) { this.sendMsg('p', cstr(this.cfg.password)); continue; }
        if (code === 5) {
          const salt = m.data.subarray(4, 8);
          const inner = md5(this.cfg.password + this.cfg.user);
          this.sendMsg('p', cstr('md5' + md5(Buffer.concat([Buffer.from(inner), salt]))));
          continue;
        }
        if (code === 10) { // SASL: pick SCRAM-SHA-256 (no channel binding)
          const mechs = m.data.subarray(4).toString().split('\0').filter(Boolean);
          if (!mechs.includes('SCRAM-SHA-256')) throw new Error('Database wants an unsupported login method: ' + mechs.join(', '));
          const nonce = crypto.randomBytes(18).toString('base64');
          const first = `n=*,r=${nonce}`;
          scram = { nonce, first };
          const msg = Buffer.from('n,,' + first);
          const len = Buffer.alloc(4); len.writeInt32BE(msg.length, 0);
          this.sendMsg('p', Buffer.concat([cstr('SCRAM-SHA-256'), len, msg]));
          continue;
        }
        if (code === 11) { // SASL continue
          const server = m.data.subarray(4).toString();
          const attrs = Object.fromEntries(server.split(',').map(kv => [kv[0], kv.slice(2)]));
          if (!attrs.r || !attrs.r.startsWith(scram.nonce)) throw new Error('Database login failed (bad nonce)');
          const salted = crypto.pbkdf2Sync(this.cfg.password.normalize('NFKC'), Buffer.from(attrs.s, 'base64'), Number(attrs.i), 32, 'sha256');
          const clientKey = hmac(salted, 'Client Key');
          const storedKey = crypto.createHash('sha256').update(clientKey).digest();
          const finalNoProof = `c=biws,r=${attrs.r}`;
          const authMsg = `${scram.first},${server},${finalNoProof}`;
          const sig = hmac(storedKey, authMsg);
          const proof = Buffer.alloc(32); for (let i = 0; i < 32; i++) proof[i] = clientKey[i] ^ sig[i];
          scram.serverSig = hmac(hmac(salted, 'Server Key'), authMsg).toString('base64');
          this.sendMsg('p', Buffer.from(`${finalNoProof},p=${proof.toString('base64')}`));
          continue;
        }
        if (code === 12) { // SASL final: check the server knows the password too
          const v = m.data.subarray(4).toString().split(',').find(x => x.startsWith('v='));
          if (!scram || !v || v.slice(2) !== scram.serverSig) throw new Error('Database login failed (server signature)');
          continue;
        }
        throw new Error('Unsupported database login method ' + code);
      }
      if (m.type === 'E') throw new PgError(fields(m.data));
      if (m.type === 'Z') return; // ready
      // S (parameter status), K (backend key), N (notice): ignore
    }
  }

  // Extended query protocol: parameters are always sent separately from the SQL.
  async query(sql, params = []) {
    const vals = params.map(v => v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));
    const bind = [cstr(''), cstr(''), int16(0), int16(vals.length)];
    for (const v of vals) {
      if (v === null) bind.push(int32(-1));
      else { const b = Buffer.from(v, 'utf8'); bind.push(int32(b.length), b); }
    }
    bind.push(int16(0));
    this.sock.write(Buffer.concat([
      msg('P', Buffer.concat([cstr(''), cstr(sql), int16(0)])),
      msg('B', Buffer.concat(bind)),
      msg('D', Buffer.concat([Buffer.from('P'), cstr('')])),
      msg('E', Buffer.concat([cstr(''), int32(0)])),
      msg('S', Buffer.alloc(0)),
    ]));
    let cols = [], rows = [], err = null, count = 0;
    for (;;) {
      const m = await this.next();
      if (m.type === 'T') cols = rowDesc(m.data);
      else if (m.type === 'D') rows.push(dataRow(m.data, cols));
      else if (m.type === 'C') { const t = m.data.toString().replace(/\0$/, '').split(' '); count = Number(t[t.length - 1]) || 0; }
      else if (m.type === 'E') err = new PgError(fields(m.data));
      else if (m.type === 'Z') { if (err) throw err; return { rows, rowCount: count }; }
    }
  }

  sendMsg(type, body) { this.sock.write(msg(type, body)); }

  onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < 1 + len) break;
      const m = { type: String.fromCharCode(this.buf[0]), data: Buffer.from(this.buf.subarray(5, 1 + len)) };
      this.buf = this.buf.subarray(1 + len);
      (this.queue || (this.queue = [])).push(m);
    }
    while (this.queue && this.queue.length && this.waiters.length) this.waiters.shift().res(this.queue.shift());
  }
  next() {
    if (this.queue && this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.dead) return Promise.reject(this.deadErr);
    return new Promise((res, rej) => this.waiters.push({ res, rej }));
  }
  fail(e) {
    if (this.dead) return;
    this.dead = true; this.deadErr = e;
    for (const w of this.waiters.splice(0)) w.rej(e);
  }
  close() { try { this.sock.write(msg('X', Buffer.alloc(0))); this.sock.end(); } catch { /* gone */ } this.fail(new Error('closed')); }
}

// Public: a "pool" of one connection with a queue, reconnecting when the database drops us
// (Neon puts idle databases to sleep and closes connections).
class Pg {
  constructor(url) { this.cfg = parseUrl(url); this.conn = null; this.chain = Promise.resolve(); }
  async connection() {
    if (this.conn && !this.conn.dead) return this.conn;
    const c = new Connection(this.cfg);
    await c.open();
    this.conn = c;
    return c;
  }
  query(sql, params) {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const c = await this.connection();
          return await c.query(sql, params);
        } catch (e) {
          if (e.pg || attempt >= 2) throw e; // real SQL errors aren't retried
          if (this.conn) this.conn.close();
          this.conn = null;
          await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
        }
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }
  end() { if (this.conn) this.conn.close(); }
}

// ---- wire helpers ----
const cstr = s => Buffer.from(String(s) + '\0', 'utf8');
const int16 = n => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const int32 = n => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const msg = (type, body) => { const h = Buffer.alloc(5); h[0] = type.charCodeAt(0); h.writeInt32BE(4 + body.length, 1); return Buffer.concat([h, body]); };
const md5 = x => crypto.createHash('md5').update(x).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
function fields(buf) {
  const f = {}; let i = 0;
  while (i < buf.length && buf[i] !== 0) { const code = String.fromCharCode(buf[i]); const end = buf.indexOf(0, i + 1); f[code] = buf.subarray(i + 1, end).toString(); i = end + 1; }
  return f;
}
function rowDesc(buf) {
  const n = buf.readInt16BE(0), cols = []; let i = 2;
  for (let k = 0; k < n; k++) {
    const end = buf.indexOf(0, i); const name = buf.subarray(i, end).toString(); i = end + 1;
    const oid = buf.readInt32BE(i + 6); i += 18;
    cols.push({ name, oid });
  }
  return cols;
}
function dataRow(buf, cols) {
  const n = buf.readInt16BE(0), row = {}; let i = 2;
  for (let k = 0; k < n; k++) {
    const len = buf.readInt32BE(i); i += 4;
    const col = cols[k] || { name: 'c' + k, oid: 0 };
    if (len === -1) { row[col.name] = null; continue; }
    const s = buf.subarray(i, i + len).toString('utf8'); i += len;
    row[col.name] = convert(s, col.oid);
  }
  return row;
}
function convert(s, oid) {
  switch (oid) {
    case TYPE.BOOL: return s === 't';
    case TYPE.INT2: case TYPE.INT4: case TYPE.FLOAT4: case TYPE.FLOAT8: return Number(s);
    case TYPE.INT8: case TYPE.NUMERIC: { const n = Number(s); return Number.isSafeInteger(n) || !Number.isInteger(n) ? n : s; }
    case TYPE.JSON: case TYPE.JSONB: return JSON.parse(s);
    default: return s;
  }
}

module.exports = { Pg, parseUrl };
