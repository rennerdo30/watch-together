"""
Every fetch of a video's stream URLs carries the cookies they were signed for.

A video is resolved once, with one member's cookies. The manifest probes and
segment fetches used to carry the *requesting* member's cookies instead; the
CDN refused most renditions for anyone else, each was silently dropped, and
that member got a manifest with one or two qualities — "quality selection
does nothing unless the person who added the video changes it first".
"""
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from core.security import get_user_cookie_path
from services import stream_owner
from services.user_cookies import clear_cache

ADDER = "adder@example.com"
OTHER = "other@example.com"
VIDEO_URL = "https://youtu.be/owner-test"
STREAM = "https://rr1---sn-x.googlevideo.com/videoplayback?itag=137&clen=1000&lmt=1&sig=for-adder"
AUDIO = "https://rr1---sn-x.googlevideo.com/videoplayback?itag=140&clen=500&lmt=1&sig=for-adder"


def _write_cookies(user, value):
    path = get_user_cookie_path(user)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    far = int(time.time()) + 86400
    with open(path, "w") as f:
        f.write("# Netscape HTTP Cookie File\n" + "\t".join(
            [".googlevideo.com", "TRUE", "/", "FALSE", str(far), "SID", value]) + "\n")
    return path


@pytest.fixture(autouse=True)
def clean():
    stream_owner.forget_all()
    clear_cache()
    yield
    stream_owner.forget_all()
    clear_cache()


@pytest.fixture
def cookie_files():
    """Cookie files for both members.

    Requested *after* the app client in tests that start the app: startup
    migrates loose cookie files into the database and removes them.
    """
    created = [_write_cookies(ADDER, "adder-secret"), _write_cookies(OTHER, "other-secret")]
    yield
    for p in created:
        if os.path.exists(p):
            os.remove(p)


def _video(resolved_by=ADDER):
    return {
        "original_url": VIDEO_URL, "stream_url": STREAM, "video_url": STREAM, "audio_url": AUDIO,
        "title": "T", "duration": 60, "stream_type": "dash",
        "available_qualities": [{"format_id": "137", "video_url": STREAM, "height": 1080, "vcodec": "avc1"}],
        "audio_options": [{"format_id": "140", "audio_url": AUDIO, "acodec": "mp4a"}],
        "resolved_by": resolved_by,
    }


def test_owner_is_remembered_for_every_url_of_the_video():
    stream_owner.remember(_video())
    rotated = STREAM.replace("sig=for-adder", "sig=rotated&expire=999")
    assert stream_owner.owner_of(STREAM) == ADDER
    assert stream_owner.owner_of(AUDIO) == ADDER
    assert stream_owner.owner_of(rotated) == ADDER  # identity ignores the rotating parts
    assert stream_owner.is_known(STREAM)
    assert not stream_owner.is_known("https://elsewhere.example/x?itag=999&clen=1&lmt=1")

    stream_owner.remember(_video(resolved_by=None))
    assert stream_owner.owner_of(STREAM) is None and stream_owner.is_known(STREAM)

    # A copy without the field says nothing about ownership.
    stream_owner.forget_all()
    v = _video()
    del v["resolved_by"]
    stream_owner.remember(v)
    assert not stream_owner.is_known(STREAM)


def test_a_client_cannot_choose_whose_cookies_are_used():
    client_copy = {**_video(), "resolved_by": "victim@example.com"}
    stream_owner.sanitize_client_video(client_copy, cached=_video())
    assert client_copy["resolved_by"] == ADDER
    client_copy = {**_video(), "resolved_by": "victim@example.com"}
    stream_owner.sanitize_client_video(client_copy, cached=None)
    assert "resolved_by" not in client_copy

    # A copy of a known video carrying URLs the resolve never produced gets
    # no owner: those URLs must not be fetched with the resolver's cookies.
    poisoned = {**_video(), "video_url": "https://www.youtube.com/feed/history"}
    stream_owner.sanitize_client_video(poisoned, cached=_video())
    assert "resolved_by" not in poisoned


def test_the_owner_is_bound_to_the_host_the_resolve_produced():
    stream_owner.remember(_video())
    same_params_elsewhere = STREAM.replace("rr1---sn-x.googlevideo.com", "www.youtube.com")
    assert not stream_owner.is_known(same_params_elsewhere)
    assert stream_owner.owner_of(same_params_elsewhere) is None


@pytest.fixture
def client():
    from main import app
    with TestClient(app) as c:
        yield c


def test_resolving_records_who_resolved(client, monkeypatch):
    import asyncio
    import main as main_module
    from services.database import save_user_cookies
    from tests.test_resolve_pipeline import FAKE_INFO

    seen = []

    def fake_extract(url, opts):
        seen.append(opts.get("cookiefile"))
        return FAKE_INFO

    monkeypatch.setattr(main_module, "_extract_with_options", fake_extract)
    # The member's cookies are in the database but not on disk, as after a
    # restart. Resolving must restore and use them, not go anonymous.
    asyncio.run(save_user_cookies(ADDER, "# Netscape HTTP Cookie File\n"))
    assert not os.path.exists(get_user_cookie_path(ADDER))
    with_cookies = client.get("/api/resolve", params={"url": "https://youtu.be/r1", "user": ADDER}).json()
    assert seen[-1] == get_user_cookie_path(ADDER)
    assert with_cookies["resolved_by"] == ADDER
    assert stream_owner.owner_of(with_cookies["video_url"]) == ADDER

    stream_owner.forget_all()
    anonymous = client.get("/api/resolve", params={"url": "https://youtu.be/r2", "user": "nobody@example.com"}).json()
    assert anonymous["resolved_by"] is None
    assert stream_owner.is_known(anonymous["video_url"])


