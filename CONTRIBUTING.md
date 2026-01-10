# Contributing to Watch Together

Thank you for your interest in contributing to Watch Together! This document provides guidelines and instructions for contributing.

## Table of Contents
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Code Style](#code-style)
- [Making Changes](#making-changes)
- [Testing](#testing)
- [Pull Request Process](#pull-request-process)

## Development Setup

### Prerequisites
- **Docker & Docker Compose** - For containerized development
- **Node.js 20+** - For frontend development
- **Python 3.11+** - For backend development
- **Git** - Version control

### Option 1: Docker Development (Recommended)

```bash
# Clone the repository
git clone https://github.com/rennerdo30/watch-together.git
cd watch-together

# Copy environment file
cp .env.example .env

# Start all services with hot-reload
docker compose up -d --build

# View logs
docker compose logs -f
```

Services:
- Frontend: http://localhost:3000 (via proxy at :80)
- Backend API: http://localhost:8000
- Nginx Proxy: http://localhost:80

### Option 2: Local Development

```bash
# Backend
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# Frontend (new terminal)
cd frontend
npm install --legacy-peer-deps
npm run dev
```

### Development Identity

For local development without Cloudflare, use the `?user=` query parameter:
```
http://localhost:3000/room/test?user=dev@example.com
```

## Project Structure

```
watch-together/
├── backend/
│   ├── main.py                 # FastAPI app, endpoints, proxy
│   ├── connection_manager.py   # WebSocket room management
│   ├── services/
│   │   ├── resolver.py        # yt-dlp video resolution
│   │   ├── database.py        # SQLite persistence
│   │   └── cache.py           # Memory/disk caching
│   ├── api/routes/            # API route modules
│   └── core/                  # Config, security
├── frontend/
│   ├── app/                   # Next.js App Router pages
│   │   ├── page.tsx          # Home page
│   │   └── room/[id]/        # Room page
│   ├── components/
│   │   ├── custom-player.tsx # Main video player
│   │   ├── player-controls.tsx
│   │   ├── player/hooks/     # useDashSync, useHlsPlayer, etc.
│   │   └── room/             # Room-specific components
│   └── lib/
│       ├── api.ts            # Backend API client
│       └── hooks/            # useRoomSync, useRoomSettings
├── extension/                # Browser extension
├── nginx/                    # Nginx configuration
└── docker-compose.yml
```

### Key Files

| File | Purpose |
|------|---------|
| `backend/main.py` | API endpoints, video proxy, app initialization |
| `backend/connection_manager.py` | WebSocket room state, sync logic |
| `backend/services/resolver.py` | yt-dlp integration, format selection |
| `frontend/components/custom-player.tsx` | Video player component |
| `frontend/components/player/hooks/useDashSync.ts` | A/V sync for DASH streams |
| `frontend/lib/hooks/useRoomSync.ts` | WebSocket room synchronization |

## Code Style

### Frontend (TypeScript/React)

- **TypeScript**: Strict mode enabled, use proper types
- **React**: Functional components with hooks
- **Styling**: TailwindCSS classes only (no CSS modules)
- **Imports**: Use absolute imports (`@/components/...`)

```typescript
// Good
const MyComponent: React.FC<Props> = ({ value }) => {
  const [state, setState] = useState<string>('');

  return (
    <div className="flex items-center gap-2">
      {/* ... */}
    </div>
  );
};

// Avoid
class MyComponent extends React.Component { }  // Use functional
import styles from './styles.module.css';      // Use Tailwind
```

### Backend (Python)

- **Type Hints**: Required on all function signatures
- **Async**: Use `async/await` for all I/O operations
- **Models**: Pydantic for request/response validation
- **Style**: PEP 8 with 100 character line limit

```python
# Good
async def get_video(url: str, user_email: str | None = None) -> VideoResponse:
    """Resolve video URL and return stream info."""
    result = await resolver.extract(url)
    return VideoResponse(url=result.url, title=result.title)

# Avoid
def get_video(url, user_email=None):  # Missing types
    result = resolver.extract(url)     # Sync call
```

## Making Changes

### Adding a New API Endpoint

1. Define Pydantic models in `backend/api/models.py` (or relevant file)
2. Add route in `backend/api/routes/` or `backend/main.py`
3. Add corresponding API call in `frontend/lib/api.ts`

### Adding a New WebSocket Message Type

1. Add handler in `backend/connection_manager.py`:
   ```python
   elif msg_type == "my_new_type":
       await self._handle_my_new_type(room_id, data, websocket)
   ```
2. Update `frontend/lib/hooks/useRoomSync.ts` to send/receive

### Modifying the Video Player

- Core player logic: `frontend/components/custom-player.tsx`
- A/V sync (DASH): `frontend/components/player/hooks/useDashSync.ts`
- HLS playback: `frontend/components/player/hooks/useHlsPlayer.ts`
- UI controls: `frontend/components/player-controls.tsx`

## Testing

### Frontend
```bash
cd frontend
npm run build        # Type checking + build
npm run lint         # ESLint
```

### Backend
```bash
cd backend
python -m py_compile main.py connection_manager.py services/*.py  # Syntax check
pytest               # Run tests (if available)
```

### Before Committing
```bash
# Frontend must build without errors
cd frontend && npm run build

# Backend must compile without errors
cd backend && python -m py_compile main.py connection_manager.py
```

## Pull Request Process

1. **Fork** the repository
2. **Create a branch**: `git checkout -b feature/amazing-feature`
3. **Make changes** following the code style guidelines
4. **Test** your changes locally
5. **Commit** using conventional commits:
   - `feat:` New feature
   - `fix:` Bug fix
   - `refactor:` Code refactoring
   - `docs:` Documentation
   - `chore:` Maintenance
6. **Push**: `git push origin feature/amazing-feature`
7. **Open a Pull Request** with:
   - Clear description of changes
   - Screenshots for UI changes
   - Test steps if applicable

### Commit Message Examples

```
feat: add subtitle support for HLS streams
fix: prevent audio desync during seek operations
refactor: extract video player into separate hooks
docs: update deployment guide for Cloudflare
```

## Reporting Issues

Use GitHub Issues with:
- **Bug reports**: Steps to reproduce, expected vs actual behavior, browser/OS info
- **Feature requests**: Clear description of the feature and use case
- **Questions**: Check existing issues first, then ask

## Questions?

Feel free to open an issue or discussion if you have questions about contributing!
