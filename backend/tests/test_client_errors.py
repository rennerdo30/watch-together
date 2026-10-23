"""Client diagnostics: verified attribution, bounded storage and secret redaction."""
import pytest
from fastapi.testclient import TestClient
from main import app
from core import config


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(config, 'ADMIN_EMAILS', frozenset({'admin@example.com'}))
    with TestClient(app) as client:
        yield client


def test_client_errors_require_identity(client):
    assert client.post('/api/client-errors', json={'source': 'runtime', 'message': 'oops'}).status_code == 401


def test_admin_can_inspect_errors_after_viewer_leaves(client):
    response = client.post('/api/client-errors?user=viewer@example.com', json={
        'source': 'shaka', 'message': 'Request https://cdn.example/video?token=SECRET failed',
        'room': 'diagnostic-room', 'code': 1001, 'http_status': 403,
        'resource': 'https://cdn.example/video?signature=SECRET',
        'stack': 'at https://app.example/player.js?key=SECRET:1:2',
        'user_agent': 'Chrome test',
    })
    assert response.status_code == 202
    overview = client.get('/api/admin/overview?user=admin@example.com')
    assert overview.headers['cache-control'] == 'private, no-store'
    event = overview.json()['client_errors'][-1]
    assert event['member'] == 'viewer@example.com'
    assert event['room'] == 'diagnostic-room'
    assert event['code'] == 1001 and event['http_status'] == 403
    assert event['resource'] == 'https://cdn.example/video'
    assert 'SECRET' not in str(event)
    assert client.get('/api/admin/overview?user=viewer@example.com').status_code == 403


def test_duplicate_errors_are_counted_and_flood_is_limited(client):
    report = {'source': 'runtime', 'message': 'Repeated problem', 'room': 'repeat'}
    for _ in range(20):
        assert client.post('/api/client-errors?user=flood@example.com', json=report).status_code == 202
    assert client.post('/api/client-errors?user=flood@example.com', json=report).status_code == 429
    events = client.get('/api/admin/overview?user=admin@example.com').json()['client_errors']
    matching = [e for e in events if e['member'] == 'flood@example.com']
    assert len(matching) == 1 and matching[0]['count'] == 20


def test_client_cannot_spoof_identity_or_send_unbounded_fields(client):
    assert client.post('/api/client-errors?user=viewer@example.com', json={
        'source': 'runtime', 'message': 'bad', 'member': 'admin@example.com',
    }).status_code == 422
    assert client.post('/api/client-errors?user=viewer@example.com', json={
        'source': 'runtime', 'message': 'x' * 2001,
    }).status_code == 422


def test_history_capacity_and_log_redaction(caplog):
    from services.client_errors import ClientError, history
    for index in range(510):
        assert history.record(f'viewer-{index}', ClientError(source='runtime', message='boom'))
    assert len(history.snapshot()) == 500
    assert history.snapshot()[0]['member'] == 'viewer-10'
    history.record('redaction', ClientError(source='runtime', message='Authorization=SECRET Bearer SECRET',
                                          resource='https://user:SECRET@cdn.test/video?sig=SECRET#SECRET'))
    assert 'SECRET' not in caplog.text
    assert history.snapshot()[-1]['resource'] == 'https://cdn.test/video'


def test_rate_limit_recovers_and_duplicates_expire(monkeypatch):
    from services import client_errors
    clock = [1000.0]
    monkeypatch.setattr(client_errors.time, 'time', lambda: clock[0])
    report = client_errors.ClientError(source='shaka', message='failed', code=1001)
    for _ in range(20):
        assert client_errors.history.record('viewer', report)
    assert not client_errors.history.record('viewer', report)
    clock[0] += 61
    assert client_errors.history.record('viewer', report)
    assert len(client_errors.history.snapshot()) == 2
