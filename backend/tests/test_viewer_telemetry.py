"""
Per-viewer telemetry: who was served, by which tier, and what their player
made of it.

"One viewer is always on a low rendition, everyone else is fine" was not
answerable from anything this backend recorded. A proxy sample named no
identity, so it described the instance rather than anyone on it; cache hits
returned before recording anything at all, so a viewer served from cache
looked like a viewer who had stopped watching; and the inputs to the
decision — the size the video is drawn at, the pixel ratio, the measured
bandwidth, the frames the decoder dropped — exist only in the browser and
reached nobody.

Reporting them over the room socket made them visible to the admin panel
and nowhere else, which is the same problem one layer along: the panel
needs a browser signed in to Cloudflare Access, so an operator standing on
the host — where the containers, the logs and the incident are — could not
read them at all, and neither could anyone looking at a log bundle
afterwards. A report now also goes to the log, once per change, and into a
bounded history that outlives the viewer.
"""
import logging
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DEVELOPMENT_MODE", "true")

from fastapi.testclient import TestClient

from connection_manager import ConnectionManager
from services import playback_quality
from services.playback_quality import (
    LOG_PREFIX, PlaybackQualityHistory, describe, history, is_notable, normalize, verdict,
    VERDICT_BANDWIDTH, VERDICT_DROPPING, VERDICT_NO_RUNG, VERDICT_SAVER,
    VERDICT_SINGLE_RUNG, VERDICT_SURFACE_CAPPED,
)
from services.metrics import (
    ProxyMetrics, proxy_metrics, throughput_mbps,
    OUTCOME_OK, TIER_DISK, TIER_MEMORY, TIER_UPSTREAM,
)

# One viewer on a small player, adapting down on a thin link.
STEADY_REPORT = {
    "rung": 360, "cap": 720, "surface_px": 540, "pixel_ratio": 1.5,
    "estimate_bps": 2_500_000, "dropped_frames": 0.002, "ladder_rungs": 8,
    "mode": "balanced", "engine": "mse",
}


def quality_lines(caplog):
    """Every INFO line this feature wrote, in order."""
    return [record.getMessage() for record in caplog.records
            if record.levelno == logging.INFO and record.getMessage().startswith(LOG_PREFIX)]


def parse_line(line):
    """`key=value key=value ...` back into a dict, the way awk reads it."""
    return dict(pair.split("=", 1) for pair in line[len(LOG_PREFIX):].split())


@pytest.fixture
def client():
    from main import app
    return TestClient(app)


class TestThroughput:
    def test_a_streamed_transfer_reports_what_the_client_was_served_at(self):
        # 1 MB in one second is 8 Mbit/s.
        assert throughput_mbps(1_000_000, 1000.0, TIER_UPSTREAM) == 8.0
        assert throughput_mbps(1_000_000, 500.0, TIER_DISK) == 16.0

    def test_a_memory_hit_reports_nothing_rather_than_an_imaginary_link(self):
        """Its elapsed time measures a copy inside this process."""
        assert throughput_mbps(1_000_000, 0.4, TIER_MEMORY) is None

    def test_nothing_measurable_is_not_reported_as_zero(self):
        assert throughput_mbps(0, 100.0, TIER_UPSTREAM) is None
        assert throughput_mbps(1024, 0.0, TIER_UPSTREAM) is None


class TestSamplesCarryWhoAndWhere:
    async def test_the_tier_that_answered_is_counted(self):
        metrics = ProxyMetrics(capacity=10)
        await metrics.record(host="cdn", status=206, outcome=OUTCOME_OK,
                             upstream_ms=100.0, transfer_ms=200.0, bytes_sent=1000,
                             identity="a@example.com")
        await metrics.record(host="cdn", status=206, outcome=OUTCOME_OK,
                             upstream_ms=0.0, transfer_ms=5.0, bytes_sent=2000,
                             identity="a@example.com", cache_tier=TIER_MEMORY)

        snapshot = await metrics.snapshot(include_identity=True)
        assert snapshot["by_cache_tier"][TIER_UPSTREAM]["requests"] == 1
        assert snapshot["by_cache_tier"][TIER_MEMORY]["bytes_sent"] == 2000
        assert [s["identity"] for s in snapshot["recent_samples"]] == ["a@example.com"] * 2

    async def test_the_open_endpoint_never_says_who_fetched_what(self, client):
        """`/api/metrics/proxy` is open to every signed-in viewer."""
        await proxy_metrics.reset()
        await proxy_metrics.record(host="cdn", status=206, outcome=OUTCOME_OK,
                                   upstream_ms=1.0, transfer_ms=2.0, bytes_sent=10,
                                   identity="watched-something-private@example.com")

        body = client.get("/api/metrics/proxy",
                          params={"user": "someone-else@example.com"}).json()

        assert body["recent_samples"], "the sample should still be reported"
        for sample in body["recent_samples"]:
            assert "identity" not in sample
        assert "watched-something-private" not in str(body)

    async def test_the_admin_panel_does_say(self, client, monkeypatch):
        import core.config as config
        import api.routes.admin as admin
        monkeypatch.setattr(config, "ADMIN_EMAILS", {"admin@example.com"})
        monkeypatch.setattr(admin.config, "ADMIN_EMAILS", {"admin@example.com"})
        await proxy_metrics.reset()
        await proxy_metrics.record(host="cdn", status=206, outcome=OUTCOME_OK,
                                   upstream_ms=1.0, transfer_ms=2.0, bytes_sent=10,
                                   identity="slow-viewer@example.com")

        body = client.get("/api/admin/cache", params={"user": "admin@example.com"}).json()

        identities = [s.get("identity") for s in body["proxy"]["recent_samples"]]
        assert "slow-viewer@example.com" in identities


