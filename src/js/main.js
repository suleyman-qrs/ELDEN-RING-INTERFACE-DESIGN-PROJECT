/* ======================================================
   ELDEN RING — narrative experience controller
   ====================================================== */

"use strict";

/* ──────────────────────────────────────────────────────
   AUDIO CONTROLLER
   Handles BGM, sequential SFX, and non-overlapping
   dialogue tracks. Respects browser autoplay policy by
   waiting for the first user gesture before playing.
────────────────────────────────────────────────────── */

class AudioController {
  constructor() {
    this.bgm = null;
    this.dialogue = null;
    this.unlocked = false;
    this._pendingBgm = false;

    const UNLOCK_EVENTS = [
      "click",
      "touchstart",
      "keydown",
      "wheel",
      "pointerdown",
    ];
    this._unlockCallbacks = [];
    const unlock = () => {
      if (this.unlocked) return;
      this.unlocked = true;
      if (this._pendingBgm && this.bgm) {
        this._tryPlay(this.bgm);
      }
      for (const cb of this._unlockCallbacks) cb();
      this._unlockCallbacks = [];
      for (const evt of UNLOCK_EVENTS) {
        document.removeEventListener(evt, unlock);
      }
    };
    for (const evt of UNLOCK_EVENTS) {
      document.addEventListener(evt, unlock, { passive: true });
    }
  }

  _tryPlay(audio) {
    const result = audio.play();
    if (result !== undefined) {
      result.catch((err) => {
        console.warn("Audio play failed:", err);
        // Retry once canplay fires in case the file is still loading
        audio.addEventListener(
          "canplay",
          () =>
            audio.play().catch((e) => console.warn("Audio retry failed:", e)),
          { once: true },
        );
      });
    }
  }

  startBgm(src, volume = 0.4) {
    if (this.bgm && !this.bgm.paused) {
      this.bgm.pause();
    }
    this.bgm = new Audio(src);
    this.bgm.loop = true;
    this.bgm.volume = volume;
    this.bgm.preload = "auto";
    this.bgm.load();
    if (this.unlocked) {
      this._tryPlay(this.bgm);
    } else {
      this._pendingBgm = true;
    }
  }

  stopBgm(fadeDuration = 2500) {
    if (!this.bgm || this.bgm.paused) return;
    const bgm = this.bgm;
    const initial = bgm.volume;
    const step = initial / (fadeDuration / 50);
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
      sfx.addEventListener("ended", () => this.playSfxSequence(rest, volume), {
        once: true,
      });
    }
  }

  // loop: when the final track ends, restart from the top of srcs
  playDialogueSequence(srcs, loop = false) {
    if (this.dialogue) {
      this.dialogue.pause();
      this.dialogue.currentTime = 0;
      this.dialogue = null;
    }
    if (!this.unlocked || !srcs.length) return;
    const [first, ...rest] = srcs;
    this.dialogue = new Audio(first);
    this.dialogue.volume = 1;
    this.dialogue.play().catch(() => {});
    if (rest.length) {
      this.dialogue.addEventListener(
        "ended",
        () => this.playDialogueSequence(rest, loop),
        { once: true },
      );
    } else if (loop) {
      this.dialogue.addEventListener(
        "ended",
        () => this.playDialogueSequence(srcs, loop),
        { once: true },
      );
    }
  }

  stopDialogue() {
    if (!this.dialogue) return;
    this.dialogue.pause();
    this.dialogue = null;
  }

  onUnlock(cb) {
    if (this.unlocked) {
      cb();
    } else {
      this._unlockCallbacks.push(cb);
    }
  }
}

/* ──────────────────────────────────────────────────────
   SCENE DATA
   12 PNG sequences, one per narration line.
   Each entry maps to Scenes/<dir>/<prefix>NN.png.
────────────────────────────────────────────────────── */

