"""
The screen share's media path: this server carrying the picture.

The owner chose a relay over a direct connection between browsers, knowing
what it costs, because the deployment has no other way to move media: no
published ports, and a tunnel that carries HTTP and WebSocket only. That
decision puts four things on this file.

* **A viewer who joins late must still see something.** The opening bytes
  of the stream are its initialisation segment, and nothing after them
  decodes without them, so the relay keeps them and replays them — followed
  by a *cluster*, never the middle of one. This is the difference between a
  feature that works and one that works if you were already there.
* **One slow viewer must not become everybody's problem.** Each viewer has
  its own bounded queue; filling it costs that viewer a restart at the live
  edge and costs the sharer nothing.
* **A viewer that cannot keep up is told so.** Repeated restarts end in a
  close with a reason, not in a still frame nobody can explain.
* **Only the room's sharer may push media into the room's share.** The
  connection id is public inside the room — it is in the sync payload — so
  it is checked together with the verified identity, never alone.
"""
import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DEVELOPMENT_MODE", "true")

from core import config  # noqa: E402
from services.share_relay import RelayRefused, ShareRelay  # noqa: E402
from services.webm import CLUSTER_ID  # noqa: E402

# A stand-in for what MediaRecorder produces: an EBML header and track
# descriptions, then clusters. The cluster shape — unknown size, Timecode
# first — is what Chromium really writes for a live stream.
INIT = b"\x1a\x45\xdf\xa3" + b"\x9f" + b"tracks and segment info"


def cluster(payload: bytes) -> bytes:
    return CLUSTER_ID + b"\x01\xff\xff\xff\xff\xff\xff\xff" + b"\xe7\x81\x00" + payload


# The share's first chunk: the initialisation segment and the start of the
# first cluster, exactly as the recorder emits it.
FIRST = INIT + cluster(b"opening frames")
# The middle of a cluster: nowhere a viewer could be started.
MIDDLE = b"\x40\xc0\xa1" + b"more frames" * 4
# A later chunk that happens to begin a cluster.
NEXT_CLUSTER = cluster(b"a keyframe and what follows it")


class FakeShareSocket:
    """A media socket that records what was sent, and can refuse to drain."""

    def __init__(self):
        self.text: list[str] = []
        self.binary: list[bytes] = []
        self.closed: tuple[int, str] | None = None

    async def send_text(self, data: str) -> None:
        self.text.append(data)

    async def send_bytes(self, data: bytes) -> None:
        self.binary.append(data)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = (code, reason)


@pytest.fixture
def relay():
    return ShareRelay()


def queued(viewer) -> list:
    """Everything waiting for one viewer, as (kind, payload) pairs."""
    return list(viewer.queue)


async def drain(relay, viewer) -> None:
    """Run this viewer's pump until its queue is empty, then stop it."""
    pump = asyncio.create_task(relay.pump(viewer))
    for _ in range(50):
        await asyncio.sleep(0)
        if not viewer.queue:
            break
    pump.cancel()
    try:
        await pump
    except asyncio.CancelledError:
        pass


