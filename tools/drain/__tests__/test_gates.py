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


def test_every_red_conclusion_blocks_the_advisory_path_not_just_FAILURE():
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

    WHAT MAKES EACH ARM FAIL: removing that conclusion from `RED_CONCLUSIONS`,
    or narrowing the branch to a literal subset. Each is checked on its own so a
    single surviving member cannot hide behind the others.
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
        assert "the NEWEST CONCLUDED run at this head was FAILURE" in why
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
        assert "the NEWEST CONCLUDED run at this head was FAILURE" in why
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
    `_newest_concluded`'s undated fallback -- though it IS reached, and can
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


def test_newest_concluded_falls_back_to_worst_wins_on_an_unreadable_timestamp():
    """`_newest_concluded` DIRECTLY, on a branch the gate genuinely takes.

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
        chosen = gates._newest_concluded(runs)
        assert chosen is not None
        assert chosen["conclusion"] == "FAILURE", f"order {order} picked {chosen}"


def test_newest_concluded_is_none_when_nothing_has_concluded():
    """The first-run-of-a-check case: every run is still in flight, so there is
    no previous answer to carry. It must be ADV-WAIT, never ADV-RERUN.

    Breaks if: an in-flight run is counted as concluded -- `_newest_concluded`
    would return it, and `_outcome` of an IN_PROGRESS run is not in
    RED_CONCLUSIONS, so the bug would be silent here and show up as a wrong
    NAME somewhere else. The classifier assertion below is the one with teeth."""
    runs = [{"name": "H", "conclusion": None, "status": "IN_PROGRESS"},
            {"name": "H", "conclusion": None, "status": "QUEUED"}]
    assert gates._newest_concluded(runs) is None

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
    read 2, not 5) or `population` counts required contexts (it would read 5)."""
    checks = [_run(n, "SUCCESS") for n in REQUIRED] + [
        _adv("CodeQL", "SUCCESS"),
        _adv("Checkov", "FAILURE"),
    ]
    split = gates.classify_advisory_checks(checks, REQUIRED)
    assert split.total_checks == 5
    assert split.population == 2
    assert split.red == ["Checkov (FAILURE)"]
    assert split.clean == ["CodeQL"]
    assert split.rerun == []


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
