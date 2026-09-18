# Handoff

Where the project stands, for whoever picks it up next — a person or a
coding session. Keep it current: when something here stops being true,
change it in the same commit that makes it untrue. Newest state first.

## State as of 2026-09-15

- **Production**: https://w2g.renner.dev runs `main` (see `git log -1`). Deployed
  with `./deploy/deploy.sh`; CI (backend, frontend lint/build, Playwright
  e2e, extension checks, CodeQL, container publish) green on that commit.
- **Suites**: 757 backend tests (`cd backend && pytest`), 129 Playwright
  tests (`cd frontend && npm run test:e2e`), lint 0 errors / 14 warnings.
- **Admin panel** at `/admin`: rooms with members and a force-close, every
  cache tier with a clear action. Gated by `ADMIN_EMAILS` (set on the host
  via `./deploy/make-env.sh --set=ADMIN_EMAILS=a@x,b@y`; empty disables it).
- **Dependabot**: version-update PRs come weekly (grouped minor/patch). Both
  open ones were merged on 2026-09-15. *Security alerts are disabled* on the
  repo — enabling them (Settings → Code security) is worth doing.

## Reading per-viewer telemetry from the host

"Which rung is this viewer on, and why" is answered from the backend log,
not from a browser. Cloudflare Access is configured in production, so
`/api/admin/*` correctly returns 401 to anything inside the docker network —
that is deliberate and must stay that way.

```sh
./deploy/host-status.sh --quality --tail=4000          # one row per viewer
./deploy/host-status.sh --quality=alice@example.com    # plus her full trail
```

Each row carries the rung, the cap, the drawing surface, the pixel ratio,
the measured estimate, the dropped-frame ratio, the ladder size, the mode,
the engine, a verdict and the time it last changed. Viewers who have left
are still listed. The verdict names the input that decided the rung:
`surface-capped` (their player is small), `bandwidth-limited` (below the cap
with rungs left), `dropping-frames` (the decoder, not the link),
`saver-mode`, `single-rung-ladder`, `no-rung-reported`.

The raw lines are in the backend log, so a log bundle answers the same
question:

```sh
./deploy/host-status.sh --logs=backend --tail=4000 | grep 'Playback quality:'
```

Only *changes* reach INFO; the client's thirty-second repeats are at DEBUG
(`LOG_LEVEL=DEBUG` to see them). The same reports are kept in a bounded
in-memory ring for the admin panel's "Picture changes" card, which is the
browser's copy of the same thing and is lost on restart. Format and
thresholds: `backend/services/playback_quality.py`.

## Shipped recently (newest first)

