/**
 * How many times a player may try to recover before it gives up.
 *
 * The budget is for one bad patch, not for the whole stream. It used to be a
 * counter that only a new source reset, so three unrelated hiccups across an
 * evening of a live stream — each recovered from — added up to "Playback
 * failed" on the fourth. Now it is whole again once playback has run cleanly
 * for `refillMs`; a stream failing in a tight loop never runs that long and
 * still runs out.
 */
export class RetryBudget {
    private spent = 0;
    /** When playback last started running cleanly, or null while it is not. */
    private cleanSince: number | null = null;
    /** Between a stall and the playback that ends it. */
    private stalling = false;

    constructor(private readonly max: number, private readonly refillMs: number) {}

    /** Take one retry. False when none is left. */
    spend(): boolean {
        if (this.spent >= this.max) return false;
        this.spent++;
        this.cleanSince = null;
        return true;
    }

    /** Playback started or resumed. */
    playing(now: number): void {
        this.stalling = false;
        if (this.cleanSince === null) this.cleanSince = now;
    }

    /** Playback stalled: whatever ran cleanly before this does not count. */
    stalled(): void {
        this.stalling = true;
        this.cleanSince = null;
    }

    /**
     * Playback moved on; refills the budget once it has run long enough.
     *
     * A recovery need not stall playback at all — a fatal playlist error that
     * a reload fixes while the buffer still has seconds in it — so there is no
     * `playing` to start the clean period after it. Progress outside a stall
     * starts it instead.
     */
    progressed(now: number): void {
        if (this.stalling) return;
        if (this.cleanSince === null) this.cleanSince = now;
        else if (now - this.cleanSince >= this.refillMs) this.spent = 0;
    }

    /** A new source starts with the whole budget. */
    reset(): void {
        this.spent = 0;
        this.cleanSince = null;
        this.stalling = false;
    }
}
