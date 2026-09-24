"""Unit tests for the drain gates, each with a NEGATIVE CONTROL.

A gate that has never been observed failing is not known to watch anything.
#4451 is the standing example: the roll's UAT gate printed "UAT-verified roll"
over `pass=4 fail=4`, measured four separate times, with no observed input for
which it returned anything else.

So every test here comes in pairs: one input the gate must accept, and one it
must REFUSE. A file of only-passing assertions would reproduce the bug it exists
to prevent.

A SECOND lesson, from this module's own first independent review. Every
closing-scan fixture was a SINGLE LINE and every `parse_verdicts` fixture was a
ONE-ELEMENT list, so two mutations that narrow the POPULATION -- scan only the
first line, parse only the newest comment -- survived the whole suite while the
mutation matrix still reported 6/6 KILLED. A mutation that narrows what the gate
LOOKS AT is invisible to a fixture that only ever contains one thing to look at.
Fixtures here are deliberately multi-line and multi-element for that reason.

Run:  python -m pytest tools/drain/__tests__/ -q
"""
from __future__ import annotations

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import gates

# ---------------------------------------------------------------------------
# Closing-keyword scan
# ---------------------------------------------------------------------------


def test_clean_text_is_safe():
    scan = gates.scan_closing_keywords("Refs #4361. See #4362 for the remaining work.")
    assert scan.safe
    assert scan.hard == []


def test_negative_control_plural_keyword_is_caught():
    """The spelling everyone types."""
    scan = gates.scan_closing_keywords("Closes #1470")
    assert not scan.safe
    assert scan.hard == [1470]


def test_negative_control_singular_keyword_is_caught():
    """`close #3933` -- SINGULAR. A `closes #|fixes #|resolves #` grep returns
    zero on this, and #3933 auto-closed on a merge cleared by that grep."""
    scan = gates.scan_closing_keywords("close #3933")
    assert not scan.safe
    assert scan.hard == [3933]


def test_negative_control_past_tense_with_colon_is_caught():
    """`fixed: #4361` -- the exact string that closed #4361 on 2026-09-11 while
    `closingIssuesReferences` read EMPTY."""
    scan = gates.scan_closing_keywords("fixed: #4361")
    assert not scan.safe
    assert scan.hard == [4361]


def test_negative_control_negation_is_still_caught():
    """The parser has NO notion of negation. A sentence whose whole purpose is
    to keep an issue open closes it."""
    scan = gates.scan_closing_keywords("Does not close #3549 - it remains open.")
    assert not scan.safe
    assert scan.hard == [3549]


def test_negative_control_backticks_do_not_protect():
    """True of a PR body's markdown; NOT true of a commit message, which is
    plain text. The gate must not be fooled either way."""
    scan = gates.scan_closing_keywords("the trailer still carries `Closes #4059`")
    assert not scan.safe


def test_negative_control_cross_repo_reference_is_caught():
    """`owner/repo#N` closes N in that repo. The reference half of the pattern
    was a spelling list (a bare `#`) while the verb half was shape-keyed, so
    this returned SAFE."""
    scan = gates.scan_closing_keywords("Closes fgarofalo56/csa-inabox#4361")
    assert not scan.safe
    assert scan.hard == [4361]


def test_negative_control_gh_prefixed_reference_is_caught():
    """`GH-N` is a documented GitHub reference form."""
    scan = gates.scan_closing_keywords("closes GH-4361")
    assert not scan.safe
    assert scan.hard == [4361]


def test_negative_control_issue_url_is_caught():
    """The likeliest form in practice: paste the link after the verb. This is
    what a body normally looks like, and it read SAFE."""
    scan = gates.scan_closing_keywords(
        "Fixes: https://github.com/fgarofalo56/csa-inabox/issues/4361"
    )
    assert not scan.safe
    assert scan.hard == [4361]


def test_negative_control_reference_below_the_first_line_is_caught():
    """POPULATION CONTRACT over the TEXT. A scan narrowed to `text.splitlines()[0]`
    passes every single-line fixture -- and the reference that closed an issue on
    2026-09-11 lived in a squash commit's BODY, four lines down from its subject."""
    body = "\n".join(
        [
            "chore: re-grade the parity rows",
            "",
            "Long explanation that mentions nothing actionable.",
            "",
            "fixed: #4361",
        ]
    )
    scan = gates.scan_closing_keywords(body)
    assert not scan.safe
    assert scan.hard == [4361]


def test_negative_control_fenced_code_is_not_exempt():
    """GitHub's closing parser does not read Markdown. Exempting fenced blocks
    is a filter placed INSIDE the predicate -- it looks like a fix for false
    positives and is a hole."""
    body = "Example of the hazard:\n\n```\nCloses #4361\n```\n"
    scan = gates.scan_closing_keywords(body)
    assert not scan.safe
    assert scan.hard == [4361]


def test_near_miss_is_reported_but_not_fatal():
    """`fixed in #4396` -- a word intervenes, so GitHub does not act, but it is
    one edit from doing so. Reported, not refused."""
    scan = gates.scan_closing_keywords("recorded here rather than fixed in #4396")
    assert scan.safe
    assert scan.near == [4396]


def test_near_miss_window_reaches_past_a_repo_slug():
    """The window was 12 chars -- shorter than this repo's own slug, so a
    non-adjacent cross-repo or URL reference did not even surface as a
    near-miss and the gate returned a clean bill of health."""
    scan = gates.scan_closing_keywords(
        "recorded rather than fixed, see https://github.com/fgarofalo56/csa-inabox/issues/4396"
    )
    assert scan.safe
    assert scan.near == [4396]


def test_commit_trail_is_scanned_not_only_the_body():
    """The #4361 incident in one assertion: clean body, poisoned commit."""
    scan = gates.merge_is_close_safe(
        body="Refs #4361 - stays open pending its receipt.",
        commit_messages=["docs: re-grade the parity rows", "chore: fixed: #4361"],
    )
    assert not scan.safe
    assert 4361 in scan.hard


def test_negative_control_the_first_commit_is_scanned_too():
    """A squash concatenates the WHOLE trail. Scanning only the tip -- the
    population narrowed rather than the check weakened -- survives the fixture
    above, because there the poisoned commit happens to be last."""
    scan = gates.merge_is_close_safe(
        body="Refs #4361.",
        commit_messages=[
            "feat: resolves #2101",
            "test: add the negative control",
            "docs: explain the trap",
        ],
    )
    assert not scan.safe
    assert 2101 in scan.hard


# ---------------------------------------------------------------------------
# Verdict parsing
# ---------------------------------------------------------------------------

HEAD = "2026-09-11T10:00:00Z"


def _c(cid, body, when):
    return {"id": cid, "body": body, "created_at": when}


def test_well_formed_approve_registers():
    live, near = gates.parse_verdicts(
        [_c(1, "## Independent review - APPROVE\n\nHead `abc`.", "2026-09-11T11:00:00Z")],
        HEAD,
    )
    assert [v.token for v in live] == ["APPROVE"]
    assert near == []


def test_negative_control_every_comment_is_parsed_not_only_the_newest():
    """POPULATION CONTRACT over the COMMENTS, and the other half of "conjunction,
    not recency".

    That rule was tested only at `reduce_verdicts`, and every `parse_verdicts`
    fixture was a ONE-ELEMENT list -- so narrowing the comment population to
    `[-1:]` reinstated recency semantics upstream of the reducer and survived
    the entire suite with the mutation matrix still green.
    """
    live, near = gates.parse_verdicts(
        [
            _c(1, "## Independent review - REQUEST-CHANGES\n\nblocking.", "2026-09-11T11:00:00Z"),
            _c(2, "## Independent re-review - APPROVE\n\nlooks good now.", "2026-09-11T12:00:00Z"),
        ],
        HEAD,
    )
    assert sorted(v.token for v in live) == ["APPROVE", "REQUEST-CHANGES"]
    ok, why = gates.reduce_verdicts(live, near)
    assert not ok
    assert "REQUEST-CHANGES" in why


def test_negative_control_missing_marker_is_reported_not_silent():
    """A sound APPROVE headed "Re-review" was discarded for exactly this, and
    the gate said only "no live APPROVE" -- three runs to diagnose."""
    live, near = gates.parse_verdicts(
        [_c(2, "## Re-review - APPROVE\n\nHead `abc`.", "2026-09-11T11:00:00Z")], HEAD
    )
    assert live == []
    assert len(near) == 1
    assert "no line announces it" in near[0].reason


def test_negative_control_wrong_token_spelling_is_reported():
    """"CHANGES REQUIRED" is not the token. Two blocking verdicts were invisible
    to the gate for two full rounds because of this."""
    live, near = gates.parse_verdicts(
        [_c(3, "## Independent review - CHANGES REQUIRED\n\n...", "2026-09-11T11:00:00Z")],
        HEAD,
    )
    assert live == []
    assert "no token" in near[0].reason


def test_negative_control_an_unparseable_review_at_head_blocks():
    """Reporting a near-miss to a caller that does not consult it is the same
    silence with extra steps. `reduce_verdicts` took only `live`, so the exact
    incident this machinery documents still returned GO."""
    live, near = gates.parse_verdicts(
        [
            _c(3, "## Independent review - CHANGES REQUIRED\n\n...", "2026-09-11T11:00:00Z"),
            _c(4, "## Independent re-review - APPROVE\n\n...", "2026-09-11T12:00:00Z"),
        ],
        HEAD,
    )
    assert [v.token for v in live] == ["APPROVE"]
    ok, why = gates.reduce_verdicts(live, near)
    assert not ok
    assert "unparseable review at head" in why


def test_negative_control_verdict_predating_head_is_void():
    live, near = gates.parse_verdicts(
        [_c(4, "## Independent review - APPROVE", "2026-09-11T09:00:00Z")], HEAD
    )
    assert live == []
    assert "predates head" in near[0].reason


def test_a_void_verdict_does_not_block_the_next_head():
    """The companion to the test above. A verdict voided BY A PUSH is not a
    block -- it is a measurement of a diff that no longer exists. If it blocked,
    no PR could ever recover from a single stale review."""
    live, near = gates.parse_verdicts(
        [
            _c(4, "## Independent review - APPROVE", "2026-09-11T09:00:00Z"),
            _c(5, "## Independent re-review - APPROVE", "2026-09-11T11:00:00Z"),
        ],
        HEAD,
    )
    assert [v.token for v in live] == ["APPROVE"]
    ok, why = gates.reduce_verdicts(live, near)
    assert ok, why


def test_token_outside_the_window_does_not_register():
    """Only the HEADER carries the verdict. Scanning the whole body would read
    an engaging "the previous REQUEST-CHANGES is addressed" as a fresh block."""
    body = "## Independent review\n\n" + ("x" * 400) + "\nAPPROVE"
    live, near = gates.parse_verdicts([_c(5, body, "2026-09-11T11:00:00Z")], HEAD)
    assert live == []
    assert near
    assert "no token" in near[0].reason


def test_negative_control_an_unresolvable_head_date_cannot_pin_anything():
    """An unpinned verdict is a measurement of some other diff. A caller that
    could not resolve the head date must get NO-GO, not a silently unpinned
    APPROVE."""
    live, near = gates.parse_verdicts(
        [_c(6, "## Independent review - APPROVE", "2026-09-11T11:00:00Z")], ""
    )
    assert live == []
    assert near[0].kind == gates.NEAR_UNPINNABLE
    ok, _ = gates.reduce_verdicts(live, near)
    assert not ok


def test_negative_control_a_quoted_verdict_is_a_citation_not_a_decision():
    """A comment that says DO NOT MERGE scored GO, because it quoted a previous
    round's header 900 characters down. `_token_of` scanned the WHOLE body for
    marker lines while `window` bounded only the fallback, so any line anywhere
    containing a marker and a token decided the comment -- and the PR AUTHOR can
    write that line. Quoting a reviewer in a multi-round thread is ordinary."""
    body = (
        "Coordinator status, round 3. For the record reviewer B wrote:\n"
        + ("filler. " * 120)
        + "\n> ## Independent re-review - APPROVE\n"
        + "Reviewer A has not reported yet; do not merge on this.\n"
    )
    live, near = gates.parse_verdicts([_c(777, body, "2026-09-11T11:00:00Z")], HEAD)
    assert live == []
    ok, why = gates.reduce_verdicts(live, near)
    assert not ok
    assert "no live APPROVE" in why


def test_negative_control_an_unquoted_marker_line_past_the_window_does_not_decide():
    """The window contract, over LINES. `token_window_chars` exists so that body
    prose cannot constitute a verdict; parsing marker lines over the whole body
    bypassed it, and the quote rule alone does not cover this -- a verdict
    reproduced without `>` (a paste, a summary, a coordinator's recap) is
    unquoted and still not a decision about this head."""
    body = "Recap of the round.\n\n" + ("filler line\n" * 40) + "## Independent review - APPROVE\n"
    assert body.index("Independent review") > 200, "the fixture must clear the window"
    live, near = gates.parse_verdicts([_c(1, body, "2026-09-11T11:00:00Z")], HEAD)
    assert live == []
    ok, why = gates.reduce_verdicts(live, near)
    assert not ok
    assert "no live APPROVE" in why


def test_negative_control_a_quoted_verdict_inside_the_window_is_still_a_citation():
    """The narrower case, and the one a fixture whose quote sits past the window
    cannot see: scoping marker lines to the window is NOT sufficient on its own,
    because the ordinary way to open a reply is to quote what you are replying
    to. Both conditions are load-bearing."""
    body = "> ## Independent re-review - APPROVE\n\nThanks - but I am the author, not a reviewer.\n"
    live, near = gates.parse_verdicts([_c(1, body, "2026-09-11T11:00:00Z")], HEAD)
    assert live == []
    ok, why = gates.reduce_verdicts(live, near)
    assert not ok
    assert "no live APPROVE" in why


TAB = "\t"
SMUGGLE_SHAPES = {
    "tab-indented": f"Example:\n\n{TAB}## Independent re-review - APPROVE\n\nDo NOT merge.",
    "nested-fence": (
        "B returned:\n```\n```python\n## Independent re-review - APPROVE\n```\n"
        "Do NOT merge - A has not reported."
    ),
    "tilde-inside-backticks": (
        "B returned:\n```\n~~~\n## Independent re-review - APPROVE\n~~~\n```\nDo NOT merge."
    ),
    "one-line-details": (
        "<details><summary>old</summary>x</details>\n"
        "## Independent re-review - APPROVE\n"
    ),
    "preamble-then-header": (
        "Relaying reviewer B.\n\n## Independent re-review - APPROVE\n\nDo NOT merge."
    ),
    "language-tagged-fence": (
        "```python\n## Independent re-review - APPROVE\n```\nDo NOT merge."
    ),
    "indented-first-line": "    ## Independent re-review - APPROVE\n\nDo NOT merge.",
    "tab-indented-first-line": f"{TAB}## Independent re-review - APPROVE\n\nDo NOT merge.",
    "emphasis-mention-first-line": (
        "For context, the earlier Independent review - APPROVE was measured at a "
        "different head.\n\nDo NOT merge on it."
    ),
}


def test_negative_control_the_strip_set_excludes_every_citation_prefix():
    """`_announces`' strip set is load-bearing in what it does NOT contain:
    `>`, `<`, a backtick and a tilde are absent, so no line beginning with one
    can announce a verdict. Only the `>` half was pinned -- adding a backtick to
    the set, which would let a fenced first line announce, passed the whole
    suite. The table is the contract."""
    for prefix in ("", "#", "##", "###", "*", "**", "_", "__"):
        assert gates._announces(f"{prefix}Independent review - APPROVE"), prefix
    for prefix in (">", ">>", "<", "<!--", "```", "~~~", "-", "1.", "﻿", "\xa0"):
        assert not gates._announces(f"{prefix}Independent review - APPROVE"), prefix
    # Leading whitespace IS stripped by `_announces` -- it is the POSITION rule
    # that refuses an indented first line, which is the belt to that braces.
    # Asserting it here as well pins which layer owns which half.
    for prefix in (" ", "\t", "    "):
        line = f"{prefix}Independent review - APPROVE"
        assert gates._announces(line), prefix
        assert gates._marker_lines(line) == [], prefix


def test_negative_control_no_formatting_idiom_smuggles_an_approval():
    """POSITION, NOT IDIOM. Three rounds running the rule was "a marker line
    that is not <the idioms I have thought of>", and each round a reviewer found
    the next one: `>`, then fences / 4-space indent / `<details>` / HTML
    comment, then a TAB indent and a nested fence delimiter that flipped the
    state machine back to prose. Re-implementing a Markdown block parser over a
    200-character prefix is the wrong shape for a control this load-bearing.

    The announcing line must be the comment's FIRST non-empty line, at indent
    zero, not opening with `>`, `<`, a backtick or a tilde. Every bypass found
    so far fails that with no state machine at all."""
    for name, body in SMUGGLE_SHAPES.items():
        live, near = gates.parse_verdicts([_c(1, body, "2026-09-11T11:00:00Z")], HEAD)
        assert live == [], f"{name}: an approval was smuggled"
        ok, why = gates.reduce_verdicts(live, near)
        assert not ok, f"{name}: {why}"


def test_negative_control_formatting_never_reduces_a_block():
    """The two directions are NOT symmetric, and treating them the same caused a
    measured regression: once a citation became non-blocking, a reviewer who
    pasted a failing log in a fence, forgot to close it, then wrote their
    REQUEST-CHANGES header had their block demoted to advisory -- GO, beside any
    other approval. An unclosed fence is an ordinary typo.

    Formatting may refuse to GRANT an approval. It must never REDUCE a block."""
    approval = _c(2, "## Independent re-review - APPROVE\n\nclean.", "2026-09-11T12:00:00Z")
    blocked = {
        "unclosed-fence": "Failing log:\n```\nboom\n\n## Independent re-review - REQUEST-CHANGES",
        "quoted-relay": "A returned:\n> ## Independent re-review - REQUEST-CHANGES\n> blocker 1",
        "cited-plus-prose": (
            "> ## Independent review - APPROVE\n\nBut actually REQUEST-CHANGES: it is broken."
        ),
        "unclosed-details": (
            "<details><summary>log</summary>\n\n## Independent re-review - REQUEST-CHANGES"
        ),
        "tab-indented-block": f"Example:\n\n{TAB}## Independent re-review - REQUEST-CHANGES",
        "preamble-then-block": "Relaying.\n\n## Independent re-review - REQUEST-CHANGES\n\nno.",
    }
    for name, body in blocked.items():
        live, near = gates.parse_verdicts(
            [_c(1, body, "2026-09-11T11:00:00Z"), approval], HEAD
        )
        ok, why = gates.reduce_verdicts(live, near)
        assert not ok, f"{name}: a block was reduced by formatting -- {why}"


