"""
Everyone watching one live stream shares one upstream session.

Each fetch of a Twitch master playlist opens a new playback session with its
own media-playlist URLs and its own ad schedule. Every member's player
fetched the master itself — each with a differently signed usher URL — so
two members of one room watched two sessions: one saw "Commercial break in
progress" and the other the stream.
"""
import asyncio
import itertools
from types import SimpleNamespace
from urllib.parse import unquote

import httpx
import pytest

from services import live_playlists, user_cookies

CHANNEL = "somechannel"


def usher(sig: str) -> str:
    return (f"https://usher.ttvnw.net/api/channel/hls/{CHANNEL}.m3u8"
            f"?sig={sig}&token=%7B%22t%22%3A%22{sig}%22%7D&p={sig}")


def media_url(session: int, rendition: str = "chunked") -> str:
    return f"https://video-weaver.example.hls.ttvnw.net/v1/playlist/s{session}-{rendition}.m3u8"


def master_body(session: int) -> str:
    return ("#EXTM3U\n"
            '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p",AUTOSELECT=YES,DEFAULT=YES\n'
            '#EXT-X-STREAM-INF:BANDWIDTH=6000000,VIDEO="chunked"\n'
            f"{media_url(session)}\n"
            '#EXT-X-STREAM-INF:BANDWIDTH=1000000,VIDEO="480p30"\n'
            f"{media_url(session, '480p30')}\n")


MEDIA_BODY = ("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:7\n"
              "#EXTINF:2.000,live\nhttps://video-edge.example.ttvnw.net/v1/segment/a.ts\n")


class Upstream:
    """Twitch as far as playlists go: every master fetch is a new session."""

    def __init__(self):
        self.sessions = itertools.count(1)
        self.fetches = []
        self.media_status = 200
        self.delay = 0.0

    async def body(self, client, url, headers):
        self.fetches.append((url, headers.get("Cookie")))
        if self.delay:
            await asyncio.sleep(self.delay)
        if "usher.ttvnw.net" in url:
            return httpx.Response(200, text=master_body(next(self.sessions)))
        return httpx.Response(self.media_status, text=MEDIA_BODY if self.media_status == 200 else "gone")

    def count(self, needle: str) -> int:
        return sum(1 for url, _ in self.fetches if needle in url)


@pytest.fixture
def upstream(monkeypatch):
    import main

    fake = Upstream()
    monkeypatch.setattr(main, "fetch_upstream_body", fake.body)
    return fake


@pytest.fixture
async def client():
    import main

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                                 base_url="http://test") as http:
        yield http


async def proxied(client, url: str, user: str = "a@example.com") -> httpx.Response:
    return await client.get("/api/proxy", params={"url": url, "user": user})


def _uncacheable(response: httpx.Response) -> None:
    directives = {d.strip() for d in response.headers.get("cache-control", "").split(",")}
    assert {"private", "no-store"} <= directives, response.headers.get("cache-control")


async def test_viewers_with_different_resolves_share_one_master(upstream, client):
    first = await proxied(client, usher("aaa"), "a@example.com")
    second = await proxied(client, usher("bbb"), "b@example.com")

    assert first.status_code == second.status_code == 200
    assert first.content == second.content
    assert upstream.count("usher.ttvnw.net") == 1
    _uncacheable(first)
    _uncacheable(second)


async def test_concurrent_master_fetches_are_one_upstream_fetch(upstream, client):
    upstream.delay = 0.05
    responses = await asyncio.gather(*(proxied(client, usher(sig)) for sig in ("a", "b", "c")))

    assert len({r.content for r in responses}) == 1
    assert upstream.count("usher.ttvnw.net") == 1


async def test_another_cookie_identity_gets_its_own_session(upstream, client):
    user_cookies.store("b@example.com",
                       "# Netscape HTTP Cookie File\n"
                       ".ttvnw.net\tTRUE\t/\tFALSE\t9999999999\tauth-token\tsecret\n")

    anonymous = await proxied(client, usher("aaa"), "a@example.com")
    signed_in = await proxied(client, usher("bbb"), "b@example.com")

    assert anonymous.content != signed_in.content
    assert upstream.count("usher.ttvnw.net") == 2
    assert [cookie for url, cookie in upstream.fetches] == [None, "auth-token=secret"]


async def test_an_expired_media_playlist_drops_the_shared_master(upstream, client):
    await proxied(client, usher("aaa"))
    upstream.media_status = 404
    gone = await proxied(client, media_url(1))
    assert gone.status_code == 404

    renewed = await proxied(client, usher("bbb"))
    assert upstream.count("usher.ttvnw.net") == 2
    assert media_url(2) in unquote(renewed.text)


async def test_an_idle_shared_master_is_dropped(upstream, client, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(live_playlists, "time", SimpleNamespace(monotonic=lambda: now[0]))

    await proxied(client, usher("aaa"))
    now[0] += live_playlists.LIVE_MASTER_SHARE_SECONDS - 1
    await proxied(client, usher("bbb"))
    assert upstream.count("usher.ttvnw.net") == 1

    now[0] += live_playlists.LIVE_MASTER_SHARE_SECONDS
    await proxied(client, usher("ccc"))
    assert upstream.count("usher.ttvnw.net") == 2


async def test_concurrent_media_playlist_requests_share_one_fetch(upstream, client):
    upstream.delay = 0.05
    responses = await asyncio.gather(*(proxied(client, media_url(1), user)
                                       for user in ("a@example.com", "b@example.com", "c@example.com")))

    assert all(r.status_code == 200 for r in responses)
    assert len({r.content for r in responses}) == 1
    assert upstream.count("/v1/playlist/") == 1
    for response in responses:
        _uncacheable(response)


async def test_a_media_playlist_is_refetched_after_the_share_window(upstream, client, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(live_playlists, "time", SimpleNamespace(monotonic=lambda: now[0]))

    await proxied(client, media_url(1))
    now[0] += live_playlists.LIVE_PLAYLIST_SHARE_SECONDS / 2
    await proxied(client, media_url(1), "b@example.com")
    assert upstream.count("/v1/playlist/") == 1

    now[0] += live_playlists.LIVE_PLAYLIST_SHARE_SECONDS
    await proxied(client, media_url(1))
    assert upstream.count("/v1/playlist/") == 2


def test_the_share_window_is_well_under_a_live_target_duration():
    assert live_playlists.LIVE_PLAYLIST_SHARE_SECONDS <= 1.0


def test_a_url_without_a_stable_identity_is_never_shared_under_another():
    assert live_playlists.master_key("https://cdn.example.com/live/index.m3u8?token=1", None) is None


async def test_the_prefetch_session_still_parses_shared_media_playlists(upstream, client):
    from services import prefetcher

    target = media_url(99, "prefetch")
    await proxied(client, target, "a@example.com")
    await proxied(client, target, "b@example.com")
    assert upstream.count("/v1/playlist/") == 1

    for viewer in ("a@example.com", "b@example.com"):
        session = await prefetcher.get_or_create_session(target, identity=viewer)
        assert session.segment_urls == ["https://video-edge.example.ttvnw.net/v1/segment/a.ts"]
