// Finders Keepers - online game server.
// Serves the game page and runs every match: treasure, bots, magpies, timer.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const PORT = process.env.PORT || 3000;
const INDEX_PATH = path.join(__dirname, 'index.html');

// ---------- game constants ----------
const WORLD = 1800, MUSEUM = { x: 900, y: 880, w: 220, h: 150 };
const ROUND = Number(process.env.ROUND) || 180, DUSK = 30, TICK_MS = 50;
const MIN_DIGGERS = 6, MAX_PLAYERS = 8, ITEMS = 60;
const BOT_SENSE = 260;      // how far a bot's detector reaches
const OWN_DROP_LOCK = 5;    // seconds before you can pick back up what was knocked out of your bag
const DIG_REACH = 46;       // how close you must be to a find to dig it (any direction)
const TYPES = [
  { k: 'junk',   v: 1,   taps: 2,  col: '#a7a69a', ring: '#d9d8cc', names: ['Bottle cap', 'Ring pull', 'Rusty nail'], w: 30, tone: 'square', base: 180 },
  { k: 'common', v: 10,  taps: 4,  col: '#c98a46', ring: '#e8a35a', names: ['Old penny', 'Brass button', 'Musket ball'], w: 40, tone: 'triangle', base: 520 },
  { k: 'rare',   v: 40,  taps: 7,  col: '#dfe8ef', ring: '#eef6ff', names: ['Silver brooch', 'Silver shilling', 'Sword hilt'], w: 22, tone: 'sine', base: 760 },
  { k: 'epic',   v: 150, taps: 12, col: '#f2c230', ring: '#ffd447', names: ['Gold torc', 'Saxon ring', 'Roman helmet'], w: 8, tone: 'sine', base: 980 },
  { k: 'box',    v: 0,   taps: 3,  col: '#4fc3e8', ring: '#8fe6ff', names: ['Mystery box', 'Mystery box', 'Mystery box'], w: 0, tone: 'triangle', base: 640 },
];
const BOX = 4;
// ---------- powerups ----------
const POWERS = {
  c: { name: 'Pro coil',    short: 'COIL',    dur: 20, desc: 'Detector reaches twice as far' },
  t: { name: 'Turbo spade', short: 'TURBO',   dur: 15, desc: 'Every dig counts double' },
  w: { name: 'Wellies',     short: 'WELLIES', dur: 15, desc: 'Faster, and you can walk over holes' },
  p: { name: 'Padlock',     short: 'LOCK',    dur: 0,  cost: 40, desc: 'Blocks the next bonk on you' },
  s: { name: 'Scarecrow',   short: 'SCARE',   dur: 30, cost: 60, desc: 'Magpies leave you alone' },
  d: { name: 'Decoy',       short: 'DECOY',   dur: 0,  cost: 80, desc: 'Plants a fake gold find that is really junk' },
};
const BOX_POWERS = ['c', 't', 'w'], ALL_POWERS = Object.keys(POWERS);
const BOX_CHANCE = 1 / 12, CRATE_FIRST = 20, CRATE_EVERY = 30;
const pick = a => a[Math.random() * a.length | 0];
// ---------- cosmetics (bought in each player's wardrobe; the server only checks the ids are real) ----------
const LOOK_IDS = {
  hat: ['none', 'cap', 'bucket', 'beanie', 'hard', 'pirate', 'crown'],
  jacket: ['auto', 'red', 'yellow', 'pink', 'orange', 'purple', 'sky', 'black', 'white', 'camo'],
  boots: ['green', 'yellow', 'red', 'pink', 'blue', 'gold'],
  det: ['classic', 'retro', 'neon', 'gold'],
  spade: ['old', 'steel', 'gold'],
  win: ['confetti', 'fireworks', 'coins', 'fanfare'],
};
const JACKET_HEX = { red: '#c0392b', yellow: '#e2b822', pink: '#e84393', orange: '#e67e22', purple: '#8e44ad', sky: '#3fa7d6', black: '#2b2b2b', white: '#ecebe4', camo: '#5d6b3a' };
function cleanLook(raw) {
  const l = {};
  for (const k in LOOK_IDS) { const v = raw && raw[k]; l[k] = LOOK_IDS[k].includes(v) ? v : LOOK_IDS[k][0]; }
  return l;
}
function botLook() {
  const l = {}; for (const k in LOOK_IDS) l[k] = k === 'jacket' ? 'auto' : pick(LOOK_IDS[k]); return l;
}
const lookCol = (look, base) => look.jacket !== 'auto' && JACKET_HEX[look.jacket] ? JACKET_HEX[look.jacket] : base;
const TOTALW = TYPES.reduce((a, t) => a + t.w, 0);
const BOTS = [['Keith', '#8c5a3c'], ['Sue', '#7b4fa0'], ['Dave', '#2f8a7a'], ['Barb', '#c27a1d'], ['Nigel', '#55606b'], ['Pam', '#6d8b1f']];
const HUMAN_COLS = ['#2d5f9e', '#d0473a', '#9b59b6', '#17a589', '#e67e22', '#34495e', '#e84393', '#b8860b'];

