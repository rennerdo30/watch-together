/**
 * Watch Together Cookie Sync - Popup Script
 */

document.addEventListener('DOMContentLoaded', async () => {
    // Elements
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const userEmail = document.getElementById('userEmail');
    const lastSync = document.getElementById('lastSync');
    const syncBtn = document.getElementById('syncBtn');
    const domainList = document.getElementById('domainList');
    const domainCount = document.getElementById('domainCount');
    const autoSyncToggle = document.getElementById('autoSyncToggle');
    const optionsBtn = document.getElementById('optionsBtn');
    const roomIdInput = document.getElementById('roomId');
    const sendBtn = document.getElementById('sendBtn');
    const sendStatus = document.getElementById('sendStatus');
    const sendSection = document.getElementById('sendSection');

    let currentStream = null;
    let currentTabUrl = null;

    // Load saved room ID
    try {
        const saved = await chrome.storage.sync.get(['lastRoomId']);
        if (saved.lastRoomId) {
            roomIdInput.value = saved.lastRoomId;
        }
    } catch (err) {
        console.error('Failed to load saved room ID:', err);
    }

    // Get current tab URL
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length > 0) {
            currentTabUrl = tabs[0].url;
        }
    } catch (err) {
        console.error('Failed to get current tab:', err);
    }

    // Load status
    await loadStatus();

    // Check for detected streams
    await checkForStreams();

    // Event listeners
    syncBtn.addEventListener('click', handleSync);
    autoSyncToggle.addEventListener('change', handleAutoSyncToggle);
    optionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
    sendBtn.addEventListener('click', handleSendToRoom);
    roomIdInput.addEventListener('input', () => {
        const roomId = roomIdInput.value.trim();
        // Only save valid room IDs (alphanumeric, hyphens, underscores)
        if (!roomId || /^[a-zA-Z0-9_-]*$/.test(roomId)) {
            chrome.storage.sync.set({ lastRoomId: roomId }).catch(err => {
                console.error('Failed to save room ID:', err);
            });
        }
    });

    // Listen for stream detection updates
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'STREAM_DETECTED') {
            checkForStreams().catch(err => console.error('Stream check failed:', err));
        }
    });

    /**
     * Load and display current status
     */
    async function loadStatus() {
        try {
            const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });

            if (!status) {
                throw new Error('No response from background script');
            }

            if (status.connected) {
                statusDot.classList.add('connected');
                statusText.textContent = 'Connected';
                userEmail.textContent = status.userEmail || '';
            } else {
                statusDot.classList.remove('connected');
                statusText.textContent = 'Not Connected';
                userEmail.textContent = 'Visit Watch Together to connect';
            }

            // Last sync
            if (status.lastSync) {
                const date = new Date(status.lastSync);
                const diff = Date.now() - status.lastSync;
                if (diff < 60000) {
                    lastSync.textContent = 'Just now';
                } else if (diff < 3600000) {
                    lastSync.textContent = `${Math.floor(diff / 60000)} min ago`;
                } else {
                    lastSync.textContent = date.toLocaleTimeString();
                }
            } else {
                lastSync.textContent = 'Never';
            }

            // Domains - use safe DOM manipulation to prevent XSS
            const domains = status.domains || [];
            domainCount.textContent = domains.length;
            domainList.innerHTML = '';
            for (const domain of domains) {
                const span = document.createElement('span');
                span.className = 'domain-tag';
                span.textContent = domain.replace(/^\./, '');
                domainList.appendChild(span);
            }

            // Auto-sync toggle
            autoSyncToggle.checked = status.autoSync;

        } catch (err) {
            console.error('Failed to load status:', err);
            statusText.textContent = 'Error';
        }
    }

    /**
     * Check for detected video streams in current tab
     */
    async function checkForStreams() {
        try {
            const response = await chrome.runtime.sendMessage({ type: 'GET_DETECTED_STREAM' });
            currentStream = response?.stream || null;

            if (currentStream) {
                sendSection.style.display = 'block';
                const typeLabel = currentStream.type.toUpperCase();
                sendBtn.title = `Send ${typeLabel} stream to Watch Together`;
            } else {
                // Still show send section - can send page URL
                sendSection.style.display = 'block';
                sendBtn.title = 'Send current page to Watch Together';
            }
        } catch (err) {
            console.error('Failed to check for streams:', err);
        }
    }

    /**
     * Handle sync button click
     */
    async function handleSync() {
        syncBtn.disabled = true;
        const originalText = syncBtn.innerHTML;
        syncBtn.innerHTML = `
            <svg class="spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M23 4v6h-6"/>
                <path d="M1 20v-6h6"/>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
            </svg>
            Syncing...
        `;

        try {
            const result = await chrome.runtime.sendMessage({ type: 'SYNC_NOW' });

            if (result?.success) {
                lastSync.textContent = 'Just now';
            } else {
                console.error('Sync failed:', result?.error || 'Unknown error');
            }
        } catch (err) {
            console.error('Sync error:', err);
        } finally {
            syncBtn.disabled = false;
            syncBtn.innerHTML = originalText;
            await loadStatus();
        }
    }

    /**
     * Handle auto-sync toggle
     */
    async function handleAutoSyncToggle() {
        try {
            await chrome.runtime.sendMessage({
                type: 'UPDATE_SETTINGS',
                settings: { autoSync: autoSyncToggle.checked }
            });
        } catch (err) {
            console.error('Failed to update settings:', err);
        }
    }

    /**
     * Handle send to room button click
     */
    async function handleSendToRoom() {
        const roomId = roomIdInput.value.trim();
        if (!roomId) {
            sendStatus.textContent = 'Enter a room ID';
            sendStatus.className = 'send-status error';
            return;
        }
        // Validate room ID format (alphanumeric, hyphens, underscores only)
        if (!/^[a-zA-Z0-9_-]+$/.test(roomId)) {
            sendStatus.textContent = 'Invalid room ID (use letters, numbers, - or _)';
            sendStatus.className = 'send-status error';
            return;
        }

        sendBtn.disabled = true;
        sendStatus.textContent = 'Resolving video...';
        sendStatus.className = 'send-status';

        try {
            // Determine what URL to send
            let urlToSend = currentTabUrl;
            let streamUrl = currentStream?.url;

            const result = await chrome.runtime.sendMessage({
                type: 'SEND_TO_ROOM',
                roomId: roomId,
                url: streamUrl,
                pageUrl: urlToSend
            });

            if (result.success) {
                sendStatus.textContent = result.message || 'Video queued!';
                sendStatus.className = 'send-status success';

                // Open Watch Together room in new tab
                const storage = await chrome.storage.sync.get(['backendUrl']);
                if (storage.backendUrl) {
                    const roomUrl = `${storage.backendUrl}/room/${encodeURIComponent(roomId)}`;
                    chrome.tabs.create({ url: roomUrl });
                }
            } else {
                sendStatus.textContent = result.error || 'Failed to send';
                sendStatus.className = 'send-status error';
            }
        } catch (err) {
            sendStatus.textContent = err.message || 'Error sending';
            sendStatus.className = 'send-status error';
        } finally {
            sendBtn.disabled = false;
        }
    }
});
