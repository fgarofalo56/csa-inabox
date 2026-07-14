#!/bin/sh
# CSA Loom — loom-unity entrypoint.
#
# Packages the OSS Unity Catalog server (unitycatalog/unitycatalog) for CSA Loom
# so Azure Government — where Databricks Unity Catalog is unavailable/limited —
# gets a real, self-hosted Unity Catalog REST backend that works day one. This
# script is thin config-rendering glue on top of the upstream image; it does NOT
# fork the server.
#
# It renders two config files into the UC config dir from environment variables,
# then execs the upstream start script:
#
#   etc/conf/hibernate.properties   persistence (H2 file DB default, Postgres opt-in)
#   etc/conf/server.properties      auth mode + optional ADLS credential vending
#
# Persistence is the DEFAULT H2 file DB placed on a mounted Azure Files volume so
# the catalog survives container restarts (the bicep module mounts the share at
# $LOOM_UNITY_DB_DIR). On first boot, if that dir is empty (fresh share), the
# image's seeded schema is copied in so the server starts against a valid DB.
#
# Azure-native only. No api.fabric.microsoft.com / api.powerbi.com is ever
# reached (.claude/rules/no-fabric-dependency.md) — this IS the Azure-native
# Unity Catalog backend.
set -eu

# Upstream image installs UC under $HOME (/home/unitycatalog); config lives in
# etc/conf and the H2 db in etc/db, both relative to the working dir.
UC_HOME="${UC_HOME:-/home/unitycatalog}"
CONF_DIR="${UC_HOME}/etc/conf"
DB_DIR="${LOOM_UNITY_DB_DIR:-${UC_HOME}/etc/db}"
DB_SEED_DIR="${UC_HOME}/etc/db.seed"

# ---------------------------------------------------------------------------
# H2-on-Azure-Files (SMB/CIFS) resilience.
#
# The default persistence is an H2 file DB on a mounted Azure Files share so the
# catalog survives restarts. But H2's file DB is fragile on CIFS: the non-root
# `unitycatalog` service account may not own the SMB-mounted dir (uid/gid mount
# defaults), and H2's file-channel/lock operations do not have reliable CIFS
# semantics — so the JVM crash-loops on first boot even though the exact same
# image runs cleanly on a local/EmptyDir volume (observed live on the Gov
# deployment 2026-07-14, non-reproducible in local Docker).
#
# Resolution: write-test the DB dir. If it is not writable by this user (the SMB
# permission case), fall back to a LOCAL ephemeral dir so UC is FUNCTIONAL
# immediately — with a loud, honest warning that catalog metadata is not
# persisted across restarts on this deployment until a durable backend
# (LOOM_UNITY_DB_URL=jdbc:postgresql://… — Postgres) is wired. Set
# LOOM_UNITY_DB_LOCAL=1 to force the local dir unconditionally (the sanctioned
# Gov posture while Postgres quota is pending). Postgres (LOOM_UNITY_DB_URL) is
# unaffected — it owns its own storage and never touches this dir.
LOCAL_DB_DIR="${LOOM_UNITY_LOCAL_DB_DIR:-/tmp/loom-unity-db}"
resolve_db_dir() {
  # Postgres backend: DB_DIR is irrelevant.
  [ -n "${LOOM_UNITY_DB_URL:-}" ] && return 0
  if [ "${LOOM_UNITY_DB_LOCAL:-}" = "1" ]; then
    echo "[loom-unity] LOOM_UNITY_DB_LOCAL=1 — using local ephemeral H2 dir ${LOCAL_DB_DIR} (catalog NOT persisted across restarts; wire LOOM_UNITY_DB_URL=jdbc:postgresql://… for durable storage)"
    DB_DIR="${LOCAL_DB_DIR}"
    return 0
  fi
  mkdir -p "${DB_DIR}" 2>/dev/null || true
  if mkdir -p "${DB_DIR}" 2>/dev/null && touch "${DB_DIR}/.loom-write-test" 2>/dev/null; then
    rm -f "${DB_DIR}/.loom-write-test" 2>/dev/null || true
    return 0
  fi
  echo "[loom-unity] WARNING: DB dir ${DB_DIR} is not writable by $(id -un) (Azure Files SMB permission/semantics) — falling back to local ephemeral dir ${LOCAL_DB_DIR}. Catalog metadata will NOT persist across restarts; wire LOOM_UNITY_DB_URL=jdbc:postgresql://… (Postgres) for durable storage. See docs/fiab/unity-gov.md."
  DB_DIR="${LOCAL_DB_DIR}"
  mkdir -p "${DB_DIR}"
}

