"""
One member's screen, carried to the room by this server.

The media path is deliberately *through here*. The origin publishes no
ports and the tunnel in front of it carries HTTP and WebSocket only, so a
browser-to-browser path cannot be relied on: the owner chose a relay this
deployment can actually open, and accepted what it costs.

What it costs, plainly:

* **Latency.** A frame is encoded into a container chunk, the chunk is
  pushed up a WebSocket, copied here, pushed down another WebSocket, and
  appended to a `SourceBuffer` before the decoder sees it. Half a second to
  two seconds, against roughly two hundred milliseconds for a direct peer
  connection. `SHARE_TIMESLICE_MS` in the frontend is the knob; nothing
  here can make the chunk arrive before it has been encoded.
* **Bandwidth, on the server.** The sharer uploads one copy; this process
  sends one copy *per viewer*. Five viewers of an 8 Mbit/s capture is
  40 Mbit/s leaving a single Python worker, on top of the segment proxy.
* **A custom pipeline.** `MediaRecorder` on one side and `MediaSource` on
  the other, instead of a transport the browser maintains for us. There is
  no congestion control in it: if a viewer cannot keep up, this module
  decides what happens, which is what the rest of this file is about.

The shape of the wire protocol, so it can be read in one place:

    publisher -> server   text  {"type": "format", "mime": "video/webm;..."}
    publisher -> server   binary  the stream, in chunks of SHARE_TIMESLICE_MS

    server -> viewer      text  {"type": "format", "mime": ...}
    server -> viewer      binary  the retained initialisation segment
    server -> viewer      binary  the stream from the next cluster onwards
    server -> viewer      text  {"type": "resync"}   (see below)
    server -> viewer      text  {"type": "ended"} / {"type": "too_slow"}

**The header is the whole reason this module keeps state.** A WebM stream
begins with an EBML header and the track descriptions, and everything after
it is meaningless without them. A viewer that joins a minute in has to be
given those bytes before any live ones, so they are retained per room for
the life of the share — that is the difference between a feature that works
and one that works if you were already there.

**Where a viewer is allowed to start.** Not at an arbitrary chunk: the
recorder's chunk boundaries are wherever a quarter of a second happened to
fall, and appending from the middle of a cluster makes Chromium's demuxer
fail outright (`CHUNK_DEMUXER_ERROR_APPEND_FAILED` — measured here, at
roughly one join in eight). Every viewer therefore starts at the
initialisation segment followed by the next *cluster*, which
`services/webm.py` finds in the stream. A cluster begins at a keyframe, so
this is also the first frame a decoder could have used. It costs a joining
viewer up to one keyframe interval before the picture appears.

**What happens under overload.** Each viewer has its own bounded queue and
its own sending task, so a viewer on a bad connection can never block the
sharer, another viewer, or the event loop — the worst it can do is fill its
own queue. When it does, the backlog is *dropped whole* rather than
trimmed: skipping bytes inside a cluster corrupts the stream exactly as
above. The viewer is told to rebuild its decoder (`resync`) and is then
started again the way a new viewer is: initialisation segment, next
cluster, live. It keeps whatever frame it had until then. A viewer that
needs this more than `SHARE_VIEWER_MAX_RESYNCS` times inside
`SHARE_VIEWER_RESYNC_WINDOW_SECONDS` is not going to recover, and is closed
with a message saying so rather than left staring at a still frame.

**Memory is bounded on every axis**, because this process also holds the
room state, the segment caches and the rate limiter: at most
`SHARE_RELAY_MAX_ROOMS` rooms relay at once, each with at most
`SHARE_RELAY_MAX_VIEWERS` viewers, each queue holding at most
`SHARE_VIEWER_QUEUE_MAX_BYTES`, plus one retained initialisation segment of
at most `SHARE_HEADER_MAX_BYTES` per room.
"""
import asyncio
import json
import logging
import time
from collections import deque
from typing import Deque, Dict, List, Optional, Tuple

