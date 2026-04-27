"""Unit tests for hosted-agent server (no AOAI required).

Loads the module by file path because dir names contain hyphens and aren't
valid Python package identifiers.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_SERVER_PATH = Path(__file__).parent.parent / "hosted-agent" / "server.py"


@pytest.fixture(scope="module")
def server_module():
    spec = importlib.util.spec_from_file_location("csa_hosted_agent_server", _SERVER_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["csa_hosted_agent_server"] = mod
    spec.loader.exec_module(mod)
    return mod


def test_extract_citations_finds_three_layer_refs(server_module):
    text = "Found gold.finance.revenue and Silver.SALES.orders, and bronze.iot.tel."
    out = server_module._extract_citations(text)
    assert "gold.finance.revenue" in out
    assert "silver.sales.orders" in out
    assert "bronze.iot.tel" in out


def test_extract_citations_ignores_non_layered_refs(server_module):
    text = "Look at example.foo.bar or some.random.path"
    assert server_module._extract_citations(text) == []


def test_looks_like_refusal_detects_common_phrases(server_module):
    assert server_module._looks_like_refusal("I cannot help with that.")
    assert server_module._looks_like_refusal("I'm unable to do that — read-only.")
    assert server_module._looks_like_refusal("Policy prevents this action.")
    assert not server_module._looks_like_refusal("Sure, here are the products: gold.x.y")


def test_estimate_cost_known_model(server_module):
    cost = server_module.estimate_cost_usd("gpt-4o-mini", 1000, 500)
    # 1000 * 0.15/1M + 500 * 0.60/1M = 0.00015 + 0.0003 = 0.00045
    assert abs(cost - 0.00045) < 1e-6


def test_estimate_cost_unknown_model_returns_zero(server_module):
    assert server_module.estimate_cost_usd("nonexistent-model-9", 1000, 500) == 0.0


def test_hash_user_deterministic_and_anonymizes(server_module):
    h1 = server_module.hash_user("alice@example.com")
    h2 = server_module.hash_user("alice@example.com")
    assert h1 == h2
    assert "alice" not in h1
    assert "@" not in h1
    assert server_module.hash_user(None) == "anonymous"
    assert server_module.hash_user("") == "anonymous"
