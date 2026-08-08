#!/usr/bin/env bash
# CSA Loom — IMAGE PREFLIGHT (round-3, PR #2640).
# ---------------------------------------------------------------------------
# Assert that every image tag a template is about to reference ACTUALLY EXISTS
# in the target Azure Container Registry, and FAIL LOUDLY when it does not.
#
# WHY THIS EXISTS. `platform/fiab/bicep/modules/admin-plane/main.bicep` now
# deploys `loom-duckdb` BY
# DEFAULT, pulling `<acr>/loom-duckdb:<appImageTags.duckdb>` and
# A subscription-scoped re-deploy over a LIVE estate
# ADOPTS every running app in that estate. If one of those tags is missing, the
# new Container App can never pull an image, the nested deployment fails, and it
# takes the surrounding deployment — the one that is also re-PUTting the live
# `loom-console` / `loom-unity` / … apps — down with it.
#
# The Gov data-plane image producer (.github/workflows/gov-provision-dataplane-images.yml)
# HAS NEVER BEEN EXECUTED, so on the live GCC-High estate the assumption "the
# image is there because a build lane exists" is provably false. This script is
# the check that turns that assumption into evidence.
#
# THREE OUTCOMES, ALL EXPLICIT — AND EACH HAS ITS OWN EXIT CODE (#3090).
#
#   tag present                        -> 0
#   registry ANSWERED, tag absent      -> 3  ("MISSING") + the producer workflow
#   registry never answered            -> 4  ("UNPROVEN") — NOT a pass, and NOT
#                                            a claim that the tag is missing
#   registry could not be read at all  -> 4
#   verified present but re-lock unproven -> 5
#   usage error                        -> 2
#
# The codes exist so a CALLER can branch on the outcome without grepping this
# script's prose. loom-roll-and-validate.yml used to do exactly that —
# `grep -q 'could not READ registry'` — which meant a wording change silently
# converted "unproven" into "refuse to roll". Distinct codes, checked by the
# self-test, are the contract.
#
# `--skip-if-registry-absent` downgrades the *registry does not exist at all*
# case (a genuine from-scratch deploy, nothing live to adopt) to a notice +
# exit 0. A registry that exists but cannot be READ still fails with 4.
#
# ONE CHECKER, NOT TWO. The per-ref lookup is delegated to
# scripts/ci/resolve-acr-digest.sh — the shared three-state checker also used by
# the roll lane — which classifies with the CANONICAL failure taxonomy
# (apps/fiab-console/lib/deploy/failure-taxonomy.json). This script is the
# multi-ref wrapper and the lease holder; it does not re-implement the lookup.
#
# NETWORK NOTE. Tag enumeration is an ACR **data-plane** call (Microsoft Learn:
# repository/tag/manifest listing is data-plane; the ARM management API covers
# registry create/update only, so there is NO control-plane alternative that the
# firewall does not gate). Every Loom ACR is publicNetworkAccess=Disabled at
# rest and every caller runs on a hosted runner, so `--lease` is REQUIRED, not
# optional: it takes the shared ACR firewall lease
# (scripts/csa-loom/acr-firewall-lease.sh, #2603) for the duration of the probe
# and releases it on exit — the same mechanism the build lanes use, so it cannot
# slam the door on a concurrent push. Without it every lookup fails and any
# classifier that guesses from that produces false verdicts.
#
# USAGE
#   scripts/ci/assert-acr-image-tags.sh --acr <acrName> [--lease] \
#     [--skip-if-registry-absent] [--rg <adminRg>] <repo:tag> [<repo:tag> ...]
#
# EXAMPLES
#   scripts/ci/assert-acr-image-tags.sh --acr acrloomabc --lease \
#     loom-duckdb:v0.1
set -uo pipefail

ACR=""
RG=""
USE_LEASE=0
SKIP_IF_REGISTRY_ABSENT=0
REFS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --acr) ACR="${2:-}"; shift 2 ;;
    --rg) RG="${2:-}"; shift 2 ;;
    --lease) USE_LEASE=1; shift ;;
    --skip-if-registry-absent) SKIP_IF_REGISTRY_ABSENT=1; shift ;;
    -h|--help) sed -n '1,45p' "$0"; exit 0 ;;
    *) REFS+=("$1"); shift ;;
  esac
