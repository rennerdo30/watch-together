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
#   ./deploy/host-status.sh --clients=<video-url> # which player clients resolve
#   ./deploy/host-status.sh --legacy-data         # what the pre-volume deploy left behind
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
SHOW_LEGACY=0

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
		--legacy-data) SHOW_LEGACY=1 ;;
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
	 WT_LEGACY=$(printf '%q' "$SHOW_LEGACY") \
	 bash -s" <<'REMOTE_SCRIPT'
set -u
REMOTE="$WT_REMOTE"
LOGS_SERVICE="${WT_LOGS:-}"
TAIL_LINES="${WT_TAIL:-40}"
PROBE_PATH="${WT_PROBE:-}"
RUN_DIAG="${WT_DIAG:-0}"
CLIENTS_URL="${WT_CLIENTS_URL:-}"
SHOW_LEGACY="${WT_LEGACY:-0}"
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
	$COMPOSE exec -T -e WT_URL="$CLIENTS_URL" backend python - <<'PYEOF'
import os, logging
logging.disable(logging.WARNING)
import yt_dlp
from core.config import POT_PROVIDER_EXTRACTOR_ARGS
from services.resolver import _extract_stream_url

URL = os.environ["WT_URL"]
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
