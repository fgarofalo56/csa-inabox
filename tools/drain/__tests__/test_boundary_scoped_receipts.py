"""#4709: a receipt from the wrong boundary must not close an item.

THESE ARE THE TESTS THAT WITNESS THE BOUNDARY CHECK. Every other test in the
package runs under an autouse fixture (`conftest.py`) that stubs
`boundary_of_issue` to `Commercial`, because #4709 puts a GitHub read on the
record path. Each test here carries `@pytest.mark.real_boundary` to opt out of
that stub.

THE FIXTURE LIVES IN `conftest.py`, NOT IN A TEST MODULE. A module-level
autouse fixture reaches only its own module, so a fixture defined in
`test_tick.py` would leave the marker decorative and file separation doing the
work. `test_the_opt_out_marker_is_load_bearing` pins the location.

THE SEAM AND THE RESOLVER ARE DIFFERENT SITES, and a mutation at one is
invisible to tests that only drive the other: `boundary = "Commercial"` written
INSIDE `verify_run_backed_receipt` is not the same edit as the same assignment
at `record_receipt_from_evidence`'s call site, which computes the wrong value
before the callee ever sees it. Both are covered -- the `seam` tests below
drive the real `record_receipt_from_evidence`, the rest call the resolver and
the verifier directly.

The defect: `receipt_producers` mapped a kind to ONE workflow with no boundary
dimension, so a Commercial `loom-roll-and-validate` run was accepted as the
receipt closing a GCC-High drift item (#2874) -- and the close posts a public
comment saying it was verified. `cloud-parity.md`: "Commercial green proves
nothing about Gov."

That is worse than an unobtainable receipt. An unreachable receipt BLOCKS and
asserts nothing. A reachable-and-wrong receipt CLOSES and publishes a claim.
"""
from __future__ import annotations

import ast
import copy
import inspect
import json
import os
import re
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import tick
from ledger import CLOSED, READY, Ledger

import gates

POLICY = gates.load_policy(os.path.join(os.path.dirname(__file__), "..", "policy.json"))

#: Captured at IMPORT, before any fixture can rebind the module attribute, so
#: `test_the_opt_out_marker_is_load_bearing` compares object IDENTITY rather
#: than a name. A name check is defeated by setting `__name__` on the wrapper;
#: identity is not.
_ORIGINAL_RESOLVER = tick.boundary_of_issue


def _roll(workflow="loom-roll-and-validate", conclusion="success"):
    """A green `deploy-run` producer run with its required step concluded."""
    steps = POLICY["receipt_required_steps"]["deploy-run"]
    return {
        "workflowName": workflow,
        "status": "completed",
        "conclusion": conclusion,
        "databaseId": 36053481220,
        "headSha": "a" * 40,
        "jobs": [{"steps": [{"name": s, "conclusion": "success"} for s in steps]}],
    }


def _g1(workflow=None, conclusion="success"):
    """A green `g1-browser` producer run. The producer and the required steps
    are LIFTED from policy rather than transcribed, so a policy edit cannot
    leave this fixture agreeing with a stale copy of itself."""
    if workflow is None:
        workflow = POLICY["receipt_producers"]["g1-browser"]["Commercial"]
    steps = POLICY["receipt_required_steps"]["g1-browser"]
    return {
        "workflowName": workflow,
        "status": "completed",
        "conclusion": conclusion,
        "databaseId": 36053481220,
        "headSha": "a" * 40,
        "jobs": [{"steps": [{"name": s, "conclusion": "success"} for s in steps]}],
    }


def _labels_stub(labels):
    """Answer `gh issue view --json labels` and nothing else.

    Anything else returns rc=1, so a test that accidentally depends on another
    `gh` call fails loudly instead of reading an empty string as an answer --
    the `2>/dev/null` shape deploy-integrity R7 exists because of.
    """
    def sh(args, **_kwargs):
        if "issue" in args and "view" in args and "labels" in args:
            return (0, json.dumps({"labels": [{"name": n} for n in labels]}), "")
        return (1, "", f"test stub: unexpected gh call {args!r}")
    return sh


# --------------------------------------------------------------------------
# THE SEAM. These drive `record_receipt_from_evidence`, so a mutation applied
# at the call site is visible to them; the direct-call tests further down are
# visible only to a mutation inside `verify_run_backed_receipt`.
# --------------------------------------------------------------------------

