"""
Tests for fragmented-MP4 box scanning and DASH manifest generation.

Box layouts are built by hand here so the parser is checked against
exact byte offsets rather than whatever a live stream happens to serve.
"""
import struct
import pytest
import sys
import os
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.mp4_index import parse_index, scan_boxes, Mp4Index
from services.manifest import build_mpd, ManifestError, clear_index_cache

MPD_NS = {"mpd": "urn:mpeg:dash:schema:mpd:2011"}


def box(box_type: bytes, payload: bytes = b"") -> bytes:
    """A minimal ISO-BMFF box."""
    return struct.pack(">I", len(payload) + 8) + box_type + payload


def large_box(box_type: bytes, payload: bytes = b"") -> bytes:
    """A box using the 64-bit size form."""
    return struct.pack(">I", 1) + box_type + struct.pack(">Q", len(payload) + 16) + payload


class TestBoxScanning:
    def test_scans_sequential_boxes(self):
        data = box(b"ftyp", b"iso6") + box(b"moov", b"x" * 100) + box(b"sidx", b"y" * 40)
        found = [(t, s, e) for t, s, e in scan_boxes(data)]

        assert [t for t, _s, _e in found] == [b"ftyp", b"moov", b"sidx"]
        assert found[0] == (b"ftyp", 0, 12)
        assert found[1] == (b"moov", 12, 120)
        assert found[2] == (b"sidx", 120, 168)

    def test_handles_64_bit_sizes(self):
        data = large_box(b"moov", b"z" * 50)
        found = list(scan_boxes(data))
        assert found[0][0] == b"moov"
        assert found[0][2] == 66

    def test_stops_on_truncated_header(self):
        data = box(b"ftyp", b"iso6") + b"\x00\x00"
        assert [t for t, _s, _e in scan_boxes(data)] == [b"ftyp"]

    def test_stops_on_impossible_size(self):
        data = struct.pack(">I", 3) + b"junk"
        assert list(scan_boxes(data)) == []

    def test_zero_size_box_runs_to_end(self):
        data = box(b"ftyp") + struct.pack(">I", 0) + b"mdat" + b"payload"
        found = list(scan_boxes(data))
        assert found[-1][0] == b"mdat"
        assert found[-1][2] == len(data)


class TestIndexParsing:
    def test_finds_init_and_index_ranges(self):
        data = box(b"ftyp", b"iso6") + box(b"moov", b"x" * 100) + box(b"sidx", b"y" * 40)
        index = parse_index(data)

        assert index == Mp4Index(init_start=0, init_end=119, index_start=120, index_end=167)
        assert index.init_range == "0-119"
        assert index.index_range == "120-167"

    def test_ignores_boxes_after_the_index(self):
        data = (box(b"ftyp") + box(b"moov", b"x" * 20) + box(b"sidx", b"y" * 10)
                + box(b"moof", b"z" * 500) + box(b"mdat", b"w" * 9000))
        index = parse_index(data)
        assert index.index_end == 8 + 28 + 18 - 1

    def test_padding_between_moov_and_sidx_counts_as_init(self):
        """A free box before sidx belongs to the initialization segment."""
        data = box(b"ftyp") + box(b"moov", b"x" * 20) + box(b"free", b"\0" * 16) + box(b"sidx", b"y" * 10)
        index = parse_index(data)

        assert index.init_end == index.index_start - 1
        assert index.index_start == 8 + 28 + 24

    def test_returns_none_without_index(self):
        assert parse_index(box(b"ftyp") + box(b"moov", b"x" * 20)) is None

    def test_returns_none_when_index_truncated(self):
        """A prefix that cuts through sidx must not yield a wrong range."""
        full = box(b"ftyp") + box(b"moov", b"x" * 20) + box(b"sidx", b"y" * 200)
        assert parse_index(full[:60]) is None

    def test_returns_none_for_non_mp4_data(self):
        assert parse_index(b"this is not an mp4 file at all") is None


@pytest.fixture(autouse=True)
def clear_cache():
    clear_index_cache()
    yield
    clear_index_cache()


