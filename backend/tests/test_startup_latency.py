"""
Paste to playing: the parts of starting a video that used to wait needlessly.

Each class pins one defect that a code review found on the path from adding
a URL to its first frame:

* a request missed the cache while a warm was fetching the very same bytes,
  and fetched them again beside it;
* the player's first two requests of every rendition (init segment, index)
  went back to the CDN for bytes the manifest probe had just read;
* warms fetched spans that no player request ever matched;
* one extraction per requester and user agent, instead of one per video;
* queueing a video waited on yt-dlp, and a queue advance blocked the
  sender's socket on it;
* nothing measured any of it.
"""
import asyncio
import logging
import os
import time
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from services import inflight, manifest as manifest_service, prefetcher, prewarm, stream_owner
from services.cache import memory_cache, get_segment_cache_key, stream_identity
from services.mp4_index import parse_index, parse_segment_table

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
with open(os.path.join(FIXTURES, "video.mp4"), "rb") as _handle:
    VIDEO = _handle.read()

URL = (f"https://rr1---sn-test.googlevideo.com/videoplayback?itag=137&clen={len(VIDEO)}"
       f"&lmt=1&mime=video%2Fmp4&id=startup-latency")


def _range_of(target: str):
    """The `range=` a fast googlevideo request carries, as (start, end)."""
    from urllib.parse import parse_qs, urlparse
    first, last = parse_qs(urlparse(target).query)["range"][0].split("-")
    return int(first), int(last)


class _Origin:
    """A stand-in for googlevideo: answers `range=` requests from VIDEO.

    Counts every fetch and can hold each one for `delay` seconds, which is
    what gives a second request the chance to find the first in flight.
    """

    def __init__(self, delay: float = 0.0):
        self.delay = delay
        self.fetches = []

    async def open(self, client, target, headers):
        self.fetches.append((target, dict(headers)))
        await asyncio.sleep(self.delay)
        start, end = _range_of(target)
        body = VIDEO[start:end + 1]
        return httpx.Response(200, stream=_Body(body), headers={
            "content-type": "video/mp4", "content-length": str(len(body))}), \
            SimpleNamespace(hostname="rr1---sn-test.googlevideo.com")


class _Body(httpx.AsyncByteStream):
    """A streamed body, as a real upstream response has."""

    def __init__(self, data: bytes):
        self._data = data

    async def __aiter__(self):
        yield self._data


@pytest.fixture
async def clean():
    await memory_cache.clear()
    manifest_service.clear_index_cache()
    stream_owner.forget_all()
    yield
    await prefetcher.drain_span_warms()
    await prewarm.drain()
    await memory_cache.clear()
    manifest_service.clear_index_cache()
    stream_owner.forget_all()


@pytest.fixture
def origin(monkeypatch):
    import main
    stub = _Origin()
    for module in (main, prefetcher, manifest_service):
        monkeypatch.setattr(module, "open_upstream_stream", stub.open)
    return stub


def _proxy(client_or_app):
    import main
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test")


