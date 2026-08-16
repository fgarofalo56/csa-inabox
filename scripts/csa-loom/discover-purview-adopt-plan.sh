#!/usr/bin/env bash
# discover-purview-adopt-plan.sh — find the Purview the tenant ALREADY owns and
# emit an adopt plan for it, instead of asking ARM for one more.
#
# WHY (deploy-integrity.md R5/R6, auto-bind-by-default.md §5, #3577)
# ------------------------------------------------------------------
# `deploy/bicep/gov/main.bicep` used to create a Purview account whenever the
# DMLZ was requested. Purview account quota is per-TENANT per-REGION and is 5,
# so on deploy-gov.yml run 31917112453 (gov-dev, usgovvirginia) ARM refused the
# whole deployment at preflight:
#
#   2005 - The Tenant *** with 5 resources has surpassed its resource quota 5
#          for resource type Account in usgovvirginia location.
#
# R5 forbids BOTH of the outcomes that line could produce — "Silently deploying
# a second Purview next to the customer's existing one is a violation. So is
# failing because one exists." This script is the DISCOVER / PRESENT / VALIDATE
# half; `main.bicep`'s `adopt` bag is the bind half.
#
# WHAT IT DOES
#   1. DISCOVER  — enumerate Microsoft.Purview/accounts across every subscription
#                  this identity can read (core `az resource list`, no CLI
#                  extension, no Resource Graph dependency).
#   2. PRESENT   — print every candidate with its region and what Loom uses it
#                  for, and print what Loom would CHANGE about it. The operator
#                  sees the mutation list BEFORE the deploy, not after (R5.2).
#   3. VALIDATE  — confirm the chosen account actually exists and report its real
#                  region. A cross-region binding is disclosed, never silently
#                  normalised.
#   4. ACCEPT    — `--account` (with optional --account-rg/--account-sub) is a
#                  first-class input path, not an undocumented override (R5.5).
#   5. REMEDIATE — when nothing is adoptable AND the region is at quota, exit
#                  non-zero with the classified quota remediation naming the
#                  region, the limit and the two real options (R6). Never a raw
#                  ARM stack.
#
# WHAT IT DOES NOT DO
#   - It never CREATES anything and never grants anything.
#   - It never invents a name. When it finds nothing it emits an EMPTY plan, and
#     `adoptMode()` then defaults the key to 'create' exactly as before — so a
#     greenfield tenant is completely unaffected by this script existing.
#   - It never reports an UNREADABLE scope as an empty one. A subscription it
#     could not enumerate is named as unknown, and a count taken over a subset
#     of the tenant is labelled a LOWER BOUND, because the quota it is being
#     compared against is per-tenant (deploy-integrity R7).
#
# OUTPUT: an ARM parameters envelope carrying just `adopt`, suitable for
#         `az deployment sub {what-if,create} --parameters <file>`. Emits an
#         envelope with an empty plan — never a partial or malformed document —
#         when nothing is adoptable.
#
# Usage:
#   discover-purview-adopt-plan.sh --location usgovvirginia --out adopt.json
#   discover-purview-adopt-plan.sh --location usgovvirginia --account my-purview
set -euo pipefail

LOCATION=""
OUT=""
ACCOUNT=""
ACCOUNT_RG=""
ACCOUNT_SUB=""
QUOTA=5
MODE="auto"   # auto | create

while [ $# -gt 0 ]; do
  case "$1" in
    --location)    LOCATION="${2:-}"; shift 2 ;;
    --out)         OUT="${2:-}"; shift 2 ;;
    --account)     ACCOUNT="${2:-}"; shift 2 ;;
    --account-rg)  ACCOUNT_RG="${2:-}"; shift 2 ;;
    --account-sub) ACCOUNT_SUB="${2:-}"; shift 2 ;;
    --quota)       QUOTA="${2:-5}"; shift 2 ;;
    # The explicit "no, deploy a new one" answer to R5.3's per-service question.
    # It is an ANSWER, not a bypass: it still prints what was discovered, so the
    # operator who chooses it sees what they chose against.
    --create-new)  MODE="create"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$LOCATION" ]; then
  echo "::error::--location is required. The Purview quota this script reasons about is per-tenant PER-REGION, so a region-less answer would be meaningless." >&2
  exit 2