@pytest.mark.real_boundary
def test_seam_a_commercial_run_cannot_close_a_gov_labelled_item(tmp_path, monkeypatch):
    """THE DEFECT, at the production seam. #2874's shape, end to end.

    WHAT VALUE WOULD MAKE THIS FAIL: `boundary = "Commercial"` at
    `record_receipt_from_evidence`'s call site. Also
    killed: deleting the `boundary_of_issue` call entirely, and passing `None`
    through to `verify_run_backed_receipt`.

    The item is labelled `drift-gov` -> GCC-High, which has NO declared
    producer, so a green Commercial roll must not close it.
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    item = led.upsert(2874, "bicep drift in Gov", "W1-deploy", lane="lane:bicep", size=1)
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _roll())
    monkeypatch.setattr(tick, "sh", _labels_stub(["drift-gov", "sp:1"]))

    with pytest.raises(tick.ReceiptRefusedError) as exc:
        tick.record_receipt_from_evidence(
            led, POLICY, "o/r", 2874, from_pr=None, from_run="36053481220")
    msg = str(exc.value)
    assert "GCC-High" in msg, msg
    assert "no declared producer" in msg, msg
    # AND IT DID NOT HALF-WRITE. A refusal that still closed the item would be
    # the same published-false-claim this rule is about.
    assert item.state == READY
    assert item.receipt_kind is None


@pytest.mark.real_boundary
def test_seam_an_unlabelled_g1_item_takes_the_per_kind_default_and_names_it(tmp_path, monkeypatch):
    """POSITIVE CONTROL for the seam, and the `cloud-parity.md` naming rule.

    Without this, the refusal above is satisfied by a resolver that refuses
    EVERYTHING.

    `g1-browser` is the ONE kind with a declared default, so this is also the
    arm that goes red if the per-kind narrowing recorded in
    `policy.default_boundary` were taken one step further and every kind
    refused.

    WHAT VALUE WOULD MAKE THIS FAIL: removing `g1-browser` from
    `default_boundary` (the item then refuses), or dropping
    `in boundary {boundary}` from the `detail` string (arm `BND7`) -- which
    would put a permanent public "verified" comment on the issue without saying
    which cloud verified it. `cloud-parity.md` forbids a status claim that does
    not name its boundaries, and this comment is exactly such a claim.
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    item = led.upsert(4408, "a console surface", "W5-console", lane="lane:console", size=1)
    assert item.effective_receipt_class == "ui-surface", "this test needs a g1-browser item"
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1())
    monkeypatch.setattr(tick, "sh", _labels_stub(["lane:console", "sp:1"]))
    seen = {}

    def _closer(_policy, _repo, _number, _state, detail, _kind, _issue_class, _binding, **_kwargs):
        seen["detail"] = detail
        return "closed (test stub)"

    monkeypatch.setattr(tick, "close_issue_on_github", _closer)

    out = tick.record_receipt_from_evidence(
        led, POLICY, "o/r", 4408, from_pr=None, from_run="36053481220")

    assert item.state == CLOSED
    assert item.receipt_kind == "g1-browser"
    # The BOUNDARY is in the text that gets published, not merely checked.
    assert "Commercial" in seen["detail"], seen["detail"]
    assert "NOT from a label" in seen["detail"], seen["detail"]
    assert "36053481220" in out.summary


@pytest.mark.real_boundary
def test_main_refuses_a_policy_missing_the_drift_gov_row(tmp_path, monkeypatch, capsys):
    """WHAT VALUE WOULD MAKE THIS FAIL: deleting the
    `assert_policy_matches_code` call from `main()`."""
    policy = copy.deepcopy(POLICY)
    del policy["boundary_labels"]["drift-gov"]
    policy_path = tmp_path / "policy.json"
    policy_path.write_text(json.dumps(policy), encoding="utf-8")
    state = str(tmp_path / "state.json")
    seed = Ledger(state, receipts=POLICY["receipts"])
    seed.upsert(4408, "a console surface", "W5-console", lane="lane:console", size=1)
    seed.save()
    monkeypatch.setattr(tick, "POLICY_PATH", str(policy_path))
    monkeypatch.setattr(tick, "STATE_PATH", state)
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1())
    monkeypatch.setattr(tick, "sh", _labels_stub(["drift-gov"]))
    closed = []
    monkeypatch.setattr(tick, "close_issue_on_github",
                        lambda *a, **_k: closed.append(a) or "closed (test stub)")
    monkeypatch.setattr(sys, "argv", ["tick.py", "--record-receipt", "4408",
                                      "--from-run", "36053481220"])

    assert tick.main() == 2
    assert "boundary_labels.drift-gov" in capsys.readouterr().err
    assert closed == []
    assert Ledger(state, receipts=POLICY["receipts"]).load().items[4408].state != CLOSED


