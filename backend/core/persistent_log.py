"""
Warnings and errors that outlive the container.

Docker keeps a container's log only as long as the container: every deploy
recreates the backend, so the client errors and refusals that explain a
viewer's trouble were gone exactly when someone went to read them. Records
at WARNING and above are also written here, to a small rotating file in the
data volume, with a timestamp (the console format has none). Bounded:
`max_bytes` × (`backups` + 1) at most.

`./deploy/host-status.sh --errors` reads these files.
"""

import logging
import os
from logging.handlers import RotatingFileHandler

LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"
DATE_FORMAT = "%Y-%m-%dT%H:%M:%S%z"


class _PersistentHandler(RotatingFileHandler):
    """Marks the handler this module installed, so a second call is a no-op."""


def attach_persistent_log(path: str, max_bytes: int, backups: int,
                          level: int = logging.WARNING) -> bool:
    """Also write `level`-and-above records to `path`. False if it cannot."""
    root = logging.getLogger()
    if any(isinstance(handler, _PersistentHandler) for handler in root.handlers):
        return True
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        handler = _PersistentHandler(path, maxBytes=max_bytes, backupCount=backups,
                                     encoding="utf-8", delay=True)
    except OSError as error:
        logging.getLogger(__name__).warning("Persistent log %s unavailable: %s", path, error)
        return False
    handler.setLevel(level)
    handler.setFormatter(logging.Formatter(LOG_FORMAT, DATE_FORMAT))
    root.addHandler(handler)
    return True
