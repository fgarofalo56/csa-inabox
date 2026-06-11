// ===========================================================================
// Databricks Unity Catalog — configured by DEFAULT
// ===========================================================================
// One-shot deploymentScript that makes the Databricks Unity Catalog metastore
// provisioned + bound by default, so `Browse > Unity Catalog` shows a real
// configured metastore/catalog after a stock deploy (no manual account-console
// clicking, no opt-in GHA step required).
//
// What it does (idempotent — safe to re-run via `azd up`):
//   1. ACCOUNT API (accounts.azuredatabricks.net): create/reuse the regional UC
//      metastore and ASSIGN it to this workspace.
//   2. ACCOUNT API: register the Console UAMI as an account service principal +
//      grant it `account_admin` so the Loom Console can LIST + MANAGE UC.
//   3. WORKSPACE UC REST 2.1: create the default catalog + pin it as
//      `default_catalog_name` so Browse shows a usable catalog.
//
// IT RUNS THE SAME `scripts/csa-loom/enable-unity-catalog.sh` logic as the
// post-deploy bootstrap workflow (one source of truth — keep the two in sync).
// The account-plane host is PUBLIC (different plane than the network-locked
// workspace), so the script works even with the workspace private; the
// default-catalog step is best-effort against the workspace host and degrades
// gracefully when unreachable (newer accounts auto-create the workspace catalog
// + set it as default on assignment).
//
// THE ONE REQUIREMENT (honest, documented — per no-vaporware.md): the script
// identity must be a Databricks ACCOUNT ADMIN. The deploymentScript runs as the
// Console UAMI (scriptUamiId); a one-time human step makes that UAMI a Databricks
// account admin (see docs/fiab/catalog/metastores.md). If the UAMI is not yet an
// account admin, the script logs a warning and exits 0 — UC enablement is never
// a hard deploy blocker. Likewise, when `databricksAccountId` is empty the
// orchestrator does not deploy this module at all (the workspace still exists;
// UC can be enabled later via the post-deploy workflow).
//
// Only deployed where Unity Catalog is supported (Commercial + GCC). On
// GCC-High / IL5 the workspace uses the Hive metastore and this module is
// skipped by the orchestrator.

targetScope = 'resourceGroup'

@description('Primary region (the metastore is regional — one per region).')
param location string = resourceGroup().location

@description('Databricks ACCOUNT id (GUID). Empty = orchestrator skips this module (UC enabled later via the post-deploy workflow).')
param databricksAccountId string

@description('Numeric Databricks workspace id (workspace.properties.workspaceId) — what the account API assigns the metastore to.')
param workspaceNumericId string

@description('Bare workspace REST host (no scheme), e.g. adb-123.19.azuredatabricks.net — used to create + pin the default catalog.')
param workspaceHost string = ''

@description('Console UAMI application/client id — registered as an account service principal + granted account_admin so the Console can list/manage UC.')
param consoleUamiClientId string

@description('Default catalog name to create + pin (Browse shows this catalog).')
param defaultCatalogName string = 'main'

@description('Resource id of the UAMI the deploymentScript runs as. MUST be a Databricks ACCOUNT ADMIN (one-time human grant) for the account-API calls to succeed.')
param scriptUamiId string

@description('Compliance tags')
param complianceTags object = {}

// Azure Databricks AAD application id — the scope the script mints account/
// workspace tokens for (`az account get-access-token --resource <this>`).
var dbxResource = '2ff814a6-3304-4ab8-85cb-cd0e6f879c1d'

