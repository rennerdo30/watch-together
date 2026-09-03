"""
Regression tests for deployment-time faults.

These assert properties of the build and packaging that only failed once
the stack ran on a real host, and which no runtime test would notice.
"""
import json
import pathlib
import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
BACKEND = REPO_ROOT / "backend"
EXTENSION = REPO_ROOT / "extension"


class TestBackendImage:
    def test_data_directory_exists_in_the_image(self):
        """A volume mounted on a path the image lacks is created root-owned.

        `data/` is in .dockerignore, so without an explicit mkdir the
        directory does not exist at build time and the non-root process
        cannot write to the mounted volume — it dies creating its cache
        and cookie directories.
        """
        dockerfile = (BACKEND / "Dockerfile").read_text()
        assert "mkdir -p /app/data" in dockerfile

        mkdir_at = dockerfile.index("mkdir -p /app/data")
        chown_at = dockerfile.index("chown -R appuser:appgroup")
        assert mkdir_at < chown_at, "the data directory must be created before ownership is set"

    def test_packages_live_somewhere_the_app_user_can_write(self):
        """yt-dlp is upgraded at boot by the non-root user."""
        dockerfile = (BACKEND / "Dockerfile").read_text()
        assert "VIRTUAL_ENV=/opt/venv" in dockerfile
        assert 'chown -R appuser:appgroup /app "$VIRTUAL_ENV"' in dockerfile

    def test_startup_refreshes_ytdlp_but_tolerates_failure(self):
        """An offline or rate-limited host must still start."""
        start = (BACKEND / "start.sh").read_text()
        assert "YTDLP_AUTO_UPDATE" in start
        assert "yt-dlp/archive/master.tar.gz" in start
        # A failed update is reported, not fatal.
        assert "starting with" in start
        assert start.rstrip().endswith("exec uvicorn main:app --host 0.0.0.0 --port 8000")


class TestExtensionManifest:
    """The extension could not detect a self-hosted instance at all."""

    @pytest.fixture
    def manifest(self):
        return json.loads((EXTENSION / "manifest.json").read_text())

    def test_instance_origins_can_be_requested(self, manifest):
        """A self-hosted instance has its own domain, unknown at packaging."""
        optional = manifest.get("optional_host_permissions", [])
        assert optional, "no optional host permissions, so no instance can be granted"
        assert any(p.startswith("https://") for p in optional)

    def test_no_content_script_is_registered(self, manifest):
        """The token comes from the API now, not from a page meta tag.

        The old content script only ran on the five video sites, never on a
        Watch Together instance, so detection could not happen at all.
        """
        assert "content_scripts" not in manifest
        assert not (EXTENSION / "content.js").exists()

    def test_cookie_and_storage_permissions_are_present(self, manifest):
        for permission in ("cookies", "storage", "alarms"):
            assert permission in manifest["permissions"]

    def test_background_completes_connection_without_the_popup(self):
        """Chrome destroys the popup when the permission prompt opens.

        The work after chrome.permissions.request() therefore has to live in
        the service worker, or the permission is granted and nothing else
        happens.
        """
        background = (EXTENSION / "background.js").read_text()
        assert "chrome.permissions.onAdded.addListener" in background
        assert "fetchInstanceConnection" in background

    def test_token_is_fetched_from_the_api(self):
        background = (EXTENSION / "background.js").read_text()
        assert "/api/me" in background
        assert "/api/token" in background
        # The meta-tag handshake is gone.
        assert "wt-ext-token" not in background
        assert "TOKEN_DETECTED" not in background

    def test_credentials_are_local_only_and_atomic(self):
        """Synced or separately-written identity fields can cross users.

        Older builds synchronized token/email/backend. A later partial move to
        local storage left the options page reading the old synced values,
        while a failed instance switch could pair a new backend with the old
        token/email. One local record is the only credential source now.
        """
        background = (EXTENSION / "background.js").read_text()
        assert "ACTIVE_CONNECTION_KEY = 'activeConnection'" in background
        assert "[ACTIVE_CONNECTION_KEY]: acquired.connection" in background
        assert "LEGACY_SYNC_CREDENTIAL_KEYS" in background
        assert "chrome.storage.sync.remove(LEGACY_SYNC_CREDENTIAL_KEYS)" in background
        assert "instanceOrigins.push" not in background

    def test_options_get_identity_from_verified_background_status(self):
        options = (EXTENSION / "options" / "options.js").read_text()
        html = (EXTENSION / "options" / "options.html").read_text()

        assert "sendMessage({ type: 'GET_STATUS' })" in options
        sync_get = options.split("chrome.storage.sync.get(", 1)[1].split(")", 1)[0]
        for credential in ("token", "userEmail", "backendUrl", "lastSync"):
            assert credential not in sync_get, f"{credential} is read from synchronized storage"
        assert 'id="tokenInput"' not in html
        assert "copyTokenBtn" not in options

    def test_cached_email_is_not_connection_proof(self):
        background = (EXTENSION / "background.js").read_text()
        assert "/api/extension/status" in background
        assert "sessionEmail !== tokenStatus.userEmail" in background
        assert "connected: !!local.token" not in background


