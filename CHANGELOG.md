# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Per-viewer telemetry is readable from the host

- Each viewer's quality report is now logged at INFO whenever the picture
  **changes** — one greppable line with the member, the room, the rung, the
  cap, the drawing surface, the pixel ratio, the measured estimate, the
  dropped-frame ratio, the ladder size, the mode and the engine. A steady
  picture's thirty-second repeats stay at DEBUG, so a quiet room writes
  nothing. Reports were previously visible only through
  `GET /api/admin/overview`, which needs a browser signed in to Cloudflare
  Access: from the host every admin call correctly returns 401, so nobody
  could answer "which rung is this viewer on" from the machine, from a log
  bundle, or after the viewer had left.
- Each line ends with a **verdict** naming the input that best explains the
  rung: `surface-capped`, `bandwidth-limited`, `dropping-frames`,
  `saver-mode`, `single-rung-ladder` or `no-rung-reported`. The panel shows
  the same word, so both answers agree.
- `./deploy/host-status.sh --quality [--tail=N]` summarises those lines into
  one row per viewer — latest rung, every input, the verdict, how many times
  it changed and when it was last seen — and `--quality=<viewer>` adds that
  viewer's full trail. Viewers who have disconnected are still listed.
- The admin panel gained a **Picture changes** card, backed by a bounded
  in-memory history (`PLAYBACK_QUALITY_HISTORY_CAPACITY`) that outlives the
  connection; each of its cards is now a named landmark.
- Identity handling is unchanged: nothing weakens authentication, no bypass
  or shared secret was added, and the email appears only in the backend log
  (which already names the requester on every resolve, cookie lend and
  history ping) and in the admin-only endpoint. Nothing is written to disk.

### A shared browser in the room

