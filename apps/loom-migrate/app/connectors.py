"""CSA Loom — loom-migrate source-estate connectors (M1).

Each connector connects to ONE source estate and enumerates its inventory into
the canonical shape the console assessment engine consumes
(``lib/migrate/assessment.ts``): a list of objects, each with a canonical
``kind`` (the connector normalizes its own raw type onto the shared vocabulary),
a name, and optional schema/database/rawType.

NO VAPORWARE: every connector makes a REAL REST call to the source. It NEVER
returns fabricated inventory. When the CONNECTION prerequisite (account/workspace
URL + a bearer token) is absent, it returns an honest ``gate`` naming exactly
what to supply — never fake counts.

NO-FABRIC-DEPENDENCY: the Fabric and Power BI connectors reach
``api.fabric.microsoft.com`` / ``api.powerbi.com`` (or the sovereign-cloud host
the operator supplies) ONLY as a MIGRATION SOURCE — an operator explicitly picks
that source type and provides credentials. Loom itself has no Fabric dependency;
these are inbound migration sources only.

Transport is the Python standard library (urllib) — no third-party HTTP client —
so the image's only embeds stay fastapi/uvicorn/pydantic/azure-identity (all
license-reviewed).
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any

# ── canonical output shapes (mirror lib/migrate/assessment.ts) ────────────────


@dataclass
class SourceObject:
    kind: str
    name: str
    schema: str | None = None
    database: str | None = None
    rawType: str | None = None  # noqa: N815 — camelCase IS the wire contract
    meta: dict[str, Any] | None = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"kind": self.kind, "name": self.name}
        if self.schema:
            out["schema"] = self.schema
        if self.database:
            out["database"] = self.database
        if self.rawType:
            out["rawType"] = self.rawType
        if self.meta:
            out["meta"] = self.meta
        return out


@dataclass
class Inventory:
    sourceType: str  # noqa: N815
    sourceLabel: str | None = None  # noqa: N815
    objects: list[SourceObject] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {
            "sourceType": self.sourceType,
            "sourceLabel": self.sourceLabel,
            "objects": [o.to_json() for o in self.objects],
        }


class ConnectorGateError(Exception):
    """Raised when a source's connection prerequisite is missing (honest gate)."""

    def __init__(self, prerequisite: list[str], message: str) -> None:
        super().__init__(message)
        self.prerequisite = prerequisite
        self.message = message


class ConnectorError(Exception):
    """Raised on a real transport / source error (→ 502 to the BFF)."""

    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


# ── HTTP helpers (stdlib) ─────────────────────────────────────────────────────


