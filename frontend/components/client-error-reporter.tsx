'use client';

import { useEffect } from 'react';
import { reportClientError } from '@/lib/client-errors';

/** Capture uncaught JS errors and rejected promises after hydration, on every page. */
export function ClientErrorReporter() {
    useEffect(() => {
        const onError = (event: ErrorEvent) => reportClientError({
            source: 'runtime', message: event.message || 'Script error',
            stack: event.error instanceof Error ? event.error.stack : undefined,
            resource: event.filename,
        });
        const onRejection = (event: PromiseRejectionEvent) => reportClientError({
            source: 'promise',
            message: event.reason instanceof Error ? event.reason.message : 'Unhandled promise rejection',
            stack: event.reason instanceof Error ? event.reason.stack : undefined,
        });
        window.addEventListener('error', onError);
        window.addEventListener('unhandledrejection', onRejection);
        return () => {
            window.removeEventListener('error', onError);
            window.removeEventListener('unhandledrejection', onRejection);
        };
    }, []);
    return null;
}
