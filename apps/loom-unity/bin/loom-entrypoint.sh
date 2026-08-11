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
#   etc/conf/hibernate.properties   persistence (Postgres default, H2 fallback)
#   etc/conf/server.properties      Entra authorization (LU-2) + optional ADLS vending
#
# Persistence (LU-1): the DEFAULT deployed posture is an Entra-only, private-
# endpoint-only Azure Database for PostgreSQL Flexible Server — the bicep module
# passes LOOM_UNITY_DB_URL + LOOM_UNITY_DB_USER + LOOM_UNITY_DB_AUTH=entra and no
# password exists anywhere. When no LOOM_UNITY_DB_URL is wired at all (local dev,
# or a deployment that has not provisioned Postgres yet) this falls back to the
# legacy H2 file DB in $LOOM_UNITY_DB_DIR; on first boot, if that dir is empty,
# the image's seeded schema is copied in so the server starts against a valid DB.
# The H2 fallback is single-writer and is known to CrashLoopBackOff on Azure
# Government's SMB mount — see the resilience block below and docs/fiab/unity-gov.md.
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

die() {
  echo "[loom-unity] FATAL: $*" >&2
  exit 1
}

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
#
# LU-1. Postgres is the DEPLOYED DEFAULT (the bicep module wires it); H2 is the
# fallback for local dev and for deployments that have not provisioned Postgres.
#
# Entra ("passwordless") mode is the default whenever Postgres is in play, and it
# matches the server: loom-unity-postgres.bicep creates the flexible server with
# authConfig.passwordAuth=Disabled, so there is NO database password to render,
# rotate, or leak. pgjdbc's `authenticationPluginClassName` hook makes the driver
# mint a fresh Microsoft Entra access token for every physical connection — the
# only correct mechanism here, because a token baked into this file at boot
# expires within the hour and the catalog would fail authentication long after it
# looked healthy. The plugin class ships in the image (apps/loom-unity/java,
# installed on the classpath by the Dockerfile).
# ---------------------------------------------------------------------------
render_hibernate() {
  db_url="${LOOM_UNITY_DB_URL:-}"
  if [ -n "${db_url}" ] && printf '%s' "${db_url}" | grep -qi '^jdbc:postgresql:'; then
    db_auth="${LOOM_UNITY_DB_AUTH:-entra}"
    db_user="${LOOM_UNITY_DB_USER:-}"
    # FAIL CLOSED. With Entra-only auth the PostgreSQL ROLE name must equal the
    # Entra principal name the token was minted for; an empty username silently
    # becomes a connection attempt as the OS user, which the server rejects with
    # an opaque auth error minutes into the boot. Name the exact variable instead.
    if [ -z "${db_user}" ]; then
      die "Postgres persistence is wired (LOOM_UNITY_DB_URL) but LOOM_UNITY_DB_USER is empty. Set it to the Entra principal name of the loom-unity managed identity (the loom-unity-postgres.bicep 'aadUser' output). See docs/fiab/unity-gov.md."
    fi

    # Query-string assembly: preserve anything the operator already put on the
    # URL, then add TLS (mandatory on Azure Database for PostgreSQL) and, in
    # Entra mode, the authentication plugin.
    db_sep='?'
    case "${db_url}" in
      *\?*) db_sep='&' ;;
    esac
    db_params=''
    case "${db_url}" in
      *sslmode=*) ;;
      *) db_params="${db_sep}sslmode=require"; db_sep='&' ;;
    esac

    if [ "${db_auth}" = "password" ]; then
      # Explicit, audited opt-out for a BYO Postgres that still uses password
      # auth. The password arrives as a Key Vault secretref, never inline.
      if [ -z "${LOOM_UNITY_DB_PASSWORD:-}" ]; then
        die "LOOM_UNITY_DB_AUTH=password but LOOM_UNITY_DB_PASSWORD is empty. Wire dbPasswordSecretUri (a Key Vault secret URI) on loom-unity-app.bicep, or use the default LOOM_UNITY_DB_AUTH=entra with an Entra-only server."
      fi
      echo "[loom-unity] NOTICE: Postgres is using PASSWORD authentication (LOOM_UNITY_DB_AUTH=password). The Loom-provisioned server is Entra-only (passwordAuth=Disabled) and needs no credential; this path exists for a BYO server only." >&2
      # BOTH `username` AND `user` are rendered, deliberately (finishline D2,
      # root-caused live): Hibernate reads `hibernate.connection.username`, but
      # upstream JCasbinAuthorizer reads `hibernate.connection.user` verbatim
      # (JCasbinAuthorizer.java: properties.getProperty("hibernate.connection.user"))
      # to build its casbin JDBCAdapter. With only `username` rendered the
      # authorizer connected as user=null -> the OS user, which is no role on
      # the server, and the boot died with upstream's cause-swallowed
      # "Problem initializing authorizer." Unknown extra keys are ignored by
      # Hibernate, so the duplicate is harmless there.
      cat <<EOF
hibernate.connection.driver_class=org.postgresql.Driver
hibernate.connection.url=${db_url}${db_params}
hibernate.connection.username=${db_user}
hibernate.connection.user=${db_user}
hibernate.connection.password=${LOOM_UNITY_DB_PASSWORD}
hibernate.dialect=org.hibernate.dialect.PostgreSQLDialect
hibernate.hbm2ddl.auto=${LOOM_UNITY_DB_DDL:-update}
hibernate.show_sql=false
hibernate.archive.autodetection=class
EOF
    else
      if [ -z "${AZURE_CLIENT_ID:-}" ]; then
        echo "[loom-unity] WARNING: AZURE_CLIENT_ID is unset. The Entra Postgres plugin will ask the managed-identity endpoint for a SYSTEM-assigned token; on a Container App with a user-assigned identity that request fails or returns the wrong identity. Set unityUamiClientId on loom-unity-app.bicep. See docs/fiab/unity-gov.md." >&2
      fi
      db_params="${db_params}${db_sep}authenticationPluginClassName=ai.limitlessdata.loom.unity.EntraPostgresAuthPlugin"
      # NOTE: no hibernate.connection.password line at all — the driver plugin
      # supplies the token. Rendering an empty password here would make pgjdbc
      # skip the plugin and send an empty cleartext password. (JCasbinAuthorizer
      # reads the absent key as null and passes it to its JDBCAdapter, whose
      # connection then also authenticates via the plugin named on the URL.)
      #
      # BOTH `username` AND `user` are rendered, deliberately (finishline D2,
      # root-caused live): Hibernate reads `hibernate.connection.username`, but
      # upstream JCasbinAuthorizer reads `hibernate.connection.user` verbatim
      # (JCasbinAuthorizer.java: properties.getProperty("hibernate.connection.user"))
      # to build its casbin JDBCAdapter. With only `username` rendered the
      # authorizer connected as user=null -> the OS user, which is no role on
      # the Entra-only server, and the boot died with upstream's cause-swallowed
      # "Problem initializing authorizer." Unknown extra keys are ignored by
      # Hibernate, so the duplicate is harmless there.
      cat <<EOF
