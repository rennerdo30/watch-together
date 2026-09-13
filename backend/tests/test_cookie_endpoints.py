"""
Tests for the cookie endpoints: the extension sync that delivers cookies,
the status a member may see, and the guarantee that cookies never reach
storage.

The extension is the only route in. The web form that once accepted a
pasted cookie file is gone, and so is the copy in the database and on
disk: a synced cookie file lives in memory until it expires or the member
drops it, and a look at the database or the data directory finds nothing.
"""
import os
import sqlite3
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DEVELOPMENT_MODE", "true")

from services import user_cookies


VALID_COOKIE_LINE = "\t".join([
    ".youtube.com", "TRUE", "/", "TRUE", "1900000000", "SID", "abc123",
])
VALID_COOKIE_FILE = "# Netscape HTTP Cookie File\n" + VALID_COOKIE_LINE + "\n"
USER = "sync@example.com"


@pytest.fixture
def client():
    from main import app
    return TestClient(app)


@pytest.fixture(autouse=True)
def reset_rate_limiter():
    """Each test starts with an empty rate-limit window."""
    from core import rate_limit
    rate_limit.reset()
    yield
    rate_limit.reset()


def bearer(client, user=USER):
    token = client.get(f"/api/token?user={user}").json()["token"]["id"]
    return {"Authorization": f"Bearer {token}"}


def sync(client, headers, cookies=VALID_COOKIE_FILE, domains=("youtube.com",)):
    return client.post("/api/extension/sync", headers=headers,
                       json={"cookies": cookies, "domains": list(domains), "browser": "chrome"})


class TestExtensionSync:
    def test_requires_bearer_token(self, client):
        response = client.post(
            "/api/extension/sync",
            json={"cookies": VALID_COOKIE_FILE, "domains": ["youtube.com"]},
        )
        assert response.status_code == 401

    def test_rejects_invalid_token(self, client):
        response = client.post(
            "/api/extension/sync",
            json={"cookies": VALID_COOKIE_FILE, "domains": ["youtube.com"]},
            headers={"Authorization": "Bearer not-a-real-token"},
        )
        assert response.status_code == 401

    def test_status_requires_bearer_token(self, client):
        assert client.get("/api/extension/status").status_code == 401

    def test_synced_cookies_are_held_for_the_token_owner(self, client):
        response = sync(client, bearer(client))
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["cookie_count"] == 1 and body["expires_at"] > 0
        assert response.headers["cache-control"] == "private, no-store"
        assert user_cookies.get_cookie_header(USER, "https://www.youtube.com/") == "SID=abc123"
        assert user_cookies.get_cookie_header("someone-else@example.com", "https://www.youtube.com/") is None

    def test_status_reflects_the_sync(self, client):
        # A token, and its sync counter, persists per user; this one is fresh.
        headers = bearer(client, user="status-fresh@example.com")
        assert client.get("/api/extension/status", headers=headers).json()["has_cookies"] is False
        sync(client, headers)
        status = client.get("/api/extension/status", headers=headers).json()
        assert status["has_cookies"] is True
        assert status["sync_count"] == 1 and status["cookie_count"] == 1

    def test_rejects_malformed_line_after_the_fifth(self, client):
        """Validation must cover every data line, not just the first few."""
        content = (
            "# Netscape HTTP Cookie File\n"
            + (VALID_COOKIE_LINE + "\n") * 6
            + "this-line-has-too-few-fields\n"
        )
        assert sync(client, bearer(client), cookies=content).status_code == 400
        assert not user_cookies.has_cookies(USER)

    def test_rejects_comment_only_empty_and_oversized_files(self, client):
        headers = bearer(client)
        assert sync(client, headers, cookies="# Netscape HTTP Cookie File\n# nothing else\n").status_code == 400
        assert sync(client, headers, cookies="   ").status_code == 400
        oversized = "# Netscape HTTP Cookie File\n" + ("x" * (1024 * 1024 + 10))
        assert sync(client, headers, cookies=oversized).status_code == 400

    def test_a_rejected_sync_keeps_the_previous_copy(self, client):
        headers = bearer(client)
        sync(client, headers)
        sync(client, headers, cookies="garbage\n")
        assert user_cookies.get_cookie_header(USER, "https://www.youtube.com/") == "SID=abc123"

    def test_sync_endpoint_is_rate_limited(self):
        """The extension sync route enforces a per-user limit."""
        from core.rate_limit import check_rate_limit
        from api.routes.extension import RATE_LIMIT_SCOPE
        from core.config import RATE_LIMIT_MAX_REQUESTS
        from fastapi import HTTPException

        for _ in range(RATE_LIMIT_MAX_REQUESTS):
            check_rate_limit("ext@example.com", scope=RATE_LIMIT_SCOPE)

        with pytest.raises(HTTPException) as exc_info:
            check_rate_limit("ext@example.com", scope=RATE_LIMIT_SCOPE)
        assert exc_info.value.status_code == 429

    def test_disconnecting_the_extension_drops_its_cookies(self, client):
        headers = bearer(client)
        sync(client, headers)
        assert user_cookies.has_cookies(USER)
        assert client.delete("/api/extension/token", headers=headers).json()["revoked"] is True
        assert not user_cookies.has_cookies(USER)


