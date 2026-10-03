import { useId } from 'react';

/**
 * The Watch Together mark: a couch under the screen's glow — the watch
 * party, wherever everyone actually is — drawn as a line icon on renner.dev's orange tile. Drawn for
 * the sizes it is used at (a 32 px header, a 16 px favicon): one stroke
 * weight, a solid tile so it holds its shape beside the title. The same
 * drawing as public/logo.svg and the favicon.
 */
export function BrandMark({ className = 'h-9 w-9' }: { className?: string }) {
    // Each instance needs its own gradient id; two marks on a page would
    // otherwise share (and fight over) one.
    const gradient = `wt-tile-${useId().replace(/:/g, '')}`;
    return (
        <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false" data-brand-mark="">
            <defs>
                <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#ff7a1a" />
                    <stop offset="1" stopColor="#ffa24c" />
                </linearGradient>
            </defs>
            <rect width="64" height="64" rx="16" fill={`url(#${gradient})`} />
            <g fill="none" stroke="#1c1207" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 13h20" />
                <path d="M17 33v-4a5 5 0 0 1 5-5h20a5 5 0 0 1 5 5v4" />
                <path d="M13 47V38a4 4 0 0 1 8 0v3h22v-3a4 4 0 0 1 8 0v9a4 4 0 0 1-4 4H17a4 4 0 0 1-4-4Z" />
            </g>
        </svg>
    );
}
