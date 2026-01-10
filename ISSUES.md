# Known Issues & Roadmap

## Known Issues

### High Priority

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

#### Proxy Cookie Isolation
- **Status**: Open
- **Description**: HLS segment proxy doesn't use user-specific cookies when available
- **Impact**: Some region-locked segments may fail even with valid user cookies

#### Database Migration
- **Status**: Open
- **Description**: Room state uses JSON file persistence instead of SQLite
- **Impact**: Potential performance issues with many concurrent rooms

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

### Pending
- [ ] **SQLite Migration**: Replace JSON file persistence
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
