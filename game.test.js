'use strict';
const assert = require('assert');
const E = require('./engine');
const { Game, blindsForLevel } = require('./game');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
}

// ---------- helpers ----------

function mk(ids, opts) {
  const g = new Game(opts);
  for (const id of ids) g.addPlayer(id, 'Player ' + id);
  return g;
}
const P = (g, id) => g.byId(id);
const toActId = g => g.players[g.toAct].id;

// Rig the next deal. holeBySeat: { seatIndex: 'As Kd' }, board: 'a b c d e'.
// Only valid when you know the dealer seat for that hand (first hand: seat 0).
function rig(g, dealerIdx, holeBySeat, board) {
  const n = g.players.length;
  const order = [];
  for (let k = 1; k <= n; k++) {
    const i = (dealerIdx + k) % n;
    if (holeBySeat[i]) order.push(i);
  }
  const hole = {};
  for (const i of Object.keys(holeBySeat)) hole[i] = E.parseCards(holeBySeat[i]);
  const b = E.parseCards(board);
  const used = new Set([...Object.values(hole).flat(), ...b].map(E.cardToString));
  const spare = E.newDeck().filter(c => !used.has(E.cardToString(c)));
  const burn = () => spare.pop();
  const dealt = [];
  for (const r of [0, 1]) for (const i of order) dealt.push(hole[i][r]);
  dealt.push(burn(), b[0], b[1], b[2], burn(), b[3], burn(), b[4]);
  const deck = [...spare, ...dealt.slice().reverse()];
  g.deckFn = () => deck.slice();
}

function checkDown(g) {
  while (g.isHandActive()) g.act(toActId(g), 'check');
}
// An all-in hand deals the rest of the board one card at a time; this plays that out at once.
function settle(g) {
  assert.strictEqual(g.phase, 'runout');
  while (g.phase === 'runout') g.runoutStep();
}
const chips = g => g.players.reduce((s, p) => s + p.stack, 0);

// ---------- blinds & order of action ----------

test('heads-up: dealer posts small blind and acts first; fold hands over the blinds', () => {
  const g = mk(['A', 'B']);
  g.startHand(0);
  assert.strictEqual(g.phase, 'preflop');
  assert.strictEqual(toActId(g), 'A');
  assert.strictEqual(P(g, 'A').bet, 25);
  assert.strictEqual(P(g, 'B').bet, 50);
  g.act('A', 'fold');
  assert.strictEqual(g.phase, 'handover');
  assert.strictEqual(P(g, 'A').stack, 12475);
  assert.strictEqual(P(g, 'B').stack, 12525);
  assert.strictEqual(g.result.type, 'fold');
});

test('3 players: UTG (the dealer) acts first, then small blind, then big blind', () => {
  const g = mk(['A', 'B', 'C']);
  g.startHand(0);
  assert.strictEqual(P(g, 'B').bet, 25); // small blind
  assert.strictEqual(P(g, 'C').bet, 50); // big blind
  assert.strictEqual(toActId(g), 'A');
  g.act('A', 'call');
  assert.strictEqual(toActId(g), 'B');
  g.act('B', 'call');
  assert.strictEqual(toActId(g), 'C'); // big blind still gets the option
  assert.strictEqual(g.getLegal('C').canCheck, true);
});

test('dealer button moves one seat each hand', () => {
  const g = mk(['A', 'B', 'C']);
  g.startHand(0);
  assert.strictEqual(g.dealer, 0);
  g.act('A', 'fold'); g.act('B', 'fold');
  g.startHand(1000);
  assert.strictEqual(g.dealer, 1);
});

test('full hand to showdown with a rigged deck pays the right winner', () => {
  const g = mk(['A', 'B', 'C']);
  rig(g, 0, { 0: 'Ah Kh', 1: '2c 2d', 2: '9s 9d' }, 'Ac Kd 7s 4h 3d');
  g.startHand(0);
  g.act('A', 'call'); g.act('B', 'call'); g.act('C', 'check');
  assert.strictEqual(g.phase, 'flop');
  assert.strictEqual(g.board.length, 3);
  assert.strictEqual(toActId(g), 'B'); // first active seat left of the dealer
  checkDown(g);
  assert.strictEqual(g.phase, 'handover');
  assert.strictEqual(g.board.length, 5);
  assert.strictEqual(P(g, 'A').stack, 12600);
  assert.strictEqual(P(g, 'B').stack, 12450);
  assert.strictEqual(P(g, 'C').stack, 12450);
  assert.deepStrictEqual(g.result.pots[0].winners, ['A']);
  assert.ok(g.result.hands.find(h => h.id === 'A').name === 'Two Pair');
});

