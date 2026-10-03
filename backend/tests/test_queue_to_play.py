"""
Queue to playing: what a room member waits on between adding a video and
its first frame, beyond the extraction itself.

* every queue change sent each member the queue *with every entry's whole
  resolve* — signed URLs for each rung and audio track, storyboard sheets —
  about 50 KB per entry, 2.3 MB for a queue of 50, serialised once per
  member; the advance's `set_video` queued behind it on every socket;
* the manifest of an entry queued longer than the format cache keeps a
  resolve ran a whole yt-dlp extraction, although the room's entry still
  held URLs the CDN serves;
* resolving a queued entry probed its whole ladder whatever its place in the
  queue, and a playlist import overflowed the index cache with those probes,
  evicting the tables of the video playing now.
"""
import asyncio
import json
import time

import pytest
from fastapi.testclient import TestClient

from connection_manager import ConnectionManager


def _signed(itag: int, expire: int) -> str:
    return (f"https://rr1---sn-test.googlevideo.com/videoplayback?expire={expire}"
            f"&itag={itag}&clen=1000&sig=" + "s" * 900)


def _resolved(number: int, expire: int = None) -> dict:
    expire = expire or int(time.time()) + 5 * 3600
    rungs = [{"height": h, "width": h * 16 // 9, "video_url": _signed(h, expire),
              "format_id": str(h), "vcodec": "avc1.640028", "tbr": h * 2.5}
             for h in (1080, 720, 480, 360)]
    return {
        "original_url": f"https://youtu.be/queue-play-{number}", "title": f"Video {number}",
        "thumbnail": f"https://i.ytimg.com/vi/{number}/hq.jpg", "duration": 600,
        "is_live": False, "stream_type": "dash", "stream_url": rungs[0]["video_url"],
        "video_url": rungs[0]["video_url"], "audio_url": _signed(251, expire),
        "available_qualities": rungs,
        "audio_options": [{"audio_url": _signed(251, expire), "format_id": "251", "acodec": "opus"}],
        "storyboard": {"width": 320, "height": 180, "rows": 3, "columns": 3, "frame_duration": 2.0,
                       "sheets": [f"https://i.ytimg.com/sb/x/M{n}.jpg?sigh=abc" for n in range(100)]},
        "chapters": [{"title": "Intro", "start_time": 0, "end_time": 60}],
        "added_by": "a@example.com", "progress": 42.0,
    }


def _room(queue: list, video=None) -> dict:
    return {"video_data": video, "is_playing": bool(video), "timestamp": 0,
            "playing_index": queue.index(video) if video in queue else -1,
            "queue": queue, "roles": {}, "permanent": False, "name": "", "activity_log": []}


def _drain(ws, wanted, limit=20):
    for _ in range(limit):
        message = ws.receive_json()
        if message.get("type") == wanted:
            return message.get("payload", {})
    raise AssertionError(f"no {wanted!r} within {limit} messages")


class TestTheQueueIsSentWithoutItsStreams:

    def test_a_row_keeps_what_the_page_draws_and_plans_from(self):
        from connection_manager import queue_view
        entry = _resolved(1)
        [row] = queue_view([entry])
        for key in ("original_url", "title", "thumbnail", "duration", "is_live",
                    "stream_type", "added_by", "progress"):
            assert row[key] == entry[key]
        assert row["available_qualities"] == [
            {"height": r["height"], "width": r["width"], "vcodec": r["vcodec"], "tbr": r["tbr"]}
            for r in entry["available_qualities"]]
        assert queue_view([{"original_url": "u", "title": "u", "pending": True}]) == [
            {"original_url": "u", "title": "u", "pending": True}]

    def test_members_are_never_sent_a_queued_entrys_signed_urls(self, monkeypatch):
        import main

        async def resolve(url, user_agent=None, **kwargs):
            return _resolved(int(url.rsplit("-", 1)[1]))

        async def prepare(entry, room_id):
            return None

        monkeypatch.setattr(main, "resolve_url", resolve)
        monkeypatch.setattr(main, "_prepare_queued_video", prepare)
        with TestClient(main.app) as client:
            main.manager.room_states["queue-slim"] = _room([_resolved(n) for n in range(1, 51)])
            with client.websocket_connect("/ws/queue-slim?user=a@example.com") as ws:
                sync = ws.receive_text()
                ws.send_json({"type": "queue_add", "payload": {"url": "https://youtu.be/queue-play-51"}})
                _drain(ws, "queue_update")  # The placeholder…
                update = None
                for _ in range(20):  # …then its resolve.
                    text = ws.receive_text()
                    if json.loads(text)["type"] == "queue_update":
                        update = text
                        break
        assert update is not None
        # Booleans and a length: pytest would otherwise render megabytes.
        leaked = ["googlevideo" in text or "storyboard" in text for text in (sync, update)]
        assert leaked == [False, False]
        size = len(update)
        assert size < 40_000  # 51 entries; with their whole resolves, ~2.4 MB.

    @pytest.mark.asyncio
    async def test_a_broadcast_is_serialised_once_for_the_room(self, monkeypatch):
        import connection_manager

        class Socket:
            def __init__(self):
                self.texts = []

            async def send_text(self, text):
                self.texts.append(text)

        dumps = []
        real_dumps = json.dumps
        monkeypatch.setattr(connection_manager.json, "dumps",
                            lambda *a, **k: dumps.append(1) or real_dumps(*a, **k))
        manager = ConnectionManager()
        sockets = [Socket() for _ in range(5)]
        manager.active_connections["r"] = sockets
        await manager.broadcast({"type": "queue_update", "payload": {"queue": []}}, "r")
        assert len(dumps) == 1
        assert all(s.texts == sockets[0].texts and len(s.texts) == 1 for s in sockets)


