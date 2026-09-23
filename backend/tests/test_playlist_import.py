"""Playlist previews are bounded; import is explicit and room-authorized."""

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from services import playlists


VIDEO_ID = "dQw4w9WgXcQ"
OTHER_ID = "9bZkp7q19f0"
PLAYLIST = "https://www.youtube.com/playlist?list=PL1234567890"
WATCH_LIST = f"https://www.youtube.com/watch?v={VIDEO_ID}&list=PL1234567890&index=2"


def _raw(*ids):
    return {"_type": "playlist", "title": "A list", "entries": [
        {"id": video_id, "title": f"Video {index}", "duration": 120}
        for index, video_id in enumerate(ids, start=1)
    ]}


def test_flat_extraction_materializes_only_151_entries_with_cookie_context_open(monkeypatch):
    seen = []
    open_context = {"value": False}

    class FakeYDL:
        def __init__(self, options):
            self.options = options

        def __enter__(self):
            open_context["value"] = True
            return self

        def __exit__(self, *args):
            open_context["value"] = False

        def extract_info(self, url, download=False, process=False):
            assert process is True
            def entries():
                for index in range(300):
                    assert open_context["value"]
                    seen.append(index)
                    yield {"id": VIDEO_ID}
            return {"_type": "playlist", "entries": entries()}

    monkeypatch.setattr(playlists.yt_dlp, "YoutubeDL", FakeYDL)
    result = playlists._extract_flat(PLAYLIST, {"cookiefile": "/tmp/requester-cookies.txt"})
    assert len(result["entries"]) == 151
    assert len(seen) == 151 and not open_context["value"]


@pytest.mark.parametrize("url", [
    PLAYLIST, WATCH_LIST,
    f"https://youtu.be/{VIDEO_ID}?list=PL1234567890&index=2",
    f"https://www.youtube-nocookie.com/watch?v={VIDEO_ID}&list=PL1234567890",
])
def test_playlist_url_normalizes_watch_context(url):
    assert playlists.canonical_playlist_url(url) == PLAYLIST


@pytest.mark.parametrize("url", [
    f"https://youtu.be/{VIDEO_ID}",
    f"https://www.youtube.com/watch?v={VIDEO_ID}",
    "https://evil.example/playlist?list=PL1234567890",
])
def test_non_playlist_url_is_rejected(url):
    with pytest.raises(playlists.PlaylistError):
        playlists.canonical_playlist_url(url)


async def test_discovery_uses_requester_cookies_and_caps_flat_extraction(monkeypatch):
    seen = {}

    @asynccontextmanager
    async def cookies(owner):
        seen["owner"] = owner
        yield "/tmp/requester-cookies.txt"

    def extract(url, options):
        seen["url"] = url
        seen["options"] = options
        return _raw(VIDEO_ID, OTHER_ID)

    monkeypatch.setattr(playlists, "has_cookies_for", lambda user, url: user == "owner@example.com" and url == PLAYLIST)
    monkeypatch.setattr(playlists, "cookie_file", cookies)
    monkeypatch.setattr(playlists, "_extract_flat", extract)

    result = await playlists.discover(WATCH_LIST, "owner@example.com")

    assert seen["owner"] == "owner@example.com"
    assert seen["url"] == PLAYLIST
    assert seen["options"]["cookiefile"] == "/tmp/requester-cookies.txt"
    assert seen["options"]["noplaylist"] is False
    assert seen["options"]["extract_flat"] == "in_playlist"
    assert seen["options"]["playlist_items"] == "1:151"
    assert [entry["index"] for entry in result["entries"]] == [1, 2]


async def test_discovery_uses_flat_entry_thumbnails_and_marks_private_rows(monkeypatch):
    monkeypatch.setattr(playlists, "has_cookies_for", lambda user, url: False)
    monkeypatch.setattr(playlists, "_extract_flat", lambda url, options: {
        "_type": "playlist", "title": "List", "entries": [
            {"id": VIDEO_ID, "title": "First", "duration": 42,
             "thumbnails": [{"url": "https://img.test/small.jpg"},
                            {"url": "https://img.test/large.jpg"}]},
            {"id": OTHER_ID, "title": "Private video", "availability": "private"},
        ],
    })
    entries = (await playlists.discover(PLAYLIST, "owner@example.com"))["entries"]
    assert entries[0]["thumbnail"] == "https://img.test/large.jpg"
    assert entries[0]["duration"] == 42
    assert entries[1]["available"] is False and entries[1]["reason"] == "private"


async def test_discovery_never_borrows_another_members_cookies(monkeypatch):
    seen = {}

    @asynccontextmanager
    async def cookies(owner):
        seen["owner"] = owner
        yield None

    monkeypatch.setattr(playlists, "has_cookies_for", lambda user, url: False)
    monkeypatch.setattr(playlists, "cookie_file", cookies)
    monkeypatch.setattr(playlists, "_extract_flat", lambda url, options: _raw(VIDEO_ID))
    await playlists.discover(PLAYLIST, "member@example.com")
    assert seen["owner"] is None


async def test_more_than_150_entries_fails_without_partial_preview(monkeypatch):
    monkeypatch.setattr(playlists, "has_cookies_for", lambda user, url: False)
    monkeypatch.setattr(playlists, "_extract_flat", lambda url, options: _raw(*([VIDEO_ID] * 151)))
    with pytest.raises(playlists.PlaylistError) as exc:
        await playlists.discover(PLAYLIST, "owner@example.com")
    assert exc.value.status_code == 413


