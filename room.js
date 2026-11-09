'use strict';
// A Room is one poker table: the Game plus the people connected to it.
// It owns the timers (turn clock, run-out pacing, pause between hands) and pushes
// live updates to every connected browser. Zero dependencies.

const crypto = require('crypto');
const { Game } = require('./game');

class RoomError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// The 20 table emojis. The browser has the same list; the server only accepts these.
const EMOJIS = [
  '👍', '👏', '😂', '😎', '😏', '🤔', '😬', '😱', '😭', '😡',
  '🤯', '🙏', '🍀', '🔥', '💰', '🦈', '🐟', '🥶', '💀', '🫡',
];

// What the host may choose in the lobby.
const SETTING_CHOICES = {
  startingStack: [2500, 5000, 10000, 12500, 20000, 25000, 50000],
  levelMinutes: [5, 10, 15, 20, 30, 45, 60],
  turnSeconds: [15, 20, 30, 45, 60, 90],
  timeBank: [0, 1, 2, 3, 5],            // extra turns of thinking time per player
  anteFromLevel: [0, 2, 3, 4, 5, 6, 8], // 0 = no antes
  lateRegLevel: [0, 2, 3, 4, 5, 6, 8],  // 0 = no late joining, otherwise open through that level
};
const DEFAULT_SETTINGS = {
  startingStack: 12500, levelMinutes: 15, turnSeconds: 30, timeBank: 3, anteFromLevel: 0, lateRegLevel: 4,
};

// Pause (ms) before the next card of an all-in run-out, by how many board cards are out.
const RUNOUT_DELAYS = { 0: 2600, 1: 900, 2: 900, 3: 3200, 4: 4200, 5: 2800 };
const EMOJI_GAP_MS = 1500;

class Room {
  constructor(code, opts = {}) {
    this.code = code;
    this.settings = { ...DEFAULT_SETTINGS, ...(opts.settings || {}) };
    if (opts.turnMs) this.settings.turnSeconds = opts.turnMs / 1000;
    this.handPauseMs = opts.handPauseMs ?? 8000; // time to look at the result, show cards, rabbit hunt
    this.runoutSpeed = opts.runoutSpeed ?? 1;    // tests use a small number to skip the drama
    this.gameOpts = opts.game || {};
    this.game = this.makeGame();

    this.hostId = null;
    this.tokens = new Map();   // secret token -> player id
    this.pins = new Map();     // player id -> salted PIN hash (to take your seat back)
    this.clients = new Map();  // player id -> Set of open event streams
    this.timeouts = new Map(); // player id -> consecutive turn timeouts
    this.timeBank = new Map(); // player id -> extra turns left
    this.preActions = new Set(); // players who ticked "check / fold" for this hand
    this.lastEmoji = new Map();
    this.lastHandNumber = 0;

    this.turnTimer = null; this.turnDeadline = null; this.turnSpan = null;
    this.nextHandTimer = null; this.nextHandAt = null;
    this.runoutTimer = null; this.runoutAt = null;
    this.saved = null;         // time left on the running timer, kept while paused
    this.lastActivity = Date.now();
    this.closed = false;
  }

  get turnMs() { return this.settings.turnSeconds * 1000; }

  makeGame() {
    const s = this.settings;
    return new Game({
      ...this.gameOpts,
      startingStack: s.startingStack, levelMinutes: s.levelMinutes,
      anteFromLevel: s.anteFromLevel, lateRegLevel: s.lateRegLevel,
    });
  }

  // ---------- people ----------

  join(name, pin) {
    const clean = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
    if (!clean) throw new RoomError('Please enter a name');
    const code = String(pin === undefined || pin === null ? '' : pin);
    if (!/^\d{4}$/.test(code)) throw new RoomError('Choose a 4-digit PIN');
    const existing = this.game.players.find(p => p.name.toLowerCase() === clean.toLowerCase());
    if (existing) return this.reclaim(existing.id, code);
    const id = 'p' + crypto.randomBytes(4).toString('hex');
    const token = crypto.randomBytes(16).toString('hex');
    this.wrap(() => this.game.addPlayer(id, clean));
    if (!this.hostId) this.hostId = id;
    const salt = crypto.randomBytes(8).toString('hex');
    this.pins.set(id, { salt, hash: this.hashPin(code, salt), fails: 0, lockedUntil: 0 });
    this.tokens.set(token, id);
    this.timeBank.set(id, this.settings.timeBank);
    this.touch();
    this.broadcast();
    return { id, token, rejoined: false };
  }

