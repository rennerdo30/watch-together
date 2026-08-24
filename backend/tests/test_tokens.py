"""Identity and token ownership contracts used by the browser extension.

The extension used to fetch `/api/me` and `/api/token` separately, cache the
email beside the token, and later display the cached email as though it proved
who the token belonged to. A browser-session switch between those requests —
or stale synchronized extension storage — could therefore show one user while
cookie sync authenticated as another.

The token response now carries its owner in the same authenticated operation,
and `/api/extension/status` is the authoritative display identity.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DEVELOPMENT_MODE", "true")

import pytest
from fastapi.testclient import TestClient

from services.database import validate_token


@pytest.fixture
def client():
    from main import app
    return TestClient(app)


def assert_private_no_store(response) -> None:
    assert response.headers["cache-control"] == "private, no-store"


class TestCurrentIdentity:
    def test_anonymous_request_reports_no_identity(self, client):
        response = client.get("/api/me")
        assert response.status_code == 200
        assert response.json() == {"authenticated": False, "email": None}
        assert_private_no_store(response)

    def test_authenticated_request_reports_exact_identity(self, client):
        response = client.get("/api/me?user=identity-a@example.com")
        assert response.status_code == 200
        assert response.json() == {
            "authenticated": True,
            "email": "identity-a@example.com",
        }
        assert_private_no_store(response)


class TestTokenOwnership:
    def test_anonymous_request_is_rejected_without_being_cacheable(self, client):
        response = client.get("/api/token")
        assert response.status_code == 401
        assert_private_no_store(response)

    async def test_token_and_owner_come_from_one_response(self, client):
        response = client.get("/api/token?user=token-a@example.com")
        assert response.status_code == 200
        body = response.json()

        assert body["user_email"] == "token-a@example.com"
        assert await validate_token(body["token"]["id"]) == "token-a@example.com"
        assert_private_no_store(response)

    def test_one_user_reuses_only_their_own_active_token(self, client):
        first = client.get("/api/token?user=token-repeat@example.com").json()
        second = client.get("/api/token?user=token-repeat@example.com").json()
        other = client.get("/api/token?user=token-other@example.com").json()

        assert first["token"]["id"] == second["token"]["id"]
        assert other["token"]["id"] != first["token"]["id"]
        assert other["user_email"] == "token-other@example.com"

    async def test_regeneration_revokes_the_previous_token(self, client):
        original = client.get("/api/token?user=token-regen@example.com").json()
        response = client.post("/api/token/regenerate?user=token-regen@example.com")
        replacement = response.json()

        assert response.status_code == 200
        assert replacement["user_email"] == "token-regen@example.com"
        assert replacement["token"]["id"] != original["token"]["id"]
        assert await validate_token(original["token"]["id"]) is None
        assert await validate_token(replacement["token"]["id"]) == \
            "token-regen@example.com"
        assert_private_no_store(response)


class TestExtensionTokenStatus:
    async def test_status_reports_the_bearer_owner_not_another_user(self, client):
        alice = client.get("/api/token?user=status-alice@example.com").json()
        client.get("/api/token?user=status-bob@example.com")

        response = client.get(
            "/api/extension/status",
            headers={"Authorization": f"Bearer {alice['token']['id']}"},
        )

        assert response.status_code == 200
        assert response.json()["user_email"] == "status-alice@example.com"
        assert_private_no_store(response)

    def test_invalid_status_is_not_cacheable(self, client):
        response = client.get(
            "/api/extension/status",
            headers={"Authorization": "Bearer definitely-invalid"},
        )
        assert response.status_code == 401
        assert_private_no_store(response)

    async def test_extension_can_revoke_exactly_its_own_token(self, client):
        owned = client.get("/api/token?user=revoke-owned@example.com").json()
        other = client.get("/api/token?user=revoke-other@example.com").json()

        response = client.delete(
            "/api/extension/token",
            headers={"Authorization": f"Bearer {owned['token']['id']}"},
        )

        assert response.status_code == 200
        assert response.json() == {"status": "ok", "revoked": True}
        assert await validate_token(owned["token"]["id"]) is None
        assert await validate_token(other["token"]["id"]) == "revoke-other@example.com"
        assert_private_no_store(response)
