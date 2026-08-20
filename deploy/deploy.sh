#!/usr/bin/env bash
# Full production deploy — single-command orchestration.
#
# Pipeline:
#   1. Verify SSH access to the host.
#   2. Rsync the bundle via deploy/sync.sh.
#   3. Ensure /opt/watch-together/.env exists and has the required keys.
#   4. docker compose up -d --build (volumes survive).
#   5. Wait for the backend to answer on the internal network.
#   6. Probe https://<WT_HOST>/ and report the status.
#
# Usage:
#   ./deploy/deploy.sh                     # full deploy
#   ./deploy/deploy.sh --skip-sync         # remote-only, files already there
#   ./deploy/deploy.sh --reset-data        # NUKE the backend data volume
#   ./deploy/deploy.sh --user=admin --host=10.0.0.5   # override target.env
#   ./deploy/deploy.sh --dry-run           # rsync dry-run, no remote actions
#
# Idempotent: every step is safe to re-run. The backend data volume (SQLite
# database, per-user cookies, segment cache) survives deploys unless
# --reset-data is passed.

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
SKIP_SYNC=0
RESET_DATA=0
DRY_RUN=0

for arg in "$@"; do
	case "$arg" in
		--user=*)     SSH_USER="${arg#--user=}" ;;
		--host=*)     SSH_HOST="${arg#--host=}" ;;
		--remote=*)   REMOTE="${arg#--remote=}" ;;
		--skip-sync)  SKIP_SYNC=1 ;;
		--reset-data) RESET_DATA=1 ;;
		--dry-run)    DRY_RUN=1 ;;
		-h|--help)
			grep -E '^# ' "$0" | sed 's/^# \?//'
			exit 0
			;;
		*)
			echo "Unknown flag: $arg" >&2
			echo "Try $0 --help" >&2
			exit 1
			;;
	esac
done

if [ -z "$SSH_HOST" ]; then
	red() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; }
	red "✗ no deployment host set."
	red "  cp deploy/target.env.example deploy/target.env  and fill it in,"
	red "  or pass --host=<address> [--user=<login>]."
	exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=15 ${SSH_USER}@${SSH_HOST}"

# Compose reads `.env` from the project directory, which defaults to the
# directory holding the compose file — /opt/watch-together/deploy — so an
# .env one level up would be ignored and every ${VAR:?required} would fail.
# --env-file points at the real file WITHOUT moving the project directory,
# so the relative build contexts (../backend, ../frontend, ../nginx) still
# resolve. --project-directory would repoint those and break the build.
COMPOSE="docker compose -f deploy/docker-compose.yml --env-file ${REMOTE}/.env"

bold()   { printf '\033[1m%s\033[0m\n' "$*"; }
green()  { printf '\033[1;32m%s\033[0m\n' "$*"; }
red()    { printf '\033[1;31m%s\033[0m\n' "$*" >&2; }
yellow() { printf '\033[1;33m%s\033[0m\n' "$*"; }

# ── 1. SSH reachability ────────────────────────────────────────────────
bold "[1/6] Verifying SSH access to ${SSH_USER}@${SSH_HOST}"
if [ "$DRY_RUN" -eq 1 ]; then
	yellow "  (--dry-run — skipping)"
elif ! $SSH true 2>/dev/null; then
	red "  Cannot SSH to ${SSH_USER}@${SSH_HOST}. Check the key is loaded and the host is up."
	exit 1
else
	green "  ✓ SSH OK"
fi

# ── 2. file sync ───────────────────────────────────────────────────────
bold "[2/6] Sync repo to ${SSH_USER}@${SSH_HOST}:${REMOTE}/"
if [ "$SKIP_SYNC" -eq 1 ]; then
	yellow "  (--skip-sync — using files already on the host)"
else
	sync_args=( --user="${SSH_USER}" --host="${SSH_HOST}" --remote="${REMOTE}" )
	[ "$DRY_RUN" -eq 1 ] && sync_args+=( --dry-run )
	WT_DEPLOY_ORCHESTRATED=1 "${REPO_ROOT}/deploy/sync.sh" "${sync_args[@]}"
fi

# ── 3. .env presence and required keys ─────────────────────────────────
bold "[3/6] Checking ${REMOTE}/.env"
if [ "$DRY_RUN" -eq 1 ]; then
	yellow "  (--dry-run — skipping)"
