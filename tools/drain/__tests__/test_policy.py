"""`policy.json` is "the authority". This file is what makes that true.

An unconsulted policy key is PROSE, not a control. Measured at head 44bdf63:
ten keys under `merge_gate` and four under `verdict_parsing` were read by no
code at all -- `base_must_equal_origin_main`, `require_no_red`,
`require_hollow_check_clean`, `marker_any_of`, `token_any_of` and the rest --
so editing the authority changed nothing. `marker_any_of` and `token_any_of`
duplicated hardcoded constants, which is worse than absent: it looks
configurable.

Two of those keys were actively FALSE. `require_hollow_check_clean: true`
asserted a capability `statusCheckRollup` cannot support, and the `clause5_*`
pair described carrying a verdict across a re-derive, which nothing implements
and which contradicts pinning.

And the module docstring that should have caught it described "five policy keys
read by nothing" as a repaired PAST defect -- prose about unconsulted prose.

So the mapping is checked BOTH WAYS, mechanically, here.

Run:  python -m pytest tools/drain/__tests__/ -q
"""
from __future__ import annotations

import copy
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import gates

POLICY_PATH = os.path.join(os.path.dirname(__file__), "..", "policy.json")
POLICY = gates.load_policy(POLICY_PATH)

#: `escalate_on_blocking_first_verdict` ships `false` as of the 2026-10-01 lean-
#: review directive (`_lean_review_2026_10_01`), so a prior blocking verdict no
#: longer raises `review_requirement`'s count by itself under the real POLICY.
#: The SHAPE-MATCHING logic this used to drive (`worst_verdict_in_history`'s
#: near-miss tagging, read through to the count) still exists -- it is just off
#: by default -- so the tests that pin that logic drive it through an explicit
#: override rather than through a branch the shipped policy no longer takes.
POLICY_BLOCK_ESCALATES = {**POLICY, "review": {**POLICY["review"],
                                               "escalate_on_blocking_first_verdict": True}}


def test_every_policy_key_has_an_implementation():
    gates.assert_policy_matches_code(POLICY)


def test_negative_control_a_new_key_with_no_implementation_is_caught():
    """The failure mode: someone adds a rule to "the authority" and nothing
    reads it, so the repo believes a control exists that does not."""
    fake = {**POLICY, "merge_gate": {**POLICY["merge_gate"], "require_a_pony": True}}
    with pytest.raises(ValueError, match="require_a_pony"):
        gates.assert_policy_matches_code(fake)


def test_negative_control_a_mapping_that_names_nothing_is_caught():
    """Key-set equality is not evidence of implementation. A reviewer added
    `"require_a_pony": "gates.there_is_no_such_function"` to the mapping and the
    contract ACCEPTED it -- the same defect one level up, a control that checks
    a spelling. The dotted name has to resolve to something callable."""
    fake_policy = {**POLICY, "merge_gate": {**POLICY["merge_gate"], "require_a_pony": True}}
    original = dict(gates.MERGE_GATE_IMPLEMENTED_BY)
    gates.MERGE_GATE_IMPLEMENTED_BY["require_a_pony"] = "gates.there_is_no_such_function"
    try:
        with pytest.raises(ValueError, match="not a callable"):
            gates.assert_policy_matches_code(fake_policy)
    finally:
        gates.MERGE_GATE_IMPLEMENTED_BY.clear()
        gates.MERGE_GATE_IMPLEMENTED_BY.update(original)


def test_the_gate_set_is_exactly_what_the_spec_names():
    """A silent DELETION from both the policy and the mapping is invisible to a
    both-ways key comparison -- the sets still agree, over a smaller world. The
    literal list is what discriminates, and changing it is a deliberate edit."""
    assert set(gates.MERGE_GATE_IMPLEMENTED_BY) == {
        "mergeable_must_be_known",
        "base_must_equal_origin_main",
        # #4585. Gate 1's SECOND arm. It does not replace the key above -- both
        # are listed because both are live, and the strict one still runs first.
        "stale_base_may_pass_on_an_inert_delta",
        "reduce_verdicts_by",
        "verdict_pinned_to_head",
        "require_no_red",
        "require_no_incomplete",
        "require_no_skipped_required_context",
        "advisory_red_is_a_no_go",
        "scan_closing_keywords_in",
        "closing_keyword_scan_blocks_an_undeclared_close",
        "audit_issue_numbers_around_every_merge",
    }


def test_negative_control_an_implementation_with_no_key_is_caught():
    """The other direction: a gate that blocks merges without the authority
    declaring it. Undeclared behaviour is as bad as undelivered behaviour."""
    trimmed = {k: v for k, v in POLICY["merge_gate"].items() if k != "require_no_red"}
    with pytest.raises(ValueError, match="require_no_red"):
        gates.assert_policy_matches_code({**POLICY, "merge_gate": trimmed})


def test_every_key_in_the_whole_file_is_implemented_or_declared_prose():
    """The contract used to cover two sections. Eleven keys outside them were
    read by nothing -- all four `stop_conditions`, `max_lanes_hard_ceiling`,
    `serialize_on_shared_checkout`, and the rest. An undeclared unconsulted key
    is indistinguishable from a control that stopped working, so "this one
    addresses the operator" is now written down rather than assumed."""
    assert gates.policy_keys_without_implementation(POLICY) == []


def test_negative_control_a_new_key_anywhere_in_the_file_is_caught():
    fake = {**POLICY, "wip": {**POLICY["wip"], "max_agents_per_lane": 3}}
    assert "wip.max_agents_per_lane" in gates.policy_keys_without_implementation(fake)
    fake2 = {**POLICY, "brand_new_section": {"a": 1}}
    assert "brand_new_section.a" in gates.policy_keys_without_implementation(fake2)


def test_negative_control_an_unread_key_three_levels_deep_is_caught():
    """Arm P13, and the round-4 blocker.

    This function was fixed once at TWO levels, after an independent reviewer
    planted `receipts.totally_unread_rule` and watched the suite stay green. The
    SAME reviewer then planted it one level further down -- on the very PR that
    made `receipts.ci_green_rule` a nested dict, so three-deep became the most
    likely place for a new key -- and it was invisible again. Fixing one depth
    and leaving the next is the one-side-of-a-symmetry defect this package keeps
    producing, so the walk is now unbounded rather than incremented, and this
    asserts it at the depth the fix was measured at AND one past it.
    """
    fake = copy.deepcopy(POLICY)
    fake["receipts"]["ci_green_rule"]["totally_unread_rule"] = "planted"
    missing = gates.policy_keys_without_implementation(fake)
    assert "receipts.ci_green_rule.totally_unread_rule" in missing
    with pytest.raises(ValueError, match="no implementation"):
        gates.assert_policy_matches_code(fake)

    deeper = copy.deepcopy(POLICY)
    deeper["receipts"]["ci_green_rule"]["a_new_nested_rule"] = {"unread": "planted"}
    assert (
        "receipts.ci_green_rule.a_new_nested_rule.unread"
        in gates.policy_keys_without_implementation(deeper)
    )


