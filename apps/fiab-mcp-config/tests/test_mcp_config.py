"""Deterministic tests for the self-hosted Azure MCP server config (PRP-05).

These tests assert the loom-mcp.json contract — they fail loudly the
moment someone weakens the tool allowlist, breaks PIM elevation, or
removes audit/rate-limit guards.

The MCP server binary is built from the vendored microsoft/mcp source
(see Dockerfile). Validating the binary itself requires a Docker build
which is out of scope for unit tests; the Dockerfile is verified
structurally (correct base images + non-root user + health probe).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
CONFIG_PATH = REPO_ROOT / "apps" / "fiab-mcp-config" / "config" / "loom-mcp.json"
DOCKERFILE_PATH = REPO_ROOT / "apps" / "fiab-mcp-config" / "Dockerfile"


@pytest.fixture(scope="module")
def cfg() -> dict:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def dockerfile_text() -> str:
    return DOCKERFILE_PATH.read_text(encoding="utf-8")


# ----- loom-mcp.json structure -----------------------------------------


def test_config_has_required_top_level_keys(cfg):
    for key in ("server", "auth", "cloud", "tools", "elevation", "audit", "rateLimit", "transport"):
        assert key in cfg, f"missing top-level key: {key}"


def test_auth_is_managed_identity(cfg):
    assert cfg["auth"]["mode"] == "managed-identity"
    # Must read identity from env (not bake into config)
    assert cfg["auth"]["identityClientIdEnv"] == "AZURE_CLIENT_ID"


def test_cloud_resolves_at_startup(cfg):
    # Boundary-aware: AzureCloud vs AzureUSGovernment is set per deploy
    assert cfg["cloud"]["resolveAtStartup"] is True


# ----- Tool allowlist (security boundary) ------------------------------


def test_tool_allowlist_contains_required_setup_wizard_tools(cfg):
    """Setup Wizard needs deployment + role + sub tools."""
    required = {
        "azure.resources.deployment.create",
        "azure.resources.deployment.whatIf",
        "azure.resources.deployment.show",
        "azure.resourcegroup.create",
        "azure.subscription.list",
        "azure.role.assignment.create",
    }
    allowed = set(cfg["tools"]["allow"])
    missing = required - allowed
    assert not missing, f"setup-wizard tools missing from allowlist: {missing}"


def test_tool_allowlist_contains_required_copilot_tools(cfg):
    """Copilot needs read-only inventory + data-plane tools."""
    required = {
        "azure.keyvault.secret.get",
        "azure.storage.account.list",
        "azure.cosmos.account.list",
        "azure.databricks.workspace.list",
        "azure.powerbi.workspace.list",
        "azure.adx.cluster.list",
    }
    allowed = set(cfg["tools"]["allow"])
    missing = required - allowed
    assert not missing, f"copilot tools missing from allowlist: {missing}"


def test_tool_denylist_blocks_destructive_ops(cfg):
    """Wildcard deny prevents accidental data loss."""
    deny = set(cfg["tools"]["deny"])
    assert "*.delete" in deny, "wildcard delete must be denied"
    assert "*.purge" in deny, "wildcard purge must be denied"


def test_tool_denylist_blocks_keyvault_write(cfg):
    """Per no-vaporware: MCP must not be able to set/delete KV secrets."""
    deny = set(cfg["tools"]["deny"])
    assert "azure.keyvault.secret.set" in deny
    assert "azure.keyvault.key.delete" in deny


def test_only_documented_exceptions_override_deny_wildcards(cfg):
    """Allowlist may override deny wildcards only for documented JIT-cleanup ops.

    `azure.role.assignment.delete` is allowed because the Setup Wizard must
    revoke the JIT Contributor role binding after a deploy succeeds. Every
    other allowlist tool MUST NOT collide with a deny entry.
    """
    DOCUMENTED_OVERRIDES = {"azure.role.assignment.delete"}
    deny = set(cfg["tools"]["deny"])
    for tool in cfg["tools"]["allow"]:
        if tool in DOCUMENTED_OVERRIDES:
            continue
        for blocked in deny:
            if blocked.startswith("*"):
                suffix = blocked[1:]  # ".delete", ".purge"
                assert not tool.endswith(suffix), (
                    f"tool {tool} matches deny wildcard {blocked} "
                    f"(if intentional, add to DOCUMENTED_OVERRIDES in this test)"
                )
            else:
                assert tool != blocked, f"tool {tool} explicitly denied"


# ----- Elevation (PIM-for-Groups) --------------------------------------


def test_elevation_uses_pim_for_groups(cfg):
    el = cfg["elevation"]
    assert el["mode"] == "pim-for-groups"
    assert el["groupObjectIdEnv"] == "PIM_CONTRIBUTOR_GROUP_ID"
    # Ticket duration is bounded — no permanent elevation
    assert isinstance(el["ticketDurationMinutes"], int)
    assert 0 < el["ticketDurationMinutes"] <= 480, "JIT elevation > 8h is excessive"


def test_elevation_has_justification(cfg):
    # PIM tickets require auditable justification
    j = cfg["elevation"]["ticketJustification"]
    assert isinstance(j, str) and len(j) > 10


# ----- Audit (App Insights) --------------------------------------------


def test_audit_writes_to_app_insights(cfg):
    a = cfg["audit"]
    assert a["destination"] == "application-insights"
    assert a["connectionStringEnv"] == "APPLICATIONINSIGHTS_CONNECTION_STRING"
    assert a["includeCaller"] is True
    # Must NOT log request/response bodies (PII risk)
    assert a["includeRequestBody"] is False
    assert a["includeResponseBody"] is False


# ----- Rate limiting (DoS guard) ---------------------------------------


def test_rate_limit_caps_per_caller(cfg):
    rl = cfg["rateLimit"]
    assert rl["callsPerCallerPerMinute"] > 0
    assert rl["callsTotalPerMinute"] >= rl["callsPerCallerPerMinute"]


# ----- Transport -------------------------------------------------------


def test_transport_uses_ingress_terminated_tls(cfg):
    t = cfg["transport"]
    assert t["type"] == "http"
    # TLS is terminated upstream; pod listens HTTP.
    assert t["tls"]["mode"] == "ingress-terminated"


# ----- Dockerfile structure --------------------------------------------


def test_dockerfile_uses_official_dotnet_base_images(dockerfile_text):
    assert "FROM mcr.microsoft.com/dotnet/sdk:" in dockerfile_text
    assert "FROM mcr.microsoft.com/dotnet/aspnet:" in dockerfile_text


def test_dockerfile_clones_microsoft_mcp_repo(dockerfile_text):
    assert "https://github.com/microsoft/mcp.git" in dockerfile_text


def test_dockerfile_pins_ref_via_build_arg(dockerfile_text):
    # MS_MCP_REF ARG lets ops pin upstream MCP version explicitly
    assert "ARG MS_MCP_REF=" in dockerfile_text


def test_dockerfile_runs_as_non_root(dockerfile_text):
    # Critical security control
    assert "USER loom" in dockerfile_text


def test_dockerfile_has_healthcheck(dockerfile_text):
    assert "HEALTHCHECK" in dockerfile_text
    assert ".well-known/health" in dockerfile_text


def test_dockerfile_mounts_config_via_env_var(dockerfile_text):
    assert "ENV LOOM_MCP_CONFIG=" in dockerfile_text
    assert "/app/config/loom-mcp.json" in dockerfile_text
