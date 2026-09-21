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
from fnmatch import fnmatch
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
DEPENDABOT_PATH = ".github/dependabot.yml"

VERSION_LANE = "version-updates"


def _narrowed(group: dict) -> bool:
    """True when `group` matches only a SUBSET of its lane.

    GitHub's Example 1 bounds the catch-all premise and the bound is easy to
    miss: `production-dependencies: {dependency-type: production}` does absorb
    production deps matching a later `rubocop*` group -- but the doc's very
    next sentence says "development dependencies matching rubocop* will be
    included in the rubocop group". The later group is NOT dead; it is
    partially absorbed.

    So a narrowed group must never be reported as shadowing, because the
    message would assert something untrue (R7). `patterns: ["*"]` WITH
    `exclude-patterns: ["azure-*"]` above `azure-sdk` is a CORRECT, idiomatic
    config, and rejecting it in a required context is the assertion-design
    "cannot pass" mode -- red against the fix as well as the defect.
    """
    return bool(group.get("exclude-patterns")
                or group.get("dependency-type")
                or group.get("update-types"))


def is_catch_all(group: dict) -> bool:
    """True when `group` matches every dependency of its lane.

    TWO forms, and missing the second is how this check goes blind:
      * no `patterns` key -- GitHub defaults to matching everything
      * `patterns` CONTAINING `"*"` -- the list is an OR, so `["*", "azure-*"]`
        matches everything just as `["*"]` does. An earlier version compared
        `== ["*"]` and missed that, and its test ASSERTED the miss, so the fix
        would have arrived looking like a regression.

    A narrowed group (see `_narrowed`) is never a catch-all.
    """
    if not isinstance(group, dict) or _narrowed(group):
        return False
    patterns = group.get("patterns")
    if patterns is None:
        return True
    return "*" in [str(p) for p in patterns]


def subsumes(earlier: dict, later: dict) -> bool:
    """Does `earlier` match everything `later` would have matched?

    Covers the named-over-named case a wildcard check misses. Every named
    group in this repo is itself a prefix glob, so `azure-identity` added
    after `azure-sdk`, or `codeql-init` after `codeql-action*`, is dead on
    arrival -- and the codeql group exists because of a real outage (init at
    v4.37.6 against analyze at v4.35.3 produced a 0-rule SARIF that froze the
    code-scanning list while every merge went unscanned).

    Pattern-against-pattern matching is an APPROXIMATION. It decides prefix
    globs, which is the shape that occurs here; it does not attempt full glob
    algebra. Deliberately conservative: shadowing is reported only when EVERY
    one of `later`'s patterns is matched by one of `earlier`'s.
    """
    if _narrowed(earlier):
        return False
    pe, pl = earlier.get("patterns"), later.get("patterns")
    if pe is None:
        return True
    if pl is None:
        return False
    pe = [str(p) for p in pe]
    return all(any(fnmatch(str(x), p) for p in pe) for x in pl)


def lane_of(group: dict) -> str:
    """A group's lane. Undefined defaults to version updates."""
    if not isinstance(group, dict):
        return VERSION_LANE
    return str(group.get("applies-to") or VERSION_LANE)


def shadowed(groups: dict) -> list[tuple[str, str, str]]:
    """Groups that an EARLIER group in the SAME lane fully swallows.

    Returns (dead_group, swallowing_group, lane) triples. Compares against
    every earlier group rather than only against catch-alls, because every
    named group in this repo is itself a prefix glob -- `azure-identity` after
    `azure-sdk` is dead on arrival, and a catch-all-only check is silent on it.

    Dict order is the file's order: PyYAML preserves it and Python dicts are
    ordered, which is what makes this check meaningful at all.
    """
    out = []
    items = [(n, b) for n, b in (groups or {}).items() if isinstance(b, dict)]
    for i, (name, body) in enumerate(items):
        lane = lane_of(body)
        for earlier_name, earlier in items[:i]:
            if lane_of(earlier) != lane:
                continue
            if subsumes(earlier, body):
                out.append((name, earlier_name, lane))
                break
    return out