def test_the_walk_stops_only_where_another_instrument_takes_over():
    """`DATA_NOT_NAMESPACE` is the walk's one exemption, and an exemption with
    no stated replacement is an off switch.

    Each entry must say which instrument checks its rows, and each must name a
    key the authority actually has -- otherwise the stop is over nothing and
    reads as coverage.
    """
    for dotted, why in gates.DATA_NOT_NAMESPACE.items():
        node = POLICY
        for part in dotted.split("."):
            assert isinstance(node, dict), dotted
            assert part in node, dotted
            node = node[part]
        assert isinstance(node, dict), f"{dotted} is not a table"
        assert node, f"{dotted} stops the walk over nothing"
        assert "__tests__" in why, (
            f"{dotted} does not name the instrument that checks its rows"
        )
        assert dotted in gates.OTHER_IMPLEMENTED_BY, (
            f"{dotted} is a leaf to the walk, so it must itself be declared"
        )


def test_negative_control_a_three_deep_control_cannot_be_moved_onto_the_allow_list():
    """Arm P14, the third walker.

    `_documentation_keys_that_are_actually_read` partitioned on the FIRST dot
    and looked the remainder up as one sub-key, so for a three-level entry it
    searched the sources for the literal `"ci_green_rule.substantive_steps"` and
    could never match. That is a false negative in the direction that matters: a
    three-deep control moved onto the prose allow-list while a function still
    read it -- the allow-list becoming an off switch, at the depth this PR just
    created.
    """
    original_map = dict(gates.OTHER_IMPLEMENTED_BY)
    original_doc = set(gates.OPERATOR_DOCUMENTATION)
    gates.OTHER_IMPLEMENTED_BY.pop("receipts.ci_green_rule.substantive_steps")
    gates.OPERATOR_DOCUMENTATION.add("receipts.ci_green_rule.substantive_steps")
    try:
        with pytest.raises(ValueError, match="READ by the code"):
            gates.assert_policy_matches_code(POLICY)
    finally:
        gates.OTHER_IMPLEMENTED_BY.clear()
        gates.OTHER_IMPLEMENTED_BY.update(original_map)
        gates.OPERATOR_DOCUMENTATION.clear()
        gates.OPERATOR_DOCUMENTATION.update(original_doc)


def test_negative_control_the_allow_list_cannot_silence_a_real_control():
    """The allow-list's own edge, and the answer is yes-it-could: moving
    `wip.max_lanes` into `OPERATOR_DOCUMENTATION` used to be ACCEPTED while
    `select_cycle` still read it -- the allow-list becoming an off switch. A key
    cannot be both prose and a control."""
    original = set(gates.OPERATOR_DOCUMENTATION)
    gates.OPERATOR_DOCUMENTATION.add("wip.max_lanes")
    try:
        with pytest.raises(ValueError, match="cannot be both prose and a control"):
            gates.assert_policy_matches_code(POLICY)
    finally:
        gates.OPERATOR_DOCUMENTATION.clear()
        gates.OPERATOR_DOCUMENTATION.update(original)


def test_negative_control_moving_a_control_onto_the_allow_list_is_caught():
    """The both-lists check caught DECLARING a key twice. It did not catch
    MOVING one -- take `wip.max_lanes` out of the implemented mapping, drop it
    into the allow-list, and the contract passed while `select_cycle` still read
    it. So the property is checked directly: a key declared to be prose must not
    appear as a string literal in this package's sources."""
    original_map = dict(gates.OTHER_IMPLEMENTED_BY)
    original_doc = set(gates.OPERATOR_DOCUMENTATION)
    gates.OTHER_IMPLEMENTED_BY.pop("wip.max_lanes")
    gates.OPERATOR_DOCUMENTATION.add("wip.max_lanes")
    try:
        with pytest.raises(ValueError, match="READ by the code"):
            gates.assert_policy_matches_code(POLICY)
    finally:
        gates.OTHER_IMPLEMENTED_BY.clear()
        gates.OTHER_IMPLEMENTED_BY.update(original_map)
        gates.OPERATOR_DOCUMENTATION.clear()
        gates.OPERATOR_DOCUMENTATION.update(original_doc)


def test_negative_control_moving_a_bare_key_onto_the_allow_list_is_caught_too():
    """`repo` is read by three modules and is a TOP-LEVEL key. A scan that
    skipped bare names -- which the first version had to, to avoid colliding
    with the ledger's own `"schema"` literal -- left exactly this hole. Keying
    to the SUBSCRIPT rather than the bare literal covers it: `policy["repo"]`
    matches, `raw.get("schema")` does not, because it is keyed to `raw`."""
    original_map = dict(gates.OTHER_IMPLEMENTED_BY)
    original_doc = set(gates.OPERATOR_DOCUMENTATION)
    gates.OTHER_IMPLEMENTED_BY.pop("repo")
    gates.OPERATOR_DOCUMENTATION.add("repo")
    try:
        with pytest.raises(ValueError, match="READ by the code"):
            gates.assert_policy_matches_code(POLICY)
    finally:
        gates.OTHER_IMPLEMENTED_BY.clear()
        gates.OTHER_IMPLEMENTED_BY.update(original_map)
        gates.OPERATOR_DOCUMENTATION.clear()
        gates.OPERATOR_DOCUMENTATION.update(original_doc)


def test_negative_control_every_spelling_of_a_policy_read_is_covered(tmp_path, monkeypatch):
    """The section half accepted only `["wip"]`, so
    `policy.get("wip", {})["max_lanes"]` was missed -- and `.get(` is this
    package's DOMINANT spelling. The hole these checks exist to close, reopened
    by a refactor that looks like its neighbours."""
    spellings = [
        'policy["wip"]["max_lanes"]',
        "policy['wip']['max_lanes']",
        'policy.get("wip", {})["max_lanes"]',
        'policy.get("wip")["max_lanes"]',
        'policy["wip"].get("max_lanes")',
        'policy.get("wip", {}).get("max_lanes")',
        'POLICY["wip"]["max_lanes"]',
    ]
    original = set(gates.OPERATOR_DOCUMENTATION)
    gates.OPERATOR_DOCUMENTATION.add("wip.max_lanes")
    try:
        for spelling in spellings:
            probe = tmp_path / "probe.py"
            probe.write_text(f"cap = {spelling}\n", encoding="utf-8")
            monkeypatch.setattr(gates, "__file__", str(tmp_path / "gates.py"))
            (tmp_path / "gates.py").write_text("", encoding="utf-8")
            found = gates._documentation_keys_that_are_actually_read()
            assert "wip.max_lanes" in found, f"missed: {spelling}"
    finally:
        gates.OPERATOR_DOCUMENTATION.clear()
        gates.OPERATOR_DOCUMENTATION.update(original)


def test_an_unrelated_literal_does_not_cry_wolf():
    """The other edge, and the reason this is keyed to the subscript: a bare
    scan failed the contract on any unrelated string, blaming a policy key that
    nothing read. `schema` is the live example -- the ledger has one of its own
    and it must stay quiet."""
    assert "schema" not in gates._documentation_keys_that_are_actually_read()
    assert "scope.target" not in gates._documentation_keys_that_are_actually_read()


