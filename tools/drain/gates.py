"""Gates the drain must pass before it may merge or close anything.

PROMOTED FROM `temp/` ON PURPOSE (#4468). The tooling that decides GO/NO-GO for
every merge used to live only in a gitignored scratch directory: one `rm -rf`
and the control that enforced the merge discipline was gone with no history, and
no reviewer could read it. Every "merged on gate GO" claim in the PR history was
a claim about a program nobody could audit.

Each function here is pure over its inputs so it can be unit-tested, and each
ships with a NEGATIVE CONTROL in `__tests__/` -- a fixture that must make it
refuse. A gate never observed failing is not known to watch anything (#4451:
`pass=4 fail=4` printed "UAT-verified roll" across four measurements, with no
observed input for which it returned anything else).

The seven gates of PRP §6 live here, and `merge_gate.py` is the caller that
composes them from live GitHub data. A gate with no caller is prose: before the
first independent review of this module, four of the seven were named in the
spec and implemented nowhere, and five `policy.json` keys were read by nothing.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# Closing-keyword scan
# ---------------------------------------------------------------------------

# ONE regex engine on purpose. Shell `grep -E`, jq's Oniguruma and Python `re`
# disagree on `\b` and escaping; a cross-engine audit once produced OPPOSITE
# answers on the same input (old=3/new=0 in jq, 0/1 in grep).
#
# Keyed to the SHAPE on BOTH halves -- verb + optional colon + reference. Every
# earlier version of this pattern was shape-keyed on the verb and a spelling
# list on the reference, which is how it returned SAFE for three forms GitHub
# acts on. The verb half: a `closes #|fixes #|resolves #` pattern returns ZERO
# on `close #N` (singular) and on `fixed: #N` (past tense + colon), and both of
# those auto-closed a live issue. The reference half: a bare `#` returns ZERO on
# the cross-repo, `GH-` and issue-URL forms, and pasting an issue link after a
# verb is the ordinary way a PR body gets written.
#
# GitHub honours nine verbs and has NO notion of negation: "Does not close #N"
# closes #N.
_VERB = r"(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)"

# The four reference shapes GitHub's parser resolves to an issue.
_REF = (
    r"(?:"
    r"\#"                                                    # #N
    r"|GH-"                                                  # GH-N
    r"|[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\#"                    # owner/repo#N
    r"|https?://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/issues/"  # full URL
    r")"
)

CLOSING_RE = re.compile(
    r"\b" + _VERB + r"\s*:?\s*" + _REF + r"(?P<num>\d+)",
    re.IGNORECASE,
)

# A verb near a reference but not adjacent -- e.g. `fixed in #N`, `fix (#N)`.
# GitHub does not act on these, but they are one edit away from doing so, so the
# scan reports them for a human look rather than passing silently.
#
# The window is 80 chars, not 12. It was 12, which is shorter than this repo's
# own `owner/repo` slug and far shorter than an issue URL -- so the three forms
# the hard pattern missed did not even surface as near-misses, and the gate
# returned a clean bill of health on text that closes an issue.
# The span may not cross a SENTENCE BOUNDARY -- a `.`/`!`/`?` followed by
# whitespace. At a flat 80 chars this matched across ordinary prose ("… we
# cannot fix this until. See #N"), producing near-misses on 7 of 40 real PR
# bodies. A list the reader learns to skim is a gate that has stopped working.
# The rule is keyed to the boundary rather than to a length, so a URL -- whose
# dots are never followed by a space -- still matches.
NEAR_RE = re.compile(
    r"\b" + _VERB + r"(?:(?![.!?]\s)[^\n]){0,80}?" + _REF + r"(?P<num>\d+)",
    re.IGNORECASE,
)


@dataclass
class ClosingScan:
    """Result of scanning one artifact for closing-keyword references."""

    hard: list[int] = field(default_factory=list)
    near: list[int] = field(default_factory=list)

    @property
    def safe(self) -> bool:
        """True only when nothing GitHub's parser would act on is present."""
        return not self.hard


def scan_closing_keywords(text: str) -> ClosingScan:
    """Find issue references GitHub's closing parser would act on.

    Scan the artifact you are about to PUBLISH -- PR body, commit message,
    comment -- not only the one you are reviewing. On 2026-09-11 the comment
    *explaining* this hazard would itself have closed two issues.

    The WHOLE text is scanned, every line of it, and no region is exempt. A
    scan narrowed to the first line survives every single-line fixture while
    missing the real case: the reference that closed an issue on 2026-09-11
    lived in a squash commit's BODY, not its subject. A scan that exempts
    fenced code blocks is the same defect wearing a plausible justification --
    GitHub's parser does not read Markdown.
    """
    hard = [int(m.group("num")) for m in CLOSING_RE.finditer(text)]
    near = [
        int(m.group("num"))
        for m in NEAR_RE.finditer(text)
        if not CLOSING_RE.match(m.group(0))
    ]
    return ClosingScan(hard=hard, near=near)


def merge_is_close_safe(body: str, commit_messages: list[str]) -> ClosingScan:
    """Scan BOTH surfaces a squash merge publishes.

    `closingIssuesReferences` is NOT a complete oracle. Measured 2026-09-11 on
    PR #4369: the field read EMPTY, the body was clean, and the merge closed
    #4361 anyway -- from `fixed: <ref>` in the SYNTHESIZED SQUASH COMMIT. That
    API field reflects the PR body and linked-issue association, never the
    commit trail a squash concatenates.

    EVERY commit message is scanned, not the last one. A squash concatenates
    the whole trail, so the first commit of a ten-commit branch publishes just
    as loudly as the tip.
    """
    merged = scan_closing_keywords(body)
    for message in commit_messages:
        one = scan_closing_keywords(message)
        merged.hard.extend(one.hard)
        merged.near.extend(one.near)
    return merged


