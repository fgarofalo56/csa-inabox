"""Tests for the COMPLETION PATH -- the half of the harness that was missing.

`complete.py` is the first production caller of `Ledger.record_receipt`. Before
it, zero of 303 items had ever reached a terminal state and none could: the only
producer of receipts was called exclusively from tests, so
`_refuse_unless_receipted` refused every close forever.

That makes this module the one that CLOSES ISSUES UNATTENDED, so every test here
is a refusal. The accept side is one test; the rest are the ways it must decline.

Run:  python -m pytest tools/drain/__tests__/ -q
"""
from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import complete
from ledger import AWAITING_RECEIPT, CLOSED, READY, Ledger

import gates

POLICY = gates.load_policy(os.path.join(os.path.dirname(__file__), "..", "policy.json"))
RECEIPTS = POLICY["receipts"]


def _led(tmp_path) -> Ledger:
    return Ledger(str(tmp_path / "state.json"), receipts=RECEIPTS)


def _bind(monkeypatch, led=None, pr=999, merged_at="2026-01-01T00:00:00Z",
          rejected=False):
    """Stand in for the GitHub round-trips AND bind the ledger's items.

    Binding is EXPLICIT now: `Item.pr` is what makes an item eligible, because a
    prose claim in a merged PR is not a completion oracle -- see
    `test_a_prose_claim_alone_never_closes_anything` for the case that proved it.
    """
    monkeypatch.setattr(
        complete, "build_closing_map",
        lambda _repo: dict.fromkeys(range(1, 50), (pr, merged_at, f"body of PR #{pr}")))
    monkeypatch.setattr(
        complete, "operator_reopened_after",
        lambda _repo, _n, _when: (rejected, "someone REOPENED it" if rejected else ""))
    if led is not None:
        for item in led.items.values():
            item.pr = pr


# ---------------------------------------------------------------------------
# gather(): every abnormal outcome is a refusal, never evidence
# ---------------------------------------------------------------------------


def test_an_unknown_receipt_kind_refuses_rather_than_guessing():
    found = complete.gather("no-such-kind", "owner/repo", 1)
    assert not found.ok
    assert "has no adapter" in found.why


def test_an_adapter_that_raises_is_a_refusal_not_a_crash(monkeypatch):
    def boom(_repo, _pr):
        raise RuntimeError("the API fell over")

    monkeypatch.setitem(complete.ADAPTERS, "ci-green", boom)
    found = complete.gather("ci-green", "owner/repo", 1)
    assert not found.ok
    assert "raised RuntimeError" in found.why


def test_an_adapter_returning_the_wrong_type_is_a_refusal(monkeypatch):
    monkeypatch.setitem(complete.ADAPTERS, "ci-green", lambda _r, _p: True)
    found = complete.gather("ci-green", "owner/repo", 1)
    assert not found.ok
    assert "not Evidence" in found.why


def test_evidence_with_an_empty_ref_is_refused(monkeypatch):
    """A receipt with no reference cannot be re-checked, so it is not one. This
    is the shape that would let an adapter 'pass' while recording nothing a
    reader could follow.

    Driven through `gather`, the real entry point -- an assertion against a
    helper the production path does not call would be testing a second
    implementation.
    """
    monkeypatch.setitem(complete.ADAPTERS, "ci-green",
                        lambda _r, _p: complete.Evidence(True, "   ", "looks fine"))
    found = complete.gather("ci-green", "owner/repo", 1)
    assert not found.ok
    assert "EMPTY ref" in found.why


def test_human_only_never_closes_automatically():
    found = complete.gather("operator", "owner/repo", 1)
    assert not found.ok
    assert "person's judgement" in found.why


@pytest.mark.parametrize("kind", ["deploy-run", "g1-browser", "estate"])
def test_a_declared_kind_with_no_producer_refuses_and_says_so(kind):
    """"No producer yet" and "no evidence found" have different remedies, so
    they are different sentences (R7)."""
    found = complete.gather(kind, "owner/repo", 1)
    assert not found.ok
    assert "no producer" in found.why


# ---------------------------------------------------------------------------
# the sweep
# ---------------------------------------------------------------------------


