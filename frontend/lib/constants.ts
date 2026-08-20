/** Application-wide constants shared by more than one component. */

export const APP_NAME = 'Watch Together';

export const REPOSITORY_URL = 'https://github.com/rennerdo30/watch-together';

/** The browser extension lives in the `extension/` folder of the main repo. */
export const EXTENSION_SOURCE_URL = `${REPOSITORY_URL}/tree/main/extension`;

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

/** Seconds of media Shaka buffers ahead of, and keeps behind, the playhead. */
export const SHAKA_BUFFER_GOAL_SECONDS = 60;
export const SHAKA_BUFFER_BEHIND_SECONDS = 60;
export const SHAKA_REBUFFER_GOAL_SECONDS = 4;
