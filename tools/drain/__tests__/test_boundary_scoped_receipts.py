"""#4709: a receipt from the wrong boundary must not close an item.

THESE ARE THE TESTS THAT WITNESS THE BOUNDARY CHECK. Every other test in the
package runs under an autouse fixture (`conftest.py`) that stubs
`boundary_of_issue` to `Commercial`, because #4709 put a GitHub read on the
record path and 6 tests would otherwise refuse -- measured at this head by
neutering the opt-out branch, not inherited. Each test here carries
`@pytest.mark.real_boundary` to opt out of that stub.

TWO CORRECTIONS THIS FILE CARRIES, because the first cut of it got both wrong
and an independent reviewer measured both on 2026-09-27:

1. **The marker was decorative.** The fixture lived in `test_tick.py`, and a
   module-level autouse fixture never reaches another module -- so the opt-out
   branch had never once executed and stripping all six markers changed
   nothing. FILE SEPARATION was doing the work the docstring credited to the
   marker. The fixture is now in `conftest.py`, which makes the marker
   load-bearing; `test_the_opt_out_marker_is_load_bearing` pins that.

2. **The mutation arms tested the wrong site.** "Defaults to Commercial" was
   applied INSIDE `verify_run_backed_receipt` and reported RED. The same
   mutation at the PRODUCTION SEAM -- replacing
   `boundary = boundary_of_issue(repo, number, policy)` at the call site with
   `boundary = "Commercial"` -- left 929 of 929 green. One label, two sites,
   one of them unwitnessed. The `seam` tests below drive the real
   `record_receipt_from_evidence`, so they see both.

The defect, measured 2026-09-24: `receipt_producers` mapped a kind to ONE
workflow with no boundary dimension, so a Commercial `loom-roll-and-validate`
run was accepted as the receipt closing a GCC-High drift item (#2874) -- and
the close posts a public comment saying it was verified. `cloud-parity.md`:
"Commercial green proves nothing about Gov."

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
#: `test_the_opt_out_marker_is_load_bearing` compares object identity rather
#: than a name a stub can copy. A reviewer defeated the name check by setting
#: `__name__` on the wrapper.
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
    `record_receipt_from_evidence`'s call site. That is the rejected design
    applied where it actually ships, and it is the mutation that left the
    whole suite green before this test existed. Also killed: deleting the
    `boundary_of_issue` call entirely, and passing `None` through to
    `verify_run_backed_receipt`.

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

    Without this, the refusal above is satisfied by refusing EVERYTHING -- the
    state the first cut of #4709 actually shipped, which blocked 235 of the 236
    non-terminal items needing a run-backed receipt.

    `g1-browser` is the ONE kind with a declared default, so this is also the
    arm that would go red if the operator's 2026-09-27 narrowing were taken one
    step further and every kind refused.

    WHAT VALUE WOULD MAKE THIS FAIL: removing `g1-browser` from
    `default_boundary` (the item then refuses), or dropping
    `in boundary {boundary}` from the `detail` string -- which would put a
    permanent public "verified" comment on the issue without saying which cloud
    verified it. `cloud-parity.md` forbids a status claim that does not name
    its boundaries, and this comment is exactly such a claim.
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    item = led.upsert(4408, "a console surface", "W5-console", lane="lane:console", size=1)
    assert item.effective_receipt_class == "ui-surface", "this test needs a g1-browser item"
    monkeypatch.setattr(tick, "_run_evidence", lambda *_: _g1())
    monkeypatch.setattr(tick, "sh", _labels_stub(["lane:console", "sp:1"]))
    seen = {}

    def _closer(_policy, _repo, _number, _state, detail, _kind, _issue_class):
        seen["detail"] = detail
        return "closed (test stub)"

    monkeypatch.setattr(tick, "close_issue_on_github", _closer)

    out = tick.record_receipt_from_evidence(
        led, POLICY, "o/r", 4408, from_pr=None, from_run="36053481220")

    assert item.state == CLOSED
    assert item.receipt_kind == "g1-browser"
    # The BOUNDARY is in the text that gets published, not merely checked.
    assert "Commercial" in seen["detail"], seen["detail"]
    assert "36053481220" in out.summary


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
    """
    led = Ledger(str(tmp_path / "state.json"), receipts=POLICY["receipts"])
    item = led.upsert(3449, "deploy: deploy-fiab-gcch is failing", "W1-deploy",
                      lane="lane:bicep", size=1)
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
    """The marker actually suppresses the autouse stub. It did NOT before.

    TWO VALUES BREAK THIS, and an earlier revision only caught one. A reviewer
    measured that moving `_default_boundary` back out of `conftest.py` into
    `test_tick.py` -- the exact 2026-09-27 regression this guards, and the
    FIRST value the old docstring named -- left 944 passing and this test
    green. Identity alone could not see it, because a fixture that never runs
    also never installs a stub. So the file location is now asserted directly,
    which is an absence-only check given a positive partner rather than left
    to stand alone.

    WHAT VALUE WOULD MAKE THIS FAIL: (1) defining `_default_boundary` anywhere
    but `conftest.py`, or (2) deleting the
    `if "real_boundary" in request.keywords: return` branch.
    """
    assert "real_boundary" in request.keywords
    assert tick.boundary_of_issue is _ORIGINAL_RESOLVER, (
        "the autouse stub is still installed -- this file is not witnessing "
        "the real resolver"
    )
    # VALUE (1). The fixture must live where it reaches the whole package. A
    # module-level autouse fixture only ever reaches its own module, which is
    # what made the marker decorative for a round.
    here = os.path.dirname(__file__)
    with open(os.path.join(here, "conftest.py"), encoding="utf-8") as handle:
        conftest = handle.read()
    # THE DECORATOR MUST BE BOUND TO THE FUNCTION, and by AST rather than by
    # two substring checks. A reviewer defeated the substring version: a dead
    # decoy `def _default_boundary(...)` plus ANY unrelated autouse fixture
    # elsewhere in conftest satisfied both needles while the real fixture had
    # moved away -- guard green, marker decorative again, whole suite green.
    # That is the same shape as the `__name__`-on-a-wrapper defeat this test
    # already memorialises, one layer out.
    # MODULE BODY, not `ast.walk`. `walk` descends into a `ClassDef`, so a
    # fixture nested inside a class satisfied this guard while pytest never
    # collected it -- measured by a reviewer, and the suite only caught it
    # through six unrelated `test_tick.py` failures, which is file separation
    # doing the work this guard is credited with, one layer out.
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
    # SCANNED BY AST, NOT BY SUBSTRING, and the difference bit on the first
    # try: a substring scan for `def _default_boundary(` matched THIS TEST'S
    # OWN ASSERTION STRING, so the check failed against itself. The suite's
    # source contains the vocabulary it is testing -- the same defect
    # `mutate_gates._SUMMARY_COUNT_RE` documents one layer down.
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
    """THE FOURTH INSTANCE of one defect, and the one that survived longest.

    `verify_run_backed_receipt` carried `boundary: str | None = None` for a
    round. A reviewer mutated only that token to `= "Commercial"` and **943 of
    943 tests stayed green**, because every test passes the argument
    explicitly. It is not an equivalent mutant: a three-argument call flipped
    from refusing to ACCEPTED in the same run.

    WHAT VALUE WOULD MAKE THIS FAIL: re-adding any default to that parameter.
    The argument is now REQUIRED, so the branch is deleted rather than tested
    -- but a future reader can put a default back "for convenience", and this
    is what notices.

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

    This PR's recurring defect is one finding with several sites. The seam
    tests fix that for the site that exists today; this is for the site
    somebody adds next year.

    WHAT VALUE WOULD MAKE THIS FAIL: a second literal `boundary_of_issue(`
    call anywhere in `tick.py`.

    ITS REACH IS NARROWER THAN THAT SENTENCE, and a reviewer measured exactly
    how much: two second-call-site mutants -- a local alias, and
    `getattr(sys.modules[__name__], "boundary_of_issue")` -- both SURVIVED at
    943/943. It also reads only `tick.py`. So this is a guard against the
    ORDINARY shape of the mistake, not a proof that one call site is the only
    one possible. Declared here rather than left implied, because an
    overstated guard is the thing this file keeps finding.
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
    """The THIRD arm of the producer-shape guard, which nothing witnessed.

    WHAT VALUE WOULD MAKE THIS FAIL: deleting
    `if not isinstance(declared, dict):`. A reviewer deleted its predecessor
    on 2026-09-27 and 936 of 936 tests stayed green -- the bare-string arm
    above is a DIFFERENT branch and does not cover this one. (The clause
    then read `... or not declared`; that half was dead and is gone.)
    Two arms of one guard, one of them unwitnessed: the same two-sites-one-
    label shape that this PR has now produced three times.

    AN EMPTY DICT DOES NOT REACH THIS GUARD, and an earlier revision of this
    docstring said it did. `if not declared:` above catches `{}` first, because
    an empty dict is falsy -- a reviewer deleted the `or not declared` clause
    and measured no behaviour change, so the clause was dead and is now gone.
    The empty case is still covered below; it simply takes the `no declared
    producer` arm, which is why this test accepts either message and says so.
    """
    for broken in ({}, [], 0, ["loom-roll-and-validate"]):
        policy = copy.deepcopy(POLICY)
        policy["receipt_producers"]["deploy-run"] = broken
        with pytest.raises(tick.ReceiptRefusedError) as exc:
            tick.verify_run_backed_receipt("deploy-run", _roll(), policy, "Commercial")
        # WHICH ARM FIRES, measured rather than asserted: `{}`, `[]` and `0`
        # are ALL falsy, so three of these four take the `no declared
        # producer` arm and only the non-empty list reaches the shape guard
        # this test is named for. An earlier revision of this comment said
        # "the rest are truthy non-dicts", which is wrong for two of them.
        # Both arms are refusals, so the SET of acceptable messages is what
        # is asserted -- but the set is the weaker claim and it says so.
        assert ("neither a boundary" in str(exc.value)
                or "no declared producer" in str(exc.value)), (broken, str(exc.value))


@pytest.mark.real_boundary
def test_a_caller_passing_no_boundary_is_refused():
    """The `if not boundary:` guard, which nothing witnessed either.

    WHAT VALUE WOULD MAKE THIS FAIL: replacing that guard with
    `boundary = "Commercial"`. A reviewer did it on 2026-09-27 and 936 of 936
    stayed green. `boundary_of_issue` now either returns a value or raises, so
    this guard is only reachable by a DIRECT caller -- which is exactly why it
    needs its own test rather than relying on the seam.
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
    that exact shape. No population count is given: two were published here
    and a reviewer falsified each.

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
    """THE OPERATOR'S 2026-09-27 DECISION, in one assertion.

    WHAT VALUE WOULD MAKE THIS FAIL: `defaults.get(kind, "Commercial")`, or
    reverting `default_boundary` to a bare string so every kind shares one
    value. Either re-exposes the 16 unlabelled Gov-about `deploy-run` items --
    #3449 `deploy-fiab-gcch is failing` and #4424 `gov-console-roll is
    failing` among them -- to closure on a Commercial roll.

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
    `boundary_of_issue`. An issue carrying a label literally named `_` then
    resolves to the documentation STRING, and that whole paragraph becomes the
    "boundary" a producer is looked up under. A reviewer's mutation removing
    that filter survived the suite on 2026-09-27; this is the arm that kills it.
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
    `defaults`. A receipt kind literally named `_` would then resolve to the
    documentation paragraph as its boundary -- the mirror of the defect above,
    at a site the boundary-label arm does not cover.
    """
    monkeypatch.setattr(tick, "sh", _labels_stub(["lane:bicep"]))
    with pytest.raises(tick.ReceiptRefusedError, match=r"no entry in policy\.default_boundary"):
        tick.boundary_of_issue("o/r", 1, POLICY, "_")


