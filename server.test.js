'use strict';
// Integration tests: start the real server and play through the HTTP API.
const assert = require('assert');
const http = require('http');
const { createApp } = require('./server');

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      port, method, path, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => buf += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (e) { /* not json */ }
        resolve({ status: res.statusCode, json, text: buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Minimal Server-Sent Events client that remembers the latest state.
function openStream(port, code, token) {
  const stream = { latest: null, waiters: [], req: null, states: [], events: [] };
  stream.req = http.get({ port, path: `/api/rooms/${code}/events?token=${token}` }, res => {
    stream.status = res.statusCode;
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = block.split('\n').find(l => l.startsWith('data: '));
        if (!line) continue;
        if (block.startsWith('event: ')) {          // named events such as emoji
          stream.events.push({ name: block.split('\n')[0].slice(7), data: JSON.parse(line.slice(6)) });
          continue;
        }
        stream.latest = JSON.parse(line.slice(6));
        stream.states.push(stream.latest);
        stream.waiters = stream.waiters.filter(w => {
          if (w.pred(stream.latest)) { clearTimeout(w.timer); w.resolve(stream.latest); return false; }
          return true;
        });
      }
    });
  });
  stream.req.on('error', () => {});
  stream.waitFor = (pred, ms = 3000) => new Promise((resolve, reject) => {
    if (stream.latest && pred(stream.latest)) return resolve(stream.latest);
    const w = { pred, resolve };
    w.timer = setTimeout(() => {
      stream.waiters = stream.waiters.filter(x => x !== w);
      reject(new Error('timed out waiting for state; last phase = ' + (stream.latest && stream.latest.phase)));
    }, ms);
    stream.waiters.push(w);
  });
  stream.close = () => stream.req.destroy();
  return stream;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function withServer(opts, fn) {
  const { server } = createApp(opts);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const streams = [];
  const open = (...a) => { const s = openStream(port, ...a); streams.push(s); return s; };
  try { await fn(port, open); }
  finally {
    streams.forEach(s => s.close());
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
}

// Create a table with a host and N-1 friends, returns everything needed to play.
async function setup(port, names) {
  const created = await request(port, 'POST', '/api/rooms', { name: names[0], pin: '1234' });
  assert.strictEqual(created.status, 200);
  const code = created.json.code;
  const players = [{ name: names[0], ...created.json }];
  for (const name of names.slice(1)) {
    const j = await request(port, 'POST', `/api/rooms/${code}/join`, { name, pin: '1234' });
    assert.strictEqual(j.status, 200, JSON.stringify(j.json));
    players.push({ name, ...j.json });
  }
  return { code, players };
}

test('create a table, join with a code, see the lobby live', async () => {
  await withServer({}, async (port, open) => {
    const { code, players } = await setup(port, ['Jan', 'Piet']);
    assert.match(code, /^[A-Z0-9]{4}$/);
    const s = open(code, players[0].token);
    const state = await s.waitFor(st => st.players.length === 2);
    assert.strictEqual(state.phase, 'lobby');
    assert.strictEqual(state.hostId, players[0].playerId);
    assert.strictEqual(state.you, players[0].playerId);
    assert.deepStrictEqual(state.players.map(p => p.name), ['Jan', 'Piet']);
    // joining with lower-case code works too
    const again = await request(port, 'POST', `/api/rooms/${code.toLowerCase()}/join`, { name: 'Klaas', pin: '1234' });
    assert.strictEqual(again.status, 200);
    await s.waitFor(st => st.players.length === 3);
  });
});

test('rejects duplicate names, empty names, unknown tables and bad tokens', async () => {
  await withServer({}, async (port) => {
    const { code } = await setup(port, ['Jan']);
    assert.strictEqual((await request(port, 'POST', `/api/rooms/${code}/join`, { name: 'jan', pin: '9999' })).status, 403);
    assert.strictEqual((await request(port, 'POST', `/api/rooms/${code}/join`, { name: '   ', pin: '1234' })).status, 400);
    assert.strictEqual((await request(port, 'POST', `/api/rooms/ZZZZ/join`, { name: 'X', pin: '1234' })).status, 404);
    assert.strictEqual((await request(port, 'POST', `/api/rooms/${code}/start`, { token: 'nope' })).status, 401);
    assert.strictEqual((await request(port, 'GET', `/api/rooms/${code}/events?token=nope`)).status, 401);
    assert.strictEqual((await request(port, 'POST', `/api/rooms/${code}/join`, undefined)).status, 400);
  });
});

test('PIN: same name + PIN takes your seat back, wrong PIN is refused and locks after 5 tries', async () => {
  await withServer({}, async (port, open) => {
    const { code, players } = await setup(port, ['Jan', 'Piet']);
    const old = open(code, players[1].token);
    await old.waitFor(st => st.players.length === 2);
    assert.strictEqual((await request(port, 'POST', `/api/rooms/${code}/join`, { name: 'Piet' })).status, 400); // PIN required
    assert.strictEqual((await request(port, 'POST', `/api/rooms/${code}/join`, { name: 'Piet', pin: 'abcd' })).status, 400);
    const back = await request(port, 'POST', `/api/rooms/${code}/join`, { name: 'piet', pin: '1234' });
    assert.strictEqual(back.status, 200);
    assert.strictEqual(back.json.rejoined, true);
    assert.strictEqual(back.json.playerId, players[1].playerId);
    assert.notStrictEqual(back.json.token, players[1].token);
    // the old session no longer works, the new one does
    assert.strictEqual((await request(port, 'POST', `/api/rooms/${code}/start`, { token: players[1].token })).status, 401);
    const fresh = open(code, back.json.token);
    const st = await fresh.waitFor(x => x.you === players[1].playerId);
    assert.strictEqual(st.players.length, 2);
    // brute force protection
    for (let i = 0; i < 5; i++) assert.strictEqual((await request(port, 'POST', `/api/rooms/${code}/join`, { name: 'Piet', pin: '0000' })).status, 403);
    assert.strictEqual((await request(port, 'POST', `/api/rooms/${code}/join`, { name: 'Piet', pin: '1234' })).status, 429);
  });
});

test('only the host can start, and it needs two players (late joining off)', async () => {
  await withServer({ settings: { lateRegLevel: 0 } }, async (port) => {
    const { code, players } = await setup(port, ['Jan', 'Piet']);
    const [host, guest] = players;
    const denied = await request(port, 'POST', `/api/rooms/${code}/start`, { token: guest.token });
    assert.strictEqual(denied.status, 403);
    const solo = await setup(port, ['Solo']);
    const tooFew = await request(port, 'POST', `/api/rooms/${solo.code}/start`, { token: solo.players[0].token });
    assert.strictEqual(tooFew.status, 400);
    const ok = await request(port, 'POST', `/api/rooms/${code}/start`, { token: host.token });
    assert.strictEqual(ok.status, 200);
    const late = await request(port, 'POST', `/api/rooms/${code}/join`, { name: 'Late', pin: '1234' });
    assert.strictEqual(late.status, 400);
  });
});

test('everyone gets live updates, and nobody sees another player\'s cards', async () => {
  await withServer({}, async (port, open) => {
    const { code, players } = await setup(port, ['Jan', 'Piet', 'Klaas']);
    const streams = players.map(p => open(code, p.token));
    await Promise.all(streams.map(s => s.waitFor(st => st.players.length === 3)));
    await request(port, 'POST', `/api/rooms/${code}/start`, { token: players[0].token });

    const states = await Promise.all(streams.map(s => s.waitFor(st => st.phase === 'preflop')));
    states.forEach((st, i) => {
      const me = st.players.find(p => p.id === players[i].playerId);
      assert.strictEqual(me.hole.length, 2);
      for (const other of st.players.filter(p => p.id !== me.id)) assert.strictEqual(other.hole, null);
      assert.deepStrictEqual(st.blinds, [25, 50]);
      assert.ok(st.turnDeadline > Date.now());
    });
    // The player to act is told what they may do; the others are not.
    const actorId = states[0].toAct;
    const actorIdx = players.findIndex(p => p.playerId === actorId);
    assert.ok(states[actorIdx].legal && states[actorIdx].legal.canCall);
    states.forEach((st, i) => { if (i !== actorIdx) assert.strictEqual(st.legal, null); });
    // The raw bytes sent to a browser never contain other players' cards
    const piet = states[1].players.find(p => p.id === players[1].playerId);
    assert.ok(!JSON.stringify(states[0]).includes(JSON.stringify(piet.hole)));
    assert.strictEqual(states[0].seatsDrawn, true);
  });
});

test('playing a hand: wrong turn is refused, a valid action updates everybody', async () => {
  await withServer({}, async (port, open) => {
    const { code, players } = await setup(port, ['Jan', 'Piet']);
    const streams = players.map(p => open(code, p.token));
    await request(port, 'POST', `/api/rooms/${code}/start`, { token: players[0].token });
    const st = await streams[0].waitFor(s => s.phase === 'preflop');
    const actor = players.find(p => p.playerId === st.toAct);
    const other = players.find(p => p !== actor);

    const wrong = await request(port, 'POST', `/api/rooms/${code}/action`, { token: other.token, action: 'call' });
    assert.strictEqual(wrong.status, 400);
    assert.match(wrong.json.error, /Not your turn/);
    const bad = await request(port, 'POST', `/api/rooms/${code}/action`, { token: actor.token, action: 'raise', amount: 60 });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.json.error, /Minimum raise/);

    const ok = await request(port, 'POST', `/api/rooms/${code}/action`, { token: actor.token, action: 'fold' });
    assert.strictEqual(ok.status, 200);
    for (const s of streams) {
      const after = await s.waitFor(x => x.phase === 'handover');
      assert.strictEqual(after.result.type, 'fold');
    }
  });
});

