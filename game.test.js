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
    const g = mk(ids);
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
        const inPlay = g.players.reduce((s, p) => s + p.stack + (g.isHandActive() ? p.totalBet : 0), 0);
        assert.strictEqual(inPlay, total, 'chips changed during a hand');
        assert.ok(g.players.every(p => p.stack >= 0), 'negative stack');
      }
      assert.strictEqual(chips(g), total, 'chips changed after a hand');
    }

    const places = g.players.map(p => p.place).sort((a, b) => a - b);
    assert.deepStrictEqual(places, Array.from({ length: n }, (_, i) => i + 1));
    assert.strictEqual(P(g, g.winner).stack, total);
  }
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
