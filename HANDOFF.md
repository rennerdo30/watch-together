# Handoff

Where the project stands, for whoever picks it up next — a person or a
coding session. Keep it current: when something here stops being true,
change it in the same commit that makes it untrue. Newest state first.

## State as of 2026-09-15

- **Production**: https://w2g.renner.dev runs `main` (see `git log -1`). Deployed
  with `./deploy/deploy.sh`; CI (backend, frontend lint/build, Playwright
  e2e, extension checks, CodeQL, container publish) green on that commit.
- **Suites**: 588 backend tests (`cd backend && pytest`), 104 Playwright
  tests (`cd frontend && npm run test:e2e`), lint 0 errors / 14 warnings.
- **Admin panel** at `/admin`: rooms with members and a force-close, every
  cache tier with a clear action. Gated by `ADMIN_EMAILS` (set on the host
  via `./deploy/make-env.sh --set=ADMIN_EMAILS=a@x,b@y`; empty disables it).
- **Dependabot**: version-update PRs come weekly (grouped minor/patch). Both
  open ones were merged on 2026-09-15. *Security alerts are disabled* on the
  repo — enabling them (Settings → Code security) is worth doing.

## Shipped recently (newest first)

| Commit | What | Why it mattered |
| --- | --- | --- |
| _this change_ | Mono audio: per-viewer downmix in player settings, one graph (`useAudioProcessing`) for levelling and mono | Anything panned hard to one side was lost to a viewer on one earbud or with hearing on one side. The graph used to exist only while levelling was on. |
| `4413fc0` | Auto quality capped to the drawing surface + one rung of headroom (`ABR_LEVELS_ABOVE_SURFACE`), following resizes | A seek buffered ~5 s: auto had picked 2160p AV1 for a laptop-sized player, whose 13–28 MB segments take seconds each; nothing shows after a seek until one lands. |
| `a43b7e7` | Proxy refuses bare (unranged) GETs for large googlevideo files | A download manager on one viewer's Chrome pulled every rendition in full — 17 of 18.4 GB served — and starved real segment fetches. See *Performance* below. |
| `5d97eb5` | Seek bar hit area 4 px → 16 px, track thickens on hover | It was unhittable. |
| `58be603` | Format cache entries carry a schema version | A deploy adding a resolve field (chapters) stayed invisible for cached videos for up to 2 h. Bump `FORMAT_CACHE_SCHEMA_VERSION` whenever the resolve response shape changes. |
| `dc203ed` | Click on faded controls reveals them instead of pausing; bar never fades under the pointer | "Phantom controls": a click that arrived with the wake-up mouse move fell through to click-to-pause and paused the whole room. |
| `96595cd` | Chapters (YouTube sections): seek-bar notches, hover/current name, sidebar tab; picking one is a room-wide seek | |
| `58dfa31` | Queued videos resume from saved watch progress | |
| `1f8b632` | Memory-only cookies, room-scoped cookie lending, in-app extension download | |

Earlier history: `CHANGELOG.md` (kept per change) and `git log`.

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
  "paste → playing" cannot be broken down from production data yet.

**Ideas, in the order worth doing them**

1. **Instrument time-to-play.** Log and expose (admin panel → proxy
   section) per-video durations: yt-dlp extraction, manifest build, first
   media byte, `playing` event. Without this every other item is a guess.
2. **Resolve in the background.** Today the room page resolves on the
   client before sending `set_video` / `queue_add`, so the sender waits on a
   spinner for the whole yt-dlp run. Instead: send the URL immediately, show
   the entry as "resolving…", let the server resolve once (resolves are
   already coalesced) and broadcast the result. Same for queue adds.
3. **Warm the next queue item.** At `queue_add` the format is cached and
   first segments prefetched, but the DASH manifest (index probes for every
   rendition) is not built until someone plays it. Build it at add time and
   again ~60 s before the current video ends if the entry is older than the
   index cache TTL; refresh the signed URLs at the same point if the cached
   format is near its TTL. The advance then hits caches all the way.
4. **Overlap segment round trips.** Each Shaka segment costs a full
   viewer→Cloudflare→tunnel→origin→CDN round trip (hundreds of ms from
   Japan); segments are fetched one at a time per stream. Try Shaka's
   `streaming.segmentPrefetchLimit` (2–4) so the next fetches are in flight
   while one completes. Measure with (1) before and after.
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
