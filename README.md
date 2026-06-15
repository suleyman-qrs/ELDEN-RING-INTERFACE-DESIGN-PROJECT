# Elden Ring — narrative experience

A single-page, audio-driven Elden Ring tribute (hero → biography → Roundtable Hold →
the Shattering narration → about → play CTA). Built with [Parcel](https://parceljs.org).

## Prerequisites

- [Node.js](https://nodejs.org) (v18+)
- npm

## Install

```
npm install
```

## Run (development)

One command — cleans the Parcel cache, links the `audio/` folder into the dev server,
then starts Parcel with hot reload:

```
npm run dev
```

Open the URL Parcel prints (usually <http://localhost:1234>).

## Build (production)

Outputs a static site to `dist/` (and copies `audio/` in alongside it):

```
npm run build
```

## Project layout

```
src/
  index.html         entry — pulls in the component partials below
  components/*.html  page sections (hero, roundtable, npc-dialogue, erdtree, …)
  js/main.js         all behaviour — one file, ~10 small classes
  css/main.css       all styling
  images/  video/    bundled visual assets
audio/               music / sfx / dialogue (see note below)
```

## Asset note (important)

`audio/` is **not** bundled by Parcel. The code references audio by string path
(e.g. `audio/dialogue/Elden Ring.mp3`), so the files are served as-is:

- `npm run dev` symlinks `audio/` into the dev server (`link-assets`).
- `npm run build` copies `audio/` into `dist/` (`copy-assets`).

Both `audio/` and `src/video/` must be present for the experience to play — keep
those folders in place. Scene videos live in `src/video/scenes/`.
