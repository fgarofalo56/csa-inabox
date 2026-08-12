#!/usr/bin/env bash
# =============================================================================
# preflight-image-tags.sh — never repoint a LIVE Container App at a tag that
#                           does not exist in the registry
# =============================================================================
#
# WHY THIS EXISTS (svc-loom-unity-authz round 3)
#
# `loom-unity` is ALREADY DEPLOYED AND RUNNING in Azure Government
# (rg-csa-loom-admin-usgovvirginia — .github/workflows/gov-uc-purview-wire.yml
# created it out-of-band). admin-plane/main.bicep now deploys a Container App
# with that exact name into that exact resource group, so the next Gov infra
# deploy ADOPTS the live app: an idempotent ARM PUT that rewrites its template,
# including the image reference.
#
# The Gov bicepparams pull `loom-unity:v0.1`
# (`unity: readEnvironmentVariable('LOOM_UNITY_TAG','v0.1')`). If that tag is
# not in the Gov ACR, the adoption PUT succeeds at the ARM layer and then the
# new revision cannot pull its image — i.e. the deploy TAKES THE LIVE GOV
# CATALOG DOWN. `.github/workflows/gov-build-images.yml` is the producer for
# that tag and it has NEVER BEEN EXECUTED, so "the tag is probably there" is not
# a safe assumption to deploy on.
#
# This preflight makes that failure impossible to reach silently:
#
#   * Container App <app> does NOT exist in <rg>  -> GREENFIELD. Nothing is
#     being adopted. A missing tag is the EXPECTED state of the documented
#     two-phase path (no-vaporware.md: provision infra with deployAppsEnabled
#     =false, THEN build images, THEN bring the apps up). Notice, exit 0.
#   * Container App <app> EXISTS                  -> ADOPTION. The tag MUST
#     resolve to a manifest, or this exits 1 with the exact remediation.
#
# It is READ-ONLY against the deployment (no ARM writes) with one exception:
# the Loom ACRs are publicNetworkAccess=Disabled + defaultAction=Deny, and tag
# resolution is a DATA-plane call, so when the data plane is unreachable from
# this host the script takes the SAME owned firewall lease every other push path
# takes (scripts/csa-loom/acr-firewall-lease.sh) and always releases it.
#
# USAGE
#   preflight-image-tags.sh --rg rg-csa-loom-admin-usgovvirginia \
#       --require loom-unity:v0.1 \
#       --require loom-console:v0.1
#
#   # Container App name differs from the repository name:
#   preflight-image-tags.sh --rg <rg> --require loom-maps-tileserver:v1@loom-maps-tiles
#
# OPTIONS
#   --rg <name>            Resource group holding the Container Apps + the ACR.
#   --require <spec>       Repeatable. <repository>:<tag>[@<container-app-name>].
#                          The Container App name defaults to <repository>.
#   --acr <name>           Skip ACR discovery and use this registry.
#   --no-lease             Never touch the ACR firewall. If the data plane is
#                          unreachable the check FAILS instead of opening it.
#   -h | --help
#
# ENV
#   LOOM_SKIP_IMAGE_PREFLIGHT=true   EMERGENCY VALVE. Warns loudly and exits 0.
#
# EXIT CODES
#   0  every adopted app's tag resolves (or nothing is being adopted)
#   1  an adopted app's tag is MISSING, or it could not be verified
#   2  bad usage
#
# REQUIRES: az logged into the target cloud + subscription. Reader on the RG is
#           enough for the control-plane half; AcrPull for the data-plane half.
# =============================================================================
set -euo pipefail

RG=""
ACR=""
ALLOW_LEASE="true"
REQUIRES=()

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() { sed -n '2,70p' "${BASH_SOURCE[0]}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rg) RG="${2:-}"; shift 2 ;;
    --acr) ACR="${2:-}"; shift 2 ;;
    --require) REQUIRES+=("${2:-}"); shift 2 ;;
    --no-lease) ALLOW_LEASE="false"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "preflight-image-tags: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