const pickTypeIdx = () => { let r = Math.random() * TOTALW; for (let i = 0; i < TYPES.length; i++) { if ((r -= TYPES[i].w) < 0) return i; } return 0; };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const holeR = ti => 9 + TYPES[ti].taps * 0.9;
const clampW = v => Math.max(50, Math.min(WORLD - 50, v));
const bagValue = d => d.bag.reduce((a, b) => a + TYPES[b.ti].v, 0);
const shiny = d => d.bag.some(b => TYPES[b.ti].v >= 40);
function inMuseumZone(x, y, pad = 0) {
  return x > MUSEUM.x - MUSEUM.w / 2 - pad && x < MUSEUM.x + MUSEUM.w / 2 + pad && y > MUSEUM.y - MUSEUM.h / 2 - pad && y < MUSEUM.y + MUSEUM.h / 2 + pad;
}
function pushOut(d, x, y, min) {
  let dx = d.x - x, dy = d.y - y, dd = Math.hypot(dx, dy);
  if (dd < min) { if (dd < 0.01) { dx = 1; dy = 0; dd = 1; } d.x = x + dx / dd * min; d.y = y + dy / dd * min; return true; }
  return false;
}
function turnTo(d, want, dt) { let a = want - d.dir; a = Math.atan2(Math.sin(a), Math.cos(a)); d.dir += a * Math.min(1, dt * 12); }

// ---------- a match ----------
class Room {
  constructor(code) {
    this.code = code;
    this.clients = new Map(); // ws -> {id, name, col}
    this.state = 'lobby';
    this.host = null;
    this.nextId = 1;
    this.resetWorld();
  }
  resetWorld() {
    this.diggers = []; this.buried = []; this.holes = []; this.loose = []; this.magpies = [];
    this.ev = []; this.timeLeft = ROUND; this.magpieT = 10; this.uid = 1; this.t = 0;
    this.crates = []; this.crateT = CRATE_FIRST;
  }
  send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  broadcast(obj) { const s = JSON.stringify(obj); for (const ws of this.clients.keys()) if (ws.readyState === 1) ws.send(s); }
  lobbyMsg() {
    this.broadcast({ t: 'lobby', code: this.code, host: this.host, state: this.state,
      players: [...this.clients.values()].map(c => ({ id: c.id, name: c.name, col: c.col })) });
  }
  addClient(ws, name, rawLook) {
    const used = new Set([...this.clients.values()].map(c => c.base));
    const base = HUMAN_COLS.find(x => !used.has(x)) || HUMAN_COLS[0], look = cleanLook(rawLook);
    const c = { id: this.nextId++, name, base, look, col: lookCol(look, base) };
    this.clients.set(ws, c);
    if (this.host === null) this.host = c.id;
    this.send(ws, { t: 'hello', you: c.id });
    if (this.state === 'play') {
      const d = this.makeDigger(c.id, c.name, c.col, false, Math.random() * 6, c.look);
      this.diggers.push(d);
      this.ev.push(['join', { id: d.id, name: d.name, col: d.col, bot: 0, look: d.look }]);
      this.send(ws, this.initMsg(c.id));
    }
    this.lobbyMsg();
  }
  removeClient(ws) {
    const c = this.clients.get(ws); if (!c) return;
    this.clients.delete(ws);
    const i = this.diggers.findIndex(d => d.id === c.id);
    if (i >= 0) { this.diggers.splice(i, 1); this.ev.push(['leave', c.id]); }
    for (const m of this.magpies) if (m.target && m.target.id === c.id) { m.state = 'leave'; m.fleeA = Math.random() * 7; }
    if (this.host === c.id) this.host = this.clients.size ? [...this.clients.values()][0].id : null;
    this.lobbyMsg();
  }
  setLook(id, raw) {
    const c = [...this.clients.values()].find(x => x.id === id); if (!c) return;
    c.look = cleanLook(raw); c.col = lookCol(c.look, c.base);
    const d = this.diggers.find(x => x.id === id);
    if (d) { d.look = c.look; d.col = c.col; this.ev.push(['look', id, c.look, c.col]); }
    this.lobbyMsg();
  }
  makeDigger(id, name, col, isBot, slot, look) {
    const a = slot / 6 * Math.PI * 2 + 0.4;
    return { id, name, col, isBot, look: look || botLook(), x: MUSEUM.x + Math.cos(a) * 170, y: MUSEUM.y + 10 + Math.sin(a) * 140, dir: a,
      bag: [], banked: 0, stun: 0, immune: 0, bonkCd: 0, swing: 0, moving: false, lastDig: 0, power: null, fx: {}, padlock: false,
      ai: isBot ? { mode: 'hunt', item: null, think: 0, digT: 0, digRate: 2 + Math.random() * 1, bankAt: 40 + Math.random() * 110,
        aggro: 0.3 + Math.random() * 0.6, robCd: 4 + Math.random() * 6, chase: 0, victim: null, loot: null,
        lx: 0, ly: 0, stuckT: 0, detour: 0, detourA: 0, wander: null } : null };
  }
  start() {
    this.resetWorld();
    const humans = [...this.clients.values()];
    humans.forEach((c, i) => this.diggers.push(this.makeDigger(c.id, c.name, c.col, false, i, c.look)));
    const bots = Math.max(0, MIN_DIGGERS - humans.length);
    for (let i = 0; i < bots; i++) { const [n, col] = BOTS[i]; this.diggers.push(this.makeDigger(1000 + i, n, col, true, humans.length + i)); }
    for (let i = 0; i < ITEMS; i++) this.spawnItem(false);
    this.ev = [];
    this.state = 'play';
    for (const [ws, c] of this.clients) this.send(ws, this.initMsg(c.id));
    this.lobbyMsg();
  }
  initMsg(you) {
    return { t: 'init', you, types: TYPES, powers: POWERS, world: WORLD, museum: MUSEUM, round: ROUND, dusk: DUSK, tl: this.timeLeft,
      diggers: this.diggers.map(d => ({ id: d.id, name: d.name, col: d.col, bot: d.isBot ? 1 : 0, look: d.look })),
      buried: this.buried.map(b => [b.id, Math.round(b.x), Math.round(b.y), b.ti, b.prog, b.name, b.owner || 0]),
      holes: this.holes.map(h => [Math.round(h.x), Math.round(h.y), h.r]),
      loose: this.loose.map(l => [l.id, Math.round(l.x), Math.round(l.y), l.item.ti, l.item.name]) };
  }
  end() {
    this.state = 'end';
    this.broadcast({ t: 'end', rank: [...this.diggers].sort((a, b) => b.banked - a.banked).map(d => [d.id, d.name, d.col, d.banked, d.isBot ? 1 : 0]) });
    this.lobbyMsg();
  }

