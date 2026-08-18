#!/usr/bin/env bash
# =============================================================================
# apply-acr-compliance-tags.sh — merge-patch the compliance tags onto the Loom
# ACR, out-of-band, after the ARM apply.
# =============================================================================
#
# WHY THIS EXISTS (#3714, and #3676/#3681 before it)
#
# The Loom admin-plane ACR is the one resource in the estate whose ARM tags are
# WRITTEN BY SOMETHING OTHER THAN THE DEPLOYMENT. `acr-firewall-lease.sh`
# records the firewall-lease mutex there —
#
#     loomAcrFwOwner / loomAcrFwExpiresEpoch / loomAcrFwSinceUtc / loomAcrFwHolderUrl
#
# — because the ARM control plane stays reachable when the registry's DATA
# plane is firewalled off, which is exactly the state the lease must be read in.
#
# That makes both declarative options unusable, and both were tried and shipped
# broken:
#
#   #3676  `tags: complianceTags` on the registry resource. ARM PUTs top-level
#          tags as an ABSOLUTE REPLACE on every apply, so each deploy erased the
#          live lease. Measured landing ~8 minutes into a ~15-minute apply and
#          denying an in-flight `az acr build` push — an 8-minute outage.
#
#   #3714  a declarative `Microsoft.Resources/tags` resource that read its own
#          current value to union into. Its scope expression IS its own resource
#          id, so ARM refused the template outright:
#              InvalidTemplate → Circular dependency detected on resource:
#              …/registries/<acr>/providers/Microsoft.Resources/tags/default
#          That broke EVERY Commercial `az deployment sub create` for as long as
#          it was on main, and it is structural — a template cannot read and
#          write the same resource in one deployment.
#
# So the tags are applied HERE, with the same primitive the lease uses:
# `az tag update --operation Merge`, a server-side PATCH that ADDS keys without
# rewriting the dictionary. It cannot clobber a concurrently-held lease, and
# there is no read-then-write window on our side at all — the merge is applied
# by the resource provider.
#
# -----------------------------------------------------------------------------
# WHAT HAPPENS IF THIS IS SKIPPED
# -----------------------------------------------------------------------------
# Nothing REMOVES tags any more, so an existing registry keeps the compliance
# tags it already carries. A NEWLY created registry, however, comes up with none
# and stays untagged until a deploy runs this step. That is why every deploy
# lane calls it unconditionally after Provision, and why this script is
# fail-closed: no `|| true`, no discarded stderr, and it verifies by READING
# BACK rather than trusting the write's exit code.
#
# -----------------------------------------------------------------------------
# USAGE
# -----------------------------------------------------------------------------
#   apply-acr-compliance-tags.sh --acr <name> [--subscription <id>]
#                                (--params-file <x.bicepparam> | --tags-json <json>)
#
#   --params-file  derive the tags from a bicepparam's `complianceTags` via
#                  `az bicep build-params`. THE PREFERRED FORM: the param file
#                  is the single source of truth the ARM deployment also used,
#                  so the tags cannot drift from the template's own idea of them.
#   --tags-json    an explicit JSON object, for callers with no param file.
#
# Exit codes: 0 applied+verified · 1 usage/precondition · 2 could not resolve the
# registry · 3 the tag write failed · 4 the write reported success but the
# read-back did not confirm it.
# =============================================================================
set -uo pipefail

# Every ARM resource id here starts with `/subscriptions/…`, and MSYS/Git Bash
# rewrites a leading-slash argument into a Windows path before `az` ever sees
# it. Measured 2026-08-18 running this script from Git Bash: the id arrived
# mangled and `az tag update` answered
#     (MissingSubscription) The request did not have a subscription or a valid
#     tenant level resource provider
# which reads like an auth/context problem and is not one. CI runs Linux where
# this variable is simply ignored, so setting it is free there and makes the
# by-hand Windows path (which acr-firewall-lease.sh explicitly supports, via its
# `local:<host>` holder id) behave identically.
export MSYS_NO_PATHCONV=1

ACR_NAME=""
SUB_ID=""
PARAMS_FILE=""
TAGS_JSON=""

