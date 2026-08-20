#!/usr/bin/env bash
# Build and install /opt/watch-together/.env on the host.
#
# Carries values over from whatever is already there, including the older
# deployment's variable names, so an existing Cloudflare tunnel token is
# reused rather than re-fetched:
#
#   CLOUDFLARED_TOKEN  ←  CLOUDFLARED_TOKEN, else the older TUNNEL_TOKEN
#   WT_HOST            ←  WT_HOST, else --wt-host, else the env.example default
#   CF_ACCESS_*        ←  preserved when already set
#
# Secret values are never printed: the summary reports only whether a key
# holds a value and how long it is. The file is written mode 600.
#
# Usage:
#   ./deploy/make-env.sh                          # build, keep existing values
#   ./deploy/make-env.sh --wt-host=w2g.renner.dev
#   ./deploy/make-env.sh --cf-team=https://TEAM.cloudflareaccess.com --cf-aud=AUDTAG
#   ./deploy/make-env.sh --show                   # report current state only

set -euo pipefail

TARGET_FILE="$(dirname "$0")/target.env"
if [ -f "$TARGET_FILE" ]; then
	# shellcheck disable=SC1090
	. "$TARGET_FILE"
fi

SSH_USER="${DEPLOY_USER:-root}"
SSH_HOST="${DEPLOY_HOST:-}"
REMOTE="${DEPLOY_REMOTE:-/opt/watch-together}"
WT_HOST_ARG=""
CF_TEAM_ARG=""
CF_AUD_ARG=""
SHOW_ONLY=0

for arg in "$@"; do
	case "$arg" in
		--user=*)    SSH_USER="${arg#--user=}" ;;
		--host=*)    SSH_HOST="${arg#--host=}" ;;
		--remote=*)  REMOTE="${arg#--remote=}" ;;
		--wt-host=*) WT_HOST_ARG="${arg#--wt-host=}" ;;
		--cf-team=*) CF_TEAM_ARG="${arg#--cf-team=}" ;;
		--cf-aud=*)  CF_AUD_ARG="${arg#--cf-aud=}" ;;
		--show)      SHOW_ONLY=1 ;;
		-h|--help)
			grep -E '^# ' "$0" | sed 's/^# \?//'
			exit 0
			;;
	esac
done

if [ -z "$SSH_HOST" ]; then
	echo "✗ no deployment host set (deploy/target.env or --host=)." >&2
	exit 1
fi

# Values are passed as environment assignments rather than positional
# arguments: ssh joins its command words into one string for the remote
# shell, so an empty argument disappears and everything after it shifts
# down a place — which silently turned --show into a write.
ssh -o BatchMode=yes -o ConnectTimeout=15 "${SSH_USER}@${SSH_HOST}" \
	"WT_REMOTE=$(printf '%q' "$REMOTE") \
	 WT_HOST_ARG=$(printf '%q' "$WT_HOST_ARG") \
	 CF_TEAM_ARG=$(printf '%q' "$CF_TEAM_ARG") \
	 CF_AUD_ARG=$(printf '%q' "$CF_AUD_ARG") \
	 WT_SHOW_ONLY=$(printf '%q' "$SHOW_ONLY") \
	 bash -s" <<'REMOTE_SCRIPT'
set -eu
REMOTE="$WT_REMOTE"
WT_HOST_ARG="${WT_HOST_ARG:-}"
CF_TEAM_ARG="${CF_TEAM_ARG:-}"
CF_AUD_ARG="${CF_AUD_ARG:-}"
SHOW_ONLY="${WT_SHOW_ONLY:-0}"

ENV_FILE="${REMOTE}/.env"
EXAMPLE="${REMOTE}/deploy/env.example"

if [ ! -f "$EXAMPLE" ]; then
	echo "✗ ${EXAMPLE} not found — run ./deploy/sync.sh first." >&2
	exit 1
fi

