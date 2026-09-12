"""The `ci-green` receipt (#4487), each decision with a NEGATIVE CONTROL.

The old definition -- "every required context green AT THE MERGED SHA" -- named
a measurement this CI topology cannot produce, and that was found by trying to
take the receipt for the first time, on the harness's own merge. At
`a02cd41e6d42`: 15 required, 10 green, 5 absent, 0 red.

A definition the topology cannot satisfy leaves two outcomes: every
guard/test-only issue is unclosable, or somebody quietly accepts 10-of-15 as
"green". The corrected definition excuses an absence ONLY when the harness can
say why, from evidence, and every branch that cannot say why fails closed. So
the tests that matter most here are the refusals: without them, "absence is
excused" is reachable by simply failing to measure anything.

Fixtures are multi-element on purpose, per `test_gates.py`'s header: every
branch below is one `break`/`[0]` away from being narrowed to the first
context, and a single-element fixture cannot see that.

Run:  python -m pytest tools/drain/__tests__/ -q
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import gates

POLICY = gates.load_policy(os.path.join(os.path.dirname(__file__), "..", "policy.json"))

VALIDATE_YML = """
name: Validate & Scan
on:
  push:
    branches: [main]
    paths:
      - 'deploy/**/*.bicep'
      - 'deploy/**/*.json'
      - '*.bicep'
      - '.github/workflows/**'
  pull_request:
    branches: [main]
  workflow_dispatch:
jobs:
  lint:
    name: Python Lint
    runs-on: ubuntu-latest
"""

# The shape of the files the #4483 merge actually touched. None of them is under
# deploy/, none is a top-level .bicep, none is a workflow.
MERGED_FILES = [
    ".gitignore",
    "PRPs/active/zero-backlog/PRP.md",
    "pyproject.toml",
    "tools/drain/gates.py",
]

GREEN = {"conclusion": "SUCCESS", "status": "COMPLETED"}


def _green(name):
    return {"name": name, **GREEN}


def _ev(name, **kw):
    return gates.ContextEvidence(name=name, **kw)


def _path_filtered(name, *, head_green=True):
    """A context that structurally could not run at the merged sha."""
    return _ev(
        name,
        workflow_path=".github/workflows/validate.yml",
        merged_check=None,
        head_check=_green(name) if head_green else {"name": name, "conclusion": "FAILURE"},
        merged_workflow_run=None,
        push_trigger=gates.parse_push_trigger(VALIDATE_YML),
    )


def _receipt(evidence, **kw):
    kw.setdefault("merged_total_count", 130)
    kw.setdefault("merged_changed_files", MERGED_FILES)
    kw.setdefault("trees_identical", True)
    return gates.ci_green_receipt(evidence, **kw)


# ---------------------------------------------------------------------------
# The trigger parser
# ---------------------------------------------------------------------------


def test_push_trigger_is_parsed_through_the_yaml_true_key():
    """`on:` is the YAML 1.1 boolean True under PyYAML's default resolver.

    A reader that only looks up the string key `"on"` finds nothing in EVERY
    real workflow file in this repo and concludes "no push trigger" -- which
    excuses every absence at once. This asserts the real parse, not the shape.
    """
    trigger = gates.parse_push_trigger(VALIDATE_YML)
    assert trigger is not None
    assert trigger.present
    assert trigger.branches == ("main",)
    assert trigger.paths == (
        "deploy/**/*.bicep", "deploy/**/*.json", "*.bicep", ".github/workflows/**"
    )


def test_negative_control_unparseable_workflow_is_none_not_an_absent_trigger():
    """None and `present=False` are DIFFERENT answers.

    None is an unanswered question and fails closed; `present=False` is a
    measured fact that EXCUSES an absence. Collapsing them turns every
    unreadable workflow into a free pass.
    """
    assert gates.parse_push_trigger("}{ not yaml") is None
    assert gates.parse_push_trigger("") is None
    assert gates.parse_push_trigger("on:\n  pull_request:\n") == gates.PushTrigger(present=False)


def test_push_trigger_handles_the_scalar_and_list_forms():
    assert gates.parse_push_trigger("on: push\njobs: {}\n").present
    assert gates.parse_push_trigger("on: [push, pull_request]\njobs: {}\n").present
    assert not gates.parse_push_trigger("on: [pull_request]\njobs: {}\n").present
    # `push:` with an empty value is every branch and every path.
    bare = gates.parse_push_trigger("on:\n  push:\njobs: {}\n")
    assert bare.present
    assert bare.paths is None


# ---------------------------------------------------------------------------
# The glob
# ---------------------------------------------------------------------------


def test_glob_star_does_not_cross_a_slash_but_doublestar_does():
    """`fnmatch.translate` maps `*` to `.*`, which is wrong in the direction of
    EXCUSING too much: `'*.bicep'` would match `deploy/x.bicep`, so a
    top-level-only filter would look like it admitted a nested file."""
    assert gates.glob_matches("*.bicep", "main.bicep")
    assert not gates.glob_matches("*.bicep", "deploy/main.bicep")
    assert gates.glob_matches("deploy/**/*.bicep", "deploy/a/b/main.bicep")
    # `**/` may consume ZERO segments together with its slash.
    assert gates.glob_matches("deploy/**/*.bicep", "deploy/main.bicep")
    assert gates.glob_matches(".github/workflows/**", ".github/workflows/validate.yml")
    assert gates.glob_matches(".github/workflows/**", ".github/workflows/a/b.yml")
    assert gates.glob_matches("docs/?.md", "docs/a.md")
    assert not gates.glob_matches("docs/?.md", "docs/ab.md")


def test_negative_control_the_real_filter_admits_none_of_the_real_merge():
    """The measured #4487 case, asserted as data rather than as prose."""
    trigger = gates.parse_push_trigger(VALIDATE_YML)
    runs, why = gates.push_event_runs(trigger, "main", MERGED_FILES)
    assert not runs
    assert "push.paths" in why
    assert "4 changed file(s)" in why
    # ...and it DOES admit a commit that touches one of them, so the filter is
    # discriminating rather than simply always-false.
    runs, _ = gates.push_event_runs(trigger, "main", [*MERGED_FILES, "deploy/x.bicep"])
    assert runs