test('turn timer: a player who runs out of time is folded automatically, next hand starts by itself', async () => {
  await withServer({ turnMs: 250, handPauseMs: 150 }, async (port, open) => {
    const { code, players } = await setup(port, ['Jan', 'Piet']);
    const s = open(code, players[0].token);
    await request(port, 'POST', `/api/rooms/${code}/start`, { token: players[0].token });
    await s.waitFor(st => st.phase === 'preflop' && st.handNumber === 1);
    // nobody acts...
    const over = await s.waitFor(st => st.phase === 'handover', 2000);
    assert.strictEqual(over.result.type, 'fold');
    const next = await s.waitFor(st => st.handNumber === 2 && st.phase === 'preflop', 2000);
    assert.ok(next.turnDeadline);
  });
});

test('two timeouts in a row sit a player out and the game keeps going', async () => {
  await withServer({ turnMs: 150, handPauseMs: 100 }, async (port, open) => {
    const { code, players } = await setup(port, ['Jan', 'Piet', 'Klaas']);
    const s = open(code, players[0].token);
    await request(port, 'POST', `/api/rooms/${code}/start`, { token: players[0].token });
    // nobody ever acts: everyone gets timed out and sat out, the table waits for players
    const st = await s.waitFor(x => x.players.filter(p => p.sittingOut).length >= 2, 5000);
    assert.ok(st.players.filter(p => p.sittingOut).length >= 2);
    // a sat-out player can come back
    const back = players.find(p => st.players.find(q => q.id === p.playerId && q.sittingOut));
    const r = await request(port, 'POST', `/api/rooms/${code}/sitin`, { token: back.token });
    assert.strictEqual(r.status, 200);
    await s.waitFor(x => !x.players.find(q => q.id === back.playerId).sittingOut);
  });
});

