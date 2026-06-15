/* ======================================================
   ELDEN RING — narrative experience controller
   ====================================================== */

"use strict";

/* ── Shared constants ──────────────────────────────── */

/** @type {readonly string[]} */
const UNLOCK_EVENTS = Object.freeze([
  "click", "touchstart", "keydown", "wheel", "pointerdown",
]);

const FADE_STEP_MS = 50;

/** Timing constants for the NPC dialogue flow (ms). */
const DIALOGUE_TIMING = Object.freeze({
  /** Wait for dialog opacity transition before showing subtitle. */
  DIALOG_FADE:      300,
  /** Delay before fading dialog back in after audio ends or is skipped. */
  SUBTITLE_RESTORE: 100,
  /** Delay before arming the skip-click listener (avoids catching the triggering click). */
  SKIP_ARM:         200,
});

/** Timing constants for the Erdtree scene transition animation (ms). */
const TRANSITION_TIMING = Object.freeze({
  /** Scroll-momentum lock for overlay scenes. */
  OVERLAY_SLIDE_LOCK: 600,
  /** Canvas slide-out duration before seeking to new scene. */
  CANVAS_SLIDE_OUT:   300,
  /** Canvas slide-in duration after seeking to new scene. */
  CANVAS_SLIDE_IN:    350,
  /** Scene-video crossfade duration — matches `.scene-video` opacity transition (0.55s). */
  SCENE_VIDEO_FADE:   550,
});

/** Auto-advance pacing for the narration (ms).
   Pacing is time-based so a scene can never flash past when its dialogue audio
   fails to play — it advances on the dialogue's `ended`, but never sooner than
   MIN_SCENE and never later than FALLBACK. */
const NARRATION_TIMING = Object.freeze({
  /** Floor — never advance before this, so subtitles stay readable. */
  MIN_SCENE:      3800,
  /** Ceiling — advance even if dialogue audio never plays or never ends. */
  FALLBACK:       9000,
  /** Pause after dialogue audio ends before advancing. */
  AUDIO_END_HOLD:  800,
  /** Dramatic beat after the final line ends before scrolling to the next section. */
  END_HOLD:       2200,
});

/* ──────────────────────────────────────────────────────
   AUDIO CONTROLLER
   Handles BGM, sequential SFX, and non-overlapping
   dialogue tracks. Respects browser autoplay policy by
   waiting for the first user gesture before playing.
────────────────────────────────────────────────────── */

class AudioController {
  /** @type {HTMLAudioElement | null} */ #bgm = null;
  /** @type {HTMLAudioElement | null} */ #dialogue = null;
  /** @type {HTMLAudioElement[]} */      #sfxList = [];
  /** @type {HTMLAudioElement[]} */      #ambientList = [];  // looping ambient SFX
  /** @type {{ srcs: string[], volume: number } | null} */ #ambientSpec = null;
  #unlocked    = false;
  #pendingBgm  = false;
  #dialogueGen = 0;
  /** @type {Array<() => void>} */       #unlockCallbacks = [];

  // Per-category enable flags — toggled by SoundControl.
  #bgmEnabled      = true;
  #dialogueEnabled = true;
  #sfxEnabled      = true;

