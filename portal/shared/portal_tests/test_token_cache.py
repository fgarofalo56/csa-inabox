"""
Tests for the persistent, HMAC-sealed MSAL token cache — CSA-0020 Phase 3.

Covers:

* Round-trip seal / unseal via both the ``InMemoryTokenCacheBackend``
  and a monkey-patched ``RedisTokenCacheBackend`` — same test battery,
  parameterised on the backend fixture.
* Tamper detection — flipping a byte in the sealed blob is rejected
  and emits the ``bff.token_cache.tamper_detected`` log event.
* TTL expiry for the in-memory backend.
* Redis client key-prefixing and TTL plumbing.
* ``derive_cache_key()`` determinism + non-disclosure of raw session id.
"""

from __future__ import annotations

import logging

import pytest
from portal.shared.api.config import Settings
from portal.shared.api.services import token_cache as tc

# Sync tests carry no marker; async tests carry ``pytest.mark.asyncio``
# explicitly (vs a module-level pytestmark) so pytest-asyncio doesn't
# warn about decorating plain functions.
_async = pytest.mark.asyncio


# ── Fakes ──────────────────────────────────────────────────────────────────


class FakeRedisClient:
    """Minimal in-memory stand-in for ``redis.asyncio.Redis``.

    Implements only the three methods the token-cache backend calls —
    ``get``, ``set``, ``delete`` — with bytes values and a TTL we
    ignore (TTL correctness is a Redis-server property, not ours).
    """

    def __init__(self) -> None:
        self.store: dict[str, bytes] = {}
        self.set_calls: list[tuple[str, bytes, int]] = []

    async def get(self, key: str) -> bytes | None:
        return self.store.get(key)

    async def set(self, key: str, value: bytes, ex: int | None = None) -> None:
        self.set_calls.append((key, value, ex or 0))
        self.store[key] = value

    async def delete(self, key: str) -> None:
        self.store.pop(key, None)


def _settings_for_cache(backend: str = "memory") -> Settings:
    return Settings(
        AUTH_MODE="bff",
        BFF_TENANT_ID="t",
        BFF_CLIENT_ID="c",
        BFF_CLIENT_SECRET="s",
        BFF_SESSION_SIGNING_KEY="x" * 64,
        BFF_TOKEN_CACHE_BACKEND=backend,
        BFF_TOKEN_CACHE_HMAC_KEY="k" * 64,
        BFF_TOKEN_CACHE_TTL_SECONDS=60,
        BFF_REDIS_URL="redis://localhost:6379/0",
    )


# ── Key derivation ─────────────────────────────────────────────────────────


def test_derive_cache_key_is_deterministic_and_sha256_namespaced() -> None:
    key = tc.derive_cache_key("session-abc")
    assert key.startswith("csa:bff:tcache:")
    # Same input → same hash.
    assert tc.derive_cache_key("session-abc") == key
    # Different input → different hash.
    assert tc.derive_cache_key("session-abd") != key
    # Raw session id is never embedded.
    assert "session-abc" not in key


# ── Seal / unseal primitives ───────────────────────────────────────────────


def test_seal_then_unseal_round_trip() -> None:
    key = b"k" * 64
    body = b'{"cache":"blob","account":"oid"}'
    sealed = tc._seal(key, body)
    assert tc._unseal(key, sealed) == body


def test_unseal_detects_body_tamper() -> None:
    key = b"k" * 64
    sealed = tc._seal(key, b"original-body")
    tampered = bytearray(sealed)
    # Flip a byte inside the body region.
    tampered[-1] ^= 0x01
    with pytest.raises(tc.TokenCacheTamperedError):
        tc._unseal(key, bytes(tampered))


def test_unseal_detects_mac_tamper() -> None:
    key = b"k" * 64
    sealed = tc._seal(key, b"original-body")
    tampered = bytearray(sealed)
    tampered[tc._NONCE_SIZE] ^= 0x01
    with pytest.raises(tc.TokenCacheTamperedError):
        tc._unseal(key, bytes(tampered))


def test_unseal_rejects_short_blob() -> None:
    key = b"k" * 64
    with pytest.raises(tc.TokenCacheTamperedError):
        tc._unseal(key, b"tiny")


def test_seal_produces_fresh_nonce_each_call() -> None:
    key = b"k" * 64
    body = b"same-body"
    a = tc._seal(key, body)
    b = tc._seal(key, body)
    assert a != b


# ── SealedTokenCache round-trip (in-memory backend) ────────────────────────


@_async
async def test_sealed_cache_in_memory_round_trip() -> None:
    backend = tc.InMemoryTokenCacheBackend()
    settings = _settings_for_cache("memory")
    cache = tc.build_sealed_cache(
        backend=backend, settings=settings, session_id="sess-1",
    )
    # MSAL cache is empty until first save/load; we simulate MSAL setting
    # has_state_changed after an ``acquire_token_*`` call.
    cache.deserialize('{"foo":"bar"}')
    cache.has_state_changed = True
    await cache.async_save()

    cache2 = tc.build_sealed_cache(
        backend=backend, settings=settings, session_id="sess-1",
    )
    await cache2.async_load()
    # MSAL's serialize() round-trips the JSON contents we injected.
    assert "foo" in cache2.serialize()


