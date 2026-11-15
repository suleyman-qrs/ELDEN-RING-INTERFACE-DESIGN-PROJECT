# DESIGN.md — Elden Ring narrative experience

Phase 0 of the redesign: audit of what exists, the design direction, the token
system, and the step-by-step plan for redesigning the UI and refactoring the code.

Sources: `src/css/main.css` (1,999 lines), `src/components/*.html`, `src/js/main.js`
(1,766 lines), the Figma maquette ("Web 2026 — Maquette (Design)", page `13:131`),
the Figma Slides deck, and the running site at 1440×900 and 375×812.

---

## 1. Visual audit (ecc:design-system, audit mode)

| # | Dimension | Score | Evidence | Fix (phase) |
|---|-----------|:-----:|----------|-------------|
| 1 | Color consistency | 5 | Tokens exist in `:root` (`main.css:38-60`) but ~45 distinct raw `rgba()` literals bypass them; 84 `opacity` declarations are used as an ad-hoc color system. | Solid tonal tokens, no opacity-as-color (P1) |
| 2 | Typography hierarchy | 4 | 26 distinct `font-size` clamps. `--font-serif` names **Agmena Pro**, which is never loaded → every body line silently renders in Palatino/Georgia. Footer and audio controls switch to Helvetica (`--font-sans`), breaking the voice. 10 different `letter-spacing` values (0.02em → 0.55em). | 6-step fluid scale, self-hosted text serif, no sans (P1) |
| 3 | Spacing rhythm | 4 | 54 distinct padding/margin/gap values, none on a scale. | 4px-based scale (P1) |
| 4 | Component consistency | 4 | Five unrelated button styles: intro "Continue" (text link), tutorial "Understood" (bordered), CTA rows (stacked gold box with arrows), NPC topics (list rows), seek-confirm (two-button). 10 copies of `border: 1px solid var(--gold-border)` boxes. | One button family + one panel language (P3) |
| 5 | Responsive | 3 | Single breakpoint (`main.css:1875`). On 375px: Sound panel overlaps footer copy and the Roundtable "Approach" hint; portrait crop hides the NPCs in Roundtable Hold; 23 hard `<br>` tags in copy produce ragged lines. | HUD safe-areas, art-directed crops, remove `<br>` (P2, P4) |
| 6 | Dark mode | n/a | Dark-only by intent — correct for the subject. Keep it that way; no light theme. | — |
| 7 | Animation | 6 | Embers, narration and fades are purposeful, but there is **no `prefers-reduced-motion` handling** anywhere (CSS or JS). 17 `setTimeout` chains drive sequencing. | Motion tokens + reduced-motion path (P5) |
| 8 | Accessibility | 3 | Effective contrast (color × opacity on `#0f0f0f`): footer copy ≈ 2.4:1, footer bar ≈ 2.4:1, "scroll to continue" 11px at 35% opacity. Labels at 11px. `:focus-visible` defined on only 2 selectors (`main.css:730`, `:1996`). | ≥ 4.5:1 text, 13px floor, focus ring on every control (P2) |
| 9 | Information density | 7 | Calm, one idea per screen — this is the site's strength. | Keep |
| 10 | Polish | 5 | Reloading mid-page stacks the headphones modal on top of the "Guidance of Grace" tutorial (seen live). Copy typos in footer ("doesn't belongs"). | Fix state ordering (P2) |

**Overall: 41 / 90** (dark mode excluded).

### AI-slop / template check

The site is not generic SaaS slop: the subject matter and assets carry it. The patterns that
*do* read as "AI fantasy template" are:

- **Gold-bordered boxes everywhere.** Tutorial, intro modal, NPC dialogs, seek-confirm, CTA — all the same 1px gold rectangle. The game itself never boxes its UI this way; it uses dark horizontal bands with hairlines that fade out at the ends.
- **Glow on everything.** `--glow-sm/--glow-lg` and 10 `text-shadow`s make gold mean nothing. When everything glows, nothing is grace.
- **Tracked-caps overuse.** 0.42–0.55em tracking on many small labels — decorative, and it hurts legibility at 11px.
- **Diamond bullet checkboxes** (audio controls) and **stacked CTA list with arrows** — neither is in the Figma maquette; both are generic "game UI" tropes.
- **Sans-serif footer** — a stock Helvetica block at the end of a manuscript-voiced experience.