  constructor() {
    const unlock = () => {
      if (this.#unlocked) return;
      this.#unlocked = true;
      if (this.#pendingBgm && this.#bgm) this.#tryPlay(this.#bgm);
      for (const cb of this.#unlockCallbacks) cb();
      this.#unlockCallbacks = [];
      for (const evt of UNLOCK_EVENTS) document.removeEventListener(evt, unlock);
    };
    for (const evt of UNLOCK_EVENTS) {
      document.addEventListener(evt, unlock, { passive: true });
    }
  }

  /** @param {HTMLAudioElement} audio */
  #tryPlay(audio) {
    audio.play().catch(err => {
      console.warn("Audio play failed:", err);
      audio.addEventListener(
        "canplay",
        () => audio.play().catch(e => console.warn("Audio retry failed:", e)),
        { once: true },
      );
    });
  }

  /**
   * Starts background music, stopping any currently playing BGM first.
   * @param {string} src
   * @param {number} [volume=0.4]
   */
  startBgm(src, volume = 0.4) {
    this.#bgm?.pause();
    this.#bgm = new Audio(src);
    this.#bgm.loop = true;
    this.#bgm.volume = volume;
    this.#bgm.preload = "auto";
    this.#bgm.load();
    if (!this.#bgmEnabled) return;
    if (this.#unlocked) {
      this.#tryPlay(this.#bgm);
    } else {
      this.#pendingBgm = true; // will play on first user gesture via unlock handler
    }
  }

  /**
   * Fades out and stops the current BGM.
   * @param {number} [fadeDuration=2500]
   */
  stopBgm(fadeDuration = 2500) {
    if (!this.#bgm || this.#bgm.paused) return;
    const bgm = this.#bgm;
    const initial = bgm.volume;
    const step = initial / (fadeDuration / FADE_STEP_MS);
    const id = setInterval(() => {
      if (bgm.volume > step) {
        bgm.volume -= step;
      } else {
        bgm.pause();
        bgm.volume = initial;
        clearInterval(id);
      }
    }, FADE_STEP_MS);
  }

  /** Stops the current BGM immediately with no fade. */
  stopBgmNow() {
    this.#bgm?.pause();
    this.#bgm = null;
  }

  /**
   * Plays multiple SFX tracks concurrently.
   * @param {string[]} srcs
   * @param {number} [volume=1]
   */
  playSfxSimultaneous(srcs, volume = 1) {
    if (!this.#sfxEnabled || !this.#unlocked || !srcs.length) return;
    for (const src of srcs) {
      const sfx = new Audio(src);
      sfx.volume = volume;
      sfx.play().catch(() => {});
      this.#sfxList.push(sfx);
      sfx.addEventListener("ended", () => {
        this.#sfxList = this.#sfxList.filter(s => s !== sfx);
      }, { once: true });
    }
  }

  /** Stops all active SFX immediately. */
  stopSfx() {
    for (const sfx of this.#sfxList) sfx.pause();
    this.#sfxList = [];
  }

  /**
   * Plays dialogue tracks sequentially, optionally looping the full sequence.
   * Uses the generation counter so stopDialogue() cancels pending callbacks.
   * @param {string[]}        srcs
   * @param {boolean}         [loop=false]
   * @param {string[]}        [rootSrcs=srcs]  Full sequence for loop restart
   * @param {(() => void) | null} [onEnd]   Called once after the last track ends (non-loop only)
   */
  playDialogueSequence(srcs, loop = false, rootSrcs = srcs, onEnd = null) {
    this.#dialogue?.pause();
    this.#dialogue = null;
    // When dialogue can't play (disabled / not yet unlocked / empty) we do NOT
    // fire onEnd synchronously — that used to cascade the scene auto-advance and
    // flash the whole narration past. The caller's time-based fallback advances.
    if (!this.#dialogueEnabled || !this.#unlocked || !srcs.length) {
      return;
    }

    const gen = ++this.#dialogueGen;
    const [first, ...rest] = srcs;
    const el = new Audio(first);
    this.#dialogue = el;
    el.volume = 1;
    el.play().catch(() => {});

    const isLast    = rest.length === 0;
    const nextSrcs  = isLast ? (loop ? rootSrcs : null) : rest;
    if (nextSrcs) {
      el.addEventListener("ended", () => {
        if (this.#dialogueGen === gen) this.playDialogueSequence(nextSrcs, loop, rootSrcs, onEnd);
      }, { once: true });
    } else if (isLast && !loop && onEnd) {
      // Last track of a non-looping sequence — fire onEnd when it finishes
      el.addEventListener("ended", () => {
        if (this.#dialogueGen === gen) onEnd();
      }, { once: true });
    }
  }

  /**
   * Plays one or more dialogue files in sequence, calling onEnd after the last.
   * Uses a generation counter so stopDialogue() cancels any pending onEnd.
   * @param {string[]}   srcs
   * @param {() => void} [onEnd]
   */
  playDialogueLine(srcs, onEnd) {
    this.#dialogue?.pause();
    this.#dialogue = null;
    if (!this.#dialogueEnabled || !this.#unlocked || !srcs.length) { onEnd?.(); return; }

    // Capture current generation; stopDialogue increments it, invalidating callbacks.
    const gen = ++this.#dialogueGen;
    const guardedEnd = onEnd ? () => { if (this.#dialogueGen === gen) onEnd(); } : undefined;

    const playFrom = (/** @type {string[]} */ remaining) => {
      if (this.#dialogueGen !== gen || !remaining.length) return;
      const [first, ...rest] = remaining;
      const el = new Audio(first);
      this.#dialogue = el;
      el.volume = 1;
      el.play().catch(() => {});
      const next = rest.length ? () => { if (this.#dialogueGen === gen) playFrom(rest); } : guardedEnd;
      if (next) {
        el.addEventListener("ended", next, { once: true });
        el.addEventListener("error",  next, { once: true });
      }
    };

    playFrom(srcs);
  }

  /** Stops the current dialogue track and cancels any pending end callbacks. */
  stopDialogue() {
    this.#dialogue?.pause();
    this.#dialogue = null;
    ++this.#dialogueGen;
  }

  /**
   * Calls cb immediately if audio is already unlocked, otherwise queues it.
   * @param {() => void} cb
   */
  onUnlock(cb) {
    if (this.#unlocked) cb();
    else this.#unlockCallbacks.push(cb);
  }

  /** True when a BGM track is loaded (playing or paused). */
  get hasBgm() { return this.#bgm !== null; }

  /**
   * Enable or disable background music.
   * Disabling pauses the current track; enabling resumes it if one is loaded.
   * @param {boolean} on
   */
  setBgmEnabled(on) {
    this.#bgmEnabled = on;
    if (!on) {
      this.#bgm?.pause();
    } else if (this.#bgm) {
      if (this.#unlocked) this.#tryPlay(this.#bgm);
      else this.#pendingBgm = true;
    }
  }

  /**
   * Enable or disable dialogue audio. Disabling stops any current line.
   * @param {boolean} on
   */
  setDialogueEnabled(on) {
    this.#dialogueEnabled = on;
    if (!on) this.stopDialogue();
  }

  /**
   * Plays looping ambient SFX (e.g. roundtable ambience).
   * Stores the spec so it can be restarted when SFX is re-enabled.
   * @param {string[]} srcs
   * @param {number} [volume=0.7]
   */
  playAmbientSfx(srcs, volume = 0.7) {
    this.#ambientSpec = { srcs, volume };
    this.#stopAmbient();
    if (!this.#sfxEnabled || !this.#unlocked || !srcs.length) return;
    for (const src of srcs) {
      const el = new Audio(src);
      el.loop   = true;
      el.volume = volume;
      el.play().catch(() => {});
      this.#ambientList.push(el);
    }
  }

  #stopAmbient() {
    for (const el of this.#ambientList) { el.pause(); el.src = ""; }
    this.#ambientList = [];
  }

  /**
   * Enable or disable SFX. Disabling stops all active SFX immediately.
   * Re-enabling restarts any ambient SFX that was playing.
   * @param {boolean} on
   */
  setSfxEnabled(on) {
    this.#sfxEnabled = on;
    if (!on) {
      this.stopSfx();
      this.#stopAmbient();
    } else if (this.#ambientSpec) {
      this.playAmbientSfx(this.#ambientSpec.srcs, this.#ambientSpec.volume);
    }
  }
}

/* ──────────────────────────────────────────────────────
   SCENE DATA
   12 PNG sequences, one per narration line.
   Boss scenes (Godrick, Malenia, Radahn, Rykard) show a
   static layered image instead of the frame animation —
   indicated by the optional `bossId` field.
────────────────────────────────────────────────────── */

/**
 * @typedef {{ dir: string, prefix: string, count: number, audio: string[], text: string, loop?: boolean, bossId?: string, videoId?: string }} SceneData
 */

/** @type {readonly SceneData[]} */
const SCENES = Object.freeze([
  {
    dir: "Scenes/01_Elden_Ring",
    prefix: "Elden_ring",
    count: 55,
    // "giving life" line plays sequentially after "O Elden Ring" — it was
    // originally a mid-scene cue at frame 40, but that path is dead now that
    // scene 1 is a video overlay (no frame ticking).
    audio: [
      "audio/dialogue/Elden Ring.mp3",
      "audio/dialogue/O Elden Ring.mp3",
      "audio/dialogue/giving life its fullest brilliance.mp3",
    ],
    text: "Elden Ring. O, Elden Ring.",
    videoId: "elden-ring",
  },
  {
    dir: "Scenes/02_Its_Gold",
    prefix: "its_Gold_commanded",
    count: 59,
    audio: ["audio/dialogue/its gold commanded the very stars.mp3"],
    text: "Its gold commanded<br>the very stars,",
    videoId: "radagon",
  },
  {
    dir: "Scenes/03_Shattered",
    prefix: "shattered",
    count: 63,
    audio: ["audio/dialogue/Shattered, by someone, or something.mp3"],
    text: "Shattered, by someone,<br>or something.",
    videoId: "hammer",
  },
  {
    dir: "Scenes/04_Godrick",
    prefix: "godrick",
    count: 58,
    audio: ["audio/dialogue/Godrick, the feeble.mp3"],
    text: "Godrick, the feeble.",
    bossId: "godrick",
  },
  {
    dir: "Scenes/05_Malenia",
    prefix: "malenia",
    count: 60,
    audio: ["audio/dialogue/Malenia, decayed from birth.mp3"],
    text: "Malenia, decayed from birth.",
    bossId: "malenia",
  },
  {
    dir: "Scenes/06_General_Radahn",
    prefix: "general_radahn",
    count: 47,
    audio: ["audio/dialogue/General Radahn, slayer of giants.mp3"],
    text: "General Radahn,<br>slayer of giants.",
    bossId: "radahn",
  },
  {
    dir: "Scenes/07_Rykard",
    prefix: "rykard",
    count: 61,
    audio: ["audio/dialogue/Rykard, the tyrannical serpent.mp3"],
    text: "Rykard,<br>the tyrannical serpent.",
    bossId: "rykard",
  },
  {
    dir: "Scenes/08_Morgott",
    prefix: "morgott",
    count: 64,
    audio: ["audio/dialogue/And Morgott, Prince of the Omen.mp3"],
    text: "And Morgott,<br>Prince of the Omen.",
    bossId: "margit",
  },
  {
    dir: "Scenes/09_Each_Inheriting",
    prefix: "each_inheriting",
    count: 47,
    audio: ["audio/dialogue/Each, inheriting their own shard, played a part in the Shattering.mp3"],
    text: "Each, inheriting their own shard,<br>played a part in the Shattering,",
    videoId: "vyke",
  },
  {
    dir: "Scenes/10_A_War",
    prefix: "a_war",
    count: 43,
    audio: ["audio/dialogue/a war with no end, and no victor.mp3"],
    text: "a war with no end,<br>and no victor.",
    videoId: "malenia-radahn",
  },
  {
    dir: "Scenes/11_and_so_the_two_Fingers",
    prefix: "and_so_the_two_fingers",
    count: 45,
    audio: ["audio/dialogue/And so the Two Fingers call upon ye, the Tarnished.mp3"],
    text: "And so the Two Fingers<br>call upon ye, the Tarnished.",
    videoId: "tarnished",
  },
  {
    dir: "Scenes/12_To_cross_the_fog",
    prefix: "to_cross_the_fog",
    count: 92,
    audio: ["audio/dialogue/To cross the Sea of Fog, to the Lands Between To seek the Elden Ring. Seek the Elden Ring.mp3"],
    text: "To cross the Sea of Fog,<br>to the Lands Between.<br><br>To seek the Elden Ring.<br>Seek the Elden Ring.",
    loop: true,
    videoId: "erdtree",
  },
]);

const TOTAL_FRAMES = SCENES.reduce((sum, s) => sum + s.count, 0);

/* ──────────────────────────────────────────────────────
   NARRATION CANVAS PLAYER
   Windowed frame cache — keeps ±25 frames in memory,
   evicting the rest. Preloads ahead on each seek.
────────────────────────────────────────────────────── */

class ErdtreePlayer {
  static #AHEAD  = 22;
  static #BEHIND = 6;

  /** @type {HTMLCanvasElement} */          #canvas;
  /** @type {CanvasRenderingContext2D} */   #ctx;
  /** @type {Map<number, HTMLImageElement>} */ #cache   = new Map();
  /** @type {Set<number>} */                #loading = new Set();
  #currentFrame = -1;

  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.#canvas = canvas;
    this.#ctx    = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
    this.#resize();
    window.addEventListener("resize", () => this.#resize(), { passive: true });
  }

  #resize() {
    const p = this.#canvas.parentElement;
    this.#canvas.width  = p?.clientWidth  ?? window.innerWidth;
    this.#canvas.height = p?.clientHeight ?? window.innerHeight;
    if (this.#currentFrame >= 0) {
      const img = this.#cache.get(this.#currentFrame);
      if (img) this.#draw(img);
    }
  }

  /** @param {number} i - global frame index */
  #src(i) {
    let g = i;
    for (const scene of SCENES) {
      if (g < scene.count) {
        return `${scene.dir}/${scene.prefix}${String(g).padStart(2, "0")}.png`;
      }
      g -= scene.count;
    }
    const last = SCENES.at(-1);
    return `${last.dir}/${last.prefix}${String(last.count - 1).padStart(2, "0")}.png`;
  }

  /** @param {number} i */
  #load(i) {
    if (i < 0 || i >= TOTAL_FRAMES) return;
    if (this.#cache.has(i) || this.#loading.has(i)) return;
    this.#loading.add(i);
    const img = new Image();
    img.onload  = () => {
      this.#loading.delete(i);
      this.#cache.set(i, img);
      if (i === this.#currentFrame) this.#draw(img);
    };
    img.onerror = () => this.#loading.delete(i);
    img.src = this.#src(i);
  }

  /** @param {number} center */
  #evict(center) {
    for (const k of this.#cache.keys()) {
      if (k < center - ErdtreePlayer.#BEHIND || k > center + ErdtreePlayer.#AHEAD) {
        this.#cache.delete(k);
      }
    }
  }

  /** @param {HTMLImageElement} img */
  #draw(img) {
    const { width: cw, height: ch } = this.#canvas;
    const scale = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
    const w = img.naturalWidth  * scale;
    const h = img.naturalHeight * scale;
    this.#ctx.clearRect(0, 0, cw, ch);
    this.#ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
  }

  /** @param {number} frameIdx */
  seek(frameIdx) {
    frameIdx = Math.max(0, Math.min(TOTAL_FRAMES - 1, frameIdx));
    this.#evict(frameIdx);
    const end = Math.min(frameIdx + ErdtreePlayer.#AHEAD, TOTAL_FRAMES - 1);
    for (let i = frameIdx; i <= end; i++) this.#load(i);
    if (frameIdx !== this.#currentFrame) {
      this.#currentFrame = frameIdx;
      const img = this.#cache.get(frameIdx);
      if (img) this.#draw(img);
    }
  }

  init() {
    for (let i = 0; i < Math.min(30, TOTAL_FRAMES); i++) this.#load(i);
  }
}

/* ──────────────────────────────────────────────────────
   CHAPTER CUES
   One cue fires at the first frame of each scene.
   "Giving life" has no dedicated scene folder so it is
   inserted as a mid-scene-01 cue.
────────────────────────────────────────────────────── */

/**
 * @typedef {{ frame: number, audio: string[], text: string, loop: boolean }} ChapterCue
 * @type {readonly ChapterCue[]}
 */
const CHAPTER_CUES = (() => {
  let frame = 0;
  const cues = SCENES.map(s => {
    const cue = { frame, audio: s.audio, text: s.text, loop: s.loop ?? false };
    frame += s.count;
    return cue;
  });
  // NOTE: the original "giving life its fullest brilliance" splice at frame 40
  // was removed — all scenes are now video/boss overlays and the frame counter
  // never ticks, so frame-based mid-scene cues can never fire.
  // The audio is now chained onto scene 1's audio array instead.
  return Object.freeze(cues);
})();

/**
 * Returns the dominant-axis wheel delta (X or Y, whichever is larger).
 * Returns 0 if the movement is too small to be intentional.
 * @param {WheelEvent} e
 * @returns {number}
 */
function getDominantScrollDelta(e) {
  const absX  = Math.abs(e.deltaX);
  const absY  = Math.abs(e.deltaY);
  const delta = absX > absY ? e.deltaX : e.deltaY;
  return Math.abs(delta) < 5 ? 0 : delta;
}

/* ──────────────────────────────────────────────────────
   NARRATION SCENE PLAYER
   Drives the multi-scene PNG animation.
   For boss scenes (bossId set) the canvas is hidden and
   a layered image overlay is shown instead.
   Converts vertical wheel → scene advance / rewind.
────────────────────────────────────────────────────── */

class ErdtreeScenePlayer {
  /** Animation frame rate for PNG sequences. */
  static #FPS = 18;

  /** @type {HTMLElement} */       #section;
  /** @type {HTMLElement} */       #stage;
  /** @type {HTMLElement} */       #subtitle;
  /** @type {HTMLElement} */       #canvasEl;
  /** @type {ErdtreePlayer} */     #player;
  /** @type {AudioController} */   #audio;
  /** @type {number[]} */          #sceneStart = [];
  /** Cached static node lists — never change after page load. */
  /** @type {HTMLElement[]} */     #bossSlides  = [];
  /** @type {HTMLElement[]} */     #sceneVideos = [];

  #chapter     = -1;
  #rafId       = null;
  #lastTs      = null;
  #frame       = 0;
  #targetFrame = -1;
  #sceneIdx    = -1;
  #active      = false;
  #done        = false;
  #sliding     = false;
  #slideTimer  = null;
  /** Timer handle for automatic scene advance (passive-viewer mode). */
  #autoTimer   = null;
  /** Timestamp (performance.now) the current chapter became active. */
  #sceneEnteredAt = 0;
  /** True once the final scene has ended and the end-scroll has been armed. */
  #finished    = false;

  // Boss parallax / float state
  /** Raw mouse offset from stage centre (px). */
  #mouseX = 0;
  #mouseY = 0;
  /** Smoothed (lerped) mouse values. */
  #lerpX  = 0;
  #lerpY  = 0;
  /** RAF handle for the boss animation loop. */
  #bossRaf = null;

  /** @param {AudioController} audio */
  constructor(audio) {
    this.#section  = /** @type {HTMLElement} */ (document.getElementById("erdtree-scroll"));
    this.#stage    = /** @type {HTMLElement} */ (document.getElementById("erdtree-stage"));
    this.#subtitle = /** @type {HTMLElement} */ (document.getElementById("erdtree-subtitle"));
    this.#canvasEl = /** @type {HTMLElement} */ (document.getElementById("erdtree-canvas"));
    this.#player   = new ErdtreePlayer(/** @type {HTMLCanvasElement} */ (this.#canvasEl));
    this.#audio    = audio;

    let f = 0;
    for (const scene of SCENES) { this.#sceneStart.push(f); f += scene.count; }

    // Cache static overlay node lists — elements never added/removed after load.
    this.#bossSlides  = Array.from(this.#stage.querySelectorAll(".boss-slide"));
    this.#sceneVideos = Array.from(this.#stage.querySelectorAll(".scene-video"));

    this.#initVisibilityObserver();
    this.#initWheelHandler();
    this.#initMouseTracking();
  }

  /** Track mouse position relative to stage centre for parallax. */
  #initMouseTracking() {
    this.#stage.addEventListener("mousemove", e => {
      const r = this.#stage.getBoundingClientRect();
      this.#mouseX = e.clientX - r.left  - r.width  / 2;
      this.#mouseY = e.clientY - r.top   - r.height / 2;
    }, { passive: true });
    this.#stage.addEventListener("mouseleave", () => {
      this.#mouseX = 0;
      this.#mouseY = 0;
    }, { passive: true });
  }

  /**
   * Start the boss parallax + float animation loop.
   * Runs only while a boss scene is active.
   */
  #startBossAnimation() {
    if (this.#bossRaf) return;
    const tick = (/** @type {number} */ ts) => {
      // Smooth the mouse position (6% lerp per frame ≈ ~90 ms settle at 60fps)
      this.#lerpX += (this.#mouseX - this.#lerpX) * 0.06;
      this.#lerpY += (this.#mouseY - this.#lerpY) * 0.06;

      // Sine-based float / drift (independent of mouse)
      const charFloat = Math.sin(ts / 1900) * 7;        // vertical bob ±7 px
      const bgDrift   = Math.sin(ts / 2800) * 4;        // slow horizontal drift ±4 px

      const slide = /** @type {HTMLElement | null} */ (
        this.#stage.querySelector(".boss-slide--active")
      );
      if (slide) {
        const bg   = /** @type {HTMLElement | null} */ (slide.querySelector(".boss-slide__bg"));
        const char = /** @type {HTMLElement | null} */ (slide.querySelector(".boss-slide__char"));
        const mx = this.#lerpX, my = this.#lerpY;

        // Background moves opposite and slower than the cursor (parallax depth)
        if (bg)   bg.style.transform   = `scale(1.07) translate(${-mx * 0.012 + bgDrift}px, ${-my * 0.009}px)`;
        // Character follows cursor slightly and floats
        if (char) char.style.transform = `translate(${mx * 0.018}px, ${my * 0.013 + charFloat}px)`;
      }

      this.#bossRaf = requestAnimationFrame(tick);
    };
    this.#bossRaf = requestAnimationFrame(tick);
  }

  /** Stop the boss animation loop and reset transforms. */
  #stopBossAnimation() {
    if (this.#bossRaf) { cancelAnimationFrame(this.#bossRaf); this.#bossRaf = null; }
    this.#stage.querySelectorAll(".boss-slide__bg, .boss-slide__char").forEach(el => {
      /** @type {HTMLElement} */ (el).style.transform = "";
    });
    this.#lerpX = 0;
    this.#lerpY = 0;
  }

  #initVisibilityObserver() {
    const io = new IntersectionObserver(([entry]) => {
      const ratio = entry.intersectionRatio;
      this.#stage.classList.toggle("active", ratio > 0.6);

      if (ratio > 0.5) {
        this.#active = true;
        if (this.#sceneIdx < 0) {
          document.body.style.overflow = "hidden";
          this.#goToScene(0);
        } else if (!this.#done) {
          document.body.style.overflow = "hidden";
        }
      } else if (ratio < 0.1) {
        this.#active = false;
        this.#cancelAutoAdvance();
        this.#subtitle.classList.remove("visible");
        this.#chapter = -1;
        this.#stopPlay();
        this.#audio.stopDialogue();
      }
    }, { threshold: [0, 0.1, 0.5, 0.6, 1.0] });
    io.observe(this.#section);
  }

  #initWheelHandler() {
    window.addEventListener("wheel", e => {
      if (!this.#active) return;

      // Accept whichever axis is dominant.
      // deltaX lets trackpad left/right swipe work; deltaY is the reliable fallback
      // (Safari intercepts horizontal swipes for history before they reach wheel).
      const delta = getDominantScrollDelta(e);
      if (delta === 0) return;

      const goingForward = delta > 0;

      // Any intentional scroll cancels the auto-advance timer.
      this.#cancelAutoAdvance();

      if (this.#rafId || this.#sliding) { e.preventDefault(); return; }
      if (goingForward && this.#done) return;
      if (!goingForward && this.#sceneIdx <= 0) {
        document.body.style.overflow = "";
        return;
      }

      e.preventDefault();
      this.#goToScene(this.#sceneIdx + (goingForward ? 1 : -1));
    }, { passive: false });
  }

  /**
   * Show the correct overlay (boss image or video) for the given scene index,
   * or restore the canvas for pure PNG-sequence scenes.
   * Pauses any outgoing video and plays the incoming one.
   * @param {number} idx
   */
  #syncOverlay(idx) {
    const scene   = SCENES[idx] ?? {};
    const bossId  = scene.bossId  ?? null;
    const videoId = scene.videoId ?? null;
    const isOverlay = bossId !== null || videoId !== null;

    // Deactivate all boss overlays.
    this.#bossSlides.forEach(el => el.classList.remove("boss-slide--active"));

    const incomingVideo = videoId ? document.getElementById(`scene-${videoId}`) : null;

    // Fade out every video that isn't the incoming one. Keep it playing through
    // the crossfade — snapping it back to frame 0 mid-fade caused a visible jump
    // ("split"). Pause + rewind only after the opacity fade has finished.
    this.#sceneVideos.forEach(el => {
      if (el === incomingVideo || !el.classList.contains("scene-video--active")) return;
      el.classList.remove("scene-video--active");
      const v = /** @type {HTMLVideoElement|null} */ (el.querySelector("video"));
      if (v) {
        setTimeout(() => {
          // Skip if this scene was re-activated in the meantime.
          if (!el.classList.contains("scene-video--active")) { v.pause(); v.currentTime = 0; }
        }, TRANSITION_TIMING.SCENE_VIDEO_FADE);
      }
    });

    // Canvas: visible only for pure PNG scenes.
    this.#canvasEl.classList.toggle("erdtree-canvas--hidden", isOverlay);

    if (bossId) {
      document.getElementById(`boss-${bossId}`)?.classList.add("boss-slide--active");
      this.#startBossAnimation();
    } else {
      this.#stopBossAnimation();
    }

    if (incomingVideo) {
      incomingVideo.classList.add("scene-video--active");
      const v = /** @type {HTMLVideoElement|null} */ (incomingVideo.querySelector("video"));
      // preload="none" means the bytes aren't fetched until we play — so only
      // scenes that are actually shown download.
      if (v) { v.currentTime = 0; v.play().catch(() => {}); }
    }

    // Prefetch the next scene's video so it's ready when we advance — bumping
    // preload triggers the download ahead of time (current + next only).
    const nextVideoId = SCENES[idx + 1]?.videoId;
    if (nextVideoId) {
      const nextV = /** @type {HTMLVideoElement|null} */ (
        document.querySelector(`#scene-${nextVideoId} video`)
      );
      if (nextV && nextV.preload !== "auto") { nextV.preload = "auto"; nextV.load(); }
    }
  }

  /** @param {number} idx */
  #goToScene(idx) {
    idx = Math.max(0, Math.min(SCENES.length - 1, idx));

    const isFirst   = this.#sceneIdx < 0;
    const direction = idx >= this.#sceneIdx ? 1 : -1;

    this.#done        = false;
    this.#finished    = false;
    this.#sceneIdx    = idx;
    this.#frame       = this.#sceneStart[idx];
    this.#targetFrame = idx < SCENES.length - 1
      ? this.#sceneStart[idx + 1] - 1
      : TOTAL_FRAMES - 1;

    this.#stopPlay();

    /** Whether the scene uses a video/boss overlay instead of canvas frames. */
    const isOverlay = !!(SCENES[idx].videoId || SCENES[idx].bossId);

    if (isFirst) {
      this.#syncOverlay(idx);
      this.#updateChapterFromFrame();

      if (!isOverlay) {
        // Pure PNG-sequence: run the frame animation; #rafId blocks wheel handler.
        this.#lastTs = null;
        this.#rafId  = requestAnimationFrame(ts => this.#tick(ts));
      } else {
        // Video / boss overlay: no RAF, but hold a brief slide-lock so scroll
        // momentum can't immediately skip to the next scene.
        this.#sliding = true;
        this.#slideTimer = setTimeout(() => {
          this.#sliding = false;
          if (idx >= SCENES.length - 1) {
            this.#done = true;
            document.body.style.overflow = "";
          }
        }, TRANSITION_TIMING.OVERLAY_SLIDE_LOCK);
      }
      return;
    }

    this.#sliding = true;
    clearTimeout(this.#slideTimer);

    if (isOverlay) {
      // Overlay scene (video or boss image): switch immediately so there is
      // no blank gap. CSS opacity transition handles the crossfade visually.
      this.#syncOverlay(idx);
      this.#updateChapterFromFrame();
      if (idx >= SCENES.length - 1) {
        this.#done = true;
        document.body.style.overflow = "";
      }
      // Hold the slide-lock long enough for the CSS fade to settle.
      this.#slideTimer = setTimeout(() => {
        this.#sliding = false;
      }, TRANSITION_TIMING.OVERLAY_SLIDE_LOCK);
    } else {
      // Pure PNG-sequence scene: slide the canvas out, seek, slide back in.
      const el   = this.#canvasEl;
      const outX = direction === 1 ? "-100%" : "100%";
      const inX  = direction === 1 ?  "100%" : "-100%";

      el.style.transition = `transform ${TRANSITION_TIMING.CANVAS_SLIDE_OUT / 1000}s ease-in`;
      el.style.transform  = `translateX(${outX})`;

      this.#slideTimer = setTimeout(() => {
        this.#syncOverlay(idx);
        this.#player.seek(this.#frame);
        this.#updateChapterFromFrame();

        el.style.transition = "none";
        el.style.transform  = `translateX(${inX})`;
        void el.offsetWidth;
        el.style.transition = `transform ${TRANSITION_TIMING.CANVAS_SLIDE_IN / 1000}s ease-out`;
        el.style.transform  = "translateX(0)";
        this.#lastTs = null;
        this.#rafId  = requestAnimationFrame(ts => this.#tick(ts));

        this.#slideTimer = setTimeout(() => {
          el.style.transition = "";
          this.#sliding = false;
        }, TRANSITION_TIMING.CANVAS_SLIDE_IN);
      }, TRANSITION_TIMING.CANVAS_SLIDE_OUT);
    }
  }

  #stopPlay() {
    if (this.#rafId) cancelAnimationFrame(this.#rafId);
    this.#rafId = null;
  }

  /**
   * Schedule an automatic advance to the next scene after audio finishes.
   * Ignored on the final scene (it loops).
   * @param {number} [holdMs=800] — extra pause after audio ends before advancing
   */
  #scheduleAutoAdvance(holdMs = 800) {
    this.#cancelAutoAdvance();
    const nextIdx = this.#sceneIdx + 1;
    if (nextIdx >= SCENES.length) return; // last scene — stay forever
    this.#autoTimer = setTimeout(() => {
      this.#autoTimer = null;
      if (!this.#active || this.#done) return;
      this.#goToScene(nextIdx);
    }, holdMs);
  }

