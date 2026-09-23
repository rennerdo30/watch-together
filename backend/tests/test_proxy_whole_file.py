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
