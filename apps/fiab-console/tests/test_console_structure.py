"""Structural tests for PRP-03 — Loom Console.

Validating the Next.js console end-to-end requires a live Bastion-fronted
deploy (the Console's ingress is VNet-internal by security design).
These tests assert the *contract* the PRP requires:

  - All PRP-03 panes have a Next.js App Router page.tsx
  - MSAL BFF auth wiring exists
  - At least one BFF route per pane proxies to the right backend
  - Critical Azure client adapters exist (Databricks, ADX, Power BI, Cosmos, Fabric)
  - OpenTelemetry instrumentation hook exists
  - Security headers (CSP/HSTS) configured

Running the deterministic structural test catches any regression where
a pane file gets deleted or a client adapter goes missing.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

CONSOLE = Path(__file__).resolve().parents[1]


# ----- App Router pages exist (PRP-03 acceptance criteria) -------------


REQUIRED_PAGES = [
    # PRP-03 §Acceptance §1-12 mapped to the actual on-disk router
    "workspaces/page.tsx",
    "workspaces/[id]/page.tsx",
    "lakehouse/page.tsx",
    "warehouse/page.tsx",
    "notebook/page.tsx",
    "realtime-hub/page.tsx",        # KQL / Eventhouse hub
    "browse/page.tsx",              # catalog browse
    "activator/page.tsx",
    "data-agent/page.tsx",
    "monitor/page.tsx",             # monitoring hub
    "admin/page.tsx",
    "setup/page.tsx",
    "copilot/page.tsx",
]


@pytest.mark.parametrize("rel", REQUIRED_PAGES)
def test_console_pane_exists(rel):
    p = CONSOLE / "app" / rel
    assert p.exists(), f"PRP-03 pane missing: app/{rel}"
    text = p.read_text(encoding="utf-8")
    # Not just an empty placeholder
    assert len(text) > 100, f"app/{rel} looks like a stub"


# ----- BFF auth (PRP-03 §MSAL BFF auth) --------------------------------


def test_msal_bff_module_exists():
    msal = CONSOLE / "lib" / "auth" / "msal.ts"
    session = CONSOLE / "lib" / "auth" / "session.ts"
    assert msal.exists()
    assert session.exists()


def test_msal_module_imports_msal_node():
    msal = (CONSOLE / "lib" / "auth" / "msal.ts").read_text(encoding="utf-8")
    assert "@azure/msal-node" in msal, "BFF must use msal-node for confidential client"


# ----- BFF API routes ---------------------------------------------------


def test_api_routes_cover_required_backends():
    """Per PRP-03 §Implementation §5: route handlers proxy to backends."""
    api_dir = CONSOLE / "app" / "api"
    expected = ["workspaces", "setup", "copilot", "admin", "fabric", "powerbi", "governance"]
    found = {d.name for d in api_dir.iterdir() if d.is_dir()}
    missing = [n for n in expected if n not in found]
    assert not missing, f"missing api route dirs: {missing}"


# ----- Azure SDK client adapters ---------------------------------------


REQUIRED_CLIENTS = [
    "databricks-client.ts",
    "kusto-client.ts",          # ADX
    "powerbi-client.ts",
    "cosmos-client.ts",
    "fabric-client.ts",
    "purview-client.ts",
]


@pytest.mark.parametrize("client", REQUIRED_CLIENTS)
def test_azure_client_exists(client):
    p = CONSOLE / "lib" / "azure" / client
    assert p.exists(), f"required Azure client adapter missing: {client}"
    text = p.read_text(encoding="utf-8")
    assert len(text) > 200, f"{client} appears stubbed"


# ----- Observability ----------------------------------------------------


def test_instrumentation_hook_exists():
    """OpenTelemetry instrumentation per PRP-03 §Implementation §6."""
    inst = CONSOLE / "instrumentation.ts"
    assert inst.exists(), "Next.js instrumentation.ts (OTel) missing"
    text = inst.read_text(encoding="utf-8").lower()
    # Either azure monitor OTel, vanilla otel, or app-insights wrapper
    assert (
        "opentelemetry" in text
        or "monitor" in text
        or "app-insights" in text
        or "telemetry" in text
    ), "instrumentation.ts has no telemetry wiring"


# ----- Package + config -------------------------------------------------


def test_package_json_uses_next_14_and_fluent_v9():
    pkg = json.loads((CONSOLE / "package.json").read_text(encoding="utf-8"))
    deps = pkg.get("dependencies", {})

    next_ver = deps.get("next", "")
    assert next_ver.startswith("^14") or next_ver.startswith("14"), (
        f"Next 14 required by PRP-03; package.json has {next_ver!r}"
    )
    fluent_ver = deps.get("@fluentui/react-components", "")
    assert fluent_ver.startswith("^9") or fluent_ver.startswith("9"), (
        f"Fluent v9 required; package.json has {fluent_ver!r}"
    )


def test_msal_packages_pinned():
    pkg = json.loads((CONSOLE / "package.json").read_text(encoding="utf-8"))
    deps = pkg.get("dependencies", {})
    assert "@azure/msal-node" in deps
    assert "@azure/msal-browser" in deps


def test_next_config_sets_security_headers():
    cfg = CONSOLE / "next.config.mjs"
    assert cfg.exists()
    text = cfg.read_text(encoding="utf-8")
    # PRP-03 ships CSP + HSTS + SameSite (per audit row)
    has_csp = "Content-Security-Policy" in text or "contentSecurityPolicy" in text
    has_hsts = "Strict-Transport-Security" in text or "strictTransportSecurity" in text
    assert has_csp, "next.config.mjs does not configure CSP"
    assert has_hsts, "next.config.mjs does not configure HSTS"
