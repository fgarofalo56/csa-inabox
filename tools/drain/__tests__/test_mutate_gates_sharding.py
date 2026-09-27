"""Tests for the SHARD SPLIT of the mutation runner (#4712).

The matrix outgrew one runner. At 413 arms it ran 44m54s against its own
``timeout-minutes: 45`` and reported CANCELLED -- including on a head that added
no arms and no tests, so the population, not any one PR, no longer fit. It was
split six ways on 2026-09-25 following #4682's vitest shape.

THE SPLIT INTRODUCED A NEW WAY FOR THIS INSTRUMENT TO STOP WATCHING. Five green
shards and one that never started read, to anything counting only outcomes,
exactly like a clean matrix. `mutate_gates.adjudicate` is where that is refused,
and it is a pure function for the reason this package's whole history is about:
a decision inside ``main()`` is a decision no test can reach -- round 16 and
round 19 were both spent moving decisions out of it after a reviewer measured
four wiring mutations surviving there.

These live in their own module rather than in ``test_mutate_gates.py`` for one
practical reason and one principled one: that file is edited by several open
lanes at once, and the sharding decisions are a separate seam with a separate
positive control.

EVERY TEST BELOW NAMES THE VALUE THAT MAKES IT FAIL, per
``.claude/rules/assertion-design.md``. The positive control
(``test_a_complete_honest_set_of_receipts_is_accepted``) is not optional: every
other test here asserts a REFUSAL, and a function that refused unconditionally
would satisfy all of them while failing every real matrix run.
"""
from __future__ import annotations

import json
import os
import re
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import mutate_gates


def _arms(n: int) -> list:
    """`n` arms with DISTINCT names, so a partition bug is nameable.

    Distinct names are not cosmetic. `_multiset_difference` is what turns "the
    union is not the matrix" into "these arms were unrun and these were
    double-assigned"; with identical names every diagnosis would come back empty
    and the refusal would say nothing a reader could act on.
    """
    return [(f"A{i}", "gates.py", f"old{i}", f"new{i}") for i in range(n)]


def _receipt(index, count, arms, *, population=None, **over):
    base = mutate_gates.build_receipt(
        index=index, count=count, arms=arms,
        population=len(arms) if population is None else population,
        counts=(len(arms), 0, 0, 0), before="d", after="d", exit_code=0, reason="ok",
    )
    base.update(over)
    return base


def _healthy(n_arms=12, count=3):
    """A complete, honest set of receipts over `_arms(n_arms)` in `count` shards."""
    arms = _arms(n_arms)
    return arms, [
        _receipt(i, count, mutate_gates.shard_of(arms, index=i, count=count),
                 population=n_arms)
        for i in range(1, count + 1)
    ]


def _verdict(receipts, arms, count=3, needs_result="success"):
    return mutate_gates.adjudicate(
        receipts=receipts, arm_names=[a[0] for a in arms],
        count=count, needs_result=needs_result,
    )


# --------------------------------------------------------------------------- #
# the partition itself
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("count", [1, 2, 3, 4, 5, 6, 7, 13])
def test_the_shards_partition_the_arms_exactly(count):
    """TOTAL and DISJOINT for every N, which is what makes a union check
    meaningful in the first place.

    BREAKS ON: `arms[index::count]` -- off by one, so shard 1 loses arm 0 and
    shard `count` comes back empty. Or `arms[index-1:count]`, a slice rather
    than a stride, which returns overlapping prefixes: at count=3 shards 1 and 2
    would both contain arm 2.
    """
    arms = _arms(41)
    union = []
    for i in range(1, count + 1):
        union += [a[0] for a in mutate_gates.shard_of(arms, index=i, count=count)]
    assert sorted(union) == sorted(a[0] for a in arms), "the union is not ARMS"
    assert len(union) == len(set(union)), "an arm landed in two shards"
    # ...and no shard is empty, which `parse_shard` also refuses up front.
    for i in range(1, count + 1):
        assert mutate_gates.shard_of(arms, index=i, count=count), f"shard {i} is empty"