def test_negative_control_a_key_read_via_a_local_alias_is_caught():
    """The chained-subscript scan spans ONE LINE, and `review_requirement` reads
    its keys across two statements -- bind the section to a local, subscript the
    local on the next line. So every `review.*` key could be moved onto the
    operator-documentation allow-list undetected while the function still read
    it: the allow-list becoming an off switch, by a two-line read rather than by
    a spelling."""
    original_map = dict(gates.OTHER_IMPLEMENTED_BY)
    original_doc = set(gates.OPERATOR_DOCUMENTATION)
    gates.OTHER_IMPLEMENTED_BY.pop("review.independent_reviewers_default")
    gates.OPERATOR_DOCUMENTATION.add("review.independent_reviewers_default")
    try:
        with pytest.raises(ValueError, match="READ by the code"):
            gates.assert_policy_matches_code(POLICY)
    finally:
        gates.OTHER_IMPLEMENTED_BY.clear()
        gates.OTHER_IMPLEMENTED_BY.update(original_map)
        gates.OPERATOR_DOCUMENTATION.clear()
        gates.OPERATOR_DOCUMENTATION.update(original_doc)


def test_negative_control_deleting_a_key_from_the_authority_is_caught():
    """Flipping a boolean to false was caught; DELETING it was not. Each of
    these is read as `x.get(k, <default>)` where the default equals the shipped
    value, so removal was unobservable -- three of the five new `review.*` keys
    could be deleted with the suite fully green. The "implemented but not
    declared" direction existed for two sections and not for the third."""
    for key in ("escalate_on_blocking_first_verdict", "escalate_when_footprint_unknown",
                "independent_reviewers_default"):
        trimmed = {k: v for k, v in POLICY["review"].items() if k != key}
        with pytest.raises(ValueError, match="implemented but not declared"):
            gates.assert_policy_matches_code({**POLICY, "review": trimmed})


def test_negative_control_the_other_mapping_is_resolution_checked_too():
    """`OTHER_IMPLEMENTED_BY` was exempt from resolution, so a bogus target was
    accepted there while the same trick was refused in the two gate sections."""
    original = dict(gates.OTHER_IMPLEMENTED_BY)
    gates.OTHER_IMPLEMENTED_BY["repo"] = "gates.no_such_thing"
    try:
        with pytest.raises(ValueError, match="not a callable"):
            gates.assert_policy_matches_code(POLICY)
    finally:
        gates.OTHER_IMPLEMENTED_BY.clear()
        gates.OTHER_IMPLEMENTED_BY.update(original)


def test_a_dotted_attribute_path_resolves():
    """`ledger.Ledger.receipt_ok` is a method on a class. A resolver that only
    walked `module.attr` would reject a TRUE entry, which is the failure that
    makes people delete the check."""
    assert gates._unresolved("ledger.Ledger.receipt_ok") is None
    assert gates._unresolved("ledger.Ledger.no_such_method") is not None


def test_the_estate_verbs_are_permitted_so_a_deploy_receipt_is_reachable():
    """Operator decision 2026-09-12: resume on demand, per deploy item. Before
    they were listed, `action_is_permitted` FAILED CLOSED on both, which made
    every `deploy-run` receipt unreachable -- W1 is the stream R1 says preempts
    everything, so the run would have ended entirely parked."""
    for action in ("resume-estate", "pause-estate"):
        ok, why = gates.action_is_permitted(action, POLICY)
        assert ok, f"{action}: {why}"


def test_negative_control_a_pause_the_harness_cannot_undo_is_not_shipped():
    """Both verbs or neither. A resume the harness cannot pause again leaves the
    estate running and billing after the receipt is taken."""
    assert ("resume-estate" in POLICY["permitted_unattended"]) == (
        "pause-estate" in POLICY["permitted_unattended"]
    )


# ---------------------------------------------------------------------------
# Review requirement -- operator decision 2026-10-02: "one reviewer on
# sensitive paths, zero elsewhere on green CI. Never two." This section
# replaces the PRE-2026-10-02 escalate-to-two machinery entirely: no input
# constructed below may ever produce `2` except through the
# `escalate_on_blocking_first_verdict` override, which is a SEPARATE,
# unchanged mechanism (see `test_a_blocking_first_verdict_is_matched_by_
# shape` and its sibling, both driven through `POLICY_BLOCK_ESCALATES`
# because the shipped default does not take that branch at all).
# ---------------------------------------------------------------------------


def test_the_sensitive_path_list_is_read_from_the_authority_not_hardcoded():
    """THE defect two independent reviewers found in the same round, for the
    PREDECESSOR of this list: the policy held English sentences while a
    hardcoded tuple did the work, so the list could be emptied, inverted or
    deleted and every decision stayed identical. Editing the authority must
    change the answer.

    WHAT VALUE WOULD MAKE THIS FAIL: `gates.sensitive_path_reason` (or
    `sensitive_path_prefixes`) reading a module-level constant instead of
    `policy["review"]["sensitive_path_prefixes"]` -- emptying the list would
    then still escalate `tools/drain/gates.py`, and widening it to `docs/`
    would NOT make an unrelated `docs/` diff sensitive."""
    gutted = {**POLICY, "review": {**POLICY["review"], "sensitive_path_prefixes": []}}
    n, _ = gates.review_requirement(gutted, changed_paths=["tools/drain/gates.py"])
    assert n == 0, "emptying the authority must stop the path from being sensitive"

    widened = {**POLICY, "review": {**POLICY["review"], "sensitive_path_prefixes": ["docs/"]}}
    n, why = gates.review_requirement(widened, changed_paths=["docs/whatever.md"])
    assert n == 1, f"adding to the authority must make the path sensitive: {why}"


def test_the_default_is_read_from_the_authority():
    """The one key that WAS consulted had no test that a policy edit propagates
    -- hardcoding `default = 0` would survive, because the shipped value is 0.
    Raising it here, over an ORDINARY (non-sensitive, resolved-footprint) path,
    is the only way to tell "read from policy" apart from "hardcoded to match
    whatever ships today"."""
    raised = {**POLICY, "review": {**POLICY["review"], "independent_reviewers_default": 3}}
    n, _ = gates.review_requirement(raised, changed_paths=["docs/x.md"])
    assert n == 3


def test_the_sensitive_reviewer_count_is_read_from_the_authority():
    """The SECOND new key, same reasoning: a hardcoded `1` for a sensitive-path
    or unknown-footprint hit would survive every test that only checks `n ==
    1` against the shipped value. Both triggers are driven here so a fix to
    one that leaves the other hardcoded is still caught."""
    raised = {**POLICY, "review": {**POLICY["review"], "sensitive_reviewers": 4}}
    n, _ = gates.review_requirement(raised, changed_paths=["tools/drain/gates.py"])
    assert n == 4, "a sensitive-path hit must read sensitive_reviewers, not a literal 1"
    n, _ = gates.review_requirement(raised, changed_paths=["docs/x.md"], footprint_known=False)
    assert n == 4, "an unknown footprint must read sensitive_reviewers too"

    # NEGATIVE VALUES ARE CLAMPED, the same reason `dependency_bump_reviewers`
    # is: `len(approvals) >= -5` is an assertion no input can break.
    silly = {**POLICY, "review": {**POLICY["review"], "sensitive_reviewers": -5}}
    assert gates.sensitive_reviewers(silly) == 0