# ---------------------------------------------------------------------------
# Verdict parsing
# ---------------------------------------------------------------------------

VERDICT_TOKENS = ("REQUEST-CHANGES", "APPROVE", "CANNOT-ASSESS")
BLOCKING_TOKENS = ("REQUEST-CHANGES", "CANNOT-ASSESS")
MARKERS = ("Independent review", "Independent re-review")

# Which function implements each `merge_gate` key in policy.json. The mapping is
# checked BOTH WAYS by `__tests__/test_policy.py`: a key with no implementation
# is prose wearing a control's clothes, and an implementation with no key is a
# behaviour the authority does not declare.
#
# This exists because ten keys under `merge_gate` and four under
# `verdict_parsing` were read by NO CODE AT ALL -- while this module's own
# docstring described "five policy keys read by nothing" as a repaired past
# defect. Editing the authority changed nothing.
MERGE_GATE_IMPLEMENTED_BY = {
    "mergeable_must_be_known": "merge_gate.run_gates gate 0",
    "base_must_equal_origin_main": "gates.base_is_current",
    "reduce_verdicts_by": "gates.reduce_verdicts",
    "verdict_pinned_to_head": "gates.parse_verdicts (postdates)",
    "require_no_red": "gates.classify_checks (RED_CONCLUSIONS)",
    "require_no_incomplete": "gates.classify_checks (INCOMPLETE_STATUSES)",
    "require_no_skipped_required_context": "gates.required_measured_nothing",
    "scan_closing_keywords_in": "gates.merge_is_close_safe",
    "closing_keyword_scan_blocks_an_undeclared_close": "merge_gate.run_gates gate 6",
    "audit_issue_numbers_around_every_merge": "gates.issue_set_audit",
}
VERDICT_PARSING_IMPLEMENTED_BY = {
    "marker_any_of": "gates.MARKERS / _marker_lines",
    "token_any_of": "gates.VERDICT_TOKENS / _token_of",
    "token_window_chars": "gates.parse_verdicts(window=...)",
    "must_postdate_head_commit": "gates.parse_verdicts (postdates)",
    "note": "prose, deliberately - it explains the three above",
}


# The rest of the file. Everything here is either implemented or DECLARED as
# operator-facing documentation -- the point being that the distinction is
# written down and checked, rather than left for the next reader to discover by
# grepping. Eleven keys outside the two sections above were read by nothing.
OTHER_IMPLEMENTED_BY = {
    "repo": "tick.read_live_issues / build_inventory.read_issues",
    "wip.max_lanes": "tick.select_cycle",
    "wip.max_lanes_hard_ceiling": "tick.select_cycle",
    "ordering.streams": "tick.select_cycle",
    "receipts": "ledger.Ledger.receipt_ok",
    "scope.closed_requires_receipt": "ledger.Ledger.receipt_ok",
    "permitted_unattended": "gates.action_is_permitted",
    "never": "gates.action_is_permitted",
    "stop_and_ask": "gates.action_is_permitted",
}
# Keys that are DELIBERATELY prose: they address the operator, not the program.
# Listing them is the point -- an undeclared unconsulted key is indistinguishable
# from a control that stopped working.
OPERATOR_DOCUMENTATION = {
    "schema",
    "scope.target", "scope.definition_of_done",
    "wip.serialize_on_shared_checkout",
    "ordering.W9_runs_continuously", "ordering.W9_reason",
    "stop_conditions.deploy_path_red",
    "stop_conditions.estate_behind_and_not_recovering",
    "stop_conditions.gate_tooling_untracked",
    "stop_conditions.consecutive_cycle_failures",
}


def policy_keys_without_implementation(policy: dict) -> list[str]:
    """Every key in the policy that no function consults and no list excuses.

    An unconsulted policy key is prose, not a control. Keys starting with `_`
    are documentation by convention and are exempt; everything else must appear
    in an `*_IMPLEMENTED_BY` mapping or in `OPERATOR_DOCUMENTATION`, which is
    how "this one addresses the operator" stops being an unwritten assumption.
    """
    sectioned = {
        "merge_gate": MERGE_GATE_IMPLEMENTED_BY,
        "verdict_parsing": VERDICT_PARSING_IMPLEMENTED_BY,
    }
    missing = []
    for key, value in policy.items():
        if key.startswith("_"):
            continue
        if key in sectioned:
            for sub in value:
                if not sub.startswith("_") and sub not in sectioned[key]:
                    missing.append(f"{key}.{sub}")
            continue
        if key in OTHER_IMPLEMENTED_BY or key in OPERATOR_DOCUMENTATION:
            continue
        if isinstance(value, dict):
            for sub in value:
                dotted = f"{key}.{sub}"
                if (not sub.startswith("_")
                        and dotted not in OTHER_IMPLEMENTED_BY
                        and dotted not in OPERATOR_DOCUMENTATION):
                    missing.append(dotted)
            continue
        missing.append(key)
    return sorted(missing)


