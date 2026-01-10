# Watch Together - Technical Specification

## Overview

Watch Together is a real-time collaborative video synchronization platform enabling multiple users to watch content from YouTube, Twitch, and 1800+ other sites simultaneously. The system prioritizes sub-second synchronization accuracy, robust error recovery, and a premium user experience.

## System Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              User Browsers                                   │
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │
│   │   User A    │  │   User B    │  │   User C    │  │  Extension  │       │
│   └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘       │
└──────────┼────────────────┼────────────────┼────────────────┼───────────────┘
           │ HTTPS          │ HTTPS          │ HTTPS          │ HTTPS
           └────────────────┴────────────────┴────────────────┘
                                    │
┌───────────────────────────────────▼─────────────────────────────────────────┐
│                    Cloudflare (Optional)                                     │
│   ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐            │
│   │  Zero Trust     │  │     Tunnel      │  │    Caching      │            │
│   │  Authentication │  │    Connector    │  │   (Optional)    │            │
│   └─────────────────┘  └─────────────────┘  └─────────────────┘            │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ HTTP
┌───────────────────────────────────▼─────────────────────────────────────────┐
│                         Nginx Reverse Proxy                                  │
│   ┌────────────────┐  ┌────────────────┐  ┌────────────────────────┐       │
│   │  /api/*        │  │     /ws/*      │  │       /*               │       │
│   │  REST + Proxy  │  │   WebSocket    │  │   Static/SSR Pages     │       │
│   └───────┬────────┘  └───────┬────────┘  └───────────┬────────────┘       │
└───────────┼───────────────────┼───────────────────────┼─────────────────────┘
            │                   │                       │
┌───────────▼───────────────────▼───────────┐  ┌───────▼─────────────────────┐
│              FastAPI Backend               │  │     Next.js Frontend        │
│  ┌─────────────────────────────────────┐  │  │  ┌───────────────────────┐  │
│  │          connection_manager.py       │  │  │  │     App Router        │  │
│  │  • WebSocket room management         │  │  │  │  • SSR pages          │  │
│  │  • Real-time sync state              │  │  │  │  • Client components  │  │
│  │  • Heartbeat broadcasting            │  │  │  └───────────────────────┘  │
│  └─────────────────────────────────────┘  │  │  ┌───────────────────────┐  │
│  ┌─────────────────────────────────────┐  │  │  │    Custom Player      │  │
│  │            main.py                   │  │  │  │  • useDashSync        │  │
│  │  • REST API endpoints                │  │  │  │  • useHlsPlayer       │  │
│  │  • Video proxy (HLS/DASH)            │  │  │  │  • useAudioNorm       │  │
│  │  • Cookie management                 │  │  │  └───────────────────────┘  │
│  └─────────────────────────────────────┘  │  │  ┌───────────────────────┐  │
│  ┌─────────────────────────────────────┐  │  │  │     useRoomSync       │  │
│  │          services/resolver.py        │  │  │  │  • WebSocket client   │  │
│  │  • yt-dlp integration                │  │  │  │  • State management   │  │
│  │  • Format selection                  │  │  │  └───────────────────────┘  │
│  │  • Cookie fallback chain             │  │  └─────────────────────────────┘
│  └─────────────────────────────────────┘  │
└───────────────────────────────────────────┘
```

### Container Architecture

```yaml
services:
  frontend:     # Next.js 16 + React 19
    port: 3000

  backend:      # FastAPI + yt-dlp
    port: 8000
    volumes:
      - ./data:/app/data

  proxy:        # Nginx reverse proxy
    port: 80

  tunnel:       # Cloudflare Tunnel (optional)
```

## Core Components

### 1. Video Resolution Engine

The backend uses yt-dlp with a multi-pass cookie strategy to maximize video access.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Resolution Flow                               │
├─────────────────────────────────────────────────────────────────┤
│  1. Check format cache (2-hour TTL)                             │
│     ├── HIT: Return cached manifest URLs                        │
│     └── MISS: Continue to resolution                            │
│                                                                  │
│  2. Cookie priority chain:                                       │
│     ├── a) Requesting user's cookies                            │
│     ├── b) Adding user's cookies (for shared queue items)       │
│     └── c) No cookies (fallback)                                │
│                                                                  │
│  3. yt-dlp extraction:                                          │
│     ├── Format: bestvideo*+bestaudio/best                       │
│     ├── PO Token: bgutil-ytdlp-pot-provider                     │
│     └── JS Runtime: Node.js for challenges                      │
│                                                                  │
│  4. Stream type detection:                                       │
│     ├── DASH: Separate video + audio URLs                       │
│     ├── HLS: Single manifest URL                                │
│     └── Direct: Progressive download URL                        │
└─────────────────────────────────────────────────────────────────┘
```

### 2. Synchronization Engine

Real-time sync uses WebSockets with intelligent drift correction.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Sync Protocol                                 │
├─────────────────────────────────────────────────────────────────┤
│  Server → Client (every 5 seconds):                             │
│  {                                                               │
│    "type": "heartbeat",                                         │
│    "timestamp": 125.43,        // Authoritative position        │
│    "is_playing": true,                                          │
│    "server_time": 1704567890   // For latency calculation       │
│  }                                                               │
│                                                                  │
│  Client drift correction:                                        │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ drift = client_time - server_time                           ││
│  │                                                              ││
│  │ if |drift| > 3.0s:                                          ││
│  │   → Hard seek to server_time                                ││
│  │ elif |drift| > 0.5s:                                        ││
│  │   → Adjust playbackRate (0.95x or 1.05x)                    ││
│  │ else:                                                        ││
│  │   → Normal playback (1.0x)                                  ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  Client → Server (on user action):                              │
│  {                                                               │
│    "type": "seek" | "play" | "pause",                           │
│    "timestamp": 90.0                                            │
│  }                                                               │
└─────────────────────────────────────────────────────────────────┘
```

### 3. DASH A/V Synchronization

For separate video/audio streams, the `useDashSync` hook maintains sync.

```
┌─────────────────────────────────────────────────────────────────┐
│                    DASH Sync Loop (4Hz)                         │
├─────────────────────────────────────────────────────────────────┤
│  1. Buffer monitoring:                                          │
│     ├── videoBuffer = video.buffered.end - video.currentTime   │
│     ├── audioBuffer = audio.buffered.end - audio.currentTime   │
│     └── if min(buffer) < 0.8s → Pause audio preemptively       │
│                                                                  │
│  2. A/V drift calculation:                                      │
│     drift = audio.currentTime - video.currentTime               │
│                                                                  │
│  3. Correction:                                                  │
│     ├── |drift| > 2.0s → Emergency sync (bypass cooldown)      │
│     ├── |drift| > 0.8s → Heavy sync (pause, seek, resume)      │
│     ├── |drift| > 0.2s → Rate adjustment (0.97x or 1.03x)      │
│     └── |drift| < 0.2s → Normal (1.0x)                         │
│                                                                  │
│  4. Recovery:                                                    │
│     ├── Buffer recovered (>1.5s) → Resume audio                 │
│     ├── Audio stopped unexpectedly → Restart audio              │
│     └── Tab visibility change → Re-sync on return               │
└─────────────────────────────────────────────────────────────────┘
```

### 4. Proxy & Caching

The video proxy handles CORS bypass and implements multi-tier caching.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Proxy Architecture                            │
├─────────────────────────────────────────────────────────────────┤
│  Request: /api/proxy?url=<encoded_url>                          │
│                                                                  │
│  1. Manifest handling:                                          │
│     ├── Detect .m3u8/.mpd by extension or content-type         │
│     ├── Rewrite all URLs to /api/proxy?url=...                 │
│     └── Return with appropriate MIME type                       │
│                                                                  │
│  2. Segment caching (3-tier):                                   │
│     ┌───────────────────────────────────────────────────────┐  │
│     │ L1: Memory Cache (LRU)                                │  │
│     │     • Segments < 25MB                                 │  │
│     │     • Audio: 500 entries, Video: 200 entries          │  │
│     │     • Adaptive TTL based on access frequency          │  │
│     ├───────────────────────────────────────────────────────┤  │
│     │ L2: Disk Bucket Cache                                 │  │
│     │     • 10MB buckets for position-aware caching         │  │
│     │     • Enables efficient seeking                       │  │
│     │     • Max 50GB total size                             │  │
│     ├───────────────────────────────────────────────────────┤  │
│     │ L3: Upstream (YouTube/Twitch CDN)                     │  │
│     │     • Passthrough with Range header support           │  │
│     │     • Streaming response (no buffering)               │  │
│     └───────────────────────────────────────────────────────┘  │
│                                                                  │
│  3. Response headers:                                           │
│     ├── Access-Control-Allow-Origin: *                          │
│     ├── Accept-Ranges: bytes                                    │
│     ├── Content-Range: bytes x-y/total                          │
│     └── Connection: close (HTTP/2 compatibility)                │
└─────────────────────────────────────────────────────────────────┘
```

## Technical Stack

### Frontend

| Component | Technology | Purpose |
|-----------|------------|---------|
| Framework | Next.js 16 | App Router, SSR |
| UI Library | React 19 | Components, hooks |
| Styling | TailwindCSS 4 | Utility-first CSS |
| Player | hls.js | HLS streaming |
| DnD | @dnd-kit | Drag-and-drop queue |
| Icons | Lucide React | Icon set |

### Backend

| Component | Technology | Purpose |
|-----------|------------|---------|
| Framework | FastAPI | Async REST API |
| Python | 3.11+ | Runtime |
| Video | yt-dlp | Video resolution |
| PO Token | bgutil-ytdlp-pot-provider | YouTube auth |
| Database | aiosqlite | Async SQLite |
| HTTP | httpx | Async HTTP client |
| WebSocket | websockets | Real-time communication |

### Infrastructure

| Component | Technology | Purpose |
|-----------|------------|---------|
| Container | Docker Compose | Orchestration |
| Proxy | Nginx | Reverse proxy, routing |
| Tunnel | Cloudflare | Secure external access |
| Auth | Cloudflare Zero Trust | User authentication |

## Data Models

### Room State

```typescript
interface Room {
  id: string;
  members: {
    [email: string]: {
      name: string;
      is_guest: boolean;
      joined_at: string;
    }
  };
  queue: QueueItem[];
  current_video: VideoState | null;
  is_playing: boolean;
  timestamp: number;
  last_active: string;
}

interface QueueItem {
  id: string;
  url: string;
  title: string;
  thumbnail: string;
  duration: number;
  added_by: string;
  added_at: string;
}

interface VideoState {
  url: string;
  title: string;
  thumbnail: string;
  stream_type: 'hls' | 'dash' | 'direct';
  video_url?: string;   // DASH only
  audio_url?: string;   // DASH only
  qualities: QualityOption[];
}
```

### WebSocket Messages

```typescript
// Client → Server
type ClientMessage =
  | { type: 'play'; timestamp: number }
  | { type: 'pause'; timestamp: number }
  | { type: 'seek'; timestamp: number }
  | { type: 'queue_add'; url: string }
  | { type: 'queue_remove'; item_id: string }
  | { type: 'queue_reorder'; queue: string[] }
  | { type: 'queue_play'; item_id: string }
  | { type: 'pong' };

// Server → Client
type ServerMessage =
  | { type: 'room_state'; room: Room }
  | { type: 'heartbeat'; timestamp: number; is_playing: boolean }
  | { type: 'play'; timestamp: number; by: string }
  | { type: 'pause'; timestamp: number; by: string }
  | { type: 'seek'; timestamp: number; by: string }
  | { type: 'set_video'; video: VideoState }
  | { type: 'queue_update'; queue: QueueItem[] }
  | { type: 'member_joined' | 'member_left'; email: string }
  | { type: 'ping' }
  | { type: 'error'; message: string };
```

## API Endpoints

### REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/resolve` | POST | Resolve video URL to streams |
| `/api/proxy` | GET | Proxy video segments |
| `/api/rooms` | GET | List active rooms |
| `/api/rooms/{id}` | GET | Get room details |
| `/api/cookies` | POST | Upload user cookies |
| `/api/cookies` | DELETE | Delete user cookies |

### WebSocket

| Endpoint | Description |
|----------|-------------|
| `/ws/{room_id}` | Room synchronization |

## Security Considerations

1. **Cookie Storage**: Stored server-side in Netscape format, linked to user identity
2. **Room Access**: All users can join any room (authentication handled by Cloudflare)
3. **Proxy**: Only whitelisted domains (YouTube, Twitch CDNs) are proxied
4. **Non-root Containers**: All services run as non-root users
5. **Input Validation**: Room IDs sanitized to alphanumeric + hyphen/underscore

## Performance Optimizations

1. **Format Caching**: 2-hour TTL prevents redundant yt-dlp calls
2. **Segment Caching**: Multi-tier cache with adaptive TTL
3. **Prefetching**: Next segments prefetched based on playback position
4. **Connection Pooling**: Reused HTTP connections for upstream requests
5. **Streaming Response**: No buffering for video proxy

## Roadmap

### Completed
- [x] Universal video resolution (yt-dlp)
- [x] Real-time WebSocket sync
- [x] DASH A/V synchronization
- [x] HLS playback with hls.js
- [x] Quality selection (up to 4K)
- [x] Cookie authentication
- [x] Browser extension for cookie sync
- [x] Audio normalization
- [x] Drag-and-drop queue
- [x] Room persistence

### Planned
- [ ] Chat system
- [ ] User playlists
- [ ] Mobile-optimized layout
- [ ] Subtitle support
- [ ] Watch history