class TestCacheHitsAreRecorded:
    """A hit used to return before any sample was taken."""

    PAYLOAD = bytes(range(256)) * 8

    @pytest.fixture
    def origin(self):
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer

        payload = self.PAYLOAD

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                rng = self.headers.get("Range")
                start_s, _, end_s = rng.split("=", 1)[1].partition("-")
                start = int(start_s)
                end = min(int(end_s) if end_s else len(payload) - 1, len(payload) - 1)
                body = payload[start:end + 1]
                self.send_response(206)
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Content-Range", f"bytes {start}-{end}/{len(payload)}")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        yield f"http://127.0.0.1:{server.server_port}/segment.mp4"
        server.shutdown()
        server.server_close()

    @pytest.fixture(autouse=True)
    def allow_local_origin(self, monkeypatch, origin):
        import services.upstream as upstream
        from urllib.parse import urlparse

        real = upstream._is_public_ip
        monkeypatch.setattr(upstream, "_is_public_ip",
                            lambda ip: ip == "127.0.0.1" or real(ip))
        monkeypatch.setattr(upstream, "UPSTREAM_ALLOWED_PORTS",
                            upstream.UPSTREAM_ALLOWED_PORTS + (urlparse(origin).port,))

    async def test_every_tier_that_serves_a_viewer_leaves_a_sample(self, client, origin):
        from services.cache import memory_cache

        params = {"url": origin, "user": "tiers@example.com"}
        headers = {"Range": "bytes=0-99"}

        await proxy_metrics.reset()
        client.get("/api/proxy", params=params, headers=headers)
        client.get("/api/proxy", params=params, headers=headers)   # memory
        await memory_cache.clear()
        client.get("/api/proxy", params=params, headers=headers)   # disk

        snapshot = await proxy_metrics.snapshot(include_identity=True)
        tiers = [s["cache_tier"] for s in snapshot["recent_samples"]]
        assert tiers == [TIER_UPSTREAM, TIER_MEMORY, TIER_DISK]
        assert {s["identity"] for s in snapshot["recent_samples"]} == {"tiers@example.com"}
        assert all(s["bytes_sent"] == 100 for s in snapshot["recent_samples"])


class TestPlaybackQualityReport:
    """What the player says about its own picture, bounded on the way in."""

    class FakeSocket:
        user_email = "viewer@example.com"

    def test_a_report_is_kept_on_the_connection(self):
        socket = self.FakeSocket()
        kept = ConnectionManager.record_playback_quality(socket, {
            "rung": 360, "cap": 720, "surface_px": 540, "pixel_ratio": 1.5,
            "estimate_bps": 2_500_000, "dropped_frames": 0.21, "ladder_rungs": 8,
            "mode": "balanced", "engine": "mse",
        }, "movies")

        assert kept["rung"] == 360 and kept["cap"] == 720
        assert kept["dropped_frames"] == 0.21
        assert kept["mode"] == "balanced" and kept["engine"] == "mse"
        assert socket.playback_quality == kept
        assert kept["at"] > 0

    def test_a_browser_cannot_write_whatever_it_likes(self):
        socket = self.FakeSocket()
        kept = ConnectionManager.record_playback_quality(socket, {
            "rung": "<script>", "cap": 10 ** 9, "surface_px": -1,
            "pixel_ratio": float("inf"), "estimate_bps": True,
            "dropped_frames": 42, "ladder_rungs": 10_000,
            "mode": "'; DROP TABLE", "engine": "something",
            "extra": "not a field this understands",
        }, "movies")

        assert set(kept) == {"rung", "cap", "surface_px", "pixel_ratio", "estimate_bps",
                             "dropped_frames", "ladder_rungs", "mode", "engine", "at"}
        assert all(kept[field] is None for field in
                   ("rung", "cap", "surface_px", "pixel_ratio", "estimate_bps",
                    "dropped_frames", "ladder_rungs", "mode", "engine"))

    def test_nonsense_is_refused_outright(self):
        assert ConnectionManager.record_playback_quality(
            self.FakeSocket(), "hello", "movies") is None

    def test_junk_is_never_logged_and_never_kept(self, caplog):
        """A payload that is not a report must not reach the log either."""
        with caplog.at_level(logging.DEBUG):
            ConnectionManager.record_playback_quality(self.FakeSocket(), "hello", "movies")

        assert quality_lines(caplog) == []
        assert history.snapshot(limit=10) == []