// ---------- raise rules ----------

test('minimum raise is enforced and grows with each raise', () => {
  const g = mk(['A', 'B', 'C']);
  g.startHand(0);
  assert.throws(() => g.act('A', 'raise', 75), /Minimum raise/);
  assert.throws(() => g.act('A', 'check'), /cannot check/);
  g.act('A', 'raise', 150); // raise of 100
  assert.throws(() => g.act('B', 'raise', 200), /Minimum raise is to 250/);
  g.act('B', 'raise', 250);
  assert.strictEqual(g.getLegal('C').minRaiseTo, 350);
});

test('acting out of turn is rejected', () => {
  const g = mk(['A', 'B', 'C']);
  g.startHand(0);
  assert.throws(() => g.act('B', 'call'), /Not your turn/);
});

test('a short all-in raise does not reopen the betting for players who already acted', () => {
  const g = mk(['A', 'B', 'C']);
  P(g, 'C').stack = 300; // short big blind
  g.startHand(0);
  g.act('A', 'raise', 200);
  g.act('B', 'call');
  g.act('C', 'allin'); // to 300: less than a full raise (min would be 350)
  assert.strictEqual(P(g, 'C').allIn, true);
  assert.strictEqual(toActId(g), 'A');
  assert.throws(() => g.act('A', 'raise', 1000), /not reopened/);
  g.act('A', 'call');
  g.act('B', 'call');
  assert.strictEqual(g.phase, 'flop');
});

test('a full raise does reopen the betting', () => {
  const g = mk(['A', 'B', 'C']);
  g.startHand(0);
  g.act('A', 'call');
  g.act('B', 'call');
  g.act('C', 'raise', 200);
  assert.strictEqual(toActId(g), 'A');
  g.act('A', 'raise', 500); // allowed: A can re-raise after a full raise
  assert.strictEqual(P(g, 'A').bet, 500);
});

// ---------- all-ins and side pots ----------

test('side pots: three different stacks all-in, each pot goes to the right player', () => {
  const g = mk(['A', 'B', 'C']);
  P(g, 'A').stack = 500;
  P(g, 'B').stack = 1500;
  P(g, 'C').stack = 3000;
  rig(g, 0, { 0: 'Ah Ad', 1: 'Kh Kd', 2: 'Qh Qd' }, '2c 7d 9h Js 3c');
  g.startHand(0);
  g.act('A', 'allin');
  g.act('B', 'allin');
  g.act('C', 'call');
  // everyone is all-in or matched, so the board runs out by itself
  settle(g);
  assert.strictEqual(g.phase, 'handover');
  assert.strictEqual(g.board.length, 5);
  assert.strictEqual(P(g, 'A').stack, 1500); // main pot: 3 x 500
  assert.strictEqual(P(g, 'B').stack, 2000); // side pot: 2 x 1000
  assert.strictEqual(P(g, 'C').stack, 1500); // uncalled chips stay with C
  assert.strictEqual(g.result.pots.length, 2);
  assert.strictEqual(chips(g), 5000);
  assert.ok(P(g, 'A').stack > 0 && P(g, 'C').busted === false);
});

test('a bigger stack that is not called gets the extra chips back', () => {
  const g = mk(['A', 'B']);
  P(g, 'B').stack = 1000;
  rig(g, 0, { 0: 'Ah Ad', 1: 'Kh Kd' }, '2c 7d 9h Js 3c');
  g.startHand(0);
  g.act('A', 'allin');          // A jams 12,500
  g.act('B', 'call');           // B only has 1,000 total
  settle(g);
  assert.strictEqual(g.phase, 'finished'); // B is knocked out, A wins the game
  assert.strictEqual(P(g, 'A').stack, 13500);
  assert.strictEqual(P(g, 'B').stack, 0);
  assert.strictEqual(chips(g), 13500);
});