async def test_empty_playlist_has_a_clear_error(monkeypatch):
    monkeypatch.setattr(playlists, "has_cookies_for", lambda user, url: False)
    monkeypatch.setattr(playlists, "_extract_flat", lambda url, options: _raw())
    with pytest.raises(playlists.PlaylistError, match="contains no videos"):
        await playlists.discover(PLAYLIST, "owner@example.com")


@pytest.fixture
def client(monkeypatch):
    import main

    async def discover(url, requester, user_agent=None):
        return {"title": "A list", "entries": [
            {"id": "row-1", "index": 1, "title": "First", "thumbnail": None,
             "duration": 100, "available": True, "reason": None,
             "url": f"https://www.youtube.com/watch?v={VIDEO_ID}"},
            {"id": "row-2", "index": 2, "title": "Unavailable", "thumbnail": None,
             "duration": None, "available": False, "reason": "private", "url": None},
            {"id": "row-3", "index": 3, "title": "Third", "thumbnail": None,
             "duration": 120, "available": True, "reason": None,
             "url": f"https://www.youtube.com/watch?v={OTHER_ID}"},
            {"id": "row-4", "index": 4, "title": "Duplicate", "thumbnail": None,
             "duration": 100, "available": True, "reason": None,
             "url": f"https://youtu.be/{VIDEO_ID}"},
        ]}

    monkeypatch.setattr(playlists, "discover", discover)
    monkeypatch.setattr(main, "_run_detached", lambda coroutine: coroutine.close())
    with TestClient(main.app) as test_client:
        main.manager.room_states["playlist-test"] = {
            "video_data": None, "is_playing": False, "timestamp": 0,
            "queue": [], "roles": {"admin@example.com": "admin",
                                   "mod@example.com": "moderator",
                                   "viewer@example.com": "user"},
            "playing_index": -1, "permanent": False, "name": "",
        }
        yield test_client
        main.manager.room_states.pop("playlist-test", None)


def _post(client, endpoint, user, body):
    return client.post(f"/api/rooms/playlist-test/playlist/{endpoint}",
                       params={"user": user}, json=body)


def test_preview_requires_room_role_and_does_not_write_queue(client):
    assert _post(client, "preview", "viewer@example.com", {"url": PLAYLIST}).status_code == 403
    assert _post(client, "preview", "stranger@example.com", {"url": PLAYLIST}).status_code == 403
    preview = _post(client, "preview", "mod@example.com", {"url": PLAYLIST})
    assert preview.status_code == 200
    body = preview.json()
    assert body["total"] == 4 and body["entries"][1]["reason"] == "private"
    assert body["entries"][0]["already_queued"] is False
    import main
    assert main.manager.room_states["playlist-test"]["queue"] == []


def test_confirm_validates_whole_selection_and_appends_in_order_once(client, monkeypatch):
    import main
    manager = main.manager
    save = AsyncMock()
    monkeypatch.setattr(manager, "_save_room_state", save)
    preview = _post(client, "preview", "admin@example.com", {"url": PLAYLIST}).json()
    token = preview["preview_id"]
    assert _post(client, "confirm", "admin@example.com", {
        "preview_id": token, "selected_ids": []}).status_code == 422
    bad = _post(client, "confirm", "admin@example.com", {
        "preview_id": token, "selected_ids": ["row-1", "row-2"]})
    assert bad.status_code == 422 and manager.room_states["playlist-test"]["queue"] == []
    denied = _post(client, "confirm", "mod@example.com", {
        "preview_id": token, "selected_ids": ["row-1"]})
    assert denied.status_code == 404
    chosen = {"preview_id": token, "selected_ids": ["row-3", "row-1", "row-4"]}
    result = _post(client, "confirm", "admin@example.com", chosen)
    assert result.status_code == 200 and result.json() == {"added": 2, "skipped": 1}
    queue = manager.room_states["playlist-test"]["queue"]
    assert [item["original_url"] for item in queue] == [
        f"https://www.youtube.com/watch?v={VIDEO_ID}",
        f"https://www.youtube.com/watch?v={OTHER_ID}",
    ]
    assert all(item["pending"] for item in queue)
    assert save.await_count == 1
    assert _post(client, "confirm", "admin@example.com", chosen).json() == result.json()
    assert save.await_count == 1
    assert _post(client, "confirm", "admin@example.com", {
        "preview_id": token, "selected_ids": ["row-1"]}).status_code == 409


def test_confirm_rechecks_demotion_and_skips_existing_video(client):
    import main
    state = main.manager.room_states["playlist-test"]
    state["queue"].append({"original_url": f"https://youtu.be/{VIDEO_ID}", "title": "Already here"})
    preview = _post(client, "preview", "mod@example.com", {"url": PLAYLIST}).json()
    assert preview["entries"][0]["already_queued"] is True
    token = preview["preview_id"]
    state["roles"]["mod@example.com"] = "user"
    assert _post(client, "confirm", "mod@example.com", {
        "preview_id": token, "selected_ids": ["row-1", "row-3"]}).status_code == 403
    assert len(state["queue"]) == 1
    state["roles"]["mod@example.com"] = "moderator"
    result = _post(client, "confirm", "mod@example.com", {
        "preview_id": token, "selected_ids": ["row-1", "row-3"]})
    assert result.json() == {"added": 1, "skipped": 1}
    assert len(state["queue"]) == 2


def test_ordinary_queue_rejects_playlist_page_but_accepts_watch_list():
    import main
    assert main._is_queueable_url(PLAYLIST) is False
    assert main._is_queueable_url(WATCH_LIST) is True