VIDEO_REP = {
    "id": "137",
    "url": "https://cdn.example.com/video.mp4?sig=abc",
    "width": 1920, "height": 1080, "vcodec": "avc1.640028", "tbr": 4500, "fps": 30,
    "index": Mp4Index(0, 738, 739, 2246),
}
AUDIO_REP = {
    "id": "140",
    "url": "https://cdn.example.com/audio.m4a?sig=def",
    "acodec": "mp4a.40.2", "abr": 128, "asr": 44100, "audio_channels": 2,
    "index": Mp4Index(0, 731, 732, 1531),
}
PROXY_BASE = "https://watch.example.com/api/proxy?url="


class TestManifestBuilding:
    def test_produces_parseable_xml(self):
        root = ET.fromstring(build_mpd(635.0, [VIDEO_REP], [AUDIO_REP], PROXY_BASE))
        assert root.tag.endswith("MPD")
        assert root.get("type") == "static"
        assert root.get("mediaPresentationDuration") == "PT635.000S"

    def test_has_one_adaptation_set_per_media_type(self):
        root = ET.fromstring(build_mpd(10.0, [VIDEO_REP], [AUDIO_REP], PROXY_BASE))
        sets = root.findall(".//mpd:AdaptationSet", MPD_NS)
        assert [s.get("contentType") for s in sets] == ["video", "audio"]

    def test_video_representation_carries_display_metadata(self):
        root = ET.fromstring(build_mpd(10.0, [VIDEO_REP], [AUDIO_REP], PROXY_BASE))
        rep = root.find(".//mpd:AdaptationSet[@contentType='video']/mpd:Representation", MPD_NS)

        assert rep.get("id") == "137"
        assert rep.get("width") == "1920"
        assert rep.get("height") == "1080"
        assert rep.get("codecs") == "avc1.640028"
        assert rep.get("frameRate") == "30"
        assert rep.get("bandwidth") == "4500000"

    def test_segment_base_uses_probed_ranges(self):
        root = ET.fromstring(build_mpd(10.0, [VIDEO_REP], [AUDIO_REP], PROXY_BASE))
        segment_base = root.find(
            ".//mpd:AdaptationSet[@contentType='video']//mpd:SegmentBase", MPD_NS)
        initialization = segment_base.find("mpd:Initialization", MPD_NS)

        assert segment_base.get("indexRange") == "739-2246"
        assert initialization.get("range") == "0-738"

    def test_media_urls_are_proxied_and_escaped(self):
        root = ET.fromstring(build_mpd(10.0, [VIDEO_REP], [AUDIO_REP], PROXY_BASE))
        base_url = root.find(".//mpd:AdaptationSet[@contentType='video']//mpd:BaseURL", MPD_NS)

        assert base_url.text.startswith(PROXY_BASE)
        # The upstream URL must be encoded, not left as a bare query string.
        assert "https%3A%2F%2Fcdn.example.com" in base_url.text
        assert "?sig=abc" not in base_url.text

    def test_audio_channel_configuration_present(self):
        root = ET.fromstring(build_mpd(10.0, [VIDEO_REP], [AUDIO_REP], PROXY_BASE))
        config = root.find(".//mpd:AdaptationSet[@contentType='audio']"
                          "//mpd:AudioChannelConfiguration", MPD_NS)
        assert config.get("value") == "2"

    def test_multiple_video_representations_are_kept(self):
        second = {**VIDEO_REP, "id": "136", "height": 720, "width": 1280, "tbr": 2000}
        root = ET.fromstring(build_mpd(10.0, [VIDEO_REP, second], [AUDIO_REP], PROXY_BASE))
        reps = root.findall(".//mpd:AdaptationSet[@contentType='video']/mpd:Representation", MPD_NS)

        assert [r.get("id") for r in reps] == ["137", "136"]

    def test_missing_bitrate_falls_back_to_a_sane_default(self):
        rep = {k: v for k, v in VIDEO_REP.items() if k != "tbr"}
        root = ET.fromstring(build_mpd(10.0, [rep], [AUDIO_REP], PROXY_BASE))
        bandwidth = root.find(
            ".//mpd:AdaptationSet[@contentType='video']/mpd:Representation", MPD_NS).get("bandwidth")

        assert int(bandwidth) > 0

    def test_xml_special_characters_are_escaped(self):
        rep = {**VIDEO_REP, "url": "https://cdn.example.com/v.mp4?a=1&b=2<x>"}
        root = ET.fromstring(build_mpd(10.0, [rep], [AUDIO_REP], PROXY_BASE))
        assert root is not None  # Parsing at all proves the escaping held

    def test_empty_representation_lists_rejected(self):
        with pytest.raises(ManifestError):
            build_mpd(10.0, [], [], PROXY_BASE)

    def test_audio_only_manifest_is_valid(self):
        root = ET.fromstring(build_mpd(10.0, [], [AUDIO_REP], PROXY_BASE))
        sets = root.findall(".//mpd:AdaptationSet", MPD_NS)
        assert [s.get("contentType") for s in sets] == ["audio"]


