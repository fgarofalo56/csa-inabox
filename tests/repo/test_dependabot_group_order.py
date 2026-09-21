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

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
GUARD = REPO_ROOT / "scripts/ci/check_dependabot_group_order.py"

sys.path.insert(0, str(REPO_ROOT / "scripts/ci"))

from check_dependabot_group_order import (  # noqa: E402
    audit,
    is_catch_all,
    lane_of,
)


def _entry(groups: dict) -> dict:
    return {"updates": [{"package-ecosystem": "pip", "directory": "/",
                         "groups": groups}]}


def test_guard_file_exists_and_is_tracked():
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

def test_explicit_wildcard_is_a_catch_all():
    # Breaks if: `patterns: ["*"]` stops being recognised.
    assert is_catch_all({"patterns": ["*"]})


def test_missing_patterns_key_is_also_a_catch_all():
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


def test_a_wildcard_anywhere_in_the_list_is_a_catch_all():
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


def test_a_named_pattern_is_not_a_catch_all():
    # Breaks if: the check widens to treat any group as a catch-all, which
    # would make every ordering look like shadowing.
    assert not is_catch_all({"patterns": ["azure-*"]})


def test_a_narrowed_group_is_not_a_catch_all():
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


def test_an_irrelevant_exclusion_spares_nothing():
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


def test_a_relevant_exclusion_does_spare():
    """And the complementary direction, or the fix above is just noise.

    Breaks if: exclusions stop being tested against the later group.
    """
    assert not audit(_entry({
        "catch": {"patterns": ["*"], "exclude-patterns": ["azure-*"]},
        "azure-sdk": {"patterns": ["azure-*"]},
    }))
    # Partial absorption: excluding ONE member of a broader later group does
    # not spare the whole group.
    assert audit(_entry({
        "catch": {"patterns": ["*"], "exclude-patterns": ["azure-identity"]},
        "azure-sdk": {"patterns": ["azure-*"]},
    }))


def test_an_undecidable_glob_falls_silent_rather_than_flagging():
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


def test_matching_is_case_sensitive_so_the_guard_agrees_with_ci():
    """`fnmatch` normcases; `fnmatchcase` does not.

    loom-guardrails runs on ubuntu while contributors run on Windows, so
    `fnmatch` would let this guard and its own pytest disagree with CI.

    Breaks if: `_covers` goes back to `fnmatch`.
    """
    assert not audit(_entry({
        "upper": {"patterns": ["AZURE-*"]},
        "azure-sdk": {"patterns": ["azure-*"]},
    }))


def test_lane_defaults_to_version_updates():
    # Breaks if: the default changes, which would silently move every
    # undefined group onto the security lane.
    assert lane_of({}) == "version-updates"
    assert lane_of({"applies-to": "security-updates"}) == "security-updates"


# --- audit --------------------------------------------------------------

def test_catch_all_above_a_named_group_is_reported():
    # Breaks if: ordering stops being evaluated (e.g. dict order is lost).
    problems = audit(_entry({
        "catch": {"patterns": ["*"]},
        "azure-sdk": {"patterns": ["azure-*"]},
    }))
    assert problems, "shadowing was not detected"
    assert "azure-sdk" in problems[0]


def test_patternless_catch_all_above_a_named_group_is_reported():
    # Breaks if: the patternless form stops counting as a catch-all.
    # Uses a bare group — one carrying `dependency-type` is narrowed and is
    # covered by test_a_narrowed_group_does_not_produce_a_false_positive.
    problems = audit(_entry({
        "catch": {},
        "azure-sdk": {"patterns": ["azure-*"]},
    }))
    assert problems, (
        "a group with no `patterns` key did not count as a catch-all")


def test_correct_order_is_silent():
    # Breaks if: the guard starts firing on well-ordered files — noise that
    # would get it disabled.
    assert not audit(_entry({
        "azure-sdk": {"patterns": ["azure-*"]},
        "catch": {"patterns": ["*"]},
    }))


def test_lanes_do_not_shadow_each_other():
    """`applies-to` is matched per lane, so a security catch-all above a
    version-lane named group shadows nothing.

    Breaks if: lane is dropped from the comparison.
    """
    assert not audit(_entry({
        "sec-catch": {"applies-to": "security-updates", "patterns": ["*"]},
        "azure-sdk": {"patterns": ["azure-*"]},
    }))


def test_a_prefix_glob_shadows_a_narrower_named_group():
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


def test_a_narrowed_group_does_not_produce_a_false_positive():
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


def test_unrelated_prefix_globs_do_not_shadow():
    # Breaks if: subsumption widens to match unrelated prefixes.
    assert not audit(_entry({
        "azure-sdk": {"patterns": ["azure-*"]},
        "codeql-action": {"patterns": ["github/codeql-action*"]},
    }))


def test_same_lane_shadowing_is_still_caught_when_lanes_are_explicit():
    # Breaks if: an explicit `applies-to` on both stops being compared.
    assert audit(_entry({
        "sec-catch": {"applies-to": "security-updates", "patterns": ["*"]},
        "sec-named": {"applies-to": "security-updates",
                      "patterns": ["azure-*"]},
    }))


# --- the real file ------------------------------------------------------

def test_the_committed_dependabot_config_is_not_shadowed():
    """The regression arm. Breaks if: someone moves a catch-all up."""
    r = subprocess.run([sys.executable, str(GUARD)],
                       cwd=REPO_ROOT, capture_output=True, text=True)
    assert r.returncode == 0, f"guard failed on the real file:\n{r.stdout}\n{r.stderr}"
    assert "OK" in r.stdout


def test_the_guards_own_self_test_passes():
    """A guard that has never gone red has never been shown to work."""
    r = subprocess.run([sys.executable, str(GUARD), "--self-test"],
                       cwd=REPO_ROOT, capture_output=True, text=True)
    assert r.returncode == 0, f"self-test failed:\n{r.stdout}\n{r.stderr}"
    assert "self-test OK" in r.stdout


def test_an_empty_updates_list_is_refused_not_reported_clean(tmp_path):
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
