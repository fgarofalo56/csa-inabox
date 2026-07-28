"""DuckDB engine + Arrow IPC serialization for the serving tier (N2b).

These tests run a REAL embedded DuckDB and a REAL pyarrow round-trip — no
engine mock. That is deliberate: `apps/loom-duckdb` is the only place in the
repo that pins `duckdb` and `pyarrow`, and a major bump of either (pyarrow
18 -> 23, #2504) previously had no automated signal at all (#2543). A test that
mocks the engine would keep that hole open.

The lake itself is never touched: every statement here reads DuckDB's own
in-memory `range()` / literals, so there is no Azure dependency and no network.
"""
from __future__ import annotations

import time
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

# `duckdb` / `pyarrow` come from the `serving` extra. Skip rather than ERROR at
# collection when they are absent, so `pytest tests/` on a lean install (the old
# `EXTRAS ?= dev,governance,functions` default) still reports honestly instead of
# failing to collect. `make setup` / `make setup-all` now install `serving`.
pytest.importorskip("duckdb", reason="tests/loom_duckdb needs the `serving` extra")
pytest.importorskip("pyarrow", reason="tests/loom_duckdb needs the `serving` extra")

import pyarrow as pa

from .conftest import load

engine = load("engine")
sqlguard = load("sqlguard")

#: Statements DuckDB refuses to wrap in a subquery, so `run()` re-executes them
#: raw (engine.py:203). `TestExecution.test_the_unwrappable_premise_still_holds`
#: proves this list really is unwrappable on the DuckDB under test, so the
#: fallback tests cannot quietly stop covering the fallback after an upgrade.
UNWRAPPABLE = ["PRAGMA version", "PRAGMA database_size", "PRAGMA table_info('duckdb_types')"]


@pytest.fixture
def isolated_engine(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    """A fresh engine with an EMPTY extension directory.

    The container bakes the four extensions in at build time; a dev box or a CI
    runner has none. Pointing `extension_directory` at an empty tmp dir makes
    that state deterministic, so `capabilities()['extensions']` is a stable
    assertion rather than a reflection of whatever is in `~/.duckdb`.
    """
    monkeypatch.setenv("LOOM_DUCKDB_EXT_DIR", str(tmp_path))
    monkeypatch.delenv("LOOM_LAKE_ACCOUNT", raising=False)
    return engine.DuckDbEngine()


class RecordingConnection:
    """Wraps a REAL DuckDB connection and records the SQL that setup issues.

    Used only to assert the *text* of the one statement that cannot be observed
    from the outside — the Azure secret DDL. Everything still executes for real
    against DuckDB, so a statement that DuckDB would reject still fails here.
    """

    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.statements: list[str] = []

    def execute(self, sql: str, *args: Any, **kwargs: Any) -> Any:
        self.statements.append(sql)
        return self.inner.execute(sql, *args, **kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self.inner, name)


class _DuckDbShim:
    """`duckdb` with only `connect` swapped, for the engine module ONLY.

    Patching `duckdb.connect` itself would be a process-global mutation of the
    real duckdb module for the duration of the test — every other consumer in
    the interpreter would see the fake. Binding this shim to `engine.duckdb`
    instead scopes the swap to the one module under test; `duckdb.Error` and
    everything else still resolve to the real module through `__getattr__`.
    """

    def __init__(self, real: ModuleType, connect: Any) -> None:
        self._real = real
        self.connect = connect

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)


@pytest.fixture
def recorded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    """Factory: build an engine whose connection records its setup statements."""
    real_duckdb = engine.duckdb
    real_connect = real_duckdb.connect
    monkeypatch.setenv("LOOM_DUCKDB_EXT_DIR", str(tmp_path))

    def factory() -> RecordingConnection:
        captured: list[RecordingConnection] = []

        def fake_connect(*args: Any, **kwargs: Any) -> RecordingConnection:
            wrapper = RecordingConnection(real_connect(*args, **kwargs))
            captured.append(wrapper)
            return wrapper

        monkeypatch.setattr(engine, "duckdb", _DuckDbShim(real_duckdb, fake_connect))
        instance = engine.DuckDbEngine()
        instance.connection()
        return captured[0]

    return factory


