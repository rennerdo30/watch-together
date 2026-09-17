"""
A real browser on the server, in the room's player.

Three things here are worth pinning, and none of them is "does neko work".

The first is that the room's one player has one source: a screen share and
the shared browser both want it, and there is exactly one browser container
for every room on the instance, so a second claimant must be refused rather
than served a picture that is not theirs.

The second is that a feature which *cannot* work says so. Its media is
WebRTC and the deployment publishes no ports, so unless an operator has
opened a UDP range or pointed it at a relay there is nothing to show — and
the failure of that is a room full of people staring at a black rectangle,
which is much worse than a button that explains itself.

The third is that nothing ever hands a browser a password. The session a
member's tab gets in with is minted here, against neko, over the internal
network; the passwords are configuration and stay configuration.

neko itself is stubbed at its HTTP boundary throughout. A container that
streams a desktop is not something a test suite should be starting, and
every assertion below is about this server's half of the conversation.
"""
import asyncio
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DEVELOPMENT_MODE", "true")

from connection_manager import ConnectionManager
from core import config
from services import shared_browser
from tests.test_connection_manager import FakeWebSocket


@pytest.fixture
def manager():
    return ConnectionManager()


@pytest.fixture
def configured(monkeypatch):
    """An instance an operator has finished setting up, over a TURN relay."""
    monkeypatch.setattr(config, "BROWSER_ENABLED", True)
    monkeypatch.setattr(config, "BROWSER_USER_PASSWORD", "user-secret")
    monkeypatch.setattr(config, "BROWSER_ADMIN_PASSWORD", "admin-secret")
    monkeypatch.setattr(config, "BROWSER_PUBLIC_IP", "")
    monkeypatch.setattr(config, "BROWSER_UDP_PORTS", "")
    monkeypatch.setattr(config, "WEBRTC_TURN_URL", "turn:relay.example.net:3478")


async def join(manager, room_id: str, email: str) -> FakeWebSocket:
    socket = FakeWebSocket()
    assert await manager.connect(socket, room_id, email)
    return socket


# --- can this instance do it at all -----------------------------------------


class TestAnInstanceThatCannotDoItSaysSo:
    def test_off_by_default(self, monkeypatch):
        """Nothing about the stack's defaults makes this work, so nothing
        about its defaults may offer it."""
        monkeypatch.setattr(config, "BROWSER_ENABLED", False)
        assert shared_browser.is_available() is False
        assert shared_browser.unavailable_reason() == config.BROWSER_UNAVAILABLE_DISABLED

    def test_enabled_but_with_no_way_out_for_the_media_is_not_available(self, monkeypatch):
        """The whole hazard of this feature: switched on, container running,
        and no path for a single video packet. The tunnel carries HTTP."""
        monkeypatch.setattr(config, "BROWSER_ENABLED", True)
        monkeypatch.setattr(config, "BROWSER_USER_PASSWORD", "user-secret")
        monkeypatch.setattr(config, "BROWSER_PUBLIC_IP", "")
        monkeypatch.setattr(config, "BROWSER_UDP_PORTS", "")
        monkeypatch.setattr(config, "WEBRTC_TURN_URL", "")

        assert shared_browser.media_transport() is None
        assert shared_browser.unavailable_reason() == config.BROWSER_UNAVAILABLE_NO_MEDIA_PATH
        assert shared_browser.is_available() is False

    def test_an_announced_address_with_no_open_ports_is_not_a_media_path(self, monkeypatch):
        """Half-configured UDP is worse than none: a candidate pointing at a
        closed port makes every viewer wait out a timeout first."""
        monkeypatch.setattr(config, "BROWSER_ENABLED", True)
        monkeypatch.setattr(config, "BROWSER_USER_PASSWORD", "user-secret")
        monkeypatch.setattr(config, "BROWSER_PUBLIC_IP", "203.0.113.10")
        monkeypatch.setattr(config, "BROWSER_UDP_PORTS", "")
        monkeypatch.setattr(config, "WEBRTC_TURN_URL", "")

        assert shared_browser.media_transport() is None

    def test_an_open_range_with_no_announced_address_is_not_one_either(self, monkeypatch):
        monkeypatch.setattr(config, "BROWSER_ENABLED", True)
        monkeypatch.setattr(config, "BROWSER_USER_PASSWORD", "user-secret")
        monkeypatch.setattr(config, "BROWSER_PUBLIC_IP", "")
        monkeypatch.setattr(config, "BROWSER_UDP_PORTS", "59000-59100")
        monkeypatch.setattr(config, "WEBRTC_TURN_URL", "")

        assert shared_browser.media_transport() is None

    def test_both_halves_of_the_udp_path_make_it_available(self, monkeypatch):
        monkeypatch.setattr(config, "BROWSER_ENABLED", True)
        monkeypatch.setattr(config, "BROWSER_USER_PASSWORD", "user-secret")
        monkeypatch.setattr(config, "BROWSER_PUBLIC_IP", "203.0.113.10")
        monkeypatch.setattr(config, "BROWSER_UDP_PORTS", "59000-59100")
        monkeypatch.setattr(config, "WEBRTC_TURN_URL", "")

        assert shared_browser.media_transport() == config.BROWSER_TRANSPORT_UDP
        assert shared_browser.is_available() is True

    def test_a_relay_alone_is_enough_and_opens_nothing(self, configured):
        assert shared_browser.media_transport() == config.BROWSER_TRANSPORT_TURN
        assert shared_browser.is_available() is True

    def test_no_password_is_its_own_answer(self, monkeypatch):
        """Distinguished from the media path on purpose: they are different
        mistakes with different fixes."""
        monkeypatch.setattr(config, "BROWSER_ENABLED", True)
        monkeypatch.setattr(config, "BROWSER_USER_PASSWORD", "")
        monkeypatch.setattr(config, "WEBRTC_TURN_URL", "turn:relay.example.net:3478")

        assert shared_browser.unavailable_reason() == config.BROWSER_UNAVAILABLE_NO_PASSWORD


