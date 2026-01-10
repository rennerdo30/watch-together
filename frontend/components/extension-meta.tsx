'use client';

import { useEffect } from 'react';
import { getExtensionToken } from '@/lib/api';

/**
 * Injects meta tags for browser extension to detect.
 * Uses direct DOM manipulation since Next.js client components
 * in <head> don't render dynamic content properly.
 */
export function ExtensionMeta() {
    useEffect(() => {
        // Get user email from Cloudflare header (set by middleware) or query param
        const searchParams = new URLSearchParams(window.location.search);
        const mockUser = searchParams.get('user');

        // Try to get email from cookie set by server
        const cfEmail = document.cookie
            .split('; ')
            .find(row => row.startsWith('cf-access-user='))
            ?.split('=')[1];

        const email = mockUser || cfEmail;
        if (!email) {
            console.log('[ExtensionMeta] No user email found');
            return;
        }

        console.log('[ExtensionMeta] User email:', email);

        // Fetch the API token
        getExtensionToken()
            .then(response => {
                const token = response.token.id;
                console.log('[ExtensionMeta] Token received, injecting meta tags');

                // Remove existing meta tags if any
                document.querySelector('meta[name="wt-ext-token"]')?.remove();
                document.querySelector('meta[name="wt-ext-user"]')?.remove();

                // Create and inject meta tags directly into DOM
                const tokenMeta = document.createElement('meta');
                tokenMeta.name = 'wt-ext-token';
                tokenMeta.content = token;
                document.head.appendChild(tokenMeta);

                const userMeta = document.createElement('meta');
                userMeta.name = 'wt-ext-user';
                userMeta.content = email;
                document.head.appendChild(userMeta);

                console.log('[ExtensionMeta] Meta tags injected successfully');
            })
            .catch(err => {
                console.warn('[ExtensionMeta] Failed to fetch extension token:', err);
            });
    }, []);

    // This component doesn't render anything - it uses direct DOM manipulation
    return null;
}
