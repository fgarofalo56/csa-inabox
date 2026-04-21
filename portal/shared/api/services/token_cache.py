"""
Persistent, HMAC-sealed MSAL token cache — CSA-0020 Phase 3 / ADR-0019.

``msal.ConfidentialClientApplication`` owns a :class:`msal.SerializableTokenCache`
per process. In Phase 2 that cache lived entirely in memory and was
re-hydrated from the stored refresh token on every process restart —
correct, but forces a round-trip to Entra ID on the first call after
each deploy or pod recycle.

Phase 3 persists the serialised cache to a pluggable backend (in-memory
for dev, Redis for prod) and **seals** each blob with an HMAC so a
Redis compromise cannot silently inject attacker-controlled cache state
(e.g. poisoned accounts, forged refresh tokens). Sealing is:

    nonce ‖ HMAC-SHA256(key, nonce ‖ cache_body) ‖ cache_body

The nonce is 16 random bytes per save. Loads recompute the HMAC and
reject on mismatch, logging ``bff.token_cache.tamper_detected`` at
ERROR so the tamper event shows up in SIEM queries.

One cache is kept per session so signing out a user purges that user's
MSAL state without touching other sessions. Keys are namespaced with
``csa:bff:tcache:<sha256(session_id)>``; the raw session id is never
written to Redis.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
from typing import TYPE_CHECKING, Protocol, runtime_checkable

import msal

if TYPE_CHECKING:  # pragma: no cover — import guarded for optional dep
    from ..config import Settings


logger = logging.getLogger(__name__)


# ── Typed error surface ─────────────────────────────────────────────────────


class TokenCacheTamperedError(Exception):
    """Raised when a loaded blob fails HMAC verification.

    Not surfaced to callers of the cache directly — ``load()`` logs the
    tamper event and returns ``None`` so MSAL re-acquires from the
    refresh token. The exception class exists so the sealing routines
    can raise/assert internally and so tests can pin the behaviour.
    """


# ── Backend Protocol + implementations ──────────────────────────────────────


@runtime_checkable
class TokenCacheBackend(Protocol):
    """Async key/value store for serialised MSAL cache blobs."""

    async def load(self, key: str) -> bytes | None:
        """Return the raw blob for ``key`` or ``None`` if missing."""
        ...

    async def save(self, key: str, blob: bytes, ttl_seconds: int) -> None:
        """Upsert ``blob`` under ``key`` with ``ttl_seconds`` TTL."""
        ...

    async def delete(self, key: str) -> None:
        """Remove a blob — idempotent."""
        ...


class InMemoryTokenCacheBackend:
    """Process-local backend used in dev/tests.

    Sessions are short-lived and TTL is enforced lazily on ``load``;
    there is no background sweeper because the in-memory path is only
    appropriate for single-replica, short-lived processes.
    """

    def __init__(self) -> None:
        # Value is (blob, expires_at_monotonic_seconds). Monotonic clock
        # avoids wall-clock skew issues inside tests.
        self._records: dict[str, tuple[bytes, float]] = {}

    async def load(self, key: str) -> bytes | None:
        import time

        record = self._records.get(key)
        if record is None:
            return None
        blob, expires_at = record
        if expires_at <= time.monotonic():
            self._records.pop(key, None)
            return None
        return blob

    async def save(self, key: str, blob: bytes, ttl_seconds: int) -> None:
        import time

        self._records[key] = (blob, time.monotonic() + ttl_seconds)

    async def delete(self, key: str) -> None:
        self._records.pop(key, None)


_REDIS_TCACHE_PREFIX = "csa:bff:tcache:"


class RedisTokenCacheBackend:
    """``redis.asyncio``-backed token cache backend.

    Keys are namespaced under ``csa:bff:tcache:`` and carry a Redis EX
    TTL matching ``BFF_TOKEN_CACHE_TTL_SECONDS``. ``redis.asyncio`` is
    imported inside ``__init__`` so a ``memory``-configured deployment
    never pulls the optional redis extra into the import graph.
    """

    def __init__(self, redis_url: str, *, client: object | None = None) -> None:
        if client is not None:
            # Injected client — used by tests with a monkeypatched
            # redis.asyncio.Redis. Avoids any real network reach during
            # pytest runs.
            self._client = client
            return
        try:
            from redis.asyncio import from_url
        except ImportError as exc:  # pragma: no cover — guard exercised at boot
            msg = (
                "BFF_TOKEN_CACHE_BACKEND=redis requires the optional "
                "'redis' extra. Install with `pip install redis>=5` or "
                "flip BFF_TOKEN_CACHE_BACKEND=memory for local dev."
            )
            raise RuntimeError(msg) from exc
        # ``decode_responses=False`` — we store raw bytes (the sealed
        # blob). Redis returns str when decoded, which breaks HMAC.
        self._client = from_url(redis_url, decode_responses=False)

    async def load(self, key: str) -> bytes | None:
        raw = await self._client.get(key)  # type: ignore[attr-defined]
        if raw is None:
            return None
        if isinstance(raw, str):
            # Defensive — some mock clients decode. Re-encode so the
            # HMAC check uses the exact bytes we signed.
            return raw.encode("utf-8")
        return bytes(raw)

    async def save(self, key: str, blob: bytes, ttl_seconds: int) -> None:
        await self._client.set(key, blob, ex=ttl_seconds)  # type: ignore[attr-defined]

    async def delete(self, key: str) -> None:
        await self._client.delete(key)  # type: ignore[attr-defined]


# ── HMAC sealing primitives ─────────────────────────────────────────────────


_NONCE_SIZE = 16
_HMAC_SIZE = 32  # HMAC-SHA256 digest size


def _seal(key_bytes: bytes, body: bytes) -> bytes:
    """Seal ``body`` with HMAC-SHA256 and a fresh 16-byte nonce.

    Layout: ``nonce || mac || body``. The nonce is included in the MAC
    input so two seals of identical bodies produce different output —
    this isn't confidentiality (MSAL cache bodies are not secret beyond
    the session the cache belongs to), but it prevents replay detection
    patterns from leaking repeat-count metadata.
    """
    nonce = os.urandom(_NONCE_SIZE)
    mac = hmac.new(key_bytes, nonce + body, hashlib.sha256).digest()
    return nonce + mac + body


def _unseal(key_bytes: bytes, sealed: bytes) -> bytes:
    """Verify and strip the HMAC seal from ``sealed``.

    Raises :class:`TokenCacheTamperedError` when the MAC does not match,
    when the blob is too short to contain a nonce + MAC, or when the
    HMAC comparison fails — :func:`hmac.compare_digest` is used so the
    check is constant-time against attacker-chosen lengths.
    """
    if len(sealed) < _NONCE_SIZE + _HMAC_SIZE:
        msg = "sealed blob is shorter than nonce+mac prefix"
        raise TokenCacheTamperedError(msg)
    nonce = sealed[:_NONCE_SIZE]
    received_mac = sealed[_NONCE_SIZE : _NONCE_SIZE + _HMAC_SIZE]
    body = sealed[_NONCE_SIZE + _HMAC_SIZE :]
    expected_mac = hmac.new(key_bytes, nonce + body, hashlib.sha256).digest()
    if not hmac.compare_digest(received_mac, expected_mac):
        msg = "HMAC mismatch on token-cache blob"
        raise TokenCacheTamperedError(msg)
    return body


# ── MSAL cache subclass ─────────────────────────────────────────────────────


class SealedTokenCache(msal.SerializableTokenCache):  # type: ignore[misc]
    """MSAL cache that persists to a :class:`TokenCacheBackend`.

    MSAL drives serialisation synchronously via the :meth:`serialize`
    and :meth:`deserialize` hooks on the base class. This subclass
    mirrors those with async ``async_load`` / ``async_save`` methods
    that :class:`~portal.shared.api.services.token_broker.TokenBroker`
    calls around every ``acquire_token_*`` invocation.

    The sync ``serialize`` / ``deserialize`` are left intact because
    MSAL calls them internally; we just avoid relying on them.
    """

    def __init__(
        self,
        *,
        backend: TokenCacheBackend,
        hmac_key: bytes,
        ttl_seconds: int,
        cache_key: str,
    ) -> None:
        super().__init__()
        self._backend = backend
        self._hmac_key = hmac_key
        self._ttl_seconds = ttl_seconds
        self._cache_key = cache_key

    @property
    def cache_key(self) -> str:
        """Expose the backend key for tests + tamper-log correlation."""
        return self._cache_key

    async def async_load(self) -> None:
        """Hydrate this cache instance from the backend.

        On tamper detection we log at ERROR + return silently so MSAL
        treats the cache as empty and re-acquires from the refresh
        token. This is the safe failure mode — no tokens reused from
        a tampered blob.
        """
        # Lazy import avoids pulling prometheus_client into the import
        # graph of a deployment that never enabled metrics.
        from ..observability.metrics import record_token_cache_hit

        sealed = await self._backend.load(self._cache_key)
        if sealed is None:
            logger.debug(
                "bff.token_cache.miss cache_key=%s", self._cache_key
            )
            record_token_cache_hit("miss")
            return
        try:
            body = _unseal(self._hmac_key, sealed)
        except TokenCacheTamperedError as exc:
            logger.error(
                "bff.token_cache.tamper_detected cache_key=%s reason=%s",
                self._cache_key,
                exc,
            )
            # Purge the tampered blob so the next acquisition writes a
            # fresh one — and the next ``async_load`` does not keep
            # re-reporting the same tamper event on every request.
            await self._backend.delete(self._cache_key)
            record_token_cache_hit("tamper")
            return
        self.deserialize(body.decode("utf-8"))
        logger.debug(
            "bff.token_cache.hit cache_key=%s bytes=%d",
            self._cache_key,
            len(body),
        )
        record_token_cache_hit("hit")

    async def async_save(self) -> None:
        """Persist this cache instance back to the backend if dirty.

        ``has_state_changed`` is an MSAL-level flag flipped inside the
        ``acquire_token_*`` call path when the cache mutates. Re-sealing
        only on changes keeps Redis writes minimal.
        """
        if not self.has_state_changed:  # type: ignore[has-type]
            return
        body = self.serialize().encode("utf-8")
        sealed = _seal(self._hmac_key, body)
        await self._backend.save(self._cache_key, sealed, self._ttl_seconds)
        # MSAL documents that callers should reset the flag after
        # persisting so subsequent no-op acquisitions don't re-write.
        self.has_state_changed = False


# ── Factory ─────────────────────────────────────────────────────────────────


def derive_cache_key(session_id: str) -> str:
    """Return the backend key for a session.

    The raw session id is never written to the backend; we hash with
    SHA-256 so log scrapers that accidentally surface the key cannot
    replay it against the session store.
    """
    digest = hashlib.sha256(session_id.encode("utf-8")).hexdigest()
    return f"{_REDIS_TCACHE_PREFIX}{digest}"


def build_token_cache_backend(
    settings: Settings,
    *,
    redis_client: object | None = None,
) -> TokenCacheBackend:
    """Construct the configured :class:`TokenCacheBackend`.

    ``redis_client`` is an optional override used by tests to inject a
    monkeypatched ``redis.asyncio.Redis`` — never used in production.
    """
    backend = settings.BFF_TOKEN_CACHE_BACKEND
    if backend == "memory":
        return InMemoryTokenCacheBackend()
    if backend == "redis":
        if not settings.BFF_REDIS_URL and redis_client is None:
            msg = (
                "BFF_TOKEN_CACHE_BACKEND=redis requires BFF_REDIS_URL to be set "
                "(e.g. redis://localhost:6379/0)."
            )
            raise RuntimeError(msg)
        return RedisTokenCacheBackend(
            settings.BFF_REDIS_URL, client=redis_client,
        )
    # pydantic Literal["memory","redis"] already rejects anything else,
    # but belt-and-braces the check so future settings shape changes
    # fail loudly rather than silently selecting in-memory.
    msg = f"Unknown BFF_TOKEN_CACHE_BACKEND={backend!r}."
    raise RuntimeError(msg)


def build_sealed_cache(
    *,
    backend: TokenCacheBackend,
    settings: Settings,
    session_id: str,
) -> SealedTokenCache:
    """Build a :class:`SealedTokenCache` for ``session_id``.

    The HMAC key is read from the settings :class:`SecretStr` inside
    this narrow call path; secrets never appear in log lines or in the
    cache instance's ``repr``.
    """
    hmac_key = settings.BFF_TOKEN_CACHE_HMAC_KEY.get_secret_value().encode("utf-8")
    return SealedTokenCache(
        backend=backend,
        hmac_key=hmac_key,
        ttl_seconds=settings.BFF_TOKEN_CACHE_TTL_SECONDS,
        cache_key=derive_cache_key(session_id),
    )


__all__ = [
    "InMemoryTokenCacheBackend",
    "RedisTokenCacheBackend",
    "SealedTokenCache",
    "TokenCacheBackend",
    "TokenCacheTamperedError",
    "build_sealed_cache",
    "build_token_cache_backend",
    "derive_cache_key",
]
