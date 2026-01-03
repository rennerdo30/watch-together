# Issues & Roadmap Tracker

## Active Issues (Bugs & Tech Debt)

**None** - All tracked issues have been resolved.

## Resolved

### Session: 2026-01-04
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
