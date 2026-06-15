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
    if (!srcs.length) return;
    // The Dialogue toggle only controls the VOICE — when it's off we still play
    // the track MUTED so subtitles and scene timing run exactly the same, just
    // silent. Unmuted audio needs the autoplay unlock; if not yet unlocked we
    // skip (the caller's time-based fallback advances) to avoid a cascade.
    if (this.#dialogueEnabled && !this.#unlocked) return;

    const gen = ++this.#dialogueGen;
    const [first, ...rest] = srcs;
    const el = new Audio(first);
    this.#dialogue = el;
    el.muted = !this.#dialogueEnabled;
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
    if (!srcs.length) { onEnd?.(); return; }
    // Dialogue off → still play MUTED so the subtitle stays for the line's
    // duration and onEnd (restore) fires normally. Unmuted needs the unlock.
    if (this.#dialogueEnabled && !this.#unlocked) { onEnd?.(); return; }

    // Capture current generation; stopDialogue increments it, invalidating callbacks.
    const gen = ++this.#dialogueGen;
    const muted = !this.#dialogueEnabled;
    const guardedEnd = onEnd ? () => { if (this.#dialogueGen === gen) onEnd(); } : undefined;

    const playFrom = (/** @type {string[]} */ remaining) => {
      if (this.#dialogueGen !== gen || !remaining.length) return;
      const [first, ...rest] = remaining;
      const el = new Audio(first);
      this.#dialogue = el;
      el.muted = muted;
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
   * Enable or disable the dialogue VOICE only. The dialogue still plays (driving
   * subtitles + scene/NPC timing); disabling just mutes it. Toggling mid-line
   * mutes/unmutes the current track without interrupting its timing.
   * @param {boolean} on
   */
  setDialogueEnabled(on) {
    this.#dialogueEnabled = on;
    if (this.#dialogue) this.#dialogue.muted = !on;
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
   12 narration lines, each rendered as a full-screen overlay:
   a looping scene video (`videoId`) or a static layered boss
   image (`bossId`). Each carries its dialogue audio + subtitle.
────────────────────────────────────────────────────── */

/**
 * @typedef {{ audio: string[], text: string, loop?: boolean, bossId?: string, videoId?: string }} SceneData
 */

/** @type {readonly SceneData[]} */
const SCENES = Object.freeze([
  {
    audio: [
      "audio/dialogue/Elden Ring.mp3",
      "audio/dialogue/O Elden Ring.mp3",
    ],
    text: "Elden Ring. O, Elden Ring.",
    videoId: "elden-ring",
  },
  {
    audio: [
      "audio/dialogue/giving life its fullest brilliance.mp3",
      "audio/dialogue/its gold commanded the very stars.mp3",
    ],
    text: "Giving life its fullest brilliance.<br>Its gold commanded the very stars,",
    videoId: "radagon",
  },
  {
    audio: ["audio/dialogue/Shattered, by someone, or something.mp3"],
    text: "Shattered, by someone,<br>or something.",
    videoId: "hammer",
  },
  {
    audio: ["audio/dialogue/Godrick, the feeble.mp3"],
    text: "Godrick, the feeble.",
    bossId: "godrick",
  },
  {
    audio: ["audio/dialogue/Malenia, decayed from birth.mp3"],
    text: "Malenia, decayed from birth.",
    bossId: "malenia",
  },
  {
    audio: ["audio/dialogue/General Radahn, slayer of giants.mp3"],
    text: "General Radahn,<br>slayer of giants.",
    bossId: "radahn",
  },
  {
    audio: ["audio/dialogue/Rykard, the tyrannical serpent.mp3"],
    text: "Rykard,<br>the tyrannical serpent.",
    bossId: "rykard",
  },
  {
    audio: ["audio/dialogue/And Morgott, Prince of the Omen.mp3"],
    text: "And Morgott,<br>Prince of the Omen.",
    bossId: "margit",
  },
  {
    audio: ["audio/dialogue/Each, inheriting their own shard, played a part in the Shattering.mp3"],
    text: "Each, inheriting their own shard,<br>played a part in the Shattering,",
    videoId: "vyke",
  },
  {
    audio: ["audio/dialogue/a war with no end, and no victor.mp3"],
    text: "a war with no end,<br>and no victor.",
    videoId: "malenia-radahn",
  },
  {
    audio: ["audio/dialogue/And so the Two Fingers call upon ye, the Tarnished.mp3"],
    text: "And so the Two Fingers<br>call upon ye, the Tarnished.",
    videoId: "tarnished",
  },
  {
    audio: ["audio/dialogue/To cross the Sea of Fog, to the Lands Between To seek the Elden Ring. Seek the Elden Ring.mp3"],
    text: "To cross the Sea of Fog,<br>to the Lands Between.<br><br>To seek the Elden Ring.<br>Seek the Elden Ring.",
    loop: true,
    videoId: "erdtree",
  },
]);

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
   Drives the 12-scene narration. Each scene is a full-screen
   overlay — a scene video or a layered boss image. Converts
   wheel input → scene advance / rewind, and auto-advances
   for passive viewers as each line's dialogue ends.
────────────────────────────────────────────────────── */

class ErdtreeScenePlayer {
  /** @type {HTMLElement} */       #section;
  /** @type {HTMLElement} */       #stage;
  /** @type {HTMLElement} */       #subtitle;
  /** @type {AudioController} */   #audio;
  /** Cached static node lists — never change after page load. */
  /** @type {HTMLElement[]} */     #bossSlides  = [];
  /** @type {HTMLElement[]} */     #sceneVideos = [];

  #chapter     = -1;
  #sceneIdx    = -1;
  #active      = false;
  #done        = false;
  #sliding     = false;
  #slideTimer  = null;
  /** Timer handle for automatic scene advance (passive-viewer mode). */
  #autoTimer   = null;
  /** Outgoing video + its `ended` handler while waiting for a loop to finish
   *  before auto-advancing (so the video never visibly snaps back to frame 0). */
  /** @type {HTMLVideoElement | null} */ #loopEndVideo   = null;
  /** @type {(() => void) | null} */     #loopEndHandler = null;
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
    this.#audio    = audio;

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
      // A sidebar jump is scrolling PAST the narration to a lower section —
      // don't start it or flash the stage in passing.
      if (passingErdtree) return;
      this.#stage.classList.toggle("active", ratio > 0.6);

      if (ratio > 0.5) {
        // Still gated at the Roundtable Hold — never start the narration; the
        // scroll clamp will pull the viewport back to the roundtable.
        if (roundtableScrollLocked) return;
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

      if (this.#sliding) { e.preventDefault(); return; }
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
   * Show the correct overlay (boss image or video) for the given scene index.
   * Pauses any outgoing video and plays the incoming one.
   * @param {number} idx
   */
  #syncOverlay(idx) {
    const scene   = SCENES[idx] ?? {};
    const bossId  = scene.bossId  ?? null;
    const videoId = scene.videoId ?? null;

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
      if (v) {
        // Every scene but the last loops. Set it explicitly (not just via the
        // HTML attribute) so a video reused after an auto-advance — which turns
        // loop off to catch its `ended` — loops again on a later visit.
        v.loop = idx < SCENES.length - 1;
        v.currentTime = 0;
        v.play().catch(() => {});
      }
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

  /**
   * Switch to scene `idx`. Every scene is a video/boss overlay, so the change is
   * applied immediately (the CSS opacity transition handles the crossfade) and a
   * brief slide-lock prevents scroll momentum from skipping the next scene.
   * @param {number} idx
   */
  #goToScene(idx) {
    idx = Math.max(0, Math.min(SCENES.length - 1, idx));

    this.#done     = false;
    this.#finished = false;
    this.#sceneIdx = idx;

    this.#syncOverlay(idx);
    this.#updateChapter(idx);

    if (idx >= SCENES.length - 1) {
      this.#done = true;
      document.body.style.overflow = "";
    }

    // Hold the slide-lock long enough for the CSS fade to settle.
    this.#sliding = true;
    clearTimeout(this.#slideTimer);
    this.#slideTimer = setTimeout(() => {
      this.#sliding = false;
    }, TRANSITION_TIMING.OVERLAY_SLIDE_LOCK);
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
      this.#advanceAtLoopBoundary(nextIdx);
    }, holdMs);
  }

  /**
   * Advance to the next scene cleanly. For a looping video scene, let the current
   * loop finish first — turning `loop` off makes the video play to its end and
   * fire `ended` instead of snapping back to frame 0, so the crossfade starts
   * exactly at the loop boundary with no restart flash. Non-video (boss) scenes,
   * or a video that's already stopped, advance immediately.
   * @param {number} nextIdx
   */
  #advanceAtLoopBoundary(nextIdx) {
    const videoId = SCENES[this.#sceneIdx]?.videoId;
    const v = videoId
      ? /** @type {HTMLVideoElement|null} */ (document.querySelector(`#scene-${videoId} video`))
      : null;

    if (!v || v.paused || v.ended) { this.#goToScene(nextIdx); return; }

    v.loop = false;
    this.#loopEndVideo   = v;
    this.#loopEndHandler = () => {
      this.#clearLoopEndWatch();
      if (this.#active && !this.#done) this.#goToScene(nextIdx);
    };
    v.addEventListener("ended", this.#loopEndHandler, { once: true });
  }

  /** Detach a pending loop-boundary `ended` watcher, if any. */
  #clearLoopEndWatch() {
    if (this.#loopEndVideo && this.#loopEndHandler) {
      this.#loopEndVideo.removeEventListener("ended", this.#loopEndHandler);
    }
    this.#loopEndVideo   = null;
    this.#loopEndHandler = null;
  }

  #cancelAutoAdvance() {
    if (this.#autoTimer !== null) { clearTimeout(this.#autoTimer); this.#autoTimer = null; }
    this.#clearLoopEndWatch();
  }

  /**
   * Show the subtitle and drive the dialogue + auto-advance for scene `idx`.
   * Guarded by `#chapter` so re-entering the same scene doesn't restart it.
   * @param {number} idx
   */
  #updateChapter(idx) {
    if (idx < 0 || idx === this.#chapter) return;

    this.#chapter = idx;
    this.#cancelAutoAdvance();
    this.#sceneEnteredAt = performance.now();

    const cue = SCENES[idx];
    this.#subtitle.innerHTML = cue.text;
    this.#subtitle.classList.remove("visible");
    requestAnimationFrame(() =>
      requestAnimationFrame(() => this.#subtitle.classList.add("visible")),
    );

    const isLast = idx >= SCENES.length - 1;

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
        const target = /** @type {HTMLElement | null} */ (this.#targets[i]);
        if (!target) return;

        const holdTop    = roundtableTopY();
        const erdtreeTop = document.getElementById("erdtree-scroll")?.offsetTop ?? Infinity;

        // The sidebar bypasses the roundtable gate (manual scrolling still can't).
        navigating = true;
        roundtableFrozen = false;
        document.body.style.overflow = "";

        if (target.offsetTop >= holdTop) {
          // Jumping to or past the hold via the sidebar departs it.
          seekDeparted = true;
          roundtableScrollLocked = false;
          // Going PAST the narration (About / Play Game) — scroll through it
          // without auto-starting it. Landing ON it (The Shattering) still does.
          if (target.offsetTop > erdtreeTop) passingErdtree = true;
        }

        clearNavOnSettle();
        target.scrollIntoView({ behavior: "smooth", block: "start" });
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
 * True once the player has departed via "Seek the Elden Ring". Permanently
 * disarms the roundtable gate so later free scrolling is never re-blocked.
 */
let seekDeparted = false;

/** True while scrolling is frozen at the hold. */
let roundtableFrozen = false;

/**
 * Sidebar-navigation bypass. The sidebar is a jump tool, so a dot click is
 * allowed to scroll past the hold even though manual scrolling cannot. These
 * only affect the programmatic sidebar scroll — manual scrolling is untouched.
 */
let navigating = false;      // a sidebar scroll is in flight → don't let the gate re-freeze it
let passingErdtree = false;  // sidebar scroll is passing the narration → don't auto-start it
let _navSettleTimer = null;
/** Clear the bypass flags once the programmatic scroll has actually settled
 *  (robust for long scrolls — not a fixed timeout racing the animation). */
function clearNavOnSettle() {
  if (_navSettleTimer) clearTimeout(_navSettleTimer);
  _navSettleTimer = setTimeout(() => { navigating = false; passingErdtree = false; }, 160);
}

/** Scroll Y where the roundtable section begins (recomputed for layout shifts). */
function roundtableTopY() {
  const el = document.getElementById("roundtable");
  return el ? el.offsetTop : Infinity;
}

/**
 * Pin the page at the Roundtable Hold and freeze scrolling until the player
 * departs via "Seek the Elden Ring".
 *
 * overflow:hidden removes the scrollport entirely, so a fast flick (or keyboard
 * jump) simply lands on the hold instead of blowing past it, and there is no
 * momentum left to bounce/stutter against. The wheel/touch blockers are a
 * backstop for inertial gestures the overflow lock might not catch. The freeze
 * is held until departure — it is deliberately NOT released by scrolling, since
 * a stray gesture releasing it was exactly what let fast scrolls slip through.
 */
function freezeAtRoundtable() {
  if (roundtableFrozen || seekDeparted) return;
  roundtableFrozen = true;
  roundtableScrollLocked = true;
  window.scrollTo(0, roundtableTopY());
  document.body.style.overflow = "hidden";
}

// Freeze the instant the viewport reaches the roundtable.
window.addEventListener("scroll", () => {
  // A sidebar jump is allowed through — keep deferring the freeze until it settles.
  if (navigating) { clearNavOnSettle(); return; }
  if (seekDeparted || roundtableFrozen) return;
  if (window.scrollY >= roundtableTopY() - 1) freezeAtRoundtable();
}, { passive: true });

// Backstop: swallow scroll gestures entirely while frozen.
const blockWhileFrozen = e => { if (roundtableFrozen && !seekDeparted) e.preventDefault(); };
window.addEventListener("wheel", blockWhileFrozen, { passive: false });
window.addEventListener("touchmove", blockWhileFrozen, { passive: false });

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
          seekDeparted = true;
          roundtableScrollLocked = false;
          roundtableFrozen = false;
          document.body.style.overflow = "";
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
        seekDeparted = true;
        roundtableScrollLocked = false;
        roundtableFrozen = false;
        document.body.style.overflow = "";
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

    // Lost-grace easter egg — touching the Site of Grace plays the chime and
    // flashes the "Lost grace discovered" banner.
    const graceZone = document.getElementById("rt-zone-grace");
    const lostGrace = document.getElementById("lost-grace");
    if (graceZone && lostGrace) {
      let graceTimer = null;
      graceZone.addEventListener("click", () => {
        this.#audio.playSfxSimultaneous(["audio/sfx/lost-grace.mp3"], 0.85);
        lostGrace.classList.add("lost-grace--visible");
        clearTimeout(graceTimer);
        graceTimer = setTimeout(() => lostGrace.classList.remove("lost-grace--visible"), 2800);
      });
    }

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

  /**
   * Headphones gate — shown on load. The page is frozen (no scrolling) until the
   * player presses Continue, then it unfreezes. Pressing Continue is also the
   * first user gesture, which unlocks audio.
   */
  #initIntroModal() {
    const modal  = /** @type {HTMLElement|null} */ (document.getElementById("intro-modal"));
    const enterBtn = document.getElementById("intro-modal-enter");
    if (!modal || !enterBtn) return;

    // Freeze immediately so nothing scrolls before the player continues.
    document.body.style.overflow = "hidden";
    modal.hidden = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => modal.classList.add("intro-modal--visible"));
    });

    const dismiss = () => {
      document.body.style.overflow = "";        // unfreeze
      modal.classList.remove("intro-modal--visible");
      modal.addEventListener("transitionend", () => { modal.hidden = true; }, { once: true });
    };

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
