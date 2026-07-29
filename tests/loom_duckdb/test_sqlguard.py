"""Read-only admission control for the DuckDB serving tier (N2b)."""
from __future__ import annotations

import pytest

from .conftest import load

sqlguard = load("sqlguard")


class TestAdmittedReads:
    def test_select_is_admitted_and_returned_intact(self) -> None:
        stmts = sqlguard.assert_read_only("SELECT 1 AS n")
        assert stmts == ["SELECT 1 AS n"]

    @pytest.mark.parametrize(
        "sql",
        [
            "WITH t AS (SELECT 1) SELECT * FROM t",
            "DESCRIBE SELECT 1",
            "SHOW TABLES",
            "EXPLAIN SELECT 1",
            "SUMMARIZE SELECT 1",
            "PRAGMA database_list",
            "  \n SELECT 1",
            "(SELECT 1)",
        ],
    )
    def test_read_shapes(self, sql: str) -> None:
        assert sqlguard.assert_read_only(sql)

    def test_multi_statement_read_script_is_admitted_in_order(self) -> None:
        stmts = sqlguard.assert_read_only("SELECT 1; SELECT 2;")
        assert stmts == ["SELECT 1", "SELECT 2"]


class TestRefusals:
    @pytest.mark.parametrize(
        ("sql", "verb"),
        [
            ("INSERT INTO t VALUES (1)", "INSERT"),
            ("CREATE TABLE t (a INT)", "CREATE"),
            ("COPY t TO 'x.parquet'", "COPY"),
            ("ATTACH 'x.db'", "ATTACH"),
            ("SET memory_limit='90GB'", "SET"),
            ("INSTALL httpfs", "INSTALL"),
        ],
    )
    def test_writes_are_refused_by_name(self, sql: str, verb: str) -> None:
        with pytest.raises(sqlguard.SqlNotAllowedError) as err:
            sqlguard.assert_read_only(sql)
        assert verb in str(err.value)

    def test_a_write_hidden_after_a_read_still_refuses_the_whole_script(self) -> None:
        with pytest.raises(sqlguard.SqlNotAllowedError) as err:
            sqlguard.assert_read_only("SELECT 1; DROP TABLE sales;")
        assert "DROP" in str(err.value)

    def test_write_hidden_in_a_comment_does_not_smuggle_through(self) -> None:
        # The comment is stripped, so only the SELECT remains and is admitted;
        # the point is that the stripping happens BEFORE verb detection.
        assert sqlguard.assert_read_only("SELECT 1 -- DROP TABLE sales") == ["SELECT 1"]

    def test_semicolon_inside_a_literal_is_not_a_statement_break(self) -> None:
        stmts = sqlguard.assert_read_only("SELECT 'a;b' AS s")
        assert stmts == ["SELECT 'a;b' AS s"]

    def test_non_introspection_pragma_is_refused(self) -> None:
        with pytest.raises(sqlguard.SqlNotAllowedError) as err:
            sqlguard.assert_read_only("PRAGMA enable_profiling")
        assert "introspection pragma" in str(err.value)

    def test_unknown_verb_is_default_denied(self) -> None:
        with pytest.raises(sqlguard.SqlNotAllowedError) as err:
            sqlguard.assert_read_only("FROBNICATE everything")
        assert "not a recognized read statement" in str(err.value)

    def test_empty_query_is_refused_with_guidance(self) -> None:
        with pytest.raises(sqlguard.SqlNotAllowedError) as err:
            sqlguard.assert_read_only("   \n  ")
        assert "empty" in str(err.value).lower()


# The exact DSN shape data-plane/ducklake-catalog-postgres.bicep emits
# (postgresql:// URI, sslmode=require) with a password containing the '!' the
# seed derivation produces.
_COMMERCIAL_DSN = (
    "postgresql://loomadmin:Dl7abcdefghij!Qz@"
    "psql-loom-ducklake-abc.postgres.database.azure.com:5432/ducklake?sslmode=require"
)
_GOV_DSN = _COMMERCIAL_DSN.replace(
    "postgres.database.azure.com", "postgres.database.usgovcloudapi.net"
)


def _console_script(dsn: str) -> str:
    """Byte-for-byte what apps/fiab-console/lib/azure/ducklake-catalog-client.ts builds."""
    return (
        f"ATTACH 'ducklake:postgres:{dsn}' AS \"loom_ducklake\" (READ_ONLY); "
        "SELECT table_schema AS schema, table_name AS name FROM information_schema.tables "
        "WHERE table_catalog = 'loom_ducklake' ORDER BY table_schema, table_name;"
    )


