/**
 * Watch Together Cookie Sync - Background Service Worker
 *
 * Handles:
 * - Periodic cookie sync via alarms
 * - Manual sync trigger from popup
 * - API communication with Watch Together backend
 * - Network interception for HLS/MPD detection
 * - Send video to Watch Together room
 */

// Default domains to sync cookies from
const DEFAULT_DOMAINS = [
    '.youtube.com',
    '.twitch.tv',
    '.vimeo.com',
    '.dailymotion.com',
    '.crunchyroll.com'
];

// Sync interval in minutes
const SYNC_INTERVAL_MINUTES = 30;

// Store detected video streams per tab
const detectedStreams = new Map(); // tabId -> { url, type, timestamp, pageUrl }

// Sync mutex to prevent concurrent sync operations
let syncInProgress = false;

// Rate limiting for sync operations
let lastSyncTime = 0;
const MIN_SYNC_INTERVAL_MS = 5000; // 5 seconds between syncs

// Stream cleanup interval (1 hour max age)
const STREAM_MAX_AGE_MS = 60 * 60 * 1000;


/** Local-only key for the one active Watch Together connection. */
const ACTIVE_CONNECTION_KEY = 'activeConnection';

/**
 * Credential keys written by older extension builds.
 *
 * They are deleted, not migrated: sync storage can arrive from another
 * browser/user, and the flat local tuple can already be internally mixed after
 * a failed instance switch. Keeping either would preserve the defect this
 * migration exists to remove.
 */
const LEGACY_SYNC_CREDENTIAL_KEYS = [
    'token', 'userEmail', 'backendUrl', 'lastSync', 'lastSyncStatus'
];
const LEGACY_LOCAL_CREDENTIAL_KEYS = [
    'token', 'userEmail', 'backendUrl', 'instanceOrigins'
];

/** Serialises connection changes; the last request deterministically wins. */
let connectionQueue = Promise.resolve();
const connectionAttempts = new Map();

/** Turn any instance URL into a match pattern for its origin. */
function originPattern(instanceUrl) {
    const { origin } = new URL(instanceUrl);
    return `${origin}/*`;
}

/** Remove credentials that could have synchronized from another user. */
async function purgeLegacyCredentials() {
    await Promise.all([
        chrome.storage.sync.remove(LEGACY_SYNC_CREDENTIAL_KEYS),
        chrome.storage.local.remove(LEGACY_LOCAL_CREDENTIAL_KEYS),
    ]);
}

/** Read the active local connection, rejecting malformed partial records. */
async function getActiveConnection() {
    const stored = await chrome.storage.local.get([ACTIVE_CONNECTION_KEY]);
    const connection = stored[ACTIVE_CONNECTION_KEY];
    if (!connection || typeof connection.origin !== 'string' ||
        typeof connection.token !== 'string' || !connection.token) {
        return null;
    }
    try {
        const origin = new URL(connection.origin).origin;
        if (!['http:', 'https:'].includes(new URL(origin).protocol)) return null;
        return { origin, token: connection.token };
    } catch {
        return null;
    }
}

/** Clear only the credential tuple; portable preferences stay intact. */
async function clearActiveConnection() {
    await chrome.storage.local.remove([ACTIVE_CONNECTION_KEY]);
}

/** Fetch the token and its owner in one authenticated response. */
async function fetchInstanceConnection(origin) {
    const tokenResponse = await fetch(`${origin}/api/token`, {
        credentials: 'include',
        cache: 'no-store',
    });
    if (!tokenResponse.ok) {
        throw new Error(`Instance returned ${tokenResponse.status} for /api/token`);
    }
    const body = await tokenResponse.json();
    const token = body?.token?.id;
    const userEmail = body?.user_email;
    if (!token || !userEmail) {
        throw new Error('Instance did not return a token and its owner');
    }

    // Prove that the new token authenticates as the owner returned with it
    // before committing anything to storage.
    const status = await fetchTokenStatus({ origin, token });
    if (status.userEmail !== userEmail) {
        throw new Error('Instance returned a token for a different user');
    }
    return { connection: { origin, token }, userEmail };
}