const SCENES = [
  {
    dir: "Scenes/01_Elden_Ring",
    prefix: "Elden_ring",
    count: 55,
    audio: ["audio/dialogue/Elden Ring.wav", "audio/dialogue/O Elden Ring.wav"],
    text: "Elden Ring. O, Elden Ring.",
  },
  {
    dir: "Scenes/02_Its_Gold",
    prefix: "its_Gold_commanded",
    count: 59,
    audio: ["audio/dialogue/its gold commanded the very stars.wav"],
    text: "Its gold commanded<br>the very stars,",
  },
  {
    dir: "Scenes/03_Shattered",
    prefix: "shattered",
    count: 63,
    audio: ["audio/dialogue/Shattered, by someone, or something.wav"],
    text: "Shattered, by someone,<br>or something.",
  },
  {
    dir: "Scenes/04_Godrick",
    prefix: "godrick",
    count: 58,
    audio: ["audio/dialogue/Godrick, the feeble.wav"],
    text: "Godrick, the feeble.",
  },
  {
    dir: "Scenes/05_Malenia",
    prefix: "malenia",
    count: 60,
    audio: ["audio/dialogue/Malenia, decayed from birth.wav"],
    text: "Malenia, decayed from birth.",
  },
  {
    dir: "Scenes/06_General_Radah",
    prefix: "general_radahn",
    count: 47,
    audio: ["audio/dialogue/General Radahn, slayer of giants.wav"],
    text: "General Radahn,<br>slayer of giants.",
  },
  {
    dir: "Scenes/07_Rykard",
    prefix: "rykard",
    count: 61,
    audio: ["audio/dialogue/Rykard, the tyrannical serpent.wav"],
    text: "Rykard,<br>the tyrannical serpent.",
  },
  {
    dir: "Scenes/08_Morgott",
    prefix: "morgott",
    count: 64,
    audio: ["audio/dialogue/And Morgott, Prince of the Omen.wav"],
    text: "And Morgott,<br>Prince of the Omen.",
  },
  {
    dir: "Scenes/09_Each_Inheriting",
    prefix: "each_inheriting",
    count: 47,
    audio: [
      "audio/dialogue/Each, inheriting their own shard, played a part in the Shattering.wav",
    ],
    text: "Each, inheriting their own shard,<br>played a part in the Shattering,",
  },
  {
    dir: "Scenes/10_A_War",
    prefix: "a_war",
    count: 43,
    audio: ["audio/dialogue/a war with no end, and no victor.wav"],
    text: "a war with no end,<br>and no victor.",
  },
  {
    dir: "Scenes/11_and_so_the_two_Fingers",
    prefix: "and_so_the_two_fingers",
    count: 45,
    audio: [
      "audio/dialogue/And so the Two Fingers call upon ye, the Tarnished.wav",
    ],
    text: "And so the Two Fingers<br>call upon ye, the Tarnished.",
  },
  {
    dir: "Scenes/12_To_cross_the_fog",
    prefix: "to_cross_the_fog",
    count: 92,
    audio: [
      "audio/dialogue/To cross the Sea of Fog, to the Lands Between To seek the Elden Ring. Seek the Elden Ring.wav",
    ],
    text: "To cross the Sea of Fog,<br>to the Lands Between.<br><br>To seek the Elden Ring.<br>Seek the Elden Ring.",
    loop: true,
  },
];

const TOTAL_FRAMES = SCENES.reduce((sum, s) => sum + s.count, 0);

/* ──────────────────────────────────────────────────────
   NARRATION CANVAS PLAYER
   Windowed frame cache — keeps ±25 frames in memory,
   evicting the rest. Preloads ahead on each seek.
────────────────────────────────────────────────────── */

class ErdtreePlayer {
  static AHEAD = 22;
  static BEHIND = 6;

  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.cache = new Map();
    this.loading = new Set();
    this.currentFrame = -1;
    this._resize();
    window.addEventListener("resize", () => this._resize(), { passive: true });
  }

  _resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    if (this.currentFrame >= 0) {
      const img = this.cache.get(this.currentFrame);
      if (img) this._draw(img);
    }
  }

  _src(i) {
    let g = i;
    for (const scene of SCENES) {
      if (g < scene.count) {
        return `${scene.dir}/${scene.prefix}${String(g).padStart(2, "0")}.png`;
      }
      g -= scene.count;
    }
    const last = SCENES[SCENES.length - 1];
    return `${last.dir}/${last.prefix}${String(last.count - 1).padStart(2, "0")}.png`;
  }

  _load(i) {
    if (i < 0 || i >= TOTAL_FRAMES) return;
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
      if (
        k < center - ErdtreePlayer.BEHIND ||
        k > center + ErdtreePlayer.AHEAD
      ) {
        this.cache.delete(k);
      }
    }
  }

  _draw(img) {
    const cw = this.canvas.width,
      ch = this.canvas.height;
    const scale = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    this.ctx.clearRect(0, 0, cw, ch);
    this.ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
  }

  seek(frameIdx) {
    frameIdx = Math.max(0, Math.min(TOTAL_FRAMES - 1, frameIdx));
    this._evict(frameIdx);
    const end = Math.min(frameIdx + ErdtreePlayer.AHEAD, TOTAL_FRAMES - 1);
    for (let i = frameIdx; i <= end; i++) this._load(i);
    if (frameIdx !== this.currentFrame) {
      this.currentFrame = frameIdx;
      const img = this.cache.get(frameIdx);
      if (img) this._draw(img);
    }
  }

  init() {
    for (let i = 0; i < Math.min(30, TOTAL_FRAMES); i++) {
      this._load(i);
    }
  }
}

