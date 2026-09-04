(function () {
  const S = (window.APP_SETTINGS = window.APP_SETTINGS || {});
  const audioEl = document.createElement('audio');
  audioEl.setAttribute('preload', 'metadata');
  document.body.appendChild(audioEl);

  // ============================================================
  // SYNTHESIZED SOUND EFFECTS (WebAudio — no files required)
  // ============================================================
  let actx = null;
  const SFX = {
    ensure() {
      if (!actx) {
        try {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (AC) actx = new AC();
        } catch (_) {}
      }
      if (actx && actx.state === 'suspended') actx.resume().catch(() => {});
      return actx;
    },
    userWantsSfx() {
      return S.sfx_user_enabled !== false; // per-user setting injected by head.ejs
    },
    tone(freq, dur, { type = 'sine', vol = 0.5, delay = 0, slideTo = null } = {}) {
      const ctx = SFX.ensure();
      if (!ctx) return;
      const t0 = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
      const v = vol * ((S.sfx_volume / 100) || 0.4);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(v, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    },
    play(name) {
      if (!SFX.userWantsSfx()) return;
      try {
        const g = (f, d, o) => SFX.tone(f, d, o);
        switch (name) {
          case 'click': g(520, 0.06, { type: 'triangle', vol: 0.35 }); break;
          case 'toggle': g(700, 0.05, { type: 'triangle', vol: 0.3 }); break;
          case 'success': g(660, 0.09, { type: 'sine', vol: 0.4 }); g(880, 0.11, { type: 'sine', vol: 0.4, delay: 0.09 }); break;
          case 'error': g(300, 0.12, { type: 'sawtooth', vol: 0.3 }); g(220, 0.15, { type: 'sawtooth', vol: 0.28, delay: 0.12 }); break;
          case 'notify': g(1046, 0.08, { type: 'sine', vol: 0.35 }); g(1318, 0.1, { type: 'sine', vol: 0.35, delay: 0.07 }); break;
          case 'start': g(440, 0.08, { type: 'triangle', vol: 0.35 }); g(660, 0.1, { type: 'triangle', vol: 0.35, delay: 0.08 }); break;
          case 'stop': g(660, 0.08, { type: 'triangle', vol: 0.35 }); g(400, 0.1, { type: 'triangle', vol: 0.35, delay: 0.08 }); break;
          case 'boot': g(523, 0.07, { type: 'triangle', vol: 0.3 }); g(659, 0.07, { type: 'triangle', vol: 0.3, delay: 0.07 }); g(784, 0.09, { type: 'triangle', vol: 0.3, delay: 0.14 }); break;
          default: break;
        }
      } catch (e) {}
    },
  };

  // ============================================================
  // SOFT CALM AMBIENT MUSIC — generated live (no audio files!)
  // Gentle evolving pads on a pentatonic scale + slow "breathing"
  // ============================================================
  const Ambient = {
    master: null,
    nodes: [],
    breathTimer: null,
    chordTimer: null,
    playing: false,
    volume: 0.35,

    // Pentatonic-ish chord sets that always sound calm together
    chords: [
      [220.00, 277.18, 329.63],        // A minor-ish pad
      [196.00, 246.94, 293.66],        // G major-ish pad
      [174.61, 220.00, 261.63],        // F major-ish pad
      [164.81, 207.65, 246.94],        // E minor-ish pad
    ],
    chordIdx: 0,

    ensureMaster() {
      const ctx = SFX.ensure();
      if (!ctx) return null;
      if (!Ambient.master) {
        Ambient.master = ctx.createGain();
        Ambient.master.gain.value = Ambient.volume;
        // gentle low-pass to keep everything soft & warm
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 900;
        Ambient.master.connect(lp).connect(ctx.destination);
      }
      return Ambient.master;
    },

    spawnPad(freq, when, dur) {
      const ctx = actx;
      if (!ctx) return;
      const master = Ambient.ensureMaster();
      if (!master) return;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      // slight detune shimmer
      try { osc.detune.value = (Math.random() * 8 - 4); } catch (_) {}

      const t0 = when;
      const attack = dur * 0.35;
      const release = dur * 0.65;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(0.055, t0 + attack);  // very quiet voices
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + release);

      osc.connect(gain).connect(master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.1);
    },

    playChord() {
      const ctx = SFX.ensure();
      if (!ctx || !Ambient.playing) return;
      const chord = Ambient.chords[Ambient.chordIdx % Ambient.chords.length];
      Ambient.chordIdx++;
      const now = ctx.currentTime + 0.05;
      // each voice enters slightly staggered for a human feel
      chord.forEach((f, i) => Ambient.spawnPad(f, now + i * 0.9, 14));
      // add a soft octave sparkle occasionally
      if (Math.random() < 0.5) {
        Ambient.spawnPad(chord[1] * 2, now + 3 + Math.random() * 3, 9);
      }
    },

    start() {
      if (Ambient.playing) return;
      const ctx = SFX.ensure();
      if (!ctx) return;
      Ambient.playing = true;
      Ambient.ensureMaster();
      Ambient.playChord();
      Ambient.chordTimer = setInterval(() => Ambient.playChord(), 9000);
    },

    stop() {
      Ambient.playing = false;
      clearInterval(Ambient.chordTimer);
      const ctx = actx;
      if (Ambient.master && ctx) {
        // fade out gracefully instead of hard cut
        try {
          Ambient.master.gain.cancelScheduledValues(ctx.currentTime);
          Ambient.master.gain.setValueAtTime(Ambient.master.gain.value, ctx.currentTime);
          Ambient.master.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 1.2);
          setTimeout(() => {
            try { Ambient.master.disconnect(); } catch (_) {}
            Ambient.master = null;
          }, 1400);
        } catch (_) { Ambient.master = null; }
      }
    },

    setVolume(v) {
      Ambient.volume = v;
      if (Ambient.master) Ambient.master.gain.value = v;
    },

    toggle() {
      if (Ambient.playing) Ambient.stop();
      else Ambient.start();
      Ambient.render();
      Ambient.persist();
      return Ambient.playing;
    },

    persist() {
      // Save the user preference (per-user via cookie auth)
      try {
        fetch('/api/user/ambient-music', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: Ambient.playing }),
        }).catch(() => {});
      } catch (_) {}
    },

    render() {
      const btn = document.getElementById('ambientToggle');
      if (!btn) return;
      btn.dataset.on = Ambient.playing ? '1' : '0';
      btn.innerHTML = Ambient.playing
        ? '<span class="amb-dot"></span> Ambient Music: ON'
        : 'Ambient Music: OFF';
    },
  };

  // ============================================================
  // GLOBAL WIRING
  // ============================================================
  window.SFX = SFX;
  window.Ambient = Ambient;
  S.ambient_user_enabled = S.ambient_user_enabled !== false; // per-user, injected by head.ejs

  document.addEventListener('click', (e) => {
    if (e.target.closest('button, .tab, a.btn, .wall-card')) SFX.play('click');
  });

  // Hook into toasts
  const origToast = window.VP && window.VP.toast;
  if (origToast) {
    window.VP.toast = function (msg, type) {
      origToast(msg, type);
      if (type === 'success') SFX.play('success');
      else if (type === 'error') SFX.play('error');
      else SFX.play('notify');
    };
  }

  // Start ambient music if the user enabled it (needs a user gesture on
  // some browsers — resume the context on the first click anywhere).
  function tryAutostart() {
    if (S.ambient_user_enabled && !Ambient.playing) Ambient.start();
  }
  document.addEventListener('click', function unlock() {
    tryAutostart();
    document.removeEventListener('click', unlock);
  }, { once: true });

  // Init once DOM ready
  function init() {
    Ambient.render();
    // sync the toggle UI if present (user settings page)
    const btn = document.getElementById('ambientToggle');
    if (btn) {
      btn.addEventListener('click', () => {
        Ambient.toggle();
        if (window.SFX) SFX.play('toggle');
      });
    }
    // instant click on the page can also start it (user intent signal)
    document.addEventListener('click', () => { if (S.ambient_user_enabled) SFX.ensure(); }, { once: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