---

## 2. Design direction (ecc:frontend-design-direction)

- **Purpose:** a guided, audio-led tribute — the user *listens and is led*, they don't browse.
- **Audience:** one-time visitors (classmates, jury, fans) on desktop with headphones; mobile must not break.
- **Tone:** *hushed, ceremonial, editorial.* Text behaves like subtitles and manuscript, never like a web page.
- **Memorable detail — "the band":** every overlay (intro, tutorial, NPC dialogue, seek-confirm, subtitles) uses one
  shape: a dark horizontal band whose top and bottom hairlines fade out at both ends — the in-game menu grammar.
  No boxes, no rounded corners, no cards.
- **The gold rule:** gold means *you can touch this* or *grace is present*. Text is parchment, never gold.
  Glow is allowed in exactly two places: the hero title and "Lost Grace Discovered".
- **Constraints:** Parcel + posthtml-include, no framework, no new runtime dependencies. Static hosting.

Follow the Figma maquette for layout and copy (hero "Hidetaka Miyazaki's / ELDEN RING", three inline framed platform
buttons bottom-right, about bio without forced line breaks, footer with logo image and Eikon project copy).

---

## 3. Tokens

Canonical values live in `src/css/tokens.css` (committed). `design/design-tokens.json` and
`design/design-preview.html` are local working files — `design/` is git-ignored, so they never reach the repo.

### Color — tonal, solid values (no opacity-as-color)

| Token | Value | Use | Contrast on `#000` / `#0f0f0f` |
|-------|-------|-----|----|
| `--ink-0` | `#000000` | page | — |
| `--ink-1` | `#0a0907` | band panels (warm black) | — |
| `--ink-2` | `#0f0f0f` | footer (Figma "dark gray") | — |
| `--parchment` | `#f0e2c0` | primary text | 16.3 / 14.9 |
| `--parchment-2` | `#c9bc9c` | secondary text, body on images | 11.2 / 10.2 |
| `--parchment-3` | `#9a9078` | labels, captions, footer | 6.6 / 6.1 |
| `--gold` | `#c8a434` | interactive at rest, hairlines | 8.8 / 8.1 |
| `--gold-bright` | `#e2bc50` | hover / focus / active | 11.5 / 10.5 |
| `--rune` | `#d0604a` | warning text ("Grace Beckons"), rare | 5.4 / 5.0 |
| `--hair` | `rgba(200,164,52,.45)` | the only translucent token — band hairlines | — |

### Type

- `--font-display`: Optimus Princeps → Palatino → serif (titles, names, caps labels)
- `--font-text`: **EB Garamond** (OFL, self-hosted woff2) → Palatino → serif — replaces the never-loaded Agmena Pro. *Confirm against the Figma body font.*
- No sans-serif anywhere.

| Step | Size (min → max) | Use |
|------|------|-----|
| `--step--1` | 13 → 14px | caps labels, captions (floor — nothing smaller) |
| `--step-0` | 16 → 18px | body, NPC topics, buttons |
| `--step-1` | 20 → 24px | subtitles, prologue lines |
| `--step-2` | 24 → 32px | NPC names, section lines |
| `--step-3` | 32 → 48px | CTA question |
| `--step-4` | 56 → 128px | hero title |

Tracking: `--track-caps: .32em` (display caps only), `--track-label: .12em`, body `0`.
Leading: display 1.1, text 1.6.

### Space — 4px base

`--space-1 4` · `-2 8` · `-3 12` · `-4 16` · `-5 24` · `-6 32` · `-7 48` · `-8 64` · `-9 96` · `-10 128`

### Motion

`--dur-quick 120ms` (hover) · `--dur-base 240ms` (UI state) · `--dur-slow 600ms` (fades) · `--dur-scene 1200ms` (scene changes)
`--ease-out: cubic-bezier(.22,1,.36,1)` · `--ease-grace: cubic-bezier(.65,0,.35,1)`
Under `prefers-reduced-motion: reduce`: durations collapse to ~0, embers and Ken-Burns zooms stop, narration still plays.

### Layers (page-level, fixed elements only)

`--z-stage 10` (narration stage) · `--z-modal 200` (intro modal) · `--z-hud 300` (sidenav, sound) · `--z-fade 500` (chapter fade) · `--z-grace 600` (Lost Grace banner)

