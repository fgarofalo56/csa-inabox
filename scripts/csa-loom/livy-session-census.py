#!/usr/bin/env python3
"""livy-session-census.py — an HONEST census of a Synapse Spark pool's Livy sessions.

Why this exists
---------------
`spark-livy-probe.sh` and the `csa-loom-spark-probe3` workflow both asked Livy
for `?from=0&size=100`. Livy's sessions endpoint documents `size` as "By default
it is 20 and that is the maximum"
(https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session/get-spark-sessions)
and 400s above it — the same defect #3568 reported against the batches endpoint.

That made the probes wrong in the worst possible way. The census lines carried
`|| true` and `2>/dev/null`, so a 400 became an empty string, the empty string
became `sessions: []`, and the probe printed a confident `by state: {}` for a
pool that might hold 700 leaked sessions. The probe built to diagnose the #1796
jam would have reported the jam as absent.

A bare clamp to 20 would not fix it either: it would report the first 20 of 700
as if that were the whole pool. So this pages at the real cap until Livy's own
`total` is satisfied, and — when it cannot finish — says so out loud instead of
presenting a partial census as a total.

Usage
-----
    livy-session-census.py census   # counts by state, + completeness
    livy-session-census.py ids      # space-separated ids in reapable states

Env: DEV (workspace dev endpoint), API (livyApi path), TOK (bearer token).
Exits non-zero on a genuine HTTP/parse failure so the caller cannot mistake a
broken census for an empty pool.
"""
import json
import os
import sys
import urllib.request
from collections import Counter

# Livy's documented per-request maximum. NOT a tuning knob.
PAGE_SIZE = 20
# 40 x 20 = 800 sessions — comfortably above the ~700 seen in the #1796 jam.
MAX_PAGES = 40

REAPABLE_STATES = ("error", "dead", "killed", "not_started", "shutting_down")


def _get(url: str, token: str) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8") or "{}")


def census(dev, api, token):
    """Return (sessions, total_reported, complete).

    Deliberately un-annotated: a `tuple[...]` subscript is evaluated at def time
    and raises TypeError on Python < 3.9. This runs on a self-hosted runner
    whose interpreter version is not pinned anywhere, and a probe that dies at
    import is indistinguishable from a probe that found nothing.
    """
    sessions = []
    seen = set()
    total = 0
    frm = 0
    complete = False
    for _ in range(MAX_PAGES):
        url = "%s/%s?from=%d&size=%d&detailed=true" % (dev, api, frm, PAGE_SIZE)
        page = _get(url, token)
        batch = page.get("sessions") or []
        reported = page.get("total")
        if isinstance(reported, int):
            total = reported
        for s in batch:
            sid = s.get("id")
            if sid is not None and sid in seen:
                continue
            if sid is not None:
                seen.add(sid)
            sessions.append(s)
        if not batch:
            complete = True
            break
        frm += len(batch)
        if len(sessions) >= total:
            complete = True
            break
    return sessions, max(total, len(sessions)), complete


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "census"
    dev = os.environ["DEV"].rstrip("/")
    api = os.environ["API"].strip("/")
    token = os.environ["TOK"]

    try:
        sessions, total, complete = census(dev, api, token)
    except Exception as err:  # noqa: BLE001 — see below
        # Intentionally broad. The ONLY thing worse than a failed census is a
        # failed census that prints like an empty pool: an HTTPError, a socket
        # timeout (TimeoutError, not URLError, on 3.10+), a proxy fault and a
        # malformed body must ALL surface as "unknown", never as zero sessions.
        # That is precisely what the old `2>/dev/null` did.
        print("::error::livy session census FAILED (%s: %s) — the counts are UNKNOWN, "
              "not zero" % (type(err).__name__, err), file=sys.stderr)
        return 1

    if mode == "ids":
        print(" ".join(str(s["id"]) for s in sessions
                       if s.get("state") in REAPABLE_STATES and s.get("id") is not None))
        if not complete:
            print("::warning::census incomplete (%d of %d sessions read) — the clean-up "
                  "below covers only what was enumerated" % (len(sessions), total),
                  file=sys.stderr)
        return 0

    print("total reported:", total, "| in list:", len(sessions),
          "| complete:", complete,
          "| by state:", dict(Counter(s.get("state") for s in sessions)))
    if not complete:
        print("::warning::census stopped after %d pages (%d of %d sessions) — treat the "
              "state counts as a LOWER BOUND, not a total"
              % (MAX_PAGES, len(sessions), total))
    return 0


if __name__ == "__main__":
    sys.exit(main())