test('reconnecting with the same token shows the current state, including your cards', async () => {
  await withServer({}, async (port, open) => {
    const { code, players } = await setup(port, ['Jan', 'Piet']);
    const first = open(code, players[1].token);
    await request(port, 'POST', `/api/rooms/${code}/start`, { token: players[0].token });
    const before = await first.waitFor(s => s.phase === 'preflop');
    first.close();
    const second = open(code, players[1].token);
    const after = await second.waitFor(s => s.phase === 'preflop');
    const mine = (st) => JSON.stringify(st.players.find(p => p.id === players[1].playerId).hole);
    assert.strictEqual(mine(after), mine(before));
  });
});

test('serves static files and blocks path traversal', async () => {
  await withServer({}, async (port) => {
    assert.strictEqual((await request(port, 'GET', '/healthz')).status, 200);
    assert.strictEqual((await request(port, 'GET', '/..%2Fserver.js')).status, 403);
    assert.strictEqual((await request(port, 'GET', '/does-not-exist.html')).status, 404);
  });
});

// ---------- host settings, pause, time bank, pre-actions, emoji, history, show, rabbit, late join, run-out ----------

const post = (port, code, what, token, extra) => request(port, 'POST', `/api/rooms/${code}/${what}`, { token, ...extra });
const idOf = (players, id) => players.find(p => p.playerId === id);