class TestTheHostCanReadIt:
    """The answer has to survive without a browser signed in to Access."""

    class FakeSocket:
        user_email = "blurry@example.com"

    def test_a_change_is_one_greppable_line_at_info(self, caplog):
        """Production runs at INFO; a DEBUG-only trail would be invisible."""
        with caplog.at_level(logging.DEBUG):
            ConnectionManager.record_playback_quality(
                self.FakeSocket(), STEADY_REPORT, "movies")

        lines = quality_lines(caplog)
        assert len(lines) == 1
        assert "\n" not in lines[0]

        fields = parse_line(lines[0])
        assert fields["member"] == "blurry@example.com"
        assert fields["room"] == "movies"
        # The rung, and every input that decided it, on the one line.
        assert fields["rung"] == "360p"
        assert fields["cap"] == "720p"
        assert fields["surface"] == "540px"
        assert fields["dpr"] == "1.5"
        assert fields["estimate"] == "2.50Mbps"
        assert fields["dropped"] == "0.20%"
        assert fields["ladder"] == "8"
        assert fields["mode"] == "balanced"
        assert fields["engine"] == "mse"
        assert fields["verdict"] == VERDICT_BANDWIDTH

    def test_a_steady_picture_does_not_repeat_itself_at_info(self, caplog):
        """The client re-sends every 30 s; that is not news."""
        socket = self.FakeSocket()
        with caplog.at_level(logging.DEBUG):
            for _ in range(4):
                ConnectionManager.record_playback_quality(socket, STEADY_REPORT, "movies")

        assert len(quality_lines(caplog)) == 1
        repeats = [r for r in caplog.records
                   if r.levelno == logging.DEBUG and r.getMessage().startswith(LOG_PREFIX)]
        assert len(repeats) == 3, "the repeats are still traceable at DEBUG"

    def test_a_new_rung_is_news(self, caplog):
        socket = self.FakeSocket()
        with caplog.at_level(logging.DEBUG):
            ConnectionManager.record_playback_quality(socket, STEADY_REPORT, "movies")
            ConnectionManager.record_playback_quality(
                socket, {**STEADY_REPORT, "rung": 720}, "movies")

        assert [parse_line(line)["rung"] for line in quality_lines(caplog)] == ["360p", "720p"]

    def test_a_bandwidth_estimate_that_actually_moved_is_news(self, caplog):
        """Same rung, four times the link: that is the answer changing."""
        socket = self.FakeSocket()
        with caplog.at_level(logging.DEBUG):
            ConnectionManager.record_playback_quality(socket, STEADY_REPORT, "movies")
            ConnectionManager.record_playback_quality(
                socket, {**STEADY_REPORT, "estimate_bps": 10_000_000}, "movies")

        assert len(quality_lines(caplog)) == 2

    def test_estimate_jitter_is_not(self, caplog):
        socket = self.FakeSocket()
        with caplog.at_level(logging.DEBUG):
            ConnectionManager.record_playback_quality(socket, STEADY_REPORT, "movies")
            ConnectionManager.record_playback_quality(
                socket, {**STEADY_REPORT, "estimate_bps": 2_550_000}, "movies")

        assert len(quality_lines(caplog)) == 1

    def test_a_decoder_starting_to_drop_frames_is_news(self, caplog):
        socket = self.FakeSocket()
        with caplog.at_level(logging.DEBUG):
            ConnectionManager.record_playback_quality(socket, STEADY_REPORT, "movies")
            ConnectionManager.record_playback_quality(
                socket, {**STEADY_REPORT, "dropped_frames": 0.09}, "movies")

        assert [parse_line(line)["verdict"] for line in quality_lines(caplog)] == [
            VERDICT_BANDWIDTH, VERDICT_DROPPING]

    def test_a_real_viewer_on_a_real_socket_lands_in_the_log(self, client, caplog):
        """End to end: the browser's message, the handler, the log line."""
        with caplog.at_level(logging.INFO):
            with client:
                with client.websocket_connect(
                        "/ws/telemetry-room?user=onsocket@example.com") as socket:
                    socket.send_json({"type": "playback_quality", "payload": STEADY_REPORT})
                    # A round trip proves the previous message was handled.
                    socket.send_json({"type": "ping", "payload": {"client_time": 1}})
                    while socket.receive_json()["type"] != "pong":
                        pass

        lines = [line for line in quality_lines(caplog)
                 if parse_line(line)["member"] == "onsocket@example.com"]
        assert len(lines) == 1
        assert parse_line(lines[0])["room"] == "telemetry-room"


