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
    const tokenInput = document.getElementById('tokenInput');
    const toggleTokenBtn = document.getElementById('toggleTokenBtn');
    const copyTokenBtn = document.getElementById('copyTokenBtn');
    const resetBtn = document.getElementById('resetBtn');

    let showToken = false;

    // Load initial data
    await loadSettings();

    // Event listeners
    autoSyncToggle.addEventListener('change', handleAutoSyncToggle);
    syncNowBtn.addEventListener('click', handleSyncNow);
    addDomainBtn.addEventListener('click', handleAddDomain);
    newDomainInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleAddDomain();
    });
    toggleTokenBtn.addEventListener('click', handleToggleToken);
    copyTokenBtn.addEventListener('click', handleCopyToken);
    resetBtn.addEventListener('click', handleReset);

    /**
     * Load and display all settings
     */
    async function loadSettings() {
        const storage = await chrome.storage.sync.get([
            'token', 'userEmail', 'backendUrl', 'domains', 'autoSync', 'lastSync'
        ]);

        // Connection status
        if (storage.token) {
            statusDot.classList.add('connected');
            statusText.textContent = 'Connected';
            userEmail.textContent = storage.userEmail || '';
            connectionHelp.style.display = 'none';
        } else {
            statusDot.classList.remove('connected');
            statusText.textContent = 'Not Connected';
            userEmail.textContent = '';
            connectionHelp.style.display = 'block';
        }

        // Auto-sync toggle
        autoSyncToggle.checked = storage.autoSync !== false;

        // Last sync
        if (storage.lastSync) {
            const date = new Date(storage.lastSync);
            lastSync.textContent = date.toLocaleString();
        } else {
            lastSync.textContent = 'Never';
        }

        // Domains
        const domains = storage.domains || DEFAULT_DOMAINS;
        renderDomains(domains);

        // Backend URL
        backendUrlInput.value = storage.backendUrl || '';

        // Token
        tokenInput.value = storage.token || '';
        tokenInput.type = 'password';
    }

    /**
     * Render domain list
     */
    function renderDomains(domains) {
        domainList.innerHTML = domains.map(domain => `
            <div class="domain-tag" data-domain="${domain}">
                <span>${domain.replace(/^\./, '')}</span>
                <button title="Remove domain">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            </div>
        `).join('');

        // Add remove handlers
        domainList.querySelectorAll('.domain-tag button').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const tag = e.target.closest('.domain-tag');
                const domain = tag.dataset.domain;
                await removeDomain(domain);
            });
        });
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
     * Toggle token visibility
     */
    function handleToggleToken() {
        showToken = !showToken;
        tokenInput.type = showToken ? 'text' : 'password';
    }

    /**
     * Copy token to clipboard
     */
    async function handleCopyToken() {
        const token = tokenInput.value;
        if (token) {
            await navigator.clipboard.writeText(token);
            copyTokenBtn.innerHTML = `
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2">
                    <polyline points="20,6 9,17 4,12"/>
                </svg>
            `;
            setTimeout(() => {
                copyTokenBtn.innerHTML = `
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                    </svg>
                `;
            }, 2000);
        }
    }

    /**
     * Reset extension
     */
    async function handleReset() {
        if (!confirm('Are you sure you want to reset the extension? This will clear all settings and disconnect from Watch Together.')) {
            return;
        }

        await chrome.storage.sync.clear();
        await chrome.storage.local.clear();
        await chrome.storage.sync.set({ domains: DEFAULT_DOMAINS, autoSync: true });

        location.reload();
    }
});
