'use strict';
// Poker engine: cards, deck, and Texas Hold'em hand evaluation.
// Zero dependencies. Ranks are 2..14 (14 = Ace). Suits are 'c','d','h','s'.

const crypto = require('crypto');

const SUITS = ['c', 'd', 'h', 's'];
const RANK_CHARS = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const CHAR_RANKS = Object.fromEntries(Object.entries(RANK_CHARS).map(([k, v]) => [v, Number(k)]));

const CATEGORY_NAMES = [
  'High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight',
  'Flush', 'Full House', 'Four of a Kind', 'Straight Flush',
];

// "As" -> { r: 14, s: 's' }
function parseCard(str) {
  const r = CHAR_RANKS[str[0].toUpperCase()];
  const s = str[1].toLowerCase();
  if (!r || !SUITS.includes(s)) throw new Error('Bad card: ' + str);
  return { r, s };
}

function parseCards(str) {
  return str.trim().split(/\s+/).map(parseCard);
}

function cardToString(c) {
  return RANK_CHARS[c.r] + c.s;
}

function newDeck() {
  const deck = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) deck.push({ r, s });
  return deck;
}

// Fisher-Yates using a cryptographically secure RNG (fair shuffles matter among friends!)
function shuffle(deck) {
  const d = deck.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// Evaluate exactly five cards. Returns a number: higher is a better hand.
// score = category * 15^5 + tiebreakers (base 15), so scores compare directly.
function evaluate5(cards) {
  const ranks = cards.map(c => c.r).sort((a, b) => b - a);
  const isFlush = cards.every(c => c.s === cards[0].s);

  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  // Group by count desc, then rank desc: this is the tiebreak order.
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const tiebreak = groups.map(g => g[0]);
  const shape = groups.map(g => g[1]).join('');

  // Straight detection (including the wheel A-2-3-4-5, which plays as 5-high)
  let straightHigh = 0;
  if (groups.length === 5) {
    if (ranks[0] - ranks[4] === 4) straightHigh = ranks[0];
    else if (ranks.join() === '14,5,4,3,2') straightHigh = 5;
  }

  let category;
  let tb = tiebreak;
  if (straightHigh && isFlush) { category = 8; tb = [straightHigh]; }
  else if (shape === '41') category = 7;
  else if (shape === '32') category = 6;
  else if (isFlush) category = 5;
  else if (straightHigh) { category = 4; tb = [straightHigh]; }
  else if (shape === '311') category = 3;
  else if (shape === '221') category = 2;
  else if (shape === '2111') category = 1;
  else category = 0;

  let score = category;
  for (let i = 0; i < 5; i++) score = score * 15 + (tb[i] || 0);
  return score;
}

function categoryOf(score) {
  return Math.floor(score / Math.pow(15, 5));
}

function* combinations(arr, k, start = 0, chosen = []) {
  if (chosen.length === k) { yield chosen.slice(); return; }
  for (let i = start; i <= arr.length - (k - chosen.length); i++) {
    chosen.push(arr[i]);
    yield* combinations(arr, k, i + 1, chosen);
    chosen.pop();
  }
}

// Best 5-card hand out of 5, 6 or 7 cards (hole cards + board).
function bestHand(cards) {
  if (cards.length < 5) throw new Error('Need at least 5 cards');
  let best = { score: -1, cards: null };
  for (const combo of combinations(cards, 5)) {
    const score = evaluate5(combo);
    if (score > best.score) best = { score, cards: combo };
  }
  best.category = categoryOf(best.score);
  best.name = CATEGORY_NAMES[best.category];
  return best;
}

// Given [{id, cards}] (hole + board already combined), returns the ids of the winner(s).
function findWinners(entries) {
  let top = -1;
  let winners = [];
  for (const e of entries) {
    const { score } = bestHand(e.cards);
    if (score > top) { top = score; winners = [e.id]; }
    else if (score === top) winners.push(e.id);
  }
  return winners;
}

// ---------- win percentages ----------

const COMBOS_7 = [...combinations([0, 1, 2, 3, 4, 5, 6], 5)];

// Score of the best five out of exactly seven cards (no allocation per combination).
function bestScore7(cards) {
  let best = -1;
  const five = [null, null, null, null, null];
  for (const c of COMBOS_7) {
    five[0] = cards[c[0]]; five[1] = cards[c[1]]; five[2] = cards[c[2]];
    five[3] = cards[c[3]]; five[4] = cards[c[4]];
    const s = evaluate5(five);
    if (s > best) best = s;
  }
  return best;
}

// Chance (0-100) that each player wins, given their hole cards and the board so far.
// entries: [{ id, hole: [card, card] }]. Ties split equally.
// With one or two cards still to come every possibility is counted exactly;
// before the flop it samples random boards, capped so it always takes a few milliseconds.
function equity(entries, board, maxEvals = 250000) {
  const known = new Set();
  for (const e of entries) for (const c of e.hole) known.add(cardToString(c));
  for (const c of board) known.add(cardToString(c));
  const unseen = newDeck().filter(c => !known.has(cardToString(c)));
  const need = 5 - board.length;
  const n = entries.length;
  const wins = new Array(n).fill(0);
  let total = 0;

  const score = (extra) => {
    const full = board.concat(extra);
    let top = -1;
    let winners = [];
    for (let i = 0; i < n; i++) {
      const s = bestScore7(entries[i].hole.concat(full));
      if (s > top) { top = s; winners = [i]; } else if (s === top) winners.push(i);
    }
    for (const w of winners) wins[w] += 1 / winners.length;
    total++;
  };

  const evalCost = 21 * n;
  const exactCount = need === 0 ? 1 : need === 1 ? unseen.length : need === 2 ? (unseen.length * (unseen.length - 1)) / 2 : Infinity;
  if (need === 0) score([]);
  else if (exactCount * evalCost <= maxEvals) {
    for (const extra of combinations(unseen, need)) score(extra);
  } else {
    const trials = Math.max(200, Math.floor(maxEvals / evalCost));
    const pool = unseen.slice();
    for (let t = 0; t < trials; t++) {
      for (let i = 0; i < need; i++) {
        const j = i + Math.floor(Math.random() * (pool.length - i));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      score(pool.slice(0, need));
    }
  }
  const out = {};
  entries.forEach((e, i) => { out[e.id] = (wins[i] / total) * 100; });
  return out;
}

module.exports = {
  SUITS, CATEGORY_NAMES,
  parseCard, parseCards, cardToString,
  newDeck, shuffle,
  evaluate5, bestHand, categoryOf, findWinners,
  equity,
};
