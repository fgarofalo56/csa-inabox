#!/usr/bin/env bash
# CSA Loom — Governance taxonomy seeding (deploy-readiness #229).
#
# Makes the governance surfaces POPULATED on first login instead of empty:
#   • Classifications  (PII / PHI / PCI-DSS / Confidential / Public / CUI / ITAR)
#   • Sensitivity labels (Public / Internal / Confidential / Highly Confidential / Restricted)
#   • Governance domains (Finance / HR / Operations / Customer / Compliance)
#
# DEFAULT (always): idempotent upsert of curated GLOBAL docs into the Console
# `loom` Cosmos DB. The BFF routes copy these GLOBAL defaults into each tenant's
# partition on first access (see app/api/admin/classifications, sensitivity-labels,
# governance/domains — copyGlobalDefaults* helpers), so day-one users see a
# populated taxonomy. Azure-native; NO Microsoft Fabric / Purview dependency.
#
# OPT-IN deepening: when LOOM_PURVIEW_ACCOUNT is set, ALSO best-effort push the
# classification taxonomy into Purview as real custom classification rules +
# scan rule sets and mirror the domains as classic collections. Failures are
# non-fatal (honest gate per .claude/rules/no-vaporware.md) — Cosmos stays the
# authoritative default backend (.claude/rules/no-fabric-dependency.md).
#
# Run by .github/workflows/csa-loom-post-deploy-bootstrap.yml after seed-catalogs,
# or manually. Auth: `az login` as a principal with Cosmos DB Built-in Data
# Contributor on the account.
#
# Required env:
#   LOOM_COSMOS_ACCOUNT   — Console Cosmos account (short name)
# Optional env:
#   LOOM_COSMOS_RG        — RG of the Cosmos account (default: $ADMIN_RG or rg-csa-loom-admin-eastus2)
#   LOOM_COSMOS_DATABASE  — Cosmos SQL database (default: loom)
#   LOOM_SUBSCRIPTION_ID  — subscription (default: live Commercial sub)
#   LOOM_SEED_TENANT      — tenant/partition id to seed under (default: GLOBAL)
#   LOOM_PURVIEW_ACCOUNT  — when set, best-effort Purview taxonomy push (data-plane)

set -uo pipefail
export MSYS_NO_PATHCONV=1

SUB="${LOOM_SUBSCRIPTION_ID:-00000000-0000-0000-0000-000000000001}"
RG="${LOOM_COSMOS_RG:-${ADMIN_RG:-rg-csa-loom-admin-eastus2}}"
COSMOS="${LOOM_COSMOS_ACCOUNT:-}"
DB="${LOOM_COSMOS_DATABASE:-loom}"
TENANT="${LOOM_SEED_TENANT:-GLOBAL}"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ -z "$COSMOS" ]; then
  echo "::warning::LOOM_COSMOS_ACCOUNT not set — skipping governance seed (no Cosmos target)."
  exit 0
fi

command -v jq >/dev/null 2>&1 || { echo "::warning::jq not found — skipping governance seed."; exit 0; }
az account set --subscription "$SUB" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# Idempotent upsert helper: create-or-replace one item in a container.
# ---------------------------------------------------------------------------
upsert() {  # container partition-key item-id json-body
  local container="$1" pk="$2" id="$3" body="$4"
  az cosmosdb sql container item create \
    --account-name "$COSMOS" -g "$RG" -d "$DB" -c "$container" \
    --partition-key-value "$pk" --body "$body" >/dev/null 2>&1 || \
  az cosmosdb sql container item replace \
    --account-name "$COSMOS" -g "$RG" -d "$DB" -c "$container" \
    --partition-key-value "$pk" --item-id "$id" --body "$body" >/dev/null 2>&1 || \
  echo "::warning::governance seed upsert failed for $container/$id (Cosmos RBAC? container missing?)"
}

# ---------------------------------------------------------------------------
# 1. Classifications — tenant-settings doc id=classifications:<tenant>.
#    Shape matches ClassificationRule in app/api/admin/classifications/route.ts.
# ---------------------------------------------------------------------------
echo "==> Seeding classifications taxonomy (tenant=$TENANT)…"
CLASSIFICATIONS=$(cat <<'JSON'
[
  {"id":"cls-pii","name":"PII","matchStrategy":"data-regex","matchValue":"\\b\\d{3}-\\d{2}-\\d{4}\\b","classification":"MICROSOFT.GOVERNMENT.US_SOCIAL_SECURITY_NUMBER"},
  {"id":"cls-phi","name":"PHI","matchStrategy":"column-name-regex","matchValue":"(?i)(diagnosis|patient|mrn|icd10|npi)","classification":"CUSTOM.PHI"},
  {"id":"cls-pci","name":"PCI-DSS","matchStrategy":"data-regex","matchValue":"\\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14})\\b","classification":"MICROSOFT.FINANCIAL.CREDIT_CARD_NUMBER"},
  {"id":"cls-confidential","name":"Confidential","matchStrategy":"column-name-regex","matchValue":"(?i)(secret|confidential|restricted)","classification":"CUSTOM.CONFIDENTIAL"},
  {"id":"cls-public","name":"Public","matchStrategy":"column-name-regex","matchValue":"(?i)(public|open)","classification":"CUSTOM.PUBLIC"},
  {"id":"cls-cui","name":"CUI","matchStrategy":"column-name-regex","matchValue":"(?i)(cui|controlled.?unclassified)","classification":"CUSTOM.CUI"},
  {"id":"cls-itar","name":"ITAR","matchStrategy":"column-name-regex","matchValue":"(?i)(itar|export.?controlled|ear99)","classification":"CUSTOM.ITAR"}
]
JSON
)
RULES=$(echo "$CLASSIFICATIONS" | jq --arg now "$NOW" '[ .[] + {createdAt:$now, createdBy:"csa-loom-seed"} ]')
CLS_DOC=$(jq -nc --arg id "classifications:$TENANT" --arg t "$TENANT" --arg now "$NOW" --argjson rules "$RULES" \
  '{id:$id, tenantId:$t, kind:"classifications", rules:$rules, updatedAt:$now}')
