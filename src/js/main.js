/* ======================================================
   ELDEN RING — narrative experience controller
   ====================================================== */

'use strict';

/* ──────────────────────────────────────────────────────
   AUDIO CONTROLLER
   Handles BGM, sequential SFX, and non-overlapping
   dialogue tracks. Respects browser autoplay policy by
   waiting for the first user gesture before playing.
────────────────────────────────────────────────────── */

class AudioController {
  constructor() {
    this.bgm            = null;
    this.dialogue       = null;
    this.unlocked       = false;
    this._pendingBgm    = false;
    this._pendingQueue  = [];

    const unlock = () => {
      if (this.unlocked) return;
      this.unlocked = true;
      if (this._pendingBgm && this.bgm) {
        this.bgm.play().catch(() => {});
      }
      document.removeEventListener('click',     unlock);
      document.removeEventListener('touchstart', unlock);
      document.removeEventListener('keydown',    unlock);
    };
    document.addEventListener('click',     unlock, { passive: true });
    document.addEventListener('touchstart', unlock, { passive: true });
    document.addEventListener('keydown',    unlock, { passive: true });
  }

  startBgm(src, volume = 0.4) {
    this.bgm         = new Audio(src);
    this.bgm.loop    = true;
    this.bgm.volume  = volume;
    this.bgm.preload = 'auto';
    if (this.unlocked) {
      this.bgm.play().catch(() => {});
    } else {
      this._pendingBgm = true;
    }
  }

  stopBgm(fadeDuration = 2500) {
    if (!this.bgm || this.bgm.paused) return;
    const bgm     = this.bgm;
    const initial = bgm.volume;
    const step    = initial / (fadeDuration / 50);
    const id = setInterval(() => {
      if (bgm.volume > step) {
        bgm.volume -= step;
      } else {
        bgm.pause();
        bgm.volume = initial;
        clearInterval(id);
      }
    }, 50);
  }

  crossfadeToBgm(newSrc, fadeDuration = 2000, newVolume = 0.4) {
    this.stopBgm(fadeDuration);
    setTimeout(() => this.startBgm(newSrc, newVolume), fadeDuration * 0.6);
  }

  playSfxSimultaneous(srcs, volume = 1) {
    if (!this.unlocked || !srcs.length) return;
    for (const src of srcs) {
      const sfx = new Audio(src);
      sfx.volume = volume;
      sfx.play().catch(() => {});
    }
  }

  playSfxSequence(srcs, volume = 1) {
    if (!this.unlocked || !srcs.length) return;
    const [first, ...rest] = srcs;
    const sfx = new Audio(first);
    sfx.volume = volume;
    sfx.play().catch(() => {});
    if (rest.length) {
      sfx.addEventListener('ended', () => this.playSfxSequence(rest, volume), { once: true });
    }
  }

  playDialogue(src) {
    if (this.dialogue) {
      this.dialogue.pause();
      this.dialogue.currentTime = 0;
      this.dialogue = null;
    }
    if (!this.unlocked) return;
    this.dialogue = new Audio(src);
    this.dialogue.volume = 1;
    this.dialogue.play().catch(() => {});
  }

  stopDialogue() {
    if (!this.dialogue) return;
    this.dialogue.pause();
    this.dialogue = null;
  }
}

/* ──────────────────────────────────────────────────────
   ERDTREE CANVAS PLAYER
   Windowed frame cache — keeps ±25 frames in memory,
   evicting the rest. Preloads ahead on each seek.
────────────────────────────────────────────────────── */

class ErdtreePlayer {
  static FRAME_COUNT = 1340;
  static BASE_IDX    = 10000;
  static AHEAD       = 22;
  static BEHIND      = 6;

  constructor(canvas) {
    this.canvas       = canvas;
    this.ctx          = canvas.getContext('2d');
    this.cache        = new Map();
    this.loading      = new Set();
    this.currentFrame = -1;
    this._resize();
    window.addEventListener('resize', () => this._resize(), { passive: true });
  }

  _resize() {
    this.canvas.width  = window.innerWidth;
    this.canvas.height = window.innerHeight;
    if (this.currentFrame >= 0) {
      const img = this.cache.get(this.currentFrame);
      if (img) this._draw(img);
    }
  }

  _src(i) {
    return `erdtree/Comp ${ErdtreePlayer.BASE_IDX + i}.png`;
  }

  _load(i) {
    if (i < 0 || i >= ErdtreePlayer.FRAME_COUNT) return;
    if (this.cache.has(i) || this.loading.has(i)) return;
    this.loading.add(i);
    const img = new Image();
    img.onload = () => {
      this.loading.delete(i);
      this.cache.set(i, img);
      if (i === this.currentFrame) this._draw(img);
    };
    img.onerror = () => this.loading.delete(i);
    img.src = this._src(i);
  }

