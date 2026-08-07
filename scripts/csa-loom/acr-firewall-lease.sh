#!/usr/bin/env bash
# =============================================================================
# acr-firewall-lease.sh — owned, fail-closed mutex for the ACR firewall toggle
# =============================================================================
#
# WHY THIS EXISTS (issue #2603)
#
# The Loom ACRs are provisioned publicNetworkAccess=Disabled + networkRuleSet
# defaultAction=Deny (private endpoint only). Every path that needs to push an
# image from outside the VNet — `az acr build` from a GitHub-hosted runner, the
# cosign sign/verify data-plane calls, the deploy-*-job.sh scripts a human runs
# from a laptop — has to open the firewall, do its work, and close it again.
#
# That open/restore pair was a SHARED MUTEX WITH NO OWNERSHIP CHECK. ANY
# process's "restore" step re-locked the registry, including a process that no
# longer had any business doing so. Observed 2026-07-28: run `61a46c22` of
# build-fiab-images-acr-tasks was CANCELLED; its `acr_restore` job still runs
# (`if: always()`), and GitHub had already released the concurrency slot, so the
# next run (`a293b805`) was mid-`az acr build`. The cancelled run's restore
# closed the registry underneath it and the push died after ~14 minutes of work:
#
#     denied: client with IP '20.29.127.164' is not allowed access
#     failed to run step ID: push: failed to push images successfully
#
# The workflow-level `concurrency:` guard only serializes two *running*
# instances of ONE workflow. It does not cover a cancelled run's cleanup, and it
# does not cover the ~19 other call sites (other workflows, other clouds, and
# shell scripts run by humans) that toggle the same registry.
#
# -----------------------------------------------------------------------------
# THE DESIGN
# -----------------------------------------------------------------------------
#
# A lease recorded as ARM tags on the ACR resource itself:
#
#   loomAcrFwOwner        opaque holder id, or "none"
#   loomAcrFwExpiresEpoch unix seconds; the lease is STALE at/after this
#   loomAcrFwSinceUtc     ISO-8601 claim time (human forensics only)
#   loomAcrFwHolderUrl    GHA run URL (or "local:<host>"); used to probe liveness
#
# ARM tags were chosen over a blob lease / ACR tag marker for one reason: the
# control plane is reachable even when the registry's DATA plane is firewalled
# off. A marker stored *inside* the registry is unreadable in exactly the state
# we need to read it. `az tag update --operation Merge` patches the tags
# sub-resource, so it never rewrites the registry body.
#
# Three invariants, in priority order:
#
#   1. FAIL CLOSED. The registry must never be left publicly reachable. Skipping
#      the restore on cancellation is NOT a fix on its own — if the surviving
#      holder also dies, the door stays open. So: `release` re-locks whenever
#      there is no LIVE holder (not just when this process is the holder), and
#      the scheduled sweeper (.github/workflows/acr-firewall-sweeper.yml)
#      re-locks any registry found open with a dead/absent/expired lease.
#
#   2. ONLY THE HOLDER CLOSES. The close decision is made from a FRESH read of
#      the owner tag at release time, never from a cached "I won the race" flag.
#      Because there is exactly one owner tag value, at most one process can
#      conclude "I am the holder" at any instant.
#
#   3. BOUNDED. `acquire` waits at most LOOM_ACR_LEASE_WAIT_MINUTES (default 25)
#      and then FAILS LOUDLY naming the current holder and its run URL. There is
#      no unbounded wait-for-lock loop.
#
# CLAIM RACE. ARM tags have no compare-and-swap, so `acquire` uses
# write -> settle -> read-back -> settle -> read-back. Two simultaneous claimants
# both write; last write wins; each re-reads, so at most one sees itself. In the
# pathological case where tag propagation exceeds both settles and both believe
# they won, invariant 2 still holds: both open (harmless — open is idempotent
# and the work is a push), and only the one the tag actually names will close.
#
# STALE TAKEOVER. A holder that crashes without releasing leaves a lease that
# expires at loomAcrFwExpiresEpoch (default TTL 75 min). After that, the next
# `acquire` takes it over with a loud warning, and the sweeper re-locks. The
# sweeper additionally probes GitHub for the holder run's status, so a crashed
# or cancelled GHA holder is swept within one sweeper interval instead of
# waiting out the full TTL.
#
# DEGRADED MODE. If the identity cannot write tags (missing
# Microsoft.Resources/tags/write — grant "Tag Contributor" on the ACR), the
# lease cannot be taken. Rather than hard-failing every build on a permission
# gap, the default is LOOM_ACR_LEASE_FALLBACK=legacy: emit a ::error:: naming
# the exact missing permission, proceed UNLEASED, and on release fall back to
# the pre-#2603 unconditional re-lock — which is fail-closed, just not
# race-free. An unleased process still *reads* the lease and refuses to open or
# to close when a live foreign holder is recorded, so read-only participants
# still get most of the protection. Set LOOM_ACR_LEASE_FALLBACK=fail to make a
# lease-infrastructure failure fatal instead.
#
# -----------------------------------------------------------------------------
# USAGE
# -----------------------------------------------------------------------------
#
#   scripts/csa-loom/acr-firewall-lease.sh acquire --acr <name> [--subscription <sub>]
#   scripts/csa-loom/acr-firewall-lease.sh release --acr <name> [--subscription <sub>]
#   scripts/csa-loom/acr-firewall-lease.sh status  --acr <name> [--subscription <sub>]
#   scripts/csa-loom/acr-firewall-lease.sh sweep   --acr <name> [--subscription <sub>] [--force]
#   scripts/csa-loom/acr-firewall-lease.sh verify  --acr <name> [--subscription <sub>]
#
# `release` and `sweep` EXIT NON-ZERO when the registry could not be VERIFIED
# locked (C24 / #3088). Do not append `|| true` to them: that restores exactly
# the defect — a green step over a publicly reachable registry.
#
# `verify` is read-only: exit 0 = locked, 1 = state unreadable, 2 = OPEN. The
# three are distinct on purpose; "I could not check" must never be reported as
# "it is fine" (deploy-integrity R7).
#
# Or source it and call acr_lease_acquire / acr_lease_release directly:
#
#   . "$(dirname "$0")/acr-firewall-lease.sh"
#   acr_lease_acquire --acr "$ACR_NAME" --subscription "$SUB"
#   trap 'acr_lease_release --acr "$ACR_NAME" --subscription "$SUB"' EXIT
#
# Tunables (env):
#   LOOM_ACR_LEASE_TTL_MINUTES     75   lease lifetime; sized for a console build
#   LOOM_ACR_LEASE_WAIT_MINUTES    25   bounded acquire wait before failing
#   LOOM_ACR_LEASE_SETTLE_SECONDS   6   tag read-back settle between confirmations
#   LOOM_ACR_LEASE_OPEN_SECONDS    35   firewall-rule propagation wait after open
#   LOOM_ACR_CLOSE_ATTEMPTS         6   verified-close attempts before failing
#   LOOM_ACR_CLOSE_RETRY_SECONDS   20   wait between close attempts (6x20 = 120s,
#                                       past the documented 30-90s propagation)
#   LOOM_ACR_LEASE_FALLBACK    legacy   legacy | fail — behavior when tags are unwritable
#   LOOM_ACR_LEASE_OWNER            -   override the auto-derived holder id
#
# Related: docs/fiab/acr-firewall-lease.md, .github/workflows/acr-firewall-sweeper.yml
# =============================================================================

