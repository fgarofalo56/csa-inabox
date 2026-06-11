# Fabric notebook source
# MAGIC %md
# MAGIC # 🧭 Hitchhiker's Guide — 04: Admin & Governance
# MAGIC
# MAGIC Every Fabric REST call below cites its canonical doc. Use a
# MAGIC service-principal token for unattended runs; use `notebookutils`
# MAGIC tokens for interactive use.
# MAGIC
# MAGIC ## Sections
# MAGIC
# MAGIC | # | Topic |
# MAGIC |---|---|
# MAGIC | A | Boilerplate: get a token, set up headers |
# MAGIC | B | Create / list / delete workspace |
# MAGIC | C | Assign workspace to capacity |
# MAGIC | D | Create lakehouse (schemas-enabled) |
# MAGIC | E | Create warehouse |
# MAGIC | F | Workspace role assignment |
# MAGIC | G | Git integration (connect, init, commit, update) |
# MAGIC | H | Deployment pipelines |
# MAGIC | I | Tenant settings (read) |
# MAGIC | J | Semantic model refresh (SPN + XMLA) |
# MAGIC | K | Workspace monitoring KQL |

# COMMAND ----------

# MAGIC %md
# MAGIC ## A — Boilerplate

# COMMAND ----------
import json, time
import requests
from azure.identity import DefaultAzureCredential

# Azure-native control plane = Azure Resource Manager (ARM). Enumerate Synapse
# workspaces (the Loom analytics workspaces) instead of Fabric workspaces.
cred  = DefaultAzureCredential()
token = cred.get_token("https://management.azure.com/.default").token
hdr   = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
sub   = "<subscription-id>"
base  = "https://management.azure.com"

def poll(operation_url: str, timeout_s: int = 600):
    """ARM long-running ops return 202 + Azure-AsyncOperation/Location header."""
    start = time.time()
    while True:
        r = requests.get(operation_url, headers=hdr, timeout=30).json()
        if r.get("status") in {"Succeeded", "Failed", "Canceled"}:
            return r
        if time.time() - start > timeout_s:
            raise TimeoutError(operation_url)
        time.sleep(5)

ws = requests.get(
    f"{base}/subscriptions/{sub}/providers/Microsoft.Synapse/workspaces?api-version=2021-06-01",
    headers=hdr, timeout=30,
).json()
print(json.dumps(ws, indent=2)[:400])
# COMMAND ----------

# MAGIC %md
# MAGIC ## B — Workspace CRUD
# MAGIC
# MAGIC 🔗 [create-workspace](https://learn.microsoft.com/en-us/rest/api/fabric/core/workspaces/create-workspace)

# COMMAND ----------

# Create
r = requests.post(f"{base}/workspaces",
  headers=hdr, data=json.dumps({"displayName": "wf-prod", "description": "Wildfire prod"}),
  timeout=30)
ws_id = r.json()["id"]

# List
ws_all = requests.get(f"{base}/workspaces", headers=hdr).json()

# Delete (irreversible — confirm carefully)
# requests.delete(f"{base}/workspaces/{ws_id}", headers=hdr)

# COMMAND ----------

# MAGIC %md
# MAGIC ## C — Assign workspace to capacity
# MAGIC
# MAGIC 🔗 [assign-to-capacity](https://learn.microsoft.com/en-us/rest/api/fabric/core/workspaces/assign-to-capacity)

# COMMAND ----------

