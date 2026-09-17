/**
 * The room's shared browser: a real browser on the server, in the player.
 *
 * Two things are worth knowing before the button is drawn. Whether the
 * instance can do it at all — which is a deployment question, because the
 * picture is WebRTC and this deployment publishes no ports — and whether
 * some other room is already using it, since there is one container behind
 * every room on the instance.
 *
 * Both come from the same endpoint, so a room that cannot open it can say
 * why rather than offering a control that quietly does nothing.
 */

/** Why the instance cannot open a shared browser. Codes, worded here. */
export type BrowserUnavailableReason =
    | 'disabled'
    | 'no_media_path'
    | 'no_password';

/** How the picture is expected to leave the server. */
export type BrowserTransport = 'udp' | 'turn';

/** What the room has open, as the server describes it. */
export interface SharedBrowserSession {
    room_id: string;
    opened_by: string;
    title: string;
    opened_at: number;
}

export interface SharedBrowserStatus {
    enabled: boolean;
    available: boolean;
    reason: BrowserUnavailableReason | null;
    transport: BrowserTransport | null;
    running: boolean;
    /** Where the embed points, on this origin. */
    path: string;
    /** The room holding the instance's one browser, if any. */
    held_by_room: string | null;
    session: SharedBrowserSession | null;
}

/**
 * What the room tells a member when the browser cannot be opened.
 *
 * Deliberately not the operator's wording: a member cannot act on any of
 * this, so each one says what it means for them and who can change it.
 */
export const BROWSER_UNAVAILABLE_TEXT: Record<BrowserUnavailableReason, string> = {
    disabled: 'The shared browser is switched off in this instance\u2019s configuration.',
    no_password: 'The shared browser is not finished being set up in this instance\u2019s configuration.',
    no_media_path:
        'This instance has no way to send the browser\u2019s picture out. It needs either a UDP port range opened on the server or a TURN relay configured; both are server settings, and the admin panel lists what is missing.',
};

/** The same fact, when the container simply is not running. */
export const BROWSER_NOT_RUNNING_TEXT =
    'The shared browser is configured but its container is not running.';

const UNAVAILABLE_FALLBACK = 'The shared browser is not available on this instance.';

/** One sentence for whatever is wrong, or null when nothing is. */
export function browserUnavailableText(status: SharedBrowserStatus | null): string | null {
    if (!status) return UNAVAILABLE_FALLBACK;
    if (!status.available) {
        return status.reason
            ? BROWSER_UNAVAILABLE_TEXT[status.reason] ?? UNAVAILABLE_FALLBACK
            : UNAVAILABLE_FALLBACK;
    }
    if (!status.running) return BROWSER_NOT_RUNNING_TEXT;
    return null;
}

export async function fetchBrowserStatus(
    origin: string,
    roomId: string,
): Promise<SharedBrowserStatus | null> {
    try {
        const response = await fetch(`${origin}/api/browser?room=${encodeURIComponent(roomId)}`);
        if (!response.ok) return null;
        return await response.json() as SharedBrowserStatus;
    } catch {
        return null;
    }
}

/**
 * Ask the server to let this tab into the browser.
 *
 * It answers by setting a cookie scoped to the browser's own path; nothing
 * here ever sees a password, and the returned path is what the iframe loads.
 * `control` says whether this member got the session that can type.
 *
 * This depends on the app and the browser being one origin, which is what
 * nginx makes true in every real deployment: the cookie is set on the origin
 * that answers this call, and the iframe loads a path on the page's origin.
 * A development setup that points the frontend straight at the backend on
 * another port has two origins and the embed will not authenticate.
 */
export async function openBrowserSession(
    origin: string,
    roomId: string,
): Promise<{ path: string; control: boolean }> {
    const response = await fetch(
        `${origin}/api/browser/session?room=${encodeURIComponent(roomId)}`,
        { method: 'POST', credentials: 'include' },
    );
    if (!response.ok) {
        throw new Error('Could not get into the shared browser.');
    }
    return await response.json() as { path: string; control: boolean };
}
