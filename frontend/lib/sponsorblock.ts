/**
 * SponsorBlock on the client: the vocabulary shared with the server and the
 * labels shown for it.
 *
 * Skipping itself happens on the server, which moves the whole room past a
 * segment with one seek. The client's part is to show the admin's setting,
 * mark segments on the seek bar, and say why the room just jumped.
 */

export const SPONSORBLOCK_CATEGORIES = [
    'sponsor',
    'selfpromo',
    'interaction',
    'intro',
    'outro',
    'preview',
    'filler',
    'music_offtopic',
    'exclusive_access',
] as const;

export type SponsorCategory = (typeof SPONSORBLOCK_CATEGORIES)[number];

/**
 * The point viewers marked as where the video gets going ("Highlight" in
 * SponsorBlock). The server sends it among the segments with `start === end`;
 * it is offered as a jump, never skipped to.
 */
export const HIGHLIGHT_CATEGORY = 'poi_highlight';
export const HIGHLIGHT_COLOR = '#ff1684';

/** Matches the server's defaults; used until the room's `sync` arrives. */
export const DEFAULT_SPONSORBLOCK_SETTINGS: SponsorBlockSettings = {
    enabled: true,
    categories: ['sponsor', 'selfpromo', 'interaction'],
};

export interface SponsorBlockSettings {
    enabled: boolean;
    categories: SponsorCategory[];
}

export interface SponsorSegment {
    start: number;
    end: number;
    category: SponsorCategory | string;
    uuid?: string;
}

/** What the room was moved past, as attached to the server's seek. */
export interface SkippedSegment {
    category: string;
    start: number;
    end: number;
}

/**
 * Where the segment data comes from, and its licence. The licence
 * (CC BY-NC-SA 4.0) requires attribution wherever the feature is offered.
 */
export const SPONSORBLOCK_SITE = 'https://sponsor.ajay.app/';
export const SPONSORBLOCK_LICENSE = 'https://creativecommons.org/licenses/by-nc-sa/4.0/';

export const SPONSOR_CATEGORY_LABELS: Record<SponsorCategory, string> = {
    sponsor: 'Sponsor',
    selfpromo: 'Unpaid / self promotion',
    interaction: 'Interaction reminder',
    intro: 'Intermission / intro animation',
    outro: 'Endcards / credits',
    preview: 'Preview / recap',
    filler: 'Filler tangent',
    music_offtopic: 'Music: non-music section',
    exclusive_access: 'Exclusive access',
};

/** The seek-bar colour of each category, following SponsorBlock's own palette. */
export const SPONSOR_CATEGORY_COLORS: Record<SponsorCategory, string> = {
    sponsor: '#00d400',
    selfpromo: '#ffff00',
    interaction: '#cc00ff',
    intro: '#00ffff',
    outro: '#0202ed',
    preview: '#008fd6',
    filler: '#7300ff',
    music_offtopic: '#ff9900',
    exclusive_access: '#008a5c',
};

const FALLBACK_COLOR = '#ffffff';

export function isSponsorCategory(value: string): value is SponsorCategory {
    return (SPONSORBLOCK_CATEGORIES as readonly string[]).includes(value);
}

export function sponsorCategoryLabel(category: string): string {
    return isSponsorCategory(category) ? SPONSOR_CATEGORY_LABELS[category] : category;
}

export function sponsorCategoryColor(category: string): string {
    return isSponsorCategory(category) ? SPONSOR_CATEGORY_COLORS[category] : FALLBACK_COLOR;
}

/** Accept whatever the server sent, keeping only what the client understands. */
export function parseSponsorBlockSettings(raw: unknown): SponsorBlockSettings | null {
    if (!raw || typeof raw !== 'object') return null;
    const candidate = raw as { enabled?: unknown; categories?: unknown };
    const categories = Array.isArray(candidate.categories)
        ? candidate.categories.filter((c): c is SponsorCategory => typeof c === 'string' && isSponsorCategory(c))
        : DEFAULT_SPONSORBLOCK_SETTINGS.categories;
    return { enabled: Boolean(candidate.enabled), categories };
}

export function parseSponsorSegments(raw: unknown): SponsorSegment[] {
    if (!Array.isArray(raw)) return [];
    const segments: SponsorSegment[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const { start, end, category, uuid } = entry as Record<string, unknown>;
        if (typeof start !== 'number' || typeof end !== 'number' || typeof category !== 'string') continue;
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        // Only the highlight is a point; anything else must have a length.
        if (category === HIGHLIGHT_CATEGORY ? start < 0 : end <= start) continue;
        segments.push({ start, end, category, uuid: typeof uuid === 'string' ? uuid : undefined });
    }
    return segments;
}

/** Where the video's highlight is, if it has one. */
export function sponsorHighlight(segments: readonly SponsorSegment[]): number | null {
    const highlight = segments.find((segment) => segment.category === HIGHLIGHT_CATEGORY);
    return highlight ? highlight.start : null;
}

/** Whether the jump to the highlight is still worth offering at `currentTime`. */
export function highlightAhead(highlight: number | null, currentTime: number): highlight is number {
    return highlight !== null && currentTime < highlight - HIGHLIGHT_PASSED_SECONDS;
}

/** Once playback is this close to the highlight, or past it, it has been reached. */
const HIGHLIGHT_PASSED_SECONDS = 1;

/** The notice shown when the server moves the room past a segment. */
export function skippedSegmentMessage(skipped: SkippedSegment): string {
    const seconds = Math.max(1, Math.round(skipped.end - skipped.start));
    return `Skipped ${sponsorCategoryLabel(skipped.category).toLowerCase()} (${seconds}s)`;
}
