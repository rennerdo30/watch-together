#!/bin/bash
# Container entrypoint.
#
# Refreshes yt-dlp before starting the app. YouTube changes its extraction
# requirements often enough that a version baked into an image goes stale
# within days, and the symptom is total resolution failure ("Sign in to
# confirm you're not a bot", zero formats) rather than a graceful
# degradation — so the newest nightly is worth fetching on every boot.
#
# Set YTDLP_AUTO_UPDATE=false to pin whatever the image was built with.
# Failure to update is never fatal: an offline or rate-limited host should
# still start with the version it already has.
set -u

YTDLP_AUTO_UPDATE="${YTDLP_AUTO_UPDATE:-true}"
YTDLP_UPDATE_TIMEOUT="${YTDLP_UPDATE_TIMEOUT:-180}"
YTDLP_SOURCE="${YTDLP_SOURCE:-https://github.com/yt-dlp/yt-dlp/archive/master.tar.gz}"

log() { echo "[start] $*"; }

current_version() {
    python -c 'import yt_dlp; print(yt_dlp.version.__version__)' 2>/dev/null || echo "unknown"
}

if [ "${YTDLP_AUTO_UPDATE,,}" = "true" ]; then
    before="$(current_version)"
    log "yt-dlp ${before}: checking for a newer nightly"

    # --upgrade against the master tarball always reinstalls, which is the
    # point: the version string only changes when upstream cuts one, but the
    # extractor code moves daily.
    if timeout "${YTDLP_UPDATE_TIMEOUT}" pip install \
            --no-cache-dir --disable-pip-version-check --quiet \
            --upgrade "yt-dlp[default] @ ${YTDLP_SOURCE}"; then
        after="$(current_version)"
        if [ "$before" = "$after" ]; then
            log "yt-dlp ${after}: already current"
        else
            log "yt-dlp updated: ${before} -> ${after}"
        fi

        # The PO token provider plugin tracks yt-dlp's provider API, so it is
        # refreshed alongside it. Without a working provider YouTube serves
        # storyboards only.
        timeout "${YTDLP_UPDATE_TIMEOUT}" pip install \
            --no-cache-dir --disable-pip-version-check --quiet \
            --upgrade yt-dlp-get-pot bgutil-ytdlp-pot-provider \
            || log "PO token plugins could not be refreshed; keeping current versions"
    else
        log "yt-dlp update failed (offline or rate limited); starting with ${before}"
    fi
else
    log "yt-dlp auto-update disabled; using $(current_version)"
fi

exec uvicorn main:app --host 0.0.0.0 --port 8000