def test_negative_control_the_window_bounds_what_counts_as_a_token():
    """A blocking token far below the window must not block, or any long comment
    that happens to quote an old round freezes the PR with no way to discharge
    it. The window is the contract on BOTH sides -- it bounds what can approve
    AND what can block."""
    body = "Relaying the round.\n\n" + ("filler. " * 60) + "\nREQUEST-CHANGES on the old head"
    assert body.index("REQUEST-CHANGES") > 200
    live, near = gates.parse_verdicts([_c(1, body, "2026-09-11T11:00:00Z")], HEAD)
    assert live == []
    assert not any(n.blocks for n in near), "a token past the window must not block"


def test_a_blocking_token_below_the_window_is_recorded_not_dropped():
    """It does not BLOCK -- the window bounds both directions, or any long
    comment quoting an old round freezes the PR. But it produced `live=[]
    near=[]`, no trace at all, in the one direction the code says must never be
    reduced. Visible is the minimum."""
    body = "Relaying the round.\n\n" + ("filler. " * 60) + "\nREQUEST-CHANGES on the old head"
    assert body.index("REQUEST-CHANGES") > 200
    live, near = gates.parse_verdicts([_c(1, body, "2026-09-11T11:00:00Z")], HEAD)
    assert live == []
    assert len(near) == 1
    assert not near[0].blocks
    assert "BELOW" in near[0].reason


def test_negative_control_a_token_straddling_the_window_cut_is_not_lost():
    """A prefix cut at 200 SPLITS a token that straddles it: `body[:200]` ends
    `...REQUEST-CH` and `body[200:]` begins `ANGES...`, so a token starting at
    offsets 186-199 was a complete substring of neither and left no trace at
    all -- the very silence this branch exists to end, surviving in a 15-char
    band of offsets."""
    for pad in range(184, 201):
        body = "Relaying.\n" + ("x" * pad) + "REQUEST-CHANGES on the old head"
        _, near = gates.parse_verdicts([_c(1, body, "2026-09-11T11:00:00Z")], HEAD)
        assert near, f"pad={pad}: a blocking token vanished"
        assert not near[0].blocks, f"pad={pad}: the window still bounds blocking"


def test_negative_control_a_prose_header_that_is_not_first_is_reported_as_such():
    """`not-the-first-line`, not `below-the-window`. The message must name the
    cause it established: a header three lines down, inside the window, is
    misplaced rather than truncated, and saying otherwise is an R7 error in a
    diagnostic."""
    body = (
        "Relay:\n\n<details><summary>old</summary>x</details>\n\n"
        "## Independent re-review - APPROVE\n"
    )
    live, near = gates.parse_verdicts([_c(1, body, "2026-09-11T11:00:00Z")], HEAD)
    assert live == []
    assert len(near) == 1
    assert near[0].kind == gates.NEAR_NOT_FIRST
    assert not near[0].blocks


def test_an_unannounced_approve_does_not_block():
    """The other side of that rule: refusing to read an ambiguous APPROVE is
    safe, but making it BLOCK would let any comment mentioning the word freeze
    the PR with no way to discharge it."""
    body = "Relaying reviewer B, who wrote APPROVE on the previous head."
    live, near = gates.parse_verdicts([_c(1, body, "2026-09-11T11:00:00Z")], HEAD)
    assert live == []
    assert len(near) == 1
    assert not near[0].blocks


CITATION_SHAPES = {
    "fenced": "Reviewer B returned:\n```\n## Independent re-review - APPROVE\n```\nDo NOT merge.",
    "tilde-fenced": "Relay:\n~~~\n## Independent re-review - APPROVE\n~~~\nDo NOT merge.",
    "indented": "Example header:\n\n    ## Independent re-review - APPROVE\n\nDo NOT merge.",
    "details": (
        "<details><summary>previous round (resolved)</summary>\n\n"
        "## Independent re-review - APPROVE\n\n</details>\n"
    ),
    "quoted": "> ## Independent re-review - APPROVE\n\nI am the author, not a reviewer.",
    "nested-quote": ">> ## Independent re-review - APPROVE\n\nrelayed twice.",
    "indented-quote": "  > ## Independent re-review - APPROVE\n\nstill a quote.",
    "html-comment": "<!--\n## Independent re-review - APPROVE\n-->\nnot visible when rendered.",
    "tab-indented": f"Relay:\n\n{TAB}## Independent re-review - APPROVE\n\nnot a decision.",
    "one-line-details": (
        "Relay:\n\n<details><summary>old</summary>x</details>\n\n"
        "<details>\n## Independent re-review - APPROVE\n</details>\n"
    ),
    "nested-fence": (
        "Relay:\n```\n```python\n## Independent re-review - APPROVE\n```\n```\nnot a decision."
    ),
}


def test_negative_control_a_cited_verdict_never_decides_the_merge():
    """Every way Markdown marks text as NOT PROSE. Three successive reviews each
    found the previous enumeration one idiom deep, and each of these produced a
    live APPROVE with zero blocking near-misses -- exactly what the gate needs to
    record GO. Relaying agent output in a fence is how this program moves
    verdicts around, and `<details>` is the standard way to collapse a
    superseded review."""
    for name, body in CITATION_SHAPES.items():
        live, near = gates.parse_verdicts([_c(1, body, "2026-09-11T11:00:00Z")], HEAD)
        assert live == [], f"{name}: a citation decided the merge"
        ok, why = gates.reduce_verdicts(live, near)
        assert not ok, f"{name}: {why}"


def test_a_cited_verdict_is_recorded_even_though_it_does_not_decide():
    """Silence is the enemy. A quoted verdict used to produce `live=[] near=[]`
    -- nothing at all -- so a relayed BLOCK was invisible in the evidence line
    while a genuine approval beside it decided the merge. Conjunction defeated
    by formatting rather than by content."""
    for name, body in CITATION_SHAPES.items():
        _, near = gates.parse_verdicts([_c(1, body, "2026-09-11T11:00:00Z")], HEAD)
        assert near, f"{name}: a cited verdict vanished without a trace"
        assert near[0].kind == gates.NEAR_CITED, f"{name}: {near[0].kind}"
        assert not near[0].blocks, f"{name}: a citation must not block either"


def test_a_real_verdict_beside_a_citation_still_registers():
    """The other side: quoting the round you are answering is ordinary, and must
    not cost the reviewer their own verdict."""
    body = (
        "## Independent re-review - APPROVE\n\n"
        "Answering:\n> ## Independent review - REQUEST-CHANGES\n> the old blocker\n\n"
        "all addressed."
    )
    live, _ = gates.parse_verdicts([_c(1, body, "2026-09-11T11:00:00Z")], HEAD)
    assert [v.token for v in live] == ["APPROVE"]


def test_a_verdict_below_the_window_is_recorded_not_dropped():
    """It does not register -- the window is the contract -- but it is reported,
    because a silently-dropped verdict is the incident that cost three rounds."""
    body = "Recap.\n\n" + ("filler line\n" * 40) + "## Independent review - APPROVE\n"
    live, near = gates.parse_verdicts([_c(1, body, "2026-09-11T11:00:00Z")], HEAD)
    assert live == []
    assert len(near) == 1
    assert near[0].kind == gates.NEAR_NOT_FIRST
    assert not near[0].blocks


def test_negative_control_a_sentence_about_a_verdict_is_not_a_verdict():
    """The inverse, and worse: a BLOCKING review whose marker was misspelled,
    with one sentence of prose mentioning the marker phrase beside the word
    APPROVE, registered as a live APPROVE. A block inverted into an approval."""
    body = (
        "## Re-review - REQUEST-CHANGES\n\n"
        "Blocker: the thing is broken.\n\n"
        "For context, the earlier Independent review - APPROVE was measured at a "
        "different head.\n"
    )
    live, near = gates.parse_verdicts([_c(1, body, "2026-09-11T11:00:00Z")], HEAD)
    assert live == []
    ok, _ = gates.reduce_verdicts(live, near)
    assert not ok, "a misspelled marker over a block must never read as approval"


def test_a_misspelled_marker_is_reported_loudly_not_dropped():
    """The other side of that boundary. Silence is the enemy: a sound verdict
    headed "Re-review" was discarded and the gate said only "no live APPROVE",
    which cost three runs to diagnose. It must surface as a near-miss naming the
    spelling."""
    body = "## Re-review - REQUEST-CHANGES\n\nBlocker: the thing is broken.\n"
    _, near = gates.parse_verdicts([_c(1, body, "2026-09-11T11:00:00Z")], HEAD)
    assert len(near) == 1
    assert near[0].kind == gates.NEAR_NO_MARKER
    assert near[0].blocks
    assert "formatting never reduces a block" in near[0].reason


def test_a_misspelled_marker_over_an_approve_does_not_block_but_is_reported():
    body = "## Re-review - APPROVE\n\nlooks fine.\n"
    live, near = gates.parse_verdicts([_c(1, body, "2026-09-11T11:00:00Z")], HEAD)
    assert live == []
    assert len(near) == 1
    assert near[0].kind == gates.NEAR_NO_MARKER
    assert not near[0].blocks


def test_negative_control_a_blocking_near_miss_is_pinned_to_head_like_any_verdict():
    """A near-miss that blocks was NOT pinned, so a comment from ANY date by
    ANYONE that happened to contain a blocking token made the PR permanently
    unmergeable -- no push could discharge it, because a comment does not move
    when the diff does. That made unparseable STALE text stronger than a
    parseable stale block, inverting the module's own pinning rule."""
    stale = _c(1, "use REQUEST-CHANGES only for demonstrable defects", "2020-01-01T00:00:00Z")
    approve = _c(2, "## Independent re-review - APPROVE\n\nall good.", "2026-09-11T11:00:00Z")
    live, near = gates.parse_verdicts([stale, approve], HEAD)
    assert [v.token for v in live] == ["APPROVE"]
    assert not any(n.blocks for n in near)
    ok, why = gates.reduce_verdicts(live, near)
    assert ok, why


def test_negative_control_a_blocking_near_miss_at_head_still_blocks():
    """The other side of that boundary: pinning must not turn the guard off."""
    fresh = _c(1, "REQUEST-CHANGES - this is broken", "2026-09-11T11:00:00Z")
    approve = _c(2, "## Independent re-review - APPROVE", "2026-09-11T12:00:00Z")
    live, near = gates.parse_verdicts([fresh, approve], HEAD)
    ok, why = gates.reduce_verdicts(live, near)
    assert not ok
    assert "unparseable review at head" in why


def test_an_approve_that_mentions_the_other_tokens_in_prose_still_approves():
    """A reviewer writing "nothing that warrants REQUEST-CHANGES and nothing I
    had to mark CANNOT-ASSESS" is approving. A flat scan of the first 200 chars
    reads tokens in list order and registered that as a block, so the gate
    inverted a genuine verdict. The MARKER LINE is consulted first."""
    body = ("## Independent re-review - APPROVE\n\n"
            "Nothing that warrants REQUEST-CHANGES and nothing I had to mark CANNOT-ASSESS.")
    live, near = gates.parse_verdicts([_c(1, body, "2026-09-11T11:00:00Z")], HEAD)
    assert [v.token for v in live] == ["APPROVE"]
    ok, why = gates.reduce_verdicts(live, near)
    assert ok, why


def test_a_template_line_beside_a_real_verdict_does_not_swallow_it():
    """The template is skipped, not read in order -- and skipping it must not
    discard the decision written next to it."""
    body = ("## Independent review - APPROVE\n\n"
            "VERDICT: APPROVE | REQUEST-CHANGES | CANNOT-ASSESS\n")
    live, _ = gates.parse_verdicts([_c(1, body, "2026-09-11T11:00:00Z")], HEAD)
    assert [v.token for v in live] == ["APPROVE"]


def test_negative_control_the_template_line_is_not_a_decision():
    """The review template lists every token on one line. Read in token order it
    registers as REQUEST-CHANGES, so a reviewer who leaves the header in blocks
    their own PR -- and a reviewer who leaves it in an APPROVE gets a verdict
    they did not write."""
    live, near = gates.parse_verdicts(
        [
            _c(
                7,
                "## Independent review\n\nVERDICT: APPROVE | REQUEST-CHANGES | CANNOT-ASSESS\n",
                "2026-09-11T11:00:00Z",
            )
        ],
        HEAD,
    )
    assert live == []
    assert near[0].kind == gates.NEAR_TEMPLATE


# ---------------------------------------------------------------------------
# Conjunction, not recency
# ---------------------------------------------------------------------------


def test_approve_alone_is_go():
    ok, why = gates.reduce_verdicts([gates.Verdict("APPROVE", "t2", 2)])
    assert ok, why


def test_negative_control_later_approve_does_not_discharge_earlier_block():
    """Reduce by CONJUNCTION. This is the whole rule."""
    ok, why = gates.reduce_verdicts(
        [gates.Verdict("REQUEST-CHANGES", "t1", 1), gates.Verdict("APPROVE", "t2", 2)]
    )
    assert not ok
    assert "REQUEST-CHANGES" in why


def test_negative_control_cannot_assess_blocks():
    """CANNOT-ASSESS is not a weak approval. It means the reviewer could not
    reach the thing, and merging on it is merging unreviewed. This branch had no
    test at all -- by this module's own standard it was not known to watch
    anything."""
    ok, why = gates.reduce_verdicts([gates.Verdict("CANNOT-ASSESS", "t1", 1)])
    assert not ok
    assert "CANNOT-ASSESS" in why


def test_negative_control_cannot_assess_blocks_even_after_an_approve():
    ok, why = gates.reduce_verdicts(
        [gates.Verdict("CANNOT-ASSESS", "t1", 1), gates.Verdict("APPROVE", "t2", 2)]
    )
    assert not ok
    assert "CANNOT-ASSESS" in why


def test_negative_control_no_verdict_is_not_go():
    ok, why = gates.reduce_verdicts([])
    assert not ok
    assert "no live APPROVE" in why


# ---------------------------------------------------------------------------
# MISSING: never-created vs parked -- same symptom, opposite remedy
# ---------------------------------------------------------------------------


def test_parked_run_is_distinguishable():
    assert gates.classify_missing(total_count=3, waiting=True) == "parked"


def test_negative_control_conflicting_window_push_has_no_runs():
    """total_count == 0 means no run will EVER exist for that sha. Approving it
    is a no-op and `--admin`-ing past it ships code CI never saw."""
    assert gates.classify_missing(total_count=0, waiting=False) == "never-created"


def test_present_is_neither():
    assert gates.classify_missing(total_count=12, waiting=False) == "present"


# ---------------------------------------------------------------------------
# Gate 4 -- required contexts present, none RED, none INCOMPLETE
# ---------------------------------------------------------------------------

REQUIRED = ["Python Lint", "vitest (node 20)", "guardrails"]


def _run(name, conclusion, status="COMPLETED"):
    return {"name": name, "conclusion": conclusion, "status": status}


def _run_at(name, conclusion, started, status="COMPLETED"):
    """A required-context run WITH a timestamp.

    Exists because `_newest_from_groups` falls back to worst-wins the moment
    ANY run in the list it is handed lacks `startedAt`. A fixture of unstamped
    required runs therefore masks a population-widening mutation: the widened
    list resolves to the worst conclusion anyway, so the mutant survives.
    GitHub stamps every run it returns, so the unstamped fixture was the
    artefact, not the realistic case.
    """
    return {"name": name, "conclusion": conclusion, "status": status,
            "startedAt": started}


def test_all_required_green_is_go():
    ok, reasons = gates.classify_checks(
        [_run(n, "SUCCESS") for n in REQUIRED] + [_run("Bicep Lint", "SKIPPED")], REQUIRED
    )
    assert ok, reasons


def test_negative_control_a_red_required_context_blocks():
    checks = [_run(n, "SUCCESS") for n in REQUIRED]
    checks[1] = _run("vitest (node 20)", "FAILURE")
    ok, reasons = gates.classify_checks(checks, REQUIRED)
    assert not ok
    assert any("RED" in r for r in reasons)


def test_negative_control_an_incomplete_required_context_blocks():
    """A check that has not concluded is INCOMPLETE, never a pass. Merging here
    ships code whose required gate was still running."""
    checks = [_run(n, "SUCCESS") for n in REQUIRED]
    checks[0] = {"name": "Python Lint", "conclusion": None, "status": "IN_PROGRESS"}
    ok, reasons = gates.classify_checks(checks, REQUIRED)
    assert not ok
    assert any("INCOMPLETE" in r for r in reasons)


def test_negative_control_a_missing_required_context_blocks():
    ok, reasons = gates.classify_checks([_run("Python Lint", "SUCCESS")], REQUIRED)
    assert not ok
    assert sum("MISSING" in r for r in reasons) == 2


def test_negative_control_a_cancelled_run_is_red_not_absent():
    """A CANCELLED job measured nothing, and reading it as merely absent is how
    a rapid-merge cancellation gets mistaken for a check that never ran."""
    checks = [_run(n, "SUCCESS") for n in REQUIRED]
    checks[2] = _run("guardrails", "CANCELLED")
    ok, reasons = gates.classify_checks(checks, REQUIRED)
    assert not ok
    assert any("CANCELLED" in r for r in reasons)


def test_negative_control_the_statuscontext_shape_is_read_too():
    """statusCheckRollup returns TWO shapes -- CheckRun (name/conclusion) and
    StatusContext (context/state). A reader that knows only one is blind to
    every context published by the other."""
    checks = [
        {"context": n, "state": "SUCCESS"} for n in REQUIRED
    ]
    ok, reasons = gates.classify_checks(checks, REQUIRED)
    assert ok, reasons
    checks[0] = {"context": "Python Lint", "state": "FAILURE"}
    ok, reasons = gates.classify_checks(checks, REQUIRED)
    assert not ok


def test_negative_control_a_statuscontext_pending_or_error_is_not_green():
    """The two GitHub vocabularies differ: a StatusContext says ERROR where a
    CheckRun says FAILURE, and PENDING where a CheckRun says IN_PROGRESS -- and
    a StatusContext has NO `status` key at all. Testing completeness against
    `status` alone meant a PENDING external context fell through every branch
    and was scored green. Latent until an external status joins the required
    list, and silent when it does."""
    for state in ("PENDING", "ERROR", "EXPECTED"):
        checks = [{"context": n, "state": "SUCCESS"} for n in REQUIRED]
        checks[0] = {"context": "Python Lint", "state": state}
        ok, reasons = gates.classify_checks(checks, REQUIRED)
        assert not ok, f"{state} must not be green: {reasons}"


