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
# ── …AND WHEN THE TRIGGER IS NEVER ACCEPTED, NAME THAT (#3472) ──────────────
# Polling settled the AMBIGUITY but not the DIAGNOSIS. Run 33472611043
# (2026-09-01) got a gateway 504 on the POST, then spent 904s over 57 polls
# reading `freshness=stale job=idle` on every single one before the wall clock
# refused — a red whose message was "did not reach a fresh state", which reads
# as "the rebuild was slow". It was not: no rebuild was ever visible. Two things
# follow, and only these two are claimed here:
#   1. ONE RETRY of the POST, and only on the INDETERMINATE gateway answer. Two
#      independent samples of the request path are much better evidence than
#      one, and when the first POST was an edge blip the second one is answered
#      by the console and the run rejoins the normal path.
#      THE RETRY IS NOT FREE, AND AN EARLIER REVISION OF THIS FILE CLAIMED IT
#      WAS. It asserted "the route is idempotent-by-restart, so a retry cannot
#      start a second concurrent rebuild". That is FALSE and this repo's own
#      sources refute it: the guard is `startReindexJob()`
#      (lib/azure/reindex-job.ts), which is REPLICA-SCOPED IN-MEMORY state — its
#      own "REPLICA SCOPE" banner says so — while front-door.bicep sets
#      `sessionAffinityState:'Disabled'` and admin-plane/main.bicep runs
#      minReplicas 2 / maxReplicas 6. So a retry lands on a different replica
#      with probability (r-1)/r and, if attempt 1 DID reach a replica, can start
#      a SECOND concurrent rebuild — which reindex-job.ts itself describes as
#      racing the shared manifest. What this script does about it: it PROBES
#      `GET` before re-POSTing and skips the retry when a rebuild is already
#      visible (fresh / running / succeeded). That NARROWS the window; it does
#      not close it, and the log says so rather than claiming safety. Set
#      `POST_RETRIES=0` to disable the retry entirely.
#   2. A DIFFERENTLY-NAMED refusal (`trigger_refused`) when EVERY POST was
#      refused at the edge AND no poll ever saw a job running AND the trailing
#      polls read `stale`/`idle` with an unchanged chunk count.
#      IT IS A RENAME AT THE CEILING, NOT AN EARLY EXIT, AND AN EARLIER REVISION
#      OF THIS FILE GOT THAT WRONG TOO. That revision broke the wait as soon as
#      the streak was reached and justified it with "the verdict this shortens
#      is a FAILURE either way … it never creates a pass". MEASURED FALSE, with
#      a real `node:http` server and real curl: POST always edge-504, GET
#      `stale`/`idle`/unmoving for polls 1-8 then `fresh` at poll 9 — the shape
#      this very file documents for a healthy rebuild running on ANOTHER replica
#      — gave exit 0 / 9 polls / "COMPLETE … FRESH index" before that change and
#      exit 1 / 8 polls / "TRIGGER REFUSED" after it. At the production
#      POLL_INTERVAL_S=15 the streak of 8 elapses at ~120s of a 900s budget, so
#      it could red a run that would have passed. The only thing that would have
#      prevented it is the SAW_RUNNING latch, and `job.state` misses a live
#      worker for 8 consecutive polls ~23% of the time at 6 replicas.
#      No durable "a rebuild is in flight" signal exists (the corpus manifest is
#      written only at the END of a run), so NO early exit can be sound. The
#      wait therefore runs to its ceiling exactly as before, and the streak only
#      decides which NAME the resulting failure gets. That keeps 100% of the
#      diagnosis #3472 asked for and 0% of the false-red risk; the cost saving
#      the earlier revision claimed is dropped, deliberately.
# SCOPE THAT SENTENCE, BECAUSE AN EARLIER REVISION DID NOT (#4373 review B1).
# It used to read "Both verdicts fail closed. This RENAMES a failure. It changes
# no exit code." The RENAME half is true and stays true. The RETRY half was
# false in both directions: a retry that gets a 202 turns a would-be timeout
# into a legitimate pass (that is the point of it), and — the defect — a retry
# answered by nothing at all used to make the script exit 0 having polled ZERO
# times, erasing a failure `origin/main` reported. So, precisely:
#   * the `trigger_refused` rename changes no exit code, ever;
#   * the retry MAY change one, in the direction of a real answer only. It can
#     never remove the obligation to poll: an INDETERMINATE attempt is latched
#     (SAW_INDETERMINATE below) and a later attempt that is itself a non-answer
#     cannot discharge it.
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
#                    gateway 5xx only (#3472). Each retry is preceded by a
#                    status GET and skipped if a rebuild is already visible.
#                    0 disables the retry.
#   POST_RETRY_DELAY_S default 5 — pause before that retry.
#   REFUSED_IDLE_POLLS default 8 — how many TRAILING polls must read
#                    `freshness=stale job=idle` with an unchanged
#                    indexedChunkCount before a wait that has ALREADY hit its
#                    ceiling is named `trigger_refused` instead of `timeout`.
#                    It does NOT end the wait early (see the #3472 note above)
#                    and it cannot change an exit code. 0 disables the rename.
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
# #3472. Both knobs default to the behaviour argued for in the header note.
# POST_RETRIES=0 gets exactly the pre-#3472 request path back; REFUSED_IDLE_POLLS=0
# gets the pre-#3472 verdict NAME back (the wait itself is unchanged either way).
# NOTE THE SHIPPED DEFAULT IS 1, AND NO CALLER OVERRIDES IT — copilot-quality-evals.yml
# sets only POLL_TIMEOUT_S / POLL_INTERVAL_S / FATAL. So "you can switch it off"
# is not a safety argument for the default path, and the #4373 review was right
# to say so: the DEFAULT is what must preserve the poll, and the
# SAW_INDETERMINATE latch below is what makes it do that.
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
#
# TRUNCATE FIRST. `curl -o` does NOT empty the file when the transfer fails, so
# on a retry that never connects the file still holds the PREVIOUS attempt's
# body — and this function then prints it under the CURRENT attempt's status and
# hands it to the classifier as `RESP_BODY`. Measured on this harness before the
# fix (#4373 review §S1): `-> HTTP 000` followed verbatim by attempt 1's
# `<html><title>504 Gateway Time-out</title>`. In a script whose entire subject
# is a log sentence that described the wrong thing, that is the same defect.
do_post() {
  : > "$POST_BODY_FILE"
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

# ── ONE GET, PARSED ONCE ────────────────────────────────────────────────────
# Sets GCODE / FRESH / JOB / CHUNKS. Used by BOTH the pre-retry safety probe and
# the poll loop, so the body parse lives in exactly one place — a second copy is
# how one of them ends up reading a field the other renamed.
# Parsed with node (already a hard dependency via the classifier) rather than
# jq, so this runs anywhere the classifier does. A body we cannot parse yields
# 'unknown', which is never read as success by either caller.
get_status() {
  # Truncated for the same reason `do_post` is (#4373 review §S1): `curl -o`
  # leaves the file untouched on a failed transfer, so an unreachable poll would
  # otherwise carry the PREVIOUS poll's body into `$POLL_BODY` and the final
  # verdict's `freshness=…` detail would describe a poll that never answered.
  : > "$POLL_BODY_FILE"
  # `|| true`, never `|| echo 000` — the fallback concatenated onto the `000`
  # curl already printed, so GCODE was "000000" and the unreachable branch just
  # below it, which exists precisely for that case, never fired (#3414).
  GCODE=$(curl -sS -o "$POLL_BODY_FILE" -w '%{http_code}' \
    -H "Authorization: Bearer $INTERNAL_TOKEN" \
    --max-time 60 \
    "$ENDPOINT") || true
  [ -n "$GCODE" ] || GCODE=000
  FRESH=unknown
  JOB=unknown
  CHUNKS=''
  if [ "$GCODE" = "000" ]; then
    return 0
  fi
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
  # Three fields, so `${STATES%%|*}` / `${STATES##*|}` do not suffice — the
  # suffix form would have handed JOB the chunk count.
  IFS='|' read -r FRESH JOB CHUNKS <<< "$STATES"
  FRESH="${FRESH:-unknown}"
  JOB="${JOB:-unknown}"
  return 0
}

# The verdict is the classifier's, never a `case` statement beside it.
# Exit 75 is its INDETERMINATE answer (a gateway 5xx with no application body,
# #3394): the edge replied for the console, so whether the POST reached a replica
# is unknown. Do not guess — fall through to the poll and let the durable
# freshness signal settle it. Every OTHER non-zero stays a failure.
do_post
POST_ATTEMPTS=1
# EVERY attempt's status, in order. The verdict's parenthetical is plural ("All
# 2 POST attempt(s) were answered by the EDGE (HTTP …)") and `$CODE` is only the
# LAST attempt's status, so naming that one code described attempt 1 with
# attempt 2's sample (#4373 review §4). Both are edge refusals whenever the
# rename fires, so the verdict was sound — the parenthetical was not.
POST_CODES="$CODE"
HTTP_CODE="$CODE" RESP_BODY="$(cat "$POST_BODY_FILE")" node "$CLASSIFIER"
CRC=$?
# ── THE INDETERMINATE OBSERVATION IS LATCHED, NOT RE-READ FROM THE LAST ──────
# ── ATTEMPT (#4373 review, BLOCKER 1) ────────────────────────────────────────
# `POLL_ANYWAY` used to be derived from the FINAL attempt's CRC alone. So when
# attempt 1 was the indeterminate gateway 5xx (CRC 75 — which this file's own
# contract says MUST fall through to the poll) and the retry produced a verdict
# the classifier TOLERATES, CRC became 0, `CODE` was not 202, and the script
# exited 0 at `reindex_poll=not-applicable` having polled ZERO times. The retry
# only fires when the request path is already misbehaving, so the likeliest
# tolerated retry verdict is exactly the one that triggers it: a curl `000`.
# MEASURED with a real node:http server and real curl — POST 1 edge-504, POST 2
# socket destroyed, GET stale/idle/49593:
#   origin/main      exit 1, 1 POST, 4 real polls  ("did NOT reach a fresh state")
#   this file BEFORE exit 0, 2 POSTs, 1 GET (the probe), NO polls at all
# i.e. the retry did not rename a failure, it ERASED one and let the evals run
# against a stale index. So the fact "an attempt was indeterminate" is latched
# here and survives whatever the later attempts say.
SAW_INDETERMINATE=false
if [ "$CRC" -eq 75 ]; then SAW_INDETERMINATE=true; fi

# ── ONE RETRY, AND ONLY ON THE INDETERMINATE ANSWER (#3472) ─────────────────
# Scoped to CRC 75 on purpose. A 401, a 502 with an application body, or an
# empty-corpus 502 are ANSWERS from the console — retrying them would only
# delay a verdict the console already gave. A gateway 5xx is not an answer, so a
# second sample is the cheapest way to tell "the edge blipped once" from "POSTs
# are not getting through".
#
# ── THE RETRY IS NOT FREE. IT USED TO SAY IT WAS. ───────────────────────────
# The line printed here used to assert "the route is idempotent-by-restart, so
# this cannot start a second concurrent rebuild". That is refuted by this repo's
# own templates and is exactly the kind of unestablished claim deploy-integrity
# R7 forbids. The guard is `startReindexJob()` (lib/azure/reindex-job.ts) and it
# is REPLICA-SCOPED IN-MEMORY state — that file's own "REPLICA SCOPE" banner
# says so — while front-door.bicep sets `sessionAffinityState:'Disabled'` and
# admin-plane/main.bicep runs minReplicas 2 / maxReplicas 6. If attempt 1 was a
# 504 at the EDGE but did reach replica A and start a job, attempt 2 lands on a
# different replica with probability (r-1)/r (50% at 2, 83% at 6), sees `idle`,
# and starts a SECOND concurrent rebuild — which reindex-job.ts describes as
# racing the shared manifest.
#
# So: PROBE FIRST. One GET before the retry. If any replica answers `fresh`, or
# reports a job `running`/`succeeded`, a rebuild is demonstrably in flight or
# done and there is nothing an extra POST can tell us that the poll will not —
# skip it. That narrows the double-rebuild window to "the probe also missed the
# worker"; it does NOT close it, and the notice below says so instead of
# claiming safety. `POST_RETRIES=0` disables the retry entirely.
#
# A probe sighting also seeds the SAW_RUNNING latch, so evidence gathered here
# is not thrown away before the poll loop starts.
SAW_RUNNING=false
while [ "$CRC" -eq 75 ] && [ "$POST_ATTEMPTS" -le "$POST_RETRIES" ]; do
  get_status
  echo "  pre-retry probe: HTTP $GCODE freshness=$FRESH job=$JOB indexedChunks=${CHUNKS:-unknown}"
  if [ "$JOB" = "running" ] || [ "$JOB" = "succeeded" ]; then SAW_RUNNING=true; fi
  if [ "$FRESH" = "fresh" ] || [ "$SAW_RUNNING" = "true" ]; then
    echo "::notice::NOT retrying the reindex POST: the status probe reports freshness=$FRESH job=$JOB, i.e. a rebuild is already visible. A second POST could land on a different replica (the in-flight guard is replica-scoped in-memory state) and start a second concurrent rebuild, so the poll below settles this instead."
    break
  fi
  echo "::notice::reindex POST was answered by the gateway (HTTP $CODE) with no application body — re-sampling in ${POST_RETRY_DELAY_S}s (attempt $(( POST_ATTEMPTS + 1 )) of $(( POST_RETRIES + 1 ))). CAVEAT, stated because it is not established otherwise: if attempt 1 DID reach a replica, this retry MAY start a second concurrent rebuild — startReindexJob()'s in-flight guard is replica-scoped in-memory state, Front Door session affinity is Disabled and the console runs 2-6 replicas. The probe above saw no rebuild, which narrows that window but does not close it. Set POST_RETRIES=0 to disable this retry."
  sleep "$POST_RETRY_DELAY_S"
  do_post
  POST_ATTEMPTS=$(( POST_ATTEMPTS + 1 ))
  POST_CODES="$POST_CODES,$CODE"
  HTTP_CODE="$CODE" RESP_BODY="$(cat "$POST_BODY_FILE")" node "$CLASSIFIER"
  CRC=$?
  if [ "$CRC" -eq 75 ]; then SAW_INDETERMINATE=true; fi
done

# Emitted ONCE, after the final attempt: GITHUB_OUTPUT is append-only, so
# emitting per attempt would leave two `reindex_post=` lines and the consumer
# would read whichever the runner's parser happened to keep.
emit "reindex_post=$CODE"

POLL_ANYWAY=false
# True only when EVERY POST attempt this run made was refused at the edge. It is
# the precondition for the `trigger_refused` RENAME below.
# HOW MANY ATTEMPTS THAT IS depends on POST_RETRIES: 2 by default, but 1 when a
# caller sets POST_RETRIES=0, and 1 when the pre-retry probe found a rebuild
# already visible and skipped the retry. An earlier revision of this comment
# said "one refused POST is not enough evidence to stop waiting" — the code has
# never enforced that, so the comment was asserting a guard that does not exist
# (R7). What IS true: the count is carried into the verdict as POST_ATTEMPTS and
# the message names it, so a one-attempt run says "1 POST attempt(s)" and a
# reader can weigh it accordingly.
POST_REFUSED=false
if [ "$CRC" -eq 75 ]; then
  POLL_ANYWAY=true
  POST_REFUSED=true
elif [ "$CRC" -eq 0 ] && [ "$SAW_INDETERMINATE" = "true" ] && [ "$CODE" = "000" ]; then
  # ── A NON-ANSWER CANNOT DISCHARGE AN EARLIER UNKNOWN (#4373 review B1) ─────
  # The retry did not reach the console either (curl 000). The classifier
  # TOLERATES that on its own — the eval reaches the console over the
  # CAE-internal network, so an edge blip must not red the gate — but it settles
  # nothing about attempt 1's gateway 5xx, which is still the open question
  # "did a rebuild start?". Tolerating it here would discard the one observation
  # that obliges this script to look. So: poll.
  #
  # SCOPED TO A NON-ANSWER ON PURPOSE, and the two cases left out are left out
  # for a measured reason, not an oversight. A retry that the CONSOLE answered
  # RESOLVES the unknown rather than discarding it:
  #   * 200/2xx ok — a pre-#2929 console rebuilt INLINE and the refresh is done;
  #   * an honest not-configured 5xx — the backing infra is not provisioned, so
  #     no rebuild can be in flight on any replica and `fresh` will never
  #     arrive. Polling that to the ceiling would convert today's honest gate
  #     (exit 0 + warning) into a false red, which is the same class of defect
  #     round 2 of this review blocked. Measured both ways below
  #     (`#4373 an honest not-configured retry answer is NOT polled to a red`).
  # `POST_REFUSED` stays FALSE here: not every attempt was an edge refusal, so
  # the `trigger_refused` rename must not be available to this run.
  POLL_ANYWAY=true
  echo "::notice::the retry POST did not reach the console either (curl $CODE), so it did NOT settle attempt 1's gateway answer. Polling the durable freshness signal anyway — a tolerated non-answer cannot discharge an INDETERMINATE one (#4373)."
elif [ "$CRC" -ne 0 ]; then
  emit 'reindex_poll=not-started'
  fail
fi

# Only a 202 leaves work in flight. A 200 is an older console that rebuilt
# inline (already complete); an honest not-configured gate, and a 000 with no
# indeterminate attempt behind it, were tolerated above. In none of those is
# there anything to poll for — EXCEPT the indeterminate gateway case, which
# polls precisely because it is unresolved.
#
# THAT "EXCEPT" WAS ASSERTING A GUARD THE CODE DID NOT HAVE (#4373 review B1,
# R7). It was written as if the indeterminate case always reached the poll; it
# did not, whenever the RETRY's own verdict was tolerated. `POLL_ANYWAY` is now
# set from the latched observation as well as the final CRC, so the sentence is
# true — and `#4373 a retry that never connects does NOT erase the poll` reds
# if the latch is removed.
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
# #3472 rename state. IDLE_STREAK counts CONSECUTIVE polls that saw nothing
# happening; SAW_RUNNING is a LATCH — once any poll (or the pre-retry probe)
# reports a job in flight the rename is off for the rest of the run,
# permanently, because at that point "no rebuild was ever visible" is false.
# NEITHER ends the wait. See the #3472 note in the header for why no early exit
# can be sound here.
IDLE_STREAK=0
BASE_CHUNKS=''

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if [ "$POLL_MAX_ATTEMPTS" -gt 0 ] && [ "$ATTEMPTS" -ge "$POLL_MAX_ATTEMPTS" ]; then
    break
  fi
  ATTEMPTS=$(( ATTEMPTS + 1 ))
  sleep "$POLL_INTERVAL_S"
  get_status
  if [ "$GCODE" = "000" ]; then
    echo "  poll: unreachable (curl 000)"
    # THE STREAK IS A RUN OF *OBSERVATIONS*, AND AN UNREACHABLE POLL IS NOT ONE
    # (#4373 review §2). This `continue` used to skip the streak bookkeeping
    # entirely, so a poll that never got a body sat INSIDE a "trailing run of
    # polls that read stale/idle" without having read anything. The verdict then
    # asserted a reading for it. Reset: a poll that produced no observation
    # breaks the run, exactly as a poll that observed something else does.
    IDLE_STREAK=0
    continue
  fi
  REACHED=true
  echo "  poll: HTTP $GCODE freshness=$FRESH job=$JOB indexedChunks=${CHUNKS:-unknown}"
  if [ "$FRESH" = "fresh" ]; then OUTCOME=fresh; break; fi
  if [ "$JOB" = "failed" ]; then OUTCOME=failed; break; fi

  # ── SIGNATURE OF A TRIGGER THAT WAS NEVER ACCEPTED (#3472) ────────────────
  # Maintained here, EVALUATED AFTER THE LOOP. It decides the NAME of a failure
  # the ceilings have already produced; it never ends the wait and never changes
  # an exit code. Three conditions, weighed honestly because the message the
  # classifier prints is an assertion (deploy-integrity R7):
  #   a) every POST attempt was refused at the edge (POST_REFUSED) — the
  #      DESIGNED evidence. Independent attempts, each answered by the edge with
  #      no application body, is a fact about the request path.
  #   b) no poll or probe ever reported a job in flight (the SAW_RUNNING latch).
  #      ONE-WAY only: `job.state` is the ANSWERING REPLICA's in-memory view
  #      (lib/azure/reindex-job.ts, "REPLICA SCOPE") and loom-console runs 2-6
  #      replicas, so seeing `running` PROVES a rebuild exists while never
  #      seeing it proves nothing. Missing a live worker for k consecutive polls
  #      has probability ((r-1)/r)^k — 23% for k=8 at the 6-replica ceiling.
  #   c) the TRAILING REFUSED_IDLE_POLLS polls read exactly `stale`/`idle` with
  #      an unchanged indexedChunkCount. The WEAKEST link, corroboration only:
  #      the corpus manifest is written at the END of a rebuild
  #      (loom-docs-index.ts writes the shards then the head), so
  #      indexedChunkCount does not move DURING one. Unchanged chunks therefore
  #      means "nothing converged", not "no progress was made".
  # Because (b) and (c) are that weak, they are NOT allowed to terminate a wait.
  # An earlier revision let them, and a fixture matching exactly the shape (b)
  # is documented to miss — a healthy rebuild on another replica, fresh at poll
  # 9 — turned a run that exits 0 at head into exit 1 at poll 8. Deciding a NAME
  # on weak evidence costs a misleading sentence in a log that is already red;
  # deciding a WAIT on it costs a false failure.
  if [ "$JOB" = "running" ] || [ "$JOB" = "succeeded" ]; then SAW_RUNNING=true; fi
  # `-n "$CHUNKS"` is not a formality: the classifier's verdict SAYS "with the
  # indexed chunk count unchanged", and a body that never reported a count
  # cannot support that sentence. With no count the streak never starts and the
  # verdict keeps its `timeout` name (R7: do not fire a verdict whose stated
  # evidence you do not have).
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
  else
    IDLE_STREAK=0
  fi
done

# ── THE RENAME, APPLIED ONLY TO A FAILURE THAT ALREADY HAPPENED ─────────────
# `timeout` is the only outcome this can touch: `fresh` and `failed` broke out
# of the loop with a verdict of their own, and `unreachable` (below) means no
# poll ever parsed a body, so no streak can exist. Every condition is re-read at
# its FINAL value — SAW_RUNNING covers the whole run, IDLE_STREAK is the
# trailing run of idle polls. IDLE_STREAK IS ALSO WHAT THE MESSAGE MUST CLAIM,
# so it is handed to the classifier below: this comment used to say the message
# claimed the trailing polls while the code passed POLL_ATTEMPTS (every poll),
# which is the #4373 review's second finding — the comment described a plumbing
# that did not exist. Exit code: unchanged, in every branch.
if [ "$OUTCOME" = "timeout" ] && [ "$POST_REFUSED" = "true" ] && \
   [ "$SAW_RUNNING" = "false" ] && [ "$REFUSED_IDLE_POLLS" -gt 0 ] && \
   [ "$IDLE_STREAK" -ge "$REFUSED_IDLE_POLLS" ]; then
  OUTCOME=trigger_refused
fi

# Never reaching the console at all is the transient case (the eval run talks to
# the console over the CAE-internal network, not Front Door). Reaching it and
# never seeing a terminal state is a real timeout.
if [ "$OUTCOME" = "timeout" ] && [ "$REACHED" = "false" ]; then
  OUTCOME=unreachable
fi
WAITED=$(( $(date +%s) - STARTED ))
emit "reindex_poll=$OUTCOME"

# POST_CODE / POST_CODES / POST_ATTEMPTS are handed over so the
# `trigger_refused` message can NAME the statuses the edge actually returned and
# how many attempts got them, instead of describing a gateway failure it did not
# observe (R7). POLL_IDLE_STREAK is handed over for the same reason: the message
# claims a `stale`/`idle`/unchanged-count reading, and the only polls that
# established one are the TRAILING streak — POLL_ATTEMPTS is every poll the loop
# made, including unreachable ones and any that read something else before the
# streak began. Passing only POLL_ATTEMPTS made the message claim a reading for
# polls that never produced it (#4373 review, measured at 10 claimed / 8 seen).
if ! MODE=poll POLL_OUTCOME="$OUTCOME" POLL_WAITED_S="$WAITED" POLL_ATTEMPTS="$ATTEMPTS" \
  POLL_IDLE_STREAK="$IDLE_STREAK" \
  POST_CODE="$CODE" POST_CODES="$POST_CODES" POST_ATTEMPTS="$POST_ATTEMPTS" \
  POLL_BODY="$(cat "$POLL_BODY_FILE")" node "$CLASSIFIER"; then
  fail
fi
exit 0
