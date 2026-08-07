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
CONFIG_DIR="${TRINO_CONFIG_DIR:-/etc/trino}"
mkdir -p "$CATALOG_DIR"

log() { echo "[loom-trino] $*"; }

# ── AUTHENTICATION — ON BY DEFAULT, SEALED WHEN UNPINNABLE ───────────────────
# Round-3 fix (PR #2641). "Default-ON" must mean SAFE by default, not merely
# running: internal ACA ingress only means "reachable by everything already on
# the VNet", and with no `http-server.authentication.type` ANY such workload
# could POST /v1/statement with an arbitrary X-Trino-User — bypassing the BFF
# session check AND the data-access audit row. This mirrors the SEALED shape
# PR #2638 applies to loom-unity.
#
#   LOOM_TRINO_AUTH_MODE=entra (DEFAULT)
#     Trino's JWT authenticator is enabled and the accepted AUDIENCE is pinned.
#       * audience pinned to a real Entra app  -> the Console BFF (which already
#         mints a UAMI token for it, lib/azure/trino-client.ts) is admitted and
#         every other in-VNet caller is rejected 401.
#       * NO audience available (fresh deploy, before the sign-in app
#         registration exists) -> the audience is pinned to the SENTINEL
#         `api://loom-trino-sealed.invalid`, which no tenant can ever mint a
#         token for. The engine is UP and serves NOBODY. Combined with
#         minReplicas 0 that costs nothing and cannot be silently open.
#     Never a silent downgrade to anonymous, and never a CrashLoopBackOff.
#
#   LOOM_TRINO_AUTH_MODE=disabled
#     Explicit, audited opt-out (the pre-#2641 posture: VNet as the only
#     perimeter). A SECURITY WARNING is logged on every boot and the Console
#     env-check reports it as failing.
#
# /v1/info stays reachable unauthenticated by design — upstream annotates it
# @ResourceSecurity(PUBLIC) — so the Container App startup/readiness/liveness
# probes keep working with authentication enabled.
AUTH_MODE=$(printf '%s' "${LOOM_TRINO_AUTH_MODE:-entra}" | tr '[:upper:]' '[:lower:]')
SEALED_AUDIENCE='api://loom-trino-sealed.invalid'
AUTH_CONF="$CONFIG_DIR/config.properties"
USER_MAP_FILE="$CONFIG_DIR/jwt-user-mapping.json"
SEALED_KEY_FILE="$CONFIG_DIR/jwt-sealed.key"

if [ "$AUTH_MODE" = "disabled" ]; then
  log "SECURITY WARNING: LOOM_TRINO_AUTH_MODE=disabled — the engine accepts UNAUTHENTICATED queries from anything that can reach it on the VNet (sibling container, peered network, admin P2S VPN), with an arbitrary X-Trino-User. This is an explicit opt-out of the default posture."
