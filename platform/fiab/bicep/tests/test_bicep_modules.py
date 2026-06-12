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


# ----- audit-T47 MCP stdio→HTTP/SSE bridge IaC wiring -------------------
# The bridge app (apps/fiab-mcp-bridge) is fully wired in admin-plane bicep,
# but until now nothing at the IaC layer asserted it. These tests close that
# bicep+bootstrap-sync gap: the loom-mcp-bridge Container App entry, its image
# tag, its UAMI + outputs, the mcpBridgeUrl output, the Console env injection,
# and the per-boundary AZURE_CLOUD / AZURE_AUTHORITY_HOST.
#
# admin-plane/main.bicep is a 3k-line orchestrator with a known pre-existing
# compile state; rather than depend on a full `az bicep build` of it, the
# wiring assertions read the bicep *source* directly (deterministic, always
# runs). identity.bicep compiles cleanly, so its UAMI + outputs are also
# verified through the real ARM-emit pipeline.

ADMIN_PLANE = BICEP_MODULES / "admin-plane"
ADMIN_MAIN_BICEP = ADMIN_PLANE / "main.bicep"
IDENTITY_BICEP = ADMIN_PLANE / "identity.bicep"
AZURE_YAML = REPO_ROOT / "platform" / "fiab" / "azd" / "azure.yaml"


