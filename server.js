'use strict';
// HTTP server: a small JSON API + live updates over Server-Sent Events,
// plus static files from ./public. Zero dependencies.
//
//   POST /api/rooms                  {name, pin}            create a table (you become host)
//   POST /api/rooms/:code/join       {name, pin}            join (same name + PIN = take your seat back) a table
//   GET  /api/rooms/:code/events?token=...                  live game state stream (SSE)
//   POST /api/rooms/:code/start      {token}                host starts the game
//   POST /api/rooms/:code/action     {token, action, amount}  fold | check | call | raise | allin
//   POST /api/rooms/:code/leave      {token}                sit out
//   POST /api/rooms/:code/sitin      {token}                come back
//   POST /api/rooms/:code/settings   {token, settings}      host: change the rules (lobby only)
//   POST /api/rooms/:code/pause      {token}                host: pause / resume (blinds clock stops too)
//   POST /api/rooms/:code/resume     {token}
//   POST /api/rooms/:code/show       {token, which}         after a hand: left | right | both
//   POST /api/rooms/:code/rabbit     {token}                after a fold-out: reveal the next cards
//   POST /api/rooms/:code/timebank   {token}                +1 turn of thinking time
//   POST /api/rooms/:code/preaction  {token, on}            check / fold when your turn comes
//   POST /api/rooms/:code/emoji      {token, emoji}         one of the 20 table emojis
//   GET  /api/rooms/:code/history?token=...                 hand history for this player
//   GET  /healthz

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Room, RoomError } = require('./room');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid mix-ups
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ROOMS = 200;

function createApp(opts = {}) {
  const rooms = new Map();
  const roomOpts = {
    turnMs: opts.turnMs, handPauseMs: opts.handPauseMs, game: opts.game,
    settings: opts.settings, runoutSpeed: opts.runoutSpeed,
  };

  function newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      if (!rooms.has(code)) return code;
    }
  }

  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', c => {
        size += c.length;
        if (size > 10000) { reject(new RoomError('Request too large', 413)); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new RoomError('Invalid JSON')); }
      });
      req.on('error', reject);
    });
  }

  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  }

  function openEvents(req, res, room, url) {
    const id = room.auth(url.searchParams.get('token'));
    if (!id) return sendJson(res, 401, { error: 'Invalid token' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    room.addClient(id, res); // also sends the first state
    req.on('close', () => room.removeClient(id, res));
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    try {
      if (pathname === '/healthz') return sendJson(res, 200, { ok: true, rooms: rooms.size });

      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
        return serveStatic(req, res, pathname);
      }

      // Create a table
      if (pathname === '/api/rooms' && req.method === 'POST') {
        const body = await readJson(req);
        if (rooms.size >= MAX_ROOMS) throw new RoomError('Server is busy, try again later', 503);
        const room = new Room(newCode(), roomOpts);
        const me = room.join(body.name, body.pin);
        rooms.set(room.code, room);
        return sendJson(res, 200, { code: room.code, playerId: me.id, token: me.token, rejoined: false });
      }

      const m = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{4})\/(join|events|history|start|action|leave|sitin|settings|show|rabbit|pause|resume|timebank|emoji|preaction)$/);
      if (!m) throw new RoomError('Not found', 404);
      const room = rooms.get(m[1].toUpperCase());
      if (!room) throw new RoomError('Table not found. Check the code.', 404);
      const what = m[2];

      if (what === 'events' && req.method === 'GET') return openEvents(req, res, room, url);
      if (what === 'history' && req.method === 'GET') {
        const hid = room.auth(url.searchParams.get('token'));
        if (!hid) throw new RoomError('Invalid token', 401);
        return sendJson(res, 200, { hands: room.historyFor(hid) });
      }
      if (req.method !== 'POST') throw new RoomError('Method not allowed', 405);

      const body = await readJson(req);
      if (what === 'join') {
        const me = room.join(body.name, body.pin);
        return sendJson(res, 200, { code: room.code, playerId: me.id, token: me.token, rejoined: me.rejoined });
      }

      const id = room.auth(body.token);
      if (!id) throw new RoomError('Invalid token', 401);
      if (what === 'start') room.start(id);
      else if (what === 'action') room.action(id, String(body.action), body.amount);
      else if (what === 'leave') room.leave(id);
      else if (what === 'sitin') room.sitIn(id);
      else if (what === 'settings') room.setSettings(id, body.settings);
      else if (what === 'show') room.show(id, String(body.which));
      else if (what === 'rabbit') room.rabbit(id);
      else if (what === 'pause') room.pause(id);
      else if (what === 'resume') room.resume(id);
      else if (what === 'timebank') room.useTimeBank(id);
      else if (what === 'emoji') room.emoji(id, String(body.emoji));
      else if (what === 'preaction') room.setPreAction(id, body.on === true);
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      if (e instanceof RoomError) return sendJson(res, e.status, { error: e.message });
      console.error(e);
      return sendJson(res, 500, { error: 'Something went wrong' });
    }
  }

  const server = http.createServer(handle);

  // Keep streams alive through proxies, and forget tables nobody has touched for hours.
  const housekeeping = setInterval(() => {
    for (const room of rooms.values()) room.ping();
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (now - room.lastActivity > ROOM_TTL_MS && room.clients.size === 0) {
        room.destroy();
        rooms.delete(code);
      }
    }
  }, 20000);
  housekeeping.unref();

  server.on('close', () => {
    clearInterval(housekeeping);
    for (const room of rooms.values()) room.destroy();
    rooms.clear();
  });

  return { server, rooms };
}

module.exports = { createApp };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const turnMs = (Number(process.env.TURN_SECONDS) || 30) * 1000;
  const handPauseMs = (Number(process.env.HAND_PAUSE_SECONDS) || 6) * 1000;
  const runoutSpeed = Number(process.env.RUNOUT_SPEED) || 1; // only for testing: 0.05 makes all-in run-outs 20x faster
  const { server } = createApp({ turnMs, handPauseMs, runoutSpeed });
  server.listen(port, '0.0.0.0', () => console.log('Poker server running on http://localhost:' + port));
}
