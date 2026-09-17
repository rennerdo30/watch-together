"""
Fragmented MP4 box scanning.

yt-dlp hands us adaptive streams as single fragmented-MP4 files served
over range requests: no manifest, no segment list. A DASH player can
still play them, but only if the manifest states where the
initialization segment ends and where the segment index (`sidx`) lives.

Both facts sit in the first few kilobytes of the file, in the ISO-BMFF
box headers, so a single small range request is enough to find them.
"""
import bisect
import struct
import logging
from dataclasses import dataclass
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

# Box header: 4-byte size + 4-byte type. Size 1 means a 64-bit size
# follows the header; size 0 means the box runs to end of file.
_HEADER_SIZE = 8
_LARGE_SIZE_MARKER = 1
_TO_EOF_MARKER = 0

# Boxes that make up the initialization segment, in file order.
_INIT_BOXES = (b"ftyp", b"moov")
_INDEX_BOX = b"sidx"

# `sidx` layout (ISO/IEC 14496-12): after the box header come a version byte
# and three flag bytes, then reference_ID and timescale; the presentation
# time and first offset are 32-bit in version 0 and 64-bit above it; then two
# reserved bytes, the reference count, and that many 12-byte entries.
_FULLBOX_HEADER = 12
_REFERENCE_ENTRY = 12
_SIZE_MASK = 0x7FFFFFFF


@dataclass(frozen=True)
class Mp4Index:
    """Byte ranges a DASH manifest needs to describe a single file."""
    init_start: int
    init_end: int      # inclusive
    index_start: int
    index_end: int     # inclusive

    @property
    def init_range(self) -> str:
        return f"{self.init_start}-{self.init_end}"

    @property
    def index_range(self) -> str:
        return f"{self.index_start}-{self.index_end}"


def scan_boxes(data: bytes):
    """Yield (box_type, start_offset, end_offset_exclusive) for top-level boxes.

    Stops when the buffer runs out mid-box, so a partial download is
    fine as long as the boxes of interest are complete.
    """
    offset = 0
    total = len(data)

    while offset + _HEADER_SIZE <= total:
        (size,) = struct.unpack_from(">I", data, offset)
        box_type = data[offset + 4:offset + 8]
        header_size = _HEADER_SIZE

        if size == _LARGE_SIZE_MARKER:
            if offset + 16 > total:
                return
            (size,) = struct.unpack_from(">Q", data, offset + 8)
            header_size = 16
        elif size == _TO_EOF_MARKER:
            yield box_type, offset, total
            return

        if size < header_size:
            logger.debug("Malformed box %r with size %d", box_type, size)
            return

        end = offset + size
        yield box_type, offset, end

        if end <= offset:
            return
        offset = end


def index_span(data: bytes) -> Optional[int]:
    """Bytes needed from the start of the file to hold the whole `sidx`.

    A box header states its own size, so a truncated prefix still says
    exactly how much more is required. A `sidx` carries 12 bytes per
    segment, which for a multi-hour livestream VOD runs past any fixed
    probe: 56 KB at 6.5 hours, 101 KB at 12, 159 KB at 19. Returning the
    real figure lets the caller ask for precisely that instead of giving
    up on the rendition.

    Returns None when the prefix holds no `sidx` header at all, which
    means either a larger prefix is needed to reach it or the file is not
    a fragmented MP4.
    """
    for box_type, _start, end in scan_boxes(data):
        if box_type == _INDEX_BOX:
            return end
    return None


def parse_index(data: bytes) -> Optional[Mp4Index]:
    """Locate the initialization segment and segment index in a prefix.

    Returns None when the prefix does not contain a complete `sidx`,
    which means a larger prefix is needed (or the file is not a
    fragmented MP4 at all).
    """
    init_end = None
    index = None

    for box_type, start, end in scan_boxes(data):
        if box_type in _INIT_BOXES:
            init_end = end
        elif box_type == _INDEX_BOX:
            if end > len(data):
                logger.debug("sidx truncated: needs %d bytes, have %d", end, len(data))
                return None
            index = (start, end)
            break

    if init_end is None or index is None:
        return None

    index_start, index_end = index
    if index_start != init_end:
        # Anything between moov and sidx (free/skip boxes) belongs to the
        # initialization segment as far as the player is concerned.
        init_end = index_start

    return Mp4Index(
        init_start=0,
        init_end=init_end - 1,
        index_start=index_start,
        index_end=index_end - 1,
    )


@dataclass(frozen=True)
class SegmentTable:
    """Where each subsegment of a fragmented MP4 starts, in bytes and seconds.

    The `sidx` box the manifest needs for its byte ranges also describes
    every subsegment's size and duration. Read once, that turns a playback
    position into the byte offset serving it — which is what makes it
    possible to warm the bytes a viewer is about to need after a jump,
    rather than guessing from the file's average bitrate. A jump is exactly
    where a guess is worst: bitrate varies, and being 5 % wrong on a 200 MB
    rendition warms the wrong ten megabytes.
    """

    #: Byte offset of each subsegment, in file order.
    offsets: Tuple[int, ...]
    #: Presentation time each subsegment starts at, in seconds.
    starts: Tuple[float, ...]
    #: Total duration the index covers, in seconds.
    duration: float

    def offset_at(self, seconds: float) -> Optional[int]:
        """Byte offset of the subsegment covering `seconds`.

        A position past the end has no subsegment; a position before the
        start belongs to the first one.
        """
        if not self.offsets or seconds < 0 or seconds >= self.duration:
            return None
        position = bisect.bisect_right(self.starts, seconds) - 1
        return self.offsets[max(0, position)]


def parse_segment_table(data: bytes, index: Mp4Index) -> Optional[SegmentTable]:
    """Read the subsegment table out of an already-located `sidx`.

    `data` is the same prefix `parse_index` read, so this costs no extra
    request. Returns None when the box is truncated or malformed rather
    than raising: a rendition whose index cannot be read still plays, it
    just cannot be warmed ahead of a jump.
    """
    start = index.index_start
    end = index.index_end + 1
    if start + _FULLBOX_HEADER > len(data) or end > len(data):
        return None

    (version,) = struct.unpack_from(">B", data, start + 8)
    cursor = start + _FULLBOX_HEADER
    try:
        (timescale,) = struct.unpack_from(">I", data, cursor + 4)
        cursor += 8
        # earliest_presentation_time and first_offset, both of which widen
        # together above version 0.
        if version == 0:
            (_earliest, first_offset) = struct.unpack_from(">II", data, cursor)
            cursor += 8
        else:
            (_earliest, first_offset) = struct.unpack_from(">QQ", data, cursor)
            cursor += 16
        (reference_count,) = struct.unpack_from(">H", data, cursor + 2)
        cursor += 4
    except struct.error:
        return None

    if not timescale or not reference_count:
        return None
    if cursor + reference_count * _REFERENCE_ENTRY > end:
        logger.debug("sidx declares %d references but the box ends early", reference_count)
        return None

    offsets = []
    starts = []
    # The first subsegment begins where the index box ends, plus whatever
    # the box itself declares.
    offset = end + first_offset
    ticks = 0
    for _ in range(reference_count):
        (raw_size, raw_duration) = struct.unpack_from(">II", data, cursor)
        cursor += _REFERENCE_ENTRY
        offsets.append(offset)
        starts.append(ticks / timescale)
        offset += raw_size & _SIZE_MASK
        ticks += raw_duration

    return SegmentTable(
        offsets=tuple(offsets),
        starts=tuple(starts),
        duration=ticks / timescale,
    )
