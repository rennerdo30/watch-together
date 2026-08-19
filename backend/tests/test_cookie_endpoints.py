"""
Tests for cookie upload validation, rate limiting, and the extension
sync endpoint.

The xfail-marked test documents that /api/extension/sync has no rate
limiting; it becomes a passing test once the limiter is shared from
core/ and applied there.
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
    from api.routes import cookies as cookies_module
    cookies_module._rate_limit_store.clear()
    yield
    cookies_module._rate_limit_store.clear()


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

    @pytest.mark.xfail(
        reason="/api/extension/sync has no rate limiting; the limiter is "
        "module-private to api/routes/cookies.py",
        strict=False,
    )
    def test_sync_endpoint_is_rate_limited(self):
        """The extension sync route must enforce a per-user upload limit."""
        import inspect
        from api.routes import extension as extension_module

        source = inspect.getsource(extension_module)
        assert "rate_limit" in source, (
            "expected /api/extension/sync to call a shared rate limiter"
        )