fi

log() { echo "[purview-adopt] $*" >&2; }

# Temp files are tracked and removed on ANY exit, including the error paths that
# `exit 1` out of the middle of the script.
TMPFILES=""
newtmp() { local t; t="$(mktemp)"; TMPFILES="${TMPFILES:+$TMPFILES }$t"; printf '%s' "$t"; }
# An `if` rather than `[ -n … ] && …`: as the LAST command of an EXIT trap, a
# false test returns non-zero and would overwrite the script's real exit status.
# shellcheck disable=SC2086
cleanup() { if [ -n "$TMPFILES" ]; then rm -f $TMPFILES; fi; }
trap cleanup EXIT

if ! command -v jq >/dev/null 2>&1; then
  echo "::error::[purview-adopt] jq is not installed. It builds the adopt plan; without it this script would have to splice values into JSON by hand, which is how an account name containing a quote becomes a document that parses but does not mean what it says. Refusing to continue." >&2
  exit 1
fi

# Build the adopt plan with jq, NEVER with printf.
#
# `printf '{"name":"%s"}' "$x"` splices the value straight into a JSON document,
# so an account name containing a quote or a brace produces a document that is
# still parseable but no longer says what this script meant — a crafted
# `--account` value could inject additional keys and sail through the
# `json.load` check below, because the result IS valid JSON. `jq -n --arg`
# escapes every value as a JSON string, which is the only way the document can
# be trusted to mean what it looks like.
plan_json() { # plan_json <name> <rg> <sub>
  jq -cn --arg name "$1" --arg rg "$2" --arg sub "$3" \
    '{purview: {mode: "adopt", target: {name: $name, rg: $rg, sub: $sub}}}'
}

# Emit the envelope and exit 0. Every success path goes through here so a
# malformed document cannot escape: the JSON is parsed before it is written, and
# a parse failure is a hard failure rather than a plan the deploy chokes on.
emit() {
  local plan="$1"
  local envelope
  envelope="$(printf '{"$schema":"https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#","contentVersion":"1.0.0.0","parameters":{"adopt":{"value":%s}}}' "$plan")"

  if command -v python >/dev/null 2>&1; then
    if ! printf '%s' "$envelope" | python -c 'import json,sys; json.load(sys.stdin)' >/dev/null 2>&1; then
      echo "::error::[purview-adopt] built a document that is not valid JSON — refusing to write it. A malformed plan would fail the deploy inside template evaluation, where the cause is much harder to read." >&2
      printf '%s\n' "$envelope" >&2
      exit 1
    fi
  else
    log "python not found — the emitted envelope was NOT syntax-checked before writing. It is machine-built, but that check did not run."
  fi

  if [ -n "$OUT" ]; then
    printf '%s\n' "$envelope" > "$OUT"
    log "wrote adopt plan to $OUT"
  else
    printf '%s\n' "$envelope"
  fi
  exit 0
}

# What Loom does to an adopted Purview. Kept verbatim in step with the
# `mutations` array of the `purview` entry in
# apps/fiab-console/lib/deploy/adoption-catalog.ts — the operator must be able
# to read this BEFORE the deploy, on whichever surface they are using.
present_mutations() {
  cat >&2 <<'EOF'
[purview-adopt]   Loom uses it for: the data catalog, classification, lineage and the sensitivity-label sweep.
[purview-adopt]   Loom would CHANGE the following on it (data plane, applied post-deploy):
[purview-adopt]     - registers Loom lake, Synapse and Databricks sources as Purview data sources
[purview-adopt]     - creates a Loom collection under the root collection
[purview-adopt]     - creates and runs scan definitions against those sources
[purview-adopt]     - writes glossary terms and classification rules
[purview-adopt]   It does NOT change the account's own control-plane configuration.
EOF
}

