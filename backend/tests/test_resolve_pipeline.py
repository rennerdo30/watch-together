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