class TestAnOlderQueueEntryIsNotExtractedAgain:

    def test_the_manifest_uses_the_rooms_entry_once_the_format_cache_let_go(self, monkeypatch):
        import main
        resolves = []

        async def resolve_video(*args, **kwargs):
            resolves.append(args)
            raise AssertionError("extracted again")

        async def fake_build(client_, duration_seconds, video_formats, audio_formats, **_):
            assert video_formats[0]["url"] == entry["available_qualities"][0]["video_url"]
            return "<MPD/>"

        monkeypatch.setattr(main, "resolve_video", resolve_video)
        monkeypatch.setattr(main, "build_manifest_for_formats", fake_build)
        entry = _resolved(7)
        with TestClient(main.app) as client:
            main.manager.room_states["queue-old"] = _room([entry])
            with client.websocket_connect("/ws/queue-old?user=a@example.com") as ws:
                ws.receive_json()
                response = client.get("/api/dash-manifest", params={
                    "url": entry["original_url"], "room": "queue-old", "user": "a@example.com"})
        assert response.status_code == 200, response.text
        assert resolves == []

    def test_an_outsider_does_not_read_the_rooms_entry(self, monkeypatch):
        import main
        from fastapi import HTTPException
        resolves = []

        async def resolve_video(*args, **kwargs):
            resolves.append(args)
            raise HTTPException(status_code=400, detail="no")

        monkeypatch.setattr(main, "resolve_video", resolve_video)
        entry = _resolved(8)
        with TestClient(main.app) as client:
            main.manager.room_states["queue-private"] = _room([entry])
            response = client.get("/api/dash-manifest", params={
                "url": entry["original_url"], "room": "queue-private", "user": "b@example.com"})
        assert response.status_code == 400
        assert len(resolves) == 1

    @pytest.mark.parametrize("lifetime", ["expired", "minutes-left", "no-deadline"])
    def test_an_entry_whose_urls_will_not_last_the_video_is_resolved(self, monkeypatch, lifetime):
        """Expired URLs are refused at once; URLs with minutes left play for
        minutes and are then refused mid-video (a 600 s video, 5 minutes of
        signature); URLs that state no deadline have no known lifetime."""
        import main
        from fastapi import HTTPException
        resolves = []

        async def resolve_video(*args, **kwargs):
            resolves.append(args)
            raise HTTPException(status_code=400, detail="no")

        monkeypatch.setattr(main, "resolve_video", resolve_video)
        if lifetime == "expired":
            entry = _resolved(9, expire=int(time.time()) - 60)
        elif lifetime == "minutes-left":
            entry = _resolved(9, expire=int(time.time()) + 300)
        else:
            import json
            entry = json.loads(json.dumps(_resolved(9)).replace("expire=", "e="))
        with TestClient(main.app) as client:
            main.manager.room_states["queue-dead"] = _room([entry])
            with client.websocket_connect("/ws/queue-dead?user=a@example.com") as ws:
                ws.receive_json()
                client.get("/api/dash-manifest", params={
                    "url": entry["original_url"], "room": "queue-dead", "user": "a@example.com"})
        assert len(resolves) == 1


class TestOnlyTheNextEntryIsProbedOnArrival:

    @pytest.mark.asyncio
    async def test_an_entry_further_back_is_left_until_it_comes_up(self, monkeypatch):
        import main
        probed = []

        async def resolve(url, user_agent=None, **kwargs):
            return _resolved(int(url.rsplit("-", 1)[1]))

        async def prepare(entry, room_id):
            probed.append(entry["original_url"])

        async def no_activity(*args, **kwargs):
            return None

        monkeypatch.setattr(main, "resolve_url", resolve)
        monkeypatch.setattr(main, "_prepare_queued_video", prepare)
        monkeypatch.setattr(main, "publish_room_activity", no_activity)
        playing = _resolved(1)
        queue = [playing] + [{"original_url": f"https://youtu.be/queue-play-{n}",
                              "title": "x", "pending": True} for n in (2, 3, 4)]
        main.manager.room_states["queue-probe"] = _room(queue, playing)
        try:
            await asyncio.gather(*(main._resolve_queued("queue-probe", f"https://youtu.be/queue-play-{n}",
                                                        "a@example.com") for n in (4, 3, 2)))
        finally:
            main.manager.room_states.pop("queue-probe", None)
        assert probed == ["https://youtu.be/queue-play-2"]
