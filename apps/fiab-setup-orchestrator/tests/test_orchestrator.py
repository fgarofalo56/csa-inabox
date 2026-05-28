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


# ----- run_bicep_deploy state machine -----------------------------------


@pytest.mark.asyncio
async def test_run_bicep_deploy_walks_to_succeeded(monkeypatch):
    """The deploy driver should progress through every stage and finish 'succeeded'."""
    store = DeploymentStateStore()
    req = {
        "boundary": "Commercial",
        "mode": "single-sub",
        "domain_name": "happy",
        "capacity_sku": "F2",
    }
    await store.create(deployment_id="d-3", request=req, caller_oid="oid-3")

    # Skip the production sleep so the test stays fast and deterministic.
    async def _no_sleep(_):
        return None

    monkeypatch.setattr(orchestrator.asyncio, "sleep", _no_sleep)

    await run_bicep_deploy(store, "d-3", req, "oid-3")

    state = await store.get("d-3")
    assert state["status"] == "succeeded"
    assert state["progress"] == 1.0
    assert state["completed_at"] is not None
    assert state["error"] is None


@pytest.mark.asyncio
async def test_run_bicep_deploy_records_failure(monkeypatch):
    """If a stage transition raises, status flips to 'failed' with the error."""
    store = DeploymentStateStore()
    req = {
        "boundary": "Commercial",
        "mode": "single-sub",
        "domain_name": "boom",
        "capacity_sku": "F2",
    }
    await store.create(deployment_id="d-4", request=req, caller_oid="oid-4")

    call_count = {"n": 0}

    async def _explode_after_first(_):
        call_count["n"] += 1
        if call_count["n"] > 1:
            raise RuntimeError("simulated MCP failure")

    monkeypatch.setattr(orchestrator.asyncio, "sleep", _explode_after_first)

    await run_bicep_deploy(store, "d-4", req, "oid-4")

    state = await store.get("d-4")
    assert state["status"] == "failed"
    assert "simulated MCP failure" in state["error"]


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
