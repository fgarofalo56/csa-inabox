#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# restore-delta-tables.sh — Restore Delta Lake tables from ADLS backup
# ---------------------------------------------------------------------------
# Restores a previously backed-up Delta table from a timestamped backup
# directory. Validates backup integrity by checking for _delta_log/ and
# optionally runs VACUUM after restore.
#
# Prerequisites:
#   - azcopy v10+ installed and on PATH
#   - Azure CLI logged in (az login) or SAS token available
#
# Usage:
#   ./restore-delta-tables.sh \
#       --backup "https://<account>.dfs.core.windows.net/backups/<timestamp>/" \
#       --target "https://<account>.dfs.core.windows.net/<container>/<path>" \
#       [--vacuum] \
#       [--force] \
#       [--dry-run]
# ---------------------------------------------------------------------------
set -euo pipefail

# ─── Defaults ───────────────────────────────────────────────────────────────
DRY_RUN=false
FORCE=false
RUN_VACUUM=false
LOG_DIR="./temp/restore-logs"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")

# ─── Usage ──────────────────────────────────────────────────────────────────
usage() {
    cat <<EOF
Usage: $(basename "$0") --backup <ADLS_URL> --target <ADLS_URL> [OPTIONS]

Required:
  --backup URL     Backup source path (timestamped backup directory)
  --target URL     Target ADLS Gen2 path to restore into

Options:
  --vacuum         Run VACUUM on the Delta table after restore (requires Spark)
  --force          Overwrite existing data at target path without prompting
  --dry-run        Show what would be restored without restoring
  -h, --help       Show this help

Safety:
  Without --force, the script will abort if the target path already contains
  data. This prevents accidental overwrites.
EOF
    exit 1
}

# ─── Parse Arguments ───────────────────────────────────────────────────────
BACKUP=""
TARGET=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --backup)  BACKUP="$2";   shift 2 ;;
        --target)  TARGET="$2";   shift 2 ;;
        --vacuum)  RUN_VACUUM=true; shift ;;
        --force)   FORCE=true;    shift   ;;
        --dry-run) DRY_RUN=true;  shift   ;;
        -h|--help) usage                   ;;
        *)         echo "Unknown option: $1"; usage ;;
    esac
done

[[ -z "$BACKUP" ]] && { echo "ERROR: --backup is required"; usage; }
[[ -z "$TARGET" ]] && { echo "ERROR: --target is required"; usage; }

# ─── Pre-flight Checks ────────────────────────────────────────────────────
command -v azcopy >/dev/null 2>&1 || {
    echo "ERROR: azcopy is not installed. Install from https://aka.ms/azcopy"
    exit 1
}

mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/restore_${TIMESTAMP}.log"

log() {
    echo "[$(date -u +"%Y-%m-%d %H:%M:%S UTC")] $*" | tee -a "$LOG_FILE"
}

log "Starting Delta table restore"
log "  Backup:  $BACKUP"
log "  Target:  $TARGET"
log "  Force:   $FORCE"
log "  Vacuum:  $RUN_VACUUM"
log "  Dry run: $DRY_RUN"

# ─── Validate Backup Integrity ────────────────────────────────────────────
log "Validating backup integrity..."

# Check for _delta_log/ directory in the backup
DELTA_LOG_CHECK=$(azcopy list "${BACKUP%/}/_delta_log/" 2>&1 || true)

if echo "$DELTA_LOG_CHECK" | grep -q "RESPONSE STATUS: 404\|does not exist\|AuthorizationFailure\|not found"; then
    # Try one level deeper (backup may contain table subdirectories)
    SUBDIRS=$(azcopy list "${BACKUP%/}/" --machine-readable 2>/dev/null | head -20 || true)
    if echo "$SUBDIRS" | grep -q "_delta_log"; then
        log "  Found _delta_log in backup subdirectory — backup appears valid"
    else
        log "ERROR: No _delta_log/ found in backup path."
        log "  This does not appear to be a valid Delta table backup."
        log "  Backup contents:"
        azcopy list "${BACKUP%/}/" 2>/dev/null | head -20 | tee -a "$LOG_FILE"
        exit 1
    fi
else
    log "  Found _delta_log/ — backup appears valid"
fi

# ─── Safety Check: Target Exists ──────────────────────────────────────────
TARGET_CHECK=$(azcopy list "${TARGET%/}/" 2>&1 || true)

if echo "$TARGET_CHECK" | grep -qv "not found\|404\|does not exist"; then
    TARGET_HAS_DATA=true
else
    TARGET_HAS_DATA=false
fi

if [[ "$TARGET_HAS_DATA" == "true" && "$FORCE" == "false" && "$DRY_RUN" == "false" ]]; then
    log "ERROR: Target path already contains data."
    log "  Use --force to overwrite, or choose a different target."
    log "  Target: $TARGET"
    exit 1
fi

if [[ "$TARGET_HAS_DATA" == "true" && "$FORCE" == "true" ]]; then
    log "WARNING: --force specified. Existing data at target will be overwritten."
fi

# ─── Restore ───────────────────────────────────────────────────────────────
AZCOPY_FLAGS=(
    --recursive
    --overwrite=true
    --log-level=WARNING
)

if [[ "$DRY_RUN" == "true" ]]; then
    AZCOPY_FLAGS+=(--dry-run)
    log "DRY RUN MODE — no files will be copied"
fi

log "Running azcopy copy (restore)..."
azcopy copy "$BACKUP" "$TARGET" "${AZCOPY_FLAGS[@]}" 2>&1 | tee -a "$LOG_FILE"
COPY_EXIT=$?

if [[ $COPY_EXIT -ne 0 ]]; then
    log "ERROR: azcopy copy failed with exit code $COPY_EXIT"
    exit $COPY_EXIT
fi

log "Restore copy completed successfully"

# ─── Post-Restore: VACUUM ─────────────────────────────────────────────────
if [[ "$RUN_VACUUM" == "true" && "$DRY_RUN" == "false" ]]; then
    log "Running VACUUM on restored table..."
    log "NOTE: VACUUM requires a Spark environment (Databricks or local Spark)."
    log "  If running outside Databricks, ensure spark-submit is available."

    # Check if databricks CLI is available for remote execution
    if command -v databricks >/dev/null 2>&1; then
        log "  Databricks CLI detected — creating VACUUM job..."
        cat <<VACEOF
-- Run this in Databricks or spark-sql to vacuum the restored table:
-- Replace <table_path> with the actual Delta table path.
VACUUM delta.\`${TARGET}\` RETAIN 168 HOURS;
VACEOF
        log "  VACUUM command printed above — execute manually in Spark environment."
    else
        log "  No Spark environment detected."
        log "  Run VACUUM manually in Databricks after restore:"
        log "    VACUUM delta.\`${TARGET}\` RETAIN 168 HOURS;"
    fi
fi

# ─── Restore Metadata ─────────────────────────────────────────────────────
if [[ "$DRY_RUN" == "false" ]]; then
    METADATA_FILE="$LOG_DIR/restore_${TIMESTAMP}_metadata.json"
    cat > "$METADATA_FILE" <<METAEOF
{
    "timestamp": "$TIMESTAMP",
    "backup_source": "$BACKUP",
    "restore_target": "$TARGET",
    "force_overwrite": $FORCE,
    "vacuum_requested": $RUN_VACUUM,
    "exit_code": $COPY_EXIT,
    "log_file": "$LOG_FILE"
}
METAEOF
    log "Metadata written to $METADATA_FILE"
fi

log "Restore process finished"
