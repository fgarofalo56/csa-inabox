"""Smoke tests for the ``python -m apps.copilot.cli skills ...`` surface.

These tests drive the CLI through :func:`apps.copilot.cli.main` directly
(no subprocess) and capture stdout/stderr to assert the user-visible
contracts.  No Azure credentials are required — the CLI registry
builder uses stub retriever/embedder implementations.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from apps.copilot.cli import main as cli_main


def test_cli_skills_list(capsys: pytest.CaptureFixture[str]) -> None:
    """``skills list`` must print at least the six seeded skills."""
    exit_code = cli_main(["skills", "list"])
    captured = capsys.readouterr()
    assert exit_code == 0
    assert "compare-fabric-vs-databricks" in captured.out
    assert "grounded-corpus-qa" in captured.out
    assert "list-adrs" in captured.out


def test_cli_skills_list_json(capsys: pytest.CaptureFixture[str]) -> None:
    """``skills list --json`` must emit parseable JSON."""
    exit_code = cli_main(["skills", "list", "--json"])
    captured = capsys.readouterr()
    assert exit_code == 0
    data = _find_skill_list_in_output(captured.out)
    assert len(data) >= 6
    ids = {entry["id"] for entry in data}
    assert "grounded-corpus-qa" in ids


def _find_skill_list_in_output(output: str) -> list[dict[str, Any]]:
    """Extract the skill list JSON (an array of dicts) from stdout."""
    decoder = json.JSONDecoder()
    idx = 0
    length = len(output)
    while idx < length:
        if output[idx] != "[":
            idx += 1
            continue
        try:
            obj, end = decoder.raw_decode(output, idx)
        except json.JSONDecodeError:
            idx += 1
            continue
        if isinstance(obj, list) and obj and isinstance(obj[0], dict) and "id" in obj[0]:
            return obj
        idx = end
    raise AssertionError(f"No skill list JSON found in CLI output:\n{output}")


def test_cli_skills_show(capsys: pytest.CaptureFixture[str]) -> None:
    """``skills show <id>`` renders the full spec."""
    exit_code = cli_main(["skills", "show", "grounded-corpus-qa"])
    captured = capsys.readouterr()
    assert exit_code == 0
    assert "id:" in captured.out
    assert "grounded-corpus-qa" in captured.out
    assert "fallback_if_tool_missing" in captured.out


def test_cli_skills_show_missing(capsys: pytest.CaptureFixture[str]) -> None:
    """Missing skill ids exit non-zero with an ERROR message."""
    exit_code = cli_main(["skills", "show", "does-not-exist"])
    captured = capsys.readouterr()
    assert exit_code == 1
    assert "ERROR" in captured.err


def test_cli_skills_run_grounded_corpus_qa(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """End-to-end run against a stubbed registry — the acceptance criterion.

    The CLI uses a null retriever + null embedder so the run does not
    require Azure credentials.  structlog writes structured JSON log
    lines to stdout alongside the CLI's own output — we therefore
    parse the *last* JSON object that carries ``skill_id`` as the
    SkillResult payload.
    """
    exit_code = cli_main(
        [
            "skills",
            "run",
            "grounded-corpus-qa",
            "--input-json",
            '{"question":"why bicep"}',
            "--json",
        ],
    )
    captured = capsys.readouterr()
    assert exit_code == 0
    data = _find_skill_result_in_output(captured.out)
    assert data["skill_id"] == "grounded-corpus-qa"
    assert data["success"] is True
    assert len(data["steps"]) == 1
    assert data["steps"][0]["status"] == "completed"


def _find_skill_result_in_output(output: str) -> dict[str, Any]:
    """Extract the SkillResult JSON from stdout.

    The CLI emits exactly one pretty-printed JSON object alongside
    structlog's single-line JSON events.  We use :class:`json.JSONDecoder`
    with ``raw_decode`` to scan for balanced JSON objects and return
    the one carrying ``skill_id`` + ``steps``.
    """
    decoder = json.JSONDecoder()
    found: list[dict[str, Any]] = []
    idx = 0
    length = len(output)
    while idx < length:
        # Advance to the next '{' — anything else is whitespace or newlines.
        if output[idx] != "{":
            idx += 1
            continue
        try:
            obj, end = decoder.raw_decode(output, idx)
        except json.JSONDecodeError:
            idx += 1
            continue
        if isinstance(obj, dict) and "skill_id" in obj and "steps" in obj:
            found.append(obj)
        idx = end
    if not found:
        raise AssertionError(f"No SkillResult payload found in CLI output:\n{output}")
    return found[-1]


def test_cli_skills_run_rejects_bad_json(capsys: pytest.CaptureFixture[str]) -> None:
    """Malformed --input-json fails fast with a clear message."""
    exit_code = cli_main(
        [
            "skills",
            "run",
            "grounded-corpus-qa",
            "--input-json",
            "{not-json}",
        ],
    )
    captured = capsys.readouterr()
    assert exit_code == 1
    assert "ERROR" in captured.err


def test_cli_skills_run_rejects_missing_required(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A missing required input raises SkillInputError → exit 1."""
    exit_code = cli_main(
        [
            "skills",
            "run",
            "grounded-corpus-qa",
            "--input-json",
            "{}",
        ],
    )
    captured = capsys.readouterr()
    assert exit_code == 1
    assert "ERROR" in captured.err
