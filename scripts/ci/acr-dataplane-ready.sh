#!/usr/bin/env bash
# =============================================================================
# acr-dataplane-ready.sh — wait until the ACR DATA PLANE actually answers this
#                          runner, on the same HTTP path the tools will use.
# =============================================================================
#
# WHY (loom-roll-and-validate run 31454217160, 2026-08-11 — a P0 roll failure).
# The SC1 cosign gate opened the ACR via the firewall lease and then polled
# `az acr login` to decide the data plane was reachable:
#
#     03:05:48.748  [acr-lease] opening ACR (publicNetworkAccess=Enabled, defaultAction=Allow) ...
#     03:05:48.748  ACR data plane reachable after 1 attempt(s).      <-- ZERO seconds later
#     03:05:50.762  Verifying cosign signature on …@sha256:3dc79f53 ...
#     03:05:51.221  Error: POST https://…/oauth2/token: DENIED: client with IP
#                   '20.3.215.35' is not allowed access.
#
# `az acr login` returned 0 two seconds after the ARM write, while the registry
# was still denying by IP. ACR firewall changes take 30–90s to reach the data
# plane — this repo's own comment block in that very step says so, and the step
# was already hardened against the RE-LOCK direction of exactly this lag. The
# OPEN direction had the mirror-image bug, and `az acr login` is the wrong
# oracle in BOTH directions: it authenticates through an ARM-mediated token
# exchange that does not exercise the anonymous registry endpoint cosign hits.
#
# The consequence was worse than a retry: the gate then declared the image
# "has NO valid cosign signature from a trusted build workflow" — a fact it had
# not established. It could not READ the signature. That is deploy-integrity.md
# R7 ("an error must not state as fact something it did not establish") and the
# same UNKNOWN-as-NEGATIVE class as #2819/#2982.
#
# THE ORACLE. Poll `GET https://<acr><suffix>/v2/` with plain curl — same host,
# same TCP path, same source IP the signing/pulling tools use. The registry
# discriminates cleanly, measured on both sides on 2026-08-11:
#
#   firewall CLOSED to this IP -> HTTP 403, body: DENIED … is not allowed access
#   firewall OPEN              -> HTTP 401, body: UNAUTHORIZED … authentication required
#
# 401 is the READY signal. It means the request reached the registry's auth
# layer, which is precisely as far as an unauthenticated probe can get and
# exactly the point cosign's token request fails when the firewall is shut.
#
# FAIL CLOSED, AND TELL THE TRUTH. On budget exhaustion this exits non-zero and
# prints the LAST OBSERVED status and body. It never reports ready on a state it
# did not observe, and it never converts "I could not reach it" into "it is not
# there".
#
# USAGE
#   bash scripts/ci/acr-dataplane-ready.sh --acr <acrName> [--timeout-seconds 180]
#
# Exit codes:
#   0  data plane answered (401/200) — ready
#   1  still firewall-denied when the budget ran out
#   2  never got an HTTP response at all (DNS/connect) within the budget
#   3  usage / could not determine the cloud's registry suffix
# -----------------------------------------------------------------------------
set -uo pipefail

ACR=""
BUDGET=180
INTERVAL=10

while [ $# -gt 0 ]; do
  case "$1" in
    --acr) ACR="${2:-}"; shift 2 ;;
    --timeout-seconds) BUDGET="${2:-180}"; shift 2 ;;
    --interval-seconds) INTERVAL="${2:-10}"; shift 2 ;;
    -h|--help) sed -n '1,60p' "$0"; exit 0 ;;
    *) echo "acr-dataplane-ready: unknown argument '$1'" >&2; exit 3 ;;
  esac
done

if [ -z "$ACR" ]; then
  echo "::error::acr-dataplane-ready: --acr <registryName> is required." >&2
  exit 3
fi

# Suffix from the ACTIVE CLOUD, never a literal — Gov registries are .azurecr.us
# and a Commercial literal here reproduces #3209 (a Gov mirror whose read-back
# was refused before it ever reached the network).
ACR_SUFFIX="$(az cloud show --query 'suffixes.acrLoginServerEndpoint' -o tsv 2>/dev/null | tr -d '[:space:]')"
if [ -z "$ACR_SUFFIX" ]; then
  echo "::error::acr-dataplane-ready: could not read suffixes.acrLoginServerEndpoint from 'az cloud show'. Refusing to guess a registry suffix." >&2
  exit 3
