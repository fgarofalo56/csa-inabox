# Databricks notebook source
# MAGIC %md
# MAGIC # 03 — KQL Threat Hunting Queries
# MAGIC
# MAGIC Reference KQL queries for Azure Log Analytics threat hunting.
# MAGIC These queries can be executed directly in Sentinel or via the
# MAGIC Azure Monitor Query API from Databricks.

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup — Log Analytics Query Client

# COMMAND ----------

from datetime import timedelta

import pandas as pd
from azure.identity import DefaultAzureCredential
from azure.monitor.query import LogsQueryClient

# Configuration
WORKSPACE_ID = spark.conf.get("spark.cybersecurity.workspace_id", "<your-workspace-id>")

try:
    credential = DefaultAzureCredential()
    client = LogsQueryClient(credential)
    LIVE_MODE = True
    print(f"Connected to Log Analytics workspace: {WORKSPACE_ID}")
except Exception:
    LIVE_MODE = False
    print("Running in demo mode — KQL queries shown as reference only")


def run_kql(query: str, timespan: timedelta = timedelta(days=1)) -> pd.DataFrame:
    """Execute a KQL query against Log Analytics or display as reference."""
    if LIVE_MODE:
        response = client.query_workspace(WORKSPACE_ID, query, timespan=timespan)
        if response.tables:
            table = response.tables[0]
            return pd.DataFrame(
                data=table.rows, columns=[c.name for c in table.columns]
            )
    print(f"--- KQL Query ---\n{query}\n-----------------")
    return pd.DataFrame()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Hunt 1: Unusual Process Execution
# MAGIC
# MAGIC Find processes launched from uncommon paths that may indicate malware.

# COMMAND ----------

kql_unusual_processes = """
SecurityEvent
| where TimeGenerated > ago(24h)
| where EventID == 4688
| where ProcessName !startswith "C:\\\\Windows\\\\"
  and ProcessName !startswith "C:\\\\Program Files\\\\"
  and ProcessName !startswith "C:\\\\Program Files (x86)\\\\"
| summarize
    ExecutionCount = count(),
    Hosts = dcount(Computer),
    HostList = make_set(Computer, 5)
  by ProcessName, ParentProcessName
| where ExecutionCount < 3
| order by ExecutionCount asc
"""

df_result = run_kql(kql_unusual_processes)
if not df_result.empty:
    display(spark.createDataFrame(df_result))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Hunt 2: Lateral Movement — Pass-the-Hash Indicators

# COMMAND ----------

kql_pth = """
SecurityEvent
| where TimeGenerated > ago(7d)
| where EventID == 4624
| where LogonType == 9 or (LogonType == 3 and AuthenticationPackageName == "NTLM")
| where AccountType == "User"
| summarize
    LogonCount = count(),
    UniqueTargets = dcount(Computer),
    Targets = make_set(Computer, 10)
  by TargetAccount, IpAddress
| where UniqueTargets > 3
| order by UniqueTargets desc
"""

df_result = run_kql(kql_pth, timedelta(days=7))
if not df_result.empty:
    display(spark.createDataFrame(df_result))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Hunt 3: C2 Beaconing Detection
# MAGIC
# MAGIC Identify periodic outbound connections that may indicate C2 communication.

# COMMAND ----------

kql_beaconing = """
AzureNetworkAnalytics_CL
| where TimeGenerated > ago(24h)
| where FlowDirection_s == "O" and FlowStatus_s == "A"
| where not(ipv4_is_private(DestIP_s))
| summarize
    ConnectionCount = count(),
    AvgInterval = avg(datetime_diff('second', TimeGenerated, prev(TimeGenerated, 1)))
  by SrcIP_s, DestIP_s, DestPort_d, bin(TimeGenerated, 1h)
| where ConnectionCount > 20
| extend BeaconScore = iff(AvgInterval between (50 .. 70), "High", "Low")
| where BeaconScore == "High"
| project SrcIP_s, DestIP_s, DestPort_d, ConnectionCount, AvgInterval, BeaconScore
"""

df_result = run_kql(kql_beaconing)
if not df_result.empty:
    display(spark.createDataFrame(df_result))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Hunt 4: Privilege Escalation — New Admin Accounts

# COMMAND ----------

kql_new_admins = """
SecurityEvent
| where TimeGenerated > ago(7d)
| where EventID == 4728 or EventID == 4732 or EventID == 4756
| where TargetSid endswith "-500" or TargetSid endswith "-512"
  or TargetSid endswith "-544" or TargetSid endswith "-519"
| project
    TimeGenerated,
    SubjectAccount,
    MemberName,
    TargetGroup = TargetAccount,
    Computer,
    Activity
| order by TimeGenerated desc
"""

df_result = run_kql(kql_new_admins, timedelta(days=7))
if not df_result.empty:
    display(spark.createDataFrame(df_result))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Export Findings to Gold Layer

# COMMAND ----------

# In production, threat hunting findings are saved to Gold for tracking
findings = [
    {"hunt_id": "HUNT-001", "name": "Unusual Process Execution", "status": "Review"},
    {"hunt_id": "HUNT-002", "name": "Pass-the-Hash Indicators", "status": "Review"},
    {"hunt_id": "HUNT-003", "name": "C2 Beaconing Detection", "status": "Review"},
    {"hunt_id": "HUNT-004", "name": "New Admin Account Creation", "status": "Review"},
]

df_findings = spark.createDataFrame(findings)

GOLD_TABLE = "cybersecurity_gold.threat_hunt_findings"
try:
    df_findings.write.mode("overwrite").saveAsTable(GOLD_TABLE)
    print(f"Exported {len(findings)} hunt findings to {GOLD_TABLE}")
except Exception as e:
    print(f"Could not write to Gold (expected in dev): {e}")
    display(df_findings)
