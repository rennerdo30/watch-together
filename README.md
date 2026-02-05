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
- **Room System**: Create custom rooms with persistent queue and playback state
- **Cookie Authentication**: Bypass age-restrictions and regional blocks with your own cookies
- **Browser Extension**: Automatic cookie sync from your browser (Chrome/Firefox)
- **Audio Normalization**: "Night mode" audio with configurable gain boost
- **Modern UI**: Dark theme with TailwindCSS, drag-and-drop queue management
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
npm install --legacy-peer-deps
npm run dev
```

- Frontend: http://localhost:3000
- Backend API: http://localhost:8000
- API Docs: http://localhost:8000/docs

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
│  • Cookie management               │  │   • Custom hooks    │
└────────────────────────────────────┘  └─────────────────────┘
```

## Cookie Authentication

To watch age-restricted or region-locked content:

### Option 1: Browser Extension (Recommended)
1. Install the Watch Together extension from `/extension` folder
2. Log in to YouTube/Twitch in your browser
3. The extension automatically syncs cookies to the server

### Option 2: Manual Upload
1. Export cookies using [Get cookies.txt LOCALLY](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc)
2. Open Settings (gear icon) in any room
3. Paste Netscape-formatted cookies and save

> **Note:** Cookies are stored server-side and linked to your identity. Guest users cannot save cookies.

## Project Structure

```
watch-together/
├── backend/                 # FastAPI Python backend
│   ├── main.py             # API endpoints, proxy, app init
│   ├── connection_manager.py # WebSocket room management
│   └── services/           # Resolver, cache, database
├── frontend/               # Next.js React frontend
│   ├── app/               # App router pages
│   ├── components/        # React components
│   │   ├── custom-player.tsx  # Video player
│   │   └── player/hooks/      # Player hooks
│   └── lib/               # Utilities, API client
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