/** Validate a token and return the identity bound to it by the backend. */
async function fetchTokenStatus(connection) {
    const response = await fetch(`${connection.origin}/api/extension/status`, {
        headers: { 'Authorization': `Bearer ${connection.token}` },
        cache: 'no-store',
    });
    if (response.status === 401) {
        const error = new Error('The saved extension token is no longer valid');
        error.code = 'invalid-token';
        throw error;
    }
    if (!response.ok) {
        throw new Error(`Instance returned ${response.status} for /api/extension/status`);
    }
    const body = await response.json();
    if (!body?.valid || !body.user_email) {
        throw new Error('Instance did not verify the token owner');
    }
    return {
        userEmail: body.user_email,
        lastSyncAt: body.last_sync_at || null,
        syncCount: body.sync_count || 0,
        hasCookies: Boolean(body.has_cookies),
    };
}

/** Fetch the identity of the browser's current Access session. */
async function fetchSessionIdentity(origin) {
    const response = await fetch(`${origin}/api/me`, {
        credentials: 'include',
        cache: 'no-store',
    });
    if (!response.ok) {
        throw new Error(`Instance returned ${response.status} for /api/me`);
    }
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
        throw new Error('Open the Watch Together instance and sign in again');
    }
    const body = await response.json();
    return body?.authenticated && body.email ? body.email : null;
}

/**
 * Verify the stored token and ensure it still belongs to the browser's current
 * signed-in user. A cached display email is never consulted.
 */
async function verifyActiveConnection({ checkSession = true } = {}) {
    const connection = await getActiveConnection();
    if (!connection) {
        return { connected: false, reason: 'not-connected' };
    }

    let tokenStatus;
    try {
        tokenStatus = await fetchTokenStatus(connection);
    } catch (err) {
        if (err.code === 'invalid-token') {
            await clearActiveConnection();
            return {
                connected: false,
                backendUrl: connection.origin,
                reason: 'invalid-token',
                error: err.message,
            };
        }
        return {
            connected: false,
            backendUrl: connection.origin,
            reason: 'unverifiable',
            error: err.message,
        };
    }

    if (checkSession) {
        let sessionEmail;
        try {
            sessionEmail = await fetchSessionIdentity(connection.origin);
        } catch (err) {
            return {
                connected: false,
                backendUrl: connection.origin,
                reason: 'unverifiable',
                error: err.message,
            };
        }
        if (!sessionEmail) {
            // The token is kept: an expired Access session says nothing about
            // who owns it, and signing back in restores the connection without
            // another permission prompt. Reporting "not connected" is enough to
            // stop a sync, so this viewer's cookies cannot reach the token's
            // account while the browser cannot say who is using it.
            return {
                connected: false,
                backendUrl: connection.origin,
                reason: 'signed-out',
                error: 'Sign in to the Watch Together instance, then reconnect',
            };
        }
        if (sessionEmail !== tokenStatus.userEmail) {
            await clearActiveConnection();
            return {
                connected: false,
                backendUrl: connection.origin,
                reason: 'account-changed',
                error: `The browser is signed in as ${sessionEmail}; reconnect the extension`,
            };
        }
    }

    return {
        connected: true,
        backendUrl: connection.origin,
        userEmail: tokenStatus.userEmail,
        lastSyncAt: tokenStatus.lastSyncAt,
        syncCount: tokenStatus.syncCount,
        hasCookies: tokenStatus.hasCookies,
        connection,
    };
}