class TestNobodyFetchesTheSameBytesTwice:

    async def test_a_request_joins_the_warm_already_fetching_its_bytes(self, clean, origin):
        """The read-ahead fetches subsegment i+1 and the player asks for it a
        beat later: one CDN fetch, not two racing on the same link."""
        origin.delay = 0.3
        start, end = 1000, 1999
        async with httpx.AsyncClient() as upstream:
            warm = asyncio.create_task(prefetcher.prefetch_bytes(upstream, URL, start, end))
            await asyncio.sleep(0.05)  # The warm is on the wire.
            assert inflight.count() == 1
            async with _proxy(None) as client:
                response = await client.get("/api/proxy", params={"url": URL},
                                            headers={"Range": f"bytes={start}-{end}"})
            await warm
        assert response.status_code == 206
        assert response.content == VIDEO[start:end + 1]
        assert response.headers["content-range"] == f"bytes {start}-{end}/{len(VIDEO)}"
        assert len(origin.fetches) == 1

    async def test_two_viewers_asking_at_once_cost_one_fetch(self, clean, origin):
        origin.delay = 0.2
        async with _proxy(None) as client:
            first, second = await asyncio.gather(*[
                client.get("/api/proxy", params={"url": URL}, headers={"Range": "bytes=2000-2999"})
                for _ in range(2)])
        assert first.content == second.content == VIDEO[2000:3000]
        assert second.headers["content-range"] == first.headers["content-range"]
        assert len(origin.fetches) == 1

    async def test_a_warm_does_not_refetch_what_a_viewer_is_fetching(self, clean, origin):
        origin.delay = 0.2
        async with _proxy(None) as client, httpx.AsyncClient() as upstream:
            viewer = asyncio.create_task(client.get(
                "/api/proxy", params={"url": URL}, headers={"Range": "bytes=3000-3999"}))
            await asyncio.sleep(0.05)
            await prefetcher.prefetch_bytes(upstream, URL, 3000, 3999)
            await viewer
        assert len(origin.fetches) == 1

    async def test_a_registration_that_was_never_released_expires(self, clean, monkeypatch):
        """A streamed response that never started cannot release itself."""
        from core import config
        monkeypatch.setattr(inflight, "INFLIGHT_MAX_AGE_SECONDS", 0.01)
        with inflight.fetching(URL, 0, 99, None):
            await asyncio.sleep(0.05)
            assert not inflight.is_fetching(URL, 0, 99, None)
            assert await inflight.join(URL, 0, 99, None, timeout=1) is False
        # Long enough for a real fetch to finish, short enough that a leftover
        # stops costing requests a join timeout soon.
        assert config.INFLIGHT_JOIN_TIMEOUT_SECONDS * 2 <= config.INFLIGHT_MAX_AGE_SECONDS <= 60


class TestTheProbeAnswersThePlayersFirstRequests:

    async def test_init_and_index_come_from_memory_after_a_manifest_build(
            self, clean, origin, monkeypatch):
        async with httpx.AsyncClient() as upstream:
            index = await manifest_service.probe_index(upstream, URL, {"User-Agent": "test"})
        assert index is not None
        probe_target, probe_headers = origin.fetches[0]
        assert "range=" in probe_target and "Range" not in probe_headers, \
            "the probe takes googlevideo's fast path"

        import main

        async def refuse(*args, **kwargs):
            raise AssertionError("the player's init/index request went to the CDN")

        monkeypatch.setattr(main, "open_upstream_stream", refuse)
        async with _proxy(None) as client:
            for span in (index.init_range, index.index_range):
                response = await client.get("/api/proxy", params={"url": URL},
                                            headers={"Range": f"bytes={span}"})
                first, last = (int(x) for x in span.split("-"))
                assert response.status_code == 206
                assert response.content == VIDEO[first:last + 1]
                assert response.headers["content-range"] == f"bytes {span}/{len(VIDEO)}"

    async def test_bytes_probed_with_someone_elses_cookies_are_not_kept(self, clean, origin):
        """The proxy would fetch this URL anonymously; a prefix fetched with a
        member's cookies must not be filed where that request finds it."""
        async with httpx.AsyncClient() as upstream:
            await manifest_service.probe_index(upstream, URL, {"Cookie": "SID=someone"})
        assert await memory_cache.get_range(URL, 0, 99, None) is None


class TestWarmsAnswerThePlayerVerbatim:

    async def test_a_warmed_position_is_a_memory_hit_for_the_players_request(
            self, clean, origin, monkeypatch):
        table = parse_segment_table(VIDEO, parse_index(VIDEO))
        monkeypatch.setitem(manifest_service._segment_tables, stream_identity(URL), table)
        video = {"available_qualities": [{"video_url": URL, "height": 1080, "vcodec": "avc1"}]}
        async with httpx.AsyncClient() as upstream:
            prewarm.warm_position(upstream, video, 2.5)
            await prewarm.drain()
        warmed = len(origin.fetches)
        assert warmed >= 1

        start, end = table.span(table.index_at(2.5))
        async with _proxy(None) as client:
            response = await client.get("/api/proxy", params={"url": URL},
                                        headers={"Range": f"bytes={start}-{end}"})
        assert response.content == VIDEO[start:end + 1]
        assert len(origin.fetches) == warmed, "served from the warm, not the CDN"

    async def test_read_ahead_after_a_request_answers_the_next_one(self, clean, origin, monkeypatch):
        table = parse_segment_table(VIDEO, parse_index(VIDEO))
        monkeypatch.setitem(manifest_service._segment_tables, stream_identity(URL), table)
        first = table.span(0)
        second = table.span(1)
        async with _proxy(None) as client:
            await client.get("/api/proxy", params={"url": URL},
                             headers={"Range": f"bytes={first[0]}-{first[1]}"})
            await prefetcher.drain_span_warms()
            before = len(origin.fetches)
            response = await client.get("/api/proxy", params={"url": URL},
                                        headers={"Range": f"bytes={second[0]}-{second[1]}"})
        assert response.content == VIDEO[second[0]:second[1] + 1]
        assert len(origin.fetches) == before


