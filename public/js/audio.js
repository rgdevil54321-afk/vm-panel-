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
    tone(freq, dur, { type = 'sine', vol = 0.5, delay = 0, slideTo = null } = {}) {
      const ctx = SFX.ensure();
      if (!ctx) return;
      const t0 = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
      const v = vol * (S.sfx_volume / 100 || 0.4);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(v, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    },
    play(name) {
      if (S.sfx_enabled === false) return;
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
  // MUSIC PLAYER
  // ============================================================
  const dock = document.createElement('div');
  dock.className = 'music-player';
  dock.id = 'musicPlayerDock';
  dock.style.display = 'none';
  dock.innerHTML =
    '<span class="music-eq" id="musicEq"><span></span><span></span><span></span></span>' +
    '<div class="music-info"><div class="music-title" id="musicTitle">Music</div><div class="music-note" id="musicNote">off</div></div>' +
    '<div class="music-controls">' +
      '<button class="music-btn" id="musicPrev" title="Previous"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M7 6l9 6-9 6z" fill="currentColor"/><rect x="6" y="6" width="2" height="12" rx="1"/></svg></button>' +
      '<button class="music-btn music-playbtn" id="musicPlay" title="Play/Pause"><svg id="musicPlayIcon" viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M8 5v14l11-7z"/></svg></button>' +
      '<button class="music-btn" id="musicNext" title="Skip"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M8 6l9 6-9 6z" fill="currentColor"/><rect x="16" y="6" width="2" height="12" rx="1"/></svg></button>' +
    '</div>' +
    '<input type="range" id="musicVol" class="music-vol" min="0" max="100" step="1" title="Volume"/>';

  const Music = {
    queue: [],
    idx: 0,
    get src() {
      if (S.music_mode === 'file') return S.music_file;
      if (S.music_mode === 'url') return S.music_url;
      return '';
    },
    buildQueue() {
      const s = Music.src;
      this.queue = s ? [s] : [];
      this.idx = 0;
    },
    async refresh() {
      Music.buildQueue();
      if (S.music_mode === 'none' || !Music.queue.length) {
        audioEl.pause();
        audioEl.removeAttribute('src');
        audioEl.load();
        dock.style.display = 'none';
        Music.renderPlay();
        return;
      }
      audioEl.loop = !!S.music_loop;
      audioEl.volume = (S.music_volume / 100 || 0.35);
      if (audioEl.getAttribute('src') !== Music.queue[this.idx]) {
        audioEl.src = Music.queue[this.idx];
        audioEl.load();
      }
      dock.style.display = 'flex';
      Music.renderTitle();
      if (S.music_autoplay) Music.play();
    },
    play() {
      if (!Music.queue.length) return;
      audioEl.play().then(() => {
        dock.dataset.playing = '1';
        Music.renderPlay();
        SFX.play('start');
      }).catch(() => {});
    },
    pause() {
      audioEl.pause();
      delete dock.dataset.playing;
      Music.renderPlay();
      SFX.play('stop');
    },
    toggle() {
      if (audioEl.paused) Music.play(); else Music.pause();
    },
    next() {
      if (Music.queue.length < 2) return;
      Music.idx = (Music.idx + 1) % Music.queue.length;
      Music.refresh().then(() => Music.play());
    },
    prev() {
      if (Music.queue.length < 2) return;
      Music.idx = (Music.idx - 1 + Music.queue.length) % Music.queue.length;
      Music.refresh().then(() => Music.play());
    },
    renderTitle() {
      const el = document.getElementById('musicTitle');
      const note = document.getElementById('musicNote');
      if (el) el.textContent = S.music_title || 'Music';
      if (note) note.textContent = Music.queue[this.idx] ? 'playing' : 'off';
    },
    renderPlay() {
      const icon = document.getElementById('musicPlayIcon');
      if (icon) icon.innerHTML = audioEl.paused ? '<path d="M8 5v14l11-7z"/>' : '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>';
    },
  };

  // Build dock + wire controls
  document.body.appendChild(dock);
  document.getElementById('musicPlay').addEventListener('click', () => Music.toggle());
  document.getElementById('musicNext').addEventListener('click', () => Music.next());
  document.getElementById('musicPrev').addEventListener('click', () => Music.prev());
  const volRange = document.getElementById('musicVol');
  volRange.value = S.music_volume;
  volRange.addEventListener('input', (e) => {
    const v = e.target.value;
    audioEl.volume = v / 100;
    try { fetch('/api/settings/music-volume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ volume: v }) }).catch(() => {}); } catch (_) {}
  });
  audioEl.addEventListener('ended', () => { if (!audioEl.loop) Music.next(); });
  audioEl.addEventListener('pause', Music.renderPlay);
  audioEl.addEventListener('play', Music.renderPlay);

  // ============================================================
  // GLOBAL WIRING
  // ============================================================
  window.SFX = SFX;
  window.Music = Music;

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

  // Init once DOM ready
  function init() {
    Music.refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
