"""The drain's durable state. The plan is a FILE, not an agent's context.

Why this exists: an operator asking an agent to "keep going" across a backlog
fails two ways -- the context fills and the plan is summarized into vagueness,
or the session dies and the plan dies with it. Here one cycle is one transaction
against this ledger, and a dead session costs at most the cycle in flight.

Terminal states are deliberately narrow. `deploy-integrity.md` R2: merged is
never done, so `closed` requires a RECEIPT OF THE KIND ITS CLASS REQUIRES and
nothing else reaches it. Presence alone is not enough: the first version of this
module checked that a receipt was truthy, which closed a console surface on the
string `"merged"` -- the one thing R2 says is never a receipt.
"""
from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict, dataclass, field, fields
from datetime import datetime, timezone

SCHEMA = 2
DEFAULT_PATH = "tools/drain/state.json"

# Non-terminal states flow left to right; terminal states end a run.
READY = "ready"
IN_FLIGHT = "in-flight"
IN_REVIEW = "in-review"
AWAITING_RECEIPT = "awaiting-receipt"
NEEDS_AUDIT = "needs-audit"
CLOSED = "closed"
PARKED = "parked"
DECLINED = "declined"

TERMINAL = (CLOSED, PARKED, DECLINED)
ALL_STATES = (READY, IN_FLIGHT, IN_REVIEW, AWAITING_RECEIPT, NEEDS_AUDIT, *TERMINAL)

# Why an item is in `needs-audit`. The two have OPPOSITE resolutions when the
# issue turns up open again, so collapsing them made the state one-way.
AUDIT_DEPARTED = "departed"   # vanished from the live set; nobody said why
AUDIT_REOPENED = "reopened"   # was terminal here and is open on GitHub
# Its receipt CLASS changed under it, so the receipt it held was evidence about
# a different question.
AUDIT_RECLASSIFIED = "reclassified"

# All three CLEAR the held receipt, and none requires a human: `transition` does
# not gate on the current state, so a lane re-takes a receipt and closes from
# any of them. The control is the KIND check, not a person.
#
# An earlier version of this comment said that and was TRUE only for
# `reclassified`, because only that route voided anything. For `reopened` the
# stale receipt survived, satisfied the kind check trivially, and the audit was
# discharged by re-running the same call -- so the comment asserted as fact
# something the code did not establish for one of the two reasons it described
# (deploy-integrity R7). The void is now on both routes; the sentence is now
# true of all three.

# Which receipt class an item falls into, derived from the stream it sits in.
# The brief an agent reads is generated from this, so a wrong entry here tells
# an agent that CI green closes a deploy-path issue -- which is R2 inverted, and
# emitted by the control that exists to prevent it.
RECEIPT_CLASS_BY_STREAM = {
    "W0-harness": "guard-or-test-only",
    "W1-deploy": "deploy-path",
    "W2-security": "guard-or-test-only",
    "W3-gov": "deploy-path",
    "W4-receipts": "estate-behaviour",
    "W5-console": "ui-surface",
    "W6-ci": "guard-or-test-only",
    "W7-bicep": "deploy-path",
    "W8-dataplane": "estate-behaviour",
    "W9-rest": "guard-or-test-only",
}
DEFAULT_RECEIPT_CLASS = "guard-or-test-only"