class TestOneExtractionPerVideo:

    @pytest.fixture
    def extractions(self, monkeypatch):
        import main
        from test_resolve_pipeline import FAKE_INFO
        calls = []

        def extract(url, opts):
            calls.append(opts["http_headers"]["User-Agent"])
            time.sleep(0.1)
            return FAKE_INFO

        monkeypatch.setattr(main, "_extract_with_options", extract)
        return main, calls

    async def test_different_user_agents_share_one_extraction(self, clean, extractions):
        """A paste-time resolve, the click and the manifest request."""
        main, calls = extractions
        from services.database import clear_format_cache
        await clear_format_cache()
        await asyncio.gather(
            main.resolve_url("https://youtu.be/one-extraction", "Browser A", user_email="a@x.test"),
            main.resolve_url("https://youtu.be/one-extraction", "Browser B", user_email="a@x.test"),
            main.resolve_url("https://youtu.be/one-extraction", None, user_email="a@x.test"),
        )
        assert len(calls) == 1
        await clear_format_cache()

    async def test_a_plain_resolve_joins_a_refresh_under_way(self, clean, extractions):
        main, calls = extractions
        refresh = asyncio.create_task(main.resolve_url("https://youtu.be/join-refresh", refresh=True))
        await asyncio.sleep(0.02)
        await main.resolve_url("https://youtu.be/join-refresh")
        await refresh
        assert len(calls) == 1
        from services.database import clear_format_cache
        await clear_format_cache()

    async def test_a_refresh_never_joins_a_plain_resolve(self, clean, extractions, monkeypatch):
        """A plain resolve may answer with exactly the stale entry a refresh
        is meant to replace."""
        main, calls = extractions
        from services.database import clear_format_cache
        await clear_format_cache()
        plain = asyncio.create_task(main.resolve_url("https://youtu.be/no-join"))
        await asyncio.sleep(0.02)
        await main.resolve_url("https://youtu.be/no-join", refresh=True)
        await plain
        assert len(calls) == 2
        await clear_format_cache()


def _video(number: int) -> dict:
    return {"original_url": f"https://youtu.be/latency-{number}", "title": f"Video {number}",
            "stream_url": f"https://cdn.test/{number}.mp4", "stream_type": "default",
            "duration": 100}


def _drain(ws, wanted, limit=20):
    for _ in range(limit):
        message = ws.receive_json()
        if message.get("type") == wanted:
            return message.get("payload", {})
    raise AssertionError(f"no {wanted!r} within {limit} messages")