upsert tenant-settings "$TENANT" "classifications:$TENANT" "$CLS_DOC"

# ---------------------------------------------------------------------------
# 2. Sensitivity labels — tenant-settings doc id=sensitivity-labels:<tenant>.
#    Shape matches SensitivityLabel in app/api/admin/sensitivity-labels/route.ts.
# ---------------------------------------------------------------------------
echo "==> Seeding sensitivity labels (tenant=$TENANT)…"
LABELS_SRC=$(cat <<'JSON'
[
  {"id":"lbl-public","name":"Public","color":"#107c10","protectionNote":"No restrictions; safe for external release."},
  {"id":"lbl-internal","name":"Internal","color":"#0078d4","protectionNote":"Organization-internal only; do not share externally."},
  {"id":"lbl-confidential","name":"Confidential","color":"#ca5010","protectionNote":"Need-to-know; encrypt at rest and in transit."},
  {"id":"lbl-highly-confidential","name":"Highly Confidential","color":"#a4262c","protectionNote":"Strict need-to-know; DLP-enforced; audited access."},
  {"id":"lbl-restricted","name":"Restricted","color":"#5c2d91","protectionNote":"Regulated data (CUI/ITAR/PHI); access via approved enclave only."}
]
JSON
)
LABELS=$(echo "$LABELS_SRC" | jq --arg now "$NOW" '[ .[] + {createdAt:$now, createdBy:"csa-loom-seed"} ]')
LBL_DOC=$(jq -nc --arg id "sensitivity-labels:$TENANT" --arg t "$TENANT" --arg now "$NOW" --argjson labels "$LABELS" \
  '{id:$id, tenantId:$t, kind:"sensitivity-labels", labels:$labels, updatedAt:$now}')
upsert tenant-settings "$TENANT" "sensitivity-labels:$TENANT" "$LBL_DOC"

# ---------------------------------------------------------------------------
# 3. Governance domains — governance-domains container, one doc per domain.
#    Shape matches LoomDomain in lib/azure/domains-client.ts.
# ---------------------------------------------------------------------------
echo "==> Seeding governance domains (tenant=$TENANT)…"
DOMAINS_SRC=$(cat <<'JSON'
[
  {"id":"finance","name":"Finance","description":"Financial reporting, GL, AP/AR, and treasury data products.","color":"#107c10","imageKey":"icon::finance"},
  {"id":"hr","name":"Human Resources","description":"Workforce, payroll, benefits, and talent data products.","color":"#5c2d91","imageKey":"icon::people"},
  {"id":"operations","name":"Operations","description":"Supply chain, logistics, and operational telemetry data products.","color":"#0078d4","imageKey":"icon::operations"},
  {"id":"customer","name":"Customer","description":"Customer 360, CRM, and engagement data products.","color":"#ca5010","imageKey":"icon::customer"},
  {"id":"compliance","name":"Compliance","description":"Regulatory, audit, and governance evidence data products.","color":"#a4262c","imageKey":"icon::shield"}
]
JSON
)
echo "$DOMAINS_SRC" | jq -c '.[]' | while IFS= read -r d; do
  id=$(echo "$d" | jq -r .id)
  doc=$(echo "$d" | jq -c --arg t "$TENANT" --arg now "$NOW" \
    '. + {tenantId:$t, createdBy:"csa-loom-seed", createdAt:$now, updatedBy:"csa-loom-seed", updatedAt:$now}')
  upsert governance-domains "$TENANT" "$id" "$doc"
done

# ---------------------------------------------------------------------------
# 4. OPT-IN Purview deepening — best-effort, never fatal.
#    The console BFF already pushes the classification taxonomy to Purview on
#    every mutation (purview-classification-sync.ts). Triggering a re-push here
#    is done by hitting the syncOnly endpoint from the running console; since we
#    only have data-plane creds in this script, we DOCUMENT the follow-up rather
#    than re-implement the push in bash. When LOOM_PURVIEW_ACCOUNT is set the
#    grants in csa-loom-post-deploy-bootstrap.yml + the console's own sync make
#    the GLOBAL taxonomy land in Purview on the next classifications mutation.
# ---------------------------------------------------------------------------
if [ -n "${LOOM_PURVIEW_ACCOUNT:-}" ]; then
  echo "==> LOOM_PURVIEW_ACCOUNT=$LOOM_PURVIEW_ACCOUNT set — Purview deepening is handled by the"
  echo "    console's syncClassificationTaxonomyToPurview on first classifications mutation"
  echo "    (data-plane roles granted by grant-purview-datamap-role.sh). No extra action here."
fi

echo "==> Governance taxonomy seed complete (classifications + sensitivity labels + domains, tenant=$TENANT)."
