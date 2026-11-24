"""
Periodic yt-dlp update checker.

YouTube rotates player scripts and extraction requirements often enough that
a long-running container goes stale between deploys. `start.sh` already
refreshes yt-dlp and its PO token plugins on every container start, so this
module checks PyPI on a fixed interval (hourly by default) and triggers a
graceful process restart once a newer stable release is published and no
room is actively playing. Docker's `restart: unless-stopped` then brings the
container right back up through `start.sh` with the fresh release.

Upgrading via container restart rather than `pip install` inside the running
process avoids mutating yt-dlp's modules underneath live imports and keeps a
single upgrade path. To prevent local dev servers or test runs from killing
themselves, the background loop only runs when `YTDLP_AUTO_UPDATE=true` and
`start.sh` exported `YTDLP_UPDATE_MANAGED=1`.
"""
import asyncio
import logging
import os
import signal
import time
from typing import Callable, Optional

import httpx
import yt_dlp

from core import config

logger = logging.getLogger(__name__)


def parse_version(raw: Optional[str]) -> Optional[tuple[int, ...]]:
    """Parse a stable dotted numeric version like `2026.11.23` or `2026.11.23.1`.

    Pre-releases (`2026.11.24.dev0`, `2026.11.24a1`) and malformed values
    return None so the updater only reacts to stable PyPI releases.
    """
    if not isinstance(raw, str):
        return None
    cleaned = raw.strip()
    if not cleaned:
        return None
    parts = cleaned.split(".")
    if not all(part.isascii() and part.isdigit() for part in parts):
        return None
    return tuple(int(part) for part in parts)


def is_newer(candidate: Optional[str], current: Optional[str]) -> bool:
    """True when `candidate` is a valid stable version strictly newer than `current`."""
    cand_tuple = parse_version(candidate)
    curr_tuple = parse_version(current)
    if cand_tuple is None or curr_tuple is None:
        return False
    return cand_tuple > curr_tuple


def _installed_ytdlp_version() -> str:
    return getattr(getattr(yt_dlp, "version", None), "__version__", "unknown")


def _send_graceful_shutdown() -> None:
    os.kill(os.getpid(), signal.SIGTERM)