ACR_LEASE_TAG_OWNER="loomAcrFwOwner"
ACR_LEASE_TAG_EXPIRES="loomAcrFwExpiresEpoch"
ACR_LEASE_TAG_SINCE="loomAcrFwSinceUtc"
ACR_LEASE_TAG_URL="loomAcrFwHolderUrl"

# Populated by acr_lease_acquire; read by acr_lease_release.
#   held     — this process is the recorded holder
#   unleased — degraded mode, opened without a lease (see DEGRADED MODE above)
#   none     — never acquired
ACR_LEASE_STATE="${ACR_LEASE_STATE:-none}"

# --- logging -----------------------------------------------------------------
# Emits GitHub Actions annotations under CI, plain text otherwise, so the same
# lines are useful in a workflow log and on a laptop.

_lease_log()  { printf '[acr-lease] %s\n' "$*" >&2; }
_lease_note() {
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then printf '::notice::[acr-lease] %s\n' "$*"
  else printf '[acr-lease] %s\n' "$*" >&2; fi
}
_lease_warn() {
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then printf '::warning::[acr-lease] %s\n' "$*"
  else printf '[acr-lease] WARNING: %s\n' "$*" >&2; fi
}
_lease_err() {
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then printf '::error::[acr-lease] %s\n' "$*"
  else printf '[acr-lease] ERROR: %s\n' "$*" >&2; fi
}

# --- helpers -----------------------------------------------------------------

_lease_now() { date -u +%s; }

# ARM tag values tolerate most characters, but the CLI's `--tags k=v` parser
# splits on the first '=' — so keep '=' (and anything exotic) out of the value.
_lease_sanitize() { printf '%s' "$1" | tr -c 'A-Za-z0-9._:@/-' '_'; }