test('split pot: board plays, odd chip goes to the winner left of the dealer', () => {
  const g = mk(['A', 'B', 'C']);
  rig(g, 0, { 0: '2c 3d', 1: '4c 5d', 2: '6c 7d' }, 'Ts Js Qs Ks As'); // royal flush on board
  g.startHand(0);
  g.act('A', 'call');
  g.act('B', 'fold');   // B loses the small blind, pot = 50 + 25 + 50 = 125
  g.act('C', 'check');
  checkDown(g);
  assert.strictEqual(P(g, 'C').stack, 12500 - 50 + 63); // extra chip: first winner left of dealer
  assert.strictEqual(P(g, 'A').stack, 12500 - 50 + 62);
  assert.strictEqual(P(g, 'B').stack, 12475);
  assert.strictEqual(chips(g), 37500);
});

test('everyone but one folds to a bet: winner takes the pot without showing cards', () => {
  const g = mk(['A', 'B', 'C']);
  g.startHand(0);
  g.act('A', 'raise', 200);
  g.act('B', 'fold');
  g.act('C', 'fold');
  assert.strictEqual(g.phase, 'handover');
  assert.strictEqual(P(g, 'A').stack, 12500 + 75);
  const view = g.getState('B');
  assert.strictEqual(view.players.find(p => p.id === 'A').hole, null); // not revealed
});

// ---------- visibility ----------

test('players only see their own hole cards during a hand', () => {
  const g = mk(['A', 'B']);
  g.startHand(0);
  const viewA = g.getState('A');
  assert.strictEqual(viewA.players.find(p => p.id === 'A').hole.length, 2);
  assert.strictEqual(viewA.players.find(p => p.id === 'B').hole, null);
  assert.ok(viewA.legal && viewA.legal.canCall);
  assert.strictEqual(g.getState('B').legal, null); // not B's turn
});

test('showdown reveals the cards of players still in the hand', () => {
  const g = mk(['A', 'B']);
  g.startHand(0);
  g.act('A', 'call');
  g.act('B', 'check');
  checkDown(g);
  const viewA = g.getState('A');
  assert.strictEqual(viewA.players.find(p => p.id === 'B').hole.length, 2);
});

// ---------- blinds clock ----------

test('blind levels follow the 15 minute clock and apply from the next hand', () => {
  const g = mk(['A', 'B']);
  const fold = () => g.act(toActId(g), 'fold');
  const posted = () => g.players.reduce((s, p) => s + p.totalBet, 0);

  g.startHand(0); assert.strictEqual(posted(), 75); fold();           // 25/50
  g.startHand(15 * 60000 - 1); assert.strictEqual(posted(), 75); fold();
  g.startHand(15 * 60000); assert.strictEqual(posted(), 150); fold(); // 50/100
  g.startHand(30 * 60000); assert.strictEqual(posted(), 225); fold(); // 75/150
  g.startHand(165 * 60000); assert.strictEqual(posted(), 4500); fold(); // level 12 (1500/3000) starts at 2:45
});

test('blind schedule matches the agreed levels and doubles after the last one', () => {
  assert.deepStrictEqual(blindsForLevel(0), [25, 50]);
  assert.deepStrictEqual(blindsForLevel(5), [200, 400]);
  assert.deepStrictEqual(blindsForLevel(11), [1500, 3000]);
  assert.deepStrictEqual(blindsForLevel(12), [3000, 6000]);
  assert.deepStrictEqual(blindsForLevel(13), [6000, 12000]);
});

test('state exposes the countdown to the next level', () => {
  const g = mk(['A', 'B']);
  g.startHand(1000);
  const s = g.getState('A', 1000 + 5 * 60000);
  assert.strictEqual(s.nextLevelAt, 1000 + 15 * 60000);
  assert.deepStrictEqual(s.nextBlinds, [50, 100]);
  assert.deepStrictEqual(s.blinds, [25, 50]);
});

