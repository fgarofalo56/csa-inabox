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

import os
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
#:
#: `ATTACH` stays on this list. It is admitted ONLY through the deliberately
#: narrow DuckLake carve-out below (`_ducklake_attach_ok`) — every other shape
#: of ATTACH is still refused with the write message.
WRITE_VERBS = frozenset(
    {
        "INSERT", "UPDATE", "DELETE", "MERGE", "CREATE", "DROP", "ALTER", "TRUNCATE",
        "COPY", "EXPORT", "IMPORT", "ATTACH", "DETACH", "INSTALL", "LOAD", "FORCE",
        "SET", "RESET", "BEGIN", "COMMIT", "ROLLBACK", "CHECKPOINT", "VACUUM",
        "GRANT", "REVOKE", "PREPARE", "EXECUTE", "DEALLOCATE", "PIVOT", "UNPIVOT",
    }
)

#: ── DuckLake read-only ATTACH carve-out ──────────────────────────────────────
#: DuckLake keeps lakehouse table metadata in Postgres, and the ONLY way to read
#: it is `ATTACH 'ducklake:postgres:<dsn>' AS <alias> (READ_ONLY)` followed by a
#: SELECT. Before this carve-out the guard refused that ATTACH outright, so the
#: whole `svc-ducklake-catalog` surface was unreachable no matter what the
#: deployment wired — the request 400'd with `read_only` before DuckDB ever saw
#: it. (Baking the `ducklake`/`postgres` extensions into the image was necessary
#: but is downstream of this refusal.)
#:
#: The carve-out is intentionally the smallest thing that works:
#:   1. target MUST start with `ducklake:` — no plain file/postgres/https ATTACH;
#:   2. the `(READ_ONLY)` option MUST be present, so the attached catalog cannot
#:      be written even by DuckDB;
#:   3. the DSN host MUST end in a known Azure PostgreSQL Flexible Server suffix,
#:      which bounds the outbound connection an attacker-chosen DSN could open
#:      (the tier accepts SQL from the authenticated Console BFF, so a creative
#:      caller must not be able to point it at an arbitrary host);
#:   4. at most ONE ATTACH per script, and the script must still contain a read.
#: `DETACH` remains refused — the handle is connection-scoped and goes away with
#: the cursor.
_DUCKLAKE_PREFIX = "ducklake:"

#: Overridable so a sovereign/air-gapped estate can name its own Postgres host
#: suffix (e.g. a private-DNS-only zone) without patching the image.
_DEFAULT_PG_HOST_SUFFIXES = (
    ".postgres.database.azure.com",
    ".postgres.database.usgovcloudapi.net",
    ".postgres.database.chinacloudapi.cn",
)


def _allowed_pg_host_suffixes() -> tuple[str, ...]:
    raw = os.environ.get("LOOM_DUCKLAKE_ALLOWED_HOST_SUFFIXES", "").strip()
    if not raw:
        return _DEFAULT_PG_HOST_SUFFIXES
    parts = tuple(p.strip().lower() for p in raw.split(",") if p.strip())
    return parts or _DEFAULT_PG_HOST_SUFFIXES


#: `ATTACH '<single-quoted target>' AS <alias> (<options>)` — alias may be
#: quoted or bare. Options are matched loosely and checked for READ_ONLY below.
_ATTACH_RE = re.compile(
    r"^\s*ATTACH\s+(?:IF\s+NOT\s+EXISTS\s+)?'((?:[^']|'')*)'\s+AS\s+"
    r"(?:\"[^\"]+\"|[A-Za-z_][A-Za-z0-9_]*)\s*\((?P<opts>[^)]*)\)\s*$",
    re.IGNORECASE,
)

_KEYWORD_HOST_RE = re.compile(r"(?:^|[\s;])host\s*=\s*([^\s;]+)", re.IGNORECASE)
#: URI form — `postgresql://[user[:pass]@]host[:port][/db][?opts]`. The password
#: may itself contain '@' or '/', so anchor on the LAST '@' before the first
#: '/' that follows the scheme.
_URI_RE = re.compile(r"^\s*postgres(?:ql)?://(?P<rest>.*)$", re.IGNORECASE | re.DOTALL)


