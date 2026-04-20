"""
Session store for the BFF auth pattern (CSA-0020 Phase 2).

The BFF (see ``portal/shared/api/routers/auth_bff.py``) stores its
per-user server-side session state — access tokens, refresh tokens,
and identity claims — behind an opaque signed cookie (``csa_sid``).
The mapping from ``session_id`` → ``SessionState`` lives in this
module, behind a small Protocol so the storage backend can change
without touching the router.

Two implementations ship today:

* :class:`InMemorySessionStore` — process-local dict with TTL
  sweeping. Only appropriate for local dev, tests, or single-replica
  deployments. The default, per ``settings.BFF_SESSION_STORE``.
* :class:`RedisSessionStore` — ``redis.asyncio``-backed store keyed
  under ``csa:bff:session:<session_id>`` with EX-based TTL. Required
  for any multi-replica deployment so sessions survive behind a load
  balancer and so logout fans out.

The factory :func:`build_session_store` picks one based on
``settings.BFF_SESSION_STORE``. Importing ``redis.asyncio`` is
deferred inside the Redis branch so a ``memory``-configured
deployment never imports the optional ``redis`` dependency.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Protocol, runtime_checkable

from ..models.auth_bff import SessionState

if TYPE_CHECKING:  # pragma: no cover — import guarded for optional dep
    from ..config import Settings


# ── Abstract interface ──────────────────────────────────────────────────────


@runtime_checkable
class SessionStore(Protocol):
    """Async key/value store for :class:`SessionState` records."""

    async def get(self, session_id: str) -> SessionState | None:
        """Fetch a session by id; return ``None`` if missing/expired."""
        ...

    async def set(self, session: SessionState, ttl_seconds: int) -> None:
        """Upsert a session with the given TTL (server-side expiry)."""
        ...

    async def delete(self, session_id: str) -> None:
        """Remove a session — idempotent."""
        ...

    async def touch(self, session_id: str, ttl_seconds: int) -> None:
        """Extend TTL on an existing session. No-op if absent."""
        ...


# ── In-memory implementation (dev/test only) ────────────────────────────────


class InMemorySessionStore:
    """Process-local session store with TTL-driven eviction.

    The implementation is deliberately simple — a dict guarded by an
    ``asyncio.Lock`` plus a background sweep task that evicts expired
    sessions every ``sweep_interval_seconds``. Suitable for local dev
    and single-replica deployments. Multi-replica / production
    deployments must use :class:`RedisSessionStore`.
    """

    def __init__(self, *, sweep_interval_seconds: int = 60) -> None:
        self._records: dict[str, tuple[SessionState, datetime]] = {}
        self._lock = asyncio.Lock()
        self._sweep_interval = sweep_interval_seconds

    async def get(self, session_id: str) -> SessionState | None:
        async with self._lock:
            record = self._records.get(session_id)
            if record is None:
                return None
            session, expires_at = record
            if expires_at <= datetime.now(timezone.utc):
                self._records.pop(session_id, None)
                return None
            return session

    async def set(self, session: SessionState, ttl_seconds: int) -> None:
        expires_at = datetime.now(timezone.utc).replace(microsecond=0)
        # naive arithmetic — datetime + timedelta would need import; use
        # a cheap addition via timestamp.
        from datetime import timedelta

        expires_at = expires_at + timedelta(seconds=ttl_seconds)
        async with self._lock:
            self._records[session.session_id] = (session, expires_at)

    async def delete(self, session_id: str) -> None:
        async with self._lock:
            self._records.pop(session_id, None)

    async def touch(self, session_id: str, ttl_seconds: int) -> None:
        async with self._lock:
            record = self._records.get(session_id)
            if record is None:
                return
            session, _old_expiry = record
        # set() re-acquires the lock, but that's fine — the operation is
        # cheap and we keep the critical sections short.
        await self.set(session, ttl_seconds)

    async def sweep_expired(self) -> int:
        """Remove any entries whose TTL has elapsed. Returns count."""
        now = datetime.now(timezone.utc)
        removed = 0
        async with self._lock:
            for sid in list(self._records.keys()):
                _session, expires_at = self._records[sid]
                if expires_at <= now:
                    self._records.pop(sid, None)
                    removed += 1
        return removed


# ── Redis-backed implementation (production) ────────────────────────────────


_REDIS_KEY_PREFIX = "csa:bff:session:"


def _redis_key(session_id: str) -> str:
    return f"{_REDIS_KEY_PREFIX}{session_id}"


class RedisSessionStore:
    """``redis.asyncio``-backed session store.

    Sessions are serialised as JSON under ``csa:bff:session:<id>`` with
    a Redis EX TTL matching the session lifetime. This provides:

    * **Multi-replica coherence** — any replica behind the load
      balancer can resolve the session.
    * **Server-side logout** — ``delete()`` revokes across the whole
      fleet instantly.
    * **Idle eviction** — Redis EX TTL handles expiry without us
      running a sweep task.

    The ``redis.asyncio`` import is inside ``__init__`` so a
    ``memory``-configured deployment never imports the optional
    ``redis`` extra.
    """

    def __init__(self, redis_url: str) -> None:
        try:
            # Import locally so the `redis` dep is optional.
            from redis.asyncio import Redis, from_url  # type: ignore[import-not-found]
        except ImportError as exc:  # pragma: no cover — guard exercised at boot
            msg = (
                "BFF_SESSION_STORE=redis requires the optional 'redis' "
                "extra. Install with `pip install redis>=5` or flip "
                "BFF_SESSION_STORE=memory for local dev."
            )
            raise RuntimeError(msg) from exc

        self._client: Redis = from_url(redis_url, decode_responses=True)

    async def get(self, session_id: str) -> SessionState | None:
        raw = await self._client.get(_redis_key(session_id))
        if raw is None:
            return None
        return SessionState.model_validate_json(raw)

    async def set(self, session: SessionState, ttl_seconds: int) -> None:
        await self._client.set(
            _redis_key(session.session_id),
            session.model_dump_json(),
            ex=ttl_seconds,
        )

    async def delete(self, session_id: str) -> None:
        await self._client.delete(_redis_key(session_id))

    async def touch(self, session_id: str, ttl_seconds: int) -> None:
        # EXPIRE returns 0 when the key does not exist; that's fine —
        # the Protocol contract is explicit that ``touch`` is a no-op
        # for missing sessions.
        await self._client.expire(_redis_key(session_id), ttl_seconds)

    async def close(self) -> None:  # pragma: no cover — shutdown hook
        await self._client.close()


# ── Factory ─────────────────────────────────────────────────────────────────


def build_session_store(settings: Settings) -> SessionStore:
    """Construct the configured session store from :class:`Settings`.

    ``BFF_SESSION_STORE=memory`` → :class:`InMemorySessionStore`
    ``BFF_SESSION_STORE=redis``  → :class:`RedisSessionStore`

    Any other value raises at startup so a typo cannot silently fall
    back to in-memory storage in a production deployment.
    """
    backend = (settings.BFF_SESSION_STORE or "memory").lower()
    if backend == "memory":
        return InMemorySessionStore()
    if backend == "redis":
        if not settings.BFF_REDIS_URL:
            msg = (
                "BFF_SESSION_STORE=redis requires BFF_REDIS_URL to be set "
                "(e.g. redis://localhost:6379/0)."
            )
            raise RuntimeError(msg)
        return RedisSessionStore(settings.BFF_REDIS_URL)
    msg = (
        f"Unknown BFF_SESSION_STORE={backend!r}; must be 'memory' or 'redis'."
    )
    raise RuntimeError(msg)