def test_a_dry_run_writes_nothing(tmp_path, monkeypatch):
    led = _led(tmp_path)
    led.upsert(1, "a guard", "W0-harness", lane="lane:harness", size=1)
    _bind(monkeypatch, led)
    monkeypatch.setitem(complete.ADAPTERS, "ci-green",
                        lambda _r, _p: complete.Evidence(True, "PR #999 @ abc", "green"))

    closed, examined = complete.sweep(led, POLICY, "owner/repo",
                                      dry_run=True, limit=None, only=None)
    assert (closed, examined) == (1, 1)
    assert led.items[1].state == READY, "a dry run must not move the item"
    assert led.items[1].receipt_kind is None, "a dry run must not record a receipt"


def test_a_live_sweep_records_the_receipt_and_closes(tmp_path, monkeypatch):
    """THE ACCEPT SIDE, and the first production call to `record_receipt`."""
    led = _led(tmp_path)
    led.upsert(1, "a guard", "W0-harness", lane="lane:harness", size=1)
    _bind(monkeypatch, led)
    monkeypatch.setitem(complete.ADAPTERS, "ci-green",
                        lambda _r, _p: complete.Evidence(True, "PR #999 @ abc123", "green"))

    closed, _ = complete.sweep(led, POLICY, "owner/repo",
                               dry_run=False, limit=None, only=None)
    assert closed == 1
    item = led.items[1]
    assert item.state == CLOSED
    assert item.receipt_kind == "ci-green"
    assert "PR #999 @ abc123" in item.receipt_ref
    assert item.receipt_taken_under == "guard-or-test-only"
    assert any("abc123" in line for line in item.history), (
        "the evidence ref must be in history, or a wrong close is untraceable"
    )


def test_an_item_a_person_reopened_is_never_reclosed(tmp_path, monkeypatch):
    """THE GUARD THAT STOPS THIS OVERRIDING A HUMAN, and it is not hypothetical.

    #2678 carries `Closes #2678.` in merged PR #3012's body AND in a commit
    body; GitHub closed it at 2026-08-06T03:42:31Z; the operator REOPENED it
    thirteen hours later. A merged `closes` is a hypothesis, and re-closing what
    a person deliberately reopened is worse than closing nothing.
    """
    led = _led(tmp_path)
    led.upsert(1, "a guard", "W0-harness", lane="lane:harness", size=1)
    _bind(monkeypatch, led, rejected=True)
    monkeypatch.setitem(complete.ADAPTERS, "ci-green",
                        lambda _r, _p: complete.Evidence(True, "PR #999 @ abc", "green"))

    closed, examined = complete.sweep(led, POLICY, "owner/repo",
                                      dry_run=False, limit=None, only=None)
    assert (closed, examined) == (0, 1)
    assert led.items[1].state == READY


def test_an_item_with_no_evidence_moves_to_awaiting_receipt(tmp_path, monkeypatch):
    """The state that existed in `ALL_STATES` and that nothing ever set."""
    led = _led(tmp_path)
    led.upsert(1, "a console surface", "W5-console", lane="lane:console", size=3)
    _bind(monkeypatch, led)

    closed, _ = complete.sweep(led, POLICY, "owner/repo",
                               dry_run=False, limit=None, only=None)
    assert closed == 0
    assert led.items[1].state == AWAITING_RECEIPT
    assert any("awaiting g1-browser" in line for line in led.items[1].history)


def test_the_sweep_refuses_without_a_receipts_map(tmp_path):
    """The ledger refuses per item; the sweep must refuse LOUDLY and up front,
    or every item would report the same per-item error 303 times."""
    led = _led(tmp_path)
    led.upsert(1, "a guard", "W0-harness", lane="lane:harness", size=1)
    with pytest.raises(SystemExit, match="no `receipts` map"):
        complete.sweep(led, {"receipts": {}}, "owner/repo",
                       dry_run=True, limit=None, only=None)


def test_limit_bounds_a_live_run(tmp_path, monkeypatch):
    led = _led(tmp_path)
    for n in (1, 2, 3):
        led.upsert(n, f"guard {n}", "W0-harness", lane="lane:harness", size=1)
    _bind(monkeypatch, led)
    monkeypatch.setitem(complete.ADAPTERS, "ci-green",
                        lambda _r, _p: complete.Evidence(True, "PR #999 @ abc", "green"))

    closed, examined = complete.sweep(led, POLICY, "owner/repo",
                                      dry_run=False, limit=2, only=None)
    assert (closed, examined) == (2, 2)
    assert led.items[3].state == READY, "the limit must bound what is TOUCHED"