hibernate.connection.driver_class=org.postgresql.Driver
hibernate.connection.url=${db_url}${db_params}
hibernate.connection.username=${db_user}
hibernate.connection.user=${db_user}
hibernate.dialect=org.hibernate.dialect.PostgreSQLDialect
hibernate.hbm2ddl.auto=${LOOM_UNITY_DB_DDL:-update}
hibernate.show_sql=false
hibernate.archive.autodetection=class
EOF
    fi
  else
    # FALLBACK — H2 file DB on the mounted (or local ephemeral) volume.
    # DB_CLOSE_DELAY=-1 keeps the in-JVM DB alive across connection close; the
    # .mv.db file is what persists on Azure Files.
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
    # protocol entirely — safe ONLY because this path pins the Container App to
    # exactly one replica (loom-unity-app.bicep forces maxReplicas:1 whenever
    # Postgres is absent) and Azure Files (SMB) can't honor H2's default
    # file-lock semantics (the second Gov first-boot crash after the
    # credentials fix).
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

# Entra authority host — Commercial by default; Azure Government deployments pass
# login.microsoftonline.us. Sovereign hosts are NEVER hard-coded on a code path;
# the bicep module derives this from environment().authentication.loginEndpoint.
unity_authority_host() {
  printf '%s' "${LOOM_UNITY_AUTHORITY_HOST:-login.microsoftonline.com}"
}

# The two OIDC discovery URLs whose `issuer` fields are the tenant's authoritative
# v1.0 and v2.0 issuer strings, at whichever authority host this deployment runs.
#
# PURE — builds strings, touches no network. Kept separate from the fetch so the
# per-cloud correctness (Commercial vs Government vs any future sovereign host)
# is assertable offline, in the same spirit as idp_probe_plan(): a decision only
# exercisable against a live IdP is a decision nobody notices has gone wrong.
discovery_urls() {
  du_authority="$1"
  du_tenant="$2"
  # v1.0 first — that is the one whose absence caused the live 401 "Invalid
  # issuer", so if the output is ever truncated it is the one still visible.
  printf 'https://%s/%s/.well-known/openid-configuration\n' "${du_authority}" "${du_tenant}"
  printf 'https://%s/%s/v2.0/.well-known/openid-configuration\n' "${du_authority}" "${du_tenant}"
}

# Fetch ONE discovery document and echo its `issuer` verbatim.
# Echoes nothing and returns 1 on any failure — unreachable, non-200, or no
# `issuer` field. Never invents or infers a value.
discovery_issuer() {
  di_url="$1"

  # TEST SEAM (offline only). When LOOM_UNITY_DISCOVERY_DOC_DIR is set, the
  # documents are read from <dir>/v1.json and <dir>/v2.json instead of fetched,
  # so the extraction and fail-closed logic are testable with no network and no
  # live tenant.
  #
  # This grants NO capability that does not already exist: LOOM_UNITY_ALLOWED_ISSUERS
  # already lets an operator set the trusted issuers to anything at all, so a seam
  # that only changes where the same bytes are read from is strictly weaker. It
  # replaces the TRANSPORT only — extraction, validation and fail-closed run
  # identically on both paths.
  if [ -n "${LOOM_UNITY_DISCOVERY_DOC_DIR:-}" ]; then
    case "${di_url}" in
      */v2.0/.well-known/openid-configuration) di_file="${LOOM_UNITY_DISCOVERY_DOC_DIR}/v2.json" ;;
      *) di_file="${LOOM_UNITY_DISCOVERY_DOC_DIR}/v1.json" ;;
    esac
    [ -f "${di_file}" ] || return 1
    di_body="$(cat "${di_file}")" || return 1
  else
    # Same transport shape as probe_idp_reachability: one request per attempt
    # with the status appended to the body, so body and code always come from
    # the SAME response; bounded retries because DNS and the CNI can lag a cold
    # ACA replica by seconds. `|| true` guards curl's non-zero exit under set -e.
    # Bounded retries. Configurable so the fail-closed path is testable in
    # seconds rather than the ~90s a full retry budget would take; production
    # never sets it and gets the full budget.
    di_max="${LOOM_UNITY_DISCOVERY_RETRIES:-6}"
    di_try=0
    di_body=""
    while [ "${di_try}" -lt "${di_max}" ]; do
      di_resp="$(curl -sS -m 10 -w '\n%{http_code}' "${di_url}" 2>/dev/null)" || true
      di_code="$(printf '%s' "${di_resp}" | tail -n 1)"
      [ -n "${di_code}" ] || di_code="000"
      if [ "${di_code}" = "200" ]; then
        di_body="$(printf '%s' "${di_resp}" | sed '$d')"
        break
      fi
      di_try=$((di_try + 1))
      [ "${di_try}" -lt "${di_max}" ] && sleep 5
    done
    [ -n "${di_body}" ] || return 1
  fi

  # No jq in the upstream image. Same extraction the jwks_uri probe uses:
  # squeeze whitespace so a pretty-printed document parses too (a URL cannot
  # contain whitespace, so this cannot corrupt the value).
  di_issuer="$(printf '%s' "${di_body}" | tr -d ' \011\012\015' | grep -o '"issuer":"[^"]*"' | head -n 1 | cut -d'"' -f4)"
  [ -n "${di_issuer}" ] || return 1
  printf '%s' "${di_issuer}"
}

# Both issuers for this tenant, comma-joined, taken verbatim from discovery.
# Echoes nothing and returns 1 unless BOTH resolve — the caller fails closed.
derive_issuers_from_discovery() {
  df_authority="$1"
  df_tenant="$2"
  df_out=""
  for df_url in $(discovery_urls "${df_authority}" "${df_tenant}"); do
    df_issuer="$(discovery_issuer "${df_url}")" || return 1
    [ -n "${df_issuer}" ] || return 1
    case ",${df_out}," in
      *",${df_issuer},"*) continue ;;   # a tenant may publish the same issuer twice
    esac
    if [ -z "${df_out}" ]; then df_out="${df_issuer}"; else df_out="${df_out},${df_issuer}"; fi
  done
  [ -n "${df_out}" ] || return 1
  printf '%s' "${df_out}"
}

