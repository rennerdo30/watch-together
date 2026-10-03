"""
No playlist or manifest may be cached anywhere between the CDN and a player.

A live playlist changes every couple of seconds. Answered with only
`Cache-Control: no-cache`, the edge in front of the origin cached it and gave
browsers a four-hour max-age: a live viewer reloaded the playlist it first got
forever (no new segments, an endless spinner), and two members of one room
watched two different moments. Segments already carried `private, no-store`
and were passed through untouched; every manifest response must too.
"""
from types import SimpleNamespace

import httpx
import pytest

PLAYLIST = "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,live\nseg1.ts\n"
MPD = '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><BaseURL>a.mp4</BaseURL></MPD>'


def _uncacheable(response: httpx.Response) -> None:
    directives = {d.strip() for d in response.headers.get("cache-control", "").split(",")}
    assert {"private", "no-store"} <= directives, response.headers.get("cache-control")


class _Body(httpx.AsyncByteStream):
    def __init__(self, data: bytes):
        self._data = data

    async def __aiter__(self):
        yield self._data


@pytest.fixture
def upstream(monkeypatch):
    import main

    async def body(client, url, headers):
        text = MPD if url.endswith(".mpd") else PLAYLIST
        return httpx.Response(200, text=text)

    async def stream(client, url, headers):
        kind = "application/dash+xml" if "mpd" in url else "application/vnd.apple.mpegurl"
        return (httpx.Response(200, stream=_Body(PLAYLIST.encode()), headers={"content-type": kind}),
                SimpleNamespace(hostname="cdn.example.com"))

    monkeypatch.setattr(main, "fetch_upstream_body", body)
    monkeypatch.setattr(main, "open_upstream_stream", stream)
    return main


@pytest.mark.parametrize("target", [
    "https://cdn.example.com/live/index.m3u8",          # an HLS playlist by its name
    "https://cdn.example.com/live/manifest.mpd",        # a DASH manifest by its name
    "https://cdn.example.com/v1/playlist/abc",          # an HLS playlist known only by its type
    "https://cdn.example.com/v1/mpd-by-type",           # a DASH manifest known only by its type
])
async def test_a_proxied_manifest_is_never_cacheable(upstream, target):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=upstream.app),
                                 base_url="http://test") as client:
        response = await client.get("/api/proxy", params={"url": target, "user": "a@example.com"})
    assert response.status_code == 200
    _uncacheable(response)


async def test_a_generated_manifest_is_never_cacheable(monkeypatch):
    import main

    async def cached(url):
        return {"original_url": url, "duration": 6, "stream_url": "https://cdn.example.com/v.mp4",
                "available_qualities": [{"video_url": "https://cdn.example.com/v.mp4", "height": 240}],
                "audio_options": [{"audio_url": "https://cdn.example.com/a.mp4"}]}

    async def build(*args, **kwargs):
        return MPD

    monkeypatch.setattr(main, "get_cached_format", cached)
    monkeypatch.setattr(main, "build_manifest_for_formats", build)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                                 base_url="http://test") as client:
        response = await client.get("/api/dash-manifest",
                                    params={"url": "https://youtu.be/x", "user": "a@example.com"})
    assert response.status_code == 200
    _uncacheable(response)