def test_only_drains_one_receipt_class(tmp_path, monkeypatch):
    led = _led(tmp_path)
    led.upsert(1, "a guard", "W0-harness", lane="lane:harness", size=1)
    led.upsert(2, "a surface", "W5-console", lane="lane:console", size=3)
    _bind(monkeypatch, led)
    monkeypatch.setitem(complete.ADAPTERS, "ci-green",
                        lambda _r, _p: complete.Evidence(True, "PR #999 @ abc", "green"))

    closed, examined = complete.sweep(led, POLICY, "owner/repo", dry_run=False,
                                      limit=None, only="guard-or-test-only")
    assert (closed, examined) == (1, 1)
    assert led.items[2].state == READY


def test_the_ledgers_own_refusal_still_decides(tmp_path):
    """`complete.py` gathers evidence; it does NOT get to close.

    `transition(CLOSED)` is the enforcement point and it is unchanged. This
    asserts the bar is still where it was: strip the receipt and the close
    raises, whatever this module believes.

    The first version of this test tried to prove it by mapping `ui-surface` to
    `ci-green` and expecting a kind mismatch -- which cannot happen, because
    `sweep` records exactly `receipts[klass]` by construction, so the two always
    agree. A test whose premise the code makes impossible proves nothing, and it
    reached for the network to find that out.
    """
    led = _led(tmp_path)
    led.upsert(1, "a console surface", "W5-console", lane="lane:console", size=3)
    led.record_receipt(1, "g1-browser", "playwright trace 7")
    led.transition(1, CLOSED, "verified live")
    assert led.items[1].state == CLOSED

    led.upsert(2, "another surface", "W5-console", lane="lane:console", size=3)
    led.record_receipt(2, "g1-browser", "playwright trace 8")
    led.items[2].receipt_kind = None          # the receipt goes away
    with pytest.raises(ValueError, match="refusing to close without a receipt"):
        led.transition(2, CLOSED, "no evidence at all")


# ---------------------------------------------------------------------------
# build_closing_map: the INVERTED query
# ---------------------------------------------------------------------------


def test_the_pr_number_is_the_last_trailing_reference_not_the_first():
    """This repo's subjects carry the ISSUE they fix as well as the PR they
    merged as:

        fix(ci): guard the cross-sub lake grant ... (#3338) (#4371)

    That fixes issue 3338 and merged as PR 4371. Taking the FIRST `(#N)` would
    bind the item to its own issue number as though it were a PR, and then look
    up a PR that does not exist.
    """
    subject = "fix(ci): guard the cross-sub lake grant (#3338) (#4371)"
    assert complete._TRAILING_PR_RE.search(subject).group(1) == "4371"

    # A subject with no trailing tag is not a squash merge and must not match.
    assert complete._TRAILING_PR_RE.search("wip: local commit") is None


def test_the_map_reads_the_commit_trail_and_the_pr_body(monkeypatch):
    """Both sources, because neither alone is complete: a squash BODY closed
    #4361 while `closingIssuesReferences` read empty, and some closes are
    declared only in a PR body that never reached a commit message."""
    log = (
        "\x1e2026-08-06T03:42:30Z\x1ffeat(x): a thing (#3012)\x1f"
        "Closes #2678. Refs #2757.\n"
        "\x1e2026-09-01T00:00:00Z\x1ffix(y): another (#4400)\x1f"
        "no closing keyword here\n"
    )
    monkeypatch.setattr(complete.merge_gate, "sh", lambda _args: (0, log, ""))
    monkeypatch.setattr(
        complete.merge_gate, "gh_json",
        lambda _args, _what: [
            {"number": 4401, "body": "Fixes #1234", "mergedAt": "2026-09-02T00:00:00Z"},
        ])

    found = complete.build_closing_map("owner/repo")
    assert found[2678][0] == 3012, "the commit trail half"
    assert "commit of PR #3012" in found[2678][2]
    assert found[1234][0] == 4401, "the PR body half"
    assert 2757 not in found, "a bare `Refs #N` is not a closing keyword"
    assert 4400 not in found, "a commit with no closing keyword claims nothing"


