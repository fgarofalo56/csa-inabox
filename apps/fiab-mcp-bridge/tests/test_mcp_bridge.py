"""Deterministic tests for the MCP stdio→HTTP/SSE bridge (audit-t47).

These tests assert the loom-mcp-bridge.json catalog contract + Dockerfile
structure. They fail loudly the moment someone:
  - allows a launcher other than npx/uvx,
  - adds a free-form command field (no-freeform-config violation),
  - drops the envAllowlist secret boundary,
  - exposes a *.azure.com server in the Gov catalog without a boundary tag,
  - or weakens the non-root / health-probe Docker hardening.

Running the bridge end-to-end requires a Docker build + live npx/uvx, which
is out of scope for unit tests; the Dockerfile + server are verified
structurally here.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
APP_DIR = REPO_ROOT / "apps" / "fiab-mcp-bridge"
CONFIG_PATH = APP_DIR / "config" / "loom-mcp-bridge.json"
DOCKERFILE_PATH = APP_DIR / "Dockerfile"
SERVER_PATH = APP_DIR / "src" / "server.mjs"
CLIENT_PATH = APP_DIR / "src" / "stdio-client.mjs"

ALLOWED_LAUNCHERS = {"npx", "uvx"}


@pytest.fixture(scope="module")
def cfg() -> dict:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def dockerfile_text() -> str:
    return DOCKERFILE_PATH.read_text(encoding="utf-8")


# ----- catalog structure ----------------------------------------------------


def test_config_has_required_top_level_keys(cfg):
    for key in ("bridge", "transport", "servers"):
        assert key in cfg, f"missing top-level key: {key}"


def test_transport_is_ingress_terminated_http(cfg):
    t = cfg["transport"]
    assert t["type"] == "http"
    assert t["port"] == 8080
    assert t["tls"]["mode"] == "ingress-terminated"


def test_servers_is_non_empty_list(cfg):
    assert isinstance(cfg["servers"], list) and len(cfg["servers"]) > 0


def test_every_entry_has_required_fields(cfg):
    required = {"id", "displayName", "transport", "launcher", "package", "envAllowlist", "boundaries", "enabled"}
    for e in cfg["servers"]:
        missing = required - set(e.keys())
        assert not missing, f"entry {e.get('id')!r} missing fields: {missing}"


def test_entry_ids_are_unique_and_url_safe(cfg):
    ids = [e["id"] for e in cfg["servers"]]
    assert len(ids) == len(set(ids)), "duplicate entry ids"
    for i in ids:
        assert all(c.isalnum() or c in "-_" for c in i), f"id {i!r} is not URL-path-safe"


# ----- launcher / no-freeform-config boundary -------------------------------


def test_only_npx_or_uvx_launchers(cfg):
    for e in cfg["servers"]:
        assert e["launcher"] in ALLOWED_LAUNCHERS, (
            f"entry {e['id']!r} uses launcher {e['launcher']!r}; only npx/uvx allowed"
        )


def test_no_freeform_command_field(cfg):
    """No-freeform-config: bridged servers are package+args, never a raw shell command."""
    for e in cfg["servers"]:
        for banned in ("command", "cmd", "shell", "exec"):
            assert banned not in e, (
                f"entry {e['id']!r} has free-form '{banned}' field — use launcher+package+args"
            )


def test_transport_is_stdio_for_every_entry(cfg):
    for e in cfg["servers"]:
        assert e["transport"] == "stdio", f"entry {e['id']!r} must be a stdio server"


def test_env_allowlist_is_a_list(cfg):
    for e in cfg["servers"]:
        assert isinstance(e["envAllowlist"], list), f"entry {e['id']!r} envAllowlist must be a list"


# ----- boundary awareness (per-cloud) ---------------------------------------


def test_boundaries_reference_known_clouds(cfg):
    known = {"AzureCloud", "AzureUSGovernment"}
    for e in cfg["servers"]:
        assert e["boundaries"], f"entry {e['id']!r} must declare at least one boundary"
        unknown = set(e["boundaries"]) - known
        assert not unknown, f"entry {e['id']!r} references unknown boundaries: {unknown}"


def test_outbound_fetch_server_excluded_from_gov(cfg):
    """A server that reaches arbitrary public URLs must NOT be enabled in Gov."""
    for e in cfg["servers"]:
        if e["id"] == "fetch":
            assert "AzureUSGovernment" not in e["boundaries"], (
                "the web-fetch server reaches *.azure.com / arbitrary URLs and must be "
                "excluded from the Gov boundary"
            )


# ----- Dockerfile structure -------------------------------------------------


def test_dockerfile_uses_node_base(dockerfile_text):
    assert "FROM node:20-slim" in dockerfile_text


def test_dockerfile_installs_uv_for_uvx(dockerfile_text):
    # uvx (Python stdio servers) must be available alongside npx.
    assert "astral.sh/uv" in dockerfile_text
    assert "ARG UV_VERSION=" in dockerfile_text


def test_dockerfile_pins_uv_version(dockerfile_text):
    assert "ARG UV_VERSION=" in dockerfile_text


def test_dockerfile_runs_as_non_root(dockerfile_text):
    assert "USER loom" in dockerfile_text


def test_dockerfile_has_healthcheck(dockerfile_text):
    assert "HEALTHCHECK" in dockerfile_text
    assert "/.well-known/health" in dockerfile_text


def test_dockerfile_exposes_8080(dockerfile_text):
    assert "EXPOSE 8080" in dockerfile_text


def test_dockerfile_mounts_config_via_env_var(dockerfile_text):
    assert "ENV LOOM_MCP_BRIDGE_CONFIG=" in dockerfile_text or "LOOM_MCP_BRIDGE_CONFIG=/app/config/loom-mcp-bridge.json" in dockerfile_text


# ----- server contract (the endpoints the Console hits) ---------------------


def test_server_serves_console_compat_paths():
    text = SERVER_PATH.read_text(encoding="utf-8")
    assert "tools/list" in text
    assert "tools/call" in text
    assert "/.well-known/health" in text


def test_server_serves_standard_sse_transport():
    text = SERVER_PATH.read_text(encoding="utf-8")
    assert "text/event-stream" in text
    assert "event: endpoint" in text


def test_client_forwards_only_allowlisted_env():
    text = CLIENT_PATH.read_text(encoding="utf-8")
    # The child env builder must key off entry.envAllowlist.
    assert "envAllowlist" in text


def test_client_uses_newline_delimited_jsonrpc():
    text = CLIENT_PATH.read_text(encoding="utf-8")
    # MCP stdio framing is newline-delimited JSON.
    assert "indexOf('\\n')" in text or 'indexOf("\\n")' in text
