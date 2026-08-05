#!/usr/bin/env bash
# CSA Loom — Bring-Your-Own (BYO) bicepparam generator / wizard.
#
# WHAT IT DOES
#   For a one-button deploy, lets you choose EXISTING vs NEW (vs honest-gate) for
#   every reusable Azure service. It scans every subscription the signed-in
#   principal can see (reuse-first), prompts per service, and emits TWO artifacts:
#     1. platform/fiab/bicep/params/<name>.generated.bicepparam — a drop-in for
#        `az deployment sub create -p ...` (the redeploy-gov.sh Phase-2 argument),
#        with existing<Svc>{Name,Rg,Sub} set literally for every reuse pick.
#     2. temp/<name>.byo-exports.sh — canonical EXISTING_* exports consumed by
#        scripts/csa-loom/{grant-navigator-rbac,patch-navigator-env}.sh AND by
#        any boundary .bicepparam (readEnvironmentVariable). Source it, then deploy.
#
#   The generated bicepparam is produced by regenerating the block between the
#   `// >>> BYO-WIZARD START` / `// <<< BYO-WIZARD END` markers in the chosen
#   boundary template — so the rest of the boundary's parameters are preserved
#   verbatim and only the BYO surface changes.
#
# NO MICROSOFT FABRIC DEPENDENCY (no-fabric-dependency.md)
#   fabricEnabled defaults FALSE (Azure-native). The wizard only offers Fabric on
#   Commercial boundaries when BYO_FABRIC=true is set explicitly; gov boundaries
#   are always fabricEnabled=false.
#
# CROSS-SUB (…Sub)
#   Every reuse pick captures name+RG+SUB, so cross-sub reuse (e.g. a shared
#   governance-sub Purview) is a first-class deploy-time input, not a post-deploy
#   patch. The …Sub values flow into LOOM_<SVC>_SUB Console env vars + the RBAC
#   script. They are pure string pass-throughs (NOT Bicep `existing` cross-sub
#   references); post-deploy RBAC is granted by grant-navigator-rbac.sh.
#
# USAGE
#   bash scripts/csa-loom/byo-wizard.sh                          # interactive, commercial-full
#   bash scripts/csa-loom/byo-wizard.sh --boundary gcc-high
#   bash scripts/csa-loom/byo-wizard.sh --boundary commercial --out my-deploy
#   # non-interactive (CI / 1-button): drive every choice via env
#   BYO_NONINTERACTIVE=1 \
#     BYO_PURVIEW='reuse:dmlz-dev-purview-eastus:rg-dmlz-dev-governance-eastus:e093f4fd-...' \
#     BYO_APIM='reuse:dml-ai-east-aigateway:rg-dlz-aiml-stack-dev:363ef5d1-...' \
#     BYO_AISEARCH=new BYO_ADX=gate \
#     bash scripts/csa-loom/byo-wizard.sh --boundary commercial-full --non-interactive
#   Each BYO_<KEY> = 'reuse:<name>[:<rg>[:<sub>]]' | 'new' | 'gate' (default 'gate'
#   when not discovered; default 'reuse:<first-candidate>' offered interactively).
#
# REQUIRES: az CLI logged in (`az login`). Read-only enumeration — nothing is
#           created or modified by this script.
set -uo pipefail

# ---------------------------------------------------------------------------
# Resolve repo paths (works from any cwd).
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BICEP_DIR="$REPO_ROOT/platform/fiab/bicep"
PARAMS_DIR="$BICEP_DIR/params"
TEMP_DIR="$REPO_ROOT/temp"

BOUNDARY="commercial-full"
OUT_NAME=""
NONINTERACTIVE="${BYO_NONINTERACTIVE:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --boundary) BOUNDARY="$2"; shift 2 ;;
    --out)      OUT_NAME="$2"; shift 2 ;;
    --non-interactive|--ci) NONINTERACTIVE=1; shift ;;
    -h|--help)
      sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

