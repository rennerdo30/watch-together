"""
Finding the point in a screen share's byte stream a viewer can start at.

This is the difference between a share that works for whoever joins and one
that works for whoever was already watching. Chromium accepts an
initialisation segment followed by a cluster, and fails permanently —
`CHUNK_DEMUXER_ERROR_APPEND_FAILED` — when handed the middle of one, so the
relay may only ever start a viewer where this module says it can.

Two things are therefore pinned here: that a cluster is recognised even when
its header straddles two chunks (the recorder cuts chunks at quarter-second
boundaries, which have nothing to do with the container), and that four
bytes of compressed video that happen to look like a cluster ID are not
mistaken for one.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.webm import CLUSTER_ID, ClusterScanner, is_cluster_start, vint_length

# What Chromium actually writes: the cluster ID, a size of "unknown" — a
# live stream cannot know it yet — and the Timecode every cluster opens
# with. Taken from a real MediaRecorder capture.
UNKNOWN_SIZE = b"\x01\xff\xff\xff\xff\xff\xff\xff"
TIMECODE = b"\xe7\x81\x00"


def cluster(payload: bytes = b"") -> bytes:
    return CLUSTER_ID + UNKNOWN_SIZE + TIMECODE + payload


class TestReadingTheStructure:
    def test_a_variable_length_integer_says_how_long_it_is(self):
        assert vint_length(0x81) == 1
        assert vint_length(0x40) == 2
        assert vint_length(0x01) == 8
        assert vint_length(0x00) == 0, "a zero byte starts nothing"

    def test_a_real_cluster_header_is_recognised(self):
        assert is_cluster_start(cluster(b"frames"), 0) is True

    def test_four_lucky_bytes_in_the_middle_of_a_frame_are_not_a_cluster(self):
        """The ID alone is 1 in 4 billion per byte position, which at these
        bitrates happens. What follows it is what makes it a cluster."""
        assert is_cluster_start(CLUSTER_ID + b"\x00\x00\x00\x00\x00", 0) is False
        assert is_cluster_start(CLUSTER_ID + UNKNOWN_SIZE + b"\xa3junk", 0) is False

    def test_a_header_cut_off_mid_way_is_neither_yes_nor_no(self):
        """It has to be possible to wait for the rest rather than answer
        wrongly: the next chunk decides it."""
        assert is_cluster_start(CLUSTER_ID + b"\x01\xff", 0) is None


class TestScanningTheStream:
    def test_the_first_cluster_is_reported_with_the_bytes_from_it_onwards(self):
        scanner = ClusterScanner()
        head = b"\x1a\x45\xdf\xa3" + b"tracks and such"

        found = scanner.feed(head + cluster(b"frames"))

        assert found is not None
        offset, segment = found
        assert offset == len(head), "that is where the initialisation segment ends"
        assert segment == cluster(b"frames")

    def test_a_cluster_header_split_across_two_chunks_is_still_found(self):
        """Chunk boundaries fall wherever a quarter of a second landed."""
        scanner = ClusterScanner()
        whole = b"\x1a\x45\xdf\xa3" + b"init" + cluster(b"frames")
        cut = len(b"\x1a\x45\xdf\xa3" + b"init") + 2

        assert scanner.feed(whole[:cut]) is None
        found = scanner.feed(whole[cut:])

        assert found is not None
        offset, segment = found
        assert offset == len(b"\x1a\x45\xdf\xa3" + b"init")
        assert segment == cluster(b"frames"), "including the half that arrived first"

    def test_a_cluster_is_reported_once(self):
        scanner = ClusterScanner()
        scanner.feed(b"init" + cluster(b"a"))

        # The next chunk carries the tail of the previous one for exactly
        # the case above; it must not re-report what it has already seen.
        assert scanner.feed(b"plain continuation bytes") is None

    def test_each_new_cluster_gets_its_own_answer(self):
        scanner = ClusterScanner()
        scanner.feed(b"init" + cluster(b"a"))
        scanner.feed(b"middle of the cluster")

        found = scanner.feed(b"tail" + cluster(b"b"))

        assert found is not None
        assert found[1] == cluster(b"b")

    def test_a_stream_with_no_cluster_yet_offers_nowhere_to_start(self):
        scanner = ClusterScanner()
        assert scanner.feed(b"\x1a\x45\xdf\xa3" + b"only the header so far") is None
