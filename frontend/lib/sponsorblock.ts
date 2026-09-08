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
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        segments.push({ start, end, category, uuid: typeof uuid === 'string' ? uuid : undefined });
    }
    return segments;
}

/** The notice shown when the server moves the room past a segment. */
export function skippedSegmentMessage(skipped: SkippedSegment): string {
    const seconds = Math.max(1, Math.round(skipped.end - skipped.start));
    return `Skipped ${sponsorCategoryLabel(skipped.category).toLowerCase()} (${seconds}s)`;
}
