#!/usr/bin/env bash
# Report what is on the deployment host: containers, images, and which
# .env keys are set. Secret VALUES are never printed — only whether a key
# has one and how long it is — so this is safe to run and paste.
#
# Usage:
#   ./deploy/host-status.sh
#   ./deploy/host-status.sh --logs=backend      # tail one service's log
#   ./deploy/host-status.sh --logs=backend --tail=200
#   ./deploy/host-status.sh --probe=/api/rooms   # ask the backend from inside
#   ./deploy/host-status.sh --diag               # yt-dlp / PO provider diagnostics
#   ./deploy/host-status.sh --clients=<video-url> [--as=<email>]
#                                                 # which clients resolve, optionally
#                                                 # using that user's cookies
#   ./deploy/host-status.sh --legacy-data         # what the pre-volume deploy left behind
#   ./deploy/host-status.sh --cookies             # per-user cookie state (never values)
#   ./deploy/host-status.sh --manifest=<video-url> # inspect the generated DASH manifest
#   ./deploy/host-status.sh --ranges=<video-url>   # re-fetch each declared range upstream
#   ./deploy/host-status.sh --host=10.0.0.5 --user=admin

set -euo pipefail

TARGET_FILE="$(dirname "$0")/target.env"
if [ -f "$TARGET_FILE" ]; then
	# shellcheck disable=SC1090
	. "$TARGET_FILE"
fi

SSH_USER="${DEPLOY_USER:-root}"
SSH_HOST="${DEPLOY_HOST:-}"
REMOTE="${DEPLOY_REMOTE:-/opt/watch-together}"

LOGS_SERVICE=""
TAIL_LINES=40
PROBE_PATH=""
RUN_DIAG=0
CLIENTS_URL=""
AS_USER=""
SHOW_LEGACY=0
SHOW_COOKIES=0
MANIFEST_URL=""
RANGES_URL=""

for arg in "$@"; do
	case "$arg" in
		--user=*)   SSH_USER="${arg#--user=}" ;;
		--host=*)   SSH_HOST="${arg#--host=}" ;;
		--remote=*) REMOTE="${arg#--remote=}" ;;
		--logs=*)   LOGS_SERVICE="${arg#--logs=}" ;;
		--tail=*)   TAIL_LINES="${arg#--tail=}" ;;
		--probe=*)  PROBE_PATH="${arg#--probe=}" ;;
		--diag)     RUN_DIAG=1 ;;
		--clients=*) CLIENTS_URL="${arg#--clients=}" ;;
		--as=*) AS_USER="${arg#--as=}" ;;
		--legacy-data) SHOW_LEGACY=1 ;;
		--cookies) SHOW_COOKIES=1 ;;
		--manifest=*) MANIFEST_URL="${arg#--manifest=}" ;;
		--ranges=*) RANGES_URL="${arg#--ranges=}" ;;
	esac
done

if [ -z "$SSH_HOST" ]; then
	echo "✗ no deployment host set (deploy/target.env or --host=)." >&2
	exit 1
fi

# Env assignments rather than positional args: ssh flattens its command
# into one string, so an empty argument would silently shift the rest.
ssh -o BatchMode=yes -o ConnectTimeout=15 "${SSH_USER}@${SSH_HOST}" \
	"WT_REMOTE=$(printf '%q' "$REMOTE") \
	 WT_LOGS=$(printf '%q' "$LOGS_SERVICE") \
	 WT_TAIL=$(printf '%q' "$TAIL_LINES") \
	 WT_PROBE=$(printf '%q' "$PROBE_PATH") \
	 WT_DIAG=$(printf '%q' "$RUN_DIAG") \
	 WT_CLIENTS_URL=$(printf '%q' "$CLIENTS_URL") \
	 WT_AS_USER=$(printf '%q' "$AS_USER") \
	 WT_LEGACY=$(printf '%q' "$SHOW_LEGACY") \
	 WT_COOKIES=$(printf '%q' "$SHOW_COOKIES") \
	 WT_MANIFEST_URL=$(printf '%q' "$MANIFEST_URL") \
	 WT_RANGES_URL=$(printf '%q' "$RANGES_URL") \
	 bash -s" <<'REMOTE_SCRIPT'