done

if [ -z "$ACR" ] || [ "${#REFS[@]}" -eq 0 ]; then
  echo "::error::assert-acr-image-tags.sh: --acr <name> and at least one <repo:tag> are required." >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# LOOM_ACR_LEASE_SCRIPT is a TEST SEAM (scripts/ci/test-assert-acr-image-tags.sh).
# The lease-acquire-failure path has to be mutation-proved — it is the OP-15
# degraded mode, and it is the one that used to print "probing anyway" and then
# manufacture MISSING verdicts out of guaranteed-failing lookups.
LEASE_SCRIPT="${LOOM_ACR_LEASE_SCRIPT:-$REPO_ROOT/scripts/csa-loom/acr-firewall-lease.sh}"

release_lease() {
  # Idempotent: the success path calls this EXPLICITLY (so the verdict can take
  # the re-lock's outcome into account before exiting) and the EXIT trap calls
  # it again on every other path. A trap alone cannot work here — it runs AFTER
  # `exit`, so a failed re-lock discovered there could no longer change the exit
  # code, which is exactly the "green job over an open registry" shape C24 fixed.
  [ "$LEASE_RELEASED" = "1" ] && return 0
  LEASE_RELEASED=1
  if [ "$USE_LEASE" = "1" ] && [ -f "$LEASE_SCRIPT" ]; then
    # C24 (#3088): NOT `|| true`. A re-lock that did not happen must never be
    # reported as one — that is how a green job sat on top of a publicly
    # reachable Commercial ACR on 2026-08-07.
    if ! bash "$LEASE_SCRIPT" release --acr "$ACR"; then
      echo "::error::image-preflight: the ACR firewall lease on '$ACR' could NOT be verified re-locked after the probe. The registry may be PUBLICLY REACHABLE — see the acr-lease output above for the hand remediation." >&2
      RELEASE_FAILED=1
    fi
  fi
  return 0
}
RELEASE_FAILED=0
LEASE_RELEASED=0
ERRFILE="$(mktemp)"
cleanup() {
  release_lease
  rm -f "$ERRFILE"
}
trap cleanup EXIT

# ── Does the registry even exist? (control plane — works through the firewall) ─
# R7: the read's failure is CAPTURED and CLASSIFIED, never discarded. This was
# `2>/dev/null` with the error text reported as "not found (or no permission to
# read it)" — a message that hedges between two facts instead of establishing
# one, which is the same shape as the defect this file exists to fix.
set +e
SHOW_OUT=$(az acr show -n "$ACR" ${RG:+-g "$RG"} -o none 2>&1)
SHOW_RC=$?
set -e
if [ "$SHOW_RC" -ne 0 ]; then
  REGISTRY_ABSENT=0
  if [ -f "$REPO_ROOT/scripts/ci/deploy-classify.mjs" ] && command -v node >/dev/null 2>&1; then
    if node "$REPO_ROOT/scripts/ci/deploy-classify.mjs" --text "$SHOW_OUT" \
         --assert-signal config.resource-not-found >/dev/null 2>&1; then
      REGISTRY_ABSENT=1
    fi
  fi
  if [ "$REGISTRY_ABSENT" = "1" ] && [ "$SKIP_IF_REGISTRY_ABSENT" = "1" ]; then
    echo "::notice::image-preflight: ARM answered ResourceNotFound for ACR '$ACR' — this is a from-scratch deploy with no live estate to adopt. Skipping (the two-phase image path builds it next)."
    exit 0
  fi
  if [ "$REGISTRY_ABSENT" = "1" ]; then
    echo "::error::image-preflight: ARM answered ResourceNotFound for ACR '$ACR'. Cannot prove ${REFS[*]} exist; refusing to continue. Raw: $(printf '%s' "$SHOW_OUT" | tr -d '\r' | tr '\n' ' ' | cut -c1-300)" >&2
    exit 3
  fi
  echo "::error::image-preflight: could NOT READ ACR '$ACR' on the control plane, so it is not established whether the registry exists — and nothing whatsoever is established about ${REFS[*]}. This is NOT a from-scratch deploy signal. Raw: $(printf '%s' "$SHOW_OUT" | tr -d '\r' | tr '\n' ' ' | cut -c1-300)" >&2
  exit 4