  #cancelAutoAdvance() {
    if (this.#autoTimer !== null) { clearTimeout(this.#autoTimer); this.#autoTimer = null; }
  }

  /** @param {DOMHighResTimeStamp} ts */
  #tick(ts) {
    if (!this.#lastTs) this.#lastTs = ts;
    const elapsed       = ts - this.#lastTs;
    const frameDuration = 1000 / ErdtreeScenePlayer.#FPS;

    if (elapsed >= frameDuration) {
      const frames  = Math.floor(elapsed / frameDuration);
      this.#lastTs  = ts - (elapsed % frameDuration);
      this.#frame   = Math.min(this.#frame + frames, this.#targetFrame);
      this.#player.seek(this.#frame);
      this.#updateChapterFromFrame();

      if (this.#frame >= this.#targetFrame) {
        if (this.#sceneIdx >= SCENES.length - 1) {
          this.#done = true;
          document.body.style.overflow = "";
        }
        this.#rafId = null;
        return;
      }
    }

    this.#rafId = requestAnimationFrame(ts => this.#tick(ts));
  }

  #updateChapterFromFrame() {
    let chapterIdx = -1;
    for (let i = CHAPTER_CUES.length - 1; i >= 0; i--) {
      if (this.#frame >= CHAPTER_CUES[i].frame) { chapterIdx = i; break; }
    }
    if (chapterIdx < 0 || chapterIdx === this.#chapter) return;

    this.#chapter = chapterIdx;
    this.#cancelAutoAdvance();
    this.#sceneEnteredAt = performance.now();

    this.#subtitle.innerHTML = CHAPTER_CUES[chapterIdx].text;
    this.#subtitle.classList.remove("visible");
    requestAnimationFrame(() =>
      requestAnimationFrame(() => this.#subtitle.classList.add("visible")),
    );

    const cue      = CHAPTER_CUES[chapterIdx];
    const isLast   = chapterIdx >= SCENES.length - 1;

    if (isLast) {
      // Final scene: closing line plays ONCE (loop=false so onEnd can fire),
      // then the experience ends and scrolls on to the next section.
      this.#audio.playDialogueSequence(cue.audio, false, cue.audio, () => this.#endNarration());
      // Safety net: end even if dialogue never plays/ends (audio not unlocked, etc.).
      this.#autoTimer = setTimeout(() => this.#endNarration(), NARRATION_TIMING.FALLBACK);
      return;
    }

    // Ceiling: advance even if dialogue audio never plays or never ends, so a
    // silent/blocked scene still progresses instead of stalling or flashing.
    this.#scheduleAutoAdvance(NARRATION_TIMING.FALLBACK);

    // When dialogue audio ends, advance after a short hold — but never sooner
    // than the readable floor, so an instantly-ending track can't flash past.
    const onAudioEnd = () => {
      const elapsed = performance.now() - this.#sceneEnteredAt;
      const wait = Math.max(
        NARRATION_TIMING.AUDIO_END_HOLD,
        NARRATION_TIMING.MIN_SCENE - elapsed,
      );
      this.#scheduleAutoAdvance(wait);
    };
    this.#audio.playDialogueSequence(cue.audio, cue.loop, cue.audio, onAudioEnd);
  }

  /**
   * End of the narration: let the final beat settle, then smooth-scroll to the
   * next page section. Runs exactly once; skipped if the viewer already left.
   */
  #endNarration() {
    if (this.#finished || !this.#active) return;
    this.#finished = true;
    this.#cancelAutoAdvance();
    this.#done = true;
    document.body.style.overflow = "";
    setTimeout(() => {
      document.getElementById("about")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, NARRATION_TIMING.END_HOLD);
  }
}

/* ──────────────────────────────────────────────────────
   SIDE NAV
   Updates active dot based on current scroll position.
   Clicking a dot smooth-scrolls to the target section.
────────────────────────────────────────────────────── */

class SideNav {
  /** @type {HTMLElement} */         #nav;
  /** @type {Element[]} */           #dots;
  /** @type {(Element | null)[]} */  #targets;
  /** @type {HTMLElement} */         #heroEl;

  constructor() {
    this.#nav     = /** @type {HTMLElement} */ (document.getElementById("sidenav"));
    this.#heroEl  = /** @type {HTMLElement} */ (document.getElementById("hero"));
    this.#dots    = Array.from(this.#nav.querySelectorAll(".sidenav__dot"));
    this.#targets = this.#dots.map(d =>
      document.getElementById(/** @type {HTMLElement} */ (d).dataset.target ?? ""),
    );

    this.#dots.forEach((dot, i) => {
      dot.addEventListener("click", () => {
        this.#targets[i]?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  /**
   * @param {number} scrollY
   * @param {number} vh
   */
  update(scrollY, vh) {
    const heroEnd = this.#heroEl.offsetTop + this.#heroEl.offsetHeight;
    this.#nav.classList.toggle("visible", scrollY > heroEnd * 0.6);

    let active = 0;
    for (let i = 0; i < this.#targets.length; i++) {
      const el = this.#targets[i];
      if (el && scrollY >= el.offsetTop - vh * 0.45) active = i;
    }
    this.#dots.forEach((d, i) => d.classList.toggle("active", i === active));
  }
}

/**
 * When true, downward wheel/touch scroll is blocked so the user can't
 * accidentally drift into the Erdtree animation from the roundtable.
 * Released only when the player intentionally clicks "Seek the Elden Ring".
 */
let roundtableScrollLocked = false;

/**
 * Returns true when the roundtable section is the current active viewport section
 * (its top edge is within ±40% of viewport height from the top of the viewport).
 * Used to scope the downward-scroll guard so it doesn't block scroll from
 * biography → roundtable when the user scrolls back down after going up.
 */
function roundtableIsActive() {
  const rect = document.getElementById("roundtable")?.getBoundingClientRect();
  if (!rect) return false;
  // Only consider the roundtable "active" when its top edge is within ±12% of
  // the viewport height from the top — i.e. the user is settled at this section,
  // not still scrolling towards it from biography.
  const threshold = window.innerHeight * 0.12;
  return rect.top > -threshold && rect.top < threshold;
}

// Accumulated upward scroll needed to escape the roundtable lock.
const UPWARD_ESCAPE_THRESHOLD = 400;
let _upwardEscapeDelta = 0;

// Single passive:false listener installed once — cheap when flag is false.
window.addEventListener("wheel", e => {
  if (!roundtableScrollLocked || !roundtableIsActive()) {
    _upwardEscapeDelta = 0;
    return;
  }
  const dy = e.deltaY ?? 0;
  if (dy > 0) {
    // Downward — always block
    e.preventDefault();
    _upwardEscapeDelta = 0;
    return;
  }
  // Upward — accumulate; only release after threshold
  _upwardEscapeDelta += Math.abs(dy);
  if (_upwardEscapeDelta < UPWARD_ESCAPE_THRESHOLD) e.preventDefault();
}, { passive: false });

// Also cover touch-based scroll (mobile / trackpad inertia).
let touchStartY = 0;
window.addEventListener("touchstart", e => { touchStartY = e.touches[0].clientY; }, { passive: true });
window.addEventListener("touchmove", e => {
  if (!roundtableScrollLocked || !roundtableIsActive()) return;
  if (e.touches[0].clientY < touchStartY) e.preventDefault(); // swiping up → scrolling down
}, { passive: false });

/**
 * Tracks which NPCs the player has spoken to at least once.
 * Keys match `data-npc-track` attribute values on initial speak buttons.
 * @type {Set<string>}
 */
const spokenNpcs = new Set();

/** All NPC ids that must be greeted before departing. */
const ALL_NPC_IDS = Object.freeze(["enia", "d", "gideon", "rogier"]);

/** Human-readable names keyed by NPC id. */
const NPC_NAMES = Object.freeze({
  enia:   "Enia, the Finger Reader",
  d:      "D, Hunter of the Dead",
  gideon: "Gideon Ofnir, the All-Knowing",
  rogier: "Sorcerer Rogier",
});

/**
 * Fades an NPC dialog, shows the subtitle, plays the audio, then restores.
 * Shared by ChoiceMap and RoundtableNPC to avoid duplicated logic.
 * @param {{
 *   dialog:      HTMLDialogElement,
 *   audio:       AudioController,
 *   npcName:     string,
 *   srcs:        string[],
 *   subtitleLine: string,
 *   unlockId?:   string | null,
 * }} opts
 */
function playNpcTopic({ dialog, audio, npcName, srcs, subtitleLine, unlockId = null }) {
  dialog.classList.add("npc-dialog--faded");

  let hasRestored = false;
  const restoreDialog = () => {
    if (hasRestored) return;
    hasRestored = true;
    subtitle.hide();
    if (unlockId) unlockId.split(",").forEach(id => document.getElementById(id.trim())?.removeAttribute("hidden"));
    setTimeout(() => dialog.classList.remove("npc-dialog--faded"), DIALOGUE_TIMING.SUBTITLE_RESTORE);
  };
  const skipAndRestore = () => {
    if (hasRestored) return;
    audio.stopDialogue();
    restoreDialog();
  };

  setTimeout(() => {
    subtitle.show(npcName, subtitleLine);
    audio.playDialogueLine(srcs, restoreDialog);
    // Arm skip listener after SKIP_ARM ms to avoid catching the triggering click.
    setTimeout(
      () => document.addEventListener("click", skipAndRestore, { capture: true, once: true }),
      DIALOGUE_TIMING.SKIP_ARM,
    );
  }, DIALOGUE_TIMING.DIALOG_FADE);
}

/**
 * Play idle audio (no subtitle fade-in, no unlock) when reopening an NPC dialog.
 * @param {{ audio: AudioController, npcName: string, srcs: string[] }} opts
 */
function playNpcIdle({ audio, npcName, srcs }) {
  subtitle.show(npcName, "");
  audio.playDialogueLine(srcs, () => subtitle.hide());
}

/* ──────────────────────────────────────────────────────
   CHOICE MAP
   Listens for clicks on Enia's zone in the Roundtable.
   "Seek the Elden Ring" → fade to black → scroll to Erdtree sequence.
   "Leave" → close dialog.
────────────────────────────────────────────────────── */

class ChoiceMap {
  /** @type {HTMLDialogElement} */ #dialog;
  /** @type {HTMLElement} */       #fadeEl;
  /** @type {AudioController} */   #audio;

  /** @param {AudioController} audio */
  constructor(audio) {
    this.#dialog = /** @type {HTMLDialogElement} */ (document.getElementById("npc-dialog-enia"));
    this.#fadeEl = /** @type {HTMLElement} */ (document.getElementById("fade-map"));
    this.#audio  = audio;

    const zone    = document.getElementById("rt-zone-enia");
    const eniaImg = document.getElementById("rt-img-enia");
    let eniaActive = false;

    /** Shared cleanup for Leave and Escape. */
    const closeDialog = () => {
      eniaActive = false;
      eniaImg?.classList.remove("rt-npc--glow");
      sceneZoom.zoomOut();
      this.#dialog.close();
    };

    zone?.addEventListener("mouseenter", () => eniaImg?.classList.add("rt-npc--glow"));
    zone?.addEventListener("mouseleave", () => { if (!eniaActive) eniaImg?.classList.remove("rt-npc--glow"); });
    zone?.addEventListener("click", () => {
      eniaActive = true;
      eniaImg?.classList.add("rt-npc--glow");
      sceneZoom.zoomTo(78, 62);
      this.#dialog.showModal();
      // Focus first option so Enter immediately works
      /** @type {HTMLElement | null} */ (this.#dialog.querySelector(".npc-topic-btn"))?.focus();
    });

    // Audio topic buttons — fade dialog, show subtitle, play, restore
    this.#dialog.querySelectorAll(".npc-topic-btn[data-audio]").forEach(btn => {
      btn.addEventListener("click", e => {
        e.preventDefault();
        const el    = /** @type {HTMLElement} */ (btn);
        const track = el.dataset.npcTrack;
        if (track) spokenNpcs.add(track);
        const srcs = (el.dataset.audio ?? "").split(",").map(s => s.trim()).filter(Boolean);
        const line = el.dataset.subtitle ?? btn.textContent?.trim() ?? "";
        playNpcTopic({ dialog: this.#dialog, audio: this.#audio, npcName: "Enia, the Finger Reader", srcs, subtitleLine: line });
      });
    });

    // "Seek the Elden Ring" — check all NPCs spoken to, then transition
    this.#dialog.querySelector("[data-action='seek-elden-ring']")?.addEventListener("click", e => {
      e.preventDefault();
      const missed = ALL_NPC_IDS.filter(id => !spokenNpcs.has(id));
      if (missed.length > 0) {
        // Show confirmation — list the NPCs not yet spoken to
        const confirmDialog = /** @type {HTMLDialogElement} */ (document.getElementById("dialog-seek-confirm"));
        const missedEl = document.getElementById("seek-confirm-missed");
        if (missedEl) missedEl.textContent = missed.map(id => NPC_NAMES[id]).join(" · ");

        const doDepart = () => {
          roundtableScrollLocked = false;
          confirmDialog.close();
          this.#dialog.close();
          eniaActive = false;
          sceneZoom.zoomOut();
          this.#transitionToNarration();
        };

        document.getElementById("seek-confirm-yes")?.addEventListener("click", doDepart, { once: true });
        document.getElementById("seek-confirm-no")?.addEventListener("click", () => confirmDialog.close(), { once: true });
        confirmDialog.addEventListener("cancel", () => confirmDialog.close(), { once: true });
        confirmDialog.showModal();
      } else {
        roundtableScrollLocked = false;
        this.#dialog.close();
        eniaActive = false;
        sceneZoom.zoomOut();
        this.#transitionToNarration();
      }
    });

    // Leave button
    this.#dialog.querySelector(".npc-topic-btn--leave")?.addEventListener("click", e => {
      e.preventDefault();
      closeDialog();
    });

    // Escape key: browser fires 'cancel' before closing — run our cleanup
    this.#dialog.addEventListener("cancel", () => closeDialog());
  }

  #transitionToNarration() {
    this.#audio.stopDialogue();
    this.#audio.stopSfx();
    this.#audio.stopBgmNow();

    this.#fadeEl.classList.add("active");
    setTimeout(() => {
      document.getElementById("erdtree-scroll")?.scrollIntoView({ behavior: "instant", block: "start" });
      this.#audio.startBgm("audio/music/gameplay-trailer-from-shadow-of-the-erdtree.mp3", 0.35);
      setTimeout(() => this.#fadeEl.classList.remove("active"), 50);
    }, 750);
  }
}

/* ──────────────────────────────────────────────────────
   ROUNDTABLE HOLD — wake-up sequence
   Triggers once when the section enters the viewport.
   Snaps into view and locks page scroll until the
   choice dialog is dismissed.
   Plays BGM → walking SFX → sigh → "my oh my".
────────────────────────────────────────────────────── */

class RoundtableHold {
  /** @type {HTMLElement} */      #section;
  /** @type {AudioController} */  #audio;
  #awoken = false;

  /** @param {AudioController} audio */
  constructor(audio) {
    this.#section = /** @type {HTMLElement} */ (document.getElementById("roundtable"));
    this.#audio   = audio;

    // IntersectionObserver fires regardless of body scroll-lock state, making
    // the audio trigger reliable whether the user scrolls or uses the sidenav.
    const io = new IntersectionObserver(([entry]) => {
      if (!this.#awoken && entry.intersectionRatio >= 0.4) {
        this.#awoken = true;
        this.#section.classList.add("rt-awake");
        this.#section.scrollIntoView({ behavior: "smooth", block: "start" });
        roundtableScrollLocked = true;
        this.#audio.onUnlock(() => this.#playAudio());
      }
    }, { threshold: [0.4] });
    io.observe(this.#section);
  }

  #playAudio() {
    this.#audio.startBgm("audio/music/1-08 Roundtable Hold.mp3", 0.4);
    this.#audio.playAmbientSfx(
      ["audio/sfx/walking.mp3", "audio/sfx/Roundtable sfx.mp3"],
      0.7,
    );
  }
}

/* ──────────────────────────────────────────────────────
   ROUNDTABLE NPC — hover glow + zoom-in + dialogue menu
   with subtitle overlay and dialog fade.
────────────────────────────────────────────────────── */

/**
 * NPC name → preload element id.
 * Parcel rewrites the src in HTML; we read the resolved URL at runtime.
 */
const NPC_PORTRAIT_EL = Object.freeze({
  "Enia, the Finger Reader":       "portrait-src-enia",
  "D, Hunter of the Dead":         "portrait-src-d",
  "Gideon Ofnir, the All-Knowing": "portrait-src-gideon",
  "Sorcerer Rogier":               "portrait-src-rogier",
});

const subtitle = (() => {
  /** @type {{ el: HTMLElement, name: HTMLElement, typed: HTMLElement, cursor: HTMLElement, portrait: HTMLImageElement } | null} */
  let cache = null;

  /** @type {ReturnType<typeof setTimeout> | null} */
  let typingTimer = null;

  function resolve() {
    if (cache) return cache;
    const el      = document.getElementById("rt-subtitle");
    const name    = el?.querySelector(".rt-subtitle__name");
    const typed   = el?.querySelector(".rt-subtitle__typed");
    const cursor  = el?.querySelector(".rt-subtitle__cursor");
    const portrait = document.getElementById("rt-subtitle-portrait");
    if (el && name && typed && cursor && portrait) {
      cache = {
        el:       /** @type {HTMLElement} */      (el),
        name:     /** @type {HTMLElement} */      (name),
        typed:    /** @type {HTMLElement} */      (typed),
        cursor:   /** @type {HTMLElement} */      (cursor),
        portrait: /** @type {HTMLImageElement} */ (portrait),
      };
    }
    return cache;
  }

  function cancelTyping() {
    if (typingTimer !== null) { clearTimeout(typingTimer); typingTimer = null; }
  }

  /**
   * Split text into sentences on . ! ? boundaries.
   * Keeps the punctuation with its sentence.
   * @param {string} text
   * @returns {string[]}
   */
  function splitSentences(text) {
    const parts = text.match(/[^.!?…]+[.!?…]+\s*/g);
    if (!parts) return [text];
    const sentences = parts.map(s => s.trim()).filter(Boolean);
    // Sum consumed characters from the raw (un-trimmed) parts to find any trailing fragment
    const consumed = parts.reduce((n, p) => n + p.length, 0);
    const remainder = text.slice(consumed).trim();
    if (remainder) sentences.push(remainder);
    return sentences.length ? sentences : [text];
  }

  /**
   * Type one sentence character by character, then either pause and show the
   * next sentence (for multi-sentence lines) or mark the cursor done.
   * @param {HTMLElement}  typed
   * @param {HTMLElement}  cursor
   * @param {string[]}     sentences   all sentences in this line
   * @param {number}       sIdx        current sentence index
   * @param {number}       cIdx        current char index within current sentence
   */
  function typeNext(typed, cursor, sentences, sIdx, cIdx) {
    const sentence = sentences[sIdx];
    if (cIdx >= sentence.length) {
      // Sentence finished
      if (sIdx + 1 < sentences.length) {
        // Pause between sentences, then clear and type the next one
        typingTimer = setTimeout(() => {
          typed.textContent = "";
          typeNext(typed, cursor, sentences, sIdx + 1, 0);
        }, 900);
      } else {
        // All done — blink cursor to signal player can skip/continue
        cursor.classList.add("rt-subtitle__cursor--done");
        typingTimer = null;
      }
      return;
    }

    typed.textContent += sentence[cIdx];

    const ch    = sentence[cIdx];
    const delay = /[.!?…]/.test(ch) ? 80  // full stop — let it breathe
                : /[,;:]/.test(ch)  ? 460  // mid-sentence pause
                : ch === " "        ? 105  // word gap
                :                      48; // base — matches audio pacing
    typingTimer = setTimeout(() => typeNext(typed, cursor, sentences, sIdx, cIdx + 1), delay);
  }

  /** Lines longer than this get split into sentences. */
  const SPLIT_THRESHOLD = 120;

  return {
    /**
     * @param {string} npcName
     * @param {string} line
     */
    show(npcName, line) {
      const s = resolve();
      if (!s) return;
      cancelTyping();

      // Portrait — read the Parcel-resolved src from the preload element
      const preloadId = NPC_PORTRAIT_EL[npcName];
      const preloadEl = preloadId ? /** @type {HTMLImageElement|null} */ (document.getElementById(preloadId)) : null;
      const src = preloadEl?.src ?? "";
      s.portrait.src = src;
      s.portrait.style.display = src ? "block" : "none";

      s.name.textContent = npcName;
      s.typed.textContent = "";
      s.cursor.classList.remove("rt-subtitle__cursor--done");
      s.el.classList.add("rt-subtitle--visible");

      const sentences = line.length > SPLIT_THRESHOLD ? splitSentences(line) : [line];
      typeNext(s.typed, s.cursor, sentences, 0, 0);
    },
    hide() {
      cancelTyping();
      const s = resolve();
      if (!s) return;
      s.el.classList.remove("rt-subtitle--visible");
    },
  };
})();

/**
 * Scene zoom — singleton; caches the `.rt-layers` element on first access.
 * @type {{ zoomTo(ox: number, oy: number, scale?: number): void, zoomOut(): void }}
 */
const sceneZoom = (() => {
  /** @type {HTMLElement | null} */
  let layers = null;

  /** @returns {HTMLElement | null} */
  function getLayers() {
    return (layers ??= /** @type {HTMLElement | null} */ (document.querySelector(".rt-layers")));
  }

  return {
    /**
     * @param {number} ox    transform-origin X %
     * @param {number} oy    transform-origin Y %
     * @param {number} [scale=1.55]
     */
    zoomTo(ox, oy, scale = 1.55) {
      const el = getLayers();
      if (!el) return;
      el.style.transformOrigin = `${ox}% ${oy}%`;
      el.style.transform       = `scale(${scale})`;
    },
    zoomOut() {
      const el = getLayers();
      if (!el) return;
      el.style.transform = "scale(1)";
    },
  };
})();

/**
 * @typedef {{
 *   zoneId:   string,
 *   imgId:    string,
 *   dialogId: string,
 *   npcName:  string,
 *   zoomX:    number,
 *   zoomY:    number,
 * }} NpcConfig
 */

class RoundtableNPC {
  /** @type {AudioController} */ #audio;
  /** @type {string} */          #name;