def assert_policy_matches_code(policy: dict) -> None:
    """Both directions, and the implementation must RESOLVE.

    Key-set equality alone is not evidence of implementation: a mapping value of
    `"gates.there_is_no_such_function"` satisfied it, which is the same defect
    one level up -- a contract that looks like a control and checks a spelling.
    Every value names a real callable, and this resolves it.
    """
    missing = policy_keys_without_implementation(policy)
    if missing:
        raise ValueError(f"policy keys with no implementation: {missing}")
    for section, mapping in (
        ("merge_gate", MERGE_GATE_IMPLEMENTED_BY),
        ("verdict_parsing", VERDICT_PARSING_IMPLEMENTED_BY),
    ):
        undeclared = sorted(set(mapping) - set(policy.get(section, {})))
        if undeclared:
            raise ValueError(
                f"{section}: implemented but not declared in policy.json: {undeclared}"
            )
    # ALL THREE mappings, not only the two sectioned ones -- `OTHER_IMPLEMENTED_BY`
    # was exempt from resolution and carries dotted attribute paths
    # (`ledger.Ledger.receipt_ok`) that the first version of `_unresolved` could
    # not walk, so it would have rejected true entries and accepted false ones.
    for label, mapping in (
        ("merge_gate", MERGE_GATE_IMPLEMENTED_BY),
        ("verdict_parsing", VERDICT_PARSING_IMPLEMENTED_BY),
        ("other", OTHER_IMPLEMENTED_BY),
    ):
        for key, where in mapping.items():
            unresolved = _unresolved(where)
            if unresolved:
                raise ValueError(
                    f"{label}.{key} names {unresolved!r}, which is not a callable in "
                    "this package - the mapping is a spelling, not an implementation"
                )
    # A key in BOTH lists is silenced by the allow-list while a real function
    # still reads it, which is the allow-list becoming an off switch.
    both = sorted(set(OTHER_IMPLEMENTED_BY) & OPERATOR_DOCUMENTATION)
    if both:
        raise ValueError(
            f"declared as operator documentation AND as implemented: {both} - "
            "a key cannot be both prose and a control"
        )


def _unresolved(where: str) -> str | None:
    """Return the dotted name in `where` that does not resolve, or None.

    `where` is free text naming a function, e.g.
    `"gates.classify_checks (RED_CONCLUSIONS)"` or `"merge_gate.run_gates gate 0"`.
    The FIRST dotted token is the claim; anything after it is commentary. A value
    with no dotted token at all is prose and is allowed only when it says so.
    """
    import importlib

    token = next((t for t in where.replace("(", " ").split() if "." in t), None)
    if token is None:
        return None if where.startswith("prose") else where
    parts = token.split("(")[0].rstrip(",.").split(".")
    try:
        target = importlib.import_module(parts[0])
    except ImportError:
        return token
    # WALK the dotted path. `ledger.Ledger.receipt_ok` is a method on a class,
    # and a resolver that only did module.attr would reject a true entry.
    for part in parts[1:]:
        target = getattr(target, part, None)
        if target is None:
            return token
    return None if callable(target) or isinstance(target, (tuple, list, frozenset)) else token

# Near-miss kinds. `blocks` is decided at parse time, not by the reducer.
NEAR_NO_MARKER = "no-marker"
NEAR_NO_TOKEN = "no-token"
NEAR_PREDATES_HEAD = "predates-head"
NEAR_TEMPLATE = "template-line"
NEAR_UNPINNABLE = "head-date-unknown"
NEAR_CITED = "cited-not-decided"
# A verdict header that IS in prose, but is not the comment's first line -- it
# may be below the window, or merely below a preamble. The old name said
# "below-the-window" and was wrong for the second case, which is an R7 error in
# a message: it asserted a cause the code had not established.
NEAR_NOT_FIRST = "not-the-first-line"


@dataclass
class Verdict:
    """One parsed review verdict, pinned to the head it measured."""

    token: str
    created_at: str
    comment_id: int


@dataclass
class NearMiss:
    """A comment that ALMOST registered, why it did not, and whether it blocks.

    Silence is the enemy here. Before this existed the gate printed only
    "no live APPROVE", which is indistinguishable between "nobody reviewed
    this" and "somebody reviewed it and I could not parse them". A sound
    APPROVE was discarded for reading "Re-review" instead of "Independent
    re-review", and two blocking verdicts were discarded for writing
    "CHANGES REQUIRED" instead of the literal token -- invisible for two
    rounds.

    Reporting a near-miss to a caller that does not consult it is the same
    silence with extra steps, so `blocks` is set here and `reduce_verdicts`
    is required to take it: an unparseable review AT HEAD is NO-GO, because
    the one thing it is not is an approval.
    """

    comment_id: int
    created_at: str
    reason: str
    kind: str = NEAR_NO_TOKEN
    blocks: bool = False


