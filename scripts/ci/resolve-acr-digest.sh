#!/usr/bin/env bash
# Resolve the manifest digest of <repo:tag> in an Azure Container Registry, with
# BOUNDED retry, and keep the three possible answers APART.
# ---------------------------------------------------------------------------
# WHY THIS EXISTS — the #2980 / #2982 roll race.
#
# loom-roll-and-validate resolved the digest like this:
#
#     DIGEST=$(az acr repository show ... --query digest -o tsv 2>/dev/null || echo "")
#     [[ -z "$DIGEST" ]] && echo "::error::… the tag does not exist" && exit 1
#
# Two defects in one line:
#
#   1. `2>/dev/null` threw away the registry's answer, so EVERY failure mode —
#      404, network denial, throttling, an expired token — collapsed into the
#      same empty string.
#   2. The empty string was then reported as "the tag does not exist", which is
#      a statement of FACT the command never established. On 2026-08-05 that
#      false statement was printed for three commits whose images were provably
#      in the registry: the preceding unskippable image-exists gate had read
#      `loom-console:248dbc83… @ sha256:a38a93e8…` five seconds earlier.
#
# The real cause was the ACR firewall: the image-exists gate holds the shared
# firewall lease and RE-LOCKS the registry on exit (assert-acr-image-tags.sh has
# `trap release_lease EXIT`). ACR firewall changes take 30–90s to reach the data
# plane, so for a few seconds after the re-lock `az acr login` still succeeds
# against a stale-open data plane — the roll concluded "reachable, no lease
# needed", and the digest read that followed was DENIED. Whether the roll passed
# or failed came down to how long the intervening vitest gate happened to take.
# That is an "UNKNOWN reported as a NEGATIVE" bug, the same class as #2819.
#
# So this resolver:
#   * NEVER discards stderr — the registry's own words go to the log;
#   * classifies with the SAME proven regex as assert-acr-image-tags.sh rather
#     than inventing a second dialect of "is this a 404?";
#   * RETRIES with backoff, which also covers the other propagation window (a
#     manifest pushed seconds ago may 404 briefly);
#   * FAILS CLOSED — exhausting the budget is a refusal, never a shrug;
#   * costs ZERO extra latency when the first call resolves (no pre-sleep, no
#     warm-up call): one `az` invocation, no sleeps. Proven in the self-test.
#
# Exit codes — the caller MUST keep these apart:
#   0  digest resolved; the digest (sha256:…) is on stdout
#   3  ABSENT   — the registry answered "not found" on every attempt
#   4  UNKNOWN  — the registry could not be READ within the budget
#   2  usage error
#
# Tunables (also the test seams):
#   LOOM_AZ_BIN                   az binary (default: az)
#   LOOM_DIGEST_SLEEP_BIN         sleep binary (default: sleep)
#   LOOM_DIGEST_ATTEMPTS          attempts before UNKNOWN gives up (default 6)
#   LOOM_DIGEST_ABSENT_ATTEMPTS   attempts before ABSENT is believed (default 3)
#   LOOM_DIGEST_BACKOFF_SECONDS   backoff unit; sleep is unit*attempt (default 10)
#
# Usage:
#   scripts/ci/resolve-acr-digest.sh --acr <acrName> --image <repo:tag>
set -uo pipefail

AZ="${LOOM_AZ_BIN:-az}"
SLEEP_BIN="${LOOM_DIGEST_SLEEP_BIN:-sleep}"
ATTEMPTS="${LOOM_DIGEST_ATTEMPTS:-6}"
ABSENT_ATTEMPTS="${LOOM_DIGEST_ABSENT_ATTEMPTS:-3}"
BACKOFF="${LOOM_DIGEST_BACKOFF_SECONDS:-10}"

# The identical classifier assert-acr-image-tags.sh uses (#2640). Adopting the
# existing, tested guard beats writing a second one that drifts from it.
ABSENT_RE='not found|does not exist|ManifestUnknown|NAME_UNKNOWN|MANIFEST_UNKNOWN|TagNotFound|404'

ACR=""
IMAGE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --acr) ACR="${2:-}"; shift 2 ;;
    --image) IMAGE="${2:-}"; shift 2 ;;
    --attempts) ATTEMPTS="${2:-}"; shift 2 ;;
    --absent-attempts) ABSENT_ATTEMPTS="${2:-}"; shift 2 ;;
    -h|--help) sed -n '1,58p' "$0"; exit 0 ;;
    *) echo "resolve-acr-digest.sh: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

if [ -z "$ACR" ] || [ -z "$IMAGE" ]; then
  echo "::error::resolve-acr-digest.sh: --acr <name> and --image <repo:tag> are required." >&2
  exit 2
fi

attempt=0
saw_unreadable=0
last_detail=""

while :; do
  attempt=$((attempt + 1))

  # NOTE: 2>&1, never 2>/dev/null. The registry's answer is the evidence.
  if OUT="$("$AZ" acr repository show --name "$ACR" --image "$IMAGE" -o json 2>&1)"; then
    DIGEST="$(printf '%s' "$OUT" | tr -d '\n' | sed -n 's/.*"digest": *"\([^"]*\)".*/\1/p')"
    if [ -n "$DIGEST" ]; then
      printf '%s\n' "$DIGEST"
      exit 0
    fi
    # Exit 0 with no digest field is not "absent" — it is an answer we do not
    # understand. Treat it as UNKNOWN and retry rather than guessing.
    class="unreadable"
    last_detail="az exited 0 but returned no \"digest\" field: $(printf '%s' "$OUT" | tr -d '\n' | cut -c1-200)"
  elif printf '%s' "$OUT" | grep -qiE "$ABSENT_RE"; then
    class="absent"
    last_detail="$(printf '%s' "$OUT" | tr -d '\r' | head -n 2 | tr '\n' ' ' | cut -c1-300)"
  else
    class="unreadable"
    last_detail="$(printf '%s' "$OUT" | tr -d '\r' | head -n 2 | tr '\n' ' ' | cut -c1-300)"
  fi

  [ "$class" = "unreadable" ] && saw_unreadable=1

  # Which budget applies depends on what the registry just said. A run that has
  # EVER been unable to read the registry can never conclude "absent" — absence
  # has not been observed, only failure to observe.
  if [ "$class" = "absent" ] && [ "$saw_unreadable" -eq 0 ]; then
    cap="$ABSENT_ATTEMPTS"
  else
    cap="$ATTEMPTS"
  fi

  echo "resolve-acr-digest: attempt ${attempt}/${cap} — ${class}: ${last_detail}" >&2

  if [ "$attempt" -ge "$cap" ]; then
    break
  fi
  "$SLEEP_BIN" "$((BACKOFF * attempt))"
done

if [ "$saw_unreadable" -eq 0 ]; then
  echo "::error::resolve-acr-digest: ${ACR}/${IMAGE} — the registry answered NOT FOUND on all ${attempt} attempt(s). The tag genuinely does not exist. Last answer: ${last_detail}" >&2
  exit 3
fi

echo "::error::resolve-acr-digest: could not READ ${ACR} to resolve ${IMAGE} after ${attempt} attempt(s). This is NOT proof the tag is missing — the registry never answered the question. Most likely the ACR firewall is closed (publicNetworkAccess=Disabled / defaultAction=Deny) for this runner, or a firewall change has not reached the data plane yet (30–90s). Last error: ${last_detail}" >&2
exit 4
