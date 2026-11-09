'use strict';
const assert = require('assert');
const E = require('./engine');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

const best = (s) => E.bestHand(E.parseCards(s));
const beats = (a, b) => best(a).score > best(b).score;

test('deck has 52 unique cards', () => {
  const d = E.newDeck();
  assert.strictEqual(d.length, 52);
  assert.strictEqual(new Set(d.map(E.cardToString)).size, 52);
});

test('shuffle keeps all 52 cards and changes order', () => {
  const d = E.newDeck();
  const s = E.shuffle(d);
  assert.strictEqual(s.length, 52);
  assert.strictEqual(new Set(s.map(E.cardToString)).size, 52);
  assert.notDeepStrictEqual(s.map(E.cardToString), d.map(E.cardToString));
});

test('recognises every hand category', () => {
  assert.strictEqual(best('As Ks Qs Js Ts').name, 'Straight Flush');
  assert.strictEqual(best('9c 9d 9h 9s 2c').name, 'Four of a Kind');
  assert.strictEqual(best('9c 9d 9h 2s 2c').name, 'Full House');
  assert.strictEqual(best('2h 7h 9h Jh Kh').name, 'Flush');
  assert.strictEqual(best('5c 6d 7h 8s 9c').name, 'Straight');
  assert.strictEqual(best('7c 7d 7h Ks 2c').name, 'Three of a Kind');
  assert.strictEqual(best('7c 7d Kh Ks 2c').name, 'Two Pair');
  assert.strictEqual(best('7c 7d 3h Ks 2c').name, 'Pair');
  assert.strictEqual(best('7c 9d 3h Ks 2c').name, 'High Card');
});

test('category ordering is correct', () => {
  const ladder = [
    '7c 9d 3h Ks 2c', '7c 7d 3h Ks 2c', '7c 7d Kh Ks 2c', '7c 7d 7h Ks 2c',
    '5c 6d 7h 8s 9c', '2h 7h 9h Jh Kh', '9c 9d 9h 2s 2c', '9c 9d 9h 9s 2c', 'As Ks Qs Js Ts',
  ];
  for (let i = 1; i < ladder.length; i++) assert.ok(beats(ladder[i], ladder[i - 1]), ladder[i]);
});

test('wheel (A-2-3-4-5) is a 5-high straight, beaten by 6-high', () => {
  assert.strictEqual(best('As 2d 3h 4s 5c').name, 'Straight');
  assert.ok(beats('2c 3d 4h 5s 6c', 'As 2d 3h 4s 5c'));
  assert.ok(beats('As 2d 3h 4s 5c', '2c 2d 2h 7s 9c'));
});

test('steel wheel is a straight flush', () => {
  assert.strictEqual(best('Ah 2h 3h 4h 5h').name, 'Straight Flush');
});

test('no wrap-around straights (Q-K-A-2-3)', () => {
  assert.notStrictEqual(best('Qc Kd Ah 2s 3c').name, 'Straight');
});

test('kickers decide between equal pairs', () => {
  assert.ok(beats('Ac Ad Kh 7s 2c', 'Ac Ad Qh 7s 2c'));
  assert.ok(beats('Ac Ad Kh 7s 3c', 'Ac Ad Kh 7s 2c'));
});

test('two pair: higher pair, then second pair, then kicker', () => {
  assert.ok(beats('Kc Kd 3h 3s 2c', 'Qc Qd Jh Js Ac'));
  assert.ok(beats('Kc Kd 4h 4s 2c', 'Kc Kd 3h 3s Ac'));
  assert.ok(beats('Kc Kd 4h 4s Ac', 'Kc Kd 4h 4s 2c'));
});

test('full house compares trips first', () => {
  assert.ok(beats('3c 3d 3h 2s 2c', '2c 2d 2h As Ac'));
});

test('identical strength splits (suits never break ties)', () => {
  assert.strictEqual(best('As Kd Qh Js 9c').score, best('Ac Kh Qd Jh 9s').score);
});

test('best of 7 picks the right five', () => {
  // Hole 9h 9d, board 9c 2s 2d Kh 4c -> full house nines over twos
  const b = best('9h 9d 9c 2s 2d Kh 4c');
  assert.strictEqual(b.name, 'Full House');
  // Board plays: both players share a straight on board, higher hole card doesn't matter if board is best
  const w = E.findWinners([
    { id: 'a', cards: E.parseCards('2c 3d 5h 6s 7c 8d 9h') }, // 5-9 straight
    { id: 'b', cards: E.parseCards('Ac Kd 5h 6s 7c 8d 9h') }, // also 5-9 straight
  ]);
  assert.deepStrictEqual(w.sort(), ['a', 'b']);
});

test('7-card: two trips become a full house', () => {
  assert.strictEqual(best('8c 8d 8h 3s 3d 3c Ad').name, 'Full House');
});