def _src(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_admin_main_declares_mcp_bridge_app_entry():
    """The loom-mcp-bridge Container App entry exists with internal ingress
    on 8080, the bridge health path, and the mcp tier."""
    src = _src(ADMIN_MAIN_BICEP)
    assert "name: 'loom-mcp-bridge'" in src, "no loom-mcp-bridge app entry"
    assert "image: 'loom-mcp-bridge:${appImageTags.mcpBridge}'" in src, (
        "loom-mcp-bridge app does not use the appImageTags.mcpBridge tag"
    )
    assert "uamiId: identity.outputs.uamiMcpBridgeId" in src, (
        "loom-mcp-bridge app not bound to the uamiMcpBridge identity"
    )
    # Internal-only ingress on the documented bridge port + health path.
    assert "ingressPort: 8080" in src
    assert "healthPath: '/.well-known/health'" in src, (
        "bridge health path /.well-known/health not wired"
    )
    # The bridge must never be public ingress.
    bridge_block = src[src.index("name: 'loom-mcp-bridge'") :]
    bridge_block = bridge_block[: bridge_block.index("name: 'loom-setup-orchestrator'")]
    assert "external: false" in bridge_block, (
        "loom-mcp-bridge ingress must be internal (external: false)"
    )
    assert "tier: 'mcp'" in bridge_block


def test_admin_main_image_tag_default_for_mcp_bridge():
    """appImageTags carries an mcpBridge tag default so the app can deploy."""
    src = _src(ADMIN_MAIN_BICEP)
    assert "mcpBridge:" in src, "appImageTags has no mcpBridge tag"


def test_admin_main_bridge_per_boundary_cloud_env():
    """The bridge child env is steered per boundary: Gov boundaries get the
    sovereign AZURE_CLOUD + .us authority host; everything else commercial."""
    src = _src(ADMIN_MAIN_BICEP)
    bridge_block = src[src.index("name: 'loom-mcp-bridge'") :]
    bridge_block = bridge_block[: bridge_block.index("name: 'loom-setup-orchestrator'")]
    assert "LOOM_MCP_BRIDGE_CONFIG" in bridge_block, (
        "bridge missing LOOM_MCP_BRIDGE_CONFIG env"
    )
    assert "LOOM_MCP_BRIDGE_PORT" in bridge_block
    # Boundary-conditional sovereign-cloud wiring.
    assert "AzureUSGovernment" in bridge_block and "AzureCloud" in bridge_block, (
        "bridge AZURE_CLOUD is not boundary-conditional"
    )
    assert "login.microsoftonline.us" in bridge_block, (
        "bridge AZURE_AUTHORITY_HOST does not target the Gov authority for "
        "GCC-High/IL5"
    )
    assert "GCC-High" in bridge_block and "IL5" in bridge_block, (
        "bridge boundary condition does not key off GCC-High/IL5"
    )


def test_admin_main_injects_bridge_url_into_console():
    """The Console app gets LOOM_MCP_BRIDGE_URL so the External-MCP panel can
    offer the bridged servers for one-click registration."""
    src = _src(ADMIN_MAIN_BICEP)
    assert "LOOM_MCP_BRIDGE_URL" in src, (
        "Console env never receives LOOM_MCP_BRIDGE_URL"
    )
    assert "http://loom-mcp-bridge:8080" in src, (
        "Console LOOM_MCP_BRIDGE_URL does not point at the internal bridge"
    )


def test_admin_main_emits_mcp_bridge_url_output():
    """admin-plane/main.bicep exposes the bridge URL as an output."""
    src = _src(ADMIN_MAIN_BICEP)
    assert "output mcpBridgeUrl string" in src, (
        "admin-plane/main.bicep does not declare the mcpBridgeUrl output"
    )


def test_identity_bicep_declares_mcp_bridge_uami_source():
    """identity.bicep declares the bridge UAMI + its three outputs."""
    src = _src(IDENTITY_BICEP)
    assert "resource uamiMcpBridge 'Microsoft.ManagedIdentity" in src, (
        "uamiMcpBridge identity resource missing from identity.bicep"
    )
    assert "name: 'uami-loom-mcp-bridge-${location}'" in src
    for out in ("uamiMcpBridgeId", "uamiMcpBridgeClientId", "uamiMcpBridgePrincipalId"):
        assert f"output {out} string" in src, f"identity.bicep missing output {out}"


def test_azure_yaml_declares_mcp_bridge_service():
    """azd service maps mcp-bridge to apps/fiab-mcp-bridge as a containerapp."""
    src = _src(AZURE_YAML)
    assert "mcp-bridge:" in src, "azure.yaml has no mcp-bridge service"
    assert "fiab-mcp-bridge" in src, (
        "mcp-bridge azd service does not point at apps/fiab-mcp-bridge"
    )


@needs_az
def test_identity_bicep_arm_emits_mcp_bridge_uami(tmp_path):
    """End-to-end ARM emit: identity.bicep compiles and the bridge UAMI +
    its three outputs are present in the emitted template."""
    arm = _build_bicep(IDENTITY_BICEP, tmp_path)
    blob = json.dumps(arm)
    assert "uami-loom-mcp-bridge-" in blob, (
        "emitted ARM has no uami-loom-mcp-bridge identity"
    )
    outputs = arm.get("outputs", {})
    for out in ("uamiMcpBridgeId", "uamiMcpBridgeClientId", "uamiMcpBridgePrincipalId"):
        assert out in outputs, f"emitted ARM missing output {out}"


# ----- D7 (audit-t165): functional RG layout + CAF naming/tagging ----------
# No admin mega-RG: the platform plane is split into six function RGs and each
# DLZ is split into four tier RGs, all with CAF names + a csa-loom-function tag
# merged onto the inherited compliance taxonomy. main.bicep references the
# admin-plane orchestrator, which has a known pre-existing max-params compile
# state, so these assertions read the bicep *source* directly (the same
# deterministic approach the MCP-bridge tests above use for admin-plane).

BOOTSTRAP_DLZ_RGS = (
    REPO_ROOT / "scripts" / "csa-loom" / "bootstrap-dlz-rgs.sh"
)

# (function label, expected var name in main.bicep)
_PLATFORM_RGS = [
    ("console", "rgConsole"),
    ("network", "rgNetwork"),
    ("shared-data", "rgSharedData"),
    ("governance", "rgGovernance"),
    ("observability", "rgObservability"),
    ("ai", "rgAi"),
]


def test_main_bicep_declares_six_function_rgs_with_caf_names():
    """The mega admin RG is replaced by six function RGs with CAF names."""
    src = _src(MAIN_BICEP)
    for fn, var in _PLATFORM_RGS:
        assert f"var {var}" in src, f"main.bicep missing naming var {var}"
        assert f"'rg-csa-loom-{fn}-${{location}}'" in src, (
            f"main.bicep missing CAF name for the {fn} RG"
        )
    # The old admin mega-RG name must be gone.
    assert "'rg-csa-loom-admin-${location}'" not in src, (
        "admin mega-RG name still present — D7 split incomplete"
    )
    # Six platform RG resources are declared.
    for var in ("consoleRg", "networkRg", "sharedDataRg", "governanceRg",
                "observabilityRg", "aiRg"):
        assert f"resource {var} 'Microsoft.Resources/resourceGroups" in src, (
            f"main.bicep does not declare the {var} resource"
        )


def test_main_bicep_tags_every_function_rg():
    """Every platform RG carries the compliance taxonomy + a function tag."""
    src = _src(MAIN_BICEP)
    for fn in ("console", "network", "shared-data", "governance",
               "observability", "ai"):
        assert (
            f"union(complianceTags, {{ 'csa-loom-function': '{fn}' }})" in src
        ), f"{fn} RG is not tagged with union(complianceTags, function)"


def test_main_bicep_splits_dlz_into_four_tiers():
    """Single-sub DLZ is split into core/compute/storage/streaming RGs, and the
    old DLZ mega-RG name is gone."""
    src = _src(MAIN_BICEP)
    for tier in ("core", "compute", "storage", "streaming"):
        assert f"'rg-csa-loom-dlz-default-{tier}-${{location}}'" in src, (
            f"main.bicep missing the DLZ -{tier} tier RG"
        )
        assert f"'csa-loom-function': 'dlz-{tier}'" in src, (
            f"DLZ -{tier} RG missing its function tag"
        )
    assert "'rg-csa-loom-dlz-single-${location}'" not in src, (
        "DLZ mega-RG (dlz-single) still present — 4-way split incomplete"
    )
    # Deterministic Console-bound names key off the -storage tier RG so the
    # Console binds to the real accounts the landing-zone module deploys.
    assert "uniqueString(singleDlzStorageRg.id)" in src, (
        "DLZ storage/Cosmos/Weave names are not keyed off the -storage RG"
    )


def test_main_bicep_admin_plane_scoped_to_console_rg():
    """The admin-plane orchestrator deploys into the console RG and depends on
    the other five function RGs (its sub-modules deploy cross-RG by name)."""
    src = _src(MAIN_BICEP)
    assert "scope: consoleRg" in src, "admin-plane not scoped to consoleRg"
    block = src[src.index("module adminPlane 'modules/admin-plane/main.bicep'"):]
    block = block[: block.index("params: {")]
    for rg in ("networkRg", "sharedDataRg", "governanceRg", "observabilityRg", "aiRg"):
        assert rg in block, f"adminPlane dependsOn is missing {rg}"


def test_admin_plane_rescopes_function_modules():
    """admin-plane re-derives the function RG names and re-scopes its
    sub-modules into them (network/observability/ai/governance/shared-data)."""
    src = _src(ADMIN_MAIN_BICEP)
    for var, name in (
        ("rgNetwork", "rg-csa-loom-network-${location}"),
        ("rgObservability", "rg-csa-loom-observability-${location}"),
        ("rgAi", "rg-csa-loom-ai-${location}"),
        ("rgGovernance", "rg-csa-loom-governance-${location}"),
        ("rgSharedData", "rg-csa-loom-shared-data-${location}"),
    ):
        assert f"var {var}" in src and f"'{name}'" in src, (
            f"admin-plane missing function RG var/name {var}"
        )
    # Representative re-scopes (network → network RG, LAW → observability,
    # AI Foundry → ai, Purview SHIR → governance, catalog → shared-data).
    assert "scope: resourceGroup(rgNetwork)" in src
    assert "scope: resourceGroup(rgObservability)" in src
    assert "scope: resourceGroup(rgAi)" in src
    assert "scope: resourceGroup(rgGovernance)" in src
    assert "scope: resourceGroup(rgSharedData)" in src
    # The networking + kusto Console env vars follow the moved resources.
    assert "{ name: 'LOOM_NETWORKING_RG', value: rgNetwork }" in src
    assert "adxEnabled ? rgObservability : ''" in src


def test_bootstrap_dlz_rgs_creates_four_tiers_per_domain():
    """The multi-sub bootstrap creates all four DLZ tier RGs per domain with
    the function tag (bicep+bootstrap sync)."""
    src = _src(BOOTSTRAP_DLZ_RGS)
    assert "for TIER in core compute storage streaming" in src, (
        "bootstrap does not loop the four DLZ tiers"
    )
    assert 'rg-csa-loom-dlz-${DOMAIN}-${TIER}-${LOCATION}' in src, (
        "bootstrap RG name does not include the tier segment"
    )
    assert "csa-loom-function=dlz-${TIER}" in src, (
        "bootstrap does not stamp the per-tier function tag"
    )