# Default holder id. In CI it names the exact run + attempt, which is what a
# reviewer needs when a lease blocks their job; locally it names user@host:pid.
_lease_default_owner() {
  if [ -n "${LOOM_ACR_LEASE_OWNER:-}" ]; then
    _lease_sanitize "$LOOM_ACR_LEASE_OWNER"
  elif [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    _lease_sanitize "gha:${GITHUB_REPOSITORY:-unknown}:${GITHUB_RUN_ID:-0}:${GITHUB_RUN_ATTEMPT:-1}"
  else
    _lease_sanitize "cli:${USER:-${USERNAME:-unknown}}@$(hostname 2>/dev/null || echo host):$$"
  fi
}

_lease_default_url() {
  if [ "${GITHUB_ACTIONS:-}" = "true" ] && [ -n "${GITHUB_RUN_ID:-}" ]; then
    printf '%s/%s/actions/runs/%s' "${GITHUB_SERVER_URL:-https://github.com}" \
      "${GITHUB_REPOSITORY:-unknown}" "${GITHUB_RUN_ID}"
  else
    printf 'local:%s' "$(hostname 2>/dev/null || echo host)"
  fi
}

# Read one JMESPath expression off the ACR resource. Missing tags return "".
_lease_acr_q() {
  # shellcheck disable=SC2086
  az acr show --name "$_LEASE_ACR" $_LEASE_SUB_ARG --query "$1" -o tsv 2>/dev/null \
    | tr -d '\r' | head -1
}

_lease_resource_id() {
  # shellcheck disable=SC2086
  az acr show --name "$_LEASE_ACR" $_LEASE_SUB_ARG --query id -o tsv 2>/dev/null | tr -d '\r' | head -1
}

# Merge-patch the lease tags. Returns non-zero when the identity lacks
# Microsoft.Resources/tags/write (the degraded-mode trigger).
_lease_write() {
  local owner="$1" expires="$2" url="$3" rid
  rid="$(_lease_resource_id)"
  if [ -z "$rid" ]; then
    _lease_err "cannot resolve the ARM resource id for ACR '$_LEASE_ACR' — is the name right and is this the correct subscription/cloud?"
    return 1
  fi
  az tag update --resource-id "$rid" --operation Merge --tags \
    "${ACR_LEASE_TAG_OWNER}=${owner}" \
    "${ACR_LEASE_TAG_EXPIRES}=${expires}" \
    "${ACR_LEASE_TAG_SINCE}=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "${ACR_LEASE_TAG_URL}=${url}" \
    -o none 2>/dev/null
}

_lease_clear() { _lease_write "none" "0" "none"; }

_lease_open_firewall() {
  _lease_note "opening ACR '$_LEASE_ACR' (publicNetworkAccess=Enabled, defaultAction=Allow) ..."
  # shellcheck disable=SC2086
  az acr update --name "$_LEASE_ACR" $_LEASE_SUB_ARG \
    --public-network-enabled true --default-action Allow -o none || return 1
  # ACR network-rule changes propagate asynchronously (~30-90s); every caller
  # previously slept here, so keep the wait inside the primitive.
  sleep "${LOOM_ACR_LEASE_OPEN_SECONDS:-35}"
}

# Read the firewall state. Prints "<pna>\t<da>" on success; returns 1 when the
# registry could not be READ, with the az error on stderr.
#
# Deliberately NOT `2>/dev/null` (deploy-integrity R7): swallowing stderr turns
# an RBAC denial, a throttle and a genuine answer into the same empty string,
# and the caller then states one of them as fact. That is the "the tag does not
# exist" incident verbatim. Here, unreadable is its own outcome and it is never
# reported as "locked".
_lease_read_firewall() {
  local out rc pna da
  # shellcheck disable=SC2086
  out="$(az acr show --name "$_LEASE_ACR" $_LEASE_SUB_ARG \
    --query "[publicNetworkAccess, networkRuleSet.defaultAction]" -o tsv 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    _LEASE_READ_ERROR="$(printf '%s' "$out" | tr -d '\r' | tr '\n' ' ' | cut -c1-300)"
    return 1
  fi
  out="$(printf '%s' "$out" | tr -d '\r' | head -1)"
  pna="$(printf '%s' "$out" | cut -f1)"
  da="$(printf '%s' "$out" | cut -f2)"
  if [ -z "$pna" ] && [ -z "$da" ]; then
    _LEASE_READ_ERROR="az acr show returned no publicNetworkAccess / defaultAction for '$_LEASE_ACR'"
    return 1
  fi
  printf '%s\t%s\n' "$pna" "$da"
}

# 0 = VERIFIED locked (Disabled + Deny); 1 = state UNREADABLE; 2 = still OPEN.
# Never conflates 1 and 2: "I could not check" is not "it is fine", and it is
# not "it is open" either.
acr_lease_verify_locked() {
  local state pna da
  if ! state="$(_lease_read_firewall)"; then
    _LEASE_LAST_STATE="unreadable: ${_LEASE_READ_ERROR:-unknown error}"
    return 1
  fi
  pna="$(printf '%s' "$state" | cut -f1)"
  da="$(printf '%s' "$state" | cut -f2)"
  _LEASE_LAST_STATE="publicNetworkAccess=${pna:-<empty>}, defaultAction=${da:-<empty>}"
  [ "$pna" = "Disabled" ] && [ "$da" = "Deny" ] && return 0
  return 2
}

# Re-lock and PROVE it (issue #3088 / FINISHLINE C24).
#
# WHAT THIS FIXES. Both writes used to end in `|| true` and nothing ever read
# the registry back, so this function returned 0 unconditionally — including
# when neither write landed. MEASURED 2026-08-07 after run 31143181962: the
# "Re-lock ACR (private endpoint only)" job concluded SUCCESS while
# `az acr show` read publicNetworkAccess=Enabled / defaultAction=Allow on three
# probes across a minute (so not the documented 30-90s propagation lag). The
# Commercial ACR was publicly reachable for an unknown window with CI green,
# and a human re-locked it by hand.
#
# The likely cause of that particular divergence — `full-app-deploy`'s
# concurrency group keyed on `inputs.region || 'auto'`, so two runs landed in
# different groups and raced for the same firewall lease — is fixed separately
# (D7 made the group a constant). It is NOT what made the incident invisible.
# A step that writes and never reads back reports success on a no-op forever,
# whatever the cause. This is the read-back.
#
# Shape follows the Key Vault sibling `kv-firewall-window.sh kvw_close`, which
# has had verified-close since #2855: write, verify, retry the retryable within
# a bounded budget, and FAIL CLOSED with a concrete hand-remediation on
# exhaustion (deploy-integrity R6). Returns 0 only when the locked state was
# actually observed.
_lease_close_firewall() {
  local attempts retry n rc deny_out pna_out
  attempts="${LOOM_ACR_CLOSE_ATTEMPTS:-6}"
  retry="${LOOM_ACR_CLOSE_RETRY_SECONDS:-20}"
  _LEASE_LAST_STATE=""

  n=1
  while [ "$n" -le "$attempts" ]; do
    _lease_note "re-locking ACR '$_LEASE_ACR' (defaultAction=Deny, publicNetworkAccess=Disabled) — attempt ${n}/${attempts} ..."
    # Deny first, then disable the endpoint — same order as the pre-#2603 code.
    # A write error is CAPTURED, not discarded: it is the remediation hint when
    # the verify below also fails. It is not itself the verdict — another
    # process may have locked the registry already, in which case a failed
    # write followed by a clean read is a PASS.
    # shellcheck disable=SC2086
    deny_out="$(az acr update --name "$_LEASE_ACR" $_LEASE_SUB_ARG --default-action Deny -o none 2>&1)" || true
    # shellcheck disable=SC2086
    pna_out="$(az acr update --name "$_LEASE_ACR" $_LEASE_SUB_ARG --public-network-enabled false -o none 2>&1)" || true

    acr_lease_verify_locked
    rc=$?
    if [ "$rc" -eq 0 ]; then
      _lease_note "ACR '$_LEASE_ACR' VERIFIED locked (publicNetworkAccess=Disabled, defaultAction=Deny) after attempt ${n}."
      return 0
    fi

    if [ "$n" -lt "$attempts" ]; then
      if [ "$rc" -eq 1 ]; then
        _lease_warn "attempt ${n}/${attempts}: could not READ BACK the firewall state of ACR '$_LEASE_ACR' (${_LEASE_LAST_STATE}). This is not evidence that it locked — retrying in ${retry}s."
      else
        _lease_warn "attempt ${n}/${attempts}: ACR '$_LEASE_ACR' is still OPEN after the write (${_LEASE_LAST_STATE}) — retrying in ${retry}s (ACR network changes propagate for ~30-90s)."
      fi
      sleep "$retry"
    fi
    n=$(( n + 1 ))
  done

  # Exhausted. Say exactly what was observed and what to run — never a bare
  # exit code, and never a cause that was not established.
  _lease_err "FAILED to re-lock ACR '$_LEASE_ACR' after ${attempts} attempts (last observed: ${_LEASE_LAST_STATE:-state unreadable}). The registry may be PUBLICLY REACHABLE. Re-lock it by hand NOW: az acr update --name $_LEASE_ACR --default-action Deny --public-network-enabled false ; then confirm with: az acr show --name $_LEASE_ACR --query '[publicNetworkAccess, networkRuleSet.defaultAction]' -o tsv"
  [ -n "$deny_out" ] && _lease_err "last 'az acr update --default-action Deny' output: $(printf '%s' "$deny_out" | tr '\n' ' ' | cut -c1-300)"
  [ -n "$pna_out" ] && _lease_err "last 'az acr update --public-network-enabled false' output: $(printf '%s' "$pna_out" | tr '\n' ' ' | cut -c1-300)"
  return 1
}

# Parse the shared --acr / --subscription / --owner flags into _LEASE_* vars.
_lease_parse_args() {
  _LEASE_ACR=""; _LEASE_SUB=""; _LEASE_OWNER=""; _LEASE_FORCE="false"
  while [ $# -gt 0 ]; do
    case "$1" in
      --acr)          _LEASE_ACR="${2:-}"; shift 2 ;;
      --subscription) _LEASE_SUB="${2:-}"; shift 2 ;;
      --owner)        _LEASE_OWNER="${2:-}"; shift 2 ;;
      --force)        _LEASE_FORCE="true"; shift ;;
      *) _lease_err "unknown argument: $1"; return 2 ;;
    esac
  done
  if [ -z "$_LEASE_ACR" ]; then
    _lease_err "--acr <registry-name> is required (the ACR NAME, not the login server)"
    return 2
  fi
  # Tolerate being handed a login server (acrfoo.azurecr.io / .azurecr.us).
  _LEASE_ACR="${_LEASE_ACR%%.*}"
  _LEASE_SUB_ARG=""
  [ -n "$_LEASE_SUB" ] && _LEASE_SUB_ARG="--subscription $_LEASE_SUB"
  if [ -z "$_LEASE_OWNER" ]; then
    _LEASE_OWNER="$(_lease_default_owner)"
  else
    _LEASE_OWNER="$(_lease_sanitize "$_LEASE_OWNER")"
  fi
  return 0
}

