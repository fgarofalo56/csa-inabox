"""Azure Function: CSA Loom Govern posture-refresh.

Pre-computes the Govern -> Admin view (F2) posture aggregates per tenant and
upserts one document per tenant into the Cosmos `posture-aggregates` container
(id = ``posture:{tenantId}``, PK ``/tenantId``). The Console BFF
(``/api/governance/govern/posture``) reads this fast-path doc and surfaces its
freshness via ``precomputedAt`` while still computing the live values inline.

Triggers:
- TimerTrigger every 5 minutes (``0 */5 * * * *``).
- HttpTrigger ``GET /api/posture-refresh`` for on-demand refresh.

Backend: Cosmos DB only (Azure-native, no Microsoft Fabric dependency). The
richer MIP/DLP/Purview enrichment runs in the Console BFF on the live path; the
Function pre-computes the Cosmos estate + trust/reuse aggregates that dominate
read latency.

Auth: ``DefaultAzureCredential`` (the Function's user-assigned managed identity
in production; ``az login`` locally). The MI must hold the Cosmos DB Built-in
Data Contributor role at account scope.
"""

from __future__ import annotations

import datetime as _dt
import logging
import os
from typing import Any

import azure.functions as func
from azure.cosmos import CosmosClient
from azure.identity import DefaultAzureCredential

app = func.FunctionApp()

_THIRTY_DAYS = _dt.timedelta(days=30)


def _client() -> CosmosClient:
    endpoint = os.environ["LOOM_COSMOS_ENDPOINT"]
    cred = DefaultAzureCredential(
        managed_identity_client_id=os.environ.get("LOOM_UAMI_CLIENT_ID")
        or os.environ.get("AZURE_CLIENT_ID")
    )
    return CosmosClient(endpoint, credential=cred)


def _db(client: CosmosClient):
    return client.get_database_client(os.environ.get("LOOM_COSMOS_DATABASE", "loom"))


def _pct(n: int, d: int) -> int:
    return round(100 * n / d) if d else 0


def _is_owned(st: dict[str, Any]) -> bool:
    return bool(st.get("owner") or st.get("ownerUpn") or st.get("contact") or st.get("steward"))


def _is_endorsed(st: dict[str, Any]) -> bool:
    return st.get("endorsement") in ("Certified", "Promoted") or st.get("certified") is True


def _is_described(st: dict[str, Any]) -> bool:
    d = st.get("description")
    return isinstance(d, str) and bool(d.strip())


def _parse(ts: Any) -> _dt.datetime | None:
    if not ts or not isinstance(ts, str):
        return None
    try:
        return _dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def _compute_tenant(db, tenant_id: str) -> dict[str, Any]:
    """Compute the Cosmos posture aggregate for one tenant."""
    ws = db.get_container_client("workspaces")
    items_c = db.get_container_client("items")
    audit = db.get_container_client("audit-log")

    ws_rows = list(
        ws.query_items(
            query="SELECT c.id FROM c WHERE c.tenantId = @t",
            parameters=[{"name": "@t", "value": tenant_id}],
            partition_key=tenant_id,
        )
    )
    ws_ids = [r["id"] for r in ws_rows]

    items: list[dict[str, Any]] = []
    if ws_ids:
        items = list(
            items_c.query_items(
                query=(
                    "SELECT c.id, c.workspaceId, c.itemType, c.state, c.updatedAt "
                    "FROM c WHERE ARRAY_CONTAINS(@w, c.workspaceId)"
                ),
                parameters=[{"name": "@w", "value": ws_ids}],
                enable_cross_partition_query=True,
            )
        )

    total = len(items)
    now = _dt.datetime.now(_dt.timezone.utc)
    labeled = sum(1 for i in items if (i.get("state") or {}).get("sensitivityLabel"))
    endorsed = sum(1 for i in items if _is_endorsed(i.get("state") or {}))
    described = sum(1 for i in items if _is_described(i.get("state") or {}))

    fresh = 0
    capacities: set[str] = set()
    domains: set[str] = set()
    for i in items:
        st = i.get("state") or {}
        ts = _parse(i.get("updatedAt") or st.get("lastRefreshedAt") or st.get("freshness"))
        if ts and (now - ts) <= _THIRTY_DAYS:
            fresh += 1
        cap = st.get("capacityId") or st.get("capacity")
        if cap:
            capacities.add(str(cap))
        dom = st.get("domain") or st.get("domainId")
        if dom:
            domains.add(str(dom))

    shared = 0
    since = (now - _THIRTY_DAYS).isoformat()
    try:
        rows = list(
            audit.query_items(
                query=(
                    "SELECT VALUE COUNT(1) FROM c WHERE c.tenantId = @t AND c.at >= @s "
                    "AND (c.kind = 'share' OR c.action = 'share')"
                ),
                parameters=[{"name": "@t", "value": tenant_id}, {"name": "@s", "value": since}],
                enable_cross_partition_query=True,
            )
        )
        shared = rows[0] if rows else 0
    except Exception:  # noqa: BLE001 — audit container may be empty
        shared = 0

    return {
        "id": f"posture:{tenant_id}",
        "tenantId": tenant_id,
        "updatedAt": now.isoformat(),
        "workspaceCount": len(ws_ids),
        "totalItems": total,
        "capacityCount": len(capacities),
        "domainCount": len(domains),
        # MIP/DLP/Purview enrichment is computed live in the Console BFF; the
        # pre-computed doc carries null for those so the UI knows to read live.
        "mipCoveragePct": None,
        "mipLabelCount": None,
        "dlpViolations30d": None,
        "dlpLastViolationAt": None,
        "purviewLastScanAt": None,
        "freshItemsPct": _pct(fresh, total),
        "describedItemsPct": _pct(described, total),
        "endorsedItemsPct": _pct(endorsed, total),
        "sharedItems30d": shared,
        # carried so the live path can reuse it without re-counting labels
        "labeledCount": labeled,
    }


def _refresh_all() -> int:
    """Recompute + upsert posture for every tenant. Returns tenants processed."""
    client = _client()
    db = _db(client)
    ws = db.get_container_client("workspaces")
    posture = db.get_container_client("posture-aggregates")

    tenant_rows = list(
        ws.query_items(
            query="SELECT DISTINCT VALUE c.tenantId FROM c",
            enable_cross_partition_query=True,
        )
    )
    count = 0
    for tenant_id in tenant_rows:
        if not tenant_id:
            continue
        try:
            doc = _compute_tenant(db, tenant_id)
            posture.upsert_item(doc)
            count += 1
        except Exception:  # noqa: BLE001 — soft-fail one tenant, keep going
            logging.exception("posture-refresh failed for tenant %s", tenant_id)
    return count


@app.timer_trigger(schedule="0 */5 * * * *", arg_name="timer", run_on_startup=False, use_monitor=True)
def posture_refresh_timer(timer: func.TimerRequest) -> None:  # noqa: ARG001
    n = _refresh_all()
    logging.info("posture-refresh (timer): refreshed %d tenant(s)", n)


@app.route(route="posture-refresh", methods=["GET"], auth_level=func.AuthLevel.FUNCTION)
def posture_refresh_http(req: func.HttpRequest) -> func.HttpResponse:  # noqa: ARG001
    try:
        n = _refresh_all()
        return func.HttpResponse(
            f'{{"ok": true, "tenants": {n}}}',
            mimetype="application/json",
            status_code=200,
        )
    except Exception as exc:  # noqa: BLE001
        logging.exception("posture-refresh (http) failed")
        return func.HttpResponse(
            f'{{"ok": false, "error": "{exc}"}}',
            mimetype="application/json",
            status_code=500,
        )