- A room can put a **real browser running on the server** into its player:
  everyone watches the same page and the room's admin types into it. It runs
  as a [neko](https://github.com/m1k1o/neko) container
  (`ghcr.io/m1k1o/neko/chromium:3.1.5`), takes the player area the way a
  screen share does, and pauses what was playing — the queue keeps its place,
  so closing the browser returns the room to it.
- **Off by default, and it says why.** neko's picture is WebRTC media, and
  cloudflared carries HTTP and WebSocket only, so this is the one feature in
  the stack that cannot work on the tunnel alone. It needs either a UDP range
  published on the host with the public address announced as an ICE candidate
  (`BROWSER_UDP_PORTS` + `BROWSER_PUBLIC_IP`, published by the separate
  `deploy/docker-compose.browser-udp.yml`) or a TURN relay
  (`BROWSER_ICE_SERVERS`, alongside the `WEBRTC_TURN_*` values screen sharing
  already uses). With neither, the room names the missing piece instead of
  offering a button that opens a black rectangle.
- **No password ever reaches a browser.** The backend logs into neko over the
  internal network and hands each member the resulting session as a cookie
  scoped to `/neko`; the room's admin gets neko's admin session (control) and
  everyone else the user session. Minting is refused unless the room has the
  browser open, so the endpoint is not a way to obtain a neko login.
- One container serves the whole instance, so a second room is told which
  room is using it, and a room releases it when its last member leaves — the
  container keeps its tabs, so reopening returns to the same page.
- The service only starts under `--profile browser`; nginx proxies `/neko/`
  through a variable upstream so an absent container is a 502 on that path
  rather than an nginx that refuses to start.

### Fixed

- `WEBRTC_TURN_URL` set without `WEBRTC_TURN_USERNAME` and
  `WEBRTC_TURN_CREDENTIAL` disabled **screen sharing entirely**. A TURN entry
  with blank credentials does not merely fail to relay: `new
  RTCPeerConnection(...)` throws on it, so no peer connection was built at
  all, including the direct ones that never needed a relay. `/api/webrtc/ice`
  now drops a half-configured relay and logs why. Found while setting up the
  shared browser, whose instructions are the first thing here that asks an
  operator to fill those values in.

### Cookies are never stored

- Cookies now reach the server only through the browser extension and live in
  process memory until 30 minutes after the last sync, until the member
  disconnects the extension, or until the process ends. The database table and
  the per-user files are gone; a backend that held them removes them at
  startup. yt-dlp reads a RAM-backed scratch file that exists for one
  extraction. The web form for pasting cookies is removed, and no endpoint
  returns a cookie value.
- A member without the extension can still add videos: while a member who is
  signed in to YouTube, Twitch or Kick is in the room, that member's session
  resolves the link. Only single-video pages qualify — feeds, playlists,
  channels and history never — and only for members connected to the room.
- The room suggests installing the extension once to members without cookies,
  and Settings downloads a build packaged by the instance for Chrome/Edge and
  Firefox (the old links pointed nowhere). The nightly release uses the same
  packager and now includes a Firefox build.
- The extension syncs Kick cookies, gives every request a deadline,
  supersedes a sync that never finished, and catches up when the browser
  starts, when the instance is opened and when the user returns after a while.
- Every container resolves DNS over HTTPS through an AdGuard `dnsproxy`
  sidecar (`WT_SUBNET`, `WT_DNS_IP`). The image is pinned: cloudflared
  removed its `proxy-dns` command in 2026.2.0, and the deploy compose's
  floating `latest` tag turned that release into a crash-looping resolver
  while the pinned local compose kept working.
- The tunnel connector tracks `cloudflare/cloudflared:latest` in both compose
  files; the local file had drifted to 2024.12.2.

### Performance and playback reliability

- Reuse cached MP4 byte spans across different player range requests. Warm
  queued videos and bounded blocks ahead of DASH playback, using the stream
  owner's cookies and Googlevideo's fast range path. HLS prefetch runs in
  parallel and refills evicted segments. DNS validation runs off the event loop.
- Coalesce simultaneous resolves and extract only the selected video from
  playlist links. Room members use the server's refreshed queue entry without
  repeating resolution. Queue metadata updates preserve signed URL expiry.
- Start the room clock when media actually plays, keeping initial loading out
  of playback time. Process end events even beside heartbeats, publish removal
  before resolving the next entry, and clear the player when the queue ends.
- Restore missing Chrome cookie-sync alarms whenever the worker starts without
  postponing existing deadlines. Refreshed live formats receive a new cache age.

### Added

- **Share your screen with the room**: a member can put their own gameplay
  on the room's player, live. The picture travels browser to browser — this
  server relays only the handshake — which is both the lowest latency
  available and the reason it suits a handful of friends: every viewer
  costs the sharer another copy of the stream. Pick a window in the
  browser's own picker, with its sound; the video that was playing pauses
  and returns afterwards. One member shares at a time, anyone may start,
  and a sharer who closes their laptop ends it for everyone rather than
  leaving a frozen frame. Quality is a choice (1080p60, 1440p30, 720p30)
  with its upload cost stated, and the dialog says plainly that viewers
  connect directly and can therefore see the sharer's IP address. A relay
  for networks that refuse a direct path is a deployment setting
  (`WEBRTC_TURN_URL` and friends) rather than a code change.

- **The room prepares what it is about to need**: both of its jumps are
  known before they happen, and both used to land in an empty buffer on
  bytes nobody had fetched. A SponsorBlock skip now has its destination
  warmed while the sponsor is still playing — at the exact byte offset,
  read from the subsegment table in each rendition's index, and for the
  renditions viewers are actually fetching rather than the one the resolve
  called best. The next queue entry is prepared as the current video runs
  out: every rendition probed (which is what building its manifest spends
  its time on) and its opening bytes fetched, so the advance hits warm
  caches. The server does this from the position it already broadcasts; the
  player asks as well, which covers a room paused near the end of a video
  or an entry whose duration the server was never told.

- **Auto quality is now a choice, and it explains itself**: player settings
  gained an *Auto quality* mode — Balanced (the cap above, unchanged and
  still the default), Highest (follow the connection alone, ignoring the
  player's size) and Data saver (never sharper than the player can show).
  A viewer watching in a small window on a fast line can now take the other
  side of that trade; the mode lives in their browser and is never sent to
  the room. The Auto button names the rung auto settled on, and the
  statistics overlay reports the cap with the surface it was computed from,
  the *measured* bandwidth estimate separately from the rendition's declared
  bitrate, what is remembered from earlier sessions and how old it is, the
  dropped-frame ratio, and how many rungs this viewer's manifest offered.
  "Auto is stuck on low" is now a readable screen instead of a guess.

- **Per-viewer serving telemetry** for the admin panel: every proxy sample
  carries who asked and which tier answered (upstream, memory, disk) with
  the throughput a streamed transfer reached, and each viewer's player
  reports what it can see of its own picture — rung, cap, drawing surface,
  pixel ratio, bandwidth estimate, dropped frames — over the room socket.
  The open `/api/metrics/proxy` view deliberately omits identities: it is
  readable by any signed-in viewer.

- **Mono audio**: a per-viewer switch in player settings → Mono audio that
  folds every channel into one, so both speakers carry the same mix. Anything
  panned hard to one side is no longer lost to someone listening through a
  single earbud or hearing on one side. It applies to that viewer's own audio
  only, works with levelling on or off, and is remembered in their browser.

- **Chapters**: a video's chapters (YouTube's sections — set by the creator
  or read from timestamps in the description) travel with the resolved video.
  They are notched on the seek bar, named under the pointer while hovering
  and beside the time while playing, and listed in a Chapters tab in the
  sidebar. Picking one there is a room-wide seek: everyone jumps, not just
  the viewer who clicked.

- **Admin Panel** at `/admin`: live rooms with connected members and a
  force-close action, plus full cache inspection — the disk segment cache
  (usage against budget, newest entries, oldest age, disk free), the
  in-memory segment cache (size, hit rate), every cached format resolution
  (age, expiry, live flag) and the proxy transfer outcomes — each tier with
  its own clear action. Access is limited to the verified identities listed
  in the `ADMIN_EMAILS` environment variable; the default is empty, which
  disables the panel entirely.

### Changed

- The player buffers three minutes ahead instead of one (hls.js was also
  raised past the 60 MB size ceiling that stopped it reaching any length
  goal), so a wobble on the long path from the origin no longer reaches the
  viewer. What a quality switch discards grows with that buffer, so the
  margin a switch keeps was doubled to twenty seconds.


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

- **Room Names**: an admin can name a room after creation from the room
  settings. The name shows in the room header and the home-page listing and
  survives restarts; the id stays the address, so existing links keep working.

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

- **Every YouTube Livestream Arrived As An Ordinary Video**: a stream with
  DVR enabled showed no LIVE badge, a seek bar over a window that cannot be
  seeked, a running duration, and the room's position sync correcting every
  viewer towards a timestamp that means nothing on a live timeline. yt-dlp
  reported the stream correctly; the resolve response did not. `is_live` is a
  field yt-dlp fills in *while processing* a result, derived from
  `live_status`, and resolution extracts with `process=False` — so the raw
  YouTube result carried no `is_live` key at all and the response defaulted
  it to false. Liveness is now read the way yt-dlp derives it: `live_status`
  decides when the extractor set it, and the raw `is_live` flag answers for
  the extractors that set that instead.

- **Preparing The Next Queue Entry Warmed Nothing At All**: in production
  every probe of it was refused — 126 `403`s, `Prepared 0/14
  representations` nine times over, for a single advance. A queue entry
  keeps the resolve it was added with, and the URLs in it state the moment
  the CDN stops serving them; past that they answer `403` to everyone,
  cookies or no cookies. Warming re-probed those dead URLs on every
  heartbeat for the last 45 seconds of the video before them. A resolve is
  now checked against the deadline in its own URLs before anything is
  fetched, and a queued video whose URLs will not outlive the next ten
  minutes is resolved again first — once, through the existing coalesced
  resolve path, with the room's members lending the cookies. A video that
  still cannot be prepared is left alone for a quarter of an hour instead of
  being retried nine times — per room, since whether a re-resolve can find
  cookies is a fact about the room — its opening bytes are no longer fetched
  from the same dead URLs, and a rendition nobody asked for that cannot be
  read is a debug line rather than a warning per rendition (the one-line
  summary stays visible: fresh URLs and nothing readable is a different
  fault). The same check guards the manifest endpoint, where a cache entry
  that had outlived its URLs produced a manifest describing nothing; there
  an entry is only replaced once it has actually expired, because a source
  that signs short-lived URLs still plays.

- **Auto Quality Could Stick Low And Never Recover**: three ways, all
  invisible. A player whose element had not been laid out yet measured a
  drawing surface of zero pixels, which was treated as a very small player
  and capped auto at the second-lowest rung of the ladder — and the cap was
  only ever recomputed when the element's CSS box changed, so a viewer who
  never resized their window kept it for the whole session, through manual
  picks and back to Auto. An unmeasured surface now caps nothing. Changing
  the device pixel ratio — dragging the window to a monitor with different
  scaling — changes no CSS box at all, so the cap stayed computed for the
  old screen; it is now recomputed when the ratio changes. And what was
  remembered of the connection was the *last* estimate seen while playing,
  so a single dip discounted itself into the next session's opening guess,
  which chose a lower rendition, whose smaller segments measured slower
  still; the best estimate the connection reached is remembered instead.
  The statistics overlay can also forget it outright.

- **Fast Measurements Were Thrown Away And Upward Switches Were Invisible**:
  Shaka was told to ignore any response faster than 20 ms as a browser cache
  hit — four times its own threshold — which discarded exactly the
  measurements of viewers close enough to the origin to be served from the
  proxy's memory in that time. Its own default is used now. A correct upward
  switch was also appended behind everything already buffered, which for a
  player that buffers a minute ahead meant up to a minute before the viewer
  saw it; a switch now clears the buffer beyond a ten-second margin. Shaka
  also fetches two segments ahead instead of leaving the link idle for a
  round trip between them.

- **Seeks Buffered For Seconds Because Auto Picked 4K For A Laptop-Sized
  Player**: a fast connection was handed the 2160p AV1 rendition, whose
  segments are 13–28 MB each and take seconds to arrive; after a seek the
  buffer is empty, so nothing shows until a whole segment has landed. Auto
  quality is now capped to the drawing surface (element height × device
  pixel ratio) plus one rung of headroom for its better bitrate — a 4K
  monitor with a large player still gets 4K, a laptop gets 1080p — and the
  cap follows resizes and fullscreen. Bandwidth still gates the choice, and
  manual picks are not restricted.

- **Whole-File Media Grabs Starved Playback**: a download manager on one
  viewer's browser saved every googlevideo rendition the page touched, in
  full — bare GETs with no byte range, 17 of the 18 GB served in one window,
  every quality of the ladder including ones the player never used — and the
  small ranged fetches real playback depends on stalled behind them. No
  player ever requests a large media file without a range, so the proxy now
  refuses such requests up front, before any upstream work.

- **The Seek Bar Was Nearly Impossible To Hit**: its hover and click area
  was the 4px track itself. The zone is now four times taller; the track
  stays thin and thickens under the pointer, and the hover preview sits
  above the taller zone.

- **New Resolve Fields Were Invisible For Cached Videos**: a resolved video
  is cached for up to two hours, so a deploy that adds a field the client
  renders (chapters, most recently) changed nothing for any video already in
  the cache until its entry expired — the room's video showed no Chapters tab
  though yt-dlp reports fourteen. Cached entries now carry a schema version
  and are treated as misses when it differs from the running code's.

- **Phantom Controls Paused The Room**: the control bar fades after three
  idle seconds, and a click on where a control had been fell through to the
  video's click-to-pause — the pointer movement that brings the bar back and
  the click arrive together, before the overlay is interactive again. A viewer
  reaching for Settings (or quality, or anything after a buffering pause had
  let the bar fade) paused everyone. A click that arrives with the wake-up
  movement now only reveals the controls, and the bar no longer fades while
  the pointer rests on it.

- **DVR Live Streams Jumped Back To The Start Of Their Window**: on a live
  stream every player's position is relative to when *it* loaded the
  playlist, so no position is comparable across viewers — yet the room
  stored one viewer's position and the heartbeat hard-seeked everyone towards
  it every five seconds, dragging a YouTube DVR stream to the start of its
  window and rebuffering. Live rooms no longer sync positions at all: play and
  pause still propagate, but the live edge is the shared position and each
  player reaches it on its own. Scrubbing a DVR window stays local.

- **The Admin Panel Kept Showing Rooms The Server No Longer Had**: an action
  that failed (closing a room that was already gone answers 404) left the
  stale list standing, so the dead room stayed clickable and every click
  repeated "No such room". Actions now refresh the panel whether they
  succeed or fail, and a 404 is reported as "already gone" rather than as an
  error.

- **Closing A Room From The Admin Panel Looked Like A No-Op**: the backend
  closed every socket and deleted the room, but each member's page treated
  the dead socket as a network drop and reconnected three seconds later —
  recreating the room. The close is now announced in-band: members see why,
  are sent back to the start page, and nothing reconnects.

- **Live Streams Died Mid-Session With No Way Back**: a live stream's signed
  playlist URL expires on the CDN's clock, and once it did (Twitch, mid-watch)
  every proxied fetch answered 403 while the player burned its whole retry
  budget re-requesting the same dead URL. Live formats are now cached for
  minutes instead of hours — enforced on read as well, so entries written
  before this change cannot outlive their token either — and the player treats
  an upstream 403/410 as "this URL is dead": it asks the room page for a fresh
  resolve and reloads seamlessly instead of giving up.

- **Renaming A Room Looked Like It Did Nothing**: the rename worked, but
  nothing said so — the settings modal hides the header, the input already
  shows what was typed, and the address deliberately never changes. The
  renamer now gets a confirmation toast, and a refused rename (non-admins)
  answers the sender with an error instead of silence.

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
