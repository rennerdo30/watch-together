"""
Cloudflare Access JWT verification tests.

These sign real RS256 tokens with a throwaway key pair and serve the
matching JWKS, so the verification path runs end to end rather than
against a mock. The forged-header test is the regression guard for the
original flaw: a plain identity header must never authenticate anyone
once Access is configured.
"""
import json
import time
import pytest
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization

TEAM_DOMAIN = "https://testteam.cloudflareaccess.com"
AUD = "test-audience-tag"
KEY_ID = "test-key-1"
USER = "verified@example.com"


@pytest.fixture(scope="module")
def keypair():
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return private_key, private_key.public_key()


@pytest.fixture(scope="module")
def jwks(keypair):
    """A JWKS document containing only the test public key."""
    _, public_key = keypair
    numbers = public_key.public_numbers()

    def b64(value: int) -> str:
        import base64
        length = (value.bit_length() + 7) // 8
        return base64.urlsafe_b64encode(value.to_bytes(length, "big")).rstrip(b"=").decode()

    return {
        "keys": [{
            "kid": KEY_ID,
            "kty": "RSA",
            "alg": "RS256",
            "use": "sig",
            "n": b64(numbers.n),
            "e": b64(numbers.e),
        }]
    }


def make_token(keypair, **overrides) -> str:
    private_key, _ = keypair
    now = int(time.time())
    claims = {
        "email": USER,
        "aud": AUD,
        "iss": TEAM_DOMAIN,
        "iat": now,
        "exp": now + 300,
        "sub": "user-id",
    }
    claims.update(overrides)
    pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return jwt.encode(claims, pem, algorithm="RS256", headers={"kid": KEY_ID})


@pytest.fixture
def access_configured(monkeypatch, jwks):
    """Configure Access verification and serve the test JWKS locally."""
    import core.config as config
    import core.access_jwt as access_jwt

    monkeypatch.setattr(config, "CF_ACCESS_TEAM_DOMAIN", TEAM_DOMAIN)
    monkeypatch.setattr(config, "CF_ACCESS_AUD", AUD)
    monkeypatch.setattr(access_jwt, "CF_ACCESS_TEAM_DOMAIN", TEAM_DOMAIN)
    monkeypatch.setattr(access_jwt, "CF_ACCESS_AUD", AUD)

    class FakeJWKClient:
        def __init__(self, *args, **kwargs):
            pass

        def get_signing_key_from_jwt(self, token):
            from jwt import PyJWK
            header = jwt.get_unverified_header(token)
            for key in jwks["keys"]:
                if key["kid"] == header.get("kid"):
                    return PyJWK.from_dict(key)
            raise jwt.PyJWTError(f"unknown key id {header.get('kid')}")

    monkeypatch.setattr(access_jwt, "PyJWKClient", FakeJWKClient)
    access_jwt.reset_jwks_cache()
    yield
    access_jwt.reset_jwks_cache()


class TestTokenVerification:
    def test_valid_token_returns_email(self, access_configured, keypair):
        from core.access_jwt import verify_access_token
        assert verify_access_token(make_token(keypair)) == USER

    def test_expired_token_rejected(self, access_configured, keypair):
        from core.access_jwt import verify_access_token, AccessVerificationError
        past = int(time.time()) - 60
        with pytest.raises(AccessVerificationError):
            verify_access_token(make_token(keypair, exp=past, iat=past - 60))

    def test_wrong_audience_rejected(self, access_configured, keypair):
        from core.access_jwt import verify_access_token, AccessVerificationError
        with pytest.raises(AccessVerificationError):
            verify_access_token(make_token(keypair, aud="someone-elses-app"))

    def test_wrong_issuer_rejected(self, access_configured, keypair):
        from core.access_jwt import verify_access_token, AccessVerificationError
        with pytest.raises(AccessVerificationError):
            verify_access_token(make_token(keypair, iss="https://evil.example.com"))

    def test_token_signed_by_unknown_key_rejected(self, access_configured):
        from core.access_jwt import verify_access_token, AccessVerificationError
        other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        pem = other_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        now = int(time.time())
        forged = jwt.encode(
            {"email": USER, "aud": AUD, "iss": TEAM_DOMAIN,
             "iat": now, "exp": now + 300},
            pem, algorithm="RS256", headers={"kid": "unknown-key"},
        )
        with pytest.raises(AccessVerificationError):
            verify_access_token(forged)

    def test_unsigned_token_rejected(self, access_configured):
        """The alg=none downgrade must not verify."""
        from core.access_jwt import verify_access_token, AccessVerificationError
        now = int(time.time())
        unsigned = jwt.encode(
            {"email": USER, "aud": AUD, "iss": TEAM_DOMAIN,
             "iat": now, "exp": now + 300},
            key="", algorithm="none", headers={"kid": KEY_ID},
        )
        with pytest.raises(AccessVerificationError):
            verify_access_token(unsigned)

    def test_token_without_email_claim_rejected(self, access_configured, keypair):
        from core.access_jwt import verify_access_token, AccessVerificationError
        with pytest.raises(AccessVerificationError):
            verify_access_token(make_token(keypair, email=None))

    def test_garbage_token_rejected(self, access_configured):
        from core.access_jwt import verify_access_token, AccessVerificationError
        with pytest.raises(AccessVerificationError):
            verify_access_token("not.a.jwt")

    def test_empty_token_rejected(self, access_configured):
        from core.access_jwt import verify_access_token, AccessVerificationError
        with pytest.raises(AccessVerificationError):
            verify_access_token("")