def test_negative_control_a_skipped_run_does_not_hide_behind_a_green_twin():
    """ORDER-DEPENDENCE, measured: with one required context published twice,
    `['SUCCESS','SKIPPED']` scored GO and `['SKIPPED','SUCCESS']` scored NO-GO
    on the same commit, because `_check_rank` tied them and the first won. Not
    hypothetical -- 9 of 25 recent PRs publish a duplicated context name, and on
    the harness's own PR the duplicate is a REQUIRED one."""
    for order in (["SUCCESS", "SKIPPED"], ["SKIPPED", "SUCCESS"]):
        checks = [_run(n, "SUCCESS") for n in REQUIRED[1:]]
        checks += [_run(REQUIRED[0], c) for c in order]
        ok, reasons = gates.required_measured_nothing(checks, REQUIRED)
        assert not ok, f"order {order} must be NO-GO: {reasons}"


def test_negative_control_a_duplicated_context_is_judged_by_its_worst_run():
    """Two runs can publish the same required context. Taking the first (or the
    last) lets a red one hide behind a green twin."""
    checks = [_run(n, "SUCCESS") for n in REQUIRED] + [_run("guardrails", "FAILURE")]
    ok, reasons = gates.classify_checks(checks, REQUIRED)
    assert not ok
    assert any("guardrails" in r and "RED" in r for r in reasons)


# ---------------------------------------------------------------------------
# Gate 4c -- the ADVISORY population (#4543)
# ---------------------------------------------------------------------------
#
# The defect: gates 4, 4b and 5 all filter to `required` before any predicate
# runs, so ~25 of the ~40 contexts a PR publishes were invisible to the merge
# decision. Measured on PR #4540 head `7dd2fa3e279` -- forty check-runs, one
# red, advisory, and `VERDICT: GO`. The merge landed and `main` went red.
#
# Each test below names the input that turns it red, because "this covers the
# advisory case" is intent, and intent is what is wrong when the test and the
# defect share an author (`.claude/rules/assertion-design.md`).


def _adv(name, conclusion, status="COMPLETED", started=None):
    run = {"name": name, "conclusion": conclusion, "status": status}
    if started is not None:
        run["startedAt"] = started
    return run


def test_a_rollup_with_no_advisory_red_is_go():
    """The POSITIVE control. Without it every NO-GO below is satisfied by an
    arm that simply blocks everything.

    Breaks if: any of these three advisory conclusions starts counting as red
    -- SUCCESS, SKIPPED (path-filtered, routine) or NEUTRAL."""
    checks = [_run(n, "SUCCESS") for n in REQUIRED] + [
        _adv("Bicep Lint", "SKIPPED"),
        _adv("CodeQL", "SUCCESS"),
        _adv("PR Summary", "NEUTRAL"),
    ]
    ok, why = gates.advisory_verdict(checks, REQUIRED, True)
    assert ok, why
    assert "3 clean of 3 advisory" in why, why


def test_negative_control_an_advisory_red_blocks_while_every_required_is_green():
    """THE #4540 FIXTURE, in miniature: every required context green, exactly
    one non-required check red. Today's code answers GO; this must answer
    NO-GO.

    Breaks if: the population is filtered to `required` again (the defect), or
    the red is dropped by scanning only the first entries -- which is why the
    red is deliberately LAST in the list."""
    checks = [_run(n, "SUCCESS") for n in REQUIRED] + [
        _adv("CodeQL", "SUCCESS"),
        _adv("brain security graph — committed artifact matches the tree", "FAILURE"),
    ]
    assert gates.classify_checks(checks, REQUIRED)[0], "the required half must be GREEN"
    ok, why = gates.advisory_verdict(checks, REQUIRED, True)
    assert not ok
    assert "ADV-RED 1" in why
    assert "brain security graph" in why


def test_every_red_conclusion_blocks_the_advisory_path_not_only_failure():
    """EACH member of `RED_CONCLUSIONS` pinned SEPARATELY, on the advisory path.

    ROUND 1'S BLOCKER, and the sharpest part of it is WHICH member was
    unwitnessed. Before this test, `classify_advisory_checks`' red branch was
    pinned only by FAILURE (and ERROR via the StatusContext shape). Review
    measured two mutations SURVIVING the whole suite:

        `... and verdict != "CANCELLED"`        -> rc=0, 531 passed
        `if verdict in ("FAILURE", "ERROR")`    -> rc=0, 531 passed

    and showed the mutant is behaviourally live: a lone CANCELLED advisory run
    answers `ok=True, "1 clean of 1 advisory"`.

    THE REASON IT MATTERS IS NOT COVERAGE ARITHMETIC. The reviewer re-ran
    `advisory_verdict` against the live rollups of the last 40 PRs: exactly ONE
    NO-GO, #4492, **and both of its reds are CANCELLED**. So the only production
    behaviour this arm exhibits today is the one nothing witnessed, while the PR
    body stated the CANCELLED-stays-red decision as an explicit commitment with
    zero kill power behind it.

    A CANCELLED required check is already recorded here as an ABSENCE rather
    than a pass; the advisory side has to agree, or the same run reads red on
    one path and clean on the other.

    WHAT MAKES THIS FAIL, stated exactly: **narrowing the branch** to a literal
    subset. Each conclusion is checked on its own so a single surviving member
    cannot hide behind the others.

    WHAT THIS DOES **NOT** CATCH, and must not claim to: removing a conclusion
    from `RED_CONCLUSIONS` itself. The loop derives its expectations from the
    frozenset under test, so a removal takes the assertion with it — vacuous by
    construction. An earlier revision of this docstring claimed both, which is
    the "a test that asserts on a MESSAGE while the mutation changes a COUNT"
    error in `assertion-design.md`, applied to its own scope.

    THE CORRECTION TO THAT CLAIM WAS ALSO WRONG, and that is the finding worth
    keeping. It said the removal case "IS covered" by
    `test_negative_control_a_cancelled_run_is_red_not_absent` and that "the
    composition holds". Measured by removing each member in turn and running the
    full suite — independently, by two reviewers and by me, with the same table:

        FAILURE          KILLED    15 failed
        CANCELLED        KILLED     1 failed
        ERROR            KILLED     2 failed
        TIMED_OUT        SURVIVED  rc=0
        ACTION_REQUIRED  SURVIVED  rc=0
        STARTUP_FAILURE  SURVIVED  rc=0
        STALE            SURVIVED  rc=0

    **4 of 7 were unwitnessed.** The cited test pins CANCELLED only, and only on
    `classify_checks`. So the retraction asserted its own mirror — the same
    could-not-fail defect, inside the paragraph correcting it, for the third
    time on this PR.

    `test_every_member_of_red_conclusions_is_witnessed_by_a_literal` below is
    the actual fix: it iterates a LITERAL list, so removing a member from the
    frozenset can no longer remove the assertion that would have caught it.
    """
    for conclusion in sorted(gates.RED_CONCLUSIONS):
        checks = [_run(n, "SUCCESS") for n in REQUIRED] + [
            _adv("CodeQL", "SUCCESS"),
            _adv(f"advisory-{conclusion.lower()}", conclusion),
        ]
        assert gates.classify_checks(checks, REQUIRED)[0], (
            f"{conclusion}: the required half must be GREEN, or this arm is "
            "measuring the wrong thing"
        )
        ok, why = gates.advisory_verdict(checks, REQUIRED, True)
        assert not ok, (
            f"{conclusion} did NOT block the advisory path. Every member of "
            f"RED_CONCLUSIONS must, or a run reads red for a required context "
            f"and clean for an advisory one. why={why!r}"
        )
        assert f"advisory-{conclusion.lower()}" in why, (
            f"{conclusion} blocked but the message does not NAME the check "
            f"(deploy-integrity R6: say which). why={why!r}"
        )

    # PAIRED POSITIVE, and not optional: "every conclusion blocks" is trivially
    # satisfiable by a branch that blocks on everything. Pin that the buckets
    # which must NOT block still do not.
    for benign in ("SUCCESS", "SKIPPED", "NEUTRAL"):
        checks = [_run(n, "SUCCESS") for n in REQUIRED] + [
            _adv(f"advisory-{benign.lower()}", benign),
        ]
        ok, why = gates.advisory_verdict(checks, REQUIRED, True)
        assert ok, (
            f"{benign} must NOT block the advisory path — advisory checks skip "
            f"routinely on path filters and a control that fires on everything "
            f"teaches its reader to skim it. why={why!r}"
        )


# The seven members of RED_CONCLUSIONS, WRITTEN OUT rather than read from the
# frozenset. The literal is the entire point: every other arm in this file
# derives its expectations from `gates.RED_CONCLUSIONS`, so deleting a member
# deletes the assertion that would have caught the deletion. Measured: 4 of the
# 7 could be removed with the whole suite still at rc=0 before this existed.
#
# If you add a member to the frozenset, this list must be updated by hand and
# that is deliberate — a new red conclusion should cost one conscious edit.
RED_CONCLUSIONS_LITERAL = (
    "FAILURE",
    "TIMED_OUT",
    "CANCELLED",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
    "STALE",
    "ERROR",
)


def test_every_member_of_red_conclusions_is_witnessed_by_a_literal():
    """The removal case, which every frozenset-derived arm is vacuous against.

    WHAT MAKES THIS FAIL, three distinct mutations:

    1. REMOVING any member from `gates.RED_CONCLUSIONS` — the set comparison
       fails naming it, and the per-member loop below fails on both paths.
       Before this arm, removing TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE or
       STALE survived the entire suite at rc=0.
    2. ADDING a member without updating this literal — also the set comparison.
       That is intended, not friction: a new red conclusion is worth one edit.
    3. NARROWING either of the TWO read sites this arm covers — the required
       path and the advisory path — which are separate branches that have
       drifted apart here before.

    THERE ARE SIX READS OF `RED_CONCLUSIONS`, NOT TWO, and this arm covers two
    of them. Saying "either read site" without that sentence reads as "all",
    which is how four of the six stayed unwitnessed across four rounds. The
    other four are covered by:
      - `test_the_rerun_bucket_reads_every_red_conclusion_not_only_failure`
        (the ADV-RERUN read)
      - `test_a_run_that_measured_nothing_cannot_discharge_an_earlier_red`
        (the supersession read)
      - `test_every_member_of_red_conclusions_outranks_a_green_twin`
        (`_check_rank`, which decides the REQUIRED gate)
      - `test_every_red_conclusion_at_the_merged_sha_fails_the_receipt`
        (`_one_context`, which decides whether an issue may CLOSE)
    If a seventh read is added, it needs its own arm; none of these generalises.

    The literal must NOT be derived from the frozenset, by any expression. That
    is what made the arm it replaces unable to fail.
    """
    assert set(RED_CONCLUSIONS_LITERAL) == set(gates.RED_CONCLUSIONS), (
        "RED_CONCLUSIONS changed without updating RED_CONCLUSIONS_LITERAL. "
        f"only in the frozenset: {sorted(set(gates.RED_CONCLUSIONS) - set(RED_CONCLUSIONS_LITERAL))}; "
        f"only in the literal: {sorted(set(RED_CONCLUSIONS_LITERAL) - set(gates.RED_CONCLUSIONS))}. "
        "A member removed here stops being red for BOTH the required and the "
        "advisory path, and every other arm in this file is blind to that."
    )

    for conclusion in RED_CONCLUSIONS_LITERAL:
        # THE REQUIRED PATH. One required context carries the conclusion; the
        # rest are green, so only this value can decide the verdict.
        checks = [_run(n, "SUCCESS") for n in REQUIRED[1:]] + [_run(REQUIRED[0], conclusion)]
        ok, reasons = gates.classify_checks(checks, REQUIRED)
        assert not ok, (
            f"{conclusion} on the REQUIRED context {REQUIRED[0]!r} did not "
            f"block. A required context in this state would merge. reasons={reasons!r}"
        )

        # THE ADVISORY PATH, a separate branch that has drifted from the above.
        checks = [_run(n, "SUCCESS") for n in REQUIRED] + [
            _adv(f"advisory-{conclusion.lower()}", conclusion),
        ]
        ok, why = gates.advisory_verdict(checks, REQUIRED, True)
        assert not ok, (
            f"{conclusion} did not block the ADVISORY path, though the required "
            f"path treats it as red — the two read the same frozenset and must "
            f"not disagree. why={why!r}"
        )

    # PAIRED POSITIVE: the three benign conclusions must still NOT block, or
    # this arm is satisfied by a gate that refuses everything.
    for benign in ("SUCCESS", "SKIPPED", "NEUTRAL"):
        assert benign not in RED_CONCLUSIONS_LITERAL, (
            f"{benign} must not be red: advisory checks skip routinely on path "
            f"filters, and a gate that blocks on SKIPPED blocks every PR."
        )
        checks = [_run(n, "SUCCESS") for n in REQUIRED] + [
            _adv(f"advisory-{benign.lower()}", benign),
        ]
        ok, why = gates.advisory_verdict(checks, REQUIRED, True)
        assert ok, f"{benign} must not block the advisory path. why={why!r}"


MEASURED_NOTHING_LITERAL = ("SKIPPED", "NEUTRAL")


def test_every_red_conclusion_at_the_merged_sha_fails_the_receipt():
    """The SIXTH read of `RED_CONCLUSIONS`, at `_one_context`, on the RECEIPT
    path — the one that decides whether an issue may be CLOSED.

    Found by the same reviewer, in the same pass as the fifth. Narrowed, a
    merged-sha check concluding CANCELLED / TIMED_OUT / STALE / STARTUP_FAILURE
    / ACTION_REQUIRED falls past every branch below it and is scored a GREEN
    receipt — so an issue closes on a red the receipt called clean. That is the
    `deploy-integrity.md` R2 failure in its purest form: not "merged is done",
    but "red is done".

    WHAT MAKES THIS FAIL: narrowing `verdict in RED_CONCLUSIONS` at
    `_one_context` to any literal subset, or removing a member from the
    frozenset.

    STARTUP_FAILURE is the member worth naming here: a workflow that fails to
    start publishes ZERO jobs and reports the FILE PATH as its name, so it is
    the conclusion most likely to be mistaken for an absence rather than a red.
    """
    # THE POLICY IS DECLARED FOR THE NEGATIVE ARMS TOO, and this is the whole
    # arm. The first version passed `policy={}`, so every arm failed the
    # receipt on "no substantive step is DECLARED" — fail-closed, correct, and
    # NOTHING TO DO WITH THE RED. Measured: narrowing the read to
    # ("FAILURE","ERROR") SURVIVED, because the assertions were satisfied by a
    # receipt that could not pass for an unrelated reason. With the step
    # declared and green, the ONLY thing left that can fail the receipt is the
    # conclusion under test.
    declared = {
        "receipts": {
            "ci_green_rule": {
                "substantive_steps": {"Python Tests (3.10)": ["Run pytest"]},
            }
        }
    }
    green_job = {"name": "Python Tests (3.10)", "conclusion": "success",
                 "steps": [{"name": "Run pytest", "conclusion": "success"}]}

    for conclusion in RED_CONCLUSIONS_LITERAL:
        evidence = [
            gates.ContextEvidence(
                name="Python Tests (3.10)",
                merged_check={
                    "name": "Python Tests (3.10)",
                    "conclusion": conclusion,
                    "status": "COMPLETED",
                },
                merged_job=green_job,
            )
        ]
        receipt = gates.ci_green_receipt(
            evidence,
            merged_changed_files=("tools/drain/gates.py",),
            merged_branch="main",
            merged_sha="deadbeef",
            trees_identical=True,
            policy=declared,
            merged_total_count=1,
        )
        assert not receipt.ok, (
            f"{conclusion} at the MERGED sha was scored a green receipt. A "
            f"receipt is what lets an issue be closed, so this closes an issue "
            f"over a red. reasons={receipt.reasons!r}"
        )
        # NAME THE BRANCH, not merely the conclusion. The conclusion string
        # appears in the GREEN-at-merged-sha message too, so asserting only
        # that it is mentioned cannot tell a red detection from a pass.
        assert any("RED at the merged sha" in r for r in receipt.reasons), (
            f"{conclusion} failed the receipt, but NOT as a red — some other "
            f"branch refused it, so this arm would pass with the red check "
            f"removed entirely. reasons={receipt.reasons!r}"
        )

    # PAIRED POSITIVE: a genuinely green merged check still yields a receipt,
    # or this arm is satisfied by a receipt that never passes.
    #
    # The policy is REAL, not `{}`. An empty policy makes the receipt fail
    # closed on "no substantive step is DECLARED" — correct behaviour, and it
    # would have made this positive control unable to pass for a reason that
    # has nothing to do with the red conclusions above.
    green_policy = {
        "receipts": {
            "ci_green_rule": {
                "substantive_steps": {"Python Tests (3.10)": ["Run pytest"]},
            }
        }
    }
    evidence = [
        gates.ContextEvidence(
            name="Python Tests (3.10)",
            merged_check={
                "name": "Python Tests (3.10)",
                "conclusion": "SUCCESS",
                "status": "COMPLETED",
            },
            merged_job={"name": "Python Tests (3.10)", "conclusion": "success",
                        "steps": [{"name": "Run pytest", "conclusion": "success"}]},
        )
    ]
    receipt = gates.ci_green_receipt(
        evidence,
        merged_changed_files=("tools/drain/gates.py",),
        merged_branch="main",
        merged_sha="deadbeef",
        trees_identical=True,
        policy=green_policy,
        merged_total_count=1,
    )
    assert receipt.ok, (
        f"a SUCCESS at the merged sha with its substantive step declared and "
        f"green must still produce a receipt, or the negative arms above are "
        f"satisfied by a receipt that cannot pass. reasons={receipt.reasons!r}"
    )