fi

if [ "$USE_LEASE" = "1" ] && [ -f "$LEASE_SCRIPT" ]; then
  # THE LEASE IS LOAD-BEARING, NOT AN OPTIMISATION (#3090). Every Loom ACR sits
  # at publicNetworkAccess=Disabled + defaultAction=Deny AT REST (#2603), and
  # every lane that calls this runs on a GitHub-HOSTED runner, outside the VNet.
  # So without the lease the data plane is unreachable by construction and every
  # lookup below is guaranteed to fail.
  #
  # This used to be `|| echo "::warning::… probing anyway."` — a warning, then a
  # batch of lookups that could only produce garbage, which the old classifier
  # then rendered as MISSING. "Probing anyway" is not resilience when the probe
  # cannot possibly succeed; it is a machine for manufacturing false verdicts.
  # It is now fatal, and it names the exact permission (OP-15).
  if ! LOOM_ACR_LEASE_TTL_MINUTES="${LOOM_ACR_LEASE_TTL_MINUTES:-15}" \
        bash "$LEASE_SCRIPT" acquire --acr "$ACR"; then
    echo "::error::image-preflight: could NOT acquire the ACR firewall lease on '$ACR'. This runner is outside the VNet and the registry is publicNetworkAccess=Disabled at rest, so the existence of ${REFS[*]} is UNPROVEN — NOT disproven. Refusing to probe anyway: every lookup would fail and the old code turned exactly that into a false 'MISSING' verdict (#3090). If the lease could not be WRITTEN, grant the deploy identity 'Tag Contributor' (Microsoft.Resources/tags/write) on the registry; if it was HELD by another run, wait for it and re-run. See the acr-lease output above." >&2
    exit 4
  fi
  # The ACR data plane lags the control plane by 30-90s after a firewall change
  # (the taxonomy records this verbatim), so poll rather than assume. The result
  # is CAPTURED and CLASSIFIED — this loop used to be
  # `az acr login … >/dev/null 2>&1 && break` with no failure path at all, so
  # six straight denials fell through silently into the lookup batch.
  LOGIN_OUT=""
  LOGIN_OK=0
  for _ in 1 2 3 4 5 6 7 8 9; do
    set +e
    LOGIN_OUT=$(az acr login -n "$ACR" 2>&1)
    LOGIN_RC=$?
    set -e
    if [ "$LOGIN_RC" -eq 0 ]; then LOGIN_OK=1; break; fi
    sleep 10
  done
  if [ "$LOGIN_OK" != "1" ]; then
    WHY=""
    if [ -f "$REPO_ROOT/scripts/ci/deploy-classify.mjs" ] && command -v node >/dev/null 2>&1; then
      WHY=$(node "$REPO_ROOT/scripts/ci/deploy-classify.mjs" --text "$LOGIN_OUT" --query 2>&1)
    fi
    echo "::error::image-preflight: held the firewall lease on '$ACR' and opened it, but the ACR DATA PLANE never became reachable (9 attempts over ~90s). The existence of ${REFS[*]} is UNPROVEN — not disproven. Last error: $(printf '%s' "$LOGIN_OUT" | tr -d '\r' | tr '\n' ' ' | cut -c1-300) ${WHY}" >&2
    exit 4
  fi
fi

MISSING=()
UNPROVEN=()
PRESENT=()

