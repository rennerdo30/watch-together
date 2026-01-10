'use client';

import { useEffect, useState } from 'react';
import { getExtensionToken } from '@/lib/api';

/**
 * Injects meta tags for browser extension to detect.
 * The extension reads these tags to auto-configure authentication.
 */
export function ExtensionMeta() {
    const [token, setToken] = useState<string | null>(null);
    const [userEmail, setUserEmail] = useState<string | null>(null);

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
        if (!email) return;

        setUserEmail(email);

        // Fetch the API token
        getExtensionToken()
            .then(response => {
                setToken(response.token.id);
            })
            .catch(err => {
                console.warn('Failed to fetch extension token:', err);
            });
    }, []);

    if (!token || !userEmail) return null;

    return (
        <>
            <meta name="wt-ext-token" content={token} />
            <meta name="wt-ext-user" content={userEmail} />
        </>
    );
}