# --- one player, one source, one container ----------------------------------


class TestOneThingOnThePlayer:
    async def test_a_room_that_opens_it_holds_it(self, manager):
        socket = await join(manager, "room", "first@example.com")
        session, refusal = manager.open_browser("room", socket, "Shared browser")

        assert refusal is None
        assert session["opened_by"] == "first@example.com"
        assert manager.browser_of("room") is session
        assert manager.browser_holder() == "room"

    async def test_a_second_room_is_told_which_room_has_it(self, manager):
        """There is one container for the instance, so this is not a
        per-room resource however much it looks like one."""
        here = await join(manager, "room", "first@example.com")
        elsewhere = await join(manager, "other-room", "second@example.com")
        manager.open_browser("room", here, "Shared browser")

        session, refusal = manager.open_browser("other-room", elsewhere, "Shared browser")

        assert session is None
        assert refusal == config.BROWSER_BUSY_OTHER_ROOM
        assert manager.browser_of("other-room") is None

    async def test_reopening_in_the_same_room_is_not_a_refusal(self, manager):
        """A member pressing it again, or a second member pressing it at
        all, must not read as an error — the room already has what they asked
        for."""
        first = await join(manager, "room", "first@example.com")
        second = await join(manager, "room", "second@example.com")
        opened, _ = manager.open_browser("room", first, "Shared browser")

        again, refusal = manager.open_browser("room", second, "Shared browser")

        assert refusal is None
        assert again == opened
        assert again["opened_by"] == "first@example.com"

    async def test_it_is_refused_while_someone_is_sharing_their_screen(self, manager):
        sharer = await join(manager, "room", "sharer@example.com")
        manager.start_share("room", sharer, "Gameplay", "smooth")

        session, refusal = manager.open_browser("room", sharer, "Shared browser")

        assert session is None
        assert refusal == config.BROWSER_BUSY_LIVE_SHARE

    async def test_a_screen_share_is_refused_while_it_is_open(self, manager):
        """The other direction, which is the one that would otherwise put
        two sources on one surface."""
        socket = await join(manager, "room", "someone@example.com")
        manager.open_browser("room", socket, "Shared browser")

        assert manager.start_share("room", socket, "Gameplay", "smooth") is None
        assert manager.share_of("room") is None