# ── THE #3090 DEFECT, AND WHAT REPLACED IT ─────────────────────────────────
#
# This loop used to be:
#
#     if OUT=$(az acr repository show --name "$ACR" --image "$REF" -o json 2>&1); then
#       PRESENT+=("$REF"); continue
#     fi
#     if printf '%s' "$OUT" | grep -qiE 'not found|…|404'; then
#       MISSING+=("$REF")
#     elif az acr repository list --name "$ACR" -o none 2>/dev/null; then
#       # Registry IS readable, so a non-404 failure on this one ref is still a miss.
#       MISSING+=("$REF")
#     else
#       UNREADABLE+=("$REF")
#     fi
#
# THREE separate R7 violations in nine lines:
#
#   1. THE `elif`. "Some other call to the registry succeeded" is not evidence
#      about THIS ref. That comment — "still a miss" — is the false inference,
#      stated in the source, that produced every bad verdict in #3090. MEASURED
#      on deploy-fiab-commercial run 31213089184 (2026-08-07): 15 refs resolved
#      with digests and 4 were reported MISSING, one of them
#      `loom-console:03bab987…` — the image the LIVE console was running at that
#      moment, on two Healthy revisions. A different random subset failed each
#      run; tags read ✓ in one run were "MISSING" 29 minutes later.
#   2. THE LOOSE REGEX. A bare `404` alternation matches a correlation id. See
#      the long note in resolve-acr-digest.sh.
#   3. THE DISCARDED EVIDENCE. `$OUT` was captured and then never printed for a
#      failing ref, and `2>/dev/null` threw away the `list` probe's error. So
#      the step asserted MISSING and emitted ZERO forensics — the log from run
#      31213089184 contains not one line explaining why any of the four failed.
#
# It is now a thin wrapper over the ONE shared three-state checker,
# scripts/ci/resolve-acr-digest.sh, which was already correct (exit 0/3/4,
# bounded retry, self-tested against the mutation that matters) and is now also
# the roll lane's checker. One implementation, one taxonomy, no dialects.
#
#   exit 0 -> EXISTS      exit 3 -> ABSENT (registry ANSWERED)
#   exit 4 -> UNPROVEN    (the registry never answered the question)
#
# Per-ref budget is deliberately smaller than the resolver's default: the lease
# is already held and the firewall already open, so this is covering a
# propagation flake, not a closed door. 3 attempts x 5s backoff = <=15s worst
# case per ref.
export LOOM_DIGEST_ATTEMPTS="${LOOM_PREFLIGHT_ATTEMPTS:-3}"
export LOOM_DIGEST_ABSENT_ATTEMPTS="${LOOM_PREFLIGHT_ABSENT_ATTEMPTS:-2}"
export LOOM_DIGEST_BACKOFF_SECONDS="${LOOM_PREFLIGHT_BACKOFF_SECONDS:-5}"

RESOLVER="$REPO_ROOT/scripts/ci/resolve-acr-digest.sh"
if [ ! -f "$RESOLVER" ]; then
  echo "::error::image-preflight: the shared image-state checker $RESOLVER is missing. Refusing to fall back to an inline lookup — an unclassified lookup is what #3090 was." >&2
  exit 4
fi

for REF in "${REFS[@]}"; do
  # `--lease` is NOT passed: this script already holds the lease for the whole
  # batch. Letting each ref take and release its own would re-lock the registry
  # between refs and re-create the #2980 race inside the loop.
  #
  # stdout is the digest; stderr is the resolver's per-attempt evidence. BOTH
  # are kept — the evidence is echoed for every ref that is not PRESENT, which
  # is the forensics the old code threw away.
  set +e
  DIGEST=$(bash "$RESOLVER" --acr "$ACR" --image "$REF" 2>"$ERRFILE")
  RC=$?
  set -e
  DIGEST="$(printf '%s' "$DIGEST" | tr -d '\r' | head -1)"
  case "$RC" in
    0)
      PRESENT+=("$REF${DIGEST:+ @ $DIGEST}")
      ;;
    3)
      MISSING+=("$REF")
      echo "  ✗ $ACR/$REF — the registry ANSWERED and the tag is absent:" >&2
      sed 's/^/      /' "$ERRFILE" >&2
      ;;
    *)
      UNPROVEN+=("$REF")
      echo "  ? $ACR/$REF — the registry did NOT answer, so existence is UNPROVEN (resolver exit $RC):" >&2
      sed 's/^/      /' "$ERRFILE" >&2
      ;;
  esac