set -u
REMOTE="$WT_REMOTE"
LOGS_SERVICE="${WT_LOGS:-}"
TAIL_LINES="${WT_TAIL:-40}"
PROBE_PATH="${WT_PROBE:-}"
RUN_DIAG="${WT_DIAG:-0}"
CLIENTS_URL="${WT_CLIENTS_URL:-}"
AS_USER="${WT_AS_USER:-}"
SHOW_LEGACY="${WT_LEGACY:-0}"
SHOW_COOKIES="${WT_COOKIES:-0}"
MANIFEST_URL="${WT_MANIFEST_URL:-}"
RANGES_URL="${WT_RANGES_URL:-}"
COMPOSE="docker compose -f deploy/docker-compose.yml --env-file ${REMOTE}/.env"

if [ -n "$LOGS_SERVICE" ]; then
	cd "$REMOTE" || exit 1
	echo "── ${LOGS_SERVICE} log (last ${TAIL_LINES} lines) ───────────"
	$COMPOSE logs --tail "$TAIL_LINES" "$LOGS_SERVICE" 2>&1
	exit 0
fi

# Ask the backend directly, from inside the network. This bypasses
# Cloudflare Access, which otherwise makes the API untestable without a
# browser session.
if [ -n "$PROBE_PATH" ]; then
	cd "$REMOTE" || exit 1
	echo "── GET http://backend:8000${PROBE_PATH} ──────────"
	$COMPOSE exec -T nginx sh -c "wget -q -T 120 -O - 'http://backend:8000${PROBE_PATH}' 2>&1 || echo '(request failed)'"
	exit 0
fi

# Whether a video resolves at all depends on the requesting user having
# usable cookies, since the server's address is bot-blocked by YouTube.
# Values are never printed, only presence, size and age.
if [ "$SHOW_COOKIES" = "1" ]; then
	cd "$REMOTE" || exit 1
	echo "-- cookie files in the data volume --"
	$COMPOSE exec -T backend python - <<'PYEOF'
import os, time, glob
from core.config import COOKIES_DIR

paths = sorted(glob.glob(os.path.join(COOKIES_DIR, "*.txt")))
if not paths:
    print("(none) - no user has synced cookies, so YouTube sees an")
    print("        anonymous datacenter address and refuses most videos")
for path in paths:
    stat = os.stat(path)
    with open(path, "r", errors="replace") as handle:
        lines = [l for l in handle if l.strip() and not l.startswith("#")]
    hosts = sorted({l.split("\t")[0] for l in lines if "\t" in l})
    age_hours = (time.time() - stat.st_mtime) / 3600
    print("%-34s %6d cookies  %5.1fh old  mode %o" % (
        os.path.basename(path), len(lines), age_hours, stat.st_mode & 0o777))
    print("     domains: %s" % ", ".join(hosts[:8]))
    # Expiry is the usual reason a working setup stops working.
    now = time.time()
    expired = 0
    soonest = None
    for l in lines:
        parts = l.split("\t")
        if len(parts) == 7 and parts[4].isdigit():
            exp = int(parts[4])
            if exp and exp < now:
                expired += 1
            elif exp:
                soonest = exp if soonest is None else min(soonest, exp)
    print("     expired: %d   next expiry: %s" % (
        expired,
        time.strftime("%Y-%m-%d", time.localtime(soonest)) if soonest else "n/a"))
PYEOF
	exit 0
fi