else
  AUDIENCE="${LOOM_TRINO_REQUIRED_AUDIENCE:-}"
  JWKS="${LOOM_TRINO_JWKS_URL:-}"
  # Any authenticator requires the cluster's internal shared secret. Single
  # process, so the value only has to exist and be unguessable for this boot.
  SHARED_SECRET=$(tr -dc 'a-f0-9' < /dev/urandom 2>/dev/null | head -c 64 || true)
  [ -n "$SHARED_SECRET" ] || SHARED_SECRET="loom-$(date -u +%s)-${HOSTNAME:-trino}"

  if [ -z "$AUDIENCE" ]; then
    AUDIENCE="$SEALED_AUDIENCE"
    log "SEALED: no LOOM_TRINO_REQUIRED_AUDIENCE was supplied, so the JWT audience is pinned to '${SEALED_AUDIENCE}'. Authorization is ENFORCED and every caller is rejected until an Entra app registration is pinned (set LOOM_MSAL_CLIENT_ID / loomBackends.trinoAudienceClientId and redeploy). The engine is up; it serves nobody."
  fi
  if [ -z "$JWKS" ]; then
    # No verification key => nothing can be validated. Stay UP but sealed:
    # a locally generated HMAC secret nobody else holds fails every signature.
    printf '%s' "$SHARED_SECRET" > "$SEALED_KEY_FILE"
    JWKS="$SEALED_KEY_FILE"
    log "SEALED: no LOOM_TRINO_JWKS_URL was supplied — falling back to a boot-local HMAC key, so every presented token fails signature validation."
  fi

  # Map ANY authenticated principal onto ONE Trino session user. Trino's default
  # system access control denies impersonation, so the session user must equal
  # the mapped principal; the real Loom UPN rides X-Trino-Client-Info / client
  # tags and is what the Cosmos _auditLog row records.
  MAPPED_USER="${LOOM_TRINO_SESSION_USER:-loom-console}"
  printf '{"rules":[{"pattern":"(.*)","user":"%s"}]}\n' "$MAPPED_USER" > "$USER_MAP_FILE"

  {
    echo ""
    echo "# ── rendered by docker-entrypoint.sh (LOOM_TRINO_AUTH_MODE=${AUTH_MODE}) ──"
    echo "http-server.authentication.type=JWT"
    echo "http-server.authentication.jwt.key-file=${JWKS}"
    echo "http-server.authentication.jwt.required-audience=${AUDIENCE}"
    echo "http-server.authentication.jwt.principal-field=${LOOM_TRINO_PRINCIPAL_FIELD:-sub}"
    echo "http-server.authentication.jwt.user-mapping.file=${USER_MAP_FILE}"
    # TLS terminates at the Container Apps ingress; process-forwarded (baked in
    # config.properties) makes Trino treat the forwarded request as secure, and
    # this re-enables the plain-HTTP hop the ingress uses to reach the container.
    echo "http-server.authentication.allow-insecure-over-http=true"
    echo "internal-communication.shared-secret=${SHARED_SECRET}"
    # Issuer pinning is OPTIONAL and OFF unless supplied: Entra issues v1
    # (https://sts.windows.net/<tid>/) or v2
    # (https://login.microsoftonline.us/<tid>/v2.0) issuers depending on the app
    # registration's accessTokenAcceptedVersion, and required-issuer takes ONE
    # value — pinning the wrong form would seal the engine shut permanently.
    # The audience is the control that matters and it is always pinned.
    if [ -n "${LOOM_TRINO_REQUIRED_ISSUER:-}" ]; then
      echo "http-server.authentication.jwt.required-issuer=${LOOM_TRINO_REQUIRED_ISSUER}"
    fi
  } >> "$AUTH_CONF"
  if [ "$AUDIENCE" = "$SEALED_AUDIENCE" ]; then
    log "authentication: JWT ENFORCED, posture=SEALED (audience ${AUDIENCE})"
  else
    log "authentication: JWT ENFORCED, posture=entra (audience ${AUDIENCE}, keys ${JWKS})"
  fi
fi