# ── admission control is enforced BEFORE the engine is touched ───────────────
class TestReadOnlyAdmission:
    def test_a_write_is_refused_before_duckdb_is_even_connected(
        self, isolated_engine: Any
    ) -> None:
        # `_con is None` is the load-bearing assertion: the guard must run
        # before `connection()`, so a hostile statement never reaches an engine
        # that holds a lake credential.
        with pytest.raises(sqlguard.SqlNotAllowedError):
            isolated_engine.run("DROP TABLE sales")
        assert isolated_engine._con is None

    def test_an_admitted_read_does_connect_and_returns_rows(
        self, isolated_engine: Any
    ) -> None:
        result = isolated_engine.run("SELECT 42 AS answer")
        assert isolated_engine._con is not None
        assert result.table.to_pylist() == [{"answer": 42}]


# ── request bounding ─────────────────────────────────────────────────────────
class TestRowBounding:
    def test_over_cap_result_is_capped_and_flagged_truncated(
        self, isolated_engine: Any
    ) -> None:
        result = isolated_engine.run("SELECT * FROM range(50) t(i)", max_rows=10)
        assert result.row_count == 10
        assert result.table.num_rows == 10
        assert result.truncated is True
        assert result.max_rows == 10

    def test_exactly_at_the_cap_is_not_reported_truncated(
        self, isolated_engine: Any
    ) -> None:
        # The engine fetches cap+1 rows precisely so this boundary is exact. A
        # naive `LIMIT cap` would make an exactly-full page look truncated and
        # send the console paging forever.
        result = isolated_engine.run("SELECT * FROM range(10) t(i)", max_rows=10)
        assert result.row_count == 10
        assert result.truncated is False

    def test_a_user_limit_below_the_cap_still_wins(self, isolated_engine: Any) -> None:
        result = isolated_engine.run("SELECT * FROM range(50) t(i) LIMIT 3", max_rows=10)
        assert result.row_count == 3
        assert result.truncated is False

    def test_a_user_limit_above_the_cap_is_still_capped(
        self, isolated_engine: Any
    ) -> None:
        result = isolated_engine.run("SELECT * FROM range(500) t(i) LIMIT 400", max_rows=10)
        assert result.row_count == 10
        assert result.truncated is True

    def test_a_caller_cannot_raise_the_cap_above_the_hard_ceiling(
        self, isolated_engine: Any
    ) -> None:
        result = isolated_engine.run("SELECT 1", max_rows=10**9)
        assert result.max_rows == engine.DEFAULT_MAX_ROWS

    def test_a_negative_cap_collapses_to_one_row_not_zero(
        self, isolated_engine: Any
    ) -> None:
        # `max(1, ...)` — a 0-row page would look like an empty table and hide a
        # real result from the caller.
        result = isolated_engine.run("SELECT * FROM range(5) t(i)", max_rows=-3)
        assert result.max_rows == 1
        assert result.row_count == 1
        assert result.truncated is True

    def test_an_omitted_cap_falls_back_to_the_deployment_default(
        self, isolated_engine: Any
    ) -> None:
        assert isolated_engine.run("SELECT 1").max_rows == engine.DEFAULT_MAX_ROWS


