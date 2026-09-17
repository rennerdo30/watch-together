/** Application-wide constants shared by more than one component. */

export const APP_NAME = 'Watch Together';

export const REPOSITORY_URL = 'https://github.com/rennerdo30/watch-together';

/** The browser extension lives in the `extension/` folder of the main repo. */
export const EXTENSION_SOURCE_URL = `${REPOSITORY_URL}/tree/main/extension`;

/** Packaged extension builds, served by the backend from the mounted source. */
export const EXTENSION_DOWNLOAD_PATH = '/api/extension/download';
export type ExtensionBrowser = 'chrome' | 'firefox';

/** Remembers that the viewer dismissed the "install the extension" hint. */
export const EXTENSION_HINT_DISMISSED_KEY = 'wt_extension_hint_dismissed';

/**
 * How long the server keeps a synced cookie copy in memory after the last
 * sync. Mirrors COOKIE_MEMORY_TTL_SECONDS in backend/core/config.py; a
 * contract test keeps the two in step.
 */
export const COOKIE_MEMORY_TTL_MINUTES = 30;

/** How often the landing page refreshes the list of active rooms. */
export const ROOM_LIST_POLL_INTERVAL_MS = 10_000;

/** Room ids are restricted to the same character set the backend accepts. */
export const ROOM_ID_ALLOWED_PATTERN = /[^a-zA-Z0-9-_]/g;
export const GENERATED_ROOM_ID_LENGTH = 6;

/** Resizable room sidebar bounds, in pixels. */
export const SIDEBAR_DEFAULT_WIDTH = 320;
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 600;

/** Reader-adjustable queue/member text size, in pixels. */
export const FONT_SIZE_DEFAULT = 15;
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 24;

/** How long a "copied to clipboard" confirmation stays visible. */
export const COPY_FEEDBACK_DURATION_MS = 2000;

/**
 * Origin the browser should call for API and WebSocket requests.
 *
 * Empty by default, which keeps requests relative so the nginx reverse
 * proxy routes them in production. Set NEXT_PUBLIC_BACKEND_ORIGIN (for
 * example `http://localhost:8000`) to talk to the backend directly when
 * running the frontend and backend separately without nginx.
 */
export const BACKEND_ORIGIN = process.env.NEXT_PUBLIC_BACKEND_ORIGIN ?? '';

/**
 * Seconds of media the player buffers ahead of, and keeps behind, the
 * playhead.
 *
 * Buffering far ahead is what carries playback across a wobble on a
 * long-haul link: every segment crosses viewer -> Cloudflare -> tunnel ->
 * origin -> CDN, so a minute of cushion is a minute of not depending on
 * that path. What bounds it is memory rather than bandwidth — the browser
 * holds the buffered media, and an over-large buffer is evicted by the
 * media source rather than helping — and the fact that anything buffered
 * is discarded by a seek, a skip or a quality switch.
 *
 * The back buffer stays small on purpose: it only serves a short step
 * backwards, and it competes with the forward buffer for the same memory.
 */
export const SHAKA_BUFFER_GOAL_SECONDS = 180;
export const SHAKA_BUFFER_BEHIND_SECONDS = 30;

/**
 * hls.js buffers by seconds and by bytes, and reaches neither goal without
 * the other: the default size ceiling is 60 MB, which a high rendition
 * fills long before the length goal. Live streams are bounded by the
 * playlist rather than by these.
 */
export const HLS_BUFFER_LENGTH_SECONDS = 180;
export const HLS_MAX_BUFFER_LENGTH_SECONDS = 300;
export const HLS_BUFFER_SIZE_BYTES = 200 * 1000 * 1000;
export const HLS_BACK_BUFFER_SECONDS = 120;

/**
 * How much must be buffered before playback starts or resumes.
 *
 * This is paid in full on every seek: the buffer is empty at the new
 * position, so nothing is displayed until the goal is met. It was raised to
 * 12s while playback was stalling constantly, but that turned out to be the
 * player being torn down and reloaded every few seconds, not a thin
 * cushion. With that fixed, and the origin serving a ranged read at any
 * depth in about 20ms, a large goal buys little and costs a long stare at a
 * spinner after every jump.
 *
 * `SHAKA_BUFFER_GOAL_SECONDS` still fills well ahead once playing, so a
 * stutter is protected against by the buffer that accumulates during
 * playback rather than by delaying its start.
 */
export const SHAKA_REBUFFER_GOAL_SECONDS = 4;

/**
 * Starting bandwidth guess, in bits per second.
 *
 * Shaka's default is optimistic enough to open on the highest rendition and
 * immediately stall on a long-haul link. Starting low costs a few seconds of
 * lower quality and lets the estimate climb from measurements instead of
 * from a guess.
 *
 * Only honoured with `useNetworkInformation` off: otherwise Chrome's
 * `navigator.connection.downlink` — a coarse guess, capped at 10 Mbps —
 * silently replaces it, and Shaka discards every measurement so far each
 * time that guess changes.
 */
export const SHAKA_INITIAL_BANDWIDTH_ESTIMATE = 700_000;

/**
 * Remembering the connection between loads (see `lib/bandwidth-memory.ts`).
 *
 * A measurement older than this says nothing about today's connection. The
 * discount turns a measurement into a guess a little below it, and the
 * ceiling keeps one wild sample from opening on a rendition that stalls.
 */
