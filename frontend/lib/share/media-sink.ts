/**
 * The viewer's end of a relayed screen share: chunks in, a playing
 * `<video>` out.
 *
 * Media Source Extensions is the only way to hand a browser a stream of
 * container bytes that is still being produced. The element is given an
 * object URL for a `MediaSource`, and every chunk the server sends is
 * appended to a `SourceBuffer` behind it.
 *
 * Two properties of that buffer decide whether a share is watchable:
 *
 * * **`sequence` mode.** The chunks are timestamped from the moment the
 *   sharer started recording, not from the moment this viewer joined. In
 *   `segments` mode a late joiner would be told to play at 00:43 with
 *   nothing buffered before it; `sequence` re-times each append to follow
 *   the last one, so a viewer that joins late — or is restarted at the live
 *   edge after falling behind — plays from zero either way.
 * * **Trimming.** A live stream that is never trimmed grows for as long as
 *   it runs, inside the browser's media memory. Nobody scrubs back through
 *   a screen share, so everything older than `keepSeconds` is dropped.
 *
 * One `ShareSink` is one decode session. It is thrown away and replaced
 * whenever the server says `resync`, because a `SourceBuffer` that has been
 * fed a byte stream with a hole in it cannot be recovered — Chromium
 * answers `CHUNK_DEMUXER_ERROR_APPEND_FAILED` and stops. A fresh one, given
 * the header and then the live edge, is what works.
 */

import { SHARE_BUFFER_KEEP_SECONDS } from '../constants';

export class ShareSink {
    /** What the `<video>` element's `src` should be. */
    readonly url: string;

    private readonly media: MediaSource;
    private buffer: SourceBuffer | null = null;
    private readonly pending: ArrayBuffer[] = [];
    private disposed = false;

    constructor(
        private readonly mime: string,
        private readonly onError: (message: string) => void,
    ) {
        this.media = new MediaSource();
        this.url = URL.createObjectURL(this.media);
        this.media.addEventListener('sourceopen', () => this.open(), { once: true });
    }

    private open() {
        if (this.disposed) return;
        try {
            this.buffer = this.media.addSourceBuffer(this.mime);
            this.buffer.mode = 'sequence';
        } catch (error) {
            this.onError('This browser cannot play the shared screen.');
            console.error('[Share] Could not open a buffer for the share:', error);
            return;
        }
        this.buffer.addEventListener('updateend', () => this.pump());
        this.buffer.addEventListener('error', () => {
            this.onError('The shared screen stopped decoding.');
        });
        this.pump();
    }

    /** Hand one chunk from the server to the decoder, in order. */
    append(chunk: ArrayBuffer) {
        if (this.disposed) return;
        this.pending.push(chunk);
        this.pump();
    }

    /** How far the buffered stream now reaches, in seconds. */
    bufferedEnd(): number {
        const buffered = this.buffer?.buffered;
        return buffered && buffered.length ? buffered.end(buffered.length - 1) : 0;
    }

    private pump() {
        const buffer = this.buffer;
        if (this.disposed || !buffer || buffer.updating) return;
        // Trimming first: it frees the memory the next append may need, and
        // an append into a full buffer throws QuotaExceededError.
        if (this.trim()) return;
        const chunk = this.pending.shift();
        if (!chunk) return;
        try {
            buffer.appendBuffer(chunk);
        } catch (error) {
            // A buffer this browser has decided is full, or bytes it cannot
            // parse. Either way this session is over; the room reconnects.
            this.onError('The shared screen could not be decoded.');
            console.error('[Share] Could not append a chunk:', error);
        }
    }

    /** Drop what is far enough behind the playhead. Returns true if started. */
    private trim(): boolean {
        const buffer = this.buffer;
        if (!buffer || buffer.updating || !buffer.buffered.length) return false;
        const start = buffer.buffered.start(0);
        const end = buffer.buffered.end(buffer.buffered.length - 1);
        if (end - start <= SHARE_BUFFER_KEEP_SECONDS) return false;
        try {
            buffer.remove(start, end - SHARE_BUFFER_KEEP_SECONDS);
            return true;
        } catch {
            // Removing is best effort: a buffer that refuses only grows.
            return false;
        }
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.pending.length = 0;
        try {
            if (this.media.readyState === 'open') this.media.endOfStream();
        } catch {
            // Already torn down by the element letting go of it.
        }
        URL.revokeObjectURL(this.url);
    }
}
