// Finders Keepers - online game server.
// Serves the game page and runs every match: treasure, bots, magpies, timer.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Accounts, UserError, CATALOG, ACHIEVEMENTS, LOADOUT: LOADOUT_CFG, xpForLevel, MAX_LEVEL } = require('./accounts');
const { verifyGoogleToken } = require('./googleauth');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || null;

const PORT = process.env.PORT || 3000;
let accounts = new Accounts(process.env.DATABASE_URL), dbError = null;
const INDEX_PATH = path.join(__dirname, 'index.html');

// ---------- game constants ----------
const WORLD = 1800;
// ---------- maps ----------
const MAPS = {
  field: { id: 'field', name: "Farmer's Field", museum: { x: 900, y: 880, w: 220, h: 150 }, top: 70 },
  haunted: { id: 'haunted', name: 'Haunted Field', museum: { x: 900, y: 880, w: 220, h: 150 }, top: 70, season: 'halloween', night: true },
  beach: { id: 'beach', name: 'The Beach', museum: { x: 900, y: 230, w: 220, h: 150 }, top: 470,
    tide: { mid: 1340, amp: 320, period: 60 },  // sea edge moves between y 1020 (high) and 1660 (low)
    wreck: { x: 900, y: 1560, r: 230 } },
  park: { id: 'park', name: 'The Park', museum: { x: 900, y: 900, w: 200, h: 140 }, top: 70,
    circle: { x: 900, y: 900, r: 850 }, pond: { x: 1270, y: 640, r: 150 } },
  mountain: { id: 'mountain', name: 'The Mountain', museum: { x: 900, y: 1580, w: 230, h: 150 }, top: 70,
    slippery: true, ice: { x: 1330, y: 720, rx: 240, ry: 140 } },
};
// trees, rocks and the pond: placed once per server start, the same for everyone
(function placeObstacles() {
  let seed = 4242; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const P = MAPS.park, M = MAPS.mountain;
  P.obstacles = [{ x: P.pond.x, y: P.pond.y, r: P.pond.r, kind: 'pond' }];
  for (let tries = 0; P.obstacles.length < 27 && tries < 2000; tries++) {
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * (P.circle.r - 110), x = P.circle.x + Math.cos(a) * d, y = P.circle.y + Math.sin(a) * d;
    if (Math.hypot(x - P.museum.x, y - P.museum.y) < 230) continue;
    if (P.obstacles.some(o => Math.hypot(o.x - x, o.y - y) < o.r + 95)) continue;
    P.obstacles.push({ x: Math.round(x), y: Math.round(y), r: 24 + Math.round(rnd() * 10), kind: 'tree' });
  }
  M.obstacles = [];
  for (let tries = 0; M.obstacles.length < 40 && tries < 3000; tries++) {
    const x = 90 + rnd() * (WORLD - 180), y = 90 + rnd() * (WORLD - 260);
    if (Math.hypot(x - M.museum.x, y - M.museum.y) < 270) continue;
    if (((x - M.ice.x) / (M.ice.rx + 50)) ** 2 + ((y - M.ice.y) / (M.ice.ry + 50)) ** 2 < 1) continue;
    if (M.obstacles.some(o => Math.hypot(o.x - x, o.y - y) < o.r + 90)) continue;
    const rock = M.obstacles.length % 4 === 3;
    M.obstacles.push({ x: Math.round(x), y: Math.round(y), r: rock ? 30 : 22 + Math.round(rnd() * 6), kind: rock ? 'rock' : 'pine' });
  }
  const H = MAPS.haunted; H.obstacles = []; // rows of gravestones and a few dead trees
  for (let tries = 0; H.obstacles.length < 46 && tries < 4000; tries++) {
    const x = 110 + rnd() * (WORLD - 220), y = 110 + rnd() * (WORLD - 220);
    if (Math.hypot(x - H.museum.x, y - H.museum.y) < 260) continue;
    if (H.obstacles.some(o => Math.hypot(o.x - x, o.y - y) < o.r + 80)) continue;
    const tree = H.obstacles.length % 6 === 5;
    H.obstacles.push({ x: Math.round(x), y: Math.round(y), r: tree ? 26 : 15, kind: tree ? 'deadtree' : 'grave' });
  }
})();
// seasonal content: Halloween runs 20 Oct - 2 Nov (HALLOWEEN=1 or 0 forces it on or off for testing)
const seasonOn = name => name !== 'halloween' ? false : process.env.HALLOWEEN ? process.env.HALLOWEEN === '1' : accounts.isHalloween();
const mapOpen = id => MAPS[id] && (!MAPS[id].season || seasonOn(MAPS[id].season));
const openMaps = () => Object.keys(MAPS).filter(mapOpen);
const BEACH_NAMES = {
  0: ['Sea glass', 'Ring pull', 'Fishing hook', 'Lolly stick', 'Bottle cap', 'Lost earring', 'Toy spade'],
  1: ['Old penny', 'Fishing weight', 'Brass button', 'Buckle', 'Musket ball', 'Pier token'],
  2: ['Silver shilling', 'Pocket watch', 'Silver locket', 'Signet ring', 'Silver bangle'],
  3: ['Gold sovereign', 'Gold ring', 'Jewelled brooch', 'Gold chain'],
  5: ["Ship's anchor", "Ship's cannon", 'Figurehead', "Ship's bell", 'Treasure chest', "Ship's wheel"],
};
const PARK_NAMES = {
  0: ['Lolly stick', 'Hair clip', 'Ring pull', 'Toy soldier', 'Bottle top', 'Dog tag', 'Lost key'],
  1: ['Old penny', 'Bus token', 'Brass button', 'Victorian farthing', 'Thimble', 'Toy car'],
  2: ['Silver locket', 'Pocket watch', 'Silver bracelet', 'War medal', 'Silver thimble'],
  3: ['Gold wedding ring', 'Gold sovereign', 'Diamond earring', 'Gold cufflink'],
  5: ['Statue head', 'Drinking fountain', 'Cast-iron bench end', 'Bandstand bell', 'Time capsule', 'Stone lion'],
};
const MOUNTAIN_NAMES = {
  0: ['Lost glove', 'Ski pole tip', 'Frozen sock', 'Lift pass', 'Goggle strap', 'Tent peg'],
  1: ['Old penny', 'Carabiner', 'Cowbell', 'Brass compass', 'Climbing piton'],
  2: ['Silver ice axe head', 'Pocket watch', 'Silver cross', "Climber's medal", 'Silver flask'],
  3: ['Gold nugget', "Explorer's medal", 'Golden ski', 'Gold pocket watch'],
  5: ['Frozen chest', 'Old ski-lift chair', 'Mountain bell', 'Lost sledge', 'Ice-cased statue', 'Summit cross'],
};
const HAUNTED_NAMES = {
  0: ['Coffin nail', 'Rusty key', 'Old bone', 'Broken candle', 'Cracked marble', 'Bent horseshoe'],
  1: ["Witch's button", 'Candle snuffer', 'Toad charm', 'Iron cross', 'Old bell'],
  2: ['Raven brooch', 'Silver locket', 'Haunted pocket watch', 'Silver dagger'],
  3: ['Cursed crown', 'Ghost gold', "Vampire's ring", 'Gold skull'],
  5: ['Coffin', 'Stone gargoyle', 'Church bell'],
};
const MAP_NAMES = { beach: BEACH_NAMES, park: PARK_NAMES, mountain: MOUNTAIN_NAMES, haunted: HAUNTED_NAMES };
const WRECK_NAMES = { 0: ['Rusty chain link', 'Barnacled bolt'], 1: ["Ship's nail", 'Porthole latch', 'Cannonball'], 2: ['Piece of eight', "Ship's compass", 'Spyglass'], 3: ['Gold doubloon', "Captain's ring", 'Jewelled cutlass'] };
const WRECK_W = [5, 30, 40, 25], WRECK_ITEMS = 7;
// ---------- random events: two per round, one in each half ----------
const EVENTS = {
  storm:      { dur: 22, maps: ['field', 'beach', 'park', 'haunted'] }, // lightning strikes near players
  ghosts:     { dur: 18, maps: ['haunted'] },  // ghosts drift through walls after anyone carrying finds
  tractor:    { dur: 13, maps: ['field'] },    // ploughs a row, runs people over
  club:       { dur: 26 },                     // a coach party of detectorists digs out one area
  goldrush:   { dur: 20 },                     // extra silver and gold, new finds a tier better
  fog:        { dur: 25 },                     // you can only see a short way (a blizzard on the mountain)
  wave:       { dur: 11, maps: ['beach'] },    // a rogue wave surges up the beach
  swarm:      { dur: 12 },                     // a flock goes after anyone carrying finds
  dog:        { dur: 18, maps: ['park'] },     // dogs off the lead snatch finds
  keeper:     { dur: 25, maps: ['park'] },     // the park keeper confiscates finds
  icecream:   { dur: 22, maps: ['park'] },     // an ice cream van: a speed boost for whoever gets there
  avalanche:  { dur: 11, maps: ['mountain'] }, // a wall of snow sweeps down one side
  skiers:     { dur: 14, maps: ['mountain'] }, // skiers zig-zag down and wipe people out
  snowmobile: { dur: 10, maps: ['mountain'] }, // tears across the slope
};
const KEEPER_SPEED = 125, AVALANCHE_W = 560, AVALANCHE_SPEED = 280, SKIER_SPEED = 300;
const CLUB = ['Ken', 'Pat', 'Doreen', 'Clive', 'Mags'];
const BONK_REACH = 48, BONK_ARC = 1.3, BONK_REWIND = 0.15; // px, radians either side of facing, seconds
const clubFind = () => { const r = Math.random(); return r < .12 ? 3 : r < .5 ? 2 : 1; }; // silver and gold mostly
const BOLT_R = 46, TRACTOR_SPEED = 170;
const waveOffset = t => t < 2 ? 0 : t < 4 ? (t - 2) / 2 * 330 : t < 7 ? 330 : t < 11 ? (11 - t) / 4 * 330 : 0;
const ROUND = Number(process.env.ROUND) || 180, DUSK = 30, TICK_MS = 50;
const MIN_DIGGERS = 6, MAX_PLAYERS = 8, ITEMS = 60;
const BOT_SENSE = 260;      // how far a bot's detector reaches
const OWN_DROP_LOCK = 5;    // seconds before you can pick back up what was knocked out of your bag
const DIG_REACH = 46;       // how close you must be to a find to dig it (any direction)
const TYPES = [
  { k: 'junk',   v: 1,   taps: 2,  col: '#a7a69a', ring: '#d9d8cc', w: 30, tone: 'square', base: 180,
    names: ['Bottle cap', 'Ring pull', 'Rusty nail', 'Toy car', 'Bent spoon', 'Lost key', 'Tin soldier', 'Old horseshoe', 'Shotgun cartridge', 'Foil wrapper'] },
  { k: 'common', v: 10,  taps: 4,  col: '#c98a46', ring: '#e8a35a', w: 40, tone: 'triangle', base: 520,
    names: ['Old penny', 'Brass button', 'Musket ball', 'Thimble', 'Buckle', 'Clay pipe', 'Farthing', 'Lead token', 'Copper ring', 'Harness bell'] },
  { k: 'rare',   v: 40,  taps: 7,  col: '#dfe8ef', ring: '#eef6ff', w: 22, tone: 'sine', base: 760,
    names: ['Silver brooch', 'Silver shilling', 'Sword hilt', 'Pocket watch', 'Silver spoon', 'Medieval seal', 'Signet ring', 'Silver locket', 'Roman denarius', 'Spur'] },
  { k: 'epic',   v: 150, taps: 12, col: '#f2c230', ring: '#ffd447', w: 8, tone: 'sine', base: 980,
    names: ['Gold torc', 'Saxon ring', 'Roman helmet', 'Gold guinea', 'Viking arm ring', 'Jewelled crown', 'Gold chalice', 'Celtic stater'] },
  { k: 'box',    v: 0,   taps: 3,  col: '#4fc3e8', ring: '#8fe6ff', w: 0, tone: 'triangle', base: 640, names: ['Mystery box'] },
  { k: 'heavy',  v: 300, taps: 16, col: '#9b7bd1', ring: '#c9a6ff', w: 0, tone: 'sawtooth', base: 260,
    names: ['Viking anchor', 'Bronze bell', "Stone king's head", 'Iron cannon', "Pirate's chest", 'Roman milestone', 'Knight in armour', 'Church bell'] },
  { k: 'scrap',  v: 6,   taps: 1,  col: '#8d8478', ring: '#b8b0a2', w: 0, tone: 'square', base: 200, names: ['Scrap metal', 'Bent bracket', 'Iron shard', 'Bronze fragment'] },
];
const BOX = 4, HEAVY = 5, SCRAP = 6, HEAVIES = 2; // HEAVIES: how many heavy finds are buried at once
const HEAVY_WAIT = 10;  // seconds a heavy find waits above ground for two carriers before it sinks
const HEAVY_HP = 8;     // bonks it takes to smash a heavy find
const SCRAP_PIECES = 10; // a smashed heavy find scatters 20% of its value as this many scrap drops
// ---------- powerups ----------
const POWERS = {
  c: { name: 'Pro coil',    short: 'COIL',    dur: 20, desc: 'Detector reaches twice as far' },
  t: { name: 'Turbo spade', short: 'TURBO',   dur: 15, desc: 'Every dig counts double' },
  w: { name: 'Wellies',     short: 'WELLIES', dur: 15, desc: 'Faster, and you can walk over holes' },
  p: { name: 'Padlock',     short: 'LOCK',    dur: 0,  cost: 60,  desc: 'Blocks the next bonk while you carry finds' },
  s: { name: 'Scarecrow',   short: 'SCARE',   dur: 30, cost: 90,  desc: 'Magpies leave you alone' },
  d: { name: 'Decoy',       short: 'DECOY',   dur: 0,  cost: 120, desc: 'Plants a fake gold find that is really junk' },
  // lucky
  m: { name: 'Magnet',       short: 'MAGNET',  dur: 10, desc: 'Pulls in dropped finds and scrap around you' },
  l: { name: 'Lucky charm',  short: 'LUCKY',   dur: 0,  desc: 'Your next 3 finds are upgraded a tier' },
  r: { name: 'Treasure map', short: 'MAP',     dur: 15, desc: 'Marks the best finds on the field' },
  // pvp
  b: { name: 'Banana peel',  short: 'BANANA',  dur: 0,  desc: 'Drops a trap: whoever slips drops their best find' },
  k: { name: 'Stink bomb',   short: 'STINK',   dur: 8,  desc: "Scrambles everyone's detector around you" },
  g: { name: 'Sticky glove', short: 'GLOVE',   dur: 30, desc: 'Your next bonk steals the find straight into your bag' },
  q: { name: 'Big bonk',     short: 'BIG BONK',dur: 0,  desc: 'Shockwave: everyone around you drops their best find' },
  // zombie modes only
  h: { name: 'Cricket bat',  short: 'BAT',     dur: 25, desc: 'Your bonks hit zombies twice as hard' },
};
// ---------- co-op zombie modes ----------
const COOP = {
  survive: { name: 'Survive', waves: 5 },             // hold out through five waves
  endless: { name: 'Endless', waves: Infinity },      // waves until everyone's down; beat your best
  escape:  { name: 'Escape', time: 240, parts: 4 },   // carry engine parts to the bus before time runs out
};
const COOP_TEAM = 4, MAX_HP = 100, REVIVE_TIME = 2.5;
const ZOMBIE = { // hp in bonks, speed, damage per hit, size
  walker: { hp: 2, speed: 62, dmg: 12, r: 15, code: 0 },
  runner: { hp: 1, speed: 128, dmg: 8, r: 13, code: 1 },
  brute:  { hp: 7, speed: 46, dmg: 25, r: 22, code: 2 },
};
const COOP_NAMES = {
  0: ['Tin of beans', 'Bottle of water', 'Chocolate bar', 'Packet of crisps', 'Energy drink'],
  1: ['Bandages', 'Plasters', 'Painkillers', 'Sling'],
  2: ['Medkit', 'First aid kit', 'Field medic bag'],
  3: ['Supply drop', 'Army crate', 'Survival kit'],
  4: ['Mystery box'],
  5: ['Engine part', 'Car battery', 'Fuel can', 'Spare wheel', 'Fan belt', 'Spark plugs'],
};
const COOP_HEAL = { 0: 10, 1: 30, 2: 60 };
const COOP_POWERS = ['q', 'k', 'w', 'h', 'h', 'q'];
const coopType = () => { const r = Math.random(); return r < .4 ? 0 : r < .68 ? 1 : r < .8 ? 2 : r < .92 ? 3 : BOX; };
const BOX_POWERS = ['c', 't', 'w', 'm', 'l', 'r'], ALL_POWERS = Object.keys(POWERS).filter(k => k !== 'h');
// Loadout: one powerup to start the round with, bought with coins on the player's phone
const MAGNET_R = 170, STINK_R = 150, SHOCK_R = 85, TRAP_LIFE = 60;
const BOX_CHANCE = 1 / 12, CRATE_FIRST = 20, CRATE_EVERY = 30;
const TIRED_AFTER = 2, TIRED_SECS = 10; // bonking empty-handed players this many times in 15s tires your arm
const pick = a => a[Math.random() * a.length | 0];
// quick chat: the client holds the words; these are the indexes bots use
const SAY_COUNT = 15, SAY = { gotcha: 6, oi: 8, laugh: 9, angry: 10, shock: 12 };
// ---------- cosmetics (bought in each player's wardrobe; the server only checks the ids are real) ----------
const LOOK_IDS = Object.fromEntries(Object.entries(CATALOG).map(([k, v]) => [k, v.items.map(i => i[0])]));
const JACKET_HEX = { red: '#c0392b', yellow: '#e2b822', pink: '#e84393', orange: '#e67e22', purple: '#8e44ad', sky: '#3fa7d6', black: '#2b2b2b', white: '#ecebe4', camo: '#5d6b3a', hivis: '#cde62a', stripes: '#1f3b73', tartan: '#a3262a', vampcape: '#1d1d1d', mummy: '#e8dfc4', reaperrobe: '#1a1a22',
  tux: '#1d1d1d', chefwhites: '#f4f1e8', santasuit: '#c0392b', skeleton: '#1d1d1d', banana: '#f2d13c', ghost: '#f1f1f1', wizrobe: '#4b2a8a', hero: '#2d5f9e', knight: '#9aa4ad', dino: '#4caf50', astro: '#eef1f4' };
