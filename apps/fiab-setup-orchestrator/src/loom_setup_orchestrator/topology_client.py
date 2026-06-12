"""Topology registration client — orchestrator → console domain-registry callback.

After a ``dlz-attach`` deployment succeeds, the orchestrator registers the new
Data Landing Zone's domain in the Console's AUTHORITATIVE tenant topology store
(the ``domains:<tenant>`` Cosmos doc) by POSTing to the Console's token-gated
internal API:

    POST {LOOM_CONSOLE_INTERNAL_URL}/api/internal/topology/register-domain

so ``/admin/domains`` immediately shows the domain bound to its subscription,
resource group, region, capacity, and Entra admin/member groups with
``status: active`` (audit-t158).

Auth mirrors the Console → orchestrator hop in reverse:
  - ``Authorization: Bearer ${LOOM_INTERNAL_TOKEN}`` — the shared internal token
    Bicep wires to both apps.
  - ``x-loom-caller-oid: <caller_oid>`` — the signed-in user's object id the
    orchestrator carries through from the deploy request; the Console writes the
    binding under that tenant's partition.

Best-effort: a registration failure NEVER fails the deployment — it is logged
and surfaced via the deployment record. No Microsoft Fabric dependency.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)


def _console_internal_url() -> str:
    """The Console's CAE-internal base URL, or '' when not wired."""
    return (os.environ.get("LOOM_CONSOLE_INTERNAL_URL") or "").strip().rstrip("/")


async def register_domain_binding(
    *,
    caller_oid: str,
    domain_id: str,
    name: str | None = None,
    subscription_id: str | None = None,
    subscription_ids: list[str] | None = None,
    dlz_rg: str | None = None,
    location: str | None = None,
    capacity_sku: str | None = None,
    admin_group_id: str | None = None,
    member_group_id: str | None = None,
    cost_center: str | None = None,
    status: str = "active",
    timeout_s: float = 15.0,
) -> dict[str, Any] | None:
    """Register/update a domain's DLZ binding in the Console topology registry.

    Returns the Console's ``{ok, domain}`` payload on success, or ``None`` when
    the callback is not wired (``LOOM_CONSOLE_INTERNAL_URL`` unset) or fails —
    callers treat a ``None`` as best-effort-skipped and continue.
    """
    base = _console_internal_url()
    if not base:
        logger.info("register_domain_binding skipped: LOOM_CONSOLE_INTERNAL_URL unset")
        return None

    token = (os.environ.get("LOOM_INTERNAL_TOKEN") or "").strip()
    if not token:
        logger.warning("register_domain_binding skipped: LOOM_INTERNAL_TOKEN unset")
        return None
    if not caller_oid:
        logger.warning("register_domain_binding skipped: empty caller_oid")
        return None

    body: dict[str, Any] = {"domainId": domain_id, "status": status}
    if name:
        body["name"] = name
    if subscription_ids:
        body["subscriptionIds"] = subscription_ids
    if subscription_id:
        body["subscriptionId"] = subscription_id
    if dlz_rg:
        body["dlzRg"] = dlz_rg
    if location:
        body["location"] = location
    if capacity_sku:
        body["capacitySku"] = capacity_sku
    if admin_group_id:
        body["adminGroupId"] = admin_group_id
    if member_group_id:
        body["memberGroupId"] = member_group_id
    if cost_center:
        body["costCenter"] = cost_center

    url = f"{base}/api/internal/topology/register-domain"
    headers = {
        "content-type": "application/json",
        "authorization": f"Bearer {token}",
        "x-loom-caller-oid": caller_oid,
    }
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            resp = await client.post(url, json=body, headers=headers)
        if resp.status_code == 200:
            logger.info("Registered domain '%s' in Console topology registry", domain_id)
            return resp.json()
        logger.warning(
            "register_domain_binding for '%s' returned %s: %s",
            domain_id,
            resp.status_code,
            resp.text[:300],
        )
    except Exception as exc:  # best-effort — never fail the deploy
        logger.warning("register_domain_binding for '%s' failed: %s", domain_id, exc)
    return None
