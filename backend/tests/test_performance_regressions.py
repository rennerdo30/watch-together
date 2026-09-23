"""Deterministic regressions for startup, queue latency and useful prefetch."""
import asyncio
import time
from unittest.mock import AsyncMock

import httpx
import pytest
from starlette.requests import Request

from connection_manager import ConnectionManager
from services.cache import memory_cache, get_segment_cache_key
from test_resolve_pipeline import FAKE_INFO


async def test_concurrent_resolves_extract_once(monkeypatch):
    import main
    calls = []

    def extract(url, opts):
        calls.append(opts)
        time.sleep(0.05)
        return FAKE_INFO

    monkeypatch.setattr(main, '_extract_with_options', extract)
    request = Request({'type': 'http', 'headers': [], 'query_string': b''})
    results = await asyncio.gather(*[
        main.resolve_video(request, 'https://youtu.be/performance-concurrent')
        for _ in range(8)
    ])
    assert len(calls) == 1
    assert all(r == results[0] for r in results)
    assert calls[0].get('noplaylist') is True


def test_refresh_does_not_extract_a_whole_playlist():
    from services.resolver import build_ydl_opts
    assert build_ydl_opts(None).get('noplaylist') is True


async def test_prefetched_prefix_answers_smaller_player_ranges(monkeypatch):
    import main
    await memory_cache.clear()
    url = 'https://cdn.example.com/performance-range.mp4'
    data = bytes(range(256)) * 16
    await memory_cache.put(get_segment_cache_key(url, 0, 4095), data,
                           'video/mp4', content_range='bytes 0-4095/10000')
    upstream = AsyncMock(side_effect=AssertionError('prefetched bytes must be reused'))
    monkeypatch.setattr(main, 'open_upstream_stream', upstream)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                                base_url='http://test') as client:
        response = await client.get('/api/proxy', params={'url': url},
                                    headers={'Range': 'bytes=512-1023'})
    assert response.status_code == 206
    assert response.content == data[512:1024]
    assert response.headers['content-range'] == 'bytes 512-1023/10000'
    upstream.assert_not_called()
    await memory_cache.clear()


@pytest.mark.parametrize('operation', ['prepend_to_queue', 'play_from_queue', 'next_video'])
async def test_startup_clock_does_not_count_loading_time(monkeypatch, operation):
    manager = ConnectionManager()
    manager.room_states['r'] = {
        'queue': [{'original_url': 'https://example.com/1'}, {'original_url': 'https://example.com/2'}],
        'video_data': {'original_url': 'https://example.com/1'},
        'playing_index': 0, 'timestamp': 0, 'is_playing': False,
    }
    monkeypatch.setattr(manager, '_save_room_state', AsyncMock())
    if operation == 'prepend_to_queue':
        await manager.prepend_to_queue('r', {'original_url': 'https://example.com/3'})
    elif operation == 'play_from_queue':
        await manager.play_from_queue('r', 1)
    else:
        await manager.next_video('r')
    manager.room_states['r']['last_sync_time'] -= 10
    assert manager.get_sync_payload('r')['timestamp'] == 0


async def test_ended_removes_current_url_even_if_index_is_stale(monkeypatch):
    manager = ConnectionManager()
    first = {'original_url': 'https://example.com/1'}
    second = {'original_url': 'https://example.com/2'}
    manager.room_states['r'] = {'queue': [first, second], 'video_data': first,
                                'playing_index': -1}
    monkeypatch.setattr(manager, '_save_room_state', AsyncMock())
    next_video, queue, index, advanced = await manager.next_video('r', first['original_url'])
    assert advanced and next_video == second and queue == [second] and index == 0


async def test_cached_subranges_never_cross_users_or_accept_truncation():
    from services.cache import MemoryCache
    cache = MemoryCache()
    url = 'https://example.com/private.mp4'
    await cache.put(get_segment_cache_key(url, 0, 9, 'alice'), b'0123456789',
                    'video/mp4', content_range='bytes 0-9/100')
    assert await cache.get_range(url, 2, 5, 'bob') is None
    assert await cache.get_range(url, 2, 5) is None
    assert await cache.get_range(url, 8, 12, 'alice') is None
    assert await cache.get_range(url, 2, 5, 'alice') == (b'2345', 'video/mp4', 'bytes 2-5/100')
    await cache.put(get_segment_cache_key(url, 0, 9, 'alice'), b'0123',
                    'video/mp4', content_range='bytes 0-9/100')
    assert await cache.get_range(url, 0, 2, 'alice') is None


