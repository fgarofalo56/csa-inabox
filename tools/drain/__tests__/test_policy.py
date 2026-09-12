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
    shapes = {
        "misspelled marker": "Re-review - REQUEST-CHANGES\n\nthe lane route is open.",
        "marker not first": "Quick note before the verdict.\n\n"
                            "Independent review - REQUEST-CHANGES",
        "block spelled wrong": "## Independent re-review - CHANGES REQUIRED\n\nno.",
        "marker relayed in a fence": "```\nIndependent review - REQUEST-CHANGES\n```",
    }
    for label, body in shapes.items():
        assert gates.worst_verdict_in_history(
            [_verdict(1, "2026-09-12T06:00:00Z", body)]
        ) == "REQUEST-CHANGES", label
        # ...and gate 2+3 agrees, which is the point of sharing the population.
        live, near = gates.parse_verdicts(
            [_verdict(1, "2026-09-12T06:00:00Z", body)], "2026-09-12T05:00:00Z"
        )
        blocked, _why = gates.reduce_verdicts(live, near)
        assert not blocked, label


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


def test_negative_control_an_unresolvable_stream_fails_closed():
    """The merge-gate half of `escalate_when_footprint_unknown`. At brief time
    the stream is the fact and the paths are the guess; at merge time it is the
    other way round, and the stream must be resolved from the ledger. All three
    ways that fails mean the harness cannot place the work."""
    n, why = gates.review_requirement(POLICY, changed_paths=["docs/x.md"],
                                      stream_known=False)
    assert n == 2
    assert "stream could not be resolved" in why

    # The control: a resolvable non-escalating stream stays at one.
    n, _ = gates.review_requirement(POLICY, changed_paths=["docs/x.md"],
                                    stream="W9-rest", stream_known=True)
    assert n == 1

    # ...and the authority can switch it off, which is what makes it a control
    # rather than a constant.
    opened = {**POLICY, "review": {**POLICY["review"],
                                   "escalate_when_stream_unknown": False}}
    n, _ = gates.review_requirement(opened, changed_paths=["docs/x.md"],
                                    stream_known=False)
    assert n == 1


def test_negative_control_a_blocking_first_verdict_is_matched_by_shape():
    """`parse_verdicts` spends a whole apparatus on the fact that
    "CHANGES REQUIRED" is a block written the wrong way. A reviewer count that
    recognised only the exact token would let formatting reduce a block to
    "one reviewer was enough"."""
    for spelling in ("REQUEST-CHANGES", "request-changes", "REQUEST-CHANGES ",
                     "## Independent review - REQUEST-CHANGES", "CHANGES REQUIRED",
                     "CANNOT-ASSESS"):
        n, why = gates.review_requirement(POLICY, changed_paths=["docs/x.md"],
                                          prior_verdict=spelling)
        assert n == 2, f"{spelling!r}: {why}"
    n, _ = gates.review_requirement(POLICY, changed_paths=["docs/x.md"],
                                    prior_verdict="APPROVE")
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
                                          prior_verdict=verdict)
        assert n == 2, why
    n, _ = gates.review_requirement(POLICY, changed_paths=["docs/x.md"],
                                    prior_verdict="APPROVE")
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