TEMPLATE="$PARAMS_DIR/$BOUNDARY.bicepparam"
[[ -f "$TEMPLATE" ]] || { echo "ERROR: boundary template not found: $TEMPLATE" >&2; echo "Available: $(ls "$PARAMS_DIR"/*.bicepparam 2>/dev/null | xargs -n1 basename | sed 's/\.bicepparam//' | tr '\n' ' ')" >&2; exit 1; }
grep -q '>>> BYO-WIZARD START' "$TEMPLATE" || { echo "ERROR: template $TEMPLATE has no BYO-WIZARD markers — add them first." >&2; exit 1; }

[[ -z "$OUT_NAME" ]] && OUT_NAME="$BOUNDARY.generated"
OUT_PARAM="$PARAMS_DIR/$OUT_NAME.bicepparam"
mkdir -p "$TEMP_DIR"
OUT_ENV="$TEMP_DIR/$OUT_NAME.byo-exports.sh"

# Gov boundaries never offer Fabric (no Fabric in Azure Government).
case "$BOUNDARY" in
  gcc-high|il5|gcc) IS_GOV=1 ;;
  *) IS_GOV=0 ;;
esac

echo "== CSA Loom — Bring-Your-Own wizard =="
echo "   boundary=$BOUNDARY  template=$(basename "$TEMPLATE")  out=params/$OUT_NAME.bicepparam"
echo "   mode=$([[ "$NONINTERACTIVE" == "1" ]] && echo non-interactive || echo interactive)  gov=$IS_GOV"
echo

SUBS="${SUBS:-$(az account list --query "[].id" -o tsv 2>/dev/null)}"
if [[ -z "$SUBS" ]]; then
  echo "WARNING: no subscriptions visible (run 'az login'). Discovery skipped — every service defaults to gate/new." >&2
fi
HAVE_GRAPH=0
[[ -n "$SUBS" ]] && az graph query -q "Resources | limit 1" -o none 2>/dev/null && HAVE_GRAPH=1

q() { az "$@" 2>/dev/null || true; }

# discover <arm-type> [<extra-jmespath-filter>] -> prints "name|rg|sub" per candidate
discover() {
  local type="$1" filt="${2:-}"
  [[ -z "$SUBS" ]] && return 0
  if [[ "$HAVE_GRAPH" == "1" ]]; then
    local where="type =~ '$type'"
    [[ -n "$filt" ]] && where="$where and $filt"
    # NOTE: `az graph query -o tsv` flattens the RESULT WRAPPER (count/skip_token),
    # not the rows — extract the data array explicitly with --query.
    q graph query -q "Resources | where $where | project name, resourceGroup, subscriptionId" --first 100 \
        --query "data[].[name,resourceGroup,subscriptionId]" -o tsv \
      | awk -F'\t' 'NF>=3 && $1!="" {print $1"|"$2"|"$3}'
  else
    local s
    for s in $SUBS; do
      q resource list --subscription "$s" --resource-type "$type" --query "[].{n:name,r:resourceGroup}" -o tsv \
        | awk -F'\t' -v sub="$s" 'NF>=2 && $1!="" {print $1"|"$2"|"sub}'
    done
  fi
}

