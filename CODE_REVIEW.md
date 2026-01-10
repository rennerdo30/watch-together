# Watch Together - Code Review Report

**Date:** 2026-01-10
**Reviewer:** Claude Code
**Focus Areas:** Stability, Synchronization, Buffering, DASH Audio Issues
**Status:** ALL ISSUES RESOLVED

---

## Executive Summary

This review identified **26 issues** across stability, synchronization, and DASH audio handling. **All 26 issues have been fixed.**

| Category | Found | Fixed |
|----------|-------|-------|
| DASH Audio | 8 | 8 |
| Synchronization | 7 | 7 |
| Backend Stability | 7 | 7 |
| Proxy/Caching | 4 | 4 |
| **Total** | **26** | **26** |

---

## Issues Fixed (Initial Pass - 16 Issues)

### DASH Audio Issues

#### 1. MediaElementAudioSourceNode Recreation Error (CRITICAL - FIXED)
**File:** `frontend/components/player/hooks/useAudioNormalization.ts`

**Problem:** `createMediaElementSource()` throws if called twice on the same element.

**Fix:** Added global WeakMap to track already-connected elements and reuse existing source nodes.

#### 2. Multiple Concurrent audio.play() Calls (HIGH - FIXED)
**File:** `frontend/components/player/hooks/useDashSync.ts`

**Problem:** Six event handlers called `audio.play()` directly without using the `safeAudioPlay()` wrapper.

**Fix:** All `audio.play()` calls now routed through `safeAudioPlay()`.

#### 3. Background Tab Audio Recovery Loop (HIGH - FIXED)
**File:** `frontend/components/player/hooks/useDashSync.ts`

**Problem:** `onAudioPause` and `onAudioSuspend` handlers created infinite recovery loops.

**Fix:** Added recovery attempt tracking (max 5 attempts) with exponential backoff (100ms → 2s).

#### 4. Quality Switch Didn't Pause Both Elements (MEDIUM - FIXED)
**File:** `frontend/components/custom-player.tsx`

**Fix:** Quality switch now pauses both elements, waits for video ready, then resumes both with proper sync.

#### 5-6. Various Direct audio.play() Calls (MEDIUM - FIXED)
**File:** `frontend/components/player/hooks/useDashSync.ts`

**Fix:** `setMuted`, `onVideoPlay`, `onVideoCanPlay`, `onVideoSeeked` all now use `safeAudioPlay()`.

### Synchronization Issues

#### 7. Playback Rate Adjustment Desyncs DASH Audio (CRITICAL - FIXED)
**File:** `frontend/lib/hooks/useRoomSync.ts`

**Problem:** Room sync adjusted `video.playbackRate` without adjusting audio in DASH mode.

**Fix:** Added DASH mode detection. In DASH mode, only hard seeks are performed; playback rate manipulation is skipped.

#### 8. Backend Timestamp Race Condition (CRITICAL - FIXED)
**File:** `backend/connection_manager.py`

**Fix:** Added per-room `asyncio.Lock` for thread-safe state access.

#### 9. last_sync_time Updated on ALL State Changes (CRITICAL - FIXED)
**File:** `backend/connection_manager.py`

**Fix:** `last_sync_time` now only updated when `is_playing` or `timestamp` changes.

#### 10. Infinite Reconnection Loop (HIGH - FIXED)
**File:** `frontend/lib/hooks/useRoomSync.ts`

**Fix:** Added exponential backoff (1s → 30s) with max 15 attempts.

#### 11. Hard Seek Threshold Inconsistency (MEDIUM - FIXED)
**Fix:** Now uses `syncThresholdRef.current` consistently.

### Backend Stability Issues

#### 12. WebSocket Exception Swallowing in Broadcast (HIGH - FIXED)
**File:** `backend/connection_manager.py`

**Fix:** Now logs exceptions and removes dead connections.

#### 13. Missing WebSocket Cleanup on Handler Exception (CRITICAL - FIXED)
**File:** `backend/main.py`

**Fix:** Added `finally` block that always calls `disconnect_and_notify()`.

#### 14. TOCTOU Race in Room Cleanup (HIGH - FIXED)
**File:** `backend/connection_manager.py`

**Fix:** Re-checks active connections before deletion.

#### 15. Background Tasks Not Awaited on Shutdown (HIGH - FIXED)
**File:** `backend/main.py`

**Fix:** Tasks now awaited with `CancelledError` handling.

#### 16. get_sync_payload Race Condition (MEDIUM - FIXED)
**Fix:** Now makes deep copy of state before calculating timestamp.

---

## Issues Fixed (Second Pass - 10 Issues)

### DASH Audio Issues

#### R1. Heavy Sync Ignores AudioContext State (HIGH - FIXED)
**File:** `frontend/components/player/hooks/useDashSync.ts`

**Problem:** After heavy sync, `audio.play()` may succeed but produce no sound if AudioContext is suspended.

**Fix:** Added AudioContext suspension check and resume before playing audio in `performHeavySync()`.