class TestConnectionsAreReused:
    """Adaptive playback is thousands of small range requests.

    The proxy and nginx both used to force the connection closed after every
    response, as a workaround for HTTP/2 stream errors. Those errors came
    from partial responses sent without a Content-Range, which is fixed at
    the source, and closing per response costs a fresh connection setup for
    every segment — expensive on any link and punitive across continents.
    """

    def test_proxy_does_not_force_the_connection_closed(self):
        source = (BACKEND / "main.py").read_text()
        assert '"Connection": "close"' not in source

    def test_nginx_keeps_the_backend_connection_alive(self):
        conf = (REPO_ROOT / "nginx" / "nginx.conf").read_text()
        # The websocket locations legitimately set Upgrade; only the media
        # proxy must not force a close.
        proxy_block = conf.split("location /api/proxy")[1].split("location ")[0]
        assert 'Connection "close"' not in proxy_block
        assert 'proxy_set_header Connection ""' in proxy_block


class TestPlayerToleratesHighLatency:
    """The server and the viewer can be on opposite sides of the world."""

    PLAYER_CONSTANTS = REPO_ROOT / "frontend" / "lib" / "constants.ts"

    def test_startup_bandwidth_guess_is_conservative(self):
        """An optimistic guess opens on the top rendition and stalls."""
        text = self.PLAYER_CONSTANTS.read_text()
        assert "SHAKA_INITIAL_BANDWIDTH_ESTIMATE" in text

    def test_rebuffer_goal_is_a_cushion_not_a_wait(self):
        """The goal is paid in full on every seek, with an empty buffer.

        It was once raised to 12s against constant stalling, which turned
        out to be the player reloading itself rather than a thin cushion.
        A goal that large is a long spinner after every jump; too small a
        one is spent before the next segment lands. `bufferingGoal` is
        what protects steady playback.
        """
        import re

        text = self.PLAYER_CONSTANTS.read_text()
        match = re.search(r"SHAKA_REBUFFER_GOAL_SECONDS = (\d+)", text)
        assert match, "the rebuffering goal is no longer defined"
        goal = int(match.group(1))
        assert 2 <= goal <= 6, (
            f"{goal}s is either too thin to survive one late segment or "
            "long enough to be felt on every seek"
        )
        ahead = re.search(r"SHAKA_BUFFER_GOAL_SECONDS = (\d+)", text)
        assert ahead and int(ahead.group(1)) > goal * 4, (
            "playback must fill well beyond the point where it resumes"
        )

    def test_segment_requests_are_retried(self):
        text = self.PLAYER_CONSTANTS.read_text()
        assert "SHAKA_SEGMENT_RETRIES" in text
        assert "SHAKA_REQUEST_TIMEOUT_MS" in text


class TestPlaybackEngineIsNotKeyedOnRoomState:
    """The engine is built once per stream, not once per state change.

    `autoPlay` follows the room's play/pause state and `initialTime`
    follows the sync position, which every heartbeat rewrites. Both were
    dependencies of the setup effect, so the player was destroyed and the
    manifest reloaded on every pause, resume, seek and heartbeat. That
    rebuffered from zero, and detaching the media element fired a `pause`
    the room broadcast as real while the following reload autoplayed and
    broadcast a real `play` — so a paused room resumed itself.

    The behaviour is covered end to end in
    `frontend/e2e/playback-stability.spec.ts`; this pins the cause.
    """

    HOOK = REPO_ROOT / "frontend" / "components" / "player" / "hooks" / "useShakaPlayer.ts"

    def test_setup_effect_depends_only_on_the_stream(self):
        import re

        text = self.HOOK.read_text()
        deps = re.findall(r"\}, \[([^\]]*)\]\);", text)
        setup_deps = [d for d in deps if "manifestUrl" in d]
        assert setup_deps, "the setup effect's dependency list is no longer recognisable"
        for dep_list in setup_deps:
            assert "autoPlay" not in dep_list, (
                "keying the engine on the play state reloads the stream on every pause"
            )
            assert "initialTime" not in dep_list, (
                "keying the engine on the sync position reloads the stream on every heartbeat"
            )

    def test_start_position_and_autoplay_are_read_at_load_time(self):
        text = self.HOOK.read_text()
        assert "callbackRefs.current.initialTime" in text
        assert "callbackRefs.current.autoPlay" in text


