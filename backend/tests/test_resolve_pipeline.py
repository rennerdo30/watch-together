"""
Regression tests for the YouTube resolution pipeline.

Each test here corresponds to a fault that took production down and left
no trace in the test suite at the time:

- the PO token provider address was never passed, so YouTube answered
  "Sign in to confirm you're not a bot" with zero formats;
- every extraction pinned a player client, and the pinned clients return
  storyboard images only;
- `remote_components` was passed in a form yt-dlp silently ignores;
- /api/resolve did not cache its result, so /api/dash-manifest — which
  reads that cache — returned 404 for a freshly pasted link.
"""
import os
import sys
import pathlib
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DEVELOPMENT_MODE", "true")

from fastapi.testclient import TestClient

BACKEND_ROOT = pathlib.Path(__file__).resolve().parent.parent

# A minimal yt-dlp info dict with one video and one audio rendition.
FAKE_INFO = {
    "title": "Test Video",
    "duration": 120,
    "is_live": False,
    "thumbnail": "https://example.com/thumb.jpg",
    "formats": [
        {
            "format_id": "137", "url": "https://cdn.example.com/v.mp4?itag=137&clen=1000",
            "vcodec": "avc1.640028", "acodec": "none",
            "height": 1080, "width": 1920, "tbr": 4500,
        },
        {
            "format_id": "140", "url": "https://cdn.example.com/a.m4a?itag=140&clen=500",
            "vcodec": "none", "acodec": "mp4a.40.2", "abr": 128,
        },
    ],
}


@pytest.fixture
def captured_options(monkeypatch):
    """Record the yt-dlp options each resolve attempt would use."""
    import main as main_module

    seen = []

    def fake_extract(url, ydl_opts):
        seen.append(ydl_opts)
        return FAKE_INFO

    monkeypatch.setattr(main_module, "_extract_with_options", fake_extract)
    return seen


@pytest.fixture
def client():
    from main import app
    return TestClient(app)


class TestPoTokenProvider:
    """Without the provider address YouTube serves no playable formats."""

    def test_provider_address_is_passed_on_every_attempt(self, client, captured_options):
        response = client.get("/api/resolve",
                              params={"url": "https://youtu.be/abc", "user": "a@example.com"})
        assert response.status_code == 200
        assert captured_options, "no extraction attempt was made"

        for opts in captured_options:
            args = opts.get("extractor_args", {})
            provider = args.get("youtubepot-bgutilhttp")
            assert provider, "the bgutil provider address was not passed"
            assert provider["base_url"], "the provider base_url is empty"

    def test_provider_url_comes_from_the_environment(self):
        """The provider is a separate service, so it must be configurable."""
        from core.config import POT_PROVIDER_EXTRACTOR_ARGS, POT_PROVIDER_URL

        assert POT_PROVIDER_EXTRACTOR_ARGS["youtubepot-bgutilhttp"]["base_url"] == [POT_PROVIDER_URL]


class TestPlayerClientIsNotPinned:
    """Pinned clients return storyboard images and no media."""

    def test_no_attempt_pins_a_player_client(self, client, captured_options):
        client.get("/api/resolve", params={"url": "https://youtu.be/abc", "user": "a@example.com"})

        for opts in captured_options:
            youtube_args = opts.get("extractor_args", {}).get("youtube", {})
            assert "player_client" not in youtube_args, (
                "a player client is pinned again; yt-dlp's own selection is "
                "the one that keeps working as YouTube changes"
            )

    @pytest.mark.parametrize("source", ["main.py", "services/resolver.py"])
    def test_sources_do_not_pin_clients_or_use_a_fake_option(self, source):
        """`ytdl_hook` is not a yt-dlp option; it silently did nothing."""
        text = (BACKEND_ROOT / source).read_text()
        assert "player_client" not in text
        assert "ytdl_hook" not in text


