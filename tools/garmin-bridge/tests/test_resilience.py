from garmin_bridge.resilience import TokenBucket, backoff


class Clock:
    def __init__(self):
        self.now = 0.0
        self.slept = []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.slept.append(seconds)
        self.now += seconds


def test_the_burst_is_free_then_calls_are_spaced_by_the_rate():
    clock = Clock()
    bucket = TokenBucket(rate=1.0, burst=5, clock=clock, sleep=clock.sleep)
    waits = [bucket.acquire() for _ in range(7)]
    assert waits[:5] == [0.0] * 5
    assert waits[5] == 1.0
    assert waits[6] == 1.0


def test_tokens_refill_with_time():
    clock = Clock()
    bucket = TokenBucket(rate=1.0, burst=2, clock=clock, sleep=clock.sleep)
    bucket.acquire()
    bucket.acquire()
    clock.now += 10
    assert bucket.acquire() == 0.0


def test_backoff_doubles_and_is_capped():
    low = lambda: 0.0  # noqa: E731
    high = lambda: 1.0  # noqa: E731
    assert backoff(0, rng=high) == 2.0
    assert backoff(1, rng=high) == 4.0
    assert backoff(0, rng=low) == 1.0
    assert backoff(10, rng=high) == 120.0
