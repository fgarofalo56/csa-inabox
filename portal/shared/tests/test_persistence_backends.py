"""
Tests for CSA-0046 seams not already covered by ``test_persistence.py``
and ``test_persistence_factory.py``.

This module focuses on:

* ``Settings.DATABASE_URL`` scheme validator — rejects unsupported
  backends at configuration-load time rather than at first store use.
* ``_ManagedIdentityTokenProvider`` — AAD token caching honours the
  5-minute refresh margin; concurrent callers only trigger one
  credential call.
* ``PostgresStore`` module-level helpers (``_normalize_postgres_url``,
  ``_redact_password``, ``_coerce_json``) exercised without a live
  connection.
* Optional Postgres idempotency + update round-trip — skipped unless
  ``POSTGRES_TEST_URL`` points at a live database.

Protocol conformance + CRUD parity are covered by
``test_persistence.py``; factory dispatch is covered by
``test_persistence_factory.py``.
"""

from __future__ import annotations

import os
import time
from typing import Any
from unittest.mock import MagicMock

import pytest
from portal.shared.api.config import Settings

# ── Settings validator ──────────────────────────────────────────────────────


class TestDatabaseUrlValidator:
    """``Settings.DATABASE_URL`` scheme guard."""

    def test_sqlite_accepted(self) -> None:
        s = Settings(DATABASE_URL="sqlite:///./data/portal.db")
        assert s.DATABASE_URL == "sqlite:///./data/portal.db"

    def test_empty_accepted(self) -> None:
        s = Settings(DATABASE_URL="")
        assert s.DATABASE_URL == ""

    def test_postgresql_short_form_accepted(self) -> None:
        s = Settings(DATABASE_URL="postgresql://u@h:5432/db")
        assert s.DATABASE_URL.startswith("postgresql")

    def test_postgresql_with_driver_accepted(self) -> None:
        for url in (
            "postgresql+psycopg://u@h/db",
            "postgresql+asyncpg://u@h/db",
            "postgres+asyncpg://u@h/db",
        ):
            s = Settings(DATABASE_URL=url)
            assert url == s.DATABASE_URL

    def test_unsupported_scheme_rejected(self) -> None:
        with pytest.raises(ValueError, match="DATABASE_URL scheme not supported"):
            Settings(DATABASE_URL="mysql://u@h/db")


# ── Managed-identity token provider ────────────────────────────────────────


class _FakeToken:
    """Minimal stand-in for azure.identity's AccessToken NamedTuple."""

    def __init__(self, token: str, expires_on: float) -> None:
        self.token = token
        self.expires_on = expires_on


class TestManagedIdentityTokenProvider:
    """Token caching + refresh-margin semantics.

    We bypass ``_ManagedIdentityTokenProvider.__init__``'s lazy import
    of :class:`azure.identity.DefaultAzureCredential` by replacing the
    private attributes directly — that avoids having to mock the
    import chain and keeps these tests hermetic.
    """

    def _build_provider(self, mock_credential: Any) -> Any:
        # __new__ skips __init__; we then install the same fields
        # __init__ would have created.
        import threading as _threading

        from portal.shared.api.persistence_postgres import (
            _ManagedIdentityTokenProvider,
        )

        p = _ManagedIdentityTokenProvider.__new__(_ManagedIdentityTokenProvider)
        p._credential = mock_credential
        p._token = None
        p._expires_on = 0.0
        p._lock = _threading.Lock()
        return p

    def test_token_cached_until_refresh_margin(self) -> None:
        credential = MagicMock()
        # Token valid for 1 hour from now.
        credential.get_token.return_value = _FakeToken(
            "tok-1",
            expires_on=time.time() + 3600,
        )
        p = self._build_provider(credential)

        first = p.get_token()
        second = p.get_token()
        third = p.get_token()

        assert first == "tok-1"
        assert second == "tok-1"
        assert third == "tok-1"
        # Credential hit exactly once because the token is still fresh.
        assert credential.get_token.call_count == 1

    def test_token_refreshed_within_margin(self) -> None:
        credential = MagicMock()
        # First token expires in 4 minutes — inside the 5-minute refresh
        # margin so the next call must re-fetch.
        credential.get_token.side_effect = [
            _FakeToken("tok-expiring", expires_on=time.time() + 4 * 60),
            _FakeToken("tok-refreshed", expires_on=time.time() + 3600),
        ]
        p = self._build_provider(credential)

        first = p.get_token()
        second = p.get_token()

        assert first == "tok-expiring"
        assert second == "tok-refreshed"
        assert credential.get_token.call_count == 2

    def test_correct_scope_requested(self) -> None:
        credential = MagicMock()
        credential.get_token.return_value = _FakeToken(
            "tok",
            expires_on=time.time() + 3600,
        )
        p = self._build_provider(credential)
        p.get_token()

        (args, _kwargs) = credential.get_token.call_args
        assert args == ("https://ossrdbms-aad.database.windows.net/.default",)


