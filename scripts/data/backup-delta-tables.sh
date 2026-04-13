#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# backup-delta-tables.sh — Incremental backup of Delta Lake tables on ADLS
# ---------------------------------------------------------------------------
# Uses azcopy to sync Delta table files from a source ADLS path to a backup
# destination. Supports incremental copies (only new/changed files) and
# retention policies.
#
# Prerequisites:
#   - azcopy v10+ installed and on PATH
#   - Azure CLI logged in (az login) or SAS token available
#   - Source and destination are ADLS Gen2 paths
#
# Usage:
#   ./backup-delta-tables.sh \
#       --source "https://<account>.dfs.core.windows.net/<container>/<path>" \
#       --dest   "https://<account>.dfs.core.windows.net/backups/<path>" \
#       [--retention 7] \
#       [--dry-run]
# ---------------------------------------------------------------------------
set -euo pipefail

# ─── Defaults ───────────────────────────────────────────────────────────────
RETENTION_COUNT=7       # Keep last N backups
DRY_RUN=false
LOG_DIR="./temp/backup-logs"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")

# ─── Usage ──────────────────────────────────────────────────────────────────
usage() {
    cat <<EOF
Usage: $(basename "$0") --source <ADLS_URL> --dest <ADLS_URL> [OPTIONS]

Required:
  --source URL     Source ADLS Gen2 path (e.g. https://acct.dfs.core.windows.net/gold/)
  --dest   URL     Backup destination path

Options:
  --retention N    Keep last N timestamped backups (default: $RETENTION_COUNT)
  --dry-run        Show what would be copied without copying
  -h, --help       Show this help
EOF
    exit 1
}

# ─── Parse Arguments ───────────────────────────────────────────────────────
SOURCE=""
DEST=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --source)   SOURCE="$2";          shift 2 ;;
        --dest)     DEST="$2";            shift 2 ;;
        --retention) RETENTION_COUNT="$2"; shift 2 ;;
        --dry-run)  DRY_RUN=true;         shift   ;;
        -h|--help)  usage                          ;;
        *)          echo "Unknown option: $1"; usage ;;
    esac
done

[[ -z "$SOURCE" ]] && { echo "ERROR: --source is required"; usage; }
[[ -z "$DEST" ]]   && { echo "ERROR: --dest is required";   usage; }

# ─── Pre-flight Checks ────────────────────────────────────────────────────
command -v azcopy >/dev/null 2>&1 || {
    echo "ERROR: azcopy is not installed. Install from https://aka.ms/azcopy"
    exit 1
}

mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/backup_${TIMESTAMP}.log"

log() {
    echo "[$(date -u +"%Y-%m-%d %H:%M:%S UTC")] $*" | tee -a "$LOG_FILE"
}

# ─── Backup ────────────────────────────────────────────────────────────────
BACKUP_DEST="${DEST%/}/${TIMESTAMP}/"

log "Starting Delta table backup"
log "  Source:      $SOURCE"
log "  Destination: $BACKUP_DEST"
log "  Retention:   last $RETENTION_COUNT backups"
log "  Dry run:     $DRY_RUN"

AZCOPY_FLAGS=(
    --recursive
    --overwrite=ifSourceNewer
    --log-level=WARNING
)

if [[ "$DRY_RUN" == "true" ]]; then
    AZCOPY_FLAGS+=(--dry-run)
    log "DRY RUN MODE — no files will be copied"
fi

log "Running azcopy sync..."
azcopy sync "$SOURCE" "$BACKUP_DEST" "${AZCOPY_FLAGS[@]}" 2>&1 | tee -a "$LOG_FILE"
SYNC_EXIT=$?

if [[ $SYNC_EXIT -ne 0 ]]; then
    log "ERROR: azcopy sync failed with exit code $SYNC_EXIT"
    exit $SYNC_EXIT
fi

# ─── Log Backup Metadata ──────────────────────────────────────────────────
if [[ "$DRY_RUN" == "false" ]]; then
    # Count files and total size in the backup
    FILE_STATS=$(azcopy list "$BACKUP_DEST" --machine-readable 2>/dev/null | tail -1 || echo "unknown")
    log "Backup complete"
    log "  Timestamp: $TIMESTAMP"
    log "  Stats:     $FILE_STATS"

    # Write metadata file
    METADATA_FILE="$LOG_DIR/backup_${TIMESTAMP}_metadata.json"
    cat > "$METADATA_FILE" <<METAEOF
{
    "timestamp": "$TIMESTAMP",
    "source": "$SOURCE",
    "destination": "$BACKUP_DEST",
    "retention_policy": $RETENTION_COUNT,
    "exit_code": $SYNC_EXIT,
    "log_file": "$LOG_FILE"
}
METAEOF
    log "Metadata written to $METADATA_FILE"
fi

# ─── Retention Policy ─────────────────────────────────────────────────────
if [[ "$DRY_RUN" == "false" && "$RETENTION_COUNT" -gt 0 ]]; then
    log "Applying retention policy (keep last $RETENTION_COUNT backups)..."

    # List timestamped backup folders, oldest first
    BACKUP_DIRS=$(azcopy list "${DEST%/}/" --machine-readable 2>/dev/null \
        | grep -oP '\d{8}T\d{6}Z' \
        | sort -u)

    BACKUP_COUNT=$(echo "$BACKUP_DIRS" | wc -l)

    if [[ $BACKUP_COUNT -gt $RETENTION_COUNT ]]; then
        TO_DELETE=$((BACKUP_COUNT - RETENTION_COUNT))
        log "  Found $BACKUP_COUNT backups, removing $TO_DELETE oldest..."

        echo "$BACKUP_DIRS" | head -n "$TO_DELETE" | while read -r OLD_BACKUP; do
            OLD_PATH="${DEST%/}/${OLD_BACKUP}/"
            log "  Removing: $OLD_PATH"
            azcopy remove "$OLD_PATH" --recursive 2>&1 | tee -a "$LOG_FILE"
        done
    else
        log "  $BACKUP_COUNT backups within retention limit — nothing to remove"
    fi
fi

log "Backup process finished"
