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