  hashPin(pin, salt) {
    return crypto.scryptSync(pin, salt, 16).toString('hex');
  }

  // Someone joins with the name of a player who is already at the table: with the
  // right PIN they get that seat back (any older sessions of that player stop working).
  reclaim(id, code) {
    const rec = this.pins.get(id);
    const now = Date.now();
    if (!rec) throw new RoomError('That name is already taken at this table');
    if (rec.lockedUntil > now) {
      throw new RoomError('Too many wrong PINs. Try again in ' + Math.ceil((rec.lockedUntil - now) / 1000) + ' seconds.', 429);
    }
    const ok = crypto.timingSafeEqual(Buffer.from(this.hashPin(code, rec.salt), 'hex'), Buffer.from(rec.hash, 'hex'));
    if (!ok) {
      rec.fails += 1;
      if (rec.fails >= 5) { rec.fails = 0; rec.lockedUntil = now + 60000; }
      throw new RoomError('That name is taken. If it is you, enter the PIN you chose; otherwise pick another name.', 403);
    }
    rec.fails = 0;
    for (const [t, pid] of this.tokens) if (pid === id) this.tokens.delete(t);
    const set = this.clients.get(id);
    if (set) { for (const res of set) { try { res.end(); } catch (e) { /* gone */ } } this.clients.delete(id); }
    const token = crypto.randomBytes(16).toString('hex');
    this.tokens.set(token, id);
    this.touch();
    this.broadcast();
    return { id, token, rejoined: true };
  }

  auth(token) {
    return this.tokens.get(String(token || '')) || null;
  }

  // ---------- host commands ----------

  requireHost(id) {
    if (id !== this.hostId) throw new RoomError('Only the host can do that', 403);
  }

  setSettings(id, input = {}) {
    this.requireHost(id);
    if (this.game.started) throw new RoomError('Settings are locked once the game has started');
    const next = { ...this.settings };
    for (const key of Object.keys(SETTING_CHOICES)) {
      if (input[key] === undefined) continue;
      const v = Number(input[key]);
      if (!SETTING_CHOICES[key].includes(v)) throw new RoomError('That value is not allowed for ' + key);
      next[key] = v;
    }
    this.settings = next;
    this.wrap(() => this.game.configure({
      startingStack: next.startingStack, levelMinutes: next.levelMinutes,
      anteFromLevel: next.anteFromLevel, lateRegLevel: next.lateRegLevel,
    }));
    for (const p of this.game.players) this.timeBank.set(p.id, next.timeBank);
    this.touch();
    this.broadcast();
  }

  start(id) {
    this.requireHost(id);
    if (this.game.started) throw new RoomError('The game has already started');
    if (this.game.players.length < 2) throw new RoomError('Need at least 2 players with chips');
    this.game.shuffleSeats(); // a real tournament draws seats at random
    this.wrap(() => this.game.startHand(Date.now()));
    this.afterChange();
  }

  pause(id) {
    this.requireHost(id);
    const now = Date.now();
    this.wrap(() => this.game.pause(now));
    this.saved = {
      turn: this.turnDeadline ? Math.max(0, this.turnDeadline - now) : null,
      next: this.nextHandAt ? Math.max(0, this.nextHandAt - now) : null,
      runout: this.runoutAt ? Math.max(0, this.runoutAt - now) : null,
    };
    this.clearTimers();
    this.touch();
    this.broadcast();
  }

  resume(id) {
    this.requireHost(id);
    this.wrap(() => this.game.resume(Date.now()));
    this.afterChange(); // timers restart with the time that was left
  }

  // ---------- commands from players ----------

  action(id, action, amount) {
    this.wrap(() => this.game.act(id, action, amount));
    this.timeouts.set(id, 0);
    this.afterChange();
  }

  leave(id) {
    if (this.game.paused) throw new RoomError('The game is paused');
    this.wrap(() => this.game.leave(id));
    this.afterChange();
  }

  sitIn(id) {
    this.wrap(() => this.game.sitIn(id));
    this.timeouts.set(id, 0);
    this.afterChange();
  }