def test_push_event_branch_filters_decide_too():
    trigger = gates.parse_push_trigger("on:\n  push:\n    branches: [main]\njobs: {}\n")
    assert gates.push_event_runs(trigger, "main", ["a.txt"])[0]
    assert not gates.push_event_runs(trigger, "release/1", ["a.txt"])[0]
    ignore = gates.parse_push_trigger(
        "on:\n  push:\n    branches-ignore: ['dependabot/**']\njobs: {}\n"
    )
    assert ignore.branches_ignore == ("dependabot/**",)
    assert ignore.present
    assert not gates.push_event_runs(ignore, "dependabot/npm/x", ["a.txt"])[0]


def test_paths_ignore_only_excuses_when_it_covers_every_changed_file():
    trigger = gates.parse_push_trigger("on:\n  push:\n    paths-ignore: ['docs/**']\njobs: {}\n")
    assert not gates.push_event_runs(trigger, "main", ["docs/a.md", "docs/b.md"])[0]
    assert gates.push_event_runs(trigger, "main", ["docs/a.md", "src/x.py"])[0]


def test_negative_control_an_unmeasured_file_set_never_excuses_a_path_filter():
    """"It did not run" must never be inferred from "I read no files".

    An empty changed-file list means the question was not answered, so
    `push_event_runs` says the workflow RUNS -- which the receipt turns into a
    FAILURE. The fail-closed direction.
    """
    trigger = gates.parse_push_trigger(VALIDATE_YML)
    runs, why = gates.push_event_runs(trigger, "main", [])
    assert runs
    assert "no changed files were measured" in why


# ---------------------------------------------------------------------------
# The receipt
# ---------------------------------------------------------------------------


def test_the_measured_4483_shape_is_a_green_receipt():
    """Green at the merged sha, path-filtered, and renamed -- the exact
    population measured at `a02cd41e6d42`, which the OLD definition scored
    10-of-15 and therefore could not close."""
    evidence = [
        _ev("Python Tests (3.10)", merged_check=_green("Python Tests (3.10)")),
        _ev("vitest (node 20)", merged_check=_green("vitest (node 20)")),
        _path_filtered("Python Lint"),
        _path_filtered("PowerShell Lint"),
        _path_filtered("Secret Scan"),
        _path_filtered("Repo Hygiene"),
        _ev(
            "changelog parser can read every commit message",
            workflow_path=".github/workflows/commit-message-parses.yml",
            merged_workflow_run={"conclusion": "success", "status": "completed"},
            merged_workflow_jobs=("changelog parser can read what landed on main",),
        ),
    ]
    receipt = _receipt(evidence)
    assert receipt.ok, receipt.reasons
    assert len(receipt.by_state("green-at-merge")) == 2
    assert len(receipt.by_state("deferred-to-head")) == 4
    assert len(receipt.by_state("renamed-at-merge")) == 1
    # Every excused absence is NAMED with its reason -- that is the whole
    # difference between this receipt and "accept 10 of 15".
    for context in receipt.by_state("deferred-to-head"):
        assert "push.paths" in context.detail
    assert "changelog parser can read what landed on main" in (
        receipt.by_state("renamed-at-merge")[0].detail
    )


