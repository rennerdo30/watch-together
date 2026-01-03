# Watch Together - Specification

## Overview
A web application allowing users to watch videos together from various sources, prioritizing maximum site compatibility by using `yt-dlp` in the backend.

## Architecture
- **Frontend**: Next.js 16 (React 19)
- **Backend**: Python (FastAPI)
- **Video Player**: Custom HLS.js player with premium UI
- **Communication**: WebSockets for real-time sync, REST API for video resolution
- **Deployment**: Docker Compose with Cloudflare Tunnel

## Core Features

### 1. Universal Video Resolver
- User inputs a URL (YouTube, Twitch, and 1800+ supported sites via yt-dlp)
- Backend uses `yt-dlp` to resolve the direct stream URL (HLS/m3u8 or MP4)
- **Generic Extractor**: Falls back to page scanning for unsupported sites
- **HLS Proxy**: Backend proxies manifests and segments to bypass CORS restrictions
- **Cookie Support**: Uses `data/cookies.txt` for age-gated or restricted content

### 2. Room System
- **Dynamic Rooms**: Users can create rooms with custom names (e.g., `/room/movie-night`)
- **Real-time Sync**: WebSocket-based synchronization of:
  - Video URL and metadata
  - Play/Pause state
  - Seek position (with drift correction)
- **Persistent State**: Room state survives server restarts (5-minute TTL after last user leaves)
- **Guest Users**: No login required, integrates with Cloudflare Access for identity

### 3. Video Player
- **Engine**: Custom player built on HLS.js for maximum control
- **Premium UI**: Glassmorphism design with smooth animations
- **Features**:
  - Adaptive quality selection
  - Picture-in-Picture support
  - "Stats for Nerds" overlay
  - Fullscreen mode
  - Live stream support with DVR
- **Autoplay**: Automatic playback with muted fallback for browser policies

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
- react-hot-toast for notifications

### Backend
- Python 3.11, FastAPI
- yt-dlp for video resolution
- httpx for async HTTP
- WebSockets for real-time sync
- JSON file persistence for room state

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
- [x] Generic Extractor for Unsupported Sites

### Planned
- [ ] Drag-and-Drop Queue Reordering
