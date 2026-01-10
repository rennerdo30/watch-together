/**
 * Watch Together Cookie Sync - Content Script
 *
 * Detects API token from Watch Together pages via meta tags.
 * Runs on all pages to detect Watch Together instances.
 */

(function() {
    'use strict';

    /**
     * Check for Watch Together meta tags and extract token
     */
    function checkForToken() {
        const tokenMeta = document.querySelector('meta[name="wt-ext-token"]');
        const userMeta = document.querySelector('meta[name="wt-ext-user"]');

        if (tokenMeta && userMeta) {
            const token = tokenMeta.getAttribute('content');
            const userEmail = userMeta.getAttribute('content');

            if (token && userEmail) {
                console.log('[WT Sync] Token detected for user:', userEmail);

                // Get the backend URL from the current page
                const backendUrl = window.location.origin;

                // Send token to background script
                chrome.runtime.sendMessage({
                    type: 'TOKEN_DETECTED',
                    token: token,
                    userEmail: userEmail,
                    backendUrl: backendUrl
                }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.warn('[WT Sync] Failed to send token:', chrome.runtime.lastError);
                        return;
                    }
                    if (response && response.success) {
                        console.log('[WT Sync] Token registered successfully');
                    }
                });

                return true;
            }
        }
        return false;
    }

    // Check immediately
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkForToken);
    } else {
        checkForToken();
    }

    // Also observe for dynamically added meta tags (SPA navigation)
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.type === 'childList') {
                for (const node of mutation.addedNodes) {
                    if (node.nodeName === 'META') {
                        if (node.getAttribute('name') === 'wt-ext-token') {
                            if (checkForToken()) {
                                observer.disconnect(); // Stop observing after successful detection
                            }
                            return;
                        }
                    }
                }
            }
        }
    });

    observer.observe(document.head || document.documentElement, {
        childList: true,
        subtree: true
    });
})();
