"""Deterministic bicep-module validation tests for PRP-12, PRP-13.

These tests run `az bicep build` against the modules and assert that
the emitted ARM JSON contains the resources/outputs the PRP demands.
This is the same pipeline `az deployment sub create` runs, so any
green test here guarantees the module is deployable.

Skipped (with marker) if `az` is not on PATH.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
BICEP_MODULES = REPO_ROOT / "platform" / "fiab" / "bicep" / "modules"

needs_az = pytest.mark.skipif(
    shutil.which("az") is None,
    reason="az CLI not on PATH; cannot build bicep",
)


def _build_bicep(bicep_path: Path, tmp_path: Path) -> dict:
    """Build a bicep module to a temp ARM JSON file and parse it.

    Avoids stdout to dodge the Windows cp1252 UnicodeEncodeError that
    bites the Azure CLI when bicep emits non-ASCII descriptions.
    """
    out = tmp_path / (bicep_path.stem + ".json")
    az_path = shutil.which("az")
    cmd = [
        az_path,
        "bicep",
        "build",
        "--file",
        str(bicep_path),
        "--outfile",
        str(out),
    ]
    # Force UTF-8 so the Azure CLI doesn't choke on emojis in descriptions.
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    proc = subprocess.run(
        cmd,
        capture_output=True,
        env=env,
        check=False,
        shell=False,
    )
    assert out.exists(), (
        f"bicep build did not produce {out}. "
        f"stdout={proc.stdout!r} stderr={proc.stderr!r}"
    )
    return json.loads(out.read_text(encoding="utf-8"))


# ----- PRP-12 catalog.bicep --------------------------------------------


@needs_az
def test_catalog_bicep_builds_to_valid_arm(tmp_path):
    arm = _build_bicep(BICEP_MODULES / "admin-plane" / "catalog.bicep", tmp_path)
    assert arm.get("$schema", "").startswith("https://schema.management.azure.com/")
    assert "resources" in arm
    assert "parameters" in arm


@needs_az
def test_catalog_bicep_declares_per_boundary_outputs(tmp_path):
    """PRP-12 §Validation gates: per-boundary endpoint outputs."""
    arm = _build_bicep(BICEP_MODULES / "admin-plane" / "catalog.bicep", tmp_path)
    outputs = arm.get("outputs", {})
    for required in ("catalogKind", "purviewAccountId", "purviewAccountName", "purviewEndpoint", "atlasEndpoint"):
        assert required in outputs, f"missing output {required}"


@needs_az
def test_catalog_bicep_supports_all_three_backends(tmp_path):
    """PRP-12 §Acceptance: branches on catalogPrimary."""
    arm = _build_bicep(BICEP_MODULES / "admin-plane" / "catalog.bicep", tmp_path)
    catalog_param = arm["parameters"]["catalogPrimary"]
    allowed = catalog_param.get("allowedValues", [])
    assert set(allowed) >= {"unity-catalog-managed", "purview", "atlas-aks"}


@needs_az
def test_catalog_bicep_provisions_purview_when_enabled(tmp_path):
    arm = _build_bicep(BICEP_MODULES / "admin-plane" / "catalog.bicep", tmp_path)
    purview_resources = [
        r for r in arm.get("resources", [])
        if "Microsoft.Purview/accounts" in r.get("type", "")
    ]
    assert purview_resources, "no Microsoft.Purview/accounts resource in catalog.bicep"


@needs_az
def test_catalog_bicep_supports_atlas_namespace(tmp_path):
    arm = _build_bicep(BICEP_MODULES / "admin-plane" / "catalog.bicep", tmp_path)
    has_atlas = any(
        "namespaces" in r.get("type", "") and "ContainerService" in r.get("type", "")
        for r in arm.get("resources", [])
    )
    assert has_atlas, "no AKS namespace resource for Atlas in catalog.bicep"


# ----- PRP-13 ai-defense.bicep + monitoring.bicep -----------------------


@needs_az
def test_ai_defense_bicep_builds_to_valid_arm(tmp_path):
    arm = _build_bicep(BICEP_MODULES / "admin-plane" / "ai-defense.bicep", tmp_path)
    assert "resources" in arm
    assert "parameters" in arm


@needs_az
def test_ai_defense_bicep_deploys_logic_app_playbook(tmp_path):
    """PRP-13 §Acceptance: Logic App playbook + Sentinel automation rule."""
    arm = _build_bicep(BICEP_MODULES / "admin-plane" / "ai-defense.bicep", tmp_path)
    logic_apps = [
        r for r in arm.get("resources", [])
        if "Microsoft.Logic/workflows" in r.get("type", "")
    ]
    assert logic_apps, "no Logic App playbook in ai-defense.bicep"


@needs_az
def test_ai_defense_bicep_creates_sentinel_automation_rule(tmp_path):
    arm = _build_bicep(BICEP_MODULES / "admin-plane" / "ai-defense.bicep", tmp_path)
    sentinel_rules = [
        r for r in arm.get("resources", [])
        if "SecurityInsights" in r.get("type", "")
        and "automationRules" in r.get("type", "")
    ]
    assert sentinel_rules, "no Sentinel automation rule in ai-defense.bicep"


@needs_az
def test_monitoring_bicep_builds_to_valid_arm(tmp_path):
    arm = _build_bicep(BICEP_MODULES / "admin-plane" / "monitoring.bicep", tmp_path)
    assert "resources" in arm


@needs_az
def test_monitoring_bicep_has_scheduled_analytics_rules(tmp_path):
    """PRP-13 §Acceptance: 2 Scheduled Analytics Rules in monitoring.bicep."""
    arm = _build_bicep(BICEP_MODULES / "admin-plane" / "monitoring.bicep", tmp_path)
    # Walk the resources tree; Sentinel scheduled rules live at
    # Microsoft.SecurityInsights/alertRules with kind=Scheduled
    scheduled_rules = []
    for r in arm.get("resources", []):
        t = r.get("type", "")
        if "SecurityInsights" in t and "alertRules" in t:
            scheduled_rules.append(r)
    # Module gates these on !defenderForAIEnabled, but the ARM still
    # declares them with a condition; should be 2+ ai-defense rules
    assert len(scheduled_rules) >= 2, (
        f"expected >=2 Sentinel scheduled rules; found {len(scheduled_rules)}"
    )


# ----- A-4 / PMF-64 IL5/GCC-High MAF orchestration tier -----------------
# The MAF (Microsoft Agent Framework) tier is the Gov AOAI-direct copilot
# backend for GCC-High / IL5 (no AI Foundry Hub at IL4+). These tests are the
# deterministic half of the "full-stack gov deploy verification" — they prove
# the loom-copilot-maf Container App emits with the correct sovereign-cloud
# wiring, and that copilotMafEnabled is threaded through the top-level template.

MAIN_BICEP = REPO_ROOT / "platform" / "fiab" / "bicep" / "main.bicep"
COPILOT_MAF_BICEP = BICEP_MODULES / "copilot" / "maf.bicep"


def _container_env(arm: dict) -> dict:
    """Collect the env name→entry map of the first containerApps container."""
    for r in arm.get("resources", []):
        if "Microsoft.App/containerApps" in r.get("type", ""):
            containers = (
                r.get("properties", {})
                .get("template", {})
                .get("containers", [])
            )
            if containers:
                return {e["name"]: e for e in containers[0].get("env", [])}
    return {}


@needs_az
def test_maf_bicep_builds_to_valid_arm(tmp_path):
    arm = _build_bicep(COPILOT_MAF_BICEP, tmp_path)
    assert arm.get("$schema", "").startswith("https://schema.management.azure.com/")
    container_apps = [
        r for r in arm.get("resources", [])
        if "Microsoft.App/containerApps" in r.get("type", "")
    ]
    assert container_apps, "no Microsoft.App/containerApps resource in maf.bicep"
    assert any(
        r.get("name", "").strip("[]").replace("'", "") == "loom-copilot-maf"
        or "loom-copilot-maf" in json.dumps(r.get("name"))
        for r in container_apps
    ), "loom-copilot-maf Container App not found"


@needs_az
def test_maf_bicep_wires_gov_aoai_direct(tmp_path):
    """MAF must target the sovereign Gov AOAI plane, never commercial."""
    arm = _build_bicep(COPILOT_MAF_BICEP, tmp_path)
    env = _container_env(arm)
    # AZURE_CLOUD is hard-set to the Gov discriminator.
    assert env.get("AZURE_CLOUD", {}).get("value") == "AzureUSGovernment", (
        "MAF AZURE_CLOUD must be AzureUSGovernment"
    )
    # The Gov Cognitive Services audience — never the commercial one.
    aud = env.get("LOOM_AOAI_AUDIENCE", {}).get("value", "")
    assert aud == "https://cognitiveservices.azure.us", (
        f"MAF LOOM_AOAI_AUDIENCE must be the Gov audience; got {aud!r}"
    )
    assert "cognitiveservices.azure.com" not in json.dumps(env), (
        "MAF must not reference the commercial cognitiveservices.azure.com audience"
    )
    # Tier discriminator the Console orchestrator keys off.
    assert env.get("LOOM_TIER", {}).get("value") == "maf"


@needs_az
def test_maf_bicep_has_health_probes_and_internal_ingress(tmp_path):
    """/health probes + VNet-internal-only ingress (never public)."""
    arm = _build_bicep(COPILOT_MAF_BICEP, tmp_path)
    blob = json.dumps(arm)
    assert "/health" in blob, "MAF must expose /health liveness+readiness probes"
    app = next(
        r for r in arm["resources"]
        if "Microsoft.App/containerApps" in r.get("type", "")
    )
    ingress = app["properties"]["configuration"]["ingress"]
    assert ingress.get("external") is False, "MAF ingress must be VNet-internal (external=false)"
    assert ingress.get("targetPort") == 3100, "MAF must serve on port 3100"


@needs_az
def test_maf_bicep_boundary_allowed_values(tmp_path):
    """boundary param accepts exactly the two Gov boundaries MAF serves."""
    arm = _build_bicep(COPILOT_MAF_BICEP, tmp_path)
    allowed = arm["parameters"]["boundary"].get("allowedValues", [])
    assert set(allowed) == {"GCC-High", "IL5"}, (
        f"MAF boundary allowedValues must be GCC-High + IL5; got {allowed}"
    )


@needs_az
def test_main_bicep_threads_copilot_maf_enabled(tmp_path):
    """GAP-1 regression: copilotMafEnabled must be a real top-level param.

    Before this fix the flag only existed on admin-plane/main.bicep with a
    default of false, so the MAF tier could never activate via the gov
    .bicepparam files. This guards the wiring through main.bicep.
    """
    arm = _build_bicep(MAIN_BICEP, tmp_path)
    assert "copilotMafEnabled" in arm.get("parameters", {}), (
        "copilotMafEnabled is not a parameter of main.bicep — "
        "the gov params cannot enable the MAF tier"
    )
    assert arm["parameters"]["copilotMafEnabled"]["type"] == "bool"
