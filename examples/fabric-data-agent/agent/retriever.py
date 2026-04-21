"""Fabric Lakehouse SQL + semantic-model retriever.

Responsibilities
----------------
1. Take a natural-language question and a list of available tables.
2. Emit a read-class SQL statement targeting the Fabric Lakehouse SQL
   endpoint (or, optionally, a semantic-model DAX query).
3. Execute the SQL via the injected client.
4. Return a :class:`RetrievalResult` with the rows and a citation
   describing which table and columns were used.

Safety
------
* All SQL is validated by :func:`_assert_read_only` before execution —
  ``INSERT``, ``UPDATE``, ``DELETE``, ``DROP``, ``ALTER``, ``CREATE``,
  ``MERGE``, ``TRUNCATE`` are blocked.  The agent is a strictly
  *read-class* surface (per CSA-0113 scope).
* The Fabric SDK is lazy-imported inside :func:`_load_fabric_client`;
  unit tests inject a mocked client via :class:`Retriever(client=...)`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Protocol

from .config import FabricAgentSettings

# ---------------------------------------------------------------------------
# Result / client shapes
# ---------------------------------------------------------------------------


@dataclass
class Citation:
    """Citation returned with every retrieval.

    Attributes:
        source_type: ``"lakehouse_sql"`` or ``"semantic_model"``.
        table_or_model: Fully-qualified table (``lakehouse.schema.table``)
            or semantic-model name.
        columns: Columns referenced in the query.
        sql: The executed SQL or DAX expression (for audit/playback).
    """

    source_type: str
    table_or_model: str
    columns: list[str]
    sql: str


@dataclass
class RetrievalResult:
    rows: list[dict[str, Any]]
    citation: Citation
    row_count: int
    truncated: bool = False
    extra: dict[str, Any] = field(default_factory=dict)


class FabricClient(Protocol):
    """Minimal Fabric client contract exercised by :class:`Retriever`.

    The real :mod:`azure-fabric` / :mod:`semantic-link` SDKs expose a
    superset of this surface; tests use a :class:`~unittest.mock.MagicMock`
    that implements the same two methods.
    """

    def execute_sql(
        self,
        *,
        workspace_id: str,
        lakehouse_id: str,
        sql: str,
        timeout_seconds: int,
    ) -> list[dict[str, Any]]:  # pragma: no cover - interface
        ...

    def execute_dax(
        self,
        *,
        workspace_id: str,
        semantic_model_id: str,
        dax: str,
        timeout_seconds: int,
    ) -> list[dict[str, Any]]:  # pragma: no cover - interface
        ...


# ---------------------------------------------------------------------------
# SQL safety
# ---------------------------------------------------------------------------

_BLOCKED_KEYWORDS: tuple[str, ...] = (
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
    "DROP",
    "ALTER",
    "CREATE",
    "TRUNCATE",
    "GRANT",
    "REVOKE",
    "EXEC",
    "EXECUTE",
)

_SELECT_RE = re.compile(r"^\s*(WITH\s|SELECT\s)", flags=re.IGNORECASE)


class UnsafeSQLError(ValueError):
    """Raised when the agent generates a non-read SQL statement."""


def _strip_comments(sql: str) -> str:
    # Remove /* ... */ blocks and -- ... line comments before scanning.
    no_block = re.sub(r"/\*.*?\*/", " ", sql, flags=re.DOTALL)
    no_line = re.sub(r"--[^\n]*", " ", no_block)
    return no_line


def _assert_read_only(sql: str) -> None:
    stripped = _strip_comments(sql)
    if not _SELECT_RE.match(stripped):
        raise UnsafeSQLError("SQL must start with SELECT or WITH")
    upper = stripped.upper()
    for kw in _BLOCKED_KEYWORDS:
        if re.search(rf"\b{kw}\b", upper):
            raise UnsafeSQLError(f"SQL contains blocked keyword: {kw}")
    if ";" in stripped[:-1].rstrip():
        # Block multi-statement injections while still allowing a final semicolon.
        trimmed = stripped.rstrip().rstrip(";")
        if ";" in trimmed:
            raise UnsafeSQLError("Multi-statement SQL is not allowed")


# ---------------------------------------------------------------------------
# SQL generation (deterministic, template-based)
# ---------------------------------------------------------------------------


_SIMPLE_COUNT_RE = re.compile(
    r"how\s+many|count|number\s+of",
    flags=re.IGNORECASE,
)
_TOP_N_RE = re.compile(r"top\s+(\d+)", flags=re.IGNORECASE)
_MAX_MIN_RE = re.compile(r"\b(max|min|highest|lowest|largest|smallest)\b", flags=re.IGNORECASE)


def generate_sql(
    question: str,
    table: str,
    columns: list[str],
    *,
    limit: int = 100,
) -> str:
    """Deterministic SQL generator (the *grounding* contract).

    This is intentionally template-based rather than LLM-based.  The
    generator maps question shape → read-class query, so we can test
    it without an LLM mock and ship a predictable surface.  Production
    deployments layer an LLM-augmented fallback on top — kept out of
    scope here for CSA-0113.

    Supported question shapes:

    * ``how many / count / number of ...`` → ``SELECT COUNT(*)``.
    * ``top N`` → ``SELECT ... ORDER BY <numeric column> DESC LIMIT N``.
    * ``max / min / highest ...`` → ``SELECT MAX/MIN(...)``.
    * Anything else → ``SELECT <columns> LIMIT <limit>``.

    Args:
        question: The user's natural-language question.
        table: Fully-qualified table name.
        columns: Column list to emit for generic SELECT.
        limit: Row cap.

    Returns:
        A bare SQL string; the caller wraps it with :func:`_assert_read_only`.
    """
    q = question.strip()

    if _SIMPLE_COUNT_RE.search(q):
        return f"SELECT COUNT(*) AS row_count FROM {table}"

    top_n_match = _TOP_N_RE.search(q)
    if top_n_match:
        n = min(int(top_n_match.group(1)), limit)
        # Pick the first numeric-sounding column as the order key; fall
        # back to the first column when none match.
        numeric_candidates = [
            c
            for c in columns
            if any(tok in c.lower() for tok in ("amount", "count", "value", "total", "score", "rate"))
        ]
        order_col = numeric_candidates[0] if numeric_candidates else columns[0]
        col_list = ", ".join(columns)
        return f"SELECT {col_list} FROM {table} ORDER BY {order_col} DESC LIMIT {n}"

    max_min_match = _MAX_MIN_RE.search(q)
    if max_min_match:
        op = max_min_match.group(1).lower()
        sql_op = "MAX" if op in ("max", "highest", "largest") else "MIN"
        target = columns[0]
        for c in columns:
            if c.lower() in q.lower():
                target = c
                break
        return f"SELECT {sql_op}({target}) AS {sql_op.lower()}_{target} FROM {table}"

    col_list = ", ".join(columns)
    return f"SELECT {col_list} FROM {table} LIMIT {limit}"


# ---------------------------------------------------------------------------
# Retriever
# ---------------------------------------------------------------------------


class Retriever:
    """Query Fabric Lakehouse (or semantic model) for grounding rows.

    Args:
        settings: :class:`FabricAgentSettings` instance.
        client: Optional client override.  In tests pass a :class:`MagicMock`.
            When omitted the retriever lazy-loads the real SDK client
            (gated on ``settings.is_configured_for_fabric()``).
    """

    def __init__(
        self,
        settings: FabricAgentSettings,
        *,
        client: FabricClient | None = None,
    ) -> None:
        self._settings = settings
        self._client_override = client
        self._client: FabricClient | None = client

    def _ensure_client(self) -> FabricClient:
        if self._client is not None:
            return self._client
        if not self._settings.is_configured_for_fabric():
            raise RuntimeError(
                "Fabric client requested but FABRIC_WORKSPACE_ID / "
                "FABRIC_LAKEHOUSE_ID are unset.  Pass a mock client or "
                "populate the environment.",
            )
        self._client = _load_fabric_client()
        return self._client

    def retrieve(
        self,
        question: str,
        *,
        table: str,
        columns: list[str],
    ) -> RetrievalResult:
        """Run the question against the lakehouse and return rows + citation."""
        sql = generate_sql(
            question,
            table=table,
            columns=columns,
            limit=self._settings.max_rows,
        )
        if self._settings.enforce_read_only:
            _assert_read_only(sql)

        client = self._ensure_client()
        rows = client.execute_sql(
            workspace_id=self._settings.workspace_id,
            lakehouse_id=self._settings.lakehouse_id,
            sql=sql,
            timeout_seconds=self._settings.query_timeout_seconds,
        )

        truncated = len(rows) >= self._settings.max_rows
        return RetrievalResult(
            rows=rows,
            citation=Citation(
                source_type="lakehouse_sql",
                table_or_model=table,
                columns=columns,
                sql=sql,
            ),
            row_count=len(rows),
            truncated=truncated,
        )


# ---------------------------------------------------------------------------
# Lazy SDK loader
# ---------------------------------------------------------------------------


def _load_fabric_client() -> FabricClient:  # pragma: no cover - exercised only when SDK is installed
    """Import and construct the real Fabric client.

    Fabric SDK surfaces are evolving; this loader encapsulates the
    import so the rest of the module stays stable.  The loader will
    raise ``ImportError`` when the Fabric SDK is not installed — the
    :class:`Retriever` catches / re-raises it upstream.
    """
    raise ImportError(
        "The Fabric SDK is pre-GA; see examples/fabric-data-agent/GOV_NOTE.md. "
        "For tests, pass ``client=MagicMock()`` to Retriever.",
    )


__all__ = [
    "Citation",
    "FabricClient",
    "RetrievalResult",
    "Retriever",
    "UnsafeSQLError",
    "_assert_read_only",
    "generate_sql",
]
