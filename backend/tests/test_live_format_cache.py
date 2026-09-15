"""
Regression tests: cached live formats must not outlive their signed URLs.

Production failure (2026-08-30): a Twitch live stream's usher playlist URL
carries a signed token with its own expiry. The format cache stored the
resolved live format for the full VOD TTL (2 hours), so once the token died
upstream, every viewer's re-resolve — including the one a page refresh
triggers — kept receiving the same dead URL and every proxied fetch answered
403 until the entry finally expired.

Live entries therefore get a short TTL on write, and — because entries
written by an older deployment still carry the long TTL — the age limit is
enforced on read as well.
"""
import json
import time


LIVE_URL = "https://www.twitch.tv/somestreamer"
VOD_URL = "https://www.youtube.com/watch?v=abc123"
# The data dir (and DB) is shared across the whole test session, so the test
# that inserts a raw row needs its own key.
STALE_LIVE_URL = "https://www.twitch.tv/wrotebyanolderdeployment"


class TestLiveFormatCacheTTL:
    async def test_live_format_is_cached_with_the_short_ttl(self, isolated_data_dir):
        from services.database import init_database, cache_format, get_async_db
        from core.config import FORMAT_CACHE_LIVE_TTL_SECONDS, FORMAT_CACHE_TTL_SECONDS

        init_database()
        await cache_format(LIVE_URL, {
            "is_live": True,
            "stream_url": "https://usher.example/playlist.m3u8?token=signed",
        })

        async with get_async_db() as db:
            cursor = await db.execute(
                "SELECT expires_at, created_at FROM format_cache WHERE original_url = ?",
                (LIVE_URL,),
            )
            row = await cursor.fetchone()

        assert row is not None
        ttl = row["expires_at"] - row["created_at"]
        assert ttl <= FORMAT_CACHE_LIVE_TTL_SECONDS, (
            f"a live format was cached for {ttl:.0f}s — long enough for its "
            "signed URL to die upstream while the cache keeps serving it"
        )
        assert ttl < FORMAT_CACHE_TTL_SECONDS

    async def test_vod_format_keeps_the_long_ttl(self, isolated_data_dir):
        from services.database import init_database, cache_format, get_async_db
        from core.config import FORMAT_CACHE_LIVE_TTL_SECONDS

        init_database()
        await cache_format(VOD_URL, {
            "is_live": False,
            "stream_url": "https://cdn.example/video.mp4",
        })

        async with get_async_db() as db:
            cursor = await db.execute(
                "SELECT expires_at, created_at FROM format_cache WHERE original_url = ?",
                (VOD_URL,),
            )
            row = await cursor.fetchone()

        assert row is not None
        assert row["expires_at"] - row["created_at"] > FORMAT_CACHE_LIVE_TTL_SECONDS

    async def test_stale_live_entry_is_refused_even_before_its_stored_expiry(
        self, isolated_data_dir,
    ):
        """An old deployment wrote live entries with the 2-hour TTL."""
        from services.database import init_database, get_cached_format, get_async_db
        from core.config import FORMAT_CACHE_LIVE_TTL_SECONDS

        init_database()
        now = time.time()
        async with get_async_db() as db:
            await db.execute(
                """INSERT INTO format_cache (original_url, video_data, expires_at, created_at)
                   VALUES (?, ?, ?, ?)""",
                (
                    STALE_LIVE_URL,
                    json.dumps({"is_live": True, "stream_url": "https://usher.example/dead.m3u8"}),
                    now + 7000,  # stored expiry far in the future
                    now - (FORMAT_CACHE_LIVE_TTL_SECONDS + 100),
                ),
            )
            await db.commit()

        assert await get_cached_format(STALE_LIVE_URL) is None, (
            "a live entry older than the live TTL was served from the cache; "
            "its signed URL may already be rejected upstream"
        )

    async def test_fresh_live_entry_is_still_served(self, isolated_data_dir):
        from services.database import init_database, cache_format, get_cached_format

        init_database()
        await cache_format(LIVE_URL, {
            "is_live": True,
            "stream_url": "https://usher.example/alive.m3u8?token=fresh",
        })

        cached = await get_cached_format(LIVE_URL)
        assert cached is not None
        assert cached["stream_url"].endswith("alive.m3u8?token=fresh")


class TestFormatCacheSchemaVersion:
    """A deploy that adds a field must not stay invisible for two hours.

    Chapters shipped, and the room's video kept resolving from a cache entry
    written before the deploy — no `chapters` field, no Chapters tab — until
    the entry's TTL ran out.
    """

    async def test_entries_from_another_schema_are_misses(self, isolated_data_dir):
        from services.database import (
            init_database, get_cached_format, get_async_db, FORMAT_CACHE_SCHEMA_KEY,
        )
        from core.config import FORMAT_CACHE_SCHEMA_VERSION

        init_database()
        now = time.time()
        rows = {
            "https://example.com/unstamped": {"stream_url": "https://cdn/a"},
            "https://example.com/older": {
                "stream_url": "https://cdn/b", FORMAT_CACHE_SCHEMA_KEY: FORMAT_CACHE_SCHEMA_VERSION - 1,
            },
        }
        async with get_async_db() as db:
            for url, data in rows.items():
                await db.execute(
                    "INSERT INTO format_cache (original_url, video_data, expires_at, created_at) VALUES (?, ?, ?, ?)",
                    (url, json.dumps(data), now + 7000, now),
                )
            await db.commit()

        for url in rows:
            assert await get_cached_format(url) is None, f"{url} served from an older schema"

    async def test_fresh_entries_carry_the_stamp_and_hit(self, isolated_data_dir):
        from services.database import init_database, cache_format, get_cached_format, FORMAT_CACHE_SCHEMA_KEY
        from core.config import FORMAT_CACHE_SCHEMA_VERSION

        init_database()
        url = "https://example.com/stamped"
        await cache_format(url, {"stream_url": "https://cdn/c"})
        cached = await get_cached_format(url)
        assert cached is not None
        assert cached[FORMAT_CACHE_SCHEMA_KEY] == FORMAT_CACHE_SCHEMA_VERSION
        assert cached["stream_url"] == "https://cdn/c"