class TestQueuedVideosAreNotPlayedFromStaleUrls:
    """A queue entry's stream URLs are as old as the entry.

    `set_video` used to show the queued copy immediately as a placeholder
    and re-resolve behind it. The player mounted on those expired URLs and
    asked for a manifest built from them; the request failed, and the
    failure is what the viewer kept seeing even after fresh URLs arrived.
    The spinner is shown instead until the re-resolve lands.
    """

    ROOM_PAGE = REPO_ROOT / "frontend" / "app" / "room" / "[id]" / "page.tsx"

    def test_the_queued_copy_is_not_shown_while_re_resolving(self):
        text = self.ROOM_PAGE.read_text()
        set_video = text.split("case 'set_video':")[1].split("case '")[0]
        assert "setVideoData(null);" in set_video
        assert "setVideoData(queuedVideoData);" in set_video, (
            "a resolve failure should still fall back to the queued copy"
        )
        # The fallback must be in the failure path, not the happy one.
        assert set_video.index("setVideoData(null);") < \
            set_video.index("setVideoData(queuedVideoData);")

    def test_every_member_sees_the_spinner_not_an_empty_room(self):
        """`loadingQueueIndex` is only set on the client that clicked."""
        text = self.ROOM_PAGE.read_text()
        assert "isRestoringVideo" in text
        assert "|| isRestoringVideo" in text, (
            "the re-resolve state must feed the resolving indicator"
        )


class TestPlayerIsNotRemountedOnReResolve:
    """Re-resolving the same video must not restart playback.

    Signed stream URLs rotate on every resolve while the video does not.
    Keying the player on the stream URL remounted it each time the room
    refreshed those URLs, which reloaded the manifest and rebuffered from
    zero — an endless buffering loop on a reconnect-prone link. And the
    WebSocket handler read the current video from a stale closure, so every
    `sync` looked like a new video and triggered exactly that refresh.
    """

    ROOM_PAGE = REPO_ROOT / "frontend" / "app" / "room" / "[id]" / "page.tsx"

    def test_player_is_keyed_on_video_identity(self):
        text = self.ROOM_PAGE.read_text()
        assert "key={`${videoData.original_url}" in text
        assert "key={`${videoData.stream_url}" not in text, (
            "keying on the signed stream URL remounts the player whenever it rotates"
        )

    def test_sync_reads_the_current_video_from_a_ref(self):
        """A closure over videoData is stale for the life of the socket."""
        text = self.ROOM_PAGE.read_text()
        assert "videoDataRef" in text
        assert "const current = videoDataRef.current;" in text
        assert "const isSameVideo = videoData?.original_url" not in text