# Is the recorded lease live? 0 = a non-expired foreign/own holder is recorded.
_lease_is_live() {
  local owner="$1" expires="$2"
  [ -n "$owner" ] && [ "$owner" != "none" ] || return 1
  case "$expires" in ''|*[!0-9]*) expires=0 ;; esac
  [ "$expires" -gt "$(_lease_now)" ]
}

# Best-effort liveness probe of a GHA holder. Returns 0 ONLY when we positively
# established the run is finished; "unknown" is treated as alive (conservative).
_lease_holder_finished() {
  local url="$1" repo runid st
  command -v gh >/dev/null 2>&1 || return 1
  [ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ] || return 1
  case "$url" in
    https://github.com/*/actions/runs/*) : ;;
    *) return 1 ;;
  esac
  repo="${url#https://github.com/}"; repo="${repo%%/actions/runs/*}"
  runid="${url##*/actions/runs/}"; runid="${runid%%/*}"
  case "$runid" in ''|*[!0-9]*) return 1 ;; esac
  st="$(gh run view "$runid" --repo "$repo" --json status -q .status 2>/dev/null | tr -d '\r')"
  case "$st" in
    ''|in_progress|queued|waiting|requested|pending) return 1 ;;
    *) return 0 ;;
  esac
}

# --- public: acquire ---------------------------------------------------------

