"""The drain's durable state. The plan is a FILE, not an agent's context.

Why this exists: an operator asking an agent to "keep going" across a backlog
fails two ways -- the context fills and the plan is summarized into vagueness,
or the session dies and the plan dies with it. Here one cycle is one transaction
against this ledger, and a dead session costs at most the cycle in flight.

Terminal states are deliberately narrow. `deploy-integrity.md` R2: merged is
never done, so `closed` requires a RECEIPT and nothing else reaches it.
"""
from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone

SCHEMA = 1
DEFAULT_PATH = "tools/drain/state.json"

# Non-terminal states flow left to right; terminal states end a run.
READY = "ready"
IN_FLIGHT = "in-flight"
IN_REVIEW = "in-review"
AWAITING_RECEIPT = "awaiting-receipt"
CLOSED = "closed"
PARKED = "parked"
DECLINED = "declined"

TERMINAL = (CLOSED, PARKED, DECLINED)
ALL_STATES = (READY, IN_FLIGHT, IN_REVIEW, AWAITING_RECEIPT, *TERMINAL)


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


class Ledger:
    """Load / mutate / atomically save the drain state."""

    def __init__(self, path: str = DEFAULT_PATH):
        self.path = path
        self.items: dict[int, Item] = {}
        self.cycle: int = 0
        self.notes: list[str] = []

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
        for entry in raw.get("items", []):
            self.items[entry["number"]] = Item(**entry)
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

    def upsert(self, number: int, title: str, stream: str, **kwargs) -> Item:
        """Add an issue, or refresh a known one without losing its progress."""
        existing = self.items.get(number)
        if existing:
            existing.title = title
            for key, value in kwargs.items():
                if value is not None:
                    setattr(existing, key, value)
            return existing
        item = Item(number=number, title=title, stream=stream, **kwargs)
        item.history.append(f"{_now()} discovered in {stream}")
        self.items[number] = item
        return item

    def transition(self, number: int, state: str, why: str = "") -> Item:
        """Move an item, refusing transitions the policy does not allow.

        The two refusals are the load-bearing ones:

        - `closed` without a receipt. This is R2 in code. An issue closes on
          deployed-and-verified, never on a merge, and "the PR landed" is the
          single most common way a backlog lies about itself.
        - `parked` without a named blocker and owner. A park with no owner is
          indistinguishable from forgetting, and it is how an item leaves the
          queue without leaving the backlog.
        """
        if state not in ALL_STATES:
            raise ValueError(f"unknown state {state!r}")
        item = self.items[number]

        if state == CLOSED and not item.receipt_kind:
            raise ValueError(
                f"#{number}: refusing to close without a receipt "
                "(deploy-integrity R2 - merged is not done)"
            )
        if state == PARKED and not (item.blocker and item.owner):
            raise ValueError(
                f"#{number}: refusing to park without a named blocker AND owner"
            )

        item.state = state
        item.history.append(f"{_now()} -> {state}" + (f" ({why})" if why else ""))
        return item

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
        """True only when every item is terminal. This is the run's exit test."""
        return all(i.state in TERMINAL for i in self.items.values())

    def remaining(self) -> list[Item]:
        return [i for i in self.items.values() if i.state not in TERMINAL]

    def by_stream(self, stream: str) -> list[Item]:
        return [i for i in self.items.values() if i.stream == stream]