done

for P in "${PRESENT[@]:-}"; do [ -n "$P" ] && echo "  ✓ $ACR/$P"; done

# ── VERDICT ─────────────────────────────────────────────────────────────────
# ABSENT is reported FIRST when both occur: it is the actionable one (an image
# genuinely was not built) and it is the one with a producer workflow to name.
# But the UNPROVEN set is ALWAYS printed too, never folded into the absent list
# — that folding is the whole defect.
if [ "${#MISSING[@]}" -gt 0 ]; then
  echo "::error::image-preflight: MISSING in $ACR: ${MISSING[*]}" >&2
  echo "::error::(the registry ANSWERED 'no such tag' for each of these — this is a positive answer, not a failed lookup)" >&2
  if [ "${#UNPROVEN[@]}" -gt 0 ]; then
    echo "::error::image-preflight: additionally UNPROVEN (the registry never answered): ${UNPROVEN[*]}" >&2
  fi
  cat >&2 <<'REMEDIATION'
::error::The template about to be deployed references image tags that do not exist in this
::error::registry. Deploying anyway creates Container Apps that can never pull, fails the
::error::nested deployment, and takes the surrounding (live-estate-adopting) deployment with it.
::error::
::error::PRODUCERS — run the one for this cloud FIRST, then re-run this deploy:
::error::  Commercial : .github/workflows/full-app-deploy-commercial.yml
::error::               (build matrix stamps loom-duckdb:<tag>; the `mirror-upstream`
::error::                job builds it)
::error::  GCC-High   : .github/workflows/gov-provision-dataplane-images.yml
::error::               boundary=gcc-high  apply=true   [NEVER EXECUTED as of PR #2640]
::error::  IL5        : .github/workflows/gov-provision-dataplane-images.yml
::error::               boundary=il5  apply=true  resource_group=<il5-admin-rg>
::error::
::error::The tag the TEMPLATE pulls is appImageTags.duckdb (LOOM_DUCKDB_TAG, default v0.1)
::error::in platform/fiab/bicep/params/<boundary>.bicepparam. The producer's image_tag input
::error::defaults to the SAME v0.1 — if you override one you must override the other.
REMEDIATION
  exit 3
fi

if [ "${#UNPROVEN[@]}" -gt 0 ]; then
  # NOTE THE WORDING. This must never tell the operator to go rebuild an image.
  # The whole point of #3090 is that this state says nothing whatsoever about
  # whether the tag exists, so the remediation is about REACHING the registry.
  echo "::error::image-preflight: could NOT READ registry '$ACR' for ${UNPROVEN[*]}, so their existence is UNPROVEN — not disproven. NOTHING here says these tags are missing; do NOT rebuild them on the strength of this message (deploy-integrity.md R7)." >&2
  echo "::error::Refusing to continue: adopting a live estate on an unverified image tag is how a running catalog goes down. The registry is publicNetworkAccess=Disabled at rest (#2603) and this runner is outside the VNet, so the data plane needs the shared firewall lease — re-run with --lease, confirm the deploy identity holds 'Tag Contributor' on the registry so the lease can be TAKEN, or run the probe from inside the VNet (dispatch .github/workflows/loom-aca-runner-smoke.yml)." >&2
  exit 4
fi

echo "::notice::image-preflight: all ${#REFS[@]} referenced tag(s) present in $ACR."
# Release EXPLICITLY, before the verdict, so a re-lock that could not be
# verified turns this step red rather than being discovered inside the EXIT trap
# where it can no longer affect the exit code.
release_lease
if [ "$RELEASE_FAILED" = "1" ]; then
  echo "::error::image-preflight: every tag was verified present, but the registry could not be verified re-locked. Failing the step — see the re-lock error above." >&2
  exit 5
fi
exit 0

