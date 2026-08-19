# Known Issues & Roadmap

Last verified against the codebase: 2026-08-19.

## Known Issues

### High Priority

#### SSRF in the Proxy Endpoint
- **Status**: Open
- **Description**: `validate_proxy_url()` in `backend/main.py` has three independent bypass paths:
  1. **Trusted-CDN suffix bypass**: `_is_trusted_cdn()` returns early *before* any IP validation and
     matches by hostname suffix only. An attacker-controlled subdomain of an allowlisted CDN domain
     (e.g. `*.fastly.net`, `*.akamaized.net`) skips SSRF validation entirely.
  2. **Unvalidated redirects**: the proxy client uses `follow_redirects=True` (max 3). Redirect
     targets are never re-validated, so a validated public URL can redirect to a private IP.
  3. **DNS rebinding**: validation resolves DNS once via `socket.getaddrinfo`, then the actual
     httpx request resolves again. An attacker's domain can resolve public during validation and
     rebind to a private IP for the request.
- **Impact**: Access to internal services via the proxy endpoint
- **Fix**: Validate the IP (not just the hostname suffix) for all hosts including trusted CDNs; pin
  the resolved IP for the actual request (custom transport/resolver); re-validate every redirect hop
  (`follow_redirects=False` + manual loop)

#### Proxy Cookie Isolation / Cross-User Credential Bleed
- **Status**: Open
- **Description**: `get_proxy_client()` creates one global httpx client with a shared cookie jar
  loaded from `data/cookies.txt`. `/api/proxy` does not authenticate the requester at all, so:
  - One user's cookies are sent upstream for every user's segment fetches.
  - The segment cache is keyed only by URL + range, so content fetched with one user's cookies can
    be served from cache to any other requester.
  - Region-locked segments may still fail for users whose own (valid) cookies are never used.
- **Impact**: Cross-user credential sharing and cache-based content leakage, not just availability
- **Fix**: Resolve the requesting user in `/api/proxy`, use their cookie file for upstream fetches,
  and include a user/cookie dimension in the segment cache key (or restrict cached entries to
  cookie-less fetches)

#### HTTP/2 Protocol Errors on Video Streaming
- **Status**: Open (worked around, root cause not found)
- **Description**: Video proxy occasionally returns `ERR_HTTP2_PROTOCOL_ERROR` with 206 Partial
  Content responses
- **Cause (suspected)**: HTTP/2 connection reuse issues when streaming large video files through
  Cloudflare
- **Workarounds in place**:
  - `Connection: close` header on proxy responses
  - Chunked encoding disabled for the video proxy
  - If still occurring, disable "HTTP/2 to Origin" in Cloudflare settings

### Medium Priority

#### Extension Sync Missing Rate Limiting
- **Status**: Open
- **Description**: `/api/extension/sync` validates cookie format and size (1MB) but has no rate
  limiting. The upload limiter is module-private to `backend/api/routes/cookies.py` and only guards
  `POST /api/cookies`.
- **Fix**: Share the rate limiter (or an equivalent) with the extension sync endpoint

#### Rate Limiter Is Process-Local
- **Status**: Open
- **Description**: The cookie-upload rate limiter is an in-memory, per-process dictionary. It resets
  on restart and does not coordinate across multiple workers or replicas.
- **Impact**: Limits are ineffective when running more than one backend process
- **Fix**: Back the limiter with shared storage if multi-worker deployment becomes a goal

#### In-Flight Cache Writes Outside Lock
- **Status**: Open (minor)
- **Description**: `_in_flight_results` is now bounded (max 100 entries, 30s TTL) and cleaned under
  `_in_flight_lock`, but the result writes happen outside the lock, so a waiter's read can race
  with eviction. Not an unbounded-growth issue.
- **Fix**: Move the result writes under `_in_flight_lock`

## Fixed Issues

Previously listed as open; verified fixed in the current code (2026-08-19):

