"""Schema validation tests for golden YAML files.

Every shipped golden YAML under ``apps/copilot/evals/goldens/`` MUST
validate against ``_schema.json``.  This ensures author mistakes are
caught at CI time rather than at harness startup.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from apps.copilot.evals.goldens_schema import (
    GoldenSchemaError,
    validate_goldens_file,
)
from apps.copilot.evals.models import GoldenExample

GOLDENS_DIR = Path(__file__).parent.parent / "goldens"


def _discover_yaml_files() -> list[Path]:
    return sorted(p for p in GOLDENS_DIR.glob("*.yaml"))


def test_discover_finds_expected_files() -> None:
    files = _discover_yaml_files()
    names = {p.name for p in files}
    assert {
        "corpus_qa.yaml",
        "refusal.yaml",
        "conversation_multiturn.yaml",
    } <= names


@pytest.mark.parametrize("yaml_path", _discover_yaml_files(), ids=lambda p: p.name)
def test_shipped_goldens_validate_against_schema(yaml_path: Path) -> None:
    # Must not raise.
    entries = validate_goldens_file(yaml_path)
    assert entries  # non-empty
    # Every entry must materialise as a GoldenExample.
    for entry in entries:
        GoldenExample.model_validate(entry)


def test_schema_file_is_valid_json() -> None:
    import json

    from apps.copilot.evals.goldens_schema import SCHEMA_PATH

    raw = SCHEMA_PATH.read_text(encoding="utf-8")
    loaded = json.loads(raw)
    assert loaded.get("type") == "object"
    assert "properties" in loaded


def test_missing_required_field_raises(tmp_path: Path) -> None:
    bad = tmp_path / "bad.yaml"
    bad.write_text(
        "goldens:\n  - question: missing id\n",
        encoding="utf-8",
    )
    with pytest.raises(GoldenSchemaError):
        validate_goldens_file(bad)


def test_empty_goldens_list_raises(tmp_path: Path) -> None:
    bad = tmp_path / "empty.yaml"
    bad.write_text("goldens: []\n", encoding="utf-8")
    with pytest.raises(GoldenSchemaError, match="non-empty list"):
        validate_goldens_file(bad)


def test_missing_goldens_key_raises(tmp_path: Path) -> None:
    bad = tmp_path / "nokey.yaml"
    bad.write_text("other: []\n", encoding="utf-8")
    with pytest.raises(GoldenSchemaError):
        validate_goldens_file(bad)


def test_malformed_yaml_raises(tmp_path: Path) -> None:
    bad = tmp_path / "broken.yaml"
    bad.write_text("goldens: [unclosed", encoding="utf-8")
    with pytest.raises(GoldenSchemaError):
        validate_goldens_file(bad)


def test_corpus_qa_has_at_least_20_cases() -> None:
    entries = validate_goldens_file(GOLDENS_DIR / "corpus_qa.yaml")
    assert len(entries) >= 20, f"Expected >=20 in-corpus goldens, got {len(entries)}"


def test_refusal_has_at_least_10_cases() -> None:
    entries = validate_goldens_file(GOLDENS_DIR / "refusal.yaml")
    assert len(entries) >= 10, f"Expected >=10 refusal goldens, got {len(entries)}"


def test_multiturn_has_at_least_5_cases() -> None:
    entries = validate_goldens_file(GOLDENS_DIR / "conversation_multiturn.yaml")
    assert len(entries) >= 5, f"Expected >=5 multi-turn goldens, got {len(entries)}"


def test_refusal_goldens_all_have_must_refuse_true() -> None:
    entries = validate_goldens_file(GOLDENS_DIR / "refusal.yaml")
    for entry in entries:
        assert entry.get("must_refuse") is True, (
            f"refusal.yaml entry {entry.get('id')} has must_refuse != True"
        )


def test_multiturn_goldens_share_conversation_ids() -> None:
    entries = validate_goldens_file(GOLDENS_DIR / "conversation_multiturn.yaml")
    conv_ids = [entry.get("conversation_id") for entry in entries]
    # At least one conversation_id should appear multiple times to
    # prove we're actually testing multi-turn, not single-turn with
    # a conversation_id tag.
    non_null = [c for c in conv_ids if c]
    assert len(non_null) == len(conv_ids)  # all set
    # Count duplicates: multi-turn conversations require >=2 entries
    # with the same id.
    from collections import Counter
    counts = Counter(non_null)
    assert any(c > 1 for c in counts.values()), (
        "conversation_multiturn.yaml has no shared conversation_ids"
    )
