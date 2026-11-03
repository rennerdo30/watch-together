"""
What went wrong, for whom, and when: one screen instead of three raw logs.

Run by `./deploy/host-status.sh --errors[=HOURS]` inside the backend
container (working directory /app), with the nginx log on stdin. Reads:

- data/logs/warnings.log* — the backend's warnings and errors, kept across
  deploys (core/persistent_log.py): client errors reported by browsers,
  refused whole-file downloads, failed measurements, tracebacks.
- the nginx media log — every proxied transfer; non-2xx ones are grouped by
  status, by whether a byte range was asked for, and by user. Lines written
  before the format carried `t=` have no time and are counted apart.
- the disk the segment cache lives on, against its floor.

Prints no URLs, cookies or tokens: only identities, rooms, codes and counts.
"""

import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

LOG_DIR = "data/logs"
LOG_NAME = "warnings.log"
RECORD = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d{4}) (WARNING|ERROR|CRITICAL) (\S+): (.*)$")
MEDIA = re.compile(r"^(\d{3}) (\d+) bytes ")
REFUSAL = re.compile(r"Refused whole-file media download: user=(\S+) itag=(\S+) mime=(\S+) room=(\S+)")
MAX_ROWS = 20


class Group:
    """Count, first and last time, and a few distinct values per field."""

    def __init__(self):
        self.count = 0
        self.first = None
        self.last = None
        self.values = defaultdict(set)

    def add(self, when, count=1, **fields):
        self.count += count
        if when is not None:
            self.first = when if self.first is None else min(self.first, when)
            self.last = when if self.last is None else max(self.last, when)
        for name, value in fields.items():
            if value not in (None, "", "-"):
                self.values[name].add(str(value))

    def describe(self, name, limit=4):
        values = sorted(self.values.get(name, ()))
        if not values:
            return "-"
        more = f" +{len(values) - limit}" if len(values) > limit else ""
        return ", ".join(values[:limit]) + more


def _time(when):
    return when.astimezone(timezone.utc).strftime("%m-%d %H:%M") if when else "  (no time)"


def _span(group):
    return f"{_time(group.first)} → {_time(group.last)}" if group.first else "(before timestamps were logged)"


def read_records(log_dir=LOG_DIR, since=None):
    """(time, level, logger, message) from the rotated files, oldest first."""
    names = sorted((n for n in os.listdir(log_dir) if n.startswith(LOG_NAME)) if os.path.isdir(log_dir) else [],
                   key=lambda n: -int(n.rsplit(".", 1)[1]) if n[len(LOG_NAME):].startswith(".") else 0)
    records = []
    for name in names:
        with open(os.path.join(log_dir, name), encoding="utf-8", errors="replace") as file:
            for line in file:
                match = RECORD.match(line.rstrip("\n"))
                if match:
                    when = datetime.strptime(match[1], "%Y-%m-%dT%H:%M:%S%z")
                    records.append([when, match[2], match[3], match[4]])
                elif records and line.strip():
                    records[-1][3] += "\n" + line.rstrip("\n")  # A traceback's continuation.
    return [tuple(r) for r in records if since is None or r[0] >= since]


def normalise(message):
    """One shape for messages that differ only in numbers, URLs or quoted values."""
    first = message.split("\n", 1)[0]
    first = re.sub(r"https?://\S+", "<url>", first)
    first = re.sub(r"'[^']*'|\"[^\"]*\"", "<…>", first)
    first = re.sub(r"\d+(\.\d+)?", "#", first)
    return first[:140]


def summarise_backend(records):
    client, refused, other = defaultdict(Group), defaultdict(Group), defaultdict(Group)
    for when, level, logger, message in records:
        if message.startswith("Client error: "):
            try:
                event = json.loads(message[len("Client error: "):])
            except ValueError:
                event = {"message": message}
            key = (event.get("source", "?"), str(event.get("code") or event.get("message", "?"))[:70],
                   event.get("http_status") or "")
            client[key].add(when, int(event.get("count") or 1), member=event.get("member"), room=event.get("room"),
                            answer=event.get("answer"))
            continue
        match = REFUSAL.search(message)
        if match:
            refused[match[1]].add(when, itag=match[2], room=match[4])
            continue
        other[(level, logger, normalise(message))].add(when)
    return client, refused, other