def parse_verdicts(
    comments: list[dict], head_date: str | None, window: int = 200
) -> tuple[list[Verdict], list[NearMiss]]:
    """Parse issue comments into live verdicts plus explained near-misses.

    Three conjunctive conditions: a marker anywhere in the body, a verdict token
    inside the first `window` characters, and a timestamp at or after the head
    commit. Tokens are checked in VERDICT_TOKENS order deliberately -- scanning
    the whole body would read "the previous REQUEST-CHANGES is addressed" as a
    fresh block, inverting the decision.

    EVERY comment is parsed. Narrowing the population to the most recent one --
    a filter placed before the check rather than in it -- silently reinstates
    the recency semantics `reduce_verdicts` exists to refuse, and is invisible
    to any fixture that passes a single comment.

    `head_date` is REQUIRED to be non-empty. A caller that could not resolve
    the head commit's date cannot pin anything, and an unpinned verdict is a
    measurement of some other diff; every comment becomes a blocking near-miss
    rather than silently registering.
    """
    live: list[Verdict] = []
    near: list[NearMiss] = []

    for comment in comments:
        body = comment.get("body") or ""
        cid = comment.get("id", 0)
        when = comment.get("created_at", "")
        head = body[:window]
        postdates = bool(head_date) and when >= head_date

        token, saw_template = _token_of(head)
        # `has_marker` is now "this comment ANNOUNCES a verdict in the window",
        # not "the word appears somewhere in the body". Scanning the whole body
        # let a quoted header from a previous round decide the gate.
        has_marker = bool(_marker_lines(head))
        # ... but a comment that carries a TOKEN in the window without a
        # well-formed marker line must still be reported, never dropped. That is
        # the recorded miss: a sound verdict headed "Re-review" instead of
        # "Independent re-review" was discarded, and the gate said only "no live
        # APPROVE" -- three runs to diagnose.
        # A BLOCKING token anywhere in the window, in ANY context -- quoted,
        # fenced, indented, collapsed. Formatting may refuse to grant an
        # approval; it must NEVER reduce a block.
        #
        # Measured regression, round 4 -> round 5: once a citation became
        # non-blocking, two inputs that had been NO-GO went GO. A reviewer who
        # pasted a failing log in a fence, forgot to close it, then wrote their
        # REQUEST-CHANGES header had their block demoted to advisory; and a
        # citation anywhere in the window suppressed the blocking report for a
        # real token in prose below it. An unclosed fence is an ordinary typo,
        # and the consequence was that a genuine block silently stopped
        # blocking. The two directions are NOT symmetric and are no longer
        # decided by the same test.
        lines = head.splitlines()
        blocking_mention = any(
            any(t in ln for t in BLOCKING_TOKENS)
            and not all(t in ln for t in VERDICT_TOKENS)  # not the template line
            for ln in lines
        )
        mentions_token = any(
            any(t in ln for t in VERDICT_TOKENS)
            and not all(t in ln for t in VERDICT_TOKENS)
            for ln in lines
        )
        # A marker line that is CITED, or one that sits past the window. Neither
        # is a decision, and both used to vanish without a trace -- `live=[]`,
        # `near=[]`, nothing in the evidence line at all.
        cited = _cited_marker_lines(head)
        out_of_window = bool(
            [ln for ln, prose in classify_lines(body) if prose and _announces(ln)]
        ) and not _marker_lines(head)

        if not head_date:
            if has_marker or token or saw_template or mentions_token or cited:
                near.append(
                    NearMiss(cid, when, "head commit date unknown - verdict cannot be pinned",
                             NEAR_UNPINNABLE, blocks=True)
                )
            continue

        # EVERY near-miss that blocks is PINNED TO HEAD, exactly like a parsed
        # verdict. Unpinned, a 2020 comment from anyone that happened to contain
        # a blocking token made the PR permanently unmergeable -- no push could
        # discharge it, because the comment does not move when the diff does.
        # That made unparseable stale text STRONGER than a parseable stale
        # block, inverting the module's own pinning rule.
        if token is None:
            if saw_template:
                near.append(
                    NearMiss(cid, when, "carries the verdict TEMPLATE line, not a decision",
                             NEAR_TEMPLATE, blocks=(has_marker or mentions_token) and postdates)
                )
            elif has_marker:
                near.append(
                    NearMiss(cid, when, f"marker line, but no token on it in body[:{window}]",
                             NEAR_NO_TOKEN, blocks=postdates)
                )
            elif blocking_mention:
                # FIRST, before any citation reporting. Tested before `cited`
                # on purpose: a citation anywhere in the window used to
                # suppress the blocking report for a real token in prose below
                # it, which is formatting reducing a block.
                near.append(
                    NearMiss(cid, when,
                             f"a BLOCKING token appears in body[:{window}] with no line "
                             "announcing a verdict - formatting never reduces a block, so "
                             "this blocks. Announce it on the comment's FIRST line, or "
                             "reference the token instead of writing it",
                             NEAR_NO_MARKER, blocks=postdates)
                )
            elif cited:
                near.append(
                    NearMiss(cid, when,
                             f"{len(cited)} verdict header(s) CITED here (quoted, fenced, "
                             "indented or collapsed) - a citation is not a decision, but it "
                             "is recorded so a relayed verdict is not invisible",
                             NEAR_CITED, blocks=False)
                )
            elif out_of_window:
                near.append(
                    NearMiss(cid, when,
                             "a verdict header appears in prose but is NOT the comment's "
                             f"first line (it may also be below body[:{window}]) - a verdict "
                             "is announced first or it does not register",
                             NEAR_NOT_FIRST, blocks=False)
                )
            elif mentions_token:
                # A NON-blocking token with no line announcing it. Reported --
                # the recorded miss is a sound verdict headed "Re-review" being
                # dropped in silence -- but it does not block, because the one
                # thing an unannounced APPROVE is not is a block. The blocking
                # case was handled above, before any citation reporting.
                near.append(
                    NearMiss(cid, when,
                             f"a verdict token appears in body[:{window}] but no line announces "
                             f"it - the announcing line must be the comment's FIRST line and "
                             f"begin with one of {MARKERS}",
                             NEAR_NO_MARKER, blocks=False)
                )
            continue
        if not postdates:
            near.append(
                NearMiss(cid, when, f"marker and {token} present, but predates head {head_date}",
                         NEAR_PREDATES_HEAD, blocks=False)
            )
            continue
        live.append(Verdict(token=token, created_at=when, comment_id=cid))

    return live, near


