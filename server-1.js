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
const TYPES = [
  { k: 'junk',   v: 1,   taps: 2,  col: '#a7a69a', ring: '#d9d8cc', names: ['Bottle cap', 'Ring pull', 'Rusty nail'], w: 30, tone: 'square', base: 180 },
  { k: 'common', v: 10,  taps: 4,  col: '#c98a46', ring: '#e8a35a', names: ['Old penny', 'Brass button', 'Musket ball'], w: 40, tone: 'triangle', base: 520 },
  { k: 'rare',   v: 40,  taps: 7,  col: '#dfe8ef', ring: '#eef6ff', names: ['Silver brooch', 'Silver shilling', 'Sword hilt'], w: 22, tone: 'sine', base: 760 },
  { k: 'epic',   v: 150, taps: 12, col: '#f2c230', ring: '#ffd447', names: ['Gold torc', 'Saxon ring', 'Roman helmet'], w: 8, tone: 'sine', base: 980 },
];
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
  }
  send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  broadcast(obj) { const s = JSON.stringify(obj); for (const ws of this.clients.keys()) if (ws.readyState === 1) ws.send(s); }
  lobbyMsg() {
    this.broadcast({ t: 'lobby', code: this.code, host: this.host, state: this.state,
      players: [...this.clients.values()].map(c => ({ id: c.id, name: c.name, col: c.col })) });
  }
  addClient(ws, name) {
    const used = new Set([...this.clients.values()].map(c => c.col));
    const c = { id: this.nextId++, name, col: HUMAN_COLS.find(x => !used.has(x)) || HUMAN_COLS[0] };
    this.clients.set(ws, c);
    if (this.host === null) this.host = c.id;
    this.send(ws, { t: 'hello', you: c.id });
    if (this.state === 'play') {
      const d = this.makeDigger(c.id, c.name, c.col, false, Math.random() * 6);
      this.diggers.push(d);
      this.ev.push(['join', { id: d.id, name: d.name, col: d.col, bot: 0 }]);
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
  makeDigger(id, name, col, isBot, slot) {
    const a = slot / 6 * Math.PI * 2 + 0.4;
    return { id, name, col, isBot, x: MUSEUM.x + Math.cos(a) * 170, y: MUSEUM.y + 10 + Math.sin(a) * 140, dir: a,
      bag: [], banked: 0, stun: 0, immune: 0, bonkCd: 0, swing: 0, moving: false, lastDig: 0,
      ai: isBot ? { mode: 'hunt', item: null, think: 0, digT: 0, digRate: 3 + Math.random() * 1.5, bankAt: 40 + Math.random() * 110,
        aggro: 0.3 + Math.random() * 0.6, robCd: 4 + Math.random() * 6, chase: 0, victim: null, loot: null,
        lx: 0, ly: 0, stuckT: 0, detour: 0, detourA: 0 } : null };
  }
  start() {
    this.resetWorld();
    const humans = [...this.clients.values()];
    humans.forEach((c, i) => this.diggers.push(this.makeDigger(c.id, c.name, c.col, false, i)));
    const bots = Math.max(0, MIN_DIGGERS - humans.length);
    for (let i = 0; i < bots; i++) { const [n, col] = BOTS[i]; this.diggers.push(this.makeDigger(1000 + i, n, col, true, humans.length + i)); }
    for (let i = 0; i < ITEMS; i++) this.spawnItem(false);
    this.ev = [];
    this.state = 'play';
    for (const [ws, c] of this.clients) this.send(ws, this.initMsg(c.id));
    this.lobbyMsg();
  }
  initMsg(you) {
    return { t: 'init', you, types: TYPES, world: WORLD, museum: MUSEUM, round: ROUND, dusk: DUSK, tl: this.timeLeft,
      diggers: this.diggers.map(d => ({ id: d.id, name: d.name, col: d.col, bot: d.isBot ? 1 : 0 })),
      buried: this.buried.map(b => [b.id, Math.round(b.x), Math.round(b.y), b.ti, b.prog, b.name]),
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
      const ti = pickTypeIdx();
      const b = { id: this.uid++, x, y, ti, name: TYPES[ti].names[Math.random() * 3 | 0], prog: 0 };
      this.buried.push(b);
      if (awayFromPlayers) this.ev.push(['spawn', b.id, Math.round(x), Math.round(y), ti, b.name]);
      return;
    }
  }
  findTarget(d) {
    const px = d.x + Math.cos(d.dir) * 26, py = d.y + Math.sin(d.dir) * 26;
    let best = null, bd = 34; // a little more forgiving than the client highlight, to absorb lag
    for (const b of this.buried) { const dd = Math.hypot(b.x - px, b.y - py); if (dd < bd) { bd = dd; best = b; } }
    return best;
  }
  digAt(d, item) {
    if (d.stun > 0 || !this.buried.includes(item)) return;
    item.prog++;
    this.ev.push(['prog', item.id, item.prog, d.id]);
    if (item.prog < TYPES[item.ti].taps) return;
    this.buried.splice(this.buried.indexOf(item), 1);
    const r = holeR(item.ti);
    this.holes.push({ x: item.x, y: item.y, r });
    this.ev.push(['dug', item.id, d.id]);
    if (this.holes.length > 150) { this.holes.shift(); this.ev.push(['hshift']); }
    if (d.isBot) pushOut(d, item.x, item.y, r + 11);
    d.bag.push({ ti: item.ti, name: item.name });
    this.spawnItem(true);
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
    const carriers = this.diggers.filter(d => shiny(d) && !inMuseumZone(d.x, d.y, 30) && !this.magpies.some(m => m.target === d));
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
        if (!this.diggers.includes(tg) || !shiny(tg) || inMuseumZone(tg.x, tg.y, 20) || m.t > 14) { m.state = 'leave'; m.fleeA = Math.atan2(m.y - tg.y, m.x - tg.x); }
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
    const speed = base * (1 - Math.min(0.45, d.bag.length * 0.05));
    d.x += mx * speed * dt; d.y += my * speed * dt;
    for (let pass = 0; pass < 2; pass++) for (const h of this.holes) pushOut(d, h.x, h.y, h.r + 11);
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
        let best = null, bd = ai.mode === 'bank' ? 90 : 240;
        for (const l of this.loose) { if (l.from === b.id && l.age < 1.5) continue; const dd = dist(l, b); if (dd < bd) { bd = dd; best = l; } }
        if (best && (ai.mode !== 'dig' || TYPES[best.item.ti].v > 10)) { ai.mode = 'grab'; ai.loot = best; }
      }
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
    if (ai.mode === 'grab') {
      if (!this.loose.includes(ai.loot)) ai.mode = b.bag.length && bagValue(b) >= ai.bankAt ? 'bank' : 'hunt';
      else { gx = ai.loot.x; gy = ai.loot.y; }
    }
    if (ai.mode === 'hunt') {
      if (!ai.item || !this.buried.includes(ai.item)) {
        ai.item = null; let bd = 1e9;
        for (const it of this.buried) {
          if (this.diggers.some(o => o !== b && o.ai && o.ai.item === it)) continue;
          const dd = dist(it, b) - TYPES[it.ti].v * 1.5 + Math.random() * 120;
          if (dd < bd) { bd = dd; ai.item = it; }
        }
      }
      if (ai.item) { gx = ai.item.x; gy = ai.item.y; if (dist(b, ai.item) < 30) { ai.mode = 'dig'; ai.digT = 0.3; } }
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
    const k = ai.mode === 'hunt' ? Math.min(1, Math.hypot(gx - b.x, gy - b.y) / 40) : 1;
    this.moveDigger(b, Math.cos(ang) * k, Math.sin(ang) * k, dt, ai.mode === 'rob' ? 190 : 170);
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
      for (const h of this.holes) pushOut(d, h.x, h.y, h.r + 9);
    } else if (msg.t === 'dig') {
      const now = Date.now(); if (now - d.lastDig < 70) return; d.lastDig = now;
      const tg = this.findTarget(d); if (tg) this.digAt(d, tg);
    } else if (msg.t === 'bonk') {
      this.bonk(d);
    }
  }

  // ----- tick -----
  tick(dt) {
    if (this.state !== 'play') return;
    this.t += dt; this.timeLeft -= dt;
    if (this.timeLeft <= 0) { this.timeLeft = 0; this.flush(); this.end(); return; }
    this.updateMagpies(dt);
    for (const d of this.diggers) {
      d.stun = Math.max(0, d.stun - dt); d.immune = Math.max(0, d.immune - dt);
      d.bonkCd = Math.max(0, d.bonkCd - dt); d.swing = Math.max(0, d.swing - dt);
      if (d.isBot) this.botThink(d, dt);
      if (d.bag.length && inMuseumZone(d.x, d.y)) {
        const v = bagValue(d); d.banked += v; d.bag = [];
        this.ev.push(['bank', d.id, v]);
      }
      if (d.stun <= 0) for (let i = this.loose.length - 1; i >= 0; i--) {
        const l = this.loose[i];
        if (l.age < 0.35 || (l.from === d.id && l.age < 1.5)) continue;
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
        d.bag.map(b => b.ti).join(''), d.banked, d.moving ? 1 : 0]),
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
      room.addClient(ws, name);
      me = room.clients.get(ws).id;
      return;
    }
    if (!room) return;
    if (msg.t === 'start') { if (me === room.host && room.state !== 'play') room.start(); return; }
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
