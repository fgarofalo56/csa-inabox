"""Unit tests for :mod:`csa_platform.streaming.cli`."""

from __future__ import annotations

from pathlib import Path

import pytest

from csa_platform.streaming.cli import main

FIXTURES = Path(__file__).parent / "fixtures"


def test_validate_happy_path(capsys: pytest.CaptureFixture[str]) -> None:
    exit_code = main(["validate", str(FIXTURES / "example_contract.yaml")])
    out = capsys.readouterr().out
    assert exit_code == 0
    assert out.startswith("ok:")
    assert "1 source(s)" in out
    assert "1 bronze" in out
    assert "1 silver" in out
    assert "1 gold" in out


def test_validate_missing_file(
    tmp_path: Path, capsys: pytest.CaptureFixture[str],
) -> None:
    missing = tmp_path / "does_not_exist.yaml"
    exit_code = main(["validate", str(missing)])
    err = capsys.readouterr().err
    assert exit_code == 2
    assert "file not found" in err


def test_validate_invalid_yaml(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    bad = tmp_path / "bad.yaml"
    bad.write_text("::: not valid yaml ::: \n- [")
    exit_code = main(["validate", str(bad)])
    err = capsys.readouterr().err
    assert exit_code == 1
    assert "invalid YAML" in err


def test_validate_rejects_non_mapping_root(
    tmp_path: Path, capsys: pytest.CaptureFixture[str],
) -> None:
    bad = tmp_path / "list.yaml"
    bad.write_text("- 1\n- 2\n")
    exit_code = main(["validate", str(bad)])
    err = capsys.readouterr().err
    assert exit_code == 1
    assert "YAML mapping" in err


def test_validate_pydantic_error(
    tmp_path: Path, capsys: pytest.CaptureFixture[str],
) -> None:
    bad = tmp_path / "c.yaml"
    bad.write_text(
        "sources:\n"
        "  - name: BAD\n"  # uppercase not allowed
        "    source_type: event_hub\n"
        "    connection:\n"
        "      namespace: n\n"
        "      entity: e\n"
        "    partition_key_path: '$.x'\n"
        "    schema_ref: s\n"
        "    watermark_field: t\n",
    )
    exit_code = main(["validate", str(bad)])
    err = capsys.readouterr().err
    assert exit_code == 1
    assert "error:" in err