from core import config
from services.webm import ClusterScanner

logger = logging.getLogger(__name__)

# What a queued item is. Text carries control messages, binary carries
# media, and close is the last thing a viewer's queue can hold.
_TEXT = "text"
_BINARY = "binary"
_CLOSE = "close"

_QueueItem = Tuple[str, object]


class RelayRefused(Exception):
    """This socket may not join the relay, with the close code to say so."""

    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class ShareViewer:
    """One browser watching, and the queue standing between it and the wire."""

    def __init__(self, viewer_id: int, socket, label: str):
        self.id = viewer_id
        self.socket = socket
        # Who is watching, for the log. Never sent to anyone else.
        self.label = label
        self.queue: Deque[_QueueItem] = deque()
        self.queued_bytes = 0
        self.wake = asyncio.Event()
        # Whether this viewer has been started — given the format, the
        # initialisation segment and a cluster to decode from. Until then it
        # is waiting for the next cluster and is sent nothing.
        self.primed = False
        # Whether the start it is waiting for is a restart, which its player
        # has to be told about so it can rebuild its decoder first.
        self.resyncing = False
        # `closing` means no more media is queued for this viewer, but what
        # is already queued — the notice telling it why — still has to go
        # out. `finished` means the socket is gone and the pump stops.
        self.closing = False
        self.finished = False
        # When this viewer last had to be resynchronised, inside the window
        # that decides whether it is merely unlucky or simply too slow.
        self.resyncs: Deque[float] = deque()
        self.dropped_chunks = 0

    def _put(self, kind: str, item: object) -> None:
        self.queue.append((kind, item))
        if kind == _BINARY:
            self.queued_bytes += len(item)  # type: ignore[arg-type]
        self.wake.set()

    def take(self) -> Optional[_QueueItem]:
        """The next thing to send, or None when the queue has run dry."""
        if not self.queue:
            return None
        kind, item = self.queue.popleft()
        if kind == _BINARY:
            self.queued_bytes -= len(item)  # type: ignore[arg-type]
        return kind, item

    def clear(self) -> int:
        """Drop the backlog. Returns how many media chunks went with it."""
        dropped = sum(1 for kind, _ in self.queue if kind == _BINARY)
        self.queue.clear()
        self.queued_bytes = 0
        return dropped


class RoomRelay:
    """The relay for one room: its publisher, its header, its viewers."""

    def __init__(self, room_id: str, connection_id: str, email: str):
        self.room_id = room_id
        # The room connection the sharer holds. The media socket is a
        # different connection, so this is what ties the two together.
        self.connection_id = connection_id
        self.email = email
        self.mime: Optional[str] = None
        # The initialisation segment: every byte before the stream's first
        # cluster. Retained for the life of the share, because it is what a
        # viewer's decoder is built from however late it arrives.
        self.init: Optional[bytes] = None
        # The stream so far, kept only until the first cluster shows where
        # the initialisation segment ends.
        self.prefix = b""
        self.scanner = ClusterScanner()
        # Whether the sharer's media socket has arrived. The relay exists
        # from the moment the room is told about the share, so that a viewer
        # connecting on that announcement has something to attach to; the
        # media socket opens a moment later.
        self.publishing = False
        self.viewers: Dict[int, ShareViewer] = {}
        self.chunks_in = 0
        self.bytes_in = 0
        self.started_at = time.monotonic()

    def format_message(self) -> str:
        return json.dumps({"type": config.SHARE_CONTROL_FORMAT, "mime": self.mime})


