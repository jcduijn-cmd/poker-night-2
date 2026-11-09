'use strict';
// A Room is one poker table: the Game plus the people connected to it.
// It owns the timers (turn clock, pause between hands) and pushes live
// updates to every connected browser. Zero dependencies.

const crypto = require('crypto');
const { Game } = require('./game');

class RoomError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

class Room {
  constructor(code, opts = {}) {
    this.code = code;
    this.game = new Game(opts.game);
    this.turnMs = opts.turnMs ?? 30000;        // time to act before auto check/fold
    this.handPauseMs = opts.handPauseMs ?? 6000; // pause to look at results between hands

    this.hostId = null;
    this.tokens = new Map();   // secret token -> player id
    this.clients = new Map();  // player id -> Set of open event streams
    this.timeouts = new Map(); // player id -> consecutive turn timeouts

    this.turnTimer = null;
    this.turnDeadline = null;
    this.nextHandTimer = null;
    this.nextHandAt = null;
    this.lastActivity = Date.now();
    this.closed = false;
  }

  // ---------- people ----------

  join(name) {
    const clean = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
    if (!clean) throw new RoomError('Please enter a name');
    if (this.game.started) throw new RoomError('The game has already started');
    if (this.game.players.some(p => p.name.toLowerCase() === clean.toLowerCase())) {
      throw new RoomError('That name is already taken at this table');
    }
    const id = 'p' + crypto.randomBytes(4).toString('hex');
    const token = crypto.randomBytes(16).toString('hex');
    try { this.game.addPlayer(id, clean); }
    catch (e) { throw new RoomError(e.message); }
    if (!this.hostId) this.hostId = id;
    this.tokens.set(token, id);
    this.touch();
    this.broadcast();
    return { id, token };
  }

  auth(token) {
    return this.tokens.get(String(token || '')) || null;
  }

  // ---------- commands from players ----------

  start(id) {
    if (id !== this.hostId) throw new RoomError('Only the host can start the game', 403);
    if (this.game.started) throw new RoomError('The game has already started');
    this.wrap(() => this.game.startHand(Date.now()));
    this.afterChange();
  }

  action(id, action, amount) {
    this.wrap(() => this.game.act(id, action, amount));
    this.timeouts.set(id, 0);
    this.afterChange();
  }

  leave(id) {
    this.wrap(() => this.game.leave(id));
    this.afterChange();
  }

  sitIn(id) {
    this.wrap(() => this.game.sitIn(id));
    this.timeouts.set(id, 0);
    this.afterChange();
  }

  wrap(fn) {
    try { return fn(); }
    catch (e) { throw (e instanceof RoomError ? e : new RoomError(e.message)); }
  }

  // ---------- clocks ----------

  afterChange() {
    this.touch();
    clearTimeout(this.turnTimer);
    clearTimeout(this.nextHandTimer);
    this.turnTimer = this.nextHandTimer = null;
    this.turnDeadline = this.nextHandAt = null;

    if (!this.closed) {
      const g = this.game;
      if (g.isHandActive()) {
        this.turnDeadline = Date.now() + this.turnMs;
        this.turnTimer = setTimeout(() => this.onTurnTimeout(), this.turnMs);
        this.turnTimer.unref();
      } else if (g.phase === 'handover') {
        this.scheduleNextHand(this.handPauseMs);
      }
    }
    this.broadcast();
  }

  scheduleNextHand(ms) {
    this.nextHandAt = Date.now() + ms;
    this.nextHandTimer = setTimeout(() => this.startNextHand(), ms);
    this.nextHandTimer.unref();
  }

  startNextHand() {
    this.nextHandTimer = null;
    if (this.closed || this.game.phase !== 'handover') return;
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
    if (this.closed || !g.isHandActive()) return;
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

  state(id) {
    const s = this.game.getState(id, Date.now());
    s.code = this.code;
    s.hostId = this.hostId;
    s.you = id;
    s.turnMs = this.turnMs;
    s.startingStack = this.game.startingStack;
    s.levelMinutes = this.game.levelMs / 60000;
    s.turnDeadline = this.turnDeadline;
    s.nextHandAt = this.nextHandAt;
    s.serverTime = Date.now(); // lets browsers correct for clock differences
    s.waitingForPlayers = this.game.phase === 'handover'
      && this.game.players.filter(p => p.stack > 0 && !p.sittingOut).length < 2;
    s.players = s.players.map(p => ({ ...p, connected: this.clients.has(p.id) }));
    return s;
  }

  broadcast() {
    for (const [id, set] of this.clients) {
      const payload = 'data: ' + JSON.stringify(this.state(id)) + '\n\n';
      for (const res of set) {
        try { res.write(payload); } catch (e) { /* closed streams are cleaned up on 'close' */ }
      }
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
    clearTimeout(this.turnTimer);
    clearTimeout(this.nextHandTimer);
    for (const set of this.clients.values()) {
      for (const res of set) { try { res.end(); } catch (e) { /* ignore */ } }
    }
    this.clients.clear();
  }
}

module.exports = { Room, RoomError };
