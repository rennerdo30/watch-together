"""
Shared test fixtures.

Every test runs against a temporary database and cookie directory. This
keeps runs reproducible on a clean checkout (CI has no pre-existing
database, so anything touching persistence would fail) and stops the
suite from writing into the real `data/` directory during development.
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
    import core.security as security

    cookies_dir = os.path.join(tmp_dir, "cookies")
    cache_dir = os.path.join(tmp_dir, "cache")
    os.makedirs(cookies_dir, exist_ok=True)
    os.makedirs(cache_dir, exist_ok=True)

    database.DB_DIR = tmp_dir
    database.DB_FILE = os.path.join(tmp_dir, "watchtogether.db")
    database.LEGACY_ROOMS_FILE = os.path.join(tmp_dir, "rooms.json")
    database.LEGACY_COOKIES_DIR = cookies_dir
    # Modules bind these names at import time, so every binding site has
    # to be redirected, not just the definition in core.config.
    config.COOKIES_DIR = cookies_dir
    config.CACHE_DIR = cache_dir
    security.COOKIES_DIR = cookies_dir

    import services.cache as cache_module
    cache_module.CACHE_DIR = cache_dir

    import main as main_module
    main_module.COOKIES_DIR = cookies_dir
    main_module.CACHE_DIR = cache_dir

    import api.routes.cookies as cookies_routes
    cookies_routes.COOKIES_DIR = cookies_dir

    import api.routes.extension as extension_routes
    extension_routes.COOKIES_DIR = cookies_dir

    database.init_database()

    yield tmp_dir

    shutil.rmtree(tmp_dir, ignore_errors=True)


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