// ---------- tournament flow ----------

test('knock-out: loser gets 2nd place and the game finishes', () => {
  const g = mk(['A', 'B']);
  rig(g, 0, { 0: 'As Ad', 1: 'Kc Kd' }, '2c 7d 9h Js 3c');
  g.startHand(0);
  g.act('A', 'allin');
  g.act('B', 'call');
  settle(g);
  assert.strictEqual(g.phase, 'finished');
  assert.strictEqual(g.winner, 'A');
  assert.strictEqual(P(g, 'A').place, 1);
  assert.strictEqual(P(g, 'B').place, 2);
  assert.strictEqual(P(g, 'A').stack, 25000);
  assert.throws(() => g.startHand(1), /over/);
});

test('cannot start with fewer than 2 players, or join after the game started', () => {
  const g = mk(['A']);
  assert.throws(() => g.startHand(0), /at least 2/);
  g.addPlayer('B', 'B');
  g.startHand(0);
  assert.throws(() => g.addPlayer('C', 'C'), /already started/);
});

test('leaving mid-hand folds you; you are skipped in later hands', () => {
  const g = mk(['A', 'B', 'C']);
  g.startHand(0);
  g.leave('B'); // not B's turn yet (A acts first)
  assert.strictEqual(P(g, 'B').folded, true);
  g.act('A', 'call');
  assert.strictEqual(toActId(g), 'C');
  g.act('C', 'check');
  checkDown(g);
  g.startHand(1000);
  assert.strictEqual(P(g, 'B').inHand, false);
  assert.strictEqual(g.players.filter(p => p.inHand).length, 2);
});

// ---------- fuzz: random play must never lose or create chips ----------

test('fuzz: 200 random tournaments keep chips constant, finish, and rank everyone', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

  for (let game = 0; game < 200; game++) {
    const n = 2 + Math.floor(rnd() * 7);
    const ids = Array.from({ length: n }, (_, i) => 'p' + i);
    const g = mk(ids, { equityEvals: 3000, anteFromLevel: game % 2 ? 1 : 0 }); // odd games play with antes
    const total = n * g.startingStack;
    let now = 0;
    let hands = 0;

    while (g.phase !== 'finished') {
      if (++hands > 4000) throw new Error('tournament did not finish');
      now += 4 * 60000; // blinds rise as time passes, so tournaments always end
      g.startHand(now);
      let steps = 0;
      while (g.isHandActive()) {
        if (++steps > 500) throw new Error('hand did not finish');
        const id = toActId(g);
        const la = g.getLegal(id);
        const r = rnd();
        if (la.canCheck) {
          if (r < 0.55) g.act(id, 'check');
          else if (la.canRaise && r < 0.9) g.act(id, 'raise', la.minRaiseTo + Math.floor(rnd() * (la.maxRaiseTo - la.minRaiseTo + 1)));
          else if (la.canRaise) g.act(id, 'allin');
          else g.act(id, 'check');
        } else {
          if (r < 0.15) g.act(id, 'fold');
          else if (r < 0.65) g.act(id, 'call');
          else if (la.canRaise && r < 0.93) g.act(id, 'raise', la.minRaiseTo + Math.floor(rnd() * (la.maxRaiseTo - la.minRaiseTo + 1)));
          else if (la.canRaise) g.act(id, 'allin');
          else g.act(id, 'call');
        }
        const inPlay = g.players.reduce((s, p) => s + p.stack + (g.isHandActive() || g.phase === 'runout' ? p.totalBet : 0), 0);
        assert.strictEqual(inPlay, total, 'chips changed during a hand');
        assert.ok(g.players.every(p => p.stack >= 0), 'negative stack');
      }
      while (g.phase === 'runout') {
        g.runoutStep();
        const inPlay = g.players.reduce((s, p) => s + p.stack + (g.phase === 'runout' ? p.totalBet : 0), 0);
        assert.strictEqual(inPlay, total, 'chips changed during a run-out');
      }
      assert.strictEqual(chips(g), total, 'chips changed after a hand');
    }

    const places = g.players.map(p => p.place).sort((a, b) => a - b);
    assert.deepStrictEqual(places, Array.from({ length: n }, (_, i) => i + 1));
    assert.strictEqual(P(g, g.winner).stack, total);
  }
});