_err() { printf '::error::[acr-compliance-tags] %s\n' "$*" >&2; }
_note() { printf '[acr-compliance-tags] %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --acr) ACR_NAME="${2:-}"; shift 2 ;;
    --subscription) SUB_ID="${2:-}"; shift 2 ;;
    --params-file) PARAMS_FILE="${2:-}"; shift 2 ;;
    --tags-json) TAGS_JSON="${2:-}"; shift 2 ;;
    -h|--help) sed -n '1,64p' "$0"; exit 0 ;;
    *) _err "unknown argument '$1'"; exit 1 ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  _err "jq is required and was not found on PATH. This script parses ARM JSON; guessing at it with sed is how a tag value with a space gets silently truncated."
  exit 1
fi

if [ -z "$ACR_NAME" ]; then
  _err "--acr <name> is required."
  exit 1
fi
if [ -z "$PARAMS_FILE" ] && [ -z "$TAGS_JSON" ]; then
  _err "one of --params-file <x.bicepparam> or --tags-json <json> is required."
  exit 1
fi

SUB_ARG=()
if [ -n "$SUB_ID" ]; then SUB_ARG=(--subscription "$SUB_ID"); fi

# ── 1. Resolve the tags ──────────────────────────────────────────────────────
if [ -n "$PARAMS_FILE" ]; then
  if [ ! -f "$PARAMS_FILE" ]; then
    _err "--params-file '$PARAMS_FILE' does not exist."
    exit 1
  fi
  BP_OUT="$(mktemp)"; BP_ERR="$(mktemp)"
  if ! az bicep build-params --file "$PARAMS_FILE" --outfile "$BP_OUT" 2>"$BP_ERR"; then
    _err "\`az bicep build-params --file $PARAMS_FILE\` FAILED. Compliance tags could not be derived, so nothing was applied. stderr follows:"
    sed -n '1,40p' "$BP_ERR" >&2
    rm -f "$BP_OUT" "$BP_ERR"
    exit 1
  fi
  # `complianceTags` absent is a DEFECT in the param file, not an empty tag set:
  # applying nothing while reporting success is how an untagged estate reads as
  # a tagged one.
  TAGS_JSON="$(jq -c '.parameters.complianceTags.value // empty' "$BP_OUT")"
  rm -f "$BP_OUT" "$BP_ERR"
  if [ -z "$TAGS_JSON" ]; then
    _err "'$PARAMS_FILE' declares no \`complianceTags\` parameter. Refusing to apply an empty tag set — that would leave the registry untagged while this step reported success."
    exit 1
  fi
fi

# Render the JSON object into the `key=value` pairs `az tag update` takes.
# Read with `mapfile` off jq's newline-delimited output so a tag value
# containing spaces survives; word-splitting a flat tag string is how these get
# silently truncated.
#
# `tr -d '\r'` IS LOAD-BEARING, not defensive tidying. On a Windows/Git-Bash
# host jq emits CRLF, `mapfile -t` strips only the `\n`, and the surviving `\r`
# becomes part of the TAG VALUE. Measured 2026-08-18 against the live
# Commercial registry: this script wrote `Environment=Commercial\r`,
# `CSA_Loom=true\r`, `FedRAMP_Level=High\r` and `Data_Classification=Standard\r`
# — four corrupted compliance tags that LOOK correct in most output. The
# read-back check below is what caught it (`az tag update` had exited 0), which
# is precisely why that check exists and why it compares values rather than
# just asserting the keys are present.
if ! printf '%s' "$TAGS_JSON" | jq -e 'type == "object" and length > 0' >/dev/null 2>&1; then
  _err "the compliance tag set is not a non-empty JSON object (got: $TAGS_JSON). Refusing to report success having applied nothing."
  exit 1
fi
mapfile -t TAG_PAIRS < <(printf '%s' "$TAGS_JSON" | jq -r 'to_entries[] | "\(.key)=\(.value)"' | tr -d '\r')
if [ "${#TAG_PAIRS[@]}" -eq 0 ]; then
  _err "the compliance tag set rendered to zero key=value pairs. Refusing."
  exit 1
fi

_note "tags to merge: ${TAG_PAIRS[*]}"

