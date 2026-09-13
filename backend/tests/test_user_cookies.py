"""
Tests for the in-memory cookie store and per-user cookie isolation.

Two regressions are guarded here. One global cookie jar once meant every
user's segments were fetched with whoever's cookies happened to be on
disk, and a URL-only cache key meant content fetched with one user's
cookies could be served to another. Later, cookies were persisted in the
database and as files under `data/` — live session credentials at rest.
They now exist only in this process, only until the extension stops
refreshing them, and on disk only for the seconds an extraction runs.
"""
import asyncio
import os
import stat
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.config import COOKIE_MEMORY_TTL_SECONDS, COOKIE_STORE_MAX_USERS, GUEST_IDENTITY
from services import user_cookies
from services.user_cookies import (
    CookieFormatError, choose_cookie_source, cookie_file, get_cookie_header,
    has_cookies_for, is_shareable, parse_netscape, to_netscape,
)
from services.cache import get_segment_cache_key, get_segment_disk_key


def netscape(entries, header=True) -> str:
    """Netscape text. Entries: (domain, name, value) or (domain, name, value, expires, secure)."""
    lines = ["# Netscape HTTP Cookie File"] if header else []
    for entry in entries:
        domain, name, value = entry[:3]
        expires = entry[3] if len(entry) > 3 else int(time.time()) + 86400
        secure = entry[4] if len(entry) > 4 else False
        lines.append("\t".join([
            domain, "TRUE" if domain.startswith(".") else "FALSE", "/",
            "TRUE" if secure else "FALSE", str(expires), name, value,
        ]))
    return "\n".join(lines) + "\n"


def hold_cookies(user_email: str, entries, **kwargs):
    """Put cookies for a user into the store, as the extension's sync would."""
    return user_cookies.store(user_email, netscape(entries), **kwargs)


class TestNetscapeParsing:
    def test_parses_data_lines_and_skips_comments(self):
        cookies = parse_netscape(netscape([(".youtube.com", "SID", "abc")]))
        assert [(c.domain, c.name, c.value) for c in cookies] == [(".youtube.com", "SID", "abc")]

    def test_httponly_lines_are_cookies_not_comments(self):
        """Browsers export HttpOnly cookies behind a '#HttpOnly_' prefix.

        The old validator treated them as comments, so a file of only
        HttpOnly cookies passed validation with "no cookies" and the login
        cookies YouTube marks HttpOnly (SID, LOGIN_INFO) were never checked.
        """
        text = "# Netscape HTTP Cookie File\n#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1900000000\tLOGIN_INFO\tv\n"
        cookies = parse_netscape(text)
        assert len(cookies) == 1
        assert cookies[0].domain == ".youtube.com"
        assert cookies[0].has_nonstandard_attr("HttpOnly")
        assert "#HttpOnly_.youtube.com\t" in to_netscape(cookies)

    def test_every_line_is_validated(self):
        text = netscape([(".youtube.com", "SID", "abc")] * 6) + "this-line-has-too-few-fields\n"
        with pytest.raises(CookieFormatError):
            parse_netscape(text)

    def test_rejects_comment_only_and_oversized_files(self):
        with pytest.raises(CookieFormatError):
            parse_netscape("# Netscape HTTP Cookie File\n# nothing else\n")
        with pytest.raises(CookieFormatError):
            parse_netscape("# Netscape HTTP Cookie File\n" + "x" * (1024 * 1024 + 10))

    def test_round_trips_session_cookies(self):
        text = "# Netscape HTTP Cookie File\n.twitch.tv\tTRUE\t/\tTRUE\t0\tauth-token\tt\n"
        cookies = parse_netscape(text)
        assert cookies[0].expires is None
        assert ".twitch.tv\tTRUE\t/\tTRUE\t0\tauth-token\tt" in to_netscape(cookies)