# Ask the upstream for exactly the byte ranges the manifest declares. A
# manifest can be structurally perfect and still unplayable if the CDN
# refuses those ranges, and only the origin can answer that.
if [ -n "$RANGES_URL" ]; then
	cd "$REMOTE" || exit 1
	echo "-- declared ranges, re-fetched upstream --"
	$COMPOSE exec -T -e WT_URL="$RANGES_URL" backend python - <<'PYEOF'
import asyncio, os, logging
logging.disable(logging.WARNING)
import httpx
from services.database import get_cached_format
from services.manifest import probe_index, clear_index_cache
from services.upstream import open_upstream_stream

URL = os.environ["WT_URL"]
HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.youtube.com/"}

async def check(client, label, url):
    clear_index_cache()
    index = await probe_index(client, url, HEADERS)
    if index is None:
        print("%-8s no fMP4 index found (not a fragmented MP4?)" % label)
        return
    for what, rng in (("init", index.init_range), ("index", index.index_range)):
        try:
            resp, _ = await open_upstream_stream(
                client, url, {**HEADERS, "Range": f"bytes={rng}"})
            body = await resp.aread()
            await resp.aclose()
            print("%-8s %-6s bytes=%-14s -> %s  got %d bytes  content-range=%s"
                  % (label, what, rng, resp.status_code, len(body),
                     resp.headers.get("content-range")))
        except Exception as exc:
            print("%-8s %-6s bytes=%-14s -> ERROR %s" % (label, what, rng, exc))

async def main():
    cached = await get_cached_format(URL)
    if not cached:
        print("not resolved yet")
        return
    async with httpx.AsyncClient(follow_redirects=False, timeout=30) as c:
        for q in (cached.get("available_qualities") or [])[:3]:
            await check(c, "v:%s" % q.get("format_id"), q.get("video_url"))
        for a in (cached.get("audio_options") or [])[:3]:
            await check(c, "a:%s" % a.get("format_id"), a.get("audio_url"))

asyncio.run(main())
PYEOF
	exit 0
fi

# Build the manifest the player would receive, in the container that has to
# build it. Going through the HTTP endpoint would need a browser session,
# since Cloudflare Access gates it.
if [ -n "$MANIFEST_URL" ]; then
	cd "$REMOTE" || exit 1
	echo "-- generated manifest --"
	$COMPOSE exec -T -e WT_URL="$MANIFEST_URL" backend python - <<'PYEOF'
import asyncio, os, re, logging
logging.disable(logging.WARNING)
import httpx
from services.database import get_cached_format
from services.manifest import build_manifest_for_formats
from core.config import MANIFEST_MAX_VIDEO_REPRESENTATIONS, MANIFEST_MAX_AUDIO_REPRESENTATIONS

URL = os.environ["WT_URL"]

async def main():
    cached = await get_cached_format(URL)
    if not cached:
        print("not resolved yet - call /api/resolve first")
        return
    print("duration:", cached.get("duration"), "| stream_type:", cached.get("stream_type"))
    vids = [{"id": q.get("format_id"), "url": q.get("video_url"), "width": q.get("width"),
             "height": q.get("height"), "vcodec": q.get("vcodec"), "tbr": q.get("tbr"),
             "fps": q.get("fps")}
            for q in (cached.get("available_qualities") or [])[:MANIFEST_MAX_VIDEO_REPRESENTATIONS]]
    auds = [{"id": a.get("format_id"), "url": a.get("audio_url"), "acodec": a.get("acodec"),
             "abr": a.get("abr"), "asr": a.get("asr"), "audio_channels": a.get("audio_channels")}
            for a in (cached.get("audio_options") or [])[:MANIFEST_MAX_AUDIO_REPRESENTATIONS]]
    print("candidates: video=%d audio=%d" % (len(vids), len(auds)))
    async with httpx.AsyncClient(follow_redirects=False, timeout=30) as c:
        mpd = await build_manifest_for_formats(
            c, float(cached["duration"]), vids, auds, "/api/proxy?url=",
            {"User-Agent": "Mozilla/5.0", "Referer": "https://www.youtube.com/"})
    # AdaptationSet grouping matters: representations inside one set must
    # share a codec, or the player appends one codec into the other's buffer.
    for m in re.finditer(r'<AdaptationSet ([^>]*)>|<Representation ([^>]*)>', mpd):
        if m.group(1):
            ct = re.search(r'contentType="(\w+)"', m.group(1))
            print("  [set] contentType=%s" % (ct.group(1) if ct else "?"))
    for m in re.finditer(r'<Representation ([^>]*)>', mpd):
        attrs = dict(re.findall(r'(\w+)="([^"]*)"', m.group(1)))
        print("  rep id=%s h=%s codecs=%s bw=%s" % (attrs.get("id"), attrs.get("height"),
              attrs.get("codecs"), attrs.get("bandwidth")))
    for m in re.finditer(r'<SegmentBase indexRange="([^"]*)"[^>]*>\s*<Initialization range="([^"]*)"', mpd):
        print("  segmentbase index=%s init=%s" % (m.group(1), m.group(2)))
    print("total length:", len(mpd))