# ---------------------------------------------------------------------------
# Service table. Columns (|-separated):
#   key | label | arm-type | graph-filter | (unused) | (unused) | (unused)
#       | env-name | env-rg | env-sub | enabled-flag
# The three (unused) columns held the main.bicep `existing<Svc>{Name,Rg,Sub}`
# param names. main.bicep no longer declares them — it declares ONE `adopt`
# object bag keyed by the `key` column (ARM's 256-parameter cap), so the emitter
# builds an adopt entry from `key` instead. The columns are kept EMPTY rather
# than removed because this table is parsed positionally.
# The env-name/env-rg/env-sub are the CANONICAL EXISTING_* vars — they match the
# bicepparam readEnvironmentVariable() names AND discover-services.sh /
# patch-navigator-env.sh, so all consumers agree (fixes the §1.4 var-name drift).
# enabled-flag is '' for DLZ-provisioned services (no provisioning toggle).
# ---------------------------------------------------------------------------
SERVICES=(
  "aisearch|AI Search|Microsoft.Search/searchServices|||||EXISTING_AI_SEARCH_SERVICE|EXISTING_AI_SEARCH_RG|EXISTING_AI_SEARCH_SUB|aiSearchEnabled"
  "apim|API Management|Microsoft.ApiManagement/service|||||EXISTING_APIM|EXISTING_APIM_RG|EXISTING_APIM_SUB|apimEnabled"
  "maps|Azure Maps|Microsoft.Maps/accounts|||||EXISTING_AZURE_MAPS_ACCOUNT|EXISTING_AZURE_MAPS_RG|EXISTING_AZURE_MAPS_SUB|loomMapsEnabled"
  "adx|ADX / Kusto|Microsoft.Kusto/clusters|||||EXISTING_KUSTO_CLUSTER|EXISTING_KUSTO_RG|EXISTING_KUSTO_SUB|adxEnabled"
  "foundry|AI Foundry / AOAI|Microsoft.CognitiveServices/accounts|kind =~ 'AIServices'||||EXISTING_AOAI|EXISTING_AOAI_RG|EXISTING_AOAI_SUB|agentFoundryEnabled"
  "purview|Microsoft Purview|Microsoft.Purview/accounts|||||EXISTING_PURVIEW|EXISTING_PURVIEW_RG|EXISTING_PURVIEW_SUB|purviewEnabled"
  "synapse|Synapse|Microsoft.Synapse/workspaces|||||EXISTING_SYNAPSE|EXISTING_SYNAPSE_RG|EXISTING_SYNAPSE_SUB|"
  "cosmos|Cosmos DB|Microsoft.DocumentDB/databaseAccounts|||||EXISTING_COSMOS_ACCOUNT|EXISTING_COSMOS_ACCOUNT_RG|EXISTING_COSMOS_ACCOUNT_SUB|"
  "adf|Data Factory|Microsoft.DataFactory/factories|||||EXISTING_ADF|EXISTING_ADF_RG|EXISTING_ADF_SUB|"
  "eventhubs|Event Hubs|Microsoft.EventHub/namespaces|||||EXISTING_EVENTHUB_NAMESPACE|EXISTING_EVENTHUB_RG|EXISTING_EVENTHUB_SUB|loomEventHubEnabled"
  "streamanalytics|Stream Analytics|Microsoft.StreamAnalytics/streamingjobs|||||EXISTING_ASA_JOB|EXISTING_ASA_RG|EXISTING_ASA_SUB|loomStreamAnalyticsEnabled"
  "databricks|Databricks|Microsoft.Databricks/workspaces|||||EXISTING_DATABRICKS|EXISTING_DATABRICKS_RG|EXISTING_DATABRICKS_SUB|"
)

# Accumulators
declare -A NAME RG SUB HOST
declare -a BLOCK_LINES ENV_LINES SUMMARY
# `set -u` + `${#arr[@]}` on a DECLARED-BUT-EMPTY array is fatal in bash, which
# is how the first cut of this emitted a params file with no `param adopt` line
# at all. Initialise to a real empty array and count separately.
declare -a ADOPT_ENTRIES=()
ADOPT_COUNT=0
# AOAI/Foundry reused-account deployment names (resolved in the loop below).
FOUNDRY_CHAT=""; FOUNDRY_EMBED=""; FOUNDRY_MINI=""; FOUNDRY_STRONG=""; FOUNDRY_CHOICE="new"

upper() { echo "$1" | tr '[:lower:]' '[:upper:]'; }

# pick_by_rank <name\tmodel TSV> <model-regex>... -> the deployment NAME whose
# MODEL matches the EARLIEST-listed regex (case-insensitive), else empty.
# Ranked rather than first-match-wins because an account's deployment order is
# arbitrary: `dml-ai-eastus-sandbox` lists grok-3 and DeepSeek-R1 before gpt-5,
# so "first line matching /gpt/" is not the best chat model, it is a coin flip.
pick_by_rank() {
  local tsv="$1"; shift
  local re hit
  for re in "$@"; do
    hit="$(awk -F'\t' -v re="$re" 'NF>=2 && tolower($2) ~ re {print $1; exit}' <<<"$tsv")"
    if [[ -n "$hit" ]]; then printf '%s' "$hit"; return 0; fi
  done
  return 0
}