def test_a_pr_does_not_close_itself(monkeypatch):
    """The trailing `(#N)` is the PR's own number. A body that says
    `closes #4371` in PR 4371 is the tag, not a claim on an issue."""
    log = "\x1e2026-01-01T00:00:00Z\x1ffix: thing (#4371)\x1fcloses #4371\n"
    monkeypatch.setattr(complete.merge_gate, "sh", lambda _args: (0, log, ""))
    monkeypatch.setattr(complete.merge_gate, "gh_json", lambda _a, _w: [])
    assert 4371 not in complete.build_closing_map("owner/repo")


def test_the_map_refuses_when_git_history_is_unreadable(monkeypatch):
    """Fails CLOSED. An empty map would read as "no issue is claimed", which is
    indistinguishable from "nothing is done" and would silently skip every item
    rather than say the query broke."""
    monkeypatch.setattr(complete.merge_gate, "sh", lambda _args: (128, "", "not a repo"))
    with pytest.raises(SystemExit, match="cannot read origin/main"):
        complete.build_closing_map("owner/repo")


# ---------------------------------------------------------------------------
# THE CORRECTION: a prose claim is a suggestion, never a decision
# ---------------------------------------------------------------------------


def test_a_prose_claim_alone_never_closes_anything(tmp_path, monkeypatch):
    """THE FALSE POSITIVE THAT CAUSED THE REDESIGN, and it was found by running
    the sweep rather than by reading it.

    The first version resolved an item's PR by scanning merged PR bodies with
    `gates.scan_closing_keywords`. Its first full run proposed closing #3883,
    whose claiming PR body says:

        ## Deliberately NOT closed
        #3883 and #3844 are deploy-path issues whose acceptance is a green
        **run**, not a merge (deploy-integrity R2). They are referenced, never
        closed.

    The scanner matched `closed` + a blank line + `#3883` across a markdown
    heading, because `CLOSING_RE` joins verb and reference with `\\s*` and `\\s`
    matches newlines. GitHub does not act on that -- which is exactly why #3883
    is still open.

    That scanner is a PUBLICATION guard and deliberately over-matches, which is
    safe when warning an author before they publish and UNSAFE as a completion
    oracle. Reusing it here inverted its safety direction. So an unbound item is
    skipped no matter what any PR's prose says.
    """
    led = _led(tmp_path)
    led.upsert(3883, "a deploy-path item", "W1-deploy", lane="lane:deploy", size=3)
    # The map claims it -- exactly as the real one did for #3883.
    monkeypatch.setattr(
        complete, "build_closing_map",
        lambda _repo: {3883: (4199, "2026-08-30T00:13:59Z", "body of PR #4199")})
    monkeypatch.setattr(complete, "operator_reopened_after",
                        lambda _repo, _n, _when: (False, ""))
    monkeypatch.setitem(complete.ADAPTERS, "deploy-run",
                        lambda _r, _p: complete.Evidence(True, "run/1", "green"))

    closed, examined = complete.sweep(led, POLICY, "owner/repo",
                                      dry_run=False, limit=None, only=None)
    assert (closed, examined) == (0, 1), "a prose claim must not close anything"
    assert led.items[3883].state == READY
    assert led.items[3883].receipt_kind is None


def test_the_prose_claim_is_still_surfaced_as_a_suggestion(tmp_path, monkeypatch, capsys):
    """Refusing is not the same as hiding. The map is still built and the
    suggestion still printed, with the exact `--bind` a human would run -- so
    the archaeology stays useful without being authoritative."""
    led = _led(tmp_path)
    led.upsert(3883, "a deploy-path item", "W1-deploy", lane="lane:deploy", size=3)
    monkeypatch.setattr(
        complete, "build_closing_map",
        lambda _repo: {3883: (4199, "2026-08-30T00:13:59Z", "body of PR #4199")})
    monkeypatch.setattr(complete, "operator_reopened_after",
                        lambda _repo, _n, _when: (False, ""))

    complete.sweep(led, POLICY, "owner/repo", dry_run=True, limit=None, only=None)
    out = capsys.readouterr().out
    assert "--bind 3883=4199" in out, out


def test_binding_records_the_pr_and_refuses_a_rebind(tmp_path):
    """`Item.pr` is the writer #4489 asks for, and rebinding is how one PR's
    work silently gets attributed to another's."""
    led = _led(tmp_path)
    led.upsert(1, "a guard", "W0-harness", lane="lane:harness", size=1)
    assert complete.bind(led, ["1=4199"]) == 1
    assert led.items[1].pr == 4199
    assert any("bound to PR #4199" in line for line in led.items[1].history)

    # Same binding twice is harmless; a DIFFERENT one is refused.
    assert complete.bind(led, ["1=4199"]) == 1
    with pytest.raises(SystemExit, match="already bound"):
        complete.bind(led, ["1=4200"])