class TestRemoteComponents:
    """yt-dlp ignores this option unless it is the string form."""

    def test_fallback_asks_for_remote_components_in_the_accepted_form(
        self, client, monkeypatch
    ):
        """The first attempt uses the local runtime; only the retry sets this."""
        import main as main_module

        seen = []

        def fake_extract(url, ydl_opts):
            seen.append(ydl_opts)
            # Fail the first attempt so the fallback runs too.
            if len(seen) == 1:
                return {"title": "t", "duration": 1, "formats": []}
            return FAKE_INFO

        monkeypatch.setattr(main_module, "_extract_with_options", fake_extract)

        response = client.get("/api/resolve",
                              params={"url": "https://youtu.be/fallback", "user": "a@example.com"})
        assert response.status_code == 200
        assert len(seen) == 2, "the fallback attempt did not run"

        assert "remote_components" not in seen[0], (
            "the first attempt should use the runtime in the image"
        )
        # A dict here makes yt-dlp log "Ignoring unsupported remote
        # component(s)" and carry on without it.
        assert seen[1]["remote_components"] == "ejs:github"
        assert isinstance(seen[1]["remote_components"], str)

    def test_both_attempts_still_pass_the_provider(self, client, monkeypatch):
        import main as main_module

        seen = []

        def fake_extract(url, ydl_opts):
            seen.append(ydl_opts)
            if len(seen) == 1:
                return {"title": "t", "duration": 1, "formats": []}
            return FAKE_INFO

        monkeypatch.setattr(main_module, "_extract_with_options", fake_extract)
        client.get("/api/resolve",
                   params={"url": "https://youtu.be/fallback2", "user": "a@example.com"})

        for opts in seen:
            assert opts["extractor_args"].get("youtubepot-bgutilhttp")


class TestResolveCachesItsResult:
    """/api/dash-manifest builds from this cache; nothing else fills it."""

    async def test_resolved_format_is_cached(self, client, captured_options):
        from services.database import get_cached_format

        url = "https://youtu.be/cache-me"
        response = client.get("/api/resolve", params={"url": url, "user": "a@example.com"})
        assert response.status_code == 200

        cached = await get_cached_format(url)
        assert cached is not None, "resolve did not cache its result"
        assert cached.get("duration") == FAKE_INFO["duration"]
        assert cached.get("stream_type") == "dash"
        assert cached.get("available_qualities")
        assert cached.get("audio_options")

    def test_duration_is_reported(self, client, captured_options):
        """The manifest needs a duration; without one it returns 422."""
        response = client.get("/api/resolve",
                              params={"url": "https://youtu.be/abc", "user": "a@example.com"})
        assert response.json()["duration"] == FAKE_INFO["duration"]

    def test_manifest_is_available_right_after_resolving(self, client, captured_options, monkeypatch):
        """The 404 that broke playback on a freshly pasted link."""
        import main as main_module
        from services.mp4_index import Mp4Index

        async def fake_build(client_, duration_seconds, video_formats, audio_formats,
                             proxy_base, headers=None):
            assert duration_seconds == FAKE_INFO["duration"]
            assert video_formats and audio_formats
            return "<MPD/>"

        monkeypatch.setattr(main_module, "build_manifest_for_formats", fake_build)

        url = "https://youtu.be/manifest-me"
        assert client.get("/api/resolve",
                          params={"url": url, "user": "a@example.com"}).status_code == 200

        manifest = client.get("/api/dash-manifest",
                              params={"url": url, "user": "a@example.com"})
        assert manifest.status_code == 200
        assert manifest.headers["content-type"].startswith("application/dash+xml")


