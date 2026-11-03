"""
Warnings outlive the container.

Every deploy recreates the backend, and Docker drops a recreated container's
log: the client errors that explained a viewer's broken playback were gone
when someone went to read them. WARNING-and-above records are also written to
a bounded rotating file in the data volume, with a timestamp.
"""
import logging
import os
import re

import pytest

from core import persistent_log
from core.persistent_log import attach_persistent_log


def _persistent_handlers():
    return [h for h in logging.getLogger().handlers if isinstance(h, persistent_log._PersistentHandler)]


def test_the_backend_attaches_it_on_import():
    import main  # noqa: F401
    from core.config import PERSISTENT_LOG_FILE
    handlers = _persistent_handlers()
    assert len(handlers) == 1
    assert handlers[0].baseFilename == os.path.abspath(PERSISTENT_LOG_FILE)
    assert handlers[0].level == logging.WARNING


@pytest.fixture
def own_handler_only():
    """Swap the backend's handler out for the test's own, and back after."""
    root = logging.getLogger()
    original = _persistent_handlers()
    for handler in original:
        root.removeHandler(handler)
    yield
    for handler in _persistent_handlers():
        root.removeHandler(handler)
        handler.close()
    for handler in original:
        root.addHandler(handler)


def test_warnings_land_in_the_file_with_a_timestamp_and_info_does_not(tmp_path, own_handler_only):
    path = tmp_path / "logs" / "warnings.log"
    assert attach_persistent_log(str(path), 1024 * 1024, 2)
    assert attach_persistent_log(str(path), 1024 * 1024, 2)  # Idempotent: one handler.
    assert len(_persistent_handlers()) == 1
    logging.getLogger("services.client_errors").warning("Client error: %s", '{"source": "shaka", "code": 1001}')
    logging.getLogger("x").info("routine")
    for handler in _persistent_handlers():
        handler.flush()
    lines = path.read_text().splitlines()
    assert len(lines) == 1
    assert re.match(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d{4} WARNING services.client_errors: Client error: ",
                    lines[0])


def test_the_file_is_bounded(tmp_path, own_handler_only):
    path = tmp_path / "warnings.log"
    attach_persistent_log(str(path), 2000, 2)
    for i in range(500):
        logging.getLogger("flood").warning("line %d %s", i, "x" * 40)
    files = sorted(name for name in os.listdir(tmp_path) if name.startswith("warnings.log"))
    assert files == ["warnings.log", "warnings.log.1", "warnings.log.2"]
    assert sum(os.path.getsize(tmp_path / name) for name in files) <= 3 * 2000 + 200
