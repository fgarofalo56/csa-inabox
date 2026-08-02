"""The Python CI lane must measure the stack that actually SHIPS (#2615).

`.github/workflows/test.yml` installs EVERY `requirements.txt` in the repo into
ONE shared environment. Six of them pin ``fastapi==0.115.x``;
``apps/loom-duckdb/requirements.txt`` — the file that describes the container
image — pins ``fastapi==0.140.13``. Those are mutually exclusive (0.115.x
requires ``starlette<0.42``, 0.140.13 requires ``starlette>=0.46``), so whichever
``pip install`` runs LAST silently decides what `tests/loom_duckdb` measures.

`tests/loom_duckdb` passes on BOTH stacks — verified in a clean venv, 99 passed
either way — so the skew produced no signal at all. That is the failure mode
these tests exist to make loud: they model the install ORDER declared in the
workflow and assert the shipped pins are the last word.

What is asserted
----------------
1. ``test_loom_duckdb_pins_are_the_last_word`` — the real guard. RED whenever a
   later install can override a pin from ``apps/loom-duckdb/requirements.txt``.
2. ``test_workflow_asserts_resolved_versions_at_runtime`` — the static model is
   not enough on its own; the workflow must also verify the RESOLVED versions in
   the actual environment.
3. ``test_engine_pins_are_the_last_word`` — CONTROL. duckdb/pyarrow were already
   re-asserted before this fix, so this passes both before and after; if it ever
   goes red at the same time as (1), the model is broken, not the workflow.
4. ``test_the_install_loop_is_not_empty`` — ANTI-VACUITY. If the `find`
   emulation returned nothing, (1) would pass trivially. It must see the
   competing fastapi pins.
"""

from __future__ import annotations

import fnmatch
import re
from dataclasses import dataclass, field
from pathlib import Path

import pytest
import yaml

from tests.conftest import load_script_module

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "test.yml"
SHIPPED_REQUIREMENTS = REPO_ROOT / "apps" / "loom-duckdb" / "requirements.txt"
PIN_ASSERTER = REPO_ROOT / "scripts" / "ci" / "assert_installed_pins.py"

#: Directories that are never part of a fresh `actions/checkout` and so are not
#: visible to the workflow's `find`. Excluded so a local venv / node_modules
#: cannot change what this test sees.
_NOT_IN_A_CHECKOUT = {
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    "__pycache__",
    "node_modules",
    "site-packages",
    "temp",
}

_pins = load_script_module("assert_installed_pins", PIN_ASSERTER)


def parse_pins(text: str) -> dict[str, str]:
    """Typed wrapper around the dynamically loaded asserter's parser."""
    parsed: dict[str, str] = _pins.parse_pins(text)
    return parsed

#: `name`, `name[extra]`, and whatever follows. Only the NAME is needed; the
#: version specifier is validated by its leading character rather than by a
#: nested-quantifier pattern, which CodeQL correctly flagged as exponential
#: backtracking (py/redos) when the inner class overlapped the separator.
_REQ_SPEC = re.compile(
    r"^(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)"
    r"(?:\[[^\]]*\])?"
    r"(?P<rest>.*)$"
)
_SPECIFIER_START = "<>=!~"


@dataclass
class InstallEvent:
    """One `pip install` in the workflow, in the order it executes."""

    label: str
    #: distribution name -> the constraint this event applies to it.
    constraints: dict[str, str] = field(default_factory=dict)


