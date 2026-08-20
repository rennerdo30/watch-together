#!/usr/bin/env bash
# Report what is on the deployment host: containers, images, and which
# .env keys are set. Secret VALUES are never printed — only whether a key
# has one and how long it is — so this is safe to run and paste.
#
# Usage:
#   ./deploy/host-status.sh
#   ./deploy/host-status.sh --logs=backend      # tail one service's log
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

for arg in "$@"; do
	case "$arg" in
		--user=*)   SSH_USER="${arg#--user=}" ;;
		--host=*)   SSH_HOST="${arg#--host=}" ;;
		--remote=*) REMOTE="${arg#--remote=}" ;;
		--logs=*)   LOGS_SERVICE="${arg#--logs=}" ;;
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
	 bash -s" <<'REMOTE_SCRIPT'
set -u
REMOTE="$WT_REMOTE"
LOGS_SERVICE="${WT_LOGS:-}"
COMPOSE="docker compose -f deploy/docker-compose.yml --env-file ${REMOTE}/.env"

if [ -n "$LOGS_SERVICE" ]; then
	cd "$REMOTE" || exit 1
	echo "── ${LOGS_SERVICE} log (last 40 lines) ───────────"
	$COMPOSE logs --tail 40 "$LOGS_SERVICE" 2>&1
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