test('host settings: only the host, only in the lobby, only allowed values; stacks and blinds follow', async () => {
  await withServer({}, async (port, open) => {
    const { code, players } = await setup(port, ['Jan', 'Piet']);
    const [host, guest] = players;
    const s = open(code, guest.token);
    const def = await s.waitFor(st => st.players.length === 2);
    assert.strictEqual(def.settings.lateRegLevel, 4);
    assert.strictEqual(def.settings.timeBank, 3);
    assert.strictEqual((await post(port, code, 'settings', guest.token, { settings: { startingStack: 5000 } })).status, 403);
    assert.strictEqual((await post(port, code, 'settings', host.token, { settings: { startingStack: 777 } })).status, 400);
    const ok = await post(port, code, 'settings', host.token, { settings: { startingStack: 5000, levelMinutes: 10, anteFromLevel: 3, timeBank: 1, turnSeconds: 45, lateRegLevel: 0 } });
    assert.strictEqual(ok.status, 200);
    const st = await s.waitFor(x => x.settings.startingStack === 5000);
    assert.strictEqual(st.settings.levelMinutes, 10);
    assert.strictEqual(st.settings.anteFromLevel, 3);
    assert.deepStrictEqual(st.blinds, [10, 20]);
    assert.ok(st.players.every(p => p.stack === 5000));
    assert.strictEqual(st.timeBank, 1);
    assert.strictEqual(st.turnMs, 45000);
    await post(port, code, 'start', host.token);
    const locked = await post(port, code, 'settings', host.token, { settings: { startingStack: 10000 } });
    assert.strictEqual(locked.status, 400);
    assert.match(locked.json.error, /locked/);
  });
});

test('emoji: everyone at the table gets it, bad ones and spam are refused', async () => {
  await withServer({}, async (port, open) => {
    const { code, players } = await setup(port, ['Jan', 'Piet']);
    const a = open(code, players[0].token);
    const b = open(code, players[1].token);
    await a.waitFor(st => st.players.length === 2);
    await b.waitFor(st => st.players.length === 2);
    assert.strictEqual((await post(port, code, 'emoji', players[0].token, { emoji: '🔥' })).status, 200);
    await new Promise(r => setTimeout(r, 100));
    for (const s of [a, b]) {
      assert.strictEqual(s.events.length, 1);
      assert.deepStrictEqual(s.events[0], { name: 'emoji', data: { id: players[0].playerId, emoji: '🔥' } });
    }
    assert.strictEqual((await post(port, code, 'emoji', players[0].token, { emoji: '🦈' })).status, 429);
    assert.strictEqual((await post(port, code, 'emoji', players[1].token, { emoji: '<script>' })).status, 400);
    assert.strictEqual((await post(port, code, 'emoji', 'nope', { emoji: '🔥' })).status, 401);
  });
});

test('pause: host only, blocks play, freezes the turn clock, resume continues with the time that was left', async () => {
  await withServer({ turnMs: 600, handPauseMs: 5000 }, async (port, open) => {
    const { code, players } = await setup(port, ['Jan', 'Piet']);
    const host = players[0];
    const s = open(code, host.token);
    await post(port, code, 'start', host.token);
    const st = await s.waitFor(x => x.phase === 'preflop');
    const actor = idOf(players, st.toAct);
    const other = players.find(p => p !== actor);
    assert.strictEqual((await post(port, code, 'pause', other === host ? actor.token : other.token)).status, 403);
    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual((await post(port, code, 'pause', host.token)).status, 200);
    const paused = await s.waitFor(x => x.paused);
    assert.ok(paused.turnRemainingMs > 100 && paused.turnRemainingMs <= 320, 'left: ' + paused.turnRemainingMs);
    const blocked = await post(port, code, 'action', actor.token, { action: 'call' });
    assert.strictEqual(blocked.status, 400);
    assert.match(blocked.json.error, /paused/);
    await new Promise(r => setTimeout(r, 900));      // longer than a whole turn
    assert.strictEqual(s.latest.phase, 'preflop');   // nobody was auto-folded while paused
    assert.strictEqual(s.latest.toAct, st.toAct);
    assert.strictEqual((await post(port, code, 'resume', host.token)).status, 200);
    const back = await s.waitFor(x => !x.paused);
    assert.ok(back.turnDeadline - back.serverTime <= 330, 'resumed with ' + (back.turnDeadline - back.serverTime));
    await s.waitFor(x => x.phase === 'handover', 1500);  // the clock runs out after resuming, as usual
  });
});