asyncio.run(main())
PYEOF
	exit 0
fi

# The stack before this one wrote into ./data on the host; the current one
# uses a named volume. Cookies and rooms from the old location are still
# there and are worth carrying over rather than re-uploading.
if [ "$SHOW_LEGACY" = "1" ]; then
	echo "-- legacy ${REMOTE}/data --"
	if [ -d "${REMOTE}/data" ]; then
		find "${REMOTE}/data" -maxdepth 2 \( -name '*.db' -o -name '*.txt' -o -type d \) \
			-printf '%10s  %p\n' 2>/dev/null | head -25
		echo "-- cookie files --"
		ls -la "${REMOTE}/data/cookies" 2>/dev/null | head -10 || echo "(no cookies dir)"
	else
		echo "(no legacy data dir)"
	fi
	echo
	echo "-- current volume --"
	docker run --rm -v watch-together_backend_data:/d alpine sh -c \
		"find /d -maxdepth 2 -printf '%10s  %p\n' 2>/dev/null | head -20" 2>/dev/null \
		|| echo "(could not read volume)"
	exit 0
fi

# Which player clients actually resolve, measured in the container that
# has to do it. The PO token provider only serves WebPO clients, and
# yt-dlp changes its default selection between releases, so this question
# has to be asked of production rather than a workstation.
if [ -n "$CLIENTS_URL" ]; then
	cd "$REMOTE" || exit 1
	echo "-- player client matrix --"
	$COMPOSE exec -T -e WT_URL="$CLIENTS_URL" -e WT_AS="$AS_USER" backend python - <<'PYEOF'
import os, logging
logging.disable(logging.WARNING)
import yt_dlp
from core.config import POT_PROVIDER_EXTRACTOR_ARGS
from services.resolver import _extract_stream_url
from core.security import get_user_cookie_path

URL = os.environ["WT_URL"]
# The server's address is bot-blocked by YouTube, so whether a video
# resolves usually comes down to the requesting user's cookies.
COOKIEFILE = None
as_user = os.environ.get("WT_AS") or ""
if as_user:
    path = get_user_cookie_path(as_user)
    if path and os.path.exists(path):
        COOKIEFILE = path
        print("using cookies for %s" % as_user)
    else:
        print("no cookie file for %s" % as_user)
else:
    print("no user given: resolving anonymously")
