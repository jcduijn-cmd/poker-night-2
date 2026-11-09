'use strict';
// Texas Hold'em tournament table: seating, blinds clock, antes, betting rounds,
// side pots, all-in run-outs, showdown, hand history and stats.
// Pure logic with no networking, so it is easy to test. Zero dependencies.

const crypto = require('crypto');
const E = require('./engine');

const BASE_STACK = 12500;       // the blind schedule below is written for this stack
const STARTING_STACK = 12500;
const LEVEL_MINUTES = 15;
// [smallBlind, bigBlind]. Past the end of the list the blinds double each level.
const BLIND_LEVELS = [
  [25, 50], [50, 100], [75, 150], [100, 200], [150, 300], [200, 400],
  [300, 600], [400, 800], [600, 1200], [800, 1600], [1000, 2000], [1500, 3000],
];
const ACTIVE_PHASES = ['preflop', 'flop', 'turn', 'river'];
const MAX_PLAYERS = 10;
const HISTORY_LIMIT = 300;

const nice = v => Math.max(5, Math.round(v / 5) * 5);

// factor scales the whole schedule when the host picks another starting stack.
function blindsForLevel(level, factor = 1) {
  let base;
  if (level < BLIND_LEVELS.length) base = BLIND_LEVELS[level];
  else {
    const last = BLIND_LEVELS[BLIND_LEVELS.length - 1];
    const f = Math.pow(2, level - BLIND_LEVELS.length + 1);
    base = [last[0] * f, last[1] * f];
  }
  if (factor === 1) return base;
  const sb = nice(base[0] * factor);
  return [sb, sb * 2];
}

// Everyone pays this before the cards are dealt, from level `fromLevel` on (0 = no antes).
function anteForLevel(level, factor, fromLevel) {
  if (!fromLevel || level + 1 < fromLevel) return 0;
  return nice(blindsForLevel(level, factor)[1] / 10);
}

class Game {
  constructor(opts = {}) {
    this.deckFn = opts.deckFn || (() => E.shuffle(E.newDeck())); // test hook: LAST card is dealt first
    this.equityEvals = opts.equityEvals || 100000; // work budget for win percentages: about 0.15s before the flop, exact after it
    this.players = [];
    this.started = false;
    this.configure(opts);

    this.clockStart = null;
    this.paused = false;
    this.pausedAt = null;
    this.endedAt = null;
    this.level = 0;
    this.handNumber = 0;
    this.dealer = -1;
    this.phase = 'lobby'; // lobby | preflop | flop | turn | river | runout | handover | finished
    this.board = [];
    this.deck = [];
    this.currentBet = 0;
    this.lastRaiseSize = 0;
    this.currentAnte = 0;
    this.toAct = -1;
    this.result = null;
    this.winner = null;
    this.equity = null;
    this.seatsDrawn = false;
    this.history = [];
    this.stats = { handsWon: {}, biggestPot: null, best: null, eliminations: [] };
  }

  // Settings can change until the first hand is dealt.
  configure(opts = {}) {
    if (this.started) throw new Error('The game has already started');
    if (opts.startingStack !== undefined || this.startingStack === undefined) this.startingStack = opts.startingStack || this.startingStack || STARTING_STACK;
    if (opts.levelMinutes !== undefined || this.levelMs === undefined) this.levelMs = (opts.levelMinutes || (this.levelMs ? this.levelMs / 60000 : LEVEL_MINUTES)) * 60000;
    if (opts.anteFromLevel !== undefined) this.anteFromLevel = opts.anteFromLevel;
    if (opts.lateRegLevel !== undefined) this.lateRegLevel = opts.lateRegLevel;
    this.anteFromLevel = this.anteFromLevel || 0;
    this.lateRegLevel = this.lateRegLevel || 0;
    this.factor = this.startingStack / BASE_STACK;
    for (const p of this.players) { p.stack = this.startingStack; p.startStack = this.startingStack; }
  }

  // ---------- seating ----------

  levelAt(now) {
    if (this.clockStart === null) return 0;
    const t = this.paused ? this.pausedAt : now;
    return Math.max(0, Math.floor((t - this.clockStart) / this.levelMs));
  }

  canJoin(now = Date.now()) {
    if (this.players.length >= MAX_PLAYERS) return false;
    if (!this.started) return true;
    if (this.phase === 'finished' || !this.lateRegLevel) return false;
    return this.levelAt(now) + 1 <= this.lateRegLevel;
  }