export const BANDWIDTH_MEMORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const BANDWIDTH_MEMORY_DISCOUNT = 0.8;
export const SHAKA_MAX_REMEMBERED_BANDWIDTH = 40_000_000;
/** How often the running estimate is written to storage while playing. */
export const BANDWIDTH_MEMORY_SAVE_INTERVAL_MS = 10_000;
/** Match the EWMA sampling thresholds used by our ABR manager and memory. */
export const SHAKA_ABR_MIN_SAMPLE_BYTES = 16_000;
export const SHAKA_ABR_MIN_TOTAL_BYTES = 128_000;

/**
 * How quickly the estimate follows measurements: half-lives, in seconds of
 * measured transfer time, of Shaka's fast and slow moving averages (defaults 2
 * and 5). Shorter ones let the estimate reach a better rendition sooner
 * after the cautious opening; the switch interval guards against flapping.
 */
export const SHAKA_ABR_FAST_HALF_LIFE = 1.5;
export const SHAKA_ABR_SLOW_HALF_LIFE = 4;

/**
 * Minimum seconds between automatic quality switches.
 *
 * Shaka's default of 8 keeps a viewer on the cautious opening rendition for
 * that long after the estimate already says a better one is affordable.
 * Four still leaves the estimate enough time to settle between switches.
 */
export const SHAKA_SWITCH_INTERVAL_SECONDS = 4;

/**
 * Seconds of buffered media a quality switch keeps.
 *
 * Shaka appends a switch after everything already buffered unless the
 * buffer is cleared, and this player buffers a minute ahead: a correct
 * upward switch was invisible for that long, which reads as "auto is stuck
 * on low". Clearing beyond this margin makes a switch visible in seconds.
 * The margin is what protects the other direction — a downward switch on a
 * congested link still keeps several times `SHAKA_REBUFFER_GOAL_SECONDS` of
 * already-downloaded media while the lower rendition refills.
 *
 * It is also what a switch costs: everything past the margin was fetched
 * and is thrown away. That price rises with the buffer goal, so the margin
 * is a good deal larger than the rebuffering goal.
 */
export const SHAKA_SWITCH_SAFE_MARGIN_SECONDS = 20;

/**
 * How many segments Shaka may fetch ahead of the one it needs next.
 *
 * Every segment costs a full viewer -> Cloudflare -> tunnel -> origin -> CDN
 * round trip, and fetching strictly one at a time leaves the link idle for
 * that whole wait — which also depresses the measured bandwidth the ABR
 * logic learns from.
 */
export const SHAKA_SEGMENT_PREFETCH_LIMIT = 2;

/**
 * How many ladder rungs above the drawing surface auto quality may go.
 *
 * The surface is the media element's height times the device pixel ratio.
 * The smallest rung that covers it is the floor; this many rungs above are
 * still allowed, because a higher rendition carries a better bitrate even
 * when downscaled. Bandwidth still gates the choice. Without any cap a
 * fast link was handed 4K AV1 for a laptop-sized player: 13–28 MB
 * segments, and every seek stared at a spinner until one had arrived.
 *
 * This is the headroom of the Balanced quality mode; `lib/quality-mode`
 * holds the other two a viewer can choose instead.
 */
export const ABR_LEVELS_ABOVE_SURFACE = 1;

/**
 * The shortest transfer the latency correction will work with, in
 * milliseconds. Subtracting the wait for headers from an interval this
 * short leaves noise, so the uncorrected time is kept instead.
 */
export const ABR_CACHE_LOAD_THRESHOLD_MS = 20;

/**
 * Below this many milliseconds Shaka treats a response as served from the
 * browser's cache and ignores it.
 *
 * This is Shaka's own default. It used to be set to the correction
 * threshold above, four times wider, which discarded the *fastest*
 * measurements: a viewer close to the origin is served a segment from the
 * proxy's memory cache in well under 20 ms, and that is a real transfer
 * over a real network, not a cache hit inside their browser. Throwing those
 * away biases the estimate down for exactly the viewers whose connection is
 * fast.
 */
export const SHAKA_CACHE_LOAD_THRESHOLD_MS = 5;

/**
 * How often the playback statistics re-read the live measurements — the
 * bandwidth estimate and the dropped-frame ratio — in milliseconds. They
 * change with every segment; the overlay only has to stay readable.
 */
export const PLAYER_STATS_REFRESH_MS = 1000;

/**
 * How close to the end of a video its successor is prepared, in seconds.
 *
 * The server does this on its own beat; the client asks as well, because
 * the server only sees rooms that are playing and only knows a duration it
 * was told. Both are idempotent: the work lands in the same caches.
 */
export const PREWARM_NEXT_VIDEO_SECONDS = 45;

/**
 * How rarely a player repeats an unchanged quality report to the server, in
 * milliseconds. A change — a different rung, cap or mode — is reported as
 * it happens; this only keeps a steady picture from talking every second.
 */
export const QUALITY_REPORT_INTERVAL_MS = 30_000;

/**
 * Codec preference, most efficient first.
 *
 * A player commits to one codec family for the session, so this decides
 * which ladder it adapts within. AV1 carries the same picture at roughly
 * half the bitrate of H.264, which is the difference between playing and
 * buffering on a constrained link.
 */
export const SHAKA_PREFERRED_VIDEO_CODECS = ['av01', 'vp09', 'avc1'];

/** Segment requests worth retrying before giving up, and the gap between them. */
export const SHAKA_SEGMENT_RETRIES = 4;
export const SHAKA_RETRY_BASE_DELAY_MS = 500;
export const SHAKA_REQUEST_TIMEOUT_MS = 45_000;