resolve_databricks_host() {  # name rg sub -> workspaceUrl
  local n="$1" r="$2" s="$3"
  [[ -z "$n" || -z "$r" ]] && return 0
  local args=(databricks workspace show -n "$n" -g "$r" --query workspaceUrl -o tsv)
  [[ -n "$s" ]] && args+=(--subscription "$s")
  q "${args[@]}"
}

for row in "${SERVICES[@]}"; do
  IFS='|' read -r key label type filt nameP rgP subP envName envRg envSub flag <<<"$row"
  echo "── $label ──────────────────────────────────────────────"
  mapfile -t cands < <(discover "$type" "$filt")
  envKey="BYO_$(upper "$key")"
  choice=""

  if [[ "$NONINTERACTIVE" == "1" ]]; then
    choice="${!envKey:-}"
    if [[ -z "$choice" ]]; then
      # No explicit BYO_<KEY>: do NOT silently reuse a discovered resource.
      # DLZ services (no enabled-flag) provision new with the platform; the
      # flagged admin-plane services default to an honest gate until chosen —
      # EXCEPT AOAI/Foundry, which is deploy-readiness opt-out (everything-ON):
      # a fresh deploy must have a working gpt-4o model on first login, so the
      # default is provision-NEW (set BYO_FOUNDRY=gate to opt out).
      if [[ -z "$flag" ]]; then choice="new"
      elif [[ "$key" == "foundry" ]]; then choice="new"
      else choice="gate"; fi
    fi
  else
    if [[ ${#cands[@]} -gt 0 ]]; then
      echo "  Found ${#cands[@]} existing candidate(s):"
      i=1; for c in "${cands[@]}"; do IFS='|' read -r cn cr cs <<<"$c"; echo "    [$i] $cn   (rg=$cr sub=$cs)"; i=$((i+1)); done
      echo "    [n] provision NEW    [g] honest-gate (leave unconfigured)"
      read -r -p "  Choose 1-${#cands[@]} / n / g [default 1=reuse]: " ans </dev/tty || ans=""
      ans="${ans:-1}"
      case "$ans" in
        n|N) choice="new" ;;
        g|G) choice="gate" ;;
        ''|*[!0-9]*) choice="gate" ;;
        *) idx=$((ans-1)); if [[ $idx -ge 0 && $idx -lt ${#cands[@]} ]]; then c="${cands[$idx]}"; choice="reuse:${c//|/:}"; else choice="gate"; fi ;;
      esac
    else
      echo "  (no existing candidate found)"
      if [[ -n "$flag" ]]; then
        read -r -p "  provision NEW or honest-gate? [N/g]: " ans </dev/tty || ans="N"
        [[ "$ans" =~ ^[gG] ]] && choice="gate" || choice="new"
      else
        echo "  DLZ-provisioned by default (a new instance deploys with the platform)."
        choice="new"
      fi
    fi
  fi

  # Parse the choice into name/rg/sub.
  n=""; r=""; s=""
  case "$choice" in
    reuse:*)
      IFS=':' read -r _ n r s <<<"$choice"
      ;;
    new)  : ;;   # leave existing* empty; *Enabled flag (if any) governs provisioning
    gate) : ;;   # leave existing* empty; honest gate
    *)    echo "  (unrecognized choice '$choice' — treating as gate)"; choice="gate" ;;
  esac

  NAME[$key]="$n"; RG[$key]="$r"; SUB[$key]="$s"
  if [[ "$key" == "databricks" && -n "$n" ]]; then
    HOST[$key]="$(resolve_databricks_host "$n" "$r" "$s")"
    [[ -z "${HOST[$key]}" ]] && echo "  (could not resolve workspaceUrl for $n — set EXISTING_DATABRICKS_HOSTNAME manually)"
  fi
  # AOAI/Foundry — when REUSING an existing account, discover the deployments the
  # Console env needs (LOOM_AOAI_DEPLOYMENT/_CHAT_DEPLOYMENT/_EMBED_DEPLOYMENT and
  # the model-tier pair LOOM_AOAI_MINI_DEPLOYMENT/_STRONG_DEPLOYMENT), not just
  # the account name. Recommend reuse when chat+embed already exist (avoids
  # duplicate model cost); otherwise the operator should provision-new.
  if [[ "$key" == "foundry" && -n "$n" ]]; then
    dargs=(cognitiveservices account deployment list -n "$n" -g "$r")
    [[ -n "$s" ]] && dargs+=(--subscription "$s")
    deploys="$(q "${dargs[@]}" --query "[].{name:name,model:properties.model.name}" -o tsv 2>/dev/null || true)"
    if [[ -z "$deploys" ]]; then
      echo "  ! could not read the deployment list on $n (not signed in, no Cognitive Services Reader, or the account is empty)."
      echo "    Set BYO_FOUNDRY_CHAT / BYO_FOUNDRY_EMBED / BYO_FOUNDRY_MINI / BYO_FOUNDRY_STRONG to name them explicitly."
    fi
    # Never guess a chat deployment out of an image/audio/embedding slot.
    CHAT_POOL="$(awk -F'\t' 'NF>=2 && tolower($2) !~ /image|dall-e|sora|whisper|tts|embedding|flux|video|speech|moderation|rerank/ {print}' <<<"$deploys")"
    # Chat/default tier: newest general chat model first; mini/nano only as a last
    # resort. The pre-2026 list ('gpt-4o|gpt-4.1|gpt-4|gpt-35') matched NOTHING on
    # a modern account (measured 2026-08-05 against alz-ai-services-westus, whose
    # only chat slots are gpt-5.4-mini / gpt-5.4-nano / o3-deep-research), which is
    # how a reuse pick emitted chatDeployment:'' and blanked LOOM_AOAI_*.
    CHAT_MAIN="$(awk -F'\t' 'tolower($2) !~ /mini|nano/ {print}' <<<"$CHAT_POOL")"
    CHAT_RANK=('gpt-5[.]6' 'gpt-5[.]5' 'gpt-5[.]4' 'gpt-5[.]3' 'gpt-5[.]2' 'gpt-5[.]1' 'gpt-5' 'gpt-chat-latest' 'gpt-4[.]1' 'gpt-4o' 'gpt-4' 'gpt-35|gpt-3[.]5' 'model-router' 'gpt-')
    FOUNDRY_CHAT="$(pick_by_rank "$CHAT_MAIN" "${CHAT_RANK[@]}")"
    [[ -z "$FOUNDRY_CHAT" ]] && FOUNDRY_CHAT="$(pick_by_rank "$CHAT_POOL" "${CHAT_RANK[@]}")"
    # Mini tier: an explicitly small model. Empty is fine — admin-plane falls the
    # tier back to the chat deployment rather than to ''.
    FOUNDRY_MINI="$(pick_by_rank "$CHAT_POOL" 'gpt-5[.]6-mini' 'gpt-5[.]4-mini' 'gpt-5-mini' 'gpt-4[.]1-mini' 'gpt-4o-mini' 'mini' 'nano' 'gpt-35-turbo')"
    # Strong tier: a reasoning-capable model. The o-series and the gpt-5 flagship
    # outrank a generic *reasoning* substring — otherwise a small Phi-4-reasoning
    # slot beats o1 on an account that has both (measured on dml-ai-eastus-sandbox).
    FOUNDRY_STRONG="$(pick_by_rank "$CHAT_MAIN" '(^|[^a-z0-9])o3([^a-z0-9]|$)' '(^|[^a-z0-9])o1([^a-z0-9]|$)' '(^|[^a-z0-9])o4([^a-z0-9]|$)' 'gpt-5[.]6' 'gpt-5[.]5' 'gpt-5[.]4' 'gpt-5[.]2' 'gpt-5[.]1' 'gpt-5' 'deepseek-r1' 'reasoning' 'deep-research' 'gpt-4[.]1' 'gpt-4o')"
    FOUNDRY_EMBED="$(pick_by_rank "$deploys" 'text-embedding-3-large' 'text-embedding-3-small' 'text-embedding-ada' 'embedding')"
    # Explicit operator input always wins over discovery (and is the supported
    # path when the wizard cannot read the account, e.g. an unattended CI run).
    FOUNDRY_CHAT="${BYO_FOUNDRY_CHAT:-$FOUNDRY_CHAT}"
    FOUNDRY_EMBED="${BYO_FOUNDRY_EMBED:-$FOUNDRY_EMBED}"
    FOUNDRY_MINI="${BYO_FOUNDRY_MINI:-$FOUNDRY_MINI}"
    FOUNDRY_STRONG="${BYO_FOUNDRY_STRONG:-$FOUNDRY_STRONG}"
    if [[ -n "$FOUNDRY_CHAT" && -n "$FOUNDRY_EMBED" ]]; then
      echo "  ✓ reuse recommended: found chat='$FOUNDRY_CHAT' + embed='$FOUNDRY_EMBED' on $n"
    elif [[ -n "$FOUNDRY_CHAT" ]]; then
      echo "  ~ chat='$FOUNDRY_CHAT' found but no embeddings deployment — add one, or provision-new."
    else
      echo "  ! no chat-capable deployment resolved on $n — LOOM_AOAI_CHAT_DEPLOYMENT would be EMPTY."
      echo "    Set BYO_FOUNDRY_CHAT='<deployment name>' or provision-NEW (BYO_FOUNDRY=new) instead of reuse."
    fi
    echo "    model tiers: mini='${FOUNDRY_MINI:-(falls back to chat)}' strong='${FOUNDRY_STRONG:-(falls back to chat)}'"
  fi
  # Track the AOAI/Foundry choice so the emitted bicepparam sets the opt-out
  # flag explicitly (new/reuse → agentFoundryEnabled stays the bicepparam default
  # true; gate → false so a fresh deploy honestly skips AOAI).
  [[ "$key" == "foundry" ]] && FOUNDRY_CHOICE="$choice"

  # Build the literal bicepparam lines for this service.
  #
  # main.bicep NO LONGER DECLARES the 36 `existing*` scalars — it declares ONE
  # `adopt` object bag (ARM caps a template at 256 params and main.bicep was at
  # 251/256, so a name/rg/sub triple could not be added for even one more
  # service). Emitting `param existingPurviewAccount = '…'` against the current
  # template is a hard BCP259: "assigned in the params file without being
  # declared in the Bicep file" — it does not deploy, it does not compile.
  #
  # So an ADOPT decision contributes one entry to the adopt bag, keyed by the
  # SAME service key as apps/fiab-console/lib/deploy/adoption-catalog.ts. A
  # `new` or `gate` choice contributes NOTHING: `adoptMode()` defaults an absent
  # key to 'create', so a pure-greenfield run must not emit an empty entry — an
  # empty `param adopt = {}` is harmless but an empty per-service scalar was the
  # thing that broke greenfield.
  if [[ -n "$n" ]]; then
    entry="  ${key}: { mode: 'adopt', target: { name: '${n}', rg: '${r}', sub: '${s}' }"
    if [[ "$key" == "databricks" && -n "${HOST[$key]:-}" ]]; then
      entry+=", extra: { hostname: '${HOST[$key]}' }"
    fi
    if [[ "$key" == "foundry" ]]; then
      entry+=", extra: { chatDeployment: '${FOUNDRY_CHAT}', embedDeployment: '${FOUNDRY_EMBED}', miniDeployment: '${FOUNDRY_MINI}', strongDeployment: '${FOUNDRY_STRONG}' }"
    fi
    entry+=" }"
    ADOPT_ENTRIES+=("$entry")
    ADOPT_COUNT=$((ADOPT_COUNT + 1))
  fi

  # Build the env-file lines (canonical EXISTING_* triples — names match the
  # bicepparam readEnvironmentVariable + the post-deploy scripts).
  ENV_LINES+=("export ${envName}='${n}'")
  ENV_LINES+=("export ${envRg}='${r}'")
  ENV_LINES+=("export ${envSub}='${s}'")

  if [[ -n "$n" ]]; then
    SUMMARY+=("  ✓ $label: REUSE $n (rg=${r:-?} sub=${s:-deploy-sub})")
  elif [[ "$choice" == "new" ]]; then
    SUMMARY+=("  + $label: NEW$([[ -n "$flag" ]] && echo " (ensure $flag=true)")")
  else
    SUMMARY+=("  - $label: GATE (honest MessageBar until configured)")
  fi
  echo