  // ----- world -----
  humanNear(x, y, r) { return this.diggers.some(d => !d.isBot && Math.hypot(d.x - x, d.y - y) < r); }
  inHole(x, y, pad) { return this.holes.some(h => Math.hypot(h.x - x, h.y - y) < h.r + pad); }
  spawnItem(awayFromPlayers) {
    for (let tries = 0; tries < 60; tries++) {
      const x = 70 + Math.random() * (WORLD - 140), y = 70 + Math.random() * (WORLD - 140);
      if (inMuseumZone(x, y, 90)) continue;
      if (awayFromPlayers && this.humanNear(x, y, 400)) continue;
      if (this.buried.some(b => Math.hypot(b.x - x, b.y - y) < 60)) continue;
      if (this.inHole(x, y, 40)) continue;
      const ti = Math.random() < BOX_CHANCE ? BOX : pickTypeIdx();
      const b = { id: this.uid++, x, y, ti, name: TYPES[ti].names[Math.random() * 3 | 0], prog: 0 };
      this.buried.push(b);
      if (awayFromPlayers) this.ev.push(['spawn', b.id, Math.round(x), Math.round(y), ti, b.name, 0]);
      return;
    }
  }
  findTarget(d, id) {
    if (id != null) { const b = this.buried.find(x => x.id === id); if (b && b.owner !== d.id && dist(b, d) < DIG_REACH + 10) return b; }
    let best = null, bd = DIG_REACH;
    for (const b of this.buried) { if (b.owner === d.id) continue; const dd = dist(b, d); if (dd < bd) { bd = dd; best = b; } }
    return best;
  }
  digAt(d, item) {
    if (d.stun > 0 || !this.buried.includes(item)) return;
    item.prog = Math.min(TYPES[item.ti].taps, item.prog + (d.fx.t > 0 ? 2 : 1));
    this.ev.push(['prog', item.id, item.prog, d.id]);
    if (item.prog < TYPES[item.ti].taps) return;
    this.buried.splice(this.buried.indexOf(item), 1);
    const r = holeR(item.ti);
    this.holes.push({ x: item.x, y: item.y, r });
    this.ev.push(['dug', item.id, d.id, item.decoy ? 1 : 0]);
    if (this.holes.length > 150) { this.holes.shift(); this.ev.push(['hshift']); }
    if (d.isBot) pushOut(d, item.x, item.y, r + 11);
    if (item.decoy) {
      d.bag.push({ ti: 0, name: 'Fake gold' });
      this.ev.push(['decoyed', d.id, item.owner]);
      return; // decoys aren't replaced
    }
    if (item.ti === BOX) this.givePower(d, pick(BOX_POWERS), 'box');
    else d.bag.push({ ti: item.ti, name: item.name });
    this.spawnItem(true);
  }

