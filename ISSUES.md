# Issues & Roadmap Tracker

## Active Issues (Bugs & Tech Debt)

### Tech Debt
- [ ] **[BACKEND] Refactor main.py**: Split into modules (api, core, services, tasks) for better maintainability.
- [ ] **[BACKEND] Database Migration**: Replace JSON-based persistence in `ConnectionManager` with a robust database (e.g., SQLite).
- [ ] **[BACKEND] Cache Request Deduplication**: Implement a tracker to prevent concurrent downloads of the same segment URL.
- [ ] **[BACKEND] Proxy Cookie Isolation**: Ensure HLS segment proxy uses user-specific cookies when available.
- [ ] **[FRONTEND] Component Decomposition**: Break down `RoomPage` and `CustomPlayer` into smaller, focused components.
- [ ] **[FRONTEND] Sync Hook Extraction**: Move WebSocket logic into a custom `useRoomSync` hook.
- [ ] **[FRONTEND] Normalization Hook**: Move Web Audio compressor logic into a dedicated `useNormalization` hook.
- [ ] **[SECURITY] Non-Root Containers**: Update Dockerfiles to run backend/frontend services as non-root users.

## Resolved

### Session: 2026-01-04
- [x] **[SYNC] Accurate Playback Badge**: Badge now shows actual player time via `onTimeUpdate` instead of independent ticker. Removed 1-second interval that caused drift.
- [x] **[SYNC] Latency-Compensated Gradual Sync**: Server sends heartbeat every 5s with authoritative timestamp. Clients measure latency via ping/pong. Small drifts (< 3s) use playbackRate adjustment (1.05x/0.95x) instead of jarring seeks.
- [x] **[PERFORMANCE] Position-Aware Caching**: Implemented 10MB bucket-based caching for DASH streams. Users seeking to similar positions now get cache hits instead of re-downloading.
- [x] **[PERFORMANCE] Format Cache TTL**: Increased format cache from 15 minutes to 2 hours for better efficiency.
- [x] **[BUG] Duplicate Dict Keys**: Fixed duplicate `members` and `queue` keys in `connection_manager.py`.
- [x] **[PERFORMANCE] Format Cache TTL**: Increased format cache from 15 minutes to 2 hours for better efficiency.
- [x] **[BUG] Duplicate Dict Keys**: Fixed duplicate `members` and `queue` keys in `connection_manager.py`.
- [x] **[BUG] DnD Sends Wrong Message**: Fixed drag-and-drop to use `queue_reorder` instead of non-existent `replace_queue`.
- [x] **[BUG] Async Save Not Awaited**: Fixed 3 places where `_save_states()` wasn't awaited, causing silent data loss.
- [x] **[MEMORY] Format Cache Cleanup**: Added periodic cleanup of expired format cache entries in background task.
- [x] **[UX] Sidebar Width Persistence**: Fixed sidebar width not loading from localStorage on mount.
- [x] **[VALIDATION] Room ID Sanitization**: Added input sanitization to prevent special characters in room IDs.
- [x] **[CLEANUP] Unused onGoToLive Prop**: Removed unused prop from PlayerControls.
- [x] **[TYPESCRIPT] Room Interface**: Added proper Room interface typing instead of `any[]`.
- [x] **[QUEUE] Cookie Sharing for Queue Items**: Videos added by users with cookies now store `added_by` field; other users can play using the adding user's cookies as fallback.
- [x] **[PERFORMANCE] Format Caching**: Resolved video formats are cached in memory for 15 minutes to avoid redundant yt-dlp calls on queue playback.
- [x] **[PLAYER] DASH Audio Loop During Buffering**: Implemented preemptive buffer monitoring in `useDashSync.ts` - pauses audio before video stalls.
- [x] **[PLAYER] DASH Missing Audio Race Condition**: Replaced 1s setInterval with RAF-based sync loop, all state in refs eliminates stale closures.
- [x] **[PLAYER] DASH Seeking Performance**: Proper seek handling with `seeking`/`seeked` events, graceful heavy sync with timeout recovery.
- [x] **[PLAYER] Refactor CustomPlayer**: Reduced from 1,251 to ~500 lines. Extracted into `useDashSync`, `useHlsPlayer`, `useAudioNormalization` hooks.
- [x] **[PLAYBACK] Failed to find demuxer**: Fixed proxy manifest detection - was incorrectly treating `.ts` segments as manifests because URL contained `.m3u8`.
- [x] **[AUDIO] Normalization UX**: Renamed to "Makeup Gain", changed unit to dB, fixed slider range.
- [x] **[STABILITY] Player Flickering**: Fixed re-initialization loop caused by timestamp ticker dependency.
- [x] **[SYNC] Status Badge**: Fixed desync/wrong timestamp using client-side ticker and optimistic updates.
- [x] **[SYNC] Sync Threshold Setting**: Added user-configurable threshold slider (1-10s) to player settings.
- [x] **[UX] Queue Drag & Drop**: Added drag handles, improved visual feedback, and clarified drop zones.
- [x] **[PLAYBACK] Audio Autoplay**: Fixed `AudioContext` suspension logic to resume on play.
- [x] **[PLAYBACK] Video Looping**: Fixed sync feedback loop caused by `currentTime(0)` on set_video.
- [x] **[PLAYBACK] Autoplay**: Added muted fallback for browser autoplay policies.
- [x] **[SYNC] Race Condition**: Changed `isInternalUpdate` from boolean to counter-based semaphore.
- [x] **[ERROR] Missing Error Boundary**: Added `ErrorBoundary` component around CustomPlayer.
- [x] **[STABILITY] Room State TTL**: Room state now persists for 5 minutes after last user leaves.
- [x] **[STABILITY] Playback Persistence**: Saves current playback position on server restart.
- [x] **[STABILITY] Proxy Client Isolation**: Each segment stream now uses its own HTTP client.
- [x] **[MAINTENANCE] Background Cleanup**: Added automatic cleanup of stale rooms every minute.
- [x] **[DX] Debug Panel**: Added debug panel showing WebSocket status, playback state, timestamp, etc.
- [x] **[CLEANUP] Unused Dependencies**: Removed `icons-react` from package.json.
- [x] **[CLEANUP] Dead Code**: Removed unused `formatWatchTime` function.
- [x] **[CLEANUP] Stale Comments**: Updated Vidstack reference to hls.js.
- [x] **[REFACTOR] Themes Extracted**: Moved themes to `lib/themes.ts`.
- [x] **[FEATURE] Stream URL Refresh**: Added re-resolve on queue_play/video_ended to fix expired manifests.
- [x] **[FEATURE] Generic Extractor**: Enabled yt-dlp generic extractor for unsupported sites.
- [x] **[FORMAT] Flexible Format Selection**: Updated to `bestvideo*+bestaudio/best` for better compatibility.

### Previous Sessions
- [x] **[PERSISTENCE] In-Memory State Loss**: Implemented JSON-based persistent storage with Docker volume mapping.
- [x] **[SYNC] HLS Segment CORS Issues**: Added `/api/proxy` endpoint to handle CORS-restricted media segments.
- [x] **[STABILITY] WebSocket Reconnection Handling**: Implemented auto-reconnect logic with status indicator.
- [x] **[UX] Local Developer Identity Mock**: Added support for `?user=email@example.com` query param.
- [x] **[DESIGN] Sleek UI Redesign**: Premium "Midnight Violet" theme with space-efficient layout.
- [x] **[NETWORKING] WebSocket Dependency**: Fixed missing `websockets` library in Docker.
- [x] **[FEATURES] Custom Rooms & Discovery**: Implemented live room list and custom room naming.
- [x] **[PLAYBACK] Resolution Reliability**: Refined `yt-dlp` format selection and segment proxy.

## Planned Features

- [x] **Drag-and-Drop Queue**: Improved native DnD with handles and visual cues.
