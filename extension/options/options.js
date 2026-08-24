/**
 * Watch Together Cookie Sync - Options Page Script
 */

const DEFAULT_DOMAINS = [
    '.youtube.com',
    '.twitch.tv',
    '.vimeo.com',
    '.dailymotion.com',
    '.crunchyroll.com'
];

document.addEventListener('DOMContentLoaded', async () => {
    // Elements
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const userEmail = document.getElementById('userEmail');
    const connectionHelp = document.getElementById('connectionHelp');
    const autoSyncToggle = document.getElementById('autoSyncToggle');
    const lastSync = document.getElementById('lastSync');
    const syncNowBtn = document.getElementById('syncNowBtn');
    const newDomainInput = document.getElementById('newDomain');
    const addDomainBtn = document.getElementById('addDomainBtn');
    const domainList = document.getElementById('domainList');
    const backendUrlInput = document.getElementById('backendUrl');
    const resetBtn = document.getElementById('resetBtn');

    // Load initial data
    await loadSettings();

    // Event listeners
    autoSyncToggle.addEventListener('change', handleAutoSyncToggle);
    syncNowBtn.addEventListener('click', handleSyncNow);
    addDomainBtn.addEventListener('click', handleAddDomain);
    newDomainInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleAddDomain();
    });
    resetBtn.addEventListener('click', handleReset);

    /**
     * Load and display all settings
     */
    async function loadSettings() {
        // Credentials never come from sync storage: old extension versions
        // synchronized them across devices, which is how one browser could
        // display another user's email and still-valid token. The background
        // worker validates the local bearer and current site session, then
        // returns the one identity the backend says it represents.
        const [status, preferences] = await Promise.all([
            chrome.runtime.sendMessage({ type: 'GET_STATUS' }),
            chrome.storage.sync.get(['domains', 'autoSync']),
        ]);

        if (status?.connected) {
            statusDot.classList.add('connected');
            statusText.textContent = 'Connected';
            userEmail.textContent = status.userEmail || '';
            connectionHelp.style.display = 'none';
        } else {
            statusDot.classList.remove('connected');
            statusText.textContent = status?.connectionReason === 'unverifiable'
                ? 'Cannot verify connection'
                : 'Not Connected';
            userEmail.textContent = '';
            connectionHelp.textContent = status?.connectionError ||
                'Visit Watch Together while logged in, then connect it from the extension menu.';
            connectionHelp.style.display = 'block';
        }

        autoSyncToggle.checked = preferences.autoSync !== false;

        if (status?.lastSync) {
            lastSync.textContent = new Date(status.lastSync).toLocaleString();
        } else {
            lastSync.textContent = 'Never';
        }

        renderDomains(preferences.domains || DEFAULT_DOMAINS);
        backendUrlInput.value = status?.backendUrl || '';
    }

    /**
     * Render domain list - uses safe DOM manipulation to prevent XSS
     */
    function renderDomains(domains) {
        domainList.innerHTML = '';

        for (const domain of domains) {
            const div = document.createElement('div');
            div.className = 'domain-tag';

            const span = document.createElement('span');
            span.textContent = domain.replace(/^\./, '');
            div.appendChild(span);

            const button = document.createElement('button');
            button.title = 'Remove domain';
            button.innerHTML = `
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
            `;
            button.addEventListener('click', () => removeDomain(domain));
            div.appendChild(button);

            domainList.appendChild(div);
        }
    }

    /**
     * Handle auto-sync toggle
     */
    async function handleAutoSyncToggle() {
        await chrome.runtime.sendMessage({
            type: 'UPDATE_SETTINGS',
            settings: { autoSync: autoSyncToggle.checked }
        });
    }

    /**
     * Handle sync now button
     */
    async function handleSyncNow() {
        syncNowBtn.disabled = true;
        syncNowBtn.textContent = 'Syncing...';

        try {
            const result = await chrome.runtime.sendMessage({ type: 'SYNC_NOW' });
            if (result.success) {
                lastSync.textContent = new Date().toLocaleString();
            } else {
                alert('Sync failed: ' + (result.error || 'Unknown error'));
            }
        } catch (err) {
            alert('Sync error: ' + err.message);
        } finally {
            syncNowBtn.disabled = false;
            syncNowBtn.textContent = 'Sync Now';
        }
    }

    /**
     * Handle add domain
     */
    async function handleAddDomain() {
        let domain = newDomainInput.value.trim().toLowerCase();
        if (!domain) return;

        // Ensure domain starts with a dot
        if (!domain.startsWith('.')) {
            domain = '.' + domain;
        }

        const storage = await chrome.storage.sync.get(['domains']);
        const domains = storage.domains || DEFAULT_DOMAINS;

        if (domains.includes(domain)) {
            alert('Domain already added');
            return;
        }

        domains.push(domain);
        await chrome.storage.sync.set({ domains });

        newDomainInput.value = '';
        renderDomains(domains);
    }

    /**
     * Remove a domain
     */
    async function removeDomain(domain) {
        const storage = await chrome.storage.sync.get(['domains']);
        const domains = (storage.domains || DEFAULT_DOMAINS).filter(d => d !== domain);
        await chrome.storage.sync.set({ domains });
        renderDomains(domains);
    }

    /**
     * Reset extension
     */
    async function handleReset() {
        if (!confirm('Are you sure you want to reset the extension? This will clear all settings and disconnect from Watch Together.')) {
            return;
        }

        const result = await chrome.runtime.sendMessage({ type: 'RESET_EXTENSION' });
        if (!result?.success) {
            alert('Reset failed: ' + (result?.error || 'Unknown error'));
            return;
        }
        location.reload();
    }
});