class TestQueueingNeverWaitsOnAnExtraction:

    @pytest.fixture
    def client(self, monkeypatch):
        import main
        outcomes = {}

        async def resolve(url, user_agent=None, **kwargs):
            await asyncio.sleep(0.3)  # An extraction takes a while.
            outcome = outcomes.get(url)
            if isinstance(outcome, Exception):
                raise outcome
            return _video(int(url.rsplit("-", 1)[1]))

        monkeypatch.setattr(main, "resolve_url", resolve)
        with TestClient(main.app) as test_client:
            yield test_client, outcomes

    def test_the_room_sees_the_entry_at_once_and_then_resolved(self, client):
        test_client, _outcomes = client
        with test_client.websocket_connect("/ws/latency-queue?user=a@example.com") as ws:
            _drain(ws, "sync")
            started = time.monotonic()
            ws.send_json({"type": "queue_add", "payload": {"url": "https://youtu.be/latency-1"}})
            placeholder = _drain(ws, "queue_update")["queue"]
            assert time.monotonic() - started < 0.25, "the placeholder did not wait for the resolve"
            assert placeholder == [{"original_url": "https://youtu.be/latency-1",
                                    "title": "https://youtu.be/latency-1", "pending": True,
                                    "added_by": "a@example.com"}]
            resolved = _drain(ws, "queue_update")["queue"]
            assert resolved[0]["title"] == "Video 1"
            assert "pending" not in resolved[0]
            assert resolved[0]["added_by"] == "a@example.com"

    def test_a_failed_resolve_removes_the_entry_and_tells_the_sender(self, client):
        from fastapi import HTTPException
        test_client, outcomes = client
        outcomes["https://youtu.be/latency-2"] = HTTPException(status_code=403, detail="Age-restricted video.")
        with test_client.websocket_connect("/ws/latency-fail?user=a@example.com") as ws:
            _drain(ws, "sync")
            ws.send_json({"type": "queue_add", "payload": {"url": "https://youtu.be/latency-2"}})
            assert _drain(ws, "queue_update")["queue"][0]["pending"] is True
            assert _drain(ws, "queue_update")["queue"] == []
            failed = _drain(ws, "resolve_failed")
            assert failed == {"url": "https://youtu.be/latency-2", "detail": "Age-restricted video."}

    def test_anything_but_an_address_is_refused(self, client):
        test_client, _outcomes = client
        with test_client.websocket_connect("/ws/latency-refuse?user=a@example.com") as ws:
            _drain(ws, "sync")
            for bad in ({"video_data": _video(3)}, {"url": "javascript:alert(1)"}, {"url": 5},
                        {"url": "https://x.test/" + "a" * 5000}):
                ws.send_json({"type": "queue_add", "payload": bad})
            ws.send_json({"type": "ping", "payload": {"client_time": 1}})
            for _ in range(10):
                message = ws.receive_json()
                assert message["type"] not in ("queue_update", "resolve_failed"), message
                if message["type"] == "pong":
                    break
            assert message["type"] == "pong", message

    def test_a_placeholder_a_restart_orphaned_is_resolved_on_the_next_join(self, client):
        import main
        test_client, _outcomes = client
        main.manager.room_states["latency-orphan"] = {
            "video_data": None, "is_playing": False, "timestamp": 0, "playing_index": -1,
            "queue": [{"original_url": "https://youtu.be/latency-4", "title": "https://youtu.be/latency-4",
                       "pending": True, "added_by": "gone@example.com"}],
            "roles": {}, "permanent": False, "name": "", "activity_log": [],
        }
        with test_client.websocket_connect("/ws/latency-orphan?user=a@example.com") as ws:
            _drain(ws, "sync")
            assert _drain(ws, "queue_update")["queue"][0]["title"] == "Video 4"


class TestAnAdvanceNeverBlocksTheSendersSocket:

    def test_the_sender_is_answered_while_the_entry_refreshes(self, monkeypatch):
        import main

        async def slow_refresh(entry, room_id, user_email):
            await asyncio.sleep(0.5)
            entry["stream_url"] = "https://cdn.test/refreshed.mp4"
            return entry

        monkeypatch.setattr(main, "_refresh_entry", slow_refresh)
        with TestClient(main.app) as test_client:
            main.manager.room_states["latency-advance"] = {
                "video_data": None, "is_playing": False, "timestamp": 0, "playing_index": -1,
                "queue": [_video(5)], "roles": {}, "permanent": False, "name": "", "activity_log": [],
            }
            with test_client.websocket_connect("/ws/latency-advance?user=a@example.com") as ws:
                _drain(ws, "sync")
                ws.send_json({"type": "queue_play", "payload": {"index": 0}})
                ws.send_json({"type": "ping", "payload": {"client_time": 1}})
                seen = []
                for _ in range(10):
                    message = ws.receive_json()
                    seen.append(message["type"])
                    if message["type"] == "set_video":
                        assert message["payload"]["video_data"]["stream_url"] == "https://cdn.test/refreshed.mp4"
                        break
                assert seen.index("pong") < seen.index("set_video"), seen