def test_negative_control_a_red_required_context_is_never_a_receipt():
    receipt = _receipt([
        _ev("guardrails", merged_check=_green("guardrails")),
        _ev("vitest (node 20)",
            merged_check={"name": "vitest (node 20)", "conclusion": "FAILURE"}),
        _path_filtered("Secret Scan"),
    ])
    assert not receipt.ok
    assert any("RED at the merged sha" in r for r in receipt.reasons)


def test_negative_control_a_statuscontext_error_is_not_green_here_either():
    """The rollup's OTHER vocabulary. A reader that knows only the CheckRun
    words scores `state: ERROR` green, which is how a required context that
    errored has read as a pass before."""
    receipt = _receipt([
        _ev("legacy status", merged_check={"context": "legacy status", "state": "ERROR"}),
    ])
    assert not receipt.ok
    assert any("RED" in r for r in receipt.reasons)


def test_negative_control_an_incomplete_or_skipped_context_is_not_a_receipt():
    pending = _receipt([
        _ev("guardrails", merged_check={"name": "guardrails", "status": "IN_PROGRESS"}),
    ])
    assert not pending.ok
    assert any("INCOMPLETE" in r for r in pending.reasons)
    skipped = _receipt([
        _ev("guardrails", merged_check={"name": "guardrails", "conclusion": "SKIPPED"}),
    ])
    assert not skipped.ok
    assert any("SKIPPED" in r for r in skipped.reasons)


def test_negative_control_an_untraceable_producer_fails_closed():
    """The branch that keeps the receipt from degrading into "absence is fine".

    A context absent at the merged sha whose producing workflow could not be
    traced is NO. Without it every excusing path below is reachable by simply
    failing to measure anything.
    """
    receipt = _receipt([
        _ev("Python Tests (3.10)", merged_check=_green("Python Tests (3.10)")),
        _ev("Secret Scan", workflow_path=None, head_check=_green("Secret Scan")),
    ])
    assert not receipt.ok
    assert any("could not be traced" in r for r in receipt.reasons)


def test_negative_control_an_unreadable_push_trigger_fails_closed():
    receipt = _receipt([
        _ev("Secret Scan",
            workflow_path=".github/workflows/validate.yml",
            head_check=_green("Secret Scan"),
            push_trigger=None),
    ])
    assert not receipt.ok
    assert any("could not be read" in r for r in receipt.reasons)


def test_negative_control_a_workflow_that_should_have_run_is_a_missing_check():
    """The filter admits the commit, the context is absent anyway. That is a
    missing check, not a structural absence, and it must not be excused."""
    receipt = _receipt(
        [_path_filtered("Secret Scan")],
        merged_changed_files=[*MERGED_FILES, ".github/workflows/validate.yml"],
    )
    assert not receipt.ok
    assert any("SHOULD have run" in r for r in receipt.reasons)


def test_negative_control_a_renamed_sibling_whose_run_failed_is_not_a_receipt():
    receipt = _receipt([
        _ev("changelog parser can read every commit message",
            workflow_path=".github/workflows/commit-message-parses.yml",
            merged_workflow_run={"conclusion": "failure", "status": "completed"},
            merged_workflow_jobs=("changelog parser can read what landed on main",)),
    ])
    assert not receipt.ok
    assert any("concluded FAILURE" in r for r in receipt.reasons)


def test_negative_control_a_deferral_over_a_different_tree_is_refused():
    """A head green over a different tree is a statement about a tree that was
    not merged. The only honest remedy is naming it, which the message does."""
    receipt = _receipt([_path_filtered("Secret Scan")], trees_identical=False)
    assert not receipt.ok
    assert any("differs from the PR head tree" in r for r in receipt.reasons)
    assert any("dispatch" in r for r in receipt.reasons)