requests.post(
  f"{base}/workspaces/{ws_id}/assignToCapacity",
  headers=hdr,
  data=json.dumps({"capacityId": "<capacity-id>"}),
  timeout=30,
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## D — Create lakehouse (schemas-enabled)
# MAGIC
# MAGIC 2026: prefer schemas-enabled lakehouses; old lakehouses can't switch.

# COMMAND ----------

r = requests.post(f"{base}/workspaces/{ws_id}/lakehouses",
  headers=hdr,
  data=json.dumps({
    "displayName": "lh_bronze",
    "description": "raw ingestion",
    "creationPayload": {"enableSchemas": True},
  }),
  timeout=30)
print(r.status_code)
if r.status_code == 202:
    print(poll(r.headers["Location"]))

# COMMAND ----------

# MAGIC %md
# MAGIC ## E — Create warehouse

# COMMAND ----------

r = requests.post(f"{base}/workspaces/{ws_id}/warehouses",
  headers=hdr,
  data=json.dumps({
    "displayName": "wh_gold",
    "creationPayload": {
      # Case-sensitive collation is the F-SKU default since 2026; specify
      # explicitly to be safe across regions.
      "collationType": "Latin1_General_100_CI_AS_KS_WS_SC_UTF8"
    },
  }),
  timeout=30)
print(r.status_code, r.text[:200])

# COMMAND ----------

# MAGIC %md
# MAGIC ## F — Workspace role assignment
# MAGIC
# MAGIC 🔗 [add-workspace-role-assignment](https://learn.microsoft.com/en-us/rest/api/fabric/core/workspaces/add-workspace-role-assignment)
# MAGIC
# MAGIC Cap: **1000 principals per workspace** (groups count as 1).

# COMMAND ----------

requests.post(
  f"{base}/workspaces/{ws_id}/roleAssignments",
  headers=hdr,
  data=json.dumps({
    "principal": {"id": "<group-id>", "type": "Group"},
    "role": "Viewer",
  }),
  timeout=30,
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## G — Git integration
# MAGIC
# MAGIC 🔗 [git/connect](https://learn.microsoft.com/en-us/rest/api/fabric/core/git/connect),
# MAGIC [git-automation](https://learn.microsoft.com/en-us/fabric/cicd/git-integration/git-automation)

# COMMAND ----------

# 1. Connect
requests.post(f"{base}/workspaces/{ws_id}/git/connect", headers=hdr, data=json.dumps({
  "gitProviderDetails": {
    "organizationName": "contoso",
    "projectName": "DataPlatform",
    "repositoryName": "fabric-poc",
    "branchName": "main",
    "directoryName": "/fabric",
  },
  "myGitCredentials": {"source": "ConfiguredConnection", "connectionId": "<conn>"},
}))

# 2. Initialize
requests.post(f"{base}/workspaces/{ws_id}/git/initializeConnection", headers=hdr,
              data=json.dumps({"initializationStrategy": "PreferWorkspace"}))

# 3. Commit (workspace → Git)
requests.post(f"{base}/workspaces/{ws_id}/git/commitToGit", headers=hdr,
              data=json.dumps({"mode": "All", "comment": "Promote from dev"}))

# 4. Update (Git → workspace)
requests.post(f"{base}/workspaces/{ws_id}/git/updateFromGit", headers=hdr,
              data=json.dumps({"conflictResolution": {"conflictResolutionType": "Workspace",
                                                       "conflictResolutionPolicy": "PreferWorkspace"}}))

# COMMAND ----------

# MAGIC %md
# MAGIC ## H — Deployment pipelines
# MAGIC
# MAGIC 🚩 **Retirement notice (Feb 12 2026):** deployment pipelines stop
# MAGIC supporting semantic models that haven't been upgraded to Enhanced
# MAGIC Metadata.

# COMMAND ----------

# 🔗 https://learn.microsoft.com/en-us/fabric/cicd/deployment-pipelines/intro-to-deployment-pipelines
requests.post(f"{base}/deploymentPipelines/<id>/deploy", headers=hdr, data=json.dumps({
  "sourceStageOrder": 0,
  "targetStageOrder": 1,
  "options": {"allowOverwriteArtifact": True},
}))

# COMMAND ----------

# MAGIC %md
# MAGIC ## I — Tenant settings (read)
# MAGIC
# MAGIC 🔗 [list-tenant-settings](https://learn.microsoft.com/en-us/rest/api/fabric/admin/tenants/list-tenant-settings)

# COMMAND ----------

requests.get(f"{base}/admin/tenantsettings", headers=hdr).json()

# COMMAND ----------

# MAGIC %md
# MAGIC ## J — Semantic model refresh (SPN + XMLA)
# MAGIC
# MAGIC 🔗 [asynchronous-refresh](https://learn.microsoft.com/en-us/power-bi/connect-data/asynchronous-refresh)
# MAGIC
# MAGIC ✅ Recommended SPN pattern:
# MAGIC 1. SPN is **Member** of the workspace.
# MAGIC 2. Tenant setting "Service principals can call Fabric public APIs" is
# MAGIC    scoped to the SPN's security group.
# MAGIC 3. On Premium: 5-hour refresh max via REST; bypass via XMLA endpoint.
# MAGIC 4. SPNs can't be RLS/OLS members — use **Fixed Identity** on Direct Lake.

# COMMAND ----------
# Azure-native semantic-model refresh: the Loom semantic layer is served by
# Azure Analysis Services (or the Direct-Lake-Shim warm-cache materializer) —
# not a Power BI workspace. Trigger a model refresh via the AAS REST API.
from azure.identity import DefaultAzureCredential

cred  = DefaultAzureCredential()
token = cred.get_token("https://*.asazure.windows.net/.default").token
requests.post(
    "https://<region>.asazure.windows.net/servers/<server>/models/<model>/refreshes",
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    data=json.dumps({"Type": "Full", "CommitMode": "transactional", "RetryCount": 1}),
)
# Or use the Loom Direct-Lake-Shim: POST /api/items/semantic-model/<id>/refresh.
# COMMAND ----------

# MAGIC %md
# MAGIC ## K — Workspace monitoring KQL
# MAGIC
# MAGIC Workspace Monitoring exposes operational telemetry via an Eventhouse;
# MAGIC 30-day retention; Contributor+ can read.
# MAGIC 🔗 [workspace-monitoring-overview](https://learn.microsoft.com/en-us/fabric/fundamentals/workspace-monitoring-overview)

# COMMAND ----------

# MAGIC %md
# MAGIC ```kusto
# MAGIC // Eventhouse ingestion load — 24h, 15-min bins
# MAGIC EventhouseMetrics
# MAGIC | where Timestamp > ago(1d)
# MAGIC | where MetricName == "IngestsLoadFactor"
# MAGIC | summarize MinValue=min(MetricMinValue), MaxValue=max(MetricMaxValue) by bin(Timestamp, 15m)
# MAGIC | render timechart
# MAGIC ```
