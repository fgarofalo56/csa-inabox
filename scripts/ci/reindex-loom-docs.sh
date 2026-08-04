#!/usr/bin/env bash
# Trigger + WAIT FOR a `loom-docs` reindex on a live console (#2929).
#
# THE ONE IMPLEMENTATION. Every caller needs "refresh the Copilot index and tell
# me honestly whether it worked":
#   * .github/workflows/loom-docs-reindex.yml              (dedicated trigger:
#     dispatch + reusable workflow_call + a nightly safety net)
#   * .github/workflows/copilot-quality-evals.yml          (before it measures)
#   * .github/workflows/console-bluegreen-roll.yml         (new image = new
#     corpus; Commercial only — see that step's note on Gov)
#   * .github/workflows/csa-loom-post-deploy-bootstrap.yml (fresh deploy; the
#     ONLY caller allowed FATAL=false)
# Every one of them used to be — or would have become — its own copy of a
# curl-and-hope block. This repo's recurring defect is the copy that quietly
# drops the verdict, so the decision lives in exactly ONE place
# (scripts/ci/classify-reindex-result.mjs, unit-tested) and the glue that feeds
# it lives in exactly ONE place (this file, exercised end-to-end against a real
# HTTP server by scripts/ci/__tests__/reindex-loom-docs.test.mjs).
#
# ── WHY POST-THEN-POLL ──────────────────────────────────────────────────────
# `POST /api/help-copilot/reindex` used to rebuild the corpus INLINE and two
# very different failures collapsed onto one opaque "HTTP 502" at the caller:
#   1. the route's OWN 502 in ~160ms — no corpus in the image at all
#      (copilot-quality-evals run 30937670794); a hard failure, and
#   2. a Front Door EDGE 502 at 60s — the AFD default origin timeout, which
#      front-door.bicep never overrides — on a perfectly healthy rebuild that
#      simply takes longer than a minute.
# A caller that cannot tell those apart either reds healthy runs or tolerates
# broken ones. The route is now async: it ACCEPTS the work (202) and this script
# polls GET for the terminal state, so no gateway timeout is on the critical
# path at all.
#
# ── WHAT COUNTS AS DONE ─────────────────────────────────────────────────────
# `freshness.state === 'fresh'` — the DURABLE, cross-replica signal (the
# persisted corpus manifest). `job.state` is only the answering REPLICA's view:
# a poll can land on a replica that never ran the job and read `idle` forever,
# so job state can prove a FAILURE but never a success.
#
# A POLL TIMEOUT IS A FAILURE. It is a refusal, not a pass: continuing would
# leave exactly the stale index this script exists to prevent.
#
# ── CONTRACT (all via env) ──────────────────────────────────────────────────
#   CONSOLE_URL      (required) base URL of the target console, trailing / ok
#   INTERNAL_TOKEN   (required) LOOM_INTERNAL_TOKEN; EMPTY => skip + warn + exit 0
#                    (an unset secret is an honest gate, not a broken index)
#   POLL_TIMEOUT_S   default 900  — cap on the wait for a full rebuild
#   POLL_INTERVAL_S  default 15
#   FATAL            default true — set 'false' ONLY where the caller is
#                    documented non-blocking (the post-deploy bootstrap). A
#                    downgrade is always announced as a ::warning::, never
#                    silent, and never changes the verdict that gets printed.
#   GITHUB_OUTPUT    optional     — receives reindex_post= / reindex_poll=
#
# Exit 0 = refreshed, honestly gated, or transient. Exit 1 = the index was NOT
# refreshed and the caller must not pretend otherwise.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLASSIFIER="$HERE/classify-reindex-result.mjs"

CONSOLE_URL="${CONSOLE_URL:-}"
INTERNAL_TOKEN="${INTERNAL_TOKEN:-}"
POLL_TIMEOUT_S="${POLL_TIMEOUT_S:-900}"
POLL_INTERVAL_S="${POLL_INTERVAL_S:-15}"
FATAL="${FATAL:-true}"

POST_BODY_FILE="$(mktemp)"
POLL_BODY_FILE="$(mktemp)"
trap 'rm -f "$POST_BODY_FILE" "$POLL_BODY_FILE"' EXIT

emit() { [ -n "${GITHUB_OUTPUT:-}" ] && printf '%s\n' "$1" >> "$GITHUB_OUTPUT"; return 0; }

# A failing verdict, routed through the FATAL switch. The downgrade is loud and
# the exit code is the ONLY thing it changes -- the classifier's message has
# already been printed by the caller of this function.
fail() {
  if [ "$FATAL" = "false" ]; then
    echo "::warning::loom-docs reindex FAILED, but this call site is documented non-blocking (FATAL=false) so the workflow continues. The Copilot index is STALE until a reindex succeeds."
    exit 0
  fi
  exit 1
}