def test_negative_control_a_deferral_with_no_head_result_is_refused():
    receipt = _receipt([
        _ev("Secret Scan",
            workflow_path=".github/workflows/validate.yml",
            head_check=None,
            push_trigger=gates.parse_push_trigger(VALIDATE_YML)),
    ])
    assert not receipt.ok
    assert any("no result anywhere to defer to" in r for r in receipt.reasons)


def test_negative_control_a_deferral_to_a_red_head_result_is_refused():
    receipt = _receipt([_path_filtered("Secret Scan", head_green=False)])
    assert not receipt.ok
    assert any("not green" in r for r in receipt.reasons)


def test_negative_control_zero_checkruns_at_the_merged_sha_is_never_green():
    """`classify_missing`'s never-created case, applied to the whole sha.

    Without it every per-context absence is excused one at a time into a
    vacuous pass over a commit where nothing ran.
    """
    receipt = _receipt([_path_filtered("Secret Scan")], merged_total_count=0)
    assert not receipt.ok
    assert any("ZERO check-runs" in r for r in receipt.reasons)
    assert receipt.contexts == ()


def test_negative_control_an_empty_required_set_is_not_a_green_receipt():
    """`all([])` is True. The same defect that printed `drained: true` over 297
    open issues, one module along."""
    receipt = _receipt([])
    assert not receipt.ok
    assert any("empty receipt" in r for r in receipt.reasons)


def test_the_receipt_summary_names_every_state_it_found():
    receipt = _receipt([
        _ev("guardrails", merged_check=_green("guardrails")),
        _path_filtered("Secret Scan"),
    ])
    assert receipt.ok
    assert "green-at-merge=1" in receipt.summary
    assert "deferred-to-head=1" in receipt.summary


def test_worst_by_name_lets_the_worst_run_decide():
    """A green re-run must not hide a run that measured nothing -- and this is
    now ONE implementation, not the copy `merge_gate` used to keep."""
    worst = gates.worst_by_name([
        {"name": "guardrails", "conclusion": "SUCCESS"},
        {"name": "guardrails", "conclusion": "SKIPPED"},
        {"context": "legacy", "state": "SUCCESS"},
    ])
    assert worst["guardrails"]["conclusion"] == "SKIPPED"
    assert worst["legacy"]["state"] == "SUCCESS"
    # ...and the receipt therefore refuses it.
    assert not _receipt([_ev("guardrails", merged_check=worst["guardrails"])]).ok


# ---------------------------------------------------------------------------
# The authority
# ---------------------------------------------------------------------------


def test_the_policy_declares_the_corrected_definition_and_the_code_implements_it():
    """#4487's own thesis: a definition with no caller is prose.

    Asserted BOTH ways -- the authority carries the rule, and
    `assert_policy_matches_code` resolves `receipts.ci_green_rule` to a real
    callable through `OTHER_IMPLEMENTED_BY`.
    """
    rule = POLICY["receipts"]["ci_green_rule"]
    assert "IDENTICAL TREE" in rule["definition"]
    assert "CAN run at the merged sha" in rule["definition"]
    assert "workflow IDENTITY" in rule["absence_is_excused_only_when"]
    for word in ("untraceable producer", "zero check-runs", "empty required set"):
        assert word in rule["fails_closed_on"], word
    assert gates.OTHER_IMPLEMENTED_BY["receipts.ci_green_rule"] == "gates.ci_green_receipt"
    gates.assert_policy_matches_code(POLICY)


def test_the_rename_case_is_grounded_in_the_real_workflow_file():
    """Both spellings of the conditionally-named job exist in the repo.

    The receipt resolves the rename by workflow IDENTITY rather than by an alias
    table, so nothing in the code depends on these two strings -- but the
    EXAMPLE in the docs and in `policy.json` does, and an example that has
    quietly stopped being true is how a reader learns to distrust the file.
    """
    path = os.path.join(
        os.path.dirname(__file__), "..", "..", "..",
        ".github", "workflows", "commit-message-parses.yml",
    )
    if not os.path.exists(path):  # a worktree that does not carry .github
        return
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    assert "changelog parser can read every commit message" in text
    assert "changelog parser can read what landed on main" in text
    trigger = gates.parse_push_trigger(text)
    assert trigger is not None
    assert trigger.present
    # ...and no path filter, which is why it DID run at the merged sha.
    assert trigger.paths is None
