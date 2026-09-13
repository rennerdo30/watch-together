"""
YouTube watch history reporting: the ping URLs, the yt-dlp capture hook, the
per-member sessions, and the setting that gates all of it.

YouTube is never reached: pings go to an httpx MockTransport, and the
extraction step is replaced by a stub that hands back tracking URLs.
"""
import asyncio
import inspect
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from services.watch_history import (
    CAPTURE_PARAM,
    PLAYBACK_URL_KEY,
    WATCHTIME_URL_KEY,
    HistoryReporter,
    TrackingUrls,
    build_ping_url,
    generate_cpn,
    install_tracking_capture,
)
from services import user_settings, watch_history
from core.config import (
    USER_SETTINGS_DEFAULTS,
    YOUTUBE_HISTORY_CPN_LENGTH,
    YOUTUBE_HISTORY_PING_INTERVAL_SECONDS,
)

VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
PLAYBACK = "https://s.youtube.com/api/stats/playback?docid=dQw4w9WgXcQ&ei=abc&len=212.5&plid=p1"
WATCHTIME = "https://s.youtube.com/api/stats/watchtime?docid=dQw4w9WgXcQ&ei=abc&len=212.5&plid=p1"
URLS = TrackingUrls(playback=PLAYBACK, watchtime=WATCHTIME)
MEMBER = "viewer@example.com"


# ---------------------------------------------------------------------------
# Ping URLs and the capture hook
# ---------------------------------------------------------------------------

def test_ping_url_adds_what_the_player_adds_and_keeps_the_rest():
    url = build_ping_url(WATCHTIME, cpn="abcdefghijklmnop", position=42.25, watched_from=10, watched_to=42.25)
    parsed = urlparse(url)
    params = parse_qs(parsed.query)
    assert parsed.netloc == "s.youtube.com" and parsed.path == "/api/stats/watchtime"
    assert params["docid"] == ["dQw4w9WgXcQ"] and params["len"] == ["212.5"]
    assert params["ver"] == ["2"] and params["el"] == ["detailpage"]
    assert params["cpn"] == ["abcdefghijklmnop"]
    assert params["cmt"] == ["42.250"] and params["st"] == ["10.000"] and params["et"] == ["42.250"]

    playback = parse_qs(urlparse(build_ping_url(PLAYBACK, cpn="x" * 16, position=0)).query)
    assert playback["cmt"] == ["0.000"] and "st" not in playback and "et" not in playback


def test_cpn_has_the_players_shape():
    cpn = generate_cpn()
    assert len(cpn) == YOUTUBE_HISTORY_CPN_LENGTH
    assert set(cpn) <= set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")


def test_capture_hook_reads_the_same_fields_yt_dlp_does():
    """The hook reads the fields yt-dlp's own mark-watched reads.

    If a yt-dlp upgrade renames them, the stock implementation would break
    too — and this pins that the two still agree.
    """
    source = inspect.getsource(watch_history._original_mark_watched)
    for key in (PLAYBACK_URL_KEY, WATCHTIME_URL_KEY, "playbackTracking", "baseUrl"):
        assert key in source
    install_tracking_capture()
    install_tracking_capture()  # idempotent
    from yt_dlp.extractor.youtube import YoutubeIE
    assert YoutubeIE._mark_watched is watch_history._capturing_mark_watched

    class FakeIE:
        def __init__(self, sink):
            self._sink = sink

        def get_param(self, name):
            return self._sink if name == CAPTURE_PARAM else None

    sink = {}
    responses = [
        {"playbackTracking": {}},
        {"playbackTracking": {
            PLAYBACK_URL_KEY: {"baseUrl": PLAYBACK},
            WATCHTIME_URL_KEY: {"baseUrl": WATCHTIME},
            "ptrackingUrl": {"baseUrl": "https://ignored.example/"},
        }},
    ]
    YoutubeIE._mark_watched(FakeIE(sink), "dQw4w9WgXcQ", responses)
    assert sink == {PLAYBACK_URL_KEY: PLAYBACK, WATCHTIME_URL_KEY: WATCHTIME}

    # A junk URL is not captured.
    sink = {}
    YoutubeIE._mark_watched(FakeIE(sink), "x", [{"playbackTracking": {PLAYBACK_URL_KEY: {"baseUrl": "not a url"}}}])
    assert sink == {}