| Commit | What | Why it mattered |
| --- | --- | --- |
| _pending_ | Live HLS latency derived from the playlist (`frontend/lib/live-latency.ts`) instead of counting declared target durations; catch-up by playback rate; hls.js interstitials off | A Twitch stream sat 24s behind the edge of a 30s window and stalled whenever a playlist refresh was late. See *Live HLS latency* below. |
| `3c53078` | Per-viewer telemetry in the backend log (one INFO line per change, with a verdict), `host-status.sh --quality`, and a bounded history the admin panel shows | The reports existed but only a browser signed in to Access could read them, and only while the viewer was connected — from the host every admin call is a 401, by design. See *Reading per-viewer telemetry from the host* above. |
| `c5b7a16` | Shared browser: a neko container in the room's player, opened and closed over the room socket, sessions minted server-side | The first thing the tunnel cannot carry. Media is WebRTC, the origin publishes nothing, so it is opt-in and reports *why* it is unavailable rather than offering a button — see *Shared browser* below. |
| _pending_ | Screen sharing carried by the server: `MediaRecorder` up `/ws/share/{room}`, a copy per viewer down, Media Source Extensions at the other end. The peer-to-peer transport, its signalling and `/api/webrtc/ice` are deleted | Peer to peer only worked when the two networks found each other, which behind this tunnel is a coin toss. The relay works from anywhere, at ~365 ms measured instead of ~200 ms, and at the server's bandwidth per viewer. See *Screen sharing* below. |
| `72c2de6` | Screen sharing: a member's gameplay on the room's player, peer to peer, signalling over the room socket | The first thing a room could watch that this server did not fetch — and the transport above replaced it. |
| _pending_ | Prewarming the next queue entry works: the deadline in a signed URL is read before it is fetched (`services/stream_expiry.py`), a queued video whose URLs have under `STREAM_URL_MIN_LIFETIME_SECONDS` left is re-resolved once through the coalesced resolve path, one that still cannot be prepared is left alone for `PREWARM_RETRY_AFTER_SECONDS`, and a refused speculative probe is a debug line | `a1a0a16` shipped it failing 100% in production: 126 `Probe of … returned 403` and nine × `Prepared 0/14 representations` for one advance. A queue entry keeps the resolve it was added with; past its `expire` every probe of it is refused, and it was re-probed on all nine heartbeats of the warming window. |
| `a1a0a16` | Prewarming: a skip's destination warmed at the right byte offset (new subsegment table from the `sidx`), the next queue entry probed and warmed near the end of the current video, from both server and client; player buffers 3 min | Every jump the room makes is scheduled, and each landed in an empty buffer on bytes nobody had fetched. **The next-entry half never worked as shipped** — see the row above. |
| `2f1ce07` | Auto quality: a viewer-chosen mode (Balanced/Highest/Data saver), a stats overlay that names the cap, the surface and the measured estimate, three sticky-low fixes, and per-viewer telemetry in the admin panel | A viewer on 1 Gbit was always on a low rendition and nothing could say why. An unmeasured surface (never-laid-out element) capped auto at the ladder's second rung and the cap outlived everything but a CSS resize; a pixel-ratio change never re-capped; the remembered bandwidth was the *last* sample, so one dip ratcheted down every later session. |
| `5bb0246` | Mono audio: per-viewer downmix in player settings, one graph (`useAudioProcessing`) for levelling and mono | Anything panned hard to one side was lost to a viewer on one earbud or with hearing on one side. The graph used to exist only while levelling was on. |
| `4413fc0` | Auto quality capped to the drawing surface + one rung of headroom (`ABR_LEVELS_ABOVE_SURFACE`), following resizes | A seek buffered ~5 s: auto had picked 2160p AV1 for a laptop-sized player, whose 13–28 MB segments take seconds each; nothing shows after a seek until one lands. |
| `a43b7e7` | Proxy refuses bare (unranged) GETs for large googlevideo files | A download manager on one viewer's Chrome pulled every rendition in full — 17 of 18.4 GB served — and starved real segment fetches. See *Performance* below. |
| `5d97eb5` | Seek bar hit area 4 px → 16 px, track thickens on hover | It was unhittable. |
| `58be603` | Format cache entries carry a schema version | A deploy adding a resolve field (chapters) stayed invisible for cached videos for up to 2 h. Bump `FORMAT_CACHE_SCHEMA_VERSION` whenever the resolve response shape changes. |
| `dc203ed` | Click on faded controls reveals them instead of pausing; bar never fades under the pointer | "Phantom controls": a click that arrived with the wake-up mouse move fell through to click-to-pause and paused the whole room. |
| `96595cd` | Chapters (YouTube sections): seek-bar notches, hover/current name, sidebar tab; picking one is a room-wide seek | |
| `58dfa31` | Queued videos resume from saved watch progress | |
| `1f8b632` | Memory-only cookies, room-scoped cookie lending, in-app extension download | |

Earlier history: `CHANGELOG.md` (kept per change) and `git log`.

## Screen sharing: the server carries it, and what that costs

The media goes through this process, on `/ws/share/{room}`: `MediaRecorder`
in the sharer's browser, a WebSocket up, a copy per viewer down, Media
Source Extensions at the other end. The peer-to-peer transport is gone —
the origin publishes no ports and the tunnel carries HTTP and WebSocket
only, so a direct path worked only when two networks happened to find each
other.

What to keep in mind when touching it:

- **It is fully testable now.** `frontend/e2e/screen-share.spec.ts` stubs
  the screen picker and asserts real playback — `readyState`, `videoWidth`,
  an advancing clock — plus the delay, measured from a pixel changing on
  the sharer's canvas to the same pixel decoded by a viewer. Locally that
  is ~365 ms; the floor is `SHARE_TIMESLICE_MS`, because nothing can be
  relayed before its chunk is complete.
- **A viewer may only be started at a cluster.** `services/webm.py` finds
  them. Starting one at an arbitrary chunk boundary fails permanently in
  Chromium (`CHUNK_DEMUXER_ERROR_APPEND_FAILED`) about one join in eight —
  that was measured, not reasoned about. The same rule is what a viewer
  that fell behind is restarted with.
- **The bandwidth is the server's.** One 8 Mbit/s capture and five viewers
  is 40 Mbit/s of upload from a single Python worker that also runs the
  segment proxy. `SHARE_RELAY_MAX_VIEWERS` and `SHARE_RELAY_MAX_ROOMS` are
  the ceilings; the quality presets are the other half of the bill.
- **What is not proven by any test**: behaviour on a genuinely slow viewer
  connection. The drop policy is driven directly in
  `backend/tests/test_share_relay.py` (a viewer whose queue is never
  drained), but no test throttles a real browser. If a viewer reports
  freezing, look for `Restarting … on the share in …` at INFO, which is one
  line per dropped backlog.

`WEBRTC_TURN_URL` survives for the shared browser alone; no browser is ever
handed ICE servers any more.

## Shared browser: what the tests cannot prove

Nothing in either suite has ever spoken to a neko container. The backend
tests stub it at its HTTP boundary (`tests/test_shared_browser.py`), and
`frontend/e2e/shared-browser.spec.ts` stubs the status endpoint, the session
endpoint and the `/neko/` document. What is proven is this server's half:
who may open it, that one room holds it at a time, that a screen share and
the browser cannot both be on the player, that no password appears in any
response, and that a room with no media path says so.

**Unverified from a sandbox, and worth checking first on a real host:**

- that neko 3.1.5 accepts `POST /neko/api/login` and returns a usable
  `NEKO_SESSION` cookie, and that re-setting that token as our own cookie on
  `/neko` authenticates the embed. This is read from neko's source
  (`server/internal/api/session.go`), not from a running container.
- that neko sends no `X-Frame-Options`/`frame-ancestors` of its own that
  would refuse the same-origin iframe. nginx's CSP now carries `frame-src
  'self'` for it.
- that media actually flows. That is the deployment question the feature is
  built around: `./host-status.sh --probe=/api/browser` reports what was
  *configured*, never what works. With the UDP option, check the range is
  open from outside; with TURN, check neko gathers a relay candidate — the
  frontend ICE list alone is the plausible mistake, and it looks fine until
  nobody sees anything.

## Live HLS latency: the declared target duration is a lie

`#EXT-X-TARGETDURATION` is an upper bound, not a measurement. Twitch declares
6 and ships `#EXTINF:2.000` segments, 15 of them — a 30s window. hls.js's
`liveSyncDurationCount` counts the *declared* number, so 4 put the playhead
24s behind the live edge with 6s of window left: one late playlist refresh
and the playhead was off the back, hls.js seeked, and the drift started over.
The two symptoms (20s behind, repeated stalls) were one cause.

`lib/live-latency.ts` derives the target from the playlist instead — the
median real segment duration × `LIVE_SYNC_SEGMENT_COUNT`, floored at
`LIVE_SYNC_MIN_SECONDS`, capped at `LIVE_SYNC_MAX_WINDOW_FRACTION` of
`totalduration`. Twitch: 6s. YouTube live (5s segments): 15s. Re-derived on
every playlist update, so a stream that changes segment length follows.

Three things are worth knowing before touching this again:

- **hls.js picks the starting fragment before you hear about the playlist.**
  Its own `LEVEL_LOADED` handlers run first and choose the start position
  from the config as it stands, so setting the target from that event is not
  enough: the hook also calls `hls.startLoad(hls.liveSyncPosition)` once per
  live source, while nothing is buffered and the element has not moved.