acr_lease_acquire() {
  _lease_parse_args "$@" || return $?

  local ttl_min wait_min settle me my_url deadline attempt now owner expires holder_url confirmed remaining
  ttl_min="${LOOM_ACR_LEASE_TTL_MINUTES:-75}"
  wait_min="${LOOM_ACR_LEASE_WAIT_MINUTES:-25}"
  settle="${LOOM_ACR_LEASE_SETTLE_SECONDS:-6}"
  me="$_LEASE_OWNER"
  my_url="$(_lease_default_url)"
  deadline=$(( $(_lease_now) + wait_min * 60 ))
  attempt=0

  _lease_log "acquiring the ACR firewall lease on '$_LEASE_ACR' as '$me' (ttl ${ttl_min}m, bounded wait ${wait_min}m)"

  while :; do
    attempt=$(( attempt + 1 ))
    now="$(_lease_now)"
    owner="$(_lease_acr_q "tags.${ACR_LEASE_TAG_OWNER}")"
    expires="$(_lease_acr_q "tags.${ACR_LEASE_TAG_EXPIRES}")"
    holder_url="$(_lease_acr_q "tags.${ACR_LEASE_TAG_URL}")"
    case "$expires" in ''|*[!0-9]*) expires=0 ;; esac

    if [ "$owner" = "$me" ] || ! _lease_is_live "$owner" "$expires"; then
      # Free, stale, or already ours — reentrant by design so a workflow with
      # several open/close pairs in one run doesn't deadlock against itself.
      if [ -n "$owner" ] && [ "$owner" != "none" ] && [ "$owner" != "$me" ]; then
        _lease_warn "taking over a STALE lease on '$_LEASE_ACR' held by '$owner' ($holder_url) — it expired $(( now - expires ))s ago without releasing. If that holder is somehow still pushing, this is the window where #2603 could recur; raise LOOM_ACR_LEASE_TTL_MINUTES if legitimate work exceeds ${ttl_min}m."
      fi

      if _lease_write "$me" "$(( now + ttl_min * 60 ))" "$my_url"; then
        # No CAS on ARM tags: write, settle, read back — twice. A losing
        # claimant sees the winner's id and backs off.
        confirmed=true
        for _ in 1 2; do
          sleep "$settle"
          if [ "$(_lease_acr_q "tags.${ACR_LEASE_TAG_OWNER}")" != "$me" ]; then
            confirmed=false; break
          fi
        done
        if [ "$confirmed" = "true" ]; then
          ACR_LEASE_STATE="held"
          _lease_note "HELD the ACR firewall lease on '$_LEASE_ACR' as '$me' for ${ttl_min}m (attempt ${attempt})."
          _lease_open_firewall || { _lease_err "failed to open ACR '$_LEASE_ACR' after taking the lease."; return 1; }
          return 0
        fi
        _lease_log "lost the claim race on attempt ${attempt} (another process wrote the owner tag after us) — backing off"
      else
        # Cannot write tags at all.
        _lease_err "could not write the lease tags on ACR '$_LEASE_ACR'. The signed-in identity is missing Microsoft.Resources/tags/write — grant it the 'Tag Contributor' role on the registry (or Contributor) so the #2603 ACR-firewall lease can be taken."
        if [ "${LOOM_ACR_LEASE_FALLBACK:-legacy}" = "fail" ]; then
          _lease_err "LOOM_ACR_LEASE_FALLBACK=fail — refusing to open the ACR without a lease."
          return 1
        fi
        _lease_warn "LOOM_ACR_LEASE_FALLBACK=legacy — proceeding UNLEASED (pre-#2603 behavior: unconditional re-lock on release). This is fail-closed but NOT race-free."
        ACR_LEASE_STATE="unleased"
        _lease_open_firewall || { _lease_err "failed to open ACR '$_LEASE_ACR'."; return 1; }
        return 0
      fi
    else
      remaining=$(( expires - now ))
      _lease_log "ACR '$_LEASE_ACR' firewall lease is held by '$owner' ($holder_url) for another ${remaining}s — waiting (bounded)"
    fi

    if [ "$(_lease_now)" -ge "$deadline" ]; then
      _lease_err "TIMED OUT after ${wait_min}m waiting for the ACR firewall lease on '$_LEASE_ACR'. Current holder: '${owner:-none}' ($holder_url). This job did NOT open the registry and did NOT disturb the holder. Wait for that run to finish and re-run this one, or — if the holder is known dead — run: scripts/csa-loom/acr-firewall-lease.sh sweep --acr $_LEASE_ACR --force"
      return 1
    fi
    # Jittered backoff so two claimants de-synchronize instead of colliding
    # on every round.
    sleep $(( 15 + (RANDOM % 16) ))
  done
}