def summarise_media(lines, since=None):
    """Non-2xx proxied transfers by (status, ranged?, user), and the 2xx total."""
    failed, ok = defaultdict(Group), 0
    for line in lines:
        match = MEDIA.match(line)
        if not match:
            continue
        stamp = re.search(r" t=(\S+)", line)
        when = datetime.fromisoformat(stamp[1]) if stamp else None
        if since is not None and when is not None and when < since:
            continue
        status = int(match[1])
        if 200 <= status < 300 or status == 304:
            ok += 1
            continue
        user = re.search(r' user="([^"]*)"', line)
        ranged = "ranged" if 'range="bytes' in line or "%26range%3D" in line else "NO RANGE"
        failed[(status, ranged, (user[1] if user and user[1] else "?"))].add(when)
    return failed, ok


def report(records, media_lines, hours, disk=None, out=sys.stdout):
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    records = [r for r in records if r[0] >= since]
    client, refused, other = summarise_backend(records)
    failed, ok = summarise_media(media_lines, since)
    write = lambda text="": print(text, file=out)  # noqa: E731

    write(f"── client errors reported by browsers (last {hours} h) ───────────")
    if not client:
        write("(none)")
    for (source, what, status), group in sorted(client.items(), key=lambda kv: -kv[1].count)[:MAX_ROWS]:
        write(f"{group.count:5}  {source:8} {what:40} {('HTTP ' + str(status)) if status else '':9} {_span(group)}")
        write(f"       members: {group.describe('member')}   rooms: {group.describe('room')}")
        if group.values.get("answer"):
            write(f"       answered: {group.describe('answer', 3)}")
    write()
    write("── proxied media requests that failed (nginx) ───────────")
    if not failed:
        write(f"(none; {ok} succeeded)")
    else:
        write(f"{ok} succeeded. Failed, by status / range / user:")
    for (status, ranged, user), group in sorted(failed.items(), key=lambda kv: -kv[1].count)[:MAX_ROWS]:
        hint = "  ← a download manager, refused on purpose" if status == 403 and ranged == "NO RANGE" else ""
        write(f"{group.count:5}  {status}  {ranged:8}  {user:32} {_span(group)}{hint}")
    write()
    write("── whole-file downloads refused, by user ───────────")
    if not refused:
        write("(none)")
    for user, group in sorted(refused.items(), key=lambda kv: -kv[1].count):
        write(f"{group.count:5}  {user:32} itags {group.describe('itag', 6):24} {_span(group)}")
    write()
    write("── other backend warnings and errors ───────────")
    if not other:
        write("(none)")
    for (level, logger, message), group in sorted(other.items(), key=lambda kv: -kv[1].count)[:MAX_ROWS]:
        write(f"{group.count:5}  {level[:4]} {logger}: {message}   [{_span(group)}]")
    if disk is not None:
        free, floor = disk
        write()
        write("── disk ───────────")
        state = "ok" if free > floor else "BELOW THE FLOOR: the segment cache is switched off"
        write(f"{free / 1e9:.1f} GB free, floor {floor / 1e9:.1f} GB — {state}")


def main():
    hours = float(os.environ.get("WT_ERROR_HOURS") or 24)
    disk = None
    try:
        sys.path.insert(0, os.getcwd())
        from core.config import MIN_DISK_FREE_BYTES
        from services.cache import check_disk_space
        disk = (check_disk_space()[1], MIN_DISK_FREE_BYTES)
    except Exception as error:  # Report what can be reported.
        print(f"(disk state unavailable: {error})")
    media = [] if sys.stdin.isatty() else sys.stdin.read().splitlines()
    report(read_records(), media, hours, disk)


if __name__ == "__main__":
    main()
