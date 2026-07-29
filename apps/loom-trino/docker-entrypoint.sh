#!/bin/sh
# CSA Loom — loom-trino start-up: render catalog property files, then hand off
# to the stock Trino launcher.
#
# POSIX sh on purpose: the Trino base image is UBI-minimal, so this avoids any
# dependency on bash-only syntax. An entrypoint that fails to run would turn a
# wired LOOM_TRINO_URL into a dead endpoint.
#
# The image is immutable; the CATALOGS are deployment state. Rendering them here
# means one image serves an estate that has an Iceberg REST Catalog (N1) and one
# that does not, and an operator can add an external federation source (the
# whole point of Trino) with an env-var change instead of an image rebuild.
#
# Every catalog written here is REAL and reachable. Nothing is emitted for a
# source that has not been configured — SHOW CATALOGS never lists a phantom.
set -eu

CATALOG_DIR="${TRINO_CATALOG_DIR:-/etc/trino/catalog}"
mkdir -p "$CATALOG_DIR"

log() { echo "[loom-trino] $*"; }

# ── Always-present, zero-dependency catalogs ─────────────────────────────────
# jmx: engine self-observability (queries against the running JVM's MBeans).
# memory: a real, writable scratch catalog so CREATE TABLE AS / temp joins work
#         out of the box. Both are in-process — no network, no credentials — so
#         both are available in an air-gapped enclave.
cat > "$CATALOG_DIR/jmx.properties" <<'EOF'
connector.name=jmx
EOF
cat > "$CATALOG_DIR/memory.properties" <<'EOF'
connector.name=memory
memory.max-data-per-node=512MB
EOF

# ── Iceberg over the Loom lake, via the N1 Iceberg REST Catalog ───────────────
# Emitted ONLY when the IRC is wired. Storage auth is the container's
# user-assigned managed identity (azure.auth-type=DEFAULT resolves the
# user-assigned identity named by AZURE_CLIENT_ID) — no account key, no SAS, no
# connection string anywhere in this file.
IRC_URL="${LOOM_ICEBERG_CATALOG_URL:-}"
if [ -n "$IRC_URL" ]; then
  IRC_URL="${IRC_URL%/}"
  IRC_PREFIX="${LOOM_ICEBERG_CATALOG_PREFIX:-/api/2.1/unity-catalog/iceberg}"
  CATALOG_NAME="${LOOM_TRINO_ICEBERG_CATALOG:-iceberg}"
  {
    echo "connector.name=iceberg"
    echo "iceberg.catalog.type=rest"
    echo "iceberg.rest-catalog.uri=${IRC_URL}${IRC_PREFIX}"
    echo "iceberg.rest-catalog.warehouse=${LOOM_ICEBERG_CATALOG_WAREHOUSE:-loom}"
    if [ -n "${LOOM_ICEBERG_CATALOG_TOKEN:-}" ]; then
      echo "iceberg.rest-catalog.security=OAUTH2"
      echo "iceberg.rest-catalog.oauth2.token=${LOOM_ICEBERG_CATALOG_TOKEN}"
    else
      echo "iceberg.rest-catalog.security=NONE"
    fi
    echo "fs.azure.enabled=true"
    echo "azure.auth-type=DEFAULT"
  } > "$CATALOG_DIR/${CATALOG_NAME}.properties"
  log "wired Iceberg catalog '${CATALOG_NAME}' -> ${IRC_URL}${IRC_PREFIX}"
else
  log "LOOM_ICEBERG_CATALOG_URL unset — no lake catalog wired; jmx + memory serve."
fi

# ── Operator-supplied federation catalogs ────────────────────────────────────
# Any env var named LOOM_TRINO_CATALOG_<NAME> is written verbatim as
# <name>.properties (lower-cased, '_' -> '-'). This is how an external
# PostgreSQL / MySQL / MongoDB / Kafka source is added — the whole reason the
# federated engine exists — with no image rebuild. Use '\n' escapes for line
# breaks; a value that carries a password rides a Key Vault secretRef on the
# Container App, never a literal app setting.
#
#   LOOM_TRINO_CATALOG_SALES='connector.name=postgresql\nconnection-url=jdbc:postgresql://pg.internal:5432/sales\nconnection-user=loom'
env | while IFS= read -r LINE; do
  case "$LINE" in
    LOOM_TRINO_CATALOG_*)
      VAR="${LINE%%=*}"
      VAL="${LINE#*=}"
      NAME=$(printf '%s' "${VAR#LOOM_TRINO_CATALOG_}" | tr '[:upper:]' '[:lower:]' | tr '_' '-')
      [ -n "$NAME" ] || continue
      printf '%b\n' "$VAL" > "$CATALOG_DIR/${NAME}.properties"
      log "wired operator catalog '${NAME}'"
      ;;
  esac
done

log "catalogs: $(ls -1 "$CATALOG_DIR" | tr '\n' ' ')"
exec "$@"