cases = {
    "yt-dlp defaults": None,
    "web": ["web"],
    "mweb": ["mweb"],
    "tv": ["tv"],
    "web_safari": ["web_safari"],
    "web_embedded": ["web_embedded"],
    "tv,web": ["tv", "web"],
    "mweb,web,tv": ["mweb", "web", "tv"],
}
for label, clients in cases.items():
    args = dict(POT_PROVIDER_EXTRACTOR_ARGS)
    if clients:
        args["youtube"] = {"player_client": clients}
    opts = {"quiet": True, "no_warnings": True, "skip_download": True,
            "nocheckcertificate": True, "socket_timeout": 30,
            "ignore_no_formats_error": True, "extractor_args": args}
    if COOKIEFILE:
        opts["cookiefile"] = COOKIEFILE
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(URL, download=False, process=False)
        si = _extract_stream_url(info)
        n = len(info.get("formats") or [])
        print("%-16s formats=%3d type=%s h=%s" % (label, n, si and si.get("type"), si and si.get("height")))
    except Exception as e:
        print("%-16s ERROR %s: %s" % (label, type(e).__name__, str(e)[:60]))
PYEOF
	exit 0
fi

# Version and reachability of the pieces YouTube resolution depends on.
# The PO token provider is a separate service, so "works locally" says
# nothing about whether the backend container can reach it.
if [ "$RUN_DIAG" = "1" ]; then
	cd "$REMOTE" || exit 1
	echo "── resolution diagnostics (inside backend) ───────"
	$COMPOSE exec -T backend python - <<'PYEOF'
import json, os, sys
import urllib.request

print("python           ", sys.version.split()[0])
try:
    import yt_dlp
    print("yt-dlp          ", yt_dlp.version.__version__)
except Exception as e:
    print("yt-dlp           IMPORT FAILED:", e)

for mod in ("requests", "urllib3", "curl_cffi", "websockets", "brotli"):
    try:
        __import__(mod)
        print(f"{mod:16} present")
    except Exception:
        print(f"{mod:16} MISSING")

url = os.environ.get("BGUTIL_YTDLP_POT_PROVIDER_URL", "(unset)")
print("provider env     ", url)
if url != "(unset)":
    try:
        with urllib.request.urlopen(url.rstrip('/') + "/ping", timeout=5) as r:
            print("provider ping    ", r.status, json.load(r))
    except Exception as e:
        print("provider ping     FAILED:", type(e).__name__, e)

try:
    from core.config import POT_PROVIDER_EXTRACTOR_ARGS
    print("extractor args   ", POT_PROVIDER_EXTRACTOR_ARGS)
except Exception as e:
    print("extractor args    FAILED:", e)

# Does yt-dlp itself have a usable request handler in this environment?
try:
    from yt_dlp.networking import Request
    ydl = yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True})
    resp = ydl.urlopen(Request(url.rstrip('/') + "/ping"))
    print("yt-dlp urlopen   ", resp.status)
except Exception as e:
    print("yt-dlp urlopen    FAILED:", type(e).__name__, e)
PYEOF
	exit 0
fi

echo "── host ──────────────────────────────────────────"
hostname
docker --version

echo
echo "── running containers ────────────────────────────"
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' || true

echo
echo "── compose projects present ──────────────────────"
docker compose ls 2>/dev/null || true

echo
echo "── ${REMOTE} ─────────────────────────────────────"
ls -la "$REMOTE" 2>/dev/null | head -20 || echo "(missing)"

echo
echo "── ${REMOTE}/.env keys (values never shown) ──────"
if [ -f "$REMOTE/.env" ]; then
	# Print each key with whether it holds a value and its length. Length
	# is enough to tell a real token from a placeholder without revealing it.
	while IFS= read -r line; do
		key="${line%%=*}"
		val="${line#*=}"
		if [ -n "$val" ]; then
			printf '%s = SET (%d chars)\n' "$key" "${#val}"
		else
			printf '%s = (empty)\n' "$key"
		fi
	done < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$REMOTE/.env")
	echo "--- permissions:"
	stat -c '%a %U:%G' "$REMOTE/.env" 2>/dev/null || true
else
	echo "(no .env yet)"
fi

echo
echo "── docker volumes ────────────────────────────────"
docker volume ls --format '{{.Name}}' | grep -i -E 'watch|w2g' || echo "(none matching)"
REMOTE_SCRIPT