/** Acquire and atomically commit one instance connection. */
async function connectInstanceNow(origin, syncAfterConnect) {
    const pattern = originPattern(origin);
    if (!await chrome.permissions.contains({ origins: [pattern] })) {
        return { success: false, error: 'Permission for this site was not granted' };
    }

    let acquired;
    try {
        acquired = await fetchInstanceConnection(origin);
    } catch (err) {
        console.warn('[WT Sync] Could not establish a connection:', err);
        return { success: false, error: err.message };
    }

    // One write means an origin can never be paired with another origin's
    // token, even if a previous or simultaneous attempt failed.
    await chrome.storage.local.set({
        [ACTIVE_CONNECTION_KEY]: acquired.connection,
    });

    const syncResult = syncAfterConnect
        ? await syncCookies({ allowReconnect: false })
        : null;
    return {
        success: true,
        backendUrl: origin,
        userEmail: acquired.userEmail,
        syncResult,
    };
}

/**
 * Connect to an instance without allowing permission/popup races to mix state.
 * Duplicate same-origin calls share one promise; different origins are
 * serialised, so a later request commits after an earlier one.
 */
function connectInstance(instanceUrl, { syncAfterConnect = true } = {}) {
    let origin;
    try {
        origin = new URL(instanceUrl).origin;
        if (!['http:', 'https:'].includes(new URL(origin).protocol)) {
            throw new Error('unsupported protocol');
        }
    } catch {
        return Promise.resolve({ success: false, error: 'That does not look like a valid URL' });
    }

    const existing = connectionAttempts.get(origin);
    if (existing) return existing;

    const attempt = connectionQueue.then(
        () => connectInstanceNow(origin, syncAfterConnect),
        () => connectInstanceNow(origin, syncAfterConnect),
    );
    connectionQueue = attempt.catch(() => undefined);
    connectionAttempts.set(origin, attempt);
    attempt.then(
        () => connectionAttempts.delete(origin),
        () => connectionAttempts.delete(origin),
    );
    return attempt;
}

