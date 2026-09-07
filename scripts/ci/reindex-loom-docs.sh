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
#   2. a gateway 5xx from the EDGE on a rebuild that simply ran long.
# A caller that cannot tell those apart either reds healthy runs or tolerates
# broken ones. The route is now async: it ACCEPTS the work (202) and this script
# polls GET for the terminal state, so no gateway timeout is on the critical
# path at all.
#
# ── AND A GATEWAY 5xx ON THE POST IS STILL INDETERMINATE (#3396) ────────────
# copilot-quality-evals went red on `HTTP 504` in 4 of 12 runs on 2026-08-13,
# ~30s in, with a Front Door HTML body. What is MEASURED: the POST handler
# cannot be the slow party (auth check, a stat-only corpus count, fire the job,
# return 202 — apps/fiab-console/app/api/help-copilot/reindex/route.ts), and
# `originResponseTimeoutSeconds` is set NOWHERE in platform/fiab/bicep. What is
# NOT measured, and is therefore not asserted anywhere in this script: why the
# edge gave up at ~30s when the AFD default is 60s, and whether the POST ever
# reached a replica. The fix does not need that answer — it converts the
# unknown into a measurement by polling the durable freshness signal.
#
# ── …AND WHEN THE TRIGGER IS SIMPLY NEVER ACCEPTED, SAY SO IN 2 MIN (#3472) ─
# Polling settled the AMBIGUITY but not the COST or the DIAGNOSIS. Run
# 33472611043 (2026-09-01) got a gateway 504 on the POST, then spent 904s over
# 57 polls reading `freshness=stale job=idle` on every single one before the
# wall clock refused — a 15-minute red whose message was "did not reach a fresh
# state", which reads as "the rebuild was slow". It was not: no rebuild was ever
# visible. Two things follow, and only these two are claimed here:
#   1. ONE RETRY of the POST. Two independent attempts are much better evidence
#      than one, and the retry is FREE when the first POST did reach a replica:
#      the route is idempotent-by-restart and answers 202 `alreadyRunning:true`
#      (lib/azure/reindex-job.ts::startReindexJob), so a retry cannot start a
#      second concurrent rebuild.
#   2. An EARLY, DIFFERENTLY-NAMED refusal (`trigger_refused`) when BOTH POSTs
#      were refused at the edge AND no poll has yet seen a job running. See the
#      long note on that branch in the loop for what that does and does NOT
#      establish — `job.state` is the ANSWERING REPLICA's view and loom-console
#      runs minReplicas 2 / maxReplicas 6 (admin-plane/main.bicep:4221), so this
#      is deliberately conservative and latches OFF the moment any poll reports
#      a running job.
# Both verdicts still fail closed. This shortens and RENAMES a failure; it never
# creates a pass.
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
#   POLL_TIMEOUT_S   default 900  — WALL-CLOCK cap on the wait for a full rebuild
#   POLL_INTERVAL_S  default 15
#   POLL_MAX_ATTEMPTS default 0 (unbounded) — cap on the NUMBER OF POLLS. See
#                    "A WALL CLOCK IS NOT A BUDGET A TEST CAN RELY ON" below.
#   POST_RETRIES     default 1 — extra POST attempts after an INDETERMINATE
#                    gateway 5xx only (#3472). 0 disables the retry.
#   POST_RETRY_DELAY_S default 5 — pause before that retry.
#   REFUSED_IDLE_POLLS default 8 — consecutive polls reading `freshness=stale
#                    job=idle` with an unchanged indexedChunkCount that, WHEN
#                    EVERY POST WAS REFUSED AT THE EDGE and no poll has seen a
#                    running job, end the wait early with `trigger_refused`.
#                    0 disables the early exit (the wall clock then governs, as
#                    it did before #3472).
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
# 0 = unbounded, i.e. the wall clock alone governs (production behaviour, and
# the default so no caller changes meaning by upgrading).
POLL_MAX_ATTEMPTS="${POLL_MAX_ATTEMPTS:-0}"
# #3472. Both knobs default to the behaviour argued for in the header note; both
# can be set to 0 to get exactly the pre-#3472 script back.
POST_RETRIES="${POST_RETRIES:-1}"
POST_RETRY_DELAY_S="${POST_RETRY_DELAY_S:-5}"
REFUSED_IDLE_POLLS="${REFUSED_IDLE_POLLS:-8}"
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
# `|| true` fixes the EXIT STATUS only. It must NOT be `|| echo 000`: curl
# already PRINTS `000` from `-w` on a connect failure, so the fallback would
# concatenate to "000000" and the classifier would be handed a string that is
# not a status code (#3414).
do_post() {
  CODE=$(curl -sS -o "$POST_BODY_FILE" -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $INTERNAL_TOKEN" \
    -H 'Content-Type: application/json' \
    --max-time 120 \
    "$ENDPOINT") || true
  [ -n "$CODE" ] || CODE=000
  echo "reindex POST $ENDPOINT -> HTTP $CODE"
  head -c 800 "$POST_BODY_FILE" || true
  echo ""
}

# The verdict is the classifier's, never a `case` statement beside it.
# Exit 75 is its INDETERMINATE answer (a gateway 5xx with no application body,
# #3394): the edge replied for the console, so whether the POST reached a replica
# is unknown. Do not guess — fall through to the poll and let the durable
# freshness signal settle it. Every OTHER non-zero stays a failure.
do_post
POST_ATTEMPTS=1
HTTP_CODE="$CODE" RESP_BODY="$(cat "$POST_BODY_FILE")" node "$CLASSIFIER"
CRC=$?

# ── ONE RETRY, AND ONLY ON THE INDETERMINATE ANSWER (#3472) ─────────────────
# Scoped to CRC 75 on purpose. A 401, a 502 with an application body, or an
# empty-corpus 502 are ANSWERS from the console — retrying them would only
# delay a verdict the console already gave. A gateway 5xx is not an answer, so a
# second sample is the cheapest way to tell "the edge blipped once" from "POSTs
# are not getting through". Safe to repeat: startReindexJob() returns the
# in-flight handle with `alreadyRunning:true` rather than racing a second
# rebuild, so if attempt 1 DID reach a replica this retry converts the unknown
# into a 202 and the normal poll path resumes.
while [ "$CRC" -eq 75 ] && [ "$POST_ATTEMPTS" -le "$POST_RETRIES" ]; do
  echo "::notice::reindex POST was answered by the gateway (HTTP $CODE) with no application body — re-sampling in ${POST_RETRY_DELAY_S}s (attempt $(( POST_ATTEMPTS + 1 )) of $(( POST_RETRIES + 1 ))). The route is idempotent-by-restart, so this cannot start a second concurrent rebuild."
  sleep "$POST_RETRY_DELAY_S"
  do_post
  POST_ATTEMPTS=$(( POST_ATTEMPTS + 1 ))
  HTTP_CODE="$CODE" RESP_BODY="$(cat "$POST_BODY_FILE")" node "$CLASSIFIER"
  CRC=$?
done

# Emitted ONCE, after the final attempt: GITHUB_OUTPUT is append-only, so
# emitting per attempt would leave two `reindex_post=` lines and the consumer
# would read whichever the runner's parser happened to keep.
emit "reindex_post=$CODE"

POLL_ANYWAY=false
# True only when EVERY POST attempt was refused at the edge. This is the
# precondition for the `trigger_refused` early exit below — one refused POST is
# not enough evidence to stop waiting.
POST_REFUSED=false
if [ "$CRC" -eq 75 ]; then
  POLL_ANYWAY=true
  POST_REFUSED=true
elif [ "$CRC" -ne 0 ]; then
  emit 'reindex_poll=not-started'
  fail
fi

# Only a 202 leaves work in flight. A 200 is an older console that rebuilt
# inline (already complete); 000 and an honest not-configured gate were
# tolerated above. In none of those is there anything to poll for — EXCEPT the
# indeterminate gateway case, which polls precisely because it is unresolved.
if [ "$CODE" != "202" ] && [ "$POLL_ANYWAY" != "true" ]; then
  emit 'reindex_poll=not-applicable'
  exit 0
fi

# ── 2. POLL: wait for the DURABLE freshness signal ──────────────────────────
#
# ── A WALL CLOCK IS NOT A BUDGET A TEST CAN RELY ON (#3942) ─────────────────
# This loop's only budget used to be `POLL_TIMEOUT_S`, checked at the TOP of
# each iteration, so the number of polls that fit inside it is a function of how
# long ONE iteration takes — a `sleep`, a `curl`, and a `node` spawn. That is
# machine load, not console behaviour. MEASURED on this tree, same test, same
# tree, same assertions:
#
#   idle                       "202 -> polls -> fresh -> exit 0"  PASS  (8.8s, 2 polls)
#   24 busy workers            same test                          PASS  (22.9s, 2 polls)
#   96 busy workers            same test                          FAIL  (65.8s, 1 poll)
#
# The failure is real and is the script's, not the test's: with one poll inside
# the cap the loop returned `timeout` for a console that was answering correctly.
# A longer POLL_TIMEOUT_S would move that threshold without removing the
# dependence on load, which is why the fix is a SECOND, DETERMINISTIC budget —
# a cap on the NUMBER OF POLLS. `POLL_MAX_ATTEMPTS` defaults to 0 (unbounded),
# so every production caller keeps exactly the wall-clock behaviour it has; the
# end-to-end suite sets it, and load can then only make the run SLOWER, never
# change its verdict.
#
# BOTH ceilings still fail closed, and the classifier is TOLD WHICH ONE tripped
# so the message cannot claim a wall-clock timeout that did not happen (R7).
echo "Polling $ENDPOINT for completion (cap ${POLL_TIMEOUT_S}s, every ${POLL_INTERVAL_S}s, max attempts ${POLL_MAX_ATTEMPTS:-0} where 0=unbounded)…"
STARTED=$(date +%s)
DEADLINE=$(( STARTED + POLL_TIMEOUT_S ))
OUTCOME=timeout
REACHED=false
ATTEMPTS=0
# #3472 early-exit state. IDLE_STREAK counts CONSECUTIVE polls that saw nothing
# happening; SAW_RUNNING is a LATCH — once any poll reports a job in flight the
# early exit is off for the rest of the run, permanently, because at that point
# "no rebuild was ever visible" is false and only the full wait can settle it.
IDLE_STREAK=0
SAW_RUNNING=false
BASE_CHUNKS=''

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if [ "$POLL_MAX_ATTEMPTS" -gt 0 ] && [ "$ATTEMPTS" -ge "$POLL_MAX_ATTEMPTS" ]; then
    break
  fi
  ATTEMPTS=$(( ATTEMPTS + 1 ))
  sleep "$POLL_INTERVAL_S"
  # `|| true`, never `|| echo 000` — the fallback concatenated onto the `000`
  # curl already printed, so GCODE was "000000" and the unreachable branch just
  # below it, which exists precisely for that case, never fired (#3414).
  GCODE=$(curl -sS -o "$POLL_BODY_FILE" -w '%{http_code}' \
    -H "Authorization: Bearer $INTERNAL_TOKEN" \
    --max-time 60 \
    "$ENDPOINT") || true
  [ -n "$GCODE" ] || GCODE=000
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
    const c = j.freshness && Number.isFinite(j.freshness.indexedChunkCount)
      ? String(j.freshness.indexedChunkCount)
      : "";
    process.stdout.write(f + "|" + s + "|" + c);
  ' "$POLL_BODY_FILE")
  # Three fields now, so `${STATES%%|*}` / `${STATES##*|}` no longer suffice —
  # the old suffix form would have handed JOB the chunk count.
  IFS='|' read -r FRESH JOB CHUNKS <<< "$STATES"
  FRESH="${FRESH:-unknown}"
  JOB="${JOB:-unknown}"
  echo "  poll: HTTP $GCODE freshness=$FRESH job=$JOB indexedChunks=${CHUNKS:-unknown}"
  if [ "$FRESH" = "fresh" ]; then OUTCOME=fresh; break; fi
  if [ "$JOB" = "failed" ]; then OUTCOME=failed; break; fi

  # ── EARLY EXIT: THE TRIGGER WAS NEVER ACCEPTED (#3472) ────────────────────
  # Fires ONLY when all three hold:
  #   a) every POST attempt was refused at the edge (POST_REFUSED),
  #   b) no poll has EVER reported a job in flight (the SAW_RUNNING latch), and
  #   c) REFUSED_IDLE_POLLS consecutive polls read exactly `stale`/`idle` with
  #      an unchanged indexedChunkCount.
  #
  # WHAT EACH LINK IS WORTH — stated because the message the classifier prints
  # is an assertion (deploy-integrity R7), and two of these are weaker than they
  # look:
  #   * (a) is the DESIGNED evidence. Two independent POSTs, both answered by the
  #     edge with no application body, is a fact about the request path.
  #   * (b) is a real safety latch but only ONE-WAY: `job.state` is the ANSWERING
  #     REPLICA's in-memory view (lib/azure/reindex-job.ts, "REPLICA SCOPE"), and
  #     loom-console runs 2-6 replicas, so seeing `running` PROVES a rebuild
  #     exists while never seeing it proves nothing. Missing a live worker for k
  #     consecutive polls has probability ((r-1)/r)^k — at the 6-replica ceiling
  #     that is 48% for k=4 and 23% for k=8. Hence the default of 8 rather than
  #     the 4 originally proposed, and hence the classifier's message says
  #     "no rebuild was OBSERVED", never "no rebuild ran".
  #   * (c) is the WEAKEST link and is corroboration only: the corpus manifest is
  #     written at the END of a rebuild (loom-docs-index.ts writes the shards then
  #     the head), so indexedChunkCount does not move DURING one. Unchanged
  #     chunks therefore means "nothing converged", not "no progress was made".
  # The verdict this shortens is a FAILURE either way, so the cost of firing it
  # wrongly is bounded: a red at ~2min instead of a red at 15min, with a message
  # that names the request path instead of the rebuild's duration.
  if [ "$JOB" = "running" ] || [ "$JOB" = "succeeded" ]; then SAW_RUNNING=true; fi
  # `-n "$CHUNKS"` is not a formality: the classifier's verdict SAYS "with the
  # indexed chunk count unchanged", and a body that never reported a count
  # cannot support that sentence. With no count the streak never starts and the
  # wall clock governs — exactly the pre-#3472 behaviour, which is the safe
  # fallback (R7: do not fire a verdict whose stated evidence you do not have).
  if [ "$POST_REFUSED" = "true" ] && [ "$SAW_RUNNING" = "false" ] && \
     [ "$REFUSED_IDLE_POLLS" -gt 0 ] && [ "$FRESH" = "stale" ] && [ "$JOB" = "idle" ] && \
     [ -n "$CHUNKS" ]; then
    if [ -z "$BASE_CHUNKS" ]; then BASE_CHUNKS="$CHUNKS"; fi
    if [ "$CHUNKS" = "$BASE_CHUNKS" ]; then
      IDLE_STREAK=$(( IDLE_STREAK + 1 ))
    else
      # The count moved: something IS writing. Restart the streak from this
      # observation rather than counting it toward "nothing is happening".
      IDLE_STREAK=1
      BASE_CHUNKS="$CHUNKS"
    fi
    if [ "$IDLE_STREAK" -ge "$REFUSED_IDLE_POLLS" ]; then
      OUTCOME=trigger_refused
      break
    fi
  else
    IDLE_STREAK=0
  fi
done

# Never reaching the console at all is the transient case (the eval run talks to
# the console over the CAE-internal network, not Front Door). Reaching it and
# never seeing a terminal state is a real timeout.
if [ "$OUTCOME" = "timeout" ] && [ "$REACHED" = "false" ]; then
  OUTCOME=unreachable
fi
WAITED=$(( $(date +%s) - STARTED ))
emit "reindex_poll=$OUTCOME"

# POST_CODE / POST_ATTEMPTS are handed over so the `trigger_refused` message can
# NAME the status the edge actually returned and how many attempts got it,
# instead of describing a gateway failure it did not observe (R7).
if ! MODE=poll POLL_OUTCOME="$OUTCOME" POLL_WAITED_S="$WAITED" POLL_ATTEMPTS="$ATTEMPTS" \
  POST_CODE="$CODE" POST_ATTEMPTS="$POST_ATTEMPTS" \
  POLL_BODY="$(cat "$POLL_BODY_FILE")" node "$CLASSIFIER"; then
  fail
fi
exit 0