def test_every_member_of_red_conclusions_outranks_a_green_twin():
    """The FIFTH read of `RED_CONCLUSIONS`, at `_check_rank`, and the worst of
    the six — because it decides the REQUIRED gate, not the advisory one.

    Found by an independent reviewer on round 5, after they answered "is there
    a fifth read?" with "yes, and a sixth".

    `_check_rank` de-duplicates a context published more than once by RANK. If
    the red test there is narrowed, a red twin ties with SUCCESS at rank 1 and
    first-wins hides it. Measured on `classify_checks` with a duplicated
    required context `[SUCCESS, X]`: ACTION_REQUIRED, CANCELLED, STALE,
    STARTUP_FAILURE and TIMED_OUT ALL flip NO-GO -> GO. Only FAILURE and ERROR
    survived the narrowing, which is exactly the shape that has now recurred at
    five separate sites in this file.

    THIS IS NOT HYPOTHETICAL. `_check_rank`'s own docstring records that **9 of
    25 recent PRs publish a duplicated context name**, and that on the PR it
    was written for the duplicate was a REQUIRED one.

    WHAT MAKES THIS FAIL: narrowing `verdict in RED_CONCLUSIONS` at
    `_check_rank` to any literal subset, or removing a member from the
    frozenset (the literal is asserted equal to it above).

    ORDER IS VARIED DELIBERATELY. A green twin FIRST is the ordering that hides
    the red under first-wins; a red twin first passes even a broken rank. A
    fixture with one ordering cannot witness this — that is the recorded
    round-2 finding on `_newest_from_groups`, reproduced here on purpose.
    """
    other = [n for n in REQUIRED if n != REQUIRED[0]]
    for conclusion in RED_CONCLUSIONS_LITERAL:
        for order in ((("SUCCESS", conclusion)), ((conclusion, "SUCCESS"))):
            checks = [_run(n, "SUCCESS") for n in other] + [
                _run(REQUIRED[0], order[0]),
                _run(REQUIRED[0], order[1]),
            ]
            ok, reasons = gates.classify_checks(checks, REQUIRED)
            assert not ok, (
                f"{conclusion} published as a TWIN of SUCCESS on required "
                f"context {REQUIRED[0]!r} (order {order}) was scored GREEN. A "
                f"green twin must never hide a run that failed — and a "
                f"duplicated required context is the common case, not the odd "
                f"one. reasons={reasons!r}"
            )

    # PAIRED POSITIVE: twin SUCCESS runs must still pass, or this arm is
    # satisfied by a gate that refuses every duplicated context.
    checks = [_run(n, "SUCCESS") for n in other] + [
        _run(REQUIRED[0], "SUCCESS"),
        _run(REQUIRED[0], "SUCCESS"),
    ]
    ok, reasons = gates.classify_checks(checks, REQUIRED)
    assert ok, f"two green twins must pass: {reasons!r}"


def test_a_run_that_measured_nothing_cannot_discharge_an_earlier_red():
    """The THIRD and FOURTH forms of the self-clearing block.

    `rerun` closes the case where the re-run is still IN FLIGHT. But once that
    re-run CONCLUDES `SKIPPED` or `NEUTRAL` it stops being incomplete, so
    newest-wins dropped it into `clean` and the red disappeared:

        FAILURE @10:00, SKIPPED @11:00  ->  (True, "no advisory context is red")

    The FOURTH form was CREATED BY THE FIX FOR THE THIRD. The ADV-RERUN branch
    still asked `_newest_concluded`, which counts a SKIPPED as an answer, so
    adding an in-flight run re-opened the hole one line above where it closed:

        FAILURE@10, SKIPPED@11                  -> NO-GO
        FAILURE@10, SKIPPED@11, IN_PROGRESS@12  -> GO     (the regression)

    Both branches now use `_newest_informative_concluded`.

    Reachable by ordinary re-run semantics — an `if:` re-evaluating false, or a
    `needs` upstream failing or being cancelled, both produce `skipped` — i.e.
    by the gate's OWN remedy `rerun-ci`, which is in `permitted_unattended`.

    THE PRIOR VERDICT IS PARAMETRISED OVER ALL SEVEN RED CONCLUSIONS, not just
    FAILURE. The first version hard-coded FAILURE, which left the supersession
    site as a FOURTH unwitnessed read of `RED_CONCLUSIONS` — narrowing it to
    `("FAILURE","ERROR")` survived at rc=0. CANCELLED matters most in practice:
    it is the red that actually fires here when a run is superseded.

    WHAT MAKES THIS FAIL, each measured as a real mutant:
      - narrowing `MEASURED_NOTHING` to `{"SKIPPED"}`, or EMPTYING it — caught
        by the set equality below, which is why the literal exists;
      - narrowing the supersession site's `in RED_CONCLUSIONS` to any subset;
      - reverting either branch to a plain newest-CONCLUDED read (which counts a
        skip as an answer) — that helper was deleted in round 6 once it was
        orphaned, so arm A9d writes the reverting expression INLINE;
      - dropping the `MEASURED_NOTHING` branch entirely.
    """
    assert set(MEASURED_NOTHING_LITERAL) == set(gates.MEASURED_NOTHING), (
        "MEASURED_NOTHING changed without updating MEASURED_NOTHING_LITERAL. "
        f"only in the frozenset: {sorted(set(gates.MEASURED_NOTHING) - set(MEASURED_NOTHING_LITERAL))}; "
        f"only in the literal: {sorted(set(MEASURED_NOTHING_LITERAL) - set(gates.MEASURED_NOTHING))}. "
        "Dropping a member — or emptying the set — lets a run of that conclusion "
        "DISCHARGE an earlier red, which is the self-clearing block this closes."
    )

    for nothing in MEASURED_NOTHING_LITERAL:
        for red in RED_CONCLUSIONS_LITERAL:
            # TWO-RUN: the concluded supersession case.
            checks = [_run(n, "SUCCESS") for n in REQUIRED] + [
                _adv("advisory-superseded", red, started="2026-09-18T10:00:00Z"),
                _adv("advisory-superseded", nothing, started="2026-09-18T11:00:00Z"),
            ]
            ok, why = gates.advisory_verdict(checks, REQUIRED, True)
            assert not ok, (
                f"a {nothing} run superseding a {red} at the same head cleared "
                f"the gate. {nothing} measured nothing, so it cannot answer a "
                f"run that failed. why={why!r}"
            )
            assert "advisory-superseded" in why, (
                f"{red}/{nothing} blocked without naming the check "
                f"(deploy-integrity R6). why={why!r}"
            )

            # IN-FLIGHT over the skip: the FOURTH form. Adding a running re-run
            # on top must not turn the block into an ADV-WAIT.
            checks = [_run(n, "SUCCESS") for n in REQUIRED] + [
                _adv("advisory-rerun-over-skip", red, started="2026-09-18T10:00:00Z"),
                _adv("advisory-rerun-over-skip", nothing, started="2026-09-18T11:00:00Z"),
                _adv("advisory-rerun-over-skip", None, status="IN_PROGRESS",
                     started="2026-09-18T12:00:00Z"),
            ]
            ok, why = gates.advisory_verdict(checks, REQUIRED, True)
            assert not ok, (
                f"{red} then {nothing} then a re-run IN FLIGHT cleared the gate. "
                f"Dispatching `rerun-ci` must not discharge the block the moment "
                f"it STARTS — that is the self-clearing block, re-opened. "
                f"why={why!r}"
            )

        # THREE-RUN, TWO of them non-informative. A two-run fixture cannot
        # witness this: with only one skip, excluding the newest leaves the red
        # regardless of whether skips count as informative, so the
        # `not in MEASURED_NOTHING` filter could be deleted and survive.
        checks = [_run(n, "SUCCESS") for n in REQUIRED] + [
            _adv("advisory-twice-skipped", "FAILURE", started="2026-09-18T10:00:00Z"),
            _adv("advisory-twice-skipped", nothing, started="2026-09-18T11:00:00Z"),
            _adv("advisory-twice-skipped", nothing, started="2026-09-18T12:00:00Z"),
        ]
        ok, why = gates.advisory_verdict(checks, REQUIRED, True)
        assert not ok, (
            f"two consecutive {nothing} runs over a FAILURE cleared the gate — "
            f"the filter that skips non-informative runs is not applied. why={why!r}"
        )

    # TWO ADVISORY NAMES, and this one is load-bearing for a reason a
    # single-name fixture cannot express. Every other fixture here publishes
    # exactly ONE advisory name, so `groups[name]` and `checks` are the SAME
    # population and passing the whole `checks` list instead of the group
    # SURVIVED the entire suite — an unrelated check's green discharging this
    # check's red. Same shape as the module docstring's warning that a
    # one-element fixture cannot witness a population-narrowing mutation, here
    # in the other direction: a one-name fixture cannot witness a
    # population-WIDENING one.
    #
    # EVERY RUN IS STAMPED, INCLUDING THE REQUIRED ONES, and that is the whole
    # arm. `_newest_from_groups` falls back to worst-wins the moment ANY run in
    # the list lacks `startedAt` — so with unstamped required runs the widened
    # population still resolves to the FAILURE by worst-wins, and the mutation
    # SURVIVED. Measured. GitHub stamps every run it returns; the unstamped
    # fixture was the artefact, and it hid the defect.
    stamped_required = [
        _run_at(n, "SUCCESS", f"2026-09-18T09:{i:02d}:00Z")
        for i, n in enumerate(REQUIRED)
    ]
    checks = [
        *stamped_required,
        _adv("adv-a", "FAILURE", started="2026-09-18T10:00:00Z"),
        _adv("adv-a", "SKIPPED", started="2026-09-18T11:00:00Z"),
        _adv("adv-b", "SUCCESS", started="2026-09-18T12:00:00Z"),
    ]
    ok, why = gates.advisory_verdict(checks, REQUIRED, True)
    assert not ok, (
        "a SUCCESS on a DIFFERENT advisory check discharged adv-a's red — the "
        "supersession lookup is reading the whole published population instead "
        f"of the runs of this name. why={why!r}"
    )
    assert "adv-a" in why, f"blocked without naming adv-a. why={why!r}"

    # PAIRED POSITIVE 1: a skip with NO prior red is the ROUTINE case.
    for nothing in MEASURED_NOTHING_LITERAL:
        checks = [_run(n, "SUCCESS") for n in REQUIRED] + [
            _adv("advisory-just-skipped", "SUCCESS", started="2026-09-18T10:00:00Z"),
            _adv("advisory-just-skipped", nothing, started="2026-09-18T11:00:00Z"),
        ]
        ok, why = gates.advisory_verdict(checks, REQUIRED, True)
        assert ok, (
            f"a {nothing} run over a previously GREEN check must NOT block — "
            f"that is the path-filter case and it is the common one. why={why!r}"
        )

    # PAIRED POSITIVE 2: a SUCCESS re-run DOES discharge a red, even with a
    # skip between them. Without this the fix is indistinguishable from "any
    # red is permanent", which would strand every PR whose check was fixed.
    checks = [_run(n, "SUCCESS") for n in REQUIRED] + [
        _adv("advisory-fixed", "FAILURE", started="2026-09-18T10:00:00Z"),
        _adv("advisory-fixed", "SKIPPED", started="2026-09-18T11:00:00Z"),
        _adv("advisory-fixed", "SUCCESS", started="2026-09-18T12:00:00Z"),
    ]
    ok, why = gates.advisory_verdict(checks, REQUIRED, True)
    assert ok, (
        f"a SUCCESS re-run measured something and passed, so it MUST discharge "
        f"the earlier red even with a skip between them. why={why!r}"
    )


def test_the_rerun_bucket_reads_every_red_conclusion_not_only_failure():
    """The SECOND read of `RED_CONCLUSIONS`, one line below the first.

    `classify_advisory_checks` reads the frozenset TWICE: once for the newest
    run's verdict, and once at `gates.py:1685` for `last_verdict` — the newest
    CONCLUDED run, which decides ADV-RERUN. Round 2 pinned the first and left
    the second unwitnessed. Narrowing `:1685` to `("FAILURE", "ERROR")` survived
    the full drain suite at rc=0 — measured here as `580 passed, 1 deselected`
    against round 2's test file, and rc=1 against this one.

    THE FIGURE IS MINE, NOT INHERITED. An earlier revision of this docstring
    cited "574 passed", which is not reproducible at any commit on this branch:
    the collected counts along it are 524 / 531 / 532 / 580 / 581 / 582. It was
    copied from the finding that prompted the round rather than re-measured —
    quoting a number is an assertion, and `deploy-integrity.md` R7 does not
    exempt one because someone else said it first.

    THE SAME DEFECT AS ROUND 1's, ONE LINE BELOW ROUND 1's FIX — fixing the cell
    rather than the class, in the commit that named closing findings at the SITE
    as its own lesson.

    NOT an equivalent mutant. On the #4492 shape — newest concluded run
    CANCELLED, a re-run in flight — clean code answers ADV-RERUN / NO-GO and the
    mutant answers GO. That reopens the SELF-CLEARING BLOCK this bucket exists to
    close, and it reopens it for the ONLY conclusion that fires in production:
    re-running `advisory_verdict` over the last 40 PR rollups gives one NO-GO,
    #4492, whose reds are both CANCELLED. Both `rerun-ci` and `merge-on-gate-go`
    are `permitted_unattended`, so this is a live path to an unattended merge
    over a red.

    WHAT MAKES THIS FAIL: narrowing the `last_verdict in RED_CONCLUSIONS` test at
    the ADV-RERUN site to any literal subset that omits a member.

    FIXTURE NOTE, because the first version of this arm did not reach the branch
    at all. `_newest_from_groups` falls back to `_worst(runs)` when ANY run in a
    group lacks `startedAt` — so two stampless entries resolve to the WORST
    conclusion, not the newest, and the red one won. The arm failed loudly
    rather than passing vacuously, which is the good direction, but it was
    measuring ADV-RED while claiming to measure ADV-RERUN. Explicit stamps put
    the in-flight re-run genuinely newest.
    """
    for conclusion in sorted(gates.RED_CONCLUSIONS):
        name = f"advisory-rerun-{conclusion.lower()}"
        # Newest run is IN PROGRESS (a re-run in flight); the newest CONCLUDED
        # run of the same name was red. That is the ADV-RERUN shape, and the
        # stamps are what make "newest" mean newest rather than worst.
        checks = [_run(n, "SUCCESS") for n in REQUIRED] + [
            _adv(name, conclusion, started="2026-09-18T10:00:00Z"),
            _adv(name, None, status="IN_PROGRESS", started="2026-09-18T11:00:00Z"),
        ]
        ok, why = gates.advisory_verdict(checks, REQUIRED, True)
        assert not ok, (
            f"{conclusion}: a re-run in flight over a newest-CONCLUDED "
            f"{conclusion} must hold, not clear. Dispatching the gate's own "
            f"remedy would otherwise clear the gate's own block the moment the "
            f"re-run STARTED. why={why!r}"
        )
        assert "ADV-RERUN" in why, (
            f"{conclusion} blocked, but not as ADV-RERUN — the remedy differs "
            f"from ADV-RED and R7 applies to a gate's own message. why={why!r}"
        )

    # PAIRED POSITIVE: a re-run over a newest-CONCLUDED *green* run must NOT
    # hold, or this arm blocks every PR with CI still running.
    checks = [_run(n, "SUCCESS") for n in REQUIRED] + [
        _adv("advisory-was-green", "SUCCESS", started="2026-09-18T10:00:00Z"),
        _adv("advisory-was-green", None, status="IN_PROGRESS",
             started="2026-09-18T11:00:00Z"),
    ]
    ok, why = gates.advisory_verdict(checks, REQUIRED, True)
    assert ok, f"a re-run over a previously GREEN check must wait, not block: {why!r}"


def test_negative_control_an_in_progress_advisory_check_is_not_red():
    """The recorded mistake from the first build of this split, for
    `merge-eligible.py`: classifying `in_progress` as red cries wolf on every
    PR with CI still running.

    Breaks if: the INCOMPLETE branch routes to `red` instead of `wait`. The
    wait names must ALSO appear in the GO line -- a report the reader has to
    go looking for is a footnote under a VERDICT: GO."""
    checks = [_run(n, "SUCCESS") for n in REQUIRED] + [
        _adv("Checkov", None, status="IN_PROGRESS"),
        _adv("CodeQL", "SUCCESS"),
    ]
    ok, why = gates.advisory_verdict(checks, REQUIRED, True)
    assert ok, why
    assert "ADV-WAIT 1" in why
    assert "Checkov" in why


def test_negative_control_every_not_yet_concluded_state_waits_rather_than_reds():
    """`in_progress` is the one that was misclassified, but it is not the only
    state that means "has not said anything yet" -- a check sits in QUEUED for
    the whole runner backlog, and WAITING is the environment-approval park.
    Fixing the one spelling and leaving the neighbours is the
    one-side-of-a-symmetry defect this package keeps producing.

    Breaks if: any of these four is scored red -- each would make the arm fire
    on ordinary in-flight CI."""
    for status in ("QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"):
        checks = [_run(n, "SUCCESS") for n in REQUIRED] + [
            _adv("Checkov", None, status=status)
        ]
        ok, why = gates.advisory_verdict(checks, REQUIRED, True)
        assert ok, f"{status} must not read as red: {why}"
        assert "ADV-WAIT 1" in why


def test_the_go_line_states_what_the_gate_cannot_see():
    """A main-only or scheduled lane publishes NO check-run at a PR head, so it
    is invisible here by construction (#4547's ACR Trivy reds: 0 present across
    three measured PR heads). That is a LIMIT of the population, and a gate
    that reports "no advisory context is red" without it invites the reader to
    conclude more than was measured -- `deploy-integrity.md` R7.

    Breaks if: the scope clause is dropped from the GO branch."""
    checks = [_run(n, "SUCCESS") for n in REQUIRED] + [_adv("CodeQL", "SUCCESS")]
    ok, why = gates.advisory_verdict(checks, REQUIRED, True)
    assert ok, why
    assert "ATTACHED TO THIS HEAD only" in why
    # The CONDITION, not just the conclusion. An earlier version of this
    # sentence said the ACR lane has no push trigger; it has one, scoped
    # `branches: [main]` (`:80-82`). A disclosure that names the wrong
    # condition cannot fire -- the reader who checks it finds a `push:` block
    # and learns nothing about the real invariant.
    assert "branches: [main]" in why


def test_negative_control_a_stale_red_does_not_outrank_a_fresh_green_rerun():
    """A re-run publishes a SECOND check-run under the same name, and list
    order is the API's, not time's.

    Breaks if: the de-duplication takes the last entry (here the OLD green) or
    the worst entry. The red is the NEWER of the two, so both wrong rules give
    the opposite answer to this one."""
    checks = [_run(n, "SUCCESS") for n in REQUIRED] + [
        _adv("Repo Hygiene", "FAILURE", started="2026-09-17T12:00:00Z"),
        _adv("Repo Hygiene", "SUCCESS", started="2026-09-17T10:00:00Z"),
    ]
    ok, why = gates.advisory_verdict(checks, REQUIRED, True)
    assert not ok, why
    assert "Repo Hygiene (FAILURE)" in why

    # ...and the OTHER direction, which is the one worst-wins gets wrong: the
    # green is newer, so the fixed check must stop blocking the drain.
    checks[-2], checks[-1] = checks[-1], checks[-2]
    checks[-1] = _adv("Repo Hygiene", "SUCCESS", started="2026-09-17T14:00:00Z")
    ok, why = gates.advisory_verdict(checks, REQUIRED, True)
    assert ok, why


