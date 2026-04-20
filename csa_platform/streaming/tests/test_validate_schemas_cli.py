"""Unit tests for the ``validate-schemas`` CLI subcommand (CSA-0137 Gap 1)."""

from __future__ import annotations

from pathlib import Path

import pytest

from csa_platform.streaming import cli as cli_mod
from csa_platform.streaming.cli import main

FIXTURES = Path(__file__).parent / "fixtures"


def test_validate_schemas_happy_path_noop(
    capsys: pytest.CaptureFixture[str],
) -> None:
    exit_code = main(
        [
            "validate-schemas",
            str(FIXTURES / "example_contract.yaml"),
            "--registry",
            "noop",
        ],
    )
    out = capsys.readouterr().out
    assert exit_code == 0
    assert out.startswith("ok:")
    assert "registry=noop" in out


def test_validate_schemas_default_registry_is_noop(
    capsys: pytest.CaptureFixture[str],
) -> None:
    exit_code = main(
        ["validate-schemas", str(FIXTURES / "example_contract.yaml")],
    )
    out = capsys.readouterr().out
    assert exit_code == 0
    assert "registry=noop" in out


def test_validate_schemas_missing_file(
    tmp_path: Path, capsys: pytest.CaptureFixture[str],
) -> None:
    missing = tmp_path / "nope.yaml"
    exit_code = main(["validate-schemas", str(missing)])
    err = capsys.readouterr().err
    assert exit_code == 2
    assert "file not found" in err


def test_validate_schemas_confluent_requires_url(
    capsys: pytest.CaptureFixture[str],
) -> None:
    exit_code = main(
        [
            "validate-schemas",
            str(FIXTURES / "example_contract.yaml"),
            "--registry",
            "confluent",
        ],
    )
    err = capsys.readouterr().err
    assert exit_code == 2
    assert "confluent" in err.lower()


def test_validate_schemas_azure_requires_url(
    capsys: pytest.CaptureFixture[str],
) -> None:
    exit_code = main(
        [
            "validate-schemas",
            str(FIXTURES / "example_contract.yaml"),
            "--registry",
            "azure",
        ],
    )
    err = capsys.readouterr().err
    assert exit_code == 2
    assert "azure" in err.lower()


def test_validate_schemas_reports_registry_errors(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Build a tiny bundle with a single source.
    contract = tmp_path / "c.yaml"
    contract.write_text(
        "sources:\n"
        "  - name: s\n"
        "    source_type: event_hub\n"
        "    connection:\n"
        "      namespace: n\n"
        "      entity: e\n"
        "    partition_key_path: '$.k'\n"
        "    schema_ref: will-miss\n"
        "    watermark_field: ts\n",
    )

    class _FailingRegistry:
        async def resolve(self, ref: str) -> object:
            from csa_platform.streaming.schema_registry import SchemaNotFoundError

            raise SchemaNotFoundError(f"unknown: {ref}")

        async def validate(self, ref: str, sample: bytes) -> bool:
            _ = sample
            _ = ref
            return False

    def _fake_build_registry(_kind: str, _url: str | None) -> _FailingRegistry:
        return _FailingRegistry()

    monkeypatch.setattr(cli_mod, "_build_registry", _fake_build_registry)

    exit_code = main(
        ["validate-schemas", str(contract), "--registry", "noop"],
    )
    err = capsys.readouterr().err
    assert exit_code == 1
    assert "not found" in err
    assert "will-miss" in err


def test_validate_schemas_pydantic_error_is_rejected(
    tmp_path: Path, capsys: pytest.CaptureFixture[str],
) -> None:
    bad = tmp_path / "bad.yaml"
    bad.write_text(
        "sources:\n"
        "  - name: BAD\n"
        "    source_type: event_hub\n"
        "    connection:\n"
        "      namespace: n\n"
        "      entity: e\n"
        "    partition_key_path: '$.k'\n"
        "    schema_ref: s\n"
        "    watermark_field: t\n",
    )
    exit_code = main(["validate-schemas", str(bad)])
    err = capsys.readouterr().err
    assert exit_code == 1
    assert "error:" in err