async def test_span_warm_uses_owner_and_fast_googlevideo_ranges(monkeypatch):
    from services import prefetcher, stream_owner
    url = ('https://rr1.googlevideo.com/videoplayback?itag=137&clen=10000000'
           '&id=performance-prefetch&lmt=1')
    stream_owner.remember({'stream_url': url, 'resolved_by': 'alice'})
    seen = []

    async def open_stream(client, target, headers):
        seen.append((target, headers))
        return httpx.Response(200, content=b'abc', headers={'content-type': 'video/mp4'}), None

    monkeypatch.setattr(prefetcher, 'open_upstream_stream', open_stream)
    # Patch the existing cookie provider so both old and new code run.
    monkeypatch.setattr('services.user_cookies.get_cookie_header', lambda identity, url: 'session=alice' if identity == 'alice' else None)
    async with httpx.AsyncClient() as client:
        await prefetcher.prefetch_bytes(client, url, 0, 3 * 1024 * 1024 - 1)
    assert seen[0][1].get('Cookie') == 'session=alice'
    assert 'range=' in seen[0][0] and 'Range' not in seen[0][1]
    # A truncated prefetch cannot poison a later ranged response.
    assert await memory_cache.get(get_segment_cache_key(url, 0, 3 * 1024 * 1024 - 1, 'alice')) is None


async def test_hls_prefetch_can_refill_evicted_segments(monkeypatch):
    from services import prefetcher
    calls = []

    class Body(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'video'

    async def open_stream(client, url, headers):
        calls.append(url)
        return httpx.Response(200, stream=Body(), headers={'content-type': 'video/mp2t'}), None

    monkeypatch.setattr(prefetcher, 'open_upstream_stream', open_stream)
    session = prefetcher.PrefetchSession('https://example.com/video.m3u8')
    await session.parse_hls_manifest('#EXTM3U\n#EXTINF:6,\nsegment.ts', session.manifest_url)
    await memory_cache.clear()
    try:
        await session._prefetch_next()
        await memory_cache.clear()  # A busy room evicted it before the viewer requested it.
        await session._prefetch_next()
        assert len(calls) == 2
    finally:
        await session.cleanup()
        await memory_cache.clear()


async def test_advancing_uses_the_cached_resolve_and_its_owner(monkeypatch):
    """The queue advance refreshes an entry through the one resolve path."""
    import main
    import time as time_module
    cached = {'original_url': 'https://example.com/video',
              'stream_url': 'https://example.com/fresh.m3u8', 'resolved_by': 'alice',
              'video_url': f'https://example.com/v?expire={int(time_module.time()) + 3600}'}
    monkeypatch.setattr(main, 'get_cached_format', AsyncMock(return_value=cached))
    monkeypatch.setattr(main, 'resolve_url', AsyncMock(side_effect=AssertionError('cache is fresh')))
    entry = {'original_url': 'https://example.com/video',
             'stream_url': 'https://example.com/expired.m3u8', 'added_by': 'bob'}
    result = await main._refresh_entry(entry, 'room', 'bob@example.com')
    assert result is entry
    assert result['stream_url'] == cached['stream_url']
    assert result['resolved_by'] == 'alice'
    assert result['added_by'] == 'bob'


async def test_refreshed_live_cache_starts_a_new_age():
    from services.database import cache_format, get_cached_format, get_async_db
    url = 'https://twitch.tv/performance-new-age'
    await cache_format(url, {'is_live': True, 'stream_url': 'old'})
    async with get_async_db() as db:
        await db.execute('UPDATE format_cache SET created_at = 0 WHERE original_url = ?', (url,))
        await db.commit()
    await cache_format(url, {'is_live': True, 'stream_url': 'fresh'})
    assert (await get_cached_format(url))['stream_url'] == 'fresh'


async def test_dns_validation_runs_off_the_playback_event_loop(monkeypatch):
    import threading
    from services import upstream
    event_thread = threading.get_ident()
    threads = []

    def pin(url):
        threads.append(threading.get_ident())
        return upstream.PinnedUpstream(url=url, hostname='example.com', ip='93.184.216.34', port=443, scheme='https')

    monkeypatch.setattr(upstream, 'pin_url', pin)
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200))) as client:
        response, _ = await upstream.open_upstream_stream(client, 'https://example.com/video', {})
        await response.aclose()
    assert threads and all(thread != event_thread for thread in threads)


async def test_queue_metadata_does_not_renew_expiring_streams():
    from services.database import cache_format, get_async_db
    url = 'https://example.com/preserve-cache-expiry'
    await cache_format(url, {'stream_url': 'signed-url'}, ttl_seconds=5)
    async with get_async_db() as db:
        cursor = await db.execute('SELECT expires_at, created_at FROM format_cache WHERE original_url = ?', (url,))
        before = tuple(await cursor.fetchone())
    await cache_format(url, {'stream_url': 'signed-url', 'added_by': 'alice'}, preserve_expiry=True)
    async with get_async_db() as db:
        cursor = await db.execute('SELECT expires_at, created_at FROM format_cache WHERE original_url = ?', (url,))
        assert tuple(await cursor.fetchone()) == before


