// Finders Keepers accounts: sign up / sign in, and everything a player keeps between games
// (coins, XP and level, wardrobe, starting powerup). Stored in Postgres when DATABASE_URL is set,
// otherwise in memory (fine for local testing, wiped on restart).
const crypto = require('crypto');
const { Pg } = require('./pglite');

// ---------- what can be unlocked: [id, name, coins, level] ----------
const CATALOG = {
  hat: { label: 'Hats', items: [['none', 'No hat', 0, 1], ['cap', 'Flat cap', 0, 1], ['bucket', 'Bucket hat', 50, 2], ['beanie', 'Bobble beanie', 50, 2], ['party', 'Party hat', 60, 3], ['cone', 'Traffic cone', 80, 4], ['hard', 'Hard hat', 100, 5], ['deer', 'Deerstalker', 100, 6], ['top', 'Top hat', 120, 8], ['cowboy', 'Cowboy hat', 150, 10], ['pirate', 'Pirate hat', 200, 12], ['viking', 'Viking helmet', 250, 15], ['halo', 'Halo', 400, 20], ['crown', 'Crown', 500, 25], ['chef', "Chef's hat", 120, 6], ['bunny', 'Bunny ears', 140, 7], ['santa', 'Santa hat', 150, 9], ['witch', 'Witch hat', 180, 11], ['propeller', 'Propeller cap', 200, 14], ['wizard', 'Wizard hat', 250, 17], ['antlers', 'Reindeer antlers', 220, 19], ['pumpkin', 'Pumpkin head', 300, 22], ['dinohood', 'Dino hood', 320, 27], ['space', 'Space helmet', 450, 30], ['unicorn', 'Unicorn horn', 500, 35], ['vampire', 'Vampire hair', 150, 1, 'halloween'], ['reaper', 'Reaper hood', 200, 3, 'halloween']] },
  jacket: { label: 'Jacket', items: [['auto', 'Team colour', 0, 1], ['red', 'Red', 30, 2], ['yellow', 'Yellow', 30, 2], ['pink', 'Pink', 30, 2], ['orange', 'Orange', 30, 2], ['purple', 'Purple', 30, 2], ['sky', 'Sky blue', 30, 2], ['black', 'Black', 60, 4], ['white', 'White', 60, 4], ['hivis', 'Hi-vis', 100, 6], ['camo', 'Camo', 120, 9], ['stripes', 'Breton stripes', 150, 11], ['tartan', 'Tartan', 150, 13], ['tux', 'Tuxedo', 180, 8], ['chefwhites', 'Chef whites', 180, 10], ['santasuit', 'Santa suit', 250, 14], ['skeleton', 'Skeleton costume', 260, 16], ['banana', 'Banana suit', 280, 18], ['ghost', 'Ghost sheet', 300, 21], ['wizrobe', 'Wizard robe', 320, 23], ['hero', 'Superhero cape', 380, 26], ['knight', 'Knight armour', 420, 29], ['dino', 'Dino costume', 450, 32], ['astro', 'Astronaut suit', 500, 36], ['vampcape', 'Vampire cape', 200, 1, 'halloween'], ['mummy', 'Mummy wraps', 200, 2, 'halloween'], ['reaperrobe', 'Reaper robe', 250, 3, 'halloween']] },
  boots: { label: 'Wellies', items: [['green', 'Green', 0, 1], ['yellow', 'Yellow', 30, 2], ['red', 'Red', 30, 2], ['pink', 'Pink', 30, 3], ['blue', 'Blue', 30, 3], ['gold', 'Gold', 150, 14], ['purple', 'Purple', 30, 3], ['black', 'Black', 40, 4], ['rainbow', 'Rainbow', 120, 10], ['clown', 'Clown shoes', 160, 15], ['flippers', 'Flippers', 180, 20], ['skates', 'Ice skates', 220, 26]] },
  pack: { label: 'Backpack', items: [['canvas', 'Canvas bag', 0, 1], ['leather', 'Leather satchel', 60, 3], ['teddy', 'Teddy bear', 120, 7], ['chest', 'Treasure chest', 250, 12], ['rocket', 'Rocket pack', 300, 18], ['picnic', 'Picnic basket', 100, 5], ['shell', 'Turtle shell', 180, 10], ['balloons', 'Balloons', 200, 15], ['surf', 'Surfboard', 220, 19], ['guitar', 'Guitar', 240, 21], ['batwings', 'Bat wings', 300, 28], ['fairy', 'Fairy wings', 300, 31], ['cauldron', 'Cauldron', 180, 2, 'halloween']] },
  pet: { label: 'Pet', items: [['none', 'No pet', 0, 1], ['duck', 'Duck', 200, 5], ['dog', 'Dog', 300, 9], ['cat', 'Cat', 300, 9], ['parrot', 'Parrot', 250, 13], ['mole', 'Mole', 350, 22], ['frog', 'Frog', 220, 6], ['hedgehog', 'Hedgehog', 260, 11], ['penguin', 'Penguin', 320, 16], ['pig', 'Piglet', 280, 20], ['robot', 'Robo-pup', 450, 30], ['dragon', 'Baby dragon', 600, 40], ['bat', 'Pet bat', 250, 2, 'halloween'], ['blackcat', 'Black cat', 250, 2, 'halloween'], ['spider', 'Big spider', 220, 4, 'halloween']] },
  trail: { label: 'Trail', items: [['none', 'No trail', 0, 1], ['prints', 'Muddy prints', 50, 2], ['hearts', 'Hearts', 150, 7], ['sparkle', 'Sparkles', 200, 11], ['gold', 'Gold dust', 400, 24], ['bubbles', 'Bubbles', 120, 5], ['flowers', 'Flowers', 150, 9], ['notes', 'Music notes', 180, 14], ['snow', 'Snowflakes', 200, 18], ['fire', 'Flames', 300, 27], ['rainbow', 'Rainbow', 500, 38], ['ghosts', 'Little ghosts', 200, 2, 'halloween'], ['sweets', 'Sweets', 150, 1, 'halloween']] },
  det: { label: 'Detector', items: [['classic', 'Classic', 0, 1], ['retro', 'Retro wood', 100, 6], ['neon', 'Neon', 150, 12], ['gold', 'Gold', 300, 20], ['toy', 'Toy', 120, 4], ['candy', 'Candy cane', 160, 9], ['ice', 'Frosty', 200, 15], ['lava', 'Lava', 260, 24], ['diamond', 'Diamond', 450, 34], ['bone', 'Bone', 180, 2, 'halloween']] },
  spade: { label: 'Spade', items: [['old', 'Old spade', 0, 1], ['steel', 'Shiny steel', 80, 5], ['gold', 'Golden', 250, 16], ['pan', 'Frying pan', 120, 4], ['fish', 'Wet fish', 160, 8], ['baguette', 'Baguette', 160, 11], ['chicken', 'Rubber chicken', 220, 15], ['sword', 'Toy sword', 250, 22], ['diamond', 'Diamond spade', 450, 33], ['scythe', 'Scythe', 250, 3, 'halloween'], ['broom', 'Broomstick', 180, 1, 'halloween']] },
  win: { label: 'Victory', items: [['confetti', 'Confetti', 0, 1], ['fireworks', 'Fireworks', 100, 7], ['coins', 'Coin shower', 150, 12], ['fanfare', 'Fanfare', 200, 17], ['bubbles', 'Bubble storm', 120, 5], ['hearts', 'Heart rain', 150, 9], ['snow', 'Snowfall', 150, 13], ['disco', 'Disco', 250, 21], ['balloons', 'Balloon lift', 300, 28], ['spooky', 'Spooky night', 200, 2, 'halloween']] },
};
// ---------- achievements ----------
// Kept on our own server so they work for everyone, signed in with a name or with Google.
// `gpgs` is the matching Google Play Games achievement id. Leave it null until the achievements are set up in the
// Play Console, then paste each id in: the game mirrors unlocks (and progress, for `steps`) to Google whenever it runs
// inside an Android wrapper that provides window.FKPlatform. Nothing else needs to change.
// stat: what's counted. Most are lifetime counters; 'level', 'rounds', 'wins', 'owned' and 'maps' are read from the account.
const ACHIEVEMENTS = [
  // digging
  { id: 'first_find', name: "Beginner's luck", desc: 'Dig up your first find', stat: 'finds', goal: 1, coins: 20, gpgs: null },
  { id: 'finds_100', name: 'Seasoned digger', desc: 'Dig up 100 finds', stat: 'finds', goal: 100, coins: 75, gpgs: null, steps: true },
  { id: 'finds_1000', name: 'Human mole', desc: 'Dig up 1,000 finds', stat: 'finds', goal: 1000, coins: 300, gpgs: null, steps: true },
  { id: 'gold_1', name: 'Struck gold', desc: 'Dig up a gold find', stat: 'gold', goal: 1, coins: 40, gpgs: null },
  { id: 'gold_50', name: 'Gold fever', desc: 'Dig up 50 gold finds', stat: 'gold', goal: 50, coins: 250, gpgs: null, steps: true },
  { id: 'boxes_10', name: 'Mystery solved', desc: 'Open 10 mystery boxes', stat: 'boxes', goal: 10, coins: 60, gpgs: null, steps: true },
  { id: 'wreck_1', name: 'Shipwrecked', desc: 'Dig up a find from the shipwreck', stat: 'wreck', goal: 1, coins: 50, gpgs: null },
  { id: 'decoyed', name: "Fool's gold", desc: "Dig up someone's decoy", stat: 'decoyed', goal: 1, coins: 20, gpgs: null },
  // the Museum
  { id: 'bank_1000', name: 'Curator', desc: 'Bank 1,000 points in total', stat: 'banked', goal: 1000, coins: 50, gpgs: null, steps: true },
  { id: 'bank_25000', name: 'Museum patron', desc: 'Bank 25,000 points in total', stat: 'banked', goal: 25000, coins: 300, gpgs: null, steps: true },
  { id: 'round_500', name: 'Big haul', desc: 'Bank 500 points in one round', stat: 'bestRound', goal: 500, coins: 100, gpgs: null },
  { id: 'clutch', name: 'Cutting it fine', desc: 'Bank finds in the last 5 seconds', stat: 'clutch', goal: 1, coins: 40, gpgs: null },
  { id: 'heavy_1', name: 'Heavy lifting', desc: 'Help carry a heavy find to the Museum', stat: 'heavies', goal: 1, coins: 50, gpgs: null },
  { id: 'heavy_10', name: 'Removal crew', desc: 'Help carry 10 heavy finds to the Museum', stat: 'heavies', goal: 10, coins: 200, gpgs: null, steps: true },
  // rounds and winning
  { id: 'rounds_10', name: 'Regular', desc: 'Play 10 rounds', stat: 'rounds', goal: 10, coins: 50, gpgs: null, steps: true },
  { id: 'rounds_100', name: 'Never off the field', desc: 'Play 100 rounds', stat: 'rounds', goal: 100, coins: 300, gpgs: null, steps: true },
  { id: 'win_1', name: 'Top digger', desc: 'Win a round', stat: 'wins', goal: 1, coins: 50, gpgs: null },
  { id: 'win_10', name: 'Champion', desc: 'Win 10 rounds', stat: 'wins', goal: 10, coins: 150, gpgs: null, steps: true },
  { id: 'win_50', name: 'Legend of the field', desc: 'Win 50 rounds', stat: 'wins', goal: 50, coins: 500, gpgs: null, steps: true },
  { id: 'maps_all', name: 'World traveller', desc: 'Play a round on every map', stat: 'maps', goal: 4, coins: 75, gpgs: null, steps: true },
  // dirty tricks
  { id: 'rob_1', name: 'Bonk!', desc: 'Bonk someone into dropping a find', stat: 'robs', goal: 1, coins: 20, gpgs: null },
  { id: 'rob_100', name: 'Highwayman', desc: 'Bonk finds out of people 100 times', stat: 'robs', goal: 100, coins: 250, gpgs: null, steps: true },
  { id: 'glove', name: 'Sticky fingers', desc: 'Steal a find with the sticky glove', stat: 'gloves', goal: 1, coins: 40, gpgs: null },
  { id: 'shock_3', name: 'Shockwave', desc: 'Hit 3 or more people with one big bonk', stat: 'shockMax', goal: 3, coins: 75, gpgs: null },
  { id: 'banana', name: 'Slapstick', desc: 'Someone slips on your banana peel', stat: 'slips', goal: 1, coins: 40, gpgs: null },
  { id: 'smash', name: 'Wrecking ball', desc: 'Land the bonk that smashes a heavy find', stat: 'smashes', goal: 1, coins: 50, gpgs: null },
  { id: 'birds_25', name: 'Bird scarer', desc: 'Bonk 25 birds', stat: 'birds', goal: 25, coins: 100, gpgs: null, steps: true },
  { id: 'crates_10', name: 'Supply run', desc: 'Grab 10 supply crates', stat: 'crates', goal: 10, coins: 75, gpgs: null, steps: true },
  // random events
  { id: 'struck', name: 'Lightning rod', desc: 'Get struck by lightning', stat: 'struck', goal: 1, coins: 30, gpgs: null },
  { id: 'runover', name: 'Roadkill', desc: 'Get run over by a tractor or snowmobile', stat: 'runover', goal: 1, coins: 30, gpgs: null },
  { id: 'dog', name: 'Who let the dogs out', desc: 'Bonk a dog', stat: 'dogs', goal: 1, coins: 30, gpgs: null },
  { id: 'keeper', name: 'Keep off the grass', desc: 'Get caught by the park keeper', stat: 'keeper', goal: 1, coins: 30, gpgs: null },
  { id: 'icecream', name: '99 Flake', desc: 'Get an ice cream from the van', stat: 'icecream', goal: 1, coins: 30, gpgs: null },
  { id: 'buried', name: 'Snow joke', desc: 'Get buried by an avalanche', stat: 'buried', goal: 1, coins: 30, gpgs: null },
  { id: 'wipeout', name: 'Wipeout', desc: 'Get wiped out by a skier', stat: 'wipeout', goal: 1, coins: 30, gpgs: null },
  // progress
  { id: 'level_10', name: 'Getting good', desc: 'Reach level 10', stat: 'level', goal: 10, coins: 100, gpgs: null, steps: true },
  { id: 'level_25', name: 'Expert', desc: 'Reach level 25', stat: 'level', goal: 25, coins: 300, gpgs: null, steps: true },
  { id: 'level_50', name: 'Master detectorist', desc: 'Reach level 50', stat: 'level', goal: 50, coins: 1000, gpgs: null, steps: true },
  { id: 'halloween_bank', name: 'Trick or treasure', desc: 'Bank 300 points on the Haunted Field', stat: 'hauntedBank', goal: 300, coins: 150, gpgs: null, season: 'halloween' },
  { id: 'ghostbuster', name: 'Ghostbuster', desc: 'Bonk 5 ghosts', stat: 'ghosts', goal: 5, coins: 150, gpgs: null, season: 'halloween', steps: true },
  { id: 'owned_20', name: 'Fashionista', desc: 'Own 20 cosmetics', stat: 'owned', goal: 20, coins: 150, gpgs: null, steps: true },
];
const ACH_BY_STAT = {};
for (const a of ACHIEVEMENTS) (ACH_BY_STAT[a.stat] = ACH_BY_STAT[a.stat] || []).push(a);