class TestStore:
    def test_status_reports_presence_and_timing_never_values(self):
        assert user_cookies.status("nobody@example.com") == {"has_cookies": False}
        hold_cookies("alice@example.com", [(".youtube.com", "SID", "alice-secret")], browser="chrome")
        status = user_cookies.status("alice@example.com")
        assert status["has_cookies"] and status["cookie_count"] == 1 and status["browser"] == "chrome"
        assert status["expires_at"] == pytest.approx(status["synced_at"] + COOKIE_MEMORY_TTL_SECONDS)
        assert "alice-secret" not in repr(status)

    def test_cookies_expire_without_a_refresh(self, monkeypatch):
        entry = hold_cookies("alice@example.com", [(".youtube.com", "SID", "s")])
        assert get_cookie_header("alice@example.com", "https://www.youtube.com/") == "SID=s"

        monkeypatch.setattr(user_cookies.time, "time", lambda: entry.expires_at + 1)
        assert get_cookie_header("alice@example.com", "https://www.youtube.com/") is None
        assert not user_cookies.has_cookies("alice@example.com")
        assert user_cookies.holders() == []

    def test_a_refresh_extends_the_life(self, monkeypatch):
        first = hold_cookies("alice@example.com", [(".youtube.com", "SID", "s")])
        later = first.synced_at + COOKIE_MEMORY_TTL_SECONDS - 60
        monkeypatch.setattr(user_cookies.time, "time", lambda: later)
        second = hold_cookies("alice@example.com", [(".youtube.com", "SID", "s2")])
        assert second.expires_at > first.expires_at
        monkeypatch.setattr(user_cookies.time, "time", lambda: first.expires_at + 1)
        assert get_cookie_header("alice@example.com", "https://www.youtube.com/") == "SID=s2"

    def test_forget_drops_them_now(self):
        hold_cookies("alice@example.com", [(".youtube.com", "SID", "s")])
        assert user_cookies.forget("alice@example.com") is True
        assert user_cookies.forget("alice@example.com") is False
        assert get_cookie_header("alice@example.com", "https://www.youtube.com/") is None

    def test_guests_cannot_own_cookies(self):
        with pytest.raises(ValueError):
            hold_cookies(GUEST_IDENTITY, [(".youtube.com", "SID", "s")])
        with pytest.raises(ValueError):
            hold_cookies("", [(".youtube.com", "SID", "s")])

    def test_the_store_is_bounded(self):
        for i in range(COOKIE_STORE_MAX_USERS + 5):
            hold_cookies(f"u{i}@example.com", [(".youtube.com", "SID", "s")])
        assert len(user_cookies.holders()) == COOKIE_STORE_MAX_USERS
        # The oldest copies went first.
        assert not user_cookies.has_cookies("u0@example.com")
        assert user_cookies.has_cookies(f"u{COOKIE_STORE_MAX_USERS + 4}@example.com")


class TestCookieLookup:
    def test_returns_none_without_cookies(self):
        assert get_cookie_header("nobody@example.com", "https://youtube.com/x") is None

    def test_returns_none_for_anonymous_caller(self):
        assert get_cookie_header(None, "https://youtube.com/x") is None

    def test_returns_matching_cookies(self):
        hold_cookies("alice@example.com", [(".youtube.com", "SID", "alice-secret")])
        assert get_cookie_header("alice@example.com", "https://www.youtube.com/watch") == "SID=alice-secret"

    def test_ignores_cookies_for_other_domains(self):
        hold_cookies("alice@example.com", [(".youtube.com", "SID", "alice-secret")])
        assert get_cookie_header("alice@example.com", "https://evil.example.com/x") is None

    def test_users_get_their_own_cookies(self):
        hold_cookies("alice@example.com", [(".youtube.com", "SID", "alice-secret")])
        hold_cookies("bob@example.com", [(".youtube.com", "SID", "bob-secret")])
        assert get_cookie_header("alice@example.com", "https://youtube.com/x") == "SID=alice-secret"
        assert get_cookie_header("bob@example.com", "https://youtube.com/x") == "SID=bob-secret"

    def test_one_user_cookies_never_leak_to_another(self):
        hold_cookies("alice@example.com", [(".youtube.com", "SID", "alice-secret")])
        assert get_cookie_header("carol@example.com", "https://youtube.com/x") is None

    def test_expired_cookies_are_skipped(self):
        hold_cookies("dave@example.com", [(".youtube.com", "OLD", "stale", int(time.time()) - 3600)])
        assert get_cookie_header("dave@example.com", "https://youtube.com/x") is None

    def test_secure_cookies_not_sent_over_http(self):
        hold_cookies("erin@example.com", [(".youtube.com", "SID", "secret", int(time.time()) + 86400, True)])
        assert get_cookie_header("erin@example.com", "http://youtube.com/x") is None
        assert get_cookie_header("erin@example.com", "https://youtube.com/x") == "SID=secret"

    def test_a_short_link_counts_as_the_site_it_serves(self):
        hold_cookies("alice@example.com", [(".youtube.com", "SID", "s")])
        assert has_cookies_for("alice@example.com", "https://youtu.be/dQw4w9WgXcQ")
        assert not has_cookies_for("alice@example.com", "https://vimeo.com/1")


