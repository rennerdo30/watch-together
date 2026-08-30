# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Changed

- **Visual Language**: the palette moves from a violet accent on pure-neutral
  greys to a cool slate with one signal red — red already means "live" next to a
  video, so it carries the primary action and the recording dot without a second
  hue, and the video is the only saturated thing on screen. The light scheme
  leaves pure white behind (a page at `#fff` gives a card nothing to sit on) and
  its borders are appreciably stronger than the dark scheme's, since a dark edge
  on a light surface carries less apparent weight than the reverse.
  The six themes now share one neutral and differ only in accent, instead of
  each tinting the whole application.
- **Typography**: the app shell no longer sets `uppercase` on everything, so no
  element has to opt back out to read normally. Small text was set in 9–11px
  `font-black uppercase tracking-widest`; four named steps (`ui-label`,
  `ui-meta`, `ui-title`, `ui-heading`) replace it, carrying hierarchy with size
  and weight rather than case and letter-spacing. `LIVE` on a live stream is the
  one place capitals were kept.
- **Accent Colours Follow The Theme**: every hard-coded violet is now a lookup of
  `--accent-primary`, which the active theme writes onto the document. Only a
  handful of places read the theme before, so most of the UI stayed violet
  whichever theme was chosen.

### Added

- **Chrome Extension Nightly**: every commit to `main` now validates and packages
  the Manifest V3 extension, uploads the ZIP and SHA-256 checksum as a workflow
  artifact, and updates one rolling GitHub prerelease tagged `nightly`.

### Security

- **Extension Identity Is Token-Bound**: the extension no longer treats a cached
  email beside any cached token as proof of who is connected. One atomic,
  local-only active connection stores the instance and token; displayed identity
  comes from `/api/extension/status`, is compared with the browser's current
  Access session, and is cleared on a 401, account switch, permission removal, or
  explicit disconnect. `/api/token` returns its owner in the same authenticated
  response, removing the former `/api/me` → `/api/token` session race. Identity
  and token responses are explicitly `private, no-store`.
- **Synchronized Extension Secrets Removed**: old builds wrote token, email and
  backend URL into `chrome.storage.sync`, and the options page still read those
  values after the background worker moved to local storage. A second browser
  could therefore display and copy another user's still-valid token while sync
  ran as the current local user. Upgrade deletes those historical secrets rather
  than migrating them, Settings reads only verified background status, and the
  token reveal/copy UI is removed.

### Removed

- Decorative CSS that nothing used: frosted-glass surfaces, a violet-to-pink
  gradient text fill, a pulsing glow, a float animation, and the glow shadow
  token. Pulsing is kept only for a dropped connection and a live stream.

### Fixed

- **Theme Cards All Previewed The Same Colour**: the restyle routed every
  theme's accent class through the live `--accent-primary` token so the whole
  app recolours on switch — correct everywhere except the picker, where all six
  preview swatches painted the currently active accent. Swatches now use each
  theme's own hex.

- **Seeking Snapped Back After Buffering**: every incoming WebSocket message —
  heartbeats fire every five seconds — raised a 300 ms suppression window, and
  a viewer's seek completing inside it was silently dropped. The server then
  kept the old position and its next heartbeat saw over three seconds of drift
  and yanked the viewer back to where they seeked away from. The window was
  wrong both ways, since `seeked` fires only after buffering: server-commanded
  seeks completing late were echoed back as user seeks. Programmatic seeks are
  now matched by their landing position, a viewer's seek always reaches the
  room, and drift correction waits out an in-flight seek instead of correcting
  against a stale heartbeat.

- **Every Member Paid A Full Extraction For The Same Video**: `/api/resolve`
  never consulted its own cache, so the sender extracted once to paste, then
  the `set_video` broadcast made every member — sender included — extract the
  same URL again, several seconds each. A fresh cached resolution is now
  returned directly; within the cache TTL a room of any size pays one
  extraction per video.

- **A Full Cache Stopped Caching Instead Of Evicting**: the proxy checked the
  budget and skipped the write once it was reached, so the first few gigabytes
  to arrive kept the space and everything afterwards went to the CDN until the
  janitor's next sweep trimmed back to exactly the limit. Measured in
  production across one session: 41 GB served, 37 cache writes, 2 disk hits,
  and an empty cache directory. A full cache now evicts oldest-first to admit
  new content, in batches so the directory scan is amortised, and admitted
  bytes are reserved against the measured size — without that, every write
  inside one ten-second measurement window read the same stale total and the
  budget was never seen to be reached. A follow-up review closed two gaps in
  that fix: a cancelled transfer — which seeking produces constantly — now
  returns its reservation instead of leaving a phantom that could refill the
  budget, and a body shorter than the origin promised is discarded rather than
  cached under a meta claiming the full range, which a later disk hit would
  have replayed as a 206 whose body does not match.

