"""
Tests for cookie upload validation, rate limiting, and the extension
sync endpoint.

Both upload paths share one limiter from core/, counted under separate
scopes: the extension route previously had no limit at all because the
limiter was private to the cookie routes.
"""
import pytest
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DEVELOPMENT_MODE", "true")

from fastapi.testclient import TestClient


VALID_COOKIE_LINE = "\t".join([
    ".youtube.com", "TRUE", "/", "TRUE", "1900000000", "SID", "abc123",
])
VALID_COOKIE_FILE = "# Netscape HTTP Cookie File\n" + VALID_COOKIE_LINE + "\n"


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


class TestCookieFormatValidation:
    def test_accepts_valid_netscape_file(self, client):
        response = client.post(
            "/api/cookies?user=fmt-ok@example.com",
            json={"content": VALID_COOKIE_FILE},
        )
        assert response.status_code == 200

    def test_rejects_malformed_line_after_the_fifth(self, client):
        """Validation must cover every data line, not just the first few."""
        content = (
            "# Netscape HTTP Cookie File\n"
            + (VALID_COOKIE_LINE + "\n") * 6
            + "this-line-has-too-few-fields\n"
        )
        response = client.post(
            "/api/cookies?user=fmt-late@example.com",
            json={"content": content},
        )
        assert response.status_code == 400

    def test_rejects_comment_only_file(self, client):
        response = client.post(
            "/api/cookies?user=fmt-comments@example.com",
            json={"content": "# Netscape HTTP Cookie File\n# nothing else\n"},
        )
        assert response.status_code == 400

    def test_rejects_oversized_upload(self, client):
        oversized = "# Netscape HTTP Cookie File\n" + ("x" * (1024 * 1024 + 10))
        response = client.post(
            "/api/cookies?user=fmt-big@example.com",
            json={"content": oversized},
        )
        assert response.status_code == 400


class TestCookieUploadRateLimit:
    def test_eleventh_upload_in_window_is_rejected(self, client):
        url = "/api/cookies?user=rate@example.com"
        for _ in range(10):
            assert client.post(url, json={"content": VALID_COOKIE_FILE}).status_code == 200
        assert client.post(url, json={"content": VALID_COOKIE_FILE}).status_code == 429

    def test_limit_is_per_user(self, client):
        for _ in range(10):
            client.post("/api/cookies?user=rate-a@example.com",
                        json={"content": VALID_COOKIE_FILE})
        response = client.post("/api/cookies?user=rate-b@example.com",
                               json={"content": VALID_COOKIE_FILE})
        assert response.status_code == 200


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

    def test_sync_endpoint_is_rate_limited(self):
        """The extension sync route enforces a per-user upload limit."""
        from core.rate_limit import check_rate_limit
        from api.routes.extension import RATE_LIMIT_SCOPE
        from core.config import RATE_LIMIT_MAX_REQUESTS
        from fastapi import HTTPException

        for _ in range(RATE_LIMIT_MAX_REQUESTS):
            check_rate_limit("ext@example.com", scope=RATE_LIMIT_SCOPE)

        with pytest.raises(HTTPException) as exc_info:
            check_rate_limit("ext@example.com", scope=RATE_LIMIT_SCOPE)
        assert exc_info.value.status_code == 429

    def test_sync_and_upload_limits_are_independent(self):
        """Exhausting one endpoint's budget must not block the other."""
        from core.rate_limit import check_rate_limit
        from api.routes.extension import RATE_LIMIT_SCOPE as SYNC_SCOPE
        from api.routes.cookies import RATE_LIMIT_SCOPE as UPLOAD_SCOPE
        from core.config import RATE_LIMIT_MAX_REQUESTS

        for _ in range(RATE_LIMIT_MAX_REQUESTS):
            check_rate_limit("both@example.com", scope=SYNC_SCOPE)

        # The upload budget is untouched.
        check_rate_limit("both@example.com", scope=UPLOAD_SCOPE)
