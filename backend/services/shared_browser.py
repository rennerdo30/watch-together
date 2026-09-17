"""
The room's shared browser: a neko container, and the sessions it is entered with.

Everything here is about one question — may this room open the browser, and
if so, how does a member's tab get in without ever being told a password?

The answer to the second half is that the password stays on this side. neko's
`multiuser` provider takes a password and gives back a session token; this
server is the one that presents it, over the internal network, and hands the
member's browser only the resulting token as a cookie scoped to neko's path.
A member can therefore use the browser and still not be able to log into it
from anywhere else, and revoking access is a matter of not minting another.

The first half — may it be opened at all — is a deployment question this
server cannot answer by trying. neko's media is WebRTC, and the deployment it
runs in publishes no ports and reaches the internet through a tunnel that
carries HTTP only. So the operator must have arranged one of two things, and
`media_transport` reports which, from configuration rather than from hope.
"""
import logging
import time
from typing import Optional

import httpx

from core import config

logger = logging.getLogger(__name__)


def media_transport() -> Optional[str]:
    """How neko's media is expected to reach a viewer, or None if it cannot.

    Direct UDP needs both halves: ports published on the host *and* the
    public address announced as a candidate, because a candidate pointing at
    a closed port only makes every viewer wait for a timeout. A TURN relay
    needs nothing opened, and the project already configures one for screen
    sharing, so the same three values serve both.
    """
    if config.BROWSER_PUBLIC_IP and config.BROWSER_UDP_PORTS:
        return config.BROWSER_TRANSPORT_UDP
    if config.WEBRTC_TURN_URL:
        return config.BROWSER_TRANSPORT_TURN
    return None


def unavailable_reason() -> Optional[str]:
    """Why this instance cannot open a shared browser, as a code, or None.

    Codes rather than sentences: the room renders the wording, and the same
    fact has to read differently to a member than to an operator.
    """
    if not config.BROWSER_ENABLED:
        return config.BROWSER_UNAVAILABLE_DISABLED
    if not config.BROWSER_USER_PASSWORD:
        return config.BROWSER_UNAVAILABLE_NO_PASSWORD
    if media_transport() is None:
        return config.BROWSER_UNAVAILABLE_NO_MEDIA_PATH
    return None


def is_available() -> bool:
    """Whether opening the browser is configured to be able to work."""
    return unavailable_reason() is None


def setup_checklist() -> list:
    """The settings still missing before a shared browser could work.

    Operator-facing, and the answer to a real confusion: the room says the
    browser is switched off, so an admin goes looking for a switch in the
    admin panel and finds none. There is none to find — this is deployment
    configuration, set in the host's `.env` and applied by a deploy — so the
    panel's job is to name the keys rather than pretend to own them.
    """
    missing = []
    if not config.BROWSER_ENABLED:
        missing.append("BROWSER_ENABLED=true")
    if not config.BROWSER_USER_PASSWORD:
        missing.append("BROWSER_USER_PASSWORD=<a password>")
    if not config.BROWSER_ADMIN_PASSWORD:
        missing.append("BROWSER_ADMIN_PASSWORD=<a different password>")
    if media_transport() is None:
        # Either route works; naming both beats picking one for them.
        missing.append(
            "BROWSER_UDP_PORTS + BROWSER_PUBLIC_IP (a published UDP range) "
            "or BROWSER_ICE_SERVERS / WEBRTC_TURN_URL (a relay)")
    return missing


def embed_path() -> str:
    """Where the room's iframe points, on this origin."""
    return f"{config.BROWSER_PATH_PREFIX}/?{config.BROWSER_EMBED_QUERY}"


def _neko_url(path: str) -> str:
    """An address on the neko container, under the prefix it serves."""
    return f"{config.BROWSER_INTERNAL_URL}{config.BROWSER_PATH_PREFIX}{path}"


# The last health answer and when it was taken. Every room asks on load,
# and the expensive case is the one that answers slowest: an enabled
# instance whose container is not there waits out the timeout each time.
_health: tuple[float, bool] = (0.0, False)


async def is_running() -> bool:
    """Whether the neko container is up and answering.

    Enabled and running are different failures with different fixes, so the
    room is told them apart: one is a configuration change, the other is a
    container that did not start.
    """
    global _health
    if not config.BROWSER_ENABLED:
        return False
    taken_at, answer = _health
    if time.monotonic() - taken_at < config.BROWSER_HEALTH_CACHE_SECONDS:
        return answer
    try:
        async with httpx.AsyncClient(
            timeout=config.BROWSER_REQUEST_TIMEOUT_SECONDS
        ) as client:
            response = await client.get(_neko_url("/health"))
        answer = response.status_code == 200
    except Exception as exc:
        logger.info(f"Shared browser health probe failed: {exc}")
        answer = False
    _health = (time.monotonic(), answer)
    return answer


class BrowserSessionError(RuntimeError):
    """neko refused to mint a session, or could not be reached."""


async def mint_session(display_name: str, as_admin: bool = False) -> str:
    """Log into neko on a member's behalf and return their session token.

    The token is what the caller sets as a cookie. Nothing else about this
    exchange reaches a browser — in particular not the password, and not the
    admin password under any circumstances, which is why the caller decides
    `as_admin` from the room's own roles rather than from anything a client
    sent.
    """
    password = (
        config.BROWSER_ADMIN_PASSWORD if as_admin else config.BROWSER_USER_PASSWORD
    )
    if not password:
        raise BrowserSessionError("no password is configured for the shared browser")

    try:
        async with httpx.AsyncClient(
            timeout=config.BROWSER_REQUEST_TIMEOUT_SECONDS
        ) as client:
            response = await client.post(
                _neko_url("/api/login"),
                json={"username": display_name, "password": password},
            )
    except Exception as exc:
        raise BrowserSessionError(f"could not reach the shared browser: {exc}") from exc

    if response.status_code != 200:
        # Deliberately not echoing the body: it is neko's, and this runs with
        # a password in hand.
        raise BrowserSessionError(
            f"the shared browser refused the login ({response.status_code})")

    # neko answers in one of two shapes depending on its own cookie setting:
    # with cookies on it sets one and says nothing more, with cookies off it
    # returns the token in the body. Both are read, so the feature does not
    # silently depend on a neko setting this repository does not own.
    token = response.cookies.get(config.BROWSER_SESSION_COOKIE_NAME)
    if not token:
        try:
            token = (response.json() or {}).get("token")
        except ValueError:
            token = None
    if not token:
        raise BrowserSessionError("the shared browser returned no session token")
    return token