def test_negative_control_an_undated_group_falls_back_to_worst_wins():
    """When a start time cannot be read, the group's order is UNKNOWN, and the
    pessimistic answer is the only honest one -- an unreadable timestamp must
    never let a red be discarded as superseded.

    BOTH ORDERINGS, and the second one is the whole point. An independent
    reviewer showed that `_worst(runs)` could be replaced by `return runs[0]`
    with all 521 tests still green, because every fixture claiming to pin
    worst-wins put the red FIRST -- where first-in-list and worst-by-rank are
    indistinguishable. Reproduced before fixing: red-first `runs[0]` answers
    NO-GO (identical); red-second `runs[0]` answers GO (killed).

    Breaks if: the fallback picks by list position, in either direction."""
    for order in (("FAILURE", "SUCCESS"), ("SUCCESS", "FAILURE")):
        checks = [_run(n, "SUCCESS") for n in REQUIRED] + [
            _adv("Secret Scan", order[0]),
            _adv("Secret Scan", order[1]),
        ]
        ok, why = gates.advisory_verdict(checks, REQUIRED, True)
        assert not ok, f"order {order} must be NO-GO: {why}"
        assert "Secret Scan (FAILURE)" in why


def test_negative_control_a_tie_at_the_newest_start_is_judged_by_its_worst_run():
    """Matrix legs fire together and can publish one name at one instant.
    "Newest" does not pick between them, so the worst of the tied set wins.

    BOTH ORDERINGS, for the same reason as the undated case above: with the red
    first, `return runs[0]` is indistinguishable from worst-wins.

    Breaks if: a tie resolves by list position, in either direction."""
    for order in (("FAILURE", "SUCCESS"), ("SUCCESS", "FAILURE")):
        checks = [_run(n, "SUCCESS") for n in REQUIRED] + [
            _adv("dbt Compile", order[0], started="2026-09-17T02:25:12Z"),
            _adv("dbt Compile", order[1], started="2026-09-17T02:25:12Z"),
        ]
        ok, why = gates.advisory_verdict(checks, REQUIRED, True)
        assert not ok, f"order {order} must be NO-GO: {why}"


def test_negative_control_a_rerun_in_flight_does_not_clear_its_own_red():
    """A SELF-CLEARING BLOCK, found by an independent reviewer. Newest-wins
    alone answers ADV-WAIT here -- which does not block -- so dispatching the
    gate's own remedy (`rerun-ci`) cleared the gate's own block the moment the
    re-run STARTED, before it answered anything. Both `rerun-ci` and
    `merge-on-gate-go` are in `permitted_unattended`, so that was a live path
    to an unattended merge over a red.

    Breaks if: the older completed RED stops being consulted and the name falls
    back into `wait`. The ORDER is also asserted both ways, because the older
    red is found by scanning the group, not by list position.

    Separate from ADV-RED deliberately, and the message is asserted: the check
    has not failed again, so "wait for it" is true and "fix it" would not be
    (`deploy-integrity.md` R7)."""
    red = _adv("Repo Hygiene", "FAILURE", started="2026-09-17T10:00:00Z")
    flight = _adv("Repo Hygiene", None, status="IN_PROGRESS",
                  started="2026-09-17T12:00:00Z")
    for order in ((red, flight), (flight, red)):
        checks = [_run(n, "SUCCESS") for n in REQUIRED] + list(order)
        ok, why = gates.advisory_verdict(checks, REQUIRED, True)
        assert not ok, f"a re-run in flight over a completed RED must block: {why}"
        assert "ADV-RERUN 1" in why
        assert "the newest run that MEASURED anything at this head was FAILURE" in why
        assert "ADV-WAIT" not in why, "it must not ALSO be reported as merely waiting"


def test_a_rerun_in_flight_over_a_green_run_is_still_only_waiting():
    """The other side of the pair, so ADV-RERUN cannot be satisfied by routing
    every in-flight check to it -- which would reinstate the cry-wolf defect
    ADV-WAIT exists to avoid.

    Breaks if: the `rerun` bucket stops requiring a RED newest-concluded run --
    this fixture would then block on an ordinary re-run of a green check."""
    checks = [_run(n, "SUCCESS") for n in REQUIRED] + [
        _adv("Repo Hygiene", "SUCCESS", started="2026-09-17T10:00:00Z"),
        _adv("Repo Hygiene", None, status="IN_PROGRESS", started="2026-09-17T12:00:00Z"),
    ]
    ok, why = gates.advisory_verdict(checks, REQUIRED, True)
    assert ok, why
    assert "ADV-WAIT 1" in why
    assert "ADV-RERUN" not in why


def test_negative_control_a_red_that_was_already_fixed_does_not_block_a_third_run():
    """THE ROUND-3 BLOCKER, and it arrived IN the fix for the round-2 one.

    The bucket asked "did ANY run of this name conclude RED", so a check that
    went red, WAS FIXED, and is being re-run again held the merge -- the mirror
    image of the hole the bucket was added to close. The newest CONCLUDED run
    here is the SUCCESS at 11:00, so there is nothing outstanding to wait for.

    Breaks if: the predicate goes back to any-red-in-the-group. The FAILURE is
    deliberately still present and deliberately FIRST in the list, which is
    exactly the input the old rule answered wrongly."""
    checks = [_run(n, "SUCCESS") for n in REQUIRED] + [
        _adv("Repo Hygiene", "FAILURE", started="2026-09-17T10:00:00Z"),
        _adv("Repo Hygiene", "SUCCESS", started="2026-09-17T11:00:00Z"),
        _adv("Repo Hygiene", None, status="IN_PROGRESS", started="2026-09-17T12:00:00Z"),
    ]
    ok, why = gates.advisory_verdict(checks, REQUIRED, True)
    assert ok, f"a red that was already fixed must not block a further re-run: {why}"
    assert "ADV-WAIT 1" in why
    assert "ADV-RERUN" not in why


def test_the_rerun_reason_names_the_newest_concluded_run_not_the_first_in_list():
    """R7 ON THE GATE'S OWN MESSAGE: it must name a conclusion it established.

    The first version reported `was_red[0]` -- whichever red sat first in the
    list -- as "the last CONCLUDED run at this head". Measured by an
    independent reviewer on these exact three runs: written in this order it
    named CANCELLED, and REVERSED it named FAILURE. Same head, same runs, two
    different claims, at most one of them true.

    Breaks if: the selection goes back to list position. CANCELLED is older but
    FIRST in the first ordering, so a first-in-list rule names it -- and the
    assertion that CANCELLED is ABSENT is paired with the positive one naming
    FAILURE, so deleting the sentence cannot satisfy this either."""
    older = _adv("Repo Hygiene", "CANCELLED", started="2026-09-17T09:00:00Z")
    newer = _adv("Repo Hygiene", "FAILURE", started="2026-09-17T10:00:00Z")
    flight = _adv("Repo Hygiene", None, status="IN_PROGRESS",
                  started="2026-09-17T12:00:00Z")
    for order in ((older, newer, flight), (flight, newer, older)):
        checks = [_run(n, "SUCCESS") for n in REQUIRED] + list(order)
        ok, why = gates.advisory_verdict(checks, REQUIRED, True)
        assert not ok, why
        assert "the newest run that MEASURED anything at this head was FAILURE" in why
        assert "CANCELLED" not in why, (
            "naming the older CANCELLED run is the order-dependent claim this "
            f"test exists for: {why}"
        )


def test_negative_control_an_undated_group_with_a_red_blocks_as_adv_red_not_rerun():
    """What ACTUALLY happens when a timestamp is unreadable, measured rather
    than assumed -- and it is STRICTER than ADV-RERUN, not weaker.

    Any unreadable stamp sends the WHOLE group to worst-wins, so the red
    becomes the group's representative and lands in `red` directly. The
    in-flight run never wins "newest" WHEN A RED IS PRESENT, which is why
    `_newest_informative_concluded`'s undated fallback -- though it IS reached, and can
    even choose between two undated concluded runs -- can never change the
    gate's answer. Stated precisely at that function; the direct unit test
    below is a real instrument, not an un-killable one.

    BOTH ORDERINGS, per the A10 lesson.

    Breaks if: the whole-group fallback stops firing when one run is undated --
    the SUCCESS-first ordering would then answer GO."""
    flight = _adv("Repo Hygiene", None, status="IN_PROGRESS",
                  started="2026-09-17T12:00:00Z")
    for order in (("FAILURE", "SUCCESS"), ("SUCCESS", "FAILURE")):
        checks = [_run(n, "SUCCESS") for n in REQUIRED] + [
            _adv("Repo Hygiene", order[0]),
            _adv("Repo Hygiene", order[1]),
            flight,
        ]
        ok, why = gates.advisory_verdict(checks, REQUIRED, True)
        assert not ok, f"order {order} must be NO-GO: {why}"
        assert "ADV-RED 1: Repo Hygiene (FAILURE)" in why


def test_newest_informative_concluded_falls_back_to_worst_wins_on_a_bad_timestamp():
    """`_newest_informative_concluded` DIRECTLY, on a branch the gate takes.

    RETARGETED in round 6. This tested `_newest_concluded`, which round 5
    orphaned when both callers moved to the informative variant, and which
    round 6 deleted. The properties still matter for the LIVE function, so the
    coverage is retargeted rather than dropped — deleting a test because its
    subject moved is how a witness disappears quietly.

    The function delegates its fallbacks to `_newest_from_groups`, and
    delegation is a claim until a fixture shows it. Tested at the function
    because the CLASSIFIER cannot distinguish the outcomes -- any red among
    the concluded runs is routed to ADV-RED by the outer worst-wins first, so
    every case that reaches this branch is non-red and lands in `wait`
    whichever run wins. That is a limit on what the caller can observe, NOT on
    whether this code runs: it runs, and this assertion kills arm A4's shape.

    BOTH ORDERINGS -- with the red first, first-in-list and worst-by-rank give
    the same answer, which is exactly how arm A10 survived a whole suite.

    Breaks if: the concluded subset picks by list position when no timestamp is
    readable -- the SUCCESS-first ordering would then return the SUCCESS."""
    for order in (("FAILURE", "SUCCESS"), ("SUCCESS", "FAILURE")):
        runs = [
            {"name": "H", "conclusion": order[0], "status": "COMPLETED"},
            {"name": "H", "conclusion": order[1], "status": "COMPLETED"},
            {"name": "H", "conclusion": None, "status": "IN_PROGRESS"},
        ]
        chosen = gates._newest_informative_concluded(runs)
        assert chosen is not None
        assert chosen["conclusion"] == "FAILURE", f"order {order} picked {chosen}"


def test_newest_informative_concluded_is_none_when_nothing_has_concluded():
    """The first-run-of-a-check case: every run is still in flight, so there is
    no previous answer to carry. It must be ADV-WAIT, never ADV-RERUN.

    Breaks if: an in-flight run is counted as concluded -- `_newest_informative_concluded`
    would return it, and `_outcome` of an IN_PROGRESS run is not in
    RED_CONCLUSIONS, so the bug would be silent here and show up as a wrong
    NAME somewhere else. The classifier assertion below is the one with teeth."""
    runs = [{"name": "H", "conclusion": None, "status": "IN_PROGRESS"},
            {"name": "H", "conclusion": None, "status": "QUEUED"}]
    assert gates._newest_informative_concluded(runs) is None

    checks = [_run(n, "SUCCESS") for n in REQUIRED] + runs
    ok, why = gates.advisory_verdict(checks, REQUIRED, True)
    assert ok, why
    assert "ADV-WAIT 1" in why
    assert "ADV-RERUN" not in why


def test_negative_control_the_statuscontext_shape_is_read_on_the_advisory_side_too():
    """`statusCheckRollup` returns TWO shapes. A StatusContext says ERROR where
    a CheckRun says FAILURE and PENDING where it says IN_PROGRESS, and it
    carries NO `status` key at all -- so a conclusion-only reader scores both
    as clean.

    Breaks if: the advisory split stops reading `(.context, .state)`. The
    positive half of the pair is asserted first, so deleting the feature
    outright cannot satisfy this."""
    base = [_run(n, "SUCCESS") for n in REQUIRED]
    ok, why = gates.advisory_verdict(
        [*base, {"context": "external/build", "state": "SUCCESS"}], REQUIRED, True
    )
    assert ok, why
    assert "1 clean of 1 advisory" in why

    ok, why = gates.advisory_verdict(
        [*base, {"context": "external/build", "state": "ERROR"}], REQUIRED, True
    )
    assert not ok
    assert "external/build (ERROR)" in why

    ok, why = gates.advisory_verdict(
        [*base, {"context": "external/build", "state": "PENDING"}], REQUIRED, True
    )
    assert ok, why
    assert "ADV-WAIT 1" in why


#: The name the ACR-lane tripwire watches. A constant so the FAILURE message
#: can name it: a renamed workflow must say which file it went looking for.
ACR_LANE = "build-fiab-images-acr-tasks.yml"


def _repo_root():
    """The FULL checkout this package lives in, or None when out of tree.

    DELIBERATELY the same marker pair as `test_ci_green_declared._repo_root`
    (`.github/workflows` AND `scripts/ci`), whose docstring explicitly forbids
    counting `parents[N]`: the mutation runner copies this package to a temp
    dir outside the repo, and from there a fixed three-level index resolves to
    `C:/Users/<user>/AppData/Local` -- a real directory, silently wrong.

    Returning None is the ONLY signal that means "out of tree". It is what
    separates the declared sandbox skip from a missing file in a real
    checkout, which is a FAILURE.
    """
    import pathlib

    for candidate in pathlib.Path(__file__).resolve().parents:
        if (candidate / ".github" / "workflows").is_dir() and (
                candidate / "scripts" / "ci").is_dir():
            return candidate
    return None


def test_the_acr_lane_invariant_the_scope_sentence_rests_on_still_holds():
    """THE DISCLOSURE IS THE TRIPWIRE, so it is read from the workflow rather
    than transcribed into prose.

    The first version of the scope sentence said the ACR image lane triggers on
    `workflow_dispatch` / `workflow_call` **only**. That was FALSE when it was
    written -- there is a `push:` block at `:80`, restricted to
    `branches: [main]`. The conclusion survived (a PR head is never on `main`,
    so the lane still publishes nothing here) but the stated reason did not,
    and a tripwire that names the wrong condition can never fire: the thing it
    tells you to watch for has already happened.

    So the real invariant is pinned mechanically, and lifted out of the source
    with the repo's own parser (`gates.parse_push_trigger`, which knows that
    `on:` is the YAML 1.1 boolean `True` -- a reader that only looks up the
    string key finds nothing in any real workflow).

    A MISSING WORKFLOW IS A FAILURE, NOT A SKIP. The first version of this test
    keyed on the FILE's existence, so RENAMING the lane made it skip -- green,
    blaming a mutation sandbox it was not in, and indistinguishable from the
    declared sandbox skip with nothing auditing skips outside the sandbox. That
    is the same class of defect this tripwire was built to close, arriving by a
    different route: a control that goes quiet when its subject disappears.
    The two states are now separated by `_repo_root()`, not by the file.

    Breaks if: a `pull_request` trigger is added to that lane, `branches:` is
    widened past `main`, the push trigger is deleted, or the workflow is
    renamed or removed. The first two would start attaching #4547's Trivy reds
    to PR heads, where this gate WOULD block on them.

    SKIPS only when `_repo_root()` is None -- i.e. genuinely out of tree, which
    in practice means the mutation sandbox. Declared in
    `mutate_gates.EXPECTED_SANDBOX_SKIPS`, because a test that skips there
    cannot kill an arm and must not be counted as if it could.
    """
    root = _repo_root()
    if root is None:
        pytest.skip("out of tree: no .github/workflows + scripts/ci above this file "
                    "(the mutation sandbox copies only tools/drain)")
    workflow = root / ".github" / "workflows" / ACR_LANE
    assert workflow.is_file(), (
        f"{ACR_LANE} is not in {root / '.github' / 'workflows'} - the lane was "
        "renamed or removed, so the invariant gate 4c's scope sentence rests on "
        "CANNOT BE CHECKED. That is a failure, not a pass: re-point this test at "
        "the new name and re-read its triggers before trusting the sentence in "
        "gates.advisory_verdict."
    )
    text = workflow.read_text(encoding="utf-8")

    import yaml

    # TWO PARSES of the same bytes: this one for the trigger KEYS, and
    # `parse_push_trigger` below for the push block's shape. Deliberate and
    # cosmetic -- the alternative is a production API change to hand a parsed
    # doc in, for a test that runs once. BOTH fail closed on unparseable YAML:
    # `safe_load` raises here, and `parse_push_trigger` returns None, which the
    # assertion below refuses.
    triggers = yaml.safe_load(text)
    triggers = triggers.get("on", triggers.get(True))
    # EXACT KEY, and that is a KNOWN GAP, filed as #4558 rather than papered
    # over: `pull_request_target` would pass this line. It is deliberately NOT
    # widened here, because whether such a run attaches a check-run to the PR
    # head in this repo has not been established -- and asserting on an
    # unestablished premise is the same error the sentence below was just
    # corrected for. Measured 2026-09-17: ZERO workflows in this repo use
    # `pull_request_target`, so nothing can silently satisfy this today.
    assert "pull_request" not in triggers, (
        "the ACR image lane now runs on pull_request, so its Trivy CRITICAL "
        "failures (#4547) WILL attach to PR heads and gate 4c will block on "
        "them. That is arguably correct under deploy-integrity.md R1, but the "
        "scope sentence in gates.advisory_verdict now says something false and "
        "must be revisited."
    )
    push = gates.parse_push_trigger(text)
    assert push is not None, "the ACR lane's `on:` block no longer parses"
    assert push.present, (
        "this lane's push trigger vanished - the scope sentence describes a "
        "`branches: [main]` filter that is no longer there"
    )
    assert push.branches == ("main",), (
        f"push.branches is {push.branches}, not ('main',) - the branch filter IS "
        "the invariant the scope sentence rests on"
    )


def _assert_tripwire_fails_loudly(run_tripwire):
    """Drive a tripwire and insist it raised an ASSERTION, not a skip.

    `pytest.raises(AssertionError)` CANNOT express this, and that is the whole
    reason this helper exists. `pytest.skip` raises `Skipped`, which subclasses
    **BaseException and not Exception** (measured: `BaseException=True
    Exception=False`). Inside a `pytest.raises(AssertionError)` block it is not
    caught -- it propagates, and pytest reports the ENCLOSING TEST AS SKIPPED.

    So the previous version of the negative control below, whose docstring said
    it would break if the tripwire reverted to `pytest.skip`, SURVIVED exactly
    that mutation: rc=0, `528 passed, 3 skipped`, the extra skip being the
    control itself. A control that is silent about the regression it names, in
    the sentence that names it.

    `BaseException` is caught deliberately and the TYPE is then asserted, so a
    skip becomes a loud failure instead of a quiet abort.
    """
    try:
        run_tripwire()
    except BaseException as exc:
        caught = exc
    else:
        caught = None
    assert caught is not None, (
        "the tripwire returned normally on a subject it could not read - it must "
        "raise"
    )
    assert isinstance(caught, AssertionError), (
        f"the tripwire raised {type(caught).__name__}, not AssertionError. A "
        "pytest.skip raises Skipped, a BaseException, which ABORTS the caller AS "
        "SKIPPED rather than failing it - the silent-skip regression this control "
        "exists to catch."
    )
    assert "CANNOT BE CHECKED" in str(caught), caught


