import { useId } from 'react';

/**
 * The Watch Together mark: a couch under a screen's glow — the watch party,
 * wherever everyone actually is. The same drawing as public/logo.svg and the
 * favicon, in renner.dev's colours: the orange accent on the navy-black tile,
 * the cyan screen above.
 */
export function BrandMark({ className = 'h-9 w-9' }: { className?: string }) {
    // Each instance needs its own gradient id; two marks on a page would
    // otherwise share (and fight over) one.
    const gradient = `wt-couch-${useId().replace(/:/g, '')}`;
    return (
        <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false" data-brand-mark="">
            <defs>
                <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#ff7a1a" />
                    <stop offset="1" stopColor="#ffa24c" />
                </linearGradient>
            </defs>
            <rect width="64" height="64" rx="15" fill="#08090f" />
            <rect x="14" y="11" width="36" height="4" rx="2" fill="#2de2f0" />
            <path d="M17 32a6 6 0 0 1 6-6h18a6 6 0 0 1 6 6v6H17Z" fill={`url(#${gradient})`} />
            <path d="M9 37a5 5 0 0 1 10 0v4h26v-4a5 5 0 0 1 10 0v9a5 5 0 0 1-5 5H14a5 5 0 0 1-5-5Z" fill={`url(#${gradient})`} />
            <path d="M15 51v4M49 51v4" stroke="#ffa24c" strokeWidth="3" strokeLinecap="round" />
        </svg>
    );
}