class TestIndexCacheKey:
    """Probed byte ranges must be keyed to one rendition.

    Every YouTube rendition lives at /videoplayback and is distinguished
    only by its query string. Keying on the path alone made all of a
    video's representations — video and audio together — share one cache
    entry, so each inherited the first one's byte ranges and the player
    found no sidx box where the manifest promised one (Shaka error 3004,
    MP4_SIDX_WRONG_BOX_TYPE).
    """

    VIDEO = ("https://rr3---sn-abc.googlevideo.com/videoplayback"
             "?expire=111&sig=AAA&ei=X&ip=1.2.3.4&itag=137&clen=999&lmt=555&mime=video%2Fmp4")
    AUDIO = ("https://rr3---sn-abc.googlevideo.com/videoplayback"
             "?expire=111&sig=AAA&ei=X&ip=1.2.3.4&itag=140&clen=86240992&lmt=777&mime=audio%2Fmp4")
    # Same rendition, re-resolved: new edge host and fresh signing params.
    VIDEO_ROTATED = ("https://rr9---sn-zzz.googlevideo.com/videoplayback"
                     "?expire=999&sig=BBB&ei=Y&ip=5.6.7.8&itag=137&clen=999&lmt=555&mime=video%2Fmp4")

    def test_video_and_audio_do_not_collide(self):
        from services.cache import stream_identity as _cache_key
        assert _cache_key(self.VIDEO) != _cache_key(self.AUDIO)

    def test_different_video_itags_do_not_collide(self):
        from services.cache import stream_identity as _cache_key
        other = self.VIDEO.replace("itag=137", "itag=136").replace("clen=999", "clen=555")
        assert _cache_key(self.VIDEO) != _cache_key(other)

    def test_rotated_signing_params_still_hit(self):
        """Re-resolving the same rendition must reuse the probed ranges."""
        from services.cache import stream_identity as _cache_key
        assert _cache_key(self.VIDEO) == _cache_key(self.VIDEO_ROTATED)

    def test_url_without_identity_params_keys_on_itself(self):
        from services.cache import stream_identity as _cache_key
        plain = "https://cdn.example.com/media/video.mp4"
        assert _cache_key(plain) == plain

    async def test_probe_does_not_reuse_another_renditions_index(self, monkeypatch):
        """The cache must not hand one rendition's index to another."""
        import services.manifest as manifest_module
        from services.mp4_index import Mp4Index

        manifest_module.clear_index_cache()
        probed = []

        async def fake_probe(client, url, headers=None):
            probed.append(url)
            # Distinct ranges per rendition, as real files have.
            offset = 100 * len(probed)
            return Mp4Index(0, offset - 1, offset, offset + 500)

        # Exercise the real caching wrapper around a stubbed fetch.
        real_open = manifest_module.open_upstream_stream

        class FakeResponse:
            status_code = 206
            def __init__(self, payload): self._payload = payload
            async def aread(self): return self._payload
            async def aclose(self): return None

        import struct

        def make_fmp4(moov_size: int) -> bytes:
            box = lambda t, n: struct.pack(">I", n + 8) + t + b"\0" * n
            return box(b"ftyp", 8) + box(b"moov", moov_size) + box(b"sidx", 40)

        sizes = iter([32, 64, 96])

        async def fake_open(client, url, headers=None, max_redirects=3):
            return FakeResponse(make_fmp4(next(sizes))), None

        monkeypatch.setattr(manifest_module, "open_upstream_stream", fake_open)

        first = await manifest_module.probe_index(None, self.VIDEO)
        second = await manifest_module.probe_index(None, self.AUDIO)

        assert first is not None and second is not None
        assert first.index_range != second.index_range

        manifest_module.open_upstream_stream = real_open
        manifest_module.clear_index_cache()