def test_the_real_arms_list_partitions_exactly_at_the_shipped_shard_count():
    """The property above, asserted over the POPULATION THE WORKFLOW ACTUALLY
    RUNS rather than over a fixture.

    BREAKS ON: the same off-by-one, and additionally on `ARMS` acquiring a
    DUPLICATE NAME -- which would make the adjudicator's multiset comparison
    still correct but every "Unrun:" diagnosis ambiguous. `.github/workflows/
    test.yml` dispatches `--shard i/6`, so 6 is the number that matters.
    """
    names = [a[0] for a in mutate_gates.ARMS]
    assert len(names) == len(set(names)), (
        "two arms share a name; the adjudicator's union diagnosis could not "
        "tell you which of them went unrun"
    )
    union = []
    for i in range(1, 7):
        union += [a[0] for a in mutate_gates.shard_of(mutate_gates.ARMS, index=i, count=6)]
    assert sorted(union) == sorted(names)
    assert len(union) == len(mutate_gates.ARMS)


@pytest.mark.parametrize(("spec", "needle"), [
    ("3", "takes 'i/N'"),
    ("3/", "takes 'i/N'"),
    ("a/b", "takes 'i/N'"),
    ("", "takes 'i/N'"),
    ("0/6", "outside 1..6"),
    ("7/6", "outside 1..6"),
    ("1/0", ">= 1"),
    ("1/500", "would be assigned nothing"),
])
def test_parse_shard_refuses_every_spec_that_would_narrow_the_run(spec, needle):
    """Each row IS the value that breaks the refusal it names.

    `0/6` and `7/6` matter most, because Python does not complain: `arms[-1::6]`
    returns a WRONG non-empty slice and `arms[6::6]` returns an EMPTY one. Both
    look like a shard that ran, and an empty shard exits 0 through every
    outcome-shaped check.
    """
    with pytest.raises(ValueError, match=re.escape(needle)):
        mutate_gates.parse_shard(spec, 389)


def test_parse_shard_accepts_the_shapes_the_workflow_uses():
    """POSITIVE CONTROL for the eight refusals above. An over-strict parser that
    rejected EVERYTHING would satisfy all of them and break every shard job.

    BREAKS ON: tightening the regex so whitespace is rejected, or making `1/1`
    invalid -- `1/1` is the no-argument default, i.e. every local invocation and
    everything `tools/drain/README.md` documents.
    """
    assert mutate_gates.parse_shard("1/1", 389) == (1, 1)
    assert mutate_gates.parse_shard("6/6", 389) == (6, 6)
    assert mutate_gates.parse_shard(" 2 / 6 ", 389) == (2, 6)


def test_the_receipt_reports_the_arms_it_was_actually_handed():
    """`assigned` and `assigned_names` are DERIVED from the same list the
    dispatch consumed -- `_exit_args`'s lesson applied to the new wiring.

    BREAKS ON: sourcing `assigned` from `population`, or from `counts[0]`
    (killed). Round 19 MEASURED both of those surviving when the equivalent
    expressions lived at a call site in `main()`: `total=killed` made two
    partition refusals vacuously true, and nothing could reach it.
    """
    arms = _arms(5)
    receipt = mutate_gates.build_receipt(
        index=2, count=3, arms=arms, population=99, counts=(1, 2, 3, 4),
        before="b", after="a", exit_code=7, reason="why",
    )
    assert receipt["assigned"] == 5
    assert receipt["population"] == 99
    assert receipt["assigned_names"] == ["A0", "A1", "A2", "A3", "A4"]
    assert (receipt["killed"], receipt["survived"],
            receipt["skipped"], receipt["errored"]) == (1, 2, 3, 4)
    assert receipt["exit_code"] == 7
    assert receipt["reason"] == "why"
    assert receipt["schema"] == mutate_gates.RECEIPT_SCHEMA


# --------------------------------------------------------------------------- #
# adjudication: the POSITIVE CONTROL first
# --------------------------------------------------------------------------- #

def test_a_complete_honest_set_of_receipts_is_accepted():
    """THE POSITIVE CONTROL, and it is not optional.

    Every test below asserts a REFUSAL. A function that refused unconditionally
    would satisfy all of them while failing every real matrix run -- the
    "could not pass" failure mode `assertion-design.md` records costing a whole
    round, where a test went red against the fix AND against the defect.

    BREAKS ON: any refusal in `adjudicate` firing on a well-formed run.
    """
    arms, receipts = _healthy()
    code, why = _verdict(receipts, arms)
    assert code == 0, why
    assert "all 12 arms KILLED across 3 shards" in why
    assert "covered exactly once" in why


# --------------------------------------------------------------------------- #
# ...then the refusals. The three the issue names come first.
# --------------------------------------------------------------------------- #