# --- public: release ---------------------------------------------------------

acr_lease_release() {
  _lease_parse_args "$@" || return $?
  local me owner expires holder_url
  me="$_LEASE_OWNER"

  owner="$(_lease_acr_q "tags.${ACR_LEASE_TAG_OWNER}")"
  expires="$(_lease_acr_q "tags.${ACR_LEASE_TAG_EXPIRES}")"
  holder_url="$(_lease_acr_q "tags.${ACR_LEASE_TAG_URL}")"
  case "$expires" in ''|*[!0-9]*) expires=0 ;; esac

  if [ "$owner" = "$me" ]; then
    # C24 (#3088): the close is now VERIFIED and its failure PROPAGATES. It used
    # to be fire-and-forget — this function returned 0 whether or not the
    # registry actually locked, which is how a green "Re-lock ACR" job sat on
    # top of a publicly reachable Commercial ACR on 2026-08-07.
    if ! _lease_close_firewall; then
      # Leave the lease tags ALONE. Clearing them would advertise the registry
      # as unowned while it is still open, and the sweeper's stale-lease branch
      # would then treat a live failure as tidy-up. Keeping the lease means the
      # sweeper sees an open registry with a holder it can probe.
      _lease_err "release FAILED on ACR '$_LEASE_ACR': the lease is held by this process but the registry could not be verified locked. Not clearing the lease tags — acr-firewall-sweeper will retry, and the lease keeps naming this run as the holder."
      return 1
    fi
    _lease_clear || _lease_warn "re-locked ACR '$_LEASE_ACR' but could not clear the lease tags; the sweeper will tidy them."
    _lease_note "released the ACR firewall lease on '$_LEASE_ACR' and VERIFIED it re-locked."
    ACR_LEASE_STATE="none"
    return 0
  fi

  if _lease_is_live "$owner" "$expires"; then
    # THE #2603 FIX. Somebody else legitimately holds the registry open — very
    # likely mid-push. Re-locking here is precisely the bug: it denies their
    # upload after minutes of work. Leave it open; they will re-lock on their
    # own release, and the sweeper re-locks if they die.
    _lease_warn "NOT re-locking ACR '$_LEASE_ACR': the firewall lease is held by '$owner' ($holder_url) for another $(( expires - $(_lease_now) ))s, not by this process ('$me'). Re-locking now would deny that holder's in-flight push — this is exactly issue #2603. The holder re-locks on release; acr-firewall-sweeper re-locks if the holder dies."
    ACR_LEASE_STATE="none"
    return 0
  fi

  # No live holder recorded — either we were unleased (degraded mode) or the
  # lease already expired. Either way nobody is protected by leaving it open, so
  # FAIL CLOSED.
  if [ "$ACR_LEASE_STATE" = "unleased" ]; then
    _lease_warn "re-locking ACR '$_LEASE_ACR' unleased (degraded mode) — no live lease holder is recorded, so this is safe, but grant 'Tag Contributor' to get the race-free path."
  else
    _lease_warn "re-locking ACR '$_LEASE_ACR' although this process ('$me') is not the recorded holder ('${owner:-none}') — no LIVE holder exists, and leaving a registry publicly reachable is never acceptable (fail closed)."
  fi
  if ! _lease_close_firewall; then
    _lease_err "release FAILED on ACR '$_LEASE_ACR' (no live lease holder). The registry may be PUBLICLY REACHABLE — see the remediation above."
    return 1
  fi
  _lease_clear >/dev/null 2>&1 || true
  ACR_LEASE_STATE="none"
  return 0
}

