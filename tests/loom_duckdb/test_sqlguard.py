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
#: A host that DOES satisfy the suffix allowlist — used to build the round-4
#: redirect cases, where the allowed name is present but is not what libpq
#: would actually connect to.
_OK_HOST = "psql-loom-ducklake-abc.postgres.database.azure.com"


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

    # ── The host-suffix control must bound the ACTUAL connection ─────────────
    # Round-4 regression set. The first implementation searched the DSN for a
    # `host=…` substring (or read the URI authority) and validated only that, but
    # libpq resolves a connection from the WHOLE keyword set — so every case
    # below was ADMITTED while the connection went to an attacker-chosen host.
    # `_OK_HOST` satisfies the suffix allowlist in each one; the redirect rides
    # next to it. These are the concrete failure inputs, not a restatement of the
    # rule: if the guard regresses, one of these starts passing.
    @pytest.mark.parametrize(
        ("dsn", "attacker_reaches", "libpq_behaviour"),
        [
            (
                f"host={_OK_HOST} hostaddr=10.0.0.5 dbname=d",
                "10.0.0.5",
                "hostaddr is connected to; host degrades to an SNI/cert name",
            ),
            (
                f"host=evil.example.com,{_OK_HOST} dbname=d",
                "evil.example.com",
                "a comma-separated host list is tried left to right",
            ),
            (
                f"host={_OK_HOST} host=evil.example.com dbname=d",
                "evil.example.com",
                "a repeated keyword keeps the LAST value",
            ),
            (
                f"host={_OK_HOST} service=evil dbname=d",
                "whatever pg_service.conf names",
                "service= pulls host/hostaddr/port out of a service file",
            ),
            (
                f"postgresql://u:p@{_OK_HOST}/d?hostaddr=10.0.0.5",
                "10.0.0.5",
                "URI query parameters are libpq connection keywords",
            ),
            (
                f"postgresql://u:p@{_OK_HOST}/d?host=evil.example.com",
                "evil.example.com",
                "a URI query host= overrides the authority",
            ),
            (
                f"postgresql://u:p@evil.example.com,{_OK_HOST}/d",
                "evil.example.com",
                "the multi-host list again, in URI form",
            ),
        ],
    )
    def test_dsn_cannot_redirect_the_connection_past_the_checked_host(
        self, dsn: str, attacker_reaches: str, libpq_behaviour: str
    ) -> None:
        sql = f"ATTACH 'ducklake:postgres:{dsn}' AS x (READ_ONLY); SELECT 1;"
        with pytest.raises(sqlguard.SqlNotAllowedError) as err:
            sqlguard.assert_read_only(sql)
        # And the refusal must not leak the DSN it refused.
        assert "evil.example.com" not in str(err.value), libpq_behaviour
        assert attacker_reaches not in str(err.value), libpq_behaviour

    def test_quoted_libpq_values_fail_closed_rather_than_half_parsed(self) -> None:
        """libpq allows single-quoted / backslash-escaped values. The guard does
        not parse those, so it refuses them instead of guessing (the URI form is
        what Loom itself emits). SQL-escaped as '' so the statement still parses
        as one ATTACH — i.e. the refusal comes from the DSN check, not from the
        outer statement shape."""
        dsn = f"host=''{_OK_HOST}'' dbname=d"
        sql = f"ATTACH 'ducklake:postgres:{dsn}' AS x (READ_ONLY); SELECT 1;"
        with pytest.raises(sqlguard.SqlNotAllowedError) as err:
            sqlguard.assert_read_only(sql)
        assert "postgresql://" in str(err.value)

    def test_a_raw_unescaped_quote_in_the_dsn_is_also_refused(self) -> None:
        """The same DSN written with a raw quote breaks the outer ATTACH shape
        instead — refused either way, which is the point."""
        sql = f"ATTACH 'ducklake:postgres:host='{_OK_HOST}'' AS x (READ_ONLY); SELECT 1;"
        with pytest.raises(sqlguard.SqlNotAllowedError):
            sqlguard.assert_read_only(sql)

    def test_a_plain_single_host_keyword_dsn_with_a_port_is_still_admitted(self) -> None:
        dsn = f"host={_OK_HOST} port=5432 dbname=ducklake sslmode=require"
        sql = f"ATTACH 'ducklake:postgres:{dsn}' AS x (READ_ONLY); SELECT 1;"
        assert len(sqlguard.assert_read_only(sql)) == 2

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
