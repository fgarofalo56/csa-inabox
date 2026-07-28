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
#   etc/conf/server.properties      Entra authorization (LU-2) + optional ADLS vending
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
# server.properties — authorization (Entra/OIDC) + optional ADLS vending
#
# LU-2 (AuthN/Z hardening). Before LU-2 this rendered `server.authorization=disable`
# unconditionally and the VNet was the ONLY boundary: anything that could reach the
# Container Apps environment could read AND mutate catalog metadata anonymously,
# and (with vending wired) mint ADLS delegation SAS. That is a FedRAMP AC-3/IA-2
# finding, not a design choice. LU-2 makes Entra-backed authorization the DEFAULT
# and refuses to start half-configured.
#
# Config keys are the upstream ones, verified verbatim against
# unitycatalog/unitycatalog `etc/conf/server.properties` at BOTH v0.5.0 (the tag
# apps/loom-unity/Dockerfile pins) and v0.5.1:
#   server.authorization      enable | disable
#   server.authorization-url  IdP authorize endpoint
#   server.token-url          IdP token endpoint
#   server.client-id          IdP client id
#   server.client-secret      IdP client secret
#   server.redirect-port      OAuth redirect port (blank = upstream default)
#   server.allowed-issuers    REQUIRED when authorization is enabled — comma list,
#                             EXACT match. Upstream documents the Entra ID form as
#                             https://login.microsoftonline.com/{tenant-id}/v2.0
#   server.audiences          REQUIRED when authorization is enabled — comma list
#                             of accepted JWT audiences (typically the app id URI
#                             and/or the client id)
# `server.access-token-timeout` exists on upstream main but NOT in v0.5.0/v0.5.1, so
# it is deliberately not rendered here (we pin the image tag; see the Dockerfile).
# ---------------------------------------------------------------------------

die() {
  echo "[loom-unity] FATAL: $*" >&2
  exit 1
}

# Entra authority host — Commercial by default; Azure Government deployments pass
# login.microsoftonline.us. Sovereign hosts are NEVER hard-coded on a code path;
# the bicep module derives this from environment().authentication.loginEndpoint.
unity_authority_host() {
  printf '%s' "${LOOM_UNITY_AUTHORITY_HOST:-login.microsoftonline.com}"
}

render_server() {
  tenant="${LOOM_UNITY_ENTRA_TENANT_ID:-}"
  client_id="${LOOM_UNITY_ENTRA_CLIENT_ID:-}"
  authority="$(unity_authority_host)"

  # DEFAULT-ON: with an Entra tenant wired, authorization is ENABLED unless the
  # operator explicitly sets LOOM_UNITY_AUTH=disable (an audited opt-out, not a
  # silent default). With no tenant wired at all we cannot fabricate a validator,
  # so the server stays open — and says so, loudly, on every boot.
  auth="${LOOM_UNITY_AUTH:-}"
  if [ -z "${auth}" ]; then
    if [ -n "${tenant}" ]; then auth=enable; else auth=disable; fi
  fi

  authz_url="${LOOM_UNITY_AUTHORIZATION_URL:-}"
  token_url="${LOOM_UNITY_TOKEN_URL:-}"
  issuers="${LOOM_UNITY_ALLOWED_ISSUERS:-}"
  audiences="${LOOM_UNITY_AUDIENCES:-}"
  # NOTE: plain `if` blocks, not `[ … ] && x=y` one-liners — `set -e` is on and a
  # false AND-list at statement level would abort the boot.
  if [ -n "${tenant}" ]; then
    if [ -z "${authz_url}" ]; then authz_url="https://${authority}/${tenant}/oauth2/v2.0/authorize"; fi
    if [ -z "${token_url}" ]; then token_url="https://${authority}/${tenant}/oauth2/v2.0/token"; fi
    if [ -z "${issuers}" ]; then issuers="https://${authority}/${tenant}/v2.0"; fi
  fi
  if [ -z "${audiences}" ] && [ -n "${client_id}" ]; then
    audiences="api://${client_id},${client_id}"
  fi

  if [ "${auth}" = "enable" ]; then
    # FAIL CLOSED. An "enabled" authorization server with no pinned issuer or no
    # pinned audience accepts tokens it must not accept — worse than an honest
    # open door because it LOOKS secured. Refuse to boot and name the exact vars.
    if [ -z "${issuers}" ]; then
      die "LOOM_UNITY_AUTH=enable but no token issuer is pinned. Set LOOM_UNITY_ENTRA_TENANT_ID (issuer is derived as https://<authority>/<tenant>/v2.0) or LOOM_UNITY_ALLOWED_ISSUERS explicitly. See docs/fiab/unity-gov.md."
    fi
    if [ -z "${audiences}" ]; then
      die "LOOM_UNITY_AUTH=enable but no token audience is pinned. Set LOOM_UNITY_ENTRA_CLIENT_ID (audiences are derived as api://<client-id>,<client-id>) or LOOM_UNITY_AUDIENCES explicitly. See docs/fiab/unity-gov.md."
    fi
  else
    echo "[loom-unity] SECURITY WARNING: authorization is DISABLED — every workload that can reach this Container App over the VNet can read AND modify Loom Unity catalog metadata anonymously (and mint ADLS credentials if vending is wired). This is an honest, audited opt-out, not the default. Set LOOM_UNITY_ENTRA_TENANT_ID + LOOM_UNITY_ENTRA_CLIENT_ID (bicep authMode=entra) to enforce Entra bearer authorization. See docs/fiab/security/loom-unity-threat-model.md." >&2
  fi

  cat <<EOF
server.env=prod
server.authorization=${auth}
server.authorization-url=${authz_url}
server.token-url=${token_url}
server.client-id=${client_id}
server.client-secret=${LOOM_UNITY_ENTRA_CLIENT_SECRET:-}
server.redirect-port=${LOOM_UNITY_REDIRECT_PORT:-}
server.allowed-issuers=${issuers}
server.audiences=${audiences}
EOF

  # ADLS credential vending (opt-in). When the operator wires a service-principal
  # for the DLZ lake, UC vends short-lived Azure delegation-SAS credentials for
  # external tables/volumes. When UNSET, loom-unity is a metadata catalog + table
  # registry and data access stays on Loom's existing managed-identity/ACL paths
  # (honest scope — see docs/fiab/unity-gov.md capability matrix).
  #
  # LU-2: the client secret arrives as a Container Apps SECRET REFERENCE backed by
  # Key Vault (loom-unity-app.bicep `adlsClientSecretUri`), never an inline literal
  # in bicep, a param file, or an `az containerapp update --set-env-vars` line.
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
echo "[loom-unity] rendering config (db=${LOOM_UNITY_DB_URL:+postgres}${LOOM_UNITY_DB_URL:-h2-file} dir=${DB_DIR} auth=${LOOM_UNITY_AUTH:-${LOOM_UNITY_ENTRA_TENANT_ID:+enable}${LOOM_UNITY_ENTRA_TENANT_ID:-disable}} adls-vending=${LOOM_UNITY_ADLS_ACCOUNT:+on}${LOOM_UNITY_ADLS_ACCOUNT:-off})"
seed_db_if_empty
write_config

cd "${UC_HOME}"
echo "[loom-unity] starting OSS Unity Catalog server on :${LOOM_UNITY_PORT:-8080}"
exec ./bin/start-uc-server