if [ -z "$CONSOLE_URL" ]; then
  echo "::error::reindex-loom-docs.sh requires CONSOLE_URL (base URL of the target console)." >&2
  exit 1
fi
if [ ! -f "$CLASSIFIER" ]; then
  echo "::error::classifier not found at $CLASSIFIER — this script cannot render a verdict, so it refuses to report success." >&2
  exit 1
fi

BASE="${CONSOLE_URL%/}"
ENDPOINT="$BASE/api/help-copilot/reindex"

if [ -z "$INTERNAL_TOKEN" ]; then
  echo "::warning::LOOM_INTERNAL_TOKEN is not set — cannot refresh the loom-docs index; whatever the console last indexed stays in place. Add the repo secret (it must match the console env). See docs/fiab/copilot-retrieval-remediation.md §9."
  emit 'reindex_post=skipped'
  emit 'reindex_poll=skipped'
  exit 0
fi

# ── 1. POST: ask for the rebuild ────────────────────────────────────────────
CODE=$(curl -sS -o "$POST_BODY_FILE" -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $INTERNAL_TOKEN" \
  -H 'Content-Type: application/json' \
  --max-time 120 \
  "$ENDPOINT" || echo 000)
echo "reindex POST $ENDPOINT -> HTTP $CODE"
head -c 800 "$POST_BODY_FILE" || true
echo ""
emit "reindex_post=$CODE"

# The verdict is the classifier's, never a `case` statement beside it.
if ! HTTP_CODE="$CODE" RESP_BODY="$(cat "$POST_BODY_FILE")" node "$CLASSIFIER"; then
  emit 'reindex_poll=not-started'
  fail
fi

# Only a 202 leaves work in flight. A 200 is an older console that rebuilt
# inline (already complete); 000 and an honest not-configured gate were
# tolerated above. In none of those is there anything to poll for.
if [ "$CODE" != "202" ]; then
  emit 'reindex_poll=not-applicable'
  exit 0
fi

# ── 2. POLL: wait for the DURABLE freshness signal ──────────────────────────
echo "Polling $ENDPOINT for completion (cap ${POLL_TIMEOUT_S}s, every ${POLL_INTERVAL_S}s)…"
STARTED=$(date +%s)
DEADLINE=$(( STARTED + POLL_TIMEOUT_S ))
OUTCOME=timeout
REACHED=false

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  sleep "$POLL_INTERVAL_S"
  GCODE=$(curl -sS -o "$POLL_BODY_FILE" -w '%{http_code}' \
    -H "Authorization: Bearer $INTERNAL_TOKEN" \
    --max-time 60 \
    "$ENDPOINT" || echo 000)
  if [ "$GCODE" = "000" ]; then
    echo "  poll: unreachable (curl 000)"
    continue
  fi
  REACHED=true
  # Parsed with node (already a hard dependency via the classifier) rather than
  # jq, so this runs anywhere the classifier does. A body we cannot parse yields
  # 'unknown', which does NOT break the loop — it keeps polling and, failing
  # that, times out. An unparseable answer can never be read as success.
  STATES=$(node -e '
    const fs = require("node:fs");
    let j = {};
    try { j = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { j = {}; }
    const f = (j.freshness && j.freshness.state) || "unknown";
    const s = (j.job && j.job.state) || "unknown";
    process.stdout.write(f + "|" + s);
  ' "$POLL_BODY_FILE")
  FRESH="${STATES%%|*}"
  JOB="${STATES##*|}"
  echo "  poll: HTTP $GCODE freshness=$FRESH job=$JOB"
  if [ "$FRESH" = "fresh" ]; then OUTCOME=fresh; break; fi
  if [ "$JOB" = "failed" ]; then OUTCOME=failed; break; fi
done

# Never reaching the console at all is the transient case (the eval run talks to
# the console over the CAE-internal network, not Front Door). Reaching it and
# never seeing a terminal state is a real timeout.
if [ "$OUTCOME" = "timeout" ] && [ "$REACHED" = "false" ]; then
  OUTCOME=unreachable
fi
WAITED=$(( $(date +%s) - STARTED ))
emit "reindex_poll=$OUTCOME"

if ! MODE=poll POLL_OUTCOME="$OUTCOME" POLL_WAITED_S="$WAITED" \
  POLL_BODY="$(cat "$POLL_BODY_FILE")" node "$CLASSIFIER"; then
  fail
fi
exit 0
