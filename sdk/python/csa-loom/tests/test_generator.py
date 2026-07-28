"""The generator must be deterministic — this is what makes the drift gate real.

If ``scripts/generate_client.py`` produced different bytes on each run, the CI
lane's ``git diff --exit-code`` would be noise and everyone would learn to
ignore it. These tests run the generator's own ``--check`` mode in-process, so a
developer who edits ``_generated/*.py`` by hand, or bumps the API without
regenerating, fails locally before CI.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

SDK_DIR = Path(__file__).resolve().parents[1]
GENERATOR = SDK_DIR / "scripts" / "generate_client.py"


def _load_generator() -> ModuleType:
    spec = importlib.util.spec_from_file_location("csa_loom_generate_client", GENERATOR)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive
        pytest.fail(f"cannot load the generator at {GENERATOR}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_generated_sources_are_up_to_date() -> None:
    """``generate_client.py --check`` must pass against the committed tree."""
    generator = _load_generator()
    assert generator.main(["--check"]) == 0, (
        "the committed client does not match sdk/openapi.json.\n"
        "Fix: python sdk/python/csa-loom/scripts/generate_client.py"
    )


def test_generation_is_deterministic() -> None:
    """Two builds from the same document produce byte-identical output."""
    generator = _load_generator()
    assert generator.build() == generator.build()


def test_generated_files_match_what_build_produces() -> None:
    generator = _load_generator()
    for path, text in generator.build().items():
        assert path.exists(), f"missing generated file {path}"
        assert path.read_text(encoding="utf-8") == text, f"{path.name} was hand-edited or is stale"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("scimServiceProviderConfig", "scim_service_provider_config"),
        ("listWorkspaces", "list_workspaces"),
        ("whoami", "whoami"),
        ("SCIMUser", "scim_user"),
    ],
)
def test_operation_id_snake_casing(raw: str, expected: str) -> None:
    generator = _load_generator()
    assert generator.snake(raw) == expected


@pytest.mark.parametrize(("raw", "expected"), [("type", "type_"), ("id", "id_"), ("workspaceId", "workspace_id")])
def test_shadowing_parameter_names_are_suffixed(raw: str, expected: str) -> None:
    """A parameter called ``type`` would shadow a builtin (ruff A002)."""
    generator = _load_generator()
    assert generator.py_param(raw) == expected
