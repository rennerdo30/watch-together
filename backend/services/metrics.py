"""
Proxy metrics collection.

Records one sample per upstream fetch so streaming failures can be
characterised after the fact: which host, which byte offset, how long
the upstream took, how many bytes reached the client, and how the
transfer ended. Aggregates are kept per host and per error class; raw
samples are kept in a bounded ring buffer for the most recent requests.

This exists because the January HAR capture of the streaming failures
contained only page-load traffic and no segment requests at all, so the
failure signature has to be gathered server-side instead.
"""
import time
import asyncio
import logging
from collections import deque, defaultdict
from typing import Dict, Optional, List

from core.config import (
    METRICS_SAMPLE_CAPACITY,
    METRICS_SLOW_UPSTREAM_MS,
)

logger = logging.getLogger(__name__)


# Terminal states for a proxied transfer.
OUTCOME_OK = "ok"
OUTCOME_UPSTREAM_ERROR = "upstream_error"
OUTCOME_CLIENT_ABORTED = "client_aborted"
OUTCOME_TRUNCATED = "truncated"


class ProxyMetrics:
    """Bounded, in-process collector for proxy transfer samples."""

    def __init__(self, capacity: int = METRICS_SAMPLE_CAPACITY):
        self._samples: deque = deque(maxlen=capacity)
        self._lock = asyncio.Lock()
        self._totals: Dict[str, int] = defaultdict(int)
        self._by_host: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
        self._by_outcome: Dict[str, int] = defaultdict(int)
        self._started_at = time.time()

    async def record(
        self,
        host: str,
        status: Optional[int],
        outcome: str,
        upstream_ms: float,
        transfer_ms: float,
        bytes_sent: int,
        range_start: int = 0,
        expected_bytes: Optional[int] = None,
        error: Optional[str] = None,
    ) -> None:
        """Record one completed (or failed) proxy transfer."""
        sample = {
            "at": time.time(),
            "host": host,
            "status": status,
            "outcome": outcome,
            "upstream_ms": round(upstream_ms, 1),
            "transfer_ms": round(transfer_ms, 1),
            "bytes_sent": bytes_sent,
            "range_start": range_start,
            "expected_bytes": expected_bytes,
            "error": error,
        }

        async with self._lock:
            self._samples.append(sample)
            self._totals["requests"] += 1
            self._totals["bytes_sent"] += bytes_sent
            self._by_outcome[outcome] += 1
            host_stats = self._by_host[host]
            host_stats["requests"] += 1
            host_stats["bytes_sent"] += bytes_sent
            if outcome != OUTCOME_OK:
                host_stats["failures"] += 1
                self._totals["failures"] += 1
            if upstream_ms >= METRICS_SLOW_UPSTREAM_MS:
                self._totals["slow_upstream"] += 1

        if outcome != OUTCOME_OK:
            logger.warning(
                "Proxy transfer %s: host=%s status=%s offset=%d sent=%d "
                "upstream=%.0fms transfer=%.0fms error=%s",
                outcome, host, status, range_start, bytes_sent,
                upstream_ms, transfer_ms, error,
            )
        else:
            logger.debug(
                "Proxy transfer ok: host=%s status=%s offset=%d sent=%d "
                "upstream=%.0fms transfer=%.0fms",
                host, status, range_start, bytes_sent, upstream_ms, transfer_ms,
            )

    async def snapshot(self, sample_limit: int = 50) -> dict:
        """Return aggregates plus the most recent samples."""
        async with self._lock:
            samples: List[dict] = list(self._samples)[-sample_limit:]
            totals = dict(self._totals)
            by_outcome = dict(self._by_outcome)
            by_host = {host: dict(stats) for host, stats in self._by_host.items()}

        failures = [s for s in samples if s["outcome"] != OUTCOME_OK]
        return {
            "uptime_seconds": round(time.time() - self._started_at, 1),
            "totals": totals,
            "by_outcome": by_outcome,
            "by_host": by_host,
            "recent_failures": failures,
            "recent_samples": samples,
        }

    async def reset(self) -> None:
        """Clear all collected data (used by tests and manual runs)."""
        async with self._lock:
            self._samples.clear()
            self._totals.clear()
            self._by_host.clear()
            self._by_outcome.clear()
            self._started_at = time.time()


proxy_metrics = ProxyMetrics()
