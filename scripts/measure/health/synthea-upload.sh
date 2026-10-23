#!/usr/bin/env bash
# synthea-upload.sh - LHDS W0-5: OPT-IN upload of a cohort + manifest to Azure Blob. Never run by CI or by
# the smoke path; it spends against a subscription, so everything is explicit and nothing defaults.
#
# Required env (no defaults, any missing -> refuse):
#   SYNTHEA_OUT_DIR                cohort directory (must contain manifest.json + manifest.sha256)
#   LHDS_COHORT_STORAGE_ACCOUNT    destination storage account name
#   LHDS_COHORT_CONTAINER          destination container
#   LHDS_SANDBOX_SUBSCRIPTION      subscription id for az --subscription (never inferred from `az account`)
#   LHDS_UPLOAD_CONFIRM=yes        literal confirmation
# Auth: `az login` identity with Storage Blob Data Contributor on the account (--auth-mode login); no keys.
# Blob prefix: <manifest hash>/ so two cohorts can never overwrite each other.
set -euo pipefail
die() { echo "ERROR: $*" >&2; exit 1; }
for v in SYNTHEA_OUT_DIR LHDS_COHORT_STORAGE_ACCOUNT LHDS_COHORT_CONTAINER LHDS_SANDBOX_SUBSCRIPTION; do
  [[ -n "${!v:-}" ]] || die "required env var $v is not set (no default by design)"
done
[[ "${LHDS_UPLOAD_CONFIRM:-}" == "yes" ]] || die "set LHDS_UPLOAD_CONFIRM=yes to upload"
[[ -s "$SYNTHEA_OUT_DIR/manifest.json" && -s "$SYNTHEA_OUT_DIR/manifest.sha256" ]] \
  || die "manifest.json / manifest.sha256 missing in $SYNTHEA_OUT_DIR - run synthea-manifest.sh first"
prefix="$(cut -d' ' -f1 "$SYNTHEA_OUT_DIR/manifest.sha256")"
[[ "$prefix" =~ ^[0-9a-f]{64}$ ]] || die "manifest.sha256 malformed"
az storage blob upload-batch --auth-mode login --subscription "$LHDS_SANDBOX_SUBSCRIPTION" \
  --account-name "$LHDS_COHORT_STORAGE_ACCOUNT" --destination "$LHDS_COHORT_CONTAINER" \
  --destination-path "$prefix" --source "$SYNTHEA_OUT_DIR" --pattern '*' --overwrite false
echo "uploaded $SYNTHEA_OUT_DIR to $LHDS_COHORT_STORAGE_ACCOUNT/$LHDS_COHORT_CONTAINER/$prefix/"