def test_binding_refuses_malformed_input_and_unknown_items(tmp_path):
    led = _led(tmp_path)
    led.upsert(1, "a guard", "W0-harness", lane="lane:harness", size=1)
    with pytest.raises(SystemExit, match="expects ISSUE=PR"):
        complete.bind(led, ["nonsense"])
    with pytest.raises(SystemExit, match="not in the ledger"):
        complete.bind(led, ["999=1"])


# ---------------------------------------------------------------------------
# A FAULT is the tool being broken; a REFUSAL is the evidence saying no
# ---------------------------------------------------------------------------


def _adapter_dependencies() -> dict[str, set[str]]:
    """Every `<module>.<attr>` this module reaches for, DERIVED from its source.

    Parsed, never hand-listed. A hand-listed set is a second copy of the truth
    that drifts silently the moment an adapter grows a call -- and drift in
    exactly this list is what the test below exists to catch, so the list must
    not be able to drift itself.
    """
    import ast

    src = os.path.join(os.path.dirname(__file__), "..", "complete.py")
    with open(src, encoding="utf-8") as handle:
        tree = ast.parse(handle.read())
    found: dict[str, set[str]] = {}
    for node in ast.walk(tree):
        if (isinstance(node, ast.Attribute)
                and isinstance(node.value, ast.Name)
                and node.value.id in ("merge_gate", "gates", "ledger")):
            found.setdefault(node.value.id, set()).add(node.attr)
    return found


def test_every_symbol_the_adapters_reach_for_actually_exists():
    """The adapters' dependencies RESOLVE -- measured, not assumed.

    This is the test whose absence let a real defect through on 2026-09-14. The
    branch was cut from `main`, where `merge_gate.collect_ci_green_evidence`,
    `merge_gate.resolve_infra_ere` and `gates.ci_green_receipt` do not exist yet
    -- they are #4487's, unmerged. The suite was 24 green tests, and every one
    of them stubbed the adapters, so not one ever CALLED the real thing. The
    only working adapter was dead and nothing said so.

    `gather()` fails closed on the resulting `AttributeError`, which is correct
    and is why nothing unsafe could happen -- but failing closed forever, in
    silence, is the failure mode this whole package is about.
    """
    import importlib

    deps = _adapter_dependencies()
    assert deps, "parsed no module attribute access at all - the parser is wrong"
    missing = []
    for module_name, attrs in sorted(deps.items()):
        module = importlib.import_module(module_name)
        missing += [f"{module_name}.{a}" for a in sorted(attrs) if not hasattr(module, a)]
    assert not missing, (
        "complete.py calls symbols that do not exist on this base: "
        + ", ".join(missing)
        + " -- if these are #4487's, this branch must be stacked on "
          "feat/4487-ci-green-receipt, not on main"
    )


def test_a_raising_adapter_is_marked_a_fault(monkeypatch):
    def boom(_repo, _pr):
        raise RuntimeError("the API fell over")

    monkeypatch.setitem(complete.ADAPTERS, "ci-green", boom)
    found = complete.gather("ci-green", "owner/repo", 1)
    assert not found.ok
    assert found.fault, "an adapter that raised is the TOOL failing, not the evidence"


def test_an_adapter_returning_the_wrong_type_is_marked_a_fault(monkeypatch):
    monkeypatch.setitem(complete.ADAPTERS, "ci-green", lambda _r, _p: True)
    assert complete.gather("ci-green", "owner/repo", 1).fault


def test_an_ordinary_refusal_is_not_a_fault(monkeypatch):
    """The discriminator must actually discriminate.

    Without this, `fault=True` everywhere would pass every other fault test
    while destroying the distinction the field exists to draw.
    """
    monkeypatch.setitem(
        complete.ADAPTERS, "ci-green",
        lambda _r, _p: complete.Evidence(False, "", "checks were red"))
    found = complete.gather("ci-green", "owner/repo", 1)
    assert not found.ok
    assert not found.fault
    # and the kinds that merely have no producer yet are refusals too
    assert not complete.gather("estate", "owner/repo", 1).fault
    assert not complete.gather("operator", "owner/repo", 1).fault
    # ... as is a kind with no adapter at all
    assert not complete.gather("no-such-kind", "owner/repo", 1).fault


