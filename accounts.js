// Finders Keepers accounts: sign up / sign in, and everything a player keeps between games
// (coins, XP and level, wardrobe, starting powerup). Stored in Postgres when DATABASE_URL is set,
// otherwise in memory (fine for local testing, wiped on restart).
const crypto = require('crypto');
const { Pg } = require('./pglite');

// ---------- what can be unlocked: [id, name, coins, level] ----------
const CATALOG = {
  hat: { label: 'Hats', items: [['none', 'No hat', 0, 1], ['cap', 'Flat cap', 0, 1], ['bucket', 'Bucket hat', 50, 2], ['beanie', 'Bobble beanie', 50, 2], ['party', 'Party hat', 60, 3], ['cone', 'Traffic cone', 80, 4], ['hard', 'Hard hat', 100, 5], ['deer', 'Deerstalker', 100, 6], ['top', 'Top hat', 120, 8], ['cowboy', 'Cowboy hat', 150, 10], ['pirate', 'Pirate hat', 200, 12], ['viking', 'Viking helmet', 250, 15], ['halo', 'Halo', 400, 20], ['crown', 'Crown', 500, 25]] },
  jacket: { label: 'Jacket', items: [['auto', 'Team colour', 0, 1], ['red', 'Red', 30, 2], ['yellow', 'Yellow', 30, 2], ['pink', 'Pink', 30, 2], ['orange', 'Orange', 30, 2], ['purple', 'Purple', 30, 2], ['sky', 'Sky blue', 30, 2], ['black', 'Black', 60, 4], ['white', 'White', 60, 4], ['hivis', 'Hi-vis', 100, 6], ['camo', 'Camo', 120, 9], ['stripes', 'Breton stripes', 150, 11], ['tartan', 'Tartan', 150, 13]] },
  boots: { label: 'Wellies', items: [['green', 'Green', 0, 1], ['yellow', 'Yellow', 30, 2], ['red', 'Red', 30, 2], ['pink', 'Pink', 30, 3], ['blue', 'Blue', 30, 3], ['gold', 'Gold', 150, 14]] },
  pack: { label: 'Backpack', items: [['canvas', 'Canvas bag', 0, 1], ['leather', 'Leather satchel', 60, 3], ['teddy', 'Teddy bear', 120, 7], ['chest', 'Treasure chest', 250, 12], ['rocket', 'Rocket pack', 300, 18]] },
  pet: { label: 'Pet', items: [['none', 'No pet', 0, 1], ['duck', 'Duck', 200, 5], ['dog', 'Dog', 300, 9], ['cat', 'Cat', 300, 9], ['parrot', 'Parrot', 250, 13], ['mole', 'Mole', 350, 22]] },
  trail: { label: 'Trail', items: [['none', 'No trail', 0, 1], ['prints', 'Muddy prints', 50, 2], ['hearts', 'Hearts', 150, 7], ['sparkle', 'Sparkles', 200, 11], ['gold', 'Gold dust', 400, 24]] },
  det: { label: 'Detector', items: [['classic', 'Classic', 0, 1], ['retro', 'Retro wood', 100, 6], ['neon', 'Neon', 150, 12], ['gold', 'Gold', 300, 20]] },
  spade: { label: 'Spade', items: [['old', 'Old spade', 0, 1], ['steel', 'Shiny steel', 80, 5], ['gold', 'Golden', 250, 16]] },
  win: { label: 'Victory', items: [['confetti', 'Confetti', 0, 1], ['fireworks', 'Fireworks', 100, 7], ['coins', 'Coin shower', 150, 12], ['fanfare', 'Fanfare', 200, 17]] },
};
// starting powerups: key -> [level, coins per round]
const LOADOUT = { c: [2, 15], t: [3, 15], w: [4, 15], m: [5, 20], p: [6, 25], l: [7, 25], b: [8, 20], s: [9, 25], r: [10, 30], k: [12, 30], g: [14, 35], d: [16, 35], q: [18, 40] };
const MAX_LEVEL = 50, START_COINS = 50, IMPORT_CAP = 3000;
const xpForLevel = L => 300 * (L - 1) + 50 * (L - 1) * (L - 2); // total XP needed to reach level L
const levelFor = xp => { let L = 1; while (L < MAX_LEVEL && xp >= xpForLevel(L + 1)) L++; return L; };
const item = (cat, id) => CATALOG[cat] && CATALOG[cat].items.find(i => i[0] === id);
const isFree = (cat, id) => { const it = item(cat, id); return !!it && it[2] === 0; };

