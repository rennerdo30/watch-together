"""
Tests for the remaining hardening measures: shared rate limiting,
cookie file permissions, and the single-worker guard.
"""
import os
import stat
import pytest
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DEVELOPMENT_MODE", "true")

from fastapi import HTTPException
from fastapi.testclient import TestClient

from core import rate_limit
from core.config import RATE_LIMIT_MAX_REQUESTS, COOKIE_FILE_MODE
from core.security import get_user_cookie_path


VALID_COOKIE_FILE = "# Netscape HTTP Cookie File\n" + "\t".join([
    ".youtube.com", "TRUE", "/", "TRUE", "1900000000", "SID", "secret",
]) + "\n"


@pytest.fixture(autouse=True)
def clean_limiter():
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture
def client():
    from main import app
    return TestClient(app)


class TestSharedRateLimiter:
    def test_allows_up_to_the_limit(self):
        for _ in range(RATE_LIMIT_MAX_REQUESTS):
            rate_limit.check_rate_limit("user@example.com", scope="test")

    def test_rejects_beyond_the_limit(self):
        for _ in range(RATE_LIMIT_MAX_REQUESTS):
            rate_limit.check_rate_limit("user@example.com", scope="test")
        with pytest.raises(HTTPException) as exc_info:
            rate_limit.check_rate_limit("user@example.com", scope="test")
        assert exc_info.value.status_code == 429

    def test_scopes_are_independent(self):
        for _ in range(RATE_LIMIT_MAX_REQUESTS):
            rate_limit.check_rate_limit("user@example.com", scope="first")
        rate_limit.check_rate_limit("user@example.com", scope="second")

    def test_users_are_independent(self):
        for _ in range(RATE_LIMIT_MAX_REQUESTS):
            rate_limit.check_rate_limit("a@example.com", scope="test")
        rate_limit.check_rate_limit("b@example.com", scope="test")

    def test_window_resets_after_expiry(self):
        for _ in range(RATE_LIMIT_MAX_REQUESTS):
            rate_limit.check_rate_limit("user@example.com", scope="test", window_seconds=0.0)
        # A zero-length window is always expired, so the budget is fresh.
        rate_limit.check_rate_limit("user@example.com", scope="test", window_seconds=0.0)

    def test_anonymous_callers_are_not_counted(self):
        for _ in range(RATE_LIMIT_MAX_REQUESTS * 2):
            rate_limit.check_rate_limit("", scope="test")


class TestCookieFilePermissions:
    def test_uploaded_cookies_are_owner_only(self, client):
        email = "perm@example.com"
        response = client.post(f"/api/cookies?user={email}",
                               json={"content": VALID_COOKIE_FILE})
        assert response.status_code == 200

        path = get_user_cookie_path(email)
        assert os.path.exists(path)
        mode = stat.S_IMODE(os.stat(path).st_mode)
        assert mode == COOKIE_FILE_MODE
        # Explicitly: nothing for group or other.
        assert not mode & (stat.S_IRWXG | stat.S_IRWXO)


class TestSingleWorkerGuard:
    def test_accepts_a_single_worker(self, monkeypatch):
        from main import check_single_worker
        monkeypatch.setenv("WEB_CONCURRENCY", "1")
        check_single_worker()

    def test_accepts_no_setting(self, monkeypatch):
        from main import check_single_worker
        monkeypatch.delenv("WEB_CONCURRENCY", raising=False)
        monkeypatch.delenv("UVICORN_WORKERS", raising=False)
        check_single_worker()

    def test_rejects_multiple_workers(self, monkeypatch):
        from main import check_single_worker
        monkeypatch.setenv("WEB_CONCURRENCY", "4")
        with pytest.raises(RuntimeError, match="single worker"):
            check_single_worker()

    def test_rejects_multiple_uvicorn_workers(self, monkeypatch):
        from main import check_single_worker
        monkeypatch.delenv("WEB_CONCURRENCY", raising=False)
        monkeypatch.setenv("UVICORN_WORKERS", "2")
        with pytest.raises(RuntimeError):
            check_single_worker()

    def test_ignores_unparseable_values(self, monkeypatch):
        from main import check_single_worker
        monkeypatch.setenv("WEB_CONCURRENCY", "auto")
        check_single_worker()