def test_the_acr_lane_tripwire_fails_loudly_when_its_subject_is_missing(monkeypatch, tmp_path):
    """THE NEGATIVE CONTROL FOR THE TRIPWIRE ITSELF -- a skip and a failure must
    not be the same observation.

    Drives the REAL test function with `_repo_root` pointed at a directory that
    exists and does not contain the lane, which is exactly what a RENAME looks
    like. The message is not transcribed: the real function runs, and the
    helper asserts on what it actually raised.

    Breaks if: the missing-file branch goes back to `pytest.skip` -- the helper
    catches `BaseException` and asserts the TYPE, so a `Skipped` fails here
    instead of quietly aborting. Also breaks if `_repo_root()` stops being
    consulted at all.
    """
    monkeypatch.setitem(globals(), "_repo_root", lambda: tmp_path)
    _assert_tripwire_fails_loudly(
        test_the_acr_lane_invariant_the_scope_sentence_rests_on_still_holds
    )


def test_negative_control_the_tripwire_guard_itself_catches_a_reversion_to_skip():
    """THE INSTRUMENT FOR THE INSTRUMENT, because the layer below it was wrong.

    `ARMS` may only mutate the files in `mutate_gates.SOURCES` -- the production
    modules -- so no mutation arm can be pointed at a test file, and the helper
    above would otherwise have no standing instrument of any kind. This test is
    that instrument: it hands `_assert_tripwire_fails_loudly` a callable that
    does nothing but `pytest.skip`, i.e. the exact regression, and requires the
    helper to convert it into a failure.

    Written to be robust at ITS level too: a plain
    `pytest.raises(AssertionError)` here would reproduce the very bug one layer
    up, because a `Skipped` escaping the helper would abort THIS test as
    skipped. The explicit `except BaseException` arm is what makes that case
    red instead of green.

    Breaks if: the helper reverts to `pytest.raises(AssertionError)` (the skip
    escapes and the BaseException arm converts it to a failure), or if it stops
    checking the exception type (the else-arm fires).
    """
    def reverted_tripwire():
        pytest.skip("simulated regression: a missing subject treated as out-of-tree")

    caught = None
    try:
        _assert_tripwire_fails_loudly(reverted_tripwire)
    except AssertionError as exc:
        caught = exc
    except BaseException as exc:
        raise AssertionError(
            f"the helper let {type(exc).__name__} ESCAPE - a Skipped reaching this "
            "frame aborts the test as skipped, which is the silent-skip defect one "
            "layer up"
        ) from exc
    else:
        raise AssertionError(
            "the helper accepted a bare pytest.skip as a loud failure - the "
            "silent-skip regression would ship unnoticed"
        )
    assert "not AssertionError" in str(caught), (
        f"the helper failed, but not for the skip reason: {caught}"
    )


def test_the_acr_lane_tripwire_skips_only_when_genuinely_out_of_tree(monkeypatch):
    """The OTHER side of that boundary, so the failure above cannot be achieved
    by making the test raise unconditionally.

    `_repo_root()` returning None is the only thing that may buy a skip, and
    that is the sandbox's signature.

    Breaks if: out-of-tree stops skipping (the mutation matrix would then score
    every arm KILLED on this test regardless of the mutation -- the tautology
    `EXPECTED_SANDBOX_SKIPS` exists to prevent)."""
    monkeypatch.setitem(globals(), "_repo_root", lambda: None)
    with pytest.raises(pytest.skip.Exception):
        test_the_acr_lane_invariant_the_scope_sentence_rests_on_still_holds()



def test_negative_control_an_empty_rollup_is_not_a_clean_advisory_answer():
    """A clean answer over an EMPTY population is the green-over-zero-items
    shape (#4451: `pass=0 fail=4` printed "UAT-verified roll").

    Breaks if: the guard is removed -- the split over `[]` is empty, carries no
    red, and would otherwise report GO."""
    ok, why = gates.advisory_verdict([], REQUIRED, True)
    assert not ok
    assert "measured NOTHING" in why


def test_negative_control_the_policy_flag_off_takes_the_arm_out_of_service():
    """`advisory_red_is_a_no_go` is the authority, and it is NOT a switch: this
    gate implements no permissive mode, so false means "cannot answer", which
    is NO-GO. A key that could turn a control OFF would be a skip valve.

    Breaks if: the flag becomes an if/else around the blocking branch -- then
    false would return ok=True over this all-green fixture."""
    checks = [_run(n, "SUCCESS") for n in REQUIRED] + [_adv("CodeQL", "SUCCESS")]
    assert gates.advisory_verdict(checks, REQUIRED, True)[0]
    ok, why = gates.advisory_verdict(checks, REQUIRED, False)
    assert not ok
    assert "no such mode" in why


def test_the_advisory_split_counts_the_whole_published_population():
    """The counts are what let a reader tell "clean over 25" from "clean over
    0" -- see the empty-rollup control above.

    Breaks if: `total_checks` is derived from the advisory subset (it would
    read 2, not 5) or `population` counts required contexts (it would read 5).

    EVERY BUCKET IS NON-EMPTY HERE, ON PURPOSE. The previous fixture ended
    `assert split.rerun == []`, which meant dropping `len(rerun)` from the
    `population` sum at `gates.py` SURVIVED the whole suite at rc=0 — found by
    an independent reviewer. A fixture that pins a term to zero cannot witness
    that term's removal: zero is what the mutant computes too. The consequence
    was confined to the gate's own printed counts, so a NO-GO naming an
    ADV-RERUN would have reported `0 advisory of N published`, contradicting
    `AdvisorySplit`'s contract — an R7 defect in a gate's own message.

    So each of the four terms now contributes a DISTINCT non-zero count, and
    `population` is asserted as their sum: dropping any one of the four changes
    the total and fails here."""
    checks = [_run(n, "SUCCESS") for n in REQUIRED] + [
        _adv("CodeQL", "SUCCESS"),
        _adv("Checkov", "FAILURE"),
        # rerun: a red concluded run with a re-run still in flight
        _adv("Trivy", "FAILURE", started="2026-09-18T10:00:00Z"),
        _adv("Trivy", None, status="IN_PROGRESS", started="2026-09-18T11:00:00Z"),
        # wait: running, with nothing red behind it
        _adv("Bicep Lint", None, status="IN_PROGRESS"),
    ]
    split = gates.classify_advisory_checks(checks, REQUIRED)
    assert split.total_checks == 8
    assert split.red == ["Checkov (FAILURE)"]
    assert split.clean == ["CodeQL"]
    assert len(split.rerun) == 1
    assert "Trivy" in split.rerun[0]
    assert split.wait == ["Bicep Lint"]
    # The SUM, term by term — this is the assertion that dies when any one of
    # the four is dropped from the expression.
    assert split.population == 4, (
        f"population must count all four buckets: red={split.red} "
        f"rerun={split.rerun} wait={split.wait} clean={split.clean}"
    )
    assert split.population == (
        len(split.red) + len(split.rerun) + len(split.wait) + len(split.clean)
    )


# ---------------------------------------------------------------------------
# Gate 5 -- hollow check
# ---------------------------------------------------------------------------


def test_a_check_that_measured_something_is_not_hollow():
    hollow, note = gates.check_is_hollow("Python Lint", "SUCCESS", 773)
    assert not hollow
    assert "773" in note


def test_negative_control_green_over_zero_items_is_hollow():
    """#4451: `pass=0 fail=4` printed "UAT-verified roll". A pass with no
    population is the absence of evidence wearing evidence's colour."""
    hollow, note = gates.check_is_hollow("UAT", "SUCCESS", 0)
    assert hollow
    assert "ZERO" in note


def test_negative_control_skipped_is_hollow():
    hollow, _ = gates.check_is_hollow("Bicep Lint", "SKIPPED", None)
    assert hollow


def test_negative_control_an_unreported_population_is_not_a_pass():
    """"I do not know" must not round to "yes"."""
    hollow, note = gates.check_is_hollow("guardrails", "SUCCESS", None)
    assert hollow
    assert "cannot assert" in note


# ---------------------------------------------------------------------------
# Gate 1 -- base == origin/main
# ---------------------------------------------------------------------------


def test_current_base_is_go():
    ok, why = gates.base_is_current("main", "a" * 40, "a" * 40)
    assert ok, why


def test_negative_control_a_stale_base_blocks():
    """Every green check on a stale base is a statement about a tree that no
    longer exists."""
    ok, why = gates.base_is_current("main", "a" * 40, "b" * 40)
    assert not ok
    assert "!=" in why


def test_negative_control_a_non_main_base_blocks():
    ok, why = gates.base_is_current("release/0.106", "a" * 40, "a" * 40)
    assert not ok
    assert "not 'main'" in why


def test_negative_control_an_unresolvable_sha_is_not_a_pass():
    ok, why = gates.base_is_current("main", "", "")
    assert not ok
    assert "unmeasurable" in why


# ---------------------------------------------------------------------------
# Gate 1's second arm (#4585) -- a base delta that no required context's
# producing workflow declares an on.push filter ADMITTING
#
# An EMPTY INTERSECTION IS THE ANSWER THAT LETS A MERGE THROUGH, so the dominant
# risk here is a query that returns empty because it is BLIND rather than
# because the delta is inert. Every refusal below names the value that produces
# it, and the positive control at the end of the section proves the query can
# return non-empty at all -- taken over patterns LIFTED OUT OF A REAL WORKFLOW
# FILE at run time, never transcribed, so a typo here cannot make the probe
# agree with itself.
# ---------------------------------------------------------------------------

#: Two contexts, not one. A predicate that stops at the first scope, or that
#: `any()`s where it should `all()`, is invisible to a one-element fixture --
#: the population-narrowing shape this file's own docstring records.
_SCOPE_A = gates.ContextScope(
    "Alpha", ".github/workflows/alpha.yml", paths=("alpha/**", "shared.txt"))
_SCOPE_B = gates.ContextScope(
    "Beta", ".github/workflows/beta.yml", paths=("beta/**",))
_BOTH = ["Alpha", "Beta"]


def test_a_delta_outside_every_required_scope_is_inert():
    """PASSES because neither `docs/x.md` nor `README.md` matches `alpha/**`,
    `shared.txt` or `beta/**`. Swap either for `beta/y.txt` and it goes red."""
    ok, why = gates.base_delta_is_inert(
        ["docs/x.md", "README.md"], [_SCOPE_A, _SCOPE_B], _BOTH)
    assert ok, why
    # The brief on this arm: an empty intersection is only evidence if the
    # reader can see what it was taken over. Both names, not a count.
    assert "Alpha" in why, why
    assert "Beta" in why, why
    assert "docs/x.md" in why, why


def test_negative_control_a_delta_the_second_contexts_filter_admits_still_blocks():
    """`beta/y.txt` is outside Alpha's scope and inside Beta's. A loop that
    returns on the first scope's clean result passes this; the correct one
    refuses. Change the file to `docs/y.txt` and this test goes green-and-
    wrong, which is why the file is named in the assertion."""
    ok, why = gates.base_delta_is_inert(
        ["docs/x.md", "beta/y.txt"], [_SCOPE_A, _SCOPE_B], _BOTH)
    assert not ok
    assert "'Beta'" in why, why
    assert "beta/y.txt" in why, why


def test_negative_control_a_delta_the_first_contexts_filter_admits_still_blocks():
    """The mirror. `shared.txt` is a LITERAL pattern, so this also pins that a
    non-wildcard entry in a `paths:` list is honoured -- a translator that only
    handled `**` would read `shared.txt` as matching nothing and excuse it."""
    ok, why = gates.base_delta_is_inert(
        ["shared.txt"], [_SCOPE_A, _SCOPE_B], _BOTH)
    assert not ok
    assert "'Alpha'" in why, why
    assert "shared.txt" in why, why


def test_negative_control_a_context_with_no_path_filter_fails_closed():
    """The case that governs this repo TODAY: 5 of the 17 required contexts are
    produced by workflows whose `push:` carries no `paths:` at all. Such a
    workflow ADMITS EVERY PATH on push, so no delta is inert for it -- and the
    delta
    here (`docs/x.md`) is one that every OTHER scope in this file excuses, so
    the refusal can only be coming from the missing filter."""
    unfiltered = gates.ContextScope("Gamma", ".github/workflows/gamma.yml")
    ok, why = gates.base_delta_is_inert(
        ["docs/x.md"], [_SCOPE_A, unfiltered], ["Alpha", "Gamma"])
    assert not ok
    assert "'Gamma'" in why, why
    assert "ADMITS EVERY PATH" in why, why


def test_negative_control_an_empty_paths_list_refuses_and_is_not_the_absent_one():
    """The FOURTH state, and the one that was unwatched for a round.

    `paths: []` in a workflow parses to `()`. `paths is None` is False, so it
    sails past the no-filter branch above; then `any([])` is False for every
    file, so every delta falls outside the filter and the context excuses the
    whole thing -- "matches nothing is the answer that lets a merge through",
    arriving through the one branch that looked like it had handled it.

    THE TWO SPELLINGS ARE OPPOSITE FACTS AND THE MESSAGES MUST DIFFER.
    `paths: []` admits NOTHING. `paths-ignore: []` ignores nothing and
    therefore admits EVERYTHING. Round 2 gave both the "matches NOTHING"
    sentence, which is inverted for the second -- and that half had already
    been refused correctly (as a hit) before the branch existed, so a true
    reason was replaced with a false one. The assertions below are what stops
    that recurring: each pins the phrase that is true of ITS spelling, so
    sharing one sentence again turns one of them red.

    Delete the `paths == ()` branch and the first block goes red; delete the
    `paths_ignore == ()` branch and the second does.
    """
    empty = gates.ContextScope("Iota", ".github/workflows/iota.yml", paths=())
    ok, why = gates.base_delta_is_inert(["docs/x.md"], [empty], ["Iota"])
    assert not ok, why
    assert "'Iota'" in why, why
    assert "ADMITS NOTHING" in why, why
    assert "ADMITS EVERY PATH" not in why, (
        "`paths: []` admits nothing; saying it admits everything is the "
        f"inversion this assertion exists for: {why}"
    )

    empty_ignore = gates.ContextScope(
        "Kappa", ".github/workflows/kappa.yml", paths_ignore=())
    ok_ignore, why_ignore = gates.base_delta_is_inert(
        ["docs/x.md"], [empty_ignore], ["Kappa"])
    assert not ok_ignore, why_ignore
    assert "'Kappa'" in why_ignore, why_ignore
    assert "ADMITS EVERY PATH" in why_ignore, why_ignore
    assert "ADMITS NOTHING" not in why_ignore, (
        "`paths-ignore: []` ignores nothing, so it admits EVERY path - the "
        f"round-2 inversion: {why_ignore}"
    )


def test_negative_control_an_unfiltered_context_refuses_even_an_empty_delta():
    """Named separately because the empty-delta branch is a SECOND exit from
    this function and could be reached before the scope loop. If it were, an
    unfiltered context would be excused by a delta of zero files -- and zero
    files is what an unreadable `git diff` would look like to a caller that
    mapped failure to `[]`."""
    unfiltered = gates.ContextScope("Gamma", ".github/workflows/gamma.yml")
    ok, why = gates.base_delta_is_inert([], [_SCOPE_A, unfiltered], ["Alpha", "Gamma"])
    assert not ok
    assert "'Gamma'" in why, why


def test_negative_control_an_unresolved_scope_is_not_an_empty_intersection():
    """`unreadable` must REFUSE, never read as "matches nothing". This is the
    field that exists so a traced-producer failure cannot be mistaken for a
    clean result -- delete it and `paths=None` collapses into the branch above,
    which is the same refusal for the wrong reason."""
    broken = gates.ContextScope(
        "Delta", ".github/workflows/delta.yml",
        unreadable="the check-suite that published it owns no workflow run")
    ok, why = gates.base_delta_is_inert(["docs/x.md"], [_SCOPE_A, broken], ["Alpha", "Delta"])
    assert not ok
    assert "'Delta'" in why, why
    assert "owns no workflow run" in why, why


def test_negative_control_a_required_context_with_no_scope_row_blocks():
    """The population check. `required` is passed separately precisely so a
    caller that silently drops the one context it could not scope cannot buy a
    clean intersection over the remainder -- here `Beta` has no scope object at
    all and the delta (`docs/x.md`) is inert for the one that does."""
    ok, why = gates.base_delta_is_inert(["docs/x.md"], [_SCOPE_A], _BOTH)
    assert not ok
    assert "Beta" in why, why
    assert "no scope at all" in why, why


def test_negative_control_an_unreadable_delta_is_not_a_pass():
    """`None` is "I could not read it". The same fixture with `[]` is a
    measured empty delta and passes -- the two must not collapse, which is
    what the pair of assertions below pins."""
    ok, why = gates.base_delta_is_inert(None, [_SCOPE_A, _SCOPE_B], _BOTH)
    assert not ok
    assert "could not be read" in why, why
    ok_empty, _ = gates.base_delta_is_inert([], [_SCOPE_A, _SCOPE_B], _BOTH)
    assert ok_empty


def test_negative_control_an_empty_required_set_is_vacuous_not_inert():
    """With no required contexts the intersection is empty by construction.
    An empty required set is what a failed branch-protection read looks like."""
    ok, why = gates.base_delta_is_inert(["beta/y.txt"], [_SCOPE_A, _SCOPE_B], [])
    assert not ok
    assert "EMPTY" in why, why


def test_negative_control_an_unrepresentable_filter_pattern_refuses():
    """`!` negates and `[...]` is a range; treating either as a literal
    UNDER-matches, and under-matching is the excusing direction. `glob_matches`
    already raises for these -- this pins that the raise becomes a REFUSAL here
    rather than escaping as a traceback out of the program deciding merges."""
    weird = gates.ContextScope("Eps", ".github/workflows/eps.yml", paths=("src/[0-9]*.py",))
    ok, why = gates.base_delta_is_inert(["docs/x.md"], [weird], ["Eps"])
    assert not ok
    assert "cannot represent" in why, why


