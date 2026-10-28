import { useId } from 'react';

/**
 * The Watch Together mark: a little screen with a face, on a teal tile. The
 * same character is the app's mascot (`components/mascot.tsx`). Teal because
 * the video brands this app plays are red (YouTube) and purple (Twitch); a
 * red tile with a play shape reads as theirs. Drawn for the sizes it is used
 * at (a 32 px header, a 16 px favicon). The same drawing as public/logo.svg,
 * the favicon and the extension icons.
 */
export function BrandMark({ className = 'h-9 w-9' }: { className?: string }) {
    // Each instance needs its own gradient id; two marks on a page would
    // otherwise share (and fight over) one.
    const gradient = `wt-tile-${useId().replace(/:/g, '')}`;
    return (
        <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false" data-brand-mark="">
            <defs>
                <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#34cdb9" />
                    <stop offset="1" stopColor="#0e8f7d" />
                </linearGradient>
            </defs>
            <rect width="64" height="64" rx="15" fill={`url(#${gradient})`} />
            <rect x="11" y="15" width="42" height="29" rx="9" fill="#ffffff" />
            <ellipse cx="25.5" cy="29.5" rx="3.2" ry="4.6" fill="#0b4f46" />
            <ellipse cx="38.5" cy="29.5" rx="3.2" ry="4.6" fill="#0b4f46" />
            <path d="M24 50h16" fill="none" stroke="#ffffff" strokeWidth="5" strokeLinecap="round" />
        </svg>
    );
}
