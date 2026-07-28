#!/usr/bin/env bash
# CSA Loom — Loom Unity PostgreSQL data-plane bootstrap (LU-1).
#
# platform/fiab/bicep/modules/data-plane/loom-unity-postgres.bicep provisions the
# Entra-only, private-endpoint-only flexible server, the `unitycatalog` database,
# and sets the loom-unity managed identity as the server's Entra ADMINISTRATOR.
# What bicep cannot do is the DATA-PLANE half: registering ADDITIONAL Entra
# principals as PostgreSQL roles and granting them on the catalog database.
# This script does that, idempotently.
#
# It also PROVES the passwordless path end-to-end before you point the catalog at
# the server: it connects with nothing but an Entra token (there is no password —
# the server is created with authConfig.passwordAuth=Disabled) and prints the
# server version. If that fails, the container would have failed the same way.
#
# WHERE TO RUN IT
#   The server has publicNetworkAccess=Disabled, so there is no firewall rule to
#   open and no path from a laptop. Run it from INSIDE the VNet — the in-VNet
#   GitHub runner (gh-aca-runner) or an ACA exec session in the same Container
#   Apps environment. Running it from outside will hang on connect; that is the
#   private endpoint working correctly, not a bug.
#
# Required env:
#   SUB                  — subscription id
#   UNITY_RG             — resource group holding the Loom Unity PG server
#   UNITY_PG_SERVER      — PG flexible-server name (psql-loom-unity-*)
# Optional:
#   UNITY_PG_DB          (unitycatalog)      — catalog database name
#   UNITY_UAMI_NAME      (uami-loom-unity)   — Entra principal name of the loom-unity
#                                              identity; must match the app module's
#                                              unityDbAadUser
#   EXTRA_PG_PRINCIPALS  ('')                — comma-separated ADDITIONAL Entra
#                                              principal names to register with
#                                              read-only access (operators/auditors)
#   PG_HOST_SUFFIX       (postgres.database.azure.com)
#                                            — postgres.database.usgovcloudapi.net in Gov
#   PG_AAD_RESOURCE      (https://ossrdbms-aad.database.windows.net)
#                                            — https://ossrdbms-aad.database.usgovcloudapi.net in Gov
#
# Auth: runs as the logged-in az principal, which MUST be an Entra administrator
# of the server (bicep's `additionalAdministrators` is where you add the deploy
# SP or an operator group for exactly this).

set -uo pipefail

: "${SUB:?SUB (subscription id) is required}"
: "${UNITY_RG:?UNITY_RG (resource group) is required}"
: "${UNITY_PG_SERVER:?UNITY_PG_SERVER (PG flexible-server name) is required}"
UNITY_PG_DB="${UNITY_PG_DB:-unitycatalog}"
UNITY_UAMI_NAME="${UNITY_UAMI_NAME:-uami-loom-unity}"
EXTRA_PG_PRINCIPALS="${EXTRA_PG_PRINCIPALS:-}"
PG_HOST_SUFFIX="${PG_HOST_SUFFIX:-postgres.database.azure.com}"
# .azure.com returns AADSTS500011 in some tenants — use the documented OSS-RDBMS
# resource, exactly as scripts/csa-loom/bootstrap-weave-pg.sh does.
PG_AAD_RESOURCE="${PG_AAD_RESOURCE:-https://ossrdbms-aad.database.windows.net}"

# Defence-in-depth: these identifiers flow into SQL below.
if ! [[ "$UNITY_PG_DB" =~ ^[A-Za-z_][A-Za-z0-9_-]{0,62}$ ]]; then
  echo "::error::UNITY_PG_DB '$UNITY_PG_DB' is not a valid identifier"; exit 1
fi
if ! [[ "$UNITY_UAMI_NAME" =~ ^[A-Za-z0-9_-]{1,128}$ ]]; then
  echo "::error::UNITY_UAMI_NAME '$UNITY_UAMI_NAME' is not a valid principal name"; exit 1
fi

FQDN="${UNITY_PG_SERVER}.${PG_HOST_SUFFIX}"
echo "== Loom Unity PG bootstrap: server=$UNITY_PG_SERVER db=$UNITY_PG_DB identity=$UNITY_UAMI_NAME =="

az account set --subscription "$SUB" >/dev/null 2>&1 || true

# 1. Wait for the server to report Ready.
for i in $(seq 1 30); do
  STATE=$(az postgres flexible-server show -g "$UNITY_RG" -n "$UNITY_PG_SERVER" --query state -o tsv 2>/dev/null || echo "")
  echo "  server state: ${STATE:-unknown} (attempt $i/30)"
  [ "$STATE" = "Ready" ] && break
  sleep 20
done
if [ "${STATE:-}" != "Ready" ]; then
  echo "::error::server $UNITY_PG_SERVER never reached Ready"; exit 1