render_server() {
  tenant="${LOOM_UNITY_ENTRA_TENANT_ID:-}"
  client_id="${LOOM_UNITY_ENTRA_CLIENT_ID:-}"
  authority="$(unity_authority_host)"

  # DEFAULT-ON, FAIL-CLOSED. Authorization is ENABLED unless the operator
  # explicitly sets LOOM_UNITY_AUTH=disable (an audited opt-out, not a silent
  # default). Until the svc-loom-unity-authz fix this block inferred `disable`
  # whenever no tenant happened to be wired — so ANY caller that forgot one env
  # var got a catalog that anything on the VNet could read AND mutate, and the
  # only signal was a stderr line nobody reads. An unconfigured server now
  # refuses to boot (see the issuer/audience checks below) instead of opening.
  auth="${LOOM_UNITY_AUTH:-enable}"

  authz_url="${LOOM_UNITY_AUTHORIZATION_URL:-}"
  token_url="${LOOM_UNITY_TOKEN_URL:-}"
  issuers="${LOOM_UNITY_ALLOWED_ISSUERS:-}"
  audiences="${LOOM_UNITY_AUDIENCES:-}"
  # NOTE: plain `if` blocks, not `[ … ] && x=y` one-liners — `set -e` is on and a
  # false AND-list at statement level would abort the boot.
  if [ -n "${tenant}" ]; then
    if [ -z "${authz_url}" ]; then authz_url="https://${authority}/${tenant}/oauth2/v2.0/authorize"; fi
    if [ -z "${token_url}" ]; then token_url="https://${authority}/${tenant}/oauth2/v2.0/token"; fi
    # BOTH Entra issuer forms for THIS tenant, taken VERBATIM from the tenant's
    # own OIDC discovery documents. No hostname table, no per-cloud branch.
    #
    # WHY BOTH. Microsoft Entra emits the token version the RESOURCE app asks
    # for, not the one the client wants: "The values of null and 1 result in
    # v1.0 tokens, and the value of 2 results in v2.0 tokens", and "Resources
    # always own their tokens ... and are the only applications that can change
    # their token details."
    #   https://learn.microsoft.com/entra/identity-platform/access-tokens#token-formats
    # The Console app registration has requestedAccessTokenVersion = null, so
    # every token minted for api://<client-id> is v1.0. Deriving only the v2.0
    # form made the catalog reject its OWN TENANT'S tokens — measured live
    # 2026-08-08, after the token-exchange body was fixed:
    #   HTTP 401 {"error_code":"UNAUTHENTICATED","message":"Invalid issuer"}
    # Accepting both is not a widening of trust — same pinned tenant, same
    # signing keys, audience check unchanged — and it keeps working if the app
    # is ever flipped to requestedAccessTokenVersion: 2.
    #
    # WHY DISCOVERY RATHER THAN A HARDCODED STRING. An earlier revision appended
    # a literal "https://sts.windows.net/<tenant>/" and did it ONLY for the
    # Commercial authority, because Microsoft's docs establish that form for
    # Entra ID but do NOT establish the Azure Government equivalent. That left
    # Gov on the broken v2-only path — a Commercial-first fix, which
    # cloud-parity.md forbids. The tenant's own metadata is authoritative for
    # BOTH forms at whichever authority host the deployment already knows, so
    # discovery yields the correct Gov issuer without anyone having to know what
    # it is, and hardcodes no cloud's hostname anywhere.
    #
    # FAIL CLOSED. If either document is unreachable or carries no `issuer`, the
    # boot ABORTS. An unreachable metadata endpoint is an UNKNOWN, and a gate
    # that reads UNKNOWN as "fine" is this program's most expensive defect class.
    # Falling back to a partial or empty allow-list would either wedge every call
    # or, worse, open the door.
    if [ -z "${issuers}" ]; then
      issuers="$(derive_issuers_from_discovery "${authority}" "${tenant}")" || issuers=""
      if [ -z "${issuers}" ]; then
        die "LOOM_UNITY_AUTH=enable but the token issuers could not be derived. Both OIDC discovery documents for tenant ${tenant} at ${authority} must be reachable and carry an \"issuer\" field: https://${authority}/${tenant}/.well-known/openid-configuration (v1.0) and https://${authority}/${tenant}/v2.0/.well-known/openid-configuration (v2.0). Refusing to boot with a partial or empty issuer allow-list — set LOOM_UNITY_ALLOWED_ISSUERS explicitly to override. See docs/fiab/unity-gov.md."
      fi
    fi
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

# ---------------------------------------------------------------------------
# AUTO-BIND — register the Console principal as an ENABLED Unity Catalog user.
#
# WHY THIS EXISTS. Turning `server.authorization=enable` on is only half of a
# working catalog. Upstream `AuthService.verifyPrincipal` (v0.5.0 and v0.5.1,
# read at the tag) resolves the caller from the subject token as:
#
#     subject = claims.getOrDefault(EMAIL, claim(SUBJECT)).asString()
#     if (subject.equals("admin")) -> allow
#     if (user != null && user.getState() == ENABLED) -> allow
#     throw OAuthInvalidRequestException("User not allowed: " + subject)
#
# An Entra **app-only** (client-credentials) token — which is what the Console's
# managed identity mints — carries NO `email` claim, so the subject falls back to
# `sub`, i.e. the service principal's object id. Unless a UC user exists with
# that object id as its email AND is ENABLED, the token exchange at
# /api/1.0/unity-control/auth/tokens answers 401 and the Console cannot talk to
# its own catalog. That is precisely why gov-uc-purview-wire.yml kept deploying
# the audited `authMode=disabled` opt-out: flipping authorization on without this
# step converts "anonymous but working" into "authenticated and unusable".
#
# Per .claude/rules/auto-bind-by-default.md §5 the PLATFORM performs that
# binding — it is not an operator instruction. The server mints its own admin
# token into etc/conf/token.txt at boot, so the container has, locally and
# without any external credential, exactly the authority needed to register the
# principal. This runs in the background against 127.0.0.1 after the JVM is up.
#
# Failure here is LOUD but never fatal: the catalog stays sealed-but-correct
# (every caller refused) rather than being taken down, and probe-loom-unity-authz
# reports the posture from the outside either way.
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# IdP REACHABILITY — is the JWKS endpoint actually reachable from THIS subnet?
#
# WHY THIS EXISTS (#2643 follow-up). With `server.authorization=enable`, upstream
# `JwksOperations.loadJwkProvider` does plain OIDC discovery against each value in
# `server.allowed-issuers` and then fetches that document's `jwks_uri` — over the
# NETWORK, from inside this container, on every token verification it cannot serve
# from cache. On Azure Government both URLs are on `login.microsoftonline.us`.
#
# If the Container Apps environment's subnet cannot egress there, EVERY token
# verification fails and the catalog refuses every caller. That converts an
# availability-SAFE finding (anonymous but working) into a silent OUTAGE — and
# nothing in the deploy says so, because from the outside "refuses everyone
# because it is secure" and "refuses everyone because it cannot fetch keys" are
# byte-identical: both answer 401 to an anonymous read, which is exactly what the
# deploy's own probe is looking for. The probe would report success.
#
# So the reachability is MEASURED at boot and stated on one deterministic line
# that a deploy can gate on. Two design choices worth defending:
#
#   * NOT FATAL. Consistent with AUTO-BIND below: an unreachable IdP leaves the
#     catalog sealed-but-correct (every caller refused), which is the safe side.
#     Dying instead would take the app down entirely and give the deploy a
#     crash-loop to diagnose rather than a sentence. The DEPLOY is the
#     enforcement point (.github/workflows/gov-uc-purview-wire.yml gates on this
#     line and refuses to point the Console at an unusable catalog).
#   * HOST ONLY in the marker. The issuer embeds the Entra tenant id and this
#     line is read back through CI logs, so the greppable marker carries the
#     authority HOST and the two HTTP codes — enough to diagnose, nothing to leak.
# ---------------------------------------------------------------------------
# Strip scheme and path from a URL, leaving the bare host.
url_host() {
  printf '%s' "$1" | sed -e 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##' -e 's#[/?].*$##'
}

# Decide — WITHOUT side effects — what the reachability probe will do. Same
# rationale as console_bind_plan: a probe only exercisable on a live container is
# a probe nobody notices has stopped running. Echoes one of:
#   skipped-authorization-disabled   no token is ever verified, nothing to reach
#   no-issuer                        authorization is on but no issuer is pinned
#                                    (render_server already fails closed on this)
#   probe:<host>                     will probe OIDC discovery + JWKS on <host>
idp_probe_plan() {
  if [ "${LOOM_UNITY_AUTH:-enable}" != "enable" ]; then
    echo "skipped-authorization-disabled"
    return 0
  fi
  probe_issuers="${LOOM_UNITY_ALLOWED_ISSUERS:-}"
  if [ -z "${probe_issuers}" ] && [ -n "${LOOM_UNITY_ENTRA_TENANT_ID:-}" ]; then
    probe_issuers="https://$(unity_authority_host)/${LOOM_UNITY_ENTRA_TENANT_ID}/v2.0"
  fi
  if [ -z "${probe_issuers}" ]; then
    echo "no-issuer"
    return 0
  fi
  # `server.allowed-issuers` is a comma list; the first entry is the one this
  # deployment mints against, so it is the one whose keys must be fetchable.
  echo "probe:$(url_host "${probe_issuers%%,*}")"
}

# Resolve the issuer the probe should use (full URL — never logged verbatim).
idp_probe_issuer() {
  probe_issuers="${LOOM_UNITY_ALLOWED_ISSUERS:-}"
  if [ -z "${probe_issuers}" ] && [ -n "${LOOM_UNITY_ENTRA_TENANT_ID:-}" ]; then
    probe_issuers="https://$(unity_authority_host)/${LOOM_UNITY_ENTRA_TENANT_ID}/v2.0"
  fi
  printf '%s' "${probe_issuers%%,*}"
}

probe_idp_reachability() {
  idp_issuer="$(idp_probe_issuer)"
  idp_host="$(url_host "${idp_issuer}")"
  idp_disc_code="000"
  idp_jwks_code="000"
  idp_jwks_host=""
  idp_body=""
  idp_try=0

  # DNS and the CNI can both lag the container by a few seconds on a cold ACA
  # replica, so a single curl would report a network posture that is not the
  # steady-state one. Retry a bounded number of times before concluding.
  #
  # ONE request per attempt: `-w '\n%{http_code}'` appends the status after the
  # body, so the body and the code come from the SAME response. Fetching them
  # with two curls would let a flapping endpoint report a 200 next to a body that
  # never arrived. `|| true` guards the non-zero exit curl returns on a transport
  # failure (set -e is on); `%{http_code}` is already `000` in that case, so the
  # code is never invented — hence no `|| echo 000`, which appended a SECOND
  # `000` and produced the nonsense `discovery=000000`.
  while [ "${idp_try}" -lt 6 ]; do
    idp_resp="$(curl -sS -m 10 -w '\n%{http_code}' "${idp_issuer%/}/.well-known/openid-configuration" 2>/dev/null)" || true
    idp_disc_code="$(printf '%s' "${idp_resp}" | tail -n 1)"
    [ -n "${idp_disc_code}" ] || idp_disc_code="000"
    idp_body="$(printf '%s' "${idp_resp}" | sed '$d')"
    if [ "${idp_disc_code}" = "200" ]; then
      break
    fi
    idp_try=$((idp_try + 1))
    sleep 5
  done

  if [ "${idp_disc_code}" = "200" ]; then
    # No jq in the upstream image. Entra returns compact JSON; squeezing
    # whitespace first makes the match tolerant of a pretty-printed document too
    # (a URL cannot contain whitespace, so this cannot corrupt the value).
    idp_jwks_url="$(printf '%s' "${idp_body}" | tr -d ' \011\012\015' | grep -o '"jwks_uri":"[^"]*"' | head -n 1 | cut -d'"' -f4)"
    if [ -n "${idp_jwks_url}" ]; then
      idp_jwks_host="$(url_host "${idp_jwks_url}")"
      idp_jwks_code="$(curl -sS -o /dev/null -w '%{http_code}' -m 10 "${idp_jwks_url}" 2>/dev/null)" || true
      [ -n "${idp_jwks_code}" ] || idp_jwks_code="000"
    fi
  fi

  if [ "${idp_disc_code}" = "200" ] && [ "${idp_jwks_code}" = "200" ]; then
    echo "[loom-unity] IDP-REACHABILITY: ok host=${idp_host} discovery=200 jwks=200 jwks-host=${idp_jwks_host}"
    return 0
  fi

  echo "[loom-unity] IDP-REACHABILITY: FAILED host=${idp_host} discovery=${idp_disc_code} jwks=${idp_jwks_code} — authorization is ENABLED but this container cannot fetch the issuer's signing keys, so EVERY token verification will fail and the catalog will refuse every caller (including the Console). This is a NETWORK finding, not a config one: allow egress from the Container Apps environment subnet to ${idp_host} on 443 (Azure Government uses login.microsoftonline.us; a UDR to a firewall or an outbound NSG deny is the usual cause). Until then the catalog is sealed. See docs/fiab/security/loom-unity-threat-model.md." >&2
  return 0
}

# ---------------------------------------------------------------------------
# ANONYMOUS SELF-READ — does an unauthenticated call actually get refused?
#
# The deploy used to answer this with `az containerapp exec` + curl from the
# Console container. That CANNOT work on Azure Government: `az containerapp exec`
# returns only its connection banner there, never the command's stdout (the same
# limitation gov-provision-maps.yml and deploy-loom-sharing.yml both record and
# work around). The 2026-07-15 run proves it — the probe's entire captured output
# was `INFO: Connecting to the container 'loom-console'...`, so every branch that
# could have failed the run was unreachable and the workflow reported success
# without ever observing the catalog's authorization posture.
#
# A loopback read from inside THIS container is observable the way Gov actually
# permits: through the container's own logs. 127.0.0.1 bypasses ingress IP rules
# and reaches the same authorization filter a VNet caller hits, so the status
# code is a true statement about AUTHORIZATION rather than about the network.
# ---------------------------------------------------------------------------
self_probe_anonymous_read() {
  anon_base="http://127.0.0.1:${LOOM_UNITY_PORT:-8080}"
  anon_code="000"
  anon_try=0
  while [ "${anon_try}" -lt 60 ]; do
    # NO `|| echo 000`. curl PRINTS `000` on a connection failure AND exits
    # non-zero, so the fallback CONCATENATES and yields `000000`. That is not
    # cosmetic here: the test below breaks out of the loop when the value is
    # != "000", and "000000" != "000" — so the 60-attempt wait-for-server retry
    # exited on attempt 1, before the server was listening, and the deploy gate
    # was handed a code that is not a code. Measured on gov-uc-purview-wire run
    # 31503926181, which failed with:
    #   [loom-unity] ANON-READ: 000000
    #   ##[error]anonymous read answered 000, which is neither a refusal
    #   (401/403) nor a success (200) — the catalog is not in a state this
    #   deploy can vouch for.
    anon_code="$(curl -sS -o /dev/null -w '%{http_code}' -m 10 \
      "${anon_base}/api/2.1/unity-catalog/catalogs" 2>/dev/null)"
    [ -n "${anon_code}" ] || anon_code="000"
    if [ "${anon_code}" != "000" ]; then
      break
    fi
    anon_try=$((anon_try + 1))
    sleep 2
  done
  echo "[loom-unity] ANON-READ: ${anon_code} (unauthenticated GET /api/2.1/unity-catalog/catalogs over loopback; authorization=${LOOM_UNITY_AUTH:-enable})"
}

# One backgrounded job for both post-boot probes, so the boot path grows exactly
# one `&`. Ordering matters: reachability needs no server, the anonymous read
# does, and running them in this order means the reachability verdict is already
# in the log by the time anything waits on the server.
post_boot_probes() {
  if [ "${LOOM_UNITY_AUTH:-enable}" = "enable" ]; then
    probe_idp_reachability
  fi
  self_probe_anonymous_read
}

# Decide — WITHOUT side effects — what the auto-bind step will do. Factored out
# so the dry-run renders the same decision the real boot takes: a bind that is
# only exercised on a live container is a bind nobody notices has stopped
# happening. Echoes one of:
#   authorization-disabled   nothing to bind — every caller is already allowed
#   not-configured           no principal id was passed (catalog enforces, but
#                            only `admin` / pre-registered users can call it)
#   invalid-principal-id     a value was passed that is not an Entra object id
#   bind:<object-id>         will register that principal as an enabled UC user
console_bind_plan() {
  if [ "${LOOM_UNITY_AUTH:-enable}" != "enable" ]; then
    echo "authorization-disabled"
  elif [ -z "${LOOM_UNITY_CONSOLE_PRINCIPAL_ID:-}" ]; then
    echo "not-configured"
  elif printf '%s' "${LOOM_UNITY_CONSOLE_PRINCIPAL_ID}" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'; then
    echo "bind:${LOOM_UNITY_CONSOLE_PRINCIPAL_ID}"
  else
    echo "invalid-principal-id"
  fi
}

# Say — on stderr, on EVERY boot including the dry run — what the auto-bind
# decision was. Separate from console_bind_plan (which stays side-effect free so
# it can be asserted on) and from bind_console_principal (which only runs on the
# happy path). The two non-binding states are the ones worth narrating: both
# leave a catalog that enforces authorization but cannot serve its own Console,
# and neither should be discoverable only by reading a container log after
# something breaks.
announce_bind_plan() {
  case "$1" in
    invalid-principal-id)
      echo "[loom-unity] WARNING: LOOM_UNITY_CONSOLE_PRINCIPAL_ID is not an Entra object id (GUID) — refusing to register it as a Unity Catalog user. Pass the Console managed identity's principalId (the 'sub' claim of the token it mints), not its client id or resource id." >&2
      ;;
    not-configured)
      echo "[loom-unity] NOTICE: authorization is ENFORCED but no LOOM_UNITY_CONSOLE_PRINCIPAL_ID was passed, so no Console principal is auto-registered. Only 'admin' and pre-registered Unity Catalog users can call this catalog. Pass consolePrincipalId on loom-unity-app.bicep." >&2
      ;;
  esac
}