def test_a_shard_reporting_fewer_arms_than_it_was_assigned_is_refused():
    """BREAKS ON: dropping the `scored != assigned` check.

    THE VALUE: shard 2 was handed 4 arms and its four buckets sum to 3. That is
    a dispatch loop that fell out partway -- a `break`, a swallowed exception, a
    lost subprocess -- and every OTHER field stays self-consistent, which is
    what makes it invisible to a check on the totals. `_exit_code` asks exactly
    this question of an unsharded run; the split has to keep asking it per shard.
    """
    arms, receipts = _healthy()
    receipts[1]["killed"] = 3          # was 4; the other three buckets are 0
    code, why = _verdict(receipts, arms)
    assert code == 1
    assert "scored 3 arms but was assigned 4" in why


def test_a_shard_claiming_more_arms_than_it_names_is_refused():
    """The other half of the same seam, and a genuinely distinct input.

    BREAKS ON: dropping `assigned != len(assigned_names)`.

    THE VALUE: `assigned: 4` beside three names. Without this, `assigned` is a
    number the adjudicator TRUSTS rather than measures -- and the union check
    would then be comparing a truthful name list against a total inflated to
    match `ARMS`, so the two checks would disagree and neither would fire.
    """
    arms, receipts = _healthy()
    receipts[0]["assigned_names"] = receipts[0]["assigned_names"][:-1]
    code, why = _verdict(receipts, arms)
    assert code == 1
    assert "claims 4 arms but names 3" in why


def test_a_union_that_does_not_cover_every_arm_is_refused():
    """THE ARM-TOTAL ASSERTION, in its strongest available form.

    BREAKS ON: dropping the name-set comparison, or weakening it to a count.

    THE VALUE: shard 3 hands back shard 1's arms instead of its own. Every count
    in every receipt is IDENTICAL to a healthy run -- three shards, four arms
    each, twelve scored, twelve killed, and `sum(assigned) == len(ARMS)` -- so a
    count-based total check passes it while four arms were never mutated at all.
    Only comparing the NAMES refuses it.

    THAT IS WHY `adjudicate` HAS NO SEPARATE `sum(assigned) == len(ARMS)`
    REFUSAL. Given `assigned == len(assigned_names)` (pinned in the test above),
    that sum is arithmetically implied by this comparison, so adding it would be
    an EQUIVALENT MUTANT -- no input could distinguish its presence from its
    absence. `_exit_code`'s docstring records measuring exactly that and
    collapsing two checks into one.
    """
    arms, receipts = _healthy()
    receipts[2]["assigned_names"] = list(receipts[0]["assigned_names"])
    code, why = _verdict(receipts, arms)
    assert code == 1
    assert "covered 12 arms" in why
    assert "declares 12" in why
    # The DIAGNOSIS is the point: the unrun arms are NAMED, not merely counted.
    assert "Unrun: ['A11', 'A2', 'A5', 'A8']" in why
    assert "Double-assigned or unrecognised: ['A0', 'A3', 'A6', 'A9']" in why


@pytest.mark.parametrize("result", ["cancelled", "failure", "skipped", ""])
def test_a_shard_job_that_did_not_succeed_is_never_counted_as_a_pass(result):
    """BREAKS ON: hardcoding `success` at the call site, or dropping this
    refusal entirely.

    THE VALUE: `cancelled`. That is exactly what a `timeout-minutes` overrun
    reports -- the outcome #4712 is about -- and the receipts fed in here are a
    COMPLETE, HEALTHY SET, which is the case that matters: an artifact left from
    an earlier attempt of the same run is downloadable even though this
    attempt's shards measured nothing. The missing-receipt check below cannot
    see that; only the job result can.

    `skipped` is a different event (never scheduled), and `""` covers the
    aggregate being unavailable at all -- which must not read as success by
    omission.
    """
    arms, receipts = _healthy()
    code, why = _verdict(receipts, arms, needs_result=result)
    assert code == 1
    assert f"concluded {result!r}, not 'success'" in why


def test_a_missing_receipt_is_refused_and_the_shard_is_named():
    """The other half of "did not execute": a shard that never started uploads
    nothing at all.

    BREAKS ON: iterating the receipts that ARE present instead of comparing
    against `range(1, count+1)`. That is the natural way to write this loop and
    it grades whatever showed up -- five green shards out of six, reported as a
    clean matrix. It is the whole failure this issue exists to close.

    THE VALUE: two receipts where three shards were dispatched.
    """
    arms, receipts = _healthy()
    code, why = _verdict([receipts[0], receipts[2]], arms)
    assert code == 1
    assert "missing=[2]" in why