// ---------- daily challenges: the same three for everyone each day (UTC) ----------
const DAILY_POOL = [
  { id: 'finds', stat: 'finds', goal: 10, text: 'Dig up 10 finds', coins: 40 },
  { id: 'gold', stat: 'gold', goal: 1, text: 'Dig up a gold find', coins: 60 },
  { id: 'robs', stat: 'robs', goal: 3, text: 'Bonk 3 finds out of people', coins: 50 },
  { id: 'banked', stat: 'banked', goal: 400, text: 'Bank 400 points', coins: 50 },
  { id: 'crates', stat: 'crates', goal: 1, text: 'Grab a supply crate', coins: 40 },
  { id: 'birds', stat: 'birds', goal: 3, text: 'Bonk 3 birds (or bats)', coins: 40 },
  { id: 'heavies', stat: 'heavies', goal: 1, text: 'Help carry a heavy find in', coins: 60 },
  { id: 'rounds', stat: 'rounds', goal: 3, text: 'Play 3 rounds', coins: 40 },
  { id: 'wins', stat: 'wins', goal: 1, text: 'Win a round', coins: 60 },
  { id: 'boxes', stat: 'boxes', goal: 2, text: 'Open 2 mystery boxes', coins: 40 },
];
const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);
const weekKey = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7))).toISOString().slice(0, 10); // the Monday
function dailyFor(day) {
  let h = 0; for (const c of day) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const pool = [...DAILY_POOL], out = [];
  while (out.length < 3) { h = (h * 1103515245 + 12345) >>> 0; out.push(pool.splice(h % pool.length, 1)[0]); }
  return out;
}