fi

# 2. Mint an Entra token. This IS the password — there is no other credential.
PGPASSWORD=$(az account get-access-token --resource "$PG_AAD_RESOURCE" --query accessToken -o tsv)
if [ -z "$PGPASSWORD" ]; then
  echo "::error::could not mint an Entra token for $PG_AAD_RESOURCE"; exit 1
fi
export PGPASSWORD
PGUSER=$(az account show --query user.name -o tsv 2>/dev/null || echo "")
if [ -z "$PGUSER" ]; then
  echo "::error::could not resolve the signed-in principal name (it must be an Entra admin of the server)"; exit 1
fi
export PGSSLMODE=require

run_sql() {
  psql "host=$FQDN port=5432 dbname=$UNITY_PG_DB user=$PGUSER sslmode=require" \
    -v ON_ERROR_STOP=1 -X -q -c "$1"
}

# 3. Prove the passwordless path works before anything else depends on it.
echo "-- connectivity probe (Entra token only, no password) --"
if ! run_sql "SELECT version();"; then
  cat >&2 <<'EOF'
::error::could not connect to the Loom Unity catalog database with an Entra token.
Checklist:
  * Are you running INSIDE the VNet? publicNetworkAccess is Disabled by design.
  * Is the signed-in principal an Entra administrator of the server
    (loom-unity-postgres.bicep `additionalAdministrators`)?
  * Does the private DNS zone resolve <server>.<suffix> to the private endpoint?
EOF
  exit 1
fi

# 4. Register the loom-unity identity + any extra principals.
#    pgaadauth_create_principal is idempotent-ish: it errors if the role exists,
#    so the existence check comes first. The loom-unity UAMI is normally already
#    a role because bicep made it the server administrator; this covers the case
#    where the operator wired the admin separately.
register_principal() {
  local principal="$1" readonly_only="$2"
  if ! [[ "$principal" =~ ^[A-Za-z0-9_-]{1,128}$ ]]; then
    echo "::error::'$principal' is not a valid Entra principal name"; return 1
  fi
  local exists
  exists=$(psql "host=$FQDN port=5432 dbname=$UNITY_PG_DB user=$PGUSER sslmode=require" \
    -X -t -A -c "SELECT 1 FROM pg_roles WHERE rolname = '$principal'" 2>/dev/null || echo "")
  if [ "$exists" != "1" ]; then
    echo "  registering Entra principal '$principal'"
    run_sql "SELECT pgaadauth_create_principal('$principal', false, false);" || {
      echo "::warning::could not register '$principal' (already present, or not an Entra identity in this tenant)"; }
  else
    echo "  Entra principal '$principal' already present"
  fi
  run_sql "GRANT CONNECT ON DATABASE \"$UNITY_PG_DB\" TO \"$principal\";" || true
  if [ "$readonly_only" = "1" ]; then
    run_sql "GRANT USAGE ON SCHEMA public TO \"$principal\";" || true
    run_sql "GRANT SELECT ON ALL TABLES IN SCHEMA public TO \"$principal\";" || true
    run_sql "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO \"$principal\";" || true
  else
    # The catalog owns its own schema: Hibernate creates/updates the UC tables on
    # first boot (hbm2ddl.auto=update), so the app identity needs CREATE.
    run_sql "GRANT USAGE, CREATE ON SCHEMA public TO \"$principal\";" || true
    run_sql "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO \"$principal\";" || true
    run_sql "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO \"$principal\";" || true
    run_sql "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO \"$principal\";" || true
    run_sql "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO \"$principal\";" || true
  fi
}

register_principal "$UNITY_UAMI_NAME" 0

if [ -n "$EXTRA_PG_PRINCIPALS" ]; then
  IFS=',' read -ra EXTRAS <<< "$EXTRA_PG_PRINCIPALS"
  for p in "${EXTRAS[@]}"; do
    p="$(echo "$p" | xargs)"
    [ -z "$p" ] && continue
    register_principal "$p" 1
  done
fi

unset PGPASSWORD

cat <<EOF

== done ==
Wire the catalog at it:

  az deployment group create -g $UNITY_RG \\
    -f platform/fiab/bicep/modules/compute/loom-unity-app.bicep \\
    -p ... unityPostgresFqdn=$FQDN \\
       unityPostgresDatabase=$UNITY_PG_DB \\
       unityDbAadUser=$UNITY_UAMI_NAME \\
       unityUamiClientId=<client-id-of-the-loom-unity-UAMI>

Then confirm the deployment output persistenceBackend == 'postgres' and
dbEntraTokenAuth == true. To carry an EXISTING H2 catalog over first, run
scripts/csa-loom/loom-unity-migrate-catalog.py BEFORE repointing the app.
EOF