  // ----- powerups -----
  givePower(d, k, src) {
    if (k === 'p') d.padlock = true; else d.power = k;
    this.ev.push(['power', d.id, k, src]);
    if (d.isBot && k !== 'p') this.usePower(d);
  }
  usePower(d) {
    const k = d.power; if (!k || d.stun > 0) return;
    d.power = null;
    if (k === 'd') this.plantDecoy(d);
    else d.fx[k] = POWERS[k].dur;
    if (k === 's') for (const m of this.magpies) if (m.target === d && m.state === 'hunt') { m.state = 'leave'; m.fleeA = Math.atan2(m.y - d.y, m.x - d.x); }
    this.ev.push(['use', d.id, k]);
  }
  plantDecoy(d) {
    let x = d.x, y = d.y;
    for (let k = 0; k < 10; k++) {
      const a = d.dir + Math.PI + (k % 2 ? 1 : -1) * k * 0.5, r = 34 + k * 4;
      const tx = clampW(d.x + Math.cos(a) * r), ty = clampW(d.y + Math.sin(a) * r);
      if (!this.inHole(tx, ty, 16) && !inMuseumZone(tx, ty, 30) && !this.buried.some(b => Math.hypot(b.x - tx, b.y - ty) < 30)) { x = tx; y = ty; break; }
    }
    const b = { id: this.uid++, x, y, ti: 3, name: pick(TYPES[3].names), prog: 0, decoy: true, owner: d.id };
    this.buried.push(b);
    this.ev.push(['spawn', b.id, Math.round(x), Math.round(y), 3, b.name, d.id]);
  }
  buy(d, k) {
    const P = POWERS[k]; if (!P || !P.cost) return;
    if (!inMuseumZone(d.x, d.y, 24) || d.banked < P.cost || (k === 'p' && d.padlock)) return;
    d.banked -= P.cost;
    this.ev.push(['buy', d.id, k, P.cost]);
    this.givePower(d, k, 'shop');
  }
  spawnCrate() {
    for (let tries = 0; tries < 40; tries++) {
      const x = 140 + Math.random() * (WORLD - 280), y = 140 + Math.random() * (WORLD - 280);
      if (inMuseumZone(x, y, 140) || this.inHole(x, y, 30)) continue;
      const c = { id: this.uid++, x, y };
      this.crates.push(c);
      this.ev.push(['crate', c.id, Math.round(x), Math.round(y)]);
      return;
    }
  }
  dropLoose(item, x, y, ang, fromId) {
    let lx = x, ly = y;
    for (let k = 0; k < 12; k++) {
      const aa = ang + (k % 2 ? 1 : -1) * k * 0.4, r = 34 + k * 3;
      lx = x + Math.cos(aa) * r; ly = y + Math.sin(aa) * r;
      if (!this.inHole(lx, ly, 14) && !inMuseumZone(lx, ly, 10)) break;
    }
    lx = clampW(lx); ly = clampW(ly);
    const l = { id: this.uid++, x: lx, y: ly, item, from: fromId, age: 0 };
    this.loose.push(l);
    this.ev.push(['loose', l.id, Math.round(lx), Math.round(ly), Math.round(x), Math.round(y), item.ti, item.name]);
  }
  bonkVictim(a) {
    if (inMuseumZone(a.x, a.y, 10)) return null;
    let best = null, bd = 48;
    for (const o of this.diggers) {
      if (o === a || inMuseumZone(o.x, o.y, 10)) continue;
      const dd = dist(a, o); if (dd > bd) continue;
      let da = Math.atan2(o.y - a.y, o.x - a.x) - a.dir; da = Math.atan2(Math.sin(da), Math.cos(da));
      if (Math.abs(da) < 1.3 || dd < 24) { bd = dd; best = o; }
    }
    return best;
  }
  magpieInReach(a) {
    for (const m of this.magpies) if (m.stun <= 0 && m.alt < 30 && Math.hypot(m.x - a.x, m.y - a.y) < 48) return m;
    return null;
  }
  bonk(a) {
    if (a.bonkCd > 0 || a.stun > 0) return false;
    a.bonkCd = 0.6; a.swing = 0.25;
    const mg = this.magpieInReach(a);
    if (mg) { this.hitMagpie(mg, a); return true; }
    const v = this.bonkVictim(a);
    if (!v) { this.ev.push(['whiff', a.id]); return false; }
    if (v.immune > 0) { this.ev.push(['blocked', a.id, v.id]); return true; }
    if (v.padlock) { v.padlock = false; v.immune = 1.5; this.ev.push(['padlock', a.id, v.id]); return true; }
    v.stun = 1; v.immune = 3;
    const ang = Math.atan2(v.y - a.y, v.x - a.x);
    v.x = clampW(v.x + Math.cos(ang) * 14); v.y = clampW(v.y + Math.sin(ang) * 14);
    if (!v.isBot) this.ev.push(['pos', v.id, Math.round(v.x), Math.round(v.y)]);
    let dropped = null;
    if (v.bag.length) {
      let bi = 0; v.bag.forEach((b, i) => { if (TYPES[b.ti].v > TYPES[v.bag[bi].ti].v) bi = i; });
      dropped = v.bag.splice(bi, 1)[0];
    }
    this.ev.push(['bonk', a.id, v.id, dropped ? dropped.ti : -1, dropped ? dropped.name : '']);
    if (dropped) this.dropLoose(dropped, v.x, v.y, ang, v.id);
    return true;
  }

