"""CSA Loom — loom-migrate estate-assessment reader (M1).

The inbound-migration ON-RAMP's backend: an internal-ingress Container App the
Console BFF (``/api/migrate/assess``) calls to ENUMERATE a source estate
(Snowflake / Databricks Unity Catalog / Microsoft Fabric / Power BI). It returns
a canonical INVENTORY the console's assessment engine
(``lib/migrate/assessment.ts``) turns into a migration-readiness report.

SECURITY POSTURE
  - INTERNAL ingress only. The Console BFF is the sole door; it authenticates
    the caller and writes a data-access audit row per assessment.
  - The reader holds NO standing source credentials. Each request carries the
    source connection (URL + a bearer token the BFF resolved from Key Vault);
    the reader uses them for that one enumeration and keeps nothing.

NO VAPORWARE: every connector makes a REAL REST call to the source. A source
whose connection prerequisite is missing returns an honest ``gate`` (never fake
counts). NO-FABRIC-DEPENDENCY: the Fabric / Power BI connectors reach their
hosts ONLY as an inbound migration SOURCE — Loom itself needs no Fabric.

SOVEREIGN / IL5: the reader runs in-boundary on the deployment's own Container
Apps environment. It reaches only the source estate the operator explicitly
points it at; with no source connection provided it does nothing but health +
capabilities. No SaaS assessment service is in the path.

Endpoints
---------
  GET  /health        liveness / readiness
  GET  /capabilities  which source connectors this build ships
  POST /enumerate     { sourceType, connection } → inventory | honest gate
"""
from __future__ import annotations

import logging
import os

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .connectors import CONNECTORS, ConnectorError, ConnectorGate

logging.basicConfig(level=os.environ.get("LOOM_MIGRATE_LOG_LEVEL", "INFO"))
log = logging.getLogger("loom-migrate")

app = FastAPI(title="loom-migrate", version="1.0.0")

SOURCE_TYPES = sorted(CONNECTORS.keys())


class EnumerateRequest(BaseModel):
    sourceType: str  # noqa: N815 — camelCase IS the wire contract with the BFF
    connection: dict = {}


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/capabilities")
def capabilities() -> dict[str, object]:
    """Which source connectors this build ships. Each is 'wired' (real REST
    enumeration) but requires a per-request connection; without one it honestly
    gates rather than returning fabricated inventory."""
    return {
        "ok": True,
        "sources": [
            {"sourceType": s, "wired": True, "requiresConnection": True}
            for s in SOURCE_TYPES
        ],
    }


@app.post("/enumerate")
def enumerate_estate(body: EnumerateRequest) -> JSONResponse:
    fn = CONNECTORS.get(body.sourceType)
    if fn is None:
        return JSONResponse(
            {"ok": False, "error": f"Unknown sourceType '{body.sourceType}'. Expected one of: {', '.join(SOURCE_TYPES)}."},
            status_code=400,
        )
    try:
        inventory = fn(body.connection or {})
    except ConnectorGate as gate:
        # Honest connection gate — reader reachable, source needs credentials.
        return JSONResponse(
            {"ok": False, "gated": True, "gate": {"prerequisite": gate.prerequisite, "message": gate.message}},
            status_code=200,
        )
    except ConnectorError as err:
        return JSONResponse({"ok": False, "error": str(err)}, status_code=err.status)
    except Exception as exc:  # pragma: no cover - defensive
        log.exception("enumerate failed")
        return JSONResponse({"ok": False, "error": f"Enumeration failed: {exc}"}, status_code=502)
    return JSONResponse({"ok": True, "inventory": inventory.to_json()})