# ── ENGINE-LEVEL CATALOG AUTHORIZATION — file-based system access control ─────
# Round-4 fix (#2678). Authentication (the JWT block above) proves WHO a caller
# is; it does NOT decide WHAT they may query. Round 3 shipped no
# `access-control.properties`, so the engine fell through to Trino's built-in
# AllowAllSystemAccessControl: any authenticated caller could query EVERY
# catalog. This block renders a DENY-BY-DEFAULT file-based system access control:
# only the catalogs actually rendered below are reachable (read-only, except the
# `memory` scratch catalog); every other catalog — including a phantom or a
# properties file dropped in later without a matching rule — is denied. Trino
# evaluates rules top-to-bottom and DENIES anything unmatched, and with no
# impersonation/principal rules present impersonation is denied too.
#
# The rule matches ANY Trino user (no `user` field), so it is uniform across the
# entra-mapped `loom-console` user AND a disabled-mode caller — the engine floor
# does not depend on the mapping. PER-CALLER narrowing (which Loom group may
# reach which catalog) is enforced at the BFF (lib/azure/trino-authz.ts), because
# every caller maps to one Trino user here; restoring the signed-in principal at
# the engine (for per-group engine rules) needs delegated tokens / an
# impersonation file and is the documented follow-up.
#
# Reversible without an image rebuild: LOOM_TRINO_ACCESS_CONTROL=none disables it
# (allow-all) and logs a SECURITY WARNING — an env flip, so a config problem can
# never hard-brick the engine.
ACCESS_CONTROL_MODE=$(printf '%s' "${LOOM_TRINO_ACCESS_CONTROL:-file}" | tr '[:upper:]' '[:lower:]')
RULES_TMP="$CONFIG_DIR/.loom-catalog-rules.jsonl"
: > "$RULES_TMP"
add_catalog_rule() {
  # $1 = catalog name (verbatim), $2 = allow (all|read-only|none). The name is a
  # regex in Trino's matcher; anchor it so "sales" cannot also match "sales_pii".
  printf '    {"catalog": "^%s$", "allow": "%s"},\n' "$1" "$2" >> "$RULES_TMP"
}
# `system` is always present (built-in); read-only for user queries.
add_catalog_rule "system" "read-only"

# ── Always-present, zero-dependency catalogs ─────────────────────────────────
# jmx: engine self-observability (queries against the running JVM's MBeans).
# memory: a real, writable scratch catalog so CREATE TABLE AS / temp joins work
#         out of the box. Both are in-process — no network, no credentials — so
#         both are available in an air-gapped enclave.
cat > "$CATALOG_DIR/jmx.properties" <<'EOF'
connector.name=jmx
EOF
add_catalog_rule "jmx" "read-only"
cat > "$CATALOG_DIR/memory.properties" <<'EOF'
connector.name=memory
memory.max-data-per-node=512MB
EOF
# memory is a writable scratch catalog (CREATE TABLE AS / temp joins) -> `all`.
add_catalog_rule "memory" "all"

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
  # The Loom lake is read-only federation (writes go through the item editors).
  add_catalog_rule "$CATALOG_NAME" "read-only"
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
      # External federation sources are read-only at the engine floor; the BFF
      # (trino-authz.ts) additionally decides WHICH callers may reach them.
      add_catalog_rule "$NAME" "read-only"
      log "wired operator catalog '${NAME}'"
      ;;
  esac
done

log "catalogs: $(ls -1 "$CATALOG_DIR" | tr '\n' ' ')"

# ── Emit the deny-by-default access control (rendered from the catalogs above) ─
# This is the LOCAL FLOOR and it is written FIRST, unconditionally, so the engine
# always has a valid, restrictive rules file even if every network call below
# fails. The governance fetch (LU-7) then OVERWRITES this file with the richer
# Loom-compiled document; if it cannot, this floor is what stays in force.
if [ "$ACCESS_CONTROL_MODE" = "none" ]; then
  rm -f "$RULES_TMP"
  log "SECURITY WARNING: LOOM_TRINO_ACCESS_CONTROL=none — engine catalog authorization is DISABLED (Trino AllowAll). Any authenticated caller can query EVERY catalog. This is an explicit opt-out of the deny-by-default engine floor; the BFF still enforces per-caller catalog authorization."
else
  RULES_FILE="$CONFIG_DIR/access-control-rules.json"
  {
    echo '{'
    echo '  "catalogs": ['
    cat "$RULES_TMP"
    # Trailing catch-all: any catalog not rendered above is DENIED (belt-and-
    # suspenders — Trino already denies an unmatched catalog).
    echo '    {"catalog": ".*", "allow": "none"}'
    echo '  ]'
    echo '}'
  } > "$RULES_FILE"
  rm -f "$RULES_TMP"
  cat > "$CONFIG_DIR/access-control.properties" <<EOF