const NAME_RE = /^[\p{L}\p{N} _'-]{3,12}$/u;
const cleanName = s => String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim();

// ---------- storage ----------
class MemStore {
  constructor() { this.players = new Map(); this.sessions = new Map(); this.persistent = false; }
  async init() {}
  async get(key) { return this.players.get(key) || null; }
  async getByGoogle(sub) { for (const p of this.players.values()) if (p.google === sub) return p; return null; }
  async create(row) {
    if (this.players.has(row.key) || (row.google && await this.getByGoogle(row.google))) return false;
    this.players.set(row.key, JSON.parse(JSON.stringify(row))); return true;
  }
  async save(key, data) { const p = this.players.get(key); if (p) p.data = JSON.parse(JSON.stringify(data)); }
  async setPassword(key, hash, salt) { const p = this.players.get(key); if (p) { p.hash = hash; p.salt = salt; } }
  async setGoogle(key, sub) { if (await this.getByGoogle(sub)) return false; const p = this.players.get(key); if (p) p.google = sub; return true; }
  async addSession(hash, key, kind) { this.sessions.set(hash, { key, kind }); }
  async getSession(hash) { return this.sessions.get(hash) || null; }
  async delSession(hash) { this.sessions.delete(hash); }
  async delSessions(key) { for (const [h, s] of this.sessions) if (s.key === key) this.sessions.delete(h); }
}
class PgStore {
  constructor(url) { this.db = new Pg(url); this.persistent = true; }
  async init() {
    await this.db.query(`CREATE TABLE IF NOT EXISTS fk_players (
      name_key TEXT PRIMARY KEY, name TEXT NOT NULL, pass_hash TEXT NOT NULL, salt TEXT NOT NULL,
      data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await this.db.query(`CREATE TABLE IF NOT EXISTS fk_sessions (
      token_hash TEXT PRIMARY KEY, name_key TEXT NOT NULL REFERENCES fk_players(name_key) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    // added with Google sign-in (safe to run on the existing tables)
    await this.db.query('ALTER TABLE fk_players ADD COLUMN IF NOT EXISTS google_sub TEXT UNIQUE');
    await this.db.query("ALTER TABLE fk_sessions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'password'");
  }
  row(p) { return p ? { key: p.name_key, name: p.name, hash: p.pass_hash, salt: p.salt, data: p.data, google: p.google_sub } : null; }
  async get(key) { const r = await this.db.query('SELECT * FROM fk_players WHERE name_key = $1', [key]); return this.row(r.rows[0]); }
  async getByGoogle(sub) { const r = await this.db.query('SELECT * FROM fk_players WHERE google_sub = $1', [sub]); return this.row(r.rows[0]); }
  async create(row) {
    try {
      const r = await this.db.query('INSERT INTO fk_players (name_key, name, pass_hash, salt, data, google_sub) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (name_key) DO NOTHING',
        [row.key, row.name, row.hash, row.salt, row.data, row.google || null]);
      return r.rowCount === 1;
    } catch (e) { if (e.code === '23505') return false; throw e; } // google account already used
  }
  async save(key, data) { await this.db.query('UPDATE fk_players SET data = $2, updated_at = now() WHERE name_key = $1', [key, data]); }
  async setPassword(key, hash, salt) { await this.db.query('UPDATE fk_players SET pass_hash = $2, salt = $3, updated_at = now() WHERE name_key = $1', [key, hash, salt]); }
  async setGoogle(key, sub) {
    try { await this.db.query('UPDATE fk_players SET google_sub = $2, updated_at = now() WHERE name_key = $1', [key, sub]); return true; }
    catch (e) { if (e.code === '23505') return false; throw e; }
  }
  async addSession(hash, key, kind) { await this.db.query('INSERT INTO fk_sessions (token_hash, name_key, kind) VALUES ($1, $2, $3)', [hash, key, kind]); }
  async getSession(hash) { const r = await this.db.query('SELECT name_key, kind FROM fk_sessions WHERE token_hash = $1', [hash]); return r.rows[0] ? { key: r.rows[0].name_key, kind: r.rows[0].kind } : null; }
  async delSession(hash) { await this.db.query('DELETE FROM fk_sessions WHERE token_hash = $1', [hash]); }
  async delSessions(key) { await this.db.query('DELETE FROM fk_sessions WHERE name_key = $1', [key]); }
}

// ---------- accounts ----------
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => e ? rej(e) : res(k.toString('hex'))));
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
// recovery codes: 12 easy-to-read characters, shown once, only the hash is kept
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.randomBytes(12), b => CODE_CHARS[b % 32]).join('').replace(/(.{4})(?=.)/g, '$1-');
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const checkPw = pw => { if (typeof pw !== 'string' || pw.length < 6 || pw.length > 72) throw new UserError('Passwords need at least 6 characters.'); };