bind_console_principal() {  bind_principal="$1"
  bind_base="http://127.0.0.1:${LOOM_UNITY_PORT:-8080}"

  # The admin token does not exist until the server writes it, and the SCIM route
  # does not answer until the JVM is listening. uc_admin_token covers both, so
  # this cannot race a slow boot. (Shared with provision_warehouse — one wait, one
  # definition of "the server is ready for privileged local calls".)
  bind_token="$(uc_admin_token)" || bind_token=""

  if [ -z "${bind_token}" ]; then
    echo "[loom-unity] AUTO-BIND FAILED: the server never wrote ${CONF_DIR}/token.txt, so the Console principal could not be registered as a Unity Catalog user. Authorization stays ENFORCED, so the catalog is refusing every caller (including the Console) rather than serving anonymous ones. See docs/fiab/security/loom-unity-threat-model.md." >&2
    return 0
  fi

  bind_status="$(curl -sS -o /dev/null -w '%{http_code}' -m 15 -X POST \
    "${bind_base}/api/1.0/unity-control/scim2/Users" \
    -H "Authorization: Bearer ${bind_token}" \
    -H 'Content-Type: application/scim+json' \
    -d "{\"schemas\":[\"urn:ietf:params:scim:schemas:core:2.0:User\"],\"userName\":\"${bind_principal}\",\"displayName\":\"CSA Loom Console\",\"emails\":[{\"value\":\"${bind_principal}\",\"primary\":true}],\"active\":true}")"

  case "${bind_status}" in
    20*)
      echo "[loom-unity] auto-bind: registered the Console principal ${bind_principal} as an ENABLED Unity Catalog user (HTTP ${bind_status}) — the Entra token exchange can now mint an internal token for it."
      ;;
    409)
      echo "[loom-unity] auto-bind: the Console principal ${bind_principal} is already a Unity Catalog user (HTTP 409) — nothing to do."
      ;;
    *)
      echo "[loom-unity] AUTO-BIND FAILED: registering the Console principal ${bind_principal} as a Unity Catalog user returned HTTP ${bind_status}. Authorization stays ENFORCED — the catalog refuses every caller rather than falling back to anonymous. The Console will report this through probe-loom-unity-authz. See docs/fiab/security/loom-unity-threat-model.md." >&2
      ;;
  esac
  return 0
}

