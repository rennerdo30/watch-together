# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Resolved
- **[SYNC] Accurate Playback Badge**: Badge now shows actual player time via `onTimeUpdate` instead of independent ticker. Removed 1-second interval that caused drift.
- **[SYNC] Latency-Compensated Gradual Sync**: Server sends heartbeat every 5s with authoritative timestamp. Clients measure latency via ping/pong. Small drifts (< 3s) use playbackRate adjustment (1.05x/0.95x) instead of jarring seeks.
- **[PERFORMANCE] Position-Aware Caching**: Implemented 10MB bucket-based caching for DASH streams. Users seeking to similar positions now get cache hits instead of re-downloading.
- **[PERFORMANCE] Format Cache TTL**: Increased format cache from 15 minutes to 2 hours for better efficiency.
- **[BUG] Duplicate Dict Keys**: Fixed duplicate `members` and `queue` keys in `connection_manager.py`.
- **[BUG] DnD Sends Wrong Message**: Fixed drag-and-drop to use `queue_reorder` instead of non-existent `replace_queue`.
- **[BUG] Async Save Not Awaited**: Fixed 3 places where `_save_states()` wasn't awaited, causing silent data loss.
- **[MEMORY] Format Cache Cleanup**: Added periodic cleanup of expired format cache entries in background task.
- **[UX] Sidebar Width Persistence**: Fixed sidebar width not loading from localStorage on mount.
- **[VALIDATION] Room ID Sanitization**: Added input sanitization to prevent special characters in room IDs.
- **[CLEANUP] Unused onGoToLive Prop**: Removed unused prop from PlayerControls.
- **[TYPESCRIPT] Room Interface**: Added proper Room interface typing instead of `any[]`.
- **[QUEUE] Cookie Sharing for Queue Items**: Videos added by users with cookies now store `added_by` field; other users can play using the adding user's cookies as fallback.
- **[PERFORMANCE] Format Caching**: Resolved video formats are cached in memory for 15 minutes to avoid redundant yt-dlp calls on queue playback.
- **[PLAYER] DASH Audio Loop During Buffering**: Implemented preemptive buffer monitoring in `useDashSync.ts` - pauses audio before video stalls.
- **[PLAYER] DASH Missing Audio Race Condition**: Replaced 1s setInterval with RAF-based sync loop, all state in refs eliminates stale closures.
- **[PLAYER] DASH Seeking Performance**: Proper seek handling with `seeking`/`seeked` events, graceful heavy sync with timeout recovery.
- **[PLAYER] Refactor CustomPlayer**: Reduced from 1,251 to ~500 lines. Extracted into `useDashSync`, `useHlsPlayer`, `useAudioNormalization` hooks.
- **[PLAYBACK] Failed to find demuxer**: Fixed proxy manifest detection - was incorrectly treating `.ts` segments as manifests because URL contained `.m3u8`.
- **[AUDIO] Normalization UX**: Renamed to "Makeup Gain", changed unit to dB, fixed slider range.
- **[STABILITY] Player Flickering**: Fixed re-initialization loop caused by timestamp ticker dependency.
- **[SYNC] Status Badge**: Fixed desync/wrong timestamp using client-side ticker and optimistic updates.
- **[SYNC] Sync Threshold Setting**: Added user-configurable threshold slider (1-10s) to player settings.
- **[UX] Queue Drag & Drop**: Added drag handles, improved visual feedback, and clarified drop zones.
- **[PLAYBACK] Audio Autoplay**: Fixed `AudioContext` suspension logic to resume on play.
- **[PLAYBACK] Video Looping**: Fixed sync feedback loop caused by `currentTime(0)` on set_video.
- **[PLAYBACK] Autoplay**: Added muted fallback for browser autoplay policies.
- **[SYNC] Race Condition**: Changed `isInternalUpdate` from boolean to counter-based semaphore.
- **[ERROR] Missing Error Boundary**: Added `ErrorBoundary` component around CustomPlayer.
- **[STABILITY] Room State TTL**: Room state now persists for 5 minutes after last user leaves.
- **[STABILITY] Playback Persistence**: Saves current playback position on server restart.
- **[STABILITY] Proxy Client Isolation**: Each segment stream now uses its own HTTP client.
- **[MAINTENANCE] Background Cleanup**: Added automatic cleanup of stale rooms every minute.
- **[DX] Debug Panel**: Added debug panel showing WebSocket status, playback state, timestamp, etc.
- **[CLEANUP] Unused Dependencies**: Removed `icons-react` from package.json.
- **[CLEANUP] Dead Code**: Removed unused `formatWatchTime` function.
- **[CLEANUP] Stale Comments**: Updated Vidstack reference to hls.js.
- **[REFACTOR] Themes Extracted**: Moved themes to `lib/themes.ts`.
- **[FEATURE] Stream URL Refresh**: Added re-resolve on queue_play/video_ended to fix expired manifests.
- **[FEATURE] Generic Extractor**: Enabled yt-dlp generic extractor for unsupported sites.
- **[FORMAT] Flexible Format Selection**: Updated to `bestvideo*+bestaudio/best` for better compatibility.

### Previous Sessions
- **[PERSISTENCE] In-Memory State Loss**: Implemented JSON-based persistent storage with Docker volume mapping.
- **[SYNC] HLS Segment CORS Issues**: Added `/api/proxy` endpoint to handle CORS-restricted media segments.
- **[STABILITY] WebSocket Reconnection Handling**: Implemented auto-reconnect logic with status indicator.
- **[UX] Local Developer Identity Mock**: Added support for `?user=email@example.com` query param.
- **[DESIGN] Sleek UI Redesign**: Premium "Midnight Violet" theme with space-efficient layout.
- **[NETWORKING] WebSocket Dependency**: Fixed missing `websockets` library in Docker.
- **[FEATURES] Custom Rooms & Discovery**: Implemented live room list and custom room naming.
- **[PLAYBACK] Resolution Reliability**: Refined `yt-dlp` format selection and segment proxy.
