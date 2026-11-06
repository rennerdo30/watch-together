/**
 * How long a queue runs: each entry's length and the sum of them all.
 *
 * Only entries with a known length count. A livestream has no end and an
 * entry the server is still resolving has no length yet; either makes the
 * total a lower bound, which the queue says rather than hides.
 */

interface QueueLengthEntry {
    duration?: number;
    is_live?: boolean;
    pending?: boolean;
}

export interface QueueLength {
    /** Seconds of every entry with a known length. */
    seconds: number;
    /** Entries the total leaves out: live, still resolving, or of unknown length. */
    unknown: number;
}

/** The entry's length in seconds, or null when it has none to show. */
export function entryLength(entry: QueueLengthEntry): number | null {
    if (entry.pending || entry.is_live) return null;
    const { duration } = entry;
    return typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : null;
}

export function queueLength(entries: readonly QueueLengthEntry[]): QueueLength {
    let seconds = 0;
    let unknown = 0;
    for (const entry of entries) {
        const length = entryLength(entry);
        if (length === null) unknown += 1;
        else seconds += length;
    }
    return { seconds, unknown };
}
