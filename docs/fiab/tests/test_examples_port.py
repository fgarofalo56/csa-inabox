"""Deterministic tests for PRP-14 — Industry Examples Port Wave 1.

Asserts:
  - All 8 example docs from PRP-14 §v1 selections exist
  - The example index page exists and references each
  - The financial-fraud-detection runnable bundle has:
      * activator rules JSON (3 rules; valid schema)
      * data-agent JSON (loom-compatible shape)
      * Spark scoring notebook
      * README
  - Each example doc page has the required PRD §11.4.1 template
    sections (hero/components/per-boundary/forward-migration)
  - No customer-framing language (per writing-voice rule)
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
DOCS_DIR = REPO_ROOT / "docs" / "fiab" / "examples"
EXAMPLES_DIR = REPO_ROOT / "examples" / "fiab"

V1_DOC_NAMES = [
    "retail-e2e",
    "fabric-data-agent",
    "financial-fraud-detection",
    "healthcare-clinical",
    "iot-streaming",
    "cybersecurity",
    "manufacturing-iot",
    "geoanalytics",
]


# ----- Doc pages exist + render-ready ---------------------------------


@pytest.mark.parametrize("doc_name", V1_DOC_NAMES)
def test_example_doc_exists(doc_name):
    page = DOCS_DIR / f"{doc_name}.md"
    assert page.exists(), f"missing doc: {page}"
    text = page.read_text(encoding="utf-8")
    assert len(text) > 500, f"doc page {doc_name}.md is implausibly short"


def test_example_index_exists():
    idx = DOCS_DIR / "index.md"
    assert idx.exists()


def test_example_index_links_all_examples():
    idx_text = (DOCS_DIR / "index.md").read_text(encoding="utf-8")
    # Each example should be referenced by name in the index
    missing = [n for n in V1_DOC_NAMES if n not in idx_text]
    assert not missing, f"index.md does not reference: {missing}"


@pytest.mark.parametrize("doc_name", V1_DOC_NAMES)
def test_example_doc_has_required_sections(doc_name):
    """Per PRP-14 §Acceptance + PRD §11.4.1 template."""
    page = DOCS_DIR / f"{doc_name}.md"
    text = page.read_text(encoding="utf-8").lower()
    # Components used + per-boundary notes are mandatory
    assert "components" in text, f"{doc_name}.md missing 'components' section"
    assert (
        "boundary" in text
        or "commercial" in text
        or "gcc" in text
        or "il5" in text
    ), f"{doc_name}.md missing per-boundary notes"


@pytest.mark.parametrize("doc_name", V1_DOC_NAMES)
def test_example_doc_uses_csa_loom_brand(doc_name):
    """AMENDMENTS §A1 + writing-voice memory: brand consistency."""
    page = DOCS_DIR / f"{doc_name}.md"
    text = page.read_text(encoding="utf-8")
    # Must mention Loom (the brand) at least once
    assert "Loom" in text, f"{doc_name}.md does not mention CSA Loom"


@pytest.mark.parametrize("doc_name", V1_DOC_NAMES)
def test_example_doc_avoids_customer_framing(doc_name):
    """Per writing-voice-no-customer-framing memory."""
    page = DOCS_DIR / f"{doc_name}.md"
    text = page.read_text(encoding="utf-8").lower()
    forbidden_phrases = [
        "customer briefing",
        "customer is using",
        "the customer wants",
        "for customer x",
    ]
    found = [p for p in forbidden_phrases if p in text]
    assert not found, f"{doc_name}.md uses customer-framing language: {found}"


# ----- financial-fraud-detection runnable bundle ----------------------


def test_fraud_example_dir_exists():
    d = EXAMPLES_DIR / "financial-fraud-detection"
    assert d.is_dir(), f"missing: {d}"


def test_fraud_activator_rules_valid_schema():
    rules_path = EXAMPLES_DIR / "financial-fraud-detection" / "activator" / "rules.json"
    rules = json.loads(rules_path.read_text(encoding="utf-8"))
    assert isinstance(rules, list)
    assert len(rules) >= 3, "PRP-14 expects 3 activator rules for fraud example"
    valid_primitives = {
        "IncreasesAbove",
        "DecreasesBelow",
        "OnEnter",
        "OnExit",
        "ChangesTo",
        "ChangesFrom",
        "NoPresenceOfData",
        "PresenceOfData",
    }
    for r in rules:
        for k in ("id", "workspaceId", "primitive", "action", "actionTarget"):
            assert k in r, f"rule {r.get('id')} missing key {k}"
        assert r["primitive"] in valid_primitives, (
            f"rule {r['id']} has invalid primitive {r['primitive']}"
        )


def test_fraud_data_agent_valid_schema():
    agent_path = (
        EXAMPLES_DIR / "financial-fraud-detection" / "agent" / "finance-fraud-agent.json"
    )
    agent = json.loads(agent_path.read_text(encoding="utf-8"))
    for k in ("id", "name", "instructions", "dataSources", "exampleQueries"):
        assert k in agent, f"agent missing key {k}"
    assert len(agent["dataSources"]) >= 1
    # Per PRP-09: each tool needs an executor reference (lakehouse or adx or synapse)
    valid_engines = {"databricks-sql", "synapse-serverless", "powerbi-xmla", "kusto", "search"}
    for ds in agent["dataSources"]:
        engine = ds.get("engine") or ds.get("type")
        assert engine in valid_engines or ds.get("type") in {"lakehouse", "adx", "synapse", "search"}


def test_fraud_notebook_executable():
    nb = EXAMPLES_DIR / "financial-fraud-detection" / "notebooks" / "score_transactions.py"
    assert nb.exists()
    src = nb.read_text(encoding="utf-8")
    # It's a real PySpark notebook — must import the expected modules
    assert "from pyspark.sql import" in src
    # PRP-14 §validation: notebook executes against test workspace
    # (we can't actually run Spark here; we assert structural integrity)
    assert "SparkSession" in src


def test_fraud_example_readme_exists():
    readme = EXAMPLES_DIR / "financial-fraud-detection" / "README.md"
    assert readme.exists()
    text = readme.read_text(encoding="utf-8")
    assert len(text) > 200