  _evict(center) {
    for (const k of this.cache.keys()) {
      if (k < center - ErdtreePlayer.BEHIND || k > center + ErdtreePlayer.AHEAD) {
        this.cache.delete(k);
      }
    }
  }

  _draw(img) {
    const cw = this.canvas.width, ch = this.canvas.height;
    const scale = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
    const w = img.naturalWidth  * scale;
    const h = img.naturalHeight * scale;
    this.ctx.clearRect(0, 0, cw, ch);
    this.ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
  }

  seek(frameIdx) {
    frameIdx = Math.max(0, Math.min(ErdtreePlayer.FRAME_COUNT - 1, frameIdx));
    this._evict(frameIdx);
    const end = Math.min(frameIdx + ErdtreePlayer.AHEAD, ErdtreePlayer.FRAME_COUNT - 1);
    for (let i = frameIdx; i <= end; i++) this._load(i);
    if (frameIdx !== this.currentFrame) {
      this.currentFrame = frameIdx;
      const img = this.cache.get(frameIdx);
      if (img) this._draw(img);
    }
  }

  init() {
    for (let i = 0; i < Math.min(30, ErdtreePlayer.FRAME_COUNT); i++) {
      this._load(i);
    }
  }
}

/* ──────────────────────────────────────────────────────
   NARRATION CONTROLLER
   Maps vertical scroll progress (0→1) across 14 slides.
   Each slide fades in, holds, fades out independently.
   Triggers audio on slide activation.
────────────────────────────────────────────────────── */

const DIALOGUE_TRACKS = [
  'audio/dialogue/Elden Ring.wav',
  'audio/dialogue/O Elden Ring.wav',
  'audio/dialogue/its gold commanded the very stars.wav',
  'audio/dialogue/giving life its fullest brilliance.wav',
  'audio/dialogue/Shattered, by someone, or something.wav',
  'audio/dialogue/Godrick, the feeble.wav',
  'audio/dialogue/Malenia, decayed from birth.wav',
  'audio/dialogue/General Radahn, slayer of giants.wav',
  'audio/dialogue/Rykard, the tyrannical serpent.wav',
  'audio/dialogue/And Morgott, Prince of the Omen.wav',
  'audio/dialogue/Each, inheriting their own shard, played a part in the Shattering.wav',
  'audio/dialogue/a war with no end, and no victor.wav',
  'audio/dialogue/And so the Two Fingers call upon ye, the Tarnished.wav',
  'audio/dialogue/To cross the Sea of Fog, to the Lands Between To seek the Elden Ring. Seek the Elden Ring.wav',
];

class NarrationController {
  constructor(stage, audio) {
    this.slides       = Array.from(stage.querySelectorAll('.nslide'));
    this.audio        = audio;
    this.activeSlide  = -1;
    this.total        = this.slides.length;
  }

  update(progress) {
    const FADE_IN  = 0.15;
    const FADE_OUT = 0.85;

    for (let i = 0; i < this.total; i++) {
      const zoneSize  = 1 / this.total;
      const zoneStart = i * zoneSize;
      const local     = (progress - zoneStart) / zoneSize;

      let opacity = 0;
      if (local >= 0 && local <= 1) {
        if      (local < FADE_IN)  opacity = local / FADE_IN;
        else if (local > FADE_OUT) opacity = (1 - local) / (1 - FADE_OUT);
        else                        opacity = 1;
      }

      this.slides[i].style.opacity = opacity;

      const isActive = local >= 0.2 && local <= 0.8;
      if (isActive && this.activeSlide !== i) {
        this.activeSlide = i;
        this.audio.playDialogue(DIALOGUE_TRACKS[i]);
      }
    }
  }
}

/* ──────────────────────────────────────────────────────
   SIDE NAV
   Updates active dot based on current scroll position.
   Clicking a dot smooth-scrolls to the target section.
────────────────────────────────────────────────────── */

