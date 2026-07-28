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

from pathlib import Path
from typing import Any

import pyarrow as pa
import pytest

from .conftest import load

engine = load("engine")
sqlguard = load("sqlguard")


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


@pytest.fixture
def recorded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    """Factory: build an engine whose connection records its setup statements."""
    real_connect = engine.duckdb.connect
    monkeypatch.setenv("LOOM_DUCKDB_EXT_DIR", str(tmp_path))

    def factory() -> RecordingConnection:
        captured: list[RecordingConnection] = []

        def fake_connect(*args: Any, **kwargs: Any) -> RecordingConnection:
            wrapper = RecordingConnection(real_connect(*args, **kwargs))
            captured.append(wrapper)
            return wrapper

        monkeypatch.setattr(engine.duckdb, "connect", fake_connect)
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

    @pytest.mark.parametrize(
        "sql",
        ["SHOW TABLES", "PRAGMA version", "DESCRIBE SELECT 1 AS a"],
    )
    def test_statements_that_cannot_be_wrapped_fall_back_to_direct_execution(
        self, isolated_engine: Any, sql: str
    ) -> None:
        # `SELECT * FROM (SHOW TABLES)` is a DuckDB parse error; the engine
        # retries unwrapped. Without that fallback these three would 400.
        result = isolated_engine.run(sql)
        assert result.table.num_columns > 0

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

    def test_extensions_report_what_actually_loaded_not_the_bundled_constant(
        self, isolated_engine: Any
    ) -> None:
        # With an empty extension_directory nothing can load. Reporting the
        # BUNDLED_EXTENSIONS constant here would be the vaporware answer.
        assert isolated_engine.capabilities()["extensions"] == []
        assert engine.BUNDLED_EXTENSIONS == ("httpfs", "azure", "delta", "iceberg")

    def test_a_load_that_succeeds_is_recorded_and_one_that_fails_is_omitted(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # `json` is statically linked into the DuckDB wheel, so it loads with
        # no extension directory and no network — which makes the pair
        # (one real load, one impossible load) assertable anywhere. The point
        # is that the reported list is the OUTCOME, not the wish list: a
        # missing extension must fail loudly at query time, not be papered
        # over by a capabilities response that claims it is present.
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
