"""Guard: a catch-all dependabot group must not shadow a named one.

WHY THIS EXISTS. `.github/dependabot.yml` carries named groups that each have
a correctness reason stated at their site -- `codeql-action` keeps three
actions from one repo in lockstep (drift produced a 0-rule SARIF that froze
the code-scanning list while every merge went unscanned), `arrow-stack` makes
four crates reviewable together, `azure-sdk` batches the Azure SDK. Those
entries also carry catch-all groups so ordinary bumps arrive grouped.

Per GitHub's dependabot options reference: "If a dependency matches more than
one rule, it's included in the first group that it matches." So a catch-all
placed ABOVE a named group silently swallows it. GitHub raises no error, the
file stays valid, and nothing else in this repo reads it -- the named group
simply stops existing in practice and the reason it was written for is gone.

WHAT COUNTS AS A CATCH-ALL, and this is the part a hand-rolled check gets
wrong: `patterns: ["*"]` is the obvious form, but a group with NO `patterns`
key at all also matches everything of its dependency-type (GitHub's own
Example 1 does exactly that). A checker that only recognises the explicit
wildcard reports GREEN while a named group sits shadowed -- the precise
defect it was built to catch. Both forms are treated as catch-alls here.

`applies-to` is matched per lane, so a version-updates catch-all does not
shadow a named group on the security lane, and vice versa. Shadowing is
evaluated WITHIN a lane.

Run:  python scripts/ci/check_dependabot_group_order.py
      python scripts/ci/check_dependabot_group_order.py --self-test
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
DEPENDABOT_PATH = ".github/dependabot.yml"

VERSION_LANE = "version-updates"


def is_catch_all(group: dict) -> bool:
    """True when `group` matches every dependency of its lane.

    Two forms, and missing the second is how this check goes blind:
      * `patterns: ["*"]` -- the explicit wildcard
      * no `patterns` key -- GitHub defaults to matching everything
    """
    if not isinstance(group, dict):
        return False
    patterns = group.get("patterns")
    if patterns is None:
        return True
    return [str(p) for p in patterns] == ["*"]


def lane_of(group: dict) -> str:
    """A group's lane. Undefined defaults to version updates."""
    if not isinstance(group, dict):
        return VERSION_LANE
    return str(group.get("applies-to") or VERSION_LANE)


def shadowed(groups: dict) -> list[tuple[str, str, str]]:
    """Named groups that a catch-all earlier in the SAME lane swallows.

    Returns (named_group, catch_all_group, lane) triples. Dict order is the
    file's order: PyYAML preserves it and Python dicts are ordered, which is
    what makes this check meaningful at all.
    """
    out = []
    seen_catch_all: dict[str, str] = {}
    for name, body in (groups or {}).items():
        lane = lane_of(body)
        if is_catch_all(body):
            seen_catch_all.setdefault(lane, name)
        elif lane in seen_catch_all:
            out.append((name, seen_catch_all[lane], lane))
    return out


def audit(doc: dict) -> list[str]:
    """Problems, one message each. Empty means none of the checks fired."""
    problems: list[str] = []
    for entry in doc.get("updates") or []:
        where = f"{entry.get('package-ecosystem')} {entry.get('directory')}"
        groups = entry.get("groups") or {}
        for named, catcher, lane in shadowed(groups):
            problems.append(
                f"{where}: group '{named}' is DEAD - the catch-all '{catcher}' "
                f"is listed above it on the '{lane}' lane and matches "
                f"everything, so '{named}' can never match. Move every "
                f"catch-all last within its entry. (GitHub: \"If a dependency "
                f"matches more than one rule, it's included in the first group "
                f"that it matches.\")"
            )
    return problems


def _self_test() -> int:
    """Prove the checker fires. A guard that has never gone red is not a guard.

    Each fixture names the value that makes it fail, per assertion-design.md.
    """
    explicit = {
        "updates": [{
            "package-ecosystem": "pip", "directory": "/",
            "groups": {
                "catch": {"patterns": ["*"]},
                "azure-sdk": {"patterns": ["azure-*"]},
            },
        }]
    }
    assert audit(explicit), "explicit-wildcard shadowing was NOT detected"

    # THE ARM A HAND-ROLLED CHECK MISSES: no `patterns` key at all.
    implicit = {
        "updates": [{
            "package-ecosystem": "pip", "directory": "/",
            "groups": {
                "all-prod": {"dependency-type": "production"},
                "azure-sdk": {"patterns": ["azure-*"]},
            },
        }]
    }
    assert audit(implicit), (
        "a group with NO patterns key was not treated as a catch-all - this "
        "is the false negative the guard exists to avoid")

    # Correct order must NOT fire, or the guard is noise.
    ordered = {
        "updates": [{
            "package-ecosystem": "pip", "directory": "/",
            "groups": {
                "azure-sdk": {"patterns": ["azure-*"]},
                "catch": {"patterns": ["*"]},
            },
        }]
    }
    assert not audit(ordered), "correct ordering produced a false positive"

    # Different LANES do not shadow each other.
    lanes = {
        "updates": [{
            "package-ecosystem": "pip", "directory": "/",
            "groups": {
                "sec-catch": {"applies-to": "security-updates",
                              "patterns": ["*"]},
                "azure-sdk": {"patterns": ["azure-*"]},
            },
        }]
    }
    assert not audit(lanes), (
        "a security-lane catch-all was treated as shadowing a version-lane "
        "group - applies-to is matched per lane")

    print("self-test OK: 2 shadowing arms fire, 2 clean arms stay silent")
    return 0


def main(root: Path) -> int:
    path = root / DEPENDABOT_PATH
    if not path.is_file():
        print(f"::error::{DEPENDABOT_PATH} not found at {root}")
        return 1

    doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    entries = doc.get("updates") or []
    if not entries:
        # A zero result must not read as "clean" when it means "read nothing".
        print(f"::error::{DEPENDABOT_PATH} parsed with ZERO update entries - "
              "refusing to report clean over a file this check did not read.")
        return 1

    problems = audit(doc)
    for p in problems:
        print(f"::error::{p}")
    if problems:
        print(f"{len(problems)} shadowed group(s). Catch-alls go LAST.")
        return 1

    grouped = sum(1 for e in entries if e.get("groups"))
    print(f"dependabot-group-order: OK - {len(entries)} update entries, "
          f"{grouped} with groups, no named group shadowed by a catch-all.")
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        sys.exit(_self_test())
    sys.exit(main(REPO_ROOT))