def test_two_receipts_claiming_one_shard_are_refused():
    """BREAKS ON: building the index map with a plain assignment, so a second
    receipt for shard 1 silently overwrites the first.

    THE VALUE: shard 1's receipt twice and shard 2's never. The NUMBER of
    receipts is still 3, so any length-based check passes; without the explicit
    duplicate refusal the run would be graded on two shards' worth of arms.
    """
    arms, receipts = _healthy()
    code, why = _verdict([receipts[0], receipts[0], receipts[2]], arms)
    assert code == 1
    assert "two receipts claim shard 1" in why.lower()


def test_a_receipt_with_an_unusable_index_is_refused():
    """BREAKS ON: dropping the `isinstance(index, int)` guard.

    THE VALUE: `shard_index: null`, which is what a truncated or
    half-serialised receipt carries. `None` is hashable, so it would key the
    map happily and then be reported as an "unexpected" shard rather than as an
    unreadable one -- a diagnosis that sends the reader to the matrix axis.
    """
    arms, receipts = _healthy()
    receipts[1]["shard_index"] = None
    code, why = _verdict(receipts, arms)
    assert code == 1
    assert "not an integer" in why


def test_a_receipt_from_a_different_population_is_refused():
    """BREAKS ON: dropping the `population` comparison.

    THE VALUE: a shard that ran against 11 arms while this checkout declares 12
    -- a receipt produced at a different commit, or an `ARMS` truncated between
    the shard and the merge. Its own counts are perfectly consistent, and it
    would otherwise contribute its arms to a union that then looks short for an
    unexplained reason.
    """
    arms, receipts = _healthy()
    receipts[0]["population"] = 11
    code, why = _verdict(receipts, arms)
    assert code == 1
    assert "ran against a matrix of 11 arms" in why


def test_a_shard_that_ran_a_different_topology_is_refused():
    """BREAKS ON: dropping the `shard_count` comparison.

    THE VALUE: a receipt saying `2/4` inside a 3-shard adjudication. This is the
    #4679 coupling failure reaching run time -- the matrix axis and the
    `--shard` denominator out of step. The union check alone would report unrun
    arms without naming the cause, and the cause is the one thing that tells you
    where to look.
    """
    arms, receipts = _healthy()
    receipts[1]["shard_count"] = 4
    code, why = _verdict(receipts, arms)
    assert code == 1
    assert "adjudicates 3 shards" in why


def test_a_survivor_in_any_shard_is_refused():
    """The thing the matrix exists to find must still be findable after the split.

    BREAKS ON: dropping `killed != assigned`.

    THE VALUE: shard 2 with `killed=3 survived=1`. The partition still holds
    (3+1 == 4), so the `scored != assigned` check passes it, and every other
    field is healthy. A SURVIVED arm is a blind spot in the drain's suite; if
    sharding lost it, the split would have cost the guarantee it exists to keep.
    """
    arms, receipts = _healthy()
    receipts[1].update(killed=3, survived=1)
    code, why = _verdict(receipts, arms)
    assert code == 1
    assert "not every arm died: killed=3 of 4" in why


def test_a_shard_that_escaped_its_sandbox_is_refused():
    """BREAKS ON: dropping the `before != after` comparison -- which round 16
    MEASURED surviving when it lived at a call site as `tree_intact=True`.

    THE VALUE: a shard whose digests differ while every count is clean. An arm
    wrote into the tracked tree, so nothing that shard reports can be trusted --
    and what it reports is `killed == assigned`.
    """
    arms, receipts = _healthy()
    receipts[2]["after"] = "different"
    code, why = _verdict(receipts, arms)
    assert code == 1
    assert "TRACKED TREE CHANGED" in why


def test_a_shard_that_refused_before_any_arm_ran_is_refused():
    """THE CATCH-ALL, and the disclosure that goes with it.

    BREAKS ON: dropping the `exit_code != 0` check.

    THE VALUE: `exit_code: 2` with all four buckets at 0, matching digests and
    an empty assignment -- i.e. a PREAMBLE refusal (red control, skip drift,
    population drift). Every other check here admits it, because every other
    check reads ARM RESULTS and a preamble refusal produces none.

    This is NOT an equivalent mutant of the partition / tree / killed checks: it
    is what stops the adjudicator silently under-reading a runner that has
    learned a refusal this function does not mirror.

    The shard is assigned NO arms in this fixture, which is what a refusal
    before the arm loop really looks like -- and note that the union check then
    reports those arms unrun as well. Both fire; the exit-code refusal is
    ordered first so the reader is sent to the control, not to the arms.
    """
    arms = _arms(12)
    receipts = [
        _receipt(i, 3, mutate_gates.shard_of(arms, index=i, count=3), population=12)
        for i in (1, 2)
    ]
    receipts.append(mutate_gates.build_receipt(
        index=3, count=3, arms=[], population=12, counts=(0, 0, 0, 0),
        before="d", after="d", exit_code=2,
        reason="control is not green; nothing below would mean anything",
    ))
    code, why = _verdict(receipts, arms)
    assert code == 1
    assert "shard 3 exited 2" in why
    # The SHARD'S OWN diagnosis is carried through. An adjudicator that said
    # only "shard 3 failed" would send the reader to the arms rather than to
    # the control that refused before any arm ran.
    assert "control is not green" in why