# ── 2. Resolve the registry's ARM resource id ────────────────────────────────
# R7 — the error must state only what was established. `az acr show` failing is
# NOT the same fact as "the registry does not exist": a permission denial, an
# expired login and a wrong subscription all land here too. So the stderr is
# CAPTURED and printed rather than discarded, and the message says which of the
# two situations the output actually supports.
SHOW_ERR="$(mktemp)"
ACR_ID="$(az acr show --name "$ACR_NAME" "${SUB_ARG[@]}" --query id -o tsv 2>"$SHOW_ERR" | tr -d '\r' | head -1)"
if [ -z "$ACR_ID" ]; then
  if grep -qi "was not found\|ResourceNotFound" "$SHOW_ERR"; then
    _err "registry '$ACR_NAME' DOES NOT EXIST in this subscription, so there is nothing to tag. If the deploy was expected to create it, the deploy did not get that far."
  else
    _err "could NOT READ registry '$ACR_NAME' — this is not the same as it being absent, and the difference matters. Raw stderr:"
    sed -n '1,20p' "$SHOW_ERR" >&2
  fi
  rm -f "$SHOW_ERR"
  exit 2
fi
rm -f "$SHOW_ERR"
_note "registry resource id: $ACR_ID"

# What is on the registry BEFORE the merge — captured so the receipt can SHOW
# that an out-of-band lease survived rather than merely asserting that it did.
BEFORE="$(az tag list --resource-id "$ACR_ID" --query "properties.tags" -o json 2>/dev/null | tr -d '\r')"
_note "tags BEFORE merge: $(printf '%s' "${BEFORE:-<unreadable>}" | tr -d '\n')"

# ── 3. Merge-patch ───────────────────────────────────────────────────────────
# `--operation Merge` is the whole point: it ADDS/overwrites only the listed
# keys and leaves every other key untouched. A `Replace` here would be #3676
# again, from a different direction.
UPD_ERR="$(mktemp)"
if ! az tag update --resource-id "$ACR_ID" --operation Merge --tags "${TAG_PAIRS[@]}" -o none 2>"$UPD_ERR"; then
  _err "\`az tag update --operation Merge\` FAILED on '$ACR_NAME'. The registry is NOT compliance-tagged. If this is a permissions gap, the identity needs Microsoft.Resources/tags/write on the registry (role: Tag Contributor). Raw stderr:"
  sed -n '1,20p' "$UPD_ERR" >&2
  rm -f "$UPD_ERR"
  exit 3
fi
rm -f "$UPD_ERR"

# ── 4. VERIFY BY READING BACK ────────────────────────────────────────────────
# deploy-integrity R6: never report success on an unverified outcome. A 0 from
# `az tag update` says the request was accepted, not that the state is what was
# intended.
AFTER="$(az tag list --resource-id "$ACR_ID" --query "properties.tags" -o json 2>/dev/null | tr -d '\r')"
if [ -z "$AFTER" ]; then
  _err "the merge was accepted but the tags could NOT be read back, so this script cannot confirm the registry is tagged. Treating an unverifiable outcome as a failure."
  exit 4
fi

MISSING="$(jq -rn --argjson after "$AFTER" --argjson want "$TAGS_JSON" \
  '[$want | to_entries[] | select(($after[.key] // null) != .value) | .key] | join(",")')"
if [ -n "$MISSING" ]; then
  _err "the merge reported success but the read-back does NOT carry: $MISSING. Registry tags are now: $AFTER"
  exit 4
fi

_note "tags AFTER merge:  $(printf '%s' "$AFTER" | tr -d '\n')"

# Report explicitly on the lease keys. This is the invariant the whole design
# exists to protect, so it is MEASURED and printed, not assumed. A lease that
# was held before the merge and is absent after it is the #3676 regression.
LEASE_BEFORE="$(printf '%s' "${BEFORE:-{\}}" | jq -r '[to_entries[] | select(.key | startswith("loomAcrFw")) | .key] | sort | join(" ")')"
LEASE_AFTER="$(printf '%s' "$AFTER" | jq -r '[to_entries[] | select(.key | startswith("loomAcrFw")) | .key] | sort | join(" ")')"
_note "firewall-lease keys before: ${LEASE_BEFORE:-<none>}"
_note "firewall-lease keys after:  ${LEASE_AFTER:-<none>}"
if [ "$LEASE_BEFORE" != "$LEASE_AFTER" ]; then
  _err "the compliance-tag merge CHANGED the firewall-lease key set ('$LEASE_BEFORE' -> '$LEASE_AFTER'). That is the #3676 clobber returning; \`--operation Merge\` must never do this. Failing loudly rather than leaving a silently broken mutex."
  exit 4
fi

_note "OK — '$ACR_NAME' carries every compliance tag, verified by read-back, with the firewall lease intact."