// starting powerups: key -> [level, coins per round]
const LOADOUT = { c: [2, 15], t: [3, 15], w: [4, 15], m: [5, 20], p: [6, 25], l: [7, 25], b: [8, 20], s: [9, 25], r: [10, 30], k: [12, 30], g: [14, 35], d: [16, 35], q: [18, 40] };
// extra powerup slots: [level needed, coins]. Everyone starts with one.
const SLOT_UNLOCKS = [[4, 250], [12, 750]];
const MAX_LEVEL = 50, START_COINS = 50, IMPORT_CAP = 3000;
const xpForLevel = L => 300 * (L - 1) + 50 * (L - 1) * (L - 2); // total XP needed to reach level L
const levelFor = xp => { let L = 1; while (L < MAX_LEVEL && xp >= xpForLevel(L + 1)) L++; return L; };
const item = (cat, id) => CATALOG[cat] && CATALOG[cat].items.find(i => i[0] === id);
const isFree = (cat, id) => { const it = item(cat, id); return !!it && it[2] === 0; };

// Halloween runs 20 Oct - 2 Nov (UTC)
const isHalloween = (d = new Date()) => process.env.HALLOWEEN ? process.env.HALLOWEEN === '1' : (d.getUTCMonth() === 9 && d.getUTCDate() >= 20) || (d.getUTCMonth() === 10 && d.getUTCDate() <= 2);
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
  async top(kind, wk) {
    const v = d => kind === 'week' ? (d.week && d.week.key === wk ? d.week.banked : 0) : kind === 'wins' ? d.wins || 0 : (d.stats && d.stats.banked) || 0;
    return [...this.players.values()].map(p => ({ name: p.name, value: v(p.data), level: levelFor(p.data.xp) })).filter(r => r.value > 0).sort((a, b) => b.value - a.value).slice(0, 20);
  }
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
  async top(kind, wk) {
    const expr = kind === 'week' ? "CASE WHEN data->'week'->>'key' = $1 THEN COALESCE((data->'week'->>'banked')::int, 0) ELSE 0 END"
      : kind === 'wins' ? "COALESCE((data->>'wins')::int, 0)" : "COALESCE((data->'stats'->>'banked')::int, 0)";
    const r = await this.db.query(`SELECT name, (${expr}) AS value, data->>'xp' AS xp FROM fk_players ORDER BY 2 DESC LIMIT 20`, kind === 'week' ? [wk] : []);
    return r.rows.map(x => ({ name: x.name, value: Number(x.value) || 0, level: levelFor(Number(x.xp) || 0) })).filter(x => x.value > 0);
  }
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

  isHalloween() { return isHalloween(); }
  slots(acct) { return Math.min(1 + SLOT_UNLOCKS.length, acct.data.slots || 1); }
  async buySlot(acct) {
    const have = this.slots(acct), next = SLOT_UNLOCKS[have - 1];
    if (!next) throw new UserError('You already have every powerup slot.');
    const [lvl, price] = next;
    if (this.level(acct) < lvl) throw new UserError(`Reach level ${lvl} to unlock another slot.`);
    if (acct.data.coins < price) throw new UserError(`You need ${price - acct.data.coins} more coins.`);
    acct.data.coins -= price; acct.data.slots = have + 1; await this.save(acct);
  }
  level(acct) { return levelFor(acct.data.xp); }
  owns(acct, cat, id) { return isFree(cat, id) || (!!acct && acct.data.owned.includes(cat + ':' + id)); }
  cleanLook(acct, raw) {
    const l = {};
    for (const cat in CATALOG) { const v = raw && raw[cat]; l[cat] = item(cat, v) && this.owns(acct, cat, v) ? v : CATALOG[cat].items[0][0]; }
    return l;
  }
  // ----- achievements -----
  statValue(acct, stat) {
    const d = acct.data, st = d.stats || {};
    if (stat === 'level') return this.level(acct);
    if (stat === 'rounds') return d.rounds || 0;
    if (stat === 'wins') return d.wins || 0;
    if (stat === 'owned') return (d.owned || []).length;
    if (stat === 'maps') return (st.maps || []).length;
    return st[stat] || 0;
  }
  // add to a counter ('add'), keep the best ('max') or remember a value ('set'); returns any achievements just unlocked
  track(acct, stat, n = 1, mode = 'add') {
    const st = acct.data.stats = acct.data.stats || {};
    const none = Object.assign([], { daily: [] }); // nothing new: callers always get an achievements list with a daily list on it
    if (mode === 'max') { if (n <= (st[stat] || 0)) return none; st[stat] = n; }
    else if (mode === 'set') { const arr = st[stat] = st[stat] || []; if (arr.includes(n)) return none; arr.push(n); }
    else st[stat] = (st[stat] || 0) + n;
    if (stat === 'banked') { const w = this.week(acct); w.banked += n; }
    const got = this.checkAch(acct, [stat]);
    got.daily = mode === 'add' ? this.dailyAdd(acct, stat, n) : [];
    return got;
  }
  // this week's totals for the leaderboard
  week(acct) { const k = weekKey(); if (!acct.data.week || acct.data.week.key !== k) acct.data.week = { key: k, banked: 0, wins: 0 }; return acct.data.week; }
  dailyState(acct) { const day = dayKey(); if (!acct.data.daily || acct.data.daily.day !== day) acct.data.daily = { day, prog: {}, done: [] }; return acct.data.daily; }
  // count towards today's challenges; completed ones pay out straight away
  dailyAdd(acct, stat, n) {
    const ds = this.dailyState(acct), got = [];
    for (const c of dailyFor(ds.day)) {
      if (c.stat !== stat || ds.done.includes(c.id)) continue;
      ds.prog[c.id] = (ds.prog[c.id] || 0) + n;
      if (ds.prog[c.id] >= c.goal) { ds.done.push(c.id); acct.data.coins += c.coins; got.push(c); }
    }
    if (got.length) this.save(acct).catch(e => console.error('save daily', e.message));
    return got;
  }
  dailyView(acct) {
    const ds = this.dailyState(acct), now = new Date(), next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    return { day: ds.day, resetsIn: Math.round((next - now) / 1000),
      list: dailyFor(ds.day).map(c => ({ id: c.id, text: c.text, goal: c.goal, coins: c.coins, prog: Math.min(c.goal, ds.prog[c.id] || 0), done: ds.done.includes(c.id) })) };
  }
  async leaderboard(kind, me) {
    const key = kind + ':' + weekKey(), hit = this.lbCache && this.lbCache[key];
    let rows = hit && Date.now() - hit.at < 20000 ? hit.rows : null;
    if (!rows) { rows = await this.store.top(kind, weekKey()); (this.lbCache = this.lbCache || {})[key] = { at: Date.now(), rows }; }
    // what everyone else sees can lag 20s; your own line is always up to date
    const val = a => kind === 'week' ? (a.data.week && a.data.week.key === weekKey() ? a.data.week.banked : 0) : kind === 'wins' ? a.data.wins || 0 : (a.data.stats && a.data.stats.banked) || 0;
    let list = rows.map(r => ({ ...r }));
    if (me) { const v = val(me), i = list.findIndex(r => r.name === me.name); if (i >= 0) list[i].value = v; else if (v > 0) list.push({ name: me.name, value: v, level: this.level(me) }); list.sort((a, b) => b.value - a.value); }
    list = list.filter(r => r.value > 0).slice(0, 20);
    const rank = me ? list.findIndex(r => r.name === me.name) + 1 : 0;
    return { kind, rows: list, me: me ? { name: me.name, value: val(me), rank } : null };
  }
  checkAch(acct, stats) {
    const got = [], have = acct.data.ach = acct.data.ach || {};
    for (const stat of stats || Object.keys(ACH_BY_STAT)) for (const a of ACH_BY_STAT[stat] || []) {
      if (have[a.id] || this.statValue(acct, stat) < a.goal) continue;
      have[a.id] = Date.now(); acct.data.coins += a.coins; got.push(a);
    }
    if (got.length) this.save(acct).catch(e => console.error('save achievement', e.message));
    return got;
  }
  profile(acct) {
    const d = acct.data, L = levelFor(d.xp);
    return { name: acct.name, coins: d.coins, xp: d.xp, level: L, levelXp: xpForLevel(L), nextXp: L < MAX_LEVEL ? xpForLevel(L + 1) : null,
      owned: d.owned, look: this.cleanLook(acct, d.look), loadout: d.loadout, rounds: d.rounds, wins: d.wins,
      google: !!acct.google, hasPassword: !!acct.hasPw, hasRecovery: !!d.recovery,
      slots: this.slots(acct), nextSlot: SLOT_UNLOCKS[this.slots(acct) - 1] || null, daily: this.dailyView(acct), ach: d.ach || {}, progress: Object.fromEntries(Object.keys(ACH_BY_STAT).map(k => [k, this.statValue(acct, k)])) };
  }
  async buy(acct, cat, id) {
    const it = item(cat, id); if (!it) throw new UserError('That item doesn\'t exist.');
    if (this.owns(acct, cat, id)) return;
    const [, name, price, lvl, season] = it;
    if (season === 'halloween' && !isHalloween()) throw new UserError(`${name} was only on sale for Halloween.`);
    if (this.level(acct) < lvl) throw new UserError(`Reach level ${lvl} to unlock ${name}.`);
    if (acct.data.coins < price) throw new UserError(`You need ${price - acct.data.coins} more coins.`);
    acct.data.coins -= price; acct.data.owned.push(cat + ':' + id);
    acct.data.look = { ...acct.data.look, [cat]: id };
    this.checkAch(acct, ['owned']);
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
    acct.data.stats = acct.data.stats || {};
    if (banked > (acct.data.stats.bestRound || 0)) acct.data.stats.bestRound = banked;
    const daily = this.dailyAdd(acct, 'rounds', 1);
    if (place === 0 && banked > 0) { this.week(acct).wins++; daily.push(...this.dailyAdd(acct, 'wins', 1)); }
    const ach = this.checkAch(acct, ['rounds', 'wins', 'level', 'bestRound']);
    await this.save(acct);
    return { coins, xp, before, after, unlocks, ach: ach.map(a => a.id), daily: daily.map(c => c.id) };
  }
}
class UserError extends Error {}

module.exports = { Accounts, UserError, CATALOG, ACHIEVEMENTS, LOADOUT, xpForLevel, levelFor, MAX_LEVEL, isFree };