  /**
   * @param {NpcConfig}       config
   * @param {AudioController} audio
   */
  constructor({ zoneId, imgId, dialogId, npcName, zoomX, zoomY }, audio) {
    this.#audio = audio;
    this.#name  = npcName;

    const zone   = document.getElementById(zoneId);
    const img    = document.getElementById(imgId);
    const dialog = /** @type {HTMLDialogElement | null} */ (document.getElementById(dialogId));

    if (!zone || !img || !dialog) {
      console.warn(`RoundtableNPC: missing element(s) for "${npcName}" (zone=${zoneId}, img=${imgId}, dialog=${dialogId})`);
      return;
    }

    /** Close the dialog and run all cleanup. */
    const closeDialog = () => {
      active = false;
      img.classList.remove("rt-npc--glow");
      sceneZoom.zoomOut();
      dialog.close();
    };

    let active = false;
    let hasSpoken = false;
    zone.addEventListener("mouseenter", () => img.classList.add("rt-npc--glow"));
    zone.addEventListener("mouseleave", () => { if (!active) img.classList.remove("rt-npc--glow"); });

    zone.addEventListener("click", () => {
      active = true;
      img.classList.add("rt-npc--glow");
      sceneZoom.zoomTo(zoomX, zoomY);
      dialog.showModal();
      // Play idle audio on return visits if the dialog has data-idle-audio set
      if (hasSpoken) {
        const idleAttr = dialog.dataset.idleAudio;
        if (idleAttr) {
          const idleSrcs = idleAttr.split(",").map(s => s.trim()).filter(Boolean);
          playNpcIdle({ audio: this.#audio, npcName: this.#name, srcs: idleSrcs });
        }
      }
      hasSpoken = true;
      // Focus first option so Enter immediately works
      /** @type {HTMLElement | null} */ (dialog.querySelector(".npc-topic-btn"))?.focus();
    });

    dialog.querySelectorAll(".npc-topic-btn[data-audio]").forEach(btn => {
      btn.addEventListener("click", e => {
        e.preventDefault();
        const el       = /** @type {HTMLElement} */ (btn);
        const track    = el.dataset.npcTrack;
        if (track) spokenNpcs.add(track);
        const srcs     = (el.dataset.audio ?? "").split(",").map(s => s.trim()).filter(Boolean);
        const line     = el.dataset.subtitle ?? btn.textContent?.trim() ?? "";
        const unlockId = el.dataset.unlocks ?? null;
        playNpcTopic({ dialog, audio: this.#audio, npcName: this.#name, srcs, subtitleLine: line, unlockId });
      });
    });

    dialog.querySelectorAll(".npc-topic-btn--leave").forEach(btn => {
      btn.addEventListener("click", e => {
        e.preventDefault();
        closeDialog();
      });
    });

    // Escape key: browser fires 'cancel' before closing — run our cleanup
    dialog.addEventListener("cancel", () => closeDialog());
  }

}

/* ──────────────────────────────────────────────────────
   GRACE EMBERS — golden mote particle system
────────────────────────────────────────────────────── */

/**
 * @typedef {{ x: number, y: number, size: number, vy: number,
 *   driftAmp: number, driftFreq: number, driftPhase: number,
 *   alpha: number, maxAlpha: number, fadeDir: number, fadeSpeed: number }} Particle
 */

class GraceEmbers {
  static #MAX = 90;

  /** @type {HTMLCanvasElement} */        #canvas;
  /** @type {CanvasRenderingContext2D} */ #ctx;
  #width  = 0;
  #height = 0;
  /** @type {Particle[]} */ #particles = [];
  #lastTimestamp = 0;

  /** @param {HTMLCanvasElement} canvasEl */
  constructor(canvasEl) {
    this.#canvas = canvasEl;
    this.#ctx    = /** @type {CanvasRenderingContext2D} */ (canvasEl.getContext("2d"));
    this.#resize();
    window.addEventListener("resize", () => this.#resize(), { passive: true });

    for (let i = 0; i < GraceEmbers.#MAX; i++) {
      this.#particles.push(this.#newParticle(true));
    }
    requestAnimationFrame(ts => this.#tick(ts));
  }

  #resize() {
    const rect     = this.#canvas.parentElement?.getBoundingClientRect();
    this.#width    = this.#canvas.width  = Math.round(rect?.width  ?? 0) || window.innerWidth;
    this.#height   = this.#canvas.height = Math.round(rect?.height ?? 0) || window.innerHeight;
  }

  /**
   * @param {boolean} [distributed=false]
   * @returns {Particle}
   */
  #newParticle(distributed = false) {
    const size = 0.7 + Math.random() * 1.6;
    return {
      x:          Math.random() * this.#width,
      y:          distributed ? Math.random() * this.#height : -size * 6,
      size,
      vy:         10 + Math.random() * 20,
      driftAmp:   8 + Math.random() * 18,
      driftFreq:  0.15 + Math.random() * 0.4,
      driftPhase: Math.random() * Math.PI * 2,
      alpha:      distributed ? Math.random() * 0.7 : 0,
      maxAlpha:   0.5 + Math.random() * 0.35,
      fadeDir:    distributed && Math.random() > 0.5 ? -1 : 1,
      fadeSpeed:  0.06 + Math.random() * 0.08,  // slow fade — survives to bottom
    };
  }

  /**
   * Update physics for one particle. Returns false when it should be removed.
   * @param {Particle} p
   * @param {number} dt  delta-time in seconds
   * @param {number} t   running time in seconds (for drift sine)
   */
  #updateParticle(p, dt, t) {
    p.y += p.vy * dt;                        // fall downward
    p.x += Math.sin(t * p.driftFreq * Math.PI * 2 + p.driftPhase) * p.driftAmp * dt;
    p.alpha += p.fadeSpeed * p.fadeDir * dt;
    if (p.alpha >= p.maxAlpha) { p.alpha = p.maxAlpha; p.fadeDir = -1; }
    if (p.alpha <= 0 && p.fadeDir < 0) return false;
    p.alpha = Math.max(0, p.alpha);
    return p.y <= this.#height + p.size * 8; // remove once past bottom
  }

  /**
   * Draw one particle onto the canvas context.
   * @param {Particle} p
   */
  #drawParticle(p) {
    const ctx = this.#ctx;
    const r   = p.size * 7;
    const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    grd.addColorStop(0,   `rgba(255, 235, 140, ${p.alpha})`);
    grd.addColorStop(0.3, `rgba(220, 172,  48, ${p.alpha * 0.7})`);
    grd.addColorStop(1,   `rgba(160, 100,  10, 0)`);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = grd;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * 0.65, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 252, 220, ${Math.min(p.alpha * 2.8, 1)})`;
    ctx.fill();
  }

  /** @param {DOMHighResTimeStamp} ts */
  #tick(ts) {
    requestAnimationFrame(ts => this.#tick(ts));
    const dt = Math.min((ts - this.#lastTimestamp) / 1000, 0.1);
    this.#lastTimestamp = ts;
    const t = ts * 0.001;

    this.#ctx.clearRect(0, 0, this.#width, this.#height);

    if (this.#particles.length < GraceEmbers.#MAX && Math.random() < dt * 9) {
      this.#particles.push(this.#newParticle(false));
    }

    this.#particles = this.#particles.filter(p => {
      if (!this.#updateParticle(p, dt, t)) return false;
      this.#drawParticle(p);
      return true;
    });
  }
}

/* ──────────────────────────────────────────────────────
   SOUND CONTROL
   Fixed panel with per-category toggles (Music / Dialogue
   / SFX). Wires HTML checkboxes to AudioController flags.
   Turning Music on also starts the Roundtable Hold track
   as ambient background music if nothing is playing yet.
────────────────────────────────────────────────────── */

class SoundControl {
  /** @param {AudioController} audio */
  constructor(audio) {
    const bgmToggle       = /** @type {HTMLInputElement|null} */ (document.getElementById("toggle-bgm"));
    const dialogueToggle  = /** @type {HTMLInputElement|null} */ (document.getElementById("toggle-dialogue"));
    const sfxToggle       = /** @type {HTMLInputElement|null} */ (document.getElementById("toggle-sfx"));

    bgmToggle?.addEventListener("change", () => {
      const on = bgmToggle.checked;
      audio.setBgmEnabled(on);
      // Start roundtable ambience when music is turned on and nothing is loaded yet.
      if (on && !audio.hasBgm) {
        audio.startBgm("audio/music/1-08 Roundtable Hold.mp3", 0.4);
      }
    });

    dialogueToggle?.addEventListener("change", () => {
      audio.setDialogueEnabled(dialogueToggle.checked);
    });

    sfxToggle?.addEventListener("change", () => {
      audio.setSfxEnabled(sfxToggle.checked);
    });
  }
}

/* ──────────────────────────────────────────────────────
   MAIN APP ORCHESTRATOR
────────────────────────────────────────────────────── */

class EldenRingApp {
  /** @type {AudioController} */  #audio;
  /** @type {SideNav} */          #sidenav;
  /** @type {ErdtreeScenePlayer} */   #erdtree;
  /** @type {Element[]} */        #fadeEls;
  /** @type {HTMLElement} */      #volumeNotice;
  /** @type {HTMLElement} */      #scrollCta;
  /** @type {HTMLElement} */      #heroEl;
  #ticking = false;

  constructor() {
    this.#audio   = new AudioController();
    this.#sidenav = new SideNav();

    new RoundtableHold(this.#audio);
    new ChoiceMap(this.#audio);
    new SoundControl(this.#audio);

    // Tutorial panel — dismiss on close, unlock Enia's seek button
    document.getElementById("rt-tutorial-close")?.addEventListener("click", () => {
      const panel = document.getElementById("rt-tutorial");
      panel?.classList.add("rt-tutorial--dismissed");
      document.getElementById("npc-enia-topic-seek")?.removeAttribute("hidden");
    });

    /** @type {readonly NpcConfig[]} */
    const NPC_CONFIGS = Object.freeze([
      { zoneId: "rt-zone-d",      imgId: "rt-img-d",      dialogId: "npc-dialog-d",      npcName: "D, Hunter of the Dead",         zoomX: 22, zoomY: 68 },
      { zoneId: "rt-zone-gideon", imgId: "rt-img-gideon", dialogId: "npc-dialog-gideon", npcName: "Gideon Ofnir, the All-Knowing", zoomX: 14, zoomY: 68 },
      { zoneId: "rt-zone-rogier", imgId: "rt-img-rogier", dialogId: "npc-dialog-rogier", npcName: "Sorcerer Rogier",               zoomX: 65, zoomY: 68 },
    ]);
    for (const config of NPC_CONFIGS) new RoundtableNPC(config, this.#audio);

    this.#erdtree = new ErdtreeScenePlayer(this.#audio);

    document.querySelectorAll(".grace-embers").forEach(c =>
      new GraceEmbers(/** @type {HTMLCanvasElement} */ (c)),
    );

    this.#fadeEls      = Array.from(document.querySelectorAll(".fade-in"));
    this.#volumeNotice = /** @type {HTMLElement} */ (document.querySelector(".volume-notice"));
    this.#scrollCta    = /** @type {HTMLElement} */ (document.querySelector(".scroll-cta"));
    this.#heroEl       = /** @type {HTMLElement} */ (document.getElementById("hero"));

    this.#initIntroModal();

    window.addEventListener("scroll", () => this.#scheduleUpdate(), { passive: true });
    window.addEventListener("resize", () => this.#update(), { passive: true });
    this.#update();
  }

  /** Show the narrative intro modal on first downward scroll from the hero. */
  #initIntroModal() {
    const modal  = /** @type {HTMLElement|null} */ (document.getElementById("intro-modal"));
    const enterBtn = document.getElementById("intro-modal-enter");
    if (!modal || !enterBtn) return;

    let triggered = false;

    const dismiss = () => {
      modal.classList.remove("intro-modal--visible");
      modal.addEventListener("transitionend", () => { modal.hidden = true; }, { once: true });
    };

    const show = () => {
      if (triggered) return;
      triggered = true;
      modal.hidden = false;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => modal.classList.add("intro-modal--visible"));
      });
    };

    // Fire on first downward scroll past 5% of the hero height
    const onScroll = () => {
      if (window.scrollY > this.#heroEl.offsetHeight * 0.05) {
        show();
        window.removeEventListener("scroll", onScroll);
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });

    enterBtn.addEventListener("click", dismiss);
    // Keyboard: Enter or Space also closes
    enterBtn.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); dismiss(); }
    });
  }

  #scheduleUpdate() {
    if (this.#ticking) return;
    this.#ticking = true;
    requestAnimationFrame(() => { this.#update(); this.#ticking = false; });
  }

  #update() {
    const scrollY  = window.scrollY;
    const vh       = window.innerHeight;
    const heroDone = scrollY > this.#heroEl.offsetHeight * 0.5;

    this.#volumeNotice.classList.toggle("hero-prompt--hidden", heroDone);
    this.#scrollCta.classList.toggle("hero-prompt--hidden",    heroDone);
    this.#sidenav.update(scrollY, vh);
    this.#updateFadeIns(vh);
  }

  /** @param {number} vh */
  #updateFadeIns(vh) {
    for (const el of this.#fadeEls) {
      if (!el.classList.contains("visible") && el.getBoundingClientRect().top < vh * 0.88) {
        el.classList.add("visible");
      }
    }
  }
}

/* ── Boot ──────────────────────────────────────────── */

new EldenRingApp();