async def test_ready_reports_cannot_restart_an_already_running_clock(monkeypatch):
    manager = ConnectionManager()
    manager.room_states['r'] = {'startup_pending': True, 'is_playing': True, 'timestamp': 0,
                                'video_data': {'original_url': 'current'}}
    monkeypatch.setattr(manager, '_save_room_state', AsyncMock())
    assert not await manager.playback_ready('r', 'previous')
    assert await manager.playback_ready('r', 'current')
    manager.room_states['r']['last_sync_time'] -= 8
    assert not await manager.playback_ready('r', 'current')
    assert manager.get_sync_payload('r')['timestamp'] >= 8


async def test_read_ahead_warms_the_next_subsegments_exactly(monkeypatch):
    """Read-ahead fetches the player's next requests byte for byte.

    It used to fetch aligned 3 MB blocks. The memory cache only answers a
    request that one cached entry fully covers, so a subsegment straddling
    a block boundary — always, at 1440p and above — never hit.
    """
    from services import manifest, prefetcher
    from services.cache import stream_identity
    from services.mp4_index import SegmentTable
    calls = []

    async def warm(client, url, start, end, **kwargs):
        calls.append((start, end, kwargs.get('read_ahead')))
        await asyncio.sleep(0)

    table = SegmentTable(offsets=(1000, 5_001_000, 9_001_000, 13_001_000),
                         starts=(0.0, 5.0, 10.0, 15.0), duration=20.0,
                         sizes=(5_000_000, 4_000_000, 4_000_000, 4_000_000))
    url = 'https://rr1.googlevideo.com/videoplayback?clen=17001000&itag=137&id=read-ahead&lmt=1'
    monkeypatch.setitem(manifest._segment_tables, stream_identity(url), table)
    monkeypatch.setattr(prefetcher, 'prefetch_bytes', warm)
    async with httpx.AsyncClient() as client:
        for _ in range(5):  # A burst of requests for subsegment 0 starts one warm per span.
            prefetcher.prefetch_ahead(client, url, 1000)
        assert len(prefetcher._span_tasks) == 2
        await prefetcher.drain_span_warms()
    assert calls == [(5_001_000, 9_000_999, True), (9_001_000, 13_000_999, True)]


async def test_read_ahead_never_guesses_without_an_index(monkeypatch):
    from services import prefetcher
    monkeypatch.setattr(prefetcher, 'prefetch_bytes', AsyncMock(side_effect=AssertionError('guessed')))
    async with httpx.AsyncClient() as client:
        prefetcher.prefetch_ahead(client, 'https://rr1.googlevideo.com/videoplayback?clen=9&itag=1&lmt=2', 0)
    assert not prefetcher._span_tasks


async def test_hls_prefetch_is_parallel_and_keeps_cookie_identity(monkeypatch):
    from services import prefetcher, user_cookies
    active = peak = 0
    cookies = []

    class Body(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'media'

    async def open_stream(client, url, headers):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        cookies.append(headers.get('Cookie'))
        await asyncio.sleep(0.01)
        active -= 1
        return httpx.Response(200, stream=Body()), None

    monkeypatch.setattr(prefetcher, 'open_upstream_stream', open_stream)
    monkeypatch.setattr(user_cookies, 'get_cookie_header', lambda identity, url: 'session=alice' if identity == 'alice' else None)
    session = prefetcher.PrefetchSession('https://example.com/auth.m3u8', identity='alice')
    await session.parse_hls_manifest('#EXTM3U\na.ts\nb.ts\nc.ts', session.manifest_url)
    try:
        await session._prefetch_next()
        assert 1 < peak <= 3
        assert cookies == ['session=alice'] * 3
        assert await memory_cache.get(get_segment_cache_key('https://example.com/a.ts')) is None
        assert await memory_cache.get(get_segment_cache_key('https://example.com/a.ts', identity='alice'))
    finally:
        await session.cleanup()
        await memory_cache.clear()


async def test_an_expired_queue_entry_is_re_resolved_on_advance(monkeypatch):
    import main
    fresh = {'original_url': 'https://example.com/fresh-queue', 'stream_type': 'dash',
             'duration': 120, 'is_live': False, 'stream_url': 'https://cdn.example.com/new',
             'resolved_by': None}
    resolves = []

    async def resolve(url, user_agent=None, **kwargs):
        resolves.append((url, kwargs.get('refresh'), kwargs.get('room_id')))
        return fresh

    monkeypatch.setattr(main, 'get_cached_format', AsyncMock(return_value=None))
    monkeypatch.setattr(main, 'resolve_url', resolve)
    entry = {'original_url': 'https://example.com/fresh-queue', 'stream_type': 'hls',
             'stream_url': 'https://cdn.example.com/old?expire=1600000000', 'is_live': True,
             'pinned': True, 'progress': 30.0, 'pending': True}
    result = await main._refresh_entry(entry, 'room-x', 'a@example.com')
    assert resolves == [('https://example.com/fresh-queue', True, 'room-x')]
    assert result['stream_type'] == 'dash'
    assert result['duration'] == 120
    assert result['is_live'] is False
    assert result['pinned'] is True and result['progress'] == 30.0
    assert 'pending' not in result