@pytest.mark.real_boundary
def test_seam_an_unlabelled_deploy_item_refuses_because_its_kind_has_no_default(
        tmp_path, monkeypatch):
    """THE OPERATOR'S NARROWING, at the seam rather than in the resolver.

    #3449 is `deploy: deploy-fiab-gcch is failing` -- a Gov item carrying no
    boundary label. Under the one-value default it resolved to Commercial and a
    green Commercial roll would have closed it, publishing a claim that a
    GCC-High deploy failure was verified.

    WHAT VALUE WOULD MAKE THIS FAIL: adding `deploy-run` to
    `default_boundary`, or reverting that key to a bare string.

    THE TITLE IS #3449's CURRENT ONE, NOT THE WATCHER SHAPE (#4764). It used to
    be `deploy: deploy-fiab-gcch is failing`, and since #4764 an item with that
    title is routed to the WATCHER route -- which never consults the boundary,
    because it binds by workflow identity instead. Keeping the old title here
    would test that route, not this one. The watcher route's own refusal of a
    Commercial roll for a Gov workflow item is
    `test_watcher_seam_a_policy_producer_run_cannot_close_a_watcher_item`.
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    item = led.upsert(
        3449,
        "deploy-fiab-gcch: scheduled runs have been QUEUED behind an environment "
        "approval since 2026-09-17, not failing (the Jul-Aug failing era is "
        "separate and ended)",
        "W1-deploy", lane="lane:bicep", size=1)
    assert tick.watcher_workflow_in_title(item.title) is None, (
        "this test needs an item OFF the watcher route")
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _roll())
    monkeypatch.setattr(tick, "sh", _labels_stub(["lane:bicep", "sp:1"]))

    with pytest.raises(tick.ReceiptRefusedError, match=r"no entry in policy\.default_boundary"):
        tick.record_receipt_from_evidence(
            led, POLICY, "o/r", 3449, from_pr=None, from_run="36053481220")
    assert item.state == READY
    assert item.receipt_kind is None


@pytest.mark.real_boundary
def test_seam_an_unreadable_label_query_does_not_close_the_item(tmp_path, monkeypatch):
    """R7 at the seam: a failed read is not an absent label.

    WHAT VALUE WOULD MAKE THIS FAIL: swallowing the non-zero rc and falling to
    the default. The item would then close on a Commercial roll because `gh`
    was briefly unreachable -- a published verification claim caused by a
    network blip. This repo has paid for that exact conversion once, when a
    `2>/dev/null` turned a permission denial into an empty string and the
    empty string into a false claim.
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    item = led.upsert(2875, "some item", "W1-deploy", lane="lane:bicep", size=1)
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _roll())
    monkeypatch.setattr(tick, "sh", lambda *_a, **_k: (1, "", "HTTP 403: Resource not accessible"))

    with pytest.raises(tick.ReceiptRefusedError) as exc:
        tick.record_receipt_from_evidence(
            led, POLICY, "o/r", 2875, from_pr=None, from_run="36053481220")
    assert "could not read labels" in str(exc.value)
    assert "403" in str(exc.value), "the underlying cause must survive into the message"
    assert item.state == READY


