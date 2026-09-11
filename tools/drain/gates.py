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
# Keyed to the SHAPE -- verb + optional colon + reference -- not to a spelling
# list. A `closes #|fixes #|resolves #` pattern returns ZERO on `close #3933`
# (singular) and on `fixed: #4361` (past tense + colon), and both of those
# auto-closed a live issue.
#
# GitHub honours nine verbs and has NO notion of negation: "Does not close #N"
# closes #N.
CLOSING_RE = re.compile(
    r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)",
    re.IGNORECASE,
)

# A verb near a reference but not adjacent -- e.g. `fixed in #4396`, `fix (#123)`.
# GitHub does not act on these, but they are one edit away from doing so, so the
# scan reports them for a human look rather than passing silently.
NEAR_RE = re.compile(
    r"\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[^\n#]{1,12}#(\d+)",
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
    """
    hard = [int(m.group(1)) for m in CLOSING_RE.finditer(text)]
    near = [
        int(m.group(2))
        for m in NEAR_RE.finditer(text)
        if not CLOSING_RE.match(m.group(0))
    ]
    return ClosingScan(hard=hard, near=near)


def merge_is_close_safe(body: str, commit_messages: list[str]) -> ClosingScan:
    """Scan BOTH surfaces a squash merge publishes.

    `closingIssuesReferences` is NOT a complete oracle. Measured 2026-09-11 on
    PR #4369: the field read EMPTY, the body was clean, and the merge closed
    #4361 anyway -- from `fixed: #4361` in the SYNTHESIZED SQUASH COMMIT. That
    API field reflects the PR body and linked-issue association, never the
    commit trail a squash concatenates.
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
MARKERS = ("Independent review", "Independent re-review")


@dataclass
class Verdict:
    """One parsed review verdict, pinned to the head it measured."""

    token: str
    created_at: str
    comment_id: int


@dataclass
class NearMiss:
    """A comment that ALMOST registered, and why it did not.

    Silence is the enemy here. Before this existed the gate printed only
    "no live APPROVE", which is indistinguishable between "nobody reviewed
    this" and "somebody reviewed it and I could not parse them". A sound
    APPROVE was discarded for reading "Re-review" instead of "Independent
    re-review", and two blocking verdicts were discarded for writing
    "CHANGES REQUIRED" instead of the literal token -- invisible for two
    rounds.
    """

    comment_id: int
    created_at: str
    reason: str


def parse_verdicts(
    comments: list[dict], head_date: str | None, window: int = 200
) -> tuple[list[Verdict], list[NearMiss]]:
    """Parse issue comments into live verdicts plus explained near-misses.

    Three conjunctive conditions: a marker anywhere in the body, a verdict token
    inside the first `window` characters, and a timestamp at or after the head
    commit. Tokens are checked in VERDICT_TOKENS order deliberately -- scanning
    the whole body would read "the previous REQUEST-CHANGES is addressed" as a
    fresh block, inverting the decision.
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

        if not has_marker:
            if token:
                near.append(NearMiss(cid, when, f"carries {token} but no marker"))
            continue
        if token is None:
            near.append(NearMiss(cid, when, f"marker, but no token in body[:{window}]"))
            continue
        if head_date and when < head_date:
            near.append(
                NearMiss(cid, when, f"marker and {token} present, but predates head {head_date}")
            )
            continue
        live.append(Verdict(token=token, created_at=when, comment_id=cid))

    return live, near


def reduce_verdicts(live: list[Verdict]) -> tuple[bool, str]:
    """Decide GO/NO-GO from live verdicts by CONJUNCTION, not recency.

    A later APPROVE does NOT discharge an earlier block. Reduce by conjunction:
    any live blocking verdict blocks, regardless of what came after it.
    """
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
    """
    if action in policy.get("never", []):
        return False, "NEVER: refused unconditionally"
    stop = policy.get("stop_and_ask", {})
    if action in stop:
        return False, f"STOP AND ASK: {stop[action]}"
    if action in policy.get("permitted_unattended", []):
        return True, "permitted unattended"
    return False, "not in permitted_unattended - fails closed, add it to policy.json deliberately"
