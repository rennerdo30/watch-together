"""
Shared test fixtures.

Every test runs against a temporary database and cache directory. This
keeps runs reproducible on a clean checkout (CI has no pre-existing
database, so anything touching persistence would fail) and stops the
suite from writing into the real `data/` directory during development.
Cookies never touch storage at all; the in-memory store is emptied between
tests.
"""
import os
import sys
import shutil
import tempfile
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Identity for tests comes from the ?user= query parameter.
os.environ.setdefault("DEVELOPMENT_MODE", "true")


@pytest.fixture(scope="session", autouse=True)
def isolated_data_dir():
    """Point persistence at a throwaway directory for the whole session."""
    tmp_dir = tempfile.mkdtemp(prefix="watch-together-tests-")

    import services.database as database
    import core.config as config

    cache_dir = os.path.join(tmp_dir, "cache")
    os.makedirs(cache_dir, exist_ok=True)

    database.DB_DIR = tmp_dir
    database.DB_FILE = os.path.join(tmp_dir, "watchtogether.db")
    database.LEGACY_ROOMS_FILE = os.path.join(tmp_dir, "rooms.json")
    database.PERSISTED_COOKIE_DIRS = (os.path.join(tmp_dir, "cookies"),)
    # Modules bind these names at import time, so every binding site has
    # to be redirected, not just the definition in core.config.
    config.CACHE_DIR = cache_dir

    import services.cache as cache_module
    cache_module.CACHE_DIR = cache_dir

    import main as main_module
    main_module.CACHE_DIR = cache_dir

    database.init_database()

    yield tmp_dir

    shutil.rmtree(tmp_dir, ignore_errors=True)


@pytest.fixture(autouse=True)
def reset_proxy_client():
    """Drop the shared HTTP client between tests.

    It is a module-level singleton bound to the event loop that created it.
    A test that exercises the proxy would otherwise leave a client behind
    for the next test's app lifespan to close on a different loop, which
    fails during teardown.
    """
    yield
    import main
    main._proxy_client = None


@pytest.fixture(autouse=True)
def offline_sponsorblock():
    """Never let a test reach the real SponsorBlock API.

    Setting a YouTube video in a room triggers a segment lookup; the stub
    answers 404 (no segments) unless a test installs its own transport.
    """
    import httpx
    import main

    main.sponsor_skipper.client.configure(
        api_url="http://sponsorblock.test",
        transport=httpx.MockTransport(lambda request: httpx.Response(404)),
    )
    yield
    main.sponsor_skipper.client.configure(
        api_url="http://sponsorblock.test",
        transport=httpx.MockTransport(lambda request: httpx.Response(404)),
    )


@pytest.fixture(autouse=True)
def offline_watch_history():
    """Never run a real extraction or reach YouTube from a test.

    The reporter's capture step is replaced by one that finds no tracking
    URLs, so no session ever starts unless a test installs its own capture.
    """
    import httpx
    from services import user_settings, watch_history

    async def no_capture(original_url, cookie_path):
        return None

    def offline():
        watch_history.reporter.configure(
            capture=no_capture,
            transport=httpx.MockTransport(lambda request: httpx.Response(204)),
        )
        user_settings.clear_cache()

    offline()
    yield
    offline()


@pytest.fixture(autouse=True)
def empty_cookie_store():
    """No member's cookies survive from one test into the next."""
    from services import user_cookies

    user_cookies.clear_all()
    yield
    user_cookies.clear_all()


@pytest.fixture(autouse=True)
def reset_room_state():
    """Keep room state from leaking between tests."""
    from connection_manager import manager

    manager.room_states.clear()
    manager.active_connections.clear()
    manager._room_locks.clear()
    yield
    manager.room_states.clear()
    manager.active_connections.clear()
    manager._room_locks.clear()