# ---------------------------------------------------------------------------
# Enumerate the subscriptions this identity can actually read.
# ---------------------------------------------------------------------------
SUBS_ERR="$(newtmp)"
if ! SUBS_RAW="$(az account list --all --query "[?state=='Enabled'].id" -o tsv 2>"$SUBS_ERR")"; then
  echo "::error::[purview-adopt] could NOT list subscriptions, so what this tenant already owns is UNKNOWN — not 'nothing'. Adoption cannot be decided from here. az said:" >&2
  sed 's/^/  /' "$SUBS_ERR" >&2 || true
  exit 1
fi
# `az -o tsv` carries a CR on Windows-authored pipelines and inside some runner
# images; an unstripped CR makes every later comparison silently fail to match.
SUBS="$(printf '%s' "$SUBS_RAW" | tr -d '\r' | sed '/^$/d')"
SUB_COUNT="$(printf '%s\n' "$SUBS" | sed '/^$/d' | wc -l | tr -d ' ')"

if [ "$SUB_COUNT" -eq 0 ]; then
  echo "::error::[purview-adopt] this identity can read ZERO subscriptions. That is a permission problem, not an empty tenant — grant it at least Reader on the subscriptions that may hold a Purview account." >&2
  exit 1
fi
log "reading $SUB_COUNT subscription(s) this identity can see"

# ---------------------------------------------------------------------------
# DISCOVER. One row per account: name<TAB>rg<TAB>location<TAB>subscription
# ---------------------------------------------------------------------------
FOUND="$(newtmp)"
UNREADABLE=0
UNREADABLE_SUBS=""
for sub in $SUBS; do
  ERR="$(newtmp)"
  # A multiselect LIST `[name,resourceGroup,location]`, not a hash. `az -o tsv`
  # emits a multiselect HASH's columns in alphabetical key order rather than the
  # order they were written, so `{name:name,rg:resourceGroup,loc:location}`
  # would arrive as loc/name/rg and every field below would be silently wrong.
  # A list projection is positional and cannot be reordered.
  if ! ROWS="$(az resource list --subscription "$sub" \
        --resource-type Microsoft.Purview/accounts \
        --query "[].[name,resourceGroup,location]" -o tsv 2>"$ERR")"; then
    # An unreadable subscription is UNKNOWN, not empty. Recording it is what
    # keeps the quota arithmetic below honest.
    UNREADABLE=$((UNREADABLE + 1))
    UNREADABLE_SUBS="${UNREADABLE_SUBS:+$UNREADABLE_SUBS }$sub"
    log "could NOT enumerate Purview accounts in subscription $sub — treating as UNKNOWN, not as zero. az said: $(tr -d '\r' < "$ERR" | head -1)"
    continue
  fi
  # `printf '%s\n'`, NOT `printf '%s'`. Command substitution strips the trailing
  # newline, so `printf '%s'` hands `read` a final line with no terminator —
  # `read` assigns it and then returns non-zero, so the loop body never runs for
  # it and the LAST account of every subscription is silently dropped. Measured
  # while building this script: a single-candidate subscription discovered
  # nothing at all, and a five-candidate one silently became four. An empty
  # $ROWS becomes one blank line here, which `sed '/^$/d'` removes.
  printf '%s\n' "$ROWS" | tr -d '\r' | sed '/^$/d' | while IFS=$'\t' read -r n rg loc; do
    [ -n "$n" ] || continue
    printf '%s\t%s\t%s\t%s\n' "$n" "$rg" "$loc" "$sub"
  done >> "$FOUND"
done

# Deterministic ordering. Two runs over the same estate must choose the same
# account: an adoption that depends on ARM's list order is a binding that can
# silently move between deploys.
sort -o "$FOUND" "$FOUND"