@pytest.mark.real_boundary
def test_a_label_merely_containing_a_mapped_one_does_not_match(monkeypatch):
    """Exact match, not substring.

    WHAT VALUE WOULD MAKE THIS FAIL: `any(k in name for k in mapping)`. A
    substring rule would read `not-drift-gov` or `drift-gov-triaged` as Gov,
    silently routing an item to a boundary nobody assigned it. A reviewer's
    substring mutation survived the suite on 2026-09-27 because nothing
    distinguished the two.
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
    default instead of raising. "gh returned something unexpected" would then
    become "this item is Commercial" -- R7's exact failure shape, and a
    reviewer's mutation of that clause survived the suite on 2026-09-27.
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
    one buys nothing in the declared -> implemented direction. Four such rows
    shipped in this change's first cut (`receipt_producers.g1-browser`,
    `.estate`, `.deploy-run`, and `boundary_labels`) and a reviewer deleted
    all four with the suite green.

    PRECISION A REVIEWER MEASURED ON 2026-09-27, because the first version of
    this docstring was wrong in the direction that matters: such a row is NOT
    "never consulted". `assert_policy_matches_code` walks the OTHER direction,
    implemented -> declared, and does read it. The rows were REDUNDANT with
    their `.Commercial` leaves, not inert, and this test guards one direction
    only. Calling a redundant row "decoration" overstates what deleting it
    proves.

    WHAT VALUE WOULD MAKE THIS FAIL: re-adding any of those four, or declaring
    any future namespace key.

    SCOPE, and it is deliberate per `assertion-design.md` "done" #4: this binds
    the keys THIS change owns. Five pre-existing namespace rows are redundant
    for the same reason and are named in the allowlist rather than deleted --
    they predate this rule and removing them is not this PR's work.
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
    #: grow. Measured 2026-09-27.
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