class TestLending:
    """Whose cookies a resolve for a room runs with."""

    REQUESTER = "req@example.com"
    LENDER = "lender@example.com"
    WATCH = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

    @pytest.mark.parametrize("url", [
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://youtu.be/dQw4w9WgXcQ",
        "https://www.youtube.com/shorts/abc123defgh",
        "https://www.youtube.com/live/abc123defgh",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=WL&index=3",
        "https://www.twitch.tv/videos/123456",
        "https://www.twitch.tv/somechannel",
        "https://clips.twitch.tv/SomeClip",
        "https://kick.com/somechannel",
        "https://kick.com/somechannel/clips/clip_01ABC",
    ])
    def test_single_video_pages_of_allowlisted_sites_are_shareable(self, url):
        assert is_shareable(url)

    @pytest.mark.parametrize("url", [
        # A lender's own account, page by page.
        "https://www.youtube.com/feed/history",
        "https://www.youtube.com/feed/subscriptions",
        "https://www.youtube.com/playlist?list=WL",
        "https://www.youtube.com/playlist?list=PLabc",
        "https://www.youtube.com/@somechannel/videos",
        "https://www.youtube.com/results?search_query=x",
        # Sites outside the allowlist, however popular.
        "https://vimeo.com/123456",
        "https://www.dailymotion.com/video/x8abc",
        "https://www.crunchyroll.com/watch/ABC/ep",
        "https://example.com/video.mp4",
    ])
    def test_everything_else_is_not(self, url):
        assert not is_shareable(url)

    def test_requesters_own_cookies_come_first(self):
        hold_cookies(self.REQUESTER, [(".youtube.com", "SID", "r")])
        hold_cookies(self.LENDER, [(".youtube.com", "SID", "l")])
        assert choose_cookie_source(self.WATCH, self.REQUESTER, [self.LENDER]) == self.REQUESTER

    def test_a_member_lends_when_the_requester_has_none(self):
        hold_cookies(self.LENDER, [(".youtube.com", "SID", "l")])
        assert choose_cookie_source(self.WATCH, self.REQUESTER, [self.LENDER]) == self.LENDER
        assert choose_cookie_source(self.WATCH, None, [self.LENDER]) == self.LENDER

    def test_members_are_tried_in_order_and_only_if_signed_in_to_the_site(self):
        hold_cookies("twitch-only@example.com", [(".twitch.tv", "auth-token", "t")])
        hold_cookies(self.LENDER, [(".youtube.com", "SID", "l")])
        members = ["twitch-only@example.com", GUEST_IDENTITY, "no-cookies@example.com", self.LENDER]
        assert choose_cookie_source(self.WATCH, self.REQUESTER, members) == self.LENDER
        assert choose_cookie_source("https://www.twitch.tv/videos/1", self.REQUESTER, members) == "twitch-only@example.com"

    def test_nobody_lends_for_a_feed_or_a_site_outside_the_allowlist(self):
        hold_cookies(self.LENDER, [(".youtube.com", "SID", "l"), (".vimeo.com", "vuid", "v")])
        assert choose_cookie_source("https://www.youtube.com/feed/history", self.REQUESTER, [self.LENDER]) is None
        assert choose_cookie_source("https://www.youtube.com/playlist?list=WL", self.REQUESTER, [self.LENDER]) is None
        assert choose_cookie_source("https://vimeo.com/1", self.REQUESTER, [self.LENDER]) is None
        # The lender's own request to those pages is their business.
        assert choose_cookie_source("https://vimeo.com/1", self.LENDER, []) == self.LENDER
        assert choose_cookie_source("https://www.youtube.com/feed/history", self.LENDER, []) == self.LENDER

    def test_requester_without_cookies_for_the_site_is_not_a_source(self):
        """A jar that does not cover the site adds nothing; the stream would be bound to it for no reason."""
        hold_cookies(self.REQUESTER, [(".twitch.tv", "auth-token", "t")])
        assert choose_cookie_source(self.WATCH, self.REQUESTER, []) is None

    def test_a_guest_never_lends_or_borrows_as_owner(self):
        hold_cookies(self.LENDER, [(".youtube.com", "SID", "l")])
        assert choose_cookie_source(self.WATCH, GUEST_IDENTITY, [self.LENDER]) == self.LENDER
        assert choose_cookie_source(self.WATCH, self.REQUESTER, [GUEST_IDENTITY]) is None