TOTAL="$(wc -l < "$FOUND" | tr -d ' ')"
IN_REGION="$(awk -F'\t' -v loc="$LOCATION" 'tolower($3)==tolower(loc)' "$FOUND" | wc -l | tr -d ' ')"

log "discovered $TOTAL Purview account(s) in the readable scope; $IN_REGION of them in $LOCATION"
if [ "$TOTAL" -gt 0 ]; then
  log "candidates:"
  while IFS=$'\t' read -r n rg loc sub; do
    log "  - $n  (rg=$rg, region=$loc, sub=$sub)"
  done < "$FOUND"
  present_mutations
fi

# ---------------------------------------------------------------------------
# 4. ACCEPT SUPPLIED — an explicitly named account wins over discovery.
# ---------------------------------------------------------------------------
if [ -n "$ACCOUNT" ]; then
  log "an account was supplied explicitly: '$ACCOUNT' — validating it before binding"
  MATCH="$(awk -F'\t' -v n="$ACCOUNT" '$1==n' "$FOUND" | head -1)"

  if [ -z "$MATCH" ]; then
    if [ -n "$ACCOUNT_RG" ]; then
      # Supplied WITH coordinates and not seen by discovery. That is not proof
      # it is absent — it may live in a subscription this identity cannot
      # enumerate. Bind it and let the template's `existing` read be the
      # authority, but say plainly that this was not verified here.
      log "'$ACCOUNT' was not visible to discovery, but --account-rg was supplied, so it will be bound on the operator's word. It was NOT validated by this script: if it does not exist, the deployment fails at the template's existing-resource read."
      emit "$(plan_json "$ACCOUNT" "$ACCOUNT_RG" "${ACCOUNT_SUB:-}")"
    fi
    echo "::error::[purview-adopt] the supplied Purview account '$ACCOUNT' was not found in any subscription this identity can read, and no --account-rg was given to bind it blind." >&2
    echo "::error::  Remediation: re-run with --account-rg <resource-group> (and --account-sub <id> if it lives in another subscription), or omit --account and let discovery choose. Accounts seen: ${TOTAL}." >&2
    exit 1
  fi

  A_NAME="$(printf '%s' "$MATCH" | cut -f1)"
  A_RG="$(printf '%s' "$MATCH" | cut -f2)"
  A_LOC="$(printf '%s' "$MATCH" | cut -f3)"
  A_SUB="$(printf '%s' "$MATCH" | cut -f4)"
  # Coordinates supplied by the operator override what discovery saw, so a
  # same-named account in a different RG can still be targeted deliberately.
  A_RG="${ACCOUNT_RG:-$A_RG}"
  A_SUB="${ACCOUNT_SUB:-$A_SUB}"

  if [ "$(printf '%s' "$A_LOC" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$LOCATION" | tr '[:upper:]' '[:lower:]')" ]; then
    # Not fatal, and deliberately so: Purview's Data Map is reached by account
    # host, so a cross-region binding works. It is disclosed, not blocked.
    log "NOTE: '$A_NAME' is in '$A_LOC' but this deployment targets '$LOCATION'. Cross-region adoption is supported — the Data Map is reached by account host — but scans of in-region sources will cross regions. Binding it."
  fi

  log "VALIDATED: binding '$A_NAME' (rg=$A_RG, region=$A_LOC, sub=$A_SUB)"
  emit "$(plan_json "$A_NAME" "$A_RG" "$A_SUB")"
fi

# ---------------------------------------------------------------------------
# AUTO. Prefer an in-region account; fall back to a cross-region one.
#
# Skipped entirely when --create-new was given: that is the operator's explicit
# answer to R5.3's "use the existing one, or deploy new?" and it is honoured.
# It still falls through to the quota check below, because an answer that cannot
# possibly succeed is worth saying so BEFORE a three-minute ARM refusal.
# ---------------------------------------------------------------------------
if [ "$MODE" = "create" ]; then
  log "--create-new was given: a NEW account will be requested, and the accounts listed above will not be touched."