async def test_capture_keeps_urls_when_format_selection_fails_afterwards(monkeypatch):
    """The URLs are captured before format selection, which may still fail."""
    class FakeYoutubeDL:
        def __init__(self, opts):
            self.opts = opts

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def extract_info(self, url, download=False):
            assert self.opts["mark_watched"] is True and "cookiefile" in self.opts
            self.opts[CAPTURE_PARAM].update({PLAYBACK_URL_KEY: PLAYBACK, WATCHTIME_URL_KEY: WATCHTIME})
            raise RuntimeError("Requested format is not available")

    monkeypatch.setattr(watch_history.yt_dlp, "YoutubeDL", FakeYoutubeDL)
    assert await watch_history.capture_tracking_urls(VIDEO_URL, "/tmp/cookies.txt") == URLS

    class EmptyYoutubeDL(FakeYoutubeDL):
        def extract_info(self, url, download=False):
            return {}

    monkeypatch.setattr(watch_history.yt_dlp, "YoutubeDL", EmptyYoutubeDL)
    assert await watch_history.capture_tracking_urls(VIDEO_URL, "/tmp/cookies.txt") is None


def test_user_settings_are_normalised():
    assert user_settings.normalize_user_settings(None) == USER_SETTINGS_DEFAULTS
    assert user_settings.normalize_user_settings({"youtube_history": 1, "bogus": True}) == {"youtube_history": True}
    assert user_settings.normalize_user_settings({"youtube_history": ""}) == {"youtube_history": False}


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

class FakeSocket:
    def __init__(self, email):
        self.user_email = email


class FakeManager:
    def __init__(self, state, clock, members):
        self.room_states = {"room": state}
        self.active_connections = {"room": [FakeSocket(m) for m in members]}
        self._clock = clock

    async def update_state(self, room_id, updates):
        state = self.room_states[room_id]
        state.update(updates)
        if "is_playing" in updates or "timestamp" in updates:
            state["last_sync_time"] = self._clock.now()


class FakeClock:
    def __init__(self):
        self.t = 5000.0
        self.slept = []

    def now(self):
        return self.t

    async def sleep(self, seconds):
        self.slept.append(seconds)
        self.t += seconds
        await asyncio.sleep(0)


def _state(clock, timestamp=0.0, playing=True, url=VIDEO_URL, live=False):
    return {
        "video_data": {"original_url": url, "is_live": live},
        "is_playing": playing,
        "timestamp": timestamp,
        "last_sync_time": clock.now(),
    }


class Pings:
    """Records every ping as (kind, params)."""

    def __init__(self, status=204):
        self.sent = []
        self.status = status

    def handler(self, request):
        kind = "playback" if "/playback" in request.url.path else "watchtime"
        params = {k: v[0] for k, v in parse_qs(request.url.query.decode()).items()}
        self.sent.append((kind, params, request.headers.get("cookie")))
        return httpx.Response(self.status)


@pytest.fixture
def opted_in(monkeypatch, tmp_path):
    """MEMBER has the setting on and cookies; no database involved."""
    from contextlib import asynccontextmanager

    cookie_path = tmp_path / "cookies.txt"
    cookie_path.write_text("# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1900000000\tSID\tsecret\n")

    async def settings(email):
        return {"youtube_history": email == MEMBER}

    @asynccontextmanager
    async def cookie_file(email):
        yield str(cookie_path) if email == MEMBER else None

    monkeypatch.setattr(watch_history, "load_user_settings", settings)
    monkeypatch.setattr(watch_history, "cookie_file", cookie_file)
    monkeypatch.setattr(watch_history, "get_cookie_header", lambda email, url: "SID=secret")


