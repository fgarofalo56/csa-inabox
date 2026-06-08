"""Azure Function: CSA Loom Govern posture-refresh.

This single Function App serves BOTH Govern posture pre-compute paths:

Admin view (F2) — tenant-scoped
  A TimerTrigger (every 5 min) and an on-demand HTTP GET
  (``/api/posture-refresh-admin``) pre-compute one document per tenant into the
  Cosmos ``posture-aggregates-admin`` container (id = ``posture:{tenantId}``,
  PK ``/tenantId``). The Console BFF (``/api/governance/govern/posture``) reads
  this fast-path doc and surfaces its freshness via ``precomputedAt`` while still
  computing the live values inline. MIP/DLP/Purview enrichment runs live in the
  BFF; the Function pre-computes the Cosmos estate + trust/reuse aggregates that
  dominate read latency.

Data-owner view (F3) — owner-scoped
  An HTTP POST (``/api/posture-refresh``) recomputes one signed-in owner's
  governance coverage (label / description / endorsement) and UPSERTs it into the
  owner-partitioned ``posture-aggregates`` + ``recommended-actions`` containers
  (id == PK == ownerId). Dispatched fire-and-forget by the Console BFF
  (``/api/governance/govern/refresh``) on tab-open.

Backend: Cosmos DB only (Azure-native, no Microsoft Fabric dependency).

Auth
  - HTTP: Function-level key (``x-functions-key``), surfaced to the BFF via the
    ``LOOM_POSTURE_FUNCTION_KEY`` app setting (secretRef). ``/api/health`` is
    anonymous.
  - Cosmos: ``DefaultAzureCredential`` (the Function App's managed identity in
    production; ``az login`` locally). The MI holds the Cosmos DB Built-in Data
    Contributor role at account scope (granted in ``deploy/main.bicep``).

Cross-owner isolation (F3)
  ``ownerId`` / ``ownerUpn`` arrive in the request body, but the BFF derives them
  from the validated session cookie — the browser never sets them. The owner item
  query filters server-side on the caller's UPN and the aggregate doc is keyed
  (id == PK == ownerId) on the owner OID, so one owner's posture can never be
  written to or read from another owner's partition.

Per-cloud
  ``LOOM_COSMOS_ENDPOINT`` is resolved per boundary by admin-plane/main.bicep
  (documents.azure.com for Commercial/GCC, documents.azure.us for GCC-High/IL5),
  so no cloud-specific logic is needed here.
"""

from __future__ import annotations

import datetime as _dt
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

import azure.functions as func
from azure.cosmos import CosmosClient
from azure.identity import DefaultAzureCredential

app = func.FunctionApp()

logger = logging.getLogger("loom.posture_refresh")

_THIRTY_DAYS = _dt.timedelta(days=30)
_ENDORSED = ("Certified", "Promoted")


# ===========================================================================
# Admin view (F2) — tenant-scoped pre-compute → posture-aggregates-admin
# ===========================================================================


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
    posture = db.get_container_client("posture-aggregates-admin")

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


@app.route(route="posture-refresh-admin", methods=["GET"], auth_level=func.AuthLevel.FUNCTION)
def posture_refresh_admin_http(req: func.HttpRequest) -> func.HttpResponse:  # noqa: ARG001
    try:
        n = _refresh_all()
        return func.HttpResponse(
            f'{{"ok": true, "tenants": {n}}}',
            mimetype="application/json",
            status_code=200,
        )
    except Exception as exc:  # noqa: BLE001
        logging.exception("posture-refresh-admin (http) failed")
        return func.HttpResponse(
            f'{{"ok": false, "error": "{exc}"}}',
            mimetype="application/json",
            status_code=500,
        )


# ===========================================================================
# Data-owner view (F3) — owner-scoped on-demand → posture-aggregates
# ===========================================================================


def _cosmos_client() -> CosmosClient:
    endpoint = os.environ["LOOM_COSMOS_ENDPOINT"]
    cred = DefaultAzureCredential()
    return CosmosClient(endpoint, credential=cred)


def _json(payload: dict, status: int = 200) -> func.HttpResponse:
    return func.HttpResponse(json.dumps(payload), status_code=status, mimetype="application/json")