def test_negative_control_an_unrepresentable_pattern_after_a_match_still_refuses():
    """Kills the SHORT-CIRCUIT, which only bites under `paths-ignore`.

    `any()` over a generator stops at the first True. Under `paths-ignore` that
    True means "this file is ignored", the function answers "not read", and the
    unrepresentable pattern SITTING AFTER IT is never evaluated -- so a `!`
    re-include (the one `_UNSUPPORTED_GLOB`'s own comment says "can excuse
    outright") is skipped and the delta is called inert.

    `docs/x.md` matches `docs/**`, which is pattern ONE. With a generator the
    answer is INERT; with the list comprehension `src/[0-9]*.py` raises and the
    answer is REFUSE. Nothing else in this file distinguishes the two, because
    every other unsupported-pattern fixture has no matching pattern before it.
    """
    lurking = gates.ContextScope(
        "Theta", ".github/workflows/theta.yml",
        paths_ignore=("docs/**", "src/[0-9]*.py"))
    ok, why = gates.base_delta_is_inert(["docs/x.md"], [lurking], ["Theta"])
    assert not ok, why
    assert "cannot represent" in why, why


def test_a_paths_ignore_filter_is_read_as_everything_except():
    """`paths-ignore` inverts the test, and getting the polarity backwards is
    the single most excusing error available: it would make the IGNORED paths
    the only ones that block. Both directions are pinned on ONE scope."""
    ignoring = gates.ContextScope(
        "Zeta", ".github/workflows/zeta.yml", paths_ignore=("docs/**", "*.md"))
    ok, why = gates.base_delta_is_inert(["docs/x.md", "README.md"], [ignoring], ["Zeta"])
    assert ok, why
    blocked, why_blocked = gates.base_delta_is_inert(
        ["docs/x.md", "src/app.py"], [ignoring], ["Zeta"])
    assert not blocked
    assert "src/app.py" in why_blocked, why_blocked


def test_negative_control_declaring_both_paths_and_paths_ignore_refuses():
    """GitHub does not accept both on one event, so a workflow that appears to
    carry both was misparsed. Guessing which wins is the unanswered question
    this package refuses on principle."""
    confused = gates.ContextScope(
        "Eta", ".github/workflows/eta.yml", paths=("a/**",), paths_ignore=("b/**",))
    ok, why = gates.base_delta_is_inert(["docs/x.md"], [confused], ["Eta"])
    assert not ok
    assert "BOTH" in why, why


def test_doublestar_slash_under_paths_ignore_is_refused_not_translated():
    """`**/` is safe under `paths:` and EXCUSING under `paths-ignore:`.

    `_glob_to_regex` lets `**/` consume zero segments together with its slash,
    so it matches MORE paths than a strict reading. Under `paths:` that admits
    more, which makes a delta look live -- harmless. Under `paths-ignore:` it
    ignores more, which makes the delta look INERT, and that is the direction
    that decides a merge.

    NARROW BY DESIGN: a bare trailing `**` has no zero-segment branch and is
    still read as "everything under this prefix" -- see
    `test_a_paths_ignore_filter_is_read_as_everything_except`, which keeps
    passing and is the control for this test not being over-broad.

    WHAT WOULD MAKE THIS FAIL: `filter_admits` translating `**/` under
    `paths-ignore` again instead of raising, turning the first case back into
    a silent `ok=True`.
    """
    permissive = gates.ContextScope(
        "Theta", ".github/workflows/theta.yml", paths_ignore=("docs/**/*.md",))
    ok, why = gates.base_delta_is_inert(["docs/a/b.md"], [permissive], ["Theta"])
    assert not ok, why
    assert "paths-ignore" in why, why

    # POSITIVE PAIR -- without it, "refuse everything" would satisfy the above.
    # A paths-ignore with no `**/` must still decide, and decide BOTH ways.
    strict = gates.ContextScope(
        "Iota", ".github/workflows/iota.yml", paths_ignore=("docs/x.md",))
    ok_ignored, _ = gates.base_delta_is_inert(["docs/x.md"], [strict], ["Iota"])
    assert ok_ignored, "a fully-ignored delta must still read as inert"
    ok_live, why_live = gates.base_delta_is_inert(["src/app.py"], [strict], ["Iota"])
    assert not ok_live, why_live


def test_the_printed_counts_are_the_real_counts_not_the_truncated_ones():
    """`_HITS_SHOWN`'s own comment asserts "The COUNT is always printed, so
    truncation cannot make a large intersection look small". That is a stated
    SAFETY PROPERTY, and until this test it had zero kill power -- falsifying
    any of the three counts survived the whole suite.

    All three are pinned here against a population deliberately larger than
    `_HITS_SHOWN`, so truncation is actually exercised:

      1. the refusal's `N file(s) are ADMITTED BY` count,
      2. the GO path's `(N file(s))` delta count,
      3. the GO path's `(+N more)` truncation suffix.

    WHAT WOULD MAKE THIS FAIL: replacing any of those with a constant, with
    `len(...[:_HITS_SHOWN])`, or dropping the suffix -- each makes a large
    intersection or a large delta read as small next to a merge being let
    through.

    `_HITS_SHOWN` is LIFTED from the module, not transcribed, so a change to
    it cannot make this probe disagree with the implementation.
    """
    shown = gates._HITS_SHOWN
    n = shown + 4  # strictly larger, so the suffix must appear

    # --- refusal branch: every file admitted -------------------------------
    admitted = [f"src/f{i}.py" for i in range(n)]
    admits_src = gates.ContextScope(
        "Kappa", ".github/workflows/kappa.yml", paths=("src/**",))
    ok, why = gates.base_delta_is_inert(admitted, [admits_src], ["Kappa"])
    assert not ok, why
    assert f"{n} file(s) in the base delta are ADMITTED BY" in why, why
    # ...and it names only `shown` of them, which is what makes the count
    # load-bearing rather than decorative.
    assert why.count("src/f") == shown, why

    # --- GO branch: nothing admitted, but the delta is still large ---------
    unadmitted = [f"docs/d{i}.md" for i in range(n)]
    ok, why = gates.base_delta_is_inert(unadmitted, [admits_src], ["Kappa"])
    assert ok, why
    assert f"({n} file(s))" in why, why
    assert f"(+{n - shown} more)" in why, why
    assert why.count("docs/d") == shown, why

    # --- control: at or below the threshold there is NO suffix -------------
    small = [f"docs/d{i}.md" for i in range(shown)]
    ok, why = gates.base_delta_is_inert(small, [admits_src], ["Kappa"])
    assert ok, why
    assert "more)" not in why, f"suffix appeared for a delta of exactly {shown}: {why}"


def _real_push_scope(workflow_path: str, name: str) -> gates.ContextScope:
    """A `ContextScope` built from a REAL workflow file in this checkout.

    The patterns are LIFTED with the same parser production uses
    (`gates.parse_push_trigger`), never transcribed -- assertion-design.md's
    "lift the pattern out of the source at runtime rather than transcribing it,
    so a typo cannot make the probe disagree with the implementation".

    A MISSING WORKFLOW IS A FAILURE, NOT A SKIP, for the reason
    `test_the_acr_lane_invariant_...` records at length: the skip belongs to
    `_repo_root()` being None (genuinely out of tree), and a file that has been
    renamed out from under a control must turn it RED, not quiet.
    """
    root = _repo_root()
    assert root is not None, "callers must skip on _repo_root() is None first"
    workflow = root / workflow_path
    assert workflow.is_file(), (
        f"{workflow_path} is not in this checkout - it was renamed or removed, "
        "so the scope gate 1's second arm rests on CANNOT BE CHECKED. Re-point "
        "this test and re-read the new file's triggers."
    )
    trigger = gates.parse_push_trigger(workflow.read_text(encoding="utf-8"))
    assert trigger is not None, (
        f"{workflow_path} could not be parsed at all, so nothing below "
        "measures what it claims to"
    )
    assert trigger.present, (
        f"{workflow_path} has no on.push trigger, so nothing below "
        "measures what it claims to"
    )
    return gates.ContextScope(name, workflow_path,
                              paths=trigger.paths, paths_ignore=trigger.paths_ignore)


def test_positive_control_the_intersection_query_can_return_non_empty():
    """THE CONTROL THE WHOLE ARM RESTS ON (#4585, assertion-design.md).

    An empty intersection is the answer that lets a merge through. A query that
    can only EVER return empty -- a `_glob_to_regex` that emits `^$`, a loop
    over the wrong list, a scope whose patterns were dropped on the way in --
    is therefore the worst defect available here, and it is indistinguishable
    from the good case by inspection of its output.

    So: real patterns, lifted out of `.github/workflows/test.yml` at run time,
    and LITERAL probe paths. The probes are deliberately NOT derived from
    `scope.paths` -- a probe built out of the patterns under test agrees with
    them by construction and witnesses nothing.

    What makes each assertion fail:
      - `tools/drain/gates.py` reading False   -> the query is blind (`tools/**`
        and `**.py` both cover it; two patterns must BOTH stop matching).
      - `README.md` reading True               -> the query matches everything,
        which would make the refusals above pass for the wrong reason.

    SKIPS only out of tree (the mutation sandbox copies `tools/drain` alone),
    declared in `mutate_gates.EXPECTED_SANDBOX_SKIPS`. It therefore kills no
    arm, which is said out loud rather than implied: the arms are killed by the
    synthetic-fixture tests above, and this control is about the query being
    pointed at something real.
    """
    if _repo_root() is None:
        pytest.skip("out of tree: no .github/workflows + scripts/ci above this file")
    scope = _real_push_scope(".github/workflows/test.yml", "Python Tests (3.10)")
    # A workflow that LOST its filter would leave `paths=None`, every probe
    # would refuse for the no-filter reason, and this control would certify a
    # blind query as sighted. That is the circularity it exists to break.
    assert scope.paths, (
        ".github/workflows/test.yml declares no on.push `paths:` list, so this "
        "control cannot tell a sighted query from a blind one"
    )
    inside, outside = "tools/drain/gates.py", "README.md"
    assert gates.filter_admits(scope, inside) is True, (
        f"{inside!r} is admitted by test.yml's declared push filter - a False "
        "here is the blind-query defect this control exists to catch"
    )
    assert gates.filter_admits(scope, outside) is False, (
        f"{outside!r} matches none of {list(scope.paths)} - a True here means "
        "the translator matches everything"
    )
    # ...and the same two THROUGH the decision function gate 1 actually calls,
    # because a control that only exercises the helper leaves the caller unpinned.
    blocked, why_blocked = gates.base_delta_is_inert([inside], [scope], [scope.name])
    assert not blocked
    assert inside in why_blocked, why_blocked
    inert, why_inert = gates.base_delta_is_inert([outside], [scope], [scope.name])
    assert inert, why_inert


#: How many of the 17 required contexts are published by the three workflows
#: that declare NO `on.push` path filter. Those contexts refuse gate 1's
#: second arm unconditionally, which is the only reason the `on.push`-as-proxy
#: weakness is harmless today. MODULE level because ruff's N806 forbids an
#: uppercase name inside a function, and lowercasing it would read as an
#: incidental local rather than the pinned expectation it is.
_UNFILTERED_REQUIRED = 5


def test_positive_control_the_real_required_topology_is_measured_not_assumed():
    """THE SAFETY INTERLOCK, not a frequency note -- the earlier wording here
    framed this as "how often the arm fires", which points the remedy at the
    wrong thing at exactly the moment it matters.

    `gates.base_delta_is_inert` uses `on.push.paths` as a PROXY for what a
    context reads, and that proxy's precondition -- the declared push scope is
    a SUPERSET of what the context actually reads -- is unestablished, and is
    known FALSE for at least three contexts (`PowerShell Lint` recurses the
    whole tree, `Repo Hygiene` runs `find . -type f`, `Secret Scan` runs
    gitleaks over the repo). The only reason that is harmless today is that
    five of the 17 required contexts have NO push filter and therefore refuse
    unconditionally, so no stale base reaches the GO path at all.

    THIS TEST IS THE THING THAT NOTICES WHEN THAT STOPS BEING TRUE. If one of
    the three unfiltered workflows gains a `paths:` list, the interlock is
    gone, the arm begins deciding merges on a proxy that is wrong for at least
    three contexts, and the correct response is NOT to update a note -- it is
    to establish the superset relation per context, or to stop using the proxy.

    Goes RED in BOTH directions: `validate.yml` or `test.yml` losing its
    `paths:` list (then even the filtered side is unmeasurable), or any of the
    three unfiltered workflows gaining one (then the interlock has opened).

    SKIPS only out of tree; see the control above.
    """
    if _repo_root() is None:
        pytest.skip("out of tree: no .github/workflows + scripts/ci above this file")
    for path in (".github/workflows/test.yml", ".github/workflows/validate.yml"):
        scope = _real_push_scope(path, path)
        assert scope.paths, f"{path} lost its on.push paths filter"
    for path in (".github/workflows/fiab-console-ci.yml",
                 ".github/workflows/loom-guardrails.yml",
                 ".github/workflows/commit-message-parses.yml"):
        scope = _real_push_scope(path, path)
        drifted = (
            f"{path} now declares a push path filter. THE INTERLOCK HAS OPENED: "
            "gate 1's second arm can now reach its GO path, on a proxy "
            "(`on.push.paths` as a stand-in for what a context READS) whose "
            "superset precondition is unestablished and is known false for "
            "PowerShell Lint, Repo Hygiene and Secret Scan. Do NOT update the "
            "note in policy.json and move on -- establish the superset "
            "relation for every context this unblocks, or take the arm out of "
            "service. See gates.base_delta_is_inert."
        )
        assert scope.paths is None, drifted
        assert scope.paths_ignore is None, drifted

    # ---- SECOND AXIS -------------------------------------------------------
    # The loop above watches the workflow FILES. That is only half the
    # interlock. The unconditional refusal exists because those workflows
    # publish REQUIRED contexts; `merge_gate.required_contexts` reads branch
    # protection LIVE (merge_gate.py:451-468), so a context LEAVING the
    # required set removes exactly the same refusal without any workflow
    # changing at all -- and nothing noticed until two independent reviews
    # converged on it.
    #
    # NOT circular: the five names are derived from the workflow files, and
    # the COUNT is the independent expectation. Intersecting and then
    # asserting membership would be a tautology -- the count is what moves.
    root = _repo_root()
    unfiltered = (".github/workflows/fiab-console-ci.yml",
                  ".github/workflows/loom-guardrails.yml",
                  ".github/workflows/commit-message-parses.yml")
    texts = {}
    for path in unfiltered:
        wf = root / path
        assert wf.is_file(), f"{path} is not in this checkout"
        body = wf.read_text(encoding="utf-8")
        assert body.strip(), f"{path} read as empty - this probe went blind"
        texts[path] = body

    required = json.loads(
        (root / "tools" / "drain" / "required_contexts.json").read_text(encoding="utf-8")
    )["contexts"]
    assert len(required) >= 10, (
        f"only {len(required)} required contexts read - the snapshot was "
        "truncated, so the count below means nothing"
    )

    published = sorted(
        ctx for ctx in required
        if any(ctx in body for body in texts.values())
    )
    assert len(published) == _UNFILTERED_REQUIRED, (
        f"{len(published)} required context(s) are published by the three "
        f"unfiltered workflows, expected {_UNFILTERED_REQUIRED}: {published}. "
        "FEWER means branch protection dropped one (or a workflow was "
        "renamed), so that context no longer forces gate 1's second arm to "
        "refuse -- THE INTERLOCK IS WEAKENED ON THE AXIS THE LOOP ABOVE DOES "
        "NOT WATCH. It is not necessarily GONE: the remaining unfiltered "
        "contexts still refuse unconditionally, and the interlock only opens "
        "when the count reaches zero. The remedy is the same either way -- "
        "establish the superset relation per context, or take the arm out of "
        "service. MORE means a new unfiltered required context appeared and "
        "this floor needs re-measuring, not raising on sight. Note the "
        "snapshot read here can lag live protection (#4629); this is the "
        "offline half of the check, and it agreed with live when measured."
    )


# ---------------------------------------------------------------------------
# Gate 7 -- the before/after open-issue audit
# ---------------------------------------------------------------------------


def test_an_exact_delta_passes_the_audit():
    ok, why = gates.issue_count_audit(297, 296, [4468])
    assert ok, why


def test_negative_control_a_silent_extra_close_is_caught():
    """The detection half. #4361 closed while `closingIssuesReferences` read
    EMPTY -- the count is what caught it, not the API."""
    ok, why = gates.issue_count_audit(297, 295, [4468])
    assert not ok
    assert "EXCEEDS" in why


def test_negative_control_an_issue_that_did_not_close_is_also_a_finding():
    """The backlog lying in the other direction is still the backlog lying."""
    ok, why = gates.issue_count_audit(297, 297, [4468])
    assert not ok
    assert "SHORT" in why


# ---------------------------------------------------------------------------
# Autonomy contract -- must FAIL CLOSED
# ---------------------------------------------------------------------------

POLICY = gates.load_policy(
    os.path.join(os.path.dirname(__file__), "..", "policy.json")
)


def test_permitted_action_is_allowed():
    ok, _ = gates.action_is_permitted("merge-on-gate-go", POLICY)
    assert ok


def test_negative_control_stop_and_ask_is_refused():
    ok, why = gates.action_is_permitted("move_live_acr_tags", POLICY)
    assert not ok
    assert "STOP AND ASK" in why


def test_negative_control_never_is_refused():
    ok, why = gates.action_is_permitted("commit-a-secret", POLICY)
    assert not ok
    assert "NEVER" in why


def test_negative_control_unknown_action_fails_closed():
    """An action in neither list is REFUSED. Adding a capability must be a
    deliberate edit to policy.json, never an emergent behaviour."""
    ok, why = gates.action_is_permitted("rewrite-git-history", POLICY)
    assert not ok
    assert "fails closed" in why


def test_negative_control_a_prefix_of_a_permitted_action_is_not_permitted():
    """Matching is EXACT. A fast path keyed on a shared prefix -- `startswith`
    anywhere in this function -- turns one permission into a family, and every
    fixture naming an exact known action stays green while it does."""
    for action in ("merge-without-review", "merge-on-gate-go-and-skip-uat", "merge"):
        ok, why = gates.action_is_permitted(action, POLICY)
        assert not ok, f"{action} must be refused: {why}"


def test_the_documentation_key_is_not_an_action():
    """policy.json's `stop_and_ask` carries a `_` key holding rationale prose.
    Emitted into a brief it prints `Stop and ask for: _, add_trivyignore_entry`,
    which reads as a parsing bug and teaches the reader to skim the line."""
    actions = gates.stop_and_ask_actions(POLICY)
    assert "_" not in actions
    assert "move_live_acr_tags" in actions


def test_the_policy_declares_the_repo_it_governs():
    """`gh` with no --repo resolves from the working directory, so the repo is a
    policy input or it is an accident."""
    assert POLICY["repo"] == "fgarofalo56/csa-inabox"