def _get_json(url: str, token: str, timeout: int = 45) -> Any:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:  # pragma: no cover - network
        body = exc.read().decode("utf-8", "replace")[:300] if exc.fp else ""
        raise ConnectorError(f"Source returned {exc.code}: {body}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:  # pragma: no cover - network
        raise ConnectorError(f"Source unreachable: {exc}") from exc


def _post_json(url: str, token: str, payload: dict[str, Any], timeout: int = 45) -> Any:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:  # pragma: no cover - network
        body = exc.read().decode("utf-8", "replace")[:300] if exc.fp else ""
        raise ConnectorError(f"Source returned {exc.code}: {body}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:  # pragma: no cover - network
        raise ConnectorError(f"Source unreachable: {exc}") from exc


def _norm_host(host: str) -> str:
    host = host.strip().rstrip("/")
    if host and not host.startswith("http"):
        host = f"https://{host}"
    return host


# ── Databricks Unity Catalog ──────────────────────────────────────────────────


def enumerate_databricks_uc(conn: dict[str, Any]) -> Inventory:
    """Enumerate a Databricks Unity Catalog via the UC REST API.

    Prerequisites: ``host`` (workspace URL) + ``token`` (PAT). Optional
    ``catalog`` narrows enumeration to one catalog (else every catalog).
    """
    host = _norm_host(str(conn.get("host") or ""))
    token = str(conn.get("token") or "")
    if not host or not token:
        raise ConnectorGateError(
            ["host", "token"],
            "Provide the Databricks workspace URL (host) and a personal access token (token, stored as a Key Vault secret) to enumerate Unity Catalog.",
        )
    base = f"{host}/api/2.1/unity-catalog"
    inv = Inventory(sourceType="databricks-uc", sourceLabel=host)

    only = str(conn.get("catalog") or "").strip()
    if only:
        catalogs = [{"name": only}]
    else:
        catalogs = (_get_json(f"{base}/catalogs", token) or {}).get("catalogs", []) or []

    for cat in catalogs:
        cname = cat.get("name")
        if not cname:
            continue
        schemas = (_get_json(f"{base}/schemas?catalog_name={urllib.parse.quote(cname)}", token) or {}).get("schemas", []) or []
        for sch in schemas:
            sname = sch.get("name")
            if not sname:
                continue
            q = f"catalog_name={urllib.parse.quote(cname)}&schema_name={urllib.parse.quote(sname)}"
            for tbl in (_get_json(f"{base}/tables?{q}", token) or {}).get("tables", []) or []:
                raw = str(tbl.get("table_type") or "TABLE")
                kind = "sql-view" if raw.upper() in {"VIEW", "MATERIALIZED_VIEW"} else "relational-table"
                inv.objects.append(SourceObject(kind=kind, name=tbl.get("name", ""), schema=sname, database=cname, rawType=raw))
            for fn in (_get_json(f"{base}/functions?{q}", token) or {}).get("functions", []) or []:
                inv.objects.append(SourceObject(kind="stored-routine", name=fn.get("name", ""), schema=sname, database=cname, rawType="FUNCTION"))
    return inv


# ── Microsoft Fabric workspace (migration SOURCE only) ────────────────────────

_FABRIC_ITEM_KIND = {
    "Lakehouse": "lakehouse",
    "Warehouse": "warehouse",
    "MirroredWarehouse": "warehouse",
    "SemanticModel": "semantic-model",
    "Report": "report",
    "PaginatedReport": "paginated-report",
    "Notebook": "notebook",
    "SparkJobDefinition": "notebook",
    "DataPipeline": "data-pipeline",
    "Dataflow": "dataflow",
    "KQLDatabase": "kql-database",
    "Eventhouse": "eventhouse",
    "Eventstream": "eventstream",
    "MirroredDatabase": "mirrored-database",
    "MLModel": "ml-model",
    "MLExperiment": "ml-model",
}


def enumerate_fabric(conn: dict[str, Any]) -> Inventory:
    """Enumerate a Microsoft Fabric workspace's items (migration SOURCE only).

    Prerequisites: ``workspaceId`` + ``token`` (a Fabric-scoped bearer). Optional
    ``apiBase`` overrides the host for sovereign clouds.
    """
    ws = str(conn.get("workspaceId") or "").strip()
    token = str(conn.get("token") or "")
    if not ws or not token:
        raise ConnectorGateError(
            ["workspaceId", "token"],
            "Provide the Fabric workspace id (workspaceId) and a Fabric-scoped bearer token (token, stored as a Key Vault secret) to enumerate the workspace as a migration source.",
        )
    # cloud-endpoint: reached ONLY as an inbound migration source, not on any
    # default Loom path (no-fabric-dependency.md). Overridable for sovereign clouds.
    api_base = _norm_host(str(conn.get("apiBase") or "https://api.fabric.microsoft.com"))
    inv = Inventory(sourceType="fabric", sourceLabel=f"Fabric workspace {ws}")
    items = (_get_json(f"{api_base}/v1/workspaces/{urllib.parse.quote(ws)}/items", token) or {}).get("value", []) or []
    for it in items:
        raw = str(it.get("type") or "")
        inv.objects.append(SourceObject(kind=_FABRIC_ITEM_KIND.get(raw, "unknown"), name=it.get("displayName") or it.get("id", ""), rawType=raw))
    return inv


# ── Power BI workspace (migration SOURCE only) ────────────────────────────────


def enumerate_powerbi(conn: dict[str, Any]) -> Inventory:
    """Enumerate a Power BI workspace (group) — datasets, reports, dataflows,
    dashboards, paginated reports (migration SOURCE only).

    Prerequisites: ``workspaceId`` (group id) + ``token`` (a Power BI-scoped
    bearer). Optional ``apiBase`` overrides the host for sovereign clouds.
    """
    ws = str(conn.get("workspaceId") or "").strip()
    token = str(conn.get("token") or "")
    if not ws or not token:
        raise ConnectorGateError(
            ["workspaceId", "token"],
            "Provide the Power BI workspace (group) id (workspaceId) and a Power BI-scoped bearer token (token, stored as a Key Vault secret) to enumerate the workspace as a migration source.",
        )
    # cloud-endpoint: reached ONLY as an inbound migration source (Power BI is
    # Fabric-family) — never on a default Loom path. Overridable for sovereign clouds.
    api_base = _norm_host(str(conn.get("apiBase") or "https://api.powerbi.com"))
    group = f"{api_base}/v1.0/myorg/groups/{urllib.parse.quote(ws)}"
    inv = Inventory(sourceType="powerbi", sourceLabel=f"Power BI workspace {ws}")

    for ds in (_get_json(f"{group}/datasets", token) or {}).get("value", []) or []:
        inv.objects.append(SourceObject(kind="semantic-model", name=ds.get("name", ""), rawType="Dataset"))
    for rep in (_get_json(f"{group}/reports", token) or {}).get("value", []) or []:
        raw = str(rep.get("reportType") or "PowerBIReport")
        kind = "paginated-report" if raw == "PaginatedReport" else "report"
        inv.objects.append(SourceObject(kind=kind, name=rep.get("name", ""), rawType=raw))
    for df in (_get_json(f"{group}/dataflows", token) or {}).get("value", []) or []:
        inv.objects.append(SourceObject(kind="dataflow", name=df.get("name", ""), rawType="Dataflow"))
    for dash in (_get_json(f"{group}/dashboards", token) or {}).get("value", []) or []:
        inv.objects.append(SourceObject(kind="dashboard", name=dash.get("displayName", ""), rawType="Dashboard"))
    return inv


# ── Snowflake ─────────────────────────────────────────────────────────────────


def enumerate_snowflake(conn: dict[str, Any]) -> Inventory:
    """Enumerate a Snowflake database via the SQL REST API over INFORMATION_SCHEMA.

    Prerequisites: ``host`` (account URL) + ``token`` (an OAuth / key-pair JWT
    bearer) + ``catalog`` (the database to enumerate).
    """
    host = _norm_host(str(conn.get("host") or ""))
    token = str(conn.get("token") or "")
    database = str(conn.get("catalog") or "").strip()
    if not host or not token or not database:
        raise ConnectorGateError(
            ["host", "token", "catalog"],
            "Provide the Snowflake account URL (host), an OAuth/key-pair bearer token (token, stored as a Key Vault secret), and the database to enumerate (catalog).",
        )
    inv = Inventory(sourceType="snowflake", sourceLabel=f"{host} · {database}")
    db = database.replace('"', '""')
    sql = (
        f'SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM "{db}".INFORMATION_SCHEMA.TABLES '
        "WHERE TABLE_SCHEMA <> 'INFORMATION_SCHEMA' ORDER BY TABLE_SCHEMA, TABLE_NAME"
    )
    body = _post_json(f"{host}/api/v2/statements", token, {"statement": sql, "timeout": 60})
    rows = (body or {}).get("data", []) or []
    for row in rows:
        if not isinstance(row, list) or len(row) < 3:
            continue
        schema, name, ttype = str(row[0]), str(row[1]), str(row[2] or "")
        kind = "sql-view" if "VIEW" in ttype.upper() else "relational-table"
        inv.objects.append(SourceObject(kind=kind, name=name, schema=schema, database=database, rawType=ttype or "TABLE"))
    return inv


CONNECTORS = {
    "databricks-uc": enumerate_databricks_uc,
    "fabric": enumerate_fabric,
    "powerbi": enumerate_powerbi,
    "snowflake": enumerate_snowflake,
}
