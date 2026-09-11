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
NEAR_RE = re.compile(
    r"\b" + _VERB + r"[^\n]{0,80}?" + _REF + r"(?P<num>\d+)",
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

# Near-miss kinds. `blocks` is decided at parse time, not by the reducer.
NEAR_NO_MARKER = "no-marker"
NEAR_NO_TOKEN = "no-token"
NEAR_PREDATES_HEAD = "predates-head"
NEAR_TEMPLATE = "template-line"
NEAR_UNPINNABLE = "head-date-unknown"


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

        token = next((t for t in VERDICT_TOKENS if t in head), None)
        has_marker = any(m in body for m in MARKERS)

        # The review TEMPLATE lists every token on one line. It is an
        # instruction to the reviewer, not a decision, and reading it in token
        # order would register the first one listed.
        if token and all(t in head for t in VERDICT_TOKENS):
            near.append(
                NearMiss(cid, when, "carries the verdict TEMPLATE line, not a decision",
                         NEAR_TEMPLATE, blocks=has_marker)
            )
            continue

        if not has_marker:
            if token:
                near.append(
                    NearMiss(cid, when, f"carries {token} but no marker", NEAR_NO_MARKER,
                             blocks=token in BLOCKING_TOKENS)
                )
            continue
        if not head_date:
            near.append(
                NearMiss(cid, when, "head commit date unknown - verdict cannot be pinned",
                         NEAR_UNPINNABLE, blocks=True)
            )
            continue
        if token is None:
            near.append(
                NearMiss(cid, when, f"marker, but no token in body[:{window}]",
                         NEAR_NO_TOKEN, blocks=True)
            )
            continue
        if when < head_date:
            near.append(
                NearMiss(cid, when, f"marker and {token} present, but predates head {head_date}",
                         NEAR_PREDATES_HEAD, blocks=False)
            )
            continue
        live.append(Verdict(token=token, created_at=when, comment_id=cid))

    return live, near


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

# GitHub conclusions that mean the check MEASURED something and it was bad.
RED_CONCLUSIONS = frozenset(
    {"FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"}
)
# Conclusions that mean the check has not finished. A required context that has
# not concluded is INCOMPLETE, never a pass.
INCOMPLETE_STATUSES = frozenset({"QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"})


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
        status = (check.get("status") or "").upper()
        conclusion = (check.get("conclusion") or check.get("state") or "").upper()
        if conclusion in RED_CONCLUSIONS:
            reasons.append(f"{name}: RED ({conclusion})")
        elif not conclusion or status in INCOMPLETE_STATUSES:
            reasons.append(f"{name}: INCOMPLETE (status={status or 'unknown'})")
    return (not reasons), reasons


def _check_rank(check: dict) -> int:
    """Worst-first ranking, so a duplicated context is judged by its worst run."""
    conclusion = (check.get("conclusion") or check.get("state") or "").upper()
    status = (check.get("status") or "").upper()
    if conclusion in RED_CONCLUSIONS:
        return 3
    if not conclusion or status in INCOMPLETE_STATUSES:
        return 2
    return 1


def check_is_hollow(name: str, conclusion: str, measured: int | None) -> tuple[bool, str]:
    """PRP §6 gate 5: did this check MEASURE anything, or pass over zero files?

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
