# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [1.1.0] - 2026-08-20

### Security

- **Verified Identity**: Cloudflare Access assertions (`Cf-Access-Jwt-Assertion`) are now
  verified against the team JWKS — signature, audience, issuer and expiry — instead of
  trusting the plain `Cf-Access-Authenticated-User-Email` header, which anyone able to
  reach the origin directly could forge. Configure with `CF_ACCESS_TEAM_DOMAIN` and
  `CF_ACCESS_AUD`; without them the previous header behaviour is kept and logged loudly.
- **Authentication Where There Was None**: `/api/proxy` and the WebSocket handshake
  accepted anonymous callers. `REQUIRE_AUTHENTICATION` rejects them, defaulting to on
  once Access is configured.
- **SSRF Closed**: removed the trusted-CDN allowlist that skipped address validation for
  any subdomain of an allowlisted domain; redirects are now followed by the proxy with
  every hop re-validated; the validated IP is pinned for the connection so DNS cannot
  rebind between check and fetch. An adversarial pass then closed four special-use
  ranges that carry no restrictive flag from the `ipaddress` module — RFC 6598 carrier
  NAT space, the deprecated 6to4 relay range, deprecated IPv6 site-local, and the
  documentation range — and made IPv4-in-IPv6 unwrapping explicit.
- **Per-User Cookies**: the single shared cookie jar is gone. Cookies are loaded per user
  and attached per request, and responses fetched with cookies are cached under a key
  that includes the user's identity.
- **Validated Prefetching**: the prefetcher fetched manifest-derived URLs with no
  validation; it uses the same validated path as the proxy.
- **Shared Rate Limiting**: `/api/extension/sync` had no limit because the limiter was
  private to the cookie routes. Both share one limiter under separate scopes.
- **Cookie File Permissions**: cookie files are written owner-only on every path.
- **Loopback by Default**: nginx publishes on `127.0.0.1`; the tunnel reaches it over the
  Docker network. `NGINX_BIND`/`NGINX_PORT` opt into wider exposure.

### Added

- **DASH Manifest Generation**: `GET /api/dash-manifest` describes the adaptive video and
  audio streams — which yt-dlp returns as separate fragmented-MP4 files with no manifest —
  by scanning each file's box headers for its initialization and index ranges.
- **Single-Element Playback**: a Shaka-based engine plays those streams through one media
  element via MSE, so the browser muxes video and audio against one clock. Selected with
  `NEXT_PUBLIC_STREAM_ENGINE=mse`; the legacy two-element path remains the default.
- **Proxy Metrics**: `GET /api/metrics/proxy` reports per-transfer host, status, byte
  offset, bytes sent against content-length, latency and outcome, classifying short
  transfers as truncated — the evidence needed for the unresolved streaming errors.
- **Backend Origin Override**: `NEXT_PUBLIC_BACKEND_ORIGIN` lets the frontend reach the
  backend without nginx, so `npm run dev` works standalone.

### Testing

- 195 backend tests covering SSRF and upstream pinning, redirect validation, Access JWT
  verification, connection limits under concurrent bursts, WebSocket sync, cookie
  isolation, manifest generation and hardening.
- Playwright end-to-end tests: two-client room synchronization through the real UI, and
  MSE playback of a generated manifest verified in a real browser.
- Tests run against a temporary data directory, so they neither depend on nor pollute the
  real one; CI now runs on the same Python version as production.

### Fixed

- **In-Flight Cache Race**: results were published outside the lock guarding the table.
- **Multi-Worker Corruption**: extra workers each held their own room state, splitting
  rooms in a way that looked like a sync bug. Startup now refuses.
- **Container Publish Workflow**: every run had been failing because the build requested
  GitHub Actions cache without setting up Buildx.

---


### Added
- **Browser Extension**: Automatic cookie sync from Chrome/Firefox to server
- **DASH Player Hooks**: Extracted `useDashPlayer` for initialization/quality management
- **PNG Icons**: Added multi-size PNG icons for browser extension
- **User Detection**: `/api/me` endpoint for automatic user identification

### Security Hardening
- **SSRF Protection**: Added `validate_proxy_url()` with private IP blocking via `ipaddress` module + DNS resolution
- **CORS Configuration**: Made configurable via `ALLOWED_ORIGINS` env var; credentials disabled when wildcard
- **Connection Limits**: Added `MAX_CONNECTIONS_PER_ROOM` (50) and `MAX_CONNECTIONS_PER_USER` (10) limits
- **Room ID Sanitization**: Restrict to alphanumeric, hyphen, underscore only
- **Auth Hardening**: Query parameter auth fallback gated behind `DEVELOPMENT_MODE` env var
- **Cookie Validation**: Added 1MB upload size limit and Netscape format validation
- **WebSocket Concurrency**: Room state initialization protected with `_state_lock` for atomic creation + role assignment
- **Atomic Connection Limits**: Per-room and per-user limit checks moved inside `_state_lock` (fixes TOCTOU race)
- **WebSocket Message Validation**: Message `type` checked for string type and length (50 chars), 100KB frame cap, JSON decode guard
- **Cookie Validation (All Lines)**: Netscape format validation covers all data lines, not just the first 5
- **Extension Sync Validation**: `/api/extension/sync` enforces the same 1MB limit and format validation as `/api/cookies`
- **Cookie Upload Rate Limiting**: `POST /api/cookies` limited to 10 uploads per user per 60s
- **In-Flight Cache Bounds**: `_in_flight_results` bounded to 100 entries with 30s TTL, synchronous cleanup under lock
- **Room Lock Cleanup**: Room locks deleted on room cleanup, orphan locks swept every 60s
- **Heartbeat Locking**: `get_sync_payload` acquires room lock to prevent reading during modification
- **Cache Robustness**: In-flight request wait has 60s timeout; TOCTOU race in bucket cache fixed
- **Heartbeat Backoff**: Exponential backoff on consecutive heartbeat errors
- **Nginx Security Headers**: Added `Content-Security-Policy`, `Strict-Transport-Security`, `Permissions-Policy`
- **Docker Hardening**: Pinned image versions, added container resource limits, removed exposed internal ports
- **Extension Permissions**: Restricted `host_permissions` to specific video CDN domains
- **Extension Token Storage**: Moved tokens from `chrome.storage.sync` to `chrome.storage.local`

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
- **setInterval Leak**: Fixed useDashSync interval accumulation via ref-based callback pattern
- **Stale Closures**: Fixed useRoomSync stale `playerRef`/`onVideoChange` via `playerRefRef`/`onVideoChangeRef` pattern
- **AudioContext Leak**: Cleanup now triggers on `sourceElement` change (browser limit ~6 contexts)
- **DASH Error Listeners**: Fixed gap where error listeners weren't attached on early return
- **DASH Mode Detection**: Replaced fragile `volume === 0 && !muted` heuristic with `data-stream-type` attribute
- **Sidebar Resize Leak**: Fixed `mousemove`/`mouseup` listener leak on component unmount
- **SSR Hydration Mismatch**: Volume/muted state loaded via `useEffect` instead of `useState` initializer

### Changed
- **DASH Sync Hook**: Applied callback refs pattern to prevent stale closures
- **Player Refactor**: Extracted DASH initialization logic to dedicated hook
- **Dynamic Referer**: Proxy sets referer header dynamically based on URL domain

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