#### R2. DASH Sync Cooldown Blocks Critical Corrections (HIGH - FIXED)
**File:** `frontend/components/player/hooks/useDashSync.ts`

**Problem:** After 5 failures, 32-second cooldown blocked even severe desync corrections.

**Fix:** Added emergency sync bypass for extreme desync (>2 seconds) that bypasses cooldown. Modified `performHeavySync()` to accept `emergencyBypass` parameter.

### Synchronization Issues

#### R3. Missing Latency Compensation in Seek (MEDIUM - FIXED)
**File:** `frontend/lib/hooks/useRoomSync.ts`

**Problem:** Seek operations didn't apply latency compensation like heartbeat did.

**Fix:** Added latency compensation to seek: `payload.timestamp + (latencyRef.current / 1000)`.

#### R4. Stale Closure in handleMessage (MEDIUM - FIXED)
**File:** `frontend/lib/hooks/useRoomSync.ts`

**Problem:** `handleMessage` read `roomState` directly but had stale closure.

**Fix:** Added `roomStateRef` to track current state and updated callback to use `roomStateRef.current`.

### Backend Stability Issues

#### R5. Members List Desynchronization (MEDIUM - FIXED)
**File:** `backend/connection_manager.py`

**Problem:** Dead connection cleanup didn't immediately update members list for remaining clients.

**Fix:** Added members list update broadcast after cleaning dead connections in `broadcast()`.

#### R6. Internal Update Counter Unused (LOW - FIXED)
**File:** `frontend/lib/hooks/useRoomSync.ts`

**Problem:** `internalUpdateCount` was incremented/decremented but never read.

**Fix:** Removed dead code.

### Proxy/Caching Issues

#### R7. No DASH Manifest Proxying (HIGH - FIXED)
**File:** `backend/main.py`

**Problem:** Only HLS manifests were rewritten; DASH manifests bypassed proxy.

**Fix:** Added `rewrite_dash_manifest()` function that handles `<BaseURL>`, `media`/`initialization` attributes, and `sourceURL` attributes. Updated proxy to detect and handle `.mpd` files and `application/dash+xml` content type.

#### R8. Cache TTL Mismatch (MEDIUM - FIXED)
**Files:** `backend/services/database.py`, `backend/core/config.py`

**Problem:** Config specified 7200s (2 hours) but `cache_format()` defaulted to 3600s (1 hour).

**Fix:** Changed `cache_format()` to use `FORMAT_CACHE_TTL_SECONDS` from config as default.

#### R9. Cache Key Collision Risk (MEDIUM - FIXED)
**File:** `backend/services/cache.py`

**Problem:** MD5 with 16-char prefix had theoretical collision risk.

**Fix:** Changed to SHA-256 with 24-char prefix for better collision resistance.

#### R10. Bucket Cache Race Condition (MEDIUM - FIXED)
**File:** `backend/main.py`

**Problem:** Cache file could be deleted between metadata read and file open.

**Fix:** Open cache file before returning StreamingResponse. Handle `FileNotFoundError` explicitly and fall through to upstream fetch.

---

## Files Changed

| File | Changes |
|------|---------|
| `frontend/components/player/hooks/useAudioNormalization.ts` | WeakMap for source nodes, disconnect() method |
| `frontend/components/player/hooks/useDashSync.ts` | safeAudioPlay everywhere, recovery limits, AudioContext resume, emergency sync bypass |
| `frontend/components/custom-player.tsx` | Quality switch coordination |
| `frontend/lib/hooks/useRoomSync.ts` | DASH mode detection, reconnect backoff, roomStateRef, latency compensation, removed dead code |
| `backend/connection_manager.py` | Room locks, last_sync_time fix, broadcast cleanup, members update |
| `backend/main.py` | WebSocket finally block, task shutdown, DASH manifest proxy, cache race fix |
| `backend/services/database.py` | Use config TTL for format cache |
| `backend/services/cache.py` | SHA-256 hash for better collision resistance |
| `CLAUDE.md` | Added note about review files |

---

## Verification

- Frontend build: **PASSING**
- Backend syntax check: **PASSING**

---

## Conclusion

All 26 identified issues have been fixed:

**DASH Audio:**
- No audio on reload: FIXED
- Audio loops: FIXED
- Audio desync with video: FIXED
- Background tab issues: FIXED
- AudioContext suspension: FIXED
- Emergency sync for extreme desync: FIXED

**Synchronization:**
- Timestamp race conditions: FIXED
- Latency compensation: FIXED
- Stale closures: FIXED
- Reconnection handling: FIXED

**Backend Stability:**
- WebSocket cleanup: FIXED
- Dead connection handling: FIXED
- Members list sync: FIXED
- Task shutdown: FIXED

**Proxy/Caching:**
- DASH manifest proxying: FIXED
- Cache TTL consistency: FIXED
- Cache key collisions: FIXED
- Cache race conditions: FIXED

The codebase is now significantly more stable and robust, with all identified issues resolved.