# A console-lane item is a UI surface whatever stream it was filed under, and a
# UI surface closes on a browser walk (G1), never on CI.
LANE_RECEIPT_CLASS = {"lane:console": "ui-surface"}


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class Item:
    """One issue under the drain."""

    number: int
    title: str
    stream: str
    state: str = READY
    lane: str | None = None
    size: int | None = None
    pr: int | None = None
    receipt_kind: str | None = None
    receipt_ref: str | None = None
    #: The `effective_receipt_class` in force WHEN the receipt was taken,
    #: stamped by `record_receipt` and re-checked by `_refuse_unless_receipted`.
    #: An item with no receipt carries None, and None == None, so the invariant
    #: is inert until there is something to be invariant about.
    receipt_taken_under: str | None = None
    receipt_class: str | None = None
    audit_reason: str | None = None
    blocker: str | None = None
    owner: str | None = None
    review_by: str | None = None
    history: list[str] = field(default_factory=list)

    @property
    def schedulable(self) -> bool:
        """An item with no lane cannot be safely parallelized.

        Lanes partition by FILE. A shared-file conflict must serialize, never
        parallelize -- so an unlaned item is not merely unsized, it is unsafe to
        schedule alongside anything.
        """
        return self.lane is not None and self.size is not None

    @property
    def effective_receipt_class(self) -> str:
        """Which of policy.json's five receipt classes closes this item.

        An explicit `receipt_class` wins, then the console lane, then the
        stream, then the default.

        `receipt_class` HAS NO PRODUCTION WRITER. `refresh_from_github` passes
        `lane` and `size` and nothing else, so the only way it is set today is a
        hand edit to `state.json` -- which means `human-only` is, by this
        module's own standard, currently prose. It is kept because the
        precedence is load-bearing for the `upsert` guard's correctness and
        because a `receipt-class:` label reader is the obvious next writer; it
        must not be described as a reachable path until one exists.
        """
        if self.receipt_class:
            return self.receipt_class
        if self.lane in LANE_RECEIPT_CLASS:
            return LANE_RECEIPT_CLASS[self.lane]
        return RECEIPT_CLASS_BY_STREAM.get(self.stream, DEFAULT_RECEIPT_CLASS)


