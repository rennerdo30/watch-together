"""Audio language selection and DASH signaling regressions."""

import xml.etree.ElementTree as ET

import pytest

from services import manifest as manifest_service
from services.manifest import build_mpd, manifest_formats
from services.mp4_index import Mp4Index
from services.resolver import _extract_stream_url


NS = {"mpd": "urn:mpeg:dash:schema:mpd:2011"}
INDEX = Mp4Index(0, 700, 701, 13000)


def _audio(format_id: str, language: str, note: str, preference: int, abr: int) -> dict:
    return {
        "format_id": format_id,
        "url": f"https://cdn.example/{format_id}.m4a",
        "ext": "m4a",
        "vcodec": "none",
        "acodec": "mp4a.40.2",
        "abr": abr,
        "language": language,
        "format_note": note,
        "language_preference": preference,
    }


def _select(*audio: dict) -> dict:
    return _extract_stream_url({"title": "Dubbed video", "formats": [
        {"format_id": "137", "url": "https://cdn.example/video.mp4",
         "ext": "mp4", "vcodec": "avc1.640028", "acodec": "none",
         "height": 1080, "width": 1920, "tbr": 4500},
        *audio,
    ]})


def test_original_survives_high_bitrate_dubs_and_is_the_default():
    selected = _select(
        _audio("en", "en", "English (default), medium", 5, 160),
        _audio("de", "de", "German, medium", -1, 150),
        _audio("fr", "fr", "French, medium", -1, 140),
        _audio("ja", "ja", "Japanese original (original), medium", 10, 128),
    )
    options = selected["audio_options"]
    assert {option["language"] for option in options} == {"en", "de", "fr", "ja"}
    assert options[0]["format_id"] == "ja"
    assert selected["audio_url"] == options[0]["audio_url"]
    assert [(option["format_id"], option["is_default"]) for option in options] == [
        ("ja", True), ("en", False), ("de", False), ("fr", False),
    ]
    assert options[0]["is_original"] is True
    assert options[0]["label"] == "Japanese original"


def test_original_and_dub_in_same_language_remain_distinct():
    selected = _select(
        _audio("en-dub", "en", "English dubbed (original), medium", 10, 160),
        _audio("en-original", "en", "English original, medium", 10, 128),
        _audio("en-commentary", "en", "English commentary, medium", -1, 112),
        _audio("en-desc", "en-desc", "English descriptive, medium", -10, 96),
    )
    options = selected["audio_options"]
    assert {option["format_id"] for option in options} == {
        "en-dub", "en-original", "en-commentary", "en-desc",
    }
    assert next(o for o in options if o["format_id"] == "en-dub")["is_original"] is False
    assert next(o for o in options if o["format_id"] == "en-desc")["role"] == "description"
    assert next(o for o in options if o["format_id"] == "en-desc")["language"] == "en"
    assert selected["audio_url"] == "https://cdn.example/en-original.m4a"


def test_duplicate_bitrates_collapse_per_language_and_role():
    selected = _select(
        _audio("ja-low", "ja", "Japanese original, low", 10, 48),
        _audio("ja-high", "ja", "Japanese original, medium", 10, 128),
        _audio("en", "en", "English (default), medium", 5, 128),
    )
    assert [o["format_id"] for o in selected["audio_options"]] == ["ja-high", "en"]


def test_missing_language_metadata_keeps_a_playable_audio_choice():
    selected = _select({
        "format_id": "140", "url": "https://cdn.example/plain.m4a",
        "vcodec": "none", "acodec": "mp4a.40.2", "abr": 128,
    })
    assert selected["audio_options"][0]["language"] == "und"
    assert selected["audio_options"][0]["is_default"] is True


def test_dash_separates_languages_and_roles_and_labels_default():
    options = _select(
        _audio("en-dub", "en", "English dubbed, medium", 5, 160),
        _audio("en-commentary", "en", "English commentary, medium", -1, 112),
        _audio("ja-original", "ja", "Japanese original, medium", 10, 128),
        _audio("ja-desc", "ja-desc", "Japanese descriptive, medium", -10, 96),
    )["audio_options"]
    formats = manifest_formats({"audio_options": options})[1]
    assert {f["language"] for f in formats} == {"en", "ja"}
    xml = build_mpd(120, [], [{**f, "index": INDEX} for f in formats], "/api/proxy?url=")
    sets = ET.fromstring(xml).findall(".//mpd:AdaptationSet[@contentType='audio']", NS)
    assert len(sets) == 4
    assert {(s.get("lang"), s.find("mpd:Role", NS).get("value")) for s in sets} == {
        ("ja", "main"), ("ja", "description"), ("en", "alternate"),
    }
    assert next(s for s in sets if s.get("lang") == "ja" and
                s.find("mpd:Role", NS).get("value") == "main").find("mpd:Label", NS).text == "Japanese original"
    assert {s.find("mpd:Label", NS).text for s in sets if s.get("lang") == "en"} == {
        "English dubbed", "English commentary",
    }


@pytest.mark.asyncio
async def test_probe_failure_promotes_a_surviving_audio_track(monkeypatch):
    async def probe(_client, url, _headers=None):
        return None if "original" in url else INDEX

    monkeypatch.setattr(manifest_service, "probe_index", probe)
    xml = await manifest_service.build_manifest_for_formats(
        None, 120, [], [
            {"id": "original", "url": "https://cdn/original.m4a", "acodec": "mp4a.40.2",
             "language": "ja", "label": "Japanese original", "role": "main", "is_default": True},
            {"id": "dub", "url": "https://cdn/dub.m4a", "acodec": "mp4a.40.2",
             "language": "en", "label": "English dubbed", "role": "alternate", "is_default": False},
        ], "/api/proxy?url=")
    sets = ET.fromstring(xml).findall(".//mpd:AdaptationSet[@contentType='audio']", NS)
    assert len(sets) == 1
    assert sets[0].find("mpd:Role", NS).get("value") == "main"
    assert sets[0].get("lang") == "en"