access-control.name=file
security.config-file=${RULES_FILE}
security.refresh-period=${LOOM_TRINO_POLICY_REFRESH_SECONDS:-60}s
EOF
  log "engine authorization: file-based system access control ENABLED (deny-by-default); rules -> ${RULES_FILE}"
fi

# ── LU-7: GOVERNANCE-COMPILED ENGINE AUTHORIZATION ───────────────────────────
# Everything above is the deployment's own floor: which catalogs exist and
# whether they are readable. It knows NOTHING about Loom's governance, so before
# LU-7 a federated query's row/column policy was whatever the source system
# happened to enforce — the engine trusted itself.
#
# LOOM_TRINO_POLICY_URL points at the Console's engine-rules endpoint, which
# compiles the SAME policy-as-code set that already drives Synapse / Unity
# Catalog / ADX into a Trino file-based access-control document: table grants,
# explicit denies, ROW FILTERS and COLUMN MASKS, plus the impersonation rule
# that lets the BFF present the signed-in Loom user so those rules match a REAL
# principal instead of the collapsed session user. The document the Console
# returns CARRIES the catalog floor above (the engine sends its own catalog list
# with the request), so overwriting the file never widens catalog reachability.
#
# The fetch happens HERE, not in Trino, for one reason: Trino's
# `security.config-file` accepts an HTTP URL but issues a plain GET with no way
# to attach a credential, and this document names group ids, table names and row
# predicates. So the entrypoint does the AUTHENTICATED fetch (the shared
# deployment token in a HEADER — never in the URL, because Trino logs the
# configured URI on failure), writes the result to the local rules file, and a
# background loop repeats it. Trino's own `security.refresh-period` (set above)
# then re-reads that file, so a policy edit in the Console reaches the engine
# within one interval with NO redeploy, NO image rebuild and NO operator plumbing.
#
# FAIL-CLOSED IN BOTH DIRECTIONS:
#   * The URL is unset  -> the locally rendered catalog floor stays in force.
#     Governance simply is not published yet; the engine is not more permissive
#     than it was.
#   * The fetch FAILS   -> the last good rules file is kept and the failure is
#     logged loudly. We never rewrite the file with a partial/empty body, and we
#     never downgrade to allow-all because the Console was briefly unreachable.
#   * The body is not a JSON object -> rejected, same as a failure. A truncated
#     response must not become the authorization policy.
POLICY_URL="${LOOM_TRINO_POLICY_URL:-}"
POLICY_TOKEN="${LOOM_TRINO_POLICY_TOKEN:-${LOOM_INTERNAL_TOKEN:-}}"
POLICY_REFRESH="${LOOM_TRINO_POLICY_REFRESH_SECONDS:-60}"
GROUP_FILE="$CONFIG_DIR/loom-groups.txt"

# The catalog list this boot actually wired — handed to the Console so the
# document it returns carries the SAME catalogs `SHOW CATALOGS` will list. The
# console never guesses the engine's catalog set.
WIRED_CATALOGS=$(ls -1 "$CATALOG_DIR" 2>/dev/null | sed 's/\.properties$//' | tr '\n' ',' | sed 's/,$//')
WIRED_CATALOGS="system,${WIRED_CATALOGS}"