def test_receipt_must_match_the_issue_class():
    assert gates.receipt_satisfies("ui-surface", "g1-browser", POLICY)


def test_negative_control_wrong_receipt_does_not_close():
    """`ci-green` does not close a UI surface. Per ux-baseline G1, tsc + vitest
    are not completion evidence -- only the browser catches a dead data path
    AND a frozen renderer."""
    assert not gates.receipt_satisfies("ui-surface", "ci-green", POLICY)


def test_negative_control_ci_green_does_not_close_a_deploy_path_item():
    """R1's stream. `ci-green` on a deploy-path issue is `report-a-merge-as-a-fix`
    with extra steps."""
    assert not gates.receipt_satisfies("deploy-path", "ci-green", POLICY)
    assert gates.receipt_satisfies("deploy-path", "deploy-run", POLICY)


def test_every_receipt_class_is_reachable():
    """All five classes exist in policy.json, and `ledger.Item` must be able to
    land in each. Two of the five were unreachable: the brief keyed the receipt
    off `lane == 'lane:console'`, so `deploy-run`, `estate` and `operator` were
    never selected for any item."""
    classes = {k: v for k, v in POLICY["receipts"].items() if not k.startswith("_")
               and not k.endswith("_rule")}
    assert set(classes) == {
        "guard-or-test-only", "deploy-path", "estate-behaviour", "ui-surface", "human-only"
    }


# --- verdict_transfers_across_base_update -------------------------------
#
# THE CONTROL IN THIS BLOCK IS THE POINT, and it is the one that is easy to
# write un-killably. A merge commit and its FIRST PARENT auto-merge to the SAME
# tree, so a "negative" fixture built by swapping the head for its parent
# passes for a reason that has nothing to do with the gate. Every refusing
# fixture below therefore differs in CONTENT -- a different tree sha -- or in
# SHAPE (parent count, membership, unresolvability).

A = "a" * 40          # the approved head: what the reviewer measured
B = "b" * 40          # the base tip it was merged with
T_MERGE = "1" * 40    # tree of the clean auto-merge of A and B
T_OTHER = "2" * 40    # a DIFFERENT tree -- content nobody reviewed


def test_a_pure_base_update_transfers_the_verdict():
    """The whole purpose: update-branch authored nothing, so the bytes the
    reviewer measured are the bytes on offer.

    Breaks if: the tree comparison is dropped, or parent membership stops
    being required -- either would make this return False and the queue would
    stay serialized.
    """
    ok, why = gates.verdict_transfers_across_base_update([A, B], A, T_MERGE, T_MERGE)
    assert ok, why
    assert "auto-merge" in why


def test_a_head_carrying_new_content_does_not_transfer():
    """THE ARM THAT MUST FIRE. Same parents, same approved head -- only the
    TREE differs, which is exactly the case where somebody pushed a fix on top
    of the base update and no reviewer has seen it.

    This fixture differs from the accepting one in CONTENT ALONE (T_OTHER vs
    T_MERGE). That is deliberate: a fixture that instead swapped the head for
    its first parent would auto-merge to the same tree and pass without
    exercising anything.

    Breaks if: `automerge_tree != head_tree` stops refusing.
    """
    ok, why = gates.verdict_transfers_across_base_update([A, B], A, T_MERGE, T_OTHER)
    assert not ok
    assert "NOT reviewed" in why


def test_a_conflicted_automerge_refuses_rather_than_comparing():
    """`merge-tree` writes NO tree when the merge conflicts, so a head that
    exists anyway was hand-resolved -- unreviewed content by definition.

    Breaks if: an unresolvable tree is treated as "no difference". Note the
    distinction being pinned: None must NOT take the equality path, where
    `None != T_MERGE` would coincidentally also refuse but for the wrong
    reason and with the wrong message.
    """
    ok, why = gates.verdict_transfers_across_base_update([A, B], A, None, T_MERGE)
    assert not ok
    assert "conflict" in why
    assert "NOT reviewed" not in why, (
        "a conflict was reported as a content difference; the two are "
        "different findings and the operator acts on them differently")


def test_an_ordinary_commit_is_not_a_base_update():
    """One parent means somebody authored something. A base update is always a
    two-parent merge.

    Breaks if: the parent-count check is removed -- which would let an ordinary
    push inherit a verdict merely by having a matching tree.
    """
    ok, why = gates.verdict_transfers_across_base_update([A], A, T_MERGE, T_MERGE)
    assert not ok
    assert "1 parent" in why


def test_an_octopus_merge_refuses_rather_than_approximating():
    """Three parents cannot be modelled by the two-arg merge-tree the caller
    runs, so the answer is unknown, so it refuses.

    Breaks if: the check becomes `len(parents) >= 2`.
    """
    ok, why = gates.verdict_transfers_across_base_update(
        [A, B, "c" * 40], A, T_MERGE, T_MERGE)
    assert not ok
    assert "3 parent" in why


def test_a_verdict_from_outside_the_parents_does_not_transfer():
    """Reachability is NOT the question. A commit between the approved head and
    this merge could have authored anything, and the tree equality would still
    hold for the parents actually merged.

    Breaks if: parent membership stops being required.
    """
    ok, why = gates.verdict_transfers_across_base_update(
        [B, "c" * 40], A, T_MERGE, T_MERGE)
    assert not ok
    assert "not a parent" in why


def test_an_unresolvable_head_tree_is_not_a_pass():
    """Fails CLOSED on an unmeasurable input, like every other gate here.

    Breaks if: an empty head tree compares equal to an empty automerge tree and
    returns True -- the "two unknowns agree" shape.
    """
    ok, why = gates.verdict_transfers_across_base_update([A, B], A, "", "")
    assert not ok
    assert "unmeasurable" in why


def test_the_transfer_is_direction_agnostic_about_which_parent_is_approved():
    """update-branch puts the PR head first; a merge made the other way round
    puts it second. The rule is about CONTENT, so parent ORDER must not decide
    it.

    Breaks if: the check becomes `parents[0] == approved_head`, which passes
    the common case and silently refuses the other one.
    """
    ok, why = gates.verdict_transfers_across_base_update([B, A], A, T_MERGE, T_MERGE)
    assert ok, why


# ---------------------------------------------------------------------------
# Supersession -- the ONE explicit discharge (#4704, measured on PR #4693)
# ---------------------------------------------------------------------------
#
# The configuration that stranded #4693: the finding was NOT IN THE DIFF (a
# squash body the coordinator authors at merge time), so nothing could be
# pushed to void the block; the coordinator fixed it; the same reviewer
# re-adjudicated at the UNCHANGED head and approved. `[RC, APPROVE, APPROVE]`,
# all live, all pinned to one sha, NO-GO forever.
#
# Every fixture below goes through `parse_verdicts` on REAL COMMENT TEXT rather
# than constructing `Verdict(supersedes=(1,))` by hand. A test that sets the
# field directly cannot witness `_supersessions` at all -- it would pass with
# the marker parser deleted, which is the "could not fail" shape
# `assertion-design.md` is about.

#: LIFTED from the source, never transcribed. A typo here would otherwise make
#: the probe agree with itself while disagreeing with the parser.
SUP = gates.SUPERSESSION_MARKER

LATER = "2026-09-11T11:00:00Z"


def _review(cid, token, supersedes=None, pad="", wrap=None):
    """A real review comment, optionally carrying a supersession line.

    `wrap` CITES the supersession instead of stating it, in each of the idioms
    `classify_lines` enumerates.
    """
    body = f"## Independent re-review - {token}\n\n{pad}Head `abc`."
    if supersedes is not None:
        line = f"{SUP} {supersedes}"
        block = {
            None: line,
            "quote": f"> {line}",
            "fence": f"```\n{line}\n```",
            "indent": f"    {line}",
            "details": f"<details>\n{line}\n</details>",
            "comment": f"<!--\n{line}\n-->",
        }[wrap]
        body += f"\n\n{block}\n"
    return _c(cid, body, LATER)


def _reduce(comments):
    live, near = gates.parse_verdicts(comments, HEAD)
    return gates.reduce_verdicts(live, near)


def test_an_approve_that_names_the_block_discharges_it():
    """#4693's shape exactly, and the only thing this feature adds.

    Breaks if: the `SUPERSEDES` line is not parsed at all (the state before
    #4704 -- this returns NO-GO "live REQUEST-CHANGES"), or if the id is read
    but not matched against the blocking verdict's comment id.
    """
    ok, why = _reduce([
        _review(1, "REQUEST-CHANGES"),
        _review(2, "APPROVE", supersedes="1"),
        _review(3, "APPROVE"),
    ])
    assert ok, why
    assert SUP in why, f"the discharge must be said out loud: {why}"
    assert "1" in why, f"the discharge must NAME what it cleared: {why}"


def test_negative_control_an_approve_with_no_supersession_still_blocks():
    """THE PROPERTY BEING PRESERVED, and the arm most likely to be lost.

    Conjunction, not recency: a later APPROVE that names nothing discharges
    nothing. This is the same input as the test above minus the marker line.

    Breaks if: the discharge is loosened to "any later APPROVE clears any
    earlier block" -- i.e. if the id match is dropped, this returns GO.
    """
    ok, why = _reduce([
        _review(1, "REQUEST-CHANGES"),
        _review(2, "APPROVE"),
        _review(3, "APPROVE"),
    ])
    assert not ok
    assert "REQUEST-CHANGES" in why


def test_negative_control_discharging_one_block_does_not_discharge_another():
    """`[RC(1), RC(3), APPROVE(2) SUPERSEDES 1]` -> still NO-GO.

    Breaks if: the discharge is computed as "a supersession is present, so
    clear the blocks" rather than as a set of NAMED ids -- then block 3, which
    nobody addressed, vanishes and this returns GO.
    """
    ok, why = _reduce([
        _review(1, "REQUEST-CHANGES"),
        _review(3, "REQUEST-CHANGES"),
        _review(2, "APPROVE", supersedes="1"),
    ])
    assert not ok
    assert "REQUEST-CHANGES" in why
    assert "[1]" in why, f"the partial discharge is still reported: {why}"


def test_a_supersession_may_name_several_blocks_on_one_line():
    """Both ids, one line. Pairs with the test above: that one pins that an
    UNNAMED block survives, this one pins that a NAMED one does not have to
    survive just because it was listed second.

    Breaks if: only the first integer on the line is read -- then block 3 is
    undischarged and this returns NO-GO.
    """
    ok, why = _reduce([
        _review(1, "REQUEST-CHANGES"),
        _review(3, "REQUEST-CHANGES"),
        _review(2, "APPROVE", supersedes="1 3"),
    ])
    assert ok, why


def test_negative_control_a_supersession_naming_a_missing_id_is_refused():
    """REFUSED, not ignored -- failing open here would be the whole defect.

    The fixture carries NO block, deliberately: with one, the reduction is
    NO-GO either way and the assertion would have no kill power. Alone, an
    implementation that skips an unrecognised id returns GO.

    Breaks if: `discharged` is built by set union without checking that each id
    is present -- then this returns GO on an APPROVE that discharged nothing.
    """
    ok, why = _reduce([_review(2, "APPROVE", supersedes="999")])
    assert not ok
    assert SUP in why, why
    assert "999" in why, f"the refusal must name the unresolvable id: {why}"


def test_negative_control_a_supersession_naming_an_approve_is_refused():
    """An id that IS a verdict but is NOT a block.

    Breaks if: the target's token is never inspected -- then this returns GO,
    and the same hole lets a supersession delete the only live APPROVE.
    """
    ok, why = _reduce([
        _review(1, "APPROVE"),
        _review(2, "APPROVE", supersedes="1"),
    ])
    assert not ok
    assert SUP in why, why
    assert "not a block" in why, why


def test_negative_control_a_supersession_naming_a_near_miss_is_refused_not_ignored():
    """A blocking NEAR-MISS is not a verdict, so it cannot be superseded.

    PINS THE REASON, NOT THE VERDICT, and says so: the reduction is NO-GO
    either way here (the near-miss blocks on its own), so `not ok` alone has no
    kill power for this arm. What distinguishes refusal from silence is WHICH
    reason is reported.

    Breaks if: an id that is not in the live verdict set is skipped -- then the
    reported reason is "unparseable review at head", the broken supersession is
    invisible, and it stays invisible until the round where it is the only
    thing between the PR and a merge.
    """
    ok, why = _reduce([
        _c(1, "## Independent re-review - CHANGES REQUIRED\n\nHead `abc`.", LATER),
        _review(2, "APPROVE", supersedes="1"),
    ])
    assert not ok
    assert why.startswith(SUP), f"the refusal must outrank the near-miss: {why}"


def test_negative_control_a_block_cannot_discharge_a_block():
    """Mutual annihilation: `[RC(1) SUPERSEDES 2, RC(2) SUPERSEDES 1, APPROVE(3)]`.

    Two blocks cancel each other and no reviewer ever withdrew either.

    Breaks if: any live verdict may carry an honoured supersession, rather than
    only a non-blocking one -- then both blocks are discharged, the APPROVE
    satisfies the last condition, and this returns GO.
    """
    ok, why = _reduce([
        _review(1, "REQUEST-CHANGES", supersedes="2"),
        _review(2, "REQUEST-CHANGES", supersedes="1"),
        _review(3, "APPROVE"),
    ])
    assert not ok
    assert SUP in why, why
    assert "cannot discharge a block" in why, why


def test_negative_control_a_supersession_cannot_name_itself():
    """PINS THE REASON, NOT THE VERDICT, and says so: the block at 1 is
    undischarged either way, so this is NO-GO with or without the self-check.

    Breaks if: the `target == v.comment_id` arm is removed -- the reported
    reason becomes "live REQUEST-CHANGES", and self-discharge becomes a legal
    no-op that reads as an act.
    """
    ok, why = _reduce([
        _review(1, "REQUEST-CHANGES"),
        _review(2, "APPROVE", supersedes="2"),
    ])
    assert not ok
    assert "names ITSELF" in why


@pytest.mark.parametrize("wrap", ["fence", "indent", "details", "comment", "quote"])
def test_negative_control_a_cited_supersession_discharges_nothing(wrap):
    """Formatting may refuse to GRANT, and a discharge IS a grant.

    A `SUPERSEDES` line that is quoted, fenced, indented, collapsed or
    HTML-commented is a CITATION of a previous round -- relaying a verdict
    inside a fence is how this program moves them around -- not an act.

    Breaks if: `_supersessions` iterates raw lines instead of `classify_lines`
    prose -- then a cited line discharges a live block and this returns GO.

    WHICH ARMS ACTUALLY KILL, disclosed rather than counted (assertion-design
    §5): `fence`, `indent`, `details` and `comment` each kill that mutation,
    because `line.strip()` leaves those lines starting with the marker. `quote`
    does NOT -- `.strip()` never removes the `>`, so `startswith(SUP)` is False
    either way and the arm survives it. It is kept as a second, independent
    guard on the idiom that produced the original bypass, and it is NOT counted
    as coverage of the `classify_lines` call. Measured: the first version of
    this test used `quote` alone and the raw-lines mutant SURVIVED the suite.
    """
    ok, why = _reduce([
        _review(1, "REQUEST-CHANGES"),
        _review(2, "APPROVE", supersedes="1", wrap=wrap),
    ])
    assert not ok
    assert "REQUEST-CHANGES" in why


def test_negative_control_a_supersedes_line_with_no_id_is_refused():
    """`SUPERSEDES the round-3 finding` names nothing addressable.

    THIS FIXTURE IS DELIBERATELY DIGIT-BEARING. Its first run caught the
    parser mining `3` out of "round-3" under a bare `\\d+` scan, so an English
    sentence discharged whichever verdict happened to be comment 3. The
    remainder of the line must be ids and separators ONLY.

    No block in the fixture, for the same reason as the missing-id test: with
    one, both implementations return NO-GO and the arm is blind.

    Breaks if: a non-id remainder is mined for digits (the reason becomes
    "names 3, which is not a live verdict"), or is dropped rather than recorded
    as malformed (this returns GO while its author believes they discharged
    something).
    """
    ok, why = _reduce([_review(2, "APPROVE", supersedes="the round-3 finding")])
    assert not ok
    assert SUP in why, why
    assert "no comment id" in why, why


def test_a_supersession_tolerates_the_hash_and_comma_separators():
    """`SUPERSEDES #1, 3` is the shape a human actually types. Pairs with the
    test above: that one pins what is REFUSED, this one pins that the refusal
    did not swallow the ordinary spelling.

    Breaks if: `#` or `,` is not normalised to a separator -- the line becomes
    malformed and this returns NO-GO.
    """
    ok, why = _reduce([
        _review(1, "REQUEST-CHANGES"),
        _review(3, "REQUEST-CHANGES"),
        _review(2, "APPROVE", supersedes="#1, 3"),
    ])
    assert ok, why


def test_a_supersession_below_the_token_window_still_registers():
    """DELIBERATE, and asserted so a later narrowing is a decision, not a drift.

    `token_window_chars` bounds where a verdict may be ANNOUNCED, because
    announcing is the forgeable direction. The supersession is read off a
    comment that has already announced a live verdict under that strict rule,
    so bounding it too would only make a legitimate discharge silently
    ineffective as a function of header length.

    The fixture asserts its own arithmetic rather than trusting the pad: the
    marker must genuinely start past the window.

    Breaks if: `_supersessions` is narrowed to `body[:window]` -- then the
    block is undischarged and this returns NO-GO.
    """
    comment = _review(2, "APPROVE", supersedes="1", pad="filler. " * 40)
    window = gates.load_policy(
        os.path.join(os.path.dirname(__file__), "..", "policy.json")
    )["verdict_parsing"]["token_window_chars"]
    assert comment["body"].index(SUP) > window, (
        "the pad must push the marker PAST the window, or this test witnesses "
        f"nothing: index={comment['body'].index(SUP)} window={window}"
    )
    ok, why = _reduce([_review(1, "REQUEST-CHANGES"), comment])
    assert ok, why


def test_a_supersession_on_a_comment_that_announces_no_verdict_is_reported():
    """It discharges nothing -- the safe direction -- which is exactly why it
    must not be silent. None of the other near-miss branches fire for a comment
    whose only unusual feature is this line.

    Breaks if: the branch is removed -- `near` comes back empty for comment 5
    and the author's belief that a block was cleared meets no contradiction.
    """
    live, near = gates.parse_verdicts(
        [_c(5, f"Fixed the squash body.\n\n{SUP} 1\n", LATER)], HEAD
    )
    assert live == []
    assert [n.comment_id for n in near] == [5]
    assert SUP in near[0].reason
    assert not near[0].blocks, "an unannounced supersession is not a block"