def test_an_unreadable_receipt_is_refused_rather_than_skipped():
    """BREAKS ON: dropping the schema check, or `continue`-ing past a receipt
    whose shape is not understood.

    THE VALUE: `schema: 'drain-mutation-shard/2'`. A future receipt format this
    adjudicator silently ignored would reduce the population without reducing
    any count it checks -- an unreadable shard and a passing shard becoming the
    same observation, which is the one thing the split must not do.
    """
    arms, receipts = _healthy()
    receipts[0]["schema"] = "drain-mutation-shard/2"
    code, why = _verdict(receipts, arms)
    assert code == 1
    assert "declares schema" in why


def test_an_empty_matrix_is_refused():
    """BREAKS ON: dropping the empty check.

    THE VALUE: `ARMS[:0]` with zero receipts and `count=0`. Every comparison in
    `adjudicate` is satisfied vacuously by that input -- no indices to miss, no
    names to mismatch, no buckets to disagree -- so without this it returns 0.
    Green over nothing: the `steps=0` shape this repo refuses everywhere else,
    and the same refusal `_exit_code` carries for the unsharded case.
    """
    code, why = mutate_gates.adjudicate(
        receipts=[], arm_names=[], count=0, needs_result="success")
    assert code == 1
    assert "EMPTY" in why


def test_the_receipt_loader_distinguishes_absent_from_empty(tmp_path):
    """A directory that does not exist, and one holding no JSON, are DIFFERENT
    faults and neither of them is "no receipts".

    BREAKS ON: returning `([], "")` for either. `adjudicate` would then get an
    empty list and produce the right refusal with the WRONG diagnosis -- the
    reader goes looking for a shard that failed rather than for a download step
    that never ran.
    """
    absent, why = mutate_gates._load_receipts(tmp_path / "nope")
    assert absent == []
    assert "is not a directory" in why

    (tmp_path / "empty").mkdir()
    none, why = mutate_gates._load_receipts(tmp_path / "empty")
    assert none == []
    assert "holds no *.json receipt" in why

    # A malformed receipt is refused too -- never skipped past, which would
    # quietly shrink the population the adjudicator grades.
    (tmp_path / "empty" / "a.json").write_text("{not json", encoding="utf-8")
    bad, why = mutate_gates._load_receipts(tmp_path / "empty")
    assert bad == []
    assert "not readable JSON" in why

    # POSITIVE CONTROL, and it pins RECURSION specifically. The workflow
    # downloads each artifact into its own subdirectory because all six carry
    # the same filename; a non-recursive glob would find nothing and report
    # "holds no receipt" on a perfectly healthy run.
    (tmp_path / "empty" / "a.json").unlink()
    for i in (1, 2):
        sub = tmp_path / "empty" / f"drain-mutation-receipt-{i}"
        sub.mkdir()
        (sub / "shard-receipt.json").write_text(
            json.dumps({"shard_index": i}), encoding="utf-8")
    found, why = mutate_gates._load_receipts(tmp_path / "empty")
    assert why == ""
    assert sorted(r["shard_index"] for r in found) == [1, 2]


def test_the_multiset_difference_counts_repeats():
    """`_multiset_difference` is what makes the union diagnosis legible, and a
    set difference would silently empty it.

    BREAKS ON: `sorted(set(left) - set(right))`. THE VALUE: `['A','A','B']`
    minus `['A']` -- a set difference returns `['B']` and loses the second `A`,
    which is exactly the double-assignment the union check exists to name.
    """
    assert mutate_gates._multiset_difference(["A", "A", "B"], ["A"]) == ["A", "B"]
    assert mutate_gates._multiset_difference(["A"], ["A", "A"]) == []
    assert mutate_gates._multiset_difference([], []) == []