def _reporter(manager, clock, pings, capture=None):
    captured = []

    async def default_capture(url, cookie_path):
        captured.append((url, cookie_path))
        return URLS

    reporter = HistoryReporter(manager, capture=capture or default_capture,
                               transport=httpx.MockTransport(pings.handler),
                               now=clock.now, sleep=clock.sleep)
    reporter.captured = captured
    return reporter


async def test_a_new_video_is_reported_from_start_to_the_interval(opted_in):
    clock = FakeClock()
    pings = Pings()
    manager = FakeManager(_state(clock), clock, [MEMBER, "other@example.com"])
    reporter = _reporter(manager, clock, pings)

    reporter.video_changed("room")
    # Start the session, then let two intervals of playback happen.
    while not reporter.active_for("room", MEMBER):
        await asyncio.sleep(0)
    await asyncio.sleep(0)
    for _ in range(2):
        await asyncio.sleep(0.01)

    # Only the opted-in member was extracted for, with their cookies.
    assert [u for u, _ in reporter.captured] == [VIDEO_URL]
    # A playback ping at the start, with the cookies, then watch-time pings
    # covering consecutive ranges at the interval.
    assert pings.sent[0][0] == "playback" and pings.sent[0][1]["cmt"] == "0.000"
    assert pings.sent[0][2] == "SID=secret"
    watchtime = [p for k, p, _ in pings.sent if k == "watchtime"]
    assert len(watchtime) >= 1
    assert watchtime[0]["st"] == "0.000"
    assert float(watchtime[0]["et"]) == pytest.approx(YOUTUBE_HISTORY_PING_INTERVAL_SECONDS)
    assert watchtime[0]["cmt"] == watchtime[0]["et"]
    assert all(p["cpn"] == pings.sent[0][1]["cpn"] for _, p, _ in pings.sent)
    reporter._end(("room", MEMBER))


async def test_nothing_is_reported_without_the_setting_cookies_or_a_youtube_video(opted_in):
    clock = FakeClock()
    pings = Pings()
    # Another member without the setting; a live stream; a non-YouTube page.
    for members, state in [
        (["someone@example.com"], _state(clock)),
        ([MEMBER], _state(clock, live=True)),
        ([MEMBER], _state(clock, url="https://www.twitch.tv/x")),
    ]:
        manager = FakeManager(state, clock, members)
        reporter = _reporter(manager, clock, pings)
        reporter.video_changed("room")
        await reporter.wait_idle()
        assert reporter.captured == [] and pings.sent == []
        assert not reporter.active_for("room", members[0])


async def test_pause_and_seek_close_the_watched_range_honestly(opted_in):
    clock = FakeClock()
    pings = Pings()
    manager = FakeManager(_state(clock), clock, [MEMBER])

    async def no_sleep(seconds):
        # Between pings the test moves the clock itself.
        clock.slept.append(seconds)
        await asyncio.sleep(0)
        raise asyncio.CancelledError  # do not report on the interval in this test

    reporter = _reporter(manager, clock, pings)
    reporter._sleep = no_sleep
    reporter.video_changed("room")
    await reporter.wait_idle()
    assert pings.sent[0][0] == "playback"

    # 20s of playback, then a member pauses at 20s.
    clock.t += 20
    await manager.update_state("room", {"is_playing": False, "timestamp": 20.0})
    reporter.rearm("room")
    await reporter.wait_idle()
    paused = pings.sent[-1]
    assert paused[0] == "watchtime" and paused[1]["st"] == "0.000" and paused[1]["et"] == "20.000"

    # Resume, play 10s, then seek to 100s: the range ends at 30s, not 100s.
    await manager.update_state("room", {"is_playing": True, "timestamp": 20.0})
    reporter.rearm("room")
    await reporter.wait_idle()
    clock.t += 10
    await manager.update_state("room", {"timestamp": 100.0})
    reporter.rearm("room")
    await reporter.wait_idle()
    seek = pings.sent[-1]
    assert seek[0] == "watchtime" and seek[1]["st"] == "20.000" and seek[1]["et"] == "30.000"
    session = reporter._sessions[("room", MEMBER)]
    assert session.range_start == pytest.approx(100.0)

    # A tiny range (a stutter) is not worth a ping.
    before = len(pings.sent)
    await manager.update_state("room", {"timestamp": 100.2})
    reporter.rearm("room")
    await reporter.wait_idle()
    assert len(pings.sent) == before