test('time bank: adds a turn on your own turn, counts down, runs out', async () => {
  await withServer({ settings: { timeBank: 1 }, turnMs: 2000, handPauseMs: 5000 }, async (port, open) => {
    const { code, players } = await setup(port, ['Jan', 'Piet']);
    const s = open(code, players[0].token);
    await post(port, code, 'start', players[0].token);
    const st = await s.waitFor(x => x.phase === 'preflop');
    const actor = idOf(players, st.toAct);
    const other = players.find(p => p !== actor);
    assert.strictEqual((await post(port, code, 'timebank', other.token)).status, 400);
    const before = st.turnDeadline;
    assert.strictEqual((await post(port, code, 'timebank', actor.token)).status, 200);
    const after = await s.waitFor(x => x.turnDeadline > before + 1500);
    assert.strictEqual(after.players.find(p => p.id === actor.playerId).timeBank, 0);
    assert.ok(after.turnSpanMs > 3500);
    const none = await post(port, code, 'timebank', actor.token);
    assert.strictEqual(none.status, 400);
    assert.match(none.json.error, /no time bank/);
  });
});

test('check / fold: done for you the moment your turn comes', async () => {
  await withServer({ handPauseMs: 5000 }, async (port, open) => {
    const { code, players } = await setup(port, ['Jan', 'Piet', 'Klaas']);
    const s = open(code, players[0].token);
    await post(port, code, 'start', players[0].token);
    const st = await s.waitFor(x => x.phase === 'preflop');
    const actor = idOf(players, st.toAct);
    const waiting = players.filter(p => p !== actor);
    assert.strictEqual((await post(port, code, 'preaction', actor.token, { on: true })).status, 400); // already your turn
    for (const p of waiting) assert.strictEqual((await post(port, code, 'preaction', p.token, { on: true })).status, 200);
    await s.waitFor(x => x.players.length === 3);
    await post(port, code, 'action', actor.token, { action: 'call' });
    // the small blind faces a bet and folds; the big blind can check and does
    const flop = await s.waitFor(x => x.phase === 'flop', 2000);
    assert.strictEqual(flop.players.filter(p => p.folded && p.inHand).length, 1);
    assert.strictEqual(flop.board.length, 3);
  });
});

test('late joining through the API: allowed by default after the start, dealt in next hand', async () => {
  await withServer({ handPauseMs: 150 }, async (port, open) => {
    const { code, players } = await setup(port, ['Jan', 'Piet']);
    const s = open(code, players[0].token);
    await post(port, code, 'start', players[0].token);
    await s.waitFor(x => x.phase === 'preflop');
    const late = await request(port, 'POST', `/api/rooms/${code}/join`, { name: 'Klaas', pin: '1234' });
    assert.strictEqual(late.status, 200);
    const joined = await s.waitFor(x => x.players.length === 3);
    const klaas = joined.players.find(p => p.name === 'Klaas');
    assert.strictEqual(klaas.inHand, false);
    assert.strictEqual(klaas.stack, 12500);
    const act = idOf(players, joined.toAct);
    await post(port, code, 'action', act.token, { action: 'fold' });
    const next = await s.waitFor(x => x.handNumber === 2 && x.phase === 'preflop', 2000);
    assert.strictEqual(next.players.find(p => p.name === 'Klaas').inHand, true);
  });
});

