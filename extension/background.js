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

// Stream cleanup interval (1 hour max age)
const STREAM_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Initialize extension on install
 */
chrome.runtime.onInstalled.addListener(async () => {
    console.log('[WT Sync] Extension installed');

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

        case 'TOKEN_DETECTED':
            // Include backendUrl from content script
            handleTokenDetected(message.token, message.userEmail, message.backendUrl)
                .then(result => sendResponse(result));
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
 * Handle token detected from content script
 */
async function handleTokenDetected(token, userEmail, backendUrl) {
    console.log('[WT Sync] Token detected for user:', userEmail, 'backend:', backendUrl);
    await chrome.storage.sync.set({ token, userEmail, backendUrl });

    // Try an initial sync
    const result = await syncCookies();
    return { success: true, syncResult: result };
}

/**
 * Update extension settings
 */
async function updateSettings(settings) {
    await chrome.storage.sync.set(settings);
    if ('autoSync' in settings) {
        await setupAutoSync();
    }
}

/**
 * Get current extension status
 */
async function getStatus() {
    const storage = await chrome.storage.sync.get(['token', 'userEmail', 'lastSync', 'lastSyncStatus', 'domains', 'autoSync']);
    return {
        connected: !!storage.token,
        userEmail: storage.userEmail || null,
        lastSync: storage.lastSync || null,
        lastSyncStatus: storage.lastSyncStatus || null,
        domains: storage.domains || DEFAULT_DOMAINS,
        autoSync: storage.autoSync !== false
    };
}

/**
 * Convert browser cookies to Netscape format
 */
function toNetscapeFormat(cookies) {
    const lines = ['# Netscape HTTP Cookie File', '# Generated by Watch Together Cookie Sync', ''];

    for (const cookie of cookies) {
        const domain = cookie.domain.startsWith('.') ? cookie.domain : '.' + cookie.domain;
        const includeSubdomains = cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE';
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

/**
 * Get the backend URL from storage or default
 */
async function getBackendUrl() {
    const storage = await chrome.storage.sync.get(['backendUrl']);
    // Default to the current tab's origin if we have a token
    return storage.backendUrl || null;
}

/**
 * Sync cookies to Watch Together backend
 */
async function syncCookies() {
    // Prevent concurrent sync operations
    if (syncInProgress) {
        console.log('[WT Sync] Sync already in progress, skipping');
        return { success: false, error: 'Sync already in progress' };
    }

    syncInProgress = true;
    console.log('[WT Sync] Starting cookie sync...');

    try {
        const storage = await chrome.storage.sync.get(['token', 'domains', 'backendUrl']);

        if (!storage.token) {
            console.log('[WT Sync] No token configured');
            await chrome.storage.sync.set({ lastSyncStatus: 'No token configured' });
            return { success: false, error: 'No token configured' };
        }

        const domains = storage.domains || DEFAULT_DOMAINS;
        const cookies = await getCookiesForDomains(domains);

        if (cookies.length === 0) {
            console.log('[WT Sync] No cookies to sync');
            await chrome.storage.sync.set({ lastSyncStatus: 'No cookies found' });
            return { success: false, error: 'No cookies found for configured domains' };
        }

        const netscapeContent = toNetscapeFormat(cookies);
        const backendUrl = storage.backendUrl || '';

        if (!backendUrl) {
            console.log('[WT Sync] No backend URL configured');
            await chrome.storage.sync.set({ lastSyncStatus: 'No backend URL' });
            return { success: false, error: 'No backend URL configured. Visit Watch Together to configure.' };
        }

        // Send to backend
        const response = await fetch(`${backendUrl}/api/extension/sync`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${storage.token}`
            },
            body: JSON.stringify({
                cookies: netscapeContent,
                domains: domains,
                browser: 'chrome'
            })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({
                detail: `HTTP ${response.status}: ${response.statusText || 'Request failed'}`
            }));
            throw new Error(error.detail || `HTTP ${response.status}`);
        }

        const result = await response.json();
        const now = Date.now();

        await chrome.storage.sync.set({
            lastSync: now,
            lastSyncStatus: 'Success'
        });

        console.log(`[WT Sync] Synced ${cookies.length} cookies from ${domains.length} domains`);
        return { success: true, cookieCount: cookies.length, domains: domains };

    } catch (err) {
        console.error('[WT Sync] Sync failed:', err);
        await chrome.storage.sync.set({ lastSyncStatus: err.message });
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

/**
 * Listen for web requests to detect video streams
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
                // Only log unexpected errors, not "no receiver" errors
                if (!err.message?.includes('Receiving end does not exist')) {
                    console.warn('[WT Sync] Failed to notify popup:', err.message);
                }
            });
        }
    },
    { urls: ['<all_urls>'] },
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
    // Clear stream when navigation starts (before new page loads)
    if (changeInfo.status === 'loading' && changeInfo.url) {
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
        const storage = await chrome.storage.sync.get(['token', 'backendUrl']);

        if (!storage.token || !storage.backendUrl) {
            return { success: false, error: 'Not connected to Watch Together' };
        }

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
        const resolveResponse = await fetch(`${storage.backendUrl}/api/resolve?url=${encodeURIComponent(urlToSend)}`, {
            headers: {
                'Authorization': `Bearer ${storage.token}`
            }
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
            videoData
        };

    } catch (err) {
        console.error('[WT Sync] Send to room failed:', err);
        return { success: false, error: err.message };
    }
}
