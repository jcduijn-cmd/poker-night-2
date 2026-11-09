'use strict';
// Texas Hold'em tournament table: seating, blinds clock, betting rounds, side pots, showdown.
// Pure logic with no networking, so it is easy to test. Zero dependencies.

const E = require('./engine');

const STARTING_STACK = 12500;
const LEVEL_MINUTES = 15;
// [smallBlind, bigBlind]. Past the end of the list the blinds double each level.
const BLIND_LEVELS = [
  [25, 50], [50, 100], [75, 150], [100, 200], [150, 300], [200, 400],
  [300, 600], [400, 800], [600, 1200], [800, 1600], [1000, 2000], [1500, 3000],
];
const ACTIVE_PHASES = ['preflop', 'flop', 'turn', 'river'];
const MAX_PLAYERS = 10;

function blindsForLevel(level) {
  if (level < BLIND_LEVELS.length) return BLIND_LEVELS[level];
  const last = BLIND_LEVELS[BLIND_LEVELS.length - 1];
  const f = Math.pow(2, level - BLIND_LEVELS.length + 1);
  return [last[0] * f, last[1] * f];
}

class Game {
  constructor(opts = {}) {
    this.startingStack = opts.startingStack || STARTING_STACK;
    this.levelMs = (opts.levelMinutes || LEVEL_MINUTES) * 60000;
    // Test hook: returns a deck array whose LAST element is dealt first.
    this.deckFn = opts.deckFn || (() => E.shuffle(E.newDeck()));

    this.players = [];
    this.started = false;
    this.clockStart = null;
    this.level = 0;
    this.handNumber = 0;
    this.dealer = -1;
    this.phase = 'lobby'; // lobby | preflop | flop | turn | river | handover | finished
    this.board = [];
    this.deck = [];
    this.currentBet = 0;
    this.lastRaiseSize = 0;
    this.toAct = -1;
    this.result = null;
    this.winner = null;
  }

  // ---------- seating ----------

  addPlayer(id, name) {
    if (this.started) throw new Error('The game has already started');
    if (this.players.length >= MAX_PLAYERS) throw new Error('Table is full');
    if (this.byId(id)) throw new Error('Player already seated');
    this.players.push({
      id, name, stack: this.startingStack,
      hole: [], bet: 0, totalBet: 0, startStack: this.startingStack,
      inHand: false, folded: true, allIn: false,
      acted: false, canRaise: true,
      sittingOut: false, busted: false, place: null,
    });
  }

  byId(id) { return this.players.find(p => p.id === id); }

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

  // ---------- blinds clock ----------

  updateLevel(now) {
    this.level = Math.max(0, Math.floor((now - this.clockStart) / this.levelMs));
  }

  blinds() { return blindsForLevel(this.level); }

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
    if (this.isHandActive()) throw new Error('A hand is already in progress');
    if (this.phase === 'finished') throw new Error('The game is over');
    const ready = this.players.filter(p => p.stack > 0 && !p.sittingOut);
    if (ready.length < 2) throw new Error('Need at least 2 players with chips');

    if (!this.started) { this.started = true; this.clockStart = now; }
    this.updateLevel(now);
    this.handNumber++;
    this.board = [];
    this.deck = this.deckFn();
    this.result = null;

    for (const p of this.players) {
      p.hole = [];
      p.bet = 0;
      p.totalBet = 0;
      p.allIn = false;
      p.acted = false;
      p.canRaise = true;
      p.inHand = p.stack > 0 && !p.sittingOut;
      p.folded = !p.inHand;
      p.startStack = p.stack;
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
    if (!this.isHandActive()) return null;
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
      pots: [{ amount: total, winners: [winner.id] }],
      winnings: { [winner.id]: total },
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
      }
      potResults.push({ amount: pot.amount, eligible: pot.eligible, winners });
    }

    this.result = {
      type: 'showdown',
      board: this.board.slice(),
      hands: live.map(p => ({ id: p.id, hole: p.hole, name: info[p.id].name, best: info[p.id].cards })),
      pots: potResults,
      winnings,
    };
    this.finishHand();
  }

  finishHand() {
    for (const p of this.players) p.bet = 0;
    this.phase = 'handover';
    this.toAct = -1;

    // Knock-outs: the shortest starting stack finishes lowest if several bust together.
    const nonBusted = this.players.filter(p => !p.busted).length;
    const out = this.players
      .filter(p => p.inHand && p.stack === 0)
      .sort((a, b) => a.startStack - b.startStack);
    out.forEach((p, i) => { p.busted = true; p.place = nonBusted - i; });

    const alive = this.players.filter(p => p.stack > 0);
    if (alive.length === 1) {
      alive[0].place = 1;
      this.winner = alive[0].id;
      this.phase = 'finished';
    }
  }

  // ---------- what a player's browser gets to see ----------

  getState(forId, now = Date.now()) {
    const showCards = this.result && this.result.type === 'showdown';
    let nextLevelAt = null;
    let nextBlinds = null;
    if (this.clockStart !== null) {
      const lv = Math.max(0, Math.floor((now - this.clockStart) / this.levelMs));
      nextLevelAt = this.clockStart + (lv + 1) * this.levelMs;
      nextBlinds = blindsForLevel(lv + 1);
    }
    return {
      phase: this.phase,
      handNumber: this.handNumber,
      level: this.level + 1,
      blinds: this.started ? this.blinds() : blindsForLevel(0),
      nextBlinds,
      nextLevelAt,
      board: this.board,
      pot: this.totalPot(),
      pots: this.isHandActive() ? this.computePots() : [],
      currentBet: this.currentBet,
      toAct: this.isHandActive() && this.players[this.toAct] ? this.players[this.toAct].id : null,
      legal: this.getLegal(forId),
      result: this.result,
      winner: this.winner,
      players: this.players.map((p, i) => {
        const reveal = showCards && p.inHand && !p.folded;
        return {
          id: p.id, name: p.name, stack: p.stack, bet: p.bet,
          folded: p.folded, allIn: p.allIn, inHand: p.inHand,
          sittingOut: p.sittingOut, busted: p.busted, place: p.place,
          isDealer: i === this.dealer,
          hasCards: p.hole.length > 0 && !p.folded,
          hole: (p.id === forId || reveal) ? p.hole : null,
        };
      }),
    };
  }
}

module.exports = { Game, BLIND_LEVELS, blindsForLevel, STARTING_STACK, LEVEL_MINUTES };
