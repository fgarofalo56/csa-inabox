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

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import gates

POLICY_PATH = os.path.join(os.path.dirname(__file__), "..", "policy.json")
POLICY = gates.load_policy(POLICY_PATH)


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
        "reduce_verdicts_by",
        "verdict_pinned_to_head",
        "require_no_red",
        "require_no_incomplete",
        "require_no_skipped_required_context",
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


def test_the_escalation_list_is_read_from_the_authority_not_hardcoded():
    """THE defect two independent reviewers found in the same round: the policy
    held four English sentences while a hardcoded `ESCALATION_PATHS` tuple did
    the work, so the list could be emptied, inverted or deleted and every
    decision stayed identical. That is `marker_any_of` reintroduced one release
    after it was fixed. Editing the authority must change the answer."""
    gutted = {**POLICY, "review": {**POLICY["review"],
                                   "escalate_to_two_when_path_contains": []}}
    n, _ = gates.review_requirement(gutted, changed_paths=["tools/drain/gates.py"])
    assert n == 1, "emptying the authority must stop escalating"

    widened = {**POLICY, "review": {**POLICY["review"],
                                    "escalate_to_two_when_path_contains": ["docs/"]}}
    n, why = gates.review_requirement(widened, changed_paths=["docs/whatever.md"])
    assert n == 2, f"adding to the authority must start escalating: {why}"


def test_the_default_is_read_from_the_authority():
    """The one key that WAS consulted had no test that a policy edit propagates
    -- hardcoding `default = 1` survived, because the shipped value is 1."""
    raised = {**POLICY, "review": {**POLICY["review"], "independent_reviewers_default": 3}}
    n, _ = gates.review_requirement(raised, changed_paths=["docs/x.md"])
    assert n == 3


def test_negative_control_the_guard_stream_escalates_on_its_own():
    """W6-ci IS the guard stream and the policy's own sentence says "or any
    guard". It was covered only INCIDENTALLY -- `stream_for` assigns W6-ci
    BECAUSE the item carries `lane:ci`, which maps to `scripts/ci`, which
    escalates by path. But `stream` is pinned from the inventory snapshot while
    `lane` is refreshed from live labels every tick, so a relabel decouples
    them. Measured before the fix: W6-ci with `lane:dataplane` got ONE."""
    for lane_path in ("domains/", "docs/"):
        n, why = gates.review_requirement(POLICY, changed_paths=[lane_path], stream="W6-ci")
        assert n == 2, f"W6-ci via {lane_path}: {why}"


def test_the_stream_escalates_whatever_the_diff_touches():
    """A lane is a guess about the footprint; a stream is a fact about the work.
    Every W0-harness item is a `tools/drain` diff by construction."""
    for stream in ("W0-harness", "W1-deploy", "W2-security", "W5-console", "W7-bicep"):
        n, why = gates.review_requirement(POLICY, changed_paths=[], stream=stream)
        assert n == 2, f"{stream}: {why}"
    n, _ = gates.review_requirement(POLICY, changed_paths=["domains/x.sql"],
                                    stream="W8-dataplane")
    assert n == 1


def test_negative_control_an_unknown_footprint_fails_closed():
    """28 of 299 live items carry no lane, so `changed_paths=[""]` matched
    nothing and they got ONE reviewer -- including all four W0-harness items and
    nine W1-deploy ones, i.e. exactly the diffs the policy says need two. Every
    sibling control in this module fails closed; this one fell open."""
    n, why = gates.review_requirement(POLICY, changed_paths=[], footprint_known=False)
    assert n == 2
    assert "not known" in why


def test_every_lane_label_in_the_repo_maps_to_a_path():
    """A lane with no mapping fell through to the default. `lane:docs` exists on
    GitHub and had no entry, so it silently yielded one reviewer with no error."""
    for lane in ("lane:console", "lane:bicep", "lane:ci", "lane:dataplane", "lane:docs"):
        assert lane in gates.LANE_PATHS, lane


def test_negative_control_each_escalating_lane_is_pinned_individually():
    """Arms that deleted the bicep and ci rows both SURVIVED a full suite: 31 and
    33 laned items would silently drop from two reviewers to one, over a green
    93/93 matrix."""
    for lane, expected in (("lane:console", 2), ("lane:bicep", 2),
                           ("lane:ci", 2), ("lane:dataplane", 1), ("lane:docs", 1)):
        n, why = gates.review_requirement(
            POLICY, changed_paths=[gates.LANE_PATHS[lane]], stream="W9-rest")
        assert n == expected, f"{lane} -> {n}, expected {expected}: {why}"


