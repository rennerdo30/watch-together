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
├── connection_manager.py      # WebSocket room management (1000+ lines)
├── services/
│   ├── resolver.py           # yt-dlp video resolution
│   ├── database.py           # SQLite persistence
│   └── cache.py              # Caching & disk management
├── api/routes/               # REST endpoints
└── core/                     # Config & security

frontend/
├── app/                      # Next.js app router pages
├── components/
│   ├── custom-player.tsx     # Main video player (1000+ lines)
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

## Testing

```bash
# Backend tests
cd backend && pytest

# Frontend type checking
cd frontend && npm run build
```

## Important Notes

- Room state persists for 5 minutes after last user leaves
- User cookies are stored in `data/cookies/{email}.txt` (Netscape format)
- Room IDs are sanitized to alphanumeric + hyphen/underscore only
- The proxy rewrites manifest URLs to avoid CORS issues
- yt-dlp requires Node.js runtime for JavaScript challenge execution

## Documentation

- `SPECIFICATION.md` - Full technical specification
- `CONTRIBUTING.md` - Development guidelines
- `DEPLOYMENT.md` - Deployment instructions
- `CHANGELOG.md` - Version history
- `ISSUES.md` - Known issues and roadmap