def test_manifest_probes_with_the_resolvers_cookies_for_everyone(client, cookie_files, monkeypatch):
    import main as main_module
    from services.database import cache_format
    import asyncio

    asyncio.run(cache_format(VIDEO_URL, _video()))
    seen = []

    async def fake_build(client_, duration_seconds, video_formats, audio_formats, proxy_base, headers=None):
        seen.append(dict(headers or {}))
        return "<MPD/>"

    monkeypatch.setattr(main_module, "build_manifest_for_formats", fake_build)
    for user in (OTHER, ADDER, "third@example.com"):
        assert client.get("/api/dash-manifest", params={"url": VIDEO_URL, "user": user}).status_code == 200
    assert [h.get("Cookie") for h in seen] == ["SID=adder-secret"] * 3


def test_set_video_from_a_client_keeps_the_servers_owner(client):
    import asyncio
    from services.database import cache_format, get_cached_format

    asyncio.run(cache_format(VIDEO_URL, _video()))
    forged = {**_video(), "resolved_by": OTHER}
    with client.websocket_connect(f"/ws/owner-room?user={OTHER}") as ws:
        ws.receive_json()
        ws.send_json({"type": "set_video", "payload": {"video_data": forged}})
        for _ in range(5):
            msg = ws.receive_json()
            if msg["type"] == "set_video":
                break
    assert asyncio.run(get_cached_format(VIDEO_URL))["resolved_by"] == ADDER
    # A client's message registers nothing; only the server's own paths do.
    assert not stream_owner.is_known(STREAM)

    # The same message with a swapped stream URL: the cache entry loses its
    # owner, the swapped URL is never registered, and the manifest built from
    # that entry probes without the resolver's cookies.
    poisoned = {**_video(), "resolved_by": ADDER, "video_url": "https://www.youtube.com/feed/history"}
    with client.websocket_connect(f"/ws/owner-room?user={OTHER}") as ws:
        ws.receive_json()
        ws.send_json({"type": "set_video", "payload": {"video_data": poisoned}})
        for _ in range(5):
            if ws.receive_json()["type"] == "set_video":
                break
    assert asyncio.run(get_cached_format(VIDEO_URL)).get("resolved_by") is None
    assert not stream_owner.is_known("https://www.youtube.com/feed/history")


class TestProxyUsesTheOwnersCookies:
    """Served from a local origin that records the Cookie header it was sent."""

    PAYLOAD = b"x" * 512

    @pytest.fixture
    def origin(self):
        seen = []
        payload = self.PAYLOAD

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append(self.headers.get("Cookie"))
                query = parse_qs(urlparse(self.path).query)
                spec = (query.get("range") or [None])[0]
                body = payload
                if spec:
                    a, _, b = spec.partition("-")
                    body = payload[int(a):int(b) + 1]
                self.send_response(200)
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        yield server.server_port, seen
        server.shutdown()
        server.server_close()

    @pytest.fixture
    def proxy(self, origin, monkeypatch):
        import services.upstream as upstream
        from main import app
        port, _ = origin
        monkeypatch.setattr(upstream, "_is_public_ip", lambda ip: True)
        monkeypatch.setattr(upstream, "UPSTREAM_ALLOWED_PORTS", upstream.UPSTREAM_ALLOWED_PORTS + (port,))
        monkeypatch.setattr(upstream, "_resolve_public_addresses", lambda hostname, p: ["127.0.0.1"])
        return TestClient(app)

    @pytest.fixture(autouse=True)
    async def empty_caches(self):
        from services.cache import memory_cache
        await memory_cache.clear()
        yield
        await memory_cache.clear()

    def _url(self, port, itag):
        return (f"http://rr1---sn-x.googlevideo.com:{port}/videoplayback"
                f"?itag={itag}&clen={len(self.PAYLOAD)}&lmt=7&sig=for-adder")

    def test_members_fetch_a_known_stream_with_the_resolvers_cookies(self, proxy, cookie_files, origin):
        port, seen = origin
        video = _video()
        video["video_url"] = video["stream_url"] = self._url(port, 137)
        video["available_qualities"][0]["video_url"] = self._url(port, 137)
        stream_owner.remember(video)

        for user, rng in ((OTHER, "bytes=0-99"), ("nobody@example.com", "bytes=100-199")):
            r = proxy.get("/api/proxy", params={"url": self._url(port, 137), "user": user}, headers={"Range": rng})
            assert r.status_code in (200, 206), r.text
        assert seen == ["SID=adder-secret", "SID=adder-secret"]

    def test_an_unknown_url_still_uses_the_callers_own_cookies(self, proxy, cookie_files, origin):
        port, seen = origin
        r = proxy.get("/api/proxy", params={"url": self._url(port, 999), "user": OTHER}, headers={"Range": "bytes=0-9"})
        assert r.status_code in (200, 206)
        assert seen == ["SID=other-secret"]