class TestAnnouncedWarms:

    @pytest.fixture
    def warms(self, monkeypatch):
        import main
        calls = []

        def record(client, video, prepare=None, room_id="", **kwargs):
            calls.append((video.get("original_url"), room_id, kwargs))

        monkeypatch.setattr(main.prewarm, "warm_video", record)
        return main, calls

    def test_a_queue_entry_is_warmed_on_the_rung_and_position_announced(self, warms):
        main, calls = warms
        with TestClient(main.app) as test_client:
            main.manager.room_states["latency-warm"] = {
                "video_data": None, "is_playing": False, "timestamp": 0, "playing_index": -1,
                "queue": [_video(6)], "roles": {}, "permanent": False, "name": "", "activity_log": [],
            }
            with test_client.websocket_connect("/ws/latency-warm?user=a@example.com") as ws:
                _drain(ws, "sync")
                response = test_client.get("/api/prewarm", params={
                    "url": _video(6)["original_url"], "room": "latency-warm", "t": 12.5,
                    "h": 720, "codec": "avc1", "user": "a@example.com"})
        assert response.status_code == 202
        assert calls == [(_video(6)["original_url"], "latency-warm",
                          {"rungs": [(720, "avc1")], "seconds": 12.5})]

    def test_an_address_nobody_resolved_is_never_fetched(self, warms):
        main, calls = warms
        with TestClient(main.app) as test_client:
            response = test_client.get("/api/prewarm", params={
                "url": "http://169.254.169.254/latest/meta-data", "user": "a@example.com"})
        assert response.status_code == 202
        assert response.json() == {"status": "unknown"}
        assert calls == []

    def test_an_outsider_does_not_borrow_the_rooms_cookies(self, warms):
        """Only a member may have the room's members lend cookies to a re-resolve."""
        main, calls = warms
        with TestClient(main.app) as test_client:
            main.manager.room_states["latency-private"] = {
                "video_data": _video(7), "is_playing": True, "timestamp": 0, "playing_index": 0,
                "queue": [_video(7)], "roles": {}, "permanent": False, "name": "", "activity_log": [],
            }
            test_client.get("/api/prewarm", params={
                "url": _video(7)["original_url"], "room": "latency-private",
                "codec": "<script>", "user": "outsider@example.com"})
        assert calls == []  # Not in the room, and not a cached resolve either.


