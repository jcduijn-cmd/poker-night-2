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
  // Same 20 as the server accepts.
  const EMOJIS = [
    '👍', '👏', '😂', '😎', '😏', '🤔', '😬', '😱', '😭', '😡',
    '🤯', '🙏', '🍀', '🔥', '💰', '🦈', '🐟', '🥶', '💀', '🫡',
  ];

  const $ = sel => document.querySelector(sel);
  const landscape = window.matchMedia('(orientation: landscape)'); // same query the CSS uses for the wide table
  const fmt = n => Number(n).toLocaleString('en-US');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const r5 = v => Math.round(v / 5) * 5;
  const cardKey = c => c.r + c.s;
  const ordinal = n => {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };
  const mmss = ms => {
    const t = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
  };
  const duration = ms => {
    const m = Math.round(ms / 60000);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}`;
  };
  const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n));

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

  const Sound = window.Sound || new Proxy({}, { get: () => () => false }); // the table still works without sound

  let session = null;     // { code, token, playerId }
  let es = null;          // EventSource
  let state = null;       // latest state from the server
  let skew = 0;           // server clock minus our clock
  const ui = {
    footerKey: '', rendered: new Set(), stagger: 0, handNumber: 0, wasMyTurn: false, overShown: false,
    busy: false, lobbyKey: '', seatPos: {}, studsKey: '', historyOpen: false, historyCount: -1,
    lastSecs: null, installEvent: null, pausedKey: '',
  };

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
    if (name !== 'game') {
      for (const id of ['#over', '#paused', '#history', '#help', '#menu']) $(id).hidden = true;
      ui.overShown = false;
      ui.historyOpen = false;
      Sound.heartbeat(false);
    }
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

  async function post(kind, extra, quiet) {
    if (ui.busy && !quiet) return;
    if (!quiet) ui.busy = true;
    try { await api(`/api/rooms/${session.code}/${kind}`, { token: session.token, ...extra }); }
    catch (e) { if (!quiet) toast(e.message); }
    finally { if (!quiet) ui.busy = false; }
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
    es.addEventListener('emoji', ev => onEmoji(JSON.parse(ev.data)));
    es.onerror = () => {
      if (ui.leaving) return;               // the tab is closing or reloading: keep the saved seat
      $('#banner').hidden = false;
      if (es && es.readyState === EventSource.CLOSED) verifySession();
    };
  }

  // The stream gave up. Only forget the seat when the server says the table or the
  // seat is really gone; on a network hiccup keep it and try again shortly.
  async function verifySession() {
    const mine = session;
    if (!mine) return;
    try {
      const r = await fetch(`/api/rooms/${mine.code}/history?token=${encodeURIComponent(mine.token)}`, { cache: 'no-store' });
      if (session !== mine) return;
      if (r.status === 401 || r.status === 404) {
        forget('That table is no longer available. It may have restarted. Create a new one or join with another code.');
        return;
      }
    } catch (e) { /* offline: keep trying below */ }
    setTimeout(() => { if (session === mine && (!es || es.readyState !== EventSource.OPEN)) connect(); }, 2000);
  }

  function forget(message) {
    closeStream();
    store.del('poker.session');
    session = null;
    state = null;
    ui.lobbyKey = ui.footerKey = '';
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
    store.set('poker.pin', $('#pin').value);
    const buttons = [$('#join-btn'), $('#create-btn')];
    buttons.forEach(b => { b.disabled = true; });
    try {
      const r = await fn();
      session = { code: r.code, token: r.token, playerId: r.playerId };
      store.set('poker.session', session);
      history.replaceState(null, '', '#' + r.code);
      connect();
      if (r.rejoined) toast('Welcome back, ' + name);
    } catch (e) {
      toast(e.message);
      syncHomeButtons();
    }
  }

  // ---------- home ----------

  function syncHomeButtons() {
    const name = $('#name').value.trim();
    const pinOk = /^\d{4}$/.test($('#pin').value);
    $('#join-btn').disabled = !(name && pinOk && $('#code').value.length === 4);
    $('#create-btn').disabled = !(name && pinOk);
  }

  let homeWired = false;
  function initHome() {
    const name = $('#name');
    const code = $('#code');
    if (!name.value) name.value = store.get('poker.name') || '';
    const pin = $('#pin');
    if (!pin.value) pin.value = store.get('poker.pin') || '';
    const hash = location.hash.replace('#', '').toUpperCase().slice(0, 4);
    if (/^[A-Z0-9]{4}$/.test(hash)) code.value = hash;
    if (!homeWired) {
      homeWired = true;
      code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
      name.addEventListener('input', syncHomeButtons);
      pin.addEventListener('input', () => { pin.value = pin.value.replace(/\D/g, '').slice(0, 4); syncHomeButtons(); });
      code.addEventListener('input', syncHomeButtons);
      $('#home-form').addEventListener('submit', e => {
        e.preventDefault();
        if ($('#join-btn').disabled) return;
        enter(() => api(`/api/rooms/${code.value}/join`, { name: name.value, pin: pin.value }));
      });
      $('#create-btn').addEventListener('click', () => enter(() => api('/api/rooms', { name: name.value, pin: pin.value })));
      $('#install-link').addEventListener('click', runInstall);
    }
    $('#home-help').replaceChildren(helpBlock());
    syncHomeButtons();
    syncInstallLink();
    (!name.value ? name : !pin.value ? pin : code).focus();
  }

  // ---------- install on the home screen ----------

  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); ui.installEvent = e; syncInstallLink(); });
  window.addEventListener('appinstalled', () => { ui.installEvent = null; syncInstallLink(); });

  function canInstall() { return !isStandalone() && (!!ui.installEvent || isIos()); }
  function syncInstallLink() { $('#install-link').hidden = !canInstall(); }
  async function runInstall() {
    if (ui.installEvent) {
      const ev = ui.installEvent;
      ui.installEvent = null;
      ev.prompt();
      try { await ev.userChoice; } catch (e) { /* dismissed */ }
      syncInstallLink();
    } else if (isIos()) {
      toast('Tap the Share button, then "Add to Home Screen".');
    }
  }

  // ---------- state updates ----------

  function onState(s) {
    skew = s.serverTime - Date.now();
    const before = state;
    state = s;
    if (s.handNumber !== ui.handNumber) { ui.handNumber = s.handNumber; ui.rendered.clear(); ui.footerKey = ''; }

    const myTurn = s.toAct === s.you;
    const touched = !navigator.userActivation || navigator.userActivation.hasBeenActive;
    if (myTurn && !ui.wasMyTurn && navigator.vibrate && touched) navigator.vibrate(150);
    ui.wasMyTurn = myTurn;
    document.title = myTurn ? 'Your turn: Poker night' : 'Poker night';

    if (s.phase === 'lobby') { showScreen('lobby'); renderLobby(s); return; }
    soundsFor(before, s);
    showScreen('game');
    if (before && before.phase === 'lobby' && s.seatsDrawn) toast('Seats were drawn at random');
    ui.stagger = 0;
    renderTopbar(s);
    renderTable(s);
    renderActions(s);
    renderPaused(s);
    if (s.phase === 'finished') renderOver(s);
    if (ui.historyOpen && s.historyCount !== ui.historyCount) loadHistory();
    tick();
  }

  // Sounds follow changes between two states.
  function soundsFor(prev, s) {
    Sound.heartbeat(s.phase === 'runout' && !s.paused, s.board.length >= 4 ? 96 : s.board.length >= 3 ? 80 : 64);
    if (!prev || prev.phase === 'lobby') return;
    const me = s.you;
    if (s.handNumber > prev.handNumber) { Sound.deal(); }
    else if (s.handNumber === prev.handNumber) {
      const pl = id => prev.players.find(p => p.id === id);
      if (s.board.length > prev.board.length) Sound.flip(s.board.length - prev.board.length);
      const betUp = s.players.some(p => pl(p.id) && p.bet > pl(p.id).bet);
      const folded = s.players.some(p => pl(p.id) && p.folded && !pl(p.id).folded && pl(p.id).inHand);
      if (betUp) Sound.chip();
      if (folded) Sound.fold();
      if (!betUp && !folded && prev.toAct && prev.toAct !== s.toAct && s.phase === prev.phase) Sound.check();
      if (s.phase === 'runout' && prev.phase !== 'runout') Sound.allIn();
      const over = p => p === 'handover' || p === 'finished';
      if (over(s.phase) && !over(prev.phase) && s.result) {
        if ((s.result.contested || {})[me] > 0) Sound.win(); else Sound.chip();
      }
    }
    if (s.toAct === me && prev.toAct !== me) Sound.turn();
  }

  // ---------- lobby ----------

  const dur = m => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}`);
  const SETTING_FIELDS = [
    ['startingStack', 'Starting stack', [2500, 5000, 10000, 12500, 20000, 25000, 50000], v => `${fmt(v)} chips`],
    ['levelMinutes', 'Blinds go up every', [5, 10, 15, 20, 30, 45, 60], v => `${v} minutes`],
    ['turnSeconds', 'Time per turn', [15, 20, 30, 45, 60, 90], v => `${v} seconds`],
    ['timeBank', 'Time bank', [0, 1, 2, 3, 5], v => (v ? `${v} extra turn${v > 1 ? 's' : ''} each` : 'None')],
    ['anteFromLevel', 'Antes', [0, 2, 3, 4, 5, 6, 8], v => (v ? `From level ${v}` : 'No antes')],
    ['lateRegLevel', 'Late joining', [0, 2, 3, 4, 5, 6, 8], (v, st) => (v ? `Open through level ${v} (${dur(v * st.levelMinutes)})` : 'Not allowed')],
  ];

  function renderLobby(s) {
    const isHost = s.hostId === s.you;
    const key = JSON.stringify([s.players.map(p => [p.id, p.name, p.connected]), s.hostId, s.settings, s.you, s.blinds]);
    if (key === ui.lobbyKey) return;
    ui.lobbyKey = key;
    const st = s.settings;
    const [sb, bb] = s.blinds;

    let rules;
    if (isHost) {
      const collect = () => {
        const out = {};
        document.querySelectorAll('#lobby select[data-key]').forEach(sel => { out[sel.dataset.key] = Number(sel.value); });
        return out;
      };
      rules = h('div', { class: 'settings' },
        h('h3', { text: 'Table rules' }),
        SETTING_FIELDS.map(([k, label, values, text]) =>
          h('label', {}, label,
            h('select', { 'data-key': k, onchange: () => post('settings', { settings: collect() }) },
              values.map(v => h('option', { value: v, selected: st[k] === v, text: text(v, st) })))),
        ),
        h('p', { class: 'hint', text: `Blinds start at ${fmt(sb)}/${fmt(bb)}. Seats are drawn at random when you start.` }));
    } else {
      rules = h('div', { class: 'settings' },
        h('h3', { text: 'Table rules' }),
        h('ul', { class: 'rules-list' }, [
          `${fmt(st.startingStack)} chips each`,
          `Blinds start at ${fmt(sb)}/${fmt(bb)} and go up every ${st.levelMinutes} minutes`,
          `${st.turnSeconds} seconds per turn, ${st.timeBank ? st.timeBank + ' extra turn' + (st.timeBank > 1 ? 's' : '') + ' of time bank' : 'no time bank'}`,
          st.anteFromLevel ? `Antes from level ${st.anteFromLevel}` : 'No antes',
          st.lateRegLevel ? `Late joining through level ${st.lateRegLevel}` : 'No late joining',
        ].map(t => h('li', { text: t }))));
    }

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
          rules,
          helpBlock(),
          isHost
            ? h('button', { class: 'btn primary', disabled: s.players.length < 2, onclick: () => post('start'),
                text: s.players.length < 2 ? 'Waiting for players to join' : 'Start game' })
            : h('p', { class: 'wait', text: 'Waiting for the host to start the game.' }))));
  }

  // ---------- how the app works ----------

  const HELP = [
    ['Joining', 'One person creates a table and shares the invite link or the 4-letter code. Everyone else joins with their name, a 4-digit PIN of their choice, and the code.'],
    ['Coming back', 'Lost your seat, or switched device? Join the same table again with the same name and PIN and you are back at your seat with your chips.'],
    ['The game', 'Everyone starts with the same stack. Blinds go up on a timer, shown at the top. The last player with chips wins.'],
    ['Your turn', 'Fold, check or call, or raise with the slider and the quick buttons. You have a turn timer. The time bank button adds one extra turn when you need it, a few times per game.'],
    ['Check / fold', 'Tap the check/fold toggle before your turn and it plays for you: it checks if that is free, and folds if not.'],
    ['All in', 'When nobody can bet any more, the cards are dealt one by one with each player\'s win chance shown.'],
    ['After a hand', 'Show one or both of your cards if you like. When everyone else folded you can rabbit hunt to see the cards that would have come.'],
    ['Emojis', 'The smiley button at the bottom left sends an emoji that pops up at your seat.'],
    ['Menu', 'The ... button at the top has the hand history, sound on or off, the invite link and, for the host, pause. The host can also change the rules in the lobby before the game starts.'],
    ['Install', 'On a phone you can add Poker night to your home screen and open it like an app.'],
  ];

  function helpList() {
    return h('dl', { class: 'help-list' }, HELP.flatMap(([title, text]) => [h('dt', { text: title }), h('dd', { text })]));
  }
  function helpBlock() {
    const d = h('details', { class: 'help' }, h('summary', { text: 'How the app works' }), helpList());
    d.open = !!ui.helpOpen;
    d.addEventListener('toggle', () => { ui.helpOpen = d.open; });
    return d;
  }
  function openHelp() {
    $('#help').replaceChildren(
      h('div', { class: 'sheet wood', role: 'dialog', 'aria-label': 'How the app works' },
        h('div', { class: 'sheet-head' },
          h('h2', { text: 'How the app works' }),
          h('button', { class: 'btn small', text: 'Close', onclick: closeHelp })),
        helpList()));
    $('#help').hidden = false;
  }
  function closeHelp() { $('#help').hidden = true; }

  // ---------- top bar and menu ----------

  function renderTopbar(s) {
    const [sb, bb] = s.blinds;
    const next = s.nextBlinds;
    $('#topbar').replaceChildren(
      h('button', { class: 'tb', onclick: invite, title: 'Share invite link' },
        h('span', { class: 'tb-label', text: 'Table' }), h('b', { text: s.code })),
      h('div', { class: 'tb' },
        h('span', { class: 'tb-label', text: `Blinds, level ${s.level}` }),
        h('b', { text: `${fmt(sb)} / ${fmt(bb)}` }),
        s.ante ? h('span', { class: 'tb-label', text: `Ante ${fmt(s.ante)}` }) : null),
      h('div', { class: 'tb right' },
        h('span', { class: 'tb-label', text: next ? `Next ${fmt(next[0])} / ${fmt(next[1])} in` : '' }),
        h('b', { class: 'js-level-time', text: '' })),
      h('button', { class: 'menu-btn', 'aria-label': 'Menu', 'aria-haspopup': 'menu', onclick: toggleMenu, text: '⋯' }));
  }

  function toggleMenu(e) {
    e.stopPropagation();
    const m = $('#menu');
    if (!m.hidden) { m.hidden = true; return; }
    const s = state;
    const items = [
      ['Hand history', openHistory],
      [`Sound: ${Sound.isEnabled() ? 'on' : 'off'}`, () => { Sound.setEnabled(!Sound.isEnabled()); Sound.chip(); }],
      ['Share invite link', invite],
      ['How the app works', openHelp],
    ];
    if (s.hostId === s.you && s.phase !== 'finished') items.push([s.paused ? 'Resume game' : 'Pause game', () => post(s.paused ? 'resume' : 'pause')]);
    if (canInstall()) items.push(['Put on home screen', runInstall]);
    m.replaceChildren(...items.map(([label, fn]) =>
      h('button', { class: 'menu-item', role: 'menuitem', text: label, onclick: () => { m.hidden = true; fn(); } })));
    m.hidden = false;
  }
  document.addEventListener('click', e => {
    const m = $('#menu');
    if (!m.hidden && !m.contains(e.target)) m.hidden = true;
    const p = $('#emoji-panel');
    if (!p.hidden && !p.contains(e.target) && e.target !== $('#emoji-btn')) closeEmojis();
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    $('#menu').hidden = true;
    closeEmojis();
    if (ui.historyOpen) closeHistory();
    closeHelp();
  });

  // ---------- cards and chips ----------

  // A card has two faces, so it can flip over when it first appears.
  function cardEl(c, key, mode) {
    const red = c.s === 'h' || c.s === 'd';
    const rank = RANK_LABEL[c.r] || String(c.r);
    let isNew = false;
    let delay = 0;
    if (key) {
      isNew = !ui.rendered.has(key);
      ui.rendered.add(key);
      if (isNew) delay = Math.min(ui.stagger++ * 0.12, 0.6);
    }
    return h('div', {
      class: 'card' + (red ? ' red' : '') + (isNew ? ' new' : '') + (mode ? ' ' + mode : ''),
      style: isNew ? `--d:${delay.toFixed(2)}s` : null,
      role: 'img', 'aria-label': `${rank} of ${SUIT_NAMES[c.s]}`,
    },
      h('div', { class: 'flip' },
        h('div', { class: 'face front' },
          h('span', { class: 'r', text: rank }),
          h('span', { class: 's', text: SUITS[c.s] }),
          h('span', { class: 'big', text: SUITS[c.s] })),
        h('div', { class: 'face back' })));
  }

  const backEl = () => h('div', { class: 'card facedown', 'aria-label': 'Face-down card' },
    h('div', { class: 'flip' }, h('div', { class: 'face back' })));

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

  // Brass studs around the padded rail. The ellipse differs between portrait and landscape.
  function buildStuds() {
    const key = landscape.matches ? 'l' : 'p';
    if (ui.studsKey === key) return;
    ui.studsKey = key;
    const ratio = landscape.matches ? 1.7 : 0.78;
    const rx = 45.6;
    const ry = 50 - 4.4 * ratio;
    const studs = [];
    const count = 34;
    for (let i = 0; i < count; i++) {
      const t = (i / count) * Math.PI * 2;
      studs.push(h('i', { style: `left:${(50 + rx * Math.cos(t)).toFixed(2)}%;top:${(50 + ry * Math.sin(t)).toFixed(2)}%` }));
    }
    $('#studs').replaceChildren(...studs);
  }

  // At a showdown: which cards made the winning hands.
  function showdownInfo(s) {
    const r = s.result;
    if (!r || r.type !== 'showdown' || (s.phase !== 'handover' && s.phase !== 'finished')) return null;
    const winners = new Set();
    for (const pot of r.pots) if (pot.eligible.length > 1) pot.winners.forEach(id => winners.add(id));
    const best = {};
    const cards = new Set();
    for (const hand of r.hands) {
      best[hand.id] = new Set(hand.best.map(cardKey));
      if (winners.has(hand.id)) hand.best.forEach(c => cards.add(cardKey(c)));
    }
    return { winners, best, cards };
  }

  function resultFor(s, id) {
    const r = s.result;
    if (!r || (s.phase !== 'handover' && s.phase !== 'finished')) return {};
    const hand = r.type === 'showdown' ? (r.hands.find(x => x.id === id) || {}).name : null;
    return { hand, win: r.winnings[id] };
  }

  function seatEl(p, pos, me, s, sd) {
    const acting = s.toAct === p.id;
    const res = resultFor(s, p.id);
    const bb = s.blinds[1];
    const eq = s.equity && s.equity[p.id] !== undefined ? s.equity[p.id] : null;

    let cards = [];
    const modeFor = c => (sd ? (sd.winners.has(p.id) && sd.best[p.id].has(cardKey(c)) ? 'win' : 'dim') : null);
    if (p.hole && p.hole.length) cards = p.hole.map((c, k) => (c ? cardEl(c, `${s.handNumber}:${p.id}:${k}`, modeFor(c)) : backEl()));
    else if (p.hasCards) cards = [backEl(), backEl()];

    let status = null;
    if (p.busted) status = `Out, ${ordinal(p.place)}`;
    else if (p.sittingOut) status = 'Away';
    else if (p.folded && p.inHand) status = 'Folded';
    else if (!p.inHand && s.phase !== 'handover' && s.phase !== 'finished') status = 'Next hand';
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
      eq !== null ? h('div', { class: 'tag eq', text: eq + '%' }) : null,
      res.hand ? h('div', { class: 'tag', text: res.hand }) : null,
      res.win ? h('div', { class: 'tag win', text: '+' + fmt(res.win) }) : null,
      status && !res.win && eq === null ? h('div', { class: 'tag', text: status }) : null,
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
    const table = $('#table');
    const players = rotate(s.players, s.you);
    table.classList.toggle('crowded', players.length > 6);
    table.classList.toggle('runout', s.phase === 'runout');
    buildStuds();

    const sd = showdownInfo(s);
    const seats = $('#seats');
    seats.replaceChildren();
    ui.seatPos = {};
    players.forEach((p, i) => {
      const pos = seatPos(i, players.length);
      ui.seatPos[p.id] = pos;
      seats.append(...seatEl(p, pos, i === 0, s, sd).filter(Boolean));
    });

    const over = s.phase === 'handover' || s.phase === 'finished';
    const center = [];
    if (!over && s.pot > 0) {
      // Only talk about side pots once someone is all in; before that it is just one pot.
      const sides = s.pots.length > 1 && s.players.some(p => p.allIn) ? s.pots.map((pot, i) => `${i === 0 ? 'Main' : 'Side'} ${fmt(pot.amount)}`).join(', ') : null;
      center.push(h('div', { class: 'pot' }, chipsEl(s.pot, s.blinds[1]), h('span', { text: `Pot ${fmt(s.pot)}` })));
      if (sides) center.push(h('div', { class: 'msg' }, h('div', { class: 'sub', text: sides })));
    }

    const rabbit = s.result && s.result.rabbit ? s.result.rabbit.cards : null;
    center.push(h('div', { class: 'board' }, [0, 1, 2, 3, 4].map(i => {
      if (s.board[i]) {
        const mode = sd ? (sd.cards.has(cardKey(s.board[i])) ? 'win' : 'dim') : null;
        return cardEl(s.board[i], `${s.handNumber}:b${i}`, mode);
      }
      const rc = rabbit && rabbit[i - s.board.length];
      return rc ? cardEl(rc, `${s.handNumber}:r${i}`, 'ghost') : h('div', { class: 'slot' });
    })));

    if (s.phase === 'runout') {
      center.push(h('div', { class: 'msg allin' }, h('div', { text: 'All in' })));
    }
    if (over) {
      const msg = h('div', { class: 'msg' }, resultLines(s).map(l => h('div', { text: l })));
      if (rabbit) {
        const by = (s.players.find(p => p.id === s.result.rabbit.by) || {}).name;
        msg.append(h('div', { class: 'sub', text: `${by} looked ahead. Faded cards would have come.` }));
      }
      if (s.phase === 'handover') {
        msg.append(s.waitingForPlayers
          ? h('div', { class: 'sub', text: 'Waiting for players to sit back in.' })
          : h('div', { class: 'sub' }, 'Next hand in ', h('span', { class: 'js-next-secs' }), 's'));
      }
      center.push(msg);
    }
    $('#center').replaceChildren(...center);
  }

  // ---------- emoji ----------

  function buildEmojiPanel() {
    $('#emoji-panel').replaceChildren(...EMOJIS.map(e =>
      h('button', { class: 'emoji', type: 'button', role: 'menuitem', 'aria-label': 'Send ' + e, text: e, onclick: () => {
        post('emoji', { emoji: e }, true);
        closeEmojis();
      } })));
  }
  function closeEmojis() { $('#emoji-panel').hidden = true; $('#emoji-btn').setAttribute('aria-expanded', 'false'); }
  $('#emoji-btn').addEventListener('click', e => {
    e.stopPropagation();
    const p = $('#emoji-panel');
    if (!p.children.length) buildEmojiPanel();
    p.hidden = !p.hidden;
    $('#emoji-btn').setAttribute('aria-expanded', String(!p.hidden));
  });

  function onEmoji({ id, emoji }) {
    const pos = ui.seatPos[id];
    if (!pos || $('#game').hidden) return;
    Sound.emoji();
    const pop = h('div', { class: 'pop', style: `left:${pos.x}%;top:${pos.y - (landscape.matches ? 7 : 6)}%`, text: emoji });
    $('#pops').append(pop);
    setTimeout(() => pop.remove(), 2800);
  }

  // ---------- action bar ----------

  function renderActions(s) {
    const me = s.players.find(p => p.id === s.you);
    const key = JSON.stringify([s.handNumber, s.phase, s.paused, s.toAct, s.currentBet, s.legal, me.stack, me.bet,
      me.sittingOut, me.folded, me.inHand, me.busted, me.allIn, me.shown, s.waitingForPlayers, s.pot, s.blinds,
      s.timeBank, s.preAction, !!(s.result && s.result.rabbit), s.hostId === s.you]);
    if (key === ui.footerKey) return;
    ui.footerKey = key;
    $('#actions').replaceChildren(h('div', { class: 'actions-inner' }, buildActions(s, me)));
  }

  function showOptions(s, me) {
    const over = s.phase === 'handover' || s.phase === 'finished';
    if (!over || !s.result) return null;
    const buttons = [];
    const mine = me.hole && me.hole.length === 2 ? me.hole : null;
    const autoShown = s.result.type === 'showdown' && !me.folded;
    if (mine && me.inHand && !autoShown && !(me.shown[0] && me.shown[1])) {
      const label = c => `Show ${RANK_LABEL[c.r] || c.r}${SUITS[c.s]}`;
      if (!me.shown[0]) buttons.push(h('button', { class: 'btn small', text: label(mine[0]), onclick: () => post('show', { which: 'left' }) }));
      if (!me.shown[1]) buttons.push(h('button', { class: 'btn small', text: label(mine[1]), onclick: () => post('show', { which: 'right' }) }));
      if (!me.shown[0] && !me.shown[1]) buttons.push(h('button', { class: 'btn small', text: 'Show both', onclick: () => post('show', { which: 'both' }) }));
    }
    if (s.result.type === 'fold' && !s.result.rabbit && s.board.length < 5) {
      buttons.push(h('button', { class: 'btn small rabbit', title: 'See the cards that would have come',
        text: 'Rabbit hunt', onclick: () => post('rabbit') }));
    }
    return buttons.length ? h('div', { class: 'show-row' }, buttons) : null;
  }

  function buildActions(s, me) {
    const status = (...kids) => h('div', { class: 'status' }, kids);
    if (s.paused) return status(h('span', { text: 'The game is paused.' }));
    if (s.phase === 'finished') return status(h('span', { text: 'The game is over.' }));
    if (me.busted) return status(h('span', { text: `You are out. You finished ${ordinal(me.place)}.` }));
    if (me.sittingOut) {
      return [status(h('span', { text: 'You are sitting out.' })),
        h('button', { class: 'btn primary', text: 'Sit back in', onclick: () => post('sitin') })];
    }
    if (s.legal) return myTurn(s, me);

    const stepAway = h('button', { class: 'link', text: 'Step away', onclick: () => {
      if (confirm('Step away? You fold this hand and sit out until you come back.')) post('leave');
    } });
    if (s.phase === 'runout') return status(h('span', { text: 'All in. Dealing the cards…' }));
    if (s.phase === 'handover') {
      const text = s.waitingForPlayers ? 'Waiting for players to sit back in.' : ['Next hand in ', h('span', { class: 'js-next-secs' }), 's'];
      return [status(h('span', {}, text), stepAway), showOptions(s, me)];
    }
    if (!me.inHand) return status(h('span', { text: 'You are dealt in from the next hand.' }), stepAway);
    if (me.folded) return status(h('span', { text: 'You folded. Waiting for the hand to finish.' }), stepAway);

    const actor = s.players.find(p => p.id === s.toAct);
    const pre = h('button', { class: 'btn small toggle', 'aria-pressed': String(s.preAction),
      title: 'Check if it is free, otherwise fold, as soon as it is your turn',
      text: s.preAction ? 'Check / fold: on' : 'Check / fold', onclick: () => post('preaction', { on: !s.preAction }) });
    return [
      status(h('span', {}, actor ? ['Waiting for ', actor.name, ' ', h('span', { class: 'js-turn-secs' })] : 'Waiting…'), stepAway),
      pre,
    ];
  }

  function myTurn(s, me) {
    const L = s.legal;
    const min = L.minRaiseTo;
    const max = L.maxRaiseTo;
    const bank = s.timeBank > 0
      ? h('button', { class: 'btn small bank', title: 'Add thinking time', text: `+${s.settings.turnSeconds}s (${s.timeBank})`, onclick: () => post('timebank') })
      : null;
    const out = [h('div', { class: 'status turn' }, h('b', { text: 'Your turn' }), h('span', { class: 'js-turn-secs' }), bank)];

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

  // ---------- paused ----------

  function renderPaused(s) {
    const o = $('#paused');
    const key = JSON.stringify([s.paused, s.hostId === s.you]);
    if (key === ui.pausedKey) return;
    ui.pausedKey = key;
    if (!s.paused) { o.hidden = true; return; }
    o.replaceChildren(
      h('div', { class: 'plaque wood' },
        h('div', { class: 'felt-card' },
          h('h2', { text: 'Game paused' }),
          h('p', { class: 'lede', text: s.hostId === s.you ? 'The turn timer and the blinds clock are stopped.' : 'The host paused the game. The turn timer and the blinds clock are stopped.' }),
          s.hostId === s.you ? h('button', { class: 'btn primary', text: 'Resume game', onclick: () => post('resume') }) : null)));
    o.hidden = false;
  }

  // ---------- hand history ----------

  function miniCards(cards) {
    return h('span', { class: 'mini-cards' }, (cards || []).map(c => cardEl(c, null, 'mini')));
  }

  function openHistory() {
    ui.historyOpen = true;
    $('#history').hidden = false;
    loadHistory();
  }
  function closeHistory() { ui.historyOpen = false; $('#history').hidden = true; }

  async function loadHistory() {
    if (!session) return;
    let hands;
    try {
      const res = await fetch(`/api/rooms/${session.code}/history?token=${encodeURIComponent(session.token)}`);
      hands = (await res.json()).hands || [];
    } catch (e) { toast('Could not load the hand history.'); return; }
    ui.historyCount = hands.length;

    const rows = hands.map(x => {
      const win = x.winners.map(w => {
        const hand = w.handName ? ` with ${HAND_PHRASE[w.handName] || w.handName}` : '';
        const cards = x.revealed[w.id];
        return h('div', { class: 'hh-win' },
          h('b', { text: w.name }), ` ${x.winners.length > 1 ? 'split' : 'won'} ${fmt(w.amount)}${hand}`,
          cards ? miniCards(cards) : null);
      });
      return h('li', { class: 'hh' },
        h('div', { class: 'hh-top' },
          h('b', { text: `Hand ${x.n}` }),
          h('span', { text: `Blinds ${fmt(x.blinds[0])}/${fmt(x.blinds[1])}` }),
          h('span', { class: 'hh-pot', text: `Pot ${fmt(x.pot)}` })),
        x.board.length ? h('div', { class: 'hh-board' }, miniCards(x.board)) : null,
        win,
        h('div', { class: 'hh-you' },
          x.yourHole
            ? ['Your cards', miniCards(x.yourHole), h('span', { class: 'net ' + (x.yourNet > 0 ? 'up' : x.yourNet < 0 ? 'down' : ''), text: signed(x.yourNet) })]
            : 'You were not dealt in'));
    });

    $('#history').replaceChildren(
      h('div', { class: 'sheet wood', role: 'dialog', 'aria-label': 'Hand history' },
        h('div', { class: 'sheet-head' },
          h('h2', { text: 'Hand history' }),
          h('button', { class: 'btn small', text: 'Close', onclick: closeHistory })),
        rows.length
          ? h('ol', { class: 'hh-list' }, rows)
          : h('p', { class: 'wait', text: 'No hands played yet.' })));
  }

  // ---------- end of the tournament ----------

  function renderOver(s) {
    if (ui.overShown || !s.recap) return;
    ui.overShown = true;
    const r = s.recap;
    const champ = r.standings[0];
    const stat = (title, body) => h('div', { class: 'stat' }, h('div', { class: 'stat-title', text: title }), h('div', { class: 'stat-body' }, body));
    const stats = [];
    if (r.biggestPot) {
      const who = r.biggestPot.names.join(' and ');
      stats.push(stat('Biggest pot', [h('b', { text: fmt(r.biggestPot.amount) }), ` won by ${who}` + (r.biggestPot.handName ? ` with ${HAND_PHRASE[r.biggestPot.handName] || r.biggestPot.handName}` : '') + ` in hand ${r.biggestPot.hand}`]));
    }
    if (r.bestHand) {
      stats.push(stat('Best hand', [h('b', { text: r.bestHand.name }), ` with ${HAND_PHRASE[r.bestHand.handName] || r.bestHand.handName}`, miniCards(r.bestHand.cards)]));
    }
    if (r.mostWins) stats.push(stat('Most hands won', [h('b', { text: r.mostWins.name }), `, ${r.mostWins.count}`]));
    if (r.mostKnockouts) stats.push(stat('Most knock-outs', [h('b', { text: r.mostKnockouts.name }), `, ${r.mostKnockouts.count}`]));
    stats.push(stat('The game', `${r.hands} ${r.hands === 1 ? "hand" : "hands"}` + (r.durationMs ? ` in ${duration(r.durationMs)}` : '')));

    $('#over').replaceChildren(
      h('div', { class: 'plaque wood recap' },
        h('div', { class: 'felt-card' },
          h('h2', { text: champ.id === s.you ? 'You win the tournament' : `${champ.name} wins the tournament` }),
          h('ol', { class: 'standings' }, r.standings.map(p =>
            h('li', {},
              h('span', {}, h('b', { text: ordinal(p.place || 1) }), ' ', p.name,
                p.knockedBy ? h('small', { text: ` knocked out by ${p.knockedBy}` }) : null),
              h('span', { text: p.place === 1 ? fmt(p.stack) + ' chips' : '' })))),
          h('div', { class: 'stats' }, stats),
          h('button', { class: 'btn primary', text: 'Back to start', onclick: () => forget() }))));
    $('#over').hidden = false;
  }

  // ---------- countdowns ----------

  function tick() {
    if (!state || state.phase === 'lobby') return;
    const now = Date.now() + skew;
    const paused = state.paused;
    const lt = document.querySelector('.js-level-time');
    if (lt && state.nextLevelAt) lt.textContent = mmss(paused ? state.levelRemainingMs : state.nextLevelAt - now);

    let secs = null;
    if (paused && state.turnRemainingMs != null) secs = Math.ceil(state.turnRemainingMs / 1000);
    else if (state.turnDeadline) secs = Math.max(0, Math.ceil((state.turnDeadline - now) / 1000));
    document.querySelectorAll('.js-turn-secs').forEach(e => { e.textContent = secs == null ? '' : secs + 's'; });
    if (state.toAct === state.you && secs != null && secs <= 5 && secs > 0 && secs !== ui.lastSecs && !paused) Sound.tick();
    ui.lastSecs = secs;

    document.querySelectorAll('.js-next-secs').forEach(e => {
      const ms = paused ? state.nextHandRemainingMs : state.nextHandAt ? state.nextHandAt - now : null;
      e.textContent = ms == null ? '' : Math.max(0, Math.ceil(ms / 1000));
    });
    if (state.turnDeadline) {
      const span = state.turnSpanMs || state.turnMs;
      const pct = clamp(((state.turnDeadline - now) / span) * 100, 0, 100);
      document.querySelectorAll('.timer i').forEach(i => { i.style.width = pct + '%'; });
    }
  }
  setInterval(tick, 250);
  landscape.addEventListener('change', () => { if (state && state.phase !== 'lobby') renderTable(state); });

  // ---------- start ----------

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* not available, that is fine */ }); });
  }

  window.addEventListener('pagehide', () => { ui.leaving = true; });
  window.addEventListener('pageshow', () => { ui.leaving = false; });

  // Waking a tab (phone unlocked, switched back): make sure the live stream is up.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && session && (!es || es.readyState !== EventSource.OPEN)) connect();
  });

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
