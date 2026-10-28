import { useId } from 'react';

/**
 * The Watch Together mark: two viewers in front of a lit screen, on a teal
 * tile. Teal because the video brands this app plays are red (YouTube) and
 * purple (Twitch); a red tile with a play shape reads as theirs. Drawn for the
 * sizes it is used at (a 32 px header, a 16 px favicon): solid shapes, no
 * strokes. The same drawing as public/logo.svg, the favicon and the
 * extension icons.
 */
export function BrandMark({ className = 'h-9 w-9' }: { className?: string }) {
    // Each instance needs its own gradient id; two marks on a page would
    // otherwise share (and fight over) one.
    const gradient = `wt-tile-${useId().replace(/:/g, '')}`;
    return (
        <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false" data-brand-mark="">
            <defs>
                <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#3dd6c2" />
                    <stop offset="1" stopColor="#119884" />
                </linearGradient>
            </defs>
            <rect width="64" height="64" rx="15" fill={`url(#${gradient})`} />
            <rect x="10" y="10" width="44" height="31" rx="6" fill="#ffffff" />
            <path d="M29 17.6v8.8a1.2 1.2 0 0 0 1.8 1l7-4.4a1.2 1.2 0 0 0 0-2l-7-4.4a1.2 1.2 0 0 0-1.8 1z" fill="#119884" />
            <g fill="#08413a">
                <circle cx="23.5" cy="40" r="6.5" />
                <circle cx="40.5" cy="40" r="6.5" />
                <path d="M11 64v-5.5C11 52 16.5 48 23.5 48S36 52 36 58.5V64zM28 64v-5.5C28 52 33.5 48 40.5 48S53 52 53 58.5V64z" />
            </g>
        </svg>
    );
}