#: Every fragment in `escalate_to_two_when_path_contains`, with a real file
#: that lands on it. The fragment itself is NOT the test input -- a test that
#: fed the list back into itself would pass over an empty list and prove
#: nothing. These paths are written out by hand so that deleting a row from the
#: authority makes a NAMED case fail.
ESCALATING_PATHS = [
    ("tools/drain", "tools/drain/gates.py"),
    ("scripts/ci", "scripts/ci/check-deploy-staleness.mjs"),
    ("dev-loop/gates", "dev-loop/gates/validate-all.ps1"),
    (".github/workflows", ".github/workflows/deploy-fiab-commercial.yml"),
    (".github/CODEOWNERS", ".github/CODEOWNERS"),
    (".gitignore", ".gitignore"),
    ("Makefile", "Makefile"),
    ("pyproject.toml", "pyproject.toml"),
    ("platform/fiab/bicep", "platform/fiab/bicep/main.bicep"),
    ("deploy/", "deploy/main.bicep"),
    ("apps/fiab-console", "apps/fiab-console/app/page.tsx"),
    ("portal/", "portal/src/index.tsx"),
]


@pytest.mark.parametrize(("fragment", "path"), ESCALATING_PATHS)
def test_negative_control_each_escalating_path_fragment_is_pinned(fragment, path):
    """Both reviewers flagged the same asymmetry: the fragments reachable
    through a LANE were pinned individually and the rest were covered only in
    aggregate, so five rows could be deleted from the authority over a green
    matrix. The five newest were the unpinned ones, and `.gitignore` is the
    worst of them -- an entry in it is what hid the merge gate from every
    reader for the length of this program, which is #4468's entire thesis.

    Parametrized rather than looped so a deletion names the row it lost."""
    n, why = gates.review_requirement(POLICY, changed_paths=[path], stream="W9-rest")
    assert n == 2, f"{fragment!r} via {path}: {why}"


def test_negative_control_the_pinned_paths_are_the_whole_authority():
    """The list above is a hand-written MIRROR, so it can fall behind the file
    it mirrors: add a thirteenth fragment and every case still passes while the
    new row goes unpinned -- which is exactly the state this test was written to
    end. Compares SETS, not counts: a swap reads clean against a length."""
    assert {f for f, _ in ESCALATING_PATHS} == set(gates.escalation_paths(POLICY))


def test_negative_control_a_blocking_first_verdict_is_matched_by_shape():
    """`parse_verdicts` spends a whole apparatus on the fact that
    "CHANGES REQUIRED" is a block written the wrong way. A reviewer count that
    recognised only the exact token would let formatting reduce a block to
    "one reviewer was enough"."""
    for spelling in ("REQUEST-CHANGES", "request-changes", "REQUEST-CHANGES ",
                     "## Independent review - REQUEST-CHANGES", "CHANGES REQUIRED",
                     "CANNOT-ASSESS"):
        n, why = gates.review_requirement(POLICY, changed_paths=["docs/x.md"],
                                          first_verdict=spelling)
        assert n == 2, f"{spelling!r}: {why}"
    n, _ = gates.review_requirement(POLICY, changed_paths=["docs/x.md"],
                                    first_verdict="APPROVE")
    assert n == 1


def test_negative_control_the_deploy_fragment_is_anchored():
    """A bare substring made `docs/how-we-deploy/notes.md` escalate. Safe
    direction, but a guard that cries wolf is a guard people route around."""
    n, _ = gates.review_requirement(POLICY, changed_paths=["docs/how-we-deploy/notes.md"])
    assert n == 1
    n, _ = gates.review_requirement(POLICY, changed_paths=["deploy/main.bicep"])
    assert n == 2


def test_an_ordinary_lane_gets_one_reviewer():
    n, why = gates.review_requirement(POLICY, changed_paths=["domains/sales/models/x.sql"])
    assert n == 1, why


def test_negative_control_a_guard_or_deploy_or_console_diff_escalates():
    """W0 took nine rounds with two reviewers because it WAS the merge gate. One
    reviewer is the default -- but in six of those nine rounds the second
    reviewer found something the first did not, so the paths whose failure modes
    one reviewer has been observed to miss still get two."""
    for path in ("tools/drain/gates.py", "scripts/ci/check-x.mjs",
                 ".github/workflows/deploy-fiab-commercial.yml",
                 "platform/fiab/bicep/main.bicep", "apps/fiab-console/app/page.tsx",
                 "deploy/main.bicep"):
        n, why = gates.review_requirement(POLICY, changed_paths=[path])
        assert n == 2, f"{path} must escalate: {why}"


def test_negative_control_a_finding_escalates_whatever_the_path():
    for verdict in ("REQUEST-CHANGES", "CANNOT-ASSESS"):
        n, why = gates.review_requirement(POLICY, changed_paths=["docs/x.md"],
                                          first_verdict=verdict)
        assert n == 2, why
    n, _ = gates.review_requirement(POLICY, changed_paths=["docs/x.md"],
                                    first_verdict="APPROVE")
    assert n == 1


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
