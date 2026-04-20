"""Multi-turn conversation state for the CSA Copilot (post-Phase-1).

The Phase-1 ``CopilotAgent.ask`` is single-turn by design: every
question is retrieved and grounded in isolation.  Real operator
workflows ("rotate a secret" → "what if the vault is replicated?" →
"how do I roll back?") require bounded context across turns.

This module ships:

* :class:`ConversationStore` Protocol — async CRUD for
  :class:`ConversationState` records keyed by ``conversation_id``.
* :class:`InMemoryConversationStore` — dict-backed default, safe for
  local dev and single-replica deployments.
* :class:`RedisConversationStore` — ``redis.asyncio``-backed store
  under ``csa:copilot:conv:<id>`` with EX TTL for multi-replica
  deployments.  The ``redis`` import is deferred inside ``__init__`` so
  ``memory``-configured deployments never pull the optional dep.
* :class:`ConversationSummarizer` — deterministic, LLM-free history
  condenser.  Joins turns into a compact Q/A transcript, trims to fit
  ``conversation_max_history_tokens`` with a simple char-per-4-tokens
  approximation.
* :func:`build_conversation_store` — factory keyed by
  :attr:`CopilotSettings.conversation_store`.

The Protocol shape mirrors ``portal/shared/api/services/session_store.py``
so the two stores feel idiomatic side-by-side.  It is deliberately NOT
imported from the portal: the Copilot is a standalone app and cannot
take a cross-cutting dependency on ``portal/``.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field

from apps.copilot.models import ConversationTurn
from csa_platform.common.logging import get_logger

if TYPE_CHECKING:  # pragma: no cover
    from apps.copilot.config import CopilotSettings

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class ConversationNotFoundError(KeyError):
    """Raised when a conversation_id is referenced but not present in the store."""


class ConversationHistoryLimitExceededError(RuntimeError):
    """Raised when a caller refuses to accept trimmed history.

    The store itself silently trims — this error is only raised by
    explicit ``raise_on_trim=True`` callers (currently unused by the
    default agent path, kept for upstream integrations).
    """


# Legacy alias — the original spec names the error without the ``Error``
# suffix; ruff's N818 rule requires the suffix, so we expose both.
ConversationHistoryLimitExceeded = ConversationHistoryLimitExceededError


# ---------------------------------------------------------------------------
# State DTO
# ---------------------------------------------------------------------------


class ConversationState(BaseModel):
    """Durable state for a multi-turn conversation.

    The DTO is frozen — mutations are expressed by building a new
    instance with :meth:`with_turn_appended`.  Turn indexes are
    contiguous (0, 1, 2, ...) because trimming removes oldest entries
    but never creates gaps in *this* representation.  Callers that need
    the original indexes should consult the indexes on the individual
    turns (which ARE preserved across trims).
    """

    conversation_id: str = Field(description="Opaque UUID4 identifier.")
    created_at: datetime = Field(description="When the conversation was started.")
    turns: list[ConversationTurn] = Field(
        default_factory=list,
        description="Turns in chronological order (oldest first).",
    )

    model_config = ConfigDict(frozen=True)

    def with_turn_appended(
        self,
        turn: ConversationTurn,
        *,
        max_turns: int,
        max_history_tokens: int,
    ) -> ConversationState:
        """Return a new state with *turn* appended and history trimmed.

        Trimming rules (applied in order):
        1. If the turn count exceeds ``max_turns``, drop oldest turns
           until the count fits.
        2. If the sum of ``approx_tokens`` across retained turns
           exceeds ``max_history_tokens``, drop oldest turns until the
           budget fits (always keep the newly-appended turn).
        """
        appended = [*self.turns, turn]

        # Enforce turn count.
        if len(appended) > max_turns:
            appended = appended[-max_turns:]

        # Enforce token budget — keep the newly added turn as the anchor.
        total = sum(t.approx_tokens for t in appended)
        while total > max_history_tokens and len(appended) > 1:
            dropped = appended.pop(0)
            total -= dropped.approx_tokens

        return ConversationState(
            conversation_id=self.conversation_id,
            created_at=self.created_at,
            turns=appended,
        )


# ---------------------------------------------------------------------------
# Protocol
# ---------------------------------------------------------------------------


@runtime_checkable
class ConversationStore(Protocol):
    """Async key/value store for :class:`ConversationState` records."""

    async def get(self, conversation_id: str) -> ConversationState | None:
        """Fetch state by id; return ``None`` if missing or expired."""
        ...

    async def set(self, state: ConversationState, ttl_seconds: int) -> None:
        """Upsert state with the given TTL."""
        ...

    async def delete(self, conversation_id: str) -> None:
        """Remove a conversation — idempotent."""
        ...


# ---------------------------------------------------------------------------
# In-memory implementation
# ---------------------------------------------------------------------------


class InMemoryConversationStore:
    """Process-local conversation store with TTL-driven eviction.

    Suitable for local dev, tests, and single-replica CLI REPL
    sessions.  Multi-replica / API deployments should use
    :class:`RedisConversationStore`.
    """

    def __init__(self) -> None:
        self._records: dict[str, tuple[ConversationState, datetime]] = {}
        self._lock = asyncio.Lock()

    async def get(self, conversation_id: str) -> ConversationState | None:
        async with self._lock:
            record = self._records.get(conversation_id)
            if record is None:
                return None
            state, expires_at = record
            if expires_at <= datetime.now(timezone.utc):
                self._records.pop(conversation_id, None)
                return None
            return state

    async def set(self, state: ConversationState, ttl_seconds: int) -> None:
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)
        async with self._lock:
            self._records[state.conversation_id] = (state, expires_at)

    async def delete(self, conversation_id: str) -> None:
        async with self._lock:
            self._records.pop(conversation_id, None)


# ---------------------------------------------------------------------------
# Redis-backed implementation
# ---------------------------------------------------------------------------


_REDIS_KEY_PREFIX = "csa:copilot:conv:"


def _redis_key(conversation_id: str) -> str:
    return f"{_REDIS_KEY_PREFIX}{conversation_id}"


class RedisConversationStore:
    """``redis.asyncio``-backed conversation store.

    State is serialised as JSON under ``csa:copilot:conv:<id>`` with a
    Redis EX TTL matching the conversation lifetime.  Mirrors the
    pattern used by :class:`portal.shared.api.services.session_store.
    RedisSessionStore` — same idioms, independent module.
    """

    def __init__(self, redis_url: str) -> None:
        try:
            from redis.asyncio import Redis, from_url
        except ImportError as exc:  # pragma: no cover — guard exercised at boot
            msg = (
                "COPILOT_CONVERSATION_STORE=redis requires the optional "
                "'redis' extra. Install with `pip install redis>=5` or "
                "set COPILOT_CONVERSATION_STORE=memory for local dev."
            )
            raise RuntimeError(msg) from exc

        self._client: Redis = from_url(redis_url, decode_responses=True)

    async def get(self, conversation_id: str) -> ConversationState | None:
        raw = await self._client.get(_redis_key(conversation_id))
        if raw is None:
            return None
        return ConversationState.model_validate_json(raw)

    async def set(self, state: ConversationState, ttl_seconds: int) -> None:
        await self._client.set(
            _redis_key(state.conversation_id),
            state.model_dump_json(),
            ex=ttl_seconds,
        )

    async def delete(self, conversation_id: str) -> None:
        await self._client.delete(_redis_key(conversation_id))

    async def close(self) -> None:  # pragma: no cover — shutdown hook
        await self._client.close()


# ---------------------------------------------------------------------------
# Summarizer
# ---------------------------------------------------------------------------


_CHARS_PER_TOKEN_APPROX = 4
"""Char-per-token heuristic used when no tokenizer is wired.