def test_a_faulting_adapter_never_moves_the_item(tmp_path, monkeypatch):
    """R7: a broken adapter establishes NOTHING about the item.

    `AWAITING_RECEIPT` means "this has a merged PR and no receipt yet" -- a
    claim about the ITEM. When the adapter faulted, the harness did not look,
    so it may not record that it looked and found nothing.
    """
    led = _led(tmp_path)
    led.upsert(1, "a guard", "W0-harness", lane="lane:harness", size=1)
    _bind(monkeypatch, led)

    def boom(_repo, _pr):
        raise RuntimeError("the API fell over")

    monkeypatch.setitem(complete.ADAPTERS, "ci-green", boom)
    complete.sweep(led, {"receipts": RECEIPTS}, "owner/repo",
                   dry_run=False, limit=None, only=None)
    assert led.items[1].state == READY, "a fault must not restate the item's state"
    assert led.items[1].receipt_kind is None
    assert led.items[1].receipt_ref is None


def test_consecutive_faults_abort_the_sweep(tmp_path, monkeypatch):
    """A structurally dead adapter must stop the run, not print 300 refusals.

    Exiting 0 after touching every item and draining none is the green-dashboard
    outcome; the abort is what converts it into a visible failure.
    """
    led = _led(tmp_path)
    for n in range(1, 11):
        led.upsert(n, f"guard {n}", "W0-harness", lane="lane:harness", size=1)
    _bind(monkeypatch, led)

    calls = []

    def boom(_repo, pr):
        calls.append(pr)
        raise AttributeError("module 'merge_gate' has no attribute 'collect_ci_green_evidence'")

    monkeypatch.setitem(complete.ADAPTERS, "ci-green", boom)
    with pytest.raises(SystemExit, match="faulted"):
        complete.sweep(led, {"receipts": RECEIPTS}, "owner/repo",
                       dry_run=False, limit=None, only=None)
    assert len(calls) == complete.CONSECUTIVE_FAULT_LIMIT, (
        "the sweep must abort AT the limit, not grind through the whole queue")


def test_a_fault_streak_is_consecutive_not_cumulative(tmp_path, monkeypatch):
    """One transient every other item must not eventually trip the breaker.

    The counter resets on any reply that was about an item, so a run that is
    merely flaky completes -- only a run that is BROKEN aborts.
    """
    led = _led(tmp_path)
    for n in range(1, 11):
        led.upsert(n, f"guard {n}", "W0-harness", lane="lane:harness", size=1)
    _bind(monkeypatch, led)

    seen = []

    def flaky(_repo, pr):
        seen.append(pr)
        if len(seen) % 2:
            raise RuntimeError("transient")
        return complete.Evidence(False, "", "checks were red")

    monkeypatch.setitem(complete.ADAPTERS, "ci-green", flaky)
    closed, examined = complete.sweep(led, {"receipts": RECEIPTS}, "owner/repo",
                                      dry_run=False, limit=None, only=None)
    assert examined == 10, "alternating faults must not abort the sweep"
    assert closed == 0


def test_an_item_needing_audit_is_never_swept_closed(tmp_path, monkeypatch):
    """`NEEDS_AUDIT` means the item left GitHub or disagreed with it.

    That is a question to answer BEFORE closing, not after, so it is excluded
    from `COMPLETABLE` -- and the exclusion needs a test, because a state
    quietly re-added to that tuple would let the sweep close exactly the items
    whose bookkeeping is known to be wrong.
    """
    from ledger import NEEDS_AUDIT

    led = _led(tmp_path)
    led.upsert(1, "a guard", "W0-harness", lane="lane:harness", size=1)
    led.items[1].state = NEEDS_AUDIT
    _bind(monkeypatch, led)
    monkeypatch.setitem(
        complete.ADAPTERS, "ci-green",
        lambda _r, _p: complete.Evidence(True, "PR #999 @ abc123", "green"))

    closed, examined = complete.sweep(led, {"receipts": RECEIPTS}, "owner/repo",
                                      dry_run=False, limit=None, only=None)
    assert examined == 0, "a NEEDS_AUDIT item must not even be examined"
    assert closed == 0
    assert led.items[1].state == NEEDS_AUDIT