class YtdlpUpdater:
    """Checks PyPI for newer stable yt-dlp releases and restarts when idle."""

    def __init__(
        self,
        *,
        pypi_url: str = config.YTDLP_PYPI_JSON_URL,
        timeout: float = config.YTDLP_UPDATE_CHECK_TIMEOUT_SECONDS,
        current_version: Callable[[], str] = _installed_ytdlp_version,
        request_restart: Callable[[], None] = _send_graceful_shutdown,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self._pypi_url = pypi_url
        self._timeout = timeout
        self._current_version = current_version
        self._request_restart = request_restart
        self._transport = transport
        self._client: Optional[httpx.AsyncClient] = None

        self.latest_version: Optional[str] = None
        self.pending_version: Optional[str] = None
        self.last_check_at: Optional[float] = None
        self.last_error: Optional[str] = None
        self._etag: Optional[str] = None
        self._restart_requested: bool = False
        self._deferred_logged_for: Optional[str] = None

    def configure(
        self,
        *,
        pypi_url: Optional[str] = None,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        current_version: Optional[Callable[[], str]] = None,
        request_restart: Optional[Callable[[], None]] = None,
    ) -> None:
        """Replace transport/callbacks (used by tests to stay offline)."""
        if pypi_url is not None:
            self._pypi_url = pypi_url
        if transport is not None:
            self._transport = transport
            self._client = None
        if current_version is not None:
            self._current_version = current_version
        if request_restart is not None:
            self._request_restart = request_restart
        self.reset()

    def reset(self) -> None:
        self.latest_version = None
        self.pending_version = None
        self.last_check_at = None
        self.last_error = None
        self._etag = None
        self._restart_requested = False
        self._deferred_logged_for = None

    @staticmethod
    def is_enabled() -> bool:
        """True only when auto-update is on and the container is supervised by start.sh."""
        return (
            config.YTDLP_AUTO_UPDATE
            and os.environ.get("YTDLP_UPDATE_MANAGED", "").strip() == "1"
        )

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            kwargs: dict = {
                "timeout": self._timeout,
                "follow_redirects": True,
                "headers": {"Accept": "application/json"},
            }
            if self._transport is not None:
                kwargs["transport"] = self._transport
            self._client = httpx.AsyncClient(**kwargs)
        return self._client

    async def aclose(self) -> None:
        if self._client is not None and not self._client.is_closed:
            try:
                await self._client.aclose()
            except Exception as exc:
                logger.warning("yt-dlp updater HTTP client did not close cleanly: %s", exc)
        self._client = None

    async def check_once(self) -> Optional[str]:
        """Query PyPI once and record whether a newer stable version is available.

        Returns the pending target version if an update is available, else None.
        Never raises: network blips or PyPI outages are logged and retried next tick.
        """
        headers = {}
        if self._etag:
            headers["If-None-Match"] = self._etag

        current = self._current_version()
        self.last_check_at = time.time()

        try:
            response = await self._get_client().get(self._pypi_url, headers=headers)
            if response.status_code == 304:
                self.last_error = None
                return self.pending_version
            response.raise_for_status()
            payload = response.json()
        except Exception as exc:
            self.last_error = str(exc)[:200]
            logger.warning("yt-dlp update check failed: %s", self.last_error)
            return self.pending_version

        etag = response.headers.get("etag")
        if etag:
            self._etag = etag

        latest = payload.get("info", {}).get("version") if isinstance(payload, dict) else None
        if not isinstance(latest, str) or parse_version(latest) is None:
            self.last_error = f"unexpected PyPI version: {latest!r}"
            logger.warning("yt-dlp update check ignored invalid version %r", latest)
            return self.pending_version

        self.latest_version = latest
        self.last_error = None

        if is_newer(latest, current):
            if self.pending_version != latest:
                logger.info("yt-dlp update available: %s -> %s", current, latest)
            self.pending_version = latest
        else:
            self.pending_version = None

        return self.pending_version

    def maybe_apply_pending(self, is_idle: Callable[[], bool]) -> bool:
        """Trigger a graceful restart if an update is pending and nothing is active."""
        if not self.pending_version or self._restart_requested:
            return False

        current = self._current_version()
        if not is_idle():
            if self._deferred_logged_for != self.pending_version:
                logger.info(
                    "yt-dlp update %s -> %s deferred until rooms are idle",
                    current, self.pending_version,
                )
                self._deferred_logged_for = self.pending_version
            return False

        self._restart_requested = True
        logger.info(
            "Restarting backend to apply yt-dlp update: %s -> %s",
            current, self.pending_version,
        )
        self._request_restart()
        return True

    async def run(
        self,
        is_idle: Callable[[], bool],
        *,
        check_interval: float = config.YTDLP_UPDATE_CHECK_INTERVAL_SECONDS,
        idle_poll: float = config.YTDLP_UPDATE_IDLE_POLL_SECONDS,
    ) -> None:
        """Periodically check PyPI and restart once idle when a new release ships.

        Sleeps one full `check_interval` before the first check: `start.sh`
        just checked PyPI at boot, and waiting first guarantees a failed boot
        upgrade can never turn into a tight restart loop.
        """
        logger.info(
            "yt-dlp auto-update checker running (current=%s, interval=%ds, idle_poll=%ds)",
            self._current_version(), int(check_interval), int(idle_poll),
        )
        last_pypi_check = time.monotonic()
        while True:
            delay = idle_poll if self.pending_version else check_interval
            await asyncio.sleep(delay)

            now = time.monotonic()
            if not self.pending_version or (now - last_pypi_check) >= check_interval:
                last_pypi_check = now
                await self.check_once()

            if self.maybe_apply_pending(is_idle):
                return

    def snapshot(self) -> dict:
        """Status summary for the admin overview endpoint."""
        return {
            "version": self._current_version(),
            "latest_version": self.latest_version,
            "update_pending": self.pending_version,
            "auto_update": self.is_enabled(),
            "check_interval_seconds": config.YTDLP_UPDATE_CHECK_INTERVAL_SECONDS,
            "last_check_at": self.last_check_at,
            "last_error": self.last_error,
        }


updater = YtdlpUpdater()
