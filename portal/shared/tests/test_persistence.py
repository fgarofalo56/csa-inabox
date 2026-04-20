"""
StoreBackend protocol conformance + backend behaviour tests (CSA-0046).

Every backend is exercised through the same parametrised CRUD battery
so that the :class:`StoreBackend` Protocol is the contract of record.
The SQLite backend runs unconditionally; the Postgres backend runs
only when the ``PG_TEST_DSN`` environment variable points at a live
Postgres database (typically an ephemeral one spun up by
``pytest-postgresql`` in CI).

Run locally::

    # SQLite only
    python -m pytest portal/shared/tests/test_persistence.py -v

    # Postgres too (requires a running Postgres + appropriate perms)
    PG_TEST_DSN=postgresql://postgres@localhost:5432/postgres \\
        python -m pytest portal/shared/tests/test_persistence.py -v
"""

from __future__ import annotations

import os
import uuid
from typing import Any

import pytest
from portal.shared.api.persistence import SqliteStore, StoreBackend

_PG_DSN = os.getenv("PG_TEST_DSN", "").strip()


# ── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture
def sqlite_store(tmp_path: Any) -> SqliteStore:
    """A fresh SqliteStore in a temp directory for each test."""
    return SqliteStore("widgets.json", data_dir=tmp_path)


@pytest.fixture
def postgres_store() -> Any:
    """A fresh PostgresStore wired to a disposable table per test.

    Skipped entirely when ``PG_TEST_DSN`` is unset.  The table name
    incorporates a UUID so parallel test runs on a shared database do
    not clash.
    """
    if not _PG_DSN:
        pytest.skip("PG_TEST_DSN not set — skipping Postgres backend tests")

    try:
        from portal.shared.api.persistence_postgres import PostgresStore
    except ImportError as exc:  # pragma: no cover — env-specific
        pytest.skip(f"Postgres dependencies not installed: {exc}")

    table_id = uuid.uuid4().hex[:8]
    filename = f"widgets_test_{table_id}.json"
    store = PostgresStore(filename, database_url=_PG_DSN)
    yield store
    # Cleanup: drop the test-specific table so the DB stays tidy.
    from sqlalchemy import text

    with store._engine.begin() as conn:
        conn.execute(text(f'DROP TABLE IF EXISTS "{store.table}"'))


# ── Protocol conformance ────────────────────────────────────────────────────


def test_sqlite_store_satisfies_protocol(sqlite_store: SqliteStore) -> None:
    """SqliteStore is a structural StoreBackend."""
    assert isinstance(sqlite_store, StoreBackend)


@pytest.mark.skipif(not _PG_DSN, reason="PG_TEST_DSN not set")
def test_postgres_store_satisfies_protocol(postgres_store: Any) -> None:
    """PostgresStore is a structural StoreBackend."""
    assert isinstance(postgres_store, StoreBackend)


# ── Parametrised CRUD battery ───────────────────────────────────────────────
#
# Each test is parametrised over the available backends.  This keeps the
# contract definition in one place and guarantees parity.


def _ensure_store(request: pytest.FixtureRequest) -> StoreBackend:
    """Resolve the backend for the current parametrisation."""
    if request.param == "sqlite":
        return request.getfixturevalue("sqlite_store")
    if request.param == "postgres":
        return request.getfixturevalue("postgres_store")
    raise AssertionError(f"Unknown backend: {request.param}")


def _backend_params() -> list[pytest.param]:
    params = [pytest.param("sqlite", id="sqlite")]
    if _PG_DSN:
        params.append(pytest.param("postgres", id="postgres"))
    return params


@pytest.fixture(params=_backend_params())
def store(request: pytest.FixtureRequest) -> StoreBackend:
    return _ensure_store(request)