- **`enableInterstitialPlayback: false` is load-bearing.** With interstitials
  on, `hls.startLoad(position)` is intercepted by the interstitial controller,
  which restarts the primary stream at the position *it* last resolved — the
  alignment above was silently undone, and the fix looked like it did nothing
  (the playlist logged the new target; the player still loaded the old
  fragment). Nothing this player is handed carries HLS interstitials.
- **`maxLiveSyncPlaybackRate` only works while `lowLatencyMode` is on.**
  hls.js's latency controller returns early when it is off, so the flag stays
  on for live even though neither Twitch nor YouTube advertises LL-HLS parts
  or blocking reloads. With parts absent, that is all the flag does here.

The e2e proof is in `frontend/e2e/hls-auto-quality.spec.ts`: the arithmetic
is pinned as a pure function, and two live fixtures (Twitch-shaped and
YouTube-shaped) assert *which segment* the player asks for first — the only
observable that says where it decided to start.

## Performance: findings and open ideas

Measured on 2026-09-15 from the nginx media log (`./deploy/host-status.sh
--perf --tail=4000`) and the backend log.

**Findings**

- The proxy itself is fast: of ~2,900 ranged segment transfers, 92 % under
  200 ms, none over 5 s; average segment 513 KB (82 % between 10 KB and 1 MB).
- **The bytes went elsewhere**: 35 whole-file GETs (no `Range` header, no
  `range=` query) fetched entire googlevideo renditions — every quality of
  the AV1 ladder plus the audio track, several times each, 4.5 GB for one
  rendition alone — 17 GB out of 18.4 GB served. No player does this
  (media elements send `Range: bytes=0-`; Shaka and hls.js request exact
  spans). It is a download manager / video-sniffer extension on the Windows
  Chrome client in the room. Now refused server-side (`is_whole_file_grab`
  in `backend/services/gvs_range.py`); the refusal is logged with identity
  and user agent — check the backend log for `Refused whole-file media
  download` to see whether it is still trying, and tell that viewer.
- Segment caches barely participate across viewers: entries are keyed on
  exact byte spans, so two viewers at different qualities or positions share
  little. Server-side read-ahead (`prefetch_ahead`, 3 MB aligned blocks) and
  `start_initial_prefetch` on set_video / queue_add exist and run.
- **Seek latency = one segment of the active rendition.** After a seek the
  buffer is empty and Shaka shows nothing until a full segment (plus audio)
  has arrived. Segment size scales with the rendition: 4K AV1 ≈ 13–28 MB,
  1080p ≈ 2–5 MB. Hence the surface cap above; `SHAKA_REBUFFER_GOAL_SECONDS`
  (4 s) is the other lever, deliberately small already.
- **Nothing logs durations**: resolve (yt-dlp), manifest build (index
  probes), and first-segment time are not measured anywhere, so
  "paste → playing" cannot be broken down from production data yet. Per
  *transfer* this is now covered: every proxy sample carries the identity,
  the tier that answered (upstream/memory/disk) and the throughput, and the
  admin panel lists them — so "what was this viewer actually served?" is
  answerable even though "how long did the resolve take?" still is not.

**Ideas, in the order worth doing them**

1. **Instrument time-to-play.** Log and expose (admin panel → proxy
   section) per-video durations: yt-dlp extraction, manifest build, first
   media byte, `playing` event. Without this every other item is a guess.
2. **Resolve in the background.** Today the room page resolves on the
   client before sending `set_video` / `queue_add`, so the sender waits on a
   spinner for the whole yt-dlp run. Instead: send the URL immediately, show
   the entry as "resolving…", let the server resolve once (resolves are
   already coalesced) and broadcast the result. Same for queue adds.