  // ----- magpies -----
  hitMagpie(m, a) {
    m.stun = 0.6;
    const item = m.item; m.item = null;
    this.ev.push(['mhit', m.id, a.id, item ? item.ti : -1, item ? item.name : '']);
    if (item) this.dropLoose(item, m.x, m.y, Math.random() * 7, null);
    m.state = 'leave'; m.fleeA = Math.random() * Math.PI * 2;
  }
  spawnMagpie() {
    const carriers = this.diggers.filter(d => shiny(d) && !(d.fx.s > 0) && !inMuseumZone(d.x, d.y, 30) && !this.magpies.some(m => m.target === d));
    if (!carriers.length) return false;
    let r = Math.random() * carriers.reduce((s, d) => s + bagValue(d), 0), tg = carriers[0];
    for (const d of carriers) { if ((r -= bagValue(d)) < 0) { tg = d; break; } }
    const a = Math.random() * Math.PI * 2;
    const m = { id: this.uid++, x: tg.x + Math.cos(a) * 520, y: tg.y + Math.sin(a) * 520, alt: 60, target: tg, item: null,
      state: 'hunt', t: 0, ts: 0, dir: a + Math.PI, stun: 0, fleeA: 0, rolled: new Set() };
    this.magpies.push(m);
    this.ev.push(['mspawn', m.id, tg.id]);
    return true;
  }
  updateMagpies(dt) {
    if ((this.magpieT -= dt) <= 0) this.magpieT = this.magpies.length < 2 && this.spawnMagpie() ? 9 + Math.random() * 8 : 3;
    for (const m of this.magpies) {
      m.t += dt;
      if (m.stun > 0) { m.stun -= dt; m.alt = Math.max(0, m.alt - dt * 80); continue; }
      let gx = m.x, gy = m.y, sp = 0;
      if (m.state === 'hunt') {
        const tg = m.target;
        if (!this.diggers.includes(tg) || !shiny(tg) || tg.fx.s > 0 || inMuseumZone(tg.x, tg.y, 20) || m.t > 14) { m.state = 'leave'; m.fleeA = Math.atan2(m.y - tg.y, m.x - tg.x); }
        else {
          gx = tg.x; gy = tg.y; sp = 240;
          const dd = Math.hypot(gx - m.x, gy - m.y); m.alt = Math.min(60, dd * 0.3);
          if (dd < 16) {
            let bi = -1; tg.bag.forEach((b, i) => { if (TYPES[b.ti].v >= 40 && (bi < 0 || TYPES[b.ti].v > TYPES[tg.bag[bi].ti].v)) bi = i; });
            m.item = tg.bag.splice(bi, 1)[0]; m.state = 'flee'; m.ts = 0;
            m.fleeA = Math.atan2(m.y - tg.y, m.x - tg.x) + (Math.random() - 0.5);
            this.ev.push(['steal', m.id, tg.id, m.item.ti, m.item.name]);
          }
        }
      }
      if (m.state === 'flee' || m.state === 'leave') {
        m.ts += dt;
        gx = m.x + Math.cos(m.fleeA) * 100; gy = m.y + Math.sin(m.fleeA) * 100;
        sp = m.state === 'flee' ? (m.ts < 1.3 ? 115 : 220) : 240;
        m.alt = Math.min(60, m.alt + dt * (m.state === 'flee' ? 22 : 60));
      }
      const dd = Math.hypot(gx - m.x, gy - m.y) || 1;
      m.x += (gx - m.x) / dd * sp * dt; m.y += (gy - m.y) / dd * sp * dt;
      if (sp) m.dir = Math.atan2(gy - m.y, gx - m.x);
      if (m.state !== 'hunt' && (m.x < -120 || m.y < -120 || m.x > WORLD + 120 || m.y > WORLD + 120)) m.gone = true;
    }
    this.magpies = this.magpies.filter(m => !m.gone);
  }

