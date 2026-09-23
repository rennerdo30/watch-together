/**
 * What a viewer wants automatic quality to optimise for.
 *
 * Auto quality is capped at the ladder rung that covers the player's
 * drawing surface, plus a rung of headroom. That cap exists for a reason —
 * a 4K rendition for a laptop-sized player means 13–28 MB segments and a
 * spinner after every seek — but it is a trade, and which side of it a
 * viewer wants depends on their screen, their link and their patience. A
 * viewer watching in a small window on a fast line was stuck below what
 * their connection could carry with no way to say otherwise.
 *
 * The mode is one viewer's choice about their own picture: it is kept in
 * their browser and never sent to the room.
 */

import { ABR_LEVELS_ABOVE_SURFACE } from './constants';

export type QualityMode = 'balanced' | 'highest' | 'saver';

export const DEFAULT_QUALITY_MODE: QualityMode = 'balanced';

/** Where this browser keeps the viewer's choice. */
export const QUALITY_MODE_STORAGE_KEY = 'w2g-player-quality-mode';

const QUALITY_MODES: readonly QualityMode[] = ['balanced', 'highest', 'saver'];

/** A stored or user-supplied value, or the default for anything else. */
export function parseQualityMode(value: string | null | undefined): QualityMode {
    return QUALITY_MODES.includes(value as QualityMode) ? (value as QualityMode) : DEFAULT_QUALITY_MODE;
}

/**
 * Rungs of headroom the mode allows above the covering rung, or `null` for
 * "do not cap at all" — which the caller must apply by *clearing* any cap
 * already in place, not by skipping the configuration.
 */
export function capHeadroom(mode: QualityMode): number | null {
    switch (mode) {
        case 'highest':
            return null;
        case 'saver':
            return 0;
        default:
            return ABR_LEVELS_ABOVE_SURFACE;
    }
}