class TestClosingIt:
    async def test_whoever_opened_it_may_close_it(self, manager):
        socket = await join(manager, "room", "opener@example.com")
        manager.open_browser("room", socket, "Shared browser")

        assert manager.close_browser("room", socket)
        assert manager.browser_of("room") is None

    async def test_the_room_admin_may_close_it_and_a_bystander_may_not(self, manager):
        admin = await join(manager, "room", "admin@example.com")  # first in is admin
        opener = await join(manager, "room", "opener@example.com")
        bystander = await join(manager, "room", "nosy@example.com")
        manager.open_browser("room", opener, "Shared browser")

        assert manager.close_browser("room", bystander) is None
        assert manager.browser_of("room") is not None
        assert manager.close_browser("room", admin)
        assert manager.browser_of("room") is None

    async def test_the_opener_leaving_does_not_close_it(self, manager):
        """Unlike a screen share, whose media stops when its sharer goes.
        The browser is the room's, and the rest of the room is still on it."""
        opener = await join(manager, "room", "opener@example.com")
        await join(manager, "room", "watcher@example.com")
        manager.open_browser("room", opener, "Shared browser")

        await manager.disconnect(opener, "room")

        assert manager.browser_of("room") is not None

    async def test_the_last_member_leaving_releases_it(self, manager):
        """Nobody is watching, and every other room on the instance is
        waiting on this one."""
        only = await join(manager, "room", "only@example.com")
        manager.open_browser("room", only, "Shared browser")

        await manager.disconnect(only, "room")

        assert manager.browser_of("room") is None
        assert manager.browser_holder() is None

    async def test_closing_the_room_takes_it_too(self, manager):
        socket = await join(manager, "room", "admin@example.com")
        manager.open_browser("room", socket, "Shared browser")

        await manager.close_room("room")

        assert manager.browser_sessions == {}

    async def test_a_room_cleaned_up_as_stale_releases_it(self, manager):
        socket = await join(manager, "room", "gone@example.com")
        manager.open_browser("room", socket, "Shared browser")
        # Force the room empty without going through disconnect, so this
        # tests the janitor rather than the path above it.
        manager.active_connections.pop("room", None)
        manager.room_states["room"]["empty_since"] = time.time() - 10

        await manager.cleanup_stale_rooms(ttl_seconds=1)

        assert manager.browser_holder() is None


class TestItIsNotPartOfTheRoomsHistory:
    async def test_it_is_never_written_to_the_database(self, manager, monkeypatch):
        """It describes a container this process is talking to. A restart
        leaves nothing for a remembered session to point at."""
        saved = []
        import connection_manager as module
        monkeypatch.setattr(module, "save_room",
                            lambda room_id, state: saved.append(state) or asyncio.sleep(0))

        socket = await join(manager, "room", "opener@example.com")
        manager.open_browser("room", socket, "Shared browser")
        await manager._save_room_state("room")

        assert saved, "the room state was not saved at all"
        assert all("shared_browser" not in state for state in saved)
        assert all("browser_sessions" not in state for state in saved)

    async def test_someone_joining_mid_session_is_told_about_it(self, manager):
        opener = await join(manager, "room", "opener@example.com")
        manager.open_browser("room", opener, "Shared browser")

        latecomer = await join(manager, "room", "late@example.com")

        sync = [m for m in latecomer.sent if m["type"] == "sync"][0]["payload"]
        assert sync["shared_browser"]["opened_by"] == "opener@example.com"

    async def test_a_room_without_one_says_so(self, manager):
        socket = await join(manager, "room", "alone@example.com")
        sync = [m for m in socket.sent if m["type"] == "sync"][0]["payload"]
        assert sync["shared_browser"] is None


# --- minting a way in, without handing over a password ----------------------


class _FakeResponse:
    def __init__(self, status_code=200, cookies=None, body=None):
        self.status_code = status_code
        self.cookies = cookies or {}
        self._body = body

    def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body