// ---------- antes, settings, pause, late joining, seating ----------

const { anteForLevel } = require('./game');

test('antes: everyone pays before the blinds, the pot holds the dead money, chips are conserved', () => {
  const g = mk(['A', 'B', 'C'], { anteFromLevel: 1 });
  g.startHand(0);
  assert.strictEqual(g.currentAnte, 5);              // a tenth of the 50 big blind
  assert.strictEqual(g.totalPot(), 15 + 75);
  assert.strictEqual(P(g, 'A').stack, 12495);        // dealer: ante only
  assert.strictEqual(P(g, 'B').stack, 12470);        // small blind + ante
  assert.strictEqual(P(g, 'A').bet, 0);              // the ante is not part of the bet to call
  assert.strictEqual(g.getLegal('A').toCall, 50);
  g.act('A', 'fold'); g.act('B', 'fold');
  assert.strictEqual(P(g, 'C').stack, 12500 - 5 - 50 + 90, 'big blind pays ante + blind and wins the whole 90 pot');
  assert.strictEqual(chips(g), 37500);
});

test('antes switch on at the chosen level and grow with the blinds', () => {
  assert.strictEqual(anteForLevel(0, 1, 3), 0);
  assert.strictEqual(anteForLevel(1, 1, 3), 0);
  assert.strictEqual(anteForLevel(2, 1, 3), 15);     // level 3 is 75/150
  assert.strictEqual(anteForLevel(5, 1, 3), 40);     // 200/400
  assert.strictEqual(anteForLevel(5, 1, 0), 0);      // off
});

test('a short stack can go all in on the ante alone and the hand still resolves', () => {
  const g = mk(['A', 'B', 'C'], { anteFromLevel: 1 });
  P(g, 'A').stack = 3;
  rig(g, 0, { 0: 'Ah Ad', 1: '2c 3d', 2: '7s 8s' }, 'As Ks Qs 4h 9d');
  g.startHand(0);
  assert.strictEqual(P(g, 'A').allIn, true);
  g.act('B', 'fold');                // A is the dealer and cannot act, small blind folds
  assert.ok(['handover', 'runout', 'preflop'].includes(g.phase));
  while (g.isHandActive()) g.act(toActId(g), 'check');
  while (g.phase === 'runout') g.runoutStep();
  assert.strictEqual(chips(g), 3 + 25000);
});

test('host settings: another starting stack scales the blinds and resets the stacks', () => {
  const g = mk(['A', 'B']);
  g.configure({ startingStack: 5000, levelMinutes: 10, anteFromLevel: 4, lateRegLevel: 2 });
  assert.strictEqual(P(g, 'A').stack, 5000);
  assert.deepStrictEqual(g.blinds(), [10, 20]);
  g.startHand(0);
  assert.strictEqual(g.totalPot(), 30);
  assert.throws(() => g.configure({ startingStack: 1000 }), /already started/);
  assert.deepStrictEqual(blindsForLevel(2, 0.4), [30, 60]);
  assert.deepStrictEqual(blindsForLevel(0, 4), [100, 200]);
});

test('pause freezes the action and the blinds clock', () => {
  const g = mk(['A', 'B']);
  g.startHand(0);
  g.pause(10 * 60000);
  assert.throws(() => g.act('A', 'call'), /paused/);
  assert.strictEqual(g.getLegal('A'), null);
  assert.strictEqual(g.getState('A', 30 * 60000).levelRemainingMs, 5 * 60000); // frozen at the moment of pausing
  assert.throws(() => g.pause(11 * 60000), /already paused/);
  g.resume(40 * 60000);                         // 30 minutes of pause
  assert.strictEqual(g.levelAt(40 * 60000), 0); // still level 1: only 10 playing minutes have passed
  assert.strictEqual(g.getState('A', 40 * 60000).levelRemainingMs, 5 * 60000);
  g.act('A', 'call');                           // play continues
  assert.throws(() => g.resume(41 * 60000), /not paused/);
});

