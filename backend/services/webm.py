"""
Finding the places a WebM stream can be picked up from.

A screen share is one continuous WebM byte stream, produced by
`MediaRecorder` and cut into chunks at arbitrary byte positions — the
recorder's `timeslice` has nothing to do with the container's structure.
That distinction is the difference between a share that works for everyone
and one that works for whoever was watching from the start.

Media Source Extensions takes two kinds of bytes: an **initialisation
segment** (for WebM: the EBML header, the segment information and the track
descriptions) and **media segments** (for WebM: clusters). A decoder can be
started with an initialisation segment followed by any cluster. It cannot be
started in the middle of a cluster, and Chromium does not fail politely when
you try — it answers `CHUNK_DEMUXER_ERROR_APPEND_FAILED` and the element
stops for good. Measured, in this project: joining at an arbitrary chunk
boundary fails roughly one time in eight.

So the relay does not hand a new viewer "the first chunk and then whatever
is live". It hands it the initialisation segment and then the stream from
the next *cluster*, which this module finds. Chromium starts a cluster at
every keyframe, so that boundary is also the first frame a decoder could
have used anyway.

Identifying a cluster is done on the bytes rather than by parsing the whole
stream, because a live WebM writes its Segment and its Clusters with
unknown sizes: there is nothing to skip over, only structure to recognise.
A candidate is accepted when it looks like a cluster all the way through —
the element ID, a well-formed size, and the Timecode child every cluster
begins with — which no four bytes of compressed video are going to manage
by accident.
"""
import logging
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

# EBML element IDs, as they appear on the wire.
CLUSTER_ID = b"\x1f\x43\xb6\x75"
TIMECODE_ID = 0xE7

# How many bytes of the previous chunk are kept, so that a cluster header
# split across two chunks is still recognised. The longest thing that has to
# be read to recognise one is the ID (4) plus a size (up to 8) plus the
# Timecode ID (1).
CARRY_BYTES = 13


def vint_length(first_byte: int) -> int:
    """How many bytes an EBML variable-length integer occupies, or 0.

    The length is written in unary: the number of leading zero bits before
    the first set bit is the number of extra bytes. A first byte of zero is
    not a valid start at all.
    """
    if first_byte == 0:
        return 0
    length = 1
    mask = 0x80
    while not first_byte & mask:
        mask >>= 1
        length += 1
    return length


def is_cluster_start(data: bytes, at: int) -> Optional[bool]:
    """Whether a cluster begins at `at`. None when there is not yet enough
    data to tell, which is a different answer from "no"."""
    if data[at:at + len(CLUSTER_ID)] != CLUSTER_ID:
        return False
    size_at = at + len(CLUSTER_ID)
    if size_at >= len(data):
        return None
    length = vint_length(data[size_at])
    if length == 0:
        return False
    child_at = size_at + length
    if child_at >= len(data):
        return None
    return data[child_at] == TIMECODE_ID


class ClusterScanner:
    """Follows one share's byte stream and reports where clusters begin.

    Fed the chunks in order, it answers with the absolute offset of each new
    cluster and the bytes of the stream from that point to the end of the
    chunk — which is exactly what a viewer starting there must be sent
    before the chunks that follow.
    """

    def __init__(self):
        self._carry = b""
        # Absolute offset, in the whole stream, of the first byte of the
        # next chunk to arrive.
        self._position = 0
        self._last_reported = -1

    def feed(self, chunk: bytes) -> Optional[Tuple[int, bytes]]:
        """The first cluster starting in this chunk, as (offset, bytes)."""
        data = self._carry + chunk
        base = self._position - len(self._carry)
        found: Optional[Tuple[int, bytes]] = None

        at = data.find(CLUSTER_ID)
        while at != -1:
            absolute = base + at
            if absolute > self._last_reported and is_cluster_start(data, at):
                self._last_reported = absolute
                found = (absolute, data[at:])
                break
            at = data.find(CLUSTER_ID, at + 1)

        self._position += len(chunk)
        self._carry = data[-CARRY_BYTES:]
        return found