fetch_policy() {
  # $1 = destination file, $2 = format (rules|groups)
  _dest="$1"; _fmt="$2"
  _tmp="${_dest}.tmp.$$"
  _url="${POLICY_URL}?format=${_fmt}&catalogs=${WIRED_CATALOGS}&writable=memory"
  if ! curl -fsS --max-time 20 \
        -H "x-loom-internal-token: ${POLICY_TOKEN}" \
        -H 'accept: application/json' \
        "$_url" -o "$_tmp"; then
    rm -f "$_tmp"
    return 1
  fi
  if [ "$_fmt" = "rules" ]; then
    # SHAPE VALIDATION, not a one-byte sniff. Per the Trino docs "if no rules
    # are provided at all, then access is granted" — so a body that parses as
    # JSON but carries no `tables` section is ALLOW-ALL. Overwriting the local
    # deny-by-default floor with such a body would be a silent fail-OPEN, which
    # is the exact opposite of what this function exists to prevent. `curl -f`
    # already rejects an HTTP error, but a proxy that returns 200 with an
    # interstitial, or a truncated body, would both slip past a first-byte
    # check. Require: starts with `{`, and carries BOTH the sections that make
    # the document restrictive.
    _head=$(head -c 1 "$_tmp" 2>/dev/null || true)
    if [ "$_head" != "{" ]; then
      log "governance: rejected a rules body that is not a JSON object (first byte '${_head}')"
      rm -f "$_tmp"
      return 2
    fi
    if ! grep -q '"tables"' "$_tmp" || ! grep -q '"catalogs"' "$_tmp"; then
      log "governance: rejected a rules body missing the \"tables\"/\"catalogs\" sections — a rules document without them is ALLOW-ALL, so it must never replace the deny-by-default floor"
      rm -f "$_tmp"
      return 2
    fi
  fi
  mv -f "$_tmp" "$_dest"
  return 0
}

if [ "$ACCESS_CONTROL_MODE" != "none" ] && [ -n "$POLICY_URL" ]; then
  if [ -z "$POLICY_TOKEN" ]; then
    log "SECURITY WARNING: LOOM_TRINO_POLICY_URL is set but no LOOM_TRINO_POLICY_TOKEN / LOOM_INTERNAL_TOKEN is present, so the governance-compiled rules CANNOT be fetched (the Console rejects an unauthenticated pull). The engine keeps the locally rendered catalog floor; Loom row/column policy is NOT enforced at the engine."
  elif ! command -v curl >/dev/null 2>&1; then
    log "SECURITY WARNING: curl is not present in this image, so the governance-compiled rules cannot be fetched. The engine keeps the locally rendered catalog floor; Loom row/column policy is NOT enforced at the engine."
  else
    if fetch_policy "$CONFIG_DIR/access-control-rules.json" rules; then
      log "governance: fetched Loom-compiled engine rules from the Console (catalogs=${WIRED_CATALOGS})"
      # Group memberships (file group provider) — needed for group-keyed rules.
      if fetch_policy "$GROUP_FILE" groups && [ -s "$GROUP_FILE" ]; then
        cat > "$CONFIG_DIR/group-provider.properties" <<EOF
group-provider.name=file
file.group-file=${GROUP_FILE}
file.refresh-period=${POLICY_REFRESH}s
EOF
        log "governance: file group provider enabled ($(wc -l < "$GROUP_FILE" | tr -d ' ') group(s))"
      else
        log "governance: no group memberships published; group-keyed rules will not match until the Console reconcile resolves them."
      fi
    else
      log "SECURITY WARNING: could not fetch the governance-compiled engine rules from ${POLICY_URL} (Console unreachable, unauthorized, or a non-JSON body). KEEPING the locally rendered catalog floor — the engine is NOT downgraded to allow-all, but Loom row/column policy is NOT enforced at the engine this boot. The refresh loop will retry."
    fi

    # Refresh loop — Trino re-reads the rules file on `security.refresh-period`,
    # so rewriting it in place is what makes a Console policy edit take effect
    # without a restart. A failed refresh leaves the previous file intact.
    (
      while true; do
        sleep "$POLICY_REFRESH"
        if fetch_policy "$CONFIG_DIR/access-control-rules.json" rules; then
          fetch_policy "$GROUP_FILE" groups || true
        else
          echo "[loom-trino] governance refresh failed; keeping the rules currently in force"
        fi
      done
    ) &
  fi
elif [ "$ACCESS_CONTROL_MODE" != "none" ]; then
  log "governance: LOOM_TRINO_POLICY_URL is unset — the engine enforces the catalog floor only. Loom row/column policy is enforced at the BFF (lib/azure/trino-authz.ts) but NOT at the engine."
fi

exec "$@"
