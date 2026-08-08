# Watch Together — frontend

Next.js 16 (App Router) client for Watch Together. It renders the landing page,
the synchronized room, and the custom HLS/DASH player, and talks to the FastAPI
backend over `/api/*` (REST) and `/ws/<room>` (WebSocket).

See the [repository README](../README.md) for the full stack and Docker setup.

## Requirements

- Node.js 20 or newer (the container image builds on `node:25-alpine`)
- A running backend, or the nginx proxy from `docker-compose.yml`, so that
  `/api/*` and `/ws/*` resolve

## Scripts

| Command | What it does |
|---------|--------------|
| `npm ci` | Install exactly the versions in `package-lock.json` |
| `npm run dev` | Start the dev server on http://localhost:3000 |
| `npm run build` | Production build (`output: "standalone"`) |
| `npm start` | Serve a build — for the standalone output use `node .next/standalone/server.js` |
| `npm run lint` | ESLint (flat config in `eslint.config.mjs`) |
| `npx tsc --noEmit` | Type-check without emitting |

The browser calls relative URLs, so run the dev server behind the nginx service
from `docker-compose.yml`, or set `BACKEND_URL` for server-side calls.

## Layout

```
app/
  layout.tsx          Root layout; inlines the colour-scheme bootstrap script
  page.tsx            Landing page: create a room, browse active rooms
  globals.css         Design tokens, light/dark schemes, base styles
  room/[id]/page.tsx  Room shell: WebSocket sync, queue, audience, settings
components/
  custom-player.tsx        Video stage (HLS via hls.js, DASH via separate A/V tracks)
  player-controls.tsx      Player chrome: seek, volume, quality, stats, fullscreen
  player/hooks/            useHlsPlayer, useDashPlayer, useDashSync, useAudioNormalization
  sortable-queue-item.tsx  Drag-and-drop queue row (@dnd-kit)
  color-mode-toggle.tsx    Light / dark / system switch
  error-boundary.tsx       Isolates player crashes from the rest of the room
lib/
  api.ts              Typed fetch wrappers for the backend REST API
  color-mode.ts       Colour-scheme preference storage and application
  constants.ts        Shared constants (poll intervals, sidebar bounds, links)
  themes.ts           Accent themes and the custom-theme helpers
```

## Styling and theming

Tailwind CSS v4 is configured entirely in `app/globals.css` — there is no
`tailwind.config`. Two independent axes control the look:

- **Colour scheme** (light / dark / system). Stored under `wt_color_mode` and
  applied as `data-theme` on `<html>` by a blocking inline script in
  `app/layout.tsx`, so the right scheme is painted on the first frame. Tailwind
  v4 compiles colour utilities to `var(--color-*)` lookups, so the scheme is
  switched by re-pointing those variables instead of annotating class names.
  Surfaces that stay dark in every scheme — the video stage, the player chrome,
  queue thumbnails — opt out with the `on-dark` class.
- **Accent theme** (`lib/themes.ts`): Obsidian, Midnight, Forest, Rose, Solar,
  Mono, or a custom background/accent pair. Stored under `wt_theme` /
  `wt_custom_theme`.

Other conventions worth knowing:

- Text on a filled accent surface uses `on-accent-light` / `on-accent-dark`
  rather than `text-white` / `text-black`, because the accent itself does not
  flip with the colour scheme.
- Animations and transitions collapse under `prefers-reduced-motion: reduce`.
- Repeated numbers and URLs live in `lib/constants.ts` instead of inline.

## Client-side storage

Preferences are local to the browser; none of these keys are sent to the server.

| Key | Meaning |
|-----|---------|
| `wt_color_mode` | `system`, `light` or `dark` |
| `wt_theme` | Accent theme id, or `custom` |
| `wt_custom_theme` | Serialized custom accent theme |
| `wt_proxy` | Route streams through the backend proxy |
| `wt_font_size` | Queue and audience text size in px |
| `wt_sidebar_width` | Room sidebar width in px |
| `w2g-sync-threshold` | Drift in seconds before a hard resync |
| `w2g-player-normalization`, `w2g-player-normalization-gain` | Audio normalization |