else
  CHOSEN="$(awk -F'\t' -v loc="$LOCATION" 'tolower($3)==tolower(loc)' "$FOUND" | head -1)"
  CHOSEN_WHY="the first account in $LOCATION, by name"
  if [ -z "$CHOSEN" ] && [ "$TOTAL" -gt 0 ]; then
    CHOSEN="$(head -1 "$FOUND")"
    CHOSEN_WHY="no account exists in $LOCATION, so the first account in any readable region, by name"
  fi

  if [ -n "$CHOSEN" ]; then
    A_NAME="$(printf '%s' "$CHOSEN" | cut -f1)"
    A_RG="$(printf '%s' "$CHOSEN" | cut -f2)"
    A_LOC="$(printf '%s' "$CHOSEN" | cut -f3)"
    A_SUB="$(printf '%s' "$CHOSEN" | cut -f4)"
    log "ADOPTING '$A_NAME' (rg=$A_RG, region=$A_LOC, sub=$A_SUB) — chosen because it is $CHOSEN_WHY."
    log "  To bind a different one:  --account <name> [--account-rg <rg>] [--account-sub <id>]"
    log "  To deploy a new one:      --create-new"
    emit "$(plan_json "$A_NAME" "$A_RG" "$A_SUB")"
  fi
fi

# ---------------------------------------------------------------------------
# 5. ABOUT TO CREATE. Is there actually room?
# ---------------------------------------------------------------------------
# Reached two ways, and the check has to cover BOTH or it covers neither:
#
#   - --create-new, with the region already full. This is the branch that has a
#     population: discovery CAN see 5 in-region accounts here, because it did
#     not consume them by adopting one.
#   - auto, having found nothing adoptable.
#
# An earlier draft put this check only after the auto path. That made it dead
# code — reaching it required TOTAL == 0, which forces IN_REGION == 0, so the
# condition could never be true. A branch with no population is not a control
# (guard_with_zero_population_needs_embedded_control); it is a comment that
# looks like one.
#
# The quota is per-TENANT. `IN_REGION` was counted over the subscriptions this
# identity can read, so whenever any scope was unreadable it is a LOWER BOUND on
# the tenant's true usage. Each branch below says which of the two it has.
if [ "$IN_REGION" -ge "$QUOTA" ]; then
  cat >&2 <<EOF
::error::[purview-adopt] QUOTA/CAPACITY — a new Purview account cannot be created in $LOCATION.
::error::  Observed: $IN_REGION Microsoft.Purview/accounts already exist in $LOCATION. The limit is per-TENANT per-REGION and is $QUOTA.
::error::  Retrying will not help; this is not a transient failure. There are exactly two real options:
::error::    1. ADOPT one of the accounts listed above — drop --create-new to let discovery bind one, or name it with --account <name>.
::error::    2. RAISE the quota, or deploy the DMLZ into a different region: Azure Government portal > Help + support > New support
::error::       request > Service and subscription limits (quotas) > Microsoft Purview, for region $LOCATION.
::error::  Deploying with deployDMLZ=false is a third option only if you do not want a Data Map at all — it disables the catalog.
EOF
  exit 1
fi

if [ "$UNREADABLE" -gt 0 ]; then
  log "about to CREATE, and $UNREADABLE subscription(s) could not be enumerated ($UNREADABLE_SUBS)."
  log "The $IN_REGION account(s) counted in $LOCATION are therefore a LOWER BOUND on the tenant's usage, not the tenant total, and the quota is per-tenant. Whether there is room is UNKNOWN."
  log "Proceeding. If the tenant is in fact at its limit of $QUOTA, ARM will refuse this at preflight — that refusal classifies as quota (not as a Loom defect) and carries this same remediation."
else
  log "no Purview account exists in $LOCATION across the $SUB_COUNT subscription(s) read, and the limit is $QUOTA — there is room. Proceeding to CREATE (greenfield)."
fi
emit '{}'