test('late joining: allowed through the chosen level, dealt in from the next hand', () => {
  const g = mk(['A', 'B', 'C'], { lateRegLevel: 2 });
  g.startHand(0);
  assert.ok(g.canJoin(14 * 60000));
  g.addPlayer('D', 'Player D', 14 * 60000);       // joins while a hand is running
  assert.strictEqual(P(g, 'D').inHand, false);
  assert.strictEqual(P(g, 'D').stack, 12500);
  g.act('A', 'fold'); g.act('B', 'fold');
  g.startHand(15 * 60000);                        // second level, still open
  assert.strictEqual(P(g, 'D').inHand, true);
  assert.strictEqual(P(g, 'D').hole.length, 2);
  assert.throws(() => g.addPlayer('E', 'Player E', 30 * 60000), /late joining is closed/);
  assert.strictEqual(g.getState('A', 14 * 60000).lateRegOpen, true);
  assert.strictEqual(g.getState('A', 31 * 60000).lateRegOpen, false);
});

test('late joining is off unless the host turns it on', () => {
  const g = mk(['A', 'B']);
  g.startHand(0);
  assert.throws(() => g.addPlayer('C', 'C', 1000), /already started/);
});

test('the seat draw is a real shuffle of the same players', () => {
  const orders = new Set();
  for (let i = 0; i < 30; i++) {
    const g = mk(['A', 'B', 'C', 'D', 'E', 'F']);
    g.shuffleSeats();
    assert.deepStrictEqual(g.players.map(p => p.id).sort(), ['A', 'B', 'C', 'D', 'E', 'F']);
    assert.strictEqual(g.seatsDrawn, true);
    orders.add(g.players.map(p => p.id).join(''));
  }
  assert.ok(orders.size > 5, 'only ' + orders.size + ' different orders in 30 draws');
  const g = mk(['A', 'B', 'C']); g.startHand(0); g.shuffleSeats(); // no effect once started
  assert.strictEqual(g.seatsDrawn, false);
});

// ---------- all-in run-out ----------

function allInHeadsUp() {
  const g = mk(['A', 'B']);
  rig(g, 0, { 0: 'Ah Ad', 1: 'Kh Kd' }, '2c 7d 9h Js 3c');
  g.startHand(0);
  g.act('A', 'allin');
  g.act('B', 'call');
  return g;
}

test('run-out: hands turn face up, the board comes one card at a time, then the showdown', () => {
  const g = allInHeadsUp();
  assert.strictEqual(g.phase, 'runout');
  assert.strictEqual(g.board.length, 0);
  assert.strictEqual(g.getLegal('A'), null);

  const view = g.getState('A');
  assert.strictEqual(view.phase, 'runout');
  assert.strictEqual(view.players.find(p => p.id === 'B').hole.length, 2); // opponent's cards are face up now
  assert.ok(view.equity.A > 78 && view.equity.A < 86, 'AA vs KK is about 82%: ' + view.equity.A);
  assert.ok(Math.abs(view.equity.A + view.equity.B - 100) <= 1);

  const seen = [];
  for (let i = 1; i <= 5; i++) {
    g.runoutStep();
    const s = g.getState('A');
    assert.strictEqual(s.board.length, i);
    assert.strictEqual(JSON.stringify(s).includes(E.cardToString(E.parseCards('3c')[0]) + '"'), false); // never leaks unseen cards as strings
    seen.push(s.board.map(E.cardToString).join(' '));
  }
  assert.strictEqual(seen[4], '2c 7d 9h Js 3c');
  assert.strictEqual(g.phase, 'runout');          // the river is out, the result comes with the next step
  assert.strictEqual(g.getState('A').equity.A, 100);
  const res = g.runoutStep();
  assert.strictEqual(res.done, true);
  assert.notStrictEqual(g.phase, 'runout');
  assert.strictEqual(g.result.type, 'showdown');
  assert.deepStrictEqual(g.result.pots[0].winners, ['A']);
});

test('run-out: undealt board cards are not in anything a browser receives', () => {
  const g = allInHeadsUp();
  g.runoutStep(); g.runoutStep();                 // two flop cards are out
  const json = JSON.stringify(g.getState('A'));
  assert.ok(!json.includes('"r":11,"s":"s"'), 'Js (a later card) was leaked');
  assert.ok(!json.includes('"r":3,"s":"c"'), '3c (a later card) was leaked');
});

