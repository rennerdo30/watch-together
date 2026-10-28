/**
 * The app's button styles. One height (36 px) and one radius for every
 * button in a bar, so a row of them lines up; the variants differ only in
 * fill. Icons inside are 16 px.
 */

const BUTTON_BASE =
    'inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3.5 text-sm font-medium transition-[background-color,filter,color] disabled:cursor-not-allowed disabled:opacity-40';

/** The one main action of a bar or dialog. */
export const BUTTON_PRIMARY = `${BUTTON_BASE} bg-[color:var(--accent-primary)] on-accent hover:brightness-110`;

/** Everything else. */
export const BUTTON_SECONDARY = `${BUTTON_BASE} border border-white/10 bg-white/5 text-neutral-100 hover:bg-white/10`;

/** Stops something that is running for the whole room. */
export const BUTTON_DANGER = `${BUTTON_BASE} border border-red-500/30 bg-red-500/15 text-red-300 hover:bg-red-500/25`;

/** A 32 px icon-only button in a header. */
export const ICON_BUTTON =
    'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-40';

/** The same, switched on. */
export const ICON_BUTTON_ACTIVE =
    'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[color:var(--accent-glow)] text-[color:var(--accent-primary)] transition-colors disabled:opacity-40';