class TestStartupIsMeasured:

    @pytest.fixture(autouse=True)
    def fresh_history(self):
        from services import startup_timing
        startup_timing.history.reset()
        yield startup_timing
        startup_timing.history.reset()

    def test_a_players_report_is_bounded_and_logged(self, fresh_history, caplog):
        startup_timing = fresh_history
        with caplog.at_level(logging.INFO, logger="services.startup_timing"):
            kept = startup_timing.record_start("room", "a@example.com", {
                "original_url": "https://youtu.be/x", "engine": "mse", "preloaded": True,
                "resolve_ms": 812.4, "set_video_to_manifest_ms": 240,
                "set_video_to_first_frame_ms": 420, "first_frame_to_playing_ms": -5,
                "rung_height": 1080, "stalls_first_30s": 0, "extra": "ignored"})
        assert kept["resolve_ms"] == 812
        assert kept["first_frame_to_playing_ms"] is None, "a negative phase is not a phase"
        assert "extra" not in kept
        line = next(r.getMessage() for r in caplog.records if r.getMessage().startswith("Startup timing:"))
        assert "preloaded=yes" in line and "set_video_to_first_frame_ms=420" in line

    @pytest.mark.parametrize("report", [
        None, "text", {}, {"original_url": "x", "engine": "flash", "set_video_to_first_frame_ms": 1},
        {"original_url": "x", "engine": "mse", "set_video_to_first_frame_ms": "fast"},
        {"original_url": "x", "engine": "mse", "set_video_to_first_frame_ms": 10 ** 12},
    ])
    def test_anything_else_is_not_a_report(self, fresh_history, report):
        assert fresh_history.record_start("room", "a@example.com", report) is None
        assert not fresh_history.history.starts

    def test_the_summary_separates_preloaded_starts(self, fresh_history):
        startup_timing = fresh_history
        for ms, preloaded in ((300, True), (400, True), (2500, False), (3000, False)):
            startup_timing.record_start("room", "a@example.com", {
                "original_url": "https://youtu.be/x", "engine": "mse", "preloaded": preloaded,
                "set_video_to_first_frame_ms": ms})
        startup_timing.record_resolve("https://youtu.be/x", 900, startup_timing.RESOLVE_EXTRACTED)
        startup_timing.record_resolve("https://youtu.be/x", 2, startup_timing.RESOLVE_CACHED)
        summary = startup_timing.history.summary()
        assert summary["first_frame_ms_preloaded"]["count"] == 2
        assert summary["first_frame_ms_cold"]["p50"] >= 2500
        assert summary["resolve_cache_hit_ratio"] == 0.5
        assert summary["resolve_extraction_ms"]["p50"] == 900

    def test_the_room_socket_carries_it(self, fresh_history):
        import main
        with TestClient(main.app) as test_client:
            with test_client.websocket_connect("/ws/latency-timing?user=a@example.com") as ws:
                _drain(ws, "sync")
                ws.send_json({"type": "playback_timing", "payload": {
                    "original_url": "https://youtu.be/x", "engine": "hls",
                    "set_video_to_first_frame_ms": 1500}})
                ws.send_json({"type": "ping", "payload": {"client_time": 1}})
                _drain(ws, "pong")
        assert [s["room"] for s in fresh_history.history.starts] == ["latency-timing"]

    async def test_a_cache_hit_resolve_is_recorded(self, fresh_history, monkeypatch):
        import main

        async def cached(url):
            return _video(8)

        monkeypatch.setattr(main, "get_cached_format", cached)
        await main.resolve_url(_video(8)["original_url"])
        assert [e["outcome"] for e in fresh_history.history.resolves] == ["cached"]

    def test_the_admin_overview_includes_it(self, fresh_history, monkeypatch):
        import main
        from core import config
        monkeypatch.setattr(config, "ADMIN_EMAILS", frozenset({"boss@example.com"}))
        with TestClient(main.app) as test_client:
            body = test_client.get("/api/admin/overview?user=boss@example.com").json()
        assert set(body["startup_timing"]) == {"summary", "resolves", "manifests", "starts"}


class TestTheMemoryCacheIndex:

    async def test_evicted_entries_leave_the_range_index(self):
        from services.cache import MemoryCache
        cache = MemoryCache(max_size_bytes=100)  # Items up to 25 bytes; four fit.
        for number in range(5):
            first = number * 25
            await cache.put(get_segment_cache_key(URL, first, first + 24), bytes([number]) * 25,
                            "video/mp4", content_range=f"bytes {first}-{first + 24}/{len(VIDEO)}")
        assert await cache.get_range(URL, 0, 10) is None, "the evicted entry is gone from the index"
        assert await cache.get_range(URL, 110, 120) == (bytes([4]) * 11, "video/mp4",
                                                        f"bytes 110-120/{len(VIDEO)}")
        await cache.clear()
        assert await cache.get_range(URL, 70, 80) is None

    async def test_looking_is_not_counted_as_a_viewer_miss(self):
        from services.cache import MemoryCache
        cache = MemoryCache()
        assert cache.contains("seg_x_0-1") is False
        assert cache.get_stats()["misses"] == 0