test('hand history: your own cards and result, the winner, nobody else\'s cards', async () => {
  await withServer({ handPauseMs: 5000 }, async (port, open) => {
    const { code, players } = await setup(port, ['Jan', 'Piet']);
    const s = open(code, players[0].token);
    await post(port, code, 'start', players[0].token);
    const st = await s.waitFor(x => x.phase === 'preflop');
    const actor = idOf(players, st.toAct);
    const other = players.find(p => p !== actor);
    await post(port, code, 'action', actor.token, { action: 'fold' });
    await s.waitFor(x => x.phase === 'handover' && x.historyCount === 1);
    const mine = (await request(port, 'GET', `/api/rooms/${code}/history?token=${actor.token}`)).json.hands;
    const theirs = (await request(port, 'GET', `/api/rooms/${code}/history?token=${other.token}`)).json.hands;
    assert.strictEqual(mine.length, 1);
    assert.strictEqual(mine[0].winners[0].name, other.name);
    assert.strictEqual(mine[0].yourHole.length, 2);
    assert.strictEqual(mine[0].yourNet, -25);
    assert.strictEqual(theirs[0].yourNet, 25);
    assert.notDeepStrictEqual(mine[0].yourHole, theirs[0].yourHole);
    assert.ok(!JSON.stringify(mine).includes(JSON.stringify(theirs[0].yourHole)), 'the winner\'s cards leaked into the loser\'s history');
    assert.strictEqual((await request(port, 'GET', `/api/rooms/${code}/history?token=nope`)).status, 401);
  });
});

test('show cards and rabbit hunt through the API', async () => {
  await withServer({ handPauseMs: 5000 }, async (port, open) => {
    const { code, players } = await setup(port, ['Jan', 'Piet']);
    const [a, b] = players.map(p => open(code, p.token));
    await post(port, code, 'start', players[0].token);
    const st = await a.waitFor(x => x.phase === 'preflop');
    const actor = idOf(players, st.toAct);
    const other = players.find(p => p !== actor);
    assert.strictEqual((await post(port, code, 'show', actor.token, { which: 'both' })).status, 400); // hand still running
    await post(port, code, 'action', actor.token, { action: 'fold' });
    const viewer = players[0] === actor ? b : a;     // the other player's browser
    await viewer.waitFor(x => x.phase === 'handover');
    assert.strictEqual((await post(port, code, 'show', actor.token, { which: 'left' })).status, 200);
    const seen = await viewer.waitFor(x => { const p = x.players.find(q => q.id === actor.playerId); return p.hole && p.hole[0]; });
    assert.strictEqual(seen.players.find(q => q.id === actor.playerId).hole[1], null);
    assert.strictEqual((await post(port, code, 'rabbit', other.token)).status, 200);
    const rab = await viewer.waitFor(x => x.result && x.result.rabbit);
    assert.strictEqual(rab.result.rabbit.cards.length, 5);
    assert.strictEqual((await post(port, code, 'rabbit', actor.token)).status, 400);
  });
});

test('all-in run-out: cards face up, win percentages, one card at a time, then the result', async () => {
  await withServer({ runoutSpeed: 0.05, handPauseMs: 5000 }, async (port, open) => {
    const { code, players } = await setup(port, ['Jan', 'Piet']);
    const s = open(code, players[0].token);
    await post(port, code, 'start', players[0].token);
    const st = await s.waitFor(x => x.phase === 'preflop');
    const actor = idOf(players, st.toAct);
    const other = players.find(p => p !== actor);
    await post(port, code, 'action', actor.token, { action: 'allin' });
    await post(port, code, 'action', other.token, { action: 'call' });
    await s.waitFor(x => x.phase === 'handover' || x.phase === 'finished', 4000);
    const run = s.states.filter(x => x.phase === 'runout');
    assert.ok(run.length >= 5, 'runout states: ' + run.length);
    assert.deepStrictEqual([...new Set(run.map(x => x.board.length))].sort(), [0, 1, 2, 3, 4, 5]);
    assert.ok(run.every(x => x.legal === null && x.toAct === null));
    const first = run[0];
    assert.strictEqual(first.players.filter(p => Array.isArray(p.hole) && p.hole.length === 2).length, 2); // both hands face up
    assert.ok(first.equity && Math.abs(first.equity[actor.playerId] + first.equity[other.playerId] - 100) <= 1);
    const flop = run.find(x => x.board.length === 3);
    assert.ok(flop.equity);
    const done = s.latest;
    assert.strictEqual(done.result.type, 'showdown');
  });
});

(async () => {
  let passed = 0;
  for (const t of tests) {
    try { await t.fn(); passed++; console.log('  ok  ' + t.name); }
    catch (e) { console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
  }
  console.log('\n' + passed + '/' + tests.length + ' passed');
  process.exit(process.exitCode || 0);
})();