- **Connection Limit Race Condition** — per-room and per-user limit checks now run inside
  `_state_lock` in `manager.connect()`, including the connection append
- **Unbounded In-Flight Request Cache** — bounded to 100 entries with a 30s TTL; cleanup runs
  synchronously under the lock instead of fire-and-forget
- **Room Lock Dictionary Memory Leak** — locks are deleted when rooms are cleaned up, and an orphan
  sweep removes locks for rooms that no longer exist (runs every 60s)
- **Incomplete Cookie Format Validation** — all data lines are validated, not just the first 5
- **WebSocket Message Type Not Validated** — `isinstance(str)` check, 50-char type limit, 100KB
  frame cap, and a JSON decode guard
- **Extension Sync Missing Format Validation** — `/api/extension/sync` now enforces the 1MB limit
  and full Netscape format validation (rate limiting still missing, see above)
- **Cookie Upload Rate Limiting** — `POST /api/cookies` limited to 10 uploads per user per 60s
- **Sidebar Resize setInterval Race** — resize handlers are stable `useCallback` references; cleanup
  removes the same function identities that were added
- **useDashSync setInterval Collision** — the existing interval is cleared at the top of the effect
  body before a new one is created
- **DASH Loading State Stuck** — readyState check added and effect dependencies reduced

## Tech Debt

### Completed
- [x] **Module Extraction**: Split `main.py` into modular structure
- [x] **Component Decomposition**: Break down `RoomPage` and `CustomPlayer`
- [x] **Sync Hook Extraction**: Move WebSocket logic to `useRoomSync` hook
- [x] **Settings Hook Extraction**: Move settings to `useRoomSettings` hook
- [x] **Non-Root Containers**: All services run as non-root users
- [x] **Cache Request Deduplication**: Prevent concurrent downloads of same segment
- [x] **DASH Player Hook**: Extract DASH initialization to `useDashPlayer`
- [x] **Callback Refs Pattern**: Applied to `useDashSync` to prevent stale closures
- [x] **Security Hardening**: SSRF validation (see open bypass paths above), CORS config, connection
  limits, auth gating, cookie validation
- [x] **Infrastructure Hardening**: Docker image pinning, resource limits, nginx security headers
- [x] **Extension Security**: Scoped permissions, local token storage
- [x] **Frontend Stability**: Fixed interval leaks, stale closures, AudioContext leaks, hydration mismatches
- [x] **Atomic Connection Limits**: Limit checks moved inside `_state_lock`
- [x] **In-Flight Cache Bounds**: Size limit + TTL on `_in_flight_results`
- [x] **Cookie Validation (All Lines)**: All data lines validated
- [x] **WebSocket Message Validation**: Type check, length limit, and frame size cap
- [x] **Extension Sync Validation**: Cookie format + size validation on extension sync endpoint
- [x] **Rate Limiting (Cookie Upload)**: Per-user limiter on `POST /api/cookies`

### Pending
- [ ] **SSRF Hardening**: Close the trusted-CDN suffix bypass, re-validate redirects, pin resolved IPs
- [ ] **Proxy Cookie Isolation**: Per-user cookies in the segment proxy + user-aware cache keying
- [ ] **Extension Sync Rate Limiting**: Apply the upload rate limiter to `/api/extension/sync`
- [ ] **HTTP/2 Streaming Root Cause**: Find and fix the underlying cause of `ERR_HTTP2_PROTOCOL_ERROR`
- [ ] **Unit Tests**: Add test coverage for critical paths (currently only auth tests exist)
- [ ] **E2E Tests**: Add Playwright tests for user flows

## Reporting Issues

Please use GitHub Issues to report bugs or request features:

1. **Bug Reports**:
   - Clear description of the issue
   - Steps to reproduce
   - Expected vs actual behavior
   - Browser and OS version
   - Console errors (F12 → Console)

2. **Feature Requests**:
   - Description of the feature
   - Use case / why it's needed
   - Any implementation ideas

3. **Questions**:
   - Check existing issues first
   - Include relevant context