/* ──────────────────────────────────────────────────────
   NARRATION HORIZONTAL SCROLL
   Drives the multi-scene PNG animation via scrollLeft.
   Displays subtitles at bottom-center.
   Triggers dialogue audio per scene.
   Converts vertical wheel → horizontal scroll.
────────────────────────────────────────────────────── */

// Derive chapter cues from SCENES — one cue fires at the first frame of each scene.
// "Giving life" has no dedicated scene folder so it's inserted as a mid-scene-01 cue.
const CHAPTER_CUES = (() => {
  let frame = 0;
  const cues = SCENES.map((s) => {
    const cue = { frame, audio: s.audio, text: s.text, loop: s.loop || false };
    frame += s.count;
    return cue;
  });
  cues.splice(1, 0, {
    frame: 40,
    audio: ["audio/dialogue/giving life its fullest brilliance.wav"],
    text: "Giving life its<br>fullest brilliance.",
  });
  return cues;
})();

class ErdtreeHScroll {
  static FPS = 6; // cinematic playback rate

  constructor(audio) {
    this.section = document.getElementById("erdtree-scroll");
    this.stage = document.getElementById("erdtree-stage");
    this.subtitle = document.getElementById("erdtree-subtitle");
    this.player = new ErdtreePlayer(document.getElementById("erdtree-canvas"));
    this.audio = audio;
    this.chapter = -1;

    this._rafId = null;
    this._lastTs = null;
    this._pauseTimer = null;
    this._tick = this._tick.bind(this);

    this.player.init();

    // Show/hide canvas overlay; start/stop auto-play as section enters/leaves view.
    // Stage uses a higher threshold (0.6) so it fades out quickly once the user
    // scrolls past the section — without this, the fixed canvas blocks visual feedback.
    const io = new IntersectionObserver(
      ([entry]) => {
        const ratio = entry.intersectionRatio;
        this.stage.classList.toggle("active", ratio > 0.6);
        if (ratio > 0.1) {
          this._onScroll();
          this._startPlay();
        } else {
          this.subtitle.classList.remove("visible");
          this.chapter = -1;
          this._stopPlay();
        }
      },
      { threshold: [0, 0.1, 0.6, 1.0] },
    );
    io.observe(this.section);

    // Redirect vertical wheel to horizontal scroll while section fills viewport.
    // Pause auto-play while the user is manually scrubbing.
    window.addEventListener(
      "wheel",
      (e) => {
        const rect = this.section.getBoundingClientRect();
        if (rect.top > 8 || rect.bottom < window.innerHeight - 8) return;
        const maxScroll = this.section.scrollWidth - this.section.clientWidth;
        const atStart = this.section.scrollLeft <= 0;
        const atEnd = this.section.scrollLeft >= maxScroll - 1;
        const goRight = e.deltaY > 0 && !atEnd;
        const goLeft = e.deltaY < 0 && !atStart;
        if ((goRight || goLeft) && Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
          e.preventDefault();
          this.section.scrollLeft += e.deltaY;
          this._onUserScrub();
        }
      },
      { passive: false },
    );

    this.section.addEventListener("scroll", () => this._onScroll(), {
      passive: true,
    });
  }

  // ── Auto-play ────────────────────────────────────────

  _startPlay() {
    if (this._rafId) return;
    this._lastTs = null;
    this._rafId = requestAnimationFrame(this._tick);
  }