  // ----- bots -----
  moveDigger(d, mx, my, dt, base) {
    const mag = Math.hypot(mx, my);
    d.moving = mag > 0.05 && d.stun <= 0;
    if (!d.moving) return;
    if (mag > 1) { mx /= mag; my /= mag; }
    const speed = base * (1 - Math.min(0.45, d.bag.length * 0.05)) * (d.fx.w > 0 ? 1.3 : 1);
    d.x += mx * speed * dt; d.y += my * speed * dt;
    if (!(d.fx.w > 0)) for (let pass = 0; pass < 2; pass++) for (const h of this.holes) pushOut(d, h.x, h.y, h.r + 11);
    d.x = clampW(d.x); d.y = clampW(d.y);
    turnTo(d, Math.atan2(my, mx), dt);
  }
  botThink(b, dt) {
    const ai = b.ai;
    ai.robCd -= dt; ai.think -= dt;
    if (b.stun > 0) { if (ai.mode === 'dig') ai.mode = 'hunt'; b.moving = false; return; }
    const mg = this.magpieInReach(b);
    if (mg && b.bonkCd <= 0 && !mg.rolled.has(b)) { mg.rolled.add(b); if (Math.random() < 0.3 + ai.aggro * 0.3) { b.dir = Math.atan2(mg.y - b.y, mg.x - b.x); this.bonk(b); } }
    const bv = bagValue(b);
    if (ai.mode !== 'rob' && ai.mode !== 'bank' && (bv >= ai.bankAt || b.bag.length >= 5)) ai.mode = 'bank';
    if (ai.think <= 0) {
      ai.think = 0.35 + Math.random() * 0.4;
      if (ai.mode !== 'rob' && ai.mode !== 'bank' && ai.robCd <= 0 && bv < 60) {
        let best = null, bd = 220;
        for (const o of this.diggers) { if (o === b || o.immune > 0 || bagValue(o) < 20 || inMuseumZone(o.x, o.y, 20)) continue; const dd = dist(o, b); if (dd < bd) { bd = dd; best = o; } }
        if (best && Math.random() < ai.aggro) { ai.mode = 'rob'; ai.victim = best; ai.chase = 3 + Math.random() * 2; }
        else ai.robCd = 1.5;
      }
      if (ai.mode === 'hunt' || ai.mode === 'dig' || ai.mode === 'bank') {
        let best = null, bd = ai.mode === 'bank' ? 80 : 160;
        for (const l of this.loose) { if (l.from === b.id && l.age < OWN_DROP_LOCK) continue; const dd = dist(l, b); if (dd < bd) { bd = dd; best = l; } }
        if (best && (ai.mode !== 'dig' || TYPES[best.item.ti].v > 10)) { ai.mode = 'grab'; ai.loot = best; }
      }
      if (ai.mode === 'hunt' && this.crates.length && dist(this.crates[0], b) < 500) { ai.mode = 'crate'; ai.crate = this.crates[0]; }
    }
    let gx = null, gy = null;
    if (ai.mode === 'bank') {
      if (!b.bag.length) { ai.mode = 'hunt'; ai.bankAt = 40 + Math.random() * 110; }
      else { gx = MUSEUM.x; gy = MUSEUM.y; }
    }
    if (ai.mode === 'rob') {
      const v = ai.victim; ai.chase -= dt;
      if (ai.chase <= 0 || !v || !this.diggers.includes(v) || v.immune > 0 || !v.bag.length || inMuseumZone(v.x, v.y, 10)) { ai.mode = 'hunt'; ai.robCd = 5 + Math.random() * 5; }
      else {
        gx = v.x; gy = v.y;
        if (dist(b, v) < 36) { b.dir = Math.atan2(v.y - b.y, v.x - b.x); if (this.bonk(b)) { ai.mode = 'hunt'; ai.robCd = 6 + Math.random() * 5; } }
      }
    }
    if (ai.mode === 'crate') {
      if (!this.crates.includes(ai.crate)) ai.mode = 'hunt';
      else { gx = ai.crate.x; gy = ai.crate.y; }
    }
    if (ai.mode === 'grab') {
      if (!this.loose.includes(ai.loot)) ai.mode = b.bag.length && bagValue(b) >= ai.bankAt ? 'bank' : 'hunt';
      else { gx = ai.loot.x; gy = ai.loot.y; }
    }
    if (ai.mode === 'hunt') {
      if (!ai.item || !this.buried.includes(ai.item)) {
        // bots only "hear" treasure within their detector range, like players
        const sense = BOT_SENSE * (b.fx.c > 0 ? 2 : 1);
        ai.item = null; let bd = sense;
        for (const it of this.buried) {
          if (it.owner === b.id) continue;
          const d0 = dist(it, b); if (d0 > sense) continue;
          if (this.diggers.some(o => o !== b && o.ai && o.ai.item === it)) continue;
          const dd = d0 + Math.random() * 80;
          if (dd < bd) { bd = dd; ai.item = it; }
        }
      }
      if (ai.item) { ai.wander = null; gx = ai.item.x; gy = ai.item.y; if (dist(b, ai.item) < 30) { ai.mode = 'dig'; ai.digT = 0.5; } }
      else {
        // nothing in range: wander the field until something beeps
        if (!ai.wander || Math.hypot(ai.wander.x - b.x, ai.wander.y - b.y) < 40) {
          let wx, wy, n = 0;
          do { wx = 120 + Math.random() * (WORLD - 240); wy = 120 + Math.random() * (WORLD - 240); } while (inMuseumZone(wx, wy, 120) && ++n < 20);
          ai.wander = { x: wx, y: wy };
        }
        gx = ai.wander.x; gy = ai.wander.y;
      }
    }
    if (ai.mode === 'dig') {
      if (!ai.item || !this.buried.includes(ai.item)) ai.mode = 'hunt';
      else {
        turnTo(b, Math.atan2(ai.item.y - b.y, ai.item.x - b.x), dt);
        if (dist(b, ai.item) > 40) ai.mode = 'hunt';
        else if ((ai.digT -= dt) <= 0) { ai.digT = 1 / ai.digRate; this.digAt(b, ai.item); }
        b.moving = false; return;
      }
    }
    if (gx === null) { b.moving = false; return; }
    let ang = Math.atan2(gy - b.y, gx - b.x);
    if (ai.detour > 0) { ai.detour -= dt; ang += ai.detourA; }
    ai.stuckT += dt;
    if (ai.stuckT > 0.7) {
      if (Math.hypot(b.x - ai.lx, b.y - ai.ly) < 10 && Math.hypot(gx - b.x, gy - b.y) > 30) { ai.detour = 0.6 + Math.random() * 0.5; ai.detourA = (Math.random() < 0.5 ? -1 : 1) * (1 + Math.random() * 0.6); }
      ai.stuckT = 0; ai.lx = b.x; ai.ly = b.y;
    }
    const k = ai.mode === 'hunt' && ai.item ? Math.min(1, Math.hypot(gx - b.x, gy - b.y) / 40) : 1;
    this.moveDigger(b, Math.cos(ang) * k, Math.sin(ang) * k, dt, ai.mode === 'rob' ? 170 : 150);
  }