FENCES = ("```", "~~~")


def _is_quoted(line: str) -> bool:
    """A Markdown blockquote. A quoted verdict is a CITATION, never a decision."""
    return line.lstrip().startswith(">")


def classify_lines(head: str) -> list[tuple[str, bool]]:
    """(line, is_prose) for every line in the window.

    "Prose" means the line is the author SPEAKING, as opposed to CITING. Three
    successive reviews of this function each found the previous enumeration one
    idiom deep, so the rule is now stated over the whole set of ways Markdown
    marks text as not-prose, and every one of them is a measured bypass:

    - **blockquote** (`>`, nested or indented) -- a coordinator comment reading
      "do NOT merge on this" scored GO because it quoted a previous round.
    - **fenced code** (``` / ~~~) -- relaying agent output in a fence is how
      this program moves verdicts around, and `KICKOFF.md` is itself a fenced
      paste-this block.
    - **indented code** (4+ spaces) -- and note the old strip set `"#*_> \\t"`
      removed the very spaces that MAKE it a code block, so it read as a header.
    - **`<details>`** -- the standard way to collapse a superseded review. This
      PR is carrying five.
    - **HTML comment** -- invisible when rendered; a verdict nobody can see.

    Each one produced a live APPROVE with zero blocking near-misses, which is
    exactly what the verdict gate needs to record GO.
    """
    out: list[tuple[str, bool]] = []
    fence: str | None = None      # the OPENING delimiter, not a boolean
    details = 0
    in_comment = False
    for line in head.splitlines():
        bare = line.strip()
        lowered = bare.lower()
        opens_comment = bare.startswith("<!--") and "-->" not in bare

        if fence is not None:
            # Only a run of the SAME character, at least as long and carrying no
            # info string, closes a fence. A boolean toggled by "any line that
            # looks like a fence" was flipped back to prose by a nested ```` ```python ````
            # or a `~~~` inside a ``` block -- and relayed agent output routinely
            # carries its own fences.
            char = fence[0]
            closes = bare and set(bare) == {char} and len(bare) >= len(fence)
            out.append((line, False))
            if closes:
                fence = None
            continue
        opener = next((f for f in FENCES if bare.startswith(f)), None)
        if opener:
            fence = bare[: len(bare) - len(bare.lstrip(opener[0]))]
            out.append((line, False))
            continue

        if lowered.startswith("<details"):
            # A ONE-LINE <details>...</details> is balanced. Counting only the
            # opener left the depth at 1 for the rest of the window on a
            # construct that renders perfectly on GitHub.
            if "</details" not in lowered:
                details += 1
            out.append((line, False))
            continue
        if lowered.startswith("</details"):
            details = max(0, details - 1)
            out.append((line, False))
            continue

        # INDENT IS MEASURED IN TABS TOO. `len(line) - len(line.lstrip(" "))`
        # counts spaces only, while `_announces` strips "#*_ \t" -- so the tab
        # that MAKES a line a code block was removed by the matcher and never
        # seen by the classifier. Same citation, spelled the other way.
        indent = len(line.expandtabs(4)) - len(line.expandtabs(4).lstrip(" "))
        prose = (
            not in_comment
            and details == 0
            and not _is_quoted(line)
            and indent < 4
        )
        out.append((line, prose))
        if opens_comment:
            in_comment = True
        elif in_comment and "-->" in bare:
            in_comment = False
    return out


def _announces(line: str) -> bool:
    """Does this line BEGIN with a marker, rather than mention one?

    "For context, the earlier Independent review - APPROVE was measured at a
    different head" mentions one; it is a sentence ABOUT a verdict, and reading
    it as one inverted a block into an approval.
    """
    return any(line.lstrip("#*_ \t").startswith(m) for m in MARKERS)


def _marker_lines(head: str) -> list[str]:
    """The ONE line that may announce a verdict: the comment's first, if it does.

    POSITION, NOT IDIOM -- and this is the point of the whole function.

    Three rounds running, the rule was "a marker line that is not <the idioms I
    have thought of>", and each round an independent reviewer found the next
    idiom: first a blockquote, then fenced / indented / `<details>` / HTML
    comment, then a TAB indent and a nested fence delimiter that flipped the
    state machine back to prose. Re-implementing a Markdown block parser over a
    200-character prefix is the wrong shape for a control this load-bearing:
    every version is one idiom from being wrong, and the failure is silent.

    So the approval direction is decided by POSITION instead, which no idiom can
    forge: the announcing line must be the FIRST NON-EMPTY LINE of the comment,
    at indent zero. Every bypass found so far fails that test with no state
    machine at all -- a fenced relay's first line is the fence, a tab-indented
    one is indented, a collapsed one starts with `<details>`.

    A line opening a blockquote, an HTML block or a code fence needs no separate
    test: `>`, `<`, a backtick and a tilde are deliberately NOT in `_announces`'
    strip set, so such a line can never begin with a marker. An explicit prefix
    check here was redundant -- there was no input for which it changed the
    answer, and an arm removing it could not be killed, which is the tell.

    It is deliberately strict. A reviewer who writes a preamble before their
    header does not register, and is TOLD so (`NEAR_NO_MARKER`). Refusing to
    read an ambiguous approval is the safe direction; refusing to read an
    ambiguous BLOCK is not, which is why `parse_verdicts` tests for a blocking
    token BEFORE it considers any of this.
    """
    for line in head.splitlines():
        if not line.strip():
            continue
        if line[:1] in (" ", "\t"):
            return []          # an indented first line is a code block
        return [line] if _announces(line) else []
    return []