def test_no_stream_escalates_any_more_resolved_or_not():
    """THE RETIREMENT, pinned as a FACT rather than a historical note. Operator
    decision 2026-10-02 supersedes BOTH the old escalating-stream list (W0-
    harness, W2-security) AND the unresolvable-stream fail-closed -- stream
    never drives a count again, in either direction. `escalate_to_two_when_
    stream_is` is UNCHANGED in policy.json (`merge_gate.ledger_stream` still
    reads it for its own, unrelated reporting question), so a test that only
    emptied that list would prove nothing about THIS function any more.

    WHAT VALUE WOULD MAKE THIS FAIL: any reintroduction of a `stream in
    escalation_streams(policy)` (or `stream_known`) check inside
    `review_requirement` that returns non-zero for one of these rows and not
    the others."""
    for stream in ("W0-harness", "W2-security", "W1-deploy", "W3-gov",
                   "W5-console", "W6-ci", "W7-bicep", "W9-rest"):
        n, why = gates.review_requirement(POLICY, changed_paths=["domains/x.sql"],
                                          stream=stream, stream_known=True)
        assert n == 0, f"{stream} escalated: {why}"

    # The unresolved case must read IDENTICALLY to a resolved, ordinary one.
    n, why = gates.review_requirement(POLICY, changed_paths=["domains/x.sql"],
                                      stream=None, stream_known=False)
    assert n == 0, f"an unresolved stream escalated: {why}"

    # ...and an override of the now-inert key must change NOTHING, which is
    # the mirror of `test_the_sensitive_path_list_is_read_from_the_authority_
    # not_hardcoded` above: this key is NOT supposed to move the answer any
    # more, and a test that did not check that could not tell a retired
    # control from one quietly still wired.
    widened = {**POLICY, "review": {**POLICY["review"],
                                    "escalate_to_two_when_stream_is": ["W9-rest"]}}
    n, _ = gates.review_requirement(widened, changed_paths=["domains/x.sql"],
                                    stream="W9-rest", stream_known=True)
    assert n == 0, "the retired stream list must have no effect on the count"


def test_negative_control_an_unknown_footprint_fails_closed_to_one_not_two():
    """28 of 299 live items carry no lane, so `changed_paths=[""]` matched
    nothing and they got ONE reviewer under the old policy. Under the new one
    the floor is still a floor -- an unknown footprint still fails closed,
    just to `sensitive_reviewers` (1) rather than 2."""
    n, why = gates.review_requirement(POLICY, changed_paths=[], footprint_known=False)
    assert n == 1
    assert "not known" in why

    # The authority still switches it off.
    opened = {**POLICY, "review": {**POLICY["review"],
                                   "escalate_when_footprint_unknown": False}}
    n, _ = gates.review_requirement(opened, changed_paths=[], footprint_known=False)
    assert n == 0


def test_every_lane_label_in_the_repo_maps_to_a_path():
    """A lane with no mapping fell through to the default. `lane:docs` exists on
    GitHub and had no entry, so it silently yielded one reviewer with no error."""
    for lane in ("lane:console", "lane:bicep", "lane:ci", "lane:dataplane", "lane:docs"):
        assert lane in gates.LANE_PATHS, lane


def test_negative_control_each_lane_is_pinned_individually():
    """Of the five lanes, exactly ONE maps to a path on the NEW sensitive list:
    `lane:bicep` -> `platform/fiab/bicep`, added 2026-10-02. The other four are
    bare directory roots that match no sensitive prefix (the sensitive entries
    under `apps/fiab-console` are specific sub-paths, and `lane:console`'s bare
    root is not one of them). Breaks if `platform/fiab/bicep` is ever dropped
    from `sensitive_path_prefixes` without updating this test, or if a bare
    lane root is ever added to it (which would re-escalate every item in that
    lane regardless of which file within it changed)."""
    expected = {
        "lane:console": 0,
        "lane:bicep": 1,
        "lane:ci": 0,
        "lane:dataplane": 0,
        "lane:docs": 0,
    }
    for lane, want in expected.items():
        n, why = gates.review_requirement(
            POLICY, changed_paths=[gates.LANE_PATHS[lane]], stream="W9-rest")
        assert n == want, f"{lane} -> {n}, expected {want}: {why}"


#: Every fragment in `sensitive_path_prefixes`, with a real file that lands on
#: it. The fragment itself is NOT the test input -- a test that fed the list
#: back into itself would pass over an empty list and prove nothing. Written
#: out by hand so that deleting a row from the authority makes a NAMED case
#: fail. `platform/fiab/bicep` and `apps/fiab-console/lib/access` are NEW
#: 2026-10-02; the other five are the PRE-2026-10-02 two-reviewer list,
#: carried over at the new one-reviewer count.
SENSITIVE_PATHS = [
    ("tools/drain", "tools/drain/gates.py"),
    ("dev-loop/gates", "dev-loop/gates/validate-all.ps1"),
    (".github/CODEOWNERS", ".github/CODEOWNERS"),
    ("platform/fiab/bicep", "platform/fiab/bicep/main.bicep"),
    ("apps/fiab-console/lib/auth", "apps/fiab-console/lib/auth/authflow.ts"),
    ("apps/fiab-console/lib/access", "apps/fiab-console/lib/access/policy.ts"),
    ("apps/fiab-console/middleware.ts", "apps/fiab-console/middleware.ts"),
]


@pytest.mark.parametrize(("fragment", "path"), SENSITIVE_PATHS)
def test_negative_control_each_sensitive_path_fragment_is_pinned(fragment, path):
    """Parametrized rather than looped so a deletion names the row it lost."""
    n, why = gates.review_requirement(POLICY, changed_paths=[path], stream="W9-rest")
    assert n == 1, f"{fragment!r} via {path}: {why}"


#: Paths that look plausible but must NOT match a sensitive entry, pinning the
#: boundary-safety `path_is_on_sensitive_prefix_list` exists for -- the same
#: hazard `path_is_on_bump_allowlist`'s docstring records measured examples of.
NOT_SENSITIVE_BY_BOUNDARY = [
    "evil-tools/drainpipe/x.py",
    "tools/drainage/x.py",
    "x/dev-loop/gatesfoo/y.ps1",
    "apps/fiab-console-two/middleware.ts",
    "apps/fiab-console/lib/authentication/other.ts",
]


@pytest.mark.parametrize("path", NOT_SENSITIVE_BY_BOUNDARY)
def test_negative_control_a_sensitive_fragment_has_a_boundary(path):
    """EIGHT of nine analogous rows took the bump-allowlist exemption before
    `path_is_on_bump_allowlist` existed (measured at `9d8952420`). The same
    unanchored `startswith`/`in` shape over THIS list would admit every path
    here. WHAT VALUE WOULD MAKE THIS FAIL: `path_is_on_sensitive_prefix_list`
    losing its segment boundary and reverting to a bare substring/prefix test."""
    n, why = gates.review_requirement(POLICY, changed_paths=[path], stream="W9-rest")
    assert n == 0, f"{path} wrongly matched a sensitive fragment: {why}"


