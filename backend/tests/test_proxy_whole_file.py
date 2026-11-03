"""
The proxy refuses whole-file grabs of large googlevideo renditions before
it touches the network: no DNS lookup, no upstream connection.
"""
import pytest
from fastapi.testclient import TestClient

from main import app

BIG = "https://rr1---sn-4g5ednrl.googlevideo.com/videoplayback?itag=399&clen=1142920584&expire=1"


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


def test_a_bare_get_for_a_whole_rendition_is_refused(client):
    response = client.get("/api/proxy", params={"url": BIG, "user": "viewer@example.com"})
    assert response.status_code == 403
    assert "byte ranges" in response.json()["detail"]


def test_the_refusal_happens_before_any_upstream_work(client, monkeypatch):
    import main as main_module
    import services.upstream as upstream
    touched = []

    def lookup(url):
        touched.append(url)
        raise AssertionError("the grab reached DNS validation, i.e. the network path")

    async def fetch(*args, **kwargs):
        touched.append(args)
        raise AssertionError("the grab reached the upstream fetch")

    monkeypatch.setattr(upstream, "pin_url", lookup)
    monkeypatch.setattr(main_module, "open_upstream_stream", fetch)
    client.get("/api/proxy", params={"url": BIG, "user": "viewer@example.com"})
    assert touched == [], "the grab reached the network path"


def test_the_refusal_names_who_and_which_stream(client, caplog):
    """The log line used to carry the first 80 characters of the URL: only the host."""
    with caplog.at_level("WARNING"):
        client.get("/api/proxy", params={"url": BIG, "user": "viewer@example.com"},
                   headers={"Referer": "https://w2g.example/room/abc123"})
    line = next(r.getMessage() for r in caplog.records if "Refused whole-file" in r.getMessage())
    assert "user=viewer@example.com" in line and "itag=399" in line and "room=abc123" in line


def test_a_refusal_may_not_be_stored_by_any_cache(client):
    """A stored refusal was replayed to a viewer's player on every reload."""
    response = client.get("/api/proxy", params={"url": BIG, "user": "viewer@example.com"})
    assert response.status_code == 403
    assert "no-store" in response.headers["cache-control"]
    assert response.headers["cdn-cache-control"] == "no-store"


def test_the_players_per_request_tag_is_ignored(client):
    """Players tag each proxied request (&rq=…, see jump-cache.ts); it changes nothing here."""
    tagged = client.get("/api/proxy", params={"url": BIG, "user": "viewer@example.com", "rq": "abc1"})
    plain = client.get("/api/proxy", params={"url": BIG, "user": "viewer@example.com"})
    assert tagged.status_code == plain.status_code == 403
    assert tagged.json() == plain.json()


def test_a_range_given_in_the_url_is_used_when_the_header_was_stripped(client, monkeypatch):
    """An extension stripped the Range header: every segment was refused as a whole-file grab."""
    import main as main_module
    import services.upstream as upstream
    sent = []

    async def fetch(_client, url, headers=None, *args, **kwargs):
        sent.append((url, dict(headers or {})))
        raise upstream.UnsafeUpstreamError("stop here")

    monkeypatch.setattr(main_module, "open_upstream_stream", fetch)
    monkeypatch.setattr(upstream, "pin_url", lambda url: (_ for _ in ()).throw(AssertionError("no DNS")))
    response = client.get("/api/proxy", params={"url": BIG, "user": "viewer@example.com", "br": "0-699"})
    assert response.status_code != 403, response.text
    assert sent, "the request never reached the upstream fetch"
    url, headers = sent[0]
    # googlevideo takes the range in its query; anything else in the header.
    assert "range=0-699" in url or headers.get("Range") == "bytes=0-699"


def test_a_malformed_url_range_is_rejected(client):
    response = client.get("/api/proxy", params={"url": BIG, "user": "viewer@example.com", "br": "0-1;evil"})
    assert response.status_code == 422