class TestCrud:
    """Verify add/get/update/delete + list semantics on each backend."""

    def test_add_get_roundtrip(self, store: StoreBackend) -> None:
        store.add({"id": "w-1", "name": "Widget"})
        got = store.get("w-1")
        assert got is not None
        assert got["name"] == "Widget"

    def test_get_missing_returns_none(self, store: StoreBackend) -> None:
        assert store.get("nonexistent") is None

    def test_add_generates_id_when_absent(self, store: StoreBackend) -> None:
        item = store.add({"name": "Anon"})
        assert "id" in item
        assert len(item["id"]) > 0

    def test_add_is_idempotent(self, store: StoreBackend) -> None:
        store.add({"id": "w-1", "name": "First"})
        store.add({"id": "w-1", "name": "Second"})
        got = store.get("w-1")
        assert got is not None
        assert got["name"] == "Second"

    def test_update_merges_fields(self, store: StoreBackend) -> None:
        store.add({"id": "w-1", "name": "Widget", "qty": 1})
        updated = store.update("w-1", {"qty": 5, "color": "blue"})
        assert updated is not None
        assert updated == {"id": "w-1", "name": "Widget", "qty": 5, "color": "blue"}

    def test_update_missing_returns_none(self, store: StoreBackend) -> None:
        assert store.update("nope", {"qty": 1}) is None

    def test_update_atomic_applies_mutator(self, store: StoreBackend) -> None:
        store.add({"id": "w-1", "n": 1})
        result = store.update_atomic("w-1", lambda item: {**item, "n": item["n"] + 1})
        assert result is not None
        assert result["n"] == 2
        assert store.get("w-1")["n"] == 2  # type: ignore[index]

    def test_update_atomic_missing_returns_none(self, store: StoreBackend) -> None:
        assert store.update_atomic("nope", lambda x: x) is None

    def test_update_atomic_rejects_non_dict_mutator_result(
        self,
        store: StoreBackend,
    ) -> None:
        store.add({"id": "w-1"})
        with pytest.raises(TypeError):
            store.update_atomic("w-1", lambda _: "not a dict")  # type: ignore[return-value,arg-type]

    def test_delete_removes(self, store: StoreBackend) -> None:
        store.add({"id": "w-1"})
        assert store.delete("w-1") is True
        assert store.get("w-1") is None

    def test_delete_missing_returns_false(self, store: StoreBackend) -> None:
        assert store.delete("nope") is False

    def test_list_returns_all(self, store: StoreBackend) -> None:
        store.add({"id": "a", "n": 1})
        store.add({"id": "b", "n": 2})
        items = store.list()
        ids = {it["id"] for it in items}
        assert ids == {"a", "b"}

    def test_load_is_alias_for_list(self, store: StoreBackend) -> None:
        store.add({"id": "a"})
        assert store.load() == store.list()

    def test_count(self, store: StoreBackend) -> None:
        assert store.count() == 0
        store.add({"id": "a"})
        store.add({"id": "b"})
        assert store.count() == 2

    def test_clear(self, store: StoreBackend) -> None:
        store.add({"id": "a"})
        store.clear()
        assert store.count() == 0

    def test_save_replaces(self, store: StoreBackend) -> None:
        store.add({"id": "old"})
        store.save([{"id": "new-1"}, {"id": "new-2"}])
        ids = {it["id"] for it in store.list()}
        assert ids == {"new-1", "new-2"}

    def test_query_by_field(self, store: StoreBackend) -> None:
        store.add({"id": "a", "color": "red"})
        store.add({"id": "b", "color": "blue"})
        store.add({"id": "c", "color": "red"})
        results = store.query(color="red")
        assert {it["id"] for it in results} == {"a", "c"}

    def test_query_empty_filters_returns_all(self, store: StoreBackend) -> None:
        store.add({"id": "a"})
        store.add({"id": "b"})
        assert len(store.query()) == 2

    def test_query_rejects_unsafe_keys(self, store: StoreBackend) -> None:
        store.add({"id": "a"})
        with pytest.raises(ValueError, match="Unsafe filter key"):
            store.query(**{"bad key with space": "x"})