# --- public: status ----------------------------------------------------------

acr_lease_status() {
  _lease_parse_args "$@" || return $?
  local pna da owner expires since holder_url
  pna="$(_lease_acr_q "publicNetworkAccess")"
  da="$(_lease_acr_q "networkRuleSet.defaultAction")"
  owner="$(_lease_acr_q "tags.${ACR_LEASE_TAG_OWNER}")"
  expires="$(_lease_acr_q "tags.${ACR_LEASE_TAG_EXPIRES}")"
  since="$(_lease_acr_q "tags.${ACR_LEASE_TAG_SINCE}")"
  holder_url="$(_lease_acr_q "tags.${ACR_LEASE_TAG_URL}")"
  case "$expires" in ''|*[!0-9]*) expires=0 ;; esac

  printf 'acr                 : %s\n' "$_LEASE_ACR"
  printf 'publicNetworkAccess : %s\n' "${pna:-<unreadable>}"
  printf 'defaultAction       : %s\n' "${da:-<unreadable>}"
  printf 'lease owner         : %s\n' "${owner:-none}"
  printf 'lease holder url    : %s\n' "${holder_url:-none}"
  printf 'lease since (utc)   : %s\n' "${since:-none}"
  if _lease_is_live "$owner" "$expires"; then
    printf 'lease state         : LIVE (%ss remaining)\n' "$(( expires - $(_lease_now) ))"
  elif [ -n "$owner" ] && [ "$owner" != "none" ]; then
    printf 'lease state         : STALE (expired %ss ago)\n' "$(( $(_lease_now) - expires ))"
  else
    printf 'lease state         : free\n'
  fi
}

# --- public: sweep -----------------------------------------------------------
#
# The fail-closed janitor. Re-locks any registry found OPEN without a live
# holder. Run on a schedule (acr-firewall-sweeper.yml) so a crashed holder can
# never leave the registry publicly reachable indefinitely.