- **Long Livestream VODs Buffering Forever**: a segment index carries 12 bytes
  per segment, so a VOD's `sidx` outgrows the fixed 64 KB probe at roughly 7.5
  hours — measured 56 KB at 6.5 hours, 101 KB at 12, 159 KB at 19. Renditions
  whose index did not fit were dropped. Audio segments are longer, so audio's
  index is about half the size of video's: between roughly 8 and 15 hours every
  video probe failed while audio succeeded, and the manifest that came out had
  sound and no picture. The player then buffered forever on a video track
  nobody had declared, and seeking could never complete. A truncated `sidx`
  header states its own size, so the probe now asks for exactly that (bounded
  by `MANIFEST_MAX_INDEX_BYTES`), and losing every representation of one media
  type is reported as an error rather than served as half a manifest.
- **Renditions That Could Never Play Are No Longer Offered**: WebM/Matroska
  keys its segments in a Cues element this project does not index, so every
  WebM rendition cost a probe and was then dropped. They are excluded before
  the quality ladder is built; a container that does not identify itself is
  still left for the probe to judge.

- **Volume Jumping To 100% On The Next Queue Item**: queue advancement
  intentionally remounts the player, and a new `<video>` starts at the browser
  defaults. Persisted preferences updated React after hydration, but a mount-only
  effect had already copied `volume=1` into the element and never ran again, so
  the slider showed the stored value while the sound was full volume. Audio
  preferences now use a hydration-safe local-storage store and React continuously
  applies the same volume/mute state to each physical media element.

- **Endless Buffering, and Paused Videos Resuming Themselves**: the MSE playback engine
  was rebuilt whenever room state changed. Its setup effect depended on `autoPlay` (which
  mirrors play/pause) and `initialTime` (which every seek and every 5-second heartbeat
  rewrites), so the player was destroyed and the manifest reloaded every few seconds
  during normal playback. That rebuffered from zero, and detaching the media element
  fired a `pause` the room broadcast as real while the following reload autoplayed and
  broadcast a real `play` — so a paused room resumed itself. Both values are now read at
  load time and the engine is keyed on the stream alone.

- **A Second Viewer Having To Press Play**: a page that has had no user gesture
  may not start audible playback, and the rejected `play()` promise is the only
  signal the browser gives — the element simply stays paused. Every call site
  swallowed that rejection into a `console.log`, and the `play` message
  broadcast by another member did not even attach a `catch`, so a friend
  joining a room that was already playing sat on a still frame with nothing to
  tell them why. A refused start is now retried muted, since being in sync
  without sound is much closer to what the viewer wanted than being stopped, and
  one click restores the audio. If even muted playback is refused, the player
  says so and offers the click the browser is waiting for.

- **Playing An Older Video From A Room's Queue**: `/api/dash-manifest` answered
  `404 "Video has not been resolved yet. Call /api/resolve first."`, which the
  player reported as "the video could not be loaded" (Shaka 1001). Stream URLs
  expire after a couple of hours and the format cache lives in process memory,
  so anything left in a queue — or anything at all after a restart — arrived
  there with nothing cached. The endpoint now resolves on demand and caches the
  result, sharing one code path with `/api/resolve`. The room page also stopped
  mounting the player on the queued copy's expired URLs while its own re-resolve
  was still running, which is what made the failure stick; every member now sees
  the resolving indicator instead of an empty room.

- **Seeking Far Into A Video**: jumping an hour in stalled for a long time
  while playing from the start did not. googlevideo accepts a byte range two
  ways and they are not equivalent: a `Range` header goes through its throttled
  progressive path, while the `range=start-end` query parameter — what yt-dlp
  uses — returns the same bytes at full speed (measured on one 720p rendition,
  1 MB at the same offset: 122 ms via the header, 29 ms via the parameter). The
  proxy now uses the parameter and synthesises the 206 it owes its caller, since
  the response comes back as a plain 200. Alongside it, Shaka's rebuffering goal
  drops from 12s to 4s: that goal is paid in full on every seek with an empty
  buffer, and it had been raised against stalling that turned out to be the
  player reloading itself.
- **Cached Entries Are Whole Or Absent**: the janitor aged and evicted each file
  on its own, so a cached body could outlive its metadata sidecar or the
  reverse — leaving something that can never be served but still counts against
  the budget. Sidecars now expire and are evicted with their body, and orphans
  of either kind are swept.

### Performance

- **Ranged Segments Are Cached On Disk Again**: every request the MSE engine makes carries
  a `Range` header, and the persistent cache could not answer one — it was keyed on a 10MB
  position bucket, so it had no way to describe an exact range and was bypassed for
  anything ranged. Entries are now keyed on the exact range and store the origin's
  `Content-Range` and length, so a hit is byte-identical to the miss it replaces. A
  re-watch, a backwards seek, or a second viewer in the room no longer costs another trip
  to the CDN. Entries fetched with a viewer's cookies stay scoped to that viewer.
- **Pooled Upstream Connections and Buffered Media Responses**: the nginx upstreams had no
  `keepalive` directive, so clearing `Connection` pooled nothing and a fresh TCP connection
  was opened per segment; `proxy_buffering` was off, which pinned a backend task and its
  CDN connection for the whole of a slow intercontinental delivery.

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