class TestTheHeaderIsKeptForWhoeverJoinsLater:
    async def test_a_viewer_joining_mid_share_starts_at_the_next_cluster(self, relay):
        """The whole reason the relay holds state. Without the
        initialisation segment a share works only for the people who were
        already watching; without waiting for a cluster it fails outright
        about one join in eight."""
        relay.open("room", "conn-1", "sharer@example.com")
        relay.set_format("room", "video/webm;codecs=vp8,opus")
        relay.publish("room", FIRST)
        relay.publish("room", MIDDLE)

        socket = FakeShareSocket()
        viewer = relay.add_viewer("room", socket, "late@example.com")
        relay.publish("room", MIDDLE)
        await drain(relay, viewer)
        assert socket.binary == [], "the middle of a cluster is not a place to start"

        relay.publish("room", NEXT_CLUSTER)
        await drain(relay, viewer)

        assert '"mime": "video/webm;codecs=vp8,opus"' in socket.text[0]
        assert socket.binary == [INIT, NEXT_CLUSTER]

        # From then on it is an ordinary viewer and gets everything.
        relay.publish("room", MIDDLE)
        await drain(relay, viewer)
        assert socket.binary == [INIT, NEXT_CLUSTER, MIDDLE]

    async def test_a_viewer_that_beats_the_first_chunk_starts_with_everyone_else(self, relay):
        relay.open("room", "conn-1", "sharer@example.com")
        socket = FakeShareSocket()
        viewer = relay.add_viewer("room", socket, "eager@example.com")
        await drain(relay, viewer)
        assert socket.binary == [] and socket.text == []

        relay.set_format("room", "video/webm;codecs=vp8")
        relay.publish("room", FIRST)
        await drain(relay, viewer)

        # The first chunk carries both: the bytes before the cluster are the
        # initialisation segment, the cluster is where decoding begins.
        assert socket.binary == [INIT, cluster(b"opening frames")]
        assert len(socket.text) == 1

    async def test_opening_bytes_larger_than_the_ceiling_are_refused(self, relay):
        """They are held for the life of the share, in a process that also
        holds the room state and the segment caches."""
        relay.open("room", "conn-1", "sharer@example.com")
        relay.set_format("room", "video/webm;codecs=vp8")

        with pytest.raises(RelayRefused) as refusal:
            relay.publish("room", b"x" * (config.SHARE_HEADER_MAX_BYTES + 1))

        assert refusal.value.code == config.SHARE_CLOSE_PROTOCOL
        assert relay.relay_of("room").init is None


class TestOneChunkReachesEveryViewer:
    async def test_every_viewer_gets_every_chunk(self, relay):
        relay.open("room", "conn-1", "sharer@example.com")
        relay.set_format("room", "video/webm;codecs=vp8")

        sockets = [FakeShareSocket() for _ in range(4)]
        viewers = [relay.add_viewer("room", s, f"v{i}@example.com")
                   for i, s in enumerate(sockets)]
        pumps = [asyncio.create_task(relay.pump(v)) for v in viewers]

        relay.publish("room", FIRST)
        for index in range(5):
            relay.publish("room", MIDDLE + bytes([index]))
        for _ in range(50):
            await asyncio.sleep(0)

        expected = [INIT, cluster(b"opening frames")] + [MIDDLE + bytes([i]) for i in range(5)]
        for socket in sockets:
            assert socket.binary == expected
        for pump in pumps:
            pump.cancel()

    async def test_a_viewer_that_never_drains_does_not_hold_up_the_others(self, relay):
        """Fan-out is a memory write. The sharer's socket is never waiting
        on a viewer's transport, which is the whole point of a queue and a
        task per viewer."""
        relay.open("room", "conn-1", "sharer@example.com")
        relay.set_format("room", "video/webm;codecs=vp8")

        stalled_socket, fine_socket = FakeShareSocket(), FakeShareSocket()
        stalled = relay.add_viewer("room", stalled_socket, "stalled@example.com")
        fine = relay.add_viewer("room", fine_socket, "fine@example.com")
        pump = asyncio.create_task(relay.pump(fine))

        relay.publish("room", FIRST)
        for index in range(4):
            relay.publish("room", MIDDLE + bytes([index]))
        for _ in range(50):
            await asyncio.sleep(0)

        assert fine_socket.binary == [INIT, cluster(b"opening frames")] + [
            MIDDLE + bytes([i]) for i in range(4)]
        assert stalled_socket.binary == [], "the stalled viewer never drained"
        assert len(queued(stalled)) == 7, "and its backlog is its own"
        pump.cancel()