def audit(doc: dict) -> list[str]:
    """Problems, one message each. Empty means none of the checks fired."""
    problems: list[str] = []
    for entry in doc.get("updates") or []:
        where = f"{entry.get('package-ecosystem')} {entry.get('directory')}"
        groups = entry.get("groups") or {}
        for named, catcher, lane in shadowed(groups):
            problems.append(
                f"{where}: group '{named}' is DEAD - '{catcher}' is listed "
                f"above it on the '{lane}' lane and matches everything "
                f"'{named}' would have, so '{named}' can never match. Move it "
                f"above '{catcher}', or narrow '{catcher}'. (GitHub: \"If a "
                f"dependency matches more than one rule, it's included in the "
                f"first group that it matches.\")"
            )
    return problems


def _self_test() -> int:
    """Prove the checker fires. A guard that has never gone red is not a guard.

    Each fixture names the value that makes it fail, per assertion-design.md.
    Both directions matter here: the FALSE-POSITIVE arms are as load-bearing
    as the detection arms, because a merge-blocking check that rejects a
    correct config is the "cannot pass" mode -- red against the fix as well as
    the defect.
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

    # `patterns` is an OR-LIST, so a wildcard ANYWHERE in it matches
    # everything. An earlier version compared `== ["*"]` and missed this, and
    # its test asserted the miss, so the fix looked like a regression.
    or_list = {
        "updates": [{
            "package-ecosystem": "pip", "directory": "/",
            "groups": {
                "catch": {"patterns": ["*", "azure-*"]},
                "azure-sdk": {"patterns": ["azure-*"]},
            },
        }]
    }
    assert audit(or_list), (
        "a wildcard inside a multi-entry patterns list was not treated as a "
        "catch-all - `patterns` is an OR, not an exact match")

    # No `patterns` key at all: GitHub defaults it to matching everything.
    implicit = {
        "updates": [{
            "package-ecosystem": "pip", "directory": "/",
            "groups": {
                "catch": {},
                "azure-sdk": {"patterns": ["azure-*"]},
            },
        }]
    }
    assert audit(implicit), "a group with NO patterns key was not a catch-all"

    # NAMED OVER NAMED. Every named group in this repo is a prefix glob, so a
    # narrower one added after it is dead on arrival and a catch-all-only
    # check is silent.
    named = {
        "updates": [{
            "package-ecosystem": "pip", "directory": "/",
            "groups": {
                "azure-sdk": {"patterns": ["azure-*"]},
                "azure-identity": {"patterns": ["azure-identity"]},
            },
        }]
    }
    assert audit(named), (
        "`azure-identity` after `azure-*` was not detected - a prefix glob "
        "swallows everything under it")

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

    # A NARROWED group shadows only PARTIALLY, so it must not be reported.
    # GitHub's Example 1: a `production` group above `rubocop*` absorbs the
    # production rubocop deps, but "development dependencies matching rubocop*
    # will be included in the rubocop group" -- the later group is alive.
    # Rejecting these in a required context is the "cannot pass" mode.
    for label, narrowing in (
        ("exclude-patterns", {"patterns": ["*"],
                              "exclude-patterns": ["azure-*"]}),
        ("dependency-type", {"dependency-type": "production"}),
        ("update-types", {"patterns": ["*"],
                          "update-types": ["version-update:semver-patch"]}),
    ):
        fixture = {
            "updates": [{
                "package-ecosystem": "pip", "directory": "/",
                "groups": {"narrow": narrowing,
                           "azure-sdk": {"patterns": ["azure-*"]}},
            }]
        }
        assert not audit(fixture), (
            f"a group narrowed by {label} was reported as shadowing - it "
            "absorbs only part of the later group, so the message would "
            "assert something untrue (R7)")

    print("self-test OK: 3 shadowing arms fire, 5 clean arms stay silent")
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
