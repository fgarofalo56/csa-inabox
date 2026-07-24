"""Read-only admission control for the DuckDB serving tier (N2b)."""
from __future__ import annotations

import pytest

from .conftest import load

sqlguard = load("sqlguard")


class TestAdmittedReads:
    def test_select_is_admitted_and_returned_intact(self):
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
    def test_read_shapes(self, sql):
        assert sqlguard.assert_read_only(sql)

    def test_multi_statement_read_script_is_admitted_in_order(self):
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
    def test_writes_are_refused_by_name(self, sql, verb):
        with pytest.raises(sqlguard.SqlNotAllowedError) as err:
            sqlguard.assert_read_only(sql)
        assert verb in str(err.value)

    def test_a_write_hidden_after_a_read_still_refuses_the_whole_script(self):
        with pytest.raises(sqlguard.SqlNotAllowedError) as err:
            sqlguard.assert_read_only("SELECT 1; DROP TABLE sales;")
        assert "DROP" in str(err.value)

    def test_write_hidden_in_a_comment_does_not_smuggle_through(self):
        # The comment is stripped, so only the SELECT remains and is admitted;
        # the point is that the stripping happens BEFORE verb detection.
        assert sqlguard.assert_read_only("SELECT 1 -- DROP TABLE sales") == ["SELECT 1"]

    def test_semicolon_inside_a_literal_is_not_a_statement_break(self):
        stmts = sqlguard.assert_read_only("SELECT 'a;b' AS s")
        assert stmts == ["SELECT 'a;b' AS s"]

    def test_non_introspection_pragma_is_refused(self):
        with pytest.raises(sqlguard.SqlNotAllowedError) as err:
            sqlguard.assert_read_only("PRAGMA enable_profiling")
        assert "introspection pragma" in str(err.value)

    def test_unknown_verb_is_default_denied(self):
        with pytest.raises(sqlguard.SqlNotAllowedError) as err:
            sqlguard.assert_read_only("FROBNICATE everything")
        assert "not a recognized read statement" in str(err.value)

    def test_empty_query_is_refused_with_guidance(self):
        with pytest.raises(sqlguard.SqlNotAllowedError) as err:
            sqlguard.assert_read_only("   \n  ")
        assert "empty" in str(err.value).lower()