class TestCookiesNeverReachStorage:
    def test_nothing_is_written_to_the_database_or_the_data_directory(self, client):
        from services import database

        sync(client, bearer(client))

        tables = {
            row[0] for row in sqlite3.connect(database.DB_FILE).execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        assert "user_cookies" not in tables
        assert not os.path.exists(os.path.join(database.DB_DIR, "cookies"))
        # And the value itself appears nowhere in the database file.
        assert b"abc123" not in open(database.DB_FILE, "rb").read()

    def test_persisted_cookies_from_an_earlier_version_are_removed_at_startup(self, tmp_path, monkeypatch):
        from services import database

        leftover = tmp_path / "cookies"
        leftover.mkdir()
        (leftover / "someone@example.com.txt").write_text(VALID_COOKIE_FILE)
        monkeypatch.setattr(database, "PERSISTED_COOKIE_DIRS", (str(leftover),))
        database._purge_persisted_cookies()
        assert not leftover.exists()

    def test_the_backend_has_no_code_path_that_persists_cookies(self):
        """A source assertion: neither the cookie table nor per-user files may return."""
        import pathlib
        root = pathlib.Path(__file__).resolve().parent.parent
        sources = [p for p in root.rglob("*.py") if "tests" not in p.parts and ".venv" not in p.parts]
        offenders = []
        for path in sources:
            text = path.read_text(encoding="utf-8")
            if "INSERT INTO user_cookies" in text or "data/cookies" in text or "get_user_cookie_path" in text:
                offenders.append(str(path.relative_to(root)))
        assert offenders == [], offenders


class TestCookieStatusEndpoints:
    def test_status_requires_identity(self, client):
        assert client.get("/api/cookies").status_code == 401
        assert client.delete("/api/cookies").status_code == 401

    def test_status_never_returns_cookie_values(self, client):
        sync(client, bearer(client))
        response = client.get(f"/api/cookies?user={USER}")
        assert response.status_code == 200
        body = response.json()
        assert body["has_cookies"] is True and body["cookie_count"] == 1
        assert "content" not in body
        assert "abc123" not in response.text
        assert response.headers["cache-control"] == "private, no-store"

    def test_pasting_cookies_into_the_web_ui_is_gone(self, client):
        response = client.post(f"/api/cookies?user={USER}", json={"content": VALID_COOKIE_FILE})
        assert response.status_code == 405
        assert not user_cookies.has_cookies(USER)

    def test_a_member_can_drop_their_cookies_early(self, client):
        sync(client, bearer(client))
        assert client.delete(f"/api/cookies?user={USER}").json()["forgotten"] is True
        assert client.get(f"/api/cookies?user={USER}").json()["has_cookies"] is False
        assert client.delete(f"/api/cookies?user={USER}").json()["forgotten"] is False