3. ~~**Warm the next queue item.**~~ Done, and then fixed: the heartbeat
   probes every rendition of the next entry and warms its opening bytes once
   the current video is within `PREWARM_NEXT_VIDEO_SECONDS` of its end. The
   client asks too, for rooms the beat cannot see (paused, or no duration).
   Preferring the cached resolve over the queue entry was not enough — both
   can outlive the `expire` in their own URLs — so the deadline is now read
   from the URL (`services/stream_expiry.py`) and a video whose URLs have
   less than `STREAM_URL_MIN_LIFETIME_SECONDS` left is re-resolved before
   anything is fetched. See the row for the fix in *Shipped recently*.
4. ~~**Overlap segment round trips.**~~ Done: `segmentPrefetchLimit: 2`
   (`SHAKA_SEGMENT_PREFETCH_LIMIT`). Whether it moved anything is still
   unmeasured — that needs (1).
5. **Live streams**: a re-resolve rotates the playlist URL and restarts
   hls.js; keep an eye on the 5-minute live TTL versus token lifetimes.

## Known caveats

- `e2e/admin-panel.spec.ts` "closing a room … for good" flaked once during
  an unusually slow full run (8 min instead of 3); passes on rerun. Not
  investigated.
- Room tabs keep the bundle they loaded: after a frontend deploy, viewers
  must reload to get fixes. There is no update prompt yet.
- OpenCode has two sessions on this repo (2026-09-13); nothing since. Its
  log only shows the hourly file-watcher reboot and `Failed to fetch
  models.dev` when offline.

## Conventions that are enforced here

- **Every fix ships with a regression test that fails on the old code**;
  prove it by swapping the old file in (copy backups to a scratch dir, `git
  show HEAD:path > path`, run, restore) — never `git stash` for this.
- **No legacy paths**: replacements delete the old version in the same
  change. Latest stable dependencies.
- Source contracts in `backend/tests/test_deployment_contract.py` pin
  frontend footguns (visual language: no `uppercase` classes; the type scale
  `ui-label` / `ui-meta` / `ui-title` / `ui-heading`).
- `CHANGELOG.md` gets an entry per change under `[Unreleased]`.
- Commits: conventional style, body explains the mechanism. Only commit
  when build, lint and tests pass. Keep runner artifacts out (`test-results/`).

## How to verify and ship

```sh
cd backend  && ../venv/bin/python -m pytest -q
cd frontend && npm run build && npm run lint && npx playwright test
./deploy/deploy.sh                       # sync, build images, health-probe
./deploy/host-status.sh                  # host + env keys (values hidden)
./deploy/host-status.sh --probe=/api/rooms      # ask the backend from inside
./deploy/host-status.sh --logs=backend --tail=500
./deploy/host-status.sh --perf --tail=4000      # media transfer stats
./deploy/host-status.sh --quality --tail=4000   # which rung each viewer is on
./deploy/host-status.sh --diag                  # yt-dlp / PO provider
```

Playwright binaries: after a `@playwright/test` bump run
`npx playwright install chromium`.

## Where things are

- Sync and room state: `backend/connection_manager.py`, WS handler in
  `backend/main.py`; client side in `frontend/app/room/[id]/page.tsx`.
- Proxy, caches, googlevideo ranges: `backend/main.py` (`proxy_stream`),
  `backend/services/cache.py`, `backend/services/gvs_range.py`,
  `backend/services/prefetcher.py`.
- Resolve and manifests: `backend/services/resolver.py`,
  `backend/services/manifest.py`; format cache in
  `backend/services/database.py` (TTL, live TTL, schema version).
- Player: `frontend/components/custom-player.tsx`,
  `frontend/components/player-controls.tsx`, hooks under
  `frontend/components/player/hooks/`.
- Admin: `backend/api/routes/admin.py`, `frontend/app/admin/page.tsx`.
- Shared browser: `backend/services/shared_browser.py` (availability,
  sessions), `backend/api/routes/browser.py`, `browser_*` messages in
  `backend/main.py`, `browser_sessions` in `connection_manager.py`;
  `frontend/lib/shared-browser.ts` and the player area in the room page.
  The neko service is behind the `browser` compose profile, and the
  `/neko/` nginx location proxies it.