class TestTheVerdictNamesTheDecidingInput:
    """"Which rung, and why" — the why is a reading of the same numbers."""

    def test_sitting_on_the_cap_means_the_player_is_too_small(self):
        assert verdict(normalize({**STEADY_REPORT, "rung": 720})) == VERDICT_SURFACE_CAPPED

    def test_below_the_cap_with_rungs_left_means_the_link(self):
        assert verdict(normalize(STEADY_REPORT)) == VERDICT_BANDWIDTH

    def test_a_dropping_decoder_outranks_everything(self):
        """More bandwidth cannot fix a decoder that cannot keep up."""
        assert verdict(normalize({**STEADY_REPORT, "rung": 720,
                                  "dropped_frames": 0.2})) == VERDICT_DROPPING

    def test_a_viewer_who_asked_for_less_is_not_a_fault(self):
        assert verdict(normalize({**STEADY_REPORT, "mode": "saver"})) == VERDICT_SAVER

    def test_a_ladder_with_one_rung_offers_nothing_to_climb_to(self):
        assert verdict(normalize({**STEADY_REPORT, "cap": None,
                                  "ladder_rungs": 1})) == VERDICT_SINGLE_RUNG

    def test_no_picture_at_all_says_so(self):
        assert verdict(normalize({})) == VERDICT_NO_RUNG


class TestAReportOutlivesTheViewer:
    """It used to live only on the connection, and leave with it."""

    class FakeSocket:
        user_email = "gone@example.com"

    def test_the_history_still_has_it_after_the_socket_is_gone(self):
        socket = self.FakeSocket()
        ConnectionManager.record_playback_quality(socket, STEADY_REPORT, "movies")
        del socket

        kept = history.snapshot(limit=10)
        assert [entry["member"] for entry in kept] == ["gone@example.com"]
        assert kept[0]["room"] == "movies"
        assert kept[0]["rung"] == 360
        assert kept[0]["verdict"] == VERDICT_BANDWIDTH

    def test_the_admin_overview_reports_a_viewer_who_has_left(self, client, monkeypatch):
        import core.config as config
        import api.routes.admin as admin
        monkeypatch.setattr(config, "ADMIN_EMAILS", {"admin@example.com"})
        monkeypatch.setattr(admin.config, "ADMIN_EMAILS", {"admin@example.com"})
        ConnectionManager.record_playback_quality(self.FakeSocket(), STEADY_REPORT, "movies")

        body = client.get("/api/admin/overview",
                          params={"user": "admin@example.com"}).json()

        assert body["rooms"] == [], "nobody is connected any more"
        assert [entry["member"] for entry in body["playback_history"]] == ["gone@example.com"]

    def test_one_idle_viewer_cannot_push_everyone_else_out(self):
        """Only changes are kept, so repeats do not consume the buffer."""
        socket = self.FakeSocket()
        for _ in range(10):
            ConnectionManager.record_playback_quality(socket, STEADY_REPORT, "movies")

        assert len(history.snapshot(limit=100)) == 1

    def test_the_history_is_bounded(self):
        bounded = PlaybackQualityHistory(capacity=3)
        for rung in (240, 360, 480, 720):
            bounded.append("movies", "someone@example.com",
                           normalize({**STEADY_REPORT, "rung": rung}))

        assert [entry["rung"] for entry in bounded.snapshot(limit=100)] == [360, 480, 720]


class TestWhatTheLogLineIsAllowedToSay:
    def test_it_names_the_viewer_the_way_the_log_already_does(self):
        """Emails are already written here (resolve, cookie lending, history).

        This is the boundary the feature must not cross: the identity goes
        to the backend log and to the admin-only endpoint, and nowhere
        else — no file under data/, no database row, no open endpoint.
        """
        line = describe("movies", "person@example.com", normalize(STEADY_REPORT))
        assert "person@example.com" in line
        assert line.count("\n") == 0

    def test_a_first_report_is_always_notable(self):
        assert is_notable(None, normalize(STEADY_REPORT))
