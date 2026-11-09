'use strict';
// Poker night: browser side. Talks to the server over fetch (actions) and
// EventSource (live table updates). No libraries.
(() => {
  const SUITS = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const SUIT_NAMES = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
  const RANK_LABEL = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J' };
  const HAND_PHRASE = {
    'High Card': 'high card', 'Pair': 'a pair', 'Two Pair': 'two pair', 'Three of a Kind': 'three of a kind',
    'Straight': 'a straight', 'Flush': 'a flush', 'Full House': 'a full house',
    'Four of a Kind': 'four of a kind', 'Straight Flush': 'a straight flush',
  };

  const $ = sel => document.querySelector(sel);
  const landscape = window.matchMedia('(orientation: landscape)'); // same query the CSS uses for the wide table
  const fmt = n => Number(n).toLocaleString('en-US');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const r5 = v => Math.round(v / 5) * 5;
  const ordinal = n => {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };
  const mmss = ms => {
    const t = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
  };

  // Tiny DOM builder. Text always goes in as text, never as HTML.
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  let session = null;     // { code, token, playerId }
  let es = null;          // EventSource
  let state = null;       // latest state from the server
  let skew = 0;           // server clock minus our clock
  const ui = { footerKey: '', rendered: new Set(), handNumber: 0, wasMyTurn: false, overShown: false, busy: false };

  // ---------- small helpers ----------

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3800);
  }

  function showScreen(name) {
    $('#home').hidden = name !== 'home';
    $('#lobby').hidden = name !== 'lobby';
    $('#game').hidden = name !== 'game';
    if (name !== 'game') { $('#over').hidden = true; ui.overShown = false; }
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let json = {};
    try { json = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) throw new Error(json.error || 'Something went wrong. Try again.');
    return json;
  }

  async function post(kind, extra) {
    if (ui.busy) return;
    ui.busy = true;
    try { await api(`/api/rooms/${session.code}/${kind}`, { token: session.token, ...extra }); }
    catch (e) { toast(e.message); }
    finally { ui.busy = false; }
  }

  async function invite() {
    const url = `${location.origin}/#${session.code}`;
    try {
      if (navigator.share) { await navigator.share({ title: 'Poker night', text: 'Join my poker table', url }); return; }
    } catch (e) { return; /* share sheet dismissed */ }
    try { await navigator.clipboard.writeText(url); toast('Invite link copied'); }
    catch (e) { toast('Share this code: ' + session.code); }
  }

  // ---------- connection ----------

  function closeStream() { if (es) { es.close(); es = null; } }

  function connect() {
    closeStream();
    es = new EventSource(`/api/rooms/${session.code}/events?token=${encodeURIComponent(session.token)}`);
    es.onopen = () => { $('#banner').hidden = true; };
    es.onmessage = ev => { $('#banner').hidden = true; onState(JSON.parse(ev.data)); };
    es.onerror = () => {
      if (es && es.readyState === EventSource.CLOSED) forget('That table is no longer available. Create a new one or join with another code.');
      else $('#banner').hidden = false;
    };
  }

  function forget(message) {
    closeStream();
    store.del('poker.session');
    session = null;
    state = null;
    history.replaceState(null, '', location.pathname);
    $('#banner').hidden = true;
    document.title = 'Poker night';
    showScreen('home');
    initHome();
    if (message) toast(message);
  }

  async function enter(fn) {
    const name = $('#name').value.trim();
    store.set('poker.name', name);
    const buttons = [$('#join-btn'), $('#create-btn')];
    buttons.forEach(b => { b.disabled = true; });
    try {
      const r = await fn();
      session = { code: r.code, token: r.token, playerId: r.playerId };
      store.set('poker.session', session);
      history.replaceState(null, '', '#' + r.code);
      connect();
    } catch (e) {
      toast(e.message);
      syncHomeButtons();
    }
  }

  // ---------- home ----------

  function syncHomeButtons() {
    const name = $('#name').value.trim();
    $('#join-btn').disabled = !(name && $('#code').value.length === 4);
    $('#create-btn').disabled = !name;
  }

  let homeWired = false;
  function initHome() {
    const name = $('#name');
    const code = $('#code');
    if (!name.value) name.value = store.get('poker.name') || '';
    const hash = location.hash.replace('#', '').toUpperCase().slice(0, 4);
    if (/^[A-Z0-9]{4}$/.test(hash)) code.value = hash;
    if (!homeWired) {
      homeWired = true;
      code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
      name.addEventListener('input', syncHomeButtons);
      code.addEventListener('input', syncHomeButtons);
      $('#home-form').addEventListener('submit', e => {
        e.preventDefault();
        if ($('#join-btn').disabled) return;
        enter(() => api(`/api/rooms/${code.value}/join`, { name: name.value }));
      });
      $('#create-btn').addEventListener('click', () => enter(() => api('/api/rooms', { name: name.value })));
    }
    syncHomeButtons();
    (name.value ? code : name).focus();
  }

  // ---------- state updates ----------

  function onState(s) {
    skew = s.serverTime - Date.now();
    state = s;
    if (s.handNumber !== ui.handNumber) { ui.handNumber = s.handNumber; ui.rendered.clear(); }

    const myTurn = s.toAct === s.you;
    const touched = !navigator.userActivation || navigator.userActivation.hasBeenActive;
    if (myTurn && !ui.wasMyTurn && navigator.vibrate && touched) navigator.vibrate(150);
    ui.wasMyTurn = myTurn;
    document.title = myTurn ? 'Your turn: Poker night' : 'Poker night';

    if (s.phase === 'lobby') { showScreen('lobby'); renderLobby(s); return; }
    showScreen('game');
    renderTopbar(s);
    renderTable(s);
    renderActions(s);
    if (s.phase === 'finished') renderOver(s);
    tick();
  }

  // ---------- lobby ----------

  function renderLobby(s) {
    const isHost = s.hostId === s.you;
    const [sb, bb] = s.blinds;
    $('#lobby').replaceChildren(
      h('div', { class: 'plaque wood' },
        h('div', { class: 'felt-card' },
          h('h2', { text: 'Your table code' }),
          h('div', { class: 'code', text: s.code }),
          h('button', { class: 'btn', onclick: invite, text: 'Share invite link' }),
          h('ul', { class: 'roster' }, s.players.map(p =>
            h('li', { class: p.connected ? 'on' : 'off' },
              h('span', { class: 'dot' }),
              h('span', { class: 'pname', text: p.name + (p.id === s.you ? ' (you)' : '') }),
              p.id === s.hostId ? h('span', { class: 'host', text: 'Host' }) : null))),
          h('p', { class: 'rules', text:
            `Everyone starts with ${fmt(s.startingStack)} chips. Blinds start at ${fmt(sb)}/${fmt(bb)} and go up every ${s.levelMinutes} minutes. You get ${Math.round(s.turnMs / 1000)} seconds per turn.` }),
          isHost
            ? h('button', { class: 'btn primary', disabled: s.players.length < 2, onclick: () => post('start'),
                text: s.players.length < 2 ? 'Waiting for players to join' : 'Start game' })
            : h('p', { class: 'wait', text: 'Waiting for the host to start the game.' }))));
  }

  // ---------- top bar ----------

  function renderTopbar(s) {
    const [sb, bb] = s.blinds;
    const next = s.nextBlinds;
    $('#topbar').replaceChildren(
      h('button', { class: 'tb', onclick: invite, title: 'Share invite link' },
        h('span', { class: 'tb-label', text: 'Table' }), h('b', { text: s.code })),
      h('div', { class: 'tb' },
        h('span', { class: 'tb-label', text: `Blinds, level ${s.level}` }), h('b', { text: `${fmt(sb)} / ${fmt(bb)}` })),
      h('div', { class: 'tb right' },
        h('span', { class: 'tb-label', text: next ? `Next ${fmt(next[0])} / ${fmt(next[1])} in` : '' }),
        h('b', { class: 'js-level-time', text: '' })));
  }

  // ---------- cards and chips ----------

  function cardEl(c, key) {
    const red = c.s === 'h' || c.s === 'd';
    const rank = RANK_LABEL[c.r] || String(c.r);
    const isNew = !ui.rendered.has(key);
    ui.rendered.add(key);
    return h('div', { class: 'card' + (red ? ' red' : '') + (isNew ? ' new' : ''), role: 'img', 'aria-label': `${rank} of ${SUIT_NAMES[c.s]}` },
      h('span', { class: 'r', text: rank }),
      h('span', { class: 's', text: SUITS[c.s] }),
      h('span', { class: 'big', text: SUITS[c.s] }));
  }

  function chipsEl(amount, bb) {
    const ratio = amount / bb;
    const color = ratio < 2 ? '#e9e4d3' : ratio < 6 ? '#b3261e' : ratio < 20 ? '#1f5fa8' : ratio < 60 ? '#1e7a46' : '#1b1b1b';
    const n = clamp(Math.ceil(Math.log2(ratio + 1)), 1, 5);
    const stack = h('div', { class: 'chips' });
    for (let i = 0; i < n; i++) stack.append(h('i', { class: 'chip', style: `--chip:${color};bottom:${(i * 0.22).toFixed(2)}em` }));
    return stack;
  }

  // ---------- the table ----------

  const rotate = (arr, id) => {
    const i = arr.findIndex(p => p.id === id);
    return i <= 0 ? arr.slice() : arr.slice(i).concat(arr.slice(0, i));
  };

  function seatPos(i, n) {
    const t = (90 + (i * 360) / n) * Math.PI / 180; // seat 0 (you) at the bottom, turns run clockwise
    const rx = n > 6 ? 39 : 41;
    const ry = landscape.matches ? 33 : 36;
    return { x: 50 + rx * Math.cos(t), y: 50 + ry * Math.sin(t) };
  }

  function resultFor(s, id) {
    const r = s.result;
    if (!r || (s.phase !== 'handover' && s.phase !== 'finished')) return {};
    const hand = r.type === 'showdown' ? (r.hands.find(x => x.id === id) || {}).name : null;
    return { hand, win: r.winnings[id] };
  }

  function seatEl(p, pos, me, s) {
    const acting = s.toAct === p.id;
    const res = resultFor(s, p.id);
    const bb = s.blinds[1];

    let cards = [];
    if (p.hole) cards = p.hole.map((c, k) => cardEl(c, `${s.handNumber}:${p.id}:${k}`));
    else if (p.hasCards) cards = [h('div', { class: 'card back' }), h('div', { class: 'card back' })];

    let status = null;
    if (p.busted) status = `Out, ${ordinal(p.place)}`;
    else if (p.sittingOut) status = 'Away';
    else if (p.folded && p.inHand) status = 'Folded';
    else if (p.allIn && s.phase !== 'handover' && s.phase !== 'finished') status = 'All in';

    const cls = ['seat', me && 'me', acting && 'acting', p.folded && !p.busted && 'folded',
      p.busted && 'out', p.sittingOut && !p.busted && 'away', res.win && 'winner'].filter(Boolean).join(' ');

    const seat = h('div', { class: cls, style: `left:${pos.x}%;top:${pos.y}%` },
      h('div', { class: 'hole' }, cards),
      h('div', { class: 'plate' },
        h('div', { class: 'name', text: p.name }),
        h('div', { class: 'stack', text: fmt(p.stack) }),
        p.isDealer ? h('span', { class: 'puck', title: 'Dealer', text: 'D' }) : null,
        p.connected ? null : h('span', { class: 'off', title: 'Disconnected' })),
      res.hand ? h('div', { class: 'tag', text: res.hand }) : null,
      res.win ? h('div', { class: 'tag win', text: '+' + fmt(res.win) }) : null,
      status && !res.win ? h('div', { class: 'tag', text: status }) : null,
      acting ? h('div', { class: 'timer' }, h('i')) : null);

    let bet = null;
    if (p.bet > 0) {
      // Bets sit between the seat and the middle, kept clear of the board cards.
      const bx = 50 + (pos.x - 50) * 0.7;
      const by = 50 + (pos.y - 50) * (landscape.matches ? 0.5 : 0.6);
      bet = h('div', { class: 'bet', style: `left:${bx}%;top:${by}%` }, chipsEl(p.bet, bb), fmt(p.bet));
    }
    return [seat, bet];
  }

  function resultLines(s) {
    const r = s.result;
    if (!r) return [];
    const name = id => (s.players.find(p => p.id === id) || {}).name || 'Someone';
    if (r.type === 'fold') {
      const id = Object.keys(r.winnings)[0];
      return [`${name(id)} wins ${fmt(r.winnings[id])}`];
    }
    return r.pots.map((pot, i) => {
      const label = r.pots.length > 1 ? (i === 0 ? 'Main pot: ' : `Side pot ${i}: `) : '';
      if (pot.eligible.length === 1) return `${label}${name(pot.winners[0])} gets ${fmt(pot.amount)} back`;
      const who = pot.winners.map(name).join(' and ');
      const handName = (r.hands.find(x => x.id === pot.winners[0]) || {}).name;
      const verb = pot.winners.length > 1 ? 'split' : 'wins';
      return `${label}${who} ${verb} ${fmt(pot.amount)}` + (handName ? ` with ${HAND_PHRASE[handName] || handName}` : '');
    });
  }

  function renderTable(s) {
    const players = rotate(s.players, s.you);
    $('#table').classList.toggle('crowded', players.length > 6);
    const seats = $('#seats');
    seats.replaceChildren();
    players.forEach((p, i) => {
      seats.append(...seatEl(p, seatPos(i, players.length), i === 0, s).filter(Boolean));
    });

    const over = s.phase === 'handover' || s.phase === 'finished';
    const center = [];
    if (!over && s.pot > 0) {
      // Only talk about side pots once someone is all in; before that it is just one pot.
      const sides = s.pots.length > 1 && s.players.some(p => p.allIn) ? s.pots.map((pot, i) => `${i === 0 ? 'Main' : 'Side'} ${fmt(pot.amount)}`).join(', ') : null;
      center.push(h('div', { class: 'pot' }, chipsEl(s.pot, s.blinds[1]), h('span', { text: `Pot ${fmt(s.pot)}` })));
      if (sides) center.push(h('div', { class: 'msg' }, h('div', { class: 'sub', text: sides })));
    }
    center.push(h('div', { class: 'board' }, [0, 1, 2, 3, 4].map(i =>
      s.board[i] ? cardEl(s.board[i], `${s.handNumber}:b${i}`) : h('div', { class: 'slot' }))));
    if (over) {
      const msg = h('div', { class: 'msg' }, resultLines(s).map(l => h('div', { text: l })));
      if (s.phase === 'handover') {
        msg.append(s.waitingForPlayers
          ? h('div', { class: 'sub', text: 'Waiting for players to sit back in.' })
          : h('div', { class: 'sub' }, 'Next hand in ', h('span', { class: 'js-next-secs' }), 's'));
      }
      center.push(msg);
    }
    $('#center').replaceChildren(...center);
  }

  // ---------- action bar ----------

  function renderActions(s) {
    const me = s.players.find(p => p.id === s.you);
    const key = JSON.stringify([s.handNumber, s.phase, s.toAct, s.currentBet, s.legal, me.stack, me.bet,
      me.sittingOut, me.folded, me.busted, me.allIn, s.waitingForPlayers, s.pot, s.blinds]);
    if (key === ui.footerKey) return;
    ui.footerKey = key;
    $('#actions').replaceChildren(h('div', { class: 'actions-inner' }, buildActions(s, me)));
  }

  function buildActions(s, me) {
    const status = (...kids) => h('div', { class: 'status' }, kids);
    if (s.phase === 'finished') return status(h('span', { text: 'The game is over.' }));
    if (me.busted) return status(h('span', { text: `You are out. You finished ${ordinal(me.place)}.` }));
    if (me.sittingOut) {
      return [status(h('span', { text: 'You are sitting out.' })),
        h('button', { class: 'btn primary', text: 'Sit back in', onclick: () => post('sitin') })];
    }
    if (s.legal) return myTurn(s, me);

    let text;
    if (s.phase === 'handover') {
      text = s.waitingForPlayers ? 'Waiting for players to sit back in.' : ['Next hand in ', h('span', { class: 'js-next-secs' }), 's'];
    } else if (me.folded) {
      text = 'You folded. Waiting for the hand to finish.';
    } else {
      const actor = s.players.find(p => p.id === s.toAct);
      text = actor ? ['Waiting for ', actor.name, ' ', h('span', { class: 'js-turn-secs' })] : 'Waiting…';
    }
    return status(
      h('span', {}, text),
      h('button', { class: 'link', text: 'Step away', onclick: () => {
        if (confirm('Step away? You fold this hand and sit out until you come back.')) post('leave');
      } }));
  }

  function myTurn(s, me) {
    const L = s.legal;
    const min = L.minRaiseTo;
    const max = L.maxRaiseTo;
    const out = [h('div', { class: 'status turn' }, h('b', { text: 'Your turn' }), h('span', { class: 'js-turn-secs' }))];

    const foldBtn = h('button', { class: 'btn fold', text: 'Fold', onclick: () => {
      if (L.canCheck && !confirm('You can check for free. Fold anyway?')) return;
      post('action', { action: 'fold' });
    } });
    const mainBtn = L.canCheck
      ? h('button', { class: 'btn call', text: 'Check', onclick: () => post('action', { action: 'check' }) })
      : h('button', { class: 'btn call', onclick: () => post('action', { action: 'call' }),
          text: L.toCall >= me.stack ? `All in ${fmt(L.toCall)}` : `Call ${fmt(L.toCall)}` });
    const buttons = [foldBtn, mainBtn];

    if (!L.canRaise) {
      out.push(h('div', { class: 'btn-row' }, buttons));
      return out;
    }

    let value = min;
    const label = v => (v >= max ? `All in ${fmt(v)}` : `${L.raiseLabel === 'bet' ? 'Bet' : 'Raise to'} ${fmt(v)}`);
    const raiseBtn = h('button', { class: 'btn raise', onclick: () => {
      if (value >= max) post('action', { action: 'allin' });
      else post('action', { action: 'raise', amount: value });
    } });
    buttons.push(raiseBtn);
    out.push(h('div', { class: 'btn-row has-raise' }, buttons));

    if (min < max) {
      const slider = h('input', { type: 'range', min, max, step: 1, value: min, 'aria-label': 'Raise amount' });
      const set = v => { value = clamp(Math.round(v), min, max); slider.value = value; raiseBtn.textContent = label(value); };
      slider.addEventListener('input', () => set(Number(slider.value)));
      const afterCall = s.pot + L.toCall;
      const quick = (text, v) => h('button', { class: 'btn small', text, onclick: () => set(v) });
      const step = s.blinds[1];
      out.push(h('div', { class: 'raise-panel' },
        h('div', { class: 'quick' },
          quick('Min', min),
          quick('½ pot', r5(s.currentBet + afterCall / 2)),
          quick('Pot', r5(s.currentBet + afterCall)),
          quick('All in', max)),
        h('div', { class: 'slider-row' },
          h('button', { class: 'btn', text: '−', 'aria-label': 'Lower raise', onclick: () => set(value - step) }),
          slider,
          h('button', { class: 'btn', text: '+', 'aria-label': 'Higher raise', onclick: () => set(value + step) }))));
      set(min);
    } else {
      value = max;
      raiseBtn.textContent = label(max);
    }
    return out;
  }

  // ---------- game over ----------

  function renderOver(s) {
    if (ui.overShown) return;
    ui.overShown = true;
    const standings = [...s.players].sort((a, b) => (a.place || 99) - (b.place || 99));
    const champ = standings[0];
    $('#over').replaceChildren(
      h('div', { class: 'plaque wood' },
        h('div', { class: 'felt-card' },
          h('h2', { text: champ.id === s.you ? 'You win the tournament' : `${champ.name} wins the tournament` }),
          h('ol', { class: 'standings' }, standings.map(p =>
            h('li', {}, h('span', { text: `${ordinal(p.place || 1)} ${p.name}` }), h('span', { text: p.place === 1 ? fmt(p.stack) + ' chips' : '' })))),
          h('button', { class: 'btn primary', text: 'Back to start', onclick: () => forget() }))));
    $('#over').hidden = false;
  }

  // ---------- countdowns ----------

  function tick() {
    if (!state) return;
    const now = Date.now() + skew;
    const lt = document.querySelector('.js-level-time');
    if (lt && state.nextLevelAt) lt.textContent = mmss(state.nextLevelAt - now);
    const secs = state.turnDeadline ? Math.max(0, Math.ceil((state.turnDeadline - now) / 1000)) : null;
    document.querySelectorAll('.js-turn-secs').forEach(e => { e.textContent = secs == null ? '' : secs + 's'; });
    document.querySelectorAll('.js-next-secs').forEach(e => {
      e.textContent = state.nextHandAt ? Math.max(0, Math.ceil((state.nextHandAt - now) / 1000)) : '';
    });
    if (state.turnDeadline) {
      const pct = clamp(((state.turnDeadline - now) / state.turnMs) * 100, 0, 100);
      document.querySelectorAll('.timer i').forEach(i => { i.style.width = pct + '%'; });
    }
  }
  setInterval(tick, 250);
  landscape.addEventListener('change', () => { if (state && state.phase !== 'lobby') renderTable(state); });

  // ---------- start ----------

  const saved = store.get('poker.session');
  const hashCode = location.hash.replace('#', '').toUpperCase().slice(0, 4);
  if (saved && saved.code && saved.token && (!hashCode || hashCode === saved.code)) {
    session = saved;
    connect();
  } else {
    showScreen('home');
    initHome();
  }
})();