class TestDucklakeAttachCarveOut:
    """The DuckLake catalog listing is the ONLY ATTACH the tier admits.

    Before this carve-out ATTACH sat in WRITE_VERBS unconditionally, so the
    Console's listing POST 400'd with `read_only` before DuckDB ever saw it and
    the whole svc-ducklake-catalog surface was unreachable regardless of what
    the deployment wired.
    """

    def test_the_console_listing_script_is_admitted_commercial(self) -> None:
        stmts = sqlguard.assert_read_only(_console_script(_COMMERCIAL_DSN))
        assert len(stmts) == 2
        assert stmts[0].upper().startswith("ATTACH")
        assert stmts[1].upper().startswith("SELECT")

    def test_the_console_listing_script_is_admitted_in_gov(self) -> None:
        assert len(sqlguard.assert_read_only(_console_script(_GOV_DSN))) == 2

    def test_libpq_keyword_dsn_shape_is_also_admitted(self) -> None:
        dsn = "host=psql-loom-ducklake-abc.postgres.database.azure.com dbname=ducklake sslmode=require"
        sql = f"ATTACH 'ducklake:postgres:{dsn}' AS x (READ_ONLY); SELECT 1;"
        assert len(sqlguard.assert_read_only(sql)) == 2

    @pytest.mark.parametrize(
        ("sql", "because"),
        [
            (
                "ATTACH 'ducklake:postgres://u:p@evil.example.com:5432/db' AS x (READ_ONLY); SELECT 1;",
                "off-suffix host (SSRF)",
            ),
            (
                "ATTACH 'ducklake:postgres://u:p@169.254.169.254/db' AS x (READ_ONLY); SELECT 1;",
                "link-local metadata address",
            ),
            ("ATTACH 'ducklake:postgres:HOSTDSN' AS x (); SELECT 1;", "no READ_ONLY"),
            ("ATTACH 'ducklake:postgres:HOSTDSN' AS x; SELECT 1;", "no option list"),
            ("ATTACH '/etc/passwd' AS x (READ_ONLY); SELECT 1;", "local file"),
            (
                "ATTACH 'postgres:host=psql-x.postgres.database.azure.com' AS x (READ_ONLY); SELECT 1;",
                "bare postgres attach",
            ),
            ("ATTACH 'https://evil.example.com/x.db' AS x (READ_ONLY); SELECT 1;", "remote db file"),
        ],
    )
    def test_every_other_attach_shape_is_still_refused(self, sql: str, because: str) -> None:
        sql = sql.replace("HOSTDSN", _COMMERCIAL_DSN)
        with pytest.raises(sqlguard.SqlNotAllowedError) as err:
            sqlguard.assert_read_only(sql)
        assert "ATTACH" in str(err.value), because

    def test_detach_is_still_refused(self) -> None:
        with pytest.raises(sqlguard.SqlNotAllowedError) as err:
            sqlguard.assert_read_only("DETACH loom_ducklake;")
        assert "DETACH" in str(err.value)

    def test_attach_alone_is_refused_it_must_serve_a_read(self) -> None:
        with pytest.raises(sqlguard.SqlNotAllowedError) as err:
            sqlguard.assert_read_only(
                f"ATTACH 'ducklake:postgres:{_COMMERCIAL_DSN}' AS x (READ_ONLY);"
            )
        assert "followed by a read" in str(err.value)

    def test_only_one_attach_per_script(self) -> None:
        sql = (
            f"ATTACH 'ducklake:postgres:{_COMMERCIAL_DSN}' AS x (READ_ONLY); "
            f"ATTACH 'ducklake:postgres:{_COMMERCIAL_DSN}' AS y (READ_ONLY); SELECT 1;"
        )
        with pytest.raises(sqlguard.SqlNotAllowedError) as err:
            sqlguard.assert_read_only(sql)
        assert "one DuckLake ATTACH" in str(err.value)

    def test_a_write_riding_behind_an_admitted_attach_still_refuses_the_script(self) -> None:
        sql = f"ATTACH 'ducklake:postgres:{_COMMERCIAL_DSN}' AS x (READ_ONLY); DROP TABLE sales;"
        with pytest.raises(sqlguard.SqlNotAllowedError) as err:
            sqlguard.assert_read_only(sql)
        assert "DROP" in str(err.value)

    def test_the_refusal_never_echoes_the_dsn_password(self) -> None:
        sql = (
            "ATTACH 'ducklake:postgres://u:SuperSecretPw@evil.example.com/db' AS x (READ_ONLY);"
            " SELECT 1;"
        )
        with pytest.raises(sqlguard.SqlNotAllowedError) as err:
            sqlguard.assert_read_only(sql)
        assert "SuperSecretPw" not in str(err.value)

    def test_host_suffix_allowlist_is_overridable_for_air_gapped_estates(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        sql = "ATTACH 'ducklake:postgres://u:p@pg.internal.enclave/db' AS x (READ_ONLY); SELECT 1;"
        with pytest.raises(sqlguard.SqlNotAllowedError):
            sqlguard.assert_read_only(sql)
        monkeypatch.setenv("LOOM_DUCKLAKE_ALLOWED_HOST_SUFFIXES", ".internal.enclave")
        assert len(sqlguard.assert_read_only(sql)) == 2