This is the OpenAI/tiktoken rule-of-thumb for English text; it is
intentionally loose because the value is only used to bound prompt
size, and the retriever downstream re-embeds whatever survives.
"""


def approx_token_count(text: str) -> int:
    """Approximate token count for *text* using the char-per-4 heuristic."""
    if not text:
        return 0
    # Ceiling division so a 3-char string still counts as 1 token.
    return (len(text) + _CHARS_PER_TOKEN_APPROX - 1) // _CHARS_PER_TOKEN_APPROX


class ConversationSummarizer:
    """Deterministic, LLM-free conversation history condenser.

    The summarizer joins prior turns into a compact ``Q:``/``A:``
    transcript so the downstream prompt stays bounded.  It does not
    call the LLM — an LLM-based summarizer would risk contaminating
    the grounding contract.  If a future phase needs a smarter summary
    it can subclass this with a narrowly-scoped ``gpt-4o-mini`` call,
    but the hard rule is: **summaries never feed the model facts that
    did not come from the corpus**.
    """

    def __init__(self, *, max_history_tokens: int) -> None:
        self.max_history_tokens = max_history_tokens

    def condense(self, state: ConversationState) -> str:
        """Return a compact transcript of *state*'s turns.

        Oldest turns are dropped first if the joined transcript
        exceeds ``max_history_tokens``.  The current (newest) turn is
        preserved even if the budget is tight — a 1-turn conversation
        always produces a non-empty summary.
        """
        if not state.turns:
            return ""

        entries: list[tuple[int, str]] = []
        for t in state.turns:
            prefix = "REFUSED" if t.refused else "A"
            body = (
                f"Q (turn {t.turn_index}): {t.question}\n"
                f"{prefix}: {t.answer}".strip()
            )
            entries.append((approx_token_count(body), body))

        # Trim oldest until budget fits.
        total = sum(n for n, _ in entries)
        while total > self.max_history_tokens and len(entries) > 1:
            dropped_tokens, _ = entries.pop(0)
            total -= dropped_tokens

        return "\n\n".join(body for _, body in entries)


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def build_conversation_store(settings: CopilotSettings) -> ConversationStore:
    """Construct the configured conversation store.

    ``conversation_store='memory'`` → :class:`InMemoryConversationStore`
    ``conversation_store='redis'``  → :class:`RedisConversationStore`

    Any other value raises — a typo cannot silently fall back to
    in-memory storage in a production deployment.
    """
    backend = settings.conversation_store
    if backend == "memory":
        return InMemoryConversationStore()
    if backend == "redis":
        if not settings.conversation_redis_url:
            msg = (
                "conversation_store='redis' requires conversation_redis_url "
                "to be set (e.g. redis://localhost:6379/0)."
            )
            raise RuntimeError(msg)
        return RedisConversationStore(settings.conversation_redis_url)
    # Unreachable under the Literal type, but guard explicitly.
    msg = f"Unknown conversation_store={backend!r}; must be 'memory' or 'redis'."
    raise RuntimeError(msg)


__all__ = [
    "ConversationHistoryLimitExceeded",
    "ConversationHistoryLimitExceededError",
    "ConversationNotFoundError",
    "ConversationState",
    "ConversationStore",
    "ConversationSummarizer",
    "InMemoryConversationStore",
    "RedisConversationStore",
    "approx_token_count",
    "build_conversation_store",
]
