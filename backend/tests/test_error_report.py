"""
`host-status.sh --errors`: the logs, summarised so trouble can be read.

Diagnosing a viewer's broken playback meant scrolling three raw logs: client
errors only in a container log that each deploy discarded, the proxy log
without times or users, refusals logged with nothing but a host name.
"""
import importlib.util
import io
import os
from datetime import datetime, timedelta, timezone

import pytest

SPEC = importlib.util.spec_from_file_location(
    "error_report", os.path.join(os.path.dirname(__file__), "..", "..", "deploy", "error_report.py"))
error_report = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(error_report)

NOW = datetime.now(timezone.utc).replace(microsecond=0)


def stamp(minutes_ago):
    return (NOW - timedelta(minutes=minutes_ago)).strftime("%Y-%m-%dT%H:%M:%S%z")


@pytest.fixture
def log_dir(tmp_path):
    # Rotated: .1 is older than the live file.
    (tmp_path / "warnings.log.1").write_text(
        f'{stamp(300)} WARNING services.client_errors: Client error: {{"source": "shaka", "code": 1001, '
        f'"http_status": 403, "member": "a@example.com", "room": "r1", "count": 2}}\n')
    (tmp_path / "warnings.log").write_text(
        f'{stamp(5)} WARNING services.client_errors: Client error: {{"source": "shaka", "code": 1001, '
        f'"http_status": 403, "member": "b@example.com", "room": "r1", "count": 1, '
        f'"answer": "origin=NOT-REACHED server=cloudflare cf-ray=abc-FRA"}}\n'
        f"{stamp(4)} WARNING main: Refused whole-file media download: user=b@example.com itag=399 "
        f"mime=video/mp4 room=r1 ua=Mozilla\n"
        f"{stamp(3)} ERROR main: Proxy failed for 12345 bytes\n"
        "Traceback (most recent call last):\n  File \"x\", line 1\n"
        f"{stamp(2)} ERROR main: Proxy failed for 999 bytes\n"
        f"{stamp(60 * 48)} WARNING old: outside the window\n")
    return str(tmp_path)


def test_records_are_read_oldest_first_with_tracebacks_attached(log_dir):
    records = error_report.read_records(log_dir)
    assert [r[2] for r in records][:2] == ["services.client_errors", "services.client_errors"]
    assert records[0][0] < records[1][0]
    assert "Traceback" in records[3][3]


def test_the_report_groups_what_matters(log_dir):
    media = [
        f'403 83 bytes request=0.004 upstream=0.004 range="-" cr="-" ua="x" ref="y" "/api/proxy?url=z" '
        f't={NOW.isoformat()} user="b@example.com"',
        f'403 83 bytes request=0.004 upstream=0.004 range="-" cr="-" ua="x" ref="y" "/api/proxy?url=z" '
        f't={NOW.isoformat()} user="b@example.com"',
        '206 100 bytes request=0.01 upstream=0.01 range="bytes=0-99" cr="bytes 0-99/100" ua="x" ref="y" "/api/proxy"',
        '502 0 bytes request=0.01 upstream=- range="bytes=0-9" cr="-" ua="x" ref="y" "/api/proxy"',
    ]
    out = io.StringIO()
    error_report.report(error_report.read_records(log_dir), media, hours=24, disk=(5e8, 2e9), out=out)
    text = out.getvalue()
    # Both client errors are one group, counts summed, both members named.
    assert "    3  shaka    1001" in text and "a@example.com, b@example.com" in text
    assert "    2  403  NO RANGE  b@example.com" in text and "download manager" in text
    assert "(before timestamps were logged)" in text  # The 502 has no t=.
    assert "itags 399" in text
    assert "answered: origin=NOT-REACHED server=cloudflare cf-ray=abc-FRA" in text
    # Messages differing only in numbers are one row; old records are outside the window.
    assert "    2  ERRO main: Proxy failed for # bytes" in text
    assert "outside the window" not in text
    assert "BELOW THE FLOOR" in text
    assert "/api/proxy" not in text and "url=" not in text  # No URLs in the report.


def test_an_empty_or_missing_log_dir_reports_nothing_rather_than_failing(tmp_path):
    out = io.StringIO()
    error_report.report(error_report.read_records(str(tmp_path / "missing")), [], hours=1, out=out)
    assert "(none)" in out.getvalue()