# ---------------------------------------------------------------------------
# hibernate.properties — persistence backend
# ---------------------------------------------------------------------------
render_hibernate() {
  db_url="${LOOM_UNITY_DB_URL:-}"
  if [ -n "${db_url}" ] && printf '%s' "${db_url}" | grep -qi '^jdbc:postgresql:'; then
    # Postgres — OPT-IN / experimental. Requires the postgres JDBC driver on the
    # server classpath and the UC schema migrated once by the operator (see
    # docs/fiab/unity-gov.md). We render the config faithfully; we do not pretend
    # the driver/migration are guaranteed present.
    cat <<EOF
hibernate.connection.driver_class=org.postgresql.Driver
hibernate.connection.url=${db_url}
hibernate.connection.username=${LOOM_UNITY_DB_USER:-}
hibernate.connection.password=${LOOM_UNITY_DB_PASSWORD:-}
hibernate.dialect=org.hibernate.dialect.PostgreSQLDialect
hibernate.hbm2ddl.auto=none
hibernate.show_sql=false
EOF
  else
    # DEFAULT — H2 file DB on the mounted (persistent) volume. DB_CLOSE_DELAY=-1
    # keeps the in-JVM DB alive across connection close; the .mv.db file is what
    # persists on Azure Files.
    #
    # CONTRACT: mirror the upstream image's own hibernate.properties exactly
    # except the file path. The image's SEEDED h2db.mv.db was created with an
    # EMPTY username (upstream renders no username/password lines) — injecting
    # `username=sa` here made H2 throw JdbcSQLInvalidAuthorizationSpecException
    # ("Wrong user name or password") on first boot, crash-looping the Gov
    # Container App (found live 2026-07-14, reproduced in local Docker).
    # `hbm2ddl.auto=update` also matches upstream so a fresh (unseeded) dir gets
    # its schema created.
    # FILE_LOCK=FS is refused outright on CIFS; FILE_LOCK=NO skips H2's lock-file
    # protocol entirely — safe here because loom-unity is the ONLY writer
    # (minReplicas=1, single container, internal ingress) and Azure Files (SMB)
    # can't honor H2's default file-lock semantics (the second Gov first-boot
    # crash after the credentials fix).
    cat <<EOF
hibernate.connection.driver_class=org.h2.Driver
hibernate.connection.url=jdbc:h2:file:${DB_DIR}/h2db;DB_CLOSE_DELAY=-1;FILE_LOCK=NO
hibernate.hbm2ddl.auto=update
hibernate.show_sql=false
hibernate.archive.autodetection=class
EOF
  fi
}

# ---------------------------------------------------------------------------
# server.properties — auth mode + optional ADLS credential vending
# ---------------------------------------------------------------------------
render_server() {
  # Auth defaults to DISABLE: the service runs on internal-ingress only (reachable
  # from the Console over the Container Apps VNet, never public), so the network
  # boundary is the security perimeter — identical to the sibling loom-onelake
  # internal service. Set LOOM_UNITY_AUTH=enable to turn on the upstream OAuth/OIDC
  # authorization server (opt-in; then wire the authorization/token URLs below).
  auth="${LOOM_UNITY_AUTH:-disable}"
  cat <<EOF
server.env=prod
server.authorization=${auth}
server.authorization-url=${LOOM_UNITY_AUTHORIZATION_URL:-}
server.token-url=${LOOM_UNITY_TOKEN_URL:-}
EOF

  # ADLS credential vending (opt-in). When the operator wires a service-principal
  # for the DLZ lake, UC vends short-lived Azure delegation-SAS credentials for
  # external tables/volumes. When UNSET, loom-unity is a metadata catalog + table
  # registry and data access stays on Loom's existing managed-identity/ACL paths
  # (honest scope — see docs/fiab/unity-gov.md capability matrix).
  if [ -n "${LOOM_UNITY_ADLS_ACCOUNT:-}" ]; then
    cat <<EOF
adls.storageAccountName.0=${LOOM_UNITY_ADLS_ACCOUNT}
adls.tenantId.0=${LOOM_UNITY_ADLS_TENANT:-}
adls.clientId.0=${LOOM_UNITY_ADLS_CLIENT_ID:-}
adls.clientSecret.0=${LOOM_UNITY_ADLS_CLIENT_SECRET:-}
EOF
  fi
}

seed_db_if_empty() {
  # Fresh Azure Files share → seed the schema from the image so the server has a
  # valid DB to open. Only for the H2 default (Postgres owns its own schema).
  if [ -n "${LOOM_UNITY_DB_URL:-}" ]; then
    return 0
  fi
  mkdir -p "${DB_DIR}"
  if [ ! -f "${DB_DIR}/h2db.mv.db" ] && [ -d "${DB_SEED_DIR}" ]; then
    echo "[loom-unity] seeding empty catalog DB dir ${DB_DIR} from image seed"
    cp -a "${DB_SEED_DIR}/." "${DB_DIR}/" 2>/dev/null || true
  fi
}

write_config() {
  mkdir -p "${CONF_DIR}"
  render_hibernate > "${CONF_DIR}/hibernate.properties"
  render_server    > "${CONF_DIR}/server.properties"
}

# Dry-run mode (used by tests): render config to stdout and exit without starting
# the JVM. Keeps the rendering logic unit-testable without a running server.
if [ "${LOOM_UNITY_DRYRUN:-}" = "1" ]; then
  echo "=== hibernate.properties ==="
  render_hibernate
  echo "=== server.properties ==="
  render_server
  exit 0
fi

# Resolve a writable DB dir BEFORE rendering hibernate.properties (which bakes
# the path into the JDBC URL) — this is what makes the H2/SMB fallback take.
resolve_db_dir
echo "[loom-unity] rendering config (db=${LOOM_UNITY_DB_URL:+postgres}${LOOM_UNITY_DB_URL:-h2-file} dir=${DB_DIR} auth=${LOOM_UNITY_AUTH:-disable} adls-vending=${LOOM_UNITY_ADLS_ACCOUNT:+on}${LOOM_UNITY_ADLS_ACCOUNT:-off})"
seed_db_if_empty
write_config

cd "${UC_HOME}"
echo "[loom-unity] starting OSS Unity Catalog server on :${LOOM_UNITY_PORT:-8080}"
exec ./bin/start-uc-server