# ---------------------------------------------------------------------------
# WAREHOUSE AUTO-BIND — create the Unity Catalog CATALOG that backs the Iceberg
# `warehouse`, and grant the Console the privileges it can hold on it.
#
# WHY THIS EXISTS. `data-plane/iceberg-catalog-aca.bicep` has always emitted
#   { name: 'LOOM_ICEBERG_WAREHOUSE', value: warehouse }   (default 'loom')
# and NOTHING has ever read it: before this change `grep -ci warehouse` over this
# entrypoint returned 0. So the deployment declared a warehouse and never created
# the object, and the Console's `GET /v1/config?warehouse=loom` +
# `GET /v1/catalogs/loom/namespaces` had no catalog to resolve. Creating the Loom
# item must PROVISION AND BIND its backing object — .claude/rules/auto-bind-by-default.md
# §1 — and the platform must do it, not an operator (§5).
#
# SELF-HEALING (§3). This runs on EVERY boot and is idempotent: it re-creates the
# catalog whenever it is absent, so a catalog deleted out-of-band — or lost with
# the ephemeral store this app runs on (LOOM_UNITY_DB_LOCAL=1 + minReplicas 0,
# i.e. every scale-to-zero) — is repaired by the next start rather than surfaced
# as an error.
#
# AUTHORITY. The server writes its own admin service token to etc/conf/token.txt
# at boot (upstream SecurityContext.createServiceTokenFile, unconditional), and
# that principal is the ONLY holder of metastore OWNER
# (UnityAccessUtil.initializeAdmin). So the container has, locally and with no
# external credential, exactly the authority these two calls need — and nothing
# outside the container ever needs it.
#
# HONEST ABOUT WHAT THIS DOES NOT FIX. See announce_iceberg_list_ns_defect below:
# provisioning the warehouse does NOT make the Iceberg REST surface readable by
# the Console, because upstream gates every one of those routes on metastore
# OWNER. That is stated on every boot rather than left to be rediscovered from a
# 403.
# ---------------------------------------------------------------------------

