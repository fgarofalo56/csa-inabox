"""Azure Function: CSA Loom access-governance sweeper (W3 + W4).

A thin SCHEDULER that drives the Console's access-governance endpoints. All the
real work — finding ledger assignments past their expiresAt, closing past-deadline
review campaigns (+ auto-revoking undecided grants), and reconciling Entra
group-targeted packages — lives in the Console BFF, where the TypeScript
grant/revoke + Cosmos + Graph clients already are. This Function just calls those
routes on a timer with the shared system token, so there is ONE implementation of
each (no ARM/SQL/ADX/Graph logic re-implemented in Python).

Triggers
  - TimerTrigger (every 15 min): POST {CONSOLE}/api/access-governance/sweep
                                 (W3 expiry auto-revoke)
  - TimerTrigger (hourly):       POST {CONSOLE}/api/access-governance/reviews/sweep
                                 (W4 AG-7 close past-deadline campaigns)
  - TimerTrigger (hourly):       POST {CONSOLE}/api/access-governance/group-sync
                                 (W4 AG-9 Entra group reconcile; no-ops honestly
                                  when LOOM_GRAPH_GROUP_SYNC_ENABLED is off)
  - HTTP GET /api/sweep-now (function key): run the expiry sweep on demand.
  - HTTP GET /api/reviews-sweep-now / /api/group-sync-now: run those on demand.
  - HTTP GET /api/health: anonymous liveness.

Config (app settings)
  - LOOM_CONSOLE_URL     — base URL of the Console (e.g. https://loom.internal).
  - LOOM_SWEEPER_TOKEN   — shared secret; sent as ``x-loom-system-token`` and
                           matched by the Console routes. Store as a KV secretRef.

Honest gate: if either setting is missing the Function logs a warning and no-ops.
Azure-native only — no Fabric/Cosmos dependency in this app.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.request

import azure.functions as func

app = func.FunctionApp()
logger = logging.getLogger("loom.access_sweeper")

_SWEEP_PATH = "/api/access-governance/sweep"
_REVIEW_SWEEP_PATH = "/api/access-governance/reviews/sweep"
_GROUP_SYNC_PATH = "/api/access-governance/group-sync"


def _call(path: str, dry_run: bool = False) -> dict:
    """POST a Console access-governance endpoint with the shared system token."""
    base = (os.environ.get("LOOM_CONSOLE_URL") or "").rstrip("/")
    token = os.environ.get("LOOM_SWEEPER_TOKEN") or ""
    if not base or not token:
        logger.warning("access-sweeper: LOOM_CONSOLE_URL / LOOM_SWEEPER_TOKEN not set — no-op")
        return {"ok": False, "gated": True, "error": "LOOM_CONSOLE_URL and LOOM_SWEEPER_TOKEN must be set"}
    url = f"{base}{path}" + ("?dryRun=1" if dry_run else "")
    req = urllib.request.Request(
        url,
        method="POST",
        headers={"x-loom-system-token": token, "content-type": "application/json"},
        data=b"{}",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:  # noqa: S310 — fixed internal host
        body = resp.read().decode("utf-8", "replace")
    try:
        return json.loads(body)
    except ValueError:
        return {"ok": resp.status < 400, "raw": body[:300]}


def _run_sweep(dry_run: bool = False) -> dict:
    return _call(_SWEEP_PATH, dry_run)


@app.timer_trigger(schedule="0 */15 * * * *", arg_name="timer", run_on_startup=False, use_monitor=True)
def sweep_timer(timer: func.TimerRequest) -> None:  # noqa: ARG001
    try:
        result = _run_sweep(dry_run=False)
        logger.info("access-sweeper (timer): %s", json.dumps(result)[:300])
    except Exception:  # noqa: BLE001 — never crash the host; next tick retries
        logger.exception("access-sweeper (timer) failed")


@app.route(route="sweep-now", methods=["GET", "POST"], auth_level=func.AuthLevel.FUNCTION)
def sweep_now(req: func.HttpRequest) -> func.HttpResponse:
    dry = req.params.get("dryRun") == "1"
    try:
        result = _run_sweep(dry_run=dry)
        return func.HttpResponse(json.dumps(result), mimetype="application/json", status_code=200 if result.get("ok") else 502)
    except Exception as exc:  # noqa: BLE001
        logger.exception("access-sweeper (http) failed")
        return func.HttpResponse(json.dumps({"ok": False, "error": str(exc)}), mimetype="application/json", status_code=500)


@app.timer_trigger(schedule="0 5 * * * *", arg_name="timer", run_on_startup=False, use_monitor=True)
def review_sweep_timer(timer: func.TimerRequest) -> None:  # noqa: ARG001
    """W4 AG-7 — close past-deadline review campaigns (+ auto-revoke undecided)."""
    try:
        result = _call(_REVIEW_SWEEP_PATH)
        logger.info("access-sweeper (review timer): %s", json.dumps(result)[:300])
    except Exception:  # noqa: BLE001
        logger.exception("access-sweeper (review timer) failed")


@app.timer_trigger(schedule="0 25 * * * *", arg_name="timer", run_on_startup=False, use_monitor=True)
def group_sync_timer(timer: func.TimerRequest) -> None:  # noqa: ARG001
    """W4 AG-9 — reconcile Entra group-targeted packages (no-ops when gate off)."""
    try:
        result = _call(_GROUP_SYNC_PATH)
        logger.info("access-sweeper (group-sync timer): %s", json.dumps(result)[:300])
    except Exception:  # noqa: BLE001
        logger.exception("access-sweeper (group-sync timer) failed")


@app.route(route="reviews-sweep-now", methods=["GET", "POST"], auth_level=func.AuthLevel.FUNCTION)
def reviews_sweep_now(req: func.HttpRequest) -> func.HttpResponse:
    dry = req.params.get("dryRun") == "1"
    try:
        result = _call(_REVIEW_SWEEP_PATH, dry_run=dry)
        return func.HttpResponse(json.dumps(result), mimetype="application/json", status_code=200 if result.get("ok") else 502)
    except Exception as exc:  # noqa: BLE001
        logger.exception("access-sweeper (reviews http) failed")
        return func.HttpResponse(json.dumps({"ok": False, "error": str(exc)}), mimetype="application/json", status_code=500)


@app.route(route="group-sync-now", methods=["GET", "POST"], auth_level=func.AuthLevel.FUNCTION)
def group_sync_now(req: func.HttpRequest) -> func.HttpResponse:
    dry = req.params.get("dryRun") == "1"
    try:
        result = _call(_GROUP_SYNC_PATH, dry_run=dry)
        return func.HttpResponse(json.dumps(result), mimetype="application/json", status_code=200 if result.get("ok") else 502)
    except Exception as exc:  # noqa: BLE001
        logger.exception("access-sweeper (group-sync http) failed")
        return func.HttpResponse(json.dumps({"ok": False, "error": str(exc)}), mimetype="application/json", status_code=500)


@app.route(route="health", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def health(req: func.HttpRequest) -> func.HttpResponse:  # noqa: ARG001
    return func.HttpResponse(json.dumps({"ok": True, "service": "access-governance-sweeper"}), mimetype="application/json")
