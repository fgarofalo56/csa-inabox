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
from fnmatch import fnmatchcase
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
DEPENDABOT_PATH = ".github/dependabot.yml"

VERSION_LANE = "version-updates"


def _narrowed(group: dict) -> bool:
    """True when `group` matches only a SUBSET of its lane, unconditionally.

    `dependency-type` and `update-types` ALWAYS leave a complementary slice --
    production leaves development, patch leaves minor and major -- so a group
    carrying either can never fully swallow a later one, whatever that later
    group matches.

    `exclude-patterns` is DELIBERATELY NOT HERE, and an earlier version had it
    wrong. Exclusions spare the later group only if they actually COVER it: a
    catch-all excluding `pytest*` leaves `azure-sdk` just as dead as one with
    no exclusions at all. Treating any exclusion as a blanket disqualifier
    silenced real detections while fixing a false positive -- widening a
    check until it retires a surviving arm. It is handled in `subsumes`,
    where the later group's patterns are actually available to test against.
    """
    return bool(group.get("dependency-type") or group.get("update-types"))


def _covers(pattern: str, target: str) -> bool:
    """Does glob `pattern` match everything glob `target` matches?

    APPROXIMATE, and the property that matters is ERROR DIRECTION rather than
    accuracy: when this cannot decide, it must fall SILENT, never flag. A miss
    leaves the repo where it was before this guard existed; a false flag
    blocks a correct merge in a required context. So anything beyond literals
    and prefix globs is refused rather than guessed.

    `?` and `[` in `pattern` are refused because the comparison feeds a
    PATTERN in where a dependency NAME belongs: `fnmatch("azure-*", "azure-?")`
    is True, the `?` matching the literal `*` character, so `azure-?` above
    `azure-*` would be flagged DEAD when `azure-identity` matches neither.

    `fnmatchcase`, never `fnmatch`: the latter normcases, so
    `fnmatch("azure-*", "AZURE-*")` is True on Windows and False on Linux.
    loom-guardrails runs on ubuntu while contributors run on Windows, which
    would let this guard and its own pytest disagree with CI.
    """
    if "?" in pattern or "[" in pattern:
        return False
    return fnmatchcase(target, pattern)


def is_catch_all(group: dict) -> bool:
    """True when `group` matches every dependency of its lane.

    TWO forms, and missing the second is how this check goes blind:
      * no `patterns` key -- GitHub defaults to matching everything
      * `patterns` CONTAINING `"*"` -- the list is an OR, so `["*", "azure-*"]`
        matches everything just as `["*"]` does. An earlier version compared
        `== ["*"]` and missed that, and its test ASSERTED the miss, so the fix
        would have arrived looking like a regression.

    Says nothing about `exclude-patterns`: a group can match everything and
    still spare a later group by excluding it. That is `subsumes`' business.
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
    after `azure-*`, or `codeql-init` after `github/codeql-action*`, is dead
    on arrival -- and the codeql group exists because of a real outage (init
    at v4.37.6 against analyze at v4.35.3 produced a 0-rule SARIF that froze
    the code-scanning list while every merge went unscanned).

    EXCLUSIONS ARE TESTED, NOT ASSUMED. `earlier` spares `later` only when its
    `exclude-patterns` cover EVERY pattern `later` carries; excluding
    something unrelated spares nothing.

    Conservative throughout: shadowing is reported only when every one of
    `later`'s patterns is matched by one of `earlier`'s and excluded by none.
    """
    if _narrowed(earlier):
        return False
    pe, pl = earlier.get("patterns"), later.get("patterns")
    ex = [str(x) for x in (earlier.get("exclude-patterns") or [])]

    if pl is None:
        # `later` matches everything of its lane, so only a group that ALSO
        # matches everything can swallow it -- patternless, or starred. An
        # earlier version required `pe is None`, which missed the starred form
        # and left a patternless duplicate after `patterns: ["*"]` silently
        # dead while the reverse order fired correctly.
        if ex:
            return False
        return pe is None or "*" in [str(p) for p in pe]
    pl = [str(p) for p in pl]

    # AN EXCLUSION THAT OVERLAPS `later` LEAVES IT ALIVE, so fall silent.
    # Three cases, and the middle one is why presence alone is not the test:
    #   exclude ["lodash"]         vs ["azure-*"] -> no overlap, later is DEAD
    #   exclude ["azure-identity"] vs ["azure-*"] -> overlap, later still
    #                                                serves azure-identity
    #   exclude ["azure-*"]        vs ["azure-*"] -> full cover, later alive
    # An earlier round rescoped the MESSAGE for the middle case and left the
    # FLAG, so a valid config still failed a required check -- the finding was
    # closed at its label, not at its site. Silence is correct here: the
    # remediation this guard prints ("move it above") would itself change
    # behaviour, making `azure-sdk` capture every azure package when the
    # config deliberately routes only one there.
    if any(_covers(t, x) or _covers(x, t) for x in ex for t in pl):
        return False

    if pe is None:
        return True
    pe = [str(p) for p in pe]
    return all(any(_covers(p, t) for p in pe) for t in pl)


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
            # "can never match" is unconditional again, and safely so: a
            # catcher whose exclusions OVERLAP `named` no longer reaches this
            # point -- `subsumes` falls silent there. An earlier round tried
            # to rescope this sentence instead of fixing the flag, which left
            # a valid config failing a required check AND produced a message
            # that contradicted itself ("is DEAD ... is reachable only for").
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

    # AN IRRELEVANT EXCLUSION SPARES NOTHING. This arm exists because the
    # first fix for the false positive above disqualified ANY group carrying
    # `exclude-patterns`, which switched detection off wholesale: one unrelated
    # entry and `azure-sdk` is dead with the guard green. Widening a check
    # until it retires a surviving arm.
    irrelevant = {
        "updates": [{
            "package-ecosystem": "pip", "directory": "/",
            "groups": {
                "catch": {"patterns": ["*"], "exclude-patterns": ["lodash"]},
                "azure-sdk": {"patterns": ["azure-*"]},
            },
        }]
    }
    assert audit(irrelevant), (
        "an exclusion that covers NOTHING the later group matches was treated "
        "as sparing it - exclusions must be TESTED, not merely present")

    # A RELEVANT exclusion does spare it, and must stay silent.
    relevant = {
        "updates": [{
            "package-ecosystem": "pip", "directory": "/",
            "groups": {
                "catch": {"patterns": ["*"], "exclude-patterns": ["azure-*"]},
                "azure-sdk": {"patterns": ["azure-*"]},
            },
        }]
    }
    assert not audit(relevant), (
        "an exclusion covering the later group's patterns was still reported "
        "as shadowing - the exclusion is what keeps that group alive")

    # WHEN IT CANNOT DECIDE, IT MUST FALL SILENT. `azure-?` does not cover
    # `azure-*` (azure-identity matches neither), and guessing produces a
    # false RED in a required context.
    undecidable = {
        "updates": [{
            "package-ecosystem": "pip", "directory": "/",
            "groups": {
                "q": {"patterns": ["azure-?"]},
                "azure-sdk": {"patterns": ["azure-*"]},
            },
        }]
    }
    assert not audit(undecidable), (
        "a `?` glob was treated as covering a `*` glob - the comparison feeds "
        "a PATTERN where a NAME belongs, so `?` matches the literal `*`")

    print("self-test OK: 4 shadowing arms fire, 7 clean arms stay silent")
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