  addPlayer(id, name, now = Date.now()) {
    if (this.byId(id)) throw new Error('Player already seated');
    if (this.players.length >= MAX_PLAYERS) throw new Error('Table is full');
    if (!this.canJoin(now)) throw new Error('The game has already started, late joining is closed');
    this.players.push({
      id, name, stack: this.startingStack,
      hole: [], bet: 0, totalBet: 0, startStack: this.startingStack,
      inHand: false, folded: true, allIn: false,
      acted: false, canRaise: true, shown: [false, false],
      sittingOut: false, busted: false, place: null, knockedBy: null,
    });
  }

  byId(id) { return this.players.find(p => p.id === id); }

  // Random seating, like a real tournament draw. Only before the first hand.
  shuffleSeats() {
    if (this.started) return;
    const a = this.players;
    for (let i = a.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    this.seatsDrawn = true;
  }

  // Step away: you are folded out of the current hand and skipped in future hands.
  leave(id) {
    const p = this.byId(id);
    if (!p) throw new Error('Unknown player');
    p.sittingOut = true;
    if (this.isHandActive() && p.inHand && !p.folded) {
      if (this.players[this.toAct] === p) {
        this.act(id, 'fold');
      } else {
        p.folded = true;
        const n = this.players.length;
        this.progress((this.toAct - 1 + n) % n);
      }
    }
  }

  sitIn(id) {
    const p = this.byId(id);
    if (!p) throw new Error('Unknown player');
    p.sittingOut = false;
  }

  // ---------- pause (the blinds clock stops too) ----------

  pause(now = Date.now()) {
    if (!this.started || this.phase === 'finished') throw new Error('Nothing to pause');
    if (this.paused) throw new Error('The game is already paused');
    this.paused = true;
    this.pausedAt = now;
  }

  resume(now = Date.now()) {
    if (!this.paused) throw new Error('The game is not paused');
    this.clockStart += now - this.pausedAt;
    this.paused = false;
    this.pausedAt = null;
  }

  // ---------- blinds clock ----------

  updateLevel(now) { this.level = this.levelAt(now); }
  blinds() { return blindsForLevel(this.level, this.factor); }

  // ---------- helpers ----------

  isHandActive() { return ACTIVE_PHASES.includes(this.phase); }
  canAct(p) { return p.inHand && !p.folded && !p.allIn; }
  needsAction(p) { return this.canAct(p) && (!p.acted || p.bet < this.currentBet); }

  nextIdx(from, pred) {
    const n = this.players.length;
    for (let k = 1; k <= n; k++) {
      const i = (((from + k) % n) + n) % n;
      if (pred(this.players[i], i)) return i;
    }
    return -1;
  }

  pay(p, amount) {
    p.stack -= amount;
    p.bet += amount;
    p.totalBet += amount;
    if (p.stack === 0) p.allIn = true;
  }

  // ---------- starting a hand ----------

  startHand(now = Date.now()) {
    if (this.paused) throw new Error('The game is paused');
    if (this.isHandActive() || this.phase === 'runout') throw new Error('A hand is already in progress');
    if (this.phase === 'finished') throw new Error('The game is over');
    const ready = this.players.filter(p => p.stack > 0 && !p.sittingOut);
    if (ready.length < 2) throw new Error('Need at least 2 players with chips');

    if (!this.started) { this.started = true; this.clockStart = now; }
    this.updateLevel(now);
    this.handNumber++;
    this.board = [];
    this.deck = this.deckFn();
    this.result = null;
    this.equity = null;

    for (const p of this.players) {
      p.hole = [];
      p.bet = 0;
      p.totalBet = 0;
      p.allIn = false;
      p.acted = false;
      p.canRaise = true;
      p.shown = [false, false];
      p.inHand = p.stack > 0 && !p.sittingOut;
      p.folded = !p.inHand;
      p.startStack = p.stack;
    }

    // Antes: dead money in the pot before the blinds.
    this.currentAnte = anteForLevel(this.level, this.factor, this.anteFromLevel);
    if (this.currentAnte > 0) {
      for (const p of this.players) {
        if (!p.inHand) continue;
        const a = Math.min(this.currentAnte, p.stack);
        p.stack -= a;
        p.totalBet += a;
        if (p.stack === 0) p.allIn = true;
      }
    }

    const inHand = p => p.inHand;
    this.dealer = this.nextIdx(this.dealer, inHand);
    const headsUp = ready.length === 2;
    const sbIdx = headsUp ? this.dealer : this.nextIdx(this.dealer, inHand);
    const bbIdx = this.nextIdx(sbIdx, inHand);
    const [sb, bb] = this.blinds();
    this.pay(this.players[sbIdx], Math.min(sb, this.players[sbIdx].stack));
    this.pay(this.players[bbIdx], Math.min(bb, this.players[bbIdx].stack));
    this.currentBet = Math.max(...this.players.map(p => p.bet));
    this.lastRaiseSize = bb;

    // Deal two cards each, one at a time, starting left of the dealer.
    for (let round = 0; round < 2; round++) {
      let i = this.dealer;
      for (let k = 0; k < ready.length; k++) {
        i = this.nextIdx(i, inHand);
        this.players[i].hole.push(this.deck.pop());
      }
    }

    this.phase = 'preflop';
    this.progress(bbIdx);
  }

  // ---------- actions ----------

  getLegal(id) {
    if (!this.isHandActive() || this.paused) return null;
    const p = this.players[this.toAct];
    if (!p || p.id !== id) return null;
    const toCall = this.currentBet - p.bet;
    const max = p.bet + p.stack;
    const canRaise = p.canRaise && p.stack > toCall;
    return {
      toCall: Math.min(toCall, p.stack),
      canCheck: toCall === 0,
      canCall: toCall > 0,
      canRaise,
      raiseLabel: this.currentBet === 0 ? 'bet' : 'raise',
      minRaiseTo: canRaise ? Math.min(this.currentBet + this.lastRaiseSize, max) : null,
      maxRaiseTo: canRaise ? max : null,
    };
  }

  // action: 'fold' | 'check' | 'call' | 'raise' (amount = total to raise TO) | 'allin'
  act(id, action, amount) {
    if (this.paused) throw new Error('The game is paused');
    if (!this.isHandActive()) throw new Error('No hand in progress');
    const idx = this.toAct;
    const p = this.players[idx];
    if (!p || p.id !== id) throw new Error('Not your turn');
    const toCall = this.currentBet - p.bet;

    switch (action) {
      case 'fold':
        p.folded = true;
        break;
      case 'check':
        if (toCall > 0) throw new Error('You cannot check, there is a bet to call');
        break;
      case 'call':
        if (toCall <= 0) throw new Error('Nothing to call');
        this.pay(p, Math.min(toCall, p.stack));
        break;
      case 'raise':
        this.doRaise(p, amount);
        break;
      case 'allin':
        if (p.stack <= toCall) this.pay(p, p.stack);
        else this.doRaise(p, p.bet + p.stack);
        break;
      default:
        throw new Error('Unknown action: ' + action);
    }
    p.acted = true;
    this.progress(idx);
  }

  doRaise(p, raiseTo) {
    if (!Number.isInteger(raiseTo)) throw new Error('Raise amount must be a whole number');
    if (!p.canRaise) throw new Error('Betting was not reopened, you can only call or fold');
    const max = p.bet + p.stack;
    if (raiseTo > max) throw new Error('Not enough chips');
    if (raiseTo <= this.currentBet) throw new Error('A raise must be higher than the current bet');
    const minTo = this.currentBet + this.lastRaiseSize;
    if (raiseTo < minTo && raiseTo < max) throw new Error('Minimum raise is to ' + minTo);

    this.pay(p, raiseTo - p.bet);
    const full = raiseTo >= minTo;
    if (full) this.lastRaiseSize = raiseTo - this.currentBet;
    this.currentBet = raiseTo;

    for (const q of this.players) {
      if (q === p || !this.canAct(q)) continue;
      if (full) {
        q.acted = false;
        q.canRaise = true;
      } else {
        // Short all-in: players who already acted must respond, but cannot re-raise.
        if (q.acted) q.canRaise = false;
        q.acted = false;
      }
    }
  }

  // ---------- flow ----------

  roundComplete() {
    const actors = this.players.filter(p => this.canAct(p));
    if (actors.length === 0) return true;
    if (actors.length === 1) return actors[0].bet >= this.currentBet;
    return actors.every(p => p.acted && p.bet === this.currentBet);
  }

  progress(fromIdx) {
    for (;;) {
      const live = this.players.filter(p => p.inHand && !p.folded);
      if (live.length === 1) return this.endByFold(live[0]);
      if (!this.roundComplete()) {
        this.toAct = this.nextIdx(fromIdx, p => this.needsAction(p));
        return;
      }
      if (this.phase === 'river') return this.showdown();
      // Nobody left who can still bet: show the cards and deal the rest slowly.
      if (this.players.filter(p => this.canAct(p)).length <= 1) return this.startRunout();
      this.dealNextStreet();
      fromIdx = this.dealer;
    }
  }

  dealNextStreet() {
    for (const p of this.players) { p.bet = 0; p.acted = false; p.canRaise = true; }
    this.currentBet = 0;
    this.lastRaiseSize = this.blinds()[1];
    this.deck.pop(); // burn card
    if (this.phase === 'preflop') {
      this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
      this.phase = 'flop';
    } else if (this.phase === 'flop') {
      this.board.push(this.deck.pop());
      this.phase = 'turn';
    } else if (this.phase === 'turn') {
      this.board.push(this.deck.pop());
      this.phase = 'river';
    }
  }

  // ---------- all-in run-out: one card at a time, driven by the room's timers ----------

  startRunout() {
    for (const p of this.players) { p.bet = 0; p.acted = false; }
    this.currentBet = 0;
    this.toAct = -1;
    this.phase = 'runout';
    this.equity = this.computeEquity();
  }

  // Deals one card. After the river is out, the next call settles the hand.
  runoutStep() {
    if (this.phase !== 'runout') throw new Error('No run-out in progress');
    const n = this.board.length;
    if (n >= 5) { this.showdown(); return { done: true }; }
    if (n === 0 || n >= 3) this.deck.pop(); // burn before the flop, turn and river
    this.board.push(this.deck.pop());
    if (this.board.length >= 3) this.equity = this.computeEquity();
    return { done: false, cards: this.board.length };
  }

  computeEquity() {
    const live = this.players.filter(p => p.inHand && !p.folded);
    const raw = E.equity(live.map(p => ({ id: p.id, hole: p.hole })), this.board, this.equityEvals);
    const out = {};
    for (const id of Object.keys(raw)) out[id] = Math.round(raw[id]);
    return out;
  }

  // ---------- pots and results ----------

  // Main pot + side pots, built from what each player put in this hand.
  computePots() {
    const levels = [...new Set(
      this.players.filter(p => p.totalBet > 0 && !p.folded).map(p => p.totalBet)
    )].sort((a, b) => a - b);

    const pots = [];
    let prev = 0;
    let allocated = 0;
    for (const level of levels) {
      let amount = 0;
      for (const p of this.players) {
        amount += Math.min(p.totalBet, level) - Math.min(p.totalBet, prev);
      }
      const eligible = this.players.filter(p => !p.folded && p.totalBet >= level).map(p => p.id);
      const last = pots[pots.length - 1];
      if (last && last.eligible.join() === eligible.join()) last.amount += amount;
      else pots.push({ amount, eligible });
      allocated += amount;
      prev = level;
    }
    const total = this.players.reduce((s, p) => s + p.totalBet, 0);
    if (total > allocated && pots.length) pots[pots.length - 1].amount += total - allocated;
    return pots;
  }

  totalPot() { return this.players.reduce((s, p) => s + p.totalBet, 0); }

  endByFold(winner) {
    const total = this.totalPot();
    winner.stack += total;
    this.result = {
      type: 'fold',
      pots: [{ amount: total, winners: [winner.id], eligible: [winner.id] }],
      winnings: { [winner.id]: total },
      contested: { [winner.id]: total },
    };
    this.finishHand();
  }

  showdown() {
    const live = this.players.filter(p => p.inHand && !p.folded);
    const info = {};
    for (const p of live) info[p.id] = E.bestHand([...p.hole, ...this.board]);

    const n = this.players.length;
    // 0 = first seat left of the dealer ... n-1 = the dealer itself
    const seatOrder = id => (this.players.findIndex(p => p.id === id) - this.dealer - 1 + n) % n;
    const winnings = {};
    const contested = {}; // chips won from other players (not just a bet coming back)
    const potResults = [];

    for (const pot of this.computePots()) {
      let winners;
      if (pot.eligible.length === 1) winners = pot.eligible.slice();
      else {
        winners = E.findWinners(pot.eligible.map(id => ({
          id, cards: [...this.byId(id).hole, ...this.board],
        })));
      }
      // Odd chips go to the winner closest to the left of the dealer.
      winners.sort((a, b) => seatOrder(a) - seatOrder(b));
      const share = Math.floor(pot.amount / winners.length);
      let rest = pot.amount - share * winners.length;
      for (const id of winners) {
        const amt = share + (rest > 0 ? 1 : 0);
        if (rest > 0) rest--;
        this.byId(id).stack += amt;
        winnings[id] = (winnings[id] || 0) + amt;
        if (pot.eligible.length > 1) contested[id] = (contested[id] || 0) + amt;
      }
      potResults.push({ amount: pot.amount, eligible: pot.eligible, winners });
    }

    for (const p of live) {
      const best = info[p.id];
      if (!this.stats.best || best.score > this.stats.best.score) {
        this.stats.best = { score: best.score, playerId: p.id, name: p.name, handName: best.name, cards: best.cards, hand: this.handNumber };
      }
    }

    this.result = {
      type: 'showdown',
      board: this.board.slice(),
      hands: live.map(p => ({ id: p.id, hole: p.hole, name: info[p.id].name, best: info[p.id].cards })),
      pots: potResults,
      winnings,
      contested,
    };
    this.finishHand();
  }

  finishHand() {
    const r = this.result;
    const nameOf = id => (this.byId(id) || {}).name;

    // Hand history (hole cards are private; the room decides who sees what).
    const net = {};
    const holes = {};
    for (const p of this.players) {
      if (!p.inHand) continue;
      net[p.id] = (r.winnings[p.id] || 0) - p.totalBet;
      holes[p.id] = p.hole.slice();
    }
    const winners = Object.entries(r.contested).map(([id, amount]) => ({
      id, name: nameOf(id), amount,
      handName: r.type === 'showdown' ? ((r.hands.find(h => h.id === id) || {}).name || null) : null,
    }));
    const pot = this.totalPot();
    this.history.push({
      n: this.handNumber, level: this.level + 1, blinds: this.blinds(), ante: this.currentAnte,
      board: this.board.slice(), pot, type: r.type, winners, holes, net,
      revealed: r.type === 'showdown' ? Object.fromEntries(r.hands.map(h => [h.id, h.hole])) : {},
    });
    if (this.history.length > HISTORY_LIMIT) this.history.shift();

    for (const w of winners) this.stats.handsWon[w.id] = (this.stats.handsWon[w.id] || 0) + 1;
    if (!this.stats.biggestPot || pot > this.stats.biggestPot.amount) {
      const top = winners.slice().sort((a, b) => b.amount - a.amount)[0];
      this.stats.biggestPot = { amount: pot, hand: this.handNumber, names: winners.map(w => w.name), handName: top ? top.handName : null };
    }

    for (const p of this.players) p.bet = 0;
    this.phase = 'handover';
    this.toAct = -1;

    // Knock-outs: the shortest starting stack finishes lowest if several bust together.
    const nonBusted = this.players.filter(p => !p.busted).length;
    const out = this.players
      .filter(p => p.inHand && p.stack === 0)
      .sort((a, b) => a.startStack - b.startStack);
    out.forEach((p, i) => {
      p.busted = true;
      p.place = nonBusted - i;
      const by = Object.entries(r.contested).filter(([id]) => id !== p.id).sort((a, b) => b[1] - a[1])[0];
      p.knockedBy = by ? by[0] : null;
      this.stats.eliminations.push({ id: p.id, by: p.knockedBy, hand: this.handNumber });
    });

    const alive = this.players.filter(p => p.stack > 0);
    if (alive.length === 1) {
      alive[0].place = 1;
      this.winner = alive[0].id;
      this.phase = 'finished';
      this.endedAt = Date.now();
    }
  }

  // ---------- showing cards and looking ahead ----------

  // After a hand: any player who was dealt in may turn one or both cards face up for the table.
  showCards(id, which) {
    if (this.phase !== 'handover' && this.phase !== 'finished') throw new Error('You can only show cards after the hand is over');
    const p = this.byId(id);
    if (!p || !p.inHand || p.hole.length !== 2) throw new Error('You have no cards to show');
    if (this.result.type === 'showdown' && !p.folded) throw new Error('Your cards are already face up');
    const picks = which === 'left' ? [0] : which === 'right' ? [1] : which === 'both' ? [0, 1] : null;
    if (!picks) throw new Error('Choose left, right or both');
    for (const i of picks) p.shown[i] = true;
  }

  // Rabbit hunt: when a hand ended with everyone folding, peek at the cards that would have come.
  rabbitHunt(id) {
    if (this.phase !== 'handover' && this.phase !== 'finished') throw new Error('You can only look ahead after the hand is over');
    if (!this.byId(id)) throw new Error('Unknown player');
    if (!this.result || this.result.type !== 'fold') throw new Error('The hand went to a showdown, there is nothing to look ahead at');
    if (this.result.rabbit) throw new Error('The next cards were already revealed');
    if (this.board.length >= 5) throw new Error('The board was already complete');
    const d = this.deck.slice();
    const cards = [];
    for (let n = this.board.length; n < 5; n++) {
      if (n === 0 || n >= 3) d.pop(); // burn
      cards.push(d.pop());
    }
    this.result.rabbit = { cards, by: id };
  }

  // ---------- end of tournament ----------

  recap() {
    const nameOf = id => (this.byId(id) || {}).name || null;
    const standings = [...this.players]
      .sort((a, b) => (a.place || 99) - (b.place || 99))
      .map(p => ({ id: p.id, name: p.name, place: p.place, stack: p.stack, knockedBy: nameOf(p.knockedBy) }));
    const top = (counts) => {
      const e = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      return e ? { name: nameOf(e[0]), count: e[1] } : null;
    };
    const kos = {};
    for (const e of this.stats.eliminations) if (e.by) kos[e.by] = (kos[e.by] || 0) + 1;
    const best = this.stats.best;
    return {
      hands: this.handNumber,
      durationMs: this.endedAt && this.clockStart ? this.endedAt - this.clockStart : null,
      standings,
      biggestPot: this.stats.biggestPot,
      bestHand: best ? { name: best.name, handName: best.handName, cards: best.cards, hand: best.hand } : null,
      mostWins: top(this.stats.handsWon),
      mostKnockouts: top(kos),
    };
  }

  // ---------- what a player's browser gets to see ----------

  getState(forId, now = Date.now()) {
    const showCards = this.result && this.result.type === 'showdown';
    const t = this.paused ? this.pausedAt : now;
    let nextLevelAt = null;
    let nextBlinds = null;
    let levelRemainingMs = null;
    if (this.clockStart !== null) {
      const lv = Math.max(0, Math.floor((t - this.clockStart) / this.levelMs));
      nextLevelAt = this.clockStart + (lv + 1) * this.levelMs;
      levelRemainingMs = nextLevelAt - t;
      nextBlinds = blindsForLevel(lv + 1, this.factor);
    }
    return {
      phase: this.phase,
      paused: this.paused,
      handNumber: this.handNumber,
      level: this.level + 1,
      blinds: this.started ? this.blinds() : blindsForLevel(0, this.factor),
      ante: this.currentAnte,
      nextBlinds,
      nextLevelAt,
      levelRemainingMs,
      board: this.board,
      pot: this.totalPot(),
      pots: this.isHandActive() || this.phase === 'runout' ? this.computePots() : [],
      currentBet: this.currentBet,
      toAct: this.isHandActive() && this.players[this.toAct] ? this.players[this.toAct].id : null,
      legal: this.getLegal(forId),
      equity: this.phase === 'runout' ? this.equity : null,
      result: this.result,
      winner: this.winner,
      lateRegOpen: this.started && this.canJoin(now),
      seatsDrawn: this.seatsDrawn,
      recap: this.phase === 'finished' ? this.recap() : null,
      players: this.players.map((p, i) => {
        const reveal = (showCards || this.phase === 'runout') && p.inHand && !p.folded;
        let hole = null;
        if (p.id === forId || reveal) hole = p.hole;
        else if (p.shown[0] || p.shown[1]) hole = p.hole.map((c, k) => (p.shown[k] ? c : null));
        return {
          id: p.id, name: p.name, stack: p.stack, bet: p.bet,
          folded: p.folded, allIn: p.allIn, inHand: p.inHand,
          sittingOut: p.sittingOut, busted: p.busted, place: p.place,
          isDealer: i === this.dealer,
          hasCards: p.hole.length > 0 && !p.folded,
          shown: p.shown.slice(),
          hole,
        };
      }),
    };
  }
}

module.exports = {
  Game, BLIND_LEVELS, blindsForLevel, anteForLevel, STARTING_STACK, LEVEL_MINUTES, MAX_PLAYERS, BASE_STACK,
};
