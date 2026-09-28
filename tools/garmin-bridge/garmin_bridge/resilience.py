"""Pacing calls to an unofficial API.

Adapted from GARMIN-CLAUDE's ``resilience.py``. The circuit breaker is left
out: the bridge only calls Garmin when somebody presses a button, and a bounded
retry with backoff is enough for that. Clock and sleep are injectable so the
tests run in no time.
"""

from __future__ import annotations

import random
import threading
import time
from collections.abc import Callable

Clock = Callable[[], float]
Sleep = Callable[[float], None]


class TokenBucket:
    """``rate`` calls per second, with a burst of ``burst`` before pacing starts."""

    def __init__(
        self, rate: float = 1.0, burst: int = 5, *, clock: Clock = time.monotonic,
        sleep: Sleep = time.sleep,
    ) -> None:
        if rate <= 0 or burst < 1:
            raise ValueError("rate must be > 0 and burst >= 1")
        self._rate = rate
        self._capacity = float(burst)
        self._tokens = float(burst)
        self._clock = clock
        self._sleep = sleep
        self._updated = clock()
        self._lock = threading.Lock()

    def acquire(self) -> float:
        """Block until a call is allowed; returns the seconds waited."""
        waited = 0.0
        while True:
            with self._lock:
                now = self._clock()
                elapsed = max(0.0, now - self._updated)
                self._tokens = min(self._capacity, self._tokens + elapsed * self._rate)
                self._updated = now
                if self._tokens >= 1.0:
                    self._tokens -= 1.0
                    return waited
                deficit = (1.0 - self._tokens) / self._rate
            self._sleep(deficit)
            waited += deficit


def backoff(
    attempt: int, *, min_wait: float = 2.0, max_wait: float = 120.0,
    rng: Callable[[], float] = random.random,
) -> float:
    """Exponential, with jitter."""
    base = min_wait * (2**attempt)
    return float(min(max_wait, base) * (0.5 + 0.5 * rng()))