@app.route(route="health", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def health(req: func.HttpRequest) -> func.HttpResponse:  # noqa: ARG001
    return _json({"ok": True, "service": "posture-refresh"})


@app.route(route="posture-refresh", methods=["POST"], auth_level=func.AuthLevel.FUNCTION)
def posture_refresh(req: func.HttpRequest) -> func.HttpResponse:
    try:
        body = req.get_json()
    except ValueError:
        return _json({"ok": False, "error": "invalid json body"}, 400)

    scope = (body or {}).get("scope", "owner")
    if scope == "owner":
        return _refresh_owner(body)
    # Tenant scope is owned by the admin Govern view (F2), served by the
    # TimerTrigger + /api/posture-refresh-admin path above.
    return _json({"ok": False, "error": "unsupported scope; only 'owner' is implemented"}, 400)


def _refresh_owner(body: dict) -> func.HttpResponse:
    owner_id = (body or {}).get("ownerId", "")
    owner_upn = (body or {}).get("ownerUpn", "")
    if not owner_id or not owner_upn:
        return _json({"ok": False, "error": "missing ownerId or ownerUpn"}, 400)

    try:
        client = _cosmos_client()
        db = client.get_database_client(os.environ.get("LOOM_COSMOS_DATABASE", "loom"))
        items_c = db.get_container_client("items")
        ws_c = db.get_container_client("workspaces")
        agg_c = db.get_container_client("posture-aggregates")
        rec_c = db.get_container_client("recommended-actions")

        # Workspaces for this tenant (Loom convention: workspace.tenantId is the
        # tenant root that owns the owner OID's data plane).
        ws_ids = [
            w["id"]
            for w in ws_c.query_items(
                query="SELECT c.id FROM c WHERE c.tenantId = @t",
                parameters=[{"name": "@t", "value": owner_id}],
                partition_key=owner_id,
            )
        ]

        now = datetime.now(timezone.utc).isoformat()

        owner_items = []
        if ws_ids:
            owner_items = list(
                items_c.query_items(
                    query=(
                        "SELECT c.id, c.itemType, c.displayName, c.state, c.createdBy FROM c "
                        "WHERE ARRAY_CONTAINS(@w, c.workspaceId) "
                        "AND (c.state.ownerUpn = @upn OR c.state.contact = @upn "
                        "OR c.state.steward = @upn OR c.createdBy = @upn)"
                    ),
                    parameters=[
                        {"name": "@w", "value": ws_ids},
                        {"name": "@upn", "value": owner_upn},
                    ],
                    enable_cross_partition_query=True,
                )
            )

        total = len(owner_items)

        def _state(i: dict) -> dict:
            return i.get("state") or {}

        def _endorsed(i: dict) -> bool:
            st = _state(i)
            return st.get("endorsement") in _ENDORSED or st.get("certified") is True

        labeled = sum(1 for i in owner_items if _state(i).get("sensitivityLabel"))
        described = sum(1 for i in owner_items if _state(i).get("description"))
        endorsed = sum(1 for i in owner_items if _endorsed(i))

        def pct(n: int) -> int:
            return round(100 * n / total) if total > 0 else 0

        agg_doc = {
            "id": owner_id,
            "ownerId": owner_id,
            "totalItems": total,
            "labelCoveragePct": pct(labeled),
            "descriptionCoveragePct": pct(described),
            "endorsementCoveragePct": pct(endorsed),
            "computedAt": now,
        }
        agg_c.upsert_item(agg_doc)

        def _action(i: dict, issue: str) -> dict:
            return {
                "id": i.get("id"),
                "displayName": i.get("displayName"),
                "itemType": i.get("itemType"),
                "issue": issue,
            }

        rec_doc = {
            "id": owner_id,
            "ownerId": owner_id,
            "unlabeled": [_action(i, "no_label") for i in owner_items if not _state(i).get("sensitivityLabel")][:8],
            "undescribed": [_action(i, "no_description") for i in owner_items if not _state(i).get("description")][:8],
            "unendorsed": [_action(i, "no_endorsement") for i in owner_items if not _endorsed(i)][:8],
            "computedAt": now,
        }
        rec_c.upsert_item(rec_doc)

        logger.info("posture-refresh owner=%s items=%d", owner_upn, total)
        return _json({"ok": True, "scope": "owner", "kpis": agg_doc})
    except Exception as exc:  # noqa: BLE001 — surface as 500 with message
        logger.exception("posture-refresh failed")
        return _json({"ok": False, "error": str(exc)}, 500)
