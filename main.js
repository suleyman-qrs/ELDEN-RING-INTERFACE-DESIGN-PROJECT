/* ======================================================
   ELDEN RING — scroll interactions & side nav
   ====================================================== */

const FRAME_COUNT = 13;

const els = {
  narrationWrapper: document.getElementById('narration-wrapper'),
  narrationTrack:   document.getElementById('narration-track'),
  sidenav:          document.getElementById('sidenav'),
  navDots:          document.querySelectorAll('.nav-dot'),
  nframes:          document.querySelectorAll('.nframe'),
  hero:             document.getElementById('s-hero'),
};

// Sections that map to side-nav dots (in order)
const navSections = [
  document.getElementById('s-intro'),
  document.getElementById('s-dialogue'),
  document.getElementById('narration-wrapper'),
  document.getElementById('s-game'),
  document.getElementById('s-about'),
  document.getElementById('s-footer'),
];

// All fade-in elements
const fadeEls = document.querySelectorAll('.section:not(.hero), .link-to-game, .about-miyazaki');

let activeFrame = 0;
let ticking = false;

/* ── Helpers ───────────────────────────────────────── */

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function getOffsetTop(el) {
  let top = 0;
  while (el) {
    top += el.offsetTop;
    el = el.offsetParent;
  }
  return top;
}

/* ── Main scroll handler ───────────────────────────── */

function onScroll() {
  const scrollY = window.scrollY;
  const vh      = window.innerHeight;

  // Show side nav after hero
  const heroBottom = els.hero.offsetTop + els.hero.offsetHeight;
  els.sidenav.classList.toggle('visible', scrollY > heroBottom * 0.7);

  // Update active nav dot
  let activeIdx = 0;
  for (let i = 0; i < navSections.length; i++) {
    const s = navSections[i];
    if (s && scrollY >= getOffsetTop(s) - vh * 0.5) {
      activeIdx = i;
    }
  }
  els.navDots.forEach((dot, i) => dot.classList.toggle('active', i === activeIdx));

  // Horizontal narration scroll
  if (els.narrationWrapper) {
    const wTop   = getOffsetTop(els.narrationWrapper);
    const wH     = els.narrationWrapper.offsetHeight;
    const scroll = wH - vh;
    const progress = clamp((scrollY - wTop) / scroll, 0, 1);
    const tx = progress * (FRAME_COUNT - 1) * window.innerWidth;

    els.narrationTrack.style.transform = `translateX(-${tx}px)`;

    const frameIdx = Math.round(progress * (FRAME_COUNT - 1));
    if (frameIdx !== activeFrame) {
      els.nframes[activeFrame]?.classList.remove('active');
      els.nframes[frameIdx]?.classList.add('active');
      activeFrame = frameIdx;
    }
  }

  // Section fade-in
  fadeEls.forEach(el => {
    const rect = el.getBoundingClientRect();
    if (rect.top < vh * 0.88) {
      el.classList.add('visible');
    }
  });
}

/* ── RAF-throttled scroll listener ────────────────── */

window.addEventListener('scroll', () => {
  if (!ticking) {
    requestAnimationFrame(() => {
      onScroll();
      ticking = false;
    });
    ticking = true;
  }
}, { passive: true });

/* ── Nav dot click → scroll to section ────────────── */

els.navDots.forEach((dot, i) => {
  dot.addEventListener('click', () => {
    const target = navSections[i];
    if (!target) return;

    // For narration, scroll to the wrapper top
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

/* ── Dialogue choice helpers ───────────────────────── */

function scrollToNarration() {
  els.narrationWrapper?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function scrollToGame() {
  document.getElementById('s-game')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ── Init ──────────────────────────────────────────── */

// Activate first narration frame immediately
els.nframes[0]?.classList.add('active');

// Run once on load to set initial state
onScroll();
