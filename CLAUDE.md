# CLAUDE.md - Watch Together Project Context

## Project Overview

Watch Together is a real-time collaborative video synchronization platform that enables multiple users to watch YouTube, Twitch, and 1800+ other sites simultaneously. It uses WebSocket-based synchronization with sub-second accuracy.

## Tech Stack

### Backend (Python 3.11+)
- **Framework:** FastAPI with Uvicorn
- **Real-time:** WebSockets for room synchronization
- **Video Resolution:** yt-dlp with bgutil-ytdlp-pot-provider for PO tokens
- **Database:** SQLite via aiosqlite
- **Caching:** In-memory LRU cache + disk caching for segments

### Frontend (TypeScript/React)
- **Framework:** Next.js 16 with App Router
- **React:** 19.x
- **Styling:** TailwindCSS 4
- **Video:** hls.js for HLS/DASH streaming
- **State:** Custom hooks with WebSocket sync

### Infrastructure
- Docker Compose orchestration
- Nginx reverse proxy
- Cloudflare Tunnel for external access

## Project Structure

```
backend/
├── main.py                    # FastAPI app, core endpoints, proxy
├── connection_manager.py      # WebSocket room management
├── services/
│   ├── resolver.py           # yt-dlp video resolution
│   ├── database.py           # SQLite persistence
│   ├── cache.py              # Caching & disk management
│   ├── upstream.py           # SSRF-safe fetching: validation, IP pinning, redirects
│   ├── user_cookies.py       # Per-user cookie lookup for upstream requests
│   ├── manifest.py           # DASH manifest generation for adaptive streams
│   ├── mp4_index.py          # Fragmented-MP4 box scanning (init/index ranges)
│   ├── metrics.py            # Per-transfer proxy metrics
│   └── prefetcher.py         # Segment prefetching
├── api/routes/               # REST endpoints
├── core/                     # Config, security, Access JWT, rate limiting
└── tests/                    # pytest suite (200+ tests)

frontend/
├── app/                      # Next.js app router pages
├── components/
│   ├── custom-player.tsx     # Main video player (MSE / legacy DASH / HLS)
│   ├── player-controls.tsx   # Playback controls UI
│   └── room/                 # Room-specific components
└── lib/
    ├── api.ts               # Backend API client
    └── hooks/               # Custom React hooks (useRoomSync, etc.)
```

## Key Files to Know

| File | Responsibility |
|------|----------------|
| `backend/main.py` | API endpoints, proxy logic, app initialization |
| `backend/connection_manager.py` | All WebSocket/room state logic |
| `backend/services/resolver.py` | yt-dlp integration, format selection |
| `frontend/components/custom-player.tsx` | Video player wrapper |
| `frontend/lib/hooks/useRoomSync.ts` | Client-side sync logic |

## Development Commands

```bash
# Backend (port 8000)
cd backend && uvicorn main:app --reload --port 8000

# Frontend (port 3000)
cd frontend && npm run dev

# Docker (production)
docker compose up -d --build
```

## Architecture Patterns

### Synchronization Strategy
1. Server sends heartbeat every 5 seconds with authoritative timestamp
2. Clients measure network latency via ping/pong
3. Drift <3s: playbackRate adjustment (1.05x/0.95x)
4. Drift >3s: hard seek to correct position

### Video Resolution Flow
1. Client requests `/api/resolve?url=...`
2. Backend tries cookie sources: user's cookies → shared user's cookies → no cookies
3. Returns HLS/DASH manifest URL or direct stream
4. Manifests are rewritten to proxy all segments through `/api/proxy`