const cleanLook = (raw, acct) => accounts.cleanLook(acct || null, raw); // guests only get the free items
function botLook() {
  const ids = k => CATALOG[k].items.filter(i => !i[4] || seasonOn(i[4])).map(i => i[0]); // bots dress up for Halloween too, but only while it's on
  const l = {}; for (const k in LOOK_IDS) l[k] = k === 'jacket' ? 'auto' : (k === 'pet' || k === 'trail') && Math.random() < 0.6 ? 'none' : pick(ids(k)); return l;
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

function pushOut(d, x, y, min) {
  let dx = d.x - x, dy = d.y - y, dd = Math.hypot(dx, dy);
  if (dd < min) { if (dd < 0.01) { dx = 1; dy = 0; dd = 1; } d.x = x + dx / dd * min; d.y = y + dy / dd * min; return true; }
  return false;
}
function turnTo(d, want, dt) { let a = want - d.dir; a = Math.atan2(Math.sin(a), Math.cos(a)); d.dir += a * Math.min(1, dt * 12); }

// ---------- a match ----------
class Room {
  constructor(code, opts = {}) {
    this.code = code;
    this.public = !!opts.public;     // Quick Play: anyone can drop in, rounds start on their own
    this.tutorial = !!opts.tutorial; // one player, a practice dummy, no surprises
    this.autoT = null;
    this.mode = 'classic'; // or a co-op zombie mode: 'survive', 'endless', 'escape'
    this.theme = ''; // 'halloween': any map at night, with pumpkins, bats, ghosts and spooky finds
    this.clients = new Map(); // ws -> {id, name, col}
    this.state = 'lobby';
    this.host = null;
    this.nextId = 1;
    this.mapId = 'field'; this.map = MAPS.field; this.M = this.map.museum;
    this.resetWorld();
  }
  resetWorld() {
    this.diggers = []; this.buried = []; this.holes = []; this.loose = []; this.magpies = [];
    this.ev = []; this.timeLeft = ROUND; this.magpieT = 10; this.uid = 1; this.t = 0;
    this.crates = []; this.crateT = CRATE_FIRST; this.heavies = []; this.traps = [];
    this.sea = this.map.tide ? this.map.tide.mid : Infinity; this.washT = 2; this.wreckT = 5;
    this.event = null; this.usedEvents = []; this.bolts = []; this.keeper = null; this.skiers = [];
    this.evPlan = [ROUND * (0.22 + Math.random() * 0.12), ROUND * (0.56 + Math.random() * 0.12)];
  }
  send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  broadcast(obj) { const s = JSON.stringify(obj); for (const ws of this.clients.keys()) if (ws.readyState === 1) ws.send(s); }
  lobbyMsg() {
    this.broadcast({ t: 'lobby', code: this.code, host: this.host, state: this.state, map: this.mapId, theme: this.theme, mode: this.mode, public: this.public ? 1 : 0, auto: this.autoT != null ? Math.ceil(this.autoT) : null,
      players: [...this.clients.values()].map(c => ({ id: c.id, name: c.name, col: c.col, lvl: c.lvl, guest: !c.acct })) });
  }
  addClient(ws, name, rawLook, acct) {
    const used = new Set([...this.clients.values()].map(c => c.base));
    const base = HUMAN_COLS.find(x => !used.has(x)) || HUMAN_COLS[0];
    const look = acct ? accounts.cleanLook(acct, acct.data.look) : cleanLook(rawLook);
    const c = { id: this.nextId++, name: acct ? acct.name : name, base, look, col: lookCol(look, base), lvl: acct ? accounts.level(acct) : 0, acct: acct || null };
    this.clients.set(ws, c);
    if (this.host === null) this.host = c.id;
    this.send(ws, { t: 'hello', you: c.id });
    if (this.state === 'play') {
      const d = this.makeDigger(c.id, c.name, c.col, false, Math.random() * 6, c.look, c.lvl); d.slots = acct ? accounts.slots(acct) : 1; if (this.isCoop()) { d.hp = MAX_HP; d.down = false; d.revive = 0; }
      this.diggers.push(d);
      this.ev.push(['join', { id: d.id, name: d.name, col: d.col, bot: 0, look: d.look, lvl: d.lvl }]);
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
    c.look = cleanLook(raw, c.acct); c.col = lookCol(c.look, c.base);
    const d = this.diggers.find(x => x.id === id);
    if (d) { d.look = c.look; d.col = c.col; this.ev.push(['look', id, c.look, c.col]); }
    this.lobbyMsg();
  }
  makeDigger(id, name, col, isBot, slot, look, lvl) {
    const a = slot / 6 * Math.PI * 2 + 0.4;
    return { id, name, col, isBot, look: look || botLook(), lvl: isBot ? 1 + (Math.random() * 15 | 0) : lvl || 0, lucky: 0, x: this.M.x + Math.cos(a) * 170, y: this.M.y + 10 + Math.sin(a) * 140, dir: a,
      bag: [], banked: 0, stun: 0, immune: 0, bonkCd: 0, swing: 0, moving: false, lastDig: 0, power: null, held: [], sel: 0, slots: 1, fx: {}, padlock: false, carry: null, grief: 0, griefT: 0, tired: 0,
      ai: isBot ? { mode: 'hunt', item: null, think: 0, digT: 0, digRate: 2 + Math.random() * 1, bankAt: 40 + Math.random() * 110,
        aggro: 0.3 + Math.random() * 0.6, robCd: 4 + Math.random() * 6, chase: 0, victim: null, loot: null,
        lx: 0, ly: 0, stuckT: 0, detour: 0, detourA: 0, wander: null } : null };
  }
  inMuseum(x, y, pad = 0) {
    const M = this.M;
    return x > M.x - M.w / 2 - pad && x < M.x + M.w / 2 + pad && y > M.y - M.h / 2 - pad && y < M.y + M.h / 2 + pad;
  }
  underwater(y, margin = 0) { return y > this.sea - margin; }
  // keep a point inside the walkable area: the square world, the park railings, round trees, rocks and the pond
  fit(o) {
    o.x = clampW(o.x); o.y = clampW(o.y);
    const C = this.map.circle;
    if (C) { const dx = o.x - C.x, dy = o.y - C.y, d = Math.hypot(dx, dy), max = C.r - 40; if (d > max) { o.x = C.x + dx / d * max; o.y = C.y + dy / d * max; } }
    for (const ob of this.map.obstacles || []) pushOut(o, ob.x, ob.y, ob.r + 12);
    return o;
  }
  // somewhere finds, crates and traps can't go
  blocked(x, y, pad = 0) {
    const C = this.map.circle; if (C && Math.hypot(x - C.x, y - C.y) > C.r - 70 - pad) return true;
    return (this.map.obstacles || []).some(ob => Math.hypot(ob.x - x, ob.y - y) < ob.r + 20 + pad);
  }
  onIce(o) { const I = this.map.ice; return !!I && ((o.x - I.x) / I.rx) ** 2 + ((o.y - I.y) / I.ry) ** 2 < 1; }
  setMap(id) { if (mapOpen(id) && id !== 'haunted' && this.state !== 'play') { this.mapId = id; this.lobbyMsg(); } }
  start() {
    // Farmer's Field on Halloween night is the graveyard
    this.choice = this.mapId; if (this.mapId === 'field' && this.theme === 'halloween' && seasonOn('halloween')) this.mapId = 'haunted';
    this.map = MAPS[this.mapId]; this.M = this.map.museum;
    this.resetWorld();
    const humans = [...this.clients.values()];
    humans.forEach((c, i) => { const d = this.makeDigger(c.id, c.name, c.col, false, i, c.look, c.lvl); d.slots = c.acct ? accounts.slots(c.acct) : 1; this.diggers.push(d); });
    for (const [ws, c] of this.clients) if (c.acct) {
      const got = accounts.checkAch(c.acct, ['rounds', 'wins', 'level', 'owned']); // catches up older accounts
      if (got.length) this.send(ws, { t: 'profile', profile: accounts.profile(c.acct), ach: got.map(x => x.id) });
      this.stat(c.id, 'maps', this.mapId, 'set');
    }
    const bots = this.tutorial ? 0 : Math.max(0, (this.isCoop() ? COOP_TEAM : MIN_DIGGERS) - humans.length);
    for (let i = 0; i < bots; i++) { const [n, col] = BOTS[i]; this.diggers.push(this.makeDigger(1000 + i, n, col, true, humans.length + i)); }
    if (this.tutorial){ // a practice dummy who stands still holding a find, a little way from the Museum
      const d = this.makeDigger(1000, 'Practice Pete', '#8a6d3b', true, 0, { hat: 'cap', jacket: 'auto', boots: 'green', pack: 'canvas', pet: 'none', trail: 'none', det: 'retro', spade: 'old', win: 'confetti' }, 1);
      d.dummy = true; d.x = this.M.x + 260; d.y = this.M.y + 60; d.dir = Math.PI; d.bag = [{ ti: 1, name: 'Brass button' }]; this.diggers.push(d);
    }
    for (const d of this.diggers) this.fit(d);
    if (this.tutorial){ // a few easy finds just below the Museum, and plenty more around
      for (const [dx, dy, ti] of [[-120, 230, 1], [60, 300, 0], [180, 220, 1], [-60, 380, 2]]){ const b = { id: this.uid++, x: this.M.x + dx, y: this.M.y + dy, ti, name: this.itemName(ti), prog: 0 }; this.fit(b); this.buried.push(b); }
      for (let i = 0; i < 25; i++) this.spawnItem(false);
      this.evPlan = []; this.timeLeft = 600; this.crateT = 1e9; this.magpieT = 1e9;
    } else if (this.isCoop()) this.coopStart();
    else {
    for (let i = 0; i < ITEMS; i++) this.spawnItem(false);
    for (let i = 0; i < HEAVIES; i++) this.spawnItem(false, HEAVY);
    }
    if (this.map.wreck) for (let i = 0; i < WRECK_ITEMS; i++) this.spawnWreckItem();
    this.ev = []; this.traps = [];
    this.state = 'play';
    // starting powerups are paid for from the account as the round begins
    for (const [ws, c] of this.clients) if (c.acct) accounts.chargeLoadout(c.acct).then(k => {
      if (!k || this.state !== 'play') return;
      const d = this.diggers.find(x => x.id === c.id); if (d) this.givePower(d, k, 'loadout');
      this.send(ws, { t: 'profile', profile: accounts.profile(c.acct), charged: { k, coins: LOADOUT_CFG[k][1] } });
    }).catch(e => console.error('loadout', e.message));
    for (const [ws, c] of this.clients) this.send(ws, this.initMsg(c.id));
    this.lobbyMsg();
  }
  initMsg(you) {
    return { t: 'init', you, mode: this.mode, coop: this.coopInfo(), theme: this.spooky() && this.mapId !== 'haunted' ? 'halloween' : '', types: TYPES, powers: POWERS, world: WORLD, museum: this.M, map: this.mapId, circle: this.map.circle || null, obstacles: this.map.obstacles || [], ice: this.map.ice || null, slippery: !!this.map.slippery, tide: this.map.tide || null, wreck: this.map.wreck || null, top: this.map.top, sea: Math.round(this.sea), round: ROUND, dusk: DUSK, tl: this.timeLeft, event: this.event ? { kind: this.event.kind, left: this.event.dur - this.event.t, dur: this.event.dur, data: this.event.data } : null,
      diggers: this.diggers.map(d => ({ id: d.id, name: d.name, col: d.col, bot: d.isBot ? 1 : 0, look: d.look, lvl: d.lvl, npc: d.npc ? 1 : 0 })),
      traps: (this.traps || []).map(tr => [tr.id, Math.round(tr.x), Math.round(tr.y), tr.owner]),
      buried: this.buried.map(b => [b.id, Math.round(b.x), Math.round(b.y), b.ti, b.prog, b.name, b.owner || 0]),
      holes: this.holes.map(h => [Math.round(h.x), Math.round(h.y), h.r]),
      loose: this.loose.map(l => [l.id, Math.round(l.x), Math.round(l.y), l.item.ti, l.item.name]),
      heavies: this.heavies.map(h => [h.id, Math.round(h.x), Math.round(h.y), h.name, h.carriers.map(c => c.id).join(','), h.hp, Math.ceil(h.wait)]) };
  }
  end() {
    this.state = 'end'; this.autoT = null;
    if (this.choice) this.mapId = this.choice; // back to what the host picked (the graveyard is Farmer's Field at Halloween)
    const ranked = this.diggers.filter(d => !d.npc).sort((a, b) => b.banked - a.banked);
    const coop = this.isCoop() ? this.coopResult || { mode: this.mode, won: false, wave: this.wave, kills: this.kills, parts: this.parts } : null; this.coopResult = null;
    this.broadcast({ t: 'end', rank: ranked.map(d => [d.id, d.name, d.col, d.banked, d.isBot ? 1 : 0]), coop });
    if (coop) this.zombies = [];
    // coins and XP go onto each signed-in player's account
    for (const [ws, c] of this.clients) {
      if (!c.acct) continue;
      const place = ranked.findIndex(d => d.id === c.id); if (place < 0) continue;
      accounts.reward(c.acct, ranked[place].banked, coop ? (coop.won ? 0 : 3) : place).then(r => {
        c.lvl = accounts.level(c.acct);
        this.send(ws, { t: 'reward', ...r, profile: accounts.profile(c.acct) });
        this.lobbyMsg();
      }).catch(e => { console.error('reward', e.message); this.send(ws, { t: 'reward', error: 'Couldn\'t save this round to your account. Try again later.' }); });
    }
    this.lobbyMsg();
  }

  // ----- world -----
  humanNear(x, y, r) { return this.diggers.some(d => !d.isBot && Math.hypot(d.x - x, d.y - y) < r); }
  inHole(x, y, pad) { return this.holes.some(h => Math.hypot(h.x - x, h.y - y) < h.r + pad); }
  isCoop() { return !!COOP[this.mode]; }
  names() { if (this.isCoop()) return COOP_NAMES; return this.theme === 'halloween' && seasonOn('halloween') ? HAUNTED_NAMES : MAP_NAMES[this.mapId] || {}; }
  spooky() { return this.mapId === 'haunted' || (this.theme === 'halloween' && seasonOn('halloween')); }
  itemName(ti, wreck) {
    const pool = wreck ? WRECK_NAMES[ti] : this.names()[ti];
    return pick(pool || TYPES[ti].names);
  }
  spawnItem(awayFromPlayers, forceTi, band) {
    for (let tries = 0; tries < 60; tries++) {
      const y0 = band ? band[0] : this.map.top, y1 = band ? band[1] : Math.min(WORLD - 70, this.sea - 40);
      if (y1 <= y0) return;
      const x = 70 + Math.random() * (WORLD - 140), y = y0 + Math.random() * (y1 - y0);
      if (this.inMuseum(x, y, 90) || this.underwater(y, 30) || this.blocked(x, y)) continue;
      if (this.map.wreck && Math.hypot(x - this.map.wreck.x, y - this.map.wreck.y) < this.map.wreck.r) continue;
      if (awayFromPlayers && this.humanNear(x, y, 400)) continue;
      if (this.buried.some(b => Math.hypot(b.x - x, b.y - y) < 60)) continue;
      if (this.inHole(x, y, 40)) continue;
      let ti = forceTi != null ? forceTi : this.isCoop() ? coopType() : Math.random() < BOX_CHANCE ? BOX : pickTypeIdx();
      if (forceTi == null && ti < 3 && this.event && this.event.kind === 'goldrush') ti++;
      let name = this.itemName(ti);
      if (ti === HEAVY) { const used = new Set([...this.buried, ...this.heavies].map(o => o.name)); name = pick((this.names()[HEAVY] || TYPES[HEAVY].names).filter(n => !used.has(n))) || name; }
      const b = { id: this.uid++, x, y, ti, name, prog: 0 };
      this.buried.push(b);
      if (this.state === 'play') this.ev.push(['spawn', b.id, Math.round(x), Math.round(y), ti, b.name, 0]);
      return;
    }
  }
  // the shipwreck: richer, ship-themed finds, only reachable when the tide is out
  spawnWreckItem() {
    const W = this.map.wreck;
    for (let tries = 0; tries < 40; tries++) {
      const a = Math.random() * Math.PI * 2, r = 40 + Math.random() * (W.r - 40);
      const x = W.x + Math.cos(a) * r * 1.4, y = W.y + Math.sin(a) * r * 0.55;
      if (this.buried.some(b => Math.hypot(b.x - x, b.y - y) < 45) || this.inHole(x, y, 30) || y > WORLD - 60) continue;
      let w = Math.random() * 100, ti = 0; for (let i = 0; i < 4; i++) { if ((w -= WRECK_W[i]) < 0) { ti = i; break; } }
      const b = { id: this.uid++, x, y, ti, name: this.itemName(ti, true), prog: 0, wreck: true };
      this.buried.push(b);
      if (this.state === 'play') this.ev.push(['spawn', b.id, Math.round(x), Math.round(y), ti, b.name, 0]);
      return;
    }
  }
  // the tide: covers the lower beach, smooths holes, washes things away, leaves fresh finds as it goes out
  updateTide(dt) {
    const T = this.map.tide; if (!T) return;
    const prev = this.sea;
    this.sea = T.mid + T.amp * Math.sin(2 * Math.PI * this.t / T.period) - (this.event && this.event.kind === 'wave' ? waveOffset(this.event.t) : 0);
    const goingOut = this.sea > prev;
    const before = this.holes.length;
    this.holes = this.holes.filter(h => !this.underwater(h.y, -8));
    if (this.holes.length !== before) this.ev.push(['hclear', Math.round(this.sea + 8)]);
    for (const l of [...this.loose]) if (this.underwater(l.y)) { this.loose.splice(this.loose.indexOf(l), 1); this.ev.push(['washed', l.id]); }
    this.crates = this.crates.filter(c => !this.underwater(c.y));
    for (const tr of [...this.traps]) if (this.underwater(tr.y)) { this.traps.splice(this.traps.indexOf(tr), 1); this.ev.push(['trapgone', tr.id]); }
    for (const h of [...this.heavies]) if (!h.carriers.length && this.underwater(h.y)) {
      this.heavies.splice(this.heavies.indexOf(h), 1); this.ev.push(['hsea', h.id, h.name]); this.spawnItem(true, HEAVY);
    }
    if (goingOut && (this.washT -= dt) <= 0) { // fresh finds on newly uncovered sand
      this.washT = 1.1;
      if (this.buried.filter(b => !b.wreck && b.ti !== HEAVY).length < ITEMS + 12) this.spawnItem(true, null, [this.sea - 170, this.sea - 35]);
    }
    if ((this.wreckT -= dt) <= 0) { this.wreckT = 4; if (this.buried.filter(b => b.wreck).length < WRECK_ITEMS) this.spawnWreckItem(); }
    for (const d of this.diggers) if (this.underwater(d.y, -45) && !d.carry) { // too deep: the waves push you back
      d.y = this.sea + 30; if (!d.isBot) this.ev.push(['pos', d.id, Math.round(d.x), Math.round(d.y)]);
    }
  }
  findTarget(d, id) {
    if (id != null) { const b = this.buried.find(x => x.id === id); if (b && b.owner !== d.id && !this.underwater(b.y, 4) && dist(b, d) < DIG_REACH + 10) return b; }
    let best = null, bd = DIG_REACH;
    for (const b of this.buried) { if (b.owner === d.id || this.underwater(b.y, 4)) continue; const dd = dist(b, d); if (dd < bd) { bd = dd; best = b; } }
    return best;
  }
  digAt(d, item) {
    if (d.stun > 0 || !this.buried.includes(item) || this.underwater(item.y, 4)) return;
    item.prog = Math.min(TYPES[item.ti].taps, item.prog + (d.fx.t > 0 ? 2 : 1));
    this.ev.push(['prog', item.id, item.prog, d.id]);
    if (item.prog < TYPES[item.ti].taps) return;
    this.buried.splice(this.buried.indexOf(item), 1);
    const r = holeR(item.ti);
    this.holes.push({ x: item.x, y: item.y, r });
    this.ev.push(['dug', item.id, d.id, item.decoy ? 1 : 0]);
    if (!item.decoy){ this.stat(d.id, 'finds'); if (item.ti === 3) this.stat(d.id, 'gold'); if (item.ti === BOX) this.stat(d.id, 'boxes'); if (item.wreck) this.stat(d.id, 'wreck'); }
    if (this.holes.length > 150) { this.holes.shift(); this.ev.push(['hshift']); }
    if (d.isBot) pushOut(d, item.x, item.y, r + 11);
    if (item.decoy) {
      d.bag.push({ ti: 0, name: 'Fake gold' });
      this.ev.push(['decoyed', d.id, item.owner]);
      return; // decoys aren't replaced
    }
    if (item.ti === HEAVY) {
      const h = { id: this.uid++, x: item.x, y: item.y, name: item.name, carriers: [], hp: HEAVY_HP, wait: this.heavyWait() };
      this.heavies.push(h);
      this.ev.push(['heavy', h.id, Math.round(h.x), Math.round(h.y), h.name, d.id]);
      return; // a new heavy find is buried once this one is banked
    }
    if (this.isCoop()) { this.coopSupply(d, item); this.spawnItem(true); return; }
    if (item.ti === BOX) this.givePower(d, pick(BOX_POWERS), 'box');
    else if (d.lucky > 0 && item.ti < 3) {
      d.lucky--;
      const ti = item.ti + 1, name = pick(TYPES[ti].names);
      d.bag.push({ ti, name });
      this.ev.push(['lucky', d.id, ti, name, d.lucky]);
    }
    else d.bag.push({ ti: item.ti, name: item.name });
    this.spawnItem(true);
  }

  // ----- random events -----
  dryPoint(minFromMuseum) {
    for (let i = 0; i < 40; i++) {
      const x = 200 + Math.random() * (WORLD - 400), y = this.map.top + 120 + Math.random() * Math.max(50, Math.min(WORLD - 200, this.sea - 220) - this.map.top - 120);
      if (Math.hypot(x - this.M.x, y - this.M.y) > minFromMuseum && !this.blocked(x, y, 40)) return { x, y };
    }
    return this.fit({ x: 500, y: Math.min(WORLD - 300, this.sea - 250) });
  }
  startEvent() {
    // map-specific events come up twice as often as the shared ones
    const options = Object.keys(EVENTS).filter(k => (!EVENTS[k].maps || EVENTS[k].maps.includes(this.mapId) || (k === 'ghosts' && this.spooky())) && !this.usedEvents.includes(k)).flatMap(k => EVENTS[k].maps ? [k, k] : [k]);
    if (!options.length) return;
    const kind = pick(options); this.usedEvents.push(kind);
    const ev = this.event = { kind, t: 0, dur: EVENTS[kind].dur, data: {}, boltT: 2 };
    if (kind === 'tractor' || kind === 'snowmobile') {
      let y = 0;
      for (let i = 0; i < 30; i++) { y = this.map.top + 150 + Math.random() * (WORLD - 300 - this.map.top); if (Math.abs(y - this.M.y) > 170) break; }
      const dir = Math.random() < 0.5 ? 1 : -1;
      ev.data = { y: Math.round(y), x0: dir > 0 ? -120 : WORLD + 120, dir, speed: kind === 'snowmobile' ? 260 : TRACTOR_SPEED };
    }
    if (kind === 'club') {
      const c = this.dryPoint(400); ev.data = { x: Math.round(c.x), y: Math.round(c.y), r: 260 };
      const names = [...CLUB].sort(() => Math.random() - 0.5).slice(0, 4);
      names.forEach((n, i) => {
        const d = this.makeDigger(2000 + this.uid++, 'Club ' + n, '#7d8a6a', true, 0, { hat: pick(['bucket', 'cap', 'deer']), jacket: 'auto', boots: 'green', pack: 'canvas', pet: 'none', trail: 'none', det: 'retro', spade: 'old', win: 'confetti' });
        d.npc = true; d.lvl = 0; d.ai.area = ev.data; d.ai.digRate = 2.4;
        for (let k = 0; k < 2; k++){ const ti = clubFind(); d.bag.push({ ti, name: this.itemName(ti) }); } // they turn up with something worth robbing
        d.x = c.x < WORLD / 2 ? 60 : WORLD - 60; d.y = c.y - 60 + i * 40;
        this.diggers.push(d);
        this.ev.push(['join', { id: d.id, name: d.name, col: d.col, bot: 1, npc: 1, look: d.look, lvl: 0 }]);
      });
      for (let k = 0; k < 10; k++) this.clubBury(ev.data); // they've found a good spot
    }
    if (kind === 'dog') { // two dogs, in through the park gate, after whoever's carrying the most
      const C = this.map.circle || { x: WORLD / 2, y: WORLD / 2, r: 800 };
      let open = this.diggers.filter(d => !this.inMuseum(d.x, d.y, 30)).sort((a, b) => bagValue(b) - bagValue(a));
      if (!open.length) open = this.diggers.slice();
      for (let i = 0; i < 2 && open.length; i++) {
        const tg = open[i % open.length], a = Math.random() * Math.PI * 2;
        const m = { id: this.uid++, x: C.x + Math.cos(a) * C.r, y: C.y + Math.sin(a) * C.r, alt: 0, target: tg, item: null, any: true, kind: 'dog',
          state: 'hunt', t: 0, ts: 0, dir: a + Math.PI, stun: 0, fleeA: 0, rolled: new Set(), steals: 0 };
        this.magpies.push(m);
      }
    }
    if (kind === 'ghosts') {
      const open = this.diggers.filter(d => !this.inMuseum(d.x, d.y, 30)).sort((a, b) => bagValue(b) - bagValue(a));
      for (let i = 0; i < 3; i++) {
        const tg = open[i % Math.max(1, open.length)] || this.diggers[0], a = Math.random() * Math.PI * 2;
        this.magpies.push({ id: this.uid++, x: WORLD / 2 + Math.cos(a) * 1000, y: WORLD / 2 + Math.sin(a) * 1000, alt: 8, target: tg, item: null, any: true, kind: 'ghost',
          state: 'hunt', t: 0, ts: 0, dir: a + Math.PI, stun: 0, fleeA: 0, rolled: new Set(), steals: 0 });
      }
    }
    if (kind === 'keeper') { const C = this.map.circle; this.keeper = { x: C.x, y: C.y + C.r - 60, dir: -Math.PI / 2, cool: new Map() }; }
    if (kind === 'icecream') { const p = this.dryPoint(250); ev.data = { x: Math.round(p.x), y: Math.round(p.y) }; ev.served = new Set(); }
    if (kind === 'avalanche') { ev.data = { x: Math.round(300 + Math.random() * (WORLD - 600)), w: AVALANCHE_W, speed: AVALANCHE_SPEED }; ev.hit = new Set(); }
    if (kind === 'skiers') {
      this.skiers = Array.from({ length: 5 }, (_, i) => ({ id: this.uid++, x0: 200 + Math.random() * (WORLD - 400), y: -40 - i * 140, ph: Math.random() * 7, x: 0, hit: new Map() }));
    }
    if (kind === 'goldrush') for (let i = 0; i < 10; i++) this.spawnItem(false, Math.random() < 0.6 ? 2 : 3);
    if (kind === 'swarm') {
      const open = this.diggers.filter(d => !(d.fx.s > 0) && !this.inMuseum(d.x, d.y, 30) && !d.npc);
      const targets = open.filter(d => d.bag.length).sort((a, b) => bagValue(b) - bagValue(a)).slice(0, 4);
      for (const d of open.sort(() => Math.random() - 0.5)) if (targets.length < 3 && !targets.includes(d)) targets.push(d);
      targets.forEach(tg => this.spawnBirdAt(tg, true));
      ev.data = { birds: targets.length };
    }
    this.ev.push(['evstart', kind, ev.dur, ev.data]);
  }
  endEvent() {
    const ev = this.event; this.event = null; this.bolts = []; this.keeper = null; this.skiers = [];
    if (ev.kind === 'dog' || ev.kind === 'ghosts') for (const m of this.magpies) if ((m.kind === 'dog' || m.kind === 'ghost') && m.state === 'hunt') { m.state = 'leave'; m.fleeA = Math.random() * 7; }
    if (ev.kind === 'avalanche') { const D = ev.data; for (let i = 0; i < 6; i++) this.spawnItem(false, null, [this.map.top + 100, WORLD - 300]); }
    if (ev.kind === 'club') for (const d of this.diggers.filter(x => x.npc)) {
      if (d.carry) this.unlift(d);
      this.diggers.splice(this.diggers.indexOf(d), 1); this.ev.push(['leave', d.id]);
    }
    this.ev.push(['evend', ev.kind]);
  }
  updateEvent(dt) {
    if (!this.event) {
      if (this.evPlan.length && this.t >= this.evPlan[0]) { this.evPlan.shift(); if (this.timeLeft > 15) this.startEvent(); }
      return;
    }
    const ev = this.event; ev.t += dt;
    if (ev.kind === 'storm' && ev.t < ev.dur - 1.5 && (ev.boltT -= dt) <= 0) {
      ev.boltT = 1.4 + Math.random() * 1.2;
      for (let n = 0; n < 2; n++) {
        const pool = this.diggers.filter(d => !this.inMuseum(d.x, d.y, 30) && !this.underwater(d.y));
        const near = pool.length && Math.random() < 0.7 ? pick(pool) : null;
        const p = near ? { x: near.x + (Math.random() - 0.5) * 140, y: near.y + (Math.random() - 0.5) * 140 } : this.dryPoint(150);
        const q = this.fit({ x: p.x, y: p.y }), b = { id: this.uid++, x: q.x, y: q.y, t: 1.1 };
        this.bolts.push(b); this.ev.push(['bolt', b.id, Math.round(b.x), Math.round(b.y)]);
      }
    }
    for (const b of [...this.bolts]) {
      if ((b.t -= dt) > 0) continue;
      this.bolts.splice(this.bolts.indexOf(b), 1);
      const hit = [];
      for (const d of this.diggers) {
        if (Math.hypot(d.x - b.x, d.y - b.y) > BOLT_R || this.inMuseum(d.x, d.y, 10)) continue;
        hit.push(d.id);
        if (d.carry) { const h = d.carry; this.hitHeavy(h, { id: 0 }); if (this.heavies.includes(h)) this.hitHeavy(h, { id: 0 }); continue; }
        d.stun = 1.5; d.immune = 2;
        const dropped = this.takeBest(d); if (dropped) this.dropLoose(dropped, d.x, d.y, Math.random() * 7, d.id);
      }
      this.ev.push(['strike', b.id, Math.round(b.x), Math.round(b.y), hit.join(',')]);
    }
    if (ev.kind === 'tractor' || ev.kind === 'snowmobile') {
      const D = ev.data, x = D.x0 + D.dir * D.speed * ev.t, plough = ev.kind === 'tractor';
      for (const b of this.buried) { // ploughed up: nearly dug already
        if (!plough || b.ploughed || Math.abs(b.y - D.y) > 55 || (D.dir > 0 ? b.x > x : b.x < x) || b.ti === HEAVY) continue;
        b.ploughed = true;
        if (b.prog < TYPES[b.ti].taps - 1) { b.prog = TYPES[b.ti].taps - 1; this.ev.push(['prog', b.id, b.prog, 0]); }
      }
      if (plough && ev.t > 0.5 && ev.t < 0.6) for (let i = 0; i < 6; i++) { // and turns up a few more finds along the row
        this.spawnItem(false, null, [D.y - 40, D.y + 40]);
        const nb = this.buried[this.buried.length - 1]; if (nb && Math.abs(nb.y - D.y) <= 40) nb.ploughed = false;
      }
      for (const d of this.diggers) {
        if (d.runT > 0) { d.runT -= dt; continue; }
        if (Math.abs(d.x - x) > 46 || Math.abs(d.y - D.y) > 36) continue;
        d.runT = 2; d.stun = 1.2; d.immune = 2;
        d.y += d.y < D.y ? -70 : 70; this.fit(d);
        if (!d.isBot) this.ev.push(['pos', d.id, Math.round(d.x), Math.round(d.y)]);
        if (d.carry) this.unlift(d);
        const dropped = this.takeBest(d); if (dropped) this.dropLoose(dropped, d.x, d.y, D.y < d.y ? Math.PI / 2 : -Math.PI / 2, d.id);
        this.ev.push(['runover', d.id, dropped ? dropped.ti : -1, dropped ? dropped.name : '']);
      }
    }
    if (ev.kind === 'keeper' && this.keeper) { // plods after the nearest digger and confiscates their best find
      const K = this.keeper;
      for (const [id, c] of K.cool) if ((c - dt) <= 0) K.cool.delete(id); else K.cool.set(id, c - dt);
      let tg = null, bd = 650;
      for (const d of this.diggers) { if (d.npc || K.cool.has(d.id) || this.inMuseum(d.x, d.y, 20)) continue; const dd = Math.hypot(d.x - K.x, d.y - K.y); if (dd < bd) { bd = dd; tg = d; } }
      if (tg) {
        const a = Math.atan2(tg.y - K.y, tg.x - K.x); K.dir = a;
        K.x += Math.cos(a) * KEEPER_SPEED * dt; K.y += Math.sin(a) * KEEPER_SPEED * dt; this.fit(K);
        if (bd < 26) {
          K.cool.set(tg.id, 6); tg.stun = Math.max(tg.stun, 1);
          const taken = this.takeBest(tg);
          this.ev.push(['keeper', tg.id, taken ? taken.ti : -1, taken ? taken.name : '']);
        }
      }
    }
    if (ev.kind === 'icecream') for (const d of this.diggers) {
      if (ev.served.has(d.id) || Math.hypot(d.x - ev.data.x, d.y - ev.data.y) > 60) continue;
      ev.served.add(d.id); d.fx.w = 10; this.ev.push(['icecream', d.id]);
    }
    if (ev.kind === 'avalanche') { // after a 2.5s rumble, the snow comes down one side
      const D = ev.data, front = -120 + D.speed * Math.max(0, ev.t - 2.5), half = D.w / 2;
      if (front > -120) {
        for (const d of this.diggers) {
          if (ev.hit.has(d.id) || Math.abs(d.x - D.x) > half || d.y > front || d.y < front - 70 || this.inMuseum(d.x, d.y, 20)) continue;
          ev.hit.add(d.id); d.stun = 2; d.immune = 2;
          if (d.carry) { const h = d.carry; for (let i = 0; i < 3 && this.heavies.includes(h); i++) this.hitHeavy(h, { id: 0 }); }
          let lost = 0; for (let i = 0; i < 2; i++) { const it = this.takeBest(d); if (!it) break; lost++; this.dropLoose(it, d.x, Math.min(WORLD - 60, d.y + 90), Math.PI / 2, d.id); }
          this.ev.push(['buried', d.id, lost]);
        }
        const before = this.holes.length;
        this.holes = this.holes.filter(h => !(Math.abs(h.x - D.x) < half && h.y < front));
        if (this.holes.length !== before) this.ev.push(['hfill', D.x, D.w, Math.round(front)]);
      }
    }
    if (ev.kind === 'skiers') {
      for (const k of [...this.skiers]) {
        k.y += SKIER_SPEED * dt; k.x = k.x0 + Math.sin(k.y * 0.012 + k.ph) * 140;
        for (const [id, c] of k.hit) if (c - dt <= 0) k.hit.delete(id); else k.hit.set(id, c - dt);
        if (k.y > WORLD + 60) { this.skiers.splice(this.skiers.indexOf(k), 1); continue; }
        for (const d of this.diggers) {
          if (k.hit.has(d.id) || Math.hypot(d.x - k.x, d.y - k.y) > 28 || this.inMuseum(d.x, d.y, 20)) continue;
          k.hit.set(d.id, 3); d.stun = 1.2; d.immune = 2;
          d.x += (d.x < k.x ? -40 : 40); this.fit(d); if (!d.isBot) this.ev.push(['pos', d.id, Math.round(d.x), Math.round(d.y)]);
          const it = this.takeBest(d); if (it) this.dropLoose(it, d.x, d.y, Math.random() * 7, d.id);
          this.ev.push(['wipeout', d.id, it ? it.ti : -1, it ? it.name : '']);
        }
      }
    }
    if (ev.t >= ev.dur) this.endEvent();
  }
  // detecting club members: dig out their patch, never bank, leave when the coach does
  // a find buried somewhere inside the club's patch, better than usual
  clubBury(A) {
    for (let tries = 0; tries < 30; tries++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * A.r * .9, x = A.x + Math.cos(a) * r, y = A.y + Math.sin(a) * r;
      if (x < 60 || y < this.map.top || x > WORLD - 60 || y > WORLD - 60 || this.inMuseum(x, y, 60) || this.underwater(y, 30) || this.blocked(x, y) || this.inHole(x, y, 30)) continue;
      const ti = clubFind(), b = { id: this.uid++, x, y, ti, name: this.itemName(ti), prog: 0 };
      this.buried.push(b); this.ev.push(['spawn', b.id, Math.round(x), Math.round(y), ti, b.name, 0]); return;
    }
  }
  clubThink(b, dt) {
    const ai = b.ai, A = ai.area;
    // the patch keeps giving while the club is here
    if (this.event && this.event.kind === 'club' && (this.event.refill = (this.event.refill || 0) - dt / 4) <= 0) {
      this.event.refill = 1;
      if (this.buried.filter(it => !it.owner && Math.hypot(it.x - A.x, it.y - A.y) < A.r).length < 6) this.clubBury(A);
    }
    if (!ai.item || !this.buried.includes(ai.item) || this.underwater(ai.item.y, 4)) {
      ai.item = null; let bd = 1e9;
      for (const it of this.buried) {
        if (it.owner || it.ti === HEAVY || this.underwater(it.y, 10) || Math.hypot(it.x - A.x, it.y - A.y) > A.r) continue;
        if (this.diggers.some(o => o !== b && o.npc && o.ai.item === it)) continue;
        const dd = dist(it, b); if (dd < bd) { bd = dd; ai.item = it; }
      }
    }
    if (ai.item && dist(b, ai.item) < 30) {
      turnTo(b, Math.atan2(ai.item.y - b.y, ai.item.x - b.x), dt); b.moving = false;
      if ((ai.digT -= dt) <= 0) { ai.digT = 1 / ai.digRate; this.digAt(b, ai.item); }
      return;
    }
    let gx, gy;
    if (ai.item) { gx = ai.item.x; gy = ai.item.y; }
    else { if (!ai.wander || Math.hypot(ai.wander.x - b.x, ai.wander.y - b.y) < 30) { const a = Math.random() * 7, r = Math.random() * A.r; ai.wander = { x: A.x + Math.cos(a) * r, y: A.y + Math.sin(a) * r }; } gx = ai.wander.x; gy = ai.wander.y; }
    const ang = Math.atan2(gy - b.y, gx - b.x);
    this.moveDigger(b, Math.cos(ang), Math.sin(ang), dt, 140);
  }

  // ----- heavy finds: two people carry, the points are split -----
  lift(d, h) {
    if (d.carry || d.stun > 0 || !this.heavies.includes(h) || h.carriers.length >= 2 || dist(d, h) > 46) return;
    d.carry = h; h.carriers.push(d);
    if (d.ai) { d.ai.mode = 'haul'; d.ai.holdT = 0; }
    this.ev.push(['lift', h.id, d.id]);
  }
  unlift(d) {
    const h = d.carry; if (!h) return;
    d.carry = null; h.carriers = h.carriers.filter(c => c !== d);
    this.ev.push(['unlift', h.id, d.id]);
  }
  updateHeavies(dt) {
    for (const h of [...this.heavies]) {
      for (const c of [...h.carriers]) if (!this.diggers.includes(c) || c.stun > 0 || dist(c, h) > 95) this.unlift(c);
      // someone is holding one end: the nearest free bot comes to help (and takes half)
      if (h.carriers.length === 1 && !this.diggers.some(o => o.ai && !o.carry && o.ai.mode === 'help' && o.ai.heavy === h)) {
        let best = null, bd = 700;
        for (const o of this.diggers) {
          if (!o.ai || o.npc || o.carry || o.stun > 0 || o.ai.mode === 'rob' || (o.ai.mode === 'bank' && bagValue(o) >= 100)) continue;
          const dd = dist(o, h); if (dd < bd) { bd = dd; best = o; }
        }
        if (best) { best.ai.mode = 'help'; best.ai.heavy = h; }
      }
      // without two carriers it only waits so long before sinking back into the mud
      if (h.carriers.length < 2) {
        if ((h.wait -= dt) <= 0) {
          for (const c of [...h.carriers]) this.unlift(c);
          this.heavies.splice(this.heavies.indexOf(h), 1);
          this.ev.push(['hgone', h.id, h.name]);
          this.spawnItem(true, HEAVY);
          continue;
        }
      } else h.wait = this.heavyWait();
      if (h.carriers.length === 2) {
        const [a, b] = h.carriers, k = Math.min(1, dt * 10);
        h.x += ((a.x + b.x) / 2 - h.x) * k; h.y += ((a.y + b.y) / 2 - h.y) * k;
      }
      if (h.carriers.length === 2 && this.inMuseum(h.x, h.y)) {
        const share = Math.round(TYPES[HEAVY].v / h.carriers.length);
        for (const c of h.carriers) { c.banked += share; c.carry = null; }
        this.ev.push(['hbank', h.id, h.carriers.map(c => c.id).join(','), share, h.name]);
        this.heavies.splice(this.heavies.indexOf(h), 1);
        if (this.mode === 'escape') { this.coopPart(); continue; }
        this.spawnItem(true, HEAVY);
      }
    }
  }

  heavyWait() { return this.mode === 'escape' ? 30 : HEAVY_WAIT; }
  heavyInReach(a) {
    if (this.isCoop()) return null; // nobody smashes the engine parts
    for (const h of this.heavies) if (!h.carriers.includes(a) && dist(a, h) < 52) return h;
    return null;
  }
  hitHeavy(h, a) {
    h.hp--;
    this.ev.push(['hhit', h.id, a.id, h.hp]);
    if (h.hp > 0) return;
    // smashed: scatter scrap worth 20% of it, nobody banks the rest
    for (const c of [...h.carriers]) this.unlift(c);
    this.heavies.splice(this.heavies.indexOf(h), 1);
    this.ev.push(['hbreak', h.id, a.id, h.name]);
    for (let i = 0; i < SCRAP_PIECES; i++) this.dropLoose({ ti: SCRAP, name: pick(TYPES[SCRAP].names) }, h.x, h.y, i / SCRAP_PIECES * Math.PI * 2, null);
    this.spawnItem(true, HEAVY);
  }

  // ----- powerups -----
  // powerups: you can hold as many as your slots allow and pick which one is ready to use
  syncPower(d) { d.sel = Math.max(0, Math.min(d.sel || 0, d.held.length - 1)); d.power = d.held[d.sel] || null; }
  givePower(d, k, src) {
    if (k === 'p') d.padlock = true;
    else { if (d.held.length < (d.slots || 1)) { d.held.push(k); d.sel = d.held.length - 1; } else d.held[d.sel] = k; this.syncPower(d); }
    this.ev.push(['power', d.id, k, src]);
    // bots use most things straight away; they save area attacks until someone's close
    if (d.isBot && k !== 'p' && k !== 'q' && k !== 'k') this.usePower(d);
  }
  usePower(d) {
    const k = d.power; if (!k || d.stun > 0) return;
    d.held.splice(d.sel, 1); this.syncPower(d);
    if (k === 'd') this.plantDecoy(d);
    else if (k === 'l') d.lucky = 3;
    else if (k === 'b') this.plantTrap(d);
    else if (k === 'k') this.stinkBomb(d);
    else if (k === 'q') this.bigBonk(d);
    else d.fx[k] = POWERS[k].dur;
    if (k === 's') for (const m of this.magpies) if (m.target === d && m.state === 'hunt') { m.state = 'leave'; m.fleeA = Math.atan2(m.y - d.y, m.x - d.x); }
    this.ev.push(['use', d.id, k]);
  }
  plantDecoy(d) {
    let x = d.x, y = d.y;
    for (let k = 0; k < 10; k++) {
      const a = d.dir + Math.PI + (k % 2 ? 1 : -1) * k * 0.5, r = 34 + k * 4;
      const tx = clampW(d.x + Math.cos(a) * r), ty = clampW(d.y + Math.sin(a) * r);
      if (!this.inHole(tx, ty, 16) && !this.inMuseum(tx, ty, 30) && !this.blocked(tx, ty) && !this.buried.some(b => Math.hypot(b.x - tx, b.y - ty) < 30)) { x = tx; y = ty; break; }
    }
    const b = { id: this.uid++, x, y, ti: 3, name: pick(TYPES[3].names), prog: 0, decoy: true, owner: d.id };
    this.buried.push(b);
    this.ev.push(['spawn', b.id, Math.round(x), Math.round(y), 3, b.name, d.id]);
  }
  spotBehind(d, avoidBuried) {
    for (let k = 0; k < 10; k++) {
      const a = d.dir + Math.PI + (k % 2 ? 1 : -1) * k * 0.5, r = 30 + k * 4;
      const tx = clampW(d.x + Math.cos(a) * r), ty = clampW(d.y + Math.sin(a) * r);
      if (!this.inHole(tx, ty, 16) && !this.inMuseum(tx, ty, 30) && !this.blocked(tx, ty) && (!avoidBuried || !this.buried.some(b => Math.hypot(b.x - tx, b.y - ty) < 30))) return { x: tx, y: ty };
    }
    return { x: d.x, y: d.y };
  }
  plantTrap(d) {
    const p = this.spotBehind(d, false);
    const tr = { id: this.uid++, x: p.x, y: p.y, owner: d.id, age: 0 };
    this.traps.push(tr);
    this.ev.push(['trap', tr.id, Math.round(tr.x), Math.round(tr.y), d.id]);
  }
  slip(tr, v) {
    this.traps.splice(this.traps.indexOf(tr), 1);
    if (v.carry) { this.ev.push(['slip', tr.id, v.id, -1, '']); this.hitHeavy(v.carry, { id: tr.owner }); return; }
    v.stun = 1.5; v.immune = 3;
    const dropped = this.takeBest(v);
    this.ev.push(['slip', tr.id, v.id, dropped ? dropped.ti : -1, dropped ? dropped.name : '', tr.owner]);
    if (dropped) this.dropLoose(dropped, v.x, v.y, Math.random() * 7, v.id);
  }
  takeBest(v) {
    if (!v.bag.length) return null;
    let bi = 0; v.bag.forEach((b, i) => { if (TYPES[b.ti].v > TYPES[v.bag[bi].ti].v) bi = i; });
    return v.bag.splice(bi, 1)[0];
  }
  stinkBomb(d) {
    const hit = [];
    for (const z of this.zombies || []) if (dist(z, d) < STINK_R + 60) z.scared = 6; // zombies can't stand it
    for (const o of this.diggers) if (o !== d && dist(o, d) < STINK_R && !this.inMuseum(o.x, o.y, 10)) { o.fx.x = POWERS.k.dur; hit.push(o.id); }
    this.ev.push(['stink', d.id, Math.round(d.x), Math.round(d.y), hit.join(',')]);
  }
  bigBonk(d) {
    const hit = [];
    for (const o of [...this.diggers]) {
      if (this.isCoop()) break;
      if (o === d || dist(o, d) > SHOCK_R || this.inMuseum(o.x, o.y, 10)) continue;
      if (o.carry) { const h = o.carry; this.hitHeavy(h, d); if (this.heavies.includes(h)) this.hitHeavy(h, d); hit.push(o.id); continue; }
      if (o.immune > 0) continue;
      o.stun = 1; o.immune = 3;
      const ang = Math.atan2(o.y - d.y, o.x - d.x);
      o.x += Math.cos(ang) * 20; o.y += Math.sin(ang) * 20; this.fit(o);
      if (!o.isBot) this.ev.push(['pos', o.id, Math.round(o.x), Math.round(o.y)]);
      const dropped = this.takeBest(o);
      if (dropped) this.dropLoose(dropped, o.x, o.y, ang, o.id);
      hit.push(o.id);
    }
    for (const m of this.magpies) if (m.stun <= 0 && m.alt < 40 && dist(m, d) < SHOCK_R) this.hitMagpie(m, d);
    for (const z of [...(this.zombies || [])]) if (dist(z, d) < SHOCK_R + 20) this.hitZombie(z, d, 3, true);
    this.ev.push(['shock', d.id, Math.round(d.x), Math.round(d.y), hit.join(',')]);
  }
  buy(d, k) {
    const P = POWERS[k]; if (!P || !P.cost) return;
    if (!this.inMuseum(d.x, d.y, 24) || d.banked < P.cost || (k === 'p' && d.padlock)) return;
    d.banked -= P.cost;
    this.ev.push(['buy', d.id, k, P.cost]);
    this.givePower(d, k, 'shop');
  }
  spawnCrate() {
    for (let tries = 0; tries < 40; tries++) {
      const x = 140 + Math.random() * (WORLD - 280), y = Math.max(140, this.map.top) + Math.random() * (WORLD - 280 - Math.max(0, this.map.top - 140));
      if (this.inMuseum(x, y, 140) || this.inHole(x, y, 30) || this.underwater(y, 150) || this.blocked(x, y, 30)) continue;
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
      if (!this.inHole(lx, ly, 14) && !this.inMuseum(lx, ly, 10) && !this.blocked(lx, ly)) break;
    }
    ({ x: lx, y: ly } = this.fit({ x: lx, y: ly }));
    const l = { id: this.uid++, x: lx, y: ly, item, from: fromId, age: 0 };
    this.loose.push(l);
    this.ev.push(['loose', l.id, Math.round(lx), Math.round(ly), Math.round(x), Math.round(y), item.ti, item.name]);
  }
  bonkVictim(a) {
    if (this.inMuseum(a.x, a.y, 10)) return null;
    // Everyone else is drawn a fraction of a second behind where they really are (network + smoothing),
    // which mostly hurts chasing someone from behind: they've already moved on. So we also check where the
    // target was over the last BONK_REWIND seconds and take the closest. Reach and swing arc are unchanged.
    let best = null, bd = BONK_REACH;
    for (const o of this.diggers) {
      if (o === a || this.inMuseum(o.x, o.y, 10)) continue;
      for (const [, hx, hy] of [[0, o.x, o.y], ...(o.hist || [])]) {
        const dd = Math.hypot(hx - a.x, hy - a.y); if (dd > bd) continue;
        let da = Math.atan2(hy - a.y, hx - a.x) - a.dir; da = Math.atan2(Math.sin(da), Math.cos(da));
        if (Math.abs(da) < BONK_ARC || dd < 24) { bd = dd; best = o; }
      }
    }
    return best;
  }
  magpieInReach(a) {
    for (const m of this.magpies) if (m.stun <= 0 && m.alt < 30 && Math.hypot(m.x - a.x, m.y - a.y) < 48) return m;
    return null;
  }
  bonk(a) {
    if (a.bonkCd > 0 || a.stun > 0 || a.carry || a.tired > 0) return false;
    a.bonkCd = 0.6; a.swing = 0.25;
    if (this.isCoop()) { // co-op: bonks are for zombies only
      if (a.down) return false;
      const z = this.zombieInReach(a);
      if (z) { this.hitZombie(z, a, a.fx.h > 0 ? 2 : 1); return true; }
      this.ev.push(['whiff', a.id]); return false;
    }
    const mg = this.magpieInReach(a);
    if (mg) { this.hitMagpie(mg, a); return true; }
    const v = this.bonkVictim(a);
    // carriers can't be robbed: bonking them (or the find itself) damages the heavy find instead
    if (v && v.carry && !v.carry.carriers.includes(a)) { this.hitHeavy(v.carry, a); return true; }
    if (!v) { const h = this.heavyInReach(a); if (h) { this.hitHeavy(h, a); return true; } }
    if (!v) { this.ev.push(['whiff', a.id]); return false; }
    if (v.immune > 0) { this.ev.push(['blocked', a.id, v.id]); return true; }
    // a padlock is only used up when there's something in the bag to protect
    if (v.padlock && v.bag.length) { v.padlock = false; v.immune = 1.5; this.ev.push(['padlock', a.id, v.id]); return true; }
    v.stun = 1; v.immune = 3;
    const ang = Math.atan2(v.y - a.y, v.x - a.x);
    v.x += Math.cos(ang) * 14; v.y += Math.sin(ang) * 14; this.fit(v);
    if (!v.isBot) this.ev.push(['pos', v.id, Math.round(v.x), Math.round(v.y)]);
    const dropped = this.takeBest(v);
    if (dropped && a.fx.g > 0) { // sticky glove: straight into the bonker's bag
      delete a.fx.g; a.bag.push(dropped);
      this.ev.push(['bonk', a.id, v.id, dropped.ti, dropped.name, 1]);
      return true;
    }
    this.ev.push(['bonk', a.id, v.id, dropped ? dropped.ti : -1, dropped ? dropped.name : '']);
    if (dropped && v.isBot && !v.npc && !v.dummy && Math.random() < .3) this.ev.push(['say', v.id, pick([SAY.angry, SAY.shock, SAY.oi])]);
    else if (dropped && a.isBot && !a.npc && Math.random() < .2) this.ev.push(['say', a.id, pick([SAY.gotcha, SAY.laugh])]);
    if (dropped) this.dropLoose(dropped, v.x, v.y, ang, v.id);
    else if (++a.grief >= TIRED_AFTER) { a.grief = 0; a.tired = TIRED_SECS; this.ev.push(['tired', a.id, TIRED_SECS]); }
    else a.griefT = 15;
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
  spawnBirdAt(tg, any) {
    const a = Math.random() * Math.PI * 2;
    const m = { id: this.uid++, x: tg.x + Math.cos(a) * 520, y: tg.y + Math.sin(a) * 520, alt: 60, target: tg, item: null, any,
      state: 'hunt', t: 0, ts: 0, dir: a + Math.PI, stun: 0, fleeA: 0, rolled: new Set() };
    this.magpies.push(m);
    this.ev.push(['mspawn', m.id, tg.id]);
  }
  spawnMagpie() {
    const carriers = this.diggers.filter(d => shiny(d) && !(d.fx.s > 0) && !this.inMuseum(d.x, d.y, 30) && !this.magpies.some(m => m.target === d));
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
      const ghost = m.kind === 'ghost', dog = m.kind === 'dog' || ghost; // ghosts hunt like dogs, just slower and floating
      let gx = m.x, gy = m.y, sp = 0;
      if (m.state === 'hunt') {
        const tg = m.target;
        const lost = !this.diggers.includes(tg) || !(m.any ? true : shiny(tg)) || tg.fx.s > 0 || this.inMuseum(tg.x, tg.y, 20);
        if (dog && lost && m.t < 16) { // a dog just picks someone else
          const nt = this.diggers.filter(d => !this.inMuseum(d.x, d.y, 20) && !(d.fx.s > 0)).sort((x, y) => (bagValue(y) - Math.hypot(y.x - m.x, y.y - m.y) / 10) - (bagValue(x) - Math.hypot(x.x - m.x, x.y - m.y) / 10))[0];
          if (nt) m.target = nt;
          continue; // nobody out in the open yet: wait for someone
        }
        if (lost || m.t > (dog ? 16 : 14)) { m.state = 'leave'; m.fleeA = Math.atan2(m.y - tg.y, m.x - tg.x); }
        else {
          gx = tg.x; gy = tg.y; sp = ghost ? 135 : dog ? 205 : 175;
          const dd = Math.hypot(gx - m.x, gy - m.y); m.alt = ghost ? 8 : dog ? 0 : Math.min(60, dd * 0.3);
          if (dd < 16) {
            let bi = -1; tg.bag.forEach((b, i) => { if ((m.any || TYPES[b.ti].v >= 40) && (bi < 0 || TYPES[b.ti].v > TYPES[tg.bag[bi].ti].v)) bi = i; });
            if (bi < 0) {
              tg.stun = Math.max(tg.stun, 0.5); this.ev.push(['peck', m.id, tg.id, ghost ? 2 : dog ? 1 : 0]);
              if (dog) { const nt = this.diggers.filter(d => d !== tg && d.bag.length && !this.inMuseum(d.x, d.y, 20))[0]; if (nt) { m.target = nt; continue; } }
              m.state = 'leave'; m.fleeA = Math.random() * 7; continue;
            }
            m.item = tg.bag.splice(bi, 1)[0]; m.state = 'flee'; m.ts = 0;
            m.fleeA = Math.atan2(m.y - tg.y, m.x - tg.x) + (Math.random() - 0.5);
            this.ev.push(['steal', m.id, tg.id, m.item.ti, m.item.name, ghost ? 2 : dog ? 1 : 0]);
          }
        }
      }
      if (m.state === 'flee' || m.state === 'leave') {
        m.ts += dt;
        gx = m.x + Math.cos(m.fleeA) * 100; gy = m.y + Math.sin(m.fleeA) * 100;
        sp = ghost ? 150 : dog ? 215 : m.state === 'flee' ? (m.ts < 1.3 ? 100 : 185) : 200;
        if (!dog) m.alt = Math.min(60, m.alt + dt * (m.state === 'flee' ? 22 : 60));
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
    const speed = base * (1 - Math.min(0.45, d.bag.length * 0.05)) * (d.fx.w > 0 ? 1.3 : 1) * (d.carry ? (d.carry.carriers.length === 2 ? 0.7 : 0) : 1) * (this.underwater(d.y) ? 0.5 : 1);
    if (this.map.slippery) { // snow: you build up speed and slide to a stop; ice is worse
      const k = Math.min(1, dt * (this.onIce(d) ? 1.1 : 3.2));
      d.vx = (d.vx || 0) + (mx * speed - (d.vx || 0)) * k; d.vy = (d.vy || 0) + (my * speed - (d.vy || 0)) * k;
      d.x += d.vx * dt; d.y += d.vy * dt;
    } else { d.x += mx * speed * dt; d.y += my * speed * dt; }
    if (!(d.fx.w > 0)) for (let pass = 0; pass < 2; pass++) for (const h of this.holes) pushOut(d, h.x, h.y, h.r + 11);
    this.fit(d);
    turnTo(d, Math.atan2(my, mx), dt);
  }
  botThink(b, dt) {
    const ai = b.ai;
    ai.robCd -= dt; ai.think -= dt;
    if (b.stun > 0) { if (ai.mode === 'dig' || ai.mode === 'help') ai.mode = 'hunt'; b.moving = false; return; }
    if (b.npc) return this.clubThink(b, dt);
    if (b.power === 'q' && this.diggers.some(o => o !== b && dist(o, b) < SHOCK_R - 15 && (o.bag.length || o.carry))) this.usePower(b);
    if (b.power === 'k' && this.diggers.filter(o => o !== b && dist(o, b) < STINK_R).length >= 2) this.usePower(b);
    if (b.carry) { // hauling a heavy find: head for the Museum, give up if nobody helps
      const h = b.carry;
      ai.holdT = (ai.holdT || 0) + dt;
      if (h.carriers.length < 2 && ai.holdT > 15) { this.unlift(b); ai.mode = 'hunt'; ai.heavyCd = 15; return; }
      if (!this.heavies.includes(h)) { b.carry = null; ai.mode = 'hunt'; return; }
      if (h.carriers.length === 2) ai.holdT = 0;
      const ang = Math.atan2(this.M.y - b.y, this.M.x - b.x);
      this.moveDigger(b, Math.cos(ang), Math.sin(ang), dt, 150);
      return;
    }
    ai.heavyCd = Math.max(0, (ai.heavyCd || 0) - dt);
    if (ai.mode === 'haul') ai.mode = 'hunt'; // put down (bonked, banked or let go)
    const mg = this.magpieInReach(b);
    if (mg && b.bonkCd <= 0 && !mg.rolled.has(b)) { mg.rolled.add(b); if (Math.random() < 0.3 + ai.aggro * 0.3) { b.dir = Math.atan2(mg.y - b.y, mg.x - b.x); this.bonk(b); } }
    const bv = bagValue(b);
    if (ai.mode !== 'rob' && ai.mode !== 'bank' && (bv >= ai.bankAt || b.bag.length >= 5)) ai.mode = 'bank';
    if (ai.think <= 0) {
      ai.think = 0.35 + Math.random() * 0.4;
      if (ai.mode !== 'rob' && ai.mode !== 'bank' && ai.robCd <= 0 && bv < 60) {
        let best = null, bd = 220;
        for (const o of this.diggers) { if (o === b || (o.immune > 0 && !o.carry) || (bagValue(o) < 20 && !o.carry) || this.inMuseum(o.x, o.y, 20)) continue; const dd = dist(o, b); if (dd < bd) { bd = dd; best = o; } }
        if (best && Math.random() < ai.aggro) { ai.mode = 'rob'; ai.victim = best; ai.chase = 3 + Math.random() * 2; }
        else ai.robCd = 1.5;
      }
      if (ai.mode === 'hunt' || ai.mode === 'dig' || ai.mode === 'bank') {
        let best = null, bd = ai.mode === 'bank' ? 80 : 160;
        for (const l of this.loose) { if (l.from === b.id && l.age < OWN_DROP_LOCK) continue; const dd = dist(l, b); if (dd < bd) { bd = dd; best = l; } }
        if (best && (ai.mode !== 'dig' || TYPES[best.item.ti].v > 10)) { ai.mode = 'grab'; ai.loot = best; }
      }
      if (ai.mode === 'hunt' && this.crates.length && dist(this.crates[0], b) < 500) { ai.mode = 'crate'; ai.crate = this.crates[0]; }
      if (ai.mode === 'hunt' && !ai.heavyCd) for (const h of this.heavies) {
        if (h.carriers.length >= 2 || dist(h, b) > 450) continue;
        if (this.diggers.some(o => o !== b && o.ai && !o.carry && o.ai.mode === 'help' && o.ai.heavy === h)) continue;
        if (h.carriers.length === 1 || Math.random() < 0.2) { ai.mode = 'help'; ai.heavy = h; ai.holdT = 0; break; }
      }
    }
    let gx = null, gy = null;
    if (ai.mode === 'bank') {
      if (!b.bag.length) { ai.mode = 'hunt'; ai.bankAt = 40 + Math.random() * 110; }
      else { gx = this.M.x; gy = this.M.y; }
    }
    if (ai.mode === 'rob') {
      const v = ai.victim; ai.chase -= dt;
      if (ai.chase <= 0 || !v || !this.diggers.includes(v) || (!v.carry && (v.immune > 0 || !v.bag.length)) || this.inMuseum(v.x, v.y, 10)) { ai.mode = 'hunt'; ai.robCd = 5 + Math.random() * 5; }
      else {
        gx = v.x; gy = v.y;
        if (dist(b, v) < 36) { b.dir = Math.atan2(v.y - b.y, v.x - b.x); const smashing = !!v.carry; if (this.bonk(b) && !smashing) { ai.mode = 'hunt'; ai.robCd = 6 + Math.random() * 5; } }
      }
    }
    if (ai.mode === 'help') {
      const h = ai.heavy;
      if (!this.heavies.includes(h) || h.carriers.length >= 2) ai.mode = 'hunt';
      else { gx = h.x; gy = h.y; if (dist(b, h) < 40) { this.lift(b, h); return; } }
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
      if (!ai.item || !this.buried.includes(ai.item) || this.underwater(ai.item.y, 20)) {
        // bots only "hear" treasure within their detector range, like players
        const sense = b.fx.x > 0 ? 0 : BOT_SENSE * (b.fx.c > 0 ? 2 : 1) * (this.event && this.event.kind === 'fog' ? 0.5 : 1);
        ai.item = null; let bd = sense;
        for (const it of this.buried) {
          if (it.owner === b.id || this.underwater(it.y, 20)) continue;
          const d0 = dist(it, b); if (d0 > sense) continue;
          if (this.diggers.some(o => o !== b && o.ai && o.ai.item === it)) continue;
          const dd = d0 + Math.random() * 80;
          if (dd < bd) { bd = dd; ai.item = it; }
        }
      }
      if (ai.item) { ai.wander = null; gx = ai.item.x; gy = ai.item.y; if (dist(b, ai.item) < 30) { ai.mode = 'dig'; ai.digT = 0.5; } }
      else {
        // nothing in range: wander the field until something beeps
        if (!ai.wander || Math.hypot(ai.wander.x - b.x, ai.wander.y - b.y) < 40 || this.underwater(ai.wander.y, 60)) {
          let wx, wy, n = 0;
          const wTop = Math.max(120, this.map.top), wBot = Math.min(WORLD - 120, this.sea - 90);
          do { wx = 120 + Math.random() * (WORLD - 240); wy = wTop + Math.random() * Math.max(10, wBot - wTop); } while ((this.inMuseum(wx, wy, 120) || this.blocked(wx, wy, 30)) && ++n < 30);
          ai.wander = { x: wx, y: wy };
        }
        gx = ai.wander.x; gy = ai.wander.y;
      }
    }
    if (ai.mode === 'dig') {
      if (!ai.item || !this.buried.includes(ai.item) || this.underwater(ai.item.y, 4)) ai.mode = 'hunt';
      else {
        turnTo(b, Math.atan2(ai.item.y - b.y, ai.item.x - b.x), dt);
        if (dist(b, ai.item) > 40) ai.mode = 'hunt';
        else if ((ai.digT -= dt) <= 0) { ai.digT = 1 / ai.digRate; this.digAt(b, ai.item); }
        b.moving = false; return;
      }
    }
    if (gx === null) { b.moving = false; return; }
    if (this.underwater(b.y, 15) && !b.carry) { gx = b.x; gy = this.sea - 120; } // get out of the sea
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
      this.fit(d);
    } else if (msg.t === 'dig') {
      const now = Date.now(); if (now - d.lastDig < 70) return; d.lastDig = now;
      const tg = this.findTarget(d, typeof msg.id === 'number' ? msg.id : null); if (tg) { d.dir = Math.atan2(tg.y - d.y, tg.x - d.x); this.digAt(d, tg); }
    } else if (msg.t === 'say') { // quick chat: an index into the client's list of phrases and emotes
      const k = msg.k | 0, now = Date.now();
      if (k >= 0 && k < SAY_COUNT && now - (d.sayAt || 0) > 1200) { d.sayAt = now; this.ev.push(['say', d.id, k]); }
    } else if (msg.t === 'bonk') {
      this.bonk(d);
    } else if (msg.t === 'lift') {
      const h = this.heavies.find(x => x.id === msg.id); if (h) this.lift(d, h);
    } else if (msg.t === 'drop') {
      this.unlift(d);
    } else if (msg.t === 'sel') { if (d.held.length > 1) { d.sel = (msg.i | 0) % d.held.length; this.syncPower(d); }
    } else if (msg.t === 'use') {
      this.usePower(d);
    } else if (msg.t === 'buy') {
      if (typeof msg.k === 'string') this.buy(d, msg.k);
    }
  }

  // ----- tick -----
  tick(dt) {
    // Quick Play rooms start on their own: 10s after the first player arrives, 15s after a round ends
    if (this.public && this.state !== 'play' && this.clients.size){
      const before = this.autoT == null ? null : Math.ceil(this.autoT);
      if (this.autoT == null) this.autoT = this.state === 'end' ? 15 : 10;
      this.autoT -= dt;
      if (this.autoT <= 0){ this.autoT = null; this.mapId = pick(openMaps().filter(m => m !== 'haunted')); this.theme = seasonOn('halloween') && Math.random() < .5 ? 'halloween' : ''; this.start(); return; }
      if (Math.ceil(this.autoT) !== before) this.lobbyMsg();
    }
    if (this.state !== 'play') return;
    this.t += dt; this.timeLeft -= dt;
    if (this.timeLeft <= 0) { this.timeLeft = 0; this.flush(); if (this.isCoop()) this.coopEnd(this.mode !== 'escape'); else this.end(); return; }
    if (this.isCoop()) { this.coopTick(dt); if (this.state !== 'play') return; } else this.updateMagpies(dt);
    this.updateTide(dt);
    this.updateEvent(dt);
    if ((this.crateT -= dt) <= 0) { this.crateT = CRATE_EVERY; if (!this.crates.length) this.spawnCrate(); }
    for (const d of this.diggers) {
      for (const k in d.fx) if ((d.fx[k] -= dt) <= 0) delete d.fx[k];
      d.tired = Math.max(0, d.tired - dt);
      if (d.griefT > 0 && (d.griefT -= dt) <= 0) d.grief = 0;
      d.stun = Math.max(0, d.stun - dt); d.immune = Math.max(0, d.immune - dt);
      d.bonkCd = Math.max(0, d.bonkCd - dt); d.swing = Math.max(0, d.swing - dt);
      // where everyone was over the last moment, so a bonk can be judged against what the bonker saw
      (d.hist || (d.hist = [])).push([this.t, d.x, d.y]); while (d.hist.length && d.hist[0][0] < this.t - BONK_REWIND) d.hist.shift();
      if (d.dummy){ if (!d.bag.length && (d.rearm = (d.rearm || 4) - dt) <= 0){ d.rearm = 0; d.bag.push({ ti: 1, name: 'Brass button' }); } }
      else if (d.isBot) { if (this.isCoop()) this.coopBot(d, dt); else this.botThink(d, dt); }
      if (d.bag.length && this.inMuseum(d.x, d.y)) {
        const v = bagValue(d); d.banked += v; d.bag = [];
        this.ev.push(['bank', d.id, v]);
        if (d.isBot && !d.padlock && d.banked >= 200 && Math.random() < 0.3) this.buy(d, 'p');
      }
      if (d.stun <= 0) for (let i = this.crates.length - 1; i >= 0; i--) {
        const c = this.crates[i];
        if (Math.hypot(c.x - d.x, c.y - d.y) < 28) { this.crates.splice(i, 1); this.ev.push(['crategot', c.id, d.id]); this.givePower(d, pick(this.isCoop() ? COOP_POWERS : ALL_POWERS), 'crate'); }
      }
      if (d.stun <= 0) for (let i = this.loose.length - 1; i >= 0; i--) {
        const l = this.loose[i];
        if (l.age < 0.35 || (l.from === d.id && l.age < OWN_DROP_LOCK)) continue;
        if (Math.hypot(l.x - d.x, l.y - d.y) < (d.fx.m > 0 ? MAGNET_R : 24)) { this.loose.splice(i, 1); d.bag.push(l.item); this.ev.push(['pick', l.id, d.id, d.fx.m > 0 ? 1 : 0]); }
      }
    }
    for (const l of this.loose) l.age += dt;
    for (const tr of [...this.traps]) {
      if ((tr.age += dt) > TRAP_LIFE) { this.traps.splice(this.traps.indexOf(tr), 1); this.ev.push(['trapgone', tr.id]); continue; }
      if (tr.age < 0.6) continue;
      const v = this.diggers.find(o => o.id !== tr.owner && o.stun <= 0 && Math.hypot(o.x - tr.x, o.y - tr.y) < 16);
      if (v) this.slip(tr, v);
    }
    this.updateHeavies(dt);
    this.flush();
  }
  // ===================== co-op zombie modes =====================
  coopStart() {
    this.zombies = []; this.wave = 0; this.toSpawn = []; this.spawnT = 0; this.breakT = 8; this.kills = 0; this.parts = 0; this.zt = 0;
    this.evPlan = []; this.magpieT = 1e9; this.crateT = 25;
    this.timeLeft = this.mode === 'escape' ? COOP.escape.time : 99999;
    for (const d of this.diggers) { d.hp = MAX_HP; d.down = false; d.revive = 0; }
    for (let i = 0; i < 45; i++) this.spawnItem(false);
    if (this.mode === 'escape') for (let i = 0; i < 3; i++) this.spawnItem(false, HEAVY);
  }
  coopInfo() {
    if (!this.isCoop()) return null;
    const left = (this.toSpawn ? this.toSpawn.length : 0) + (this.zombies ? this.zombies.length : 0);
    return [this.wave || 0, left, this.breakT > 0 && !left ? Math.ceil(this.breakT) : 0, this.parts || 0, COOP.escape.parts, this.kills || 0];
  }
  team() { return this.diggers.filter(d => !d.npc); }
  startWave() {
    const n = ++this.wave, humans = this.team().filter(d => !d.isBot).length;
    const count = 5 + n * 3 + humans * 2, q = [];
    for (let i = 0; i < count; i++) q.push(n >= 2 && Math.random() < Math.min(.4, .12 * n) ? 'runner' : 'walker');
    for (let i = 0; i < (n >= 3 ? 1 + Math.floor(n / 3) : 0); i++) q.splice(Math.floor(Math.random() * q.length), 0, 'brute');
    this.toSpawn = q; this.spawnT = 0;
    this.ev.push(['wave', n, count + (q.length - count)]);
  }
  spawnZombie(kind) {
    const C = this.map.circle;
    for (let tries = 0; tries < 30; tries++) {
      let x, y; const side = Math.random() * 4 | 0, k = Math.random();
      if (C) { const a = Math.random() * Math.PI * 2; x = C.x + Math.cos(a) * (C.r - 110); y = C.y + Math.sin(a) * (C.r - 110); }
      else { x = side === 0 ? 70 : side === 1 ? WORLD - 70 : 70 + k * (WORLD - 140); y = side === 2 ? Math.max(this.map.top + 30, 70) : side === 3 ? Math.min(WORLD - 70, this.sea - 60) : Math.max(this.map.top + 30, 70) + k * (Math.min(WORLD - 70, this.sea - 60) - Math.max(this.map.top + 30, 70)); }
      if (this.blocked(x, y, 10) || this.team().some(d => Math.hypot(d.x - x, d.y - y) < 300)) continue;
      const Z = ZOMBIE[kind], hp = Z.hp + (this.wave >= 6 ? 1 : 0);
      this.zombies.push({ id: this.uid++, kind, x, y, hp, max: hp, dir: 0, hitCd: 1, stun: 0, scared: 0, groan: Math.random() * 5 });
      return true;
    }
    return false;
  }
  zombieInReach(a) {
    let best = null, bd = BONK_REACH + 8;
    for (const z of this.zombies) {
      const dd = dist(a, z) - ZOMBIE[z.kind].r * .5; if (dd > bd) continue;
      let da = Math.atan2(z.y - a.y, z.x - a.x) - a.dir; da = Math.atan2(Math.sin(da), Math.cos(da));
      if (Math.abs(da) < BONK_ARC + .2 || dd < 26) { bd = dd; best = z; }
    }
    return best;
  }
  hitZombie(z, a, dmg, blast) {
    if (!this.zombies.includes(z)) return;
    z.hp -= dmg; z.stun = blast ? .9 : .45;
    const ang = Math.atan2(z.y - a.y, z.x - a.x), kb = z.kind === 'brute' ? 8 : 26;
    z.x += Math.cos(ang) * kb; z.y += Math.sin(ang) * kb; this.fit(z);
    if (z.hp > 0) { this.ev.push(['zhurt', z.id, a.id]); return; }
    this.zombies.splice(this.zombies.indexOf(z), 1); this.kills++;
    a.banked += z.kind === 'brute' ? 50 : 10;
    this.ev.push(['zdie', z.id, a.id, Math.round(z.x), Math.round(z.y), ZOMBIE[z.kind].code]);
    this.stat(a.id, 'zkills');
    if (Math.random() < (z.kind === 'brute' ? 1 : .12)) { // sometimes they drop something useful
      const ti = z.kind === 'brute' ? 2 : 1, b = { id: this.uid++, x: z.x, y: z.y, ti, name: this.itemName(ti), prog: TYPES[ti].taps - 1 };
      if (!this.blocked(b.x, b.y)) { this.buried.push(b); this.ev.push(['spawn', b.id, Math.round(b.x), Math.round(b.y), ti, b.name, 0]); }
    }
  }
  coopSupply(d, item) {
    if (COOP_HEAL[item.ti] != null) {
      const before = d.hp; d.hp = Math.min(MAX_HP, d.hp + COOP_HEAL[item.ti]); d.banked += 5;
      this.ev.push(['supply', d.id, 'heal', Math.round(d.hp - before), item.name]);
    } else { d.banked += 10; this.givePower(d, pick(COOP_POWERS), 'box'); }
  }
  coopPart() {
    this.parts++;
    this.ev.push(['part', this.parts, COOP.escape.parts]);
    if (this.parts >= COOP.escape.parts) { for (const d of this.team()) d.banked += 200; this.flush(); this.coopEnd(true); return; }
    this.spawnItem(true, HEAVY);
  }
  knockDown(d) {
    if (d.down) return;
    d.down = true; d.hp = 0; d.revive = 0; d.stun = 1;
    if (d.carry) this.unlift(d);
    this.ev.push(['down', d.id]);
  }
  coopTick(dt) {
    this.zt += dt;
    // ----- waves (Survive and Endless) or a steady stream (Escape) -----
    if (this.mode === 'escape') {
      if ((this.spawnT -= dt) <= 0) { this.spawnT = Math.max(1.4, 4.5 - this.zt / 50); if (this.zombies.length < 40) this.spawnZombie(this.zt > 60 && Math.random() < .3 ? 'runner' : 'walker'); }
      if ((this.bruteT = (this.bruteT ?? 50) - dt) <= 0) { this.bruteT = 45; this.spawnZombie('brute'); }
    } else {
      if (this.toSpawn.length) { if ((this.spawnT -= dt) <= 0) { this.spawnT = .7; if (this.spawnZombie(this.toSpawn[0])) this.toSpawn.shift(); } }
      else if (!this.zombies.length) {
        if (this.wave > 0 && !this.waveDone) { // wave cleared
          this.waveDone = true; this.breakT = 12;
          for (const d of this.team()) d.banked += 100;
          if (this.mode === 'endless') for (const d of this.team()) this.stat(d.id, 'zwaveBest', this.wave, 'max');
          this.ev.push(['wavedone', this.wave]);
          if (this.mode === 'survive' && this.wave >= COOP.survive.waves) { this.flush(); this.coopEnd(true); return; }
          for (const d of this.team()) if (d.down) { d.down = false; d.hp = 40; d.stun = 0; this.ev.push(['revived', d.id, 0]); } else d.hp = Math.min(MAX_HP, d.hp + 25); // a breather patches everyone up
          for (let i = 0; i < 8; i++) this.spawnItem(false);
        }
        if ((this.breakT -= dt) <= 0) { this.waveDone = false; this.startWave(); }
      }
    }
    // ----- zombies shamble after the nearest person who's still up -----
    const speedUp = 1 + Math.min(.6, (this.mode === 'escape' ? this.zt / 240 : this.wave * .05));
    for (const z of this.zombies) {
      const Z = ZOMBIE[z.kind];
      z.hitCd -= dt; if ((z.groan -= dt) <= 0) { z.groan = 4 + Math.random() * 6; this.ev.push(['groan', z.id]); }
      if (z.stun > 0) { z.stun -= dt; continue; }
      let tg = null, bd = 1e9;
      for (const d of this.diggers) { if (d.down || d.npc) continue; const dd = dist(d, z); if (dd < bd) { bd = dd; tg = d; } }
      if (!tg) continue;
      let ang = Math.atan2(tg.y - z.y, tg.x - z.x);
      if (z.scared > 0) { z.scared -= dt; ang += Math.PI; }
      const sp = Z.speed * speedUp * (z.scared > 0 ? 1.4 : 1);
      z.x += Math.cos(ang) * sp * dt; z.y += Math.sin(ang) * sp * dt;
      let da = ang - z.dir; da = Math.atan2(Math.sin(da), Math.cos(da)); z.dir += da * Math.min(1, dt * 6);
      for (const o of this.zombies) if (o !== z) { const dd = dist(o, z), min = (Z.r + ZOMBIE[o.kind].r) * .8; if (dd < min && dd > 0.01) { z.x += (z.x - o.x) / dd * (min - dd) * .5; z.y += (z.y - o.y) / dd * (min - dd) * .5; } }
      this.fit(z);
      if (bd < Z.r + 13 && z.hitCd <= 0 && z.scared <= 0) { // bite
        z.hitCd = 1; tg.hp -= Z.dmg;
        const ka = Math.atan2(tg.y - z.y, tg.x - z.x); tg.x += Math.cos(ka) * 12; tg.y += Math.sin(ka) * 12; this.fit(tg);
        if (!tg.isBot) this.ev.push(['pos', tg.id, Math.round(tg.x), Math.round(tg.y)]);
        this.ev.push(['zhit', z.id, tg.id, Math.max(0, Math.ceil(tg.hp))]);
        if (tg.hp <= 0) this.knockDown(tg);
      }
    }
    // ----- the downed wait for a teammate to stand over them; the Museum patches people up -----
    for (const d of this.diggers) {
      if (d.npc) continue;
      if (d.down) {
        d.stun = .5;
        const helpers = this.diggers.filter(o => o !== d && !o.down && !o.npc && dist(o, d) < 40).length;
        d.revive = helpers ? d.revive + dt * helpers : Math.max(0, d.revive - dt * .5);
        if (d.revive >= REVIVE_TIME) { d.down = false; d.hp = 40; d.revive = 0; d.stun = 0; this.ev.push(['revived', d.id, 1]); for (const o of this.diggers) if (o !== d && !o.down && dist(o, d) < 40) { o.banked += 25; this.stat(o.id, 'revives'); } }
      } else if (this.inMuseum(d.x, d.y, 10) && d.hp < MAX_HP) d.hp = Math.min(MAX_HP, d.hp + dt * 4);
    }
    if (this.team().every(d => d.down)) { this.flush(); this.coopEnd(false); }
  }
  // a simple team-mate: revive people, fight what's close, otherwise dig for supplies or carry parts
  coopBot(b, dt) {
    const ai = b.ai; if (b.down) { b.moving = false; return; }
    if (b.stun > 0) { b.moving = false; return; }
    const go = (x, y, sp = 150) => { const a = Math.atan2(y - b.y, x - b.x); this.moveDigger(b, Math.cos(a), Math.sin(a), dt, sp); };
    if (b.power && (b.power !== 'q' || this.zombies.filter(z => dist(z, b) < SHOCK_R).length >= 3)) this.usePower(b);
    // carrying an engine part to the bus
    if (b.carry) { const h = b.carry; if (!this.heavies.includes(h)) { b.carry = null; return; } if (h.carriers.length < 2) { if ((ai.holdT = (ai.holdT || 0) + dt) > 12) { this.unlift(b); ai.holdT = 0; } b.moving = false; return; } ai.holdT = 0; return go(this.M.x, this.M.y, 170); }
    let near = null, nd = 1e9; for (const z of this.zombies) { const dd = dist(z, b); if (dd < nd) { nd = dd; near = z; } }
    const downed = this.team().filter(d => d.down && d !== b).sort((p, q) => dist(p, b) - dist(q, b))[0];
    if (downed && dist(downed, b) < 600 && nd > 40) { if (dist(downed, b) > 20) go(downed.x, downed.y, 170); else b.moving = false; return; }
    if (near && nd < (b.hp < 35 ? 90 : 240)) { b.dir = Math.atan2(near.y - b.y, near.x - b.x); if (nd > 34) go(near.x, near.y, 160); else { b.moving = false; this.bonk(b); } return; }
    if (b.hp < 35 && !this.inMuseum(b.x, b.y)) return go(this.M.x, this.M.y, 170);
    if (this.mode === 'escape') { // help carry parts
      const h = this.heavies.find(x => x.carriers.length < 2 && !x.carriers.includes(b) && dist(x, b) < 900);
      if (h) { if (dist(h, b) > 50) return go(h.x, h.y, 165); this.lift(b, h); return; }
    }
    if (!ai.target || !this.buried.includes(ai.target)) { let best = null, bdd = 1e9; for (const it of this.buried) { const dd = dist(it, b) * (it.ti === HEAVY && this.mode !== 'escape' ? 9 : 1); if (dd < bdd) { bdd = dd; best = it; } } ai.target = best; }
    const it = ai.target; if (!it) { b.moving = false; return; }
    if (dist(it, b) > 26) return go(it.x, it.y, 140);
    b.moving = false; if ((ai.digT = (ai.digT || 0) - dt) <= 0) { ai.digT = .45; this.digAt(b, it); }
  }
  coopEnd(won) {
    if (this.state !== 'play') return;
    if (won && this.mode === 'survive') for (const d of this.team()) this.stat(d.id, 'survived');
    if (won && this.mode === 'escape') for (const d of this.team()) this.stat(d.id, 'escaped');
    this.coopResult = { mode: this.mode, won: !!won, wave: this.wave, kills: this.kills, parts: this.parts };
    this.end();
  }

  // ----- achievements: count things signed-in players do, and tell them the moment one unlocks -----
  clientOf(id) { for (const [ws, c] of this.clients) if (c.id === id) return [ws, c]; return [null, null]; }
  stat(id, key, n = 1, mode) {
    if (id == null || id >= 1000) return; // bots and the detecting club don't have accounts
    const [ws, c] = this.clientOf(id); if (!c || !c.acct) return;
    const got = accounts.track(c.acct, key, n, mode) || [], daily = got.daily || [];
    if (got.length || daily.length) this.send(ws, { t: 'profile', profile: accounts.profile(c.acct), ach: got.map(a => a.id), daily: daily.map(x => x.id) });
  }
  // most stats come straight off the events the clients already get
  statsFromEvents(evs) {
    const ids = s => String(s || '').split(',').filter(Boolean).map(Number);
    for (const e of evs) switch (e[0]) {
      case 'bank': this.stat(e[1], 'banked', e[2]); if (this.timeLeft <= 5) this.stat(e[1], 'clutch'); if (this.spooky()) this.stat(e[1], 'hauntedBank', e[2]); break;
      case 'hbank': for (const id of ids(e[2])) this.stat(id, 'heavies'); break;
      case 'bonk': if (e[3] >= 0) { this.stat(e[1], 'robs'); if (e[5]) this.stat(e[1], 'gloves'); } break;
      case 'shock': this.stat(e[1], 'shockMax', ids(e[4]).length, 'max'); break;
      case 'slip': if (e[5] != null && e[5] !== e[2]) this.stat(e[5], 'slips'); break;
      case 'hbreak': this.stat(e[2], 'smashes'); break;
      case 'mhit': { const m = this.magpies.find(x => x.id === e[1]); this.stat(e[2], m && m.kind === 'dog' ? 'dogs' : m && m.kind === 'ghost' ? 'ghosts' : 'birds'); break; }
      case 'strike': for (const id of ids(e[4])) this.stat(id, 'struck'); break;
      case 'runover': this.stat(e[1], 'runover'); break;
      case 'keeper': this.stat(e[1], 'keeper'); break;
      case 'icecream': this.stat(e[1], 'icecream'); break;
      case 'buried': this.stat(e[1], 'buried'); break;
      case 'wipeout': this.stat(e[1], 'wipeout'); break;
      case 'crategot': this.stat(e[2], 'crates'); break;
      case 'decoyed': this.stat(e[1], 'decoyed'); break;
    }
  }
  flush() {
    this.statsFromEvents(this.ev);
    const s = {
      t: 's', tl: Math.round(this.timeLeft * 10) / 10, sea: this.map.tide ? Math.round(this.sea) : undefined,
      d: this.diggers.map(d => [d.id, Math.round(d.x), Math.round(d.y), Math.round(d.dir * 100) / 100, d.stun > 0 ? 1 : 0, d.immune > 0 ? 1 : 0,
        d.bag.map(b => b.ti).join(''), d.banked, d.moving ? 1 : 0, d.held.length > 1 ? d.held.join('') + ':' + d.sel : d.power || '',
        Object.keys(d.fx).map(k => k + Math.ceil(d.fx[k])).join('') + (d.padlock ? 'p' : '') + (d.lucky > 0 ? 'l' + d.lucky : '') + (d.tired > 0 ? 'z' + Math.ceil(d.tired) : ''),
        d.hp != null ? Math.ceil(d.hp) : -1, d.down ? 1 + Math.round(Math.min(1, d.revive / REVIVE_TIME) * 99) : 0]),
      z: this.zombies && this.zombies.length ? this.zombies.map(z => [z.id, Math.round(z.x), Math.round(z.y), Math.round(z.dir * 100) / 100, z.hp, z.max, ZOMBIE[z.kind].code, z.stun > 0 ? 1 : 0]) : undefined,
      co: this.isCoop() ? this.coopInfo() : undefined,
      hv: this.heavies.map(h => [h.id, Math.round(h.x), Math.round(h.y), h.carriers.map(c => c.id).join(','), h.hp, Math.ceil(h.wait)]),
      c: this.crates.map(c => [c.id, Math.round(c.x), Math.round(c.y)]),
      m: this.magpies.map(m => [m.id, Math.round(m.x), Math.round(m.y), Math.round(m.alt), Math.round(m.dir * 100) / 100, m.item ? m.item.ti : -1, m.stun > 0 ? 1 : 0, m.kind === 'dog' ? 1 : m.kind === 'ghost' ? 2 : 0]),
      kp: this.keeper ? [Math.round(this.keeper.x), Math.round(this.keeper.y), Math.round(this.keeper.dir * 100) / 100] : undefined,
      sk: this.skiers && this.skiers.length ? this.skiers.map(k => [Math.round(k.x), Math.round(k.y)]) : undefined,
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

// ---------- account API ----------
const tries = new Map(); // ip -> {n, reset}: slow down password guessing
function limited(ip) {
  const now = Date.now(), t = tries.get(ip) || { n: 0, reset: now + 10 * 60 * 1000 };
  if (now > t.reset) { t.n = 0; t.reset = now + 10 * 60 * 1000; }
  t.n++; tries.set(ip, t);
  return t.n > 20;
}
function readJson(req) {
  return new Promise((res, rej) => {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 20000) { rej(new UserError('Too much data.')); req.destroy(); } });
    req.on('end', () => { try { res(body ? JSON.parse(body) : {}); } catch { rej(new UserError('Bad request.')); } });
    req.on('error', rej);
  });
}
const bearer = req => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : null; };
async function api(req, res) {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const path = req.url.split('?')[0];
  try {
    if (path === '/api/catalog') return send(200, { catalog: CATALOG, achievements: ACHIEVEMENTS, season: { halloween: seasonOn('halloween') }, loadout: LOADOUT_CFG, levels: Array.from({ length: MAX_LEVEL }, (_, i) => xpForLevel(i + 1)), persistent: accounts.persistent, dbError, googleClientId: GOOGLE_CLIENT_ID });
    if (req.method !== 'POST') return send(405, { error: 'Use POST.' });
    if (path === '/api/clientlog') { const b = await readJson(req); console.error('CLIENT ERROR', JSON.stringify({ where: String(b.where).slice(0, 30), v: String(b.v).slice(0, 20), map: String(b.map).slice(0, 12), inGame: !!b.inGame, state: String(b.state).slice(0, 10), ua: String(b.ua).slice(0, 160) }), '\n' + String(b.msg).slice(0, 600)); return send(200, { ok: true }); }
    if (path === '/api/leaderboard') { const b = await readJson(req), kind = ['week', 'all', 'wins', 'zombies'].includes(b.kind) ? b.kind : 'week', ses = await accounts.session(bearer(req)).catch(() => null); return send(200, await accounts.leaderboard(kind, ses && ses.acct)); }
    const body = await readJson(req);
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const slow = () => limited(ip) && send(429, { error: 'Too many attempts. Wait a few minutes and try again.' });
    if (path === '/api/signup' || path === '/api/login') {
      if (slow()) return;
      const r = path === '/api/signup' ? await accounts.signup(body.name, body.password, body.import) : await accounts.login(body.name, body.password);
      return send(200, { token: r.token, profile: accounts.profile(r.acct), recovery: r.recovery });
    }
    if (path === '/api/recover') {
      if (slow()) return;
      const r = await accounts.recover(body.name, body.code, body.password);
      return send(200, { token: r.token, profile: accounts.profile(r.acct), recovery: r.recovery });
    }
    if (path === '/api/google') {
      if (slow()) return;
      let claims; try { claims = await verifyGoogleToken(body.credential, GOOGLE_CLIENT_ID); } catch (e) { throw new UserError(e.message); }
      const r = body.name ? await accounts.googleSignUp(claims, body.name, body.import) : await accounts.googleSignIn(claims);
      if (r.needName) return send(200, { needName: true, suggestion: r.suggestion });
      return send(200, { token: r.token, profile: accounts.profile(r.acct) });
    }
    const token = bearer(req), sess = await accounts.session(token), acct = sess && sess.acct;
    if (!acct) return send(401, { error: 'Please sign in again.' });
    if (path === '/api/link-google') {
      let claims; try { claims = await verifyGoogleToken(body.credential, GOOGLE_CLIENT_ID); } catch (e) { throw new UserError(e.message); }
      await accounts.linkGoogle(acct, claims);
      return send(200, { profile: accounts.profile(acct) });
    }
    if (path === '/api/password') {
      if (slow()) return;
      await accounts.setPassword(acct, sess.kind, body.current, body.password);
      return send(200, { profile: accounts.profile(acct) });
    }
    if (path === '/api/recovery-code') { const recovery = await accounts.newRecovery(acct); return send(200, { recovery, profile: accounts.profile(acct) }); }
    if (path === '/api/me') return send(200, { profile: accounts.profile(acct) });
    if (path === '/api/logout') { await accounts.logout(token); return send(200, { ok: true }); }
    if (path === '/api/buy') { await accounts.buy(acct, String(body.cat), String(body.id)); return send(200, { profile: accounts.profile(acct) }); }
    if (path === '/api/look') {
      await accounts.setLook(acct, body.look);
      for (const r of rooms.values()) for (const c of r.clients.values()) if (c.acct === acct) r.setLook(c.id, acct.data.look);
      return send(200, { profile: accounts.profile(acct) });
    }
    if (path === '/api/slot') { await accounts.buySlot(acct); return send(200, { profile: accounts.profile(acct) }); }
    if (path === '/api/loadout') { await accounts.setLoadout(acct, body.k); return send(200, { profile: accounts.profile(acct) }); }
    return send(404, { error: 'Not found.' });
  } catch (e) {
    if (e instanceof UserError) return send(400, { error: e.message });
    console.error('api', path, e);
    return send(500, { error: 'Something went wrong on the server. Try again in a moment.' });
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (req.url.startsWith('/api/')) { api(req, res); return; }
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
  let joining = false;
  ws.on('message', async raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    if (msg.t === 'join') {
      if (room || joining) return;
      joining = true;
      let acct = null;
      if (msg.token) {
        try { acct = await accounts.bySession(msg.token); } catch (e) { console.error('join auth', e.message); }
        if (!acct) { joining = false; ws.send(JSON.stringify({ t: 'error', msg: 'Your sign-in has expired. Sign in again, or play as a guest.', signout: 1 })); return; }
      }
      if (ws.readyState !== 1) return;
      const name = String(msg.name || 'Digger').replace(/[^\p{L}\p{N} _'-]/gu, '').trim().slice(0, 12) || 'Digger';
      let code = String(msg.room || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
      if (code) {
        room = rooms.get(code);
        if (!room) { joining = false; ws.send(JSON.stringify({ t: 'error', msg: `No game with code ${code}. Check the code or create a new game.` })); return; }
        if (room.clients.size >= MAX_PLAYERS) { room = null; joining = false; ws.send(JSON.stringify({ t: 'error', msg: 'That game is full (8 players).' })); return; }
      } else if (msg.quick) { // the busiest open Quick Play game, or a fresh one
        room = [...rooms.values()].filter(r => r.public && r.clients.size < MAX_PLAYERS).sort((a, b) => b.clients.size - a.clients.size)[0];
        if (!room){ code = newCode(); room = new Room(code, { public: true }); room.mapId = pick(openMaps().filter(m => m !== 'haunted')); rooms.set(code, room); }
      } else if (msg.tutorial) {
        code = newCode(); room = new Room(code, { tutorial: true }); rooms.set(code, room);
      } else {
        code = newCode(); room = new Room(code); rooms.set(code, room);
      }
      room.addClient(ws, name, msg.look, acct);
      me = room.clients.get(ws).id;
      if (room.tutorial) room.start();
      return;
    }
    if (!room) return;
    if (msg.t === 'start') { if (me === room.host && room.state !== 'play' && !room.public) room.start(); return; }
    if (msg.t === 'look') { room.setLook(me, msg.look); return; }
    if (msg.t === 'map') { if (me === room.host && !room.public) room.setMap(String(msg.id)); return; }
    if (msg.t === 'mode') { if (me === room.host && !room.public && room.state !== 'play') { room.mode = COOP[msg.id] ? String(msg.id) : 'classic'; room.lobbyMsg(); } return; }
    if (msg.t === 'theme') { if (me === room.host && !room.public && room.state !== 'play') { room.theme = msg.on && seasonOn('halloween') ? 'halloween' : ''; room.lobbyMsg(); } return; }
    room.onInput(me, msg);
  });
  ws.on('close', () => {
    if (!room) return;
    room.removeClient(ws);
    if (!room.clients.size) rooms.delete(room.code);
  });
}

process.on('uncaughtException', e => console.error('UNCAUGHT', e && e.stack || e)); // log it and keep serving everyone else
process.on('unhandledRejection', e => console.error('UNHANDLED', e && e.stack || e));

// heartbeat drops dead phone connections
setInterval(() => {
  for (const ws of conns) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
}, 15000);

let last = Date.now();
setInterval(() => {
  const now = Date.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
  for (const r of rooms.values()) { try { r.tick(dt); } catch (e) { console.error('ROOM ERROR', r.code, e && e.stack || e); } }
}, TICK_MS);

accounts.init().then(() => {
  console.log(accounts.persistent ? 'Accounts: saved in the database' : 'Accounts: NOT saved (no DATABASE_URL set) - they vanish on restart');
}).catch(e => {
  // bad connection string or database down: keep the game running, warn players accounts won't save
  dbError = 'The account database could not be reached, so progress is not being saved right now.';
  console.error('Database error:', e.message);
  accounts = new Accounts(null);
}).finally(() => server.listen(PORT, () => console.log(`Finders Keepers running on port ${PORT}`)));
