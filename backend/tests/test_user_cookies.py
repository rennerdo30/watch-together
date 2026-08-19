"""
Tests for per-user cookie isolation in upstream fetches.

The regression these guard against: one global cookie jar meant every
user's segments were fetched with whoever's cookies happened to be on
disk, and a URL-only cache key meant content fetched with one user's
cookies could be served to another.
"""
import os
import time
import pytest
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.user_cookies import get_cookie_header, clear_cache, invalidate
from services.cache import get_segment_cache_key, get_bucket_cache_key
from core.security import get_user_cookie_path


def write_cookies(user_email: str, entries) -> str:
    """Write a Netscape cookie file for a user. Entries: (domain, name, value)."""
    path = get_user_cookie_path(user_email)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    far_future = int(time.time()) + 86400
    lines = ["# Netscape HTTP Cookie File"]
    for domain, name, value in entries:
        include_subdomains = "TRUE" if domain.startswith(".") else "FALSE"
        lines.append("\t".join([
            domain, include_subdomains, "/", "FALSE", str(far_future), name, value,
        ]))
    with open(path, "w") as handle:
        handle.write("\n".join(lines) + "\n")
    return path


@pytest.fixture(autouse=True)
def clean_cookie_state():
    clear_cache()
    created = []
    yield created
    for path in created:
        if os.path.exists(path):
            os.remove(path)
    clear_cache()


class TestCookieLookup:
    def test_returns_none_without_cookie_file(self):
        assert get_cookie_header("nobody@example.com", "https://youtube.com/x") is None

    def test_returns_none_for_anonymous_caller(self):
        assert get_cookie_header(None, "https://youtube.com/x") is None

    def test_returns_matching_cookies(self, clean_cookie_state):
        clean_cookie_state.append(
            write_cookies("alice@example.com", [(".youtube.com", "SID", "alice-secret")])
        )
        header = get_cookie_header("alice@example.com", "https://www.youtube.com/watch")
        assert header == "SID=alice-secret"

    def test_ignores_cookies_for_other_domains(self, clean_cookie_state):
        clean_cookie_state.append(
            write_cookies("alice@example.com", [(".youtube.com", "SID", "alice-secret")])
        )
        assert get_cookie_header("alice@example.com", "https://evil.example.com/x") is None

    def test_users_get_their_own_cookies(self, clean_cookie_state):
        clean_cookie_state.append(
            write_cookies("alice@example.com", [(".youtube.com", "SID", "alice-secret")])
        )
        clean_cookie_state.append(
            write_cookies("bob@example.com", [(".youtube.com", "SID", "bob-secret")])
        )

        alice = get_cookie_header("alice@example.com", "https://youtube.com/x")
        bob = get_cookie_header("bob@example.com", "https://youtube.com/x")

        assert alice == "SID=alice-secret"
        assert bob == "SID=bob-secret"
        assert alice != bob

    def test_one_user_cookies_never_leak_to_another(self, clean_cookie_state):
        """A user without cookies must not inherit someone else's."""
        clean_cookie_state.append(
            write_cookies("alice@example.com", [(".youtube.com", "SID", "alice-secret")])
        )
        assert get_cookie_header("carol@example.com", "https://youtube.com/x") is None

    def test_expired_cookies_are_skipped(self, clean_cookie_state):
        path = get_user_cookie_path("dave@example.com")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        past = int(time.time()) - 3600
        with open(path, "w") as handle:
            handle.write("# Netscape HTTP Cookie File\n")
            handle.write("\t".join([
                ".youtube.com", "TRUE", "/", "FALSE", str(past), "OLD", "stale",
            ]) + "\n")
        clean_cookie_state.append(path)

        assert get_cookie_header("dave@example.com", "https://youtube.com/x") is None

    def test_secure_cookies_not_sent_over_http(self, clean_cookie_state):
        path = get_user_cookie_path("erin@example.com")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        future = int(time.time()) + 86400
        with open(path, "w") as handle:
            handle.write("# Netscape HTTP Cookie File\n")
            handle.write("\t".join([
                ".youtube.com", "TRUE", "/", "TRUE", str(future), "SID", "secret",
            ]) + "\n")
        clean_cookie_state.append(path)

        assert get_cookie_header("erin@example.com", "http://youtube.com/x") is None
        assert get_cookie_header("erin@example.com", "https://youtube.com/x") == "SID=secret"

    def test_updated_file_is_picked_up(self, clean_cookie_state):
        path = write_cookies("frank@example.com", [(".youtube.com", "SID", "first")])
        clean_cookie_state.append(path)
        assert get_cookie_header("frank@example.com", "https://youtube.com/x") == "SID=first"

        write_cookies("frank@example.com", [(".youtube.com", "SID", "second")])
        invalidate("frank@example.com")
        assert get_cookie_header("frank@example.com", "https://youtube.com/x") == "SID=second"


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

    def test_two_users_do_not_share_a_bucket_entry(self):
        alice, alice_path = get_bucket_cache_key("https://cdn/x.ts", 0, identity="alice@example.com")
        bob, bob_path = get_bucket_cache_key("https://cdn/x.ts", 0, identity="bob@example.com")
        assert alice != bob
        assert alice_path != bob_path

    def test_range_still_separates_entries(self):
        first = get_segment_cache_key("https://cdn/x.ts", 0, identity="alice@example.com")
        second = get_segment_cache_key("https://cdn/x.ts", 1024, identity="alice@example.com")
        assert first != second

    def test_identity_is_hashed_not_embedded(self):
        """Cache keys become file names; an email must not appear in them."""
        key = get_segment_cache_key("https://cdn/x.ts", 0, identity="alice@example.com")
        assert "alice@example.com" not in key
