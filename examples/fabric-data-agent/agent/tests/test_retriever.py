"""Tests for :mod:`agent.retriever`.

Covers:
  * :func:`generate_sql` templates (count / top-N / max-min / default).
  * :func:`_assert_read_only` blocks every mutation verb.
  * :class:`Retriever.retrieve` routes to the injected client and
    builds a correct :class:`Citation`.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# Add the fabric-data-agent package root to sys.path.  The dir name is
# hyphenated (not a regular Python identifier) so we import ``agent``
# as a top-level package from here.
_PKG_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(_PKG_ROOT))

from agent.config import FabricAgentSettings  # noqa: E402
from agent.retriever import (  # noqa: E402
    Citation,
    RetrievalResult,
    Retriever,
    UnsafeSQLError,
    _assert_read_only,
    generate_sql,
)


# ---------------------------------------------------------------------------
# SQL generation
# ---------------------------------------------------------------------------


def test_generate_sql_count() -> None:
    sql = generate_sql(
        "How many sales were there last quarter?",
        table="lakehouse.sales.orders",
        columns=["order_id", "total_amount"],
    )
    assert "COUNT(*)" in sql
    assert "FROM lakehouse.sales.orders" in sql


def test_generate_sql_top_n() -> None:
    sql = generate_sql(
        "Show me the top 5 orders by total_amount",
        table="lakehouse.sales.orders",
        columns=["order_id", "total_amount", "customer"],
    )
    assert "ORDER BY total_amount DESC" in sql
    assert "LIMIT 5" in sql


def test_generate_sql_top_n_caps_at_limit() -> None:
    sql = generate_sql(
        "Top 10000 records",
        table="t",
        columns=["a"],
        limit=100,
    )
    assert "LIMIT 100" in sql


def test_generate_sql_max() -> None:
    sql = generate_sql(
        "What is the max total_amount on orders?",
        table="t",
        columns=["total_amount", "customer"],
    )
    assert sql.startswith("SELECT MAX(total_amount)")


def test_generate_sql_min() -> None:
    sql = generate_sql(
        "What is the lowest total_amount?",
        table="t",
        columns=["total_amount", "customer"],
    )
    assert sql.startswith("SELECT MIN(total_amount)")


def test_generate_sql_default_select() -> None:
    sql = generate_sql(
        "Give me some rows",
        table="t",
        columns=["a", "b"],
        limit=50,
    )
    assert sql == "SELECT a, b FROM t LIMIT 50"


# ---------------------------------------------------------------------------
# Read-only guard
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "bad",
    [
        "DELETE FROM t",
        "UPDATE t SET x=1",
        "INSERT INTO t VALUES (1)",
        "DROP TABLE t",
        "TRUNCATE TABLE t",
        "CREATE TABLE t (x int)",
        "MERGE INTO t USING s ON t.x = s.x",
        "ALTER TABLE t ADD COLUMN y INT",
        "GRANT SELECT ON t TO user",
        "EXEC sp_msforeachtable 'DROP TABLE ?'",
        "SELECT * FROM t; DELETE FROM t",
    ],
)
def test_assert_read_only_blocks_mutations(bad: str) -> None:
    with pytest.raises(UnsafeSQLError):
        _assert_read_only(bad)


def test_assert_read_only_allows_select() -> None:
    _assert_read_only("SELECT * FROM t LIMIT 10")
    _assert_read_only("WITH x AS (SELECT 1) SELECT * FROM x")
    _assert_read_only("SELECT COUNT(*) FROM t;")  # trailing semicolon OK


def test_assert_read_only_strips_comments() -> None:
    """Comments mustn't bypass the keyword scan."""
    _assert_read_only("SELECT 1 -- this is a comment about DELETE\n")
    with pytest.raises(UnsafeSQLError):
        _assert_read_only("DELETE /* disguised */ FROM t")


# ---------------------------------------------------------------------------
# Retriever (mocked client)
# ---------------------------------------------------------------------------


def _settings() -> FabricAgentSettings:
    return FabricAgentSettings(
        workspace_id="ws-guid-abc",
        lakehouse_id="lh-guid-xyz",
        max_rows=50,
    )


def test_retriever_uses_injected_client() -> None:
    client = MagicMock()
    client.execute_sql.return_value = [
        {"row_count": 42},
    ]
    retriever = Retriever(_settings(), client=client)
    result = retriever.retrieve(
        "How many orders are there?",
        table="lakehouse.sales.orders",
        columns=["order_id"],
    )
    assert isinstance(result, RetrievalResult)
    assert result.row_count == 1
    assert result.rows == [{"row_count": 42}]
    assert isinstance(result.citation, Citation)
    assert result.citation.source_type == "lakehouse_sql"
    assert result.citation.table_or_model == "lakehouse.sales.orders"
    assert "COUNT(*)" in result.citation.sql
    # Client was called with the right arguments.
    call = client.execute_sql.call_args
    assert call.kwargs["workspace_id"] == "ws-guid-abc"
    assert call.kwargs["lakehouse_id"] == "lh-guid-xyz"
    assert call.kwargs["timeout_seconds"] == 30


def test_retriever_flags_truncation_when_max_rows_hit() -> None:
    settings = FabricAgentSettings(
        workspace_id="w",
        lakehouse_id="l",
        max_rows=3,
    )
    client = MagicMock()
    client.execute_sql.return_value = [
        {"a": 1}, {"a": 2}, {"a": 3},  # exactly max_rows
    ]
    retriever = Retriever(settings, client=client)
    result = retriever.retrieve(
        "Show me rows",
        table="t",
        columns=["a"],
    )
    assert result.truncated is True


def test_retriever_blocks_unsafe_sql_before_client_call() -> None:
    """If a generator ever produces mutation SQL, we stop BEFORE hitting Fabric."""
    client = MagicMock()
    retriever = Retriever(_settings(), client=client)

    # Monkey-patch the generator output to something unsafe.
    from agent import retriever as retriever_mod

    original = retriever_mod.generate_sql

    def _evil_sql(*_a: object, **_kw: object) -> str:
        return "DELETE FROM t"

    retriever_mod.generate_sql = _evil_sql  # type: ignore[assignment]
    try:
        with pytest.raises(UnsafeSQLError):
            retriever.retrieve(
                "Clean up old rows",
                table="t",
                columns=["a"],
            )
    finally:
        retriever_mod.generate_sql = original  # type: ignore[assignment]
    client.execute_sql.assert_not_called()


def test_retriever_requires_fabric_config_without_client() -> None:
    """With no client and no workspace/lakehouse env, ``retrieve`` raises."""
    settings = FabricAgentSettings()  # empty
    retriever = Retriever(settings)
    with pytest.raises(RuntimeError, match="FABRIC_WORKSPACE_ID"):
        retriever.retrieve(
            "How many?",
            table="t",
            columns=["a"],
        )