  _stopPlay() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
    clearTimeout(this._pauseTimer);
    this._pauseTimer = null;
  }

  _onUserScrub() {
    // Pause auto-play while scrubbing; resume 2 s after last gesture.
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    clearTimeout(this._pauseTimer);
    this._pauseTimer = setTimeout(() => {
      const maxScroll = this.section.scrollWidth - this.section.clientWidth;
      if (this.section.scrollLeft < maxScroll - 1) this._startPlay();
    }, 2000);
  }

  _tick(ts) {
    if (!this._lastTs) this._lastTs = ts;
    const elapsed = ts - this._lastTs;
    const frameDuration = 1000 / ErdtreeHScroll.FPS;

    if (elapsed >= frameDuration) {
      const frames = Math.floor(elapsed / frameDuration);
      this._lastTs = ts - (elapsed % frameDuration);

      const maxScroll = this.section.scrollWidth - this.section.clientWidth;
      if (maxScroll <= 0) {
        this._rafId = requestAnimationFrame(this._tick);
        return;
      }

      const pixPerFrame = maxScroll / (TOTAL_FRAMES - 1);
      const next = this.section.scrollLeft + frames * pixPerFrame;

      if (next >= maxScroll) {
        this.section.scrollLeft = maxScroll;
        this._stopPlay();
        return;
      }
      this.section.scrollLeft = next;
    }

    this._rafId = requestAnimationFrame(this._tick);
  }

  // ── Cue logic (unchanged) ────────────────────────────

  _onScroll() {
    const maxScroll = this.section.scrollWidth - this.section.clientWidth;
    const progress = maxScroll > 0 ? this.section.scrollLeft / maxScroll : 0;
    const frame = Math.round(progress * (TOTAL_FRAMES - 1));

    this.player.seek(frame);

    // Walk backwards through cue points to find the highest one we've passed.
    let chapterIdx = -1;
    for (let i = CHAPTER_CUES.length - 1; i >= 0; i--) {
      if (frame >= CHAPTER_CUES[i].frame) {
        chapterIdx = i;
        break;
      }
    }

    if (chapterIdx >= 0 && chapterIdx !== this.chapter) {
      this.chapter = chapterIdx;
      this.subtitle.innerHTML = CHAPTER_CUES[chapterIdx].text;
      this.subtitle.classList.remove("visible");
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          this.subtitle.classList.add("visible");
        }),
      );
      this.audio.playDialogueSequence(
        CHAPTER_CUES[chapterIdx].audio,
        CHAPTER_CUES[chapterIdx].loop || false,
      );
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
    this.nav = document.getElementById("sidenav");
    this.dots = Array.from(this.nav.querySelectorAll(".nav-dot"));
    this.targets = this.dots.map((d) =>
      document.getElementById(d.dataset.target),
    );

    this.dots.forEach((dot, i) => {
      dot.addEventListener("click", () => {
        this.targets[i]?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  update(scrollY, vh) {
    const heroEl = document.getElementById("hero");
    const heroEnd = heroEl.offsetTop + heroEl.offsetHeight;
    this.nav.classList.toggle("visible", scrollY > heroEnd * 0.6);

    let active = 0;
    for (let i = 0; i < this.targets.length; i++) {
      const el = this.targets[i];
      if (!el) continue;
      if (scrollY >= el.offsetTop - vh * 0.45) active = i;
    }
    this.dots.forEach((d, i) => d.classList.toggle("active", i === active));
  }
}

/* ──────────────────────────────────────────────────────
   CHOICE OVERLAY (Phase 3)
   Shows dialog on Layer 6 click.
   "Yes" → fade to black → scroll to Erdtree sequence.
   "No"  → smooth scroll to footer.
────────────────────────────────────────────────────── */

class ChoiceOverlay {
  constructor(audio) {
    this.dialog = document.getElementById("choice-overlay");
    this.fadeEl = document.getElementById("fade-overlay");
    this.hoverImg = document.getElementById("rt-hover");
    this.glowImg = document.getElementById("rt-glow");
    this.audio = audio;

    this.hoverImg.addEventListener("click", () => this._open());
    this.dialog.addEventListener("close", () => this._onClose());
  }

  _open() {
    this.glowImg.style.opacity = "1";
    this.dialog.showModal();
  }

  _onClose() {
    this.glowImg.style.removeProperty("opacity");
    // Restore page scroll locked by RoundtableHold
    document.body.style.overflow = "";
    const answer = this.dialog.returnValue;
    if (answer === "yes") {
      this._transitionToNarration();
    } else {
      document
        .getElementById("footer")
        .scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  _transitionToNarration() {
    this.audio.crossfadeToBgm("audio/music/scroll music.wav", 1500, 0.35);
    this.fadeEl.classList.add("active");
    setTimeout(() => {
      document
        .getElementById("erdtree-scroll")
        .scrollIntoView({ behavior: "instant", block: "start" });
      setTimeout(() => {
        this.fadeEl.classList.remove("active");
      }, 50);
    }, 750);
  }
}

/* ──────────────────────────────────────────────────────
   ROUNDTABLE HOLD — wake-up sequence
   Triggers once when the section enters the viewport.
   Snaps section into view and locks page scroll so it
   stays fixed until the choice dialog is dismissed.
   Plays BGM → sigh → my_oh_my in sequence.
────────────────────────────────────────────────────── */

class RoundtableHold {
  constructor(audio) {
    this.section = document.getElementById("roundtable");
    this.audio = audio;
    this.awoken = false;
  }

  _playAudio() {
    this.audio.startBgm("audio/music/1-08 Roundtable Hold.mp3", 0.4);
    this.audio.playSfxSimultaneous(
      ["audio/sfx/walking.wav", "audio/sfx/Roundtable sfx.wav"],
      0.7,
    );
    setTimeout(() => {
      this.audio.playSfxSequence([
        "audio/dialogue/sigh.wav",
        "audio/dialogue/my oh my.wav",
      ]);
    }, 800);
  }

  tryAwaken(scrollY, vh) {
    if (this.awoken) return;
    const rect = this.section.getBoundingClientRect();
    if (rect.top < vh * 0.6) {
      this.awoken = true;
      this.section.classList.add("rt-awake");

      // Snap flush to viewport top, then lock page scroll until choice is made.
      this.section.scrollIntoView({ behavior: "smooth", block: "start" });
      setTimeout(() => {
        document.body.style.overflow = "hidden";
      }, 600);

      // Defer audio until the browser audio context is unlocked by a user gesture.
      // onUnlock fires immediately if already unlocked, otherwise queues the call.
      this.audio.onUnlock(() => this._playAudio());
    }
  }
}

/* ──────────────────────────────────────────────────────
   MAIN APP ORCHESTRATOR
────────────────────────────────────────────────────── */

class EldenRingApp {
  constructor() {
    this.audio = new AudioController();
    this.sidenav = new SideNav();
    this.roundtable = new RoundtableHold(this.audio);
    this.choice = new ChoiceOverlay(this.audio);
    this.erdtree = new ErdtreeHScroll(this.audio);

    this.fadeEls = Array.from(document.querySelectorAll(".fade-in"));
    this.volumeNotice = document.querySelector(".volume-notice");
    this.scrollCta = document.querySelector(".scroll-cta");
    this._heroEl = document.getElementById("hero");

    this._ticking = false;
    window.addEventListener("scroll", () => this._scheduleUpdate(), {
      passive: true,
    });
    window.addEventListener("resize", () => this._update(), { passive: true });
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
    const vh = window.innerHeight;

    // Fade out hero prompts once the user has scrolled past the hero section
    const heroFadeThreshold = this._heroEl.offsetHeight * 0.5;
    const heroDone = scrollY > heroFadeThreshold;
    this.volumeNotice.classList.toggle("hero-prompt--hidden", heroDone);
    this.scrollCta.classList.toggle("hero-prompt--hidden", heroDone);

    this.sidenav.update(scrollY, vh);
    this.roundtable.tryAwaken(scrollY, vh);
    this._updateFadeIns(vh);
  }

  _updateFadeIns(vh) {
    for (const el of this.fadeEls) {
      if (!el.classList.contains("visible")) {
        const rect = el.getBoundingClientRect();
        if (rect.top < vh * 0.88) el.classList.add("visible");
      }
    }
  }
}

/* ── Boot ──────────────────────────────────────────── */

window.app = new EldenRingApp();