class TestCodecGrouping:
    """Representations in one AdaptationSet must be interchangeable.

    A player backs an AdaptationSet with a single MSE SourceBuffer created
    for a single codec. H.264 and AV1 in the same set makes it append one
    codec's segments into the other's buffer: playback runs for a fraction
    of a second and freezes on a stale frame.
    """

    IDX = Mp4Index(0, 700, 701, 13000)

    def video(self, rep_id, codec, height, tbr):
        return {"id": rep_id, "url": f"https://cdn/{rep_id}.mp4", "height": height,
                "width": height * 16 // 9, "vcodec": codec, "tbr": tbr, "index": self.IDX}

    def audio(self, rep_id, codec, abr):
        return {"id": rep_id, "url": f"https://cdn/{rep_id}.m4a", "acodec": codec,
                "abr": abr, "asr": 44100, "audio_channels": 2, "index": self.IDX}

    def sets_for(self, root, content_type):
        return root.findall(
            f".//mpd:AdaptationSet[@contentType='{content_type}']", MPD_NS)

    def codecs_in(self, adaptation_set):
        return [r.get("codecs")
                for r in adaptation_set.findall("mpd:Representation", MPD_NS)]

    def test_h264_and_av1_are_separated(self):
        reps = [self.video("137", "avc1.640028", 1080, 4500),
                self.video("399", "av01.0.08M.08", 1080, 2000),
                self.video("136", "avc1.4d401f", 720, 2500)]
        root = ET.fromstring(build_mpd(100.0, reps, [AUDIO_REP], PROXY_BASE))

        video_sets = self.sets_for(root, "video")
        assert len(video_sets) == 2
        for adaptation_set in video_sets:
            families = {c.split(".")[0] for c in self.codecs_in(adaptation_set)}
            assert len(families) == 1, f"mixed codecs in one set: {families}"

    def test_same_codec_family_stays_together(self):
        """Different profiles of one codec are interchangeable."""
        reps = [self.video("137", "avc1.640028", 1080, 4500),
                self.video("136", "avc1.4d401f", 720, 2500)]
        root = ET.fromstring(build_mpd(100.0, reps, [AUDIO_REP], PROXY_BASE))

        video_sets = self.sets_for(root, "video")
        assert len(video_sets) == 1
        assert len(self.codecs_in(video_sets[0])) == 2

    def test_aac_and_opus_are_separated(self):
        reps = [self.audio("140", "mp4a.40.2", 128), self.audio("251", "opus", 160)]
        root = ET.fromstring(build_mpd(100.0, [VIDEO_REP], reps, PROXY_BASE))

        audio_sets = self.sets_for(root, "audio")
        assert len(audio_sets) == 2

    def test_quality_order_is_preserved_within_a_set(self):
        """Grouping must not reshuffle the caller's ordering."""
        reps = [self.video("137", "avc1.640028", 1080, 4500),
                self.video("399", "av01.0.08M.08", 1080, 2000),
                self.video("136", "avc1.4d401f", 720, 2500)]
        root = ET.fromstring(build_mpd(100.0, reps, [AUDIO_REP], PROXY_BASE))

        h264 = next(s for s in self.sets_for(root, "video")
                    if self.codecs_in(s)[0].startswith("avc1"))
        ids = [r.get("id") for r in h264.findall("mpd:Representation", MPD_NS)]
        assert ids == ["137", "136"]