# ── execution semantics ──────────────────────────────────────────────────────
class TestExecution:
    def test_multi_statement_script_returns_the_last_result(
        self, isolated_engine: Any
    ) -> None:
        result = isolated_engine.run("SELECT 1 AS first; SELECT 2 AS second")
        assert result.table.schema.names == ["second"]
        assert result.table.to_pylist() == [{"second": 2}]

    @pytest.mark.parametrize("sql", ["SHOW TABLES", "DESCRIBE SELECT 1 AS a", "SUMMARIZE SELECT 1 AS a"])
    def test_introspection_statements_return_a_real_result(
        self, isolated_engine: Any, sql: str
    ) -> None:
        # NOTE: these three ARE subquery-wrappable in DuckDB 1.1.3, so they go
        # down the normal wrapped path — they are NOT fallback coverage. An
        # earlier version of this test claimed they were; `UNWRAPPABLE` below
        # is the set that actually takes the fallback, and
        # `test_the_unwrappable_premise_still_holds` keeps that honest.
        result = isolated_engine.run(sql)
        assert result.table.num_columns > 0

    @pytest.mark.parametrize("sql", UNWRAPPABLE)
    def test_the_unwrappable_premise_still_holds(
        self, isolated_engine: Any, sql: str
    ) -> None:
        # The fallback at engine.py:203 only ever runs because DuckDB refuses
        # `SELECT * FROM (<stmt>)` for these. If a DuckDB upgrade makes them
        # wrappable, every fallback test below silently stops covering the
        # fallback — this test turns RED instead of letting that happen quietly.
        with pytest.raises(engine.duckdb.Error):
            isolated_engine.connection().execute(f"SELECT * FROM ({sql}) AS loom_q LIMIT 2")

    @pytest.mark.parametrize("sql", UNWRAPPABLE)
    def test_statements_that_cannot_be_wrapped_fall_back_to_direct_execution(
        self, isolated_engine: Any, sql: str
    ) -> None:
        # Without the fallback these would 400 — the wrapped form is a DuckDB
        # parse error.
        result = isolated_engine.run(sql)
        assert result.table.num_columns > 0
        assert result.table.num_rows > 0

    def test_the_fallback_branch_still_bounds_and_flags_the_result(
        self, isolated_engine: Any
    ) -> None:
        # The fallback re-executes the RAW statement (it cannot carry a LIMIT —
        # see `TestUnwrappableFallbackIsStreamed`), so the cap on this branch is
        # applied by the caller: the reader is stopped at `cap + 1` rows and the
        # table is sliced to `cap`. This pins that post-hoc slice, which every
        # other row-bounding case misses because they all use a wrappable
        # SELECT.
        result = isolated_engine.run("PRAGMA table_info('duckdb_types')", max_rows=5)
        assert result.row_count == 5
        assert result.table.num_rows == 5
        assert result.truncated is True
        assert result.max_rows == 5

    def test_the_result_carries_honest_timing_and_the_submitted_sql(
        self, isolated_engine: Any
    ) -> None:
        result = isolated_engine.run("SELECT 1 AS n")
        assert isinstance(result.elapsed_ms, int)
        assert result.elapsed_ms >= 0
        assert result.sql == "SELECT 1 AS n"

    def test_a_duckdb_error_propagates_instead_of_returning_an_empty_table(
        self, isolated_engine: Any
    ) -> None:
        with pytest.raises(engine.duckdb.Error):
            isolated_engine.run("SELECT * FROM table_that_does_not_exist")

    def test_to_json_projects_typed_columns_and_row_lists(
        self, isolated_engine: Any
    ) -> None:
        payload = isolated_engine.run("SELECT 1 AS n, 'x' AS s").to_json()
        assert payload["columns"] == [
            {"name": "n", "type": "int32"},
            {"name": "s", "type": "string"},
        ]
        assert payload["rows"] == [[1, "x"]]
        assert payload["rowCount"] == 1
        assert payload["engine"] == "duckdb"
        assert payload["truncated"] is False


# ── the unwrappable fallback must not materialize the whole result (#2575) ──
class _CursorThatRefusesTheWrapper:
    """The REAL DuckDB cursor, with `SELECT * FROM (...) AS loom_q` refused."""

    def __init__(self, real: Any) -> None:
        self._real = real

    def execute(self, sql: str, *args: Any, **kwargs: Any) -> Any:
        if "AS loom_q" in sql:
            raise engine.duckdb.ParserException(
                "Parser Error: injected — this statement cannot be wrapped in a subquery",
            )
        return self._real.execute(sql, *args, **kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)