DEPLOY_WORKFLOWS = [
    ".github/workflows/deploy-fiab-commercial.yml",
    ".github/workflows/deploy-gov.yml",
]


@pytest.mark.parametrize("path", DEPLOY_WORKFLOWS)
def test_a_deploy_workflow_file_is_sensitive(path):
    """The SHAPE match, not a literal list entry -- `.github/workflows/` was
    DROPPED from the authority entirely on 2026-10-01 (an under-anchored
    fragment there once made `docs/how-we-deploy/notes.md` escalate), and the
    new shape-matcher deliberately narrows back to only a `deploy-*` basename
    directly in that one directory."""
    n, why = gates.review_requirement(POLICY, changed_paths=[path], stream="W9-rest")
    assert n == 1, f"{path}: {why}"


NOT_DEPLOY_WORKFLOWS = [
    # basename does not START WITH `deploy-` -- contains the word, is not it.
    ".github/workflows/post-deploy-bootstrap.yml",
    ".github/workflows/csa-loom-deploy-check.yml",
    # right directory, nested -- workflows do not nest, and this must not
    # silently qualify a stray subdirectory either.
    ".github/workflows/nested/deploy-x.yml",
    # right basename, wrong directory.
    "scripts/ci/deploy-helpers/deploy-x.sh",
]


@pytest.mark.parametrize("path", NOT_DEPLOY_WORKFLOWS)
def test_negative_control_the_deploy_workflow_shape_has_a_boundary(path):
    """WHAT VALUE WOULD MAKE THIS FAIL: `path_is_a_deploy_workflow` degrading to
    a substring test (`"deploy-" in path`) or dropping its directory check."""
    n, why = gates.review_requirement(POLICY, changed_paths=[path], stream="W9-rest")
    assert n == 0, f"{path} wrongly matched the deploy-workflow shape: {why}"
    assert not gates.path_is_a_deploy_workflow(path), path


API_LIB_HELPERS = [
    "apps/fiab-console/app/api/lakehouse/_lib/shortcut-credentials.ts",
    "apps/fiab-console/app/api/warehouse/sql/_lib/auth.ts",
]


@pytest.mark.parametrize("path", API_LIB_HELPERS)
def test_an_api_lib_helper_is_sensitive(path):
    """`apps/fiab-console/app/api/**/_lib` -- a path SEGMENT, matched as a
    shape because no literal-prefix list can express "any depth, one exact
    segment name" without a false-friend hazard (`_libxyz`, `foo_lib`)."""
    n, why = gates.review_requirement(POLICY, changed_paths=[path], stream="W9-rest")
    assert n == 1, f"{path}: {why}"


NOT_API_LIB_HELPERS = [
    # a segment that merely CONTAINS `_lib`, not equal to it.
    "apps/fiab-console/app/api/lakehouse/_libxyz/x.ts",
    "apps/fiab-console/app/api/lakehouse/foo_lib/x.ts",
    # right segment name, wrong tree entirely.
    "apps/some-other-app/app/api/x/_lib/y.ts",
    # the API tree itself, no `_lib` segment anywhere in it.
    "apps/fiab-console/app/api/lakehouse/route.ts",
]


@pytest.mark.parametrize("path", NOT_API_LIB_HELPERS)
def test_negative_control_the_api_lib_shape_has_a_boundary(path):
    """WHAT VALUE WOULD MAKE THIS FAIL: `path_is_an_api_lib_helper` testing
    `"_lib" in path` (a substring) instead of splitting into segments."""
    n, why = gates.review_requirement(POLICY, changed_paths=[path], stream="W9-rest")
    assert n == 0, f"{path} wrongly matched the api-_lib shape: {why}"
    assert not gates.path_is_an_api_lib_helper(path), path


def test_an_ordinary_lane_gets_no_reviewer_on_green_ci():
    """THE CONTROL for the new default. Without it, every assertion of `n == 0`
    above could be "always zero" rather than "zero because this path is
    ordinary"."""
    n, why = gates.review_requirement(POLICY, changed_paths=["domains/sales/models/x.sql"])
    assert n == 0, why


def test_never_two_for_any_input_this_function_accepts():
    """THE SWEEP. Operator decision 2026-10-02 is absolute: "never two, for any
    reason" except the pre-existing, UNCHANGED `escalate_on_blocking_first_
    verdict` branch (which ships `false`, so it cannot fire through POLICY at
    all -- `test_a_blocking_first_verdict_no_longer_escalates_by_default`
    below pins that it does not). Every OTHER combination of inputs below must
    return 0 or 1, never 2, under the shipped POLICY."""
    paths = ["domains/x.sql", "tools/drain/gates.py", ".github/CODEOWNERS",
             "platform/fiab/bicep/main.bicep", ".github/workflows/deploy-x.yml",
             "apps/fiab-console/app/api/x/_lib/y.ts", ""]
    streams = [None, "W0-harness", "W2-security", "W9-rest", "W1-deploy"]
    for path in paths:
        for stream in streams:
            for stream_known in (True, False):
                for footprint_known in (True, False):
                    for dependency_bump in (True, False):
                        n, why = gates.review_requirement(
                            POLICY, changed_paths=[path], stream=stream,
                            stream_known=stream_known, footprint_known=footprint_known,
                            dependency_bump=dependency_bump,
                        )
                        assert n in (0, 1), (
                            f"got {n} (never 2) for path={path!r} stream={stream!r} "
                            f"stream_known={stream_known} footprint_known={footprint_known} "
                            f"dependency_bump={dependency_bump}: {why}"
                        )


def test_a_blocking_first_verdict_no_longer_escalates_by_default():
    """Operator directive 2026-10-01 (`_lean_review_2026_10_01`):
    `escalate_on_blocking_first_verdict` ships `false`, so a REQUEST-CHANGES-
    shaped prior verdict no longer raises the count on its own under the real
    POLICY -- it now falls all the way through to the ORDINARY default (0),
    not to 1, since 2026-10-02 dropped the default from 1 to 0. Breaks if the
    shipped key reverts to `true`, or the `and prior_verdict` guard in
    `review_requirement` stops reading it."""
    for spelling in ("REQUEST-CHANGES", "CHANGES REQUIRED", "CANNOT-ASSESS"):
        n, why = gates.review_requirement(POLICY, changed_paths=["docs/x.md"],
                                          prior_verdict=spelling)
        assert n == 0, f"{spelling!r} escalated under the lean default: {why}"