# The catalog name backing the Iceberg namespaces. Emitted by
# data-plane/iceberg-catalog-aca.bicep; absent on the sibling loom-unity app,
# which serves the Unity surface only and provisions no warehouse.
unity_warehouse() {
  printf '%s' "${LOOM_ICEBERG_WAREHOUSE:-}"
}

# Decide — WITHOUT side effects — what the warehouse step will do. Same rationale
# as console_bind_plan/idp_probe_plan: a provisioning decision only exercisable
# on a live container is one nobody notices has stopped happening. Echoes:
#   not-configured           no LOOM_ICEBERG_WAREHOUSE (the loom-unity app)
#   invalid-warehouse-name   a value that is not a Unity Catalog identifier
#   provision:<name>         will create-if-absent that catalog
warehouse_bind_plan() {
  wb_name="$(unity_warehouse)"
  if [ -z "${wb_name}" ]; then
    echo "not-configured"
  elif printf '%s' "${wb_name}" | grep -Eq '^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$'; then
    echo "provision:${wb_name}"
  else
    echo "invalid-warehouse-name"
  fi
}

announce_warehouse_plan() {
  case "$1" in
    invalid-warehouse-name)
      echo "[loom-unity] WARNING: LOOM_ICEBERG_WAREHOUSE is not a valid Unity Catalog identifier — refusing to create a catalog from it. Use letters, digits, underscore or dash (<=128 chars); it is interpolated into a JSON body and a URL path. Set catalogConfig.warehouse on data-plane/iceberg-catalog-aca.bicep." >&2
      ;;
  esac
}

# The upstream defect that provisioning CANNOT fix, stated on every boot so it is
# a KNOWN ceiling rather than a rediscovered 500.
#
# MEASURED on this image (authorization enabled, warehouse provisioned, namespace
# present, every principal tried including the server's own metastore-OWNER admin
# token):
#   GET <irc>/v1/catalogs/<wh>/namespaces
#     -> HTTP 500 {"error":{"message":"Authorization filter not initialized —
#        ensure the request goes through UnityAccessDecorator.", ...}}
#
# ── CAUSE, CORRECTED 2026-08-10 ───────────────────────────────────────────────
# This was previously announced as "a regression imported by the v0.5.1
# unitycatalog-server overlay". THAT WAS WRONG, and the error message asserted a
# cause nothing had established (deploy-integrity.md R7). The "control" behind it
# changed TWO variables at once: it compared this image (overlay ON, authorization
# ENABLED) against the bare upstream image (overlay OFF, authorization DISABLED),
# then credited the difference to the overlay.
#
# Re-measured with ONE variable — this same image with the overlay stripped off
# the classpath and authorization still ENABLED — the route answers the SAME 500.
# And at byte level, AuthorizedService, SchemaService, IcebergRestCatalogService,
# UnityAccessDecorator and ResultFilter are IDENTICAL in the released v0.5.0 and
# v0.5.1 artifacts; the entire v0.5.0->v0.5.1 delta is PermissionService (one added
# annotation, the #1603 fix), its synthetic sibling, AuthorizeExpressions and a
# version string. The overlaid classes are not on this code path at all.
#
# The real cause is an UPSTREAM defect present in BOTH v0.5.0 and v0.5.1 that
# fires whenever server.authorization is enabled: AuthorizedService.applyResponseFilter
# runs only `if (isAuthorizationEnabled())`, and then requires the RESULT_FILTER
# request attribute that UnityAccessDecorator installs for @ResponseAuthorizeFilter
# routes. IcebergRestCatalogService.listNamespaces reaches SchemaService.listSchemas
# IN-PROCESS, under the Iceberg route's context, where that attribute was never set
# — so it throws INTERNAL. With authorization DISABLED the whole body is skipped,
# which is the only reason the bare image looked healthy. Every OTHER Iceberg route
# is unaffected (namespace GET, table list, table load and register all return 200).
# v0.5.1 is the newest release on Maven Central, so there is no version to bump to.
#
# The Console works around it by serving namespaces from the Unity schemas API on
# this same server (lib/azure/iceberg-catalog-client.ts listNamespaces). An
# external engine calling the catalog DIRECTLY still hits the 500 on that one
# route.
announce_iceberg_list_ns_defect() {
  [ -n "$(unity_warehouse)" ] || return 0
  echo "[loom-unity] ICEBERG-LIST-NAMESPACES-DEFECT: GET <iceberg>/v1/catalogs/<warehouse>/namespaces answers HTTP 500 'Authorization filter not initialized' on this image, for EVERY principal including the metastore owner. Cause: an UPSTREAM defect in unitycatalog v0.5.0 AND v0.5.1 that fires whenever server.authorization is enabled — IcebergRestCatalogService.listNamespaces reaches SchemaService.listSchemas in-process, under a request context where UnityAccessDecorator never installed the RESULT_FILTER attribute that AuthorizedService.applyResponseFilter requires. It is NOT caused by the #1603 overlay this image applies: measured with the overlay removed and authorization still enabled, the same call returns the same 500, and the overlaid classes are byte-identical in both releases. The same call with authorization DISABLED returns 200, which is the only reason the bare upstream image looked healthy. Every other Iceberg route is unaffected. The Console serves namespaces from /api/2.1/unity-catalog/schemas instead; a DIRECT external-engine LIST-namespaces call still fails. See docs/fiab/parity/external-engine-federation.md." >&2
}

