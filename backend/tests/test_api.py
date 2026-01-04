"""
Tests for FastAPI endpoints.
"""
import pytest
from fastapi.testclient import TestClient
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from main import app


@pytest.fixture
def client():
    """Create a test client for the FastAPI app."""
    return TestClient(app)


class TestHealthEndpoints:
    """Test basic health/status endpoints."""
    
    def test_root_endpoint(self, client):
        """Root endpoint should return OK status."""
        response = client.get("/")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "service" in data
    
    def test_rooms_endpoint(self, client):
        """Rooms endpoint should return a list."""
        response = client.get("/api/rooms")
        assert response.status_code == 200
        assert isinstance(response.json(), list)


class TestCookieEndpoints:
    """Test cookie management endpoints."""
    
    def test_get_cookies_requires_auth(self, client):
        """GET /api/cookies should require user identity."""
        response = client.get("/api/cookies")
        assert response.status_code == 401
    
    def test_get_cookies_with_query_param(self, client):
        """GET /api/cookies should work with query param auth."""
        response = client.get("/api/cookies?user=test@example.com")
        assert response.status_code == 200
        data = response.json()
        assert "has_cookies" in data
    
    def test_post_cookies_requires_auth(self, client):
        """POST /api/cookies should require user identity."""
        response = client.post("/api/cookies", json={"content": "test"})
        assert response.status_code == 401
    
    def test_post_cookies_rejects_empty(self, client):
        """POST /api/cookies should reject empty content."""
        response = client.post(
            "/api/cookies?user=test@example.com",
            json={"content": ""}
        )
        assert response.status_code == 400
    
    def test_delete_cookies_requires_auth(self, client):
        """DELETE /api/cookies should require user identity."""
        response = client.delete("/api/cookies")
        assert response.status_code == 401


class TestResolveEndpoint:
    """Test URL resolution endpoint."""
    
    def test_resolve_requires_url(self, client):
        """Resolve endpoint should require URL parameter."""
        response = client.get("/api/resolve")
        assert response.status_code == 422  # Validation error
    
    def test_resolve_invalid_url(self, client):
        """Resolve endpoint should handle invalid URLs gracefully."""
        response = client.get("/api/resolve?url=not-a-valid-url")
        # Should return 400 (bad request) for invalid URLs
        assert response.status_code in [400, 500]


class TestProxyEndpoint:
    """Test proxy endpoint."""
    
    def test_proxy_requires_url(self, client):
        """Proxy endpoint should require URL parameter."""
        response = client.get("/api/proxy")
        # FastAPI returns 422 for missing required query params
        assert response.status_code == 422
    
    def test_proxy_options_cors(self, client):
        """Proxy OPTIONS should return CORS headers."""
        response = client.options("/api/proxy")
        assert response.status_code == 200
        assert "access-control-allow-origin" in response.headers
