# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added
- **Browser Extension**: Automatic cookie sync from Chrome/Firefox to server
- **DASH Player Hooks**: Extracted `useDashPlayer` for initialization/quality management
- **PNG Icons**: Added multi-size PNG icons for browser extension
- **User Detection**: `/api/me` endpoint for automatic user identification

### Fixed
- **HTTP/2 Protocol Errors**: Added `Connection: close` header and disabled chunked encoding to prevent streaming issues
- **DASH Loading State**: Fixed loading spinner stuck on true when video/audio already loaded
- **Cookie Format**: Corrected Netscape format - `includeSubdomains` must be TRUE when domain has leading dot
- **Volume State**: Apply saved volume/muted state on page load for non-DASH mode
- **Proxy Redirects**: Limited max redirects to 3 to prevent YouTube CDN 503 errors
- **HLS Player Loop**: Prevented infinite re-initialization by fixing effect dependencies
- **Nginx Timeouts**: Increased proxy timeouts for large video streams (600s)
- **Direct MP4 Streams**: Handle non-HLS sources correctly in player
- **Extension Security**: Fixed multiple security and stability issues in cookie sync

### Changed
- **DASH Sync Hook**: Applied callback refs pattern to prevent stale closures
- **Player Refactor**: Extracted DASH initialization logic to dedicated hook

---

## [1.0.0] - 2025-01-04

### Features
- **Universal Video Resolution**: yt-dlp integration supporting 1800+ sites
- **Real-time Synchronization**: WebSocket-based sync with sub-second accuracy
- **DASH/HLS Streaming**: Separate video/audio streams with quality selection up to 4K
- **Room System**: Persistent rooms with queue management
- **Cookie Authentication**: Bypass age-restrictions with user cookies
- **Audio Normalization**: "Night mode" with configurable gain boost
- **Drag-and-Drop Queue**: Reorderable queue with @dnd-kit
- **Cloudflare Integration**: Zero Trust authentication and tunnel support

### Synchronization
- Server heartbeat every 5 seconds with authoritative timestamp
- Client latency measurement via ping/pong
- Small drifts (<3s) use playbackRate adjustment (0.95x/1.05x)
- Large drifts trigger hard seek to correct position
- A/V sync for DASH streams with preemptive buffer monitoring

### Performance
- Position-aware 10MB bucket caching for DASH streams
- 2-hour format cache TTL for yt-dlp results
- Multi-tier cache: Memory LRU → Disk buckets → Upstream
- Segment prefetching based on playback position

### Stability
- Room state persists for 5 minutes after last user leaves
- Automatic cleanup of stale rooms every minute
- Error boundary around video player
- WebSocket auto-reconnect with status indicator

### UI/UX
- Premium "Midnight Violet" dark theme
- Responsive sidebar with width persistence
- Quality selection with codec labels (VP9, AV1, H264)
- Sync threshold slider (1-10s) in player settings
- Debug panel showing WebSocket status and playback state

### Fixed (Initial Release)
- Duplicate dict keys in connection_manager.py
- DnD sends wrong message type for queue reorder
- Async save not awaited causing silent data loss
- Format cache cleanup for expired entries
- Room ID sanitization for special characters
- Cookie sharing for queue items (added_by field)
- DASH audio loop during buffering
- Seeking performance with proper event handling
- Player flickering from re-initialization loop
- Sync status badge using optimistic updates
- AudioContext suspension logic for autoplay
- Video looping sync feedback loop

### Technical
- Next.js 16 with App Router and React 19
- FastAPI with fully async I/O
- TailwindCSS 4 for styling
- Non-root Docker containers
- Modular backend structure (core/, services/, api/routes/)