def _strip_comments(script: str) -> list[str]:
    return [
        line.strip()
        for line in script.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def _find_requirements(find_command: str) -> list[Path]:
    """Emulate the workflow's `find . -name requirements.txt -not -path ...`."""
    excludes = re.findall(r"-not\s+-path\s+\"([^\"]+)\"", find_command)
    found: list[Path] = []
    for path in sorted(REPO_ROOT.rglob("requirements.txt")):
        rel = path.relative_to(REPO_ROOT)
        if _NOT_IN_A_CHECKOUT.intersection(rel.parts):
            continue
        as_find_prints_it = "./" + rel.as_posix()
        if any(fnmatch.fnmatch(as_find_prints_it, pattern) for pattern in excludes):
            continue
        found.append(path)
    return found


def _constraints_from_specs(specs: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in specs:
        spec = raw.strip().strip("'\"")
        if not spec or spec.startswith(("-", "$")):
            continue
        match = _REQ_SPEC.match(spec.split(";", 1)[0].strip())
        if match is None:
            continue
        rest = match.group("rest")
        if rest and rest[0] not in _SPECIFIER_START:
            continue
        out[match.group("name")] = spec
    return out


def install_events() -> list[InstallEvent]:
    """Model, in execution order, every `pip install` in the install step.

    Handles the four shapes the workflow uses: an editable install with extras,
    `-r <file>`, the `for req in $(find ...)` loop, and explicit specs — including
    specs held in a shell variable populated by `grep` from a requirements file,
    which is how the pre-#2615 workflow re-asserted its engine pins.
    """
    workflow = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    steps = workflow["jobs"]["python-tests"]["steps"]
    script = next(s["run"] for s in steps if s.get("name") == "Install dependencies")

    events: list[InstallEvent] = []
    grep_vars: dict[str, dict[str, str]] = {}
    loop_files: list[Path] = []

    for line in _strip_comments(script):
        # `NAME=$(grep -E '<pattern>' <path>)` — pins pulled out of a file.
        assignment = re.match(r"^(\w+)=\$\(grep -E '([^']+)' (\S+)\)$", line)
        if assignment:
            var, pattern, target = assignment.groups()
            text = (REPO_ROOT / target).read_text(encoding="utf-8")
            matched = [ln for ln in text.splitlines() if re.search(pattern, ln)]
            grep_vars[var] = parse_pins("\n".join(matched))
            continue

        if line.startswith("for req in $(find "):
            loop_files = _find_requirements(line)
            continue

        # `echo "...pip install -r ${req#./} FAILED..."` is a diagnostic, not an
        # install. Match the command form instead of substring-searching.
        if line.startswith("echo"):
            continue
        command = re.search(r"(?:^|!\s*)(?:python -m )?pip install\s+(.+?)(?:;\s*then)?$", line)
        if command is None:
            continue

        args = command.group(1).strip()

        if args.startswith("-e"):
            # Extras are deliberate FLOORS (ranges), never exact pins; they can
            # never be "the last word" and are not modelled as constraints.
            events.append(InstallEvent(label="pip install -e .[extras]"))
            continue

        if '-r "$req"' in args:
            union: dict[str, str] = {}
            for req in loop_files:
                for name, version in parse_pins(req.read_text(encoding="utf-8")).items():
                    union[name] = f"{name}=={version}"
            events.append(
                InstallEvent(
                    label=f"per-domain requirements loop ({len(loop_files)} files)",
                    constraints=union,
                )
            )
            continue

        file_install = re.match(r"^-r\s+(\S+)", args)
        if file_install:
            target = file_install.group(1)
            pins = parse_pins((REPO_ROOT / target).read_text(encoding="utf-8"))
            events.append(
                InstallEvent(
                    label=f"pip install -r {target}",
                    constraints={n: f"{n}=={v}" for n, v in pins.items()},
                )
            )
            continue

        variable = re.match(r"^\$(\w+)$", args)
        if variable and variable.group(1) in grep_vars:
            pins = grep_vars[variable.group(1)]
            events.append(
                InstallEvent(
                    label=f"pip install ${variable.group(1)}",
                    constraints={n: f"{n}=={v}" for n, v in pins.items()},
                )
            )
            continue

        specs = [tok for tok in args.split() if tok not in {"-U", "--upgrade"}]
        events.append(
            InstallEvent(label=f"pip install {args}", constraints=_constraints_from_specs(specs))
        )

    return events


def _last_constraint(events: list[InstallEvent], name: str) -> tuple[str, str] | None:
    """The label + constraint of the LAST event that touches *name*."""
    for event in reversed(events):
        if name in event.constraints:
            return event.label, event.constraints[name]
    return None


@pytest.fixture(scope="module")
def events() -> list[InstallEvent]:
    return install_events()


@pytest.fixture(scope="module")
def shipped_pins() -> dict[str, str]:
    return parse_pins(SHIPPED_REQUIREMENTS.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# ANTI-VACUITY. If the loop expansion were empty, the guard below would pass
# for the wrong reason — the exact "gate measures nothing" failure this repo
# has hit before. Prove the model can SEE the competing pins.
# ---------------------------------------------------------------------------


def test_the_install_loop_is_not_empty(events: list[InstallEvent]) -> None:
    loop = [e for e in events if e.label.startswith("per-domain requirements loop")]
    assert loop, "the model did not find the per-domain requirements loop at all"
    assert loop[0].constraints, "the loop expanded to zero pins — the `find` emulation is broken"


def test_the_model_sees_the_competing_fastapi_pins(
    events: list[InstallEvent], shipped_pins: dict[str, str]
) -> None:
    """The hazard must be real: other files DO pin a different fastapi."""
    loop = next(e for e in events if e.label.startswith("per-domain requirements loop"))
    assert "fastapi" in loop.constraints, (
        "no requirements.txt in the loop constrains fastapi — either the emulation "
        "is broken or the conflict is gone; re-read #2615 before relaxing anything"
    )
    assert loop.constraints["fastapi"] != f"fastapi=={shipped_pins['fastapi']}", (
        "the loop now pins the same fastapi as the shipped image; if that is a real "
        "convergence, say so explicitly rather than deleting the ordering guard"
    )


# ---------------------------------------------------------------------------
# CONTROL — true before AND after the #2615 fix (duckdb/pyarrow were already
# re-asserted after the loop). If this goes red together with the guard below,
# the model is wrong, not the workflow.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("name", ["duckdb", "pyarrow"])
def test_engine_pins_are_the_last_word(
    events: list[InstallEvent], shipped_pins: dict[str, str], name: str
) -> None:
    last = _last_constraint(events, name)
    assert last is not None, f"nothing in the install step constrains {name}"
    _, constraint = last
    assert constraint == f"{name}=={shipped_pins[name]}"


# ---------------------------------------------------------------------------
# THE GUARD — RED before #2615, GREEN after.
# ---------------------------------------------------------------------------


def test_loom_duckdb_pins_are_the_last_word(
    events: list[InstallEvent], shipped_pins: dict[str, str]
) -> None:
    """Every pin in the shipped requirements must survive to the end of install.

    A pin whose LAST constraint comes from somewhere else is a pin the tests do
    not actually exercise: the suite runs a different version than the image
    ships, and passes, having measured nothing about the deployed stack.
    """
    skew: list[str] = []
    for name, version in sorted(shipped_pins.items()):
        last = _last_constraint(events, name)
        if last is None:
            skew.append(f"{name}: pinned {version} but no install step constrains it")
            continue
        label, constraint = last
        if constraint != f"{name}=={version}":
            skew.append(
                f"{name}: apps/loom-duckdb pins {version}, but the last install to "
                f"touch it is `{label}` applying `{constraint}`"
            )

    assert not skew, (
        "tests/loom_duckdb would run against a different stack than the image ships "
        "(#2615). Install apps/loom-duckdb/requirements.txt LAST.\n  - "
        + "\n  - ".join(skew)
    )


def test_no_later_pin_fights_the_shipped_fastapi(events: list[InstallEvent]) -> None:
    """`starlette` must be resolved BY the pinned fastapi, never pinned beside it.

    fastapi 0.115.x requires ``starlette<0.42`` and 0.140.13 requires
    ``starlette>=0.46``. An independent starlette pin therefore silently picks a
    fastapi generation. Whatever starlette the shipped fastapi resolves to is the
    one the image runs; if a floor is genuinely needed it belongs in
    apps/loom-duckdb/requirements.txt, where this file's guard covers it.
    """
    offenders = [
        f"`{event.label}` constrains starlette as `{event.constraints['starlette']}`"
        for event in events
        if "starlette" in event.constraints and not event.label.startswith("pip install -r")
    ]
    assert not offenders, (
        "an independent starlette pin decides which fastapi generation CI measures "
        "(#2615): " + "; ".join(offenders)
    )


# ---------------------------------------------------------------------------
# The static model above cannot see what pip ACTUALLY resolved. The workflow
# must check that too, or a transitive downgrade still slips through silently.
# ---------------------------------------------------------------------------


def test_workflow_asserts_resolved_versions_at_runtime() -> None:
    script = WORKFLOW.read_text(encoding="utf-8")
    assert "scripts/ci/assert_installed_pins.py" in script, (
        "the install step must verify the RESOLVED versions, not just the declared "
        "order — run scripts/ci/assert_installed_pins.py (#2615)"
    )
    assert PIN_ASSERTER.is_file(), f"{PIN_ASSERTER} is referenced by CI but missing"
    # Referenced against the file that describes the shipped image, not some
    # other requirements file.
    assert re.search(
        r"assert_installed_pins\.py\s*\\?\s*\n?\s*apps/loom-duckdb/requirements\.txt",
        script,
    ), "the runtime assertion must be pointed at apps/loom-duckdb/requirements.txt"


# ---------------------------------------------------------------------------
# Unit tests for the asserter itself — a checker that cannot fail is not a check.
# ---------------------------------------------------------------------------


class TestSpecParsing:
    """`_constraints_from_specs` after the py/redos rewrite (CodeQL, PR #2806).

    The original pattern validated the version specifier with
    ``(?:[<>=!~]=?[^,]+)(?:,[<>=!~]=?[^,]+)*``; ``[^,]+`` overlapped the
    separator, so an adversarial spec backtracked exponentially. Only the
    distribution NAME is ever used, so the specifier is now checked by its
    leading character. These cases pin the behaviour that rewrite must keep.
    """

    def test_bare_names_and_specifiers_are_accepted(self) -> None:
        parsed = _constraints_from_specs(
            ["pip", "'pathspec>=0.12.1'", "starlette>=0.40,<0.42", "uvicorn[standard]==0.51.0"]
        )
        assert parsed == {
            "pip": "pip",
            "pathspec": "pathspec>=0.12.1",
            "starlette": "starlette>=0.40,<0.42",
            "uvicorn": "uvicorn[standard]==0.51.0",
        }

    def test_flags_and_shell_variables_are_not_constraints(self) -> None:
        assert _constraints_from_specs(["-U", "--upgrade", "$duckdb_pins", ""]) == {}

    def test_a_trailing_specifier_must_start_with_a_specifier_character(self) -> None:
        """`name` followed by junk is not a requirement and must be dropped."""
        assert _constraints_from_specs(["fastapi/0.140.13", "apps/loom-duckdb"]) == {}

    def test_the_codeql_backtracking_input_terminates(self) -> None:
        """The py/redos witness must parse in linear time.

        It is still *accepted* (as a constraint on a package literally named
        "0") — this parser reads workflow-authored argv, not untrusted input, so
        the property that matters is that it terminates rather than that it
        rejects. Under the old nested-quantifier pattern this input backtracked
        exponentially; if that regex ever comes back, this test hangs.
        """
        adversarial = "0!+,!" + "=+,!" * 64
        assert set(_constraints_from_specs([adversarial])) == {"0"}


class TestPinParsing:
    def test_exact_pins_are_extracted_with_extras_and_markers(self) -> None:
        parsed = parse_pins(
            "\n".join(
                [
                    "# a comment",
                    "",
                    "fastapi==0.140.13",
                    'uvicorn[standard]==0.51.0 ; python_version >= "3.9"',
                    "duckdb==1.5.5  # the engine",
                    "-r other.txt",
                ]
            )
        )
        assert parsed == {
            "fastapi": "0.140.13",
            "uvicorn": "0.51.0",
            "duckdb": "1.5.5",
        }

    def test_ranges_are_not_treated_as_pins(self) -> None:
        assert parse_pins("fastapi>=0.115.0,<1.0.0\nstarlette>=0.40,<0.42\n") == {}

    def test_the_shipped_requirements_actually_parse(self) -> None:
        pins = parse_pins(SHIPPED_REQUIREMENTS.read_text(encoding="utf-8"))
        assert "fastapi" in pins
        assert "duckdb" in pins
        assert "pyarrow" in pins


class TestMismatchDetection:
    def test_a_missing_distribution_is_a_mismatch(self) -> None:
        result = _pins.check({"definitely-not-installed-xyz": "1.0.0"})
        assert result == [("definitely-not-installed-xyz", "1.0.0", None)]

    def test_a_wrong_version_is_a_mismatch(self) -> None:
        result = _pins.check({"pytest": "0.0.0-not-a-real-version"})
        assert len(result) == 1
        name, expected, actual = result[0]
        assert name == "pytest"
        assert expected == "0.0.0-not-a-real-version"
        assert actual is not None, "pytest is installed; the checker read no version"

    def test_a_matching_version_is_not_a_mismatch(self) -> None:
        import importlib.metadata as md

        assert _pins.check({"pytest": md.version("pytest")}) == []

    def test_an_empty_pin_set_fails_loudly(self, tmp_path: Path) -> None:
        """A requirements file with no exact pins must not pass vacuously."""
        empty = tmp_path / "requirements.txt"
        empty.write_text("# nothing pinned here\nfastapi>=0.1\n", encoding="utf-8")
        assert _pins.main([str(empty)]) == 2

    def test_main_returns_nonzero_on_skew(self, tmp_path: Path) -> None:
        skewed = tmp_path / "requirements.txt"
        skewed.write_text("pytest==0.0.0-not-a-real-version\n", encoding="utf-8")
        assert _pins.main([str(skewed)]) == 1

    def test_main_returns_zero_when_the_env_matches(self, tmp_path: Path) -> None:
        import importlib.metadata as md

        matching = tmp_path / "requirements.txt"
        matching.write_text(f"pytest=={md.version('pytest')}\n", encoding="utf-8")
        assert _pins.main([str(matching)]) == 0