def test_negative_control_a_blocking_first_verdict_is_matched_by_shape():
    """Shape, not spelling -- pinned against `POLICY_BLOCK_ESCALATES`, since the
    shipped default (test above) no longer exercises this branch at all. This
    branch is UNCHANGED by the 2026-10-02 decision and still returns the
    literal `2` it always has -- `review_requirement`'s docstring and
    `gates.py`'s own comment say so: "leave this branch alone"."""
    for spelling in ("REQUEST-CHANGES", "request-changes", "REQUEST-CHANGES ",
                     "## Independent review - REQUEST-CHANGES", "CHANGES REQUIRED",
                     "CANNOT-ASSESS"):
        n, why = gates.review_requirement(POLICY_BLOCK_ESCALATES, changed_paths=["docs/x.md"],
                                          prior_verdict=spelling)
        assert n == 2, f"{spelling!r}: {why}"
    # The control: with the override on but NO block, the ordinary (now-zero)
    # default applies -- this branch escalates on a BLOCK, not on being on.
    n, _ = gates.review_requirement(POLICY_BLOCK_ESCALATES, changed_paths=["docs/x.md"],
                                    prior_verdict="APPROVE")
    assert n == 0


def test_negative_control_the_deploy_fragment_is_anchored():
    """PRE-2026-10-01 a bare substring made `docs/how-we-deploy/notes.md`
    escalate while `deploy/` itself correctly required two. Neither is on the
    authority any more in ANY form (the 2026-10-02 shape-matcher only ever
    looks at `.github/workflows/deploy-*`), so both now get the ordinary
    (zero) count -- pinned together so a reader does not mistake "no longer
    sensitive" for a regression of the anchoring fix."""
    n, _ = gates.review_requirement(POLICY, changed_paths=["docs/how-we-deploy/notes.md"])
    assert n == 0
    n, _ = gates.review_requirement(POLICY, changed_paths=["deploy/main.bicep"])
    assert n == 0


def test_negative_control_a_sensitive_path_diff_needs_exactly_one_approval():
    """W0 took nine rounds with two reviewers because it WAS the merge gate.
    Operator decision 2026-10-02 lowers that floor to ONE -- not zero, and
    never back to two -- for the paths whose failure modes a single reviewer
    has been observed to miss. `SENSITIVE_PATHS` above pins each fragment
    individually; this re-states the property over the whole set at once."""
    for fragment, path in SENSITIVE_PATHS:
        n, why = gates.review_requirement(POLICY, changed_paths=[path])
        assert n == 1, f"{fragment!r} via {path} must need exactly one: {why}"


# ---------------------------------------------------------------------------
# `worst_verdict_in_history` / `parse_verdicts` -- the verdict-history scan.
# UNCHANGED by the 2026-10-02 review-count decision; kept here because this
# is where the suite has always exercised them.
# ---------------------------------------------------------------------------


def _verdict(cid, when, body):
    return {"id": cid, "created_at": when, "body": body}


def test_negative_control_the_verdict_history_reduces_worst_first_not_by_time():
    """THE race. `gates.py` used to return the EARLIEST verdict-bearing comment
    and stop, which a reviewer broke by swapping two comments.

    On this repo the two verdicts of a round land within a second of each other
    -- measured on PR #4488's own round 5: `5644049925` at 06:01:07Z
    (REQUEST-CHANGES) and `5644050042` at 06:01:08Z (APPROVE). The drain launches
    its reviewers in parallel and both post under the operator's login, so which
    lands first is arbitrary; an APPROVE winning that race disarmed the trigger
    on half of all parallel double-reviews. The property wanted is "a block
    occurred", so the reduction is conjunction, not recency.

    Kills MG16."""
    approve_first = [
        _verdict(1, "2026-09-12T06:01:07Z", "## Independent review - APPROVE\n\nfine."),
        _verdict(2, "2026-09-12T06:01:08Z",
                 "## Independent review - REQUEST-CHANGES\n\nthe guard is open."),
    ]
    assert gates.worst_verdict_in_history(approve_first) == "REQUEST-CHANGES"
    # ...and the order genuinely does not matter.
    assert gates.worst_verdict_in_history(list(reversed(approve_first))) \
        == "REQUEST-CHANGES"
    # The control: all-approving history reports an approval, not a phantom block.
    assert gates.worst_verdict_in_history(approve_first[:1]) == "APPROVE"
    assert gates.worst_verdict_in_history([]) is None


def test_the_verdict_is_read_from_the_announcing_line_and_not_from_prose():
    """THE ONE PLACE THE TWO REVIEWERS DISAGREED, resolved by this module's own
    principle rather than by recency.

    Round 6, reviewer A: the docstring claimed a blocking token ANYWHERE in the
    window wins, while `_token_of` reads the announcing line only -- a claim
    about code that did not exist. They offered two remedies: narrow the
    sentence, or add a flat scan. I added the flat scan.

    Round 7, reviewer B measured what it cost: a clean approval whose prose
    NAMED a prior block read as a block. That is verbatim the hazard
    `_token_of`'s docstring records as deliberately avoided -- "an approving
    review whose prose mentioned the other spellings registered as a block".

    Their two inputs are the SAME SHAPE, a token in prose below an announcing
    line, so no rule satisfies both. POSITION, not idiom, is the rule the rest
    of this module is built on, so it wins here too. Kills MG17."""
    # Reviewer B's input: an approval that cites a block must stay an approval.
    cites_a_block = [_verdict(
        1, "2026-09-12T06:00:00Z",
        "## Independent review - APPROVE\n\nAddresses the prior REQUEST-CHANGES "
        "cleanly; retested end to end.",
    )]
    assert gates.worst_verdict_in_history(cites_a_block) == "APPROVE"

    # ...and the asymmetry that DOES exist, and is enough: within the announcing
    # line, tokens are read in VERDICT_TOKENS order, so a hedged header resolves
    # to the block. Formatting cannot REDUCE a block; it just has to be on the
    # line that announces.
    hedged_header = [_verdict(
        1, "2026-09-12T06:00:00Z",
        "## Independent review - APPROVE / REQUEST-CHANGES on the lane route",
    )]
    assert gates.worst_verdict_in_history(hedged_header) == "REQUEST-CHANGES"