class FakeRequest:
    def __init__(self, headers=None, query_params=None):
        self.headers = headers or {}
        self.query_params = query_params or {}


class TestIdentityResolution:
    def test_forged_email_header_is_rejected_when_configured(self, access_configured):
        """The original flaw: a plain header must not authenticate anyone."""
        from core.security import get_user_from_request
        request = FakeRequest(
            headers={"cf-access-authenticated-user-email": "attacker@example.com"}
        )
        assert get_user_from_request(request) is None

    def test_valid_assertion_authenticates(self, access_configured, keypair):
        from core.security import get_user_from_request
        request = FakeRequest(headers={"cf-access-jwt-assertion": make_token(keypair)})
        assert get_user_from_request(request) == USER

    def test_invalid_assertion_is_rejected(self, access_configured, keypair):
        from core.security import get_user_from_request
        request = FakeRequest(headers={"cf-access-jwt-assertion": "tampered"})
        assert get_user_from_request(request) is None

    def test_assertion_wins_over_header(self, access_configured, keypair):
        """A forged header alongside a valid assertion cannot change identity."""
        from core.security import get_user_from_request
        request = FakeRequest(headers={
            "cf-access-jwt-assertion": make_token(keypair),
            "cf-access-authenticated-user-email": "attacker@example.com",
        })
        assert get_user_from_request(request) == USER

    def test_query_param_ignored_in_production_mode(self, access_configured, monkeypatch):
        import core.security as security
        monkeypatch.setattr(security, "DEVELOPMENT_MODE", False)
        request = FakeRequest(query_params={"user": "attacker@example.com"})
        assert security.get_user_from_request(request) is None

    def test_header_still_used_when_access_unconfigured(self, monkeypatch):
        """Deployments without Access keep working as before."""
        import core.access_jwt as access_jwt
        import core.security as security
        monkeypatch.setattr(access_jwt, "CF_ACCESS_TEAM_DOMAIN", "")
        monkeypatch.setattr(access_jwt, "CF_ACCESS_AUD", "")
        request = FakeRequest(
            headers={"cf-access-authenticated-user-email": "legacy@example.com"}
        )
        assert security.get_user_from_request(request) == "legacy@example.com"


class TestConfiguration:
    def test_not_configured_without_env(self, monkeypatch):
        import core.access_jwt as access_jwt
        monkeypatch.setattr(access_jwt, "CF_ACCESS_TEAM_DOMAIN", "")
        monkeypatch.setattr(access_jwt, "CF_ACCESS_AUD", "")
        assert not access_jwt.is_configured()

    def test_configured_with_both_values(self, access_configured):
        from core.access_jwt import is_configured
        assert is_configured()

    def test_certs_url_built_from_team_domain(self, access_configured):
        from core.access_jwt import _certs_url
        assert _certs_url() == f"{TEAM_DOMAIN}/cdn-cgi/access/certs"

    def test_certs_url_tolerates_bare_domain(self, monkeypatch):
        import core.access_jwt as access_jwt
        monkeypatch.setattr(access_jwt, "CF_ACCESS_TEAM_DOMAIN", "team.cloudflareaccess.com")
        assert access_jwt._certs_url() == "https://team.cloudflareaccess.com/cdn-cgi/access/certs"