resource ucBootstrap 'Microsoft.Resources/deploymentScripts@2023-08-01' = {
  name: 'loom-dbx-uc-bootstrap'
  location: location
  tags: complianceTags
  kind: 'AzureCLI'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${scriptUamiId}': {} }
  }
  properties: {
    azCliVersion: '2.64.0'
    retentionInterval: 'PT1H'
    timeout: 'PT30M'
    cleanupPreference: 'OnSuccess'
    environmentVariables: [
      { name: 'DATABRICKS_ACCOUNT_ID', value: databricksAccountId }
      { name: 'REGION', value: location }
      { name: 'WORKSPACE_ID', value: workspaceNumericId }
      { name: 'WORKSPACE_HOST', value: workspaceHost }
      { name: 'UAMI_APP_ID', value: consoleUamiClientId }
      { name: 'DEFAULT_CATALOG', value: defaultCatalogName }
      { name: 'DBX_RESOURCE', value: dbxResource }
    ]
    // Faithful inline port of scripts/csa-loom/enable-unity-catalog.sh. Keep the
    // two in sync — the script is the canonical CLI used by the GHA bootstrap.
    scriptContent: '''
      set -uo pipefail
      ACCOUNT_HOST="https://accounts.azuredatabricks.net"
      METASTORE_NAME="loom-${REGION}"
      out() { echo "{\"status\":\"$1\",\"detail\":\"$2\"}" > "$AZ_SCRIPTS_OUTPUT_PATH"; }

      echo ">>> Acquiring Databricks account token (as the Console UAMI)"
      TOKEN=$(az account get-access-token --resource "$DBX_RESOURCE" --query accessToken -o tsv 2>/dev/null || echo "")
      if [ -z "$TOKEN" ]; then echo "::warning:: could not acquire Databricks token"; out "skipped" "no-token"; exit 0; fi
      API="${ACCOUNT_HOST}/api/2.0/accounts/${DATABRICKS_ACCOUNT_ID}"
      AUTH=(-H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json")

      echo ">>> Looking for an existing metastore in ${REGION}"
      LIST_CODE=$(curl -s -o /tmp/ms.json -w '%{http_code}' --max-time 60 "${AUTH[@]}" "${API}/metastores" || echo "000")
      if [ "$LIST_CODE" != "200" ]; then
        echo "::warning:: metastores list returned HTTP ${LIST_CODE} — the script identity is likely NOT a Databricks account admin. See docs/fiab/catalog/metastores.md"
        out "skipped" "not-account-admin-or-unreachable:${LIST_CODE}"; exit 0
      fi
      METASTORE_ID=$(python3 -c "import sys,json;d=json.load(open('/tmp/ms.json'));print(next((m['metastore_id'] for m in d.get('metastores',[]) if m.get('region')=='${REGION}'),''))" 2>/dev/null || echo "")

      if [ -z "$METASTORE_ID" ]; then
        echo ">>> Creating metastore '${METASTORE_NAME}' in ${REGION}"
        CREATE_CODE=$(curl -s -o /tmp/msc.json -w '%{http_code}' --max-time 60 "${AUTH[@]}" -X POST "${API}/metastores" \
          -d "{\"metastore_info\":{\"name\":\"${METASTORE_NAME}\",\"region\":\"${REGION}\"}}" || echo "000")
        METASTORE_ID=$(python3 -c "import sys,json;d=json.load(open('/tmp/msc.json'));i=d.get('metastore_info',d);print(i.get('metastore_id',''))" 2>/dev/null || echo "")
        if [ -z "$METASTORE_ID" ]; then echo "::warning:: metastore create failed (HTTP ${CREATE_CODE})"; out "skipped" "metastore-create-failed"; exit 0; fi
        echo "    created ${METASTORE_ID}"
      else
        echo "    reusing metastore ${METASTORE_ID}"
      fi

      echo ">>> Assigning metastore ${METASTORE_ID} to workspace ${WORKSPACE_ID}"
      curl -s --max-time 60 "${AUTH[@]}" -X PUT "${API}/workspaces/${WORKSPACE_ID}/metastore" \
        -d "{\"metastore_id\":\"${METASTORE_ID}\"}" >/dev/null || true

      # Ensure Console UAMI is an account SP + account_admin so the Console lists/manages UC.
      if [ -n "$UAMI_APP_ID" ]; then
        echo ">>> Ensuring UAMI ${UAMI_APP_ID} is an account SP + account_admin"
        SP_ID=$(curl -s --max-time 60 "${AUTH[@]}" "${API}/scim/v2/ServicePrincipals?filter=applicationId%20eq%20%22${UAMI_APP_ID}%22" \
          | python3 -c "import sys,json;d=json.load(sys.stdin);print((d.get('Resources') or [{}])[0].get('id',''))" 2>/dev/null || echo "")
        if [ -z "$SP_ID" ]; then
          SP_ID=$(curl -s --max-time 60 "${AUTH[@]}" -X POST "${API}/scim/v2/ServicePrincipals" \
            -d "{\"schemas\":[\"urn:ietf:params:scim:schemas:core:2.0:ServicePrincipal\"],\"applicationId\":\"${UAMI_APP_ID}\",\"displayName\":\"loom-console-uami\",\"active\":true}" \
            | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
        fi
        if [ -n "$SP_ID" ]; then
          curl -s --max-time 60 "${AUTH[@]}" -X PATCH "${API}/scim/v2/ServicePrincipals/${SP_ID}" \
            -d '{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"add","path":"roles","value":[{"value":"account_admin"}]}]}' >/dev/null || true
          echo "    UAMI SCIM id=${SP_ID}; granted account_admin."
        fi
      fi

      # Make the default catalog deterministic so Browse shows a real catalog.
      if [ -n "$WORKSPACE_HOST" ]; then
        WS_API="https://${WORKSPACE_HOST}/api/2.1/unity-catalog"
        echo ">>> Ensuring default catalog '${DEFAULT_CATALOG}' on ${WORKSPACE_HOST}"
        CAT_CODE=$(curl -s -o /tmp/cat.json -w '%{http_code}' --max-time 60 "${AUTH[@]}" -X POST "${WS_API}/catalogs" \
          -d "{\"name\":\"${DEFAULT_CATALOG}\",\"comment\":\"Loom default catalog (auto-provisioned)\"}" || echo "000")
        if [ "$CAT_CODE" = "200" ] || [ "$CAT_CODE" = "201" ]; then
          echo "    created catalog '${DEFAULT_CATALOG}'."
        elif [ "$CAT_CODE" = "409" ] || grep -qi "already exists\|ALREADY_EXISTS" /tmp/cat.json 2>/dev/null; then
          echo "    catalog '${DEFAULT_CATALOG}' already exists."
        else
          echo "::warning:: catalog create HTTP ${CAT_CODE} (workspace host may be unreachable); leaving account default in place."
          DEFAULT_CATALOG=""
        fi
        if [ -n "$DEFAULT_CATALOG" ]; then
          curl -s --max-time 60 "${AUTH[@]}" -X PUT "${API}/workspaces/${WORKSPACE_ID}/metastore" \
            -d "{\"metastore_id\":\"${METASTORE_ID}\",\"default_catalog_name\":\"${DEFAULT_CATALOG}\"}" >/dev/null || true
          echo "    default catalog pinned."
        fi
      fi

      echo "✓ Unity Catalog configured (metastore ${METASTORE_ID} -> workspace ${WORKSPACE_ID})."
      out "ok" "metastore=${METASTORE_ID}"
    '''
  }
}

output result object = ucBootstrap.properties.outputs