done

# Databricks hostname (resolved above) travels inside the adopt bag's `extra`,
# not as its own param — `existingDatabricksHostname` no longer exists in
# main.bicep. The env line stays: the boundary bicepparams still fold
# EXISTING_DATABRICKS_HOSTNAME into the plan for an env-file-only workflow.
DBX_HOST="${HOST[databricks]:-}"
ENV_LINES+=("export EXISTING_DATABRICKS_HOSTNAME='${DBX_HOST}'")

# AOAI/Foundry reused-account deployment names (empty when provisioning new —
# the dedicated agentFoundry account then deploys gpt-4o + embeddings itself).
# Same story: they ride in the adopt bag's `extra`, not as standalone params.
ENV_LINES+=("export EXISTING_AOAI_CHAT_DEPLOYMENT='${FOUNDRY_CHAT}'")
ENV_LINES+=("export EXISTING_AOAI_EMBED_DEPLOYMENT='${FOUNDRY_EMBED}'")
# Model-tier slots on the reused account (LOOM_AOAI_MINI/STRONG_DEPLOYMENT).
# Empty is safe: admin-plane falls each tier back to the reused account's chat
# deployment, which reproduces the documented "router rides the single resolved
# default" behaviour instead of shipping a blank env var.
ENV_LINES+=("export EXISTING_AOAI_MINI_DEPLOYMENT='${FOUNDRY_MINI}'")
ENV_LINES+=("export EXISTING_AOAI_STRONG_DEPLOYMENT='${FOUNDRY_STRONG}'")
# AOAI/Foundry is ON BY DEFAULT (agentFoundryEnabled defaults true in main.bicep
# AND is set true in each boundary bicepparam). The flag lives OUTSIDE the BYO
# block, so we do NOT inject it here (that would duplicate the param). If the
# operator gated AOAI (BYO_FOUNDRY=gate), the summary flags it — set
# `agentFoundryEnabled = false` in the bicepparam to honestly skip the account.
if [[ "$FOUNDRY_CHOICE" == "gate" ]]; then
  SUMMARY+=("  ! AOAI gated: set 'param agentFoundryEnabled = false' in the boundary bicepparam to skip the AOAI account (Copilot/data-agent/AI-functions then honest-gate).")