else
	env_status=$($SSH "
		set -e
		mkdir -p ${REMOTE}
		if [ ! -f ${REMOTE}/.env ]; then
			cp ${REMOTE}/deploy/env.example ${REMOTE}/.env 2>/dev/null || true
			chmod 600 ${REMOTE}/.env 2>/dev/null || true
			echo CREATED
		fi
		for key in WT_HOST CLOUDFLARED_TOKEN; do
			val=\$(grep -E \"^\${key}=\" ${REMOTE}/.env 2>/dev/null | head -1 | cut -d= -f2-)
			val=\$(echo \"\$val\" | tr -d '\"' | tr -d \"'\" | sed 's/^[[:space:]]*//;s/[[:space:]]*\$//')
			[ -z \"\$val\" ] && echo \"MISSING:\$key\"
		done
		exit 0
	")

	if echo "$env_status" | grep -q CREATED; then
		yellow "  ${REMOTE}/.env created from env.example."
	fi

	missing=$(echo "$env_status" | sed -n 's/^MISSING://p' || true)
	if [ -n "$missing" ]; then
		red "  Missing required values in ${REMOTE}/.env:"
		echo "$missing" | while read -r k; do red "    - $k"; done
		red ""
		red "  CLOUDFLARED_TOKEN comes from Cloudflare Zero Trust →"
		red "  Networks → Tunnels → your tunnel → Install connector (Docker)."
		red "  Bind a public hostname on that tunnel to  HTTP  nginx:80"
		red ""
		red "  Then edit it on the host:"
		red "    ssh ${SSH_USER}@${SSH_HOST} 'nano ${REMOTE}/.env'"
		exit 1
	fi
	green "  ✓ required keys present"
fi

# ── 4. optional data reset ─────────────────────────────────────────────
if [ "$RESET_DATA" -eq 1 ]; then
	bold "[4a/6] --reset-data — DESTRUCTIVE: removing the backend data volume"
	if [ "$DRY_RUN" -eq 1 ]; then
		yellow "  (--dry-run — skipping)"
	else
		yellow "  This deletes the room database, every user's stored cookies,"
		yellow "  and the segment cache on ${SSH_HOST}."
		read -r -p "  Type 'yes' to confirm: " confirm
		if [ "$confirm" != "yes" ]; then
			red "  Aborted. Re-run without --reset-data to keep existing data."
			exit 1
		fi
		$SSH "cd ${REMOTE} && ${COMPOSE} down 2>/dev/null || true; docker volume rm watch-together_backend_data 2>/dev/null || true"
		green "  ✓ volume removed"
	fi
fi

# ── 5. build and start ─────────────────────────────────────────────────
bold "[5/6] docker compose up -d --build"
if [ "$DRY_RUN" -eq 1 ]; then
	yellow "  (--dry-run — skipping)"
else
	$SSH "set -e; cd ${REMOTE} && ${COMPOSE} up -d --build"
	green "  ✓ stack up"

	bold "[5b/6] Waiting for the backend to answer"
	backend_ok=0
	for _ in $(seq 1 30); do
		# Asked from inside the network: the backend is not published.
		code=$($SSH "cd ${REMOTE} && ${COMPOSE} exec -T nginx wget -q -O /dev/null -S http://backend:8000/ 2>&1 | sed -n 's/.*HTTP\\/1.1 \\([0-9]*\\).*/\\1/p' | head -1" 2>/dev/null || echo "")
		if [ "$code" = "200" ]; then
			green "  ✓ backend healthy"
			backend_ok=1
			break
		fi
		sleep 2
	done
	if [ "$backend_ok" -eq 0 ]; then
		yellow "  Backend did not answer within 60s. Logs:"
		yellow "    ssh ${SSH_USER}@${SSH_HOST} 'cd ${REMOTE} && ${COMPOSE} logs --tail 40 backend'"
	fi
fi

# ── 6. public probe ────────────────────────────────────────────────────
bold "[6/6] Probing the public hostname"
if [ "$DRY_RUN" -eq 1 ]; then
	yellow "  (--dry-run — skipping)"
else
	wt_host=$($SSH "grep -E '^WT_HOST=' ${REMOTE}/.env | head -1 | cut -d= -f2- | tr -d '\"'\\'' '" || echo "")
	if [ -z "$wt_host" ]; then
		yellow "  WT_HOST not readable from .env — skipping probe."
	else
		echo ""
		# The tunnel needs a few seconds to register its route.
		code=000
		for i in 1 2 3 4 5 6; do
			code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://${wt_host}/" || echo "000")
			case "$code" in
				200|301|302)
					green "  ✓ HTTP ${code}  https://${wt_host}/"
					break
					;;
				# Cloudflare Access sends the browser to its login page, which
				# is the expected answer for an unauthenticated request.
				403)
					green "  ✓ HTTP 403  https://${wt_host}/  (Cloudflare Access is gating it — expected)"
					break
					;;
			esac
			yellow "  attempt $i: HTTP ${code} — retrying in 5s"
			sleep 5
		done
		case "$code" in
			200|301|302|403) ;;
			*)
				red "  Tunnel did not come up cleanly (last status ${code}). Check:"
				red "    ssh ${SSH_USER}@${SSH_HOST} 'cd ${REMOTE} && ${COMPOSE} logs --tail 30 cloudflared'"
				red "  Also confirm the tunnel's public hostname points at  HTTP  nginx:80"
				;;
		esac
	fi
fi

echo ""
green "✓ deploy complete"