class TestVisualLanguage:
    """The parts of the styling that were actively working against readability.

    The whole app shell carried `uppercase`, so every string in the UI was
    set in capitals and each one that needed to read normally had to opt
    back out. At the 9-11px the labels used, with `font-black` and wide
    letter-spacing on top, capitals cost the ascenders and descenders a
    reader uses to tell words apart.

    The stylesheet also carried a set of decorative rules — frosted glass,
    a violet-to-pink gradient text fill, a pulsing glow, a float — that
    nothing used. Dead code that only has to be looked at is still dead.
    """

    GLOBALS = REPO_ROOT / "frontend" / "app" / "globals.css"
    ROOM_PAGE = REPO_ROOT / "frontend" / "app" / "room" / "[id]" / "page.tsx"
    FRONTEND = REPO_ROOT / "frontend"

    def source_files(self):
        for pattern in ("app/**/*.tsx", "components/**/*.tsx"):
            yield from self.FRONTEND.glob(pattern)

    def test_the_app_shell_does_not_capitalise_everything(self):
        text = self.ROOM_PAGE.read_text()
        shell = text.split("<main", 1)[1].split(">", 1)[0]
        assert "uppercase" not in shell, (
            "the shell capitalises the entire UI again"
        )
        assert "normal-case" not in text, (
            "an opt-out only exists because something opted everything in"
        )

    def test_no_component_shouts_by_default(self):
        """`LIVE` on a live stream is the one place capitals earn it."""
        offenders = []
        for path in self.source_files():
            for number, line in enumerate(path.read_text().splitlines(), 1):
                if "uppercase" in line:
                    offenders.append(f"{path.name}:{number}")
        assert not offenders, f"uppercase is back in {offenders}"

    def test_the_heaviest_weight_is_not_used_for_small_labels(self):
        offenders = []
        for path in self.source_files():
            for number, line in enumerate(path.read_text().splitlines(), 1):
                if "font-black" in line:
                    offenders.append(f"{path.name}:{number}")
        assert not offenders, f"font-black is back in {offenders}"

    def test_the_decorative_dead_rules_are_gone(self):
        css = self.GLOBALS.read_text()
        for dead in ("gradient-text", "pulse-glow", "animate-float",
                     "shadow-glow", ".glass"):
            assert dead not in css, f"{dead} is back and still unused"

    def test_the_type_scale_exists_and_is_used(self):
        css = self.GLOBALS.read_text()
        for step in (".ui-label", ".ui-meta", ".ui-title", ".ui-heading"):
            assert step in css, f"{step} is missing from the type scale"

        used = sum(
            path.read_text().count("ui-label") + path.read_text().count("ui-title")
            for path in self.source_files()
        )
        assert used > 10, "the type scale is defined but the UI does not use it"

    def test_accent_colours_come_from_the_token(self):
        """A hard-coded accent does not follow the chosen theme.

        Only a handful of places read `activeTheme.accent`, so every
        hard-coded violet stayed violet whatever theme was picked.
        """
        offenders = []
        for path in self.source_files():
            for number, line in enumerate(path.read_text().splitlines(), 1):
                # Class names, not prose: "-violet-" appears in
                # `bg-violet-500` but not in a comment explaining why it
                # is gone.
                if "-violet-" in line or "-fuchsia-" in line:
                    offenders.append(f"{path.name}:{number}")
        assert not offenders, f"a hard-coded accent is back in {offenders}"


class TestExtensionNightlyRelease:
    """Every main commit produces one rolling, installable Chrome package."""

    WORKFLOW = REPO_ROOT / ".github" / "workflows" / "extension-nightly.yml"

    def test_runs_on_every_main_commit(self):
        text = self.WORKFLOW.read_text()
        assert "push:" in text
        assert "branches: [main]" in text

    def test_release_has_write_permission_and_is_a_prerelease(self):
        text = self.WORKFLOW.read_text()
        assert "contents: write" in text
        assert "gh release" in text
        assert "--prerelease" in text
        assert "git tag -f nightly" in text

    def test_chrome_package_is_manifest_v3_and_excludes_repo_files(self):
        text = self.WORKFLOW.read_text()
        assert 'manifest["manifest_version"] == 3' in text
        assert 'root / "manifest.json"' in text
        assert 'root / "background.js"' in text
        assert 'root / "manifest.v2.json"' not in text
        assert "CLAUDE.md" not in text

    def test_release_has_a_zip_and_checksum(self):
        text = self.WORKFLOW.read_text()
        assert "watch-together-chrome-nightly.zip" in text
        assert ".zip.sha256" in text
        assert "unzip -t" in text


class TestContactDetailsAreReal:
    """An invented contact address sends real reports nowhere.

    `security+watch-together@proton.me` was written into the security policy,
    the code of conduct and two issue templates. Nobody owned that mailbox, so
    a vulnerability reported there would simply have been lost. GitHub's
    private advisory flow needs no mailbox to be monitored.
    """

    DOCUMENTS = (
        "SECURITY.md",
        "CODE_OF_CONDUCT.md",
        ".github/ISSUE_TEMPLATE/config.yml",
        ".github/ISSUE_TEMPLATE/security_report.md",
    )

    def test_no_contact_email_is_advertised(self):
        import re

        pattern = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
        offenders = {}
        for name in self.DOCUMENTS:
            found = pattern.findall((REPO_ROOT / name).read_text())
            if found:
                offenders[name] = found
        assert not offenders, (
            f"an email address is advertised in {offenders}; use the GitHub "
            "advisory flow rather than a mailbox nobody reads"
        )

    def test_the_private_advisory_route_is_documented(self):
        for name in ("SECURITY.md", ".github/ISSUE_TEMPLATE/config.yml",
                     ".github/ISSUE_TEMPLATE/security_report.md"):
            text = (REPO_ROOT / name).read_text()
            assert "security/advisories/new" in text, f"{name} has no private route"

    def test_no_response_time_is_promised(self):
        """A one-person side project cannot honour an acknowledgement SLA."""
        text = (REPO_ROOT / "SECURITY.md").read_text().lower()
        for promise in ("within 72 hours", "within 7 days", "within 24 hours"):
            assert promise not in text


