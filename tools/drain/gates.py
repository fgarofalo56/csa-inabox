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

PRP §6's gates live here, and `merge_gate.py` is the caller that
composes them from live GitHub data. A gate with no caller is prose: before the
first independent review of this module, four of them were named in the
spec and implemented nowhere, and five `policy.json` keys were read by nothing.
"""
from __future__ import annotations

import datetime as _dt
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


#: Any issue reference at all, with NO closing verb required.
#:
#: NARROWER than `_REF` on purpose, and the narrowing is the whole design. A
#: verb-anchored scan can afford a loose reference alphabet, because the verb
#: does the discriminating. Without a verb, `#\d+` alone matched a hex colour
#: (`#1f2937` -> 1), a Markdown heading anchor (`[x](#42-the-section)` -> 42),
#: and a foreign repo's issue (`astral-sh/ruff#12345`), all measured. So:
#:
#: - `#N` must not be preceded by a word character or `-` (kills `#1f2937`'s
#:   tail, `GH-1` double-matching) and must not be followed by `-` or a letter
#:   (kills the heading anchor).
#: - `owner/repo#N` and the issue URL are handled SEPARATELY, because they must
#:   be checked against `policy["repo"]` -- another repo's numbers are a
#:   different population, and resolving them against this ledger is the
#:   wrong-population defect `guard_refresh` spends a hundred lines policing,
#:   reached through a different door.
#:
#: IGNORECASE, like `CLOSING_RE`. It was not, so `GH-4487` matched and
#: `gh-4487` did not -- while the docstring claimed "the same reference shapes
#: as CLOSING_RE ... one alphabet, two questions". `CLOSING_RE.flags` is 34 and
#: this was 32; a reviewer read the flags rather than the sentence.
#: The boundaries exclude alphanumerics and `-`, NOT `_`. `\w` includes
#: underscore, so `_#4488_` -- ordinary Markdown emphasis -- resolved to
#: nothing, and a missed mention can only LOSE an escalation, which is the
#: wrong direction for a control that fails closed everywhere else. `*#4487*`
#: already worked, which is what made the gap easy to miss.
BARE_REF_RE = re.compile(
    r"(?<![0-9A-Za-z-])(?:\#|GH-)(?P<num>\d+)(?![0-9A-Za-z-])", re.IGNORECASE
)
_QUALIFIED_REF_RE = re.compile(
    r"(?P<slug>[A-Za-z0-9._-]+/[A-Za-z0-9._-]+)"
    r"(?:\#|/issues/)(?P<num>\d+)(?![\w-])",
    re.IGNORECASE,
)


def referenced_issues(body: str, commit_messages: list[str],
                      repo: str | None = None) -> list[int]:
    """Every issue this PR mentions, closing or not.

    A DIFFERENT question from `merge_is_close_safe`, and it has to be, because
    that scan is verb-anchored: `hard` needs a closing verb adjacent to the
    reference and `near` needs one within 80 characters. `Refs #4487` carries no
    verb, so it appears in NEITHER -- and `Refs #N` is how nearly every PR in
    this repo names the item it is work on, including the PR that added this
    function.

    Used by gate 3b to resolve the item's STREAM. Reusing the closing scan for
    that would have read "this PR references no issue" on most PRs and, since
    an unresolvable stream fails closed, escalated all of them for the wrong
    reason -- a control that fires on everything teaches the reader to skim it.

    OVER-MATCHING IS NOT HARMLESS HERE, which is why the pattern is narrow.
    `ledger_stream` prefers any escalating stream, so a stray reference usually
    only RAISES the count -- but one shape lowers it: a W1-deploy fix whose body
    cites only a non-escalating item and whose diff touches no listed path
    resolves `stream_known=True` and gets ONE reviewer, where no reference at
    all would have failed closed to two. A false reference can therefore buy a
    weaker gate, so the scan must not invent one.

    `repo` gates the qualified forms. Passing None accepts none of them, which
    fails closed: an unqualified caller cannot tell whose #123 it is looking at.
    """
    text = "\n".join([body, *commit_messages])
    found = {int(m.group("num")) for m in BARE_REF_RE.finditer(text)}
    for match in _QUALIFIED_REF_RE.finditer(text):
        if repo and match.group("slug").lower() == repo.lower():
            found.add(int(match.group("num")))
    return sorted(found)


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
    "stale_base_may_pass_on_an_inert_delta": "gates.base_delta_is_inert",
    "reduce_verdicts_by": "gates.reduce_verdicts",
    "verdict_pinned_to_head": "gates.parse_verdicts (postdates)",
    "require_no_red": "gates.classify_checks (RED_CONCLUSIONS)",
    "require_no_incomplete": "gates.classify_checks (INCOMPLETE_STATUSES)",
    "require_no_skipped_required_context": "gates.required_measured_nothing",
    "advisory_red_is_a_no_go": "gates.advisory_verdict",
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
    # THE WRITE PATH, which README long recorded as the gap: `record_receipt`
    # had no production caller, so every close was a hand edit to an untracked
    # file. `tick.py` is the writer because it already owns the ledger -- #4489
    # blocked the same write in `merge_gate` twice, once for rewriting a ledger
    # a worktree does not own and once for an unlocked read-modify-write with
    # four lanes live.
    "receipt_producers": "tick.verify_run_backed_receipt",
    "receipt_producers.g1-browser": "tick.verify_run_backed_receipt",
    "receipt_producers.estate": "tick.verify_run_backed_receipt",
    "receipt_producers.deploy-run": "tick.verify_run_backed_receipt",
    "receipt_required_steps": "tick.verify_run_backed_receipt",
    "receipt_required_steps.g1-browser": "tick.verify_run_backed_receipt",
    "receipt_required_steps.deploy-run": "tick.verify_run_backed_receipt",
    "receipt_required_steps.estate": "tick.verify_run_backed_receipt",
    # EACH CLASS DECLARED INDIVIDUALLY, now that a dict-valued top-level key no
    # longer exempts its sub-keys. `receipt_satisfies` looks each of these up by
    # name, so they are read, not prose -- and spelling them out is what makes
    # an ADDED-but-unread sibling detectable, which is the hole a reviewer
    # walked through with `receipts.totally_unread_rule`.
    "receipts.guard-or-test-only": "gates.receipt_satisfies",
    "receipts.deploy-path": "gates.receipt_satisfies",
    "receipts.estate-behaviour": "gates.receipt_satisfies",
    "receipts.ui-surface": "gates.receipt_satisfies",
    "receipts.human-only": "gates.receipt_satisfies",
    "receipts.ci_green_rule": "gates.ci_green_receipt",
    "receipts.ci_green_rule.substantive_steps": "gates.context_did_its_work",
    "receipts.ci_green_rule.scope_paths": "gates.scope_untouched_at_merge",
    "receipts.ci_green_rule.alternatives": "gates.alternative_accounted_for",
    "stop_and_ask.publish_security_advisory": "gates.action_is_permitted",
    "stop_and_ask.move_live_acr_tags": "gates.action_is_permitted",
    "stop_and_ask.delete_data_or_schema": "gates.action_is_permitted",
    "stop_and_ask.force_push_shared_branch": "gates.action_is_permitted",
    "stop_and_ask.weaken_or_baseline_a_guard": "gates.action_is_permitted",
    "stop_and_ask.add_trivyignore_entry": "gates.action_is_permitted",
    "stop_and_ask.use_skip_valve": "gates.action_is_permitted",
    "scope.closed_requires_receipt": "ledger.Ledger.receipt_ok",
    "permitted_unattended": "gates.action_is_permitted",
    "never": "gates.action_is_permitted",
    "stop_and_ask": "gates.action_is_permitted",
    "review.independent_reviewers_default": "gates.review_requirement",
    "review.escalate_to_two_when_path_contains": "gates.escalation_paths",
    "review.escalate_to_two_when_stream_is": "gates.escalation_streams",
    "review.escalate_on_blocking_first_verdict": "gates.review_requirement",
    "review.escalate_when_footprint_unknown": "gates.review_requirement",
    "review.escalate_when_stream_unknown": "gates.review_requirement",
}
# Keys that are DELIBERATELY prose: they address the operator, not the program.
# Listing them is the point -- an undeclared unconsulted key is indistinguishable
# from a control that stopped working.
OPERATOR_DOCUMENTATION = {
    "schema",
    # Addressed to the agent taking a G1 receipt, not to any function: there is
    # no program that can decide whether an assertion is reachable from an error
    # path. Declared rather than claimed, which is the whole point of this list
    # -- and it only became VISIBLE once a dict-valued top-level key stopped
    # exempting its sub-keys.
    "receipts.g1_assertion_rule",
    # The human-readable SPECIFICATION of `ci_green_receipt`. The control is the
    # function; this prose is what a reviewer reads to check the function against
    # its contract, and no code subscripts it. Newly VISIBLE (not newly unread)
    # once the walk stopped halting at two levels -- these four sat under a
    # declared parent and so were structurally unreachable, which is the hole an
    # independent reviewer walked through at three deep.
    "receipts.ci_green_rule.definition",
    "receipts.ci_green_rule.absence_is_excused_only_when",
    "receipts.ci_green_rule.fails_closed_on",
    "receipts.ci_green_rule.not_proven_by_this_receipt",
    "review.writer_is_never_the_reviewer",
    "scope.target", "scope.definition_of_done",
    "wip.serialize_on_shared_checkout",
    "ordering.W9_runs_continuously", "ordering.W9_reason",
    "stop_conditions.deploy_path_red",
    "stop_conditions.estate_behind_and_not_recovering",
    "stop_conditions.gate_tooling_untracked",
    "stop_conditions.consecutive_cycle_failures",
}


#: Declared keys whose VALUE is DATA the implementation consumes wholesale --
#: a table, not a namespace of further policy keys. The walk STOPS at these and
#: treats them as leaves, because the alternative is demanding a `gates.py`
#: declaration for every row of a data table.
#:
#: A stop here is only honest if some OTHER named instrument checks the rows,
#: and each entry says which. Nothing may be added without that sentence.
DATA_NOT_NAMESPACE = {
    "receipts.ci_green_rule.substantive_steps":
        "rows are checked against live branch protection by "
        "__tests__/test_ci_green_declared.py (set EQUALITY, so a stale or "
        "invented context name fails), and an undeclared context fails closed "
        "at runtime in gates.context_did_its_work",
    "receipts.ci_green_rule.scope_paths":
        "rows are checked against the producing workflow's own change detector "
        "by __tests__/test_ci_green_declared.py, and a context without a row "
        "cannot reach the scope-untouched branch at all",
    "receipts.ci_green_rule.alternatives":
        "rows are checked against the producing workflow by "
        "__tests__/test_ci_green_declared.py, which requires every named "
        "alternative step to EXIST in that workflow and to be gated on a "
        "DIFFERENT output than the primary step it stands in for",
}


def policy_keys_without_implementation(policy: dict) -> list[str]:
    """Every key in the policy that no function consults and no list excuses.

    An unconsulted policy key is prose, not a control. Keys starting with `_`
    are documentation by convention and are exempt; everything else must appear
    in an `*_IMPLEMENTED_BY` mapping or in `OPERATOR_DOCUMENTATION`, which is
    how "this one addresses the operator" stops being an unwritten assumption.

    WALKS TO ANY DEPTH, and it took three rounds to get there because each fix
    closed one level and left the next. A top-level declaration used to exempt
    every sub-key under it, and an independent reviewer disproved this
    function's own advertised contract by planting `receipts.totally_unread_rule`:
    the suite stayed green because `receipts` is declared at the top level and
    the branch short-circuited before the sub-key walk. That was fixed at TWO
    levels -- and the same reviewer then planted
    `receipts.ci_green_rule.totally_unread_rule` at three, which this function
    could not see either, on the very PR that made `ci_green_rule` a nested
    dict and so made three-deep the most likely place for a new key.

    So the depth is now unbounded rather than incremented, and the two sibling
    walkers were fixed with it -- `assert_policy_matches_code`'s
    implemented->declared loop and `_documentation_keys_that_are_actually_read`'s
    subscript scan, which partitioned on the FIRST dot and so could never match
    a three-level read. Fixing one direction and leaving the other is the
    one-side-of-a-symmetry defect this package keeps producing; all three
    directions are the symmetry.
    """
    sectioned = {
        "merge_gate": MERGE_GATE_IMPLEMENTED_BY,
        "verdict_parsing": VERDICT_PARSING_IMPLEMENTED_BY,
    }
    missing: list[str] = []

    def walk(node: dict, prefix: str) -> None:
        for key, value in node.items():
            if key.startswith("_"):
                continue
            dotted = f"{prefix}.{key}" if prefix else key
            if dotted in sectioned:
                for sub in value:
                    if not sub.startswith("_") and sub not in sectioned[dotted]:
                        missing.append(f"{dotted}.{sub}")
                continue
            # A dict is a NAMESPACE and is descended into -- the key itself
            # never has to be declared, only its leaves. Unless it is declared
            # DATA, in which case it is the leaf and its rows are somebody
            # else's contract.
            if isinstance(value, dict) and dotted not in DATA_NOT_NAMESPACE:
                walk(value, dotted)
                continue
            if dotted not in OTHER_IMPLEMENTED_BY and dotted not in OPERATOR_DOCUMENTATION:
                missing.append(dotted)

    walk(policy, "")
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

    # The SAME direction for the third mapping, which this loop never covered.
    # Each of its keys is read as `x.get(k, <default>)` where the default equals
    # the shipped value, so DELETING one from policy.json was unobservable --
    # flipping it to false was caught, removing it was not. Three of the five
    # new `review.*` keys could be deleted with the suite fully green: the
    # mapping claimed an implementation for a key the authority no longer
    # contained. "Undeclared behaviour is as bad as undelivered behaviour" is
    # asserted for the other two sections and was missing here.
    #
    # WALKS TO ANY DEPTH. It used to `partition` on the FIRST dot and look the
    # remainder up as a single key, so a three-level entry like
    # `receipts.ci_green_rule.substantive_steps` was reported absent even when
    # the authority carried it -- and, worse, a three-level key the authority
    # did NOT carry was structurally unmissable in the other direction. That is
    # the same hole an independent reviewer found at two levels, one level down:
    # fixing one depth and leaving the next is the one-side-of-a-symmetry defect
    # this package keeps producing. Measured before changing it: 71 leaf paths,
    # 19 of them three-or-more levels deep, and ZERO newly unclaimed -- so this
    # tightens the contract without a cascade.
    absent = []
    for dotted in OTHER_IMPLEMENTED_BY:
        node = policy
        for part in dotted.split("."):
            if not isinstance(node, dict) or part not in node:
                absent.append(dotted)
                break
            node = node[part]
    if absent:
        raise ValueError(
            f"implemented but not declared in policy.json: {sorted(absent)} - "
            "a mapping that names a key the authority does not contain is a claim "
            "about a control that is not there"
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
    read = sorted(_documentation_keys_that_are_actually_read())
    if read:
        raise ValueError(
            f"declared as operator documentation but READ by the code: {read} - "
            "moving a control onto the allow-list is the allow-list becoming an off switch"
        )


def _documentation_keys_that_are_actually_read() -> list[str]:
    """`OPERATOR_DOCUMENTATION` entries that some module actually consults.

    The both-lists check caught DECLARING a key twice. It did not catch MOVING
    one -- take `wip.max_lanes` out of the implemented mapping, drop it into the
    allow-list, and the contract passed while `select_cycle` still read it. That
    is the allow-list becoming an off switch, which is the thing it must never
    be.

    So the property is checked directly rather than by bookkeeping: a key
    declared to be prose must not be SUBSCRIPTED out of a policy dict anywhere
    in this package.

    Keyed to the SUBSCRIPT (`policy["x"]` / `.get("x"` / `["x"]`), not to the
    bare literal. A bare-literal scan had both edges: it cried wolf on any
    unrelated string (`ANNOTATION_KIND = "target"` in an unrelated module failed
    the contract and blamed `scope.target` -- an R7 message aimed at a
    maintainer), and it had to skip top-level names entirely to avoid the
    `schema` collision, which left `repo` -- genuinely read by three modules --
    able to be moved onto the allow-list undetected. The subscript form covers
    top-level keys too, because `raw.get("schema")` in the ledger is about the
    LEDGER's schema and is keyed to `raw`, not to a policy dict.

    A read assembled from variables still passes. That is inherent to a source
    scan and is stated rather than implied; it catches the naive move, which is
    the one that happened.
    """
    import pathlib
    import re

    here = pathlib.Path(__file__).resolve().parent
    sources = "\n".join(
        p.read_text(encoding="utf-8")
        for p in sorted(here.glob("*.py"))
        if p.name != "mutate_gates.py"
    )
    found = []
    # WHITESPACE-COLLAPSED, because a chained read is routinely written across
    # LINES and a gap of `[^\n]{0,20}` cannot cross one. This package's own read
    # of `receipts.ci_green_rule.substantive_steps` is three lines of `.get(...)`
    # in the house style, so the scan would have reported that key unread no
    # matter how deep the walk went -- a depth fix that leaves the pattern
    # unable to see the shape it was widened for. Collapsing errs toward
    # FLAGGING (the gap could bridge two adjacent statements), and flagging is
    # the safe direction here: it says "this prose key looks read", which a
    # maintainer resolves by declaring it implemented.
    flat = re.sub(r"\s+", " ", sources)
    for dotted in OPERATOR_DOCUMENTATION:
        parts = dotted.split(".")
        if len(parts) > 1:
            # THE CHAIN, TO ANY DEPTH. This used to `partition` on the FIRST
            # dot and treat the remainder as ONE sub-key, so a three-level entry
            # searched the sources for the literal `"ci_green_rule.definition"`
            # and could never match. That is a FALSE NEGATIVE in the direction
            # that matters: a three-deep control could be moved onto the
            # operator-documentation allow-list while a function still read it,
            # which is precisely the allow-list becoming an off switch. Same
            # depth defect as the two sibling walkers, third instance.
            step = r"(?:\[|\.get\()\s*[\"']{}[\"']"
            chain = step.format(re.escape(parts[0])) + "".join(
                r"[^\n]{0,20}?" + step.format(re.escape(part)) for part in parts[1:]
            )
            # ...but a read split ACROSS TWO STATEMENTS is not a chain: bind the
            # parent to a local first, then subscript the local on the next
            # line. The chain cannot span that, so `review.*` keys could be moved
            # onto the allow-list undetected while `review_requirement` still
            # read them. The local-alias form is matched separately, keyed to the
            # IMMEDIATE PARENT as a receiver -- which is the spelling that makes
            # an alias readable in the first place.
            alias = (r"\b" + re.escape(parts[-2]) + r"\s*(?:\[|\.get\()\s*[\"']"
                     + re.escape(parts[-1]) + r"[\"']")
            if re.search(alias, flat):
                found.append(dotted)
                continue
            #
            # BOTH halves accept `.get(`, not just the last. The asymmetry
            # missed `policy.get("wip", {})["max_lanes"]` -- and `.get(` is this
            # package's dominant spelling (seven occurrences, including the
            # two-level `policy.get("receipts", {}).get(...)`), so a future read
            # written in the file's own house style would let a sectioned
            # control be moved onto the allow-list undetected. The hole these
            # checks exist to close, reopened by a refactor that looks like its
            # neighbours.
            pattern = chain
        else:
            # A TOP-LEVEL key must be rooted at a policy dict. `repo` is read by
            # three modules as `policy["repo"]`; the ledger's `raw.get("schema")`
            # is keyed to `raw` and so does not match, which is what lets bare
            # names be covered at all.
            pattern = (r"(?:policy|POLICY|cfg)\s*(?:\[|\.get\()\s*[\"']"
                       + re.escape(parts[0]) + r"[\"']")
        if re.search(pattern, flat):
            found.append(dotted)
    return found


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

#: What `worst_verdict_in_history` returns when the block it found was a
#: NEAR-MISS -- a blocking token somewhere in the review history with no line
#: announcing a verdict. It still escalates (formatting never reduces a block),
#: but it is NOT attributable to a reviewer's decision, and saying "a reviewer
#: returned REQUEST-CHANGES" about ordinary status prose is an R7 error. It
#: carries a blocking token by construction so every shape-match downstream
#: still fires.
UNANNOUNCED_BLOCK = "REQUEST-CHANGES unannounced"

NEAR_PREDATES_HEAD = "predates-head"
NEAR_TEMPLATE = "template-line"
NEAR_UNPINNABLE = "head-date-unknown"
NEAR_CITED = "cited-not-decided"
# A verdict header that IS in prose, but is not the comment's first line -- it
# may be below the window, or merely below a preamble. The old name said
# "below-the-window" and was wrong for the second case, which is an R7 error in
# a message: it asserted a cause the code had not established.
NEAR_NOT_FIRST = "not-the-first-line"

#: ONE SENTENCE PER KIND, because three kinds can block here and they are not
#: the same fact. The first version wrote the `no-marker` sentence for all
#: three, so "a blocking token appears with no line announcing a verdict" was
#: FALSE for the other two -- `no-token` is a comment that DOES announce and
#: carries no token at all, `template-line` announces on its first line. A
#: reviewer measured both through the real composition. That is the R7 defect
#: the same round was written to repair, landed on one side of its own
#: boundary, which this package names as its dominant failure mode.
UNANNOUNCED_REASON_BY_KIND = {
    NEAR_NO_MARKER: (
        "a blocking token appears in this PR's review history with no line "
        "announcing a verdict"
    ),
    NEAR_NO_TOKEN: (
        "a comment in this PR's review history announces a verdict and carries "
        "no token on that line, so what it decided is unreadable"
    ),
    # NOT "carries the verdict TEMPLATE line". `_saw_template` establishes only
    # that a line LISTS ALL THREE TOKENS -- its own docstring says so -- and a
    # sentence describing the policy does that without pasting anything:
    #
    #   "This module's policy allows APPROVE, REQUEST-CHANGES, or
    #    CANNOT-ASSESS as outcomes."
    #
    # A reviewer ran exactly that and got told it "carries the verdict TEMPLATE
    # line". Worse, it was a REGRESSION: the blanket sentence this replaced
    # ("no line announcing a verdict") happened to be TRUE of that shape, so
    # the per-kind fix made one sub-case worse while fixing two others.
    #
    # The remedy is the wording, not a narrower `_saw_template`: narrowing it
    # would REDUCE what blocks, and this package does not move that direction
    # to make a message read better.
    NEAR_TEMPLATE: (
        "a comment in this PR's review history carries a line naming EVERY "
        "verdict token, so it lists the outcomes rather than choosing one"
    ),
}
#: Whatever a FUTURE kind turns out to be, the reason must not claim to know.
#: A `.get()` onto a confident sentence is how the defect above happened.
UNANNOUNCED_REASON_UNKNOWN = (
    "a comment in this PR's review history blocks for a reason this message "
    "has no wording for - read the comment"
)


def _unannounced_kind(prior_verdict: str) -> str:
    """The near-miss kind `worst_verdict_in_history` tagged into the string."""
    inside = prior_verdict[len(UNANNOUNCED_BLOCK):].strip(" ()")
    return inside.split(",")[0].strip()


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


def worst_verdict_in_history(comments: list[dict], window: int = 200) -> str | None:
    """The WORST verdict ever posted to this PR, ignoring the head.

    `escalate_on_blocking_first_verdict` asks a question about the review's
    HISTORY, not about its current state, so this deliberately does NOT pin to
    the head. `parse_verdicts` does pin, and correctly: a block from before a
    push is no longer a live verdict. But it is still true that a reviewer
    blocked, and that fact is what raises the count to two. Without it the
    trigger was inert at the only place the count is enforced, and the
    block-push-reapprove rhythm -- the ordinary shape of a round here -- merged
    on one approval what a reviewer had just rejected.

    WORST-FIRST, NOT FIRST-BY-TIMESTAMP. The previous version returned the
    EARLIEST verdict-bearing comment and stopped, which a reviewer broke by
    swapping two comments. On THIS repo the two verdicts of a round are posted
    within a second of each other -- measured on PR #4488's own round 5:
    `5644049925` at 06:01:07Z (REQUEST-CHANGES) and `5644050042` at 06:01:08Z
    (APPROVE). The drain launches its reviewers in parallel, so which one lands
    first is a race, and an APPROVE winning it disarmed the trigger entirely.
    Half of all parallel double-reviews. The property wanted is "a block
    occurred", so the reduction is the same conjunction `reduce_verdicts` uses.

    POSITION, NOT IDIOM -- and the two reviewers disagreed about this, so the
    module's own principle decides it.

    Round 6, reviewer A: the docstring claimed a blocking token ANYWHERE in the
    window wins, and `_token_of` reads the announcing line only, so the claim
    described code that did not exist. They offered two remedies -- narrow the
    sentence, or add a flat scan. I added the flat scan.

    Round 7, reviewer B measured what that costs:

        "## Independent review - APPROVE

         Addresses the prior REQUEST-CHANGES cleanly; retested end to end."
                                        -> REQUEST-CHANGES

    A clean approval read as a block because its prose NAMED one. That is
    verbatim the hazard `_token_of`'s own docstring records as deliberately
    avoided: "an approving review whose prose mentioned the other spellings
    registered as a block". The two reviewers' inputs are the same SHAPE -- a
    token in prose below an announcing line -- so no rule can satisfy both, and
    the one that matches the rest of this module is the announcing line.

    ONE POPULATION, NOT TWO. This delegates to `parse_verdicts` rather than
    re-parsing, and that is the whole design. The hand-rolled version was
    STRICTER than the gate it feeds: it required a well-formed marker line, so
    four shapes that gate 2+3 blocks on went unseen, and each one merged on a
    single approval after a push. A reviewer measured all four end to end:

        "Re-review - REQUEST-CHANGES"                  (marker misspelled)
        a block below a one-line preamble              (marker not first)
        "Independent re-review - CHANGES REQUIRED"     (block spelled wrong)
        a fenced relay of the header                   (marker cited)

    The third is the sharpest. `review_requirement` carries a dedicated
    `"CHANGES REQUIRED"` branch, with an arm and a direct unit test -- and the
    only production producer of `prior_verdict` could never emit a string
    containing it. That is verbatim the defect this round claimed to repair one
    function over: a trigger proved against the FUNCTION and never against the
    CALLER feeding it.

    `parse_verdicts` already answers "did anything blocking happen here", across
    every marker shape, every token spelling, and quoted/fenced/collapsed text,
    with the near-miss machinery three reviews built. A block is a blocking live
    verdict OR a blocking near-miss. Sharing it also removes the over-firing the
    OTHER reviewer measured: a comment whose FIRST line announces APPROVE is a
    live APPROVE, so prose beneath it -- citing a prior round, linking one,
    quoting one -- reports nothing. Both complaints, one answer.

    THE COST, MEASURED BY THE OTHER REVIEWER AND TAKEN DELIBERATELY. Sharing
    the population means inheriting `NEAR_NO_MARKER`, which blocks on a blocking
    token in a comment that announces nothing. In gate 2+3 that is safe because
    a push discharges it; here nothing pins, so it is PERMANENT. Their input:

        "Status: the round-3 REQUEST-CHANGES finding about the anchor
         meta-test has since been fixed and re-verified end to end."

    Ordinary status prose -- the house style on this very PR -- locks it to two
    reviewers for the rest of its life.

    I could not find a rule that separates that from the first reviewer's

        "Re-review - REQUEST-CHANGES"          (marker misspelled)

    They are the same shape: a token on a line that is not a recognised marker.
    Every candidate discriminator was an idiom, and "three rounds running, the
    rule was 'a marker line that is not <the idioms I have thought of>'" is the
    recorded history of the function next door. So the tie is broken on the
    rule this package already states in both directions: formatting may refuse
    to GRANT an approval and must never REDUCE a block, and every sibling
    control fails closed. An over-escalation costs a reviewer; an
    under-escalation merges a PR a reviewer rejected.

    What is NOT acceptable is the reason string lying about it. "a reviewer
    returned REQUEST-CHANGES" is false for status prose -- no reviewer returned
    anything. So an unannounced block comes back tagged and carrying its comment
    id, and `review_requirement` words it as what it is.

    The head_date passed is the earliest NON-EMPTY timestamp, so nothing is
    pinned out -- and a comment with no timestamp at all is treated as
    unpinnable rather than as predating, because `"" >= "0000-..."` is False and
    that silently DROPPED its verdict. Measured as a regression against the
    hand-rolled version, in the losing direction.
    """
    if not comments:
        return None
    stamped = [c.get("created_at") or "" for c in comments]
    earliest = min((s for s in stamped if s), default="") or "0000-01-01T00:00:00Z"
    # NORMALISE THE MISSING TIMESTAMPS IN, rather than special-casing them out.
    # `min()` over the raw values returned `""` whenever ANY comment lacked one,
    # the fallback kicked in, and that comment then failed
    # `"" >= "0000-01-01T00:00:00Z"` -- so `parse_verdicts` called it
    # PREDATES-HEAD, `blocks=False`, and dropped its verdict. Measured as a
    # regression against the hand-rolled version, in the losing direction.
    #
    # A comment with no timestamp is not OLD, it is UNDATED. Pinning is not the
    # question this function asks, so an undated comment is pinned in at the
    # earliest and parsed like any other -- which keeps a well-formed
    # `REQUEST-CHANGES` a live block rather than demoting it to unpinnable.
    pinned_in = [
        c if s else {**c, "created_at": earliest}
        for c, s in zip(comments, stamped, strict=False)
    ]
    live, near = parse_verdicts(pinned_in, earliest, window)
    blocking = next((v.token for v in live if v.token in BLOCKING_TOKENS), None)
    if blocking:
        return blocking
    blocked = next((n for n in near if n.blocks), None)
    if blocked:
        # A near-miss has no token by construction -- that is what makes it a
        # near-miss -- so it cannot be reported as one reviewer's decision. It
        # is TAGGED, and it names the comment, because a permanent escalation
        # nobody can locate is worse than one they can argue with.
        #
        # It also carries the KIND. Three kinds can block here and the first
        # version worded the reason for ONE of them, so the sentence "a
        # blocking token appears ... with no line announcing a verdict" was
        # FALSE for the other two: `no-token` is a comment that DOES announce
        # and carries no token at all, and `template-line` announces on its
        # first line. A reviewer measured both. Fixed on one side of a boundary
        # and not the other, in the round whose whole subject was that.
        return f"{UNANNOUNCED_BLOCK} ({blocked.kind}, comment {blocked.comment_id})"
    return next((v.token for v in live), None)


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
        # A blocking token BELOW the window, in a comment that announces
        # nothing, used to produce `live=[] near=[]` -- no trace whatever, in
        # the one direction the code says must never be reduced. It does not
        # BLOCK (the window is the contract on both sides, or any long comment
        # quoting an old round freezes the PR), but it is no longer silent.
        #
        # Scanned over the WHOLE body, not `body[window:]`. A prefix cut at 200
        # splits a token that STRADDLES it -- `body[:200]` ends "...REQUEST-CH"
        # and `body[200:]` begins "ANGES..." -- so a token starting at offsets
        # 186-199 was a complete substring of neither and left no trace at all,
        # the very silence this branch exists to end, surviving in a 15-char
        # band. The branch is gated on `not blocking_mention`, so scanning the
        # whole body cannot double-report and cannot block.
        blocking_below = (
            not blocking_mention
            and any(
                any(t in ln for t in BLOCKING_TOKENS)
                and not all(t in ln for t in VERDICT_TOKENS)
                for ln in body.splitlines()
            )
        )

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
            elif blocking_below:
                near.append(
                    NearMiss(cid, when,
                             f"a BLOCKING token appears BELOW body[:{window}] in a comment "
                             "that announces no verdict - it does not block (the window "
                             "bounds both directions) but it is recorded rather than dropped",
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
# Concluded, not red, and carrying NO measurement. These are green ON THEIR OWN
# -- an advisory check that skips on a path filter is the routine case and must
# never block -- but they cannot DISCHARGE an earlier red run of the same name
# at the same head, because nothing was measured to discharge it with. A
# SUCCESS is deliberately absent: that is a re-run that ran and passed.
MEASURED_NOTHING = frozenset({"SKIPPED", "NEUTRAL"})
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


def worst_by_name(checks) -> dict[str, dict]:
    """Context name -> its WORST run. Shared, because two callers need it.

    Two runs can publish the same context name (a re-run, or a matrix leg), and
    the worst one has to decide: a green twin must never hide a run that
    measured nothing. `merge_gate` reached into `_check_rank` to rebuild this,
    which is the same de-duplication written twice and free to drift.
    """
    by_name: dict[str, dict] = {}
    for check in checks:
        name = check.get("name") or check.get("context") or ""
        if not name:
            continue
        prior = by_name.get(name)
        if prior is None or _check_rank(check) > _check_rank(prior):
            by_name[name] = check
    return by_name


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
    by_name = worst_by_name(checks)

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


# ---------------------------------------------------------------------------
# Gate 4c -- the ADVISORY population (#4543)
# ---------------------------------------------------------------------------
#
# Gates 4, 4b and 5 all take `required` and FILTER THE POPULATION BEFORE ANY
# PREDICATE RUNS. Only 15 of the ~35-40 contexts this repo publishes are
# required, so ~25 checks per PR were invisible to the program that decides
# every merge -- and an advisory RED and `VERDICT: GO` were perfectly
# compatible. Measured on PR #4540, head `7dd2fa3e279`: forty check-runs,
# exactly ONE red (`brain security graph -- committed artifact matches the
# tree`, advisory), and the gate printed GO. The merge landed and `main` was
# red afterwards.
#
# This capability EXISTED and was lost. `temp/merge-eligible.py` -- the tool
# `merge_gate.py` replaced -- had the same blind spot, it was found (#4035) and
# it was fixed there with exactly this three-way split. The promotion out of
# `temp/` did not carry it. A gate checking a gate, inheriting its blindness.
#
# The population here is `statusCheckRollup`, which already carries every check
# and needs no second API call. That matters for fail-closed behaviour: if the
# rollup cannot be read, `collect` raises and nothing is scored -- a site that
# is never evaluated, not a site that evaluates to GO.


@dataclass(frozen=True)
class AdvisorySplit:
    """The split, as names -- so a caller can PRINT which is which.

    `red` carries `"name (CONCLUSION)"`; `rerun` carries a sentence; `wait` and
    `clean` carry bare names. `population` counts the distinct advisory
    contexts considered and `total_checks` every entry the rollup published,
    required included. Both counts are reported rather than derived by the
    caller, because a clean answer over an EMPTY population is the
    green-over-zero-items shape (#4451) and the reader has to be able to tell
    the two apart.

    FOUR buckets, not three. `rerun` is the one the predecessor did not have:
    a name whose NEWEST run has not concluded while an OLDER run at the same
    head concluded RED. See `classify_advisory_checks` for why it is separate
    from both `red` and `wait`.
    """

    red: list[str]
    rerun: list[str]
    wait: list[str]
    clean: list[str]
    population: int
    total_checks: int


def _started_utc(check: dict) -> _dt.datetime | None:
    """When this run STARTED, in UTC, or None when that cannot be established.

    FOUR spellings, because the same fact arrives under different names:
    GraphQL `statusCheckRollup` publishes `startedAt`, the REST check-runs API
    publishes `started_at`, and a StatusContext has neither -- it carries
    `createdAt` / `created_at`. A reader that knows one spelling silently
    treats every other shape as timestamp-less.

    Returns None, deliberately, for anything it cannot parse or that carries no
    timezone. `newest_by_name` reads None as "fall back to worst-wins for this
    whole name", which is the conservative branch: an unreadable timestamp must
    never let a red run be discarded as superseded.
    """
    for key in ("startedAt", "started_at", "createdAt", "created_at"):
        raw = check.get(key)
        if not isinstance(raw, str) or not raw.strip():
            continue
        text = raw.strip()
        # `fromisoformat` did not accept a trailing `Z` until 3.11, and this
        # package declares >=3.10. Every GitHub timestamp ends in one.
        if text[-1] in ("Z", "z"):
            text = text[:-1] + "+00:00"
        try:
            when = _dt.datetime.fromisoformat(text)
        except ValueError:
            return None
        if when.tzinfo is None:
            return None
        return when.astimezone(_dt.timezone.utc)
    return None


def _worst(runs: list[dict]) -> dict:
    """The worst run in a group, first-wins on a tie (as `worst_by_name` is)."""
    chosen = runs[0]
    for run in runs[1:]:
        if _check_rank(run) > _check_rank(chosen):
            chosen = run
    return chosen


def _group_by_name(checks) -> dict[str, list[dict]]:
    """Context name -> every run that published it at this head.

    Split out because TWO questions need the whole group, not just its winner:
    which run is newest, and whether any OTHER run of that name concluded RED
    (`classify_advisory_checks`'s `rerun` bucket). Narrowing the population is
    therefore a single edit here, which is what arm A2 mutates.
    """
    groups: dict[str, list[dict]] = {}
    for check in checks:
        name = check.get("name") or check.get("context") or ""
        if not name:
            continue
        groups.setdefault(name, []).append(check)
    return groups


def newest_by_name(checks) -> dict[str, dict]:
    """Context name -> its NEWEST run, by max start time. Not last-in-list.

    A re-run publishes a SECOND check-run under the same name, and list order
    is the API's, not time's. Taking the last entry is wrong in both
    directions: a stale red can outrank the green re-run that fixed it, and a
    stale green can bury a red one. Neither error is visible from the answer.

    Deliberately DIFFERENT from `worst_by_name`, which the required path uses.
    There, worst-wins is right: a required context that concluded SKIPPED must
    not hide behind a green twin, and a required gate is allowed to be
    pessimistic. Here the question is "what does this advisory check say NOW",
    and a fixed check that still blocks is a gate that strands the drain.

    Two ways this falls back to worst-wins, both fail-closed:
      * any run in the group has no readable start time -- then the group's
        order is unknown and the pessimistic answer is the only honest one;
      * two or more runs TIE at the maximum start time (matrix legs fire
        together) -- then "newest" does not pick one and the worst of the tied
        set is taken.
    """
    return _newest_from_groups(_group_by_name(checks))


def _newest_from_groups(groups: dict[str, list[dict]]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for name, runs in groups.items():
        stamps = [_started_utc(run) for run in runs]
        if any(stamp is None for stamp in stamps):
            out[name] = _worst(runs)
            continue
        newest = max(stamps)
        out[name] = _worst([r for r, s in zip(runs, stamps, strict=True) if s == newest])
    return out


def _is_incomplete(check: dict) -> bool:
    """Has this run NOT said anything yet? One definition, two callers.

    Written once because the advisory split and `_newest_informative_concluded` must agree
    exactly: if they drift, a run counts as in-flight for one question and as
    concluded for the other, and the bucket boundary moves without anyone
    editing it.

    DISCLOSED GAP, pre-existing and deliberately not papered over: the
    `status in INCOMPLETE_STATUSES` clause has NO fixture that distinguishes it
    on this path. Every advisory in-flight fixture also has a falsy `verdict`,
    so the first clause answers first and deleting the third is invisible to
    the suite. It is kept because `_outcome`'s docstring records why -- a
    CheckRun can publish `status: IN_PROGRESS` alongside a stale `conclusion`,
    and a reader testing only one of the pair scored a PENDING StatusContext
    green. The same clause exists unfixtured at two OLDER sites
    (`classify_checks`, `_check_rank`); an independent reviewer measured that
    and asked for this line rather than a fabricated fixture, and those two
    sites are deliberately NOT touched here.
    """
    verdict, status = _outcome(check)
    return not verdict or verdict in INCOMPLETE_STATUSES or status in INCOMPLETE_STATUSES


def _newest_informative_concluded(runs: list[dict]) -> dict | None:
    """The newest CONCLUDED run that actually MEASURED something, or None.

    A plain newest-concluded read answers "what did this check last say". This answers the
    narrower question both callers need: "what did this check last say when it
    actually RAN". A `SKIPPED` or `NEUTRAL` run said nothing, so it is not an
    answer to a previous failure.

    WHAT MAKES THIS RETURN None: a group of nothing but skips and in-flight
    runs. That routes the caller to `clean`/`wait`, which is correct — a check
    that has never measured anything at this head has no red to carry forward.

    NO `exclude` PARAMETER, and the reason is worth recording. The first version
    took the newest run and dropped it by IDENTITY, with a docstring claiming
    that removing by VALUE would drop byte-equal twins and fail OPEN. Two
    independent reviewers showed that claim was UNKILLABLE: `is not` → `!=` →
    dropping the filter entirely all left the suite green, and one enumerated
    all 898 reachable 2- and 3-run groups and found the verdict never differs.
    It is dead by construction at both call sites — the supersession caller's
    run is in `MEASURED_NOTHING` and the ADV-RERUN caller's is incomplete, so
    each is already removed by a filter below. `assertion-design.md` says an
    un-killable assertion is disclosed or dropped; this one is dropped, because
    the honest version of it is "this parameter does nothing".
    """
    informative = [
        run for run in runs
        if not _is_incomplete(run)
        and _outcome(run)[0] not in MEASURED_NOTHING
    ]
    if not informative:
        return None
    return _newest_from_groups({"": informative})[""]


def classify_advisory_checks(checks: list[dict], required: list[str]) -> AdvisorySplit:
    """Split every NON-required context: ADV-RED / ADV-RERUN / ADV-WAIT / clean.

    The same split the required path uses, over the population the required
    path throws away, plus one bucket the predecessor did not have. Both rollup
    shapes are read via `_outcome`: a StatusContext says ERROR/PENDING where a
    CheckRun says FAILURE/IN_PROGRESS and has no `status` key at all, so a
    conclusion-only reader is blind to every context published by the other
    shape.

    IN-PROGRESS IS NOT RED. That is the recorded mistake from the first time
    this was built, for `merge-eligible.py`: classifying `in_progress` as red
    cries wolf on every PR with CI still running, and a control that fires on
    everything teaches its reader to skim it. The same goes for `queued` and
    for a StatusContext's `PENDING` -- `INCOMPLETE_STATUSES` is the whole
    vocabulary of "has not said anything yet", and all of it routes to `wait`.

    SKIPPED IS NOT RED EITHER, on this side. For a REQUIRED context a SKIPPED
    run is a gate that measured nothing (gate 5), but advisory checks skip
    routinely and legitimately on path filters -- `Bicep Lint` and `Workflow
    lane states` were both SKIPPED on the fixture head, on a PR that touched
    neither. Counting those would make the arm red on essentially every PR.

    ADV-RERUN HOLDS TWO SHAPES, and the bucket's name is older than its
    contents. Both mean "the last thing this check MEASURED was red, and
    nothing has measured since":

      1. a re-run is IN FLIGHT and has not answered yet; and
      2. a re-run has CONCLUDED `SKIPPED` or `NEUTRAL` — it answered, but it
         measured nothing, so it did not answer THIS.

    Shape 1 closes a SELF-CLEARING BLOCK found by an independent reviewer on
    the first version of this arm: `newest`-wins alone answered ADV-WAIT, which
    does not block, so dispatching the gate's OWN remedy (`rerun-ci`) cleared
    the gate's own block the moment the re-run STARTED. Shape 2 is the same
    hole one step later, found on round 4 — and round 4's fix for it re-opened
    shape 1 by changing only the sibling branch. Both `rerun-ci` and
    `merge-on-gate-go` are in `permitted_unattended`, so this was a live path
    to merging over a red without a human in it.

    NEWEST INFORMATIVE, not "any run was red" -- see
    `_newest_informative_concluded`, where an earlier version of this bucket
    over-blocked a check that had already been fixed and named a run whose
    conclusion it had never read.

    It is a SEPARATE bucket from `red` on purpose, because the remedy differs
    and `deploy-integrity.md` R7 applies to a gate's own message: the check has
    not failed AGAIN, and the red has not been cleared.

    "WAIT FOR IT" IS NOT SAID HERE, AND THE REASON IS THE ROUND-4 BLOCKER. It
    was the runtime message and it is false for shape 2 — that re-run has
    already concluded, so waiting can never resolve it. The message now says
    the red has not been CLEARED and that a re-run must actually MEASURE to
    clear it, which is true of both shapes. A docstring that still said "wait
    for it is true" survived one round after the message it described was
    corrected; closing a finding at the MESSAGE and not at the SPEC is the
    label-not-site error `assertion-design.md` names.

    Live frequency of the shape: 0 across 52 PR heads (the reviewer's scan), so
    holding it costs nothing measurable today. It is blocked rather than
    disclosed because the cost of holding is a few minutes and the cost of the
    hole is an unattended merge over a red -- and because the drain's own
    remedy is what creates the shape, which makes it reachable by design rather
    than by chance.
    """
    required_names = set(required)
    red: list[str] = []
    rerun: list[str] = []
    wait: list[str] = []
    clean: list[str] = []
    groups = _group_by_name(checks)
    for name, check in sorted(_newest_from_groups(groups).items()):
        if name in required_names:
            continue
        verdict = _outcome(check)[0]
        if verdict in RED_CONCLUSIONS:
            red.append(f"{name} ({verdict})")
        elif _is_incomplete(check):
            # `_newest_informative_concluded`, NOT `_newest_concluded` -- the
            # FOURTH form of the self-clearing block, and round 4 CREATED it by
            # fixing only the sibling branch below. a plain newest-CONCLUDED read counts a
            # SKIPPED run as an answer, so:
            #
            #     FAILURE@10, SKIPPED@11                  -> NO-GO  (round 4)
            #     FAILURE@10, SKIPPED@11, IN_PROGRESS@12  -> GO     (this hole)
            #
            # i.e. round 4 made `FAILURE, SKIPPED` block, and then dispatching
            # `rerun-ci` -- the gate's OWN `permitted_unattended` remedy --
            # cleared it the instant the re-run STARTED. That is round 2's
            # finding verbatim, re-opened one line above round 4's fix for it.
            # The two branches ask the same question and must use the same
            # helper.
            last = _newest_informative_concluded(groups[name])
            last_verdict = _outcome(last)[0] if last is not None else ""
            if last_verdict in RED_CONCLUSIONS:
                rerun.append(
                    f"{name} (a re-run is in flight; the newest run that MEASURED "
                    f"anything at this head was {last_verdict})"
                )
            else:
                wait.append(name)
        elif verdict in MEASURED_NOTHING:
            # A RUN THAT MEASURED NOTHING CANNOT DISCHARGE A RED ONE.
            #
            # The third form of the self-clearing block, found by an independent
            # reviewer after the first two were closed. `rerun` above holds the
            # case where the re-run is still IN FLIGHT -- but once that re-run
            # CONCLUDES `SKIPPED` or `NEUTRAL` it stops being incomplete, so
            # newest-wins dropped it straight into `clean` and the red vanished:
            #
            #     FAILURE @10:00, SKIPPED @11:00  ->  (True, "no advisory context is red")
            #
            # and the same for NEUTRAL. That is reachable by ordinary re-run
            # semantics -- an `if:` re-evaluating false, or a `needs` upstream
            # failing or being cancelled, both yield `skipped` -- i.e. by the
            # gate's OWN remedy, `rerun-ci`, which is in `permitted_unattended`.
            #
            # SKIPPED still is not RED (see above: advisory checks skip
            # routinely on path filters, and counting that would block every
            # PR). The claim here is narrower and is about SUPERSESSION: a
            # skip may mean "not applicable", which is fine on its own and is
            # NOT fine as an answer to a run that already failed at this head.
            # A SUCCESS deliberately DOES discharge it -- that is a re-run that
            # measured something and passed.
            prior = _newest_informative_concluded(groups[name])
            prior_verdict = _outcome(prior)[0] if prior is not None else ""
            if prior_verdict in RED_CONCLUSIONS:
                rerun.append(
                    f"{name} (superseded by a {verdict} run, which measured nothing; "
                    f"the newest run that DID measure at this head was {prior_verdict})"
                )
            else:
                clean.append(name)
        else:
            clean.append(name)
    return AdvisorySplit(
        red=red,
        rerun=rerun,
        wait=wait,
        clean=clean,
        population=len(red) + len(rerun) + len(wait) + len(clean),
        total_checks=len(checks),
    )


def advisory_verdict(
    checks: list[dict], required: list[str], policy_says_no_go: bool
) -> tuple[bool, str]:
    """Gate 4c: an advisory RED is a NO-GO. Returns (ok, one legible line).

    BLOCK, not report -- decided on a measurement rather than on taste, and the
    measurement was taken WITH THIS FUNCTION rather than with a restatement of
    it. Across 22 PR heads on 2026-09-17 (the 10 then-open PRs plus the 12 most
    recently merged), TWO would go NO-GO here:

        #4540  brain security graph -- committed artifact matches the tree
               (FAILURE)  <- the fixture; this is the head that shipped a red
               main under a VERDICT: GO
        #4492  in-VNet runner capability probe (CANCELLED)
               the runner PAT is not reachable from job code (CANCELLED)

    So 2 of 22, ~9%: not "every PR", and blocking does not strand the drain.
    An earlier draft of this docstring said ONE of 22 -- that number came from
    remembering the merged half of the population and not re-reading the open
    half, which is the partial-read-then-confident-claim shape this repo keeps
    recording. It is corrected here rather than quietly dropped, because the
    block-vs-report decision rests on it.

    #4492's pair is not a false positive to be carved out: a CANCELLED run
    measured nothing, neither was re-run, and that PR genuinely should not
    merge until they are. The remedy is a re-run, which is already in
    `permitted_unattended`.

    WHAT THIS GATE CANNOT SEE, stated here rather than left to be discovered.
    The population is the checks attached to the HEAD BEING MEASURED. A lane
    with no `pull_request` trigger publishes no check-run at a PR head and is
    therefore invisible to this arm -- by construction, not by omission.

    The named instance is #4547, and the CONDITION MATTERS more than the
    conclusion: `build-fiab-images-acr-tasks.yml` triggers on
    `workflow_dispatch`, `workflow_call` AND `push` -- but that push is
    `branches: [main]` (`:80-82`), and a PR head is never on `main`. THE
    INVARIANT IS `branches: [main]`, not "there is no push trigger". An earlier
    version of this comment said the latter, which was false at the time it was
    written: the reader who checks it finds a `push:` block, concludes the
    disclosure is stale, and learns nothing about the real condition. A
    tripwire that names the wrong condition cannot fire -- the thing it told
    you to watch for has already happened.

    So what would make these reds start blocking here is a `pull_request`
    trigger being added, or `branches:` being widened past `main`. Corroborated
    empirically, twice and independently: 0 ACR-lane checks across 22 PR heads
    (this lane) and across 40 merged heads (the reviewer's scan, whose only
    Trivy hits were `trivy.yml`'s, on 2 heads, both SUCCESS).

    Two consequences, both deliberate: the known-flaky objection to blocking
    does not apply, and NO allowlist, exemption or carve-out is built for it --
    a guard-weakening mechanism is a defect in its own right here; and this
    gate must not be read as saying anything about main-only or scheduled
    lanes. A red there is a P0 under `deploy-integrity.md` R1 and needs a
    different instrument.

    ADV-WAIT does NOT block, and is named in the GO line rather than left as a
    footnote. Blocking on it would mean waiting for every advisory check on
    every PR, including the 30-minute ones, and an in-progress or queued check
    has not said anything yet. The residual risk is stated in the line itself:
    a check still running can still turn red after this answer.

    `policy_says_no_go` is `policy.json`'s `merge_gate.advisory_red_is_a_no_go`,
    read by the caller and passed here. It is NOT a switch: setting it false
    does not relax the arm, it makes the arm refuse to answer, because this
    gate implements no permissive mode. A key that could turn a control off
    would be a skip valve; a key that can only take the control out of service
    is the authority being consulted.
    """
    if not policy_says_no_go:
        return False, (
            "policy.json declares merge_gate.advisory_red_is_a_no_go=false and this "
            "gate implements no such mode - it cannot answer, which is NO-GO, not a "
            "pass. Restore the key to true."
        )
    if not checks:
        return False, (
            "the rollup published NO checks at all, so this arm measured NOTHING - "
            "a clean advisory answer over an empty population is the "
            "green-over-zero-items shape (#4451), not a pass. See gate 4b for which "
            "of never-created / parked this is."
        )
    split = classify_advisory_checks(checks, required)
    waiting = (
        f" ADV-WAIT {len(split.wait)} still running ({', '.join(split.wait)}) - NOT "
        "counted as red, and a check still running can still turn red after this line."
        if split.wait else ""
    )
    if split.red or split.rerun:
        blocking = [
            (f"ADV-RED {len(split.red)}: {'; '.join(split.red)}." if split.red else ""),
            (f"ADV-RERUN {len(split.rerun)}: {'; '.join(split.rerun)} - the red has "
             "NOT been cleared; a re-run must actually MEASURE to clear it. Do not "
             "read a re-run's mere existence, or a re-run that skipped, as the red "
             "being cleared."
             if split.rerun else ""),
        ]
        return False, (
            " ".join(part for part in blocking if part)
            + " These are NOT required contexts, so branch protection will merge "
            "straight over them - which is exactly how #4540 shipped a red main. "
            "REMEDY: fix the check, or re-run it with `gh run rerun --failed` (both "
            "`rerun-ci` and `approve-parked-ci-run` are permitted unattended) and "
            "wait for the new answer. Do NOT merge past it. "
            f"[{split.population} advisory of {split.total_checks} published; "
            f"{len(split.clean)} clean]" + waiting
        )
    return True, (
        f"no advisory context is red: {len(split.clean)} clean of {split.population} "
        f"advisory ({split.total_checks} checks published in total). SCOPE: checks "
        "ATTACHED TO THIS HEAD only - a lane with no `pull_request` trigger publishes "
        "nothing here. The ACR image builds (#4547) DO have a push trigger, but it is "
        "`branches: [main]`, and a PR head is never on main - that branch filter is the "
        "invariant, not an absent trigger." + waiting
    )


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
# The `ci-green` receipt (#4487)
# ---------------------------------------------------------------------------
#
# The receipt used to read "every required context green AT THE MERGED SHA".
# That measurement is UNOBTAINABLE for most PRs in this repo, and it was found
# by trying to take the receipt for the first time -- on the harness's own
# merge, `a02cd41e6d42` (#4483):
#
#     15 required contexts (branch protection)
#     10 green at the merged sha
#      5 absent at the merged sha
#      0 RED
#
# None of the five is a failure or a flake:
#
#   * four (`Python Lint`, `PowerShell Lint`, `Secret Scan`, `Repo Hygiene`) are
#     published by `validate.yml`, whose `push:` trigger is PATH-FILTERED to
#     bicep/deploy/workflow paths. That merge touched `tools/`, `PRPs/`,
#     `pyproject.toml` and `.gitignore`, so the workflow correctly did not run.
#     The contexts are NEVER-CREATED at that sha -- not pending, not failing.
#   * the fifth is a RENAME, not an absence: `commit-message-parses.yml` gives
#     its job a conditional `name:`, so on `push` it publishes `changelog parser
#     can read what landed on main` while branch protection requires the
#     `pull_request` spelling. It ran at the merged sha and was green.
#
# A definition the topology cannot satisfy leaves exactly two outcomes: every
# guard/test-only issue is unclosable, or somebody quietly accepts 10-of-15 as
# "green" and the receipt stops meaning what it says. The second is the failure
# mode this whole toolchain exists to prevent.
#
# So the receipt is redefined to something that is both TRUE and TAKEABLE:
#
#     every required context that CAN run at the merged sha is green; every one
#     that cannot is NAMED, with its reason and its result on the PR head over
#     an IDENTICAL TREE.
#
# The load-bearing word is *named*. An absence is only excused when the harness
# can say WHY, from evidence -- the producing workflow's own trigger, read at
# the merged sha -- and every branch that cannot say why FAILS CLOSED. A version
# that excused absence generically would be the "quietly accept 10-of-15"
# outcome with a function wrapped around it.
#
# Nothing here is keyed to a context's SPELLING. The producer of each context is
# measured at the PR head (where it ran) via the workflow-run/jobs API, and the
# rename case is resolved by WORKFLOW IDENTITY -- the same workflow ran at the
# merged sha and concluded green under a different job name. A hardcoded alias
# list would be one rename away from being wrong, silently, which is the shape
# of defect this package keeps finding.


@dataclass(frozen=True)
class PushTrigger:
    """One workflow's `on.push` trigger, as it bears on a merged sha.

    `present` is False when the workflow has no `push` trigger at all, which is
    itself a complete explanation for a never-created context.
    """

    present: bool
    branches: tuple[str, ...] | None = None
    branches_ignore: tuple[str, ...] | None = None
    paths: tuple[str, ...] | None = None
    paths_ignore: tuple[str, ...] | None = None


def _as_tuple(value: object) -> tuple[str, ...] | None:
    if value is None:
        return None
    if isinstance(value, str):
        return (value,)
    if isinstance(value, list):
        return tuple(str(v) for v in value)
    return None


def parse_push_trigger(workflow_yaml: str) -> PushTrigger | None:
    """Parse `on.push` out of a workflow file. None means "could not read it".

    None and `PushTrigger(present=False)` are DIFFERENT answers and the caller
    treats them differently: the first is an unanswered question (fail closed),
    the second is a measured fact that explains an absence. Collapsing them
    would turn every unparseable workflow into a free pass.

    `on:` is the YAML 1.1 boolean `True` under PyYAML's default resolver, so a
    reader that only looks up the string key finds NOTHING in every real
    workflow file and concludes "no push trigger" -- i.e. it would excuse every
    absence in the repo. Both keys are consulted.
    """
    try:
        import yaml
    except ImportError:  # pragma: no cover - pyyaml is a declared dependency
        return None
    try:
        doc = yaml.safe_load(workflow_yaml)
    except Exception:
        return None
    if not isinstance(doc, dict):
        return None
    triggers = doc.get("on", doc.get(True))
    if isinstance(triggers, str):
        return PushTrigger(present=triggers == "push")
    if isinstance(triggers, list):
        return PushTrigger(present="push" in triggers)
    if not isinstance(triggers, dict):
        return None
    if "push" not in triggers:
        return PushTrigger(present=False)
    push = triggers["push"]
    if not isinstance(push, dict):
        # `push:` with an empty value -- every branch, every path.
        return PushTrigger(present=True)
    return PushTrigger(
        present=True,
        branches=_as_tuple(push.get("branches")),
        branches_ignore=_as_tuple(push.get("branches-ignore")),
        paths=_as_tuple(push.get("paths")),
        paths_ignore=_as_tuple(push.get("paths-ignore")),
    )


def _glob_to_regex(pattern: str) -> str:
    r"""GitHub filter-pattern semantics, not `fnmatch`.

    `fnmatch.translate` maps `*` to `.*`, which matches across `/` -- so
    `'*.bicep'` would match `deploy/x.bicep` and a top-level-only filter would
    silently excuse nothing. The three wildcards differ here:

        `**`  zero or more characters, INCLUDING `/`
        `*`   zero or more characters, EXCLUDING `/`
        `?`   exactly one character, EXCLUDING `/`

    `a/**/b` matches `a/b` as well as `a/x/y/b`: the `**/` is allowed to consume
    zero path segments together with its slash. `.github/workflows/**` therefore
    matches `.github/workflows/validate.yml`, and `deploy/**/*.bicep` matches
    `deploy/x.bicep` -- both of which a naive `**` -> `.*` translation gets
    wrong in the direction of excusing too much.
    """
    out = []
    i = 0
    while i < len(pattern):
        char = pattern[i]
        if char == "*":
            if pattern.startswith("**", i):
                if pattern.startswith("**/", i):
                    out.append("(?:.*/)?")
                    i += 3
                    continue
                if i > 0 and pattern[i - 1] == "/" and i + 2 == len(pattern):
                    # trailing `/**` -- the slash is already emitted, so let it
                    # match the directory itself too.
                    out.append(".*")
                    i += 2
                    continue
                out.append(".*")
                i += 2
                continue
            out.append("[^/]*")
        elif char == "?":
            out.append("[^/]")
        else:
            out.append(re.escape(char))
        i += 1
    return "^" + "".join(out) + "$"


#: Filter-pattern syntax this translator does NOT implement. `!` negates,
#: `[...]` is a character range, `+` and `(` are extglob-ish. Translating them
#: as LITERALS under-matches, and under-matching a positive `paths:` list is the
#: EXCUSING direction -- the filter looks like it admitted nothing, so an
#: absence gets excused. `!` under `paths-ignore:` is worse still: it re-includes
#: a path, so ignoring it can excuse outright.
#:
#: `?` is here for a DIFFERENT reason than the others, and the difference is
#: the point: it was not unimplemented, it was implemented WRONG. This
#: translator emitted `[^/]` for it -- one arbitrary character, the fnmatch
#: reading -- while GitHub documents `?` as "zero or one of the PRECEDING
#: character". Those disagree on real inputs, and the disagreement excuses in
#: both of the cases where GitHub admits. Measured on this checkout: 127
#: workflow files, 40 with an `on.push` trigger, and ZERO push filters contain
#: `?`, so refusing costs nothing and guessing costs correctness.
#:
#: Zero workflows in this repo use any of them today (measured), which is
#: exactly why refusing is free. A pattern this cannot represent is an
#: unanswered question, and unanswered questions fail closed here.
_UNSUPPORTED_GLOB = re.compile(r"[!\[\]+()@|?]")


class UnsupportedPatternError(ValueError):
    """A filter pattern this translator cannot represent faithfully."""


def glob_matches(pattern: str, path: str) -> bool:
    """Does one GitHub filter pattern match one path?

    Raises `UnsupportedPattern` rather than guessing. See `_UNSUPPORTED_GLOB`:
    silently treating `!` or `[0-9]` as literal text under-matches, and
    under-matching is the direction that EXCUSES an absence.
    """
    if _UNSUPPORTED_GLOB.search(pattern):
        raise UnsupportedPatternError(pattern)
    return re.match(_glob_to_regex(pattern), path) is not None


def _any_match(patterns: tuple[str, ...], values) -> bool:
    return any(glob_matches(p, v) for p in patterns for v in values)


def select_merged_run(runs, workflow_path: str, merged_sha: str) -> dict | None:
    """The `push` run of `workflow_path` AT the merged sha, or None.

    EXTRACTED FROM THE COLLECTOR SO IT CAN BE TESTED. The version that lived
    inline in `merge_gate.collect_ci_green_evidence` took the NEWEST run for a
    path with no event filter and no sha filter, and both independent reviewers
    built the same attack on it: a single sha carries many runs per path across
    `push`, `schedule`, `check_suite` and `issues` -- measured, 73 workflow runs
    at `a02cd41e6d42` with 10 paths carrying more than one -- so a RED `push`
    run followed by any green cron would supply the "rename" evidence.

    `push` is the only event that answers the question being asked. The
    required context is the `pull_request` spelling; what is being excused is
    that the `push` event published a different job name at this commit. A
    `schedule` or `workflow_dispatch` run is a different question with a
    different range, which `commit-message-parses.yml` states about itself in
    so many words.

    Newest-first among genuine candidates only, so a re-run of the push
    supersedes the original rather than a cron superseding both.
    """
    candidates = [
        run for run in runs
        if isinstance(run, dict)
        and run.get("path") == workflow_path
        and str(run.get("head_sha") or "") == merged_sha
        and str(run.get("event") or "").lower() == "push"
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda r: str(r.get("run_started_at") or ""))


def push_event_runs(
    trigger: PushTrigger, branch: str, changed_files
) -> tuple[bool, str]:
    """Would this workflow run on a push of `changed_files` to `branch`?

    Returns (runs, why). The `why` is the receipt's explanation text when the
    answer is False, so it names the filter and the population it was applied
    to rather than saying "filtered out".

    An EMPTY `changed_files` returns True with a reason saying the question was
    unanswerable: a path filter cannot be shown to exclude a set nobody
    measured, and "it did not run" must never be inferred from "I read no
    files". The caller turns a True here into a FAILURE (the context should
    have been created and was not), which is the fail-closed direction.
    """
    if not trigger.present:
        return False, "the producing workflow has no `push:` trigger at all"
    files = [f for f in changed_files if f]

    # An UNREPRESENTABLE pattern anywhere in this trigger makes the whole
    # question unanswerable, and it resolves to "it runs" -- which the receipt
    # turns into a FAILURE. Never into an excused absence.
    for label, patterns in (
        ("push.branches", trigger.branches),
        ("push.branches-ignore", trigger.branches_ignore),
        ("push.paths", trigger.paths),
        ("push.paths-ignore", trigger.paths_ignore),
    ):
        if patterns is None:
            continue
        for pattern in patterns:
            if _UNSUPPORTED_GLOB.search(pattern):
                return True, (
                    f"`{label}` contains {pattern!r}, which this translator cannot "
                    "represent faithfully - refusing to guess rather than under-match"
                )

    if trigger.branches is not None and not _any_match(trigger.branches, [branch]):
        return False, (
            f"`push.branches` {list(trigger.branches)} does not match {branch!r}"
        )
    if trigger.branches_ignore is not None and _any_match(trigger.branches_ignore, [branch]):
        return False, (
            f"`push.branches-ignore` {list(trigger.branches_ignore)} matches {branch!r}"
        )
    if trigger.paths is not None:
        if not files:
            return True, "no changed files were measured, so no path filter can be shown to exclude them"
        if not _any_match(trigger.paths, files):
            return False, (
                f"`push.paths` {list(trigger.paths)} matches none of the "
                f"{len(files)} changed file(s)"
            )
    if trigger.paths_ignore is not None and files:
        unignored = [f for f in files if not _any_match(trigger.paths_ignore, [f])]
        if not unignored:
            return False, (
                f"`push.paths-ignore` {list(trigger.paths_ignore)} matches all "
                f"{len(files)} changed file(s)"
            )
    return True, "the `push:` trigger admits this commit"


@dataclass(frozen=True)
class ContextEvidence:
    """Everything measured about ONE required context, for the receipt.

    Collected by `merge_gate.collect_ci_green_evidence`; this module never
    reaches the network, so every branch below is reachable from a fixture.

    `workflow_path` is measured at the PR HEAD -- the event where the context
    demonstrably ran -- because that is the only place a context that is absent
    at the merged sha can be traced back to a producer. `None` means the trace
    failed, and an untraceable absence is NO, not an excuse.
    """

    name: str
    workflow_path: str | None = None
    merged_check: dict | None = None
    head_check: dict | None = None
    merged_workflow_run: dict | None = None
    #: The JOBS of `merged_workflow_run`, as dicts carrying at least `name`,
    #: `conclusion` and `steps`. This used to be a tuple of bare NAMES that the
    #: receipt read only to PRINT -- the evidence that would prove a rename was
    #: gathered and then discarded, and both independent reviewers found it.
    merged_workflow_jobs: tuple[dict, ...] = ()
    #: The PR-head job behind `head_check`, same shape. Needed because a green
    #: check is not proof that anything RAN: `test.yml` reports SUCCESS on
    #: `pull_request` with `Run pytest`, `Lint with ruff` and `mypy` all
    #: `skipped`, BY DESIGN, and runs the real suite only on `push`. Measured on
    #: PRs #4440 and #4437, whose deferral this receipt used to accept.
    head_job: dict | None = None
    #: The job behind `merged_check`, same shape. `green-at-merge` needs it for
    #: exactly the reason `deferred-to-head` needs `head_job`: a green
    #: conclusion is not evidence the check did its work.
    merged_job: dict | None = None
    push_trigger: PushTrigger | None = None


@dataclass(frozen=True)
class ContextResult:
    """One required context's standing in the receipt."""

    name: str
    state: str          # green-at-merge | renamed-at-merge | deferred-to-head | FAIL
    detail: str

    @property
    def ok(self) -> bool:
        return self.state != "FAIL"


@dataclass(frozen=True)
class CiGreenReceipt:
    ok: bool
    contexts: tuple[ContextResult, ...] = ()
    reasons: tuple[str, ...] = ()

    def by_state(self, state: str) -> list[ContextResult]:
        return [c for c in self.contexts if c.state == state]

    @property
    def summary(self) -> str:
        counts = {}
        for context in self.contexts:
            counts[context.state] = counts.get(context.state, 0) + 1
        shape = ", ".join(f"{k}={v}" for k, v in sorted(counts.items()))
        return f"{'GREEN' if self.ok else 'NOT GREEN'} ({shape or 'no contexts'})"


def ci_green_receipt(
    evidence,
    *,
    merged_total_count: int,
    merged_changed_files,
    merged_sha: str,
    merged_branch: str = "main",
    trees_identical: bool,
    policy: dict,
    infra_ere: str | None = None,
) -> CiGreenReceipt:
    """The `ci-green` receipt, as a measurement that can actually be taken.

    Per required context, worst-first, every unanswered question failing closed:

    1. **Present at the merged sha** -- green closes it; RED and INCOMPLETE
       fail. Reuses the same two vocabularies `classify_checks` reads, so a
       StatusContext `ERROR` is not scored green here either.
    2. **Absent, producer untraceable** -- FAIL. "I could not find out why" is
       not a reason a receipt may contain (`deploy-integrity.md` R7).
    3. **Absent, but the producing workflow RAN at the merged sha and concluded
       green** -- the context was renamed for this event, which is the
       `commit-message-parses.yml` shape. Resolved by workflow IDENTITY, never
       by an alias table, and the sibling job names are recorded.
    4. **Absent, and the producing workflow was NEVER CREATED at the merged
       sha** -- only excused when its own `push:` trigger, read at that sha,
       says it could not have run. Then the result is deferred to the PR head,
       and ONLY over an identical tree: a head green over a different tree is a
       statement about a tree that was not merged.
    5. Anything else -- FAIL.

    `merged_total_count` guards the whole receipt through `classify_missing`: if
    the merged sha carries ZERO check-runs, nothing ran at all and every
    "absence" above would be excused one by one into a vacuous pass.
    """
    contexts: list[ContextResult] = []
    reasons: list[str] = []

    if classify_missing(merged_total_count, waiting=False) == "never-created":
        return CiGreenReceipt(
            ok=False,
            reasons=(
                ("the merged sha carries ZERO check-runs - nothing ran there at all, "
                 "so no per-context absence can be excused"),
            ),
        )

    for item in evidence:
        result = _one_context(
            item,
            merged_changed_files=merged_changed_files,
            merged_branch=merged_branch,
            merged_sha=merged_sha,
            trees_identical=trees_identical,
            policy=policy,
            infra_ere=infra_ere,
        )
        contexts.append(result)
        if not result.ok:
            reasons.append(f"{result.name}: {result.detail}")

    if not contexts:
        return CiGreenReceipt(
            ok=False,
            reasons=("no required contexts were measured - an empty receipt is not a green one",),
        )
    return CiGreenReceipt(ok=not reasons, contexts=tuple(contexts), reasons=tuple(reasons))


def _one_context(
    item: ContextEvidence,
    *,
    merged_changed_files,
    merged_branch: str,
    merged_sha: str,
    trees_identical: bool,
    policy: dict,
    infra_ere: str | None = None,
) -> ContextResult:
    if item.merged_check is not None:
        verdict, status = _outcome(item.merged_check)
        if verdict in RED_CONCLUSIONS:
            return ContextResult(item.name, "FAIL", f"RED at the merged sha ({verdict})")
        if not verdict or verdict in INCOMPLETE_STATUSES or status in INCOMPLETE_STATUSES:
            return ContextResult(
                item.name, "FAIL",
                f"INCOMPLETE at the merged sha (state={verdict or status or 'unknown'})",
            )
        if verdict == "SKIPPED":
            return ContextResult(
                item.name, "FAIL",
                "SKIPPED at the merged sha - a required context that ran nothing is not a pass",
            )
        # KNOWN DISAGREEMENT, RECORDED RATHER THAN DEFERRED SILENTLY (#4491
        # round 16 review, finding 6). This branch decides green NEGATIVELY --
        # "not RED, not INCOMPLETE, not SKIPPED" -- while the deferral branch
        # ~80 lines below asks `verdict != "SUCCESS"` POSITIVELY. The two
        # vocabularies agree on every conclusion except one:
        #
        #   NEUTRAL  ->  green here, refused there.
        #
        # A reviewer demonstrated it end to end; the receipt literally prints
        # `green at the merged sha (NEUTRAL)`. `neutral` is the Checks API's
        # "ran, made no determination", which is the exact shape this package
        # refuses everywhere else, and the string `neutral` appears nowhere in
        # `tools/drain/` -- not in policy.json, not in a test, not in an arm. So
        # it is undocumented, untested and unarmed.
        #
        # NOT CHANGED IN THIS ROUND, and the reason is scope rather than
        # disagreement: refusing NEUTRAL here makes the gate STRICTER, which is
        # the direction this package normally moves, but it changes the merge
        # verdict for every PR the harness gates while three are mid-flight
        # against it. A semantics change to the instrument, made by the author
        # of the work the instrument is judging, is not something to slip into a
        # round that exists to fix stale numbers. Tracked as issue #4518 with the
        # measurement, and the two predicates over one question are named here
        # so the next reader does not have to re-derive the contradiction.
        # A GREEN CONCLUSION IS NOT EVIDENCE THE CHECK DID ITS WORK, and this
        # branch carries 14 of 15 contexts on a typical PR. It used to return a
        # pass on the conclusion alone -- the same defect the deferral branch
        # had, one branch along, which is this package's most persistent shape.
        # Live at the time it was found: PR #4488 returned RECEIPT: GREEN while
        # `next build (node 20)` concluded success with `Build (next build)`
        # SKIPPED behind a change-detection gate.
        did_work, evidence, route = context_is_accounted_for(
            item.name, item.merged_job, merged_changed_files, policy,
            infra_ere=infra_ere,
        )
        if not did_work:
            return ContextResult(
                item.name, "FAIL",
                f"green at the merged sha ({verdict}), but {evidence}",
            )
        if route == ACCOUNTED_SCOPE_SKIP:
            return ContextResult(
                item.name, ACCOUNTED_SCOPE_SKIP,
                f"green at the merged sha ({verdict}); it skipped its declared work, and "
                f"{evidence}",
            )
        if route == ACCOUNTED_ALTERNATIVE:
            # REPORTED SEPARATELY FROM `green-at-merge`, because it is a
            # different claim. Its declared substantive step was SKIPPED, and an
            # independent reviewer pointed out that folding it in makes the one
            # line a reader acts on say twelve contexts executed their check when
            # eleven did and one did the other half of its job. The README
            # already refuses that fold for `scope-untouched-at-merge`; the
            # asymmetry was the defect.
            return ContextResult(
                item.name, ACCOUNTED_ALTERNATIVE,
                f"green at the merged sha ({verdict}); it {evidence}",
            )
        return ContextResult(
            item.name, ACCOUNTED_DID_WORK,
            f"green at the merged sha ({verdict}), and it {evidence}",
        )

    if not item.workflow_path:
        return ContextResult(
            item.name, "FAIL",
            "absent at the merged sha and its producing workflow could not be traced "
            "from the PR head - an absence nobody can explain is not an excused one",
        )

    if item.merged_workflow_run is not None:
        return _renamed_at_merge(
            item, merged_sha=merged_sha,
            merged_changed_files=merged_changed_files, policy=policy,
            infra_ere=infra_ere,
        )

    if item.push_trigger is None:
        return ContextResult(
            item.name, "FAIL",
            f"absent at the merged sha and the `on.push` trigger of {item.workflow_path} "
            "could not be read there - fail closed rather than assume it was filtered out",
        )

    runs, why = push_event_runs(item.push_trigger, merged_branch, merged_changed_files)
    if runs:
        return ContextResult(
            item.name, "FAIL",
            f"absent at the merged sha although {item.workflow_path} SHOULD have run there "
            f"({why}) - that is a missing check, not a structural absence",
        )
    if not trees_identical:
        return ContextResult(
            item.name, "FAIL",
            f"structurally absent at the merged sha ({why}), and the PR head result cannot "
            "stand in for it because the merged tree differs from the PR head tree - "
            f"dispatch {item.workflow_path} at the merged sha to obtain it",
        )
    if item.head_check is None:
        return ContextResult(
            item.name, "FAIL",
            f"structurally absent at the merged sha ({why}) and absent on the PR head too - "
            "there is no result anywhere to defer to",
        )
    verdict, status = _outcome(item.head_check)
    if verdict != "SUCCESS":
        return ContextResult(
            item.name, "FAIL",
            f"structurally absent at the merged sha ({why}) and its PR-head result is "
            f"{verdict or status or 'unknown'}, not green",
        )
    # A GREEN THAT RAN NOTHING IS NOT A RESULT TO DEFER TO, and this is the
    # branch both independent reviewers blocked on. `test.yml` publishes
    # `Python Tests (3.x)` on BOTH events and, on `pull_request`, reports
    # SUCCESS with `Run pytest with coverage`, `Lint with ruff` and `mypy` all
    # `skipped` -- by design, documented in the workflow, because the real suite
    # is meant to run on `push`. Deferring a path-filtered context to that green
    # is precisely "quietly accept 10-of-15" wearing a function.
    #
    # Measured live before this check existed: the receipt returned GREEN for
    # #4440 and #4437 on exactly that job (run 34483464251). It is 3 of 11
    # deferrals, not all of them -- `dbt Compile (shared)` on the same run is
    # genuine, 0 of 9 steps skipped -- so the fix has to read the STEPS rather
    # than distrust deferral as a category.
    ran, evidence, route = context_is_accounted_for(
        item.name, item.head_job, merged_changed_files, policy,
        push_trigger=item.push_trigger, infra_ere=infra_ere,
    )
    if not ran:
        return ContextResult(
            item.name, "FAIL",
            f"structurally absent at the merged sha ({why}), and its PR-head run is green "
            f"but {evidence} - a check that executed nothing is not a result to defer to; "
            f"dispatch {item.workflow_path} at the merged sha instead",
        )
    if route == ACCOUNTED_SCOPE_SKIP:
        return ContextResult(
            item.name, ACCOUNTED_SCOPE_SKIP,
            f"structurally absent at the merged sha ({why}); green on the PR head over an "
            f"identical tree, where it skipped its declared work, and {evidence}",
        )
    if route == ACCOUNTED_ALTERNATIVE:
        return ContextResult(
            item.name, ACCOUNTED_ALTERNATIVE,
            f"structurally absent at the merged sha ({why}); green on the PR head over an "
            f"identical tree, where it {evidence}",
        )
    return ContextResult(
        item.name, "deferred-to-head",
        f"structurally absent at the merged sha ({why}); green on the PR head over an "
        f"identical tree, and it {evidence}",
    )


def context_did_its_work(name: str, job: dict | None, policy: dict) -> tuple[bool, str]:
    """Did THIS context execute the step that IS the check?

    WHICH step, not how many, and the distinction is the whole control.
    Measured 2026-09-13 over 24 `green-at-merge` contexts on PRs #4483 and
    #4488, a proportion cannot decide it:

        Python Tests (3.10)    9% skipped -> `Coverage summary`      LEGITIMATE
        vitest (node 20)      38% skipped -> `Run vitest (...)`      HOLLOW
        next build (node 20)  92% skipped -> `Build (next build)`    HOLLOW

    `vitest` skipped the step that IS the check while sitting at a LOWER
    proportion than a job that skipped only a trailing report. Any threshold
    that accepts the second accepts the first.

    Nor can it be inferred from names: `_is_bookkeeping_step` already
    misclassifies six real step names (`Post HIGH findings to PR`) in the
    EXCUSING direction, which is what a name-shaped guess buys you.

    So it is DECLARED in `policy.json` under
    `receipts.ci_green_rule.substantive_steps`, read off real green runs. A
    context absent from that map FAILS CLOSED -- the alternative is a receipt
    that silently stops checking whenever someone adds a required context.

    `"ALL"` means every work step must have run, for contexts whose work is
    spread across many steps (`guardrails` has 158) rather than concentrated in
    one. A LIST names the steps that must have executed, matched as substrings
    so a step's parenthetical detail can change without breaking the receipt.
    """
    declared = (
        policy.get("receipts", {})
        .get("ci_green_rule", {})
        .get("substantive_steps", {})
    )
    if name not in declared:
        return False, (
            f"no substantive step is DECLARED for {name!r} in policy.json "
            "(receipts.ci_green_rule.substantive_steps) - an undeclared context "
            "fails closed rather than silently stop being checked"
        )
    if not isinstance(job, dict):
        return False, "no job record was read for it, so it cannot be shown to have run"
    # THE JOB'S OWN VERDICT, which this path never read. Round 14: `green-at-
    # merge` and the deferral path asked only about STEPS, so a job that
    # concluded `failure` was accepted as having "executed its declared
    # substantive step" -- and an independent reviewer proved the job join
    # PREFERS that failed job over its green twin. `_renamed_at_merge` has
    # always read this field; the other two routes did not, and a receipt is
    # only as good as its least-asked route.
    job_verdict = step_conclusion(job)
    if job_verdict is None:
        return False, (
            "its job record has not concluded, so it is still running and "
            "cannot yet be shown to have done its work"
        )
    if job_verdict != "success":
        return False, (
            f"its job concluded {job_verdict!r}, not success - a job that did "
            "not pass has not done the thing it is required for, whatever its "
            "individual steps say"
        )
    steps = job.get("steps")
    if not isinstance(steps, list) or not steps:
        return False, "its job record carries no steps, so it cannot be shown to have run"

    work = [
        s for s in steps
        if isinstance(s, dict) and not _is_bookkeeping_step(str(s.get("name") or ""))
    ]
    if not work:
        return False, (
            f"all {len(steps)} of its steps are runner bookkeeping - no work steps at all"
        )

    # A STEP THAT HAS NOT CONCLUDED IS NEITHER RUN NOR SKIPPED, and this is the
    # SEVENTH reader of that field. Round 13 fixed `scope_untouched_at_merge`
    # and called it a root-cause fix; an independent reviewer showed it landed
    # on ONE OF THREE ROUTES. Here the consequence is `green-at-merge`: an
    # in-progress job whose declared step had already succeeded was accepted,
    # and `merge_gate`'s job join PREFERS that job in both input orders.
    unfinished = [
        str(s.get("name") or "?") for s in work if not step_has_concluded(s)
    ]
    if unfinished:
        return False, (
            f"{len(unfinished)} of its work step(s) have NOT CONCLUDED "
            f"({', '.join(unfinished[:3])}) - this job is still running, so it "
            "cannot yet be shown to have done the thing it is required for"
        )

    def ran(step: dict) -> bool:
        return step_conclusion(step) != "skipped"

    rule = declared[name]
    if rule == "ALL":
        skipped = [s for s in work if not ran(s)]
        if skipped:
            names = ", ".join(str(s.get("name") or "?")[:40] for s in skipped[:3])
            return False, (
                f"declared ALL, and {len(skipped)} of its {len(work)} work step(s) "
                f"are SKIPPED ({names})"
            )
        return True, f"declared ALL; every one of its {len(work)} work step(s) ran"

    if not isinstance(rule, list) or not rule:
        return False, (
            f"the declaration for {name!r} is {rule!r}, which is neither \"ALL\" nor a "
            "non-empty list of step names"
        )

    missing, hollow, ambiguous = [], [], []
    for wanted in rule:
        # EVERY matching step, and EVERY one of them must have run. This used to
        # be `any(ran(s) for s in matches)`, and an independent reviewer's
        # mutation arm truncated the match list to `[:1]` and SURVIVED: with
        # `any`, one running step satisfied a declaration no matter how many
        # others matched and skipped, so narrowing the population was
        # unobservable. A filter placed INSIDE the predicate beats a contract
        # written about the predicate -- which is the whole lesson of the `N*`
        # arms. `all` makes the size of the match set load-bearing, so a
        # truncation changes an answer and a test can see it.
        matches = [s for s in work if wanted in str(s.get("name") or "")]
        if not matches:
            missing.append(wanted)
            continue
        skipped = [s for s in matches if not ran(s)]
        if len(skipped) == len(matches):
            hollow.append(wanted)
        elif skipped:
            ambiguous.append(
                f"{wanted!r} matches {len(matches)} steps and {len(skipped)} of them "
                "are SKIPPED"
            )
    if missing:
        return False, (
            f"the declared step(s) {missing} are ABSENT from this job - the declaration "
            "is stale, or this is not the job it describes; re-read it off a green run"
        )
    if ambiguous:
        # ASKED BEFORE `hollow` IS ACTED ON. A declaration that matched several
        # steps with a MIXED outcome cannot say which one is the check, and
        # round 5 answered a hollow primary with an alternative BEFORE reaching
        # this refusal -- so a two-entry declaration with one hollow entry and
        # one ambiguous entry returned a pass and this sentence was never
        # printed. An independent reviewer demonstrated it synthetically; it was
        # latent only because both rows that declare alternatives name exactly
        # one primary step.
        return False, (
            "a declaration matched several steps with a MIXED outcome, so which one "
            f"is the check cannot be decided from it: {'; '.join(ambiguous)} - make "
            "the declaration name exactly one step"
        )
    if hollow:
        # NO ALTERNATIVE IS CONSULTED HERE, and that is the fix for round 6's
        # blocker. Round 5 accepted "a declared alternative ran" as the context
        # having done its work, inside this function -- which has no
        # `changed_files` and cannot ask the only question that makes such an
        # acceptance safe. `context_is_accounted_for` returned on `did` before
        # the merged file list was ever consulted, so the `hits` refusal (a
        # change detector that MISSED a change, the #3783 shape `policy.json`
        # says must never be laundered) became unreachable whenever any
        # alternative ran. Two reviewers found it independently, on different
        # rows, and the same input that round 4 REFUSED round 5 ACCEPTED.
        #
        # So the alternative lives in `alternative_accounted_for`, which asks
        # the scope question and this one as two halves of a single predicate.
        return False, (
            f"its declared substantive step(s) {hollow} were SKIPPED - the check "
            "concluded green having not done the thing it is required for"
        )
    return True, f"executed its declared substantive step(s) {list(rule)}"


#: A `scope_paths` output may declare its scope to BE the producing workflow's
#: own `on.push.paths` rather than a copy of it. Used where the workflow's in-job
#: detector parses that key out of the file itself, so a second list in
#: `policy.json` would be the drift the workflow explicitly refuses to carry.
ON_PUSH_PATHS = "on.push.paths"

#: The same delegation, for a scope that is COMPUTED rather than written down.
#: `fiab-console-ci.yml`'s vitest detector derives its `infra` ERE by running
#: `node scripts/ci/derive-infra-reading-suites.mjs --ere` over the tree, so
#: there is no list to copy and any copy would be stale the moment a suite moves.
#: The value is resolved by the CALLER and injected, exactly as `push_trigger`
#: is -- `gates.py` runs no subprocess, so the decision function stays pure and a
#: test can drive both the resolved and the unresolvable case.
INFRA_READING_ERE = "derive-infra-reading-suites.mjs --ere"

#: The routes by which a green required context can be ACCOUNTED FOR. Returned
#: by `context_is_accounted_for` as the third element so the collector names the
#: route rather than re-deriving it, and so the three cannot be folded into one
#: another in a summary line. They are genuinely different claims:
#:
#:   DID_WORK     it executed the step that IS the check
#:   ALTERNATIVE  it skipped that step and executed a declared OTHER half of the
#:                same job, with the merged files outside the primary's scope
#:   SCOPE_SKIP   it skipped that step, ran nothing at all, and the merged files
#:                are outside every scope the job gates work on
#:
#: An independent reviewer found ALTERNATIVE being counted inside DID_WORK: on
#: #4488 that is the difference between `green-at-merge=13` and `12 + 1`, and the
#: per-context detail was honest while the summary a reader acts on was not.
ACCOUNTED_DID_WORK = "green-at-merge"
ACCOUNTED_ALTERNATIVE = "alternative-work-at-merge"
ACCOUNTED_SCOPE_SKIP = "scope-untouched-at-merge"


def context_is_accounted_for(
    name: str, job: dict | None, changed_files, policy: dict,
    push_trigger: PushTrigger | None = None,
    infra_ere: str | None = None,
) -> tuple[bool, str, str]:
    """ONE question -- is this green check accounted for? -- asked in one place.

    Returns `(ok, evidence, route)`, where `route` is one of
    `ACCOUNTED_DID_WORK`, `ACCOUNTED_ALTERNATIVE`, `ACCOUNTED_SCOPE_SKIP`, or
    `""` when the answer is no.

    A green check is accounted for by exactly one of three routes:

    1. it EXECUTED its declared substantive step;
    2. it skipped that step and executed a declared ALTERNATIVE -- the other
       half of a job whose work is gated on more than one output -- **with the
       merged files outside the primary's declared scope**;
    3. it skipped that step, ran nothing at all, and the merged commit's own
       file list falls outside every scope the job gates work on.

    Every branch of the receipt goes through here. Three of them used to ask the
    question with three different predicates -- `green-at-merge` and
    `deferred-to-head` called `context_did_its_work` while `_renamed_at_merge`
    called `job_executed` -- and "two predicates over the same question" is
    exactly the shape that produced the original hole: the deferral branch was
    fixed, the green-at-merge branch was not, and a reviewer found it one round
    later. A single entry point is not tidiness; it is what makes "fixed on one
    side only" impossible to write.

    AND IT WAS NOT TRUE OF THE JOB'S OWN CONCLUSION until #4518 finding 5, which
    is what the check below the docstring now fixes. Round 14 added a job-level
    conclusion check -- refuse a job that did not conclude, refuse one that
    concluded non-`success` -- and it landed
    on ONE of the three routes. Route 1 `context_did_its_work` reads it (the
    `step_conclusion` call and the two refusals immediately below it, in this
    file); route 2
    `scope_untouched_at_merge` and route 3 `alternative_accounted_for` read no
    job-level conclusion at all -- and STILL DO NOT, deliberately: the check is
    asked once, here, rather than copied into each of them, because three copies
    is the defect one more time. A reviewer demonstrated the hole against the
    real unmodified `next build (node 20)` policy row:

        job.conclusion='success'   -> ok=True route='scope-untouched-at-merge'
        job.conclusion='failure'   -> ok=True route='scope-untouched-at-merge'
        job.conclusion='cancelled' -> ok=True route='scope-untouched-at-merge'
        job.conclusion=None        -> ok=True route='scope-untouched-at-merge'

    So this docstring's own claim -- that a single entry point makes "fixed on
    one side only" impossible -- is exactly what round 14 then wrote, one level
    up from where round 13 wrote it. The paragraph above describes the defect
    the paragraph is in.

    The `None` row is the one that matters, because `merge_gate._jobs_by_name`
    deliberately prefers "the one that executed LESS", so an in-progress
    duplicate wins the join -- which is the documented input rounds 13 and 14
    exist for. End-to-end reachability is LOW (an in-progress job usually
    publishes an in-progress check-run, and `worst_by_name` scores it INCOMPLETE
    first), but that is a coincidence of the rollup, not a control, and this
    package does not rest a stop on a coincidence.

    NOW FIXED, as its own change (#4518 finding 5), for the reason the deferral
    itself named: the remedy is either three lines in each route or lifting the
    job-verdict read into THIS function, and the second is the one that cannot
    be got half-right. It is lifted, below, before any route runs. It was held
    back for several rounds because it changes what the merge gate accepts and
    three PRs were mid-flight against it -- changing the instrument's verdict,
    authored by the same hand as the work it was judging, did not belong in a
    round convened to correct stale numbers. Those PRs have landed, so it ships
    alone, where its effect on the estate is the only thing being read.

    The remedy is STRICTLY STRICTER and one-directional: it can only turn an
    acceptance into a refusal, never the reverse, and it fails visibly when it
    does. Tracked as #4518; the finding was recorded with its measurement so
    the next reader inherited it rather than the silence, after a reviewer
    filtered all 400 open issues and found that an earlier "tracked separately"
    here named nothing -- an unconsulted claim in a tracked file, the defect
    class this package exists to refuse, written into its own deferral.

    THE ORDER OF 2 AND 3 IS NOT ARBITRARY and neither may skip the other's
    question. Round 5 put the alternative inside `context_did_its_work`, which
    receives no `changed_files`, so route 2 returned a pass before route 3's
    scope corroboration was ever reached -- and the `hits` refusal, the one
    check watching for a detector that MISSED a change, became unreachable
    whenever an alternative ran. Both reviewers reproduced it: the identical
    input that round 4 refused with "that is a change detector that missed a
    change", round 5 accepted as `green-at-merge`. Routes 2 and 3 now share
    `_merged_files_outside_scope`, so the file-list question is asked on every
    route that accepts a SKIPPED primary, and the two are halves of one
    predicate rather than two branches that can each bypass the other.
    """
    # THE JOB'S OWN VERDICT, ASKED ONCE, BEFORE ANY ROUTE (#4518 finding 5).
    #
    # Round 14 added this check and it landed on ROUTE 1 ONLY. Routes 2 and 3
    # read no job-level conclusion at all, so a job that concluded `failure`,
    # `cancelled`, or NOT AT ALL was still accepted as `scope-untouched-at-merge`.
    # Measured by a reviewer against the real unmodified `next build (node 20)`
    # policy row -- detector `success`, all work steps `skipped`, `Post Checkout`
    # failing:
    #
    #     job.conclusion='success'    -> ok=True route='scope-untouched-at-merge'
    #     job.conclusion='failure'    -> ok=True route='scope-untouched-at-merge'
    #     job.conclusion='cancelled'  -> ok=True route='scope-untouched-at-merge'
    #     job.conclusion=None         -> ok=True route='scope-untouched-at-merge'
    #
    # The `None` row is the one that matters: `merge_gate._jobs_by_name`
    # deliberately prefers "the one that executed LESS", so an in-progress
    # duplicate wins the join -- the documented input rounds 13 and 14 exist for.
    #
    # THIS IS THE SHAPE THE DOCSTRING ABOVE FORBIDS, written into the function
    # that forbids it. "A single entry point is not tidiness; it is what makes
    # 'fixed on one side only' impossible to write" -- and then round 14 wrote
    # it, one level up from where round 13 had.
    #
    # Deferred for several rounds on the argument that end-to-end reachability
    # is low, because an in-progress job usually publishes an in-progress
    # check-run and `worst_by_name` scores it INCOMPLETE first. That is true and
    # it is not a control: it is a coincidence of the rollup, and the deferral
    # said so in the same breath as resting on it.
    #
    # Asked HERE rather than added to each route, because three copies is the
    # defect one more time. Every route below accepts a job as having accounted
    # for a context; none of them may do so for a job that did not conclude
    # successfully.
    #
    # THE `isinstance` GUARD IS NOT DEFENSIVE PADDING -- it is load-bearing, and
    # omitting it crashed the negative control on the first run of this change.
    # `job` is `dict | None` by signature, `step_conclusion` does `step.get(...)`,
    # and a `None` job reaches here whenever no job record was read. Route 1
    # guards it the same way before its own `step_conclusion`; the guard has to
    # move up with the check it protects, not stay behind with the route that
    # used to own it.
    if not isinstance(job, dict):
        return False, (
            "no job record was read for it, so nothing about it can be shown - "
            "not that it did its work, not that its skip was scope-appropriate, "
            "and not that an alternative covered it"
        ), ""
    job_verdict = step_conclusion(job)
    if job_verdict is None:
        return False, (
            "its job record has not concluded, so nothing about it can be "
            "shown yet - not that it did its work, not that its skip was "
            "scope-appropriate, and not that an alternative covered it"
        ), ""
    if job_verdict != "success":
        return False, (
            f"its job concluded {job_verdict!r}, not success - no route can "
            "account for a context whose job did not pass, whatever its "
            "individual steps, its scope, or its alternatives say"
        ), ""

    did, evidence = context_did_its_work(name, job, policy)
    if did:
        return True, evidence, ACCOUNTED_DID_WORK
    excused, why = scope_untouched_at_merge(
        name, job, changed_files, policy,
        push_trigger=push_trigger, infra_ere=infra_ere)
    if excused:
        return True, why, ACCOUNTED_SCOPE_SKIP
    alt_ok, alt_why = alternative_accounted_for(
        name, job, changed_files, policy,
        push_trigger=push_trigger, infra_ere=infra_ere)
    if alt_ok:
        return True, alt_why, ACCOUNTED_ALTERNATIVE
    return False, (
        f"{evidence}. Nor is that a scope skip: {why}. "
        f"Nor a declared alternative: {alt_why}"
    ), ""


def scope_untouched_at_merge(
    name: str, job: dict | None, changed_files, policy: dict,
    push_trigger: PushTrigger | None = None,
    infra_ere: str | None = None,
) -> tuple[bool, str]:
    """Was the substantive step skipped because this context's SCOPE did not change?

    #4487 round 4. `context_did_its_work` correctly refuses a check that
    concluded green having skipped the step that IS the check -- and that made
    `ci-green` UNOBTAINABLE FOR THE EXACT CLASS IT CLOSES. A guard/test-only PR
    is by construction one that does not touch `apps/fiab-console`, so
    `next build (node 20)` and `vitest (node 20)` correctly skip their build and
    test steps behind an in-job change detector and conclude SUCCESS. Measured:
    both drain merges in the window, #4483 and #4488 -- the two PRs this receipt
    exists for, including the harness's own merge -- returned NOT GREEN for
    exactly those two contexts, 0 for 2 on the population it serves.

    That is #4487's own thesis reproduced one branch along: a definition the
    topology cannot satisfy leaves every guard/test-only issue unclosable, or
    somebody quietly accepts. The receipt excused a PATH-FILTERED workflow and
    refused the structurally identical IN-JOB change-detection skip -- the only
    difference being whether the filter lives in `on.push.paths` or in a shell
    step, which is a fact about where GitHub lets you write a filter, not about
    how much the merge was checked.

    So this is the same measurement the path-filter branch takes, against the
    same population. `push_event_runs` proves a workflow could not have run by
    applying its DECLARED filter to the merged commit's changed files; this
    proves a step could not have run by applying its DECLARED scope to the same
    list. `merge_gate` reads that list with `git show --name-only <merged>`,
    which is the very range the on-push detector computes for itself
    (`HEAD~1...HEAD`), so this corroborates the detector against its own input
    rather than trusting its output.

    It is an EXCUSE, never a shortcut, and every unanswered question fails
    closed:

    - no declared row for the context -> no excuse. An undeclared context
      cannot reach this branch at all.
    - the gate step is absent from the job, or did not run, or did not conclude
      success -> we do not know why the substantive step skipped.
    - a declared substantive step concluded anything other than `skipped`
      (failed, cancelled, absent) -> that is not a scope skip.
    - the merged changed-file list is empty -> nothing to measure against.
    - ANY changed file matches the declared scope -> FAIL, loudly. The detector
      skipped work it should have done, which is the #3783 shape and a real
      defect rather than an excuse.
    """
    row = _scope_row(name, policy)
    if row is None:
        return False, (
            f"no change-detection scope is DECLARED for {name!r} in policy.json "
            "(receipts.ci_green_rule.scope_paths), so its skip cannot be excused "
            "as a scope skip"
        )
    gate_step = str(row.get("gate_step") or "")
    if not isinstance(job, dict) or not isinstance(job.get("steps"), list):
        return False, "no job record was read for it, so its skip cannot be explained"
    steps = [s for s in job["steps"] if isinstance(s, dict)]

    gate_ok, gate_why, detectors = _declared_gate_ran(row, steps)
    if not gate_ok:
        return False, gate_why

    hollow_ok, hollow_why = _primary_steps_all_skipped(name, steps, policy)
    if not hollow_ok:
        return False, hollow_why

    files = [str(f) for f in (changed_files or []) if str(f).strip()]
    # "NOTHING FOR IT TO DO" MUST BE TRUE WHEN IT IS PRINTED (R7), and so must
    # every refusal on the way there. This is asked BEFORE the scope comparison
    # because a job that ran its other half would otherwise be refused with
    # "that is a change detector that missed a change" -- a sentence about a
    # detector that did NOT miss anything, since the matching scope is exactly
    # why the alternative ran. Round 6 introduced that inversion by adding the
    # second output and left the order alone; the order IS the claim.
    #
    # It closes the BENIGN direction only, and that is stated because round 5's
    # reply claimed more for it. A detector that wrongly reports FALSE runs
    # nothing, so `did_run` is empty and this assertion is silent -- the
    # dangerous direction is closed by `_merged_files_outside_scope` asking
    # EVERY output below, which is what makes an under-declared row impossible
    # rather than merely unlikely.
    # A STEP THAT HAS NOT CONCLUDED IS NOT A STEP THAT DID NOT RUN. Round 13:
    # this read `conclusion or ""` and folded `""` into the "did not run" set
    # alongside `skipped`, so a `queued` or `in_progress` step -- whose
    # conclusion is `null` -- made this branch report "no work step in the job
    # ran". Measured live, with no mutation and no policy edit.
    unfinished = [
        str(s.get("name") or "?")
        for s in steps
        if s not in detectors
        and not _is_bookkeeping_step(str(s.get("name") or ""))
        and not step_has_concluded(s)
    ]
    if unfinished:
        return False, (
            f"{len(unfinished)} work step(s) have NOT CONCLUDED "
            f"({', '.join(unfinished[:3])}) - a step that is queued or still "
            "running has not been shown to have done nothing, and this branch "
            "may only excuse a job that provably had nothing to do"
        )
    did_run = [
        str(s.get("name") or "?")
        for s in steps
        if s not in detectors
        and not _is_bookkeeping_step(str(s.get("name") or ""))
        and step_conclusion(s) != "skipped"
    ]
    if did_run:
        return False, (
            f"{len(did_run)} work step(s) RAN anyway ({', '.join(did_run[:3])}) - a job "
            "that did work is not a job with nothing to do. If those steps are a second "
            "half of this job's work, declare them under `alternatives`, which is "
            "corroborated against the merged files exactly as this branch is"
        )
    clear, scope_why = _merged_files_outside_scope(
        name, row, files, push_trigger, infra_ere)
    if not clear:
        return False, scope_why
    return True, (
        f"its declared gate step {gate_step!r} ran, {scope_why}, and no work "
        "step in the job ran - so there was nothing for it to do"
    )


def _scope_row(name: str, policy: dict) -> dict | None:
    """The `scope_paths` row for a context, or None when it declares no scope."""
    row = (
        policy.get("receipts", {})
        .get("ci_green_rule", {})
        .get("scope_paths", {})
        .get(name)
    )
    return row if isinstance(row, dict) else None


def _declared_gate_ran(
    row: dict, steps: list[dict],
) -> tuple[bool, str, list[dict]]:
    """Did the declared change detector run and conclude success?

    Returns `(ok, why, detectors)`.

    EVERY matching gate step must have concluded success, not ANY of them.
    `gate_step` is matched as a SUBSTRING, so `any()` let a step whose name
    merely CONTAINS the declared one answer for a detector that was itself
    skipped -- an independent reviewer's counterexample:

      Detect console changes                 -> skipped
      Detect console changes (portal half)   -> success
      Build (next build)                     -> skipped
      => excused, claiming "its declared gate step ... ran"

    That is also an R7 lie: the message asserts the declared detector ran when
    what ran was a different step. `context_did_its_work` moved from `any` to
    `all` for exactly this reason; this parallel loop stayed behind, which was
    the one-side-of-a-symmetry defect again, inside the round that named it.
    """
    gate_step = str(row.get("gate_step") or "")
    if not gate_step:
        return False, (
            f"the declared scope {row!r} is missing a `gate_step`, so nothing "
            "establishes WHY the work was skipped"
        ), []
    detectors = [s for s in steps if gate_step in str(s.get("name") or "")]
    if not detectors:
        return False, (
            f"its declared gate step {gate_step!r} is ABSENT from this job - the "
            "declaration is stale, or this is not the job it describes"
        ), []
    off = [
        f"{s.get('name') or '?'!s}={step_conclusion(s) or 'NOT CONCLUDED'!s}"
        for s in detectors
        if step_conclusion(s) != "success"
    ]
    if off:
        return False, (
            f"its declared gate step {gate_step!r} matches {len(detectors)} step(s) "
            f"and {len(off)} of them did not conclude success ({', '.join(off[:3])}), "
            "so nothing establishes WHY the work was skipped"
        ), detectors
    return True, "", detectors


def step_conclusion(step: dict) -> str | None:
    """A step's conclusion, or None when it HAS NOT REACHED ONE.

    ROUND 13 BLOCKER, and the most reachable defect this issue has produced: no
    mutation, no policy edit, live production path. A step that is `queued` or
    `in_progress` carries `conclusion: null`, and every reader in this module
    coerced that to `""` -- which `did_run` then folded into "did not run", so
    `scope_untouched_at_merge` returned True and printed "no work step in the
    job ran - so there was nothing for it to do" about steps that were STILL
    RUNNING. An R7 lie and a fail-open in one sentence.

    An independent reviewer measured the whole chain rather than asserting it:
    `merge_gate` applies no `status == "completed"` filter, its job join PREFERS
    the job that executed less (so an in-progress duplicate wins in both input
    orders), and the live jobs API returned `guardrails steps=162
    status=in_progress nullsteps=11` on the day it was found.

    So `None` is its own answer here. It is not `skipped`, it is not `success`,
    and it is not `failure`: it is "this step has not said". Every caller must
    treat it as undecidable and refuse, because the alternative is to decide on
    behalf of a step that is still running.
    """
    raw = step.get("conclusion")
    if raw is None:
        return None
    text = str(raw).strip().lower()
    return text or None


def step_has_concluded(step: dict) -> bool:
    """Has this step reached a conclusion at all? The negation is a refusal.

    ROUND 16: now CALLED, at all three sites that had inlined it. It was added
    in round 15 with zero production callers and exactly two test assertions --
    decorative code, which this package's own rule refuses in the same breath as
    it refuses an unconsulted policy key ("an unconsulted definition is prose,
    not a control"). A reviewer caught it and offered the choice: delete it, or
    call it where `step_conclusion(x) is None` was already written out.

    Wiring won over deleting because the three sites were spelling the same
    concept three times and none of them named it. The substitution is
    behaviour-identical by construction -- `not step_has_concluded(s)` IS
    `step_conclusion(s) is None`, the body is that expression -- so this does not
    move the gate's verdict, which matters in a round that deliberately declined
    to move it anywhere else.
    """
    return step_conclusion(step) is not None


def steps_named(wanted: str, steps: list[dict]) -> tuple[list[dict] | None, str]:
    """Every step a DECLARED name refers to, or None when it cannot be decided.

    ROUND 9. There are five places in this module that resolve a declared step
    name against a job's actual steps by SUBSTRING. Three were hardened in
    earlier rounds of this issue, each after a reviewer found the ambiguity, and
    each independently:

        context_did_its_work        REFUSES a mixed-outcome match
        _declared_gate_ran          REFUSES unless every match concluded success
        _primary_steps_all_skipped  REFUSES unless every match skipped

    Round 8 added a fourth (`_outputs_whose_work_did_not_run`) and left a fifth
    (`ran_instead`) unhardened, and an independent reviewer showed both were
    exploitable by adding ONE step whose name extends a declared one:

      - the fourth DROPPED the output from the scope question entirely, so a
        portal-only merge with every portal step skipped was certified green by
        the portal's only blocking check -- round 6's blocker restored;
      - the fifth reported the MATCHED step as the declared alternative, so the
        receipt said `executed its declared alternative(s) ['Jest (portal) -
        snapshot freshness report']` while both DECLARED alternatives were
        skipped. That is the R7 lie fixed at `_declared_gate_ran` and not
        carried across.

    So the resolution lives in ONE place. A sixth site must call this rather
    than write a sixth ruling.

    An EXACT name match wins outright: that is what the declaration means when
    the workflow says it. Otherwise a substring match is accepted only when it
    is unique -- several near-misses and no exact hit cannot say which step the
    declaration meant, and this repo's naming convention makes that live rather
    than hypothetical (`Use Node.js 20` / `Use Node.js 20 (portal)` and
    `Install dependencies` / `Install dependencies (portal)` are both in the one
    job whose row declares `Jest (portal)` and `Type-check (portal)`).

    Returns `([], "")` for "no such step" -- an absent step is a different
    finding from an undecidable one, and each caller words it differently.
    """
    exact = [s for s in steps if str(s.get("name") or "") == wanted]
    if exact:
        return exact, ""
    loose = [s for s in steps if wanted in str(s.get("name") or "")]
    if len(loose) > 1:
        shown = ", ".join(sorted(repr(str(s.get("name") or "")) for s in loose))
        return None, (
            f"{wanted!r} matches {len(loose)} steps and NONE is named exactly that "
            f"({shown}) - which step the declaration means cannot be decided from it"
        )
    return loose, ""


def _primary_steps_all_skipped(
    name: str, steps: list[dict], policy: dict,
) -> tuple[bool, str]:
    """Were ALL of this context's declared substantive steps skipped?

    The precondition both routes that accept a skipped primary share. A step
    that concluded anything else (failed, cancelled) is not a skip and neither
    route may excuse or substitute for it.
    """
    declared_steps = (
        policy.get("receipts", {})
        .get("ci_green_rule", {})
        .get("substantive_steps", {})
        .get(name)
    )
    if not isinstance(declared_steps, list) or not declared_steps:
        return False, (
            f"the substantive-step declaration for {name!r} is {declared_steps!r}; "
            'a scope skip is only meaningful for a NAMED step, never for "ALL"'
        )
    for wanted in declared_steps:
        # THROUGH THE SHARED RESOLVER. Round 11: this was the SEVENTH place
        # resolving a declared step name by raw substring, and the one that
        # gates BOTH routes -- "the primary must be cleanly HOLLOW" is the
        # precondition the excuse and the alternative share. An independent
        # reviewer showed a `[:1]` narrowing of it is fail-OPEN (a decoy that
        # SKIPPED, ahead of a primary that RAN, reads as hollow) and that no arm
        # pointed at it. Exact-match-wins ignores the decoy outright; an
        # ambiguous pool refuses.
        matches, ambiguous = steps_named(str(wanted), steps)
        if matches is None:
            return False, (
                f"its declared step {wanted!r} cannot be resolved: {ambiguous}"
            )
        if not matches:
            return False, f"its declared step {wanted!r} is absent from this job"
        off = [
            step_conclusion(s) or "NOT CONCLUDED"
            for s in matches
            if step_conclusion(s) != "skipped"
        ]
        if off:
            return False, (
                f"its declared step {wanted!r} concluded {', '.join(off)} rather "
                "than `skipped`, so this is not a scope skip"
            )
    return True, ""


def _outputs_whose_work_did_not_run(
    name: str, row: dict, steps: list[dict],
) -> tuple[list[str] | None, str]:
    """Which declared outputs gated work that did NOT run?

    ROUND 8 BLOCKER 1, and it is round 6's blocker rebuilt one output over.
    `alternative_accounted_for` used to narrow the scope question by IDENTITY --
    "the outputs that gate the PRIMARY step" -- and those are not the same set as
    "the outputs whose work did not run" the moment a job carries a third output.

    An independent reviewer drove the real `next build (node 20)` row plus a
    third declared output `docs` (gating `Docs link check`, which SKIPPED) with
    `docs/adr/0001.md` in the merge. The excuse branch refused the job in those
    words; the alternative branch accepted it, because `docs` gates neither the
    primary nor the alternative and so was never asked. Declaring the output
    CORRECTLY did not protect it -- which matters, because "declare every
    work-gating output" is the entire remedy round 7 chose for round 6.

    So selection is by OUTCOME: an output is asked when every step it gates
    concluded `skipped`. An output whose gated steps RAN is excluded, and that
    exclusion is the one this route exists for -- the alternative's own scope
    SHOULD match a merged file, because that is WHY it ran. Asking it would
    rebuild round 4's defect, where `infra`'s ERE contains `tools/` and so
    matches every drain PR by construction.

    Returns `(None, why)` when an output's gated step cannot be found in the job
    at all. That is an ambiguous declaration, not an absent one, and this fails
    closed rather than silently dropping the output from the question.
    """
    outputs = row.get("outputs")
    if not isinstance(outputs, list) or not outputs:
        return None, (
            f"the declared scope for {name!r} carries no non-empty `outputs` list, "
            "so which outputs gated unrun work cannot be decided"
        )
    gate_step = str(row.get("gate_step") or "")
    asked: list[str] = []
    for spec in outputs:
        if not isinstance(spec, dict):
            return None, f"a declared output of {name!r} is {spec!r}, not an object"
        out = spec.get("output")
        gated = spec.get("gates")
        if not isinstance(gated, list) or not gated:
            return None, (
                f"declared output {out!r} of {name!r} does not name the steps it "
                "`gates`, so whether its work ran cannot be decided"
            )
        conclusions: list[str] = []
        for wanted in gated:
            # A DECLARED GATE MAY NOT BE THE DETECTOR OR RUNNER BOOKKEEPING.
            # Round 10: `ran_instead` refuses both and this, the caller whose
            # answer decides WHICH SCOPES GET COMPARED, refused neither -- so one
            # policy line naming `Detect console changes` or `Set up job` as an
            # output's `gates` exempted that output's scope on the alternative
            # route while the excuse route refused the byte-identical job. The
            # detector always runs, so an output gated on it is never "unrun";
            # bookkeeping is not this job's work at all. `_merged_files_outside_
            # scope` already validates shape on EVERY entry for the same reason:
            # a row is the authority or it is not.
            if gate_step and gate_step in str(wanted):
                return None, (
                    f"declared output {out!r} of {name!r} claims to gate "
                    f"{wanted!r}, which is its own change DETECTOR - the detector "
                    "always runs, so that output could never be shown to have had "
                    "nothing to do"
                )
            if _is_bookkeeping_step(str(wanted)):
                return None, (
                    f"declared output {out!r} of {name!r} claims to gate "
                    f"{wanted!r}, which is runner BOOKKEEPING and not this job's "
                    "work - it cannot evidence whether that output's work ran"
                )
            matches, ambiguous = steps_named(str(wanted), steps)
            if matches is None:
                # ROUND 9 BLOCKER. This used to resolve a mixed-outcome match in
                # the EXCUSING direction: `all(c == "skipped")` came back False,
                # the output was silently removed from `asked`, and its scope was
                # then never compared against the merged files at all. One added
                # step named `Jest (portal) - snapshot freshness report` flipped a
                # portal-only merge -- every portal step skipped -- from refused to
                # `ok=True route=alternative-work-at-merge`.
                return None, (
                    f"declared output {out!r} of {name!r} cannot be resolved: {ambiguous}"
                )
            if not matches:
                return None, (
                    f"declared output {out!r} of {name!r} claims to gate {wanted!r}, "
                    "which is absent from this job - the row cannot say whether that "
                    "output's work ran"
                )
            # ONE NAME, ONE ANSWER. Round 10 BLOCKER: `steps_named` returns EVERY
            # exact match and GitHub Actions permits two steps in a job to share a
            # `name` (steps are a list, not a map). A duplicate `Docs link check`
            # -- one skipped, one success -- pooled below, `all(skipped)` came back
            # False, and the output was dropped from the question with its scope
            # never compared. That is round 8's blocker restored by a DUPLICATE
            # name where round 9 closed only the EXTENDING name.
            #
            # Distinct from, and deliberately not disturbing, the rule below: two
            # DIFFERENT declared steps that disagree means part of this output's
            # work ran, and excluding it is correct. One NAME that disagrees with
            # itself is undecidable.
            mine = {str(s.get("conclusion") or "?").lower() for s in matches}
            if len(mine) > 1:
                return None, (
                    f"declared output {out!r} of {name!r} gates {wanted!r}, which "
                    f"resolved to {len(matches)} steps concluding {sorted(mine)} - "
                    "one declared name cannot say whether its own work ran"
                )
            conclusions += sorted(mine)
        # ALL SKIPPED -> ask its scope. ALL RAN -> exclude it, because its scope
        # SHOULD match and that is why the work ran. MIXED -> REFUSE.
        #
        # ROUND 11 BLOCKER, and a correction of round 10. Round 10 wrote this
        # refusal, saw it break the control proving every declared alternative is
        # consulted, and backed it out as an "over-correction". THE TEST WAS
        # WRONG, not the refusal. Measured in the real workflow: `Type-check
        # (portal)` and `Jest (portal)` carry the IDENTICAL condition
        # (`fiab-console-ci.yml:297` and `:302` respectively, both
        # `steps.changed.outputs.portal == 'true'`), so they CANNOT disagree.
        # (Round 16: the two names were listed in the opposite order to their
        # two line numbers. The substantive claim was true and both citations
        # resolved, so nothing downstream was wrong -- but a citation a reader
        # cannot follow without re-deriving it is the defect this file spends
        # its budget on. A reviewer caught it; re-read both lines before
        # editing.) The
        # fixture that produced a mixed outcome was describing an impossible job,
        # and treating that state as "part of its work ran, so exclude it" is
        # fail-OPEN: an independent reviewer drove a merge of
        # `portal/react-webapp/src/App.tsx` with `Jest (portal)` SKIPPED and
        # `Type-check (portal)` RUN, and the portal scope -- which MATCHED -- was
        # never asked. Round 8's blocker through a third door, on the one
        # required context that is the portal's only blocking check.
        #
        # So a declaration whose steps disagree cannot say whether that output's
        # work ran, exactly as one NAME that disagrees with itself cannot. Both
        # refuse. What must NOT refuse is the ordinary two-output job where one
        # output's work all ran and another's all skipped -- that is the
        # population this route exists for, and it is unaffected.
        # THE WHOLE TABLE, NOT ONE ROW OF IT. Round 12 BLOCKER: round 11 refused
        # `skipped`+`success` and EXCLUDED everything else, and an independent
        # reviewer drove `Jest (portal)=failure` + `Type-check (portal)=success`
        # on the UNMODIFIED real policy row with `portal/react-webapp/src/App.tsx`
        # merged: `ok=True`, the portal scope MATCHED and was never asked, while
        # the portal's blocking test step had FAILED. `cancelled`, `timed_out`
        # and an unknown conclusion all behaved the same way. Same defect, through
        # the failure door.
        #
        # Round 11's stated reason for excluding a failure -- that `ran_instead`
        # refuses it one sentence later -- is FALSE, and the reviewer measured
        # that too: `ran_instead` BUILDS "concluded ['failure'], not success" and
        # DISCARDS it whenever a sibling alternative succeeded, and for an output
        # whose gated steps are not declared alternatives it never iterates them
        # at all. A comment asserting a mechanism the code does not have is the
        # exact R7 defect this package exists to refuse, written into the
        # justification for an R7 fix.
        #
        # So: ASK when every step skipped. EXCLUDE only when every step
        # SUCCEEDED -- that is the alternative that ran, whose scope should
        # match, which is the population this route exists for. REFUSE anything
        # else. "Not shown to have succeeded" is not "shown to have run".
        outcomes = set(conclusions)
        if outcomes == {"skipped"}:
            asked.append(str(out))
        elif outcomes == {"success"}:
            pass  # its work ran and passed; its scope is expected to match
        else:
            return None, (
                f"declared output {out!r} of {name!r} gates {list(gated)}, which "
                f"concluded {sorted(outcomes)} - neither 'every step skipped' nor "
                "'every step succeeded', so whether that output's work ran cannot "
                "be read off the declaration"
            )
    return asked, ""


def _output_scope_hits(
    spec, files: list[str],
    push_trigger: PushTrigger | None, infra_ere: str | None,
) -> tuple[list[str] | None, str]:
    """Which merged files fall inside ONE declared output's scope?

    Returns `(hits, description)`, or `(None, refusal)` when the scope cannot be
    evaluated -- every unanswerable question resolves in the refusing direction.
    """
    if not isinstance(spec, dict):
        return None, (
            f"a declared output is {spec!r}, not an object with `output` and `paths`"
        )
    out = str(spec.get("output") or "")
    if not out:
        return None, f"a declared output {spec!r} does not name the output it gates"
    paths = spec.get("paths")

    if paths == ON_PUSH_PATHS:
        # THE DETECTOR READS THE WORKFLOW'S OWN `on.push.paths`, so there is no
        # second list to drift. `test.yml`'s `Detect Python-relevant changes`
        # delegates to `scripts/ci/python_trigger_scope.py`, which parses that
        # very key out of the file -- its own comment says "ONE list ... READ OUT
        # OF THIS FILE - not a second copy of it that has to be kept in agreement
        # by review". Copying those 15 globs into `policy.json` would create
        # exactly the second copy that file refuses to have.
        #
        # This is the SAME predicate `push_event_runs` applies one branch up, and
        # that is the point rather than a circularity: one list governs both
        # whether the workflow could run at the merged sha and whether the step
        # could run at the head, because the workflow was written that way.
        if push_trigger is None or not push_trigger.paths:
            return None, (
                f"output {out!r} declares its scope as the producing workflow's "
                "`on.push.paths`, and that trigger could not be read here - fail "
                "closed rather than assume it excludes anything"
            )
        paths = list(push_trigger.paths)

    if paths == INFRA_READING_ERE:
        # THE SAME DELEGATION, for a scope that is COMPUTED. The vitest
        # detector's `infra` half greps the merged files against an ERE produced
        # by `derive-infra-reading-suites.mjs --ere`, which walks the tree -- so
        # there is no list to copy, and a copy would be stale the moment a suite
        # moves. Resolved by the caller and injected; unresolvable means refuse.
        if not infra_ere:
            return None, (
                f"output {out!r} declares its scope as the ERE computed by "
                f"{INFRA_READING_ERE}, and it was not resolved here - fail closed "
                "rather than assume it excludes anything"
            )
        try:
            return (
                sorted({f for f in files if re.search(infra_ere, f)}),
                f"{out}=/{infra_ere}/",
            )
        except re.error as exc:
            return None, (
                f"output {out!r} resolved to {infra_ere!r}, which is not a regular "
                f"expression this gate can evaluate ({exc}) - a scope that cannot "
                "be evaluated excuses nothing"
            )

    if not isinstance(paths, list) or not paths:
        return None, (
            f"output {out!r} declares {paths!r}, which is neither a non-empty list "
            f"of globs nor a recognised delegation"
        )
    # AN UNREPRESENTABLE PATTERN IS AN UNANSWERED QUESTION, and `glob_matches`
    # RAISES on one rather than guessing -- so without this the excuse branch
    # would propagate an exception out of a gate whose entire contract is to fail
    # closed. `push_event_runs` has the same guard one branch up and resolves it
    # in the REFUSING direction (the workflow "runs", so the absence is not
    # excused); the refusing direction here is "not a scope skip".
    try:
        hits = sorted({f for f in files if _any_match(tuple(paths), [f])})
    except UnsupportedPatternError as exc:
        return None, (
            f"its declared scope contains {str(exc)!r}, which this translator "
            "cannot represent faithfully - a scope that cannot be evaluated "
            "excuses nothing"
        )
    return hits, f"{out}={list(paths)}"


def _merged_files_outside_scope(
    name: str, row: dict, files: list[str],
    push_trigger: PushTrigger | None = None, infra_ere: str | None = None,
    only_gating: list[str] | None = None,
) -> tuple[bool, str]:
    """Do the merged files fall outside the scope of the outputs that matter?

    THE UNIT IS THE OUTPUT, NOT THE CONTEXT, and that is round 6's second
    blocker. A `scope_paths` row used to carry one `paths` list against a
    `gate_step` that emits SEVERAL outputs, and the receipt corroborated only
    the first of them. Measured by an independent reviewer:

      next build (node 20)  declared `console`; the same detector also emits
                            `portal` (`^portal/react-webapp/`), and
                            `fiab-console-ci.yml` records this job as the
                            portal's ONLY blocking check. A portal-only merge
                            whose portal grep did not fire was excused with
                            "there was nothing for it to do" by the one required
                            context that would have caught it.
      vitest (node 20)      declared `console`; also emits `infra`, whose scope
                            is an ERE computed by a script and named in no row.

    So a row enumerates EVERY output that gates work, each with its own scope
    and the steps it gates. An output that cannot be evaluated REFUSES -- an
    under-declared row is a refusal rather than a silent pass, which is the
    direction this whole receipt is specified to fail in.

    `only_gating` is a list of OUTPUT NAMES and narrows the question to them.
    Getting this wrong re-breaks the receipt rather than merely weakening it.
    The two routes ask genuinely different questions:

      excuse       nothing ran, so EVERY output must have been false, so no
                   output's scope may match. `only_gating=None`.
      alternative  some of this job's work ran and some did not. Every output
                   whose work did NOT run must have a clear scope; an output
                   whose work RAN is excluded, because its scope SHOULD match --
                   that is WHY it ran.

    ROUND 8: the alternative used to narrow to "the outputs that gate the
    PRIMARY step", which is selection by IDENTITY. Selection is by OUTCOME --
    see `_outputs_whose_work_did_not_run` -- because a job with a THIRD output
    whose gated step skipped and whose scope matched was accepted here while the
    excuse branch refused the byte-identical job.

    Asking every output on the alternative route would instead make `ci-green`
    unobtainable for the exact class it closes, which is round 4's defect
    rebuilt: `infra`'s ERE contains `tools/` and `PRPs/`, so every drain PR
    matches it, and vitest -- whose infra suite genuinely runs on those PRs --
    would be refused for having done the work.

    A scope that MATCHES a merged file is a FAILURE, loudly: that is a change
    detector that missed a change (#3783), and it is the defect this must never
    launder. Both routes that accept a SKIPPED primary come through here, so
    that refusal cannot be bypassed by taking the other one.
    """
    outputs = row.get("outputs")
    if not isinstance(outputs, list) or not outputs:
        return False, (
            f"the declared scope for {name!r} is {row!r}, which carries no non-empty "
            "`outputs` list - a row that does not enumerate every work-gating output "
            "cannot show this job had nothing to do"
        )
    if not files:
        return False, (
            "the merged commit's changed-file list is empty, so the declared scope "
            "cannot be shown to exclude anything"
        )
    selected, described = [], []
    seen: set[str] = set()
    for spec in outputs:
        if not isinstance(spec, dict):
            return False, (
                f"a declared output of {name!r} is {spec!r}, not an object"
            )
        # SHAPE ON EVERY ENTRY, BEFORE SELECTING. Round 8: `gates` was validated
        # on every output but `output` and `paths` only on the SELECTED ones, so
        # a malformed non-selected entry refused on one route and passed on the
        # other, and a DUPLICATE output name passed on both. A row is the
        # authority or it is not; it cannot be the authority only where the
        # question happens to land.
        out = spec.get("output")
        if not isinstance(out, str) or not out.strip():
            return False, (
                f"a declared output of {name!r} has no `output` name ({out!r}), so "
                "its scope cannot be attributed to anything the detector emits"
            )
        if out in seen:
            return False, (
                f"declared output {out!r} of {name!r} appears more than once - the "
                "row cannot say which of the two scopes is that output's"
            )
        seen.add(out)
        if not spec.get("paths"):
            return False, (
                f"declared output {out!r} of {name!r} declares no `paths`, so it "
                "cannot be shown to exclude any merged file"
            )
        gated = spec.get("gates")
        if not isinstance(gated, list) or not gated:
            return False, (
                f"declared output {out!r} of {name!r} does not name the "
                "steps it `gates`, so it cannot be matched to a substantive step"
            )
        if only_gating is None or out in only_gating:
            selected.append(spec)
    if only_gating is not None and not selected:
        return False, (
            f"no declared output of {name!r} gates work that was skipped "
            f"({list(only_gating)}) - the row cannot say which detector decided it"
        )
    for spec in selected:
        hits, detail = _output_scope_hits(spec, files, push_trigger, infra_ere)
        if hits is None:
            return False, detail
        if hits:
            shown = ", ".join(hits[:3])
            more = f", +{len(hits) - 3} more" if len(hits) > 3 else ""
            return False, (
                f"its declared scope {detail} MATCHES {len(hits)} merged file(s) "
                f"({shown}{more}) and the work was skipped anyway - that is a change "
                "detector that missed a change, not a scope skip"
            )
        described.append(detail)
    return True, (
        f"none of the {len(files)} merged file(s) is inside any of the "
        f"{len(described)} declared scope(s) checked ({'; '.join(described)})"
    )


def alternative_accounted_for(
    name: str, job: dict | None, changed_files, policy: dict,
    push_trigger: PushTrigger | None = None,
    infra_ere: str | None = None,
) -> tuple[bool, str]:
    """Did this context skip its primary step and do the OTHER half of its work?

    A job may carry more than one work-gating output. `vitest (node 20)` skips
    `Run vitest (with istanbul coverage floor)` when the console is untouched
    and runs `Run vitest (infra-reading suites only)` when `infra` fired -- and
    `infra`'s ERE contains `tools/` and `PRPs/`, the exact footprint of a drain
    PR. Reporting that as "there was nothing for it to do" stated something
    FALSE about a job that had done work (R7), which is what round 5 fixed.

    THE FIX FOR ROUND 5'S FIX. That acceptance was made inside
    `context_did_its_work`, which receives no `changed_files`, so it returned a
    pass before the scope corroboration ran -- and `_merged_files_outside_scope`
    is the only place a detector's output is checked against the merged commit's
    own file list. Both reviewers demonstrated the consequence on different
    rows: with a console file in the merge and the detector wrongly reporting
    `console=false`, round 4 refused ("a change detector that missed a change")
    and round 5 returned `green-at-merge`, naming the alternative. A required
    context was certified green over a console that was never built or tested.

    So an alternative may stand in for a skipped primary ONLY when the merged
    files are provably outside every declared scope -- the same question the
    excuse branch asks, asked here too. The two are halves of one predicate.

    Three further conditions, each of which was a reviewer's finding:

    - the alternative must have concluded SUCCESS, not merely "not skipped".
      `ran()` counts `failure` and `cancelled` as executed, which is harmless
      for a primary inside a green job and is not harmless here: it would
      report a FAILED step as the work this context did instead.
    - the alternative must not be the gate step. Alternatives are matched as
      substrings against the job's steps, and the detector always runs, so
      declaring it would make this function return True for every green run of
      the context -- switching the substantive-step rule off entirely, with a
      one-line edit to `policy.json` and no test failing.
    - the primary must be cleanly HOLLOW. `_primary_steps_all_skipped` refuses a
      primary that failed or was cancelled, and it is also what refuses an
      AMBIGUOUS declaration -- `context_is_accounted_for` reaches BOTH routes
      whenever the substantive-step check came back false, so nothing upstream
      has already filtered one out. Round 8 note: this docstring used to credit
      `context_did_its_work` with that refusal. Same outcome, wrong stated
      reason, in a file whose whole thesis is that the stated reason IS the
      control.
    """
    alternatives = (
        policy.get("receipts", {})
        .get("ci_green_rule", {})
        .get("alternatives", {})
        .get(name)
    )
    if not isinstance(alternatives, list) or not alternatives:
        return False, (
            f"no alternative step is DECLARED for {name!r} in policy.json "
            "(receipts.ci_green_rule.alternatives)"
        )
    row = _scope_row(name, policy)
    if row is None:
        return False, (
            f"no change-detection scope is DECLARED for {name!r}, so an alternative "
            "cannot be corroborated against the merged files"
        )
    if not isinstance(job, dict) or not isinstance(job.get("steps"), list):
        return False, "no job record was read for it, so no alternative can be shown to have run"
    steps = [s for s in job["steps"] if isinstance(s, dict)]

    gate_ok, gate_why, _ = _declared_gate_ran(row, steps)
    if not gate_ok:
        return False, gate_why
    hollow_ok, hollow_why = _primary_steps_all_skipped(name, steps, policy)
    if not hollow_ok:
        return False, hollow_why

    files = [str(f) for f in (changed_files or []) if str(f).strip()]
    declared_primary = (
        policy.get("receipts", {})
        .get("ci_green_rule", {})
        .get("substantive_steps", {})
        .get(name)
    )
    if not isinstance(declared_primary, list) or not declared_primary:
        return False, (
            f"the substantive-step declaration for {name!r} is {declared_primary!r}; "
            "an alternative is only meaningful for a NAMED primary step"
        )
    # EVERY OUTPUT WHOSE WORK DID NOT RUN, not "the primary's output". Round 8
    # BLOCKER 1: those two sets diverge the moment a job carries a third output,
    # and the alternative route accepted a matching scope on one the excuse
    # route refused. The alternative's OWN output is excluded because its work
    # ran -- its scope SHOULD match, which is why it ran.
    unrun, unrun_why = _outputs_whose_work_did_not_run(name, row, steps)
    if unrun is None:
        return False, unrun_why
    clear, scope_why = _merged_files_outside_scope(
        name, row, files, push_trigger, infra_ere, only_gating=unrun)
    if not clear:
        return False, scope_why

    gate_step = str(row.get("gate_step") or "")
    # THE DECLARED NAME, RESOLVED ONCE. Round 9 BLOCKER: this matched by bare
    # substring and then PRINTED THE MATCHED STEP as the declared alternative, so
    # the receipt read `executed its declared alternative(s) ['Jest (portal) -
    # snapshot freshness report']` while both DECLARED alternatives concluded
    # `skipped`. `Jest (portal) - snapshot freshness report` is declared nowhere.
    # The sentence asserted that a declared alternative ran; the code had
    # established only that SOME step containing a declared name ran. That is
    # word-for-word the R7 lie `_declared_gate_ran` was fixed for in round 5, and
    # it was not carried across. `ran_instead` now reports the DECLARED name.
    ran_instead: list[str] = []
    # WHY EACH ONE WAS NOT COUNTED, so the refusal below can say. Round 10 (R7):
    # both `continue`s here were silent and the refusal then attributed every
    # outcome to "did not conclude success" -- including an alternative the code
    # had just established DID succeed (the gate-step case, whose success
    # `_declared_gate_ran` proved forty lines earlier) and one that was simply
    # ABSENT. `steps_named`'s own docstring says an absent step is a different
    # finding from an undecidable one "and each caller words it differently";
    # this caller did not word it at all.
    not_counted: list[str] = []
    for alt in alternatives:
        alt_name = str(alt)
        if gate_step and gate_step in alt_name:
            not_counted.append(
                f"{alt_name!r} IS the change detector, which always runs, so it "
                "cannot stand in for skipped work"
            )
            continue
        matches, ambiguous = steps_named(alt_name, steps)
        if matches is None:
            return False, (
                f"its declared alternative {alt_name!r} cannot be resolved: {ambiguous}"
            )
        if not matches:
            not_counted.append(f"{alt_name!r} is absent from this job")
            continue
        usable = [
            s for s in matches
            if gate_step not in str(s.get("name") or "")
            and not _is_bookkeeping_step(str(s.get("name") or ""))
        ]
        if not usable:
            not_counted.append(
                f"{alt_name!r} resolved only to the detector or to runner "
                "bookkeeping, which is not this job's work"
            )
            continue
        concluded = {str(s.get("conclusion") or "?").lower() for s in usable}
        if concluded == {"success"}:
            ran_instead.append(alt_name)
        elif "success" in concluded:
            return False, (
                f"its declared alternative {alt_name!r} resolved to {len(usable)} steps "
                f"concluding {sorted(concluded)} - a MIXED outcome cannot show the "
                "alternative ran"
            )
        else:
            not_counted.append(
                f"{alt_name!r} concluded {sorted(concluded)}, not success"
            )
    if not ran_instead:
        return False, (
            f"none of its declared alternative(s) {list(alternatives)} is shown to "
            f"have run: {'; '.join(not_counted)}"
        )
    return True, (
        f"skipped its primary step(s) {list(declared_primary)} and executed its "
        f"declared alternative(s) {ran_instead} instead - the other half of a job whose "
        f"work is gated on more than one output - and {scope_why}"
    )


def job_executed(job: dict | None) -> tuple[bool, str]:
    """Did this job actually DO its work, or conclude green having skipped it?

    The population source `statusCheckRollup` does not have and the Actions
    jobs API does: `steps[].conclusion`.

    THE PREDICATE IS "EVERY WORK STEP RAN", NOT "ANY DID", and that distinction
    is the whole control. The first version of this function asked whether ANY
    substantive step executed -- and on PR #4440 the `Python Tests (3.10)` head
    job satisfied it with exactly one: `Detect Python-relevant changes`, the
    change-detection gate that then SKIPPED the other ten, including `Run
    pytest with coverage`, `Lint with ruff` and `Typecheck with mypy (strict)`.
    A predicate a gate step can satisfy is not a predicate. That was found by
    running the corrected receipt against the reviewer's own counterexample
    instead of against the fixture written from their description.

    MEASURED BEFORE CHOOSING THE RULE, because a threshold picked without the
    distribution is the same defect one level up. Across the 16 deferrals on
    PRs #4440 and #4483 the split is BIMODAL WITH NO MIDDLE:

        genuine   `Python Lint`, `Secret Scan`, `Repo Hygiene`, all four
                  `dbt Compile (*)`, `changelog parser ...`, `PowerShell Lint`
                  -> 0 skipped, of 2 to 7 work steps. Every one.
        hollow    `Python Tests (3.10|3.11|3.12)` -> 10 skipped of 11.

    No job is partially skipped, so "any skip refuses" costs nothing today and
    a ratio threshold would be an arbitrary number dressed as a measurement. If
    a job legitimately starts skipping a step, this refuses and a human looks —
    which is the direction this package fails in.

    Fails CLOSED on absent step data: `None`, an empty `steps` list, or a
    non-dict all mean the question was not answered, and an unanswered question
    is not evidence. Returns (ran, evidence-phrase) so the caller can quote
    WHAT it saw rather than assert a cause (R7).

    The runner's own bookkeeping is not evidence that the job did its work:
    `Set up job`, `Complete job`, `Post ...` and the checkout run on every job
    including one whose real steps were all skipped.
    """
    if not isinstance(job, dict):
        return False, "no job record was read for it, so it cannot be shown to have run"
    steps = job.get("steps")
    if not isinstance(steps, list) or not steps:
        return False, "its job record carries no steps, so it cannot be shown to have run"
    substantive = [
        step for step in steps
        if isinstance(step, dict) and not _is_bookkeeping_step(str(step.get("name") or ""))
    ]
    if not substantive:
        return False, (
            f"all {len(steps)} of its steps are runner bookkeeping - it has no work steps at all"
        )
    # THE EIGHTH READER, and the one that STEERS the others: this boolean is the
    # selector `merge_gate` uses to choose a route. Round 14: it folded "has not
    # concluded" into "skipped" and then printed "1 of its 1 work step(s) are
    # SKIPPED" about a step that was QUEUED -- an R7-false sentence feeding a
    # wrong route choice.
    unfinished = [
        step for step in substantive if not step_has_concluded(step)
    ]
    if unfinished:
        names = ", ".join(str(s.get("name") or "?") for s in unfinished[:4])
        return False, (
            f"{len(unfinished)} of its {len(substantive)} work step(s) have NOT "
            f"CONCLUDED ({names}) - the job is still running, which is not the "
            "same as having skipped its work"
        )
    skipped = [
        step for step in substantive
        if step_conclusion(step) == "skipped"
    ]
    if skipped:
        names = ", ".join(str(s.get("name") or "?") for s in skipped[:4])
        more = f", +{len(skipped) - 4} more" if len(skipped) > 4 else ""
        return False, (
            f"{len(skipped)} of its {len(substantive)} work step(s) are SKIPPED "
            f"({names}{more})"
        )
    return True, f"executed {len(substantive)} of {len(substantive)} work step(s)"


_BOOKKEEPING = (
    "set up job", "complete job", "checkout", "post ", "set up runner",
)


def _is_bookkeeping_step(name: str) -> bool:
    lowered = name.strip().lower()
    return any(lowered.startswith(prefix) or prefix in lowered for prefix in _BOOKKEEPING)


def _renamed_at_merge(
    item: ContextEvidence, *, merged_sha: str, merged_changed_files, policy: dict,
    infra_ere: str | None = None,
) -> ContextResult:
    """The per-event RENAME case, on evidence rather than on a green run.

    THE FIRST VERSION OF THIS WAS A WEAKENING and both independent reviewers
    blocked on it. It asked one question -- did some run of this workflow path
    at the merged sha conclude SUCCESS -- and from that asserted "published
    under a different name", which is a cause it never established (R7). It
    accepted an EMPTY job list, never read a job's conclusion, never checked
    the run was even about this commit, and the collector handed it the NEWEST
    run of that path regardless of event. Since `commit-message-parses.yml`
    also carries `schedule:` and `workflow_dispatch:`, and its own header says
    the dispatch shape "goes green having judged no commits at all", a RED push
    run followed by any green cron could produce `RECEIPT: GREEN`. Under the
    definition this replaced there was simply no receipt.

    So the rename must now be SHOWN, not inferred:

    1. the run is about THIS commit (`head_sha` == the merged sha),
    2. it is the `push` run -- the event whose spelling we are excusing,
    3. it concluded SUCCESS,
    4. its job list is non-empty and the required context is genuinely ABSENT
       from it (that is what makes this a rename rather than a missing job),
    5. the sibling job that stands in concluded success and is ACCOUNTED FOR by
       `context_is_accounted_for` -- the same predicate every other branch uses.
       It used to call `job_executed` instead, which asked a DIFFERENT question
       ("every work step ran") about the same thing, and two predicates over one
       question is the shape that produced the original hole. The sibling is the
       renamed job, so it carries the same STEPS and the context's own
       declaration applies to it unchanged.

    Every one of those fails closed, and the message names the sibling actually
    observed instead of asserting one exists.
    """
    run = item.merged_workflow_run or {}
    where = item.workflow_path
    conclusion = str(run.get("conclusion") or "").upper()
    status = str(run.get("status") or "").upper()

    head_sha = str(run.get("head_sha") or "")
    if not head_sha or (merged_sha and head_sha != merged_sha):
        return ContextResult(
            item.name, "FAIL",
            f"absent under this name, and the {where} run offered as the rename is for "
            f"{head_sha[:12] or 'an unreadable sha'}, not the merged sha {merged_sha[:12]}",
        )
    event = str(run.get("event") or "").lower()
    if event != "push":
        return ContextResult(
            item.name, "FAIL",
            f"absent under this name, and the {where} run offered as the rename was "
            f"triggered by {event or 'an unreadable event'}, not `push` - a scheduled or "
            "dispatched run is not the event whose spelling is being excused",
        )
    if conclusion != "SUCCESS":
        return ContextResult(
            item.name, "FAIL",
            f"absent under this name, and {where} did run at the merged sha but concluded "
            f"{conclusion or status or 'unknown'}",
        )
    jobs = [j for j in item.merged_workflow_jobs if isinstance(j, dict)]
    if not jobs:
        return ContextResult(
            item.name, "FAIL",
            f"absent under this name, and no jobs could be read from the {where} run - "
            "with no job list there is nothing showing a rename rather than a missing job",
        )
    names = [str(j.get("name") or "") for j in jobs]
    if item.name in names:
        return ContextResult(
            item.name, "FAIL",
            f"the {where} run DOES carry a job named {item.name!r}, so this is not a "
            "rename - the context is absent for some other reason",
        )
    ran = [
        (j, context_is_accounted_for(
            item.name, j, merged_changed_files, policy, infra_ere=infra_ere))
        for j in jobs
    ]
    usable = [
        (j, ev) for j, (ok, ev, _route) in ran
        if ok and str(j.get("conclusion") or "").lower() == "success"
    ]
    if not usable:
        return ContextResult(
            item.name, "FAIL",
            f"absent under this name, and no job in the {where} run both concluded success "
            f"and executed anything (jobs: {', '.join(n or '?' for n in names[:4])})",
        )
    sibling, evidence = usable[0]
    return ContextResult(
        item.name, "renamed-at-merge",
        f"{where} ran on `push` at the merged sha, concluded SUCCESS, and published "
        f"{str(sibling.get('name'))!r} instead of this context - which {evidence}",
    )


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


@dataclass(frozen=True)
class ContextScope:
    """Which paths ONE required context's producing workflow declares it reads.

    `paths` / `paths_ignore` are that workflow's own `on.push` filter, DERIVED
    from the workflow file by `merge_gate.derive_context_scopes` -- never
    transcribed into this package. `unreadable` carries the reason the scope
    could not be established at all, and a scope that carries one can only
    refuse.

    THE THREE STATES ARE DIFFERENT ANSWERS AND ARE KEPT APART, for the same
    reason `parse_push_trigger` keeps `None` apart from `present=False`:

        paths=('a/**',)                  a filter: only `a/**` reaches it
        paths=None, paths_ignore=None    NO filter: it reads EVERYTHING
        paths=()                         an EMPTY filter: it matches NOTHING
        unreadable='...'                 the question was not answered

    Collapsing any of the last three into "matches nothing" is the whole defect
    this guards against -- an empty intersection is the answer that lets a
    merge through, so a scope that cannot match is indistinguishable from a
    scope that was never resolved unless they are separate fields. The
    `paths=()` row is the one that was MISSED for a round: it is not the absent
    state, it is a real `paths: []` in a workflow file, and because `any([])`
    is False it excused every delta through the branch that looked like it had
    already handled it. `base_delta_is_inert` refuses it explicitly.
    """

    name: str
    workflow_path: str | None = None
    paths: tuple[str, ...] | None = None
    paths_ignore: tuple[str, ...] | None = None
    unreadable: str | None = None


def _every_pattern_matched(patterns: tuple[str, ...], path: str) -> bool:
    """`any()` over a LIST, so every pattern is evaluated before an answer.

    `_any_match` uses a generator and short-circuits. That is harmless under a
    positive `paths:` list -- an early match means a HIT, which refuses either
    way -- and it is the EXCUSING direction under `paths-ignore`: a match on
    pattern one returns before pattern two is looked at, so an unrepresentable
    pattern later in the list never raises, and a `!` re-include (which
    `_UNSUPPORTED_GLOB` exists to refuse, precisely because ignoring it can
    excuse outright) is silently skipped. The list comprehension forces every
    `glob_matches` call, so an unsupported pattern ANYWHERE in the list raises.
    """
    return any([glob_matches(pattern, path) for pattern in patterns])  # noqa: C419


def filter_admits(scope: ContextScope, path: str) -> bool:
    """Would a push touching `path` have been ADMITTED by this filter?

    NAMED FOR WHAT IT MEASURES. It was `scope_reads` for two rounds, and the
    name asserted the very thing `base_delta_is_inert`'s docstring says this
    cannot establish -- that the filter bounds what the context READS. It
    bounds what the TRUNK RE-RUNS FOR. A retraction that leaves the claim in an
    identifier is the same defect as one that leaves it in a printed string.

    Raises `UnsupportedPatternError` (via `glob_matches`) rather than guessing,
    and raises `ValueError` on a scope that has no filter -- callers must have
    refused before they get here. Both are the fail-closed direction: this
    function NEVER answers "no" for a reason other than the patterns.
    """
    if scope.unreadable:
        raise ValueError(f"{scope.name}: scope unresolved ({scope.unreadable})")
    if scope.paths is not None and scope.paths_ignore is not None:
        raise ValueError(f"{scope.name}: both paths and paths-ignore declared")
    if scope.paths is not None:
        return _every_pattern_matched(scope.paths, path)
    if scope.paths_ignore is not None:
        # `**` is REFUSED here though it is fine under `paths:`, and the
        # asymmetry is the whole point. `_glob_to_regex` lets `**/` consume
        # ZERO segments, so it matches MORE paths than a strict reading. Under
        # `paths:` matching more ADMITS more, which makes a delta look live --
        # the refusing direction, and safe. Under `paths-ignore:` the same
        # permissiveness IGNORES more, which makes the delta look INERT: the
        # excusing direction, on the arm that decides merges.
        #
        # Measured on this checkout: 127 workflow files, 40 with an `on.push`
        # trigger, and ZERO of them declare `paths-ignore` at all -- so this
        # refuses nothing that exists today, and costs nothing to keep closed.
        # NARROW ON PURPOSE: `**/` only, not a bare trailing `**`. The
        # permissiveness lives in the `**/` production, which may consume ZERO
        # segments together with its slash; `docs/**` has no such branch and
        # is read exactly as "everything under docs/", which is why the
        # everything-except test still passes.
        for pattern in scope.paths_ignore:
            if "**/" in pattern:
                raise UnsupportedPatternError(
                    f"{pattern} (`**/` under paths-ignore - it may consume "
                    "zero segments, which is permissive, and permissive under "
                    "negation excuses an absence rather than refusing it)"
                )
        return not _every_pattern_matched(scope.paths_ignore, path)
    raise ValueError(f"{scope.name}: no path filter at all - it admits every path")


#: How many hit files a refusal names before it truncates. The COUNT is always
#: printed, so truncation cannot make a large intersection look small.
_HITS_SHOWN = 3


def base_delta_is_inert(
    delta_files: list[str] | None,
    scopes: list[ContextScope],
    required: list[str],
) -> tuple[bool, str]:
    """#4585. Can the commits in `base..origin/main` affect THIS PR's evidence?

    Gate 1 requires `base == origin/main` because branch protection here is
    `strict=false`: without it, "all required contexts green" could be a
    statement about a base that no longer exists. That is correct, and it makes
    every merge staleness-block every other open PR -- clearing which is a push,
    which re-pins every live verdict as `predates-head`. Measured 2026-09-18:
    four rounds of verdicts burned on pushes where no content changed, and one
    re-run discarded a 42-minute mutation matrix over a base delta of three
    comment-only Dockerfiles.

    THIS IS A NARROWER PROPERTY THAN GATE 1'S, AND THE EARLIER TEXT HERE SAID
    THE OPPOSITE. It said "this is not a relaxation of the property, it is the
    same property measured directly". That was FALSE, both reviewers measured
    it, and the sentence is recorded here rather than deleted because a
    docstring asserting a soundness it does not have is the R7 error this
    package exists to refuse -- and because the chain of reasoning it invites
    is what the next person acts on.

    Gate 1's property is: THE CI GREEN BEING COUNTED WAS MEASURED AGAINST THE
    BASE BEING MERGED. What this function measures is: THE TRUNK'S OWN `push`
    FILTERS WOULD NOT HAVE RE-RUN THIS CONTEXT FOR THESE COMMITS. Those are
    different questions. `on.push.paths` models WHAT THE TRUNK RE-RUNS FOR, not
    WHAT A CONTEXT READS, and on this repo they already diverge:

    - `validate.yml` publishes FIVE required contexts while declaring only
      bicep paths plus `.github/workflows/**`.
    - `PowerShell Lint` inside it runs
      `Get-ChildItem -Path . -Filter "*.ps1" -Recurse`, and `Repo Hygiene` runs
      `find . -type f`. Both read the whole tree.
    - `Secret Scan` runs `gitleaks detect --config .gitleaks.toml`
      (`validate.yml:599`), and `.gitleaks.toml` matches none of the filtered
      contexts' patterns either.

    Fed the real scopes of the 12 filtered contexts -- the counterfactual this
    arm invites -- this function returns INERT for
    `deploy/bicep/DLZ/powershellHelper.ps1` and for a 6 MB binary, which
    `PowerShell Lint` and `Repo Hygiene` demonstrably read. It is harmless
    TODAY only because the five unfiltered contexts refuse everything, which is
    a property of the topology and not of this function.

    SO THE `on.push` FILTER IS A PROXY, AND ITS PRECONDITION IS UNESTABLISHED.
    Relying on it requires, PER CONTEXT, that the workflow's declared push
    scope be a SUPERSET of what that context actually reads. That has not been
    shown for any of the 12 filtered contexts; for three of them it is shown
    FALSE above. Nobody may make this arm fire -- by giving one of the five
    unfiltered workflows a `paths:` list, or any other route -- without
    establishing that superset relation for the contexts it would unblock.

    AND THE "MAIN WAS GREEN ANYWAY" ARGUMENT IS WEAKER THAN THIS GATE, which
    is the other thing the earlier text got wrong. That the trunk accepted
    these commits without re-running a context is a statement about TRUNK
    HYGIENE. Gate 1 stands in for `strict=true` on branch protection, and
    `strict` does not consult path filters AT ALL -- it requires the branch to
    be up to date, full stop. So "the trunk would not have re-run it" is
    strictly less than what gate 1 is substituting for, and it is offered here
    as the reason the refusals are safe, never as a proof that the passes are.

    WHAT MAKES THE ARM SAFE TO SHIP TODAY IS ITS FAIL-CLOSED BEHAVIOUR, not
    the proxy: every input that is not a measured miss refuses, five of the 17
    required contexts refuse unconditionally, and so no stale base reaches the
    GO path at all. `policy.json`'s `ci_green_rule` reads the same filters, and
    it is worth saying that it is not a precedent for this: it uses them to
    explain why a context was NEVER CREATED at a sha, which is a fact about
    GitHub's dispatcher, whereas this would use them to bound what a context
    READS, which is a fact about the job.

    EVERYTHING THAT IS NOT A MEASURED MISS IS A REFUSAL:

    - a required context with no scope at all (its producer could not be traced)
    - a producing workflow that could not be read or parsed
    - a workflow with NO `on.push` path filter -- it reads EVERYTHING
    - a workflow with an EMPTY one (`paths: []`) -- it matches NOTHING, which
      would make every delta read inert
    - a filter pattern `glob_matches` will not represent (`!`, `[...]`, ...)
    - a delta that could not be read
    - an empty required set

    `required` is passed SEPARATELY and set-equality is asserted against the
    scopes. Deriving the population from `scopes` itself would make the loop
    unable to witness a dropped context: a caller that silently omits the one
    context whose scope is unresolvable would produce a clean intersection over
    the remainder, which is the "a loop derived from the thing under test
    cannot witness it" shape.

    WHAT THIS ARM DOES ON THIS REPO TODAY, measured 2026-09-19 rather than
    projected, because an arm that cannot fire is the defect this package
    exists to find:

    - FIVE of the 17 required contexts are produced by workflows whose `push:`
      carries no `paths:` at all -- `fiab-console-ci.yml` (`next build
      (node 20)`, `vitest (node 20)`, `brain security graph`),
      `loom-guardrails.yml` (`guardrails`) and `commit-message-parses.yml`
      (`changelog parser can read every commit message`). Each reads
      EVERYTHING, so each refuses, so this arm refuses EVERY stale base today
      and gate 1 behaves exactly as it did before.
    - The issue's own worked example does not survive re-measurement either.
      #4574 -> #4552's delta is three Dockerfiles
      (`git diff --name-only 0c2c4c97434 e6d28c0892f`), and
      `apps/fiab-setup-orchestrator/Dockerfile` IS inside `test.yml`'s push
      paths -- so seven required contexts hit it on the filtered side as well.
      "That intersection is empty" was a hypothesis; it is false on two
      independent grounds.

    So this ships as the MECHANISM, tested in both directions ON THE ARM'S OWN
    LOGIC, and it would start firing if a producing workflow declared a
    `push` path scope. Read that scope narrowly: round 4 shipped the same
    phrase unqualified while `core.quotePath` was still unset on a sibling
    path-reading call, which EXCUSED rather than refused. Both directions
    describes the arm's decision logic, not a guarantee that every query
    feeding it reads paths faithfully - that is now held by `sh()`.
    That is technically available -- `on.push.paths` is a different event from
    `on.pull_request`, so a required check can keep reporting on every PR while
    declaring its push scope -- and it is deliberately NOT done here, for two
    reasons and not one: it changes what runs on main, AND the superset
    precondition above is unestablished, so declaring a filter would make this
    arm fire on a proxy that is known to be wrong for at least three contexts.
    Establish the superset relation per context FIRST. Do not report this arm
    as having reduced any cost until a real PR has passed on it.

    Returns `(inert, why)`. `why` NAMES the contexts considered on the passing
    arm -- an empty intersection is only evidence if you can see what it was
    taken over.
    """
    if not required:
        return False, (
            "the required-context set is EMPTY, so an empty intersection is "
            "vacuous - unmeasurable is not a pass"
        )
    by_name = {s.name: s for s in scopes}
    unscoped = sorted(set(required) - set(by_name))
    if unscoped:
        return False, (
            f"{len(unscoped)} required context(s) have no scope at all: "
            f"{unscoped} - an intersection taken over a subset of the required "
            "set cannot say anything about the rest"
        )
    if delta_files is None:
        return False, (
            "the base..origin/main delta could not be read, so nothing was "
            "intersected - unmeasurable is not a pass"
        )
    for name in required:
        scope = by_name[name]
        if scope.unreadable:
            return False, (
                f"{name!r}: {scope.unreadable} - a scope that could not be "
                "resolved refuses; it never reads as 'matches nothing'"
            )
        if scope.paths is None and scope.paths_ignore is None:
            return False, (
                f"{name!r} is produced by {scope.workflow_path} which declares "
                "NO `on.push` path filter, so it ADMITS EVERY PATH and any "
                "base delta can reach it"
            )
        # AN EMPTY LIST IS NOT THE SAME STATE AS AN ABSENT ONE, and it is the
        # dangerous one. `paths: []` parses to `()`, `any([])` is False, so
        # every delta falls outside the filter and the context excuses
        # everything -- the "matches nothing is the answer that lets a merge
        # through" shape, arriving through the one branch above that looked
        # like it had already handled it. `ContextScope`'s own docstring names
        # three states; this is the fourth, and it was unwatched.
        #
        # THE TWO EMPTY SPELLINGS ARE OPPOSITE FACTS AND GET OPPOSITE REASONS.
        # Round 2 shipped one message for both, saying "matches NOTHING" -- and
        # for `paths-ignore: []` that is INVERTED: ignoring nothing means the
        # workflow admits EVERYTHING. Worse, that half was already refused
        # correctly before the branch existed (every file matched the hit arm),
        # so a true reason was replaced with a false one. R7, introduced by the
        # fix for something else, which is why they are split here rather than
        # sharing a sentence.
        if scope.paths == ():
            return False, (
                f"{name!r}: {scope.workflow_path} declares an EMPTY `on.push` "
                "`paths` list, which ADMITS NOTHING - that is not a scope, it "
                "is a context that would excuse every delta"
            )
        if scope.paths_ignore == ():
            return False, (
                f"{name!r}: {scope.workflow_path} declares an EMPTY `on.push` "
                "`paths-ignore` list, which ignores nothing and therefore "
                "ADMITS EVERY PATH - any base delta can reach it"
            )
        if scope.paths is not None and scope.paths_ignore is not None:
            return False, (
                f"{name!r}: {scope.workflow_path} declares BOTH `paths` and "
                "`paths-ignore` on push - this translator will not guess which "
                "wins"
            )
        try:
            hits = [f for f in delta_files if filter_admits(scope, f)]
        except UnsupportedPatternError as exc:
            return False, (
                f"{name!r}: {scope.workflow_path} uses filter pattern "
                f"{str(exc)!r}, which this translator cannot represent "
                "faithfully - an unanswerable question is not an empty "
                "intersection"
            )
        except ValueError as exc:  # pragma: no cover - the branches above cover it
            return False, f"{name!r}: {exc}"
        if hits:
            return False, (
                f"{len(hits)} file(s) in the base delta are ADMITTED BY the "
                f"`on.push` filter of {name!r}'s producer "
                f"({scope.workflow_path}): {sorted(hits)[:_HITS_SHOWN]} - the "
                "trunk would have re-run it; take origin/main and re-run"
            )
    # THE VOCABULARY ON BOTH PASSING BRANCHES IS THE RETRACTION'S, and round 2
    # missed that. The prose was corrected to say this measures the trunk's
    # push filters rather than what a context READS -- while the string printed
    # BESIDE A MERGE BEING LET THROUGH still said "is read by". A retraction
    # that leaves the claim in the program's own output puts the false sentence
    # into the permanent record the moment the gate prints it.
    if not delta_files:
        return True, (
            "the base..origin/main delta lists NO files at all, so no required "
            f"context's `on.push` filter can admit anything from it - "
            f"{len(required)} considered: {sorted(required)}"
        )
    return True, (
        f"no file in the base..origin/main delta ({len(delta_files)} file(s)) "
        f"is admitted by the `on.push` filter of any of the {len(required)} "
        f"required context(s) {sorted(required)} - delta: "
        f"{sorted(delta_files)[:_HITS_SHOWN]}"
        + (f" (+{len(delta_files) - _HITS_SHOWN} more)"
           if len(delta_files) > _HITS_SHOWN else "")
        + ". NOT a claim that no required context READS those files: the "
          "filters bound what the trunk RE-RUNS, and the superset precondition "
          "is unestablished - see gates.base_delta_is_inert."
    )


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


def escalation_paths(policy: dict) -> tuple[str, ...]:
    """Path fragments that escalate, READ FROM THE AUTHORITY.

    This was a hardcoded tuple while `policy.json` carried four English
    sentences declared as its implementation. The list could be emptied,
    inverted or deleted and every decision stayed identical -- the
    `marker_any_of` defect (a policy value duplicating a constant, so editing
    the authority changes nothing) reintroduced one release after it was fixed.
    Two independent reviewers found it in the same round.
    """
    return tuple(policy.get("review", {}).get("escalate_to_two_when_path_contains", ()))


def escalation_streams(policy: dict) -> tuple[str, ...]:
    """Workstreams that escalate whatever the diff turns out to touch."""
    return tuple(policy.get("review", {}).get("escalate_to_two_when_stream_is", ()))


# What each lane OWNS. A lane name is not a path -- `lane:console` contains no
# substring of `apps/fiab-console` -- so a brief that passed the lane string
# straight to the path test silently never escalated. Measured: the console
# lane, which is the one `ux-baseline` G1 cares most about, asked for one
# reviewer.
#
# This map is a GUESS and is treated as one. A `lane:dataplane` fix can land in
# bicep, a workflow or a console surface, and `domains/` matches none of them --
# which is why an item's STREAM is consulted too, and why an unmapped lane
# escalates instead of falling through.
LANE_PATHS = {
    "lane:console": "apps/fiab-console",
    "lane:bicep": "platform/fiab/bicep",
    "lane:ci": "scripts/ci",
    "lane:dataplane": "domains/",
    "lane:docs": "docs/",
}


def review_requirement(policy: dict, changed_paths: list[str] | None = None,
                       prior_verdict: str | None = None,
                       stream: str | None = None,
                       footprint_known: bool = True,
                       stream_known: bool = True) -> tuple[int, str]:
    """How many independent reviewers this change needs, and why.

    Operator decision 2026-09-12. W0 -- the merge gate itself -- took EIGHT
    POSTED rounds with two reviewers, and that was right for the program that
    decides every merge. It is NOT the default for ordinary lanes: at ~296 it
    would dominate the run.

    FAILS CLOSED on an unknown footprint. The decision is usually taken at brief
    time, from a LANE, before the diff exists -- so the path set is a guess. An
    item with no lane produced `changed_paths=[""]`, matched nothing, and got
    one reviewer: **119 of 299** live items, including all four W0-harness ones
    and nine W1-deploy ones, i.e. precisely the diffs the policy says need two.
    (An earlier draft of this comment said 28, which is 119 minus the 91 in
    W9-rest -- a sub-population quoted without saying so, in a module that
    polices exactly that.) Every sibling control here fails closed; this one
    fell open.

    Returns (reviewers, reason) so a brief can state the requirement rather than
    leave the lane to infer it.
    """
    review = policy.get("review", {})
    default = int(review.get("independent_reviewers_default", 1))

    # `prior_verdict`, not `first_verdict`. The policy key is still named for
    # the FIRST reviewer because that is the operator's rule in their words, but
    # "first" cannot be the implementation: the drain posts its reviewers'
    # verdicts in parallel, one second apart, so which is first is a race. The
    # faithful reading is "a reviewer blocked", and `worst_verdict_in_history`
    # reduces worst-first to produce it.
    if review.get("escalate_on_blocking_first_verdict", True) and prior_verdict:
        # Shape, not spelling: `parse_verdicts` spends a whole apparatus on the
        # fact that "CHANGES REQUIRED" is a block written the wrong way. A
        # reviewer count that only recognised the exact token would let
        # formatting reduce a block to "one reviewer was enough".
        upper = prior_verdict.upper()
        # `"CHANGES REQUIRED"` is kept although no PRODUCTION caller can emit
        # it: `worst_verdict_in_history` returns a `VERDICT_TOKENS` member or
        # `UNANNOUNCED_BLOCK`, and a `CHANGES REQUIRED` header now arrives
        # through the near-miss path as the latter. The behaviour IS covered;
        # this branch is a second net for any future caller that passes a raw
        # header, and it is named here as such rather than left looking like a
        # live control -- a reviewer counted it as the same
        # proved-against-the-function-never-the-caller shape twice running.
        if any(t in upper for t in BLOCKING_TOKENS) or "CHANGES REQUIRED" in upper:
            # SAY WHICH IT IS. An unannounced block escalates on the same rule
            # -- formatting never reduces a block -- but attributing it to a
            # reviewer's decision is false: a comment that announces nothing
            # decided nothing. A reviewer measured ordinary status prose being
            # reported as "a reviewer returned REQUEST-CHANGES".
            if prior_verdict.startswith(UNANNOUNCED_BLOCK):
                return 2, (
                    f"{UNANNOUNCED_REASON_BY_KIND.get(_unannounced_kind(prior_verdict), UNANNOUNCED_REASON_UNKNOWN)}"
                    f" ({prior_verdict.strip()}) - not attributable to a "
                    "reviewer's decision, and it fails closed because "
                    "formatting never reduces a block"
                )
            return 2, f"a reviewer returned {prior_verdict.strip()!r}"

    if stream and stream in escalation_streams(policy):
        return 2, f"{stream} escalates whatever the diff turns out to touch"

    for path in changed_paths or []:
        normalized = path.replace("\\", "/")
        hit = next((p for p in escalation_paths(policy)
                    if normalized.startswith(p) or f"/{p}" in normalized), None)
        if hit:
            return 2, f"the diff touches {hit} - a guard, deploy or console surface"

    if not footprint_known and review.get("escalate_when_footprint_unknown", True):
        return 2, "the change's file footprint is not known yet - failing closed"
    # The merge-gate half of the same idea. At BRIEF time the stream is a fact
    # and the paths are a guess; at MERGE time the paths are a fact and the
    # stream must be resolved from the ledger through the issues the PR
    # references. `stream_known=False` says that resolution failed -- no issue
    # referenced, no ledger, or an issue the ledger has never seen -- and the
    # harness cannot place work it cannot classify.
    if not stream_known and review.get("escalate_when_stream_unknown", True):
        return 2, "the item's stream could not be resolved - failing closed"
    return default, "default for an ordinary lane"


def stop_and_ask_actions(policy: dict) -> list[str]:
    """The stop-and-ask action names, without the `_` documentation key.

    The raw dict carries a `"_"` key holding the rationale prose. Emitting it
    into a brief prints `Stop and ask for: _, add_trivyignore_entry, ...`,
    which reads as a parsing bug and teaches the reader to skim the line.
    """
    return sorted(k for k in policy.get("stop_and_ask", {}) if not k.startswith("_"))
