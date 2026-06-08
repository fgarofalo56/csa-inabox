"""Azure Function: CSA Loom Posture Refresh.

Backs the data-owner Govern view (F3). On tab-open the Loom Console BFF
(/api/governance/govern/refresh) dispatches an owner-scoped recompute here;
this function reads the signed-in owner's items from the Loom Cosmos catalog,
computes governance coverage (sensitivity label / description / endorsement),
and UPSERTs the result into the ``posture-aggregates`` + ``recommended-actions``
containers. The Console then re-reads /api/governance/govern/owner, which serves
the freshly written aggregates from Cosmos.

Endpoints
---------
POST /api/posture-refresh  — compute owner (or tenant) posture and write Cosmos.
                             Auth: Function-level key (``x-functions-key``).
GET  /api/health           — liveness probe. Anonymous.

Auth model
----------
- HTTP: Function-level key, validated by the Functions host. The key lives in
  the Loom Key Vault and is surfaced to the Console BFF via the
  ``LOOM_POSTURE_FUNCTION_KEY`` app setting (secretRef). It is never exposed to
  the browser.
- Cosmos: the Function App's system-assigned managed identity holds the Cosmos
  "Built-in Data Contributor" role at account scope (granted in
  ``deploy/main.bicep``). No account keys — ``DefaultAzureCredential`` only.

Cross-owner isolation
---------------------
``ownerId`` / ``ownerUpn`` arrive in the request body, but the BFF derives them
from the validated session cookie — the browser never sets them. The owner item
query filters server-side on ``state.ownerUpn`` / ``state.contact`` /
``state.steward`` / ``createdBy`` matching the caller's UPN, and the aggregate
doc is keyed (id == PK == ownerId) on the owner OID, so one owner's posture can
never be written to or read from another owner's partition.

Cold-start budget
-----------------
On a Consumption (Y1) Python plan, cold start is ~2-5 s. The BFF dispatches this
fire-and-forget and the Console renders immediately from cached/live Cosmos data
— no user-facing request ever blocks on the cold start. Last-write-wins UPSERT
means the cached aggregate is never stale by more than one tab-open.

Per-cloud
---------
``LOOM_COSMOS_ENDPOINT`` is resolved per boundary by admin-plane/main.bicep
(documents.azure.com for Commercial/GCC, documents.azure.us for GCC-High/IL5),
so no cloud-specific logic is needed here.
"""

import json
import logging
import os
from datetime import datetime, timezone

import azure.functions as func
from azure.cosmos import CosmosClient
from azure.identity import DefaultAzureCredential

app = func.FunctionApp()
logger = logging.getLogger("loom.posture_refresh")

_ENDORSED = ("Certified", "Promoted")


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
    # Tenant scope is owned by the admin Govern view (served live by
    # /api/governance/insights); this Function is the owner-scoped path.
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