class TestAnUnresolvableEntryIsPassedOver:

    def test_playing_a_placeholder_that_cannot_resolve_moves_to_the_next(self, monkeypatch):
        """Handing the room an entry with no stream leaves every player
        on an error; the room moves on instead."""
        import main

        async def refresh(entry, room_id, user_email):
            if entry["original_url"].endswith("-9"):
                return entry  # Still a placeholder: it did not resolve.
            entry["stream_url"] = "https://cdn.test/ok.mp4"
            return entry

        monkeypatch.setattr(main, "_refresh_entry", refresh)
        broken = {"original_url": "https://youtu.be/latency-9", "title": "https://youtu.be/latency-9",
                  "pending": True, "added_by": "a@example.com"}
        with TestClient(main.app) as test_client:
            main.manager.room_states["latency-skip"] = {
                "video_data": None, "is_playing": False, "timestamp": 0, "playing_index": -1,
                "queue": [broken, _video(10)], "roles": {}, "permanent": False, "name": "",
                "activity_log": [],
            }
            with test_client.websocket_connect("/ws/latency-skip?user=a@example.com") as ws:
                _drain(ws, "sync")
                ws.send_json({"type": "queue_play", "payload": {"index": 0}})
                started = _drain(ws, "set_video")["video_data"]
        assert started["original_url"] == _video(10)["original_url"]
        assert [e["original_url"] for e in main.manager.room_states["latency-skip"]["queue"]] == \
            [_video(10)["original_url"]]


class TestReviewFindings:
    """Defects a review of this change found before it shipped."""

    @pytest.mark.parametrize("position", ["inf", "Infinity", "nan", "1e400", "-1", "90000"])
    def test_an_impossible_position_is_a_422_not_a_500(self, position, monkeypatch):
        import main
        monkeypatch.setattr(main.prewarm, "warm_video", lambda *a, **k: None)
        with TestClient(main.app) as test_client:
            response = test_client.get("/api/prewarm", params={
                "url": _video(11)["original_url"], "t": position, "user": "a@example.com"})
        assert response.status_code == 422

    def test_an_anonymous_caller_cannot_borrow_a_rooms_cookies(self, monkeypatch):
        """With auth off there is no identity to check membership against, so
        there is no room to borrow from."""
        import main
        calls = []
        monkeypatch.setattr(main.prewarm, "warm_video",
                            lambda client, video, prepare=None, room_id="", **k: calls.append(room_id))
        monkeypatch.setattr(main, "get_user_from_request", lambda request: None)
        monkeypatch.setattr(main, "REQUIRE_AUTHENTICATION", False)
        with TestClient(main.app) as test_client:
            main.manager.room_states["latency-anon"] = {
                "video_data": _video(12), "is_playing": True, "timestamp": 0, "playing_index": 0,
                "queue": [_video(12)], "roles": {}, "permanent": False, "name": "", "activity_log": [],
            }
            test_client.get("/api/prewarm", params={"url": _video(12)["original_url"], "room": "latency-anon"})
        assert calls == []

    async def test_playing_a_placeholder_joins_its_resolve(self, clean, monkeypatch):
        """Playing a row that is still resolving must not start a second
        extraction beside the one resolving it."""
        import main
        from test_resolve_pipeline import FAKE_INFO
        from services.database import clear_format_cache
        await clear_format_cache()
        calls = []

        def extract(url, opts):
            calls.append(url)
            time.sleep(0.2)
            return FAKE_INFO

        monkeypatch.setattr(main, "_extract_with_options", extract)
        url = "https://youtu.be/latency-joined"
        queued = asyncio.create_task(main.resolve_url(url, user_email="a@example.com"))
        await asyncio.sleep(0.02)
        entry = {"original_url": url, "title": url, "pending": True, "added_by": "a@example.com"}
        await main._refresh_entry(entry, "", "a@example.com")
        await queued
        assert len(calls) == 1
        assert "pending" not in entry and entry["stream_url"]
        await clear_format_cache()

    async def test_a_leftover_registration_does_not_mask_a_live_fetch(self, clean):
        """Waiting follows whichever covering fetch lands first."""
        leftover = inflight.fetching(URL, 0, 999, None)
        leftover.__enter__()
        try:
            async def live():
                with inflight.fetching(URL, 0, 999, None):
                    await asyncio.sleep(0.05)

            task = asyncio.create_task(live())
            await asyncio.sleep(0.01)
            started = time.monotonic()
            assert await inflight.join(URL, 100, 200, None, timeout=2) is True
            assert time.monotonic() - started < 1
            await task
        finally:
            leftover.__exit__(None, None, None)