# Read a key from the existing .env, empty when absent.
current() {
	[ -f "$ENV_FILE" ] || return 0
	grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- \
		| sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

report() {
	local key="$1" val="$2"
	if [ -n "$val" ]; then
		printf '  %-22s SET (%d chars)\n' "$key" "${#val}"
	else
		printf '  %-22s (empty)\n' "$key"
	fi
}

# ── carry values over ────────────────────────────────────────────────
# The older stack named the tunnel token TUNNEL_TOKEN; the current compose
# expects CLOUDFLARED_TOKEN. Prefer the new name, fall back to the old one
# so a working tunnel does not have to be re-provisioned.
token="$(current CLOUDFLARED_TOKEN)"
token_source="CLOUDFLARED_TOKEN"
if [ -z "$token" ]; then
	token="$(current TUNNEL_TOKEN)"
	[ -n "$token" ] && token_source="TUNNEL_TOKEN (older name)"
fi

# An explicit --wt-host wins, then whatever the file already has, then
# the example default.
if [ -n "$WT_HOST_ARG" ]; then
	wt_host="$WT_HOST_ARG"
else
	wt_host="$(current WT_HOST)"
	if [ -z "$wt_host" ]; then
		wt_host="$(grep -E '^WT_HOST=' "$EXAMPLE" | head -1 | cut -d= -f2-)"
	fi
fi

# Explicit flags win, otherwise keep what is already there.
cf_team="${CF_TEAM_ARG:-$(current CF_ACCESS_TEAM_DOMAIN)}"
cf_aud="${CF_AUD_ARG:-$(current CF_ACCESS_AUD)}"
require_auth="$(current REQUIRE_AUTHENTICATION)"
allowed_origins="$(current ALLOWED_ORIGINS)"

echo "── current ${ENV_FILE} ───────────────────────────"
if [ -f "$ENV_FILE" ]; then
	while IFS= read -r line; do
		report "${line%%=*}" "${line#*=}"
	done < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE")
else
	echo "  (none)"
fi

echo
echo "── resolved values ──────────────────────────────"
printf '  %-22s %s\n' "WT_HOST" "$wt_host"
report "CLOUDFLARED_TOKEN" "$token"
[ -n "$token" ] && echo "     └ carried from ${token_source}"
report "CF_ACCESS_TEAM_DOMAIN" "$cf_team"
report "CF_ACCESS_AUD" "$cf_aud"

if [ "$SHOW_ONLY" = "1" ]; then
	echo
	echo "(--show: nothing written)"
	exit 0
fi

if [ -z "$token" ]; then
	echo
	echo "✗ no tunnel token found in ${ENV_FILE}." >&2
	echo "  Get one from Cloudflare Zero Trust → Networks → Tunnels →" >&2
	echo "  your tunnel → Install connector (Docker), then add it as" >&2
	echo "  CLOUDFLARED_TOKEN=… and re-run." >&2
	exit 1
fi

# ── write ────────────────────────────────────────────────────────────
# Backed up first: this file is the only copy of the tunnel token.
if [ -f "$ENV_FILE" ]; then
	cp "$ENV_FILE" "${ENV_FILE}.bak"
	chmod 600 "${ENV_FILE}.bak"
fi

umask 077
cat > "$ENV_FILE" <<ENVEOF
# Generated by deploy/make-env.sh — values carried over from the previous
# file where present. Mode 600: this holds the tunnel token.

WT_HOST=${wt_host}
CLOUDFLARED_TOKEN=${token}

CF_ACCESS_TEAM_DOMAIN=${cf_team}
CF_ACCESS_AUD=${cf_aud}
REQUIRE_AUTHENTICATION=${require_auth}

ALLOWED_ORIGINS=${allowed_origins}
ENVEOF
chmod 600 "$ENV_FILE"

echo
echo "✓ wrote ${ENV_FILE} (mode $(stat -c '%a' "$ENV_FILE"))"
[ -f "${ENV_FILE}.bak" ] && echo "  previous file kept at ${ENV_FILE}.bak"

if [ -z "$cf_team" ] || [ -z "$cf_aud" ]; then
	echo
	echo "! CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD are empty, so the backend"
	echo "  will trust the plain identity header instead of verifying the"
	echo "  signed Access assertion. Fill them in for verified identity."
fi
REMOTE_SCRIPT
