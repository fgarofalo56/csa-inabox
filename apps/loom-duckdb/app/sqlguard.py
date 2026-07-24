"""Read-only SQL admission control for the loom-duckdb serving tier (N2b).

The service is a QUERY tier, never a write tier: it reads Delta / Iceberg /
Parquet off the customer's own ADLS Gen2 through the container's user-assigned
managed identity. Nothing in Loom's product surface needs it to write, so every
statement is admitted only when it is unambiguously a read.

The guard is deliberately a *shape* check on the tokenized statement rather
than a full parser: DuckDB itself is the authority (its `access_mode` and the
identity's **Storage Blob Data Reader** role are the real enforcement), and a
guard that silently permits an unknown verb is worse than one that refuses it.
Default-DENY: an unrecognized leading keyword is refused with the exact reason.

Pure Python, no DuckDB import — unit-testable with zero Azure and zero engine.
"""
from __future__ import annotations

import re

#: Leading keywords that can only ever read.
READ_VERBS = frozenset(
    {"SELECT", "WITH", "DESCRIBE", "DESC", "SHOW", "EXPLAIN", "VALUES", "TABLE", "FROM", "SUMMARIZE"}
)

#: `PRAGMA`/`CALL` are read-shaped in DuckDB but can also mutate settings, so a
#: narrow allowlist of introspection pragmas is admitted and nothing else.
READ_PRAGMAS = frozenset(
    {
        "database_list",
        "database_size",
        "show_tables",
        "show_tables_expanded",
        "table_info",
        "version",
        "platform",
        "database_versions",
    }
)

#: Statements that are unambiguously writes / privilege changes. Listed so the
#: refusal message can name the verb instead of saying "unknown".
WRITE_VERBS = frozenset(
    {
        "INSERT", "UPDATE", "DELETE", "MERGE", "CREATE", "DROP", "ALTER", "TRUNCATE",
        "COPY", "EXPORT", "IMPORT", "ATTACH", "DETACH", "INSTALL", "LOAD", "FORCE",
        "SET", "RESET", "BEGIN", "COMMIT", "ROLLBACK", "CHECKPOINT", "VACUUM",
        "GRANT", "REVOKE", "PREPARE", "EXECUTE", "DEALLOCATE", "PIVOT", "UNPIVOT",
    }
)

_LINE_COMMENT = re.compile(r"--[^\n]*")
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)


class SqlNotAllowedError(ValueError):
    """Raised when a statement is not admitted by the read-only guard."""


def strip_comments(sql: str) -> str:
    """Remove SQL comments so a write cannot hide behind ``--`` or ``/* */``."""
    return _BLOCK_COMMENT.sub(" ", _LINE_COMMENT.sub(" ", sql or ""))


def split_statements(sql: str) -> list[str]:
    """Split on semicolons that are OUTSIDE string literals.

    A naive ``sql.split(';')`` mis-splits ``SELECT ';'`` and would let a second
    statement ride along inside a literal, so quoting state is tracked.
    """
    out: list[str] = []
    buf: list[str] = []
    quote: str | None = None
    i = 0
    text = strip_comments(sql)
    while i < len(text):
        ch = text[i]
        if quote:
            buf.append(ch)
            if ch == quote:
                # Doubled quote is an escaped quote, not a terminator.
                if i + 1 < len(text) and text[i + 1] == quote:
                    buf.append(text[i + 1])
                    i += 2
                    continue
                quote = None
            i += 1
            continue
        if ch in ("'", '"'):
            quote = ch
            buf.append(ch)
            i += 1
            continue
        if ch == ";":
            out.append("".join(buf))
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    out.append("".join(buf))
    return [s.strip() for s in out if s.strip()]


def _first_token(statement: str) -> str:
    match = re.match(r"[\(\s]*([A-Za-z_][A-Za-z0-9_]*)", statement)
    return (match.group(1) if match else "").upper()


def assert_read_only(sql: str) -> list[str]:
    """Return the admitted statements, or raise :class:`SqlNotAllowedError`.

    Multi-statement submissions are allowed only when EVERY statement is a
    read — the SQL Lab surface runs a script, and refusing the whole script for
    one write is the honest outcome (a partially-executed script is worse).
    """
    statements = split_statements(sql)
    if not statements:
        raise SqlNotAllowedError("The query is empty. Type a SELECT and run it again.")

    for statement in statements:
        verb = _first_token(statement)
        if verb in READ_VERBS:
            continue
        if verb == "PRAGMA":
            pragma = _first_token(statement[len("PRAGMA"):])
            if pragma.lower() in READ_PRAGMAS:
                continue
            raise SqlNotAllowedError(
                f"PRAGMA {pragma.lower() or '<empty>'} is not an introspection pragma. "
                "The DuckDB serving tier admits read-only statements; run schema or "
                "settings changes from the owning item's editor instead."
            )
        if verb in WRITE_VERBS:
            raise SqlNotAllowedError(
                f"{verb} is a write/DDL statement. The DuckDB serving tier is read-only "
                "(its managed identity holds Storage Blob Data READER on the lake), so it "
                "cannot modify data. Use a notebook, pipeline or transformation project to write."
            )
        raise SqlNotAllowedError(
            f"'{verb or '<empty>'}' is not a recognized read statement. The DuckDB serving "
            "tier admits SELECT / WITH / DESCRIBE / SHOW / EXPLAIN / SUMMARIZE and "
            "introspection PRAGMAs only."
        )
    return statements
