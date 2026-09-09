/**
 * Storyboards: a video sampled every few seconds into tiled image sheets,
 * shown as the preview while hovering the seek bar.
 *
 * Sheet `n` holds frames `n * rows * columns` onwards, laid out left to
 * right, top to bottom, each `width` by `height` pixels. The server picks
 * one storyboard size per video (see the resolver); this module only maps
 * a time to the frame that stands for it.
 */

export interface Storyboard {
    width: number;
    height: number;
    rows: number;
    columns: number;
    /** Seconds each frame stands for. */
    frame_duration: number;
    /** One image URL per sheet, in order. */
    sheets: string[];
}

export interface StoryboardFrame {
    url: string;
    /** Offset of the frame inside its sheet, in pixels. */
    x: number;
    y: number;
    width: number;
    height: number;
}

/** The frame standing for `time` seconds, or null when the storyboard cannot say. */
export function storyboardFrame(storyboard: Storyboard, time: number): StoryboardFrame | null {
    const { width, height, rows, columns, frame_duration: frameDuration, sheets } = storyboard;
    if (!(frameDuration > 0) || rows < 1 || columns < 1 || sheets.length === 0 || !Number.isFinite(time)) {
        return null;
    }
    const perSheet = rows * columns;
    const index = Math.max(0, Math.floor(time / frameDuration));
    const sheet = Math.min(sheets.length - 1, Math.floor(index / perSheet));
    // The last sheet may be short; clamp into it rather than past it.
    const within = Math.min(perSheet - 1, index - sheet * perSheet);
    return {
        url: sheets[sheet],
        x: (within % columns) * width,
        y: Math.floor(within / columns) * height,
        width,
        height,
    };
}