@pytest.mark.real_boundary
def test_the_opt_out_marker_is_load_bearing(request):
    """The marker actually suppresses the autouse stub.

    TWO VALUES BREAK THIS, and the identity assertion alone catches only one:
    moving `_default_boundary` out of `conftest.py` into `test_tick.py` leaves
    identity satisfied, because a fixture that never runs also never installs a
    stub. So the file LOCATION is asserted directly as well -- an absence-only
    check given a positive partner rather than left to stand alone.

    WHAT VALUE WOULD MAKE THIS FAIL: (1) defining `_default_boundary` anywhere
    but `conftest.py`, or (2) deleting the
    `if "real_boundary" in request.keywords: return` branch.
    """
    assert "real_boundary" in request.keywords
    assert tick.boundary_of_issue is _ORIGINAL_RESOLVER, (
        "the autouse stub is still installed -- this file is not witnessing "
        "the real resolver"
    )
    # VALUE (1). The fixture must live where it reaches the whole package: a
    # module-level autouse fixture only ever reaches its own module.
    here = os.path.dirname(__file__)
    with open(os.path.join(here, "conftest.py"), encoding="utf-8") as handle:
        conftest = handle.read()
    # THE DECORATOR MUST BE BOUND TO THE FUNCTION, and by AST rather than by
    # two substring checks: a dead decoy `def _default_boundary(...)` plus ANY
    # unrelated autouse fixture elsewhere in conftest satisfies both needles
    # while the real fixture has moved away -- guard green, marker decorative.
    # MODULE BODY, not `ast.walk`. `walk` descends into a `ClassDef`, and
    # pytest does not collect a fixture nested inside a class, so `walk` would
    # accept a definition that never runs.
    fixture = next(
        (n for n in ast.parse(conftest).body
         if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
         and n.name == "_default_boundary"),
        None,
    )
    assert fixture is not None, (
        "the autouse boundary fixture is no longer defined in conftest.py, so "
        "`real_boundary` stops reaching the tests that rely on it"
    )
    autouse = [
        d for d in fixture.decorator_list
        if isinstance(d, ast.Call)
        and any(k.arg == "autouse" and getattr(k.value, "value", False) is True
                for k in d.keywords)
    ]
    assert autouse, (
        "`_default_boundary` exists in conftest.py but is not decorated "
        "autouse=True -- a fixture nobody requests is the same inertness one "
        "layer down"
    )
    # SCANNED BY AST, NOT BY SUBSTRING. A substring scan for
    # `def _default_boundary(` matches THIS TEST'S OWN ASSERTION STRING, so the
    # check would fail against itself: the suite's source contains the
    # vocabulary it is testing. `mutate_gates._SUMMARY_COUNT_RE` documents the
    # same defect one layer down.
    for other in ("test_tick.py", "test_boundary_scoped_receipts.py"):
        with open(os.path.join(here, other), encoding="utf-8") as handle:
            tree = ast.parse(handle.read())
        defined = {n.name for n in ast.walk(tree)
                   if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
        assert "_default_boundary" not in defined, (
            f"{other} defines its own `_default_boundary`; a module-level "
            "autouse fixture reaches only its own module"
        )
    # POSITIVE CONTROL for the AST scan: it finds the function it is standing
    # in, so a parse that returned nothing would not read as "clean".
    with open(os.path.join(here, "test_boundary_scoped_receipts.py"), encoding="utf-8") as handle:
        names = {n.name for n in ast.walk(ast.parse(handle.read()))
                 if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
    assert "test_the_opt_out_marker_is_load_bearing" in names


@pytest.mark.real_boundary
def test_the_signature_requires_a_boundary():
    """`boundary` must have NO default, so the argument cannot be omitted.

    A default on that parameter is invisible to every test that passes the
    argument explicitly -- which is all of them -- while not being an
    equivalent mutant: a three-argument call flips from REFUSED to ACCEPTED.
    That is arm `BND12` in `mutate_gates.py`.

    WHAT VALUE WOULD MAKE THIS FAIL: re-adding any default to that parameter.
    The argument is REQUIRED, so the branch is deleted rather than tested --
    but a future reader can put a default back "for convenience", and this is
    what notices.

    Introspection rather than a call, because the whole point is the shape of
    the signature when NOBODY passes the argument.
    """
    sig = inspect.signature(tick.verify_run_backed_receipt)
    param = sig.parameters["boundary"]
    assert param.default is inspect.Parameter.empty, (
        f"`boundary` has default {param.default!r}; a default here is "
        "unreachable from every existing test and hid a live defect for a round"
    )
    # POSITIVE CONTROL: a three-argument call is a TypeError now, not a silent
    # Commercial. Without this the assertion above could pass against a
    # signature that had dropped the parameter entirely.
    with pytest.raises(TypeError):
        tick.verify_run_backed_receipt("deploy-run", _roll(), POLICY)


def test_the_boundary_seam_stays_at_exactly_one_call_site():
    """No SECOND close path may resolve a boundary of its own.

    The seam tests cover the call site that exists today; this is for the site
    somebody adds later.

    WHAT VALUE WOULD MAKE THIS FAIL: a second literal `boundary_of_issue(`
    call anywhere in `tick.py`.

    ITS REACH IS NARROWER THAN THAT SENTENCE, and the limit is DISCLOSED
    rather than implied: a second call site reached through a local alias, or
    through `getattr(sys.modules[__name__], "boundary_of_issue")`, SURVIVES
    this check, and it reads only `tick.py`. So it guards the ORDINARY shape
    of the mistake and is not a proof that one call site is the only one
    possible.
    """
    with open(os.path.join(os.path.dirname(__file__), "..", "tick.py"),
              encoding="utf-8") as handle:
        source = handle.read()
    # The DEFINITION is `def boundary_of_issue(`, so it is excluded by the
    # `def ` prefix rather than by subtracting one from the count -- an
    # off-by-one here would silently permit a second caller.
    calls = list(re.finditer(r"(?<!def )boundary_of_issue\(", source))
    assert len(calls) == 1, (
        f"{len(calls)} call sites of boundary_of_issue in tick.py, expected 1. "
        "Each one needs its own seam test; see this test's docstring."
    )
    # POSITIVE CONTROL: the pattern finds a real call, so a rename that made
    # this zero would not read as "still exactly one".
    assert "boundary_of_issue(repo, number, policy, kind)" in source


# --------------------------------------------------------------------------
# THE RESOLVER, called directly.
# --------------------------------------------------------------------------

@pytest.mark.real_boundary
def test_blocker_a_commercial_run_cannot_close_a_gcc_high_item():
    """The same refusal, at `verify_run_backed_receipt` rather than the seam.

    WHAT VALUE WOULD MAKE THIS FAIL: reverting `receipt_producers` to a bare
    `kind -> workflow` string, or falling back to another boundary's producer
    when the item's own is absent.

    `GCC-High` is deliberately ABSENT from the producer map -- no receipt has
    ever been taken from a Gov producer -- so this refuses on the boundary
    having no declared producer, which is the `cloud-parity.md` position: an
    unexercised boundary is declared, never implied.
    """
    with pytest.raises(tick.ReceiptRefusedError) as exc:
        tick.verify_run_backed_receipt("deploy-run", _roll(), POLICY, "GCC-High")
    msg = str(exc.value)
    assert "GCC-High" in msg, msg
    assert "no declared producer" in msg, msg
    # AND THE REMEDIATION IS SUFFICIENT. Declaring a Gov producer alone is not
    # enough -- `receipt_required_steps` names steps that exist only in the
    # Commercial workflow, so the next refusal would be at the step check. A
    # message that stopped at "add the producer" would send someone down a
    # path that refuses again for a different reason (R7).
    assert "receipt_required_steps" in msg, msg

    # POSITIVE CONTROL: the SAME run, same kind, for a Commercial item, is
    # accepted. Without this the refusal above could be the run being bad
    # rather than the boundary being wrong.
    ref = tick.verify_run_backed_receipt("deploy-run", _roll(), POLICY, "Commercial")
    assert "36053481220" in ref, ref


@pytest.mark.real_boundary
def test_a_bare_string_producer_is_refused_not_silently_accepted():
    """The pre-#4709 declaration shape must not keep working.

    WHAT VALUE WOULD MAKE THIS FAIL: accepting a `str` producer for backward
    compatibility. A bare string has no boundary, so accepting one would let
    the old map -- the defect -- be reintroduced by editing policy.json alone,
    with every test still green.
    """
    old_shape = copy.deepcopy(POLICY)
    old_shape["receipt_producers"]["deploy-run"] = "loom-roll-and-validate"
    with pytest.raises(tick.ReceiptRefusedError, match="bare producer"):
        tick.verify_run_backed_receipt("deploy-run", _roll(), old_shape, "Commercial")


@pytest.mark.real_boundary
def test_a_producer_that_is_neither_string_nor_boundary_map_is_refused():
    """The THIRD arm of the producer-shape guard.

    WHAT VALUE WOULD MAKE THIS FAIL: deleting
    `if not isinstance(declared, dict):` -- arm `BND11` in `mutate_gates.py`.
    The bare-string arm above is a DIFFERENT branch and does not cover this
    one.

    AN EMPTY DICT DOES NOT REACH THIS GUARD. `if not declared:` above catches
    `{}` first, because an empty dict is falsy. The empty case is still
    covered below; it simply takes the `no declared producer` arm, which is
    why this test accepts either message and says so.
    """
    for broken in ({}, [], 0, ["loom-roll-and-validate"]):
        policy = copy.deepcopy(POLICY)
        policy["receipt_producers"]["deploy-run"] = broken
        with pytest.raises(tick.ReceiptRefusedError) as exc:
            tick.verify_run_backed_receipt("deploy-run", _roll(), policy, "Commercial")
        # WHICH ARM FIRES: `{}`, `[]` and `0` are ALL falsy, so three of these
        # four take the `no declared producer` arm and only the non-empty list
        # reaches the shape guard this test is named for. Both arms are
        # refusals, so the SET of acceptable messages is what is asserted --
        # the weaker claim, said so rather than implied.
        assert ("neither a boundary" in str(exc.value)
                or "no declared producer" in str(exc.value)), (broken, str(exc.value))


@pytest.mark.real_boundary
def test_a_caller_passing_no_boundary_is_refused():
    """The `if not boundary:` guard, which the seam cannot reach.

    WHAT VALUE WOULD MAKE THIS FAIL: replacing that guard with
    `boundary = "Commercial"` -- arm `BND10` in `mutate_gates.py`.
    `boundary_of_issue` either returns a value or raises, so this guard is
    reachable only by a DIRECT caller, which is why it needs its own test
    rather than relying on the seam.
    """
    with pytest.raises(tick.ReceiptRefusedError, match="BOUNDARY could not be established"):
        tick.verify_run_backed_receipt("deploy-run", _roll(), POLICY, None)
    with pytest.raises(tick.ReceiptRefusedError, match="BOUNDARY could not be established"):
        tick.verify_run_backed_receipt("deploy-run", _roll(), POLICY, "")


@pytest.mark.real_boundary
def test_boundary_of_issue_reads_labels_and_falls_to_the_per_kind_default(monkeypatch):
    """Labels decide; an unlabelled issue takes `default_boundary[kind]`.

    WHAT VALUE WOULD MAKE THIS FAIL: reading the TITLE. #4709 itself names
    both `Commercial` and `GCC-High` because it is ABOUT boundaries -- a
    title needle classifies this very issue as Gov. The third case below is
    that exact shape.

    A LABEL BEATS THE DEFAULT EVEN WHEN THE KIND HAS ONE, and the first case
    pins that: `g1-browser` is the kind that DOES default to Commercial, and a
    `drift-gov` label must still win.
    """
    monkeypatch.setattr(tick, "sh", _labels_stub(["drift-gov", "sp:1"]))
    b, src = tick.boundary_of_issue("o/r", 2874, POLICY, "g1-browser")
    assert (b, src) == ("GCC-High", "its drift-gov label"), (b, src)

    monkeypatch.setattr(tick, "sh", _labels_stub(["drift-commercial"]))
    b, src = tick.boundary_of_issue("o/r", 3191, POLICY, "deploy-run")
    assert (b, src) == ("Commercial", "its drift-commercial label"), (b, src)

    monkeypatch.setattr(tick, "sh", _labels_stub(["lane:bicep", "sp:1"]))
    b, src = tick.boundary_of_issue("o/r", 4709, POLICY, "g1-browser")
    assert b == "Commercial", b
    assert "NOT from a label" in src, src


@pytest.mark.real_boundary
def test_a_kind_with_no_declared_default_refuses_rather_than_borrowing_one(monkeypatch):
    """THE OPERATOR'S PER-KIND DEFAULT, in one assertion.

    WHAT VALUE WOULD MAKE THIS FAIL: `defaults.get(kind, "Commercial")` (arm
    `BND5`), or reverting `default_boundary` to a bare string so every kind
    shares one value (arm `BND8`). Either re-exposes the unlabelled Gov-about
    `deploy-run` items -- #3449 `deploy-fiab-gcch is failing` and #4424
    `gov-console-roll is failing` among them -- to closure on a Commercial
    roll.

    `g1-browser` IS declared and must still resolve, so this is not satisfied
    by a resolver that refuses everything.
    """
    monkeypatch.setattr(tick, "sh", _labels_stub(["lane:bicep"]))
    for kind in ("deploy-run", "estate"):
        with pytest.raises(tick.ReceiptRefusedError, match=r"no entry in policy\.default_boundary"):
            tick.boundary_of_issue("o/r", 3449, POLICY, kind)
    assert tick.boundary_of_issue("o/r", 3449, POLICY, "g1-browser")[0] == "Commercial"


@pytest.mark.real_boundary
def test_an_absent_default_map_refuses_rather_than_hard_coding_one(monkeypatch):
    """The default lives in POLICY. With the key gone, this refuses.

    WHAT VALUE WOULD MAKE THIS FAIL: `policy.get("default_boundary", {...})`
    with a literal fallback -- a code-side default, which is the #4709 defect
    wearing the fix's name. The whole value of the default is that it is
    auditable in policy.json.
    """
    no_default = copy.deepcopy(POLICY)
    del no_default["default_boundary"]
    monkeypatch.setattr(tick, "sh", _labels_stub(["lane:bicep"]))
    with pytest.raises(tick.ReceiptRefusedError, match=r"no entry in policy\.default_boundary"):
        tick.boundary_of_issue("o/r", 4709, no_default, "g1-browser")


@pytest.mark.real_boundary
def test_a_documentation_key_is_not_a_label(monkeypatch):
    """`boundary_labels._` is prose, and an issue labelled `_` must not read it.

    WHAT VALUE WOULD MAKE THIS FAIL: dropping the `startswith("_")` filter in
    `boundary_of_issue` -- arm `BND2` in `mutate_gates.py`. An issue carrying a
    label literally named `_` then resolves to the documentation STRING, and
    that whole paragraph becomes the "boundary" a producer is looked up under.
    """
    assert POLICY["boundary_labels"]["_"].startswith("ISSUE LABEL"), (
        "this test is pinned to `_` being documentation; if that changed, the "
        "filter it guards may no longer be the right one"
    )
    monkeypatch.setattr(tick, "sh", _labels_stub(["_"]))
    assert tick.boundary_of_issue("o/r", 1, POLICY, "g1-browser")[0] == "Commercial"


@pytest.mark.real_boundary
def test_a_documentation_key_is_not_a_receipt_kind(monkeypatch):
    """The same filter on the OTHER map. `default_boundary._` is prose too.

    WHAT VALUE WOULD MAKE THIS FAIL: dropping the `startswith("_")` filter on
    `defaults` -- arm `BND9` in `mutate_gates.py`. A receipt kind literally
    named `_` would then resolve to the documentation paragraph as its
    boundary -- the mirror of the defect above, at a site the boundary-label
    arm does not cover.
    """
    monkeypatch.setattr(tick, "sh", _labels_stub(["lane:bicep"]))
    with pytest.raises(tick.ReceiptRefusedError, match=r"no entry in policy\.default_boundary"):
        tick.boundary_of_issue("o/r", 1, POLICY, "_")


@pytest.mark.real_boundary
def test_a_label_merely_containing_a_mapped_one_does_not_match(monkeypatch):
    """Exact match, not substring.

    WHAT VALUE WOULD MAKE THIS FAIL: `any(k in name for k in mapping)` -- arm
    `BND3` in `mutate_gates.py`. A substring rule would read `not-drift-gov` or
    `drift-gov-triaged` as Gov, silently routing an item to a boundary nobody
    assigned it.
    """
    monkeypatch.setattr(tick, "sh", _labels_stub(["drift-gov-triaged", "xdrift-commercial"]))
    assert tick.boundary_of_issue("o/r", 1, POLICY, "g1-browser")[0] == "Commercial"
    # POSITIVE CONTROL: the exact label still resolves, so this is not
    # satisfied by a resolver that matches nothing at all.
    monkeypatch.setattr(tick, "sh", _labels_stub(["drift-gov-triaged", "drift-gov"]))
    assert tick.boundary_of_issue("o/r", 1, POLICY, "g1-browser")[0] == "GCC-High"


@pytest.mark.real_boundary
def test_two_boundary_labels_are_ambiguous_and_refuse(monkeypatch):
    """Two mapped labels refuse rather than picking a winner.

    WHAT VALUE WOULD MAKE THIS FAIL: returning the first match, or falling to
    the default. Choosing one would silently decide which cloud a published
    verification claim is about, on a labelling error nobody had noticed --
    and falling to the default would do the same thing more quietly.
    """
    monkeypatch.setattr(tick, "sh", _labels_stub(["drift-gov", "drift-commercial"]))
    with pytest.raises(tick.ReceiptRefusedError, match="ambiguous"):
        tick.boundary_of_issue("o/r", 99, POLICY, "g1-browser")


@pytest.mark.real_boundary
def test_an_unparseable_response_is_not_an_unlabelled_issue(monkeypatch):
    """rc=0 with a body this cannot parse must refuse, not take the default.

    WHAT VALUE WOULD MAKE THIS FAIL: widening the `except` to return the
    default instead of raising -- arm `BND4` in `mutate_gates.py`. "gh returned
    something unexpected" would then become "this item is Commercial", which is
    R7's exact failure shape.
    """
    monkeypatch.setattr(tick, "sh", lambda *_a, **_k: (0, "not json at all", ""))
    with pytest.raises(tick.ReceiptRefusedError, match="could not parse labels"):
        tick.boundary_of_issue("o/r", 1, POLICY, "g1-browser")

    # The other shape: valid JSON whose `labels` is not a list of objects.
    monkeypatch.setattr(tick, "sh", lambda *_a, **_k: (0, '{"labels": [1, 2]}', ""))
    with pytest.raises(tick.ReceiptRefusedError, match="could not parse labels"):
        tick.boundary_of_issue("o/r", 1, POLICY, "g1-browser")


@pytest.mark.real_boundary
def test_an_unreadable_label_query_refuses_rather_than_defaulting(monkeypatch):
    """A failed read is not an absent label. R7: it does not know, so it says so.

    WHAT VALUE WOULD MAKE THIS FAIL: returning the default on a non-zero `gh`
    exit. The item would close on a Commercial roll because a token expired.
    """
    monkeypatch.setattr(tick, "sh", lambda *_a, **_k: (1, "", "HTTP 403: Resource not accessible"))
    with pytest.raises(tick.ReceiptRefusedError) as exc:
        tick.boundary_of_issue("o/r", 2874, POLICY, "g1-browser")
    assert "could not read labels" in str(exc.value)
    assert "403" in str(exc.value), "the underlying cause must survive into the message"


def test_no_decorative_authority_rows():
    """No row this change added to `OTHER_IMPLEMENTED_BY` is REDUNDANT.

    `policy_keys_without_implementation` descends into a dict NAMESPACE
    without demanding the namespace key itself be declared, so a row naming
    one buys nothing in the declared -> implemented direction.

    SUCH A ROW IS REDUNDANT, NOT INERT, and the difference is the direction:
    `assert_policy_matches_code` walks implemented -> declared and DOES read
    it. This test guards one direction only, so calling a redundant row
    "decoration" overstates what deleting it proves.

    WHAT VALUE WOULD MAKE THIS FAIL: adding `receipt_producers.g1-browser`,
    `receipt_producers.estate`, `receipt_producers.deploy-run` or
    `boundary_labels` to `OTHER_IMPLEMENTED_BY` -- each is redundant with its
    `.Commercial` leaf -- or declaring any future namespace key.

    SCOPE, and it is deliberate per `assertion-design.md` "done" #4: this binds
    the keys THIS change owns. The namespace rows listed below are redundant
    for the same reason and are named rather than deleted -- they predate this
    rule and removing them is not this PR's work.
    """
    policy = gates.load_policy(os.path.join(os.path.dirname(__file__), "..", "policy.json"))

    checked: set[str] = set()

    def walk(node, prefix):
        for key, value in node.items():
            if key.startswith("_"):
                continue
            dotted = f"{prefix}.{key}" if prefix else key
            if dotted in {"merge_gate", "verdict_parsing"}:
                continue
            if isinstance(value, dict) and dotted not in gates.DATA_NOT_NAMESPACE:
                walk(value, dotted)
                continue
            checked.add(dotted)

    walk(policy, "")
    # POSITIVE CONTROL: the walk found real leaves. Without this the test is
    # satisfied by a walk that collects nothing, which would make every row
    # "decorative" and the assertion below unreachable in the other direction.
    assert "boundary_labels.drift-gov" in checked
    assert "default_boundary.g1-browser" in checked

    #: Namespace rows that PREDATE #4709. Not fixed here, named so they cannot
    #: grow. The LIST is the claim; there is deliberately no count.
    pre_existing = {
        "receipt_producers",
        "receipt_required_steps",
        "receipts",
        "receipts.ci_green_rule",
        "stop_and_ask",
    }
    decorative = {r for r in gates.OTHER_IMPLEMENTED_BY if r not in checked} - pre_existing
    assert decorative == set(), (
        f"these authority rows name a namespace the policy walk never checks, so "
        f"they are decoration rather than coverage: {sorted(decorative)}"
    )
