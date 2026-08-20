#!/usr/bin/env bash
# rsync the Watch Together bundle to /opt/watch-together/ on the host.
#
# Usage:
#   ./deploy/sync.sh                # target from deploy/target.env
#   ./deploy/sync.sh --user=admin --host=10.0.0.5
#   ./deploy/sync.sh --dry-run

set -euo pipefail

# ── Deployment target ────────────────────────────────────────────────
# The host lives in deploy/target.env, which is gitignored: this
# repository is public, so the address and login stay on the machine that
# deploys rather than in the published history. Flags override the file.
TARGET_FILE="$(dirname "$0")/target.env"
if [ -f "$TARGET_FILE" ]; then
	# shellcheck disable=SC1090
	. "$TARGET_FILE"
fi

SSH_USER="${DEPLOY_USER:-root}"
SSH_HOST="${DEPLOY_HOST:-}"
REMOTE="${DEPLOY_REMOTE:-/opt/watch-together}"
DRY_RUN=""

for arg in "$@"; do
	case "$arg" in
		--user=*)   SSH_USER="${arg#--user=}" ;;
		--host=*)   SSH_HOST="${arg#--host=}" ;;
		--remote=*) REMOTE="${arg#--remote=}" ;;
		--dry-run)  DRY_RUN="-n" ;;
	esac
done

if [ -z "$SSH_HOST" ]; then
	echo "✗ no deployment host set." >&2
	echo "  cp deploy/target.env.example deploy/target.env  and fill it in," >&2
	echo "  or pass --host=<address> [--user=<login>]." >&2
	exit 1
fi

cd "$(dirname "$0")/.."  # repo root

DEST="${SSH_USER}@${SSH_HOST}:${REMOTE}/"
echo "→ syncing $(pwd) → ${DEST}"

# ── Connection handling ──────────────────────────────────────────────
# Several rsync calls plus an ssh mkdir in quick succession can trip
# per-IP connection throttling, which shows up as a connect timeout
# partway through rather than an auth error. ControlMaster multiplexes
# them over one TCP connection; keepalives stop an idle NAT timeout from
# tearing down a long transfer.
CM_PATH="${TMPDIR:-/tmp}/wt-cm-%r@%h-%p"
SSH_OPTS=(
	-o ControlMaster=auto
	-o "ControlPath=${CM_PATH}"
	-o ControlPersist=300
	-o ServerAliveInterval=15
	-o ServerAliveCountMax=8
	-o ConnectTimeout=20
)
SSH_CMD="ssh $(printf '%s ' "${SSH_OPTS[@]}")"

cleanup() { ssh -o "ControlPath=${CM_PATH}" -O exit "${SSH_USER}@${SSH_HOST}" 2>/dev/null || true; }
trap cleanup EXIT

# rsync wrapper with bounded retries. `--partial` keeps a half-sent file so
# a resumed run continues instead of restarting it.
#
# FLAG COMPATIBILITY: macOS ships an rsync predating 3.1, so `--info=…` and
# `--human-readable` are unavailable and fail outright. Stick to flags that
# build lists: -a -v --delete --partial --timeout -e --exclude.
RSYNC_MAX_TRIES=3
# Retry transport-ish failures only. A usage error (1) or protocol mismatch
# (2) cannot succeed on retry, so fail fast rather than burning attempts.
RSYNC_RETRY_CODES=" 10 11 12 23 24 30 35 255 "
run_rsync() {
	local try=1 rc
	while true; do
		rsync $DRY_RUN -av --delete --partial --timeout=90 \
			-e "${SSH_CMD}" \
			--exclude='node_modules' \
			--exclude='.next' \
			--exclude='venv' \
			--exclude='__pycache__' \
			--exclude='*.pyc' \
			--exclude='data' \
			--exclude='.env' \
			--exclude='test-results' \
			--exclude='playwright-report' \
			--exclude='*.har' \
			--exclude='*.bak' \
			--exclude='.DS_Store' \
			"$@" && return 0
		rc=$?
		case "$RSYNC_RETRY_CODES" in
			*" $rc "*) ;;  # transient — retry
			*)
				echo "✗ rsync exited ${rc} (not transient) — aborting: $*" >&2
				return "$rc"
				;;
		esac
		if [ "$try" -ge "$RSYNC_MAX_TRIES" ]; then
			echo "✗ rsync failed after ${try} attempts (exit ${rc}): $*" >&2
			return "$rc"
		fi
		echo "  · interrupted (exit ${rc}) — retry $((try + 1))/${RSYNC_MAX_TRIES} in 5s…" >&2
		sleep 5
		try=$((try + 1))
	done
}

ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SSH_HOST}" "mkdir -p ${REMOTE}"

# NO trailing slashes on the sources. `rsync deploy/ dest/` copies the
# CONTENTS of deploy into dest, flattening docker-compose.yml straight into
# /opt/watch-together/; `rsync deploy dest/` copies the directory itself and
# yields /opt/watch-together/deploy/docker-compose.yml. The compose file
# resolves its build contexts relatively (../backend, ../frontend,
# ../nginx), so it only works from inside /opt/watch-together/deploy/.
#
# Directory sources also keep `--delete` scoped: it prunes only within each
# transferred directory and never touches unrelated entries at the
# destination root (such as .env).
run_rsync deploy backend frontend nginx "${DEST}"

echo "✓ sync complete"

# Only advertise next steps when run on its own. deploy.sh calls this as one
# step of its pipeline and sets WT_DEPLOY_ORCHESTRATED, where a "next on
# host" block would contradict the surrounding progress output.
if [ -z "${WT_DEPLOY_ORCHESTRATED:-}" ]; then
	echo ""
	echo "next:"
	echo "  ./deploy/deploy.sh        # build + up + probe"
	echo ""
	echo "or drive the host by hand:"
	echo "  ssh ${SSH_USER}@${SSH_HOST} 'cd ${REMOTE} && docker compose -f deploy/docker-compose.yml --env-file ${REMOTE}/.env up -d --build'"
fi
