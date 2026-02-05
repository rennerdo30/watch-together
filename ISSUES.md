# Known Issues & Roadmap

## Known Issues

### High Priority

#### Connection Limit Race Condition
- **Status**: Open
- **Description**: Per-room and per-user connection limit checks are performed outside any lock, creating a TOCTOU race. Concurrent WebSocket connections can bypass limits.
- **Impact**: Room could exceed `MAX_CONNECTIONS_PER_ROOM` (50) under concurrent connection bursts
- **Fix**: Move limit checks inside `manager.connect()` protected by `_state_lock`

#### SSRF DNS Rebinding
- **Status**: Open
- **Description**: `validate_proxy_url()` resolves DNS at validation time, but the actual HTTP request resolves DNS again. An attacker's domain could resolve to a public IP during validation, then rebind to a private IP before the request.
- **Impact**: Potential access to internal services via proxy endpoint
- **Fix**: Pin resolved IP and use it directly, or validate IP after DNS resolution in the HTTP transport layer

#### HTTP/2 Protocol Errors on Video Streaming
- **Status**: Partially Fixed
- **Description**: Video proxy occasionally returns `ERR_HTTP2_PROTOCOL_ERROR` with 206 Partial Content responses
- **Cause**: HTTP/2 connection reuse issues when streaming large video files through Cloudflare
- **Workaround**:
  - Added `Connection: close` header to proxy responses
  - Disabled chunked encoding for video proxy
  - If still occurring, disable "HTTP/2 to Origin" in Cloudflare settings

#### DASH Loading State Stuck
- **Status**: Fixed
- **Description**: Loading spinner stays visible while audio plays
- **Cause**: Effect re-running due to dependency changes after `{ once: true }` event listeners already fired
- **Fix**: Added readyState check and reduced effect dependencies

### Medium Priority

#### Unbounded In-Flight Request Cache
- **Status**: Open
- **Description**: `_in_flight_results` dictionary stores request results with fire-and-forget cleanup tasks. Under heavy load, cleanup may not run promptly, causing memory growth.
- **Impact**: Memory exhaustion under sustained high request volume
- **Fix**: Add maximum size limit with LRU eviction or periodic background cleanup

#### Room Lock Dictionary Memory Leak
- **Status**: Open
- **Description**: `_get_room_lock()` creates locks on-demand for any room ID. Locks for non-existent or deleted rooms persist forever.
- **Impact**: Slow memory leak proportional to unique room IDs seen
- **Fix**: Only create locks during room creation; validate room existence before lock creation

#### Incomplete Cookie Format Validation
- **Status**: Open
- **Description**: Netscape cookie validation only checks first 5 data lines. Malformed data after line 5 passes validation.
- **Fix**: Validate all data lines, not just `lines[:5]`

#### WebSocket Message Type Not Validated
- **Status**: Open
- **Description**: WebSocket message `type` field is not validated for type or length. Extremely long type strings consume memory.
- **Fix**: Add `isinstance(msg_type, str)` check and length limit (50 chars)

#### Extension Sync Missing Format Validation
- **Status**: Open
- **Description**: `/api/extension/sync` endpoint accepts cookie content without Netscape format or size validation, unlike the regular `/api/cookies` endpoint.
- **Fix**: Apply same validation as `/api/cookies` (format check + size limit)

#### Proxy Cookie Isolation
- **Status**: Open
- **Description**: HLS segment proxy doesn't use user-specific cookies when available
- **Impact**: Some region-locked segments may fail even with valid user cookies

#### Sidebar Resize setInterval Race
- **Status**: Open
- **Description**: Sidebar resize refs are reassigned on every render. Cleanup effect may use stale ref functions.
- **Fix**: Use stable `useCallback` references for event handlers

#### useDashSync setInterval Collision
- **Status**: Open
- **Description**: When `syncIntervalMs` changes, new interval is created before old one is cleared in the effect body.
- **Fix**: Clear existing interval before creating new one

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
- [x] **Security Hardening**: SSRF protection, CORS config, connection limits, auth gating, cookie validation
- [x] **Infrastructure Hardening**: Docker image pinning, resource limits, nginx security headers
- [x] **Extension Security**: Scoped permissions, local token storage
- [x] **Frontend Stability**: Fixed interval leaks, stale closures, AudioContext leaks, hydration mismatches

### Pending
- [ ] **Atomic Connection Limits**: Move limit checks inside `_state_lock`
- [ ] **DNS Rebinding Protection**: Pin resolved IPs for proxy requests
- [ ] **In-Flight Cache Bounds**: Add size limits to `_in_flight_results`
- [ ] **Cookie Validation (All Lines)**: Validate all lines, not just first 5
- [ ] **WebSocket Message Validation**: Type check and length limit on message types
- [ ] **Extension Sync Validation**: Apply cookie format validation to extension sync endpoint
- [ ] **Rate Limiting**: Add rate limiting to cookie upload endpoint
- [ ] **Proxy Cookie Isolation**: Use user-specific cookies in segment proxy
- [ ] **Unit Tests**: Add test coverage for critical paths
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
