"""The dependabot group-order guard must catch a shadowed group.

`scripts/ci/check_dependabot_group_order.py` exists because a catch-all group
placed above a named one silently swallows it: GitHub raises no error, the
file stays valid, and the named group stops existing in practice. Nothing
else in this repo reads `.github/dependabot.yml`, so if this guard is blind
the shadowing is invisible.

Each test names the value that makes it fail, per assertion-design.md. The
two that matter are the negative ones — a guard that cannot go red is not a
guard, and the `no patterns key` case is the specific false negative that a
hand-rolled version of this check shipped with.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
GUARD = REPO_ROOT / "scripts/ci/check_dependabot_group_order.py"

sys.path.insert(0, str(REPO_ROOT / "scripts/ci"))

# `scripts/ci` is not a package, so the guard is imported by path at runtime
# and mypy cannot follow it. Ignored AT THE SITE rather than by adding an entry
# to the `ignore_missing_imports` override in pyproject.toml: that list is for
# third-party packages without stubs, and widening it would silence real
# import errors across every first-party module.
from check_dependabot_group_order import (  # type: ignore[import-not-found] # noqa: E402
    audit,
    is_catch_all,
    lane_of,
)


def _entry(groups: dict[str, Any]) -> dict[str, Any]:
    return {"updates": [{"package-ecosystem": "pip", "directory": "/",
                         "groups": groups}]}


def test_guard_file_exists_and_is_tracked() -> None:
    """The whole point is that it lives in the merged tree, not in temp/."""
    assert GUARD.is_file(), f"{GUARD} is missing"
    out = subprocess.run(
        ["git", "ls-files", "--error-unmatch",
         "scripts/ci/check_dependabot_group_order.py"],
        cwd=REPO_ROOT, capture_output=True, text=True)
    assert out.returncode == 0, (
        "the guard is UNTRACKED — an untracked guard cannot run in CI, which "
        "is the defect this file was written to close")


# --- is_catch_all -------------------------------------------------------

def test_explicit_wildcard_is_a_catch_all() -> None:
    # Breaks if: `patterns: ["*"]` stops being recognised.
    assert is_catch_all({"patterns": ["*"]})


def test_missing_patterns_key_is_also_a_catch_all() -> None:
    """A group with no `patterns` matches everything of its lane.

    GitHub's Example 1 relies on exactly this. A checker that only knows the
    explicit wildcard reports GREEN while a named group sits shadowed.

    NOTE the bound, which an earlier version of this test got wrong: a group
    carrying `dependency-type` is NARROWED, so it absorbs only part of a later
    group and is deliberately NOT a catch-all — see
    test_a_narrowed_group_is_not_a_catch_all.

    Breaks if: `is_catch_all` starts requiring a `patterns` key.
    """
    assert is_catch_all({})
    assert is_catch_all({"applies-to": "version-updates"})


def test_a_wildcard_anywhere_in_the_list_is_a_catch_all() -> None:
    """`patterns` is an OR-LIST, so a wildcard ANYWHERE matches everything.

    THIS ASSERTION USED TO BE INVERTED. The first version of the guard
    compared `patterns == ["*"]` and this test asserted that
    `["*", "azure-*"]` was NOT a catch-all — so the test RATIFIED the miss,
    and whoever later fixed `is_catch_all` would have got a red test telling
    them they had broken it. A test that pins a bug is worse than no test.

    Breaks if: `is_catch_all` goes back to exact-list comparison.
    """
    assert is_catch_all({"patterns": ["*", "azure-*"]})
    assert is_catch_all({"patterns": ["azure-*", "*"]})


def test_a_named_pattern_is_not_a_catch_all() -> None:
    # Breaks if: the check widens to treat any group as a catch-all, which
    # would make every ordering look like shadowing.
    assert not is_catch_all({"patterns": ["azure-*"]})


def test_a_narrowed_group_is_not_a_catch_all() -> None:
    """`dependency-type` and `update-types` narrow a group unconditionally.

    Each partitions on an axis `patterns` cannot express — production leaves
    development, patch leaves minor and major — so such a group can never
    fully swallow a later one, whatever that group matches.

    `exclude-patterns` is DELIBERATELY ABSENT here: it lives on the same axis
    as `patterns`, so whether it spares the later group depends on what it
    actually excludes. Tested in `subsumes`, not asserted by presence — see
    test_an_irrelevant_exclusion_spares_nothing.

    Breaks if: `_narrowed` stops disqualifying either key — and the failure
    mode is a REQUIRED check rejecting a correct config.
    """
    assert not is_catch_all({"dependency-type": "production"})
    assert not is_catch_all({"patterns": ["*"],
                             "update-types": ["version-update:semver-patch"]})


def test_an_irrelevant_exclusion_spares_nothing() -> None:
    """One unrelated exclude entry must not switch detection off.

    The first fix for the exclude-patterns false positive disqualified ANY
    group carrying the key, which silenced real shadowing: no azure package
    matches `lodash`, so `azure-sdk` is fully absorbed and dead.

    Breaks if: `exclude-patterns` goes back into `_narrowed`.
    """
    assert audit(_entry({
        "catch": {"patterns": ["*"], "exclude-patterns": ["lodash"]},
        "azure-sdk": {"patterns": ["azure-*"]},
    })), "an exclusion covering nothing was treated as sparing the later group"


def test_a_relevant_exclusion_does_spare() -> None:
    """An exclusion covering the later group's patterns keeps it alive.

    The PARTIAL case (excluding one member of a broader group) lives in
    test_a_partial_exclusion_falls_silent — an earlier version asserted here
    that partial absorption should still flag, which mis-transcribed the
    specification and pinned the defect a reviewer had already described.

    Breaks if: exclusions stop being tested against the later group.
    """
    assert not audit(_entry({
        "catch": {"patterns": ["*"], "exclude-patterns": ["azure-*"]},
        "azure-sdk": {"patterns": ["azure-*"]},
    }))


def test_an_undecidable_glob_falls_silent_rather_than_flagging() -> None:
    """Error DIRECTION is the property, not accuracy.

    A miss leaves the repo where it was before this guard existed; a false
    flag blocks a correct merge in a required context. `azure-?` does not
    cover `azure-*` — `azure-identity` matches neither — and the comparison
    feeds a PATTERN where a NAME belongs, so `?` would match the literal `*`.

    Breaks if: `_covers` stops refusing `?` and `[`.
    """
    assert not audit(_entry({
        "q": {"patterns": ["azure-?"]},
        "azure-sdk": {"patterns": ["azure-*"]},
    }))


def test_a_patternless_duplicate_after_a_starred_catch_all_is_caught() -> None:
    """Both spellings of "matches everything" must shadow each other.

    An earlier version required the EARLIER group to be patternless, so
    `{patterns:["*"]}` followed by a bare `{}` left the second silently dead
    while the reverse order fired correctly — the same rule reaching a
    different verdict depending on which spelling came first.

    Breaks if: `subsumes` goes back to requiring `pe is None`.
    """
    assert audit(_entry({
        "catch": {"patterns": ["*"]},
        "dupe": {},
    }))
    assert audit(_entry({
        "catch": {},
        "dupe": {"patterns": ["*"]},
    }))


def test_a_partial_exclusion_falls_silent() -> None:
    """A group the catcher partly excludes is NOT dead, so do not flag it.

    THIS TEST USED TO PIN THE WRONG VERDICT. It asserted the guard flagged
    this case while its own docstring explained why flagging was wrong —
    accepting the finding in prose and ratifying the defect in the assertion,
    three lines apart. Third instance of that shape in this file's history.

    The remediation made it worse than a wording bug: "move it above 'catch'"
    would make `azure-sdk` capture EVERY azure package, when the config
    deliberately routes only `azure-identity` there. A correct config blocked
    in a required check, with a fix that changes behaviour.

    Breaks if: `subsumes` stops testing exclusions for OVERLAP.
    """
    assert not audit(_entry({
        "catch": {"patterns": ["*"], "exclude-patterns": ["azure-identity"]},
        "azure-sdk": {"patterns": ["azure-*"]},
    }))


def test_a_total_shadow_says_can_never_match_even_with_an_exclusion() -> None:
    """The mirror of the above: an IRRELEVANT exclusion must not soften the
    message.

    An earlier fix discriminated on `exclude-patterns` PRESENCE, so a
    total-death case carrying `exclude-patterns: ["pytest*"]` rendered as
    "reachable only for packages 'catch' explicitly excludes" — claiming it
    receives packages it cannot match. Same R7 defect, pointing the other way.

    Breaks if: the message goes back to branching on presence.
    """
    problems = audit(_entry({
        "catch": {"patterns": ["*"], "exclude-patterns": ["pytest*"]},
        "azure-sdk": {"patterns": ["azure-*"]},
    }))
    assert problems, "no azure package matches pytest*, so azure-sdk is dead"
    assert "can never match" in problems[0], problems[0]
    assert "reachable only for" not in problems[0], problems[0]


def test_an_exclusion_gives_the_same_verdict_in_both_spellings() -> None:
    """Spelling dependence survived once in the `pl is None` branch.

    `excl zzz` above a duplicate spelled `{patterns:["*"]}` fired, while the
    same config spelled `{}` did not. Both must agree: the duplicate still
    serves `zzz`, so neither should flag.

    Breaks if: the two branches diverge again.
    """
    starred = audit(_entry({
        "catch": {"patterns": ["*"], "exclude-patterns": ["zzz"]},
        "dupe": {"patterns": ["*"]},
    }))
    patternless = audit(_entry({
        "catch": {"patterns": ["*"], "exclude-patterns": ["zzz"]},
        "dupe": {},
    }))
    # THE EQUALITY GOES FIRST, and the order is load-bearing. Asserting it
    # last made it UN-KILLABLE: if either individual assertion fails execution
    # stops, and if both pass both are `[]`, so `[] == []` holds necessarily —
    # assertion-design.md's own example. Checked first, it is the arm that
    # actually fires on the disagreement this test is named for.
    assert starred == patternless, (
        f"the two spellings disagree: starred={starred} "
        f"patternless={patternless} — same config, so same verdict")
    assert not starred, (
        "both spellings flagged; the duplicate still serves `zzz`")


def test_an_undecidable_exclusion_falls_silent_not_flags() -> None:
    """A HELPER'S SAFE DEFAULT IS ONLY SAFE WHERE IT WAS WRITTEN FOR.

    `_covers` refuses to `False`, which is correct in the SUBSUMPTION test
    ("cannot show it is swallowed" -> stay silent) and INVERTED in the overlap
    test, where `False` means "no overlap" and therefore FLAGS. Reusing it for
    both made `exclude-patterns: ["azure-[ab]x"]` report a group dead that the
    exclusion actually keeps alive — the guard's own conservatism pointing
    backwards, in the merge-blocking direction.

    `_overlaps` exists to hold the opposite default: undecidable means assume
    overlap, so the later group is assumed alive and the guard stays quiet.

    Breaks if: `_overlaps` is collapsed back into `_covers`.
    """
    assert not audit(_entry({
        "catch": {"patterns": ["*"], "exclude-patterns": ["azure-[ab]x"]},
        "later": {"patterns": ["azure-ax"]},
    })), "an undecidable exclusion was treated as no-overlap and flagged"

    assert not audit(_entry({
        "catch": {"patterns": ["*"], "exclude-patterns": ["lod?sh"]},
        "azure-sdk": {"patterns": ["azure-*"]},
    }))


def test_matching_is_case_sensitive_so_the_guard_agrees_with_ci() -> None:
    """`fnmatch` normcases; `fnmatchcase` does not.

    loom-guardrails runs on ubuntu while contributors run on Windows, so
    `fnmatch` would let this guard and its own pytest disagree with CI.

    Breaks if: `_covers` goes back to `fnmatch`.
    """
    assert not audit(_entry({
        "upper": {"patterns": ["AZURE-*"]},
        "azure-sdk": {"patterns": ["azure-*"]},
    }))


def test_lane_defaults_to_version_updates() -> None:
    # Breaks if: the default changes, which would silently move every
    # undefined group onto the security lane.
    assert lane_of({}) == "version-updates"
    assert lane_of({"applies-to": "security-updates"}) == "security-updates"


# --- audit --------------------------------------------------------------

def test_catch_all_above_a_named_group_is_reported() -> None:
    # Breaks if: ordering stops being evaluated (e.g. dict order is lost).
    problems = audit(_entry({
        "catch": {"patterns": ["*"]},
        "azure-sdk": {"patterns": ["azure-*"]},
    }))
    assert problems, "shadowing was not detected"
    assert "azure-sdk" in problems[0]


def test_patternless_catch_all_above_a_named_group_is_reported() -> None:
    # Breaks if: the patternless form stops counting as a catch-all.
    # Uses a bare group — one carrying `dependency-type` is narrowed and is
    # covered by test_a_narrowed_group_does_not_produce_a_false_positive.
    problems = audit(_entry({
        "catch": {},
        "azure-sdk": {"patterns": ["azure-*"]},
    }))
    assert problems, (
        "a group with no `patterns` key did not count as a catch-all")


def test_correct_order_is_silent() -> None:
    # Breaks if: the guard starts firing on well-ordered files — noise that
    # would get it disabled.
    assert not audit(_entry({
        "azure-sdk": {"patterns": ["azure-*"]},
        "catch": {"patterns": ["*"]},
    }))


def test_lanes_do_not_shadow_each_other() -> None:
    """`applies-to` is matched per lane, so a security catch-all above a
    version-lane named group shadows nothing.

    Breaks if: lane is dropped from the comparison.
    """
    assert not audit(_entry({
        "sec-catch": {"applies-to": "security-updates", "patterns": ["*"]},
        "azure-sdk": {"patterns": ["azure-*"]},
    }))


def test_a_prefix_glob_shadows_a_narrower_named_group() -> None:
    """NAMED OVER NAMED — the arm a catch-all-only check is silent on.

    Every named group in this repo is itself a prefix glob, so a narrower one
    added after it is dead on arrival: `azure-identity` under `azure-*`,
    `codeql-init` under `github/codeql-action*`.

    Breaks if: `shadowed` goes back to comparing only against catch-alls.
    """
    assert audit(_entry({
        "azure-sdk": {"patterns": ["azure-*"]},
        "azure-identity": {"patterns": ["azure-identity"]},
    }))
    assert audit(_entry({
        "broad": {"patterns": ["github/*"]},
        "codeql-action": {"patterns": ["github/codeql-action*"]},
    }))


def test_a_narrowed_group_does_not_produce_a_false_positive() -> None:
    """The "cannot pass" mode: a REQUIRED check rejecting a correct config.

    `patterns: ["*"]` WITH `exclude-patterns: ["azure-*"]` above `azure-sdk`
    is idiomatic and correct — the exclusion is precisely what keeps the later
    group alive.

    Breaks if: `_narrowed` stops disqualifying these keys.
    """
    for narrowing in (
        {"patterns": ["*"], "exclude-patterns": ["azure-*"]},
        {"dependency-type": "production"},
        {"patterns": ["*"], "update-types": ["version-update:semver-patch"]},
    ):
        assert not audit(_entry({
            "narrow": narrowing,
            "azure-sdk": {"patterns": ["azure-*"]},
        })), f"false positive on a group narrowed by {sorted(narrowing)}"


def test_unrelated_prefix_globs_do_not_shadow() -> None:
    # Breaks if: subsumption widens to match unrelated prefixes.
    assert not audit(_entry({
        "azure-sdk": {"patterns": ["azure-*"]},
        "codeql-action": {"patterns": ["github/codeql-action*"]},
    }))


def test_same_lane_shadowing_is_still_caught_when_lanes_are_explicit() -> None:
    # Breaks if: an explicit `applies-to` on both stops being compared.
    assert audit(_entry({
        "sec-catch": {"applies-to": "security-updates", "patterns": ["*"]},
        "sec-named": {"applies-to": "security-updates",
                      "patterns": ["azure-*"]},
    }))


# --- the real file ------------------------------------------------------

def test_the_committed_dependabot_config_is_not_shadowed() -> None:
    """The regression arm. Breaks if: someone moves a catch-all up."""
    r = subprocess.run([sys.executable, str(GUARD)],
                       cwd=REPO_ROOT, capture_output=True, text=True)
    assert r.returncode == 0, f"guard failed on the real file:\n{r.stdout}\n{r.stderr}"
    assert "OK" in r.stdout


def test_the_guards_own_self_test_passes() -> None:
    """A guard that has never gone red has never been shown to work."""
    r = subprocess.run([sys.executable, str(GUARD), "--self-test"],
                       cwd=REPO_ROOT, capture_output=True, text=True)
    assert r.returncode == 0, f"self-test failed:\n{r.stdout}\n{r.stderr}"
    assert "self-test OK" in r.stdout


def test_an_empty_updates_list_is_refused_not_reported_clean(
    tmp_path: Path,
) -> None:
    """A zero result must not read as 'clean' when it means 'read nothing'.

    Breaks if: `main` starts reporting OK over a file it parsed as empty.
    """
    from check_dependabot_group_order import main

    (tmp_path / ".github").mkdir()
    (tmp_path / ".github/dependabot.yml").write_text(
        "version: 2\nupdates: []\n", encoding="utf-8")
    assert main(tmp_path) == 1, (
        "an empty updates list was reported clean instead of refused")


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