fi

HOST="${ACR}${ACR_SUFFIX}"
URL="https://${HOST}/v2/"
DEADLINE=$(( $(date +%s) + BUDGET ))
ATTEMPT=0
LAST_CODE=""
LAST_BODY=""

echo "[acr-dataplane-ready] probing ${URL} (budget ${BUDGET}s, every ${INTERVAL}s)"

while :; do
  ATTEMPT=$(( ATTEMPT + 1 ))
  BODY_FILE="$(mktemp)"
  # NOT `$(curl … || echo 000)`: curl already prints `000` on a connect failure
  # AND exits non-zero, so the fallback CONCATENATES and yields `000000` — which
  # then misses the `000` case below and reports a DNS failure as a firewall
  # refusal. That is the very UNKNOWN-as-NEGATIVE bug this script exists to kill,
  # reproduced inside the fix; caught by the negative test in
  # scripts/ci/test-acr-dataplane-ready.sh.
  CODE="$(curl -s -o "$BODY_FILE" -w '%{http_code}' --max-time 20 "$URL" 2>/dev/null)"
  [ -n "$CODE" ] || CODE="000"
  BODY="$(head -c 400 "$BODY_FILE" 2>/dev/null | tr -d '\r\n')"
  rm -f "$BODY_FILE"
  LAST_CODE="$CODE"
  LAST_BODY="$BODY"

  case "$CODE" in
    401|200)
      # Reached the registry's auth layer => the firewall is letting us through.
      echo "[acr-dataplane-ready] READY after ${ATTEMPT} attempt(s) — HTTP ${CODE} from ${HOST} (the registry is evaluating auth, not blocking by IP)."
      exit 0
      ;;
    403)
      echo "[acr-dataplane-ready] attempt ${ATTEMPT}: HTTP 403 — firewall has not propagated yet: ${BODY:0:160}"
      ;;
    000)
      echo "[acr-dataplane-ready] attempt ${ATTEMPT}: no HTTP response (connect/DNS)."
      ;;
    *)
      echo "[acr-dataplane-ready] attempt ${ATTEMPT}: HTTP ${CODE}: ${BODY:0:160}"
      ;;
  esac

  NOW=$(date +%s)
  if [ "$NOW" -ge "$DEADLINE" ]; then break; fi
  SLEEP=$INTERVAL
  REMAIN=$(( DEADLINE - NOW ))
  [ "$REMAIN" -lt "$SLEEP" ] && SLEEP=$REMAIN
  sleep "$SLEEP"
done

if [ "$LAST_CODE" = "000" ]; then
  echo "::error::acr-dataplane-ready: ${HOST} never returned an HTTP response within ${BUDGET}s (${ATTEMPT} attempts) — DNS or TCP, not a firewall verdict. This is an UNKNOWN: do not report anything as missing or unsigned on the strength of it." >&2
  exit 2
fi

# Say what the CONTROL plane actually reports rather than assuming it says open.
# The first draft of this message asserted "the firewall lease reports the
# registry as open at the control plane" — which this script had never read.
CP="$(az acr show -n "$ACR" --query '{pna:publicNetworkAccess,da:networkRuleSet.defaultAction}' -o tsv 2>/dev/null | tr '\t' '/' | tr -d '[:space:]')"
if [ -n "$CP" ]; then
  CP_NOTE="The control plane currently reports ${CP} (publicNetworkAccess/defaultAction)."
else
  CP_NOTE="The control-plane state could not be read, so this message does not claim one."
fi

echo "::error::acr-dataplane-ready: ${HOST} was still refusing this runner after ${BUDGET}s (${ATTEMPT} attempts). Last response: HTTP ${LAST_CODE} ${LAST_BODY:0:200}. ${CP_NOTE} If it reports Enabled/Allow this is propagation taking longer than the budget or an Azure Policy reverting the toggle. Either way this is an UNKNOWN, not a verdict about the registry's contents." >&2
exit 1
