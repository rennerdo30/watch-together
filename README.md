# Watch Together

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-Ready-blue?logo=docker)](docker-compose.yml)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688?logo=fastapi)](https://fastapi.tiangolo.com/)
[![CI](https://github.com/rennerdo30/watch-together/actions/workflows/ci.yml/badge.svg)](https://github.com/rennerdo30/watch-together/actions/workflows/ci.yml)
[![CodeQL](https://github.com/rennerdo30/watch-together/actions/workflows/codeql.yml/badge.svg)](https://github.com/rennerdo30/watch-together/actions/workflows/codeql.yml)

A real-time video synchronization platform for watching YouTube, Twitch, and 1800+ other sites together. Built with Next.js 16, FastAPI, and yt-dlp.

## Features

- **Universal Video Support**: Uses `yt-dlp` to resolve streams from YouTube, Twitch, Vimeo, Dailymotion, and 1800+ other sites
- **Real-time Synchronization**: Sub-second accurate sync via WebSockets with intelligent drift correction
- **DASH/HLS Streaming**: Separate video/audio streams with quality selection up to 4K
- **Segment Caching & Prefetch**: Position-aware bucket cache on disk plus an in-memory LRU for hot segments, with look-ahead prefetching of upcoming video/audio segments
- **Livestream Chat**: On-demand chat panel with Twitch, YouTube, Kick and Owncast adapters. Other providers can use a custom HTTPS chat embed URL or open the original stream. Custom URLs stay with that stream in the current browser tab. Chat updates live independently of the buffered video; provider sign-in and embedding restrictions still apply.
- **Room System**: Create custom rooms with persistent queue and playback state, showing who added each video
- **Seek Preview**: Hovering the timeline shows the frame under the pointer (YouTube storyboards)
- **SponsorBlock**: Community-marked sponsor, self-promotion and reminder segments in YouTube videos are skipped for the whole room at once (the server seeks everyone), shown on the seek bar, and chosen per room by its admin
- **Cookie Authentication**: Bypass age-restrictions and regional blocks with your own cookies
- **YouTube Watch History (opt-in)**: While the extension is syncing your cookies, videos the room watches can be recorded in your own YouTube history with the position you stopped at, the way YouTube's player reports it. Off until you switch it on in the settings dialog
- **Browser Extension**: Automatic cookie sync from your browser (Chrome/Firefox)
- **Audio Normalization**: "Night mode" audio with configurable gain boost
- **Client-side Video Enhancement (Beta)**: Opt-in local upscaling with automatic animation/live-action selection, WebGPU neural processing and a lightweight WebGL fallback. Open player settings → Video enhancement. [Compatibility and implementation details](frontend/lib/upscaling/README.md).
- **Modern UI**: Light and dark colour schemes (following the OS by default), six accent themes plus a custom one, drag-and-drop queue management
- **Cloudflare Integration**: Zero Trust authentication and tunnel support

## Quick Start

### Prerequisites
- Docker & Docker Compose
- (Optional) Cloudflare account for Zero Trust access

### Deploy with Docker

```bash
# Clone the repository
git clone https://github.com/rennerdo30/watch-together.git
cd watch-together

# Copy environment template
cp .env.example .env

# Start all services
docker compose up -d --build
```

The application will be available at `http://localhost:80` (via nginx proxy).

### Local Development

```bash
# Backend (Python 3.11+)
cd backend
python -m venv venv
source venv/bin/activate  # or `venv\Scripts\activate` on Windows
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# Frontend (Node.js 20+) - in a new terminal
cd frontend
npm ci
npm run dev
```

- Frontend: http://localhost:3000
- Backend API: http://localhost:8000
- API Docs: http://localhost:8000/docs

### Configuration

The only variable in `.env.example` is `TUNNEL_TOKEN`, used by the optional
Cloudflare Tunnel container. Leave it unset to run without a tunnel.

Backend tunables (cache sizes, TTLs, prefetch depth) are constants in
`backend/core/config.py` rather than environment variables — cache is capped at
200 MB on disk with a 100 MB in-memory LRU by default.

### Tests

```bash
# Backend (from the repo root)
pip install -r backend/requirements.txt
pip install pytest pytest-asyncio httpx
python -m pytest -v backend/tests

# Frontend
npm run --prefix frontend lint
npm run --prefix frontend build
```

CI runs exactly these, plus manifest/syntax checks on the browser extension.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     User Browser                             │
└─────────────────────────┬───────────────────────────────────┘
                          │ HTTPS
┌─────────────────────────▼───────────────────────────────────┐
│              Cloudflare Tunnel (Optional)                    │
└─────────────────────────┬───────────────────────────────────┘
                          │ HTTP
┌─────────────────────────▼───────────────────────────────────┐
│                    Nginx Reverse Proxy                       │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────┐  │
│  │  /api/*     │    │   /ws/*     │    │      /*         │  │
│  │  /api/proxy │    │  WebSocket  │    │   Static/SSR    │  │
│  └──────┬──────┘    └──────┬──────┘    └────────┬────────┘  │
└─────────┼──────────────────┼───────────────────┼────────────┘
          │                  │                   │
┌─────────▼──────────────────▼───────┐  ┌───────▼─────────────┐
│         FastAPI Backend            │  │   Next.js Frontend  │
│  • yt-dlp video resolution         │  │   • React 19        │
│  • WebSocket room sync             │  │   • TailwindCSS 4   │
│  • HLS/DASH proxy                  │  │   • hls.js player   │
│  • Cookie management               │  │   • Light/dark UI   │
└────────────────────────────────────┘  └─────────────────────┘
```

## Cookie Authentication

Most videos only play from a server with a signed-in session. Cookies reach
the server one way only: through the browser extension.

1. Install the extension — Settings (gear icon) in any room offers a download
   for Chrome/Edge and Firefox, packaged by the instance itself; the
   [Nightly release](../../releases/tag/nightly) carries the same builds
2. Log in to YouTube, Twitch or Kick in your browser
3. Open your Watch Together instance while signed in, then connect it from the
   extension popup
4. The extension syncs your cookies every ten minutes while the browser is
   open, and again whenever you open the instance

> **Cookies are never stored.** The server keeps them in memory only, drops
> them half an hour after the last sync or as soon as you disconnect the
> extension, and never writes them to disk or its database. While you are in a
> room, YouTube, Twitch and Kick links other members paste can be resolved with
> your session — single videos only, never your feeds, playlists or history.
> Members without the extension are told about it once, above the URL box.

## Project Structure

```
watch-together/
├── backend/                    # FastAPI Python backend
│   ├── main.py                # App init, streaming proxy, WebSocket entrypoint
│   ├── connection_manager.py  # WebSocket room management
│   ├── api/routes/            # rooms, cookies, tokens, extension routers
│   ├── core/                  # config constants, security helpers
│   ├── services/              # resolver, cache, prefetcher, database
│   └── tests/                 # pytest suite
├── frontend/               # Next.js React frontend
│   ├── app/               # App router pages
│   ├── components/        # React components
│   │   ├── custom-player.tsx  # Video player
│   │   └── player/hooks/      # Player hooks
│   ├── lib/               # Utilities, API client, themes, constants
│   └── README.md          # Frontend structure, theming and storage keys
├── extension/             # Browser extension for cookie sync
├── nginx/                 # Nginx configuration
├── docker-compose.yml     # Container orchestration
├── CONTRIBUTING.md        # Contribution guidelines
├── DEPLOYMENT.md          # Deployment guide
├── SECURITY.md            # Security policy
└── SUPPORT.md             # Support policy
```

## Documentation

- [DEPLOYMENT.md](DEPLOYMENT.md) - Detailed deployment guide
- [CONTRIBUTING.md](CONTRIBUTING.md) - Development guidelines
- [SPECIFICATION.md](SPECIFICATION.md) - Technical specification
- [CHANGELOG.md](CHANGELOG.md) - Version history
- [ISSUES.md](ISSUES.md) - Known issues and roadmap
- [frontend/README.md](frontend/README.md) - Frontend structure, theming and scripts
- [SECURITY.md](SECURITY.md) - Responsible vulnerability disclosure
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) - Community standards
- [SUPPORT.md](SUPPORT.md) - Support channels and expectations

## Tech Stack

| Component | Technology |
|-----------|------------|
| Frontend | Next.js 16, React 19, TypeScript, TailwindCSS 4 |
| Backend | FastAPI, Python 3.11+, yt-dlp, aiosqlite |
| Player | hls.js, custom DASH sync hooks |
| Real-time | WebSockets |
| Proxy | Nginx |
| Container | Docker Compose |
| Auth | Cloudflare Zero Trust (optional) |

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
