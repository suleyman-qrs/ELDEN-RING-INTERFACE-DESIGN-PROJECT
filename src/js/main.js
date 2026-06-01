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
  DIALOG_FADE:      370,
  /** Delay before fading dialog back in after audio ends or is skipped. */
  SUBTITLE_RESTORE: 300,
  /** Delay before arming the skip-click listener (avoids catching the triggering click). */
  SKIP_ARM:         200,
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
  #unlocked = false;
  #pendingBgm = false;
  #dialogueGen = 0;
  /** @type {Array<() => void>} */       #unlockCallbacks = [];

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
    if (this.#unlocked) {
      this.#tryPlay(this.#bgm);
    } else {
      this.#pendingBgm = true;
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
   * @param {string} newSrc
   * @param {number} [fadeDuration=2000]
   * @param {number} [newVolume=0.4]
   */
  crossfadeToBgm(newSrc, fadeDuration = 2000, newVolume = 0.4) {
    this.stopBgm(fadeDuration);
    setTimeout(() => this.startBgm(newSrc, newVolume), fadeDuration * 0.6);
  }

  /**
   * Plays multiple SFX tracks concurrently.
   * @param {string[]} srcs
   * @param {number} [volume=1]
   */
  playSfxSimultaneous(srcs, volume = 1) {
    if (!this.#unlocked || !srcs.length) return;
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
   * Plays SFX tracks one after another.
   * @param {string[]} srcs
   * @param {number} [volume=1]
   */
  playSfxSequence(srcs, volume = 1) {
    if (!this.#unlocked || !srcs.length) return;
    const [first, ...rest] = srcs;
    const sfx = new Audio(first);
    sfx.volume = volume;
    sfx.play().catch(() => {});
    if (rest.length) {
      sfx.addEventListener("ended", () => this.playSfxSequence(rest, volume), { once: true });
    }
  }

  /**
   * Plays dialogue tracks sequentially, optionally looping the full sequence.
   * Uses the generation counter so stopDialogue() cancels pending callbacks.
   * @param {string[]} srcs
   * @param {boolean}  [loop=false]
   * @param {string[]} [_root=srcs] - Full original sequence for loop restart
   */
  playDialogueSequence(srcs, loop = false, _root = srcs) {
    this.#dialogue?.pause();
    this.#dialogue = null;
    if (!this.#unlocked || !srcs.length) return;

    const gen = ++this.#dialogueGen;
    const [first, ...rest] = srcs;
    const el = new Audio(first);
    this.#dialogue = el;
    el.volume = 1;
    el.play().catch(() => {});

    const nextSrcs = rest.length ? rest : (loop ? _root : null);
    if (nextSrcs) {
      el.addEventListener("ended", () => {
        if (this.#dialogueGen === gen) this.playDialogueSequence(nextSrcs, loop, _root);
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
    if (!this.#unlocked || !srcs.length) { onEnd?.(); return; }

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
}

/* ──────────────────────────────────────────────────────
   SCENE DATA
   12 PNG sequences, one per narration line.
   Each entry maps to Scenes/<dir>/<prefix>NN.png.
────────────────────────────────────────────────────── */

/**
 * @typedef {{ dir: string, prefix: string, count: number, audio: string[], text: string, loop?: boolean }} SceneData
 */

/** @type {readonly SceneData[]} */
const SCENES = Object.freeze([
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
    audio: ["audio/dialogue/Each, inheriting their own shard, played a part in the Shattering.wav"],
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
    audio: ["audio/dialogue/And so the Two Fingers call upon ye, the Tarnished.wav"],
    text: "And so the Two Fingers<br>call upon ye, the Tarnished.",
  },
  {
    dir: "Scenes/12_To_cross_the_fog",
    prefix: "to_cross_the_fog",
    count: 92,
    audio: ["audio/dialogue/To cross the Sea of Fog, to the Lands Between To seek the Elden Ring. Seek the Elden Ring.wav"],
    text: "To cross the Sea of Fog,<br>to the Lands Between.<br><br>To seek the Elden Ring.<br>Seek the Elden Ring.",
    loop: true,
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
  cues.splice(1, 0, {
    frame: 40,
    audio: ["audio/dialogue/giving life its fullest brilliance.wav"],
    text:  "Giving life its<br>fullest brilliance.",
    loop:  false,
  });
  return Object.freeze(cues);
})();

/* ──────────────────────────────────────────────────────
   NARRATION SCENE PLAYER
   Drives the multi-scene PNG animation.
   Displays subtitles and triggers dialogue per scene.
   Converts vertical wheel → scene advance / rewind.
────────────────────────────────────────────────────── */

class ErdtreeHScroll {
  static #FPS = 12;

  /** @type {HTMLElement} */       #section;
  /** @type {HTMLElement} */       #stage;
  /** @type {HTMLElement} */       #subtitle;
  /** @type {HTMLElement} */       #canvasEl;
  /** @type {ErdtreePlayer} */     #player;
  /** @type {AudioController} */   #audio;
  /** @type {number[]} */          #sceneStart = [];

  #chapter     = -1;
  #rafId       = null;
  #lastTs      = null;
  #frame       = 0;
  #targetFrame = -1;
  #sceneIdx    = -1;   // -1 = not yet entered
  #active      = false;
  #done        = false; // true once last scene finishes
  #sliding     = false; // true during slide transition
  #slideTimer  = null;

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

    this.#player.init();
    this.#initVisibilityObserver();
    this.#initWheelHandler();
  }

  #initVisibilityObserver() {
    // Stage uses a higher threshold (0.6) so it fades out quickly once the
    // user scrolls past — without this the fixed canvas blocks visual feedback.
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
        this.#subtitle.classList.remove("visible");
        this.#chapter = -1;
        this.#stopPlay();
        this.#audio.stopDialogue();
      }
    }, { threshold: [0, 0.1, 0.5, 0.6, 1.0] });
    io.observe(this.#section);
  }

  #initWheelHandler() {
    // While a scene is playing or transitioning, swallow the event so it
    // doesn't race ahead. At the edges, pass through so the page can scroll.
    window.addEventListener("wheel", e => {
      if (!this.#active) return;
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;

      const goingDown = e.deltaY > 0;

      if (this.#rafId || this.#sliding) { e.preventDefault(); return; }
      if (goingDown && this.#done) return;
      if (!goingDown && this.#sceneIdx <= 0) {
        document.body.style.overflow = "";
        return;
      }

      e.preventDefault();
      this.#goToScene(this.#sceneIdx + (goingDown ? 1 : -1));
    }, { passive: false });
  }

  /** @param {number} idx */
  #goToScene(idx) {
    idx = Math.max(0, Math.min(SCENES.length - 1, idx));

    const isFirst   = this.#sceneIdx < 0;
    const direction = idx >= this.#sceneIdx ? 1 : -1;

    this.#done        = false;
    this.#sceneIdx    = idx;
    this.#frame       = this.#sceneStart[idx];
    this.#targetFrame = idx < SCENES.length - 1
      ? this.#sceneStart[idx + 1] - 1
      : TOTAL_FRAMES - 1;

    this.#stopPlay();

    if (isFirst) {
      this.#checkChapterCues();
      this.#lastTs = null;
      this.#rafId  = requestAnimationFrame(ts => this.#tick(ts));
      return;
    }

    // Slide transition: old frame slides out, new slides in.
    this.#sliding = true;
    clearTimeout(this.#slideTimer);
    const el   = this.#canvasEl;
    const outX = direction === 1 ? "-100%" : "100%";
    const inX  = direction === 1 ?  "100%" : "-100%";

    el.style.transition = "transform 0.3s ease-in";
    el.style.transform  = `translateX(${outX})`;

    this.#slideTimer = setTimeout(() => {
      // Seek and fire cues now so dialogue starts as the new frame slides in.
      this.#player.seek(this.#frame);
      this.#checkChapterCues();

      el.style.transition = "none";
      el.style.transform  = `translateX(${inX})`;
      void el.offsetWidth; // force reflow so the next transition fires
      el.style.transition = "transform 0.35s ease-out";
      el.style.transform  = "translateX(0)";

      this.#lastTs = null;
      this.#rafId  = requestAnimationFrame(ts => this.#tick(ts));

      this.#slideTimer = setTimeout(() => {
        el.style.transition = "";
        this.#sliding = false;
      }, 350);
    }, 300);
  }

  #stopPlay() {
    if (this.#rafId) cancelAnimationFrame(this.#rafId);
    this.#rafId = null;
  }

  /** @param {DOMHighResTimeStamp} ts */
  #tick(ts) {
    if (!this.#lastTs) this.#lastTs = ts;
    const elapsed       = ts - this.#lastTs;
    const frameDuration = 1000 / ErdtreeHScroll.#FPS;

    if (elapsed >= frameDuration) {
      const frames  = Math.floor(elapsed / frameDuration);
      this.#lastTs  = ts - (elapsed % frameDuration);
      this.#frame   = Math.min(this.#frame + frames, this.#targetFrame);
      this.#player.seek(this.#frame);
      this.#checkChapterCues();

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

  #checkChapterCues() {
    let chapterIdx = -1;
    for (let i = CHAPTER_CUES.length - 1; i >= 0; i--) {
      if (this.#frame >= CHAPTER_CUES[i].frame) { chapterIdx = i; break; }
    }
    if (chapterIdx < 0 || chapterIdx === this.#chapter) return;

    this.#chapter = chapterIdx;
    this.#subtitle.innerHTML = CHAPTER_CUES[chapterIdx].text;
    this.#subtitle.classList.remove("visible");
    requestAnimationFrame(() =>
      requestAnimationFrame(() => this.#subtitle.classList.add("visible")),
    );
    this.#audio.playDialogueSequence(
      CHAPTER_CUES[chapterIdx].audio,
      CHAPTER_CUES[chapterIdx].loop,
    );
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
    this.#dots    = Array.from(this.#nav.querySelectorAll(".nav-dot"));
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

/* ──────────────────────────────────────────────────────
   CHOICE MAP (Phase 3)
   Listens for clicks on the roundtable <area> hotspot.
   "Yes" → fade to black → scroll to Erdtree sequence.
   "No"  → smooth scroll to footer.
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
        const srcs = (/** @type {HTMLElement} */ (btn).dataset.audio ?? "").split(",").map(s => s.trim()).filter(Boolean);
        const line = /** @type {HTMLElement} */ (btn).dataset.subtitle ?? btn.textContent?.trim() ?? "";
        this.#playTopic(srcs, line);
      });
    });

    // "Seek the Elden Ring" — close dialog then transition
    this.#dialog.querySelector("[data-action='seek-elden-ring']")?.addEventListener("click", e => {
      e.preventDefault();
      this.#dialog.close();
      eniaActive = false;
      sceneZoom.zoomOut();
      document.body.style.overflow = "";
      this.#transitionToNarration();
    });

    // Leave button
    this.#dialog.querySelector(".npc-topic-btn--leave")?.addEventListener("click", e => {
      e.preventDefault();
      closeDialog();
    });

    // Escape key: browser fires 'cancel' before closing — run our cleanup
    this.#dialog.addEventListener("cancel", () => closeDialog());
  }

  /**
   * Fades dialog, shows subtitle, plays audio, then restores.
   * @param {string[]} srcs
   * @param {string}   line
   */
  #playTopic(srcs, line) {
    this.#dialog.classList.add("npc-dialog--faded");

    let done = false;
    const restore = () => {
      if (done) return;
      done = true;
      subtitle.hide();
      setTimeout(() => this.#dialog.classList.remove("npc-dialog--faded"), DIALOGUE_TIMING.SUBTITLE_RESTORE);
    };
    const onSkip = () => {
      if (done) return;
      this.#audio.stopDialogue();
      restore();
    };

    setTimeout(() => {
      subtitle.show("Enia, the Finger Reader", line);
      this.#audio.playDialogueLine(srcs, restore);
      setTimeout(() => document.addEventListener("click", onSkip, { capture: true, once: true }), DIALOGUE_TIMING.SKIP_ARM);
    }, DIALOGUE_TIMING.DIALOG_FADE);
  }

  #transitionToNarration() {
    this.#audio.stopDialogue();
    this.#audio.stopSfx();
    this.#audio.stopBgmNow();

    this.#fadeEl.classList.add("active");
    setTimeout(() => {
      document.getElementById("erdtree-scroll")?.scrollIntoView({ behavior: "instant", block: "start" });
      this.#audio.startBgm("audio/music/scroll music.wav", 0.35);
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
        setTimeout(() => { document.body.style.overflow = "hidden"; }, 600);
        this.#audio.onUnlock(() => this.#playAudio());
      }
    }, { threshold: [0, 0.4, 1.0] });
    io.observe(this.#section);
  }

  #playAudio() {
    this.#audio.startBgm("audio/music/1-08 Roundtable Hold.mp3", 0.4);
    this.#audio.playSfxSimultaneous(
      ["audio/sfx/walking.wav", "audio/sfx/Roundtable sfx.wav"],
      0.7,
    );
  }
}