class _FakeClient:
    """Stands in for neko at the HTTP boundary, recording what it was sent."""

    posted = []

    def __init__(self, *_args, **_kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def post(self, url, json=None):
        type(self).posted.append((url, json))
        return type(self).response

    async def get(self, url):
        return type(self).response


@pytest.fixture
def fake_neko(monkeypatch):
    # The health answer is cached for a few seconds in production, so it has
    # to be dropped between tests or one test's container decides the next
    # test's.
    monkeypatch.setattr(shared_browser, "_health", (0.0, False))
    _FakeClient.posted = []
    _FakeClient.response = _FakeResponse(
        cookies={config.BROWSER_SESSION_COOKIE_NAME: "session-token"})
    monkeypatch.setattr(shared_browser.httpx, "AsyncClient", _FakeClient)
    return _FakeClient


class TestTheWayIn:
    async def test_a_session_is_minted_against_neko_with_the_user_password(
            self, configured, fake_neko):
        token = await shared_browser.mint_session("member@example.com")

        assert token == "session-token"
        url, body = fake_neko.posted[-1]
        assert url.endswith("/neko/api/login")
        assert body == {"username": "member@example.com", "password": "user-secret"}

    async def test_the_admin_password_is_used_only_when_asked_for(
            self, configured, fake_neko):
        await shared_browser.mint_session("boss@example.com", as_admin=True)
        assert fake_neko.posted[-1][1]["password"] == "admin-secret"

    async def test_a_token_in_the_body_is_read_too(self, configured, fake_neko):
        """neko returns one or the other depending on its own cookie
        setting, and this feature must not silently depend on which."""
        fake_neko.response = _FakeResponse(cookies={}, body={"token": "from-body"})
        assert await shared_browser.mint_session("member@example.com") == "from-body"

    async def test_a_refusal_is_an_error_and_not_an_empty_session(
            self, configured, fake_neko):
        fake_neko.response = _FakeResponse(status_code=401)
        with pytest.raises(shared_browser.BrowserSessionError):
            await shared_browser.mint_session("member@example.com")

    async def test_a_login_with_no_password_configured_never_goes_out(
            self, monkeypatch, fake_neko):
        monkeypatch.setattr(config, "BROWSER_USER_PASSWORD", "")
        with pytest.raises(shared_browser.BrowserSessionError):
            await shared_browser.mint_session("member@example.com")
        assert fake_neko.posted == []


# --- the endpoints ----------------------------------------------------------

from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture
def client():
    from main import app
    with TestClient(app) as test_client:
        yield test_client


class TestTheStatusEndpoint:
    def test_an_unconfigured_instance_reports_why(self, client, monkeypatch):
        monkeypatch.setattr(config, "BROWSER_ENABLED", False)
        body = client.get("/api/browser").json()

        assert body["enabled"] is False
        assert body["available"] is False
        assert body["reason"] == config.BROWSER_UNAVAILABLE_DISABLED
        assert body["transport"] is None
        assert body["running"] is False

    def test_a_configured_instance_names_its_transport(
            self, client, configured, fake_neko):
        body = client.get("/api/browser").json()

        assert body["available"] is True
        assert body["reason"] is None
        assert body["transport"] == config.BROWSER_TRANSPORT_TURN
        assert body["path"].startswith(config.BROWSER_PATH_PREFIX)

    def test_a_container_that_is_not_up_is_not_the_same_as_not_configured(
            self, client, configured, fake_neko):
        """Two different fixes: one is an environment change, the other is a
        `--profile browser` that was left off."""
        fake_neko.response = _FakeResponse(status_code=502)
        body = client.get("/api/browser").json()

        assert body["available"] is True
        assert body["running"] is False

    def test_the_health_answer_is_reused_for_a_moment(
            self, client, configured, fake_neko):
        """Every room asks on load, and the slowest answer is the one an
        enabled-but-absent container gives: a full connect timeout, each
        time. One probe has to serve the burst."""
        probes = []

        async def counting_get(_self, url):
            probes.append(url)
            return _FakeResponse(status_code=200)

        monkeypatch = pytest.MonkeyPatch()
        monkeypatch.setattr(_FakeClient, "get", counting_get)
        try:
            for _ in range(5):
                assert client.get("/api/browser").json()["running"] is True
        finally:
            monkeypatch.undo()

        assert len(probes) == 1, probes

    def test_no_password_is_ever_in_the_answer(self, client, configured, fake_neko):
        raw = client.get("/api/browser").text
        assert "user-secret" not in raw
        assert "admin-secret" not in raw


class TestTheSessionEndpoint:
    def test_an_unconfigured_instance_refuses_rather_than_minting(
            self, client, monkeypatch, fake_neko):
        monkeypatch.setattr(config, "BROWSER_ENABLED", False)
        response = client.post("/api/browser/session?room=x&user=a@example.com")

        assert response.status_code == 503
        assert fake_neko.posted == []

    def test_a_room_with_nothing_open_is_not_a_way_to_get_a_neko_login(
            self, client, configured, fake_neko):
        """Otherwise anyone who can reach the API can have a session on the
        instance's browser without a room ever agreeing to it."""
        response = client.post("/api/browser/session?room=empty&user=a@example.com")

        assert response.status_code == 409
        assert fake_neko.posted == []

    def test_a_member_gets_a_cookie_and_never_a_password(
            self, client, configured, fake_neko):
        room = "browser-session"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as socket:
            _drain_until(socket, "sync")
            socket.send_json({"type": "browser_open", "payload": {}})
            _drain_until(socket, "browser_opened")

            response = client.post(
                f"/api/browser/session?room={room}&user=a@example.com")

        assert response.status_code == 200
        assert response.cookies.get(config.BROWSER_SESSION_COOKIE_NAME) == "session-token"
        set_cookie = response.headers["set-cookie"]
        assert f"Path={config.BROWSER_PATH_PREFIX}" in set_cookie
        assert "HttpOnly" in set_cookie
        assert "user-secret" not in response.text
        assert "admin-secret" not in response.text

    def test_the_rooms_admin_drives_and_a_later_member_watches(
            self, client, configured, fake_neko):
        room = "browser-control"
        with client.websocket_connect(f"/ws/{room}?user=admin@example.com") as admin, \
                client.websocket_connect(f"/ws/{room}?user=guest@example.com") as guest:
            _drain_until(admin, "sync")
            _drain_until(guest, "sync")
            admin.send_json({"type": "browser_open", "payload": {}})
            _drain_until(guest, "browser_opened")

            as_admin = client.post(
                f"/api/browser/session?room={room}&user=admin@example.com").json()
            as_guest = client.post(
                f"/api/browser/session?room={room}&user=guest@example.com").json()

        assert as_admin["control"] is True
        assert as_guest["control"] is False
        # The admin password was used exactly once, for the admin.
        passwords = [body["password"] for _url, body in fake_neko.posted]
        assert passwords.count("admin-secret") == 1


# --- the messages, over a real socket ---------------------------------------


def _drain_until(ws, msg_type, limit=12):
    for _ in range(limit):
        message = ws.receive_json()
        if message.get("type") == msg_type:
            return message.get("payload", {})
    raise AssertionError(f"no {msg_type!r} message within {limit} messages")


class TestTheBrowserMessages:
    def test_an_unconfigured_instance_refuses_the_message_too(self, client, monkeypatch):
        """The button is meant never to be pressable here, but the socket is
        reachable without the button."""
        monkeypatch.setattr(config, "BROWSER_ENABLED", False)
        room = "browser-off"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as socket:
            _drain_until(socket, "sync")
            socket.send_json({"type": "browser_open", "payload": {}})
            socket.send_json({"type": "ping", "payload": {"client_time": 1}})

            refusals = []
            for _ in range(12):
                message = socket.receive_json()
                if message["type"] == "error":
                    refusals.append(message["payload"]["message"])
                if message["type"] == "pong":
                    break

            assert refusals and "not available" in refusals[0]
            from connection_manager import manager
            assert manager.browser_of(room) is None

    def test_opening_is_announced_and_stops_what_was_playing(self, client, configured):
        room = "browser-start"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as opener, \
                client.websocket_connect(f"/ws/{room}?user=b@example.com") as watcher:
            _drain_until(opener, "sync")
            _drain_until(watcher, "sync")

            opener.send_json({"type": "browser_open", "payload": {"title": "Shared browser"}})

            announced = _drain_until(watcher, "browser_opened")
            assert announced["opened_by"] == "a@example.com"
            assert announced["room_id"] == room
            from connection_manager import manager
            # The queue keeps its place, so closing returns the room to it.
            assert manager.room_states[room]["is_playing"] is False

    def test_a_second_room_is_told_it_is_busy(self, client, configured):
        with client.websocket_connect("/ws/busy-a?user=a@example.com") as first, \
                client.websocket_connect("/ws/busy-b?user=b@example.com") as second:
            _drain_until(first, "sync")
            _drain_until(second, "sync")
            first.send_json({"type": "browser_open", "payload": {}})
            _drain_until(first, "browser_opened")

            second.send_json({"type": "browser_open", "payload": {}})
            second.send_json({"type": "ping", "payload": {"client_time": 1}})

            refusals = []
            for _ in range(12):
                message = second.receive_json()
                if message["type"] == "error":
                    refusals.append(message["payload"]["message"])
                if message["type"] == "pong":
                    break
            assert refusals and "Another room" in refusals[0]

    def test_closing_tells_the_room_and_leaves_the_queue_alone(self, client, configured):
        room = "browser-stop"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as opener, \
                client.websocket_connect(f"/ws/{room}?user=b@example.com") as watcher:
            _drain_until(opener, "sync")
            _drain_until(watcher, "sync")
            opener.send_json({"type": "browser_open", "payload": {}})
            _drain_until(watcher, "browser_opened")

            opener.send_json({"type": "browser_close", "payload": {}})

            ended = _drain_until(watcher, "browser_closed")
            assert ended["reason"] == "closed"
            from connection_manager import manager
            assert manager.browser_of(room) is None
            assert manager.room_states[room]["queue"] == []

    def test_a_title_from_a_browser_cannot_be_arbitrarily_long(self, client, configured):
        room = "browser-title"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as socket:
            _drain_until(socket, "sync")
            socket.send_json({"type": "browser_open",
                              "payload": {"title": "x" * 500}})

            announced = _drain_until(socket, "browser_opened")
            assert len(announced["title"]) == config.BROWSER_TITLE_MAX_LENGTH


# --- a relay that is only half configured -----------------------------------


class TestHalfConfiguredTurnDoesNotBreakEverything:
    """`WEBRTC_TURN_URL` alone used to take screen sharing down with it.

    A TURN entry with a blank username or credential does not merely fail to
    relay: `new RTCPeerConnection(...)` throws on it, so no peer connection is
    built at all — including the direct ones that never needed a relay. The
    shared browser makes that configuration much more likely, because its
    setup instructions are the first thing in this project that asks an
    operator to fill these values in.
    """

    def test_a_turn_url_without_credentials_is_dropped(self, client, monkeypatch):
        monkeypatch.setattr(config, "WEBRTC_TURN_URL", "turn:relay.example.net:3478")
        monkeypatch.setattr(config, "WEBRTC_TURN_USERNAME", "")
        monkeypatch.setattr(config, "WEBRTC_TURN_CREDENTIAL", "")

        servers = client.get("/api/webrtc/ice").json()["iceServers"]

        assert all("turn:" not in str(server.get("urls")) for server in servers)
        # STUN still comes back: dropping the relay must not drop the rest.
        assert servers, "the STUN servers went with it"

    def test_a_fully_configured_relay_is_offered(self, client, monkeypatch):
        monkeypatch.setattr(config, "WEBRTC_TURN_URL", "turn:relay.example.net:3478")
        monkeypatch.setattr(config, "WEBRTC_TURN_USERNAME", "user")
        monkeypatch.setattr(config, "WEBRTC_TURN_CREDENTIAL", "secret")

        servers = client.get("/api/webrtc/ice").json()["iceServers"]

        relay = [s for s in servers if "turn:" in str(s.get("urls"))]
        assert relay == [{
            "urls": "turn:relay.example.net:3478",
            "username": "user",
            "credential": "secret",
        }]

    def test_the_shared_browser_still_counts_it_as_a_media_path(self, monkeypatch):
        """Deliberately different from the two above: neko is given its ICE
        list through its own environment (`BROWSER_ICE_SERVERS`), so a relay
        the *browsers* must not be handed is still one neko can be aimed at."""
        monkeypatch.setattr(config, "BROWSER_ENABLED", True)
        monkeypatch.setattr(config, "BROWSER_USER_PASSWORD", "user-secret")
        monkeypatch.setattr(config, "BROWSER_PUBLIC_IP", "")
        monkeypatch.setattr(config, "BROWSER_UDP_PORTS", "")
        monkeypatch.setattr(config, "WEBRTC_TURN_URL", "turn:relay.example.net:3478")
        monkeypatch.setattr(config, "WEBRTC_TURN_USERNAME", "")
        monkeypatch.setattr(config, "WEBRTC_TURN_CREDENTIAL", "")

        assert shared_browser.media_transport() == config.BROWSER_TRANSPORT_TURN


class TestTheAdminPanelNamesWhatIsMissing:
    """An admin told "the browser is switched off" goes looking for a switch.

    There is none to find: this is deployment configuration, set in the
    host's `.env` and applied by a deploy. The panel's job is therefore to
    name the settings rather than to pretend it owns them — without that,
    the honest refusal in the room is a dead end.
    """

    def test_an_unconfigured_instance_lists_every_missing_setting(self, monkeypatch):
        monkeypatch.setattr(config, "BROWSER_ENABLED", False)
        monkeypatch.setattr(config, "BROWSER_USER_PASSWORD", "")
        monkeypatch.setattr(config, "BROWSER_ADMIN_PASSWORD", "")
        monkeypatch.setattr(config, "BROWSER_PUBLIC_IP", "")
        monkeypatch.setattr(config, "BROWSER_UDP_PORTS", "")
        monkeypatch.setattr(config, "WEBRTC_TURN_URL", "")

        missing = shared_browser.setup_checklist()

        joined = " ".join(missing)
        assert "BROWSER_ENABLED=true" in missing
        assert any(item.startswith("BROWSER_USER_PASSWORD") for item in missing)
        assert any(item.startswith("BROWSER_ADMIN_PASSWORD") for item in missing)
        # Either media route answers; naming one would send an operator down
        # a road their deployment may not allow.
        assert "BROWSER_UDP_PORTS" in joined and "TURN" in joined

    def test_a_working_instance_asks_for_nothing(self, monkeypatch):
        monkeypatch.setattr(config, "BROWSER_ENABLED", True)
        monkeypatch.setattr(config, "BROWSER_USER_PASSWORD", "u")
        monkeypatch.setattr(config, "BROWSER_ADMIN_PASSWORD", "a")
        monkeypatch.setattr(config, "BROWSER_PUBLIC_IP", "203.0.113.10")
        monkeypatch.setattr(config, "BROWSER_UDP_PORTS", "59000-59100")

        assert shared_browser.setup_checklist() == []
        assert shared_browser.is_available() is True

    def test_the_half_configured_case_asks_only_for_the_half_that_is_missing(self, monkeypatch):
        """Switched on with passwords but no way out is the trap this
        feature exists to be honest about."""
        monkeypatch.setattr(config, "BROWSER_ENABLED", True)
        monkeypatch.setattr(config, "BROWSER_USER_PASSWORD", "u")
        monkeypatch.setattr(config, "BROWSER_ADMIN_PASSWORD", "a")
        monkeypatch.setattr(config, "BROWSER_PUBLIC_IP", "")
        monkeypatch.setattr(config, "BROWSER_UDP_PORTS", "")
        monkeypatch.setattr(config, "WEBRTC_TURN_URL", "")

        missing = shared_browser.setup_checklist()

        assert len(missing) == 1
        assert "BROWSER_UDP_PORTS" in missing[0]

    def test_the_overview_carries_it_to_the_panel(self, client, monkeypatch):
        """The panel is where an admin looks, so the answer has to be there."""
        import core.config as config_module
        import api.routes.admin as admin

        monkeypatch.setattr(config_module, "ADMIN_EMAILS", {"admin@example.com"})
        monkeypatch.setattr(admin.config, "ADMIN_EMAILS", {"admin@example.com"})
        monkeypatch.setattr(config, "BROWSER_ENABLED", False)

        body = client.get("/api/admin/overview", params={"user": "admin@example.com"}).json()

        assert body["shared_browser"]["available"] is False
        assert body["shared_browser"]["reason"] == config.BROWSER_UNAVAILABLE_DISABLED
        assert "BROWSER_ENABLED=true" in body["shared_browser"]["missing"]
