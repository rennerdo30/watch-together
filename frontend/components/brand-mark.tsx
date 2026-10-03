/**
 * The Watch Together mark: a play button and its echo — one screen, and
 * another playing in step with it. The same drawing as public/logo.svg and
 * the favicon; the tile is the app's dark surface and the triangles its red,
 * so it matches the theme rather than standing apart from it.
 */
export function BrandMark({ className = 'h-9 w-9' }: { className?: string }) {
    return (
        <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false" data-brand-mark="">
            <rect width="64" height="64" rx="15" fill="#15161a" />
            <rect x="1" y="1" width="62" height="62" rx="14" fill="none" stroke="#fff" strokeOpacity=".08" strokeWidth="2" />
            <path d="M17 15.5v23a2.5 2.5 0 0 0 3.8 2.1l18.4-11.5a2.5 2.5 0 0 0 0-4.2L20.8 13.4A2.5 2.5 0 0 0 17 15.5Z" fill="#d93a3a" fillOpacity=".45" />
            <path d="M24 25.5v23a2.5 2.5 0 0 0 3.8 2.1l18.4-11.5a2.5 2.5 0 0 0 0-4.2L27.8 23.4A2.5 2.5 0 0 0 24 25.5Z" fill="#e4605f" />
        </svg>
    );
}