These keep today's values. Local stacking inside a section (1–15) stays as plain numbers. NPC dialogs use the native
`<dialog>` top layer and need no z-index. Phase 2 lifts `--z-modal` above `--z-hud` so the HUD can't sit over the modal.

### Shape

Radius `0` everywhere. The only circles are the sidenav ticks.

---

## 4. Components

- **Band** — `.band`: full-bleed or ≤ 720px strip; `background: linear-gradient(90deg, transparent, var(--ink-1) 12% 88%, transparent)`; `::before/::after` hairlines with the same fade. Used by intro modal, tutorial, NPC dialog, seek-confirm, subtitles.
- **Button** — one `.btn` base: display serif, `--step-0`, parchment text, ≥ 44px hit area, gold underline that draws in on hover/focus.
  - `.btn--framed`: 1px `--parchment-3` frame, gold on hover (Figma platform buttons).
  - `.btn--quiet`: `--parchment-3`, for Leave / Stay a while.
- **Label** — `.label`: display caps, `--step--1`, `--track-label`, `--parchment-3`.
- **Focus** — every interactive element: `outline: 1px solid var(--gold-bright); outline-offset: 4px`.
- **HUD** — sidenav + sound control share one safe area and hide while a band or the footer is on screen.

---

## 5. Step-by-step plan

Each phase is one commit, verified with before/after screenshots at 1440 and 375 before starting the next.

| Phase | Scope | Skills / agents |
|-------|-------|-----------------|
| **0 — Audit & direction** ✅ | This document, tokens, preview | `ecc:design-system`, `ecc:frontend-design-direction` |
| **1 — Foundations (no visual change)** ✅ | `main.css` → `@import` list of `tokens.css`, `base/`, `sections/`, `components/` (contiguous slices, original cascade order; the one `@media` block moved into the files it styles). Full token set added; `--black`/`--cream` renamed to `--ink-0`/`--parchment`; page-level z-index tokenised. Verified: 219/219 rules identical, 0 computed-style differences on all 277 elements at 1024px and 375px, production build OK. *Deferred:* self-hosting EB Garamond (changes the look — waits on open question 1) and swapping translucent rgba for solid tones (changes contrast — Phase 2). | `ecc:design-system`, `ecc:inherit-legacy-style` |
| **2 — Bugs & accessibility** | Modal/tutorial stacking on reload; HUD collisions on mobile; contrast to ≥ 4.5:1; 13px floor; focus-visible everywhere; remove `<br>` from copy; reduced-motion CSS. | `ecc:accessibility`, `ecc:frontend-a11y`, agent `ecc:a11y-architect` |
| **3 — Component language** | Band, button family, label; rebuild intro modal, tutorial, NPC dialog, seek-confirm, sound control, sidenav (Figma collapsed-tick variant). | `ecc:make-interfaces-feel-better`, `ecc:frontend-design-direction` checklist |
| **4 — Sections, one at a time** | Hero → Prologue → Roundtable (mobile art-direction) → Narration subtitles → CTA (Figma inline buttons) → About (Figma copy) → Footer (logo + Figma copy). | `figma:figma-design-to-code` per frame, `design:design-critique` |
| **5 — Motion** | Apply motion tokens; one easing family; reduced-motion JS path (embers, zooms). | `ecc:motion-foundations`, `ecc:motion-patterns` |
| **6 — JS refactor** | Split `main.js` into ES modules (`audio/`, `scenes/`, `roundtable/`, `ui/`); replace module-level flags (`roundtableFrozen`, `navigating`, `passingErdtree`, `seekDeparted`) with one small state object; `AbortController` for the 43 listeners (only 1 is ever removed); promise-based sequencing instead of 17 `setTimeout` chains. | agents `ecc:code-architect`, `ecc:code-simplifier`, `ecc:silent-failure-hunter`, `ecc:typescript-reviewer` |
| **7 — QA** | Lighthouse, axe, three breakpoints, full narration run-through. | `ecc:browser-qa`, agent `ecc:e2e-runner`, agent `ecc:code-reviewer` |

### Open questions

1. Figma body font — confirm it's a Garamond before self-hosting EB Garamond.
2. Copy: adopt the Figma bio and footer text (they differ from the site)? Figma dialogue frame has a typo ("Would like me to tell you…").
3. CTA placement: Figma puts the platform buttons bottom-right; the site centers them. Plan follows Figma.