def _dsn_host(target: str) -> str | None:
    """Extract the host from a `ducklake:postgres:<dsn>` target.

    Handles BOTH shapes DuckDB/libpq accept: the `postgresql://` URI the Loom
    bicep module emits, and the `host=… dbname=…` keyword form. Returns None
    when no host can be determined. NEVER returns any other part of the DSN —
    the string carries a password and must not reach a log or an error message.
    """
    dsn = target[len(_DUCKLAKE_PREFIX):]
    # `ducklake:postgres:<dsn>` is the DuckLake form; the inner <dsn> may itself
    # be a `postgresql://` URI or libpq keywords. Strip the `postgres:` selector
    # ONLY when it is not already the URI scheme (`postgres://…`).
    if dsn.lower().startswith("postgres:") and not dsn.lower().startswith("postgres://"):
        dsn = dsn[len("postgres:"):]
    uri = _URI_RE.match(dsn)
    if uri:
        rest = uri.group("rest")
        authority = rest.split("/", 1)[0].split("?", 1)[0]
        # Strip userinfo at the LAST '@' so a password containing '@' is safe.
        if "@" in authority:
            authority = authority.rsplit("@", 1)[1]
        # Strip the port (and IPv6 brackets).
        if authority.startswith("["):
            authority = authority[1:].split("]", 1)[0]
        else:
            authority = authority.split(":", 1)[0]
        return authority.strip().lower() or None
    keyword = _KEYWORD_HOST_RE.search(dsn)
    if keyword:
        return keyword.group(1).strip().lower().rstrip("/") or None
    return None


def ducklake_attach_reason(statement: str) -> str | None:
    """Return None when `statement` is an admissible DuckLake ATTACH.

    Otherwise return the precise reason it is refused, so the caller can put it
    in the error rather than saying "ATTACH is a write".
    """
    match = _ATTACH_RE.match(strip_comments(statement))
    if not match:
        return (
            "only the exact form ATTACH '<ducklake dsn>' AS <alias> (READ_ONLY) is admitted"
        )
    target = match.group(1).replace("''", "'")
    if not target.lower().startswith(_DUCKLAKE_PREFIX):
        return f"the attach target must start with '{_DUCKLAKE_PREFIX}'"
    opts = [o.strip().upper() for o in match.group("opts").split(",")]
    if "READ_ONLY" not in opts:
        return "the (READ_ONLY) option is required"
    host = _dsn_host(target)
    if not host:
        return "the DuckLake DSN must name an explicit host"
    if not any(host.endswith(suffix) for suffix in _allowed_pg_host_suffixes()):
        return (
            f"host '{host}' is not an Azure PostgreSQL Flexible Server endpoint "
            "(set LOOM_DUCKLAKE_ALLOWED_HOST_SUFFIXES to widen this deliberately)"
        )
    return None

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

    attach_seen = 0
    read_seen = 0
    for statement in statements:
        verb = _first_token(statement)
        if verb in READ_VERBS:
            read_seen += 1
            continue
        if verb == "PRAGMA":
            pragma = _first_token(statement[len("PRAGMA"):])
            if pragma.lower() in READ_PRAGMAS:
                read_seen += 1
                continue
            raise SqlNotAllowedError(
                f"PRAGMA {pragma.lower() or '<empty>'} is not an introspection pragma. "
                "The DuckDB serving tier admits read-only statements; run schema or "
                "settings changes from the owning item's editor instead."
            )
        if verb == "ATTACH":
            # DuckLake carve-out — see the block comment on WRITE_VERBS. Anything
            # that is not the exact read-only DuckLake shape falls through to the
            # write refusal below, with the precise reason attached.
            reason = ducklake_attach_reason(statement)
            if reason is None:
                attach_seen += 1
                if attach_seen > 1:
                    raise SqlNotAllowedError(
                        "Only one DuckLake ATTACH is admitted per script. Split the "
                        "statements or attach a single catalog."
                    )
                continue
            raise SqlNotAllowedError(
                "ATTACH is a write/DDL statement. The DuckDB serving tier admits exactly "
                "one narrow form — a read-only DuckLake catalog attach — and this one was "
                f"refused because {reason}."
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
    if attach_seen and not read_seen:
        # An ATTACH on its own mutates only connection state and returns nothing.
        # Requiring a read keeps the carve-out a means to an end, not an end.
        raise SqlNotAllowedError(
            "A DuckLake ATTACH must be followed by a read statement in the same script."
        )
    return statements