fi

# Fabric mode (no-fabric-dependency.md: default false; gov hard-false).
FABRIC_VAL="false"
if [[ "$IS_GOV" == "0" && "${BYO_FABRIC:-false}" == "true" ]]; then
  FABRIC_VAL="true"
  echo "NOTE: fabricEnabled=true requested (Commercial). A bound Fabric workspace is OPT-IN."
fi
BLOCK_LINES+=("param fabricEnabled = ${FABRIC_VAL}")
ENV_LINES+=("export FABRIC_ENABLED='${FABRIC_VAL}'")

# ---------------------------------------------------------------------------
# Emit the generated bicepparam: copy the template, replacing the marked block.
# ---------------------------------------------------------------------------
BLOCK_FILE="$(mktemp)"
# The template's own adopt block (the `var legacyAdoptFromEnv = union(...)`
# declaration through the line BEFORE `param adopt =`) is carried through
# VERBATIM: the wizard must not drop the EXISTING_* env fallback just because it
# is regenerating the marked region. Only the final `param adopt =` assignment
# is rewritten, so the operator's literal picks compose OVER the env reads.
ADOPT_VAR_BLOCK="$(awk '/^var legacyAdoptFromEnv = union\(/{p=1} p{print} /^\)$/{if(p) exit}' "$TEMPLATE")"
{
  echo "// >>> BYO-WIZARD START (generated by scripts/csa-loom/byo-wizard.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ))"
  if [[ -n "$ADOPT_VAR_BLOCK" ]]; then
    echo "$ADOPT_VAR_BLOCK"
  else
    echo "var legacyAdoptFromEnv = {}"
  fi
  # The adopt bag. `main.bicep` no longer declares the 36 `existing*` scalars —
  # it declares ONE `adopt` object (ARM caps a template at 256 params and
  # main.bicep was at 251/256). Emitting `param existingPurviewAccount = '…'`
  # against the current template is a hard BCP259 ("assigned in the params file
  # without being declared in the Bicep file"): it does not compile, so it does
  # not deploy.
  #
  # A pure-greenfield run (every answer 'new' or 'gate') contributes NO entries
  # and this collapses to exactly the template's own default — `adoptMode()`
  # resolves every absent key to 'create'. That is deliberate: the previous
  # generator appended `param existingDatabricksHostname = ''` unconditionally,
  # which broke a greenfield deploy that had adopted nothing at all.
  if [[ "$ADOPT_COUNT" -gt 0 ]]; then
    echo "param adopt = union(legacyAdoptFromEnv, json(readEnvironmentVariable('LOOM_ADOPT_JSON', '{}')), {"
    for e in ${ADOPT_ENTRIES[@]+"${ADOPT_ENTRIES[@]}"}; do echo "$e"; done
    echo "})"
  else
    echo "param adopt = union(legacyAdoptFromEnv, json(readEnvironmentVariable('LOOM_ADOPT_JSON', '{}')))"
  fi
  for l in "${BLOCK_LINES[@]}"; do echo "$l"; done
  echo "// <<< BYO-WIZARD END"
} > "$BLOCK_FILE"

