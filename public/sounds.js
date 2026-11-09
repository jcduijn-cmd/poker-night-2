'use strict';
// Poker night sounds. Everything is synthesised with the Web Audio API,
// so there are no audio files to download. Browsers only allow sound after
// the first tap, which unlock() takes care of.
window.Sound = (() => {
  let ctx = null;
  let master = null;
  let noiseBuf = null;
  let enabled = true;
  let beat = null;

  try { enabled = localStorage.getItem('poker.sound') !== 'off'; } catch (e) { /* private mode */ }

  function ensure() {
    if (!enabled) return null;
    if (!ctx) {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.55;
        master.connect(ctx.destination);
        noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      } catch (e) { ctx = null; return null; }
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // A short pitched note with a quick fade.
  function tone(freq, start, dur, o = {}) {
    const c = ensure();
    if (!c) return;
    const t = c.currentTime + start;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(freq, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + dur);
    const peak = o.gain ?? 0.2;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + (o.attack ?? 0.006));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(master);
    osc.start(t); osc.stop(t + dur + 0.05);
  }

  // A burst of filtered noise: cards, chips, swishes.
  function noise(start, dur, o = {}) {
    const c = ensure();
    if (!c) return;
    const t = c.currentTime + start;
    const src = c.createBufferSource();
    src.buffer = noiseBuf;
    src.playbackRate.value = o.rate || 1;
    const f = c.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.frequency.setValueAtTime(o.freq || 3000, t);
    if (o.sweepTo) f.frequency.exponentialRampToValueAtTime(o.sweepTo, t + dur);
    f.Q.value = o.q || 0.8;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.gain ?? 0.25, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05);
  }

  const api = {
    unlock() { ensure(); },
    isEnabled() { return enabled; },
    setEnabled(v) {
      enabled = !!v;
      try { localStorage.setItem('poker.sound', enabled ? 'on' : 'off'); } catch (e) { /* ignore */ }
      if (!enabled) api.heartbeat(false); else ensure();
    },

    // Cards sliding onto the felt.
    deal() { for (let i = 0; i < 2; i++) noise(i * 0.11, 0.07, { freq: 4200, q: 0.9, gain: 0.22 }); },
    flip(n = 1) { for (let i = 0; i < n; i++) noise(i * 0.13, 0.09, { freq: 3200, sweepTo: 5200, q: 1.1, gain: 0.26 }); },
    chip() {
      noise(0, 0.05, { freq: 5200, q: 2, gain: 0.2 });
      tone(2300, 0.005, 0.05, { type: 'triangle', gain: 0.1 });
      noise(0.07, 0.05, { freq: 4600, q: 2, gain: 0.16 });
    },
    check() { tone(190, 0, 0.1, { to: 85, gain: 0.35 }); noise(0, 0.05, { type: 'lowpass', freq: 700, gain: 0.25 }); },
    fold() { noise(0, 0.22, { freq: 2600, sweepTo: 500, q: 0.7, gain: 0.2 }); },
    turn() { tone(660, 0, 0.14, { gain: 0.18 }); tone(880, 0.12, 0.2, { gain: 0.2 }); },
    tick() { tone(1150, 0, 0.04, { type: 'square', gain: 0.07 }); },
    emoji() { tone(520, 0, 0.09, { to: 980, gain: 0.14 }); },
    allIn() {
      tone(70, 0, 0.9, { type: 'sawtooth', to: 150, gain: 0.16, attack: 0.1 });
      noise(0, 0.8, { type: 'lowpass', freq: 200, sweepTo: 900, gain: 0.3 });
    },
    win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.1, 0.35, { type: 'triangle', gain: 0.18 })); },

    // Slow double thump while the cards are dealt after an all-in; speeds up as the river nears.
    heartbeat(on, bpm = 60) {
      if (beat) { clearInterval(beat.timer); beat = null; }
      if (!on || !enabled) return;
      const thump = () => {
        tone(58, 0, 0.16, { to: 40, gain: 0.5, attack: 0.01 });
        tone(52, 0.19, 0.14, { to: 38, gain: 0.32, attack: 0.01 });
      };
      thump();
      beat = { timer: setInterval(thump, 60000 / bpm) };
    },
  };

  // The first tap anywhere allows sound for the rest of the visit.
  const unlock = () => { api.unlock(); };
  document.addEventListener('pointerdown', unlock, { passive: true });
  document.addEventListener('keydown', unlock);
  return api;
})();