# GitHub Actions annotations when running in CI, plain text otherwise.
in_ci() { [[ -n "${GITHUB_ACTIONS:-}" ]]; }
err()   { if in_ci; then echo "::error::$*"; else echo "ERROR: $*" >&2; fi; }
warn()  { if in_ci; then echo "::warning::$*"; else echo "WARNING: $*" >&2; fi; }
note()  { if in_ci; then echo "::notice::$*"; else echo "$*"; fi; }

if [[ "${LOOM_SKIP_IMAGE_PREFLIGHT:-false}" == "true" ]]; then
  warn "LOOM_SKIP_IMAGE_PREFLIGHT=true — SKIPPING the adopted-image preflight. If any Container App in ${RG:-<rg>} is being adopted onto a tag that is not in the registry, this deploy will replace a running revision with one that cannot pull its image."
  exit 0
fi

if [[ -z "$RG" || ${#REQUIRES[@]} -eq 0 ]]; then
  echo "preflight-image-tags: --rg and at least one --require are required." >&2
  usage
  exit 2
fi

# ---------------------------------------------------------------------------
# 0. Is there anything to adopt at all?
#    A resource group that does not exist yet is a from-scratch deploy: no live
#    app, nothing to break. Same for an RG with none of the named apps in it.
# ---------------------------------------------------------------------------
if ! az group show -n "$RG" -o none 2>/dev/null; then
  note "preflight: resource group '$RG' does not exist yet — from-scratch deploy, no live Container App is being adopted. Image tags are produced by the image-build phase that follows (see no-vaporware.md 'two-phase image path')."
  exit 0
fi

LIVE_APPS="$(az containerapp list -g "$RG" --query "[].name" -o tsv 2>/dev/null | tr -d '\r' || true)"

ADOPTED=()
for SPEC in "${REQUIRES[@]}"; do
  APP="${SPEC##*@}"
  REF="${SPEC%@*}"
  [[ "$SPEC" == *"@"* ]] || APP="${REF%%:*}"
  REPO="${REF%%:*}"
  TAG="${REF##*:}"
  if [[ -z "$REPO" || -z "$TAG" || "$REPO" == "$TAG" ]]; then
    echo "preflight-image-tags: malformed --require '$SPEC' (want <repository>:<tag>[@<app>])." >&2
    exit 2
  fi
  if echo "$LIVE_APPS" | grep -qx "$APP"; then
    ADOPTED+=("${REPO}:${TAG}@${APP}")
    note "preflight: Container App '$APP' is LIVE in $RG — this deploy ADOPTS it and will repoint it at ${REPO}:${TAG}. The tag must exist."
  else
    note "preflight: Container App '$APP' does not exist in $RG — greenfield, nothing adopted (${REPO}:${TAG} is produced by the image-build phase)."
  fi
done

if [[ ${#ADOPTED[@]} -eq 0 ]]; then
  note "preflight: no live Container App is being adopted — nothing to verify."
  exit 0
fi

# ---------------------------------------------------------------------------
# 1. Resolve the registry (control plane — reachable even when the ACR data
#    plane is firewalled off).
# ---------------------------------------------------------------------------
if [[ -z "$ACR" ]]; then
  ACR="$(az acr list -g "$RG" --query "[0].name" -o tsv 2>/dev/null | tr -d '\r' || true)"
fi
if [[ -z "$ACR" ]]; then
  err "Container App(s) ${ADOPTED[*]} are LIVE in $RG and this deploy will repoint them, but no Azure Container Registry was found in $RG — the image references cannot possibly resolve. Refusing to deploy."
  exit 1
fi
ACR_LOGIN="$(az acr show -n "$ACR" --query loginServer -o tsv 2>/dev/null | tr -d '\r' || true)"
ACR_LOGIN="${ACR_LOGIN:-$ACR}"
note "preflight: registry = $ACR ($ACR_LOGIN)"

# ---------------------------------------------------------------------------
# 2. Tag resolution (DATA plane). Try as-is first; only touch the firewall if
#    the registry is genuinely unreachable from here.
# ---------------------------------------------------------------------------
LEASE_HELD="false"
# The lease helper, overridable so the behaviour tests can exercise the LEASE
# PATH with a stub. Before this that path was unreachable under test: the tests
# stub `az` on PATH, so a real acquire spun against a stub registry — which is
# exactly why the "reads without a lease" race (#3137) had no coverage. Acquire
# and release BOTH route through it; stubbing only one half would leave a test
# that passes while the real script leaks a lease.
LEASE_SCRIPT="${LOOM_ACR_LEASE_SCRIPT:-${SCRIPT_DIR}/acr-firewall-lease.sh}"
# C24 (#3088): returns NON-ZERO when the registry could not be verified
# re-locked. It used to be `release … >/dev/null 2>&1 || warn "…"`, which broke
# the control two ways: it discarded the verdict (a failed re-lock became a
# warning on an otherwise-successful preflight), and `>/dev/null 2>&1` threw
# away the script's own concrete remediation — the exact deploy-integrity R7
# shape where the operator is told less than the code knew.
release_lease() {
  if [[ "$LEASE_HELD" != "true" ]]; then
    return 0
  fi
  LEASE_HELD="false"
  if ! bash "$LEASE_SCRIPT" release --acr "$ACR"; then
    err "preflight: could NOT verify the ACR firewall re-locked on $ACR — it may be PUBLICLY REACHABLE. The remediation the lease script printed is above; the scheduled sweeper (.github/workflows/acr-firewall-sweeper.yml) also retries."
    return 1
  fi
  return 0
}
# A bare non-zero command in an EXIT trap does NOT set the script's exit status
# (measured, bash 5.3), so the failure is turned into an explicit exit. A prior
# failure code is preserved so a clean re-lock never masks a failed preflight.
preflight_exit_trap() {
  local rc=$?
  if ! release_lease; then
    exit 1
  fi
  exit "$rc"
}
trap preflight_exit_trap EXIT

data_plane_up() { az acr repository list -n "$ACR" -o none 2>/dev/null; }

# TAKE THE LEASE WHENEVER WE INTEND TO READ — not only when we find the door
# already shut (#3137).
#
# The old shape probed first and leased ONLY on failure. That made a successful
# first probe the decision to read WITHOUT a lease, and an open registry is not
# the same thing as a registry that will STAY open: every Loom ACR rests at
# publicNetworkAccess=Disabled + defaultAction=Deny, so if it is open at all it
# is standing open under SOMEONE ELSE'S lease. When that holder releases — or
# acr-firewall-sweeper re-locks it — the door shuts mid-read.
#
# Measured on run 31589236616 (deploy-fiab-gcch, 2026-08-12T10:58Z): the
# "firewalled off — taking the lease" note NEVER printed, so the first probe
# succeeded and no lease was taken; SIX SECONDS later the second probe failed.
# The sibling image-build job in the same workflow had just released its lease.
# The deploy was reading on borrowed time and lost the race.
#
# Leasing unconditionally costs an ACR firewall update on the happy path. That is
# the correct trade for a gate whose whole job is to stop an adoption deploy
# repointing a LIVE Gov Container App at an unverified tag.
FIRST_PROBE_OK="false"
if data_plane_up; then FIRST_PROBE_OK="true"; fi

if [[ "$ALLOW_LEASE" != "true" ]]; then
  if [[ "$FIRST_PROBE_OK" != "true" ]]; then
    err "The $ACR data plane is not reachable from this host and --no-lease was passed, so the image tags for the LIVE app(s) ${ADOPTED[*]} cannot be verified. Refusing to deploy blind onto a running Gov app. Re-run from an in-VNet runner, or drop --no-lease so the owned firewall lease can be taken."
    exit 1
  fi
  note "preflight: --no-lease was passed and the $ACR data plane is reachable — reading WITHOUT a lease. If another holder releases mid-read this can still fail; that is the documented cost of --no-lease."
else
  if [[ "$FIRST_PROBE_OK" == "true" ]]; then
    note "preflight: $ACR data plane is reachable — taking the owned firewall lease anyway so it cannot be re-locked mid-read."
  else
    note "preflight: $ACR data plane is firewalled off — taking the owned firewall lease to read tags."
  fi
  if bash "$LEASE_SCRIPT" acquire --acr "$ACR"; then
    LEASE_HELD="true"
    for _ in $(seq 1 12); do data_plane_up && break; sleep 15; done
  elif [[ "$FIRST_PROBE_OK" == "true" ]]; then
    # Could not take our own lease, but the plane was reachable a moment ago.
    # Say exactly that rather than implying we are safe.
    note "preflight: could NOT acquire the firewall lease on $ACR. The data plane was reachable on the first probe, so the read is attempted anyway — but it is unprotected, and a concurrent release or sweep can still close it mid-read."
  fi
fi

if ! data_plane_up; then
  # R7 — do not assert a cause we did not establish. "Fix your AcrPull" is a
  # DIFFERENT bug from "the door shut under us", and stating the first when the
  # second happened sent this exact failure down the wrong path once already.
  if [[ "$FIRST_PROBE_OK" == "true" ]]; then
    err "The $ACR data plane was REACHABLE moments ago and is NOT reachable now, so the image tags for the LIVE app(s) ${ADOPTED[*]} could not be verified. This is a firewall race, not a permissions problem: the registry rests at Deny, it was standing open under another holder's lease, and it was re-locked mid-read (a sibling job releasing, or acr-firewall-sweeper). $( [[ "$LEASE_HELD" == "true" ]] && echo "This run HELD its own lease, so investigate who re-locked a leased registry." || echo "This run did NOT hold a lease — acquire failed above." ) Re-run; if it persists, check acr-firewall-lease.sh acquire permissions for this principal. EMERGENCY OVERRIDE: LOOM_SKIP_IMAGE_PREFLIGHT=true."
    exit 1
  fi
  err "Could not read the $ACR data plane, so the image tags for the LIVE app(s) ${ADOPTED[*]} could not be verified. An adoption deploy that repoints a running Gov Container App at an unverified tag can take it down, so this is a hard stop. Fix registry access (private endpoint / firewall / AcrPull on this principal) and re-run. EMERGENCY OVERRIDE: LOOM_SKIP_IMAGE_PREFLIGHT=true."
  exit 1
fi

FAILED=0
UNPROVEN_REFS=()
REPO_ROOT_PF="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESOLVER_PF="$REPO_ROOT_PF/ci/resolve-acr-digest.sh"
if [ ! -f "$RESOLVER_PF" ]; then
  err "the shared image-state checker $RESOLVER_PF is missing. Refusing to fall back to an inline lookup — an unclassified lookup is exactly what #3090 was."
  exit 1
fi

# Bound the per-ref retry budget. The resolver's defaults (6 attempts, 10s*n
# backoff) are sized for a roll resolving ONE image; this loop walks every
# adopted app, and data_plane_up() above has already established the registry is
# reachable, so a long budget here would only slow a deploy down. Overridable
# for a genuinely flaky estate.
export LOOM_DIGEST_ATTEMPTS="${LOOM_PREFLIGHT_ATTEMPTS:-3}"
export LOOM_DIGEST_ABSENT_ATTEMPTS="${LOOM_PREFLIGHT_ABSENT_ATTEMPTS:-2}"
export LOOM_DIGEST_BACKOFF_SECONDS="${LOOM_PREFLIGHT_BACKOFF_SECONDS:-5}"

# #3090 — THIS LOOP USED TO CONVICT TAGS IT COULD NOT READ, ON THE PATH THAT
# GATES LIVE GOV CONTAINER APP ADOPTION. It was:
#
#   DIGEST="$(az acr repository show … --query digest -o tsv 2>/dev/null | tr -d '\r' || true)"
#   if [[ -z "$DIGEST" ]]; then … "${REPO}:${TAG} does not exist" …
#
# `2>/dev/null` + `|| true` + an emptiness test: a per-repo AcrPull denial, a
# throttle, or the lease lapsing mid-loop all rendered as "does not exist" — and
# the remediation then sent the operator to rebuild an image that was fine. The
# show-tags fallback discarded ITS stderr too, so an unreadable repository
# printed "<none — the repository itself is empty or absent>", a second
# unestablished absence claim inside the first one.
#
# Absence now comes only from the shared three-state checker (exit 3 = the
# registry ANSWERED; exit 4 = it did not). Unproven is a hard stop with its own
# wording — on this path an unverifiable tag must never be adopted either, but
# it must not be described as missing.
for ENTRY in "${ADOPTED[@]}"; do
  APP="${ENTRY##*@}"
  REF="${ENTRY%@*}"
  REPO="${REF%%:*}"
  TAG="${REF##*:}"
  set +e
  DIGEST="$(bash "$RESOLVER_PF" --acr "$ACR" --image "${REPO}:${TAG}")"
  RC=$?
  set -e
  DIGEST="$(printf '%s' "$DIGEST" | tr -d '\r' | head -1)"
  if [[ $RC -eq 0 && -n "$DIGEST" ]]; then
    note "preflight OK — ${REPO}:${TAG} resolves to ${DIGEST} (Container App '${APP}' can be adopted safely)."
    continue
  fi
  FAILED=1
  if [[ $RC -eq 3 ]]; then
    # The registry ANSWERED. Only now may the tag list be quoted as evidence —
    # and its own read is captured, so an unreadable listing says so.
    set +e
    AVAIL_OUT="$(az acr repository show-tags -n "$ACR" --repository "$REPO" --top 10 --orderby time_desc -o tsv 2>&1)"
    AVAIL_RC=$?
    set -e
    if [[ $AVAIL_RC -eq 0 ]]; then
      AVAILABLE="$(printf '%s' "$AVAIL_OUT" | tr -d '\r' | paste -sd, -)"
      AVAILABLE="${AVAILABLE:-<none — the registry answered with an empty tag list>}"
    else
      AVAILABLE="<could not be read: $(printf '%s' "$AVAIL_OUT" | tr -d '\r' | tr '\n' ' ' | cut -c1-160)>"
    fi
    err "IMAGE PREFLIGHT FAILED — the registry ANSWERED and ${ACR_LOGIN}/${REPO}:${TAG} does not exist, but Container App '${APP}' is LIVE in ${RG} and this deploy would repoint it at that tag. The running revision would be replaced by one that cannot pull its image (the app goes DOWN). Tags present for '${REPO}': ${AVAILABLE}. REMEDIATION: run .github/workflows/gov-build-images.yml (inputs: apps=${REPO}, tag=${TAG}) against this estate first, then re-run this deploy."
  else
    UNPROVEN_REFS+=("${REPO}:${TAG}")
    err "IMAGE PREFLIGHT UNPROVEN — could NOT read ${ACR_LOGIN}/${REPO}:${TAG}, so its existence is UNPROVEN, NOT disproven (resolver exit $RC; its per-attempt evidence is above). Container App '${APP}' is LIVE in ${RG} and this deploy would repoint it, so this is still a hard stop — but nothing here says the tag is missing and you must NOT rebuild it on the strength of this message. REMEDIATION: fix registry ACCESS (the ACR firewall lease, the private endpoint, or AcrPull on this principal) and re-run."
  fi
done

# C24: the re-lock is a hard gate here too. Under `set -e` a bare
# `release_lease` would already abort, but the trap is cleared on the next line,
# so make the intent explicit rather than leaving it to errexit.
if ! release_lease; then
  exit 1
fi
trap - EXIT

if [[ "$FAILED" != "0" ]]; then
  if (( ${#UNPROVEN_REFS[@]} > 0 )); then
    err "SUMMARY: ${#UNPROVEN_REFS[@]} tag(s) could not be READ (${UNPROVEN_REFS[*]}). That is 'unknown', not 'missing' — do not rebuild them on the strength of this run."
  fi
  exit 1
fi

note "preflight: every adopted Container App's image tag resolves in $ACR."
