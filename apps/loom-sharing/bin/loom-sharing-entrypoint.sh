#!/bin/sh
# CSA Loom — loom-sharing entrypoint (LU-9).
#
# Packages the OSS Delta Sharing REFERENCE SERVER (delta-io/delta-sharing,
# Apache-2.0) so Azure Government — where Databricks Delta Sharing is
# unavailable — gets a real open-protocol sharing server over the SAME ADLS
# Gen2 Delta tables the Loom lakehouse already writes. This script is thin
# config-rendering glue on top of the upstream image; it does NOT fork the
# server.
#
# It renders two files from environment variables and then execs the upstream
# launcher:
#
#   $LOOM_SHARING_CONF_DIR/delta-sharing-server.yaml   shares + bearer + tuning
#   /opt/docker/conf/core-site.xml                     Hadoop ADLS credentials
#
# ── SECURITY MODEL (read this before changing anything) ────────────────────
# The upstream reference server has exactly ONE authorization primitive: a
# single global `authorization.bearerToken`. It CANNOT scope a caller to a
# subset of shares — every holder of that token sees every share the config
# file declares (verified against ServerConfig.scala / Authorization on the
# v0.7.8 tag this image pins).
#
# That is why this container is NEVER the recipient-facing endpoint. Its ACA
# ingress is internal-only and the bearer rendered here is a server-to-BFF
# credential vended from Key Vault. Recipients authenticate to the Loom Console
# with Microsoft Entra tokens at /api/delta-sharing/*, where the per-recipient
# grant is resolved and enforced BEFORE anything is proxied here
# (apps/fiab-console/lib/sharing/recipient-auth.ts). Exposing this port to a
# recipient would hand them every share on the server.
#
# Consequently the bearer is MANDATORY: with no bearer the upstream server
# accepts unauthenticated calls, so a rendered config without one would make
# every share readable by anything that reaches the Container Apps environment.
# We fail closed instead.
#
# Azure-native only. No Fabric / Power BI / OneLake endpoint is ever reached
# (.claude/rules/no-fabric-dependency.md) — the shared tables are ADLS Gen2
# Delta, the same storage the lakehouse item type provisions.
set -eu

APP_HOME="${LOOM_SHARING_APP_HOME:-/opt/docker}"
# Hadoop reads core-site.xml off the CLASSPATH. sbt-native-packager puts
# ../conf on the launcher classpath (build.sbt: scriptClasspath ++= "../conf"),
# which resolves to $APP_HOME/conf — so that is the only directory where a
# rendered core-site.xml is actually picked up.
HADOOP_CONF_DIR="${LOOM_SHARING_HADOOP_CONF_DIR:-${APP_HOME}/conf}"
CONF_DIR="${LOOM_SHARING_CONF_DIR:-/opt/loom/etc}"
CONFIG_FILE="${CONF_DIR}/delta-sharing-server.yaml"