class Ledger:
    """Load / mutate / atomically save the drain state.

    `receipts` is `policy.json`'s receipts map. Without it the ledger CANNOT
    validate that a receipt is of the kind an item's class requires, so it
    refuses to close anything rather than falling back to a presence check.
    """

    def __init__(self, path: str = DEFAULT_PATH, receipts: dict | None = None):
        self.path = path
        self.items: dict[int, Item] = {}
        self.cycle: int = 0
        self.notes: list[str] = []
        self.receipts = receipts or {}
        self.loaded_from_disk = False

    # -- persistence --------------------------------------------------------

    def load(self) -> Ledger:
        if not os.path.exists(self.path):
            return self
        with open(self.path, encoding="utf-8") as handle:
            raw = json.load(handle)
        if raw.get("schema") != SCHEMA:
            raise SystemExit(
                f"ledger schema {raw.get('schema')} != {SCHEMA} - migrate deliberately"
            )
        self.cycle = raw.get("cycle", 0)
        self.notes = raw.get("notes", [])
        known = {f.name for f in fields(Item)}
        for entry in raw.get("items", []):
            self.items[entry["number"]] = Item(**{k: v for k, v in entry.items() if k in known})
        self.loaded_from_disk = True
        return self

    def save(self) -> None:
        """Write atomically.

        A half-written ledger is worse than none: the next cycle would read a
        truncated plan as the whole plan. Write to a temp file in the same
        directory and replace, so a reader sees the old file or the new one.
        """
        payload = {
            "schema": SCHEMA,
            "cycle": self.cycle,
            "updated": _now(),
            "notes": self.notes,
            "counts": self.counts(),
            "items": [asdict(i) for i in sorted(self.items.values(), key=lambda x: x.number)],
        }
        directory = os.path.dirname(self.path) or "."
        os.makedirs(directory, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp")
        os.close(fd)
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=1)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, self.path)

    # -- mutation -----------------------------------------------------------

    def upsert(
        self,
        number: int,
        title: str,
        stream: str,
        lane: str | None = None,
        size: int | None = None,
        **kwargs,
    ) -> Item:
        """Add an issue, or refresh a known one without losing its progress.

        `lane` and `size` are AUTHORITATIVE from GitHub's labels and are written
        even when they arrive as None -- a label removed on GitHub must clear
        the ledger's copy, or an item stays schedulable on a lane it no longer
        claims. Everything else keeps the None-skip, so a partial refresh cannot
        erase progress.

        An item that is TERMINAL and is seen open on GitHub again has been
        REOPENED. That is how a false close gets disputed, so it must re-enter
        the queue: it lands in `needs-audit`, never silently back in `ready`
        (whatever closed it may still be true) and never left terminal.
        """
        existing = self.items.get(number)
        if existing:
            # SNAPSHOT THE OUTCOME, NOT ONE OF ITS CAUSES.
            #
            # `effective_receipt_class` has THREE inputs -- an explicit
            # `receipt_class`, then `lane`, then `stream` -- and `upsert` writes
            # all three from live GitHub data. The previous guard keyed on
            # `stream` alone, which left the LANE door open: and the lane is the
            # door the comment it replaced named as the attack. Measured at
            # ec66f72, suite green: a `ui-surface` item holding a refused
            # `ci-green`, lose `lane:console`, class drops to
            # `guard-or-test-only`, the SAME receipt closes it, nothing in
            # `history`. Eleven live items sit on a lane-derived class today, 8
            # of them W2-security items whose required receipt would fall from
            # `g1-browser` (a live browser walk, ux-baseline G1) to `ci-green`.
            #
            # So the comparison is taken over the CLASS, before any write and
            # again after all of them. That is the form that does not need
            # re-patching when a fourth input appears -- the previous two
            # versions of this guard were each a narrower enumeration of causes.
            was_class = existing.effective_receipt_class
            was_stream, was_lane = existing.stream, existing.lane
            was_state = existing.state

            existing.title = title
            existing.lane = lane
            existing.size = size
            # A re-pin has to reach an item already in the ledger: the stream
            # decides selection order and feeds the class, and the pinned sets
            # in `build_inventory` are how a misclassification gets corrected.
            # Measured: #4485 was pinned to W0-harness and stayed W6-ci.
            if stream:
                existing.stream = stream
            for key, value in kwargs.items():
                if value is not None:
                    setattr(existing, key, value)

            if existing.stream != was_stream:
                existing.history.append(
                    f"{_now()} stream {was_stream} -> {existing.stream}"
                )
            if existing.lane != was_lane:
                existing.history.append(f"{_now()} lane {was_lane} -> {existing.lane}")
            now_class = existing.effective_receipt_class
            # ANY class change voids a held receipt. NOT "the receipt is no
            # longer valid for the new class" -- that was the first attempt and
            # it never fires on the dangerous case, because a DOWNGRADE is
            # precisely where the old receipt BECOMES valid. Running the
            # reviewers' own input against that patch showed the attack still
            # succeeding.
            #
            # A receipt is evidence about a QUESTION. Change the class and it is
            # evidence about a different question, whichever direction it moved.
            if now_class != was_class:
                if existing.receipt_kind:
                    existing.history.append(
                        f"{_now()} receipt {existing.receipt_kind!r} "
                        f"({existing.receipt_ref}) VOID - it was taken against "
                        f"{was_class}, and this item is now {now_class}. A receipt is "
                        "evidence about a class; the class changed (R2)"
                    )
                    existing.receipt_kind = None
                    existing.receipt_ref = None
                    existing.receipt_taken_under = None
                else:
                    # No receipt to void, but the class still moved. Silence here
                    # is how the downgrade stayed invisible in the first place.
                    existing.history.append(
                        f"{_now()} receipt class {was_class} -> {now_class}"
                    )
                # A lane MID-WORK is working toward a target that just moved, so
                # it is flagged whether or not a receipt had been taken yet.
                #
                # But ONLY mid-work. A `ready` item has nothing to audit -- its
                # receipt is void, that is recorded, and what it needs is
                # re-work, which is what `ready` means. Routing every
                # reclassification to `needs-audit` STRANDED items: `audit_reason`
                # is a scalar, so overwriting a `departed` reason made the
                # departure rescue's `elif` unmatchable and the item could never
                # return to the queue -- the one-way `needs-audit` that rescue
                # exists to prevent.
                #
                # `was_state`, not `existing.state`: the kwargs loop above
                # writes arbitrary fields, `state` among them, so reading the
                # POST-write state let a `state='ready'` kwarg suppress this
                # routing. Not reachable from either production caller today --
                # neither passes `state=` -- but the class comparison two lines
                # up was hardened against exactly this and its sibling was not.
                if was_state in (IN_FLIGHT, IN_REVIEW, AWAITING_RECEIPT):
                    existing.audit_reason = AUDIT_RECLASSIFIED
                    existing.state = NEEDS_AUDIT
            if was_state in TERMINAL:
                existing.state = NEEDS_AUDIT
                existing.audit_reason = AUDIT_REOPENED
                existing.history.append(
                    f"{_now()} -> {NEEDS_AUDIT} (was {was_state} but is OPEN on "
                    "GitHub - reopened, or closed in error)"
                )
                # THE SIBLING OF THE CLASS-CHANGE VOID, and it was missed.
                #
                # A reopen DISPUTES the receipt that closed the item, and the
                # class has not moved, so nothing above touches it. Measured by
                # a reviewer: close on `ci-green`, reopen, and `receipt_ok()` --
                # which `merge_gate.ledger_receipt_ready` calls -- still said
                # True, so `--allow-close` re-closed on the very evidence being
                # disputed, with no new work. The kind check is satisfied
                # trivially here; there is nothing left to re-take.
                receipt_is_the_thing_in_dispute = bool(existing.receipt_kind)
                if receipt_is_the_thing_in_dispute:
                    existing.history.append(
                        f"{_now()} receipt {existing.receipt_kind!r} "
                        f"({existing.receipt_ref}) VOID - this item was closed on it "
                        "and is open again, so that receipt is the thing in dispute. "
                        "Re-take it (R2)"
                    )
                    existing.receipt_kind = None
                    existing.receipt_ref = None
                    existing.receipt_taken_under = None
            elif was_state == NEEDS_AUDIT and existing.audit_reason == AUDIT_DEPARTED:
                # It was flagged because it VANISHED from the live set, and here
                # it is. The departure was a truncated read or a transient, and
                # its premise is now void -- so it returns to the queue. Without
                # this, `needs-audit` was one-way: a flaky read could strand
                # items no lane would ever pick up again and no CLI could clear.
                existing.state = READY
                existing.audit_reason = None
                existing.history.append(
                    f"{_now()} -> {READY} (open on GitHub again; the departure that "
                    "flagged it was transient)"
                )
            return existing
        item = Item(number=number, title=title, stream=stream, lane=lane, size=size, **kwargs)
        item.history.append(f"{_now()} discovered in {stream}")
        self.items[number] = item
        return item

    def transition(self, number: int, state: str, why: str = "") -> Item:
        """Move an item, refusing transitions the policy does not allow.

        The two refusals are the load-bearing ones:

        - `closed` without a receipt OF THE RIGHT KIND. This is R2 in code. An
          issue closes on deployed-and-verified, never on a merge, and "the PR
          landed" is the single most common way a backlog lies about itself. A
          presence-only check let the literal string `"merged"` through.
        - `parked` without a named blocker and owner. A park with no owner is
          indistinguishable from forgetting, and it is how an item leaves the
          queue without leaving the backlog.
        """
        if state not in ALL_STATES:
            raise ValueError(f"unknown state {state!r}")
        item = self.items[number]

        if state == CLOSED:
            self._refuse_unless_receipted(item)
        if state == PARKED and not (item.blocker and item.owner):
            raise ValueError(
                f"#{number}: refusing to park without a named blocker AND owner"
            )
        # `declined` is the THIRD terminal state and had no refusal at all: an
        # empty `why` recorded "-> declined" and nothing else, so 297 items
        # could reach `drained(): True` -- this program's exit condition -- with
        # zero evidence. PRP §1 and the README both say declined requires a
        # recorded decision; two of the three refusals were in code and this one
        # was only in prose.
        if state == DECLINED and not (why and why.strip()):
            raise ValueError(
                f"#{number}: refusing to decline without a recorded decision - "
                "pass `why` naming WHO decided and on what grounds"
            )

        item.state = state
        item.history.append(f"{_now()} -> {state}" + (f" ({why})" if why else ""))
        return item

    def receipt_ok(self, item: Item) -> tuple[bool, str]:
        """Public form of the R2 refusal, for callers that want to ASK.

        `merge_gate` needs to know whether an item could close before it will
        let a lane declare an auto-close, and it was reaching into the private
        method to find out. Same rule, one implementation.
        """
        try:
            self._refuse_unless_receipted(item)
        except ValueError as exc:
            return False, str(exc)
        return True, f"#{item.number} holds a {item.receipt_kind} receipt"

    def _refuse_unless_receipted(self, item: Item) -> None:
        """R2 in code, on the kind and not merely the presence.

        THE INVARIANT, checked at the decision. `upsert`'s class comparison is
        an EVENT OBSERVER: it can only witness a class that moves across a call
        it makes. Two of `effective_receipt_class`'s inputs are not fields at
        all -- `RECEIPT_CLASS_BY_STREAM` and `LANE_RECEIPT_CLASS` are module
        constants -- so a one-line edit to either moved every held receipt's
        class with NOTHING in `history`, which is the identical symptom as the
        round-3 defect, reached through an input no `upsert` guard can see.
        Measured by a reviewer: a `ui-surface` item whose `ci-green` had just
        been refused closed on that same receipt after one map edit.

        There is a milder, no-source-edit form: `merge_gate` LOADS `state.json`
        and never upserts, so adding `lane:console` to an issue and running
        `--allow-close` before the next tick evaluates the receipt against the
        stale, weaker class.

        So the class is stamped at capture (`record_receipt`) and compared here.
        This ends the sequence rather than adding a fifth enumeration of causes:
        it does not care HOW the class moved, or whether anything observed it
        move. `upsert`'s comparison stays, because it is what produces good
        `history` and the `needs-audit` routing -- but it is no longer the
        load-bearing control.
        """
        if not item.receipt_kind:
            raise ValueError(
                f"#{item.number}: refusing to close without a receipt "
                "(deploy-integrity R2 - merged is not done)"
            )
        if not self.receipts:
            raise ValueError(
                f"#{item.number}: refusing to close - no policy receipts map, so the "
                "receipt KIND cannot be validated. Construct Ledger(receipts=policy['receipts'])."
            )
        want = self.receipts.get(item.effective_receipt_class)
        if not want:
            raise ValueError(
                f"#{item.number}: receipt class {item.effective_receipt_class!r} is not in "
                "policy.json receipts - unclassifiable, so unclosable"
            )
        if item.receipt_kind != want:
            raise ValueError(
                f"#{item.number}: receipt {item.receipt_kind!r} does not close a "
                f"{item.effective_receipt_class!r} item - that needs {want!r} "
                "(deploy-integrity R2)"
            )
        # A receipt whose kind happens to match the CURRENT class but was taken
        # under a different one is the downgrade case, and it is precisely where
        # the kind check above is trivially satisfied.
        if item.receipt_taken_under != item.effective_receipt_class:
            raise ValueError(
                f"#{item.number}: receipt {item.receipt_kind!r} ({item.receipt_ref}) "
                f"was taken under {item.receipt_taken_under!r} and this item is now "
                f"{item.effective_receipt_class!r} - a receipt is evidence about a "
                "CLASS, so re-take it under the current one (deploy-integrity R2)"
            )

    def record_receipt(self, number: int, kind: str, ref: str) -> Item:
        """Attach the evidence that will let this item close.

        The CLASS the receipt was taken under is stamped here, at capture time,
        and re-checked at the decision. That is what makes the R2 control an
        INVARIANT rather than an event observer -- see
        `_refuse_unless_receipted`.
        """
        item = self.items[number]
        item.receipt_kind = kind
        item.receipt_ref = ref
        item.receipt_taken_under = item.effective_receipt_class
        item.history.append(
            f"{_now()} receipt {kind}: {ref} (taken under {item.receipt_taken_under})"
        )
        return item

    # -- queries ------------------------------------------------------------

    def counts(self) -> dict:
        out = dict.fromkeys(ALL_STATES, 0)
        for item in self.items.values():
            out[item.state] = out.get(item.state, 0) + 1
        out["total"] = len(self.items)
        out["unschedulable"] = sum(
            1 for i in self.items.values()
            if i.state not in TERMINAL and not i.schedulable
        )
        return out

    def drained(self) -> bool:
        """True only when there ARE items and every one of them is terminal.

        `all([])` is True. Without the emptiness clause a fresh clone, a wiped
        scratch file or a `git clean -xfd` reports a 297-issue backlog DRAINED
        before any work has been done -- and `--status` printing `drained: true`
        is this program's documented exit condition, so that answer ends the
        run. An empty ledger is the absence of a measurement, not a result.
        """
        return bool(self.items) and all(i.state in TERMINAL for i in self.items.values())

    def remaining(self) -> list[Item]:
        return [i for i in self.items.values() if i.state not in TERMINAL]

    def by_stream(self, stream: str) -> list[Item]:
        return [i for i in self.items.values() if i.stream == stream]