class Accounts {
  constructor(url) {
    this.store = url ? new PgStore(url) : new MemStore();
    this.cache = new Map(); // name_key -> {key, name, data}
  }
  get persistent() { return this.store.persistent; }
  async init() { await this.store.init(); }

  async load(key) {
    if (this.cache.has(key)) return this.cache.get(key);
    const row = await this.store.get(key); if (!row) return null;
    const acct = { key: row.key, name: row.name, data: row.data, google: row.google || null, hasPw: !!row.hash };
    this.cache.set(key, acct);
    return acct;
  }
  save(acct) { return this.store.save(acct.key, acct.data); }

  async signup(rawName, pw, imp) {
    const name = cleanName(rawName);
    if (!NAME_RE.test(name)) throw new UserError('Names are 3 to 12 letters or numbers (spaces, _ and - are fine).');
    checkPw(pw);
    const key = name.toLowerCase();
    const salt = crypto.randomBytes(16).toString('hex');
    const data = { coins: START_COINS, xp: 0, owned: [], look: {}, loadout: null, rounds: 0, wins: 0 };
    // bring across what this phone had saved before accounts existed
    if (imp && typeof imp === 'object') {
      data.coins += Math.max(0, Math.min(IMPORT_CAP, Math.floor(Number(imp.coins) || 0) - START_COINS));
      if (Array.isArray(imp.owned)) data.owned = [...new Set(imp.owned.filter(o => typeof o === 'string' && (([c, i]) => item(c, i))(o.split(':'))))];
      if (imp.look && typeof imp.look === 'object') data.look = imp.look;
    }
    const recovery = newCode(); data.recovery = sha(normCode(recovery));
    const acct = { key, name, data, google: null, hasPw: true };
    data.look = this.cleanLook(acct, data.look);
    const ok = await this.store.create({ key, name, hash: await scrypt(pw, salt), salt, data });
    if (!ok) throw new UserError('That name is taken. Try another, or sign in if it\'s yours.');
    this.cache.set(key, acct);
    return { acct, token: await this.newSession(key, 'password'), recovery };
  }
  async login(rawName, pw) {
    const key = cleanName(rawName).toLowerCase();
    const row = key && typeof pw === 'string' ? await this.store.get(key) : null;
    const hash = await scrypt(String(pw || ''), row ? row.salt : 'x'.repeat(32));
    if (row && !row.hash) throw new UserError('That account signs in with Google. Use the Google button.');
    if (!row || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(row.hash))) throw new UserError('Wrong name or password.');
    const acct = await this.load(key);
    return { acct, token: await this.newSession(key, 'password') };
  }
  async newSession(key, kind) {
    const token = crypto.randomBytes(32).toString('base64url');
    await this.store.addSession(sha(token), key, kind || 'password');
    return token;
  }
  async session(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const s = await this.store.getSession(sha(token)); if (!s) return null;
    const acct = await this.load(s.key);
    return acct ? { acct, kind: s.kind } : null;
  }
  async bySession(token) { const s = await this.session(token); return s ? s.acct : null; }

  // ----- forgotten passwords: recovery code, or Google -----
  async newRecovery(acct) {
    const code = newCode(); acct.data.recovery = sha(normCode(code)); await this.save(acct); return code;
  }
  async recover(rawName, code, pw) {
    checkPw(pw);
    const key = cleanName(rawName).toLowerCase(), acct = key ? await this.load(key) : null;
    const want = acct && acct.data.recovery, got = sha(normCode(code));
    if (!want || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got))) throw new UserError('That name and recovery code don\'t match.');
    const salt = crypto.randomBytes(16).toString('hex');
    await this.store.setPassword(key, await scrypt(pw, salt), salt); acct.hasPw = true;
    await this.store.delSessions(key); // sign out everywhere else
    const recovery = await this.newRecovery(acct); // each code works once
    return { acct, token: await this.newSession(key, 'recovery'), recovery };
  }
  // signed in: change or set a password. Needs the current one unless they just proved who they are another way.
  async setPassword(acct, kind, current, pw) {
    checkPw(pw);
    if (acct.hasPw && kind === 'password') {
      const row = await this.store.get(acct.key);
      const hash = await scrypt(String(current || ''), row.salt);
      if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(row.hash))) throw new UserError('Your current password isn\'t right.');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    await this.store.setPassword(acct.key, await scrypt(pw, salt), salt); acct.hasPw = true;
  }

  // ----- Google -----
  async googleSignIn(claims) {
    const row = await this.store.getByGoogle(claims.sub);
    if (!row) return { needName: true, suggestion: await this.freeName(claims.given_name || claims.name) };
    const acct = await this.load(row.key);
    return { acct, token: await this.newSession(row.key, 'google') };
  }
  async freeName(raw) {
    let base = cleanName(raw).replace(/[^\p{L}\p{N} _'-]/gu, '').slice(0, 10);
    if (base.length < 3) base = 'Digger';
    for (let i = 0; i < 50; i++) { const n = i ? base + (i + 1) : base; if (!(await this.store.get(n.toLowerCase()))) return n; }
    return base + (100 + (Math.random() * 900 | 0));
  }
  async googleSignUp(claims, rawName, imp) {
    if (await this.store.getByGoogle(claims.sub)) return this.googleSignIn(claims);
    const name = cleanName(rawName);
    if (!NAME_RE.test(name)) throw new UserError('Names are 3 to 12 letters or numbers (spaces, _ and - are fine).');
    const key = name.toLowerCase();
    const data = { coins: START_COINS, xp: 0, owned: [], look: {}, loadout: null, rounds: 0, wins: 0 };
    if (imp && typeof imp === 'object') {
      data.coins += Math.max(0, Math.min(IMPORT_CAP, Math.floor(Number(imp.coins) || 0) - START_COINS));
      if (Array.isArray(imp.owned)) data.owned = [...new Set(imp.owned.filter(o => typeof o === 'string' && (([c, i]) => item(c, i))(o.split(':'))))];
      if (imp.look && typeof imp.look === 'object') data.look = imp.look;
    }
    const acct = { key, name, data, google: claims.sub, hasPw: false };
    data.look = this.cleanLook(acct, data.look);
    const ok = await this.store.create({ key, name, hash: '', salt: '', data, google: claims.sub });
    if (!ok) throw new UserError('That name is taken. Pick another.');
    this.cache.set(key, acct);
    return { acct, token: await this.newSession(key, 'google') };
  }
  async linkGoogle(acct, claims) {
    if (acct.google === claims.sub) return;
    if (acct.google) throw new UserError('This account is already linked to a different Google account.');
    if (!(await this.store.setGoogle(acct.key, claims.sub))) throw new UserError('That Google account is already linked to another player.');
    acct.google = claims.sub;
  }
  logout(token) { return typeof token === 'string' ? this.store.delSession(sha(token)) : null; }

  level(acct) { return levelFor(acct.data.xp); }
  owns(acct, cat, id) { return isFree(cat, id) || (!!acct && acct.data.owned.includes(cat + ':' + id)); }
  cleanLook(acct, raw) {
    const l = {};
    for (const cat in CATALOG) { const v = raw && raw[cat]; l[cat] = item(cat, v) && this.owns(acct, cat, v) ? v : CATALOG[cat].items[0][0]; }
    return l;
  }
  profile(acct) {
    const d = acct.data, L = levelFor(d.xp);
    return { name: acct.name, coins: d.coins, xp: d.xp, level: L, levelXp: xpForLevel(L), nextXp: L < MAX_LEVEL ? xpForLevel(L + 1) : null,
      owned: d.owned, look: this.cleanLook(acct, d.look), loadout: d.loadout, rounds: d.rounds, wins: d.wins,
      google: !!acct.google, hasPassword: !!acct.hasPw, hasRecovery: !!d.recovery };
  }
  async buy(acct, cat, id) {
    const it = item(cat, id); if (!it) throw new UserError('That item doesn\'t exist.');
    if (this.owns(acct, cat, id)) return;
    const [, name, price, lvl] = it;
    if (this.level(acct) < lvl) throw new UserError(`Reach level ${lvl} to unlock ${name}.`);
    if (acct.data.coins < price) throw new UserError(`You need ${price - acct.data.coins} more coins.`);
    acct.data.coins -= price; acct.data.owned.push(cat + ':' + id);
    acct.data.look = { ...acct.data.look, [cat]: id };
    await this.save(acct);
  }
  async setLook(acct, raw) {
    // anything not owned keeps what they were already wearing
    const cur = this.cleanLook(acct, acct.data.look), next = {};
    for (const cat in CATALOG) { const v = raw && raw[cat]; next[cat] = item(cat, v) && this.owns(acct, cat, v) ? v : cur[cat]; }
    acct.data.look = next; await this.save(acct);
  }
  async setLoadout(acct, k) {
    if (k === null || k === undefined || k === '') acct.data.loadout = null;
    else if (!LOADOUT[k]) throw new UserError('Unknown powerup.');
    else if (this.level(acct) < LOADOUT[k][0]) throw new UserError(`Reach level ${LOADOUT[k][0]} to start with that.`);
    else acct.data.loadout = k;
    await this.save(acct);
  }
  // at round start: pay for the starting powerup if the player can still afford it
  async chargeLoadout(acct) {
    const k = acct.data.loadout, cfg = k && LOADOUT[k];
    if (!cfg || this.level(acct) < cfg[0] || acct.data.coins < cfg[1]) return null;
    acct.data.coins -= cfg[1];
    await this.save(acct);
    return k;
  }
  // at round end: coins and XP from what was banked and where they placed
  async reward(acct, banked, place) {
    const bonus = banked > 0 ? [25, 15, 10][place] || 0 : 0;
    const coins = Math.floor(banked / 10) + bonus;
    const xp = banked + (banked > 0 ? [100, 60, 30][place] || 0 : 0) + 25;
    const before = this.level(acct);
    acct.data.coins += coins; acct.data.xp += xp; acct.data.rounds = (acct.data.rounds || 0) + 1;
    if (place === 0 && banked > 0) acct.data.wins = (acct.data.wins || 0) + 1;
    const after = this.level(acct);
    const unlocks = [];
    if (after > before) {
      for (const cat in CATALOG) for (const [, name, , lvl] of CATALOG[cat].items) if (lvl > before && lvl <= after) unlocks.push(name);
      for (const k in LOADOUT) if (LOADOUT[k][0] > before && LOADOUT[k][0] <= after) unlocks.push('Start with: ' + k);
    }
    await this.save(acct);
    return { coins, xp, before, after, unlocks };
  }
}
class UserError extends Error {}

module.exports = { Accounts, UserError, CATALOG, LOADOUT, xpForLevel, levelFor, MAX_LEVEL, isFree };
