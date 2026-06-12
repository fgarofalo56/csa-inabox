"""Deterministic tests for the CSA Loom Setup Orchestrator (PRP-04).

These tests exercise the same code paths the live Container App will hit:
  - DeploymentStateStore CRUD (in-memory mode)
  - bicep parameter rendering per boundary (Commercial / GCC / GCC-High)
  - run_bicep_deploy state-machine progression
  - FoundryOrchestrator + MafOrchestrator dispatch wiring
  - FastAPI request validation (DeployRequest schema)

Azure SDK calls are mocked. No live Azure access required.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# Import the orchestrator package without installing it.
SRC = Path(__file__).parents[1] / "src"
sys.path.insert(0, str(SRC))

from loom_setup_orchestrator import deployment_state, orchestrator  # noqa: E402
from loom_setup_orchestrator.deployment_state import (  # noqa: E402
    DeploymentStateStore,
    _render_bicep_parameters,
)
from loom_setup_orchestrator.orchestrator import (  # noqa: E402
    FoundryOrchestrator,
    MafOrchestrator,
    run_bicep_deploy,
)


# ----- bicep parameter rendering ----------------------------------------


def test_render_bicep_parameters_commercial():
    req = {
        "boundary": "Commercial",
        "mode": "single-sub",
        "domain_name": "salesops",
        "capacity_sku": "F8",
    }
    params = _render_bicep_parameters(req)
    assert params["environment"] == "AzureCloud"
    assert params["boundary"] == "Commercial"
    assert params["containerPlatform"] == "containerApps"
    assert params["capacitySku"] == "F8"
    assert params["dlzDomainNames"] == ["salesops"]


def test_render_bicep_parameters_gcc_high_uses_aks_and_usgov():
    req = {
        "boundary": "GCC-High",
        "mode": "multi-sub",
        "domain_name": "finance",
        "capacity_sku": "F64",
    }
    params = _render_bicep_parameters(req)
    assert params["environment"] == "AzureUSGovernment"
    assert params["containerPlatform"] == "aks"
    assert params["deploymentMode"] == "multi-sub"


def test_render_bicep_parameters_il5_uses_aks_and_usgov():
    req = {
        "boundary": "IL5",
        "mode": "single-sub",
        "domain_name": "il5-mission",
        "capacity_sku": "F128",
    }
    params = _render_bicep_parameters(req)
    assert params["environment"] == "AzureUSGovernment"
    assert params["containerPlatform"] == "aks"


def test_render_bicep_parameters_gcc_uses_container_apps():
    req = {
        "boundary": "GCC",
        "mode": "single-sub",
        "domain_name": "gcc-mission",
        "capacity_sku": "F2",
    }
    params = _render_bicep_parameters(req)
    # GCC is in the public cloud, not USGov
    assert params["environment"] == "AzureCloud"
    assert params["containerPlatform"] == "containerApps"


# ----- DeploymentStateStore (in-memory) ---------------------------------


@pytest.mark.asyncio
async def test_state_store_create_then_get_roundtrip():
    store = DeploymentStateStore()
    req = {
        "boundary": "Commercial",
        "mode": "single-sub",
        "domain_name": "test",
        "capacity_sku": "F2",
    }
    await store.create(deployment_id="d-1", request=req, caller_oid="oid-1")
    state = await store.get("d-1")
    assert state is not None
    assert state["status"] == "queued"
    assert state["progress"] == 0.0
    assert state["caller_oid"] == "oid-1"
    assert state["bicep_parameters"]["boundary"] == "Commercial"


@pytest.mark.asyncio
async def test_state_store_update_mutates_status_progress():
    store = DeploymentStateStore()
    req = {
        "boundary": "Commercial",
        "mode": "single-sub",
        "domain_name": "test",
        "capacity_sku": "F2",
    }
    await store.create(deployment_id="d-2", request=req, caller_oid="oid-2")
    await store.update("d-2", status="running", progress=0.5, current_stage="Provisioning")
    state = await store.get("d-2")
    assert state["status"] == "running"
    assert state["progress"] == 0.5
    assert state["current_stage"] == "Provisioning"


@pytest.mark.asyncio
async def test_state_store_get_returns_none_for_unknown_id():
    store = DeploymentStateStore()
    assert await store.get("does-not-exist") is None


@pytest.mark.asyncio
async def test_state_store_update_silently_skips_unknown_id():
    store = DeploymentStateStore()
    # Should not raise — caller can update concurrently after completion
    await store.update("unknown", status="failed")
    assert await store.get("unknown") is None


# ----- run_bicep_deploy state machine (real ARM path, SDK mocked) -------

# The real driver imports azure.mgmt.resource models at call time; skip the
# driver tests when the SDK isn't installed in this environment.
pytest.importorskip("azure.mgmt.resource", reason="azure-mgmt-resource not installed")

from types import SimpleNamespace  # noqa: E402


class _FakePoller:
    """Stands in for the LRO poller begin_create_or_update returns."""

    def __init__(self, provisioning_state: str) -> None:
        self._state = provisioning_state

    def done(self) -> bool:
        return True

    def result(self):
        return SimpleNamespace(properties=SimpleNamespace(provisioning_state=self._state))


class _FakeDeployments:
    def __init__(self, provisioning_state: str) -> None:
        self._state = provisioning_state
        self.calls: list = []

    def begin_create_or_update_at_subscription_scope(self, name, deployment):
        self.calls.append((name, deployment))
        return _FakePoller(self._state)


class _FakeResourceClient:
    def __init__(self, provisioning_state: str) -> None:
        self.deployments = _FakeDeployments(provisioning_state)


def _deploy_req() -> dict:
    return {
        "boundary": "Commercial",
        "mode": "single-sub",
        "domain_name": "happy",
        "capacity_sku": "F2",
        "subscription_id": "00000000-0000-0000-0000-000000000001",
        "region": "eastus2",
    }


@pytest.mark.asyncio
async def test_run_bicep_deploy_succeeds_on_arm_succeeded(monkeypatch):
    """A real subscription-scoped ARM submit that returns Succeeded → succeeded."""
    store = DeploymentStateStore()
    await store.create(deployment_id="d-3", request=_deploy_req(), caller_oid="oid-3")

    monkeypatch.setenv("LOOM_SETUP_TEMPLATE_URI", "https://loomtpl.blob.core.windows.net/main.json")
    fake = _FakeResourceClient("Succeeded")
    monkeypatch.setattr(orchestrator, "make_resource_client", lambda *a, **k: fake)

    await run_bicep_deploy(store, "d-3", _deploy_req(), "oid-3")

    state = await store.get("d-3")
    assert state["status"] == "succeeded"
    assert state["progress"] == 1.0
    assert state["completed_at"] is not None
    assert state["error"] is None
    # The real ARM call was actually made with our deployment name.
    assert fake.deployments.calls and fake.deployments.calls[0][0] == "loom-setup-d-3"


@pytest.mark.asyncio
async def test_run_bicep_deploy_fails_when_arm_not_succeeded(monkeypatch):
    """A terminal provisioning state other than Succeeded → failed (no fake success)."""
    store = DeploymentStateStore()
    await store.create(deployment_id="d-4", request=_deploy_req(), caller_oid="oid-4")

    monkeypatch.setenv("LOOM_SETUP_TEMPLATE_URI", "https://loomtpl.blob.core.windows.net/main.json")
    monkeypatch.setattr(orchestrator, "make_resource_client", lambda *a, **k: _FakeResourceClient("Failed"))

    await run_bicep_deploy(store, "d-4", _deploy_req(), "oid-4")

    state = await store.get("d-4")
    assert state["status"] == "failed"
    assert "Failed" in state["error"]


@pytest.mark.asyncio
async def test_run_bicep_deploy_propagates_arm_exception(monkeypatch):
    """If the ARM client raises, status flips to failed with the error."""
    store = DeploymentStateStore()
    await store.create(deployment_id="d-4b", request=_deploy_req(), caller_oid="oid-4b")

    monkeypatch.setenv("LOOM_SETUP_TEMPLATE_URI", "https://loomtpl.blob.core.windows.net/main.json")

    def _boom(*_a, **_k):
        raise RuntimeError("simulated ARM failure")

    monkeypatch.setattr(orchestrator, "make_resource_client", _boom)

    await run_bicep_deploy(store, "d-4b", _deploy_req(), "oid-4b")

    state = await store.get("d-4b")
    assert state["status"] == "failed"
    assert "simulated ARM failure" in state["error"]


@pytest.mark.asyncio
async def test_run_bicep_deploy_fails_honestly_without_template_uri(monkeypatch):
    """No LOOM_SETUP_TEMPLATE_URI → honest failure, never a fake success."""
    store = DeploymentStateStore()
    await store.create(deployment_id="d-4c", request=_deploy_req(), caller_oid="oid-4c")

    monkeypatch.delenv("LOOM_SETUP_TEMPLATE_URI", raising=False)

    await run_bicep_deploy(store, "d-4c", _deploy_req(), "oid-4c")

    state = await store.get("d-4c")
    assert state["status"] == "failed"
    assert "LOOM_SETUP_TEMPLATE_URI" in state["error"]


# ----- dlz-attach → console topology registration (audit-t158) ----------


@pytest.mark.asyncio
async def test_deploy_success_registers_domain_binding(monkeypatch):
    """On ARM Succeeded the orchestrator calls register_domain_binding with the
    request's domain / subscription / region / capacity — the automatic
    dlz-attach → Console topology-registry path."""
    store = DeploymentStateStore()
    await store.create(deployment_id="d-7", request=_deploy_req(), caller_oid="oid-7")

    monkeypatch.setenv("LOOM_SETUP_TEMPLATE_URI", "https://loomtpl.blob.core.windows.net/main.json")
    monkeypatch.setattr(orchestrator, "make_resource_client", lambda *a, **k: _FakeResourceClient("Succeeded"))

    calls: list[dict] = []

    async def _fake_register(**kwargs):
        calls.append(kwargs)
        return {"ok": True, "domain": {"domainId": kwargs.get("domain_id")}}

    monkeypatch.setattr(orchestrator, "register_domain_binding", _fake_register)

    await run_bicep_deploy(store, "d-7", _deploy_req(), "oid-7")

    state = await store.get("d-7")
    assert state["status"] == "succeeded"
    assert len(calls) == 1
    call = calls[0]
    assert call["caller_oid"] == "oid-7"
    assert call["domain_id"] == "happy"
    assert call["subscription_id"] == "00000000-0000-0000-0000-000000000001"
    assert call["location"] == "eastus2"
    assert call["capacity_sku"] == "F2"


@pytest.mark.asyncio
async def test_deploy_failure_does_not_register_domain_binding(monkeypatch):
    """A non-succeeded deploy must NOT register a binding — no false topology rows."""
    store = DeploymentStateStore()
    await store.create(deployment_id="d-8", request=_deploy_req(), caller_oid="oid-8")

    monkeypatch.setenv("LOOM_SETUP_TEMPLATE_URI", "https://loomtpl.blob.core.windows.net/main.json")
    monkeypatch.setattr(orchestrator, "make_resource_client", lambda *a, **k: _FakeResourceClient("Failed"))

    calls: list[dict] = []

    async def _fake_register(**kwargs):
        calls.append(kwargs)

    monkeypatch.setattr(orchestrator, "register_domain_binding", _fake_register)

    await run_bicep_deploy(store, "d-8", _deploy_req(), "oid-8")

    assert (await store.get("d-8"))["status"] == "failed"
    assert calls == []


@pytest.mark.asyncio
async def test_deploy_success_registers_each_dlz_domain(monkeypatch):
    """Multi-sub deploy with parallel DLZ arrays registers one binding per
    domain, pairing each domain with its own subscription id."""
    store = DeploymentStateStore()
    req = {
        "boundary": "Commercial",
        "mode": "multi-sub",
        "domain_name": "primary",
        "capacity_sku": "F8",
        "subscription_id": "00000000-0000-0000-0000-000000000001",
        "region": "eastus2",
        "dlz_domain_names": ["finance", "salesops"],
        "dlz_subscription_ids": [
            "00000000-0000-0000-0000-0000000000aa",
            "00000000-0000-0000-0000-0000000000bb",
        ],
    }
    await store.create(deployment_id="d-9", request=req, caller_oid="oid-9")

    monkeypatch.setenv("LOOM_SETUP_TEMPLATE_URI", "https://loomtpl.blob.core.windows.net/main.json")
    monkeypatch.setattr(orchestrator, "make_resource_client", lambda *a, **k: _FakeResourceClient("Succeeded"))

    calls: list[dict] = []

    async def _fake_register(**kwargs):
        calls.append(kwargs)

    monkeypatch.setattr(orchestrator, "register_domain_binding", _fake_register)

    await run_bicep_deploy(store, "d-9", req, "oid-9")

    assert [c["domain_id"] for c in calls] == ["finance", "salesops"]
    assert calls[0]["subscription_id"] == "00000000-0000-0000-0000-0000000000aa"
    assert calls[1]["subscription_id"] == "00000000-0000-0000-0000-0000000000bb"


# ----- Orchestrator backends dispatch -----------------------------------
@pytest.mark.asyncio
async def test_foundry_orchestrator_dispatches_to_deploy_driver(monkeypatch):
    store = DeploymentStateStore()
    req = MagicMock(
        boundary="Commercial",
        mode="single-sub",
        domain_name="dom",
        capacity_sku="F2",
    )
    req.model_dump.return_value = {
        "boundary": "Commercial",
        "mode": "single-sub",
        "domain_name": "dom",
        "capacity_sku": "F2",
    }
    await store.create(deployment_id="d-5", request=req.model_dump(), caller_oid="oid-5")

    called = {}

    async def _fake_driver(_store, _did, _req, _oid):
        called["did"] = _did
        called["oid"] = _oid

    monkeypatch.setattr(orchestrator, "run_bicep_deploy", _fake_driver)

    fo = FoundryOrchestrator(state_store=store)
    await fo.deploy("d-5", req, "oid-5")

    assert called == {"did": "d-5", "oid": "oid-5"}


@pytest.mark.asyncio
async def test_maf_orchestrator_dispatches_to_deploy_driver(monkeypatch):
    store = DeploymentStateStore()
    req = MagicMock()
    req.model_dump.return_value = {
        "boundary": "GCC-High",
        "mode": "single-sub",
        "domain_name": "gov",
        "capacity_sku": "F4",
    }
    await store.create(deployment_id="d-6", request=req.model_dump(), caller_oid="oid-6")

    called = {}

    async def _fake_driver(_store, _did, _req, _oid):
        called["did"] = _did

    monkeypatch.setattr(orchestrator, "run_bicep_deploy", _fake_driver)

    mo = MafOrchestrator(state_store=store)
    await mo.deploy("d-6", req, "oid-6")
    assert called == {"did": "d-6"}


# ----- FastAPI request validation ---------------------------------------


def test_deploy_request_validates_boundary():
    from loom_setup_orchestrator.main import DeployRequest

    with pytest.raises(Exception):  # pydantic ValidationError
        DeployRequest(
            boundary="NotAThing",
            mode="single-sub",
            domain_name="x",
            capacity_sku="F2",
        )


def test_deploy_request_validates_domain_name_pattern():
    from loom_setup_orchestrator.main import DeployRequest

    with pytest.raises(Exception):
        DeployRequest(
            boundary="Commercial",
            mode="single-sub",
            domain_name="HasUpperCase",  # pattern is [a-z0-9-]+
            capacity_sku="F2",
        )


def test_deploy_request_validates_capacity_sku():
    from loom_setup_orchestrator.main import DeployRequest

    with pytest.raises(Exception):
        DeployRequest(
            boundary="Commercial",
            mode="single-sub",
            domain_name="ok",
            capacity_sku="F1",  # not in Literal
        )


def test_deploy_request_accepts_all_valid_boundaries():
    from loom_setup_orchestrator.main import DeployRequest

    for boundary in ("Commercial", "GCC", "GCC-High", "IL5"):
        req = DeployRequest(
            boundary=boundary,  # type: ignore[arg-type]
            mode="single-sub",
            domain_name="ok",
            capacity_sku="F2",
        )
        assert req.boundary == boundary


# ----- dlz-attach topology (audit-t157) ---------------------------------


def test_deploy_parameters_tenant_emits_topology():
    from loom_setup_orchestrator.orchestrator import _deploy_parameters

    params = _deploy_parameters(
        {"boundary": "Commercial", "mode": "single-sub", "domain_name": "sales", "capacity_sku": "F8"}
    )
    assert params["topology"]["value"] == "tenant"
    assert params["deploymentMode"]["value"] == "single-sub"


def test_attach_parameters_shape():
    from loom_setup_orchestrator.orchestrator import _deploy_parameters

    params = _deploy_parameters(
        {
            "topology": "dlz-attach",
            "boundary": "Commercial",
            "domain_name": "finance",
            "capacity_sku": "F32",
            "target_subscription_id": "11111111-1111-1111-1111-111111111111",
            "hubVnetId": "/subscriptions/h/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/hub",
            "hubConsolePrincipalId": "principal-oid",
            "adx_enabled": False,
        }
    )
    assert params["topology"]["value"] == "dlz-attach"
    assert params["targetSubscriptionId"]["value"] == "11111111-1111-1111-1111-111111111111"
    assert params["attachDomainName"]["value"] == "finance"
    # multi-sub sizing but empty spoke arrays (no second console / no [for] loop)
    assert params["deploymentMode"]["value"] == "multi-sub"
    assert "dlzSubscriptionIds" not in params
    assert params["adxEnabled"]["value"] is False
    assert params["hubVnetId"]["value"].endswith("/hub")
    assert params["hubConsolePrincipalId"]["value"] == "principal-oid"


def test_role_assignment_remediation_commercial():
    from loom_setup_orchestrator.orchestrator import role_assignment_remediation

    cmd = role_assignment_remediation(
        principal_id="oid-123", subscription_id="sub-abc", is_gov=False
    )
    assert "az role assignment create" in cmd
    assert "--assignee-object-id oid-123" in cmd
    assert "--assignee-principal-type ServicePrincipal" in cmd
    assert "--role Contributor" in cmd
    assert "/subscriptions/sub-abc" in cmd
    assert "az cloud set" not in cmd  # commercial → no gov prefix


def test_role_assignment_remediation_gov_prefixes_cloud_set():
    from loom_setup_orchestrator.orchestrator import role_assignment_remediation

    cmd = role_assignment_remediation(principal_id=None, subscription_id="sub-gov", is_gov=True)
    assert cmd.splitlines()[0] == "az cloud set --name AzureUSGovernment"
    assert "<orchestrator-principal-object-id>" in cmd  # honest placeholder when unknown
