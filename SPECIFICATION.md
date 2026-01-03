# Watch Together - Specification

## Overview
A web application allowing users to watch videos together from various sources, prioritizing maximum site compatibility by using `yt-dlp` in the backend.

## Architecture
- **Frontend**: Next.js 16 (React 19)
- **Backend**: Python (FastAPI), fully asynchronous
- **Video Player**: Custom HLS.js player with premium UI
- **Communication**: WebSockets for real-time sync, REST API for video resolution
- **Deployment**: Docker Compose with Cloudflare Tunnel

## Core Features

### 1. Universal Video Resolver
- User inputs a URL (YouTube, Twitch, and 1800+ supported sites via yt-dlp)
- Backend uses `yt-dlp` to resolve the direct stream URL (HLS/m3u8 or MP4)
- **HLS Preference**: Prioritizes Master Playlists (`.m3u8`) to enable adaptive quality selection
- **HLS Proxy**: Backend proxies manifests and segments to bypass CORS restrictions
  - Rewrites internal absolute URLs in manifests to route through proxy
  - Supports Partial Content (Range requests) for robust seeking
- **Cookie Support**: Uses `data/cookies.txt` for age-gated or restricted content
- **Smart Runtime**: Uses Node.js in backend for complex JavaScript challenges (e.g. YouTube `n` parameter)

### 2. Room System
- **Dynamic Rooms**: Users can create rooms with custom names (e.g., `/room/movie-night`)
- **Real-time Sync**: WebSocket-based synchronization of:
  - Video URL and metadata
  - Play/Pause state and Timestamp (with drift correction)
  - Queue state and User roles
- **Persistent State**: Room state survives server restarts (5-minute TTL after last user leaves)
- **Async I/O**: Non-blocking file operations (`aiofiles`) for high concurrency
- **Guest Users**: No login required, integrates with Cloudflare Access for identity

### 3. Video Player
- **Engine**: Custom player built on HLS.js for maximum control
- **Premium UI**: Glassmorphism design with smooth animations
- **Features**:
  - **Quality Selection**: Manually select resolution (1080p, 720p, etc.) or Auto
  - **Audio Normalization**: Integrated compressor/limiter for night mode viewing (dynamic gain)
  - **Persistent Settings**: Remembers Volume, Mute, and Normalization preferences via LocalStorage
  - **Robust Unmute**: Automatically handles browser autoplay policies to restore audio
  - Picture-in-Picture, Fullscreen, and "Stats for Nerds"
- **Sync Logic**: Prevents race conditions on load; forces 0:00 start for new videos

### 4. Queue System
- Add videos to queue for continuous playback
- Pin videos to prevent auto-removal after playback
- Reorder queue (drag-and-drop planned)
- Auto-advance to next video on completion
- **Stream URL Refresh**: Re-resolves URLs on playback to prevent expiration

### 5. Debug Panel
- Real-time display of:
  - WebSocket connection status
  - Playback state (Playing/Paused)
  - Current timestamp and last sync time
  - Queue info and proxy status

## Technical Stack

### Frontend
- Next.js 16, React 19
- TailwindCSS 4 for styling
- Lucide React for icons
- HLS.js for video playback
- Web Audio API for Normalization

### Backend
- Python 3.11, FastAPI
- **Async Framework**: `aiofiles` for I/O, `httpx` for requests
- `yt-dlp` (latest) for video resolution
- Node.js runtime for JS execution
- WebSockets for real-time sync

### Deployment
- Docker Compose orchestration
- Nginx reverse proxy
- Cloudflare Tunnel for secure access
- Volume mapping for persistent data

## Roadmap

### Completed
- [x] Project Scaffold (Frontend + Backend)
- [x] Backend: `yt-dlp` integration service
- [x] Frontend: Premium player UI
- [x] Frontend: Integration with Backend
- [x] Docker Deployment (Dockerfile + docker-compose)
- [x] Room System (Backend WebSockets)
- [x] Room System (Frontend Integration + Sync Logic)
- [x] Queue & Playlist system
- [x] Custom HLS.js Player with Stats Overlay
- [x] HLS Proxy & Cookie Support
- [x] Debug Panel for Sync State Visibility
- [x] Persistent Playback State Across Restarts
- [x] **Quality Selection (HLS Master Playlist Support)**
- [x] **Audio Normalization (Compressor/Limiter)**
- [x] **Async Backend Refactor**

### Planned
- [ ] Drag-and-Drop Queue Reordering