  show(id, which) {
    this.wrap(() => this.game.showCards(id, which));
    this.touch();
    this.broadcast();
  }

  rabbit(id) {
    this.wrap(() => this.game.rabbitHunt(id));
    this.touch();
    this.broadcast();
  }

  // Extra thinking time: adds one full turn to the clock, on your own turn only.
  useTimeBank(id) {
    const g = this.game;
    if (g.paused) throw new RoomError('The game is paused');
    if (!g.isHandActive() || g.players[g.toAct].id !== id) throw new RoomError('You can only use the time bank on your turn');
    const left = this.timeBank.get(id) || 0;
    if (left <= 0) throw new RoomError('You have no time bank left');
    this.timeBank.set(id, left - 1);
    clearTimeout(this.turnTimer);
    this.scheduleTurn(Math.max(0, this.turnDeadline - Date.now()) + this.turnMs);
    this.touch();
    this.broadcast();
  }

  // "Check / fold": done for you the moment it is your turn, even if your phone is asleep.
  setPreAction(id, on) {
    const g = this.game;
    if (!g.isHandActive()) throw new RoomError('No hand in progress');
    const p = g.byId(id);
    if (!p || !p.inHand || p.folded) throw new RoomError('You are not in this hand');
    if (g.players[g.toAct].id === id) throw new RoomError('It is already your turn');
    if (on) this.preActions.add(id); else this.preActions.delete(id);
    this.touch();
    this.broadcast();
  }

  emoji(id, emoji) {
    if (!EMOJIS.includes(emoji)) throw new RoomError('Unknown emoji');
    const now = Date.now();
    if (now - (this.lastEmoji.get(id) || 0) < EMOJI_GAP_MS) throw new RoomError('Slow down a little', 429);
    this.lastEmoji.set(id, now);
    this.touch();
    this.broadcastEvent('emoji', { id, emoji });
  }

  wrap(fn) {
    try { return fn(); }
    catch (e) { throw (e instanceof RoomError ? e : new RoomError(e.message)); }
  }

  // ---------- clocks ----------

  clearTimers() {
    clearTimeout(this.turnTimer);
    clearTimeout(this.nextHandTimer);
    clearTimeout(this.runoutTimer);
    this.turnTimer = this.nextHandTimer = this.runoutTimer = null;
    this.turnDeadline = this.nextHandAt = this.runoutAt = null;
  }

  afterChange() {
    this.touch();
    this.clearTimers();
    const g = this.game;
    if (!this.closed && !g.paused) {
      if (g.handNumber !== this.lastHandNumber) { this.preActions.clear(); this.lastHandNumber = g.handNumber; }
      this.applyPreActions();
      this.armTimers();
    }
    this.broadcast();
  }

  applyPreActions() {
    const g = this.game;
    while (g.isHandActive() && this.preActions.has(g.players[g.toAct].id)) {
      const id = g.players[g.toAct].id;
      this.preActions.delete(id);
      try {
        if (g.getLegal(id).canCheck) g.act(id, 'check');
        else g.act(id, 'fold');
      } catch (e) { console.error('pre-action failed:', e.message); break; }
    }
  }

  armTimers() {
    const g = this.game;
    const saved = this.saved || {};
    this.saved = null;
    if (g.isHandActive()) this.scheduleTurn(saved.turn ?? this.turnMs);
    else if (g.phase === 'runout') this.scheduleRunout(saved.runout ?? this.runoutDelay(g.board.length));
    else if (g.phase === 'handover') this.scheduleNextHand(saved.next ?? this.handPauseMs);
  }

  scheduleTurn(ms) {
    this.turnSpan = ms;
    this.turnDeadline = Date.now() + ms;
    this.turnTimer = setTimeout(() => this.onTurnTimeout(), ms);
    this.turnTimer.unref();
  }

  scheduleNextHand(ms) {
    this.nextHandAt = Date.now() + ms;
    this.nextHandTimer = setTimeout(() => this.startNextHand(), ms);
    this.nextHandTimer.unref();
  }

  scheduleRunout(ms) {
    this.runoutAt = Date.now() + ms;
    this.runoutTimer = setTimeout(() => this.runoutTick(), ms);
    this.runoutTimer.unref();
  }

  runoutDelay(cardsOut) {
    return Math.round((RUNOUT_DELAYS[cardsOut] ?? 1500) * this.runoutSpeed);
  }