class ShareRelay:
    """Every room relaying a screen right now.

    Single worker, single event loop: nothing here awaits while mutating,
    so no lock is needed — and a second worker would hold a second, empty
    copy of this, which is one of the reasons startup refuses one.
    """

    def __init__(self):
        self._rooms: Dict[str, RoomRelay] = {}
        self._next_viewer_id = 1

    # --- the sharer ---------------------------------------------------------

    def open(self, room_id: str, connection_id: str, email: str) -> RoomRelay:
        """Make room for a share that has just been announced, or refuse it.

        Called when the room accepts `share_start`, not when the media
        socket opens: a viewer reacting to the announcement would otherwise
        arrive before there was anything to attach it to.
        """
        existing = self._rooms.get(room_id)
        if existing is not None:
            # The room's own one-sharer rule should have caught this. If it
            # did not, the first share keeps the room: replacing it would
            # hand its viewers a byte stream whose header they never got.
            raise RelayRefused(
                config.SHARE_CLOSE_BUSY,
                "This room is already relaying a screen share",
            )
        if len(self._rooms) >= config.SHARE_RELAY_MAX_ROOMS:
            logger.warning(
                "Refused a screen share in %s: %d rooms are already relaying, "
                "which is the ceiling this worker's memory is sized for",
                room_id, len(self._rooms),
            )
            raise RelayRefused(
                config.SHARE_CLOSE_BUSY,
                "This server is already carrying as many screen shares as it can",
            )
        relay = RoomRelay(room_id, connection_id, email)
        self._rooms[room_id] = relay
        logger.info("Screen share relay opened for %s by %s", room_id, email)
        return relay

    def relay_of(self, room_id: str) -> Optional[RoomRelay]:
        return self._rooms.get(room_id)

    def attach_publisher(self, room_id: str, connection_id: str) -> RoomRelay:
        """Accept the sharer's media socket for a share already announced."""
        relay = self._rooms.get(room_id)
        if relay is None or relay.connection_id != connection_id:
            raise RelayRefused(
                config.SHARE_CLOSE_NO_SHARE,
                "This share is no longer running",
            )
        if relay.publishing:
            raise RelayRefused(
                config.SHARE_CLOSE_BUSY,
                "This share already has a media connection",
            )
        relay.publishing = True
        return relay

    def set_format(self, room_id: str, mime: str) -> None:
        """Record what the sharer is encoding, and tell anyone waiting.

        Announced once, before the first chunk: a `SourceBuffer` has to be
        created with the exact MIME type the recorder produced.
        """
        relay = self._rooms.get(room_id)
        if relay is None:
            return
        relay.mime = mime[:config.SHARE_FORMAT_MAX_LENGTH]
        logger.info("Screen share in %s is %s", room_id, relay.mime)

    def publish(self, room_id: str, chunk: bytes) -> None:
        """Fan one chunk out to every viewer of this room.

        Never blocks on a viewer: enqueueing is a memory write, and the
        per-viewer task does the sending.
        """
        relay = self._rooms.get(room_id)
        if relay is None:
            return
        relay.chunks_in += 1
        relay.bytes_in += len(chunk)

        # Where this chunk could be picked up from, if at all. Most chunks
        # are the middle of a cluster and offer nowhere to start.
        boundary = relay.scanner.feed(chunk)

        if relay.init is None:
            relay.prefix += chunk
            if len(relay.prefix) > config.SHARE_HEADER_MAX_BYTES:
                raise RelayRefused(
                    config.SHARE_CLOSE_PROTOCOL,
                    "The share's opening bytes are too large to retain",
                )
            if boundary is not None:
                # Everything before the first cluster is the initialisation
                # segment: the EBML header, the segment information and the
                # track descriptions. Nothing after it decodes without it.
                offset, _segment = boundary
                relay.init = relay.prefix[:offset]
                relay.prefix = b""
                logger.info(
                    "Kept the initialisation segment for the share in %s (%d bytes)",
                    room_id, len(relay.init),
                )

        for viewer in list(relay.viewers.values()):
            if viewer.closing or viewer.finished:
                continue
            if viewer.primed:
                self._offer(relay, viewer, chunk)
            elif boundary is not None:
                self._start(relay, viewer, boundary[1])

    def close_publisher(self, room_id: str, connection_id: str) -> None:
        """The sharer's media socket is gone; end the relay for this room."""
        relay = self._rooms.get(room_id)
        if relay is None or relay.connection_id != connection_id:
            return
        self.end(room_id, config.SHARE_CONTROL_ENDED)

    def end(self, room_id: str, reason: str = config.SHARE_CONTROL_ENDED) -> None:
        """Tear the room's relay down, telling every viewer why."""
        relay = self._rooms.pop(room_id, None)
        if relay is None:
            return
        for viewer in list(relay.viewers.values()):
            self._finish(viewer, config.SHARE_CLOSE_ENDED, reason)
        logger.info(
            "Screen share relay for %s closed after %.0fs: %d chunks, %.1f MB in, "
            "%d viewers at the end",
            room_id, time.monotonic() - relay.started_at, relay.chunks_in,
            relay.bytes_in / 1_000_000, len(relay.viewers),
        )

    # --- viewers ------------------------------------------------------------

    def add_viewer(self, room_id: str, socket, label: str) -> ShareViewer:
        """Attach one watching browser. It starts at the next cluster."""
        relay = self._rooms.get(room_id)
        if relay is None:
            raise RelayRefused(
                config.SHARE_CLOSE_NO_SHARE,
                "Nobody is sharing a screen in this room",
            )
        if len(relay.viewers) >= config.SHARE_RELAY_MAX_VIEWERS:
            logger.warning(
                "Refused a viewer for the share in %s: %d are already watching",
                room_id, len(relay.viewers),
            )
            raise RelayRefused(
                config.SHARE_CLOSE_TOO_MANY_VIEWERS,
                "This share already has as many viewers as the server will carry",
            )
        viewer = ShareViewer(self._next_viewer_id, socket, label)
        self._next_viewer_id += 1
        relay.viewers[viewer.id] = viewer
        logger.info(
            "%s is watching the share in %s (%d viewers)",
            label, room_id, len(relay.viewers),
        )
        return viewer

    def remove_viewer(self, room_id: str, viewer: ShareViewer) -> None:
        relay = self._rooms.get(room_id)
        viewer.finished = True
        viewer.wake.set()
        if relay is None:
            return
        relay.viewers.pop(viewer.id, None)
        if viewer.dropped_chunks:
            logger.info(
                "%s stopped watching the share in %s after dropping %d chunks",
                viewer.label, room_id, viewer.dropped_chunks,
            )

    def viewer_count(self, room_id: str) -> int:
        relay = self._rooms.get(room_id)
        return len(relay.viewers) if relay else 0

    async def pump(self, viewer: ShareViewer) -> None:
        """Send one viewer its queue, forever, on its own task.

        This is the only place a relayed byte is written to a socket. It is
        per viewer on purpose: `send_bytes` on a congested connection waits
        for the transport, and one such wait must not hold up the sharer or
        anybody else's picture.
        """
        try:
            while not viewer.finished:
                await viewer.wake.wait()
                viewer.wake.clear()
                while True:
                    item = viewer.take()
                    if item is None:
                        break
                    kind, payload = item
                    if kind == _CLOSE:
                        code, reason = payload  # type: ignore[misc]
                        await viewer.socket.close(code=code, reason=reason)
                        return
                    if kind == _TEXT:
                        await viewer.socket.send_text(payload)  # type: ignore[arg-type]
                    else:
                        await viewer.socket.send_bytes(payload)  # type: ignore[arg-type]
                if viewer.finished:
                    return
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # The viewer's connection broke mid-send. Its socket handler is
            # about to see the same thing and clean up.
            logger.info("Stopped sending the share to %s: %s", viewer.label, exc)
            viewer.finished = True

    # --- the parts that decide what a slow viewer sees ----------------------

    def _start(self, relay: RoomRelay, viewer: ShareViewer, segment: bytes) -> None:
        """Start one viewer at a cluster: format, initialisation, decodable bytes.

        `segment` runs from the first byte of a cluster to the end of the
        chunk it arrived in, so what the viewer receives is a stream it can
        be given to a `SourceBuffer` from its very first byte.
        """
        if viewer.primed or viewer.closing or viewer.finished:
            return
        if relay.mime is None or relay.init is None:
            return
        if viewer.resyncing:
            # Its decoder has been fed a stream with a hole in it and will
            # never recover; the player throws it away and builds another.
            viewer._put(_TEXT, json.dumps({"type": config.SHARE_CONTROL_RESYNC}))
            viewer.resyncing = False
        viewer._put(_TEXT, relay.format_message())
        viewer._put(_BINARY, relay.init)
        viewer._put(_BINARY, segment)
        viewer.primed = True

    def _offer(self, relay: RoomRelay, viewer: ShareViewer, chunk: bytes) -> None:
        """Queue one chunk, or restart a viewer that is falling behind."""
        over_bytes = viewer.queued_bytes + len(chunk) > config.SHARE_VIEWER_QUEUE_MAX_BYTES
        over_chunks = len(viewer.queue) >= config.SHARE_VIEWER_QUEUE_MAX_CHUNKS
        if not (over_bytes or over_chunks):
            viewer._put(_BINARY, chunk)
            return

        now = time.monotonic()
        viewer.resyncs.append(now)
        while viewer.resyncs and now - viewer.resyncs[0] > config.SHARE_VIEWER_RESYNC_WINDOW_SECONDS:
            viewer.resyncs.popleft()
        if len(viewer.resyncs) > config.SHARE_VIEWER_MAX_RESYNCS:
            logger.warning(
                "Dropping %s from the share in %s: %d restarts in %.0fs, "
                "this connection cannot carry it",
                viewer.label, relay.room_id, len(viewer.resyncs),
                config.SHARE_VIEWER_RESYNC_WINDOW_SECONDS,
            )
            self._finish(viewer, config.SHARE_CLOSE_TOO_SLOW, config.SHARE_CONTROL_TOO_SLOW)
            return

        # The backlog goes whole — trimming it would leave a hole inside a
        # cluster, which is worse than a gap — and this viewer waits for the
        # next cluster like any newcomer. Its player keeps the last frame it
        # decoded until then.
        viewer.dropped_chunks += viewer.clear()
        viewer.primed = False
        viewer.resyncing = True
        logger.info(
            "Restarting %s on the share in %s: its queue filled up, so the "
            "backlog is dropped and it rejoins at the next cluster",
            viewer.label, relay.room_id,
        )

    def _finish(self, viewer: ShareViewer, code: int, reason: str) -> None:
        """Stop sending media to this viewer and close it with a reason.

        The backlog goes, the explanation does not: a viewer that is cut off
        has to be able to say why, which is the difference between a player
        that reports "your connection could not keep up" and one that simply
        stops moving.
        """
        if viewer.closing or viewer.finished:
            return
        viewer.clear()
        viewer.closing = True
        viewer._put(_TEXT, json.dumps({"type": reason}))
        viewer._put(_CLOSE, (code, reason))

    # --- diagnostics --------------------------------------------------------

    def snapshot(self) -> List[dict]:
        """What is being relayed right now, for logs and the admin view."""
        return [
            {
                "room_id": relay.room_id,
                "email": relay.email,
                "mime": relay.mime,
                "viewers": len(relay.viewers),
                "chunks_in": relay.chunks_in,
                "bytes_in": relay.bytes_in,
                "queued_bytes": sum(v.queued_bytes for v in relay.viewers.values()),
                "waiting_for_a_cluster": sum(
                    1 for v in relay.viewers.values() if not v.primed),
            }
            for relay in self._rooms.values()
        ]


# One relay for the process, like every other piece of room state here.
relay = ShareRelay()