test('7-card: flush beats straight when both are available', () => {
  assert.strictEqual(best('2h 5h 8h Jh Kh 9c Td').name, 'Flush');
});

test('findWinners finds a single winner', () => {
  const w = E.findWinners([
    { id: 'alice', cards: E.parseCards('Ac Ad 2h 7s 9c Kd 4h') },
    { id: 'bob', cards: E.parseCards('Kc Kh 2h 7s 9c Kd 4h') },
  ]);
  assert.deepStrictEqual(w, ['bob']);
});

test('random 5-card hand frequencies match real poker odds', () => {
  // Known: pair ~42.26%, two pair ~4.75%, trips ~2.11%, flush ~0.197%
  const N = 200000;
  const tally = new Array(9).fill(0);
  const deck = E.newDeck();
  for (let i = 0; i < N; i++) {
    const hand = E.shuffle(deck).slice(0, 5);
    tally[E.categoryOf(E.evaluate5(hand))]++;
  }
  const pct = (i) => (tally[i] / N) * 100;
  assert.ok(Math.abs(pct(1) - 42.26) < 1.0, 'pair ' + pct(1).toFixed(2));
  assert.ok(Math.abs(pct(2) - 4.75) < 0.5, 'two pair ' + pct(2).toFixed(2));
  assert.ok(Math.abs(pct(3) - 2.11) < 0.4, 'trips ' + pct(3).toFixed(2));
  assert.ok(Math.abs(pct(5) - 0.197) < 0.15, 'flush ' + pct(5).toFixed(3));
});

// ---------- win percentages ----------

const eq = (a, b, board) => E.equity(
  [{ id: 'a', hole: E.parseCards(a) }, { id: 'b', hole: E.parseCards(b) }],
  board ? E.parseCards(board) : []);

test('equity: aces against kings before the flop is about 82%', () => {
  const r = eq('Ah Ad', 'Kh Kd');
  assert.ok(Math.abs(r.a + r.b - 100) < 1e-9);
  assert.ok(r.a > 79 && r.a < 85, 'got ' + r.a);
});

test('equity: a finished board gives 100% to the winner and splits ties', () => {
  const win = eq('Ah Ad', 'Kh Kd', '2c 7d 9s Jc 3h');
  assert.strictEqual(win.a, 100);
  assert.strictEqual(win.b, 0);
  const tie = E.equity(
    [{ id: 'a', hole: E.parseCards('2c 3d') }, { id: 'b', hole: E.parseCards('2h 3s') }],
    E.parseCards('As Ks Qs Js Ts'));
  assert.strictEqual(tie.a, 50);
});

test('equity: on the flop aces still beat kings about 91% of the time (exact count)', () => {
  const r = eq('Ah Ad', 'Kh Kd', '2c 7d 9s');
  assert.ok(Math.abs(r.a + r.b - 100) < 1e-9);
  assert.ok(r.a > 88 && r.a < 94, 'got ' + r.a);
});

test('equity: turn spot is exact (outs / unseen cards)', () => {
  // Board As 7s 2d Kc, a: Qs Js (flush draw, 9 outs, plus runner pair outs are not enough) vs b: Ah Ad (set of aces)
  // Only the river is left: a wins with any of the 8 remaining spades that do not pair the board for b... count by brute force instead
  const a = E.parseCards('Qs Js'); const b = E.parseCards('Ah Ad');
  const board = E.parseCards('As 7s 2d Kc');
  const used = new Set([...a, ...b, ...board].map(E.cardToString));
  let aWins = 0; let total = 0;
  for (const c of E.newDeck()) {
    if (used.has(E.cardToString(c))) continue;
    total++;
    const sa = E.bestHand([...a, ...board, c]).score;
    const sb = E.bestHand([...b, ...board, c]).score;
    if (sa > sb) aWins++; else if (sa === sb) aWins += 0.5;
  }
  const r = E.equity([{ id: 'a', hole: a }, { id: 'b', hole: b }], board);
  assert.ok(Math.abs(r.a - (aWins / total) * 100) < 1e-9, `${r.a} vs ${(aWins / total) * 100}`);
});

test('equity: ten players all-in before the flop is fast and adds up to 100', () => {
  const deck = E.shuffle(E.newDeck());
  const entries = Array.from({ length: 10 }, (_, i) => ({ id: 'p' + i, hole: [deck[i * 2], deck[i * 2 + 1]] }));
  const t0 = Date.now();
  const r = E.equity(entries, []);
  const ms = Date.now() - t0;
  assert.ok(Math.abs(Object.values(r).reduce((s, v) => s + v, 0) - 100) < 1e-6);
  assert.ok(ms < 1500, 'took ' + ms + 'ms');
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