  // Deals the next card of an all-in run-out, or settles the hand after the river.
  runoutTick() {
    this.runoutTimer = null;
    const g = this.game;
    if (this.closed || g.paused || g.phase !== 'runout') return;
    try { g.runoutStep(); } catch (e) { console.error('run-out failed:', e.message); }
    this.afterChange();
  }

  startNextHand() {
    this.nextHandTimer = null;
    if (this.closed || this.game.paused || this.game.phase !== 'handover') return;
    try {
      this.game.startHand(Date.now());
      this.afterChange();
    } catch (e) {
      // Not enough players ready (others are sitting out): check again shortly.
      this.scheduleNextHand(3000);
      this.broadcast();
    }
  }

  // Out of time: check if free, otherwise fold. A second timeout in a row sits the player out.
  onTurnTimeout() {
    this.turnTimer = null;
    const g = this.game;
    if (this.closed || g.paused || !g.isHandActive()) return;
    const p = g.players[g.toAct];
    const n = (this.timeouts.get(p.id) || 0) + 1;
    this.timeouts.set(p.id, n);
    try {
      if (n >= 2) g.leave(p.id);
      else if (g.getLegal(p.id).canCheck) g.act(p.id, 'check');
      else g.act(p.id, 'fold');
    } catch (e) {
      console.error('turn timeout failed:', e.message);
    }
    this.afterChange();
  }

  // ---------- what each browser sees ----------

  historyFor(id) {
    return this.game.history.slice().reverse().map(h => ({
      n: h.n, level: h.level, blinds: h.blinds, ante: h.ante, board: h.board, pot: h.pot, type: h.type,
      winners: h.winners,
      revealed: h.revealed,            // hands turned face up at a showdown are public
      yourHole: h.holes[id] || null,   // your own cards only
      yourNet: h.net[id] ?? null,
    }));
  }

  state(id) {
    const now = Date.now();
    const g = this.game;
    const s = g.getState(id, now);
    s.code = this.code;
    s.hostId = this.hostId;
    s.you = id;
    s.settings = this.settings;
    s.turnMs = this.turnMs;
    s.turnSpanMs = this.turnSpan || this.turnMs;
    s.turnDeadline = this.turnDeadline;
    s.nextHandAt = this.nextHandAt;
    s.turnRemainingMs = g.paused && this.saved ? this.saved.turn : null;
    s.nextHandRemainingMs = g.paused && this.saved ? this.saved.next : null;
    s.serverTime = now; // lets browsers correct for clock differences
    s.timeBank = this.timeBank.get(id) || 0;
    s.preAction = this.preActions.has(id);
    s.historyCount = g.history.length;
    s.waitingForPlayers = g.phase === 'handover'
      && g.players.filter(p => p.stack > 0 && !p.sittingOut).length < 2;
    s.players = s.players.map(p => ({ ...p, connected: this.clients.has(p.id), timeBank: this.timeBank.get(p.id) || 0 }));
    return s;
  }

  // ---------- live updates ----------

  addClient(id, res) {
    if (!this.clients.has(id)) this.clients.set(id, new Set());
    this.clients.get(id).add(res);
    this.broadcast();
  }

  removeClient(id, res) {
    const set = this.clients.get(id);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) this.clients.delete(id);
    this.broadcast();
  }

  broadcast() {
    for (const [id, set] of this.clients) {
      const payload = 'data: ' + JSON.stringify(this.state(id)) + '\n\n';
      for (const res of set) {
        try { res.write(payload); } catch (e) { /* closed streams are cleaned up on 'close' */ }
      }
    }
  }

  broadcastEvent(name, data) {
    const payload = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const set of this.clients.values()) {
      for (const res of set) { try { res.write(payload); } catch (e) { /* ignore */ } }
    }
  }

  ping() {
    for (const set of this.clients.values()) {
      for (const res of set) { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } }
    }
  }

  touch() { this.lastActivity = Date.now(); }

  destroy() {
    this.closed = true;
    this.clearTimers();
    for (const set of this.clients.values()) {
      for (const res of set) { try { res.end(); } catch (e) { /* ignore */ } }
    }
    this.clients.clear();
  }
}

module.exports = { Room, RoomError, EMOJIS, SETTING_CHOICES, DEFAULT_SETTINGS };