# Block until the server has written its admin token AND is answering, then echo
# the token. Echoes nothing on exhaustion — the caller reports that honestly.
# Shared by the SCIM bind and the warehouse provisioning so a slow boot cannot
# race either of them.
uc_admin_token() {
  ut_token=""
  ut_try=0
  while [ "${ut_try}" -lt 90 ]; do
    if [ -s "${CONF_DIR}/token.txt" ]; then
      ut_token="$(tr -d ' \011\015\012' < "${CONF_DIR}/token.txt")"
      if [ -n "${ut_token}" ] && curl -sS -o /dev/null -m 5 \
          -H "Authorization: Bearer ${ut_token}" \
          "http://127.0.0.1:${LOOM_UNITY_PORT:-8080}/api/1.0/unity-control/scim2/Users"; then
        printf '%s' "${ut_token}"
        return 0
      fi
    fi
    ut_try=$((ut_try + 1))
    sleep 2
  done
  return 1
}

# Create the warehouse catalog if it is absent, then grant the bound Console
# principal every privilege it CAN hold on it.
#
# Grants are deliberately the API-expressible set — USE CATALOG / SELECT /
# CREATE SCHEMA / CREATE TABLE. They are what make the Unity surface usable for
# the Console (list schemas, read tables, register new ones under this catalog);
# they do NOT and cannot include OWNER (see announce_iceberg_list_ns_defect).
provision_warehouse() {
  pw_name="$1"
  pw_principal="$2"      # '' when nothing was bound (no user exists to grant to)
  pw_base="http://127.0.0.1:${LOOM_UNITY_PORT:-8080}"
  pw_api="${pw_base}/api/2.1/unity-catalog"

  pw_token="$(uc_admin_token)" || pw_token=""
  if [ -z "${pw_token}" ]; then
    echo "[loom-unity] WAREHOUSE-BIND: FAILED name=${pw_name} reason=no-admin-token — the server never wrote ${CONF_DIR}/token.txt, so the warehouse catalog could not be created. The Iceberg REST surface has no catalog to resolve; external-engine discovery will fail until the next boot succeeds." >&2
    return 0
  fi

  # 1. Does it already exist? A GET is cheap and makes "created" mean created.
  pw_get="$(curl -sS -o /dev/null -w '%{http_code}' -m 15 \
    -H "Authorization: Bearer ${pw_token}" \
    "${pw_api}/catalogs/${pw_name}")" || pw_get="000"
  [ -n "${pw_get}" ] || pw_get="000"

  case "${pw_get}" in
    200)
      echo "[loom-unity] WAREHOUSE-BIND: present name=${pw_name} (HTTP 200) — nothing to create."
      ;;
    404)
      pw_post="$(curl -sS -o /dev/null -w '%{http_code}' -m 30 -X POST \
        "${pw_api}/catalogs" \
        -H "Authorization: Bearer ${pw_token}" \
        -H 'Content-Type: application/json' \
        -d "{\"name\":\"${pw_name}\",\"comment\":\"CSA Loom warehouse — backs the Iceberg REST Catalog namespaces. Created automatically by the loom-unity entrypoint (auto-bind-by-default.md).\"}")" || pw_post="000"
      [ -n "${pw_post}" ] || pw_post="000"
      case "${pw_post}" in
        20*)
          echo "[loom-unity] WAREHOUSE-BIND: created name=${pw_name} (HTTP ${pw_post})"
          ;;
        409)
          echo "[loom-unity] WAREHOUSE-BIND: present name=${pw_name} (HTTP 409, created concurrently) — nothing to do."
          ;;
        *)
          echo "[loom-unity] WAREHOUSE-BIND: FAILED name=${pw_name} create=HTTP ${pw_post} — the Iceberg REST Catalog has no catalog to resolve, so /v1/catalogs/${pw_name}/namespaces cannot answer. This is a catalog-server failure, not a configuration one: the admin token authenticated (the existence check above returned ${pw_get})." >&2
          return 0
          ;;
      esac
      ;;
    *)
      # UNKNOWN is not "absent". Creating on a 403/500 would either duplicate or
      # fail confusingly, and reporting "created" on an unverified outcome is the
      # exact error deploy-integrity.md R6/R7 forbid.
      echo "[loom-unity] WAREHOUSE-BIND: UNKNOWN name=${pw_name} probe=HTTP ${pw_get} — could not establish whether the catalog exists, so nothing was created. This is NOT a statement that it is missing." >&2
      return 0
      ;;
  esac

  # 2. A namespace, so the warehouse is not a DEAD END on first open.
  #
  # MEASURED against this image: with the catalog created but empty,
  #   GET <irc>/v1/catalogs/<wh>/namespaces/default          -> 404
  #   GET <irc>/v1/catalogs/<wh>/namespaces/default/tables    -> 404
  # and after creating schema `<wh>.default` the same two answer 200
  # ({"identifiers":[],...}). An engine's first walk of a freshly provisioned
  # warehouse must land on a real, empty namespace — not a 404 the operator has
  # to interpret (auto-bind-by-default.md §4).
  pw_ns="${LOOM_ICEBERG_DEFAULT_NAMESPACE:-default}"
  pw_schema="$(curl -sS -o /dev/null -w '%{http_code}' -m 30 -X POST \
    "${pw_api}/schemas" \
    -H "Authorization: Bearer ${pw_token}" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"${pw_ns}\",\"catalog_name\":\"${pw_name}\",\"comment\":\"Default CSA Loom namespace.\"}")" || pw_schema="000"
  [ -n "${pw_schema}" ] || pw_schema="000"
  case "${pw_schema}" in
    20*)
      echo "[loom-unity] WAREHOUSE-BIND: namespace ${pw_name}.${pw_ns} created (HTTP ${pw_schema})"
      ;;
    *)
      # DO NOT report "not created" on the strength of a non-2xx alone. Upstream
      # answers a DUPLICATE schema with HTTP 400, not 409 — measured on the
      # second boot of this very container, where the first revision of this
      # block printed "NOT created … an engine will see 404" about a namespace
      # that plainly existed. An error must not assert something it did not
      # establish (.claude/rules/deploy-integrity.md R7), so the state is READ
      # back before anything is claimed about it.
      pw_ns_get="$(curl -sS -o /dev/null -w '%{http_code}' -m 15 \
        -H "Authorization: Bearer ${pw_token}" \
        "${pw_api}/schemas/${pw_name}.${pw_ns}")" || pw_ns_get="000"
      [ -n "${pw_ns_get}" ] || pw_ns_get="000"
      if [ "${pw_ns_get}" = "200" ]; then
        echo "[loom-unity] WAREHOUSE-BIND: namespace ${pw_name}.${pw_ns} already present (create=HTTP ${pw_schema}, read-back=HTTP 200) — nothing to do."
      else
        echo "[loom-unity] WAREHOUSE-BIND: namespace ${pw_name}.${pw_ns} MISSING (create=HTTP ${pw_schema}, read-back=HTTP ${pw_ns_get}) — the warehouse exists but has no namespace, so an engine walking it will see 404 on every namespace route until one is created." >&2
      fi
      ;;
  esac

  # 3. Grants. Only meaningful once a Console principal exists as a UC user —
  # upstream PermissionService resolves the grantee with getUserByEmail(), so a
  # grant before the SCIM bind 404s. bind_console_principal runs first, in the
  # same sequential job, for exactly that reason.
  if [ -z "${pw_principal}" ]; then
    echo "[loom-unity] WAREHOUSE-BIND: grants skipped for ${pw_name} — no Console principal is registered (LOOM_UNITY_CONSOLE_PRINCIPAL_ID unset, or authorization is the audited disable opt-out)."
    return 0
  fi

  pw_grant="$(curl -sS -o /dev/null -w '%{http_code}' -m 30 -X PATCH \
    "${pw_api}/permissions/catalog/${pw_name}" \
    -H "Authorization: Bearer ${pw_token}" \
    -H 'Content-Type: application/json' \
    -d "{\"changes\":[{\"principal\":\"${pw_principal}\",\"add\":[\"USE CATALOG\",\"SELECT\",\"CREATE SCHEMA\",\"CREATE TABLE\"]}]}")" || pw_grant="000"
  [ -n "${pw_grant}" ] || pw_grant="000"

  case "${pw_grant}" in
    20*)
      echo "[loom-unity] WAREHOUSE-BIND: granted USE CATALOG,SELECT,CREATE SCHEMA,CREATE TABLE on ${pw_name} to the Console principal (HTTP ${pw_grant})."
      ;;
    *)
      echo "[loom-unity] WAREHOUSE-BIND: grants FAILED on ${pw_name} (HTTP ${pw_grant}) — the catalog exists but the Console principal holds no privilege on it, so the Unity surface will refuse its reads. Check that the SCIM bind above succeeded: PermissionService resolves the grantee by getUserByEmail(<principal object id>)." >&2
      ;;
  esac
  return 0
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
  echo "=== auto-bind ==="
  echo "console-principal-bind=$(console_bind_plan)"
  announce_bind_plan "$(console_bind_plan)"
  echo "warehouse-bind=$(warehouse_bind_plan)"
  announce_warehouse_plan "$(warehouse_bind_plan)"
  announce_iceberg_list_ns_defect
  echo "=== probes ==="
  echo "idp-reachability=$(idp_probe_plan)"
  exit 0