@_async
async def test_sealed_cache_noop_save_when_state_unchanged() -> None:
    backend = tc.InMemoryTokenCacheBackend()
    settings = _settings_for_cache("memory")
    cache = tc.build_sealed_cache(
        backend=backend, settings=settings, session_id="sess-noop",
    )
    # Has not been mutated — save() is a no-op.
    cache.has_state_changed = False
    await cache.async_save()
    assert await backend.load(cache.cache_key) is None


@_async
async def test_sealed_cache_tamper_detection_logs_and_returns_empty(
    caplog: pytest.LogCaptureFixture,
) -> None:
    backend = tc.InMemoryTokenCacheBackend()
    settings = _settings_for_cache("memory")
    cache = tc.build_sealed_cache(
        backend=backend, settings=settings, session_id="sess-tamper",
    )
    cache.deserialize('{"foo":"bar"}')
    cache.has_state_changed = True
    await cache.async_save()

    # Flip a byte inside the backend blob.
    sealed = await backend.load(cache.cache_key)
    assert sealed is not None
    tampered = bytearray(sealed)
    tampered[-1] ^= 0x01
    await backend.save(cache.cache_key, bytes(tampered), 60)

    # Reload → tamper path → blob purged, log emitted.
    cache2 = tc.build_sealed_cache(
        backend=backend, settings=settings, session_id="sess-tamper",
    )
    with caplog.at_level(logging.ERROR):
        await cache2.async_load()
    # The tampered blob was purged so subsequent loads see nothing.
    assert await backend.load(cache.cache_key) is None
    assert any("tamper_detected" in rec.getMessage() for rec in caplog.records)


@_async
async def test_sealed_cache_ttl_expiry_in_memory() -> None:
    backend = tc.InMemoryTokenCacheBackend()
    # Manually place a blob with an elapsed TTL so we don't have to sleep.
    backend._records["csa:bff:tcache:expired"] = (b"sealed", 0.0)
    assert await backend.load("csa:bff:tcache:expired") is None


# ── RedisTokenCacheBackend (monkey-patched) ────────────────────────────────


@_async
async def test_redis_backend_round_trip_via_injected_client() -> None:
    fake = FakeRedisClient()
    backend = tc.RedisTokenCacheBackend("redis://localhost:6379/0", client=fake)
    await backend.save("csa:bff:tcache:abc", b"hello", 30)
    assert fake.set_calls == [("csa:bff:tcache:abc", b"hello", 30)]
    assert await backend.load("csa:bff:tcache:abc") == b"hello"
    await backend.delete("csa:bff:tcache:abc")
    assert await backend.load("csa:bff:tcache:abc") is None


@_async
async def test_sealed_cache_round_trip_via_redis_backend() -> None:
    fake = FakeRedisClient()
    backend = tc.RedisTokenCacheBackend("redis://x", client=fake)
    settings = _settings_for_cache("redis")

    cache = tc.build_sealed_cache(
        backend=backend, settings=settings, session_id="sess-redis",
    )
    cache.deserialize('{"a":1}')
    cache.has_state_changed = True
    await cache.async_save()

    cache2 = tc.build_sealed_cache(
        backend=backend, settings=settings, session_id="sess-redis",
    )
    await cache2.async_load()
    assert '"a"' in cache2.serialize()


@_async
async def test_sealed_cache_redis_tamper_detection(
    caplog: pytest.LogCaptureFixture,
) -> None:
    fake = FakeRedisClient()
    backend = tc.RedisTokenCacheBackend("redis://x", client=fake)
    settings = _settings_for_cache("redis")

    cache = tc.build_sealed_cache(
        backend=backend, settings=settings, session_id="sess-r-tamper",
    )
    cache.deserialize('{"a":1}')
    cache.has_state_changed = True
    await cache.async_save()

    # Tamper Redis contents — flip a byte.
    key = cache.cache_key
    fake.store[key] = fake.store[key][:-1] + bytes([fake.store[key][-1] ^ 0x42])

    cache2 = tc.build_sealed_cache(
        backend=backend, settings=settings, session_id="sess-r-tamper",
    )
    with caplog.at_level(logging.ERROR):
        await cache2.async_load()
    assert key not in fake.store
    assert any("tamper_detected" in rec.getMessage() for rec in caplog.records)


# ── Factory ────────────────────────────────────────────────────────────────


def test_build_token_cache_backend_memory() -> None:
    backend = tc.build_token_cache_backend(_settings_for_cache("memory"))
    assert isinstance(backend, tc.InMemoryTokenCacheBackend)


def test_build_token_cache_backend_redis_with_injected_client() -> None:
    fake = FakeRedisClient()
    backend = tc.build_token_cache_backend(
        _settings_for_cache("redis"), redis_client=fake,
    )
    assert isinstance(backend, tc.RedisTokenCacheBackend)
