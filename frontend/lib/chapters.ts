/**
 * Chapters — "sections" on YouTube: named stretches of a video, set by the
 * creator or read from timestamps in the description. The server delivers
 * them sorted by start with the resolved video; this module maps a time to
 * the chapter that contains it.
 */

export interface VideoChapter {
    /** Seconds from the start of the video. */
    start: number;
    end: number;
    title: string;
}

/** The chapter containing `time`, or null before the first one / with none. */
export function chapterAt(chapters: readonly VideoChapter[], time: number): VideoChapter | null {
    if (!Number.isFinite(time)) return null;
    let found: VideoChapter | null = null;
    for (const chapter of chapters) {
        if (chapter.start > time) break;
        found = chapter;
    }
    return found;
}

export function formatChapterTime(seconds: number): string {
    const whole = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const secs = whole % 60;
    const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
    return `${hours > 0 ? `${hours}:` : ''}${mm}:${String(secs).padStart(2, '0')}`;
}