def test_negative_control_the_history_scan_sees_every_shape_gate_two_three_blocks_on():
    """ONE POPULATION, NOT TWO. The hand-rolled scan was STRICTER than the gate
    it feeds -- it required a well-formed marker line -- so four shapes gate 2+3
    blocks on raised no count at all, and each merged on a single approval after
    a push. A reviewer measured all four end to end through the composed gate.

    The third is the sharpest: `review_requirement` carries a dedicated
    `"CHANGES REQUIRED"` branch with an arm and a direct unit test, and the only
    production producer of `prior_verdict` could never emit a string containing
    it. A trigger proved against the FUNCTION and never against the CALLER --
    verbatim the defect the same round claimed to repair one function over.

    Kills MG17, MG27."""
    #: label -> (body, the near-miss KIND it must be reported as, or None when
    #: it is a real live verdict attributable to a reviewer).
    #:
    #: The last two are the ones the first version of this test had no fixture
    #: for, so `review_requirement` wrote the `no-marker` sentence about them
    #: and nothing noticed: `no-token` is a comment that DOES announce and
    #: carries no token at all, and `template-line` announces on its first
    #: line -- "no line announcing a verdict" is false of both. The old
    #: assertion compared the reason to the TAG, which is a test that the code
    #: is self-consistent, not that it is TRUE of the comment.
    shapes = {
        "misspelled marker": (
            "Re-review - REQUEST-CHANGES\n\nthe lane route is open.",
            gates.NEAR_NO_MARKER,
        ),
        "marker not first": (
            "Quick note before the verdict.\n\nIndependent review - REQUEST-CHANGES",
            gates.NEAR_NO_MARKER,
        ),
        "block spelled wrong": (
            "## Independent re-review - CHANGES REQUIRED\n\nno.",
            gates.NEAR_NO_TOKEN,
        ),
        "marker relayed in a fence": (
            "```\nIndependent review - REQUEST-CHANGES\n```",
            gates.NEAR_NO_MARKER,
        ),
        "announces, token below the window": (
            "Independent re-review of PR #4488\n\n" + "x" * 220 + "REQUEST-CHANGES",
            gates.NEAR_NO_TOKEN,
        ),
        "the template line itself": (
            ("Independent re-review - APPROVE / REQUEST-CHANGES / CANNOT-ASSESS\n\n"
            "(paste your verdict above)"),
            gates.NEAR_TEMPLATE,
        ),
        # NO MARKER AND NO TEMPLATE -- ordinary prose that happens to name all
        # three outcomes, which is how this repo's own review threads talk. A
        # reviewer measured it being told it "carries the verdict TEMPLATE
        # line", and that was a REGRESSION: the blanket sentence it replaced was
        # accidentally TRUE of this shape, so the per-kind fix made one sub-case
        # worse while fixing two others. The KIND is right -- `_saw_template`
        # only ever established "a line lists all three tokens" -- so the
        # remedy was the wording, and this fixture asserts the SENTENCE.
        "prose naming all three outcomes": (
            ("This module's policy allows APPROVE, REQUEST-CHANGES, or "
             "CANNOT-ASSESS as outcomes.\nI think this should get APPROVE "
             "overall, nice work."),
            gates.NEAR_TEMPLATE,
        ),
    }
    for label, (body, kind) in shapes.items():
        got = gates.worst_verdict_in_history([_verdict(1, "2026-09-12T06:00:00Z", body)])
        # Every one carries a blocking token by construction, so
        # `review_requirement`'s shape-match fires. None is attributable to a
        # reviewer's DECISION, so each comes back TAGGED with its kind and its
        # comment -- a permanent escalation nobody can locate is worse than one
        # they can argue with, and one that names the wrong cause is worse still.
        assert "REQUEST-CHANGES" in got, label
        assert got.startswith(gates.UNANNOUNCED_BLOCK), label
        assert f"({kind}," in got, f"{label}: wrong kind in {got}"
        # POLICY_BLOCK_ESCALATES, not POLICY: the shipped default no longer
        # routes a prior verdict into the count at all (`_lean_review_2026_10_
        # 01`), so this integration check drives the override to keep proving
        # the SHAPE-MATCHING logic still exists and is wired correctly.
        n, why = gates.review_requirement(POLICY_BLOCK_ESCALATES, changed_paths=["docs/x.md"],
                                          prior_verdict=got)
        assert n == 2, label
        # THE REASON MUST BE TRUE OF THE COMMENT, not merely consistent with
        # the tag. Kills MG32.
        assert gates.UNANNOUNCED_REASON_BY_KIND[kind] in why, f"{label}: {why}"
        for other, sentence in gates.UNANNOUNCED_REASON_BY_KIND.items():
            if other != kind:
                assert sentence not in why, f"{label} got {other}'s sentence"
        # ...and gate 2+3 agrees, which is the point of sharing the population.
        live, near = gates.parse_verdicts(
            [_verdict(1, "2026-09-12T06:00:00Z", body)], "2026-09-12T05:00:00Z"
        )
        blocked, _why = gates.reduce_verdicts(live, near)
        assert not blocked, label


def test_negative_control_an_unrecognised_kind_gets_no_confident_sentence():
    """`UNANNOUNCED_REASON_UNKNOWN` is the safety net for the defect round 9
    blocked on, and it had no fixture and no arm.

    A reviewer mutated ONLY the `.get` default -- leaving the three known kinds
    alone, which is all the other fixtures exercise -- and the suite stayed
    green while an unknown kind was handed the `no-marker` sentence verbatim.
    That is round 9's blocker, reachable again, over a 150/150 matrix. A
    fallback nobody drives is a control nobody has.

    Kills MG36. Driven through `POLICY_BLOCK_ESCALATES` -- see that constant's
    docstring -- since the shipped default no longer routes a prior verdict
    into the count at all."""
    tagged = f"{gates.UNANNOUNCED_BLOCK} (brand-new-kind, comment 7)"
    n, why = gates.review_requirement(POLICY_BLOCK_ESCALATES, changed_paths=["docs/x.md"],
                                      prior_verdict=tagged)
    assert n == 2, "an unrecognised kind still fails closed"
    assert gates.UNANNOUNCED_REASON_UNKNOWN in why, why
    # ...and it must not borrow any KNOWN kind's sentence, which is exactly what
    # the surviving mutation did.
    for sentence in gates.UNANNOUNCED_REASON_BY_KIND.values():
        assert sentence not in why, f"borrowed a known kind's sentence: {why}"


def test_negative_control_prose_under_an_approve_header_reports_nothing():
    """The other reviewer's complaint, and the same fix answers it. A comment
    whose FIRST line announces APPROVE is a LIVE APPROVE, so `parse_verdicts`
    emits no near-miss and the prose beneath it -- citing a prior round, linking
    one, quoting one, showing one in a fence -- cannot turn it into a block.

    All five of these read as blocks under the hand-rolled flat scan, including
    the first, which is the ordinary opening sentence of a re-review."""
    approvals = [
        ("## Independent re-review - APPROVE\n\nRound 6's REQUEST-CHANGES findings "
        "are all discharged."),
        ("## Independent re-review - APPROVE\n\nSee .../pull/1#issuecomment-1 "
        "(REQUEST-CHANGES, round 5)."),
        ("## Independent re-review - APPROVE\n\n- fix(drain): stop emitting "
        "REQUEST-CHANGES on a template line"),
        "## Independent re-review - APPROVE\n\n> Independent review - REQUEST-CHANGES",
        "## Independent re-review - APPROVE\n\n```\nREQUEST-CHANGES\n```",
    ]
    for body in approvals:
        assert gates.worst_verdict_in_history(
            [_verdict(1, "2026-09-12T06:00:00Z", body)]
        ) == "APPROVE", body[:60]