async def test_a_refusal_from_youtube_ends_the_session(opted_in):
    clock = FakeClock()
    pings = Pings(status=403)
    manager = FakeManager(_state(clock), clock, [MEMBER])
    reporter = _reporter(manager, clock, pings)
    reporter.video_changed("room")
    await reporter.wait_idle()
    assert len(pings.sent) == 1
    assert not reporter.active_for("room", MEMBER)


async def test_leaving_and_switching_off_stop_reporting(opted_in):
    clock = FakeClock()
    pings = Pings()
    manager = FakeManager(_state(clock), clock, [MEMBER])

    async def never(seconds):
        await asyncio.Event().wait()

    reporter = _reporter(manager, clock, pings)
    reporter._sleep = never
    reporter.video_changed("room")
    while not reporter.active_for("room", MEMBER):
        await asyncio.sleep(0)

    # The member switches the setting off in another tab.
    reporter.settings_changed(MEMBER, {"youtube_history": False})
    assert not reporter.active_for("room", MEMBER)

    # Switching it on again starts a fresh session for the video that plays.
    reporter.settings_changed(MEMBER, {"youtube_history": True})
    while not reporter.active_for("room", MEMBER):
        await asyncio.sleep(0)

    # Their last tab leaves: a final range is reported, then nothing more.
    manager.active_connections["room"] = []
    clock.t += 15
    reporter.member_left("room", MEMBER)
    await asyncio.sleep(0.01)
    assert not reporter.active_for("room", MEMBER)
    assert pings.sent[-1][0] == "watchtime" and pings.sent[-1][1]["et"] == "15.000"


async def test_the_room_moving_on_during_extraction_starts_nothing(opted_in):
    clock = FakeClock()
    pings = Pings()
    manager = FakeManager(_state(clock), clock, [MEMBER])
    gate = asyncio.Event()

    async def slow_capture(url, cookie_path):
        await gate.wait()
        return URLS

    reporter = _reporter(manager, clock, pings, capture=slow_capture)
    reporter.video_changed("room")
    await asyncio.sleep(0)
    manager.room_states["room"]["video_data"] = {"original_url": "https://www.youtube.com/watch?v=otherVideo1"}
    gate.set()
    await asyncio.sleep(0.01)
    assert pings.sent == []


# ---------------------------------------------------------------------------
# The setting through the API
# ---------------------------------------------------------------------------

@pytest.fixture
def client():
    from main import app
    from fastapi.testclient import TestClient
    return TestClient(app)


def test_settings_endpoint_is_per_identity_and_persists(client):
    assert client.get("/api/user/settings").status_code == 401

    default = client.get("/api/user/settings?user=alice@example.com").json()
    assert default == {"settings": {"youtube_history": False}}

    updated = client.put("/api/user/settings?user=alice@example.com",
                         json={"youtube_history": True, "admin": True})
    assert updated.status_code == 200
    assert updated.json() == {"settings": {"youtube_history": True}}
    assert client.get("/api/user/settings?user=alice@example.com").json()["settings"]["youtube_history"] is True
    # Nobody else's setting moved.
    assert client.get("/api/user/settings?user=bob@example.com").json()["settings"]["youtube_history"] is False

    # Stored, not just cached.
    user_settings.clear_cache()
    assert client.get("/api/user/settings?user=alice@example.com").json()["settings"]["youtube_history"] is True

    assert client.put("/api/user/settings?user=alice@example.com", json={"youtube_history": "yes"}).status_code == 422