die() {
  echo "[loom-sharing] FATAL: $*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# delta-sharing-server.yaml
#
# The `shares:` block is authored by the Console (lib/sharing/manifest.ts) and
# handed over base64-encoded, because a YAML document does not survive an ACA
# env-var round trip intact (newlines, quoting, and `az containerapp update`
# argument splitting all mangle it). base64 is transport, not obfuscation.
#
# An EMPTY share list is a valid, honest state: the server boots, answers the
# protocol, and lists nothing. That is what a fresh deployment looks like
# before an operator publishes the first share — not an error, and not a gate.
# ---------------------------------------------------------------------------
render_shares() {
  if [ -n "${LOOM_SHARING_SHARES_B64:-}" ]; then
    printf '%s' "${LOOM_SHARING_SHARES_B64}" | base64 -d \
      || die "LOOM_SHARING_SHARES_B64 is not valid base64. It must be the base64 of the YAML 'shares:' block rendered by the Console (GET /api/marketplace/sharing/manifest)."
    return 0
  fi
  if [ -n "${LOOM_SHARING_SHARES_FILE:-}" ]; then
    [ -r "${LOOM_SHARING_SHARES_FILE}" ] \
      || die "LOOM_SHARING_SHARES_FILE=${LOOM_SHARING_SHARES_FILE} is not readable."
    cat "${LOOM_SHARING_SHARES_FILE}"
    return 0
  fi
  echo "shares: []"
}

render_config() {
  bearer="${LOOM_SHARING_BEARER:-}"
  # FAIL CLOSED. Upstream treats a missing `authorization` block as "no
  # authentication required" — every share on the server would be readable by
  # anything that can open a socket to it. There is no deployment of this
  # container where that is acceptable, so there is no code path that renders
  # a config without a bearer.
  if [ -z "${bearer}" ]; then
    die "LOOM_SHARING_BEARER is empty. The Delta Sharing reference server accepts UNAUTHENTICATED calls when no bearer is configured, which would expose every published share to anything on the VNet. Wire sharingBearerSecretUri (a Key Vault secret URI) on platform/fiab/bicep/modules/compute/loom-sharing-app.bicep. See docs/fiab/security/loom-sharing-threat-model.md."
  fi

  cat <<EOF
version: 1
host: "${LOOM_SHARING_HOST:-0.0.0.0}"
port: ${LOOM_SHARING_PORT:-8080}
endpoint: "${LOOM_SHARING_ENDPOINT:-/delta-sharing}"
authorization:
  bearerToken: "${bearer}"
preSignedUrlTimeoutSeconds: ${LOOM_SHARING_URL_TIMEOUT_SECONDS:-900}
temporaryCredentialValiditySeconds: ${LOOM_SHARING_CREDENTIAL_VALIDITY_SECONDS:-900}
deltaTableCacheSize: ${LOOM_SHARING_TABLE_CACHE_SIZE:-10}
stalenessAcceptable: ${LOOM_SHARING_STALENESS_ACCEPTABLE:-false}
evaluatePredicateHints: ${LOOM_SHARING_EVALUATE_PREDICATE_HINTS:-false}
queryTablePageSizeLimit: ${LOOM_SHARING_PAGE_SIZE_LIMIT:-10000}
EOF
  render_shares
}

# ---------------------------------------------------------------------------
# core-site.xml — how the server reads the shared ADLS Gen2 Delta tables.
#
# OAuth client-credentials ONLY. The two alternatives were both rejected:
#   * account keys (fs.azure.account.key.*) — a standing, non-expiring secret
#     with full data-plane rights over the whole account.
#   * managed identity (MsiTokenProvider) — hadoop-azure asks the classic IMDS
#     endpoint (169.254.169.254), which Container Apps does not serve; it hands
#     the identity out over $IDENTITY_ENDPOINT instead. Wiring MSI here would
#     look right in review and fail at runtime. (Same class of bug as the ACA
#     managed-identity parsing issue the Console carries a shim for.)
#
# The client secret arrives as a Container Apps SECRET REFERENCE backed by Key
# Vault — never an inline bicep literal, never an `--set-env-vars` argument.
# The service principal should hold Storage Blob Data READER on the shared
# container(s) and nothing else: this server never writes.
#
# When no ADLS principal is wired the file is not rendered at all. The server
# still boots and serves metadata for shares whose tables it can reach; table
# reads then fail with the storage layer's own error. That is deliberate — a
# fabricated "success" here would be worse than an honest storage 403.
# ---------------------------------------------------------------------------
render_core_site() {
  account="${LOOM_SHARING_ADLS_ACCOUNT}"
  suffix="${LOOM_SHARING_ADLS_SUFFIX:-dfs.core.windows.net}"
  authority="${LOOM_SHARING_AUTHORITY_HOST:-login.microsoftonline.com}"
  tenant="${LOOM_SHARING_ADLS_TENANT:-}"
  client_id="${LOOM_SHARING_ADLS_CLIENT_ID:-}"
  secret="${LOOM_SHARING_ADLS_CLIENT_SECRET:-}"

  if [ -z "${tenant}" ] || [ -z "${client_id}" ] || [ -z "${secret}" ]; then
    die "LOOM_SHARING_ADLS_ACCOUNT=${account} is set but the OAuth principal is incomplete (need LOOM_SHARING_ADLS_TENANT, LOOM_SHARING_ADLS_CLIENT_ID and the LOOM_SHARING_ADLS_CLIENT_SECRET Key Vault secretref). Refusing to start half-configured: the server would list shares it cannot read. Set adlsTenantId/adlsClientId/adlsClientSecretUri on loom-sharing-app.bicep."
  fi

  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!-- Rendered by the loom-sharing entrypoint. Do not edit in place. -->
<configuration>
  <property>
    <name>fs.azure.account.auth.type.${account}.${suffix}</name>
    <value>OAuth</value>
  </property>
  <property>
    <name>fs.azure.account.oauth.provider.type.${account}.${suffix}</name>
    <value>org.apache.hadoop.fs.azurebfs.oauth2.ClientCredsTokenProvider</value>
  </property>
  <property>
    <name>fs.azure.account.oauth2.client.endpoint.${account}.${suffix}</name>
    <value>https://${authority}/${tenant}/oauth2/token</value>
  </property>
  <property>
    <name>fs.azure.account.oauth2.client.id.${account}.${suffix}</name>
    <value>${client_id}</value>
  </property>
  <property>
    <name>fs.azure.account.oauth2.client.secret.${account}.${suffix}</name>
    <value>${secret}</value>
  </property>
</configuration>
EOF
}

note_no_adls() {
  echo "[loom-sharing] NOTICE: no LOOM_SHARING_ADLS_ACCOUNT — no storage credential is configured. Share/table METADATA is served, but reading a table's files will fail at the storage layer until adlsAccount + the OAuth principal are wired on loom-sharing-app.bicep." >&2
}

# Dry-run mode (used by apps/loom-sharing/tests/entrypoint.test.mjs): render the
# config to stdout and exit without starting the JVM, so the rendering logic —
# including every fail-closed branch — is unit-testable with no server.
if [ "${LOOM_SHARING_DRYRUN:-}" = "1" ]; then
  echo "=== delta-sharing-server.yaml ==="
  render_config
  if [ -n "${LOOM_SHARING_ADLS_ACCOUNT:-}" ]; then
    echo "=== core-site.xml ==="
    render_core_site
  else
    note_no_adls
  fi
  exit 0
fi

mkdir -p "${CONF_DIR}"
# 0600 BEFORE the write: the file carries the server bearer, and a config that
# is briefly world-readable is still a config that was world-readable.
: > "${CONFIG_FILE}"
chmod 0600 "${CONFIG_FILE}"
render_config > "${CONFIG_FILE}"

if [ -n "${LOOM_SHARING_ADLS_ACCOUNT:-}" ]; then
  mkdir -p "${HADOOP_CONF_DIR}" 2>/dev/null || true
  [ -w "${HADOOP_CONF_DIR}" ] \
    || die "Hadoop conf dir ${HADOOP_CONF_DIR} is not writable by $(id -un). It must be on the server launcher classpath AND writable at runtime — check the chown in apps/loom-sharing/Dockerfile."
  : > "${HADOOP_CONF_DIR}/core-site.xml"
  chmod 0600 "${HADOOP_CONF_DIR}/core-site.xml"
  render_core_site > "${HADOOP_CONF_DIR}/core-site.xml"
else
  note_no_adls
fi

echo "[loom-sharing] starting the Delta Sharing reference server on :${LOOM_SHARING_PORT:-8080}${LOOM_SHARING_ENDPOINT:-/delta-sharing} (adls=${LOOM_SHARING_ADLS_ACCOUNT:-none})"
cd "${APP_HOME}"
# sbt-native-packager launcher: everything after `--` is passed to the app.
exec "${APP_HOME}/bin/delta-sharing-server" -- --config "${CONFIG_FILE}"