def _cited_marker_lines(head: str) -> list[str]:
    """Marker lines that are CITED -- quoted, fenced, indented or collapsed.

    Reported, never acted on. A quoted verdict used to produce no verdict AND no
    near-miss: `live=[] near=[]`, nothing printed at all, so a relayed block was
    invisible in the evidence line while a genuine approval beside it decided
    the merge. Conjunction defeated by formatting rather than by content, which
    is the silence `NearMiss` exists to end.
    """
    return [ln for ln, prose in classify_lines(head) if not prose and _announces(ln.lstrip("> \t"))]


def _saw_template(head: str) -> bool:
    """Did any unquoted line in the window list ALL THREE tokens?

    Scanned over the whole window rather than over marker lines only: the
    template usually sits a line or two BELOW the header, so a scan restricted
    to marker lines never saw it and reported the comment as "marker, no token"
    -- true, but it buries the actual cause under a spelling hint.
    """
    return any(
        prose and all(t in ln for t in VERDICT_TOKENS)
        for ln, prose in classify_lines(head)
    )


def _token_of(head: str) -> tuple[str | None, bool]:
    """Find this comment's verdict token, and whether a template line was seen.

    Line-oriented, and ONLY a qualifying marker line decides (see
    `_marker_lines`) -- that is where a reviewer writes the decision
    (`## Independent review - APPROVE`). There is deliberately NO fallback to a
    flat scan of the window: a flat scan reads the first token in
    `VERDICT_TOKENS` order anywhere in that window, so an approving review whose
    prose mentioned the other spellings registered as a block.

    A line carrying ALL THREE tokens is the review TEMPLATE -- an instruction to
    the reviewer, not a decision -- and is skipped rather than read in order. It
    is reported, so a reviewer who pasted the template and wrote nothing else
    does not pass silently.

    Within one marker line the tokens are still read in `VERDICT_TOKENS` order,
    so a header that hedges ("APPROVE, but REQUEST-CHANGES on the second half")
    resolves to the block.
    """
    saw_template = _saw_template(head)
    for line in _marker_lines(head):
        if all(t in line for t in VERDICT_TOKENS):
            continue
        token = next((t for t in VERDICT_TOKENS if t in line), None)
        if token:
            return token, saw_template
    return None, saw_template


def reduce_verdicts(live: list[Verdict], near: list[NearMiss] | None = None) -> tuple[bool, str]:
    """Decide GO/NO-GO from live verdicts by CONJUNCTION, not recency.

    A later APPROVE does NOT discharge an earlier block. Reduce by conjunction:
    any live blocking verdict blocks, regardless of what came after it.

    Blocking NEAR-MISSES are part of the conjunction. A reviewer who wrote
    "CHANGES REQUIRED" instead of the literal token, at head, has blocked this
    PR; a reducer that only reads the parsed set returns GO for the PR they
    blocked. That is the exact 2026-09-11 incident, and reporting the near-miss
    to nobody did not fix it.
    """
    blocking_near = [n for n in (near or []) if n.blocks]
    if blocking_near:
        reasons = "; ".join(f"#{n.comment_id} {n.reason}" for n in blocking_near[:3])
        return False, f"unparseable review at head ({len(blocking_near)}): {reasons}"
    if any(v.token == "REQUEST-CHANGES" for v in live):
        return False, "live REQUEST-CHANGES"
    if any(v.token == "CANNOT-ASSESS" for v in live):
        return False, "live CANNOT-ASSESS"
    if not any(v.token == "APPROVE" for v in live):
        return False, "no live APPROVE at head"
    return True, "live APPROVE, zero live blocking verdicts"


# ---------------------------------------------------------------------------
# Check-run interpretation
# ---------------------------------------------------------------------------

# Bad outcomes, in BOTH GitHub vocabularies. `statusCheckRollup` returns two
# shapes: a CheckRun (`name`/`status`/`conclusion`) and a StatusContext
# (`context`/`state`). Their words differ -- a StatusContext says `ERROR` where a
# CheckRun says `FAILURE`, and `PENDING` where a CheckRun says `IN_PROGRESS` --
# so a set built from one vocabulary silently passes the other. `ERROR` and
# `EXPECTED` were missing and a StatusContext carrying them read GREEN.
RED_CONCLUSIONS = frozenset(
    {"FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE",
     "ERROR"}
)
# Not finished. A required context that has not concluded is INCOMPLETE, never a
# pass. `EXPECTED` is a StatusContext that has been announced and never
# reported -- the check-run equivalent of never-created.
INCOMPLETE_STATUSES = frozenset(
    {"QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED", "EXPECTED"}
)


def classify_missing(total_count: int, waiting: bool) -> str:
    """Distinguish the two states that BOTH present as a missing required check.

    Measured 2026-09-11: a commit pushed while its PR was CONFLICTING got ZERO
    check-runs, permanently -- GitHub cannot compute `refs/pull/N/merge`, so
    `pull_request` workflows are never created, and clearing the conflict
    afterwards does not create them retroactively.

    That looks identical to a run parked on an environment approval gate. The
    remedies are OPPOSITE: approving a parked run is right; "approving" the
    other is a no-op, and `--admin`-ing past it ships code CI never saw.
    """
    if total_count == 0:
        return "never-created"
    if waiting:
        return "parked"
    return "present"