awk -v blockfile="$BLOCK_FILE" '
  /\/\/ >>> BYO-WIZARD START/ { while ((getline line < blockfile) > 0) print line; close(blockfile); skip=1; next }
  /\/\/ <<< BYO-WIZARD END/   { skip=0; next }
  skip==1 { next }
  { print }
' "$TEMPLATE" > "$OUT_PARAM"
rm -f "$BLOCK_FILE"

# ---------------------------------------------------------------------------
# Emit the env file for the post-deploy scripts (+ env-driven deploy).
# ---------------------------------------------------------------------------
{
  echo "# CSA Loom BYO env — generated $(date -u +%Y-%m-%dT%H:%M:%SZ) for boundary $BOUNDARY"
  echo "# Source then deploy (env-driven) OR feed grant-navigator-rbac.sh / patch-navigator-env.sh:"
  echo "#   source $OUT_ENV && az deployment sub create -f platform/fiab/bicep/main.bicep -p platform/fiab/bicep/params/$BOUNDARY.bicepparam"
  for l in "${ENV_LINES[@]}"; do echo "$l"; done
} > "$OUT_ENV"

# ---------------------------------------------------------------------------
# Summary + next steps.
# ---------------------------------------------------------------------------
echo "============================================================"
echo "Choices:"
for s in "${SUMMARY[@]}"; do echo "$s"; done
echo
echo "Wrote:"
echo "  • params/$OUT_NAME.bicepparam   (drop-in for az deployment sub create -p)"
echo "  • ${OUT_ENV#$REPO_ROOT/}        (EXISTING_* exports for the post-deploy scripts)"
echo
echo "Next — one-button deploy with your BYO choices:"
echo "  az deployment sub create \\"
echo "    -f platform/fiab/bicep/main.bicep \\"
echo "    -p platform/fiab/bicep/params/$OUT_NAME.bicepparam \\"
echo "    -l <region>"
echo
echo "Then grant the Console UAMI roles on every REUSED resource:"
echo "  source $OUT_ENV && bash scripts/csa-loom/grant-navigator-rbac.sh"
echo "(For an already-running console, reconcile env without redeploy:"
echo "  source $OUT_ENV && bash scripts/csa-loom/patch-navigator-env.sh )"