class TestScratchFile:
    """yt-dlp gets a file that lives exactly as long as one extraction."""

    def test_none_for_a_member_without_cookies(self):
        async def run():
            async with cookie_file("nobody@example.com") as path:
                return path
        assert asyncio.run(run()) is None
        assert asyncio.run(run()) is None

    def test_written_privately_and_removed_afterwards(self):
        hold_cookies("alice@example.com", [(".youtube.com", "SID", "alice-secret")])

        async def run():
            async with cookie_file("alice@example.com") as path:
                with open(path, encoding="utf-8") as handle:
                    content = handle.read()
                mode = stat.S_IMODE(os.stat(path).st_mode)
                return path, content, mode

        path, content, mode = asyncio.run(run())
        assert "alice-secret" in content
        assert not os.path.exists(path)
        assert not os.path.exists(os.path.dirname(path))
        if os.name != "nt":
            assert not mode & (stat.S_IRWXG | stat.S_IRWXO)

    def test_removed_even_when_the_extraction_fails(self):
        hold_cookies("alice@example.com", [(".youtube.com", "SID", "s")])
        seen = {}

        async def run():
            async with cookie_file("alice@example.com") as path:
                seen["path"] = path
                raise RuntimeError("extractor blew up")

        with pytest.raises(RuntimeError):
            asyncio.run(run())
        assert not os.path.exists(seen["path"])

    def test_never_under_the_data_directory(self):
        from core.config import COOKIE_SCRATCH_DIR
        hold_cookies("alice@example.com", [(".youtube.com", "SID", "s")])

        async def run():
            async with cookie_file("alice@example.com") as path:
                return os.path.abspath(path)

        path = asyncio.run(run())
        assert not path.startswith(os.path.abspath("data"))
        if COOKIE_SCRATCH_DIR:
            assert path.startswith(os.path.abspath(COOKIE_SCRATCH_DIR))


class TestCacheKeyIsolation:
    def test_anonymous_keys_are_shared(self):
        assert get_segment_cache_key("https://cdn/x.ts", 0) == \
            get_segment_cache_key("https://cdn/x.ts", 0)

    def test_authenticated_key_differs_from_anonymous(self):
        anonymous = get_segment_cache_key("https://cdn/x.ts", 0)
        authenticated = get_segment_cache_key("https://cdn/x.ts", 0, identity="alice@example.com")
        assert anonymous != authenticated

    def test_two_users_do_not_share_a_segment_entry(self):
        alice = get_segment_cache_key("https://cdn/x.ts", 0, identity="alice@example.com")
        bob = get_segment_cache_key("https://cdn/x.ts", 0, identity="bob@example.com")
        assert alice != bob

    def test_two_users_do_not_share_a_disk_entry(self):
        alice, alice_path = get_segment_disk_key(
            "https://cdn/x.ts", 0, 99, identity="alice@example.com")
        bob, bob_path = get_segment_disk_key(
            "https://cdn/x.ts", 0, 99, identity="bob@example.com")
        assert alice != bob
        assert alice_path != bob_path

    def test_disk_entries_are_keyed_on_the_exact_range(self):
        """A body cached for one range must not answer another."""
        narrow, _ = get_segment_disk_key("https://cdn/x.ts", 0, 9)
        wide, _ = get_segment_disk_key("https://cdn/x.ts", 0, 999)
        assert narrow != wide

    def test_range_still_separates_entries(self):
        first = get_segment_cache_key("https://cdn/x.ts", 0, identity="alice@example.com")
        second = get_segment_cache_key("https://cdn/x.ts", 1024, identity="alice@example.com")
        assert first != second

    def test_identity_is_hashed_not_embedded(self):
        """Cache keys become file names; an email must not appear in them."""
        key = get_segment_cache_key("https://cdn/x.ts", 0, identity="alice@example.com")
        assert "alice@example.com" not in key