test('run-out starts when only one player can still bet; an all-in on the river goes straight to showdown', () => {
  const g = mk(['A', 'B']);
  rig(g, 0, { 0: 'Ah Ad', 1: 'Kh Kd' }, '2c 7d 9h Js 3c');
  g.startHand(0);
  g.act('A', 'call'); g.act('B', 'check');                    // flop
  g.act('B', 'check'); g.act('A', 'check');                   // turn
  g.act('B', 'check'); g.act('A', 'check');                   // river
  g.act('B', 'raise', 12000);
  g.act('A', 'call');
  assert.notStrictEqual(g.phase, 'runout');                   // nothing left to deal
  assert.strictEqual(g.result.type, 'showdown');
});

test('run-out: a player with chips left cannot act but the all-in player gets the cards slowly', () => {
  const g = mk(['A', 'B']);
  P(g, 'B').stack = 1000;
  rig(g, 0, { 0: 'Kh Kd', 1: 'Ah Ad' }, '2c 7d 9h Js 3c');
  g.startHand(0);
  g.act('A', 'raise', 1000);
  g.act('B', 'call');
  assert.strictEqual(g.phase, 'runout');
  assert.strictEqual(g.toAct, -1);
  settle(g);
  assert.strictEqual(chips(g), 13500);
});

// ---------- showing cards, rabbit hunt, history, recap ----------

function foldedOut() {
  const g = mk(['A', 'B', 'C']);
  rig(g, 0, { 0: 'Ah Kh', 1: '2c 2d', 2: '9s 9d' }, 'Ac Kd 7s 4h 3d');
  g.startHand(0);
  g.act('A', 'raise', 200); g.act('B', 'fold'); g.act('C', 'fold');
  return g;
}

test('show cards: any player can show one card or both after the hand, the table sees only what was shown', () => {
  const g = foldedOut();
  assert.strictEqual(g.getState('C').players.find(p => p.id === 'B').hole, null);
  g.showCards('B', 'left');
  const b = g.getState('C').players.find(p => p.id === 'B').hole;
  assert.strictEqual(E.cardToString(b[0]), '2c');
  assert.strictEqual(b[1], null);
  g.showCards('A', 'both');                                   // the winner may show too
  assert.strictEqual(g.getState('C').players.find(p => p.id === 'A').hole.length, 2);
  g.showCards('B', 'right');
  assert.strictEqual(g.getState('C').players.find(p => p.id === 'B').hole.every(Boolean), true);
  assert.throws(() => g.showCards('A', 'middle'), /left, right or both/);
});

test('show cards: not during a hand, and not for players who already showed down', () => {
  const g = mk(['A', 'B', 'C']);
  g.startHand(0);
  assert.throws(() => g.showCards('A', 'both'), /after the hand/);
  g.act('A', 'call'); g.act('B', 'fold'); g.act('C', 'check');
  checkDown(g);
  assert.throws(() => g.showCards('A', 'both'), /already face up/);
  g.showCards('B', 'both');                                   // B folded earlier and may show
  assert.strictEqual(g.getState('A').players.find(p => p.id === 'B').hole.length, 2);
});

test('rabbit hunt: after a fold-out anyone can reveal the cards that would have come, once', () => {
  const g = foldedOut();
  g.rabbitHunt('C');
  assert.deepStrictEqual(g.getState('B').result.rabbit.cards.map(E.cardToString), ['Ac', 'Kd', '7s', '4h', '3d']);
  assert.strictEqual(g.result.rabbit.by, 'C');
  assert.throws(() => g.rabbitHunt('B'), /already revealed/);
});