class TestManifestResolvesOnDemand:
    """A room's queue outlives the resolved formats behind it.

    Stream URLs expire after a couple of hours and the format cache lives
    in process memory, so pressing play on an older queue item — or on
    anything at all after a restart — reaches the manifest endpoint with
    nothing cached. It used to answer

        404 {"detail": "Video has not been resolved yet. Call /api/resolve first."}

    which the player reported as "the video could not be loaded" (Shaka
    1001). The page does re-resolve, but the manifest was requested before
    that finished, and the failure stuck.
    """

    @pytest.fixture
    def stub_manifest(self, monkeypatch):
        import main as main_module

        async def fake_build(client_, duration_seconds, video_formats, audio_formats,
                             proxy_base, headers=None):
            return "<MPD/>"

        monkeypatch.setattr(main_module, "build_manifest_for_formats", fake_build)

    async def test_manifest_resolves_a_video_nobody_resolved(
            self, client, captured_options, stub_manifest):
        url = "https://youtu.be/never-resolved"
        from services.database import get_cached_format
        assert await get_cached_format(url) is None

        manifest = client.get("/api/dash-manifest",
                              params={"url": url, "user": "a@example.com"})

        assert manifest.status_code == 200
        assert manifest.headers["content-type"].startswith("application/dash+xml")
        assert captured_options, "the manifest endpoint did not resolve anything"

    async def test_the_resolve_it_triggers_is_cached(
            self, client, captured_options, stub_manifest):
        """Otherwise every segment request re-resolves the whole video."""
        url = "https://youtu.be/cache-me-too"
        client.get("/api/dash-manifest", params={"url": url, "user": "a@example.com"})

        from services.database import get_cached_format
        assert await get_cached_format(url) is not None

    async def test_a_cached_video_is_not_resolved_again(
            self, client, captured_options, stub_manifest):
        url = "https://youtu.be/already-resolved"
        client.get("/api/resolve", params={"url": url, "user": "a@example.com"})
        attempts_after_resolve = len(captured_options)

        client.get("/api/dash-manifest", params={"url": url, "user": "a@example.com"})

        assert len(captured_options) == attempts_after_resolve

    async def test_an_unresolvable_video_still_reports_the_real_reason(
            self, client, monkeypatch, stub_manifest):
        """A 404 saying "call /api/resolve first" is not actionable."""
        import main as main_module

        def no_formats(url, ydl_opts):
            return {"title": "Gone", "formats": []}

        monkeypatch.setattr(main_module, "_extract_with_options", no_formats)

        response = client.get("/api/dash-manifest",
                              params={"url": "https://youtu.be/gone",
                                      "user": "a@example.com"})

        # 400 with the resolver's own reason, not a 404 telling the caller
        # to do something it just did on their behalf.
        assert response.status_code == 400
        assert "playable" in response.json()["detail"].lower()


class TestQualityLadder:
    """A viewer on a slow link needs the low rungs most.

    The candidate list arrives sorted by height descending, and the code took
    a slice off the front. On a video with several 1080p variants that kept
    only the largest renditions, so there was no 480p or 360p to fall back to
    — the quality menu offered nothing below 720p.
    """

    LADDER = [
        (1080, {"vcodec": "avc1.640028", "format_id": "137"}),
        (1080, {"vcodec": "av01.0.08M.08", "format_id": "399"}),
        (1080, {"vcodec": "vp9", "format_id": "248"}),
        (720, {"vcodec": "avc1.4d401f", "format_id": "136"}),
        (720, {"vcodec": "vp9", "format_id": "247"}),
        (480, {"vcodec": "avc1", "format_id": "135"}),
        (360, {"vcodec": "avc1", "format_id": "134"}),
        (240, {"vcodec": "avc1", "format_id": "133"}),
        (144, {"vcodec": "avc1", "format_id": "160"}),
    ]

    def heights(self, limit):
        from services.resolver import _select_quality_ladder
        return [h for h, _ in _select_quality_ladder(self.LADDER, limit)]

    def test_each_codec_family_gets_a_complete_ladder(self):
        """A player commits to one codec, so gaps in it are unrecoverable.

        Spreading the budget across codecs gave AV1 only 2160p and 1440p, so
        a player that chose AV1 had nothing lower to drop to — which looks
        exactly like ABR refusing to switch down.
        """
        from services.resolver import _select_quality_ladder

        candidates = []
        for height in (2160, 1440, 1080, 720, 480, 360, 240, 144):
            candidates.append((height, {"vcodec": "av01.0.08M.08"}))
            if height <= 1080:
                candidates.append((height, {"vcodec": "avc1.640028"}))

        picked = _select_quality_ladder(candidates, 8)
        per_codec = {}
        for height, fmt in picked:
            per_codec.setdefault(fmt["vcodec"].split(".")[0], []).append(height)

        for family, heights in per_codec.items():
            assert min(heights) <= 360, f"{family} has no low rung: {heights}"
            assert len(heights) >= 4, f"{family} ladder is too sparse: {heights}"

    def test_low_renditions_survive(self):
        heights = self.heights(10)
        assert 360 in heights, "no 360p to fall back to"
        assert min(heights) <= 240

    def test_highest_and_lowest_are_both_kept_when_trimming(self):
        heights = self.heights(4)
        assert max(heights) == 1080
        assert min(heights) == 144

    def test_result_stays_sorted_by_height_descending(self):
        heights = self.heights(6)
        assert heights == sorted(heights, reverse=True)

    def test_both_codecs_of_one_height_can_survive(self):
        """AV1 at the same resolution is far cheaper to stream."""
        from services.resolver import _select_quality_ladder
        picked = _select_quality_ladder(self.LADDER, 10)
        codecs_1080 = {f["vcodec"].split(".")[0] for h, f in picked if h == 1080}
        assert len(codecs_1080) > 1

    def test_duplicate_height_and_codec_is_not_repeated(self):
        from services.resolver import _select_quality_ladder
        duplicated = self.LADDER + [(360, {"vcodec": "avc1", "format_id": "134-dup"})]
        picked = _select_quality_ladder(duplicated, 10)
        keys = [(h, f["vcodec"].split(".")[0]) for h, f in picked]
        assert len(keys) == len(set(keys))

    def test_the_configured_ladder_is_big_enough_for_low_rungs(self):
        from core.config import QUALITY_LADDER_SIZE, MANIFEST_MAX_VIDEO_REPRESENTATIONS
        assert QUALITY_LADDER_SIZE >= 8
        # The manifest must not re-truncate what the ladder deliberately kept.
        assert MANIFEST_MAX_VIDEO_REPRESENTATIONS >= QUALITY_LADDER_SIZE