fi

# Resolve a writable DB dir BEFORE rendering hibernate.properties (which bakes
# the path into the JDBC URL) — this is what makes the H2/SMB fallback take.
resolve_db_dir
echo "[loom-unity] rendering config (db=${LOOM_UNITY_DB_URL:+postgres/${LOOM_UNITY_DB_AUTH:-entra}}${LOOM_UNITY_DB_URL:-h2-file} dir=${DB_DIR} auth=${LOOM_UNITY_AUTH:-enable} adls-vending=${LOOM_UNITY_ADLS_ACCOUNT:+on}${LOOM_UNITY_ADLS_ACCOUNT:-off})"
if [ -z "${LOOM_UNITY_DB_URL:-}" ]; then
  # LU-1: the H2 fallback is not the recommended posture anywhere it can be
  # avoided. Say so on every boot rather than letting a deployment quietly sit on
  # a single-writer, unbacked-up, SMB-fragile store.
  echo "[loom-unity] NOTICE: no LOOM_UNITY_DB_URL — running on the LEGACY H2 file DB. It is single-writer (so this app is pinned to ONE replica), has no backup or point-in-time restore, and is known to CrashLoopBackOff on Azure Government's SMB mount. Provision the Entra-only Postgres store (platform/fiab/bicep/modules/data-plane/loom-unity-postgres.bicep) and pass unityPostgresFqdn to loom-unity-app.bicep. See docs/fiab/unity-gov.md." >&2
fi
seed_db_if_empty
write_config

cd "${UC_HOME}"

# AUTO-BIND (see bind_console_principal / console_bind_plan above). Only
# meaningful when authorization is actually enforced — with `disable` every
# caller is already allowed and there is no principal to register.
#
# The id is interpolated into a JSON body, so its shape is VALIDATED first (in
# console_bind_plan): an Entra object id is a GUID, and refusing anything else
# keeps a malformed or hostile value from breaking out of the JSON string. A bad
# value is a configuration error worth naming, not something to paper over.
BIND_PLAN="$(console_bind_plan)"
announce_bind_plan "${BIND_PLAN}"
WAREHOUSE_PLAN="$(warehouse_bind_plan)"
announce_warehouse_plan "${WAREHOUSE_PLAN}"
announce_iceberg_list_ns_defect

# ONE sequential background job, deliberately. The warehouse grant resolves its
# grantee with upstream's getUserByEmail(<principal object id>), so it MUST run
# after the SCIM registration — running them as two independent `&` jobs would
# race and the grant would intermittently 404 against a user that had not been
# created yet.
auto_bind() {
  bind_principal_id=""
  case "${BIND_PLAN}" in
    bind:*)
      bind_principal_id="${BIND_PLAN#bind:}"
      bind_console_principal "${bind_principal_id}"
      ;;
  esac
  case "${WAREHOUSE_PLAN}" in
    provision:*)
      provision_warehouse "${WAREHOUSE_PLAN#provision:}" "${bind_principal_id}"
      ;;
  esac
}
auto_bind &

# POST-BOOT PROBES (see probe_idp_reachability / self_probe_anonymous_read).
# Unconditional: the anonymous read is exactly as worth stating when
# authorization is the audited `disable` opt-out — that is the finding #2643
# tracks, and a deploy should be able to see it rather than infer it.
post_boot_probes &

echo "[loom-unity] starting OSS Unity Catalog server on :${LOOM_UNITY_PORT:-8080}"
exec ./bin/start-uc-server