test('rabbit hunt: only the missing streets, never after a showdown', () => {
  const g = mk(['A', 'B', 'C']);
  rig(g, 0, { 0: 'Ah Kh', 1: '2c 2d', 2: '9s 9d' }, 'Ac Kd 7s 4h 3d');
  g.startHand(0);
  g.act('A', 'call'); g.act('B', 'call'); g.act('C', 'check');
  g.act('B', 'raise', 100); g.act('C', 'fold'); g.act('A', 'fold');
  assert.strictEqual(g.board.length, 3);
  g.rabbitHunt('A');
  assert.deepStrictEqual(g.result.rabbit.cards.map(E.cardToString), ['4h', '3d']);

  const h = mk(['A', 'B']);
  h.startHand(0); h.act('A', 'call'); h.act('B', 'check'); checkDown(h);
  assert.throws(() => h.rabbitHunt('A'), /showdown/);
  const i = mk(['A', 'B']);
  i.startHand(0);
  assert.throws(() => i.rabbitHunt('A'), /after the hand/);
});

test('hand history: winner, winning hand, board, every player\'s result, and who showed what', () => {
  const g = mk(['A', 'B', 'C']);
  rig(g, 0, { 0: 'Ah Kh', 1: '2c 2d', 2: '9s 9d' }, 'Ac Kd 7s 4h 3d');
  g.startHand(0);
  g.act('A', 'call'); g.act('B', 'call'); g.act('C', 'check');
  checkDown(g);
  const h = g.history[0];
  assert.strictEqual(h.n, 1);
  assert.deepStrictEqual(h.blinds, [25, 50]);
  assert.strictEqual(h.winners.length, 1);
  assert.strictEqual(h.winners[0].name, 'Player A');
  assert.strictEqual(h.winners[0].handName, 'Two Pair');
  assert.strictEqual(h.winners[0].amount, 150);
  assert.strictEqual(h.pot, 150);
  assert.strictEqual(h.board.length, 5);
  assert.strictEqual(h.holes.B.map(E.cardToString).join(' '), '2c 2d');
  assert.strictEqual(Object.values(h.net).reduce((s, v) => s + v, 0), 0);
  assert.strictEqual(h.net.A, 100);
  assert.deepStrictEqual(Object.keys(h.revealed).sort(), ['A', 'B', 'C']);
});

test('hand history: a fold-out has a winner but no hand name and nothing revealed', () => {
  const g = foldedOut();
  const h = g.history[0];
  assert.strictEqual(h.type, 'fold');
  assert.strictEqual(h.winners[0].handName, null);
  assert.deepStrictEqual(h.revealed, {});
  assert.strictEqual(h.board.length, 0);
});

test('hand history does not count returned chips as a win', () => {
  const g = mk(['A', 'B']);
  P(g, 'B').stack = 1000;
  rig(g, 0, { 0: 'Kh Kd', 1: 'Ah Ad' }, '2c 7d 9h Js 3c');
  g.startHand(0);
  g.act('A', 'allin'); g.act('B', 'call');
  settle(g);
  const h = g.history[0];
  assert.deepStrictEqual(h.winners.map(w => [w.name, w.amount]), [['Player B', 2000]]);
  assert.strictEqual(h.net.A, -1000);                         // the extra 11,500 came back to A
});

test('recap: standings with who knocked out whom, biggest pot, best hand, most wins', () => {
  const g = mk(['A', 'B', 'C']);
  rig(g, 0, { 0: 'Ah Ad', 1: 'Kh Kd', 2: 'Qh Qd' }, '2c 7d 9h Js 3c');
  g.startHand(0);
  g.act('A', 'allin'); g.act('B', 'call'); g.act('C', 'call');
  settle(g);
  assert.strictEqual(g.phase, 'finished');
  const r = g.getState('A').recap;
  assert.strictEqual(r.standings[0].name, 'Player A');
  assert.deepStrictEqual(r.standings.map(s => s.place), [1, 2, 3]);   // equal stacks busting together: either order is fair
  assert.ok(r.standings.slice(1).every(s => s.knockedBy === 'Player A'));
  assert.strictEqual(r.biggestPot.amount, 37500);
  assert.strictEqual(r.bestHand.handName, 'Pair');
  assert.deepStrictEqual(r.mostWins, { name: 'Player A', count: 1 });
  assert.deepStrictEqual(r.mostKnockouts, { name: 'Player A', count: 2 });
  assert.strictEqual(r.hands, 1);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