class SideNav {
  constructor() {
    this.nav     = document.getElementById('sidenav');
    this.dots    = Array.from(this.nav.querySelectorAll('.nav-dot'));
    this.targets = this.dots.map(d => document.getElementById(d.dataset.target));

    this.dots.forEach((dot, i) => {
      dot.addEventListener('click', () => {
        this.targets[i]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  update(scrollY, vh) {
    const heroEl  = document.getElementById('hero');
    const heroEnd = heroEl.offsetTop + heroEl.offsetHeight;
    this.nav.classList.toggle('visible', scrollY > heroEnd * 0.6);

    let active = 0;
    for (let i = 0; i < this.targets.length; i++) {
      const el = this.targets[i];
      if (!el) continue;
      if (scrollY >= el.offsetTop - vh * 0.45) active = i;
    }
    this.dots.forEach((d, i) => d.classList.toggle('active', i === active));
  }
}

/* ──────────────────────────────────────────────────────
   CHOICE OVERLAY (Phase 3)
   Shows dialog on Layer 6 click.
   "Yes" → fade to black → scroll to narration.
   "No"  → smooth scroll to footer.
────────────────────────────────────────────────────── */

class ChoiceOverlay {
  constructor(audio) {
    this.dialog    = document.getElementById('choice-overlay');
    this.fadeEl    = document.getElementById('fade-overlay');
    this.hoverImg  = document.getElementById('rt-hover');
    this.glowImg   = document.getElementById('rt-glow');
    this.audio     = audio;

    this.hoverImg.addEventListener('click', () => this._open());
    this.dialog.addEventListener('close',  () => this._onClose());
  }

  _open() {
    this.glowImg.style.opacity = '1';
    this.dialog.showModal();
  }

  _onClose() {
    this.glowImg.style.removeProperty('opacity');
    const answer = this.dialog.returnValue;
    if (answer === 'yes') {
      this._transitionToNarration();
    } else {
      document.getElementById('footer').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  _transitionToNarration() {
    this.audio.crossfadeToBgm('audio/music/scroll music.wav', 1500, 0.35);
    this.fadeEl.classList.add('active');
    setTimeout(() => {
      document.getElementById('narration-scroll')
        .scrollIntoView({ behavior: 'instant', block: 'start' });
      setTimeout(() => {
        this.fadeEl.classList.remove('active');
      }, 50);
    }, 750);
  }
}

/* ──────────────────────────────────────────────────────
   ROUNDTABLE HOLD — wake-up sequence
   Triggers once when the section enters the viewport.
   Plays BGM → sigh → my_oh_my in sequence.
────────────────────────────────────────────────────── */

class RoundtableHold {
  constructor(audio) {
    this.section = document.getElementById('roundtable');
    this.audio   = audio;
    this.awoken  = false;
  }

  tryAwaken(scrollY, vh) {
    if (this.awoken) return;
    const rect = this.section.getBoundingClientRect();
    if (rect.top < vh * 0.6) {
      this.awoken = true;
      this.section.classList.add('rt-awake');
      this.audio.startBgm('audio/music/1-08 Roundtable Hold.mp3', 0.4);
      this.audio.playSfxSimultaneous([
        'audio/sfx/walking.wav',
        'audio/sfx/Roundtable sfx.wav',
      ], 0.7);
      setTimeout(() => {
        this.audio.playSfxSequence([
          'audio/dialogue/sigh.wav',
          'audio/dialogue/my oh my.wav',
        ]);
      }, 800);
    }
  }
}

/* ──────────────────────────────────────────────────────
   MAIN APP ORCHESTRATOR
────────────────────────────────────────────────────── */

class EldenRingApp {
  constructor() {
    this.audio      = new AudioController();
    this.sidenav    = new SideNav();
    this.roundtable = new RoundtableHold(this.audio);
    this.choice     = new ChoiceOverlay(this.audio);

    this.narrationEl = document.getElementById('narration-scroll');
    this.narrationCtrl = new NarrationController(
      document.getElementById('narration-stage'),
      this.audio
    );

    this.erdtreeEl = document.getElementById('erdtree-scroll');
    this.erdtree   = new ErdtreePlayer(document.getElementById('erdtree-canvas'));
    this.erdtree.init();

    this.fadeEls = Array.from(document.querySelectorAll('.fade-in'));

    this._ticking = false;
    window.addEventListener('scroll', () => this._scheduleUpdate(), { passive: true });
    window.addEventListener('resize', () => this._update(), { passive: true });
    this._update();
  }

  _scheduleUpdate() {
    if (!this._ticking) {
      requestAnimationFrame(() => {
        this._update();
        this._ticking = false;
      });
      this._ticking = true;
    }
  }

  _update() {
    const scrollY = window.scrollY;
    const vh      = window.innerHeight;

    this.sidenav.update(scrollY, vh);
    this.roundtable.tryAwaken(scrollY, vh);
    this._updateFadeIns(vh);
    this._updateNarration(scrollY, vh);
    this._updateErdtree(scrollY, vh);
  }

  _updateFadeIns(vh) {
    for (const el of this.fadeEls) {
      if (!el.classList.contains('visible')) {
        const rect = el.getBoundingClientRect();
        if (rect.top < vh * 0.88) el.classList.add('visible');
      }
    }
  }

  _updateNarration(scrollY, vh) {
    const top    = this.narrationEl.offsetTop;
    const height = this.narrationEl.offsetHeight - vh;
    const progress = Math.max(0, Math.min(1, (scrollY - top) / height));
    this.narrationCtrl.update(progress);
  }

  _updateErdtree(scrollY, vh) {
    const top      = this.erdtreeEl.offsetTop;
    const height   = this.erdtreeEl.offsetHeight - vh;
    const progress = Math.max(0, Math.min(1, (scrollY - top) / height));
    const frame    = Math.floor(progress * (ErdtreePlayer.FRAME_COUNT - 1));
    this.erdtree.seek(frame);
  }
}

/* ── Boot ──────────────────────────────────────────── */

window.app = new EldenRingApp();