def classify_checks(checks: list[dict], required: list[str]) -> tuple[bool, list[str]]:
    """PRP §6 gate 4: every required context present, none RED, none INCOMPLETE.

    `checks` are dicts carrying at least `name`; `conclusion` and `status` are
    read with either GitHub shape. `statusCheckRollup` returns TWO shapes -- a
    CheckRun (`name`/`conclusion`/`status`) and a StatusContext
    (`context`/`state`) -- and a reader that knows only one is blind to every
    context published by the other.

    Returns (ok, reasons). `ok` is True only when every required context is
    present and concluded green; the reasons list every failure, because a
    caller that stops at the first one re-runs this loop once per defect.
    """
    by_name: dict[str, dict] = {}
    for check in checks:
        name = check.get("name") or check.get("context") or ""
        if not name:
            continue
        # Two runs can share a context name; the worst one decides.
        prior = by_name.get(name)
        if prior is None or _check_rank(check) > _check_rank(prior):
            by_name[name] = check

    reasons: list[str] = []
    for name in required:
        check = by_name.get(name)
        if check is None:
            reasons.append(f"{name}: MISSING (no check-run published this context)")
            continue
        verdict, status = _outcome(check)
        if verdict in RED_CONCLUSIONS:
            reasons.append(f"{name}: RED ({verdict})")
        elif not verdict or verdict in INCOMPLETE_STATUSES or status in INCOMPLETE_STATUSES:
            reasons.append(f"{name}: INCOMPLETE (state={verdict or status or 'unknown'})")
    return (not reasons), reasons


def _outcome(check: dict) -> tuple[str, str]:
    """(verdict, status) from EITHER rollup shape, upper-cased.

    A StatusContext has no `status` key at all, so a reader that tests
    completeness against `status` alone can never see a PENDING one -- it falls
    through every branch and is scored green. Both values are returned and BOTH
    sets are consulted against BOTH.
    """
    return (
        (check.get("conclusion") or check.get("state") or "").upper(),
        (check.get("status") or "").upper(),
    )


def _check_rank(check: dict) -> int:
    """Worst-first ranking, so a duplicated context is judged by its worst run.

    SKIPPED ranks strictly worse than SUCCESS. It used to tie, which made the
    de-duplication ORDER-DEPENDENT: with one required context published twice,
    `['SUCCESS', 'SKIPPED']` scored GO and `['SKIPPED', 'SUCCESS']` scored NO-GO
    on the same commit. That is not hypothetical here -- 9 of 25 recent PRs
    publish a duplicated context name, and on this very PR the duplicate is a
    REQUIRED one. A green twin must never hide a run that measured nothing.
    """
    verdict, status = _outcome(check)
    if verdict in RED_CONCLUSIONS:
        return 4
    if not verdict or verdict in INCOMPLETE_STATUSES or status in INCOMPLETE_STATUSES:
        return 3
    if verdict == "SKIPPED":
        return 2
    return 1


def required_measured_nothing(checks: list[dict], required: list[str]) -> tuple[bool, list[str]]:
    """PRP §6 gate 5, over ONLY what `statusCheckRollup` actually exposes.

    Stated plainly, because the previous version of this gate overstated itself:
    **the rollup API carries no per-check population.** Its entries are
    `__typename, completedAt, conclusion, detailsUrl, name, startedAt, status,
    workflowName` -- measured, not assumed. So `check_is_hollow(..., measured=None)`
    is the only branch reachable from live data, and a caller that then discards
    every `None` has a gate that can only ever see SKIPPED.

    What this DOES detect is a required context that concluded SKIPPED: it ran
    nothing, and a required gate that ran nothing is not a pass. Detecting the
    #4451 shape -- green over `pass=0 fail=4` -- needs a population source this
    API does not have, so that remains an owed capability rather than a claim.
    Returns (ok, reasons).
    """
    worst: dict[str, dict] = {}
    for check in checks:
        name = check.get("name") or check.get("context") or ""
        if name in required and (name not in worst or _check_rank(check) > _check_rank(worst[name])):
            worst[name] = check
    reasons = [
        f"{name}: SKIPPED - a required context that ran nothing is not a pass"
        for name, check in sorted(worst.items())
        if _outcome(check)[0] == "SKIPPED"
    ]
    return (not reasons), reasons


def check_is_hollow(name: str, conclusion: str, measured: int | None) -> tuple[bool, str]:
    """Did this check MEASURE anything, or pass over zero files?

    Used wherever a population IS available (a test count, a lint file count, a
    UAT pass/fail pair). It is NOT reachable from `statusCheckRollup`, which
    publishes no population -- see `required_measured_nothing`.

    #4451 is the standing example -- `pass=0 fail=4` printed "UAT-verified
    roll", four separate measurements, no observed input for which it returned
    anything else. A green check over an empty population is not evidence; it
    is the absence of evidence wearing evidence's colour.

    `measured` is the population the check reported (files linted, tests run,
    rows scanned). `None` means the check does not report one -- which is NOT
    a pass: it is an unanswerable question, and the caller is told so.
    """
    verdict = (conclusion or "").upper()
    if verdict == "SKIPPED":
        return True, f"{name}: SKIPPED - measured nothing; justify the skip or widen the filter"
    if verdict != "SUCCESS":
        return False, f"{name}: not green, hollowness is not the question"
    if measured is None:
        return True, f"{name}: green but reports no population - cannot assert it measured anything"
    if measured == 0:
        return True, f"{name}: green over ZERO items - a pass with no population"
    return False, f"{name}: green over {measured} item(s)"


