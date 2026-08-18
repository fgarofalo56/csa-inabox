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
as if that were the whole pool. So this pages at the real cap and reports
`complete` ONLY when completeness was actually established — the server ran the
list dry, or it reported a `total` and we reached it. A backend that omits
`total` (or returns an empty body, or a page with no `sessions` key) cannot talk
this script into a confident answer: the walk keeps going until a page runs dry,
and anything it genuinely cannot establish surfaces as a warning or a non-zero
exit, never as a total.

Usage
-----
    livy-session-census.py census   # counts by state, + completeness
    livy-session-census.py ids      # space-separated ids in reapable states

Env: DEV (workspace dev endpoint), API (livyApi path), TOK (bearer token).
Exits non-zero on a genuine HTTP/parse failure so the caller cannot mistake a
broken census for an empty pool. CALLERS MUST CHECK THAT EXIT CODE — a
`$(...)`-captured invocation in a script without `set -e` discards it, which is
how the same swallow this file removed reappears one level up.
"""
import json
import os
import sys
import urllib.parse
import urllib.request
from collections import Counter

# Livy's documented per-request maximum. NOT a tuning knob.
PAGE_SIZE = 20
# 40 x 20 = 800 sessions — comfortably above the ~700 seen in the #1796 jam.
MAX_PAGES = 40

REAPABLE_STATES = ("error", "dead", "killed", "not_started", "shutting_down")


def _get(url: str, token: str) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
    # `DEV` is operator-supplied, so the scheme is checked STRUCTURALLY (parse,
    # not a substring test) right at the call site. Same shape as the sibling
    # loom-unity-migrate-catalog.py — it keeps the guarantee next to the
    # urlopen rather than making a reader trace it back to the caller.
    if urllib.parse.urlparse(url).scheme not in ("http", "https"):
        raise ValueError(f"refusing non-http(s) request URL: {url!r}")
    # nosec B310 - the URL scheme is allow-listed to http/https on the two lines
    # above, so B310's concern (file:/ + custom schemes) cannot be reached.
    # Suppressed HERE rather than added to the global pyproject skips, so any
    # FUTURE urlopen elsewhere is still flagged.
    with urllib.request.urlopen(req, timeout=60) as resp:  # nosec B310
        raw = resp.read().decode("utf-8")
    if not raw.strip():
        # A 200 with an EMPTY BODY is not an empty pool. The old `or "{}"` turned
        # one into the other, and `{}` walked straight out as
        # `total: 0 | in list: 0 | complete: True | by state: {}` — a broken
        # census printing as a healthy pool, exit 0. That is verbatim the class
        # this file's docstring says it exists to prevent, so it must land in
        # main()'s `except` and exit non-zero instead.
        raise ValueError(
            f"empty body from {url} — a 200 with no payload means the counts are "
            f"UNKNOWN, not zero")
    body = json.loads(raw)
    if not isinstance(body, dict):
        raise ValueError(f"expected a JSON object from {url}, got {type(body).__name__}")
    return body


def _pool_wide_total(reported, page_len):
    """Return `reported` only when it CANNOT be this page's own length.

    Livy's server means `sessionManager.size()` — the whole pool — but the
    Azure REST spec that generates every Synapse Spark SDK documents the
    sibling batches field the other way:

        specification/synapse/data-plane/Microsoft.Synapse/preview/
        2019-11-01-preview/sparkJob.json
          SparkBatchJobCollection.total -> "Number of sessions fetched."

    and gives `SparkSessionCollection` — the shape THIS endpoint returns — no
    description at all. Under the page-length reading a 137-session pool
    answers page one with `total: 20` beside 20 rows, `len(sessions) >= total`
    is `20 >= 20`, and the walk stops one page in reporting `complete: True`.
    A 20-of-137 census printed as the whole pool is the #1796 jam reported as
    absent — exactly what this script exists to prevent.

    `reported > page_len` is the one observation impossible under the
    page-length reading (a page length cannot exceed itself), so it alone is
    accepted. Anything else leaves the total unknown and lets the walk end the
    only way that is honest under BOTH readings: a page that comes back empty.
    On a pool holding one page or less that costs one extra request.

    Position-independent on purpose: this runs on EVERY page, so it cannot lean
    on "a short page means the list is exhausted" the way a first-page-only
    check could.
    """
    if not isinstance(reported, int) or isinstance(reported, bool):
        # `isinstance(True, int)` is True in Python; a bool `total` is not a count.
        return None
    return reported if reported > page_len else None


def census(dev, api, token):
    """Return (sessions, total_reported_or_None, complete).

    `total_reported_or_None` is None when the SERVER never reported a total we
    can navigate by — absent, or indistinguishable from the length of the page
    it arrived on (see `_pool_wide_total`). Substituting a number of our own
    there is what turned a partial walk into a confident one, so the unknown is
    propagated rather than filled.

    Deliberately un-annotated: a `tuple[...]` subscript is evaluated at def time
    and raises TypeError on Python < 3.9. This runs on a self-hosted runner
    whose interpreter version is not pinned anywhere, and a probe that dies at
    import is indistinguishable from a probe that found nothing.
    """
    sessions = []
    seen = set()
    total = None
    frm = 0
    complete = False
    for _ in range(MAX_PAGES):
        url = f"{dev}/{api}?from={frm}&size={PAGE_SIZE}&detailed=true"
        page = _get(url, token)
        batch = page.get("sessions")
        if not isinstance(batch, list):
            # No `sessions` key at all. We cannot tell an exhausted list from a
            # malformed response, and guessing "exhausted" is how a broken read
            # becomes a confident count. Say we do not know.
            raise ValueError(
                f"page at from={frm} carries no 'sessions' list "
                f"(keys: {sorted(page.keys())}) — cannot distinguish an "
                f"exhausted list from a broken response")
        reported = _pool_wide_total(page.get("total"), len(batch))
        if reported is not None:
            total = reported
        for s in batch:
            sid = s.get("id")
            if sid is not None and sid in seen:
                continue
            if sid is not None:
                seen.add(sid)
            sessions.append(s)
        if not batch:
            # The server RAN DRY. This is the one completeness signal that does
            # not depend on the backend reporting a `total` — it is established,
            # not assumed.
            complete = True
            break
        frm += len(batch)
        if total is not None and len(sessions) >= total:
            complete = True
            break
    return sessions, total, complete


def _total_phrase(total):
    """Describe the server's `total` without inventing one when it never sent it."""
    return f"server total {total}" if total is not None else "server reported NO total"


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "census"
    dev = os.environ["DEV"].rstrip("/")
    api = os.environ["API"].strip("/")
    token = os.environ["TOK"]

    try:
        sessions, total, complete = census(dev, api, token)
    except Exception as err:
        # Intentionally broad. The ONLY thing worse than a failed census is a
        # failed census that prints like an empty pool: an HTTPError, a socket
        # timeout (TimeoutError, not URLError, on 3.10+), a proxy fault and a
        # malformed body must ALL surface as "unknown", never as zero sessions.
        # That is precisely what the old `2>/dev/null` did.
        print(f"::error::livy session census FAILED ({type(err).__name__}: {err}) — "
              f"the counts are UNKNOWN, not zero", file=sys.stderr)
        return 1

    if mode == "ids":
        print(" ".join(str(s["id"]) for s in sessions
                       if s.get("state") in REAPABLE_STATES and s.get("id") is not None))
        if not complete:
            print(f"::warning::census incomplete ({len(sessions)} sessions read, "
                  f"{_total_phrase(total)}) — the clean-up below covers only what "
                  f"was enumerated", file=sys.stderr)
        return 0

    print("total reported:", total if total is not None else "UNREPORTED by the server",
          "| in list:", len(sessions),
          "| complete:", complete,
          "| by state:", dict(Counter(s.get("state") for s in sessions)))
    if not complete:
        print(f"::warning::census stopped after {MAX_PAGES} pages "
              f"({len(sessions)} sessions read, {_total_phrase(total)}) — treat the "
              f"state counts as a LOWER BOUND, not a total")
    return 0


if __name__ == "__main__":
    sys.exit(main())