/* ──────────────────────────────────────────────────────
   ROUNDTABLE NPC — hover glow + zoom-in + dialogue menu
   with subtitle overlay and dialog fade.
────────────────────────────────────────────────────── */

/**
 * Subtitle overlay — singleton; caches DOM refs on first access.
 * @type {{ show(npcName: string, line: string): void, hide(): void }}
 */
const subtitle = (() => {
  /** @type {{ el: HTMLElement, name: HTMLElement, text: HTMLElement } | null} */
  let cache = null;

  function resolve() {
    if (cache) return cache;
    const el   = document.getElementById("rt-subtitle");
    const name = el?.querySelector(".rt-subtitle__name");
    const text = el?.querySelector(".rt-subtitle__text");
    if (el && name && text) {
      cache = {
        el:   /** @type {HTMLElement} */ (el),
        name: /** @type {HTMLElement} */ (name),
        text: /** @type {HTMLElement} */ (text),
      };
    }
    return cache;
  }

  return {
    /**
     * @param {string} npcName
     * @param {string} line
     */
    show(npcName, line) {
      const s = resolve();
      if (!s) return;
      s.name.textContent = npcName;
      s.text.textContent = line;
      s.el.classList.add("rt-subtitle--visible");
    },
    hide() {
      resolve()?.el.classList.remove("rt-subtitle--visible");
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
    zone.addEventListener("mouseenter", () => img.classList.add("rt-npc--glow"));
    zone.addEventListener("mouseleave", () => { if (!active) img.classList.remove("rt-npc--glow"); });

    zone.addEventListener("click", () => {
      active = true;
      img.classList.add("rt-npc--glow");
      sceneZoom.zoomTo(zoomX, zoomY);
      dialog.showModal();
      // Focus first option so Enter immediately works
      /** @type {HTMLElement | null} */ (dialog.querySelector(".npc-topic-btn"))?.focus();
    });

    dialog.querySelectorAll(".npc-topic-btn[data-audio]").forEach(btn => {
      btn.addEventListener("click", e => {
        e.preventDefault();
        const el       = /** @type {HTMLElement} */ (btn);
        const srcs     = (el.dataset.audio ?? "").split(",").map(s => s.trim()).filter(Boolean);
        const line     = el.dataset.subtitle ?? btn.textContent?.trim() ?? "";
        const unlockId = el.dataset.unlocks ?? null;
        this.#playTopic(dialog, srcs, line, unlockId);
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

  /**
   * Fades out the dialog, shows subtitle, plays audio sequence, then restores.
   * Clicking anywhere while audio plays skips it and restores the dialog.
   * If unlockId is provided, the element with that ID has its `hidden` attribute
   * removed once the audio finishes (not on skip).
   * @param {HTMLDialogElement} dialog
   * @param {string[]}          srcs
   * @param {string}            line
   * @param {string | null}     [unlockId]
   */
  #playTopic(dialog, srcs, line, unlockId = null) {
    dialog.classList.add("npc-dialog--faded");

    let done = false;

    /** @param {boolean} [completed] — true when audio ended naturally (not skipped) */
    const restore = (completed = false) => {
      if (done) return;
      done = true;
      subtitle.hide();
      // Reveal the follow-up option only when the dialogue played to the end
      if (completed && unlockId) {
        document.getElementById(unlockId)?.removeAttribute("hidden");
      }
      setTimeout(() => dialog.classList.remove("npc-dialog--faded"), DIALOGUE_TIMING.SUBTITLE_RESTORE);
    };
    const onSkip = () => {
      if (done) return;
      this.#audio.stopDialogue();
      restore(false);
    };

    setTimeout(() => {
      subtitle.show(this.#name, line);
      this.#audio.playDialogueLine(srcs, () => restore(true));
      // Arm the skip listener after SKIP_ARM ms to avoid catching the
      // triggering click. Capture phase so it fires before element handlers.
      setTimeout(() => document.addEventListener("click", onSkip, { capture: true, once: true }), DIALOGUE_TIMING.SKIP_ARM);
    }, DIALOGUE_TIMING.DIALOG_FADE);
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
  static #MAX = 40;

  /** @type {HTMLCanvasElement} */        #canvas;
  /** @type {CanvasRenderingContext2D} */ #ctx;
  #W = 0;
  #H = 0;
  /** @type {Particle[]} */ #particles = [];
  #lastTs = 0;

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
    const rect  = this.#canvas.parentElement?.getBoundingClientRect();
    this.#W = this.#canvas.width  = Math.round(rect?.width  ?? 0) || window.innerWidth;
    this.#H = this.#canvas.height = Math.round(rect?.height ?? 0) || window.innerHeight;
  }

  /**
   * @param {boolean} [distributed=false]
   * @returns {Particle}
   */
  #newParticle(distributed = false) {
    const size = 1.2 + Math.random() * 2.5;
    return {
      x:          Math.random() * this.#W,
      y:          distributed ? Math.random() * this.#H : this.#H + size * 6,
      size,
      vy:         16 + Math.random() * 30,
      driftAmp:   10 + Math.random() * 20,
      driftFreq:  0.2 + Math.random() * 0.5,
      driftPhase: Math.random() * Math.PI * 2,
      alpha:      distributed ? Math.random() * 0.45 : 0,
      maxAlpha:   0.3 + Math.random() * 0.4,
      fadeDir:    distributed && Math.random() > 0.5 ? -1 : 1,
      fadeSpeed:  0.2 + Math.random() * 0.3,
    };
  }

  /** @param {DOMHighResTimeStamp} ts */
  #tick(ts) {
    requestAnimationFrame(ts => this.#tick(ts));
    const dt = Math.min((ts - this.#lastTs) / 1000, 0.1);
    this.#lastTs = ts;
    const t = ts * 0.001;

    const ctx = this.#ctx;
    ctx.clearRect(0, 0, this.#W, this.#H);

    if (this.#particles.length < GraceEmbers.#MAX && Math.random() < dt * 4) {
      this.#particles.push(this.#newParticle(false));
    }

    this.#particles = this.#particles.filter(p => {
      p.y -= p.vy * dt;
      p.x += Math.sin(t * p.driftFreq * Math.PI * 2 + p.driftPhase) * p.driftAmp * dt;

      p.alpha += p.fadeSpeed * p.fadeDir * dt;
      if (p.alpha >= p.maxAlpha) { p.alpha = p.maxAlpha; p.fadeDir = -1; }
      if (p.alpha <= 0 && p.fadeDir < 0) return false;
      p.alpha = Math.max(0, p.alpha);
      if (p.y < -p.size * 8) return false;

      const r   = p.size * 5;
      const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      grd.addColorStop(0,   `rgba(255, 225, 120, ${p.alpha})`);
      grd.addColorStop(0.3, `rgba(212, 165,  40, ${p.alpha * 0.65})`);
      grd.addColorStop(1,   `rgba(160, 100,  10, 0)`);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = grd;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 250, 210, ${Math.min(p.alpha * 2.2, 1)})`;
      ctx.fill();

      return true;
    });
  }
}

/* ──────────────────────────────────────────────────────
   MAIN APP ORCHESTRATOR
────────────────────────────────────────────────────── */

class EldenRingApp {
  /** @type {AudioController} */  #audio;
  /** @type {SideNav} */          #sidenav;
  /** @type {ErdtreeHScroll} */   #erdtree;
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

    /** @type {readonly NpcConfig[]} */
    const NPC_CONFIGS = Object.freeze([
      { zoneId: "rt-zone-d",      imgId: "rt-img-d",      dialogId: "npc-dialog-d",      npcName: "D, Hunter of the Dead",         zoomX: 22, zoomY: 68 },
      { zoneId: "rt-zone-gideon", imgId: "rt-img-gideon", dialogId: "npc-dialog-gideon", npcName: "Gideon Ofnir, the All-Knowing", zoomX: 14, zoomY: 68 },
      { zoneId: "rt-zone-rogier", imgId: "rt-img-rogier", dialogId: "npc-dialog-rogier", npcName: "Sorcerer Rogier",               zoomX: 65, zoomY: 68 },
    ]);
    for (const config of NPC_CONFIGS) new RoundtableNPC(config, this.#audio);

    this.#erdtree = new ErdtreeHScroll(this.#audio);

    document.querySelectorAll(".grace-embers").forEach(c =>
      new GraceEmbers(/** @type {HTMLCanvasElement} */ (c)),
    );

    this.#fadeEls      = Array.from(document.querySelectorAll(".fade-in"));
    this.#volumeNotice = /** @type {HTMLElement} */ (document.querySelector(".volume-notice"));
    this.#scrollCta    = /** @type {HTMLElement} */ (document.querySelector(".scroll-cta"));
    this.#heroEl       = /** @type {HTMLElement} */ (document.getElementById("hero"));

    window.addEventListener("scroll", () => this.#scheduleUpdate(), { passive: true });
    window.addEventListener("resize", () => this.#update(), { passive: true });
    this.#update();
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