class TestSeeksAreNotSwallowedBySync:
    """A user's seek must always reach the room, and never be undone.

    Every incoming WebSocket message — heartbeats fire every five seconds —
    used to raise a 300 ms suppression window, and a local seek completing
    inside it was silently dropped. The server then kept the old timestamp,
    and its next heartbeat saw more than three seconds of drift and yanked
    the viewer back to where they had seeked away from: skip, buffer, snap
    back. The window was wrong in the other direction too, because `seeked`
    fires only when a seek finishes buffering — a server-commanded seek
    completing after 300 ms was re-broadcast as though the user made it.
    """

    ROOM_PAGE = REPO_ROOT / "frontend" / "app" / "room" / "[id]" / "page.tsx"
    PLAYER = REPO_ROOT / "frontend" / "components" / "custom-player.tsx"

    def test_seek_broadcast_is_not_gated_on_the_message_counter(self):
        text = self.ROOM_PAGE.read_text()
        on_seeked = text.split("onSeeked={", 1)[1].split("}}", 1)[0]
        assert "internalUpdateCount" not in on_seeked, (
            "a seek completing near any incoming message is swallowed again"
        )
        assert "sendMsg('seek'" in on_seeked
        assert "lastLocalSeekAtRef.current = Date.now()" in on_seeked

    def test_heartbeat_correction_waits_out_a_local_seek(self):
        """A stale heartbeat can be in flight when the seek reaches the server."""
        text = self.ROOM_PAGE.read_text()
        heartbeat = text.split("case 'heartbeat':", 1)[1].split("break;", 1)[0]
        assert "lastLocalSeekAtRef" in heartbeat, (
            "nothing stops a pre-seek heartbeat from snapping the viewer back"
        )
        assert "video?.seeking" in heartbeat, (
            "a seek still buffering must not be corrected against"
        )

    def test_programmatic_seeks_are_matched_by_landing_position(self):
        """Sync corrections must not echo back to the room as user seeks."""
        text = self.PLAYER.read_text()
        assert "pendingProgrammaticSeeksRef" in text
        # Anchor inside the implementation: the PlayerAPI interface above it
        # declares the same signature.
        implementation = text.split("playerRef.current = {", 1)[1]
        setter = implementation.split("currentTime: (time?: number) =>", 1)[1].split("},", 1)[0]
        assert "pendingProgrammaticSeeksRef.current.push" in setter
        seeked = text.split("const handleVideoSeeked", 1)[1].split("};", 1)[0]
        assert "pendingProgrammaticSeeksRef" in seeked


class TestLiveStreamExpiryIsRecoverable:
    """A live stream outlives its signed playlist URL.

    Production (2026-08-30): the Twitch usher token behind a playing room
    expired mid-session. Every proxied fetch answered 403, and hls.js spent
    its whole retry budget re-requesting the same dead URL before giving up
    with "please try refreshing". The only recovery is a fresh resolve, so
    the hook must report the expiry instead of retrying, and the room page
    must answer it by re-resolving the original URL.
    """
    HOOK = REPO_ROOT / "frontend" / "components" / "player" / "hooks" / "useHlsPlayer.ts"
    ROOM_PAGE = REPO_ROOT / "frontend" / "app" / "room" / "[id]" / "page.tsx"

    def test_hls_hook_reports_an_expired_source_instead_of_retrying_it(self):
        text = self.HOOK.read_text()
        assert "onSourceExpired" in text, "the hook has no way to report a dead source"
        # 403 (dead signed token) and 410 (gone) are verdicts a retry of the
        # same URL cannot change.
        assert "403" in text and "410" in text

        handler = text.split("Hls.Events.ERROR", 1)[1]
        expiry_at = handler.index("onSourceExpired")
        retry_at = handler.index("retryCountRef.current >= MAX_RETRIES")
        assert expiry_at < retry_at, (
            "the expiry check must run before the retry budget: retrying a "
            "403'd URL burns every retry on an answer that cannot change"
        )

    def test_room_page_answers_expiry_with_a_fresh_resolve(self):
        text = self.ROOM_PAGE.read_text()
        assert "const handleSourceExpired" in text
        handler = text.split("const handleSourceExpired", 1)[1]
        handler = handler.split("const getFinalVideoUrl", 1)[0]
        assert "resolveUrl(original)" in handler, (
            "the expiry handler must re-resolve the original URL — nothing "
            "else can mint a fresh signed stream URL"
        )
        assert "onSourceExpired={handleSourceExpired}" in text, (
            "the handler is not wired into the player"
        )