class TestASlowViewerIsRestartedRatherThanStarved:
    # Three chunks fit inside the ceiling; the fourth cannot, and is the
    # one that overflows the queue. Sized from the configured ceiling so
    # that raising it does not quietly stop testing anything.
    FILLER = b"y" * (config.SHARE_VIEWER_QUEUE_MAX_BYTES // 4)
    OVERFLOW = b"z" * (config.SHARE_VIEWER_QUEUE_MAX_BYTES // 2)

    def _watching(self, relay):
        relay.open("room", "conn-1", "sharer@example.com")
        relay.set_format("room", "video/webm;codecs=vp8")
        socket = FakeShareSocket()
        viewer = relay.add_viewer("room", socket, "slow@example.com")
        relay.publish("room", FIRST)
        return socket, viewer

    def _overflow_once(self, relay):
        for _ in range(3):
            relay.publish("room", self.FILLER)
        relay.publish("room", self.OVERFLOW)

    async def test_the_backlog_is_dropped_whole_and_the_viewer_rejoins_cleanly(self, relay):
        """Not trimmed: skipping bytes inside a cluster makes the viewer's
        demuxer fail outright. It is restarted the way a newcomer is."""
        socket, viewer = self._watching(relay)
        queued_before = len(queued(viewer))
        assert queued_before > 0

        self._overflow_once(relay)

        assert queued(viewer) == [], "the backlog went, and nothing replaced it yet"
        assert viewer.dropped_chunks >= queued_before
        assert viewer.primed is False and viewer.resyncing is True

        # Nothing until the stream offers a place to start again.
        relay.publish("room", MIDDLE)
        assert queued(viewer) == []

        relay.publish("room", NEXT_CLUSTER)
        kinds = [kind for kind, _ in queued(viewer)]
        payloads = [payload for _, payload in queued(viewer)]
        assert kinds == ["text", "text", "binary", "binary"], kinds
        assert '"type": "resync"' in payloads[0], "its decoder has to be rebuilt first"
        assert payloads[2] == INIT
        assert payloads[3] == NEXT_CLUSTER

    async def test_a_viewer_that_keeps_falling_behind_is_closed_with_a_reason(self, relay):
        socket, viewer = self._watching(relay)

        for _ in range(config.SHARE_VIEWER_MAX_RESYNCS + 1):
            self._overflow_once(relay)
            relay.publish("room", NEXT_CLUSTER)

        await drain(relay, viewer)
        assert socket.closed == (config.SHARE_CLOSE_TOO_SLOW, config.SHARE_CONTROL_TOO_SLOW)
        # Told before it was cut off: a viewer that goes quiet without a
        # reason is indistinguishable from a bug in the player.
        assert any(config.SHARE_CONTROL_TOO_SLOW in line for line in socket.text)

    async def test_nothing_is_queued_for_a_viewer_being_closed(self, relay):
        socket, viewer = self._watching(relay)
        for _ in range(config.SHARE_VIEWER_MAX_RESYNCS + 1):
            self._overflow_once(relay)
            relay.publish("room", NEXT_CLUSTER)

        queued_before = len(queued(viewer))
        relay.publish("room", NEXT_CLUSTER)
        relay.publish("room", MIDDLE)

        assert len(queued(viewer)) == queued_before


class TestTheRelayHasCeilings:
    async def test_a_room_takes_only_so_many_viewers(self, relay):
        relay.open("room", "conn-1", "sharer@example.com")
        for index in range(config.SHARE_RELAY_MAX_VIEWERS):
            relay.add_viewer("room", FakeShareSocket(), f"v{index}@example.com")

        with pytest.raises(RelayRefused) as refusal:
            relay.add_viewer("room", FakeShareSocket(), "one-too-many@example.com")

        assert refusal.value.code == config.SHARE_CLOSE_TOO_MANY_VIEWERS

    async def test_the_worker_carries_only_so_many_shares(self, relay):
        for index in range(config.SHARE_RELAY_MAX_ROOMS):
            relay.open(f"room-{index}", f"conn-{index}", "sharer@example.com")

        with pytest.raises(RelayRefused) as refusal:
            relay.open("one-room-too-many", "conn-x", "sharer@example.com")

        assert refusal.value.code == config.SHARE_CLOSE_BUSY

    async def test_ending_a_share_frees_its_room_and_closes_its_viewers(self, relay):
        relay.open("room", "conn-1", "sharer@example.com")
        relay.set_format("room", "video/webm;codecs=vp8")
        socket = FakeShareSocket()
        viewer = relay.add_viewer("room", socket, "watcher@example.com")
        relay.publish("room", FIRST)

        relay.end("room")
        await drain(relay, viewer)

        assert relay.relay_of("room") is None
        assert socket.closed == (config.SHARE_CLOSE_ENDED, config.SHARE_CONTROL_ENDED)
        assert relay.viewer_count("room") == 0

    async def test_a_second_media_socket_for_one_share_is_refused(self, relay):
        relay.open("room", "conn-1", "sharer@example.com")
        relay.attach_publisher("room", "conn-1")

        with pytest.raises(RelayRefused) as refusal:
            relay.attach_publisher("room", "conn-1")

        assert refusal.value.code == config.SHARE_CLOSE_BUSY

    async def test_a_media_socket_for_somebody_elses_connection_is_refused(self, relay):
        relay.open("room", "conn-1", "sharer@example.com")

        with pytest.raises(RelayRefused) as refusal:
            relay.attach_publisher("room", "conn-2")

        assert refusal.value.code == config.SHARE_CLOSE_NO_SHARE


# --- the sockets themselves -------------------------------------------------

from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture
def client():
    from main import app
    with TestClient(app) as test_client:
        yield test_client


def _drain_until(ws, msg_type, limit=12):
    for _ in range(limit):
        message = ws.receive_json()
        if message.get("type") == msg_type:
            return message.get("payload", {})
    raise AssertionError(f"no {msg_type!r} message within {limit} messages")


def _settle(room_socket) -> None:
    """Wait for the server to have worked through what was sent.

    A ping is answered unconditionally, and everything sent before it —
    including on another connection, since one worker serves them all — has
    been handled by the time the pong comes back. Without this, a test that
    asserts something was *refused* has nothing to wait for, and a
    regression hangs it instead of failing it.
    """
    room_socket.send_json({"type": "ping", "payload": {"client_time": 1}})
    _drain_until(room_socket, "pong", limit=20)


def _start_share(room_socket, room: str) -> str:
    connection_id = _drain_until(room_socket, "sync")["your_connection_id"]
    room_socket.send_json({"type": "share_start", "payload": {"title": "Gameplay"}})
    _drain_until(room_socket, "share_started")
    return connection_id


class TestOnlyTheSharerMayPushMedia:
    def test_a_member_who_is_not_sharing_is_refused(self, client):
        room = "relay-auth"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as sharer, \
                client.websocket_connect(f"/ws/{room}?user=b@example.com") as other:
            connection_id = _start_share(sharer, room)
            _drain_until(other, "sync")

            # The other member knows the sharer's connection id — it is in
            # the announcement every member received — and that is exactly
            # why the identity is checked with it.
            media = client.websocket_connect(
                f"/ws/share/{room}?role=publisher&connection={connection_id}"
                f"&user=b@example.com")
            with media as socket:
                socket.send_bytes(FIRST)
                message = socket.receive()

            assert message["type"] == "websocket.close"
            assert message["code"] == config.SHARE_CLOSE_NOT_AUTHORIZED

    def test_media_for_a_room_with_no_share_is_refused(self, client):
        room = "relay-no-share"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as member:
            connection_id = _drain_until(member, "sync")["your_connection_id"]

            with client.websocket_connect(
                    f"/ws/share/{room}?role=publisher&connection={connection_id}"
                    f"&user=a@example.com") as socket:
                message = socket.receive()

            assert message["code"] == config.SHARE_CLOSE_NO_SHARE

    def test_a_viewer_who_is_not_in_the_room_is_refused(self, client):
        """A share is for the people in the room. Watching one without
        joining would be watching without appearing."""
        room = "relay-outsider"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as sharer:
            _start_share(sharer, room)

            with client.websocket_connect(
                    f"/ws/share/{room}?role=viewer&user=stranger@example.com") as socket:
                message = socket.receive()

            assert message["code"] == config.SHARE_CLOSE_NOT_AUTHORIZED


class TestAPublisherCannotOutliveItsShare:
    def test_a_stale_media_socket_cannot_feed_the_next_share(self, client):
        """The media socket outlives the room socket that authorised it.

        A member can start a share, drop their room connection — which ends
        their share and frees the slot — and keep the media socket open. If
        the relay were addressed by room rather than by share, the next
        member's share would be fed by the previous member's socket: a
        stranger's bytes, and an initialisation segment nobody can decode.
        """
        room = "relay-stale"
        from services.share_relay import relay as live_relay

        first = client.websocket_connect(f"/ws/{room}?user=a@example.com")
        first_socket = first.__enter__()
        connection_id = _start_share(first_socket, room)
        media = client.websocket_connect(
            f"/ws/share/{room}?role=publisher&connection={connection_id}"
            f"&user=a@example.com")
        publisher = media.__enter__()
        publisher.send_json({"type": "format", "mime": "video/webm;codecs=vp8"})
        publisher.send_bytes(FIRST)

        # The sharer's room connection goes. The share ends with it.
        first.__exit__(None, None, None)
        assert live_relay.relay_of(room) is None

        with client.websocket_connect(f"/ws/{room}?user=b@example.com") as second:
            _start_share(second, room)
            assert live_relay.relay_of(room) is not None

            # The stale socket speaks into the room it no longer owns.
            publisher.send_json({"type": "format", "mime": "video/evil"})
            publisher.send_bytes(FIRST)
            _settle(second)

            stale_relay = live_relay.relay_of(room)
            assert stale_relay is not None, "and it did not end the new share either"
            assert stale_relay.mime is None, "nothing it said was believed"
            assert stale_relay.init is None
            assert stale_relay.chunks_in == 0

            closing = publisher.receive()
            media.__exit__(None, None, None)
            assert closing["type"] == "websocket.close"
            assert closing["code"] == config.SHARE_CLOSE_NO_SHARE

    def test_an_oversized_control_message_is_refused(self, client):
        room = "relay-fat-control"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as sharer:
            connection_id = _start_share(sharer, room)

            with client.websocket_connect(
                    f"/ws/share/{room}?role=publisher&connection={connection_id}"
                    f"&user=a@example.com") as publisher:
                publisher.send_text("x" * (config.SHARE_CONTROL_MAX_BYTES + 1))
                message = publisher.receive()

            assert message["code"] == config.SHARE_CLOSE_PROTOCOL


class TestAViewerWhoLeavesStopsWatching:
    async def test_viewers_of_one_identity_are_dropped(self, relay):
        relay.open("room", "conn-1", "sharer@example.com")
        relay.set_format("room", "video/webm;codecs=vp8")
        leaving_socket, staying_socket = FakeShareSocket(), FakeShareSocket()
        leaving = relay.add_viewer("room", leaving_socket, "gone@example.com")
        staying = relay.add_viewer("room", staying_socket, "here@example.com")
        relay.publish("room", FIRST)

        assert relay.drop_viewers_of("room", "gone@example.com") == 1
        await drain(relay, leaving)
        await drain(relay, staying)

        assert leaving_socket.closed == (config.SHARE_CLOSE_NOT_AUTHORIZED,
                                         config.SHARE_CONTROL_ENDED)
        assert staying_socket.closed is None
        assert staying_socket.binary == [INIT, cluster(b"opening frames")]

    def test_leaving_the_room_closes_the_media_socket(self, client):
        """A share is for the people in the room, and the media socket is a
        connection of its own: leaving has to take it with it."""
        room = "relay-leaver"
        from services.share_relay import relay as live_relay

        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as sharer:
            connection_id = _start_share(sharer, room)
            watcher = client.websocket_connect(f"/ws/{room}?user=b@example.com")
            watcher_socket = watcher.__enter__()
            _drain_until(watcher_socket, "sync")

            with client.websocket_connect(
                    f"/ws/share/{room}?role=publisher&connection={connection_id}"
                    f"&user=a@example.com") as publisher, \
                    client.websocket_connect(
                        f"/ws/share/{room}?role=viewer&user=b@example.com") as viewer:
                publisher.send_json({"type": "format", "mime": "video/webm;codecs=vp8"})
                publisher.send_bytes(FIRST)
                assert viewer.receive_json()["type"] == "format"
                assert live_relay.viewer_count(room) == 1

                # b leaves the room, but not the media socket.
                watcher.__exit__(None, None, None)
                _settle(sharer)

                # Its socket is closed from the relay's side; the connection
                # itself is removed a round trip later, when its handler
                # notices, which is not what this is about.
                watching = live_relay.relay_of(room).viewers.values()
                assert all(v.closing for v in watching), \
                    "someone who has left the room is still being sent its share"

                # Behind whatever was already on its way out.
                closing = None
                for _ in range(6):
                    message = viewer.receive()
                    if message["type"] == "websocket.close":
                        closing = message
                        break
                assert closing is not None
                assert closing["code"] == config.SHARE_CLOSE_NOT_AUTHORIZED


class TestTheMediaGetsThere:
    def test_a_viewer_receives_the_format_the_header_and_the_live_chunks(self, client):
        room = "relay-flow"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as sharer, \
                client.websocket_connect(f"/ws/{room}?user=b@example.com") as watcher:
            connection_id = _start_share(sharer, room)
            _drain_until(watcher, "sync")

            with client.websocket_connect(
                    f"/ws/share/{room}?role=publisher&connection={connection_id}"
                    f"&user=a@example.com") as publisher, \
                    client.websocket_connect(
                        f"/ws/share/{room}?role=viewer&user=b@example.com") as viewer:
                publisher.send_json({"type": "format", "mime": "video/webm;codecs=vp8"})
                publisher.send_bytes(FIRST)
                publisher.send_bytes(MIDDLE)

                assert viewer.receive_json() == {
                    "type": "format", "mime": "video/webm;codecs=vp8"}
                assert viewer.receive_bytes() == INIT
                assert viewer.receive_bytes() == cluster(b"opening frames")
                assert viewer.receive_bytes() == MIDDLE

    def test_media_before_the_format_is_refused(self, client):
        """Bytes whose codec nobody has been told cannot be appended to any
        buffer, so they could only ever be discarded."""
        room = "relay-formatless"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as sharer:
            connection_id = _start_share(sharer, room)

            with client.websocket_connect(
                    f"/ws/share/{room}?role=publisher&connection={connection_id}"
                    f"&user=a@example.com") as publisher:
                publisher.send_bytes(FIRST)
                message = publisher.receive()

            assert message["code"] == config.SHARE_CLOSE_PROTOCOL


class TestTheRelayGoesWithTheShare:
    def test_the_sharer_leaving_the_room_tears_the_relay_down(self, client):
        room = "relay-teardown"
        from services.share_relay import relay as live_relay

        sharer = client.websocket_connect(f"/ws/{room}?user=a@example.com")
        entered = sharer.__enter__()
        connection_id = _start_share(entered, room)
        assert live_relay.relay_of(room) is not None
        sharer.__exit__(None, None, None)

        assert live_relay.relay_of(room) is None
        assert connection_id

    def test_stopping_the_share_tears_the_relay_down(self, client):
        room = "relay-stop"
        from services.share_relay import relay as live_relay

        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as sharer:
            _start_share(sharer, room)
            assert live_relay.relay_of(room) is not None

            sharer.send_json({"type": "share_stop", "payload": {}})
            _drain_until(sharer, "share_ended")

            assert live_relay.relay_of(room) is None

    def test_the_media_socket_closing_ends_the_share_for_the_room(self, client):
        """A laptop lid closing takes the media connection with it. The room
        must be given its player back rather than left on a frozen frame."""
        room = "relay-media-lost"
        with client.websocket_connect(f"/ws/{room}?user=a@example.com") as sharer, \
                client.websocket_connect(f"/ws/{room}?user=b@example.com") as watcher:
            connection_id = _start_share(sharer, room)
            _drain_until(watcher, "sync")

            with client.websocket_connect(
                    f"/ws/share/{room}?role=publisher&connection={connection_id}"
                    f"&user=a@example.com") as publisher:
                publisher.send_json({"type": "format", "mime": "video/webm;codecs=vp8"})
                publisher.send_bytes(FIRST)

            ended = _drain_until(watcher, "share_ended")
            assert ended["reason"] == "disconnected"

            from connection_manager import manager
            assert manager.share_of(room) is None