class TestUnindexableRenditionsAreNotOffered:
    """A WebM rendition can never be described by a SegmentBase manifest.

    The DASH manifest points at each rendition's `sidx` box, which exists
    only in fragmented MP4. Matroska keys its segments in a Cues element
    this project does not index, so every WebM rendition offered cost a
    64 KB probe and was then dropped — and if the whole ladder happened
    to be WebM, the manifest came out with sound and no picture.
    """

    def indexable(self, **fields):
        from services.resolver import _is_indexable
        return _is_indexable(fields)

    def test_webm_is_excluded_by_extension(self):
        assert not self.indexable(ext="webm", url="https://cdn/x")
        assert not self.indexable(ext="mkv", url="https://cdn/x")

    def test_fragmented_mp4_is_kept(self):
        assert self.indexable(ext="mp4", url="https://cdn/x")
        assert self.indexable(ext="m4a", url="https://cdn/x")

    def test_googlevideo_mime_decides_when_no_extension_is_recorded(self):
        assert not self.indexable(
            url="https://r1.googlevideo.com/videoplayback?itag=278&mime=video%2Fwebm")
        assert self.indexable(
            url="https://r1.googlevideo.com/videoplayback?itag=137&mime=video%2Fmp4")

    def test_an_unlabelled_container_is_left_for_the_probe(self):
        """Guessing would drop renditions from sources that do not say."""
        assert self.indexable(url="https://cdn.example.com/media/video")
        assert self.indexable(url="")

    def test_webm_never_reaches_the_quality_ladder(self):
        from services.resolver import _extract_stream_url

        info = {
            "title": "Mixed containers",
            "formats": [
                {"format_id": "137", "url": "https://cdn/v.mp4?mime=video%2Fmp4",
                 "ext": "mp4", "vcodec": "avc1.640028", "acodec": "none",
                 "height": 1080, "width": 1920, "tbr": 4500},
                {"format_id": "248", "url": "https://cdn/v.webm?mime=video%2Fwebm",
                 "ext": "webm", "vcodec": "vp9", "acodec": "none",
                 "height": 1080, "width": 1920, "tbr": 4000},
                {"format_id": "140", "url": "https://cdn/a.m4a?mime=audio%2Fmp4",
                 "ext": "m4a", "vcodec": "none", "acodec": "mp4a.40.2", "abr": 128},
                {"format_id": "251", "url": "https://cdn/a.webm?mime=audio%2Fwebm",
                 "ext": "webm", "vcodec": "none", "acodec": "opus", "abr": 160},
            ],
        }

        selected = _extract_stream_url(info)

        assert selected["type"] == "dash"
        offered = {q["format_id"] for q in selected["available_qualities"]}
        assert offered == {"137"}, f"a rendition that cannot be indexed was offered: {offered}"
        assert {a["format_id"] for a in selected["audio_options"]} == {"140"}