# ── Postgres URL + helpers (no live DB) ────────────────────────────────────


class TestPostgresHelpers:
    """Module-level utilities exercised without a live Postgres."""

    def test_normalize_rewrites_async_to_sync(self) -> None:
        from portal.shared.api.persistence_postgres import _normalize_postgres_url

        assert _normalize_postgres_url(
            "postgresql+asyncpg://u@h/db",
        ) == "postgresql+psycopg://u@h/db"

    def test_normalize_rewrites_plain_to_psycopg(self) -> None:
        from portal.shared.api.persistence_postgres import _normalize_postgres_url

        assert _normalize_postgres_url(
            "postgresql://u@h/db",
        ) == "postgresql+psycopg://u@h/db"

    def test_normalize_preserves_explicit_psycopg(self) -> None:
        from portal.shared.api.persistence_postgres import _normalize_postgres_url

        url = "postgresql+psycopg://u@h/db"
        assert _normalize_postgres_url(url) == url

    def test_redact_password_hides_credentials(self) -> None:
        from portal.shared.api.persistence_postgres import _redact_password

        assert _redact_password(
            "postgresql://user:secret@host:5432/db",
        ) == "postgresql://user:***@host:5432/db"

    def test_redact_password_passthrough_when_no_password(self) -> None:
        from portal.shared.api.persistence_postgres import _redact_password

        assert _redact_password(
            "postgresql://user@host:5432/db",
        ) == "postgresql://user@host:5432/db"

    def test_coerce_json_accepts_dict(self) -> None:
        from portal.shared.api.persistence_postgres import _coerce_json

        assert _coerce_json({"id": "x"}) == {"id": "x"}

    def test_coerce_json_parses_text(self) -> None:
        from portal.shared.api.persistence_postgres import _coerce_json

        assert _coerce_json('{"id": "x"}') == {"id": "x"}

    def test_coerce_json_rejects_non_object(self) -> None:
        from portal.shared.api.persistence_postgres import _coerce_json

        with pytest.raises(TypeError, match="Expected JSON object"):
            _coerce_json("[1,2,3]")


# ── Live Postgres round-trip (skipped unless POSTGRES_TEST_URL set) ───────


POSTGRES_TEST_URL = os.environ.get("POSTGRES_TEST_URL", "").strip()


@pytest.mark.skipif(
    not POSTGRES_TEST_URL,
    reason="POSTGRES_TEST_URL not set — skipping live Postgres CRUD tests.",
)
class TestPostgresStoreLive:
    """Round-trip CRUD against a real Postgres instance."""

    def test_add_idempotent_upsert(self) -> None:
        """Second add() on the same id updates (ON CONFLICT DO UPDATE)."""
        from portal.shared.api.persistence_postgres import PostgresStore

        store = PostgresStore(
            "test_csa_idempotent.json",
            database_url=POSTGRES_TEST_URL,
            use_managed_identity=False,
        )
        store.clear()

        first = store.add({"id": "same", "n": 1})
        second = store.add({"id": "same", "n": 2})

        assert first["id"] == "same"
        assert second["id"] == "same"
        assert store.count() == 1
        assert store.get("same") == {"id": "same", "n": 2}

        store.clear()

    def test_update_merges_fields(self) -> None:
        from portal.shared.api.persistence_postgres import PostgresStore

        store = PostgresStore(
            "test_csa_update.json",
            database_url=POSTGRES_TEST_URL,
            use_managed_identity=False,
        )
        store.clear()

        store.add({"id": "a", "status": "pending", "owner": "alice"})
        merged = store.update("a", {"status": "approved"})

        assert merged == {"id": "a", "status": "approved", "owner": "alice"}
        assert store.get("a") == merged

        store.clear()