  // ----- player messages -----
  onInput(id, msg) {
    const d = this.diggers.find(x => x.id === id); if (!d || this.state !== 'play') return;
    if (msg.t === 'in') {
      if (typeof msg.dir === 'number' && isFinite(msg.dir)) d.dir = msg.dir;
      if (d.stun > 0 || typeof msg.x !== 'number' || typeof msg.y !== 'number' || !isFinite(msg.x) || !isFinite(msg.y)) return;
      const nx = clampW(msg.x), ny = clampW(msg.y);
      const jump = Math.hypot(nx - d.x, ny - d.y);
      if (jump > 160) { this.ev.push(['pos', d.id, Math.round(d.x), Math.round(d.y)]); return; } // ignore teleports
      d.moving = jump > 0.5; d.x = nx; d.y = ny;
      if (!(d.fx.w > 0)) for (const h of this.holes) pushOut(d, h.x, h.y, h.r + 9);
    } else if (msg.t === 'dig') {
      const now = Date.now(); if (now - d.lastDig < 70) return; d.lastDig = now;
      const tg = this.findTarget(d, typeof msg.id === 'number' ? msg.id : null); if (tg) { d.dir = Math.atan2(tg.y - d.y, tg.x - d.x); this.digAt(d, tg); }
    } else if (msg.t === 'bonk') {
      this.bonk(d);
    } else if (msg.t === 'use') {
      this.usePower(d);
    } else if (msg.t === 'buy') {
      if (typeof msg.k === 'string') this.buy(d, msg.k);
    }
  }

  // ----- tick -----
  tick(dt) {
    if (this.state !== 'play') return;
    this.t += dt; this.timeLeft -= dt;
    if (this.timeLeft <= 0) { this.timeLeft = 0; this.flush(); this.end(); return; }
    this.updateMagpies(dt);
    if ((this.crateT -= dt) <= 0) { this.crateT = CRATE_EVERY; if (!this.crates.length) this.spawnCrate(); }
    for (const d of this.diggers) {
      for (const k in d.fx) if ((d.fx[k] -= dt) <= 0) delete d.fx[k];
      d.stun = Math.max(0, d.stun - dt); d.immune = Math.max(0, d.immune - dt);
      d.bonkCd = Math.max(0, d.bonkCd - dt); d.swing = Math.max(0, d.swing - dt);
      if (d.isBot) this.botThink(d, dt);
      if (d.bag.length && inMuseumZone(d.x, d.y)) {
        const v = bagValue(d); d.banked += v; d.bag = [];
        this.ev.push(['bank', d.id, v]);
        if (d.isBot && !d.padlock && d.banked >= 200 && Math.random() < 0.3) this.buy(d, 'p');
      }
      if (d.stun <= 0) for (let i = this.crates.length - 1; i >= 0; i--) {
        const c = this.crates[i];
        if (Math.hypot(c.x - d.x, c.y - d.y) < 28) { this.crates.splice(i, 1); this.ev.push(['crategot', c.id, d.id]); this.givePower(d, pick(ALL_POWERS), 'crate'); }
      }
      if (d.stun <= 0) for (let i = this.loose.length - 1; i >= 0; i--) {
        const l = this.loose[i];
        if (l.age < 0.35 || (l.from === d.id && l.age < OWN_DROP_LOCK)) continue;
        if (Math.hypot(l.x - d.x, l.y - d.y) < 24) { this.loose.splice(i, 1); d.bag.push(l.item); this.ev.push(['pick', l.id, d.id]); }
      }
    }
    for (const l of this.loose) l.age += dt;
    this.flush();
  }
  flush() {
    const s = {
      t: 's', tl: Math.round(this.timeLeft * 10) / 10,
      d: this.diggers.map(d => [d.id, Math.round(d.x), Math.round(d.y), Math.round(d.dir * 100) / 100, d.stun > 0 ? 1 : 0, d.immune > 0 ? 1 : 0,
        d.bag.map(b => b.ti).join(''), d.banked, d.moving ? 1 : 0, d.power || '',
        Object.keys(d.fx).map(k => k + Math.ceil(d.fx[k])).join('') + (d.padlock ? 'p' : '')]),
      c: this.crates.map(c => [c.id, Math.round(c.x), Math.round(c.y)]),
      m: this.magpies.map(m => [m.id, Math.round(m.x), Math.round(m.y), Math.round(m.alt), Math.round(m.dir * 100) / 100, m.item ? m.item.ti : -1, m.stun > 0 ? 1 : 0]),
      e: this.ev,
    };
    this.ev = [];
    this.broadcast(s);
  }
}