class _ConnectionThatRefusesTheWrapper:
    """The REAL DuckDB connection, handing out wrapper-refusing cursors.

    This injects ONE condition — "DuckDB will not wrap this statement" — which
    is exactly what DuckDB already does for PRAGMA / EXPLAIN. It is what lets a
    LARGE statement take the fallback, i.e. the "larger unwrappable shape is
    admitted" case #2575 says turns the latent defect live. Every other part of
    the path (the guard, the cap arithmetic, the fetch, DuckDB itself) is real.
    """

    def __init__(self, real: Any) -> None:
        self._real = real

    def cursor(self) -> _CursorThatRefusesTheWrapper:
        return _CursorThatRefusesTheWrapper(self._real.cursor())

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)


class TestUnwrappableFallbackIsStreamed:
    #: ~4M rows / ~200 MB of Arrow once materialized; ~10 ms to stream one batch.
    HEAVY = "SELECT i, i * 2 AS d, md5(i::VARCHAR) AS h FROM range(4000000) t(i)"

    def test_an_unwrappable_statement_is_bounded_without_materializing_it_whole(
        self, isolated_engine: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # BUG CAUGHT (#2575): the fallback used to re-execute the raw statement
        # with `fetch_arrow_table()` and NO limit, so an unwrappable statement
        # over a large source was materialized IN FULL and only then sliced to
        # the cap — the exact memory blow-up the cap exists to prevent. The
        # slice hides it from the response, so the ONLY way to see it is to
        # measure the work actually done.
        #
        # Revert `_bounded_direct_fetch` to `cursor.execute(statement)
        # .fetch_arrow_table()` and this test goes RED: the fallback takes as
        # long as the control, because it does the same work.
        connection = isolated_engine.connection()

        # CONTROL, measured FIRST against plain DuckDB with no Loom code in the
        # path: this statement really IS a blow-up when materialized whole.
        # Without it the subject's timing would be an unanchored number, and the
        # bar below would not adapt to the runner.
        started = time.perf_counter()
        materialized_rows = connection.cursor().execute(self.HEAVY).fetch_arrow_table().num_rows
        materialized_ms = (time.perf_counter() - started) * 1000
        assert materialized_rows == 4_000_000
        assert materialized_ms > 100, (
            "the control did not measure a real materialization cost, so the "
            "comparison below would be meaningless"
        )

        monkeypatch.setattr(
            isolated_engine, "_con", _ConnectionThatRefusesTheWrapper(connection),
        )
        started = time.perf_counter()
        result = isolated_engine.run(self.HEAVY, max_rows=5)
        fallback_ms = (time.perf_counter() - started) * 1000

        # Correct answer, still bounded and still flagged.
        assert result.row_count == 5
        assert result.truncated is True
        assert result.table.column("i").to_pylist() == [0, 1, 2, 3, 4]
        # Measured locally the gap is ~80x (780 ms vs 10 ms). A 4x bar leaves an
        # order of magnitude of headroom for a loaded CI runner while remaining
        # impossible to clear by materializing 4M rows.
        assert fallback_ms < materialized_ms / 4, (
            f"the fallback took {fallback_ms:.0f} ms against a "
            f"{materialized_ms:.0f} ms full materialization — it is still "
            "materializing the whole result before slicing it"
        )

    def test_the_fallback_bounds_by_streaming_not_by_rewriting_the_statement(
        self, isolated_engine: Any
    ) -> None:
        # GUARDS THE WRONG FIX (not the shipped bug — that is the test above).
        # The other obvious way to bound #2575 is to append `LIMIT n` to the raw
        # statement, and it is silently wrong: `EXPLAIN <query> LIMIT 2` is an
        # EXPLAIN *of* `<query> LIMIT 2`, a different plan than the caller asked
        # for. Implement the fallback that way and this goes RED. EXPLAIN is
        # genuinely unwrappable (asserted below), so this rides the real
        # fallback rather than a simulated one.
        statement = "EXPLAIN SELECT i FROM range(1000) t(i)"
        with pytest.raises(engine.duckdb.Error):
            isolated_engine.connection().execute(
                f"SELECT * FROM ({statement}) AS loom_q LIMIT 2",
            )

        through_the_fallback = isolated_engine.run(statement, max_rows=2)
        rewritten = (
            isolated_engine.connection()
            .execute(f"{statement} LIMIT 2")
            .fetch_arrow_table()
        )
        assert through_the_fallback.table.to_pylist() != rewritten.to_pylist(), (
            "the fallback produced the plan of the LIMIT-appended statement, so "
            "it rewrote the caller's SQL instead of streaming the real one"
        )
        # And it is the plan of the statement as submitted.
        unbounded = isolated_engine.connection().execute(statement).fetch_arrow_table()
        assert through_the_fallback.table.to_pylist() == unbounded.to_pylist()


# ── Arrow IPC (the wire the console, duckdb-wasm and ADBC all read) ──────────
class TestArrowIpcSerialization:
    def test_ipc_stream_round_trips_the_exact_table(self, isolated_engine: Any) -> None:
        result = isolated_engine.run(
            "SELECT i, i * 2 AS doubled, CAST(i AS VARCHAR) AS label FROM range(200) t(i)"
        )
        payload = engine.arrow_ipc_bytes(result.table)
        restored = pa.ipc.open_stream(pa.py_buffer(payload)).read_all()
        assert restored.schema == result.table.schema
        assert restored.equals(result.table)
        assert restored.num_rows == 200

    def test_an_empty_result_still_emits_a_schema_bearing_stream(
        self, isolated_engine: Any
    ) -> None:
        # duckdb-wasm's `insertArrowFromIPCStream` needs the schema even for a
        # 0-row page; emitting b"" would blank the grid instead of showing
        # "no rows".
        result = isolated_engine.run("SELECT 1 AS a WHERE false")
        restored = pa.ipc.open_stream(pa.py_buffer(engine.arrow_ipc_bytes(result.table))).read_all()
        assert restored.num_rows == 0
        assert restored.schema.names == ["a"]

    def test_unicode_and_nulls_survive_the_wire(self, isolated_engine: Any) -> None:
        result = isolated_engine.run("SELECT 'é中' AS s, NULL AS n UNION ALL SELECT 'z', 'v'")
        restored = pa.ipc.open_stream(pa.py_buffer(engine.arrow_ipc_bytes(result.table))).read_all()
        assert sorted(r["s"] for r in restored.to_pylist()) == ["z", "é中"]
        assert None in [r["n"] for r in restored.to_pylist()]


# ── setup, identity and hardening ────────────────────────────────────────────
class TestSetupAndCapabilities:
    def test_no_lake_account_is_an_honest_gate_naming_the_env_var(
        self, isolated_engine: Any
    ) -> None:
        caps = isolated_engine.capabilities()
        assert caps["engine"] == "duckdb"
        assert caps["authMode"] == "none"
        assert caps["lakeAccount"] == ""
        assert "LOOM_LAKE_ACCOUNT" in caps["setupNote"]
        assert caps["maxRows"] == engine.DEFAULT_MAX_ROWS
        assert caps["queryTimeoutSeconds"] == engine.QUERY_TIMEOUT_S

    def test_a_load_that_succeeds_is_recorded_and_one_that_fails_is_omitted(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # This is the ONLY honest form of the "reports the outcome, not the
        # BUNDLED_EXTENSIONS wish list" assertion. The earlier version of this
        # test asserted `capabilities()['extensions'] == []` with an empty
        # extension directory: that is an assertion about the ABSENCE of
        # behaviour in a third-party wheel (it holds only while none of
        # httpfs/azure/delta/iceberg is statically linked and no LOAD
        # auto-installs over the network), and it survived the
        # `self._loaded.append(ext)` -> `pass` mutation, i.e. it could not
        # detect the defect its name claimed. It was DELETED, not kept
        # alongside this one.
        #
        # `json` is statically linked into the DuckDB wheel, so it loads with
        # no extension directory and no network — which makes the pair
        # (one real load, one impossible load) assertable anywhere.
        monkeypatch.setenv("LOOM_DUCKDB_EXT_DIR", str(tmp_path))
        monkeypatch.delenv("LOOM_LAKE_ACCOUNT", raising=False)
        monkeypatch.setattr(engine, "BUNDLED_EXTENSIONS", ("json", "not_a_real_extension"))
        assert engine.DuckDbEngine().capabilities()["extensions"] == ["json"]

    def test_a_lake_account_switches_auth_mode_and_clears_the_gate(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("LOOM_DUCKDB_EXT_DIR", str(tmp_path))
        monkeypatch.setenv("LOOM_LAKE_ACCOUNT", "  stloomlake01  ")
        caps = engine.DuckDbEngine().capabilities()
        assert caps["lakeAccount"] == "stloomlake01"  # whitespace-trimmed
        assert caps["authMode"] == "managed-identity"
        assert caps["setupNote"] is None

    def test_the_lake_secret_uses_the_credential_chain_and_carries_no_key(
        self, monkeypatch: pytest.MonkeyPatch, recorded: Any
    ) -> None:
        monkeypatch.setenv("LOOM_LAKE_ACCOUNT", "stloomlake01")
        connection = recorded()
        secrets = [s for s in connection.statements if "SECRET" in s.upper()]
        assert len(secrets) == 1
        ddl = secrets[0]
        assert "TYPE AZURE" in ddl
        assert "PROVIDER CREDENTIAL_CHAIN" in ddl
        assert "managed_identity" in ddl
        assert "ACCOUNT_NAME 'stloomlake01'" in ddl
        # The whole posture of this service: no key, no SAS, no conn string.
        for forbidden in ("ACCOUNT_KEY", "CONNECTION_STRING", "SAS", "PROVIDER CONFIG"):
            assert forbidden not in ddl.upper()

    def test_no_secret_is_created_when_no_lake_account_is_configured(
        self, monkeypatch: pytest.MonkeyPatch, recorded: Any
    ) -> None:
        monkeypatch.delenv("LOOM_LAKE_ACCOUNT", raising=False)
        connection = recorded()
        assert [s for s in connection.statements if "SECRET" in s.upper()] == []

    def test_configuration_is_locked_only_after_setup_finishes(
        self, monkeypatch: pytest.MonkeyPatch, recorded: Any
    ) -> None:
        monkeypatch.setenv("LOOM_LAKE_ACCOUNT", "stloomlake01")
        statements = recorded().statements
        lock = next(i for i, s in enumerate(statements) if "lock_configuration" in s)
        autoinstall = next(
            i for i, s in enumerate(statements) if "autoinstall_known_extensions = false" in s
        )
        secret = next(i for i, s in enumerate(statements) if "SECRET" in s.upper())
        # Locking BEFORE the secret would break the lake; locking after the
        # autoinstall/autoload disable is what freezes egress.
        assert secret < autoinstall < lock

    def test_a_submitted_statement_cannot_re_enable_extension_autoinstall(
        self, isolated_engine: Any
    ) -> None:
        # Defence in depth behind sqlguard: even holding the raw connection,
        # egress cannot be switched back on for the life of the process.
        with pytest.raises(engine.duckdb.Error):
            isolated_engine.connection().execute("SET autoinstall_known_extensions = true")

    def test_the_connection_is_created_once_and_shared(self, isolated_engine: Any) -> None:
        assert isolated_engine.connection() is isolated_engine.connection()