def test_negative_control_a_comment_with_no_timestamp_still_blocks():
    """`min()` over the timestamps returned `""` when ANY comment lacked one,
    the fallback kicked in, and that comment then failed `"" >= "0000-..."` --
    so `parse_verdicts` classified it PREDATES-HEAD, `blocks=False`, and its
    verdict was silently dropped. A reviewer measured all three shapes as a
    REGRESSION against the hand-rolled version, in the losing direction: an
    escalation lost, which is the direction this package never accepts.

    A comment with no timestamp cannot be PINNED. That is not the same as
    predating, and `parse_verdicts` already has the right answer for it --
    unpinnable, and it blocks. Kills MG28, MG30."""
    block = "## Independent review - REQUEST-CHANGES\n\nno."
    approve = "## Independent re-review - APPROVE\n\nfixed."

    # Every comment unstamped.
    assert gates.worst_verdict_in_history(
        [{"id": 1, "body": block}]
    ) == "REQUEST-CHANGES"
    # The BLOCK unstamped, an approval stamped -- the shape that returned
    # APPROVE, i.e. a real block erased by a sibling that happened to have a
    # timestamp.
    assert gates.worst_verdict_in_history([
        {"id": 1, "body": block},
        _verdict(2, "2026-09-12T06:00:00Z", approve),
    ]) == "REQUEST-CHANGES"
    # Present but empty is the same case.
    assert gates.worst_verdict_in_history(
        [_verdict(1, "", block)]
    ) == "REQUEST-CHANGES"
    # The control: unstamped approvals stay approvals, so this is not simply
    # "anything unpinnable blocks".
    assert gates.worst_verdict_in_history([{"id": 1, "body": approve}]) == "APPROVE"


def test_negative_control_the_history_scan_does_not_pin_to_the_head():
    """Deliberate, and the opposite of `parse_verdicts`. A block from before a
    push is no longer a LIVE verdict -- correctly -- but it is still true that a
    reviewer blocked, and that is the fact this trigger asks about. Pinning here
    would make the push that voids the block also void the escalation, which is
    the block-push-reapprove hole in the first place."""
    history = [
        _verdict(1, "2026-01-01T00:00:00Z",
                 "## Independent review - REQUEST-CHANGES\n\nno."),
        _verdict(2, "2026-12-31T00:00:00Z", "## Independent re-review - APPROVE\n\nok."),
    ]
    assert gates.worst_verdict_in_history(history) == "REQUEST-CHANGES"
    # `parse_verdicts` pinned to a head after the block reports it NOT live --
    # the two functions disagreeing is the point, so assert it here too.
    live, _near = gates.parse_verdicts(history, "2026-06-01T00:00:00Z")
    assert [v.token for v in live] == ["APPROVE"]


def test_negative_control_a_bare_reference_scan_does_not_invent_references():
    """A verb-anchored scan can afford a loose reference alphabet; the verb does
    the discriminating. Without one, `#\\d+` matched a hex colour, a Markdown
    heading anchor and a foreign repo's issue -- all measured by a reviewer.

    Over-matching is not harmless here. `ledger_stream` prefers any escalating
    stream, so a stray reference usually only RAISES the count -- but a
    W1-deploy fix citing only a non-escalating item resolves `stream_known=True`
    and gets ONE reviewer, where no reference at all would have failed closed to
    two. A false reference buys a weaker gate. Kills MG18, MG19."""
    repo = "fgarofalo56/csa-inabox"
    must_not_match = [
        "colour #1f2937 in the theme",
        "[link](#42-the-section)",
        "upstream astral-sh/ruff#12345",
        "https://github.com/astral-sh/ruff/issues/12345",
    ]
    for text in must_not_match:
        assert gates.referenced_issues(text, [], repo=repo) == [], text

    must_match = [
        ("Refs #4487 - stays open", [4487]),
        ("see GH-4468 for context", [4468]),
        # LOWERCASE, which is the regression MG24 names and which the first
        # version of this list did not carry: `GH-` matches the literal with or
        # without the flag, so the uppercase case cannot tell the two apart.
        # MG24 SURVIVED on that. The example in an arm's name has to be IN a
        # fixture, or the arm is pinned by its own prose.
        ("see gh-4468 for context", [4468]),
        # Markdown emphasis, both spellings. `_` is a `\w` character, so an
        # underscore-emphasised reference resolved to nothing while the asterisk
        # form worked -- and a MISSED mention can only lose an escalation, the
        # wrong direction for a control that fails closed everywhere else.
        ("_#4488_ is the harness PR", [4488]),
        ("*#4487* is the receipt issue", [4487]),
        (f"tracked at {repo}#4485", [4485]),
        (f"https://github.com/{repo}/issues/4485", [4485]),
    ]
    for text, expected in must_match:
        assert gates.referenced_issues(text, [], repo=repo) == expected, text

    # The commit trail is scanned too -- a squash publishes the whole thing.
    assert gates.referenced_issues("", ["feat: x\n\nRefs #4487"], repo=repo) == [4487]
    # No repo means the qualified forms cannot be attributed, so they are not
    # accepted: an unqualified caller cannot tell whose #123 it is looking at.
    assert gates.referenced_issues(f"{repo}#4485", [], repo=None) == []


def test_the_hard_ceiling_is_a_control_not_a_comment():
    import tick

    over = {**POLICY, "wip": {**POLICY["wip"], "max_lanes": 99}}
    with pytest.raises(SystemExit, match="hard_ceiling"):
        tick.select_cycle(_empty_ledger(), over)


def _empty_ledger():
    from ledger import Ledger

    return Ledger("unused", receipts=POLICY["receipts"])


def test_the_documentation_key_is_exempt():
    """Keys starting with `_` carry rationale prose by convention, and a check
    that flagged them would be ignored within a week."""
    assert "merge_gate._" not in gates.policy_keys_without_implementation(POLICY)


def test_the_constants_match_what_the_policy_declares():
    """`marker_any_of` and `token_any_of` duplicated hardcoded tuples. A value
    that can drift from its own authority is not configuration, it is a second
    copy that will silently disagree."""
    assert list(gates.MARKERS) == POLICY["verdict_parsing"]["marker_any_of"]
    assert list(gates.VERDICT_TOKENS) == POLICY["verdict_parsing"]["token_any_of"]


def test_the_window_default_matches_the_policy():
    import inspect

    default = inspect.signature(gates.parse_verdicts).parameters["window"].default
    assert default == POLICY["verdict_parsing"]["token_window_chars"]


def test_the_removed_keys_record_why_rather_than_vanishing():
    """A capability that is dropped must leave a reason where the next reader
    looks, or it gets re-added by someone reading the PRP."""
    with open(POLICY_PATH, encoding="utf-8") as handle:
        raw = json.load(handle)
    removed = [k for k in raw["merge_gate"] if k.startswith("_removed")]
    assert removed, "dropped gates must be recorded, not deleted"
    for key in removed:
        assert len(raw["merge_gate"][key]) > 80, f"{key} needs the reason, not a stub"


def test_the_policy_names_the_repo_and_the_receipt_classes():
    assert POLICY["repo"] == "fgarofalo56/csa-inabox"
    classes = {k for k in POLICY["receipts"] if not k.startswith("_") and not k.endswith("_rule")}
    assert classes == {
        "guard-or-test-only", "deploy-path", "estate-behaviour", "ui-surface", "human-only"
    }


def test_the_stop_and_ask_list_is_not_empty_and_carries_reasons():
    """A stop-and-ask entry with no reason is a rule nobody can evaluate."""
    actions = gates.stop_and_ask_actions(POLICY)
    assert len(actions) >= 5
    for action in actions:
        assert len(POLICY["stop_and_ask"][action]) > 20, f"{action} has no stated reason"