// ---------- rooms ----------
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function newCode() {
  for (;;) { let c = ''; for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.random() * CODE_CHARS.length | 0]; if (!rooms.has(c)) return c; }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  fs.readFile(INDEX_PATH, (err, buf) => {
    if (err) { res.writeHead(500); res.end('Missing page'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

// ---------- tiny WebSocket layer (no packages needed) ----------
class Conn extends EventEmitter {
  constructor(socket) {
    super();
    this.s = socket; this.buf = Buffer.alloc(0); this.frag = []; this.readyState = 1; this.isAlive = true;
    socket.on('data', d => this.onData(d));
    socket.on('close', () => this.closed());
    socket.on('end', () => this.closed());
    socket.on('error', () => this.closed());
  }
  onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1], fin = b0 & 0x80, op = b0 & 0x0f;
      let len = b1 & 0x7f, off = 2;
      if (!(b1 & 0x80)) return this.terminate(); // browsers always mask
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; if (this.buf.readUInt32BE(2)) return this.terminate(); len = this.buf.readUInt32BE(6); off = 10; }
      if (len > 16384) return this.terminate();
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4), payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { this.frame(0xA, payload); continue; }
      if (op === 0xA) { this.isAlive = true; continue; }
      if (op === 0x1 || op === 0x0) {
        this.frag.push(payload);
        if (fin) { const msg = Buffer.concat(this.frag).toString('utf8'); this.frag = []; if (msg.length <= 4096) this.emit('message', msg); }
      }
    }
  }
  frame(op, payload) {
    if (this.readyState !== 1) return;
    if (op === 0x1 && this.s.writableLength > 262144) return; // phone can't keep up: skip a frame
    const len = payload.length; let h;
    if (len < 126) h = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(len, 6); }
    try { this.s.write(Buffer.concat([h, payload])); } catch { /* socket gone */ }
  }
  send(str) { this.frame(0x1, Buffer.from(str, 'utf8')); }
  ping() { this.frame(0x9, Buffer.alloc(0)); }
  close() { if (this.readyState !== 1) return; this.frame(0x8, Buffer.alloc(0)); this.readyState = 2; this.s.end(); this.closed(); }
  terminate() { this.s.destroy(); this.closed(); }
  closed() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
}
const conns = new Set();
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const ws = new Conn(socket);
  conns.add(ws);
  ws.on('close', () => conns.delete(ws));
  onConnection(ws);
});

function onConnection(ws) {
  let room = null, me = null;
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    if (msg.t === 'join') {
      if (room) return;
      const name = String(msg.name || 'Digger').replace(/[^\p{L}\p{N} _'-]/gu, '').trim().slice(0, 12) || 'Digger';
      let code = String(msg.room || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
      if (code) {
        room = rooms.get(code);
        if (!room) { ws.send(JSON.stringify({ t: 'error', msg: `No game with code ${code}. Check the code or create a new game.` })); return; }
        if (room.clients.size >= MAX_PLAYERS) { room = null; ws.send(JSON.stringify({ t: 'error', msg: 'That game is full (8 players).' })); return; }
      } else {
        code = newCode(); room = new Room(code); rooms.set(code, room);
      }
      room.addClient(ws, name, msg.look);
      me = room.clients.get(ws).id;
      return;
    }
    if (!room) return;
    if (msg.t === 'start') { if (me === room.host && room.state !== 'play') room.start(); return; }
    if (msg.t === 'look') { room.setLook(me, msg.look); return; }
    room.onInput(me, msg);
  });
  ws.on('close', () => {
    if (!room) return;
    room.removeClient(ws);
    if (!room.clients.size) rooms.delete(room.code);
  });
}

// heartbeat drops dead phone connections
setInterval(() => {
  for (const ws of conns) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
}, 15000);

let last = Date.now();
setInterval(() => {
  const now = Date.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
  for (const r of rooms.values()) r.tick(dt);
}, TICK_MS);

server.listen(PORT, () => console.log(`Finders Keepers running on port ${PORT}`));