acr_lease_sweep() {
  _lease_parse_args "$@" || return $?

  local pna da owner expires holder_url
  pna="$(_lease_acr_q "publicNetworkAccess")"
  da="$(_lease_acr_q "networkRuleSet.defaultAction")"
  if [ -z "$pna" ] && [ -z "$da" ]; then
    _lease_err "could not read the firewall state of ACR '$_LEASE_ACR' — cannot sweep. Check the name, subscription, and cloud."
    return 1
  fi

  owner="$(_lease_acr_q "tags.${ACR_LEASE_TAG_OWNER}")"
  expires="$(_lease_acr_q "tags.${ACR_LEASE_TAG_EXPIRES}")"
  holder_url="$(_lease_acr_q "tags.${ACR_LEASE_TAG_URL}")"
  case "$expires" in ''|*[!0-9]*) expires=0 ;; esac

  if [ "$pna" = "Disabled" ] && [ "$da" = "Deny" ]; then
    if [ -n "$owner" ] && [ "$owner" != "none" ] && ! _lease_is_live "$owner" "$expires"; then
      _lease_log "ACR '$_LEASE_ACR' is already locked; clearing the stale lease record left by '$owner'."
      _lease_clear >/dev/null 2>&1 || true
    fi
    _lease_log "ACR '$_LEASE_ACR' is locked (publicNetworkAccess=Disabled, defaultAction=Deny) — nothing to sweep."
    return 0
  fi

  if [ "$_LEASE_FORCE" = "true" ]; then
    _lease_warn "--force: re-locking ACR '$_LEASE_ACR' regardless of the recorded lease ('${owner:-none}', $holder_url)."
    _lease_close_firewall || return 1
    _lease_clear >/dev/null 2>&1 || true
    return 0
  fi

  if _lease_is_live "$owner" "$expires"; then
    if _lease_holder_finished "$holder_url"; then
      _lease_warn "ACR '$_LEASE_ACR' is OPEN under a lease held by '$owner', but $holder_url is no longer running — the holder died without releasing. Re-locking (fail closed)."
      _lease_close_firewall || return 1
      _lease_clear >/dev/null 2>&1 || true
      return 0
    fi
    _lease_log "ACR '$_LEASE_ACR' is OPEN, legitimately leased by '$owner' ($holder_url) for another $(( expires - $(_lease_now) ))s — leaving it open."
    return 0
  fi

  _lease_err "ACR '$_LEASE_ACR' was found publicly reachable (publicNetworkAccess=${pna}, defaultAction=${da}) with NO live lease holder (recorded: '${owner:-none}', $holder_url). Re-locking now. If a build was legitimately in flight, it did not take a lease — wire that call site to scripts/csa-loom/acr-firewall-lease.sh (see docs/fiab/acr-firewall-lease.md)."
  # C24 (#3088): the sweeper is the LAST line of defence — a janitor that
  # reports success on a re-lock it never confirmed is worse than no janitor,
  # because the open registry then looks swept. Propagate the failure so the
  # scheduled run goes red and a human sees it.
  _lease_close_firewall || return 1
  _lease_clear >/dev/null 2>&1 || true
  return 0
}

# --- CLI ---------------------------------------------------------------------
# Only takes effect when executed directly; sourcing exposes the functions
# without touching the caller's shell options.

_acr_lease_usage() {
  sed -n '2,30p' "$0" >&2
  cat >&2 <<'EOF'

usage:
  acr-firewall-lease.sh acquire --acr <name> [--subscription <sub>] [--owner <id>]
  acr-firewall-lease.sh release --acr <name> [--subscription <sub>] [--owner <id>]
  acr-firewall-lease.sh status  --acr <name> [--subscription <sub>]
  acr-firewall-lease.sh sweep   --acr <name> [--subscription <sub>] [--force]
  acr-firewall-lease.sh verify  --acr <name> [--subscription <sub>]

exit codes:
  release / sweep : 0 = registry VERIFIED locked (or legitimately left open for
                    a live foreign holder); 1 = could NOT verify it locked.
  verify          : 0 = locked, 1 = state unreadable, 2 = publicly reachable.
EOF
}

# Read-only verdict, for a workflow that wants to assert posture without
# touching the lease. Prints what was observed — never a bare exit code.
_acr_lease_verify_cli() {
  _lease_parse_args "$@" || return $?
  acr_lease_verify_locked
  case $? in
    0) _lease_note "ACR '$_LEASE_ACR' is LOCKED (${_LEASE_LAST_STATE})."; return 0 ;;
    1) _lease_err "could NOT read the firewall state of ACR '$_LEASE_ACR' (${_LEASE_LAST_STATE}). This is 'unknown', not 'locked'."; return 1 ;;
    *) _lease_err "ACR '$_LEASE_ACR' is PUBLICLY REACHABLE (${_LEASE_LAST_STATE}). Re-lock: az acr update --name $_LEASE_ACR --default-action Deny --public-network-enabled false"; return 2 ;;
  esac
}

if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  set -uo pipefail
  cmd="${1:-}"; [ $# -gt 0 ] && shift
  case "$cmd" in
    acquire) acr_lease_acquire "$@" ;;
    release) acr_lease_release "$@" ;;
    status)  acr_lease_status  "$@" ;;
    sweep)   acr_lease_sweep   "$@" ;;
    verify)  _acr_lease_verify_cli "$@" ;;
    *) _acr_lease_usage; exit 2 ;;
  esac
fi
