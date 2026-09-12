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

        An explicit `receipt_class` wins -- that is how `human-only` is reached
        for an item only a person can verify. Otherwise the console lane wins
        over the stream, and the stream over the default.
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
            existing.title = title
            existing.lane = lane
            existing.size = size
            for key, value in kwargs.items():
                if value is not None:
                    setattr(existing, key, value)
            if existing.state in TERMINAL:
                was = existing.state
                existing.state = NEEDS_AUDIT
                existing.audit_reason = AUDIT_REOPENED
                existing.history.append(
                    f"{_now()} -> {NEEDS_AUDIT} (was {was} but is OPEN on GitHub - "
                    "reopened, or closed in error)"
                )
            elif existing.state == NEEDS_AUDIT and existing.audit_reason == AUDIT_DEPARTED:
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
        """R2 in code, on the kind and not merely the presence."""
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

    def record_receipt(self, number: int, kind: str, ref: str) -> Item:
        """Attach the evidence that will let this item close."""
        item = self.items[number]
        item.receipt_kind = kind
        item.receipt_ref = ref
        item.history.append(f"{_now()} receipt {kind}: {ref}")
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