/** Revoke the active token best-effort, clear it locally, and drop permission. */
async function disconnectInstance() {
    const connection = await getActiveConnection();
    if (!connection) return { success: true };

    try {
        await fetch(`${connection.origin}/api/extension/token`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${connection.token}` },
            cache: 'no-store',
        });
    } catch (err) {
        console.warn('[WT Sync] Could not revoke the token during disconnect:', err);
    }

    await clearActiveConnection();
    try {
        // Manifest V2 grants host access up front, so the browser refuses to
        // drop it. Losing the credential is what disconnect has to guarantee.
        await chrome.permissions.remove({ origins: [originPattern(connection.origin)] });
    } catch (err) {
        console.warn('[WT Sync] Host permission was not removable:', err);
    }
    return { success: true };
}

/**
 * Initialize extension on install
 */
chrome.runtime.onInstalled.addListener(async () => {
    console.log('[WT Sync] Extension installed or updated');

    // Credentials from older builds were synchronized across devices and may
    // belong to another browser/user. Delete them rather than treating them as
    // a current connection; the user reconnects once under the new schema.
    await purgeLegacyCredentials();

    // Set default settings
    const settings = await chrome.storage.sync.get(['domains', 'autoSync']);
    if (!settings.domains) {
        await chrome.storage.sync.set({ domains: DEFAULT_DOMAINS });
    }
    if (settings.autoSync === undefined) {
        await chrome.storage.sync.set({ autoSync: true });
    }

    // Set up auto-sync alarm
    setupAutoSync();

});

/**
 * Finish connecting as soon as a host permission is granted.
 *
 * Chrome tears down the popup when the optional-permission prompt opens,
 * so any code after `chrome.permissions.request()` in the popup may never
 * run — the permission is granted and nothing else happens. Completing the
 * work here instead makes it independent of the popup's lifetime.
 */
chrome.permissions.onAdded.addListener((permissions) => {
    const origins = permissions.origins || [];
    if (origins.length === 0) return;

    (async () => {
        for (const pattern of origins) {
            // Patterns look like https://host/*; recover the origin.
            const origin = pattern.replace(/\/\*$/, '');
            try {
                const result = await connectInstance(origin);
                if (result.success) {
                    console.log('[WT Sync] Connected to', origin, 'as', result.userEmail);
                } else {
                    console.warn('[WT Sync] Could not finish connecting to', origin, '-', result.error);
                }
            } catch (err) {
                console.warn('[WT Sync] Error connecting to', origin, err);
            }
        }
    })();
});

/** A removed host permission invalidates a connection to that origin. */
chrome.permissions.onRemoved.addListener((permissions) => {
    const removed = new Set(permissions.origins || []);
    if (removed.size === 0) return;
    getActiveConnection().then((connection) => {
        if (connection && removed.has(originPattern(connection.origin))) {
            return clearActiveConnection();
        }
    }).catch(err => console.warn('[WT Sync] Permission cleanup failed:', err));
});

/**
 * Set up periodic auto-sync alarm
 */
async function setupAutoSync() {
    const settings = await chrome.storage.sync.get(['autoSync']);
    if (settings.autoSync !== false) {
        chrome.alarms.create('cookieSync', {
            periodInMinutes: SYNC_INTERVAL_MINUTES
        });
        console.log(`[WT Sync] Auto-sync alarm set for every ${SYNC_INTERVAL_MINUTES} minutes`);
    } else {
        chrome.alarms.clear('cookieSync');
        console.log('[WT Sync] Auto-sync disabled');
    }
}

/**
 * Handle alarm events
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'cookieSync') {
        console.log('[WT Sync] Auto-sync triggered');
        await syncCookies();
    } else if (alarm.name === 'streamCleanup') {
        cleanupOldStreams();
    }
});

/**
 * Set up periodic stream cleanup alarm
 */
chrome.alarms.create('streamCleanup', { periodInMinutes: 15 });

/**
 * Clean up old stream entries from the Map
 */
function cleanupOldStreams() {
    const now = Date.now();
    let cleaned = 0;
    for (const [tabId, stream] of detectedStreams.entries()) {
        if (now - stream.timestamp > STREAM_MAX_AGE_MS) {
            detectedStreams.delete(tabId);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`[WT Sync] Cleaned up ${cleaned} old stream entries`);
    }
}

/**
 * Listen for messages from popup/content scripts
 * Consolidated into a single handler for all message types
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
        case 'SYNC_NOW':
            syncCookies().then(result => sendResponse(result));
            return true;

        case 'GET_STATUS':
            getStatus().then(status => sendResponse(status));
            return true;


        case 'CONNECT_INSTANCE':
            connectInstance(message.instanceUrl).then(result => sendResponse(result));
            return true;

        case 'DISCONNECT_INSTANCE':
            disconnectInstance().then(result => sendResponse(result));
            return true;

        case 'RESET_EXTENSION':
            resetExtension().then(result => sendResponse(result));
            return true;

        case 'UPDATE_SETTINGS':
            updateSettings(message.settings).then(() => sendResponse({ success: true }));
            return true;

        case 'GET_DETECTED_STREAM':
            getDetectedStream(message.tabId).then(stream => sendResponse({ stream }));
            return true;

        case 'SEND_TO_ROOM':
            sendToRoom(message.roomId, message.url, message.pageUrl)
                .then(result => sendResponse(result));
            return true;

        default:
            return false;
    }
});

/**
 * Update portable extension settings.
 * Credentials are never accepted here: this is the sync-storage boundary.
 */
async function updateSettings(settings) {
    const portable = {};
    for (const key of ['domains', 'autoSync', 'lastRoomId']) {
        if (key in settings) portable[key] = settings[key];
    }
    await chrome.storage.sync.set(portable);
    if ('autoSync' in portable) {
        await setupAutoSync();
    }
}

/** Get current, backend-verified extension status. */
async function getStatus() {
    const [verified, local, sync] = await Promise.all([
        verifyActiveConnection(),
        chrome.storage.local.get(['lastSync', 'lastSyncStatus']),
        chrome.storage.sync.get(['domains', 'autoSync']),
    ]);
    return {
        connected: verified.connected,
        userEmail: verified.connected ? verified.userEmail : null,
        backendUrl: verified.backendUrl || null,
        connectionReason: verified.reason || null,
        connectionError: verified.error || null,
        lastSync: local.lastSync || null,
        lastSyncStatus: local.lastSyncStatus || null,
        domains: sync.domains || DEFAULT_DOMAINS,
        autoSync: sync.autoSync !== false,
    };
}

/** Reset both the local connection and portable preferences coherently. */
async function resetExtension() {
    await disconnectInstance();
    await chrome.storage.local.remove(['lastSync', 'lastSyncStatus', 'lastQueuedVideo']);
    await chrome.storage.sync.clear();
    await chrome.storage.sync.set({ domains: DEFAULT_DOMAINS, autoSync: true });
    await setupAutoSync();
    return { success: true };
}

/**
 * Convert browser cookies to Netscape format
 */
function toNetscapeFormat(cookies) {
    const lines = ['# Netscape HTTP Cookie File', '# Generated by Watch Together Cookie Sync', ''];

    for (const cookie of cookies) {
        // Netscape format: domain must start with . for subdomain access
        // If we add the dot, includeSubdomains MUST be TRUE for valid format
        const hasDot = cookie.domain.startsWith('.');
        const domain = hasDot ? cookie.domain : '.' + cookie.domain;
        const includeSubdomains = 'TRUE'; // Always TRUE when domain has leading dot
        const path = cookie.path || '/';
        const secure = cookie.secure ? 'TRUE' : 'FALSE';
        const expiry = cookie.expirationDate ? Math.floor(cookie.expirationDate) : 0;
        const name = cookie.name;
        const value = cookie.value;

        lines.push(`${domain}\t${includeSubdomains}\t${path}\t${secure}\t${expiry}\t${name}\t${value}`);
    }

    return lines.join('\n');
}

/**
 * Get cookies for configured domains
 */
async function getCookiesForDomains(domains) {
    const allCookies = [];

    for (const domain of domains) {
        try {
            const cookies = await chrome.cookies.getAll({ domain });
            allCookies.push(...cookies);
        } catch (err) {
            console.warn(`[WT Sync] Failed to get cookies for ${domain}:`, err);
        }
    }

    // Remove duplicates (same name + domain) and filter expired cookies
    const now = Date.now() / 1000; // Convert to seconds (cookie expiry is in seconds)
    const seen = new Set();
    const unique = allCookies.filter(cookie => {
        // Skip expired cookies (session cookies have no expirationDate)
        if (cookie.expirationDate && cookie.expirationDate < now) {
            return false;
        }
        const key = `${cookie.domain}:${cookie.name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    return unique;
}

/** Send one cookie payload with the active bearer token. */
async function postCookieSync(connection, netscapeContent, domains) {
    return fetch(`${connection.origin}/api/extension/sync`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${connection.token}`,
        },
        body: JSON.stringify({
            cookies: netscapeContent,
            domains,
            browser: 'chrome',
        }),
        cache: 'no-store',
    });
}

/**
 * Sync cookies only after the active token and current browser session agree
 * on the same user. A revoked token is reacquired once, never retried forever.
 */
async function syncCookies({ allowReconnect = true } = {}) {
    const startedAt = Date.now();
    if (startedAt - lastSyncTime < MIN_SYNC_INTERVAL_MS) {
        const waitSec = Math.ceil((MIN_SYNC_INTERVAL_MS - (startedAt - lastSyncTime)) / 1000);
        console.log(`[WT Sync] Rate limited, wait ${waitSec}s`);
        return { success: false, error: `Please wait ${waitSec}s before syncing again` };
    }
    if (syncInProgress) {
        console.log('[WT Sync] Sync already in progress, skipping');
        return { success: false, error: 'Sync already in progress' };
    }

    syncInProgress = true;
    lastSyncTime = startedAt;
    console.log('[WT Sync] Starting cookie sync...');

    try {
        let verified = await verifyActiveConnection();
        const reconnectOrigin = verified.backendUrl;

        if (!verified.connected && allowReconnect && reconnectOrigin &&
            await chrome.permissions.contains({ origins: [originPattern(reconnectOrigin)] })) {
            const reconnected = await connectInstance(reconnectOrigin, { syncAfterConnect: false });
            if (reconnected.success) verified = await verifyActiveConnection();
        }

        if (!verified.connected || !verified.connection) {
            const error = verified.error || 'Not connected to Watch Together';
            await chrome.storage.local.set({ lastSyncStatus: error });
            return { success: false, error };
        }

        const { domains = DEFAULT_DOMAINS } = await chrome.storage.sync.get(['domains']);
        const cookies = await getCookiesForDomains(domains);
        if (cookies.length === 0) {
            await chrome.storage.local.set({ lastSyncStatus: 'No cookies found' });
            return { success: false, error: 'No cookies found for configured domains' };
        }

        const netscapeContent = toNetscapeFormat(cookies);
        let connection = verified.connection;
        let response = await postCookieSync(connection, netscapeContent, domains);

        // Token regeneration invalidates the stored bearer. Reacquire it from
        // the current signed-in session and retry this payload exactly once.
        if (response.status === 401 && allowReconnect) {
            const origin = connection.origin;
            await clearActiveConnection();
            const reconnected = await connectInstance(origin, { syncAfterConnect: false });
            if (reconnected.success) {
                const fresh = await verifyActiveConnection();
                if (fresh.connected && fresh.connection) {
                    connection = fresh.connection;
                    response = await postCookieSync(connection, netscapeContent, domains);
                }
            }
        }

        if (!response.ok) {
            if (response.status === 401) await clearActiveConnection();
            const error = await response.json().catch(() => ({
                detail: `HTTP ${response.status}: ${response.statusText || 'Request failed'}`,
            }));
            throw new Error(error.detail || `HTTP ${response.status}`);
        }

        await response.json();
        const syncedAt = Date.now();
        await chrome.storage.local.set({
            lastSync: syncedAt,
            lastSyncStatus: 'Success',
        });

        console.log(`[WT Sync] Synced ${cookies.length} cookies from ${domains.length} domains`);
        return { success: true, cookieCount: cookies.length, domains };
    } catch (err) {
        console.error('[WT Sync] Sync failed:', err);
        await chrome.storage.local.set({ lastSyncStatus: err.message });
        return { success: false, error: err.message };
    } finally {
        syncInProgress = false;
    }
}

// ============================================================================
// Network Interception for HLS/MPD Detection
// ============================================================================

/**
 * Check if URL is a video manifest
 */
function isVideoManifest(url) {
    const lowUrl = url.toLowerCase();
    if (lowUrl.includes('.m3u8') || (lowUrl.includes('manifest') && lowUrl.includes('mpegurl'))) {
        return 'hls';
    }
    if (lowUrl.includes('.mpd') || (lowUrl.includes('dash') && lowUrl.includes('manifest'))) {
        return 'dash';
    }
    return null;
}

// Scoped URL patterns for video stream detection (instead of <all_urls>)
const VIDEO_SITE_PATTERNS = [
    '*://*.youtube.com/*',
    '*://*.googlevideo.com/*',
    '*://*.ytimg.com/*',
    '*://*.twitch.tv/*',
    '*://*.ttvnw.net/*',
    '*://*.jtvnw.net/*',
    '*://*.vimeo.com/*',
    '*://*.vimeocdn.com/*',
    '*://*.dailymotion.com/*',
    '*://*.dm-event.net/*',
    '*://*.dmcdn.net/*',
    '*://*.crunchyroll.com/*',
    '*://*.akamaized.net/*',
    '*://*.cloudfront.net/*',
    '*://*.fastly.net/*',
];

/**
 * Listen for web requests to detect video streams (scoped to video sites)
 */
chrome.webRequest.onCompleted.addListener(
    (details) => {
        const type = isVideoManifest(details.url);
        if (type && details.tabId >= 0) {
            // Store the detected stream for this tab
            detectedStreams.set(details.tabId, {
                url: details.url,
                type: type,
                timestamp: Date.now(),
                pageUrl: details.initiator || details.url
            });
            console.log(`[WT Sync] Detected ${type.toUpperCase()} stream in tab ${details.tabId}:`, details.url.slice(0, 80));

            // Notify the popup if it's open (ignore errors if popup not open)
            chrome.runtime.sendMessage({
                type: 'STREAM_DETECTED',
                tabId: details.tabId,
                stream: detectedStreams.get(details.tabId)
            }).catch((err) => {
                const errorMsg = err?.message || String(err);
                if (!errorMsg.includes('Receiving end does not exist')) {
                    console.warn('[WT Sync] Failed to notify popup:', errorMsg);
                }
            });
        }
    },
    { urls: VIDEO_SITE_PATTERNS },
    []
);

/**
 * Clean up detected streams when tab is closed
 */
chrome.tabs.onRemoved.addListener((tabId) => {
    detectedStreams.delete(tabId);
});

/**
 * Clean up detected streams when tab navigates to a new page
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    // Clear stream when navigation starts (catches SPA and all navigation types)
    if (changeInfo.status === 'loading') {
        detectedStreams.delete(tabId);
    }
});

/**
 * Get detected stream for current tab
 */
async function getDetectedStream(tabId) {
    // Check for explicit tabId (0 is a valid tab ID, must be a non-negative number)
    if (typeof tabId === 'number' && tabId >= 0) {
        return detectedStreams.get(tabId) || null;
    }
    // If no tabId provided, get current active tab
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0) {
        return detectedStreams.get(tabs[0].id) || null;
    }
    return null;
}


/**
 * Send a video URL to a Watch Together room
 */
async function sendToRoom(roomId, videoUrl, pageUrl) {
    console.log(`[WT Sync] Sending to room ${roomId}:`, videoUrl?.slice(0, 80) || pageUrl);

    try {
        const verified = await verifyActiveConnection();
        if (!verified.connected || !verified.connection) {
            return {
                success: false,
                error: verified.error || 'Not connected to Watch Together',
            };
        }
        const connection = verified.connection;

        // Use the page URL for resolution (original URL), or the detected stream URL
        const urlToSend = pageUrl || videoUrl;
        if (!urlToSend) {
            return { success: false, error: 'No video URL to send' };
        }

        // Validate URL to prevent SSRF attacks
        try {
            const parsedUrl = new URL(urlToSend);
            if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                return { success: false, error: 'Invalid URL protocol' };
            }
        } catch {
            return { success: false, error: 'Invalid URL format' };
        }

        // Resolve the video through the backend
        const resolveResponse = await fetch(`${connection.origin}/api/resolve?url=${encodeURIComponent(urlToSend)}`, {
            credentials: 'include',
            headers: {
                'Authorization': `Bearer ${connection.token}`,
            },
            cache: 'no-store',
        });

        if (!resolveResponse.ok) {
            const error = await resolveResponse.json().catch(() => ({ detail: 'Failed to resolve video' }));
            throw new Error(error.detail || `HTTP ${resolveResponse.status}`);
        }

        const videoData = await resolveResponse.json();

        // Connect to the room WebSocket and queue the video
        // For simplicity, we'll use an HTTP endpoint if available, or just return the resolved data
        // The frontend can handle WebSocket connection

        // Store the video data for the popup to use
        await chrome.storage.local.set({
            lastQueuedVideo: {
                roomId,
                videoData,
                timestamp: Date.now()
            }
        });

        return {
            success: true,
            message: `Video resolved: ${videoData.title}`,
            backendUrl: connection.origin,
            videoData,
        };

    } catch (err) {
        console.error('[WT Sync] Send to room failed:', err);
        return { success: false, error: err.message };
    }
}