# ---------------------------------------------------------------------------
# Base currency and the issue-count audit
# ---------------------------------------------------------------------------


def base_is_current(
    base_ref: str, base_sha: str, origin_main_sha: str, expected_base: str = "main"
) -> tuple[bool, str]:
    """PRP §6 gate 1: base == `origin/main`, exactly.

    Both halves matter. A PR targeting some other branch merges into something
    that is not the trunk; a PR targeting main from a stale base was measured
    against a tree that no longer exists, and every green check on it is a
    statement about that older tree.
    """
    if base_ref != expected_base:
        return False, f"base is {base_ref!r}, not {expected_base!r}"
    if not base_sha or not origin_main_sha:
        return False, "cannot resolve base or origin/main sha - unmeasurable, not a pass"
    if base_sha != origin_main_sha:
        return False, f"base {base_sha[:12]} != origin/{expected_base} {origin_main_sha[:12]}"
    return True, f"base == origin/{expected_base} @ {base_sha[:12]}"


def issue_set_audit(
    before: list[int] | set[int], after: list[int] | set[int], intended: list[int]
) -> tuple[bool, str]:
    """PRP §6 gate 7, on the SETS rather than on their sizes.

    The count version passes a SET SWAP: `before=297, after=296, intended=[N]`
    reads clean even when the issue that actually left was a different one and
    something else opened concurrently. On this repo concurrent movement is the
    normal case -- release-please opens issues, and merges auto-close unclaimed
    ones -- so the two errors cancel and the audit reports OK over exactly the
    silent-close it exists to catch.

    The caller already holds both number lists; comparing them costs nothing
    extra and is strictly stronger.
    """
    before_set, after_set, want = set(before), set(after), set(intended)
    departed = before_set - after_set
    arrived = after_set - before_set
    if departed == want:
        note = f"{len(departed)} issue(s) closed, exactly the intended set {sorted(want)}"
        if arrived:
            note += f"; {len(arrived)} opened concurrently {sorted(arrived)} (not a finding)"
        return True, note
    unexpected = sorted(departed - want)
    missing = sorted(want - departed)
    parts = []
    if unexpected:
        parts.append(f"{len(unexpected)} issue(s) closed that nobody chose: {unexpected}")
    if missing:
        parts.append(f"{len(missing)} issue(s) meant to close did not: {missing}")
    if arrived:
        parts.append(f"(also {len(arrived)} opened concurrently: {sorted(arrived)})")
    return False, "; ".join(parts)


def issue_count_audit(before: int, after: int, intended: list[int]) -> tuple[bool, str]:
    """PRP §6 gate 7: the before/after open-issue count around every merge.

    The scan (`merge_is_close_safe`) is PREVENTION and the count is DETECTION,
    and the count has caught what the strongest API oracle did not:
    `closingIssuesReferences` read EMPTY while a squash commit closed #4361.

    A delta larger than intended means something closed that nobody chose. A
    delta SMALLER is equally a finding -- an issue the merge was supposed to
    close did not, and the backlog now lies in the other direction.
    """
    delta = before - after
    want = len(intended)
    if delta == want:
        return True, f"open issues {before} -> {after}; delta {delta} == intended {want}"
    if delta > want:
        return False, (
            f"open issues {before} -> {after}; delta {delta} EXCEEDS intended {want} "
            f"({intended}) - {delta - want} issue(s) closed that nobody chose"
        )
    return False, (
        f"open issues {before} -> {after}; delta {delta} is SHORT of intended {want} "
        f"({intended}) - an issue meant to close did not"
    )


def receipt_satisfies(issue_class: str, receipt_kind: str, policy: dict) -> bool:
    """True when this receipt kind closes this class of issue."""
    required = policy.get("receipts", {}).get(issue_class)
    return bool(required) and required == receipt_kind


def load_policy(path: str = "tools/drain/policy.json") -> dict:
    """Read the autonomy contract. The file is the authority, not this module."""
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def action_is_permitted(action: str, policy: dict) -> tuple[bool, str]:
    """Check an action against the autonomy contract.

    Fails CLOSED: an action that appears in neither list is refused, so adding a
    new capability is a deliberate edit to policy.json rather than an emergent
    behaviour.

    Matching is EXACT and never by prefix. `merge-on-gate-go` is permitted;
    `merge-without-review` is a different action and must be refused, and any
    fast path keyed on a shared prefix turns one permission into a family.
    """
    if action in policy.get("never", []):
        return False, "NEVER: refused unconditionally"
    stop = policy.get("stop_and_ask", {})
    if action in stop and not action.startswith("_"):
        return False, f"STOP AND ASK: {stop[action]}"
    if action in policy.get("permitted_unattended", []):
        return True, "permitted unattended"
    return False, "not in permitted_unattended - fails closed, add it to policy.json deliberately"


def stop_and_ask_actions(policy: dict) -> list[str]:
    """The stop-and-ask action names, without the `_` documentation key.

    The raw dict carries a `"_"` key holding the rationale prose. Emitting it
    into a brief prints `Stop and ask for: _, add_trivyignore_entry, ...`,
    which reads as a parsing bug and teaches the reader to skim the line.
    """
    return sorted(k for k in policy.get("stop_and_ask", {}) if not k.startswith("_"))
