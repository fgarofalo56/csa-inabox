"""
Tests for the async StoreBackend stack (ADR-0016 / CSA-0046 v2).

Exercises :class:`AsyncSqliteStore` unconditionally and
:class:`AsyncPostgresStore` when ``POSTGRES_TEST_URL`` points at a
reachable instance.  Also covers the async factory dispatch and the
lifespan-style close helper.

Run locally::

    # SQLite only
    python -m pytest portal/shared/tests/test_async_persistence.py -v

    # Postgres too (requires a running Postgres)
    POSTGRES_TEST_URL=postgresql://postgres@localhost:5432/postgres \\
        python -m pytest portal/shared/tests/test_async_persistence.py -v
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass
from typing import Any

import pytest
import pytest_asyncio
from portal.shared.api.persistence_async import (
    AsyncSqliteStore,
    AsyncStoreBackend,
    build_async_store_backend,
    close_async_engines,
)

# ── Settings shim (avoid pulling a full config load) ──────────────────────


@dataclass
class _FakeSettings:
    DATABASE_URL: str = ""
    DATA_DIR: str = ""
    POSTGRES_USE_MANAGED_IDENTITY: bool = False
    DATABASE_POOL_SIZE: int = 10
    DATABASE_MAX_OVERFLOW: int = 20


# ── Fixtures ──────────────────────────────────────────────────────────────


@pytest_asyncio.fixture
async def sqlite_store(tmp_path: Any) -> AsyncSqliteStore:
    """Fresh AsyncSqliteStore in a temp directory per test."""
    store = AsyncSqliteStore("widgets.json", data_dir=tmp_path)
    yield store
    await store.close()


# ── Protocol conformance ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_async_sqlite_store_satisfies_protocol(
    sqlite_store: AsyncSqliteStore,
) -> None:
    """AsyncSqliteStore structurally matches AsyncStoreBackend."""
    assert isinstance(sqlite_store, AsyncStoreBackend)


# ── CRUD battery ──────────────────────────────────────────────────────────


class TestAsyncSqliteCrud:
    """Round-trip CRUD against the async SQLite backend."""

    @pytest.mark.asyncio
    async def test_add_get_roundtrip(self, sqlite_store: AsyncSqliteStore) -> None:
        await sqlite_store.add({"id": "w-1", "name": "Widget"})
        got = await sqlite_store.get("w-1")
        assert got is not None
        assert got["name"] == "Widget"

    @pytest.mark.asyncio
    async def test_get_missing_returns_none(
        self, sqlite_store: AsyncSqliteStore,
    ) -> None:
        assert await sqlite_store.get("nope") is None

    @pytest.mark.asyncio
    async def test_add_generates_id_when_absent(
        self, sqlite_store: AsyncSqliteStore,
    ) -> None:
        item = await sqlite_store.add({"name": "Anon"})
        assert "id" in item
        assert len(item["id"]) > 0

    @pytest.mark.asyncio
    async def test_add_is_idempotent(self, sqlite_store: AsyncSqliteStore) -> None:
        await sqlite_store.add({"id": "w-1", "name": "First"})
        await sqlite_store.add({"id": "w-1", "name": "Second"})
        got = await sqlite_store.get("w-1")
        assert got is not None
        assert got["name"] == "Second"

    @pytest.mark.asyncio
    async def test_update_merges(self, sqlite_store: AsyncSqliteStore) -> None:
        await sqlite_store.add({"id": "w-1", "name": "Widget", "qty": 1})
        updated = await sqlite_store.update(
            "w-1", {"qty": 5, "color": "blue"},
        )
        assert updated == {
            "id": "w-1",
            "name": "Widget",
            "qty": 5,
            "color": "blue",
        }

    @pytest.mark.asyncio
    async def test_update_missing_returns_none(
        self, sqlite_store: AsyncSqliteStore,
    ) -> None:
        assert await sqlite_store.update("nope", {"x": 1}) is None

    @pytest.mark.asyncio
    async def test_update_atomic(self, sqlite_store: AsyncSqliteStore) -> None:
        await sqlite_store.add({"id": "c", "n": 1})
        result = await sqlite_store.update_atomic(
            "c", lambda item: {**item, "n": item["n"] + 1},
        )
        assert result is not None
        assert result["n"] == 2
        got = await sqlite_store.get("c")
        assert got is not None
        assert got["n"] == 2

    @pytest.mark.asyncio
    async def test_update_atomic_rejects_non_dict(
        self, sqlite_store: AsyncSqliteStore,
    ) -> None:
        await sqlite_store.add({"id": "c"})
        with pytest.raises(TypeError):
            await sqlite_store.update_atomic(
                "c", lambda _: "nope",  # type: ignore[return-value]
            )

    @pytest.mark.asyncio
    async def test_delete(self, sqlite_store: AsyncSqliteStore) -> None:
        await sqlite_store.add({"id": "x"})
        assert await sqlite_store.delete("x") is True
        assert await sqlite_store.delete("x") is False
        assert await sqlite_store.get("x") is None

    @pytest.mark.asyncio
    async def test_list_load_and_count(
        self, sqlite_store: AsyncSqliteStore,
    ) -> None:
        await sqlite_store.add({"id": "a"})
        await sqlite_store.add({"id": "b"})
        items = await sqlite_store.list()
        assert {i["id"] for i in items} == {"a", "b"}
        assert await sqlite_store.load() == items
        assert await sqlite_store.count() == 2

    @pytest.mark.asyncio
    async def test_clear(self, sqlite_store: AsyncSqliteStore) -> None:
        await sqlite_store.add({"id": "a"})
        await sqlite_store.clear()
        assert await sqlite_store.count() == 0

    @pytest.mark.asyncio
    async def test_save_replaces(self, sqlite_store: AsyncSqliteStore) -> None:
        await sqlite_store.add({"id": "old"})
        await sqlite_store.save([{"id": "new-1"}, {"id": "new-2"}])
        items = await sqlite_store.list()
        assert {i["id"] for i in items} == {"new-1", "new-2"}

    @pytest.mark.asyncio
    async def test_query(self, sqlite_store: AsyncSqliteStore) -> None:
        await sqlite_store.add({"id": "a", "color": "red"})
        await sqlite_store.add({"id": "b", "color": "blue"})
        await sqlite_store.add({"id": "c", "color": "red"})
        results = await sqlite_store.query(color="red")
        assert {r["id"] for r in results} == {"a", "c"}

    @pytest.mark.asyncio
    async def test_query_rejects_unsafe_keys(
        self, sqlite_store: AsyncSqliteStore,
    ) -> None:
        await sqlite_store.add({"id": "a"})
        with pytest.raises(ValueError, match="Unsafe filter key"):
            await sqlite_store.query(**{"bad key": "x"})

    @pytest.mark.asyncio
    async def test_query_empty_filters_returns_all(
        self, sqlite_store: AsyncSqliteStore,
    ) -> None:
        await sqlite_store.add({"id": "a"})
        results = await sqlite_store.query()
        assert len(results) == 1


# ── Factory dispatch ──────────────────────────────────────────────────────


class TestAsyncFactory:
    """build_async_store_backend dispatches on DATABASE_URL."""

    def test_empty_url_selects_sqlite(self, tmp_path: Any) -> None:
        s = _FakeSettings(DATABASE_URL="", DATA_DIR=str(tmp_path))
        store = build_async_store_backend("widgets.json", s)  # type: ignore[arg-type]
        assert isinstance(store, AsyncSqliteStore)

    def test_sqlite_url_selects_sqlite(self, tmp_path: Any) -> None:
        s = _FakeSettings(
            DATABASE_URL=f"sqlite:///{tmp_path}/x.db",
            DATA_DIR=str(tmp_path),
        )
        store = build_async_store_backend("widgets.json", s)  # type: ignore[arg-type]
        assert isinstance(store, AsyncSqliteStore)

    def test_unknown_scheme_rejected(self) -> None:
        s = _FakeSettings(DATABASE_URL="mysql://example.com/db")
        with pytest.raises(ValueError, match="Unsupported DATABASE_URL scheme"):
            build_async_store_backend("widgets.json", s)  # type: ignore[arg-type]


# ── Lifespan helper ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_close_async_engines_is_idempotent() -> None:
    """``close_async_engines`` can be called multiple times safely."""
    await close_async_engines()
    await close_async_engines()


# ── URL helpers ───────────────────────────────────────────────────────────


class TestAsyncUrlHelpers:
    """Normalise-and-redact helpers for the async Postgres driver."""

    def test_normalize_plain_to_asyncpg(self) -> None:
        from portal.shared.api.persistence_async import _normalize_async_postgres_url

        assert _normalize_async_postgres_url(
            "postgresql://u@h/db",
        ) == "postgresql+asyncpg://u@h/db"

    def test_normalize_psycopg_to_asyncpg(self) -> None:
        from portal.shared.api.persistence_async import _normalize_async_postgres_url

        assert _normalize_async_postgres_url(
            "postgresql+psycopg://u@h/db",
        ) == "postgresql+asyncpg://u@h/db"

    def test_normalize_preserves_asyncpg(self) -> None:
        from portal.shared.api.persistence_async import _normalize_async_postgres_url

        url = "postgresql+asyncpg://u@h/db"
        assert _normalize_async_postgres_url(url) == url

    def test_redact_password(self) -> None:
        from portal.shared.api.persistence_async import _redact_password

        assert _redact_password(
            "postgresql+asyncpg://user:secret@host/db",
        ) == "postgresql+asyncpg://user:***@host/db"

    def test_coerce_json_dict(self) -> None:
        from portal.shared.api.persistence_async import _coerce_json

        assert _coerce_json({"id": "x"}) == {"id": "x"}

    def test_coerce_json_text(self) -> None:
        from portal.shared.api.persistence_async import _coerce_json

        assert _coerce_json('{"id": "x"}') == {"id": "x"}

    def test_coerce_json_rejects_array(self) -> None:
        from portal.shared.api.persistence_async import _coerce_json

        with pytest.raises(TypeError, match="Expected JSON object"):
            _coerce_json("[1,2]")


# ── Optional live Postgres round-trip ─────────────────────────────────────


POSTGRES_TEST_URL = os.environ.get("POSTGRES_TEST_URL", "").strip()


@pytest.mark.skipif(
    not POSTGRES_TEST_URL,
    reason="POSTGRES_TEST_URL not set — skipping live async Postgres tests",
)
class TestAsyncPostgresLive:
    """Exercises AsyncPostgresStore against a real database."""

    @pytest.mark.asyncio
    async def test_crud_roundtrip(self) -> None:
        from portal.shared.api.persistence_async import AsyncPostgresStore

        table_id = uuid.uuid4().hex[:8]
        store = AsyncPostgresStore(
            f"async_test_{table_id}.json",
            database_url=POSTGRES_TEST_URL,
            use_managed_identity=False,
        )
        try:
            await store.add({"id": "a", "n": 1})
            got = await store.get("a")
            assert got == {"id": "a", "n": 1}
            assert await store.count() == 1

            merged = await store.update("a", {"n": 2})
            assert merged == {"id": "a", "n": 2}

            await store.delete("a")
            assert await store.get("a") is None
        finally:
            from sqlalchemy import text

            engine = await store._ensure_ready()
            async with engine.begin() as conn:
                await conn.execute(text(f'DROP TABLE IF EXISTS "{store.table}"'))
            await store.close()
            await close_async_engines()