### Playback Engines
yt-dlp returns adaptive streams as **separate** fragmented-MP4 files with no manifest.
Two engines consume them, chosen by `NEXT_PUBLIC_STREAM_ENGINE`:
- `mse` — `/api/dash-manifest` generates a real DASH manifest (byte ranges found by
  scanning each file's box headers) and Shaka plays it through **one** `<video>`, so the
  browser muxes A/V against a single clock.
- `legacy` (default) — separate `<video>` + `<audio>` kept in step by `useDashSync`.
  Being retired: two media elements cannot be kept frame-accurate.

### Security Model
- Identity comes from the **verified** `Cf-Access-Jwt-Assertion` JWT
  (`CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD`). The plain email header is only trusted
  when Access is unconfigured — it is forgeable by anyone reaching the origin directly.
- All upstream fetches go through `services/upstream.py`: every host validated, the
  validated IP pinned for the connection, every redirect hop re-validated.
- Cookies are per user and per request; any response fetched with cookies is cached
  under a key including the user's identity.
- **Single worker only.** Room state, caches and the rate limiter are in process memory;
  startup refuses `WEB_CONCURRENCY > 1`.

### Caching Strategy
- **Manifests:** 30-min in-memory LRU cache
- **Formats:** 2-hour in-memory LRU cache
- **Segments:** Position-aware 10MB bucket caching for DASH

## Code Style Guidelines

### Backend (Python)
- Use async/await for all I/O operations
- Type hints on all function signatures
- Pydantic models for request/response validation
- Error handling: return appropriate HTTP status codes

### Frontend (TypeScript)
- Strict TypeScript mode enabled
- React hooks for state management
- TailwindCSS for styling (no CSS modules)
- ESLint enforced

## Common Tasks

### Adding a New API Endpoint
1. Add route in `backend/api/routes/` or `backend/main.py`
2. Define Pydantic models for request/response
3. Register route in FastAPI app
4. Add corresponding API call in `frontend/lib/api.ts`

### Adding a New WebSocket Message Type
1. Define handler in `backend/connection_manager.py`
2. Add message type to switch/case in `handle_message()`
3. Update `frontend/lib/hooks/useRoomSync.ts` to send/receive

### Modifying Video Player Behavior
1. Main logic is in `frontend/components/custom-player.tsx`
2. Sync logic is in `frontend/lib/hooks/useRoomSync.ts`
3. UI controls are in `frontend/components/player-controls.tsx`

## Git Commit Policy

**IMPORTANT:** Make git commits proactively when you see fit, following these rules:

1. **Only commit when code compiles and is functional**
   - Frontend: Run `npm run build` in `/frontend` - must pass
   - Backend: Run `python -m py_compile <files>` - must pass

2. **When to commit:**
   - After completing a logical unit of work (bug fix, feature, refactor)
   - After fixing multiple related issues
   - Before starting a different type of task
   - When the codebase is in a stable, working state

3. **Commit message format:**
   - Use conventional commits style (fix:, feat:, refactor:, docs:, etc.)
   - Be concise but descriptive
   - Reference issue numbers if applicable

4. **Verification before committing:**
   ```bash
   # Frontend
   cd frontend && npm run build

   # Backend
   cd backend && python -m py_compile main.py connection_manager.py services/*.py
   ```

5. **Do NOT commit if:**
   - Build fails
   - Syntax errors exist
   - Changes are incomplete/partial
   - The files are review/analysis files (code reviews, reports, etc.)
   - The files are debug files, temporary logs, or investigation notes

## Testing

```bash
# Backend tests (200+; use a temporary data dir, safe to run anytime)
cd backend && pytest

# End-to-end: two-client room sync, plus MSE playback in a real browser.
# Starts both servers itself.
cd frontend && npm run test:e2e

# Frontend type checking and lint
cd frontend && npm run build && npm run lint
```

Tests run against a temporary database and cookie directory (see
`backend/tests/conftest.py`), so they neither depend on nor pollute `backend/data/`.

## Important Notes

- Room state persists for 5 minutes after last user leaves
- User cookies are stored in `data/cookies/{email}.txt` (Netscape format, mode 0600)
- Room IDs are sanitized to alphanumeric + hyphen/underscore only
- The proxy rewrites manifest URLs to avoid CORS issues
- yt-dlp requires Node.js runtime for JavaScript challenge execution

## Documentation

- `SPECIFICATION.md` - Full technical specification
- `CONTRIBUTING.md` - Development guidelines
- `DEPLOYMENT.md` - Deployment instructions
- `CHANGELOG.md` - Version history
- `ISSUES.md` - Known issues and roadmap