class TestAdminCloseIsNotResurrected:
    """Closing a room from the admin panel looked like a no-op.

    The backend closed every socket and deleted the room, but the room
    page's onclose handler reconnected unconditionally three seconds
    later — recreating the room. The close must be announced in-band and
    the reconnect must honour it.
    """
    ROOM_PAGE = REPO_ROOT / "frontend" / "app" / "room" / "[id]" / "page.tsx"

    def test_the_reconnect_honours_a_deliberate_close(self):
        text = self.ROOM_PAGE.read_text()
        assert "case 'room_closed'" in text, "the close notice is not handled"

        handler = text.split("ws.onclose", 1)[1]
        handler = handler.split("};", 1)[0]
        assert "setTimeout(connect" in handler, "the reconnect moved; update this test"
        guard_at = handler.index("roomClosedRef")
        reconnect_at = handler.index("setTimeout(connect")
        assert guard_at < reconnect_at, (
            "onclose reconnects unconditionally: an admin-closed room is "
            "recreated three seconds after it was closed"
        )


class TestAdminPanelSelfHeals:
    """A failed panel action left the stale list standing.

    Closing a room that had already vanished server-side answered 404 —
    truthfully — but the panel only reloaded after successes, so the dead
    room stayed in the list and every further click repeated the same
    "No such room". A failed action is precisely the moment the view is
    known to disagree with the server, so it must refresh then too.
    """
    ADMIN_PAGE = REPO_ROOT / "frontend" / "app" / "admin" / "page.tsx"

    def test_actions_reload_even_when_they_fail(self):
        text = self.ADMIN_PAGE.read_text()
        run_action = text.split("const runAction", 1)[1]
        run_action = run_action.split("[load]", 1)[0]
        finally_at = run_action.find("finally")
        assert finally_at != -1, "runAction has no finally block"
        assert "load()" in run_action[finally_at:], (
            "the reload is not in the finally block: a failed action leaves "
            "the stale list standing"
        )


class TestLiveStreamsAreNotPositionSynced:
    """A DVR live stream kept jumping back to the start of its window.

    On a live stream every player's `currentTime` is relative to when
    *that* player loaded the playlist, so no position is comparable across
    viewers. The room nevertheless stored one viewer's position and the
    heartbeat corrected everyone towards it every five seconds — a hard
    seek to (near) the start of the DVR window, followed by a rebuffer.
    Live rooms share only the live edge, which each player reaches alone.
    """
    ROOM_PAGE = REPO_ROOT / "frontend" / "app" / "room" / "[id]" / "page.tsx"

    def _case(self, text: str, name: str) -> str:
        body = text.split(f"case '{name}':", 1)[1]
        return body.split("\n            case '", 1)[0]

    def test_incoming_positions_are_ignored_for_live_streams(self):
        text = self.ROOM_PAGE.read_text()
        for name in ("play", "pause", "seek", "heartbeat"):
            body = self._case(text, name)
            assert "is_live" in body, (
                f"the '{name}' handler seeks a live stream to another viewer's position"
            )
        heartbeat = self._case(text, "heartbeat")
        assert heartbeat.index("is_live") < heartbeat.index("playbackRate = 1.05"), (
            "the live guard must come before drift correction"
        )
        # The old check read a field play/pause messages never carry.
        assert "payload.video_data?.is_live && serverTimestamp === 0" not in text
        assert "isLive && serverTimestamp === 0" not in text

    def test_live_positions_are_never_published(self):
        text = self.ROOM_PAGE.read_text()
        for handler in ("onPlay={", "onPause={", "onSeeked={"):
            body = text.split(handler, 1)[1].split("}}", 1)[0]
            assert "is_live" in body, f"{handler} publishes a live position"
