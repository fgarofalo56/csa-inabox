# Tutorial: SIEM Migration Experience for Splunk

**Status:** Authored 2026-04-30
**Audience:** Detection Engineers, SOC Analysts, Security Engineers
**Purpose:** Step-by-step walkthrough of Microsoft's SIEM Migration Experience tool for converting Splunk detection rules to Sentinel analytics rules

---

## Overview

The **SIEM Migration Experience** is a purpose-built tool in the Microsoft Defender portal that automates the conversion of Splunk detection rules (correlation searches, scheduled searches, alerts) to Microsoft Sentinel analytics rules. It uses Security Copilot to translate SPL queries to KQL and provides a side-by-side review interface.

**What you will accomplish:**

1. Export detection rules from Splunk
2. Upload rules to the SIEM Migration Experience
3. Review Copilot-translated KQL rules
4. Configure data connectors for rule dependencies
5. Deploy validated analytics rules to Sentinel
6. Verify detection coverage

**Prerequisites:**

- Microsoft Sentinel workspace deployed
- Microsoft Defender portal access with Sentinel Contributor role
- Security Copilot enabled (for translation quality)
- Splunk admin access (to export rules)
- Estimated time: 1-2 hours for initial walkthrough; days to weeks for full rule library

---

## Step 1: Export detection rules from Splunk

### Method A: Export from Splunk ES (Enterprise Security)

```spl
# List all enabled correlation searches
| rest /servicesNS/-/-/saved/searches
| search disabled=0 action.correlationsearch.enabled=1
| table title, search, cron_schedule, action.correlationsearch.label,
        action.notable.param.severity, action.notable.param.rule_title
| outputcsv correlation_searches_export.csv
```

### Method B: Export all saved searches and alerts

```spl
# Export all enabled saved searches with alert actions
| rest /servicesNS/-/-/saved/searches
| search disabled=0
| search alert.severity!=0 OR is_scheduled=1 OR action.correlationsearch.enabled=1
| table title, search, cron_schedule, alert.severity, description,
        action.email.to, action.script, dispatch.earliest_time, dispatch.latest_time
| outputcsv all_detection_rules_export.csv
```

### Method C: Export individual rule files

For large rule libraries, export each rule as a separate file:

```bash
# Use Splunk CLI to export saved searches
/opt/splunk/bin/splunk search '| rest /servicesNS/-/-/saved/searches
| search disabled=0 action.correlationsearch.enabled=1
| table title, search' -output json > detection_rules.json

# Or export the savedsearches.conf directly
cp /opt/splunk/etc/apps/SA-*/local/savedsearches.conf ./splunk_rules/
cp /opt/splunk/etc/apps/SplunkEnterpriseSecuritySuite/local/savedsearches.conf ./splunk_rules/es_rules.conf
```

### Prepare the export file

The SIEM Migration Experience accepts Splunk export files in CSV or JSON format. Ensure each rule includes:

- **Rule name** (title)
- **SPL query** (search)
- **Schedule** (cron_schedule)
- **Severity** (alert.severity or action.notable.param.severity)
- **Description** (description)

---

## Step 2: Access the SIEM Migration Experience

1. Navigate to the **Microsoft Defender portal** (https://security.microsoft.com)
2. In the left navigation, expand **Microsoft Sentinel**
3. Select **Content management** > **SIEM Migration**
4. Alternatively, navigate directly to: **Settings** > **Microsoft Sentinel** > **SIEM Migration**

!!! note "Azure Government"
For Azure Government environments, access the Defender portal at https://security.microsoft.us. The SIEM Migration Experience is available in Azure Government with the same functionality.

---

## Step 3: Upload Splunk detection rules

1. On the SIEM Migration page, select **Create new migration**
2. Select **Splunk** as the source SIEM
3. Upload your exported rules file (CSV or JSON)
4. The tool will parse and validate the uploaded rules
5. You will see a summary: total rules detected, parsing success/failure count

### Upload validation

The tool validates each rule and categorizes them:

| Status                  | Meaning                                                        | Action required                                |
| ----------------------- | -------------------------------------------------------------- | ---------------------------------------------- |
| **Parsed successfully** | SPL query recognized and ready for translation                 | Proceed to review                              |
| **Parse warning**       | SPL parsed with warnings (e.g., macro references not resolved) | Review -- may need manual macro expansion      |
| **Parse failed**        | SPL could not be parsed                                        | Export rule manually and resolve syntax issues |

---

## Step 4: Review Copilot-translated rules

After upload, Security Copilot translates each SPL rule to KQL. The review interface shows:

### Translation status categories

| Translation status       | Description                                                     | Typical percentage |
| ------------------------ | --------------------------------------------------------------- | ------------------ |
| **Fully translated**     | SPL fully converted to valid KQL with correct logic             | 50-80% of rules    |
| **Partially translated** | Most of the SPL converted; some elements need manual completion | 15-35% of rules    |
| **Not translated**       | SPL too complex for automated translation                       | 5-15% of rules     |

### Side-by-side review

For each rule, you see:

**Left panel (Splunk):**

```spl
# Original SPL
index=auth sourcetype=linux:auth action=failure
| stats count as failure_count by src_ip, user
| where failure_count > 20
| lookup admin_users user OUTPUT is_admin
| where is_admin="true"
```

**Right panel (Sentinel):**

```kql
// Translated KQL
Syslog
| where TimeGenerated > ago(1h)
| where Facility == "auth" and SyslogMessage contains "Failed"
| summarize failure_count = count() by SrcIP = extract("from (\\S+)", 1, SyslogMessage),
    user = extract("for (\\w+)", 1, SyslogMessage)
| where failure_count > 20
| join kind=inner (
    _GetWatchlist('AdminUsers')
    | project user = UserName
) on user
```

### Review actions for each rule

| Action     | When to use                                                      |
| ---------- | ---------------------------------------------------------------- |
| **Accept** | Translation is correct and complete                              |
| **Modify** | Translation is mostly correct but needs adjustment               |
| **Reject** | Translation is wrong; you will rewrite manually                  |
| **Skip**   | Rule is no longer needed or duplicates existing Sentinel content |

### Modification workflow

When modifying a partially translated rule:

1. Click **Edit** on the KQL translation
2. Adjust the KQL query in the editor
3. Click **Run query** to validate against your Log Analytics workspace
4. Verify results match expected detection behavior
5. Click **Save** to accept the modified translation

---

## Step 5: Configure data connectors

The SIEM Migration Experience identifies which Sentinel data connectors are required for each translated rule:

### Data connector recommendations

The tool analyzes your translated rules and provides a connector checklist:

| Required connector              | Status         | Sentinel table        | Rules dependent |
| ------------------------------- | -------------- | --------------------- | --------------- |
| Windows Security Events via AMA | Not configured | SecurityEvent         | 45 rules        |
| Syslog via AMA                  | Not configured | Syslog                | 23 rules        |
| Microsoft Entra ID              | Configured     | SigninLogs, AuditLogs | 18 rules        |
| CEF via AMA                     | Not configured | CommonSecurityLog     | 15 rules        |
| Microsoft 365                   | Configured     | OfficeActivity        | 8 rules         |
| Microsoft Defender XDR          | Configured     | AlertEvidence         | 12 rules        |

### Configure missing connectors

For each "Not configured" connector:

1. Click **Configure connector** to open the connector configuration page
2. Follow the connector-specific setup instructions
3. Verify data is flowing by running a test query
4. Return to the migration tool and refresh connector status

!!! warning "Configure connectors before deploying rules"
Analytics rules will not generate alerts if their required data sources are not connected. Always verify data flow before enabling migrated rules.

---

## Step 6: Deploy analytics rules to Sentinel

### Bulk deployment

1. Select all accepted/modified rules (or use filters: severity, translation status, data source)
2. Click **Deploy to Sentinel**
3. Configure deployment settings:
    - **Rule status:** Enabled or Disabled (recommended: start Disabled for validation)
    - **Workspace:** Select target Sentinel workspace
    - **Resource group:** Confirm resource group

### Deployment configuration per rule

For each deployed rule, the tool configures:

| Setting            | Source                                | Notes                                                                     |
| ------------------ | ------------------------------------- | ------------------------------------------------------------------------- |
| **Query**          | Translated KQL                        | Your reviewed and accepted query                                          |
| **Frequency**      | Splunk cron schedule                  | Mapped to Sentinel frequency (e.g., cron `*/5 * * * *` becomes 5 minutes) |
| **Lookup period**  | Splunk earliest/latest                | Mapped to query time window                                               |
| **Severity**       | Splunk alert severity                 | Mapped: critical/high/medium/low/informational                            |
| **MITRE ATT&CK**   | Splunk ES ATT&CK mapping (if present) | Carried forward to Sentinel rule                                          |
| **Entity mapping** | Copilot-recommended                   | IP, Account, Host entities mapped from query fields                       |
| **Alert grouping** | Default                               | Configure post-deployment based on alert volume                           |

### Post-deployment verification

```kql
// Verify deployed analytics rules
SentinelAudit
| where TimeGenerated > ago(1h)
| where OperationName == "Create Analytics Rule"
| project TimeGenerated, RuleName = ExtendedProperties.RuleName, Status
| sort by TimeGenerated desc
```

---

## Step 7: Validate detection coverage

### Enable rules in batches

1. Start with high-severity rules (Critical, High)
2. Enable 10-20 rules at a time
3. Monitor for 24-48 hours
4. Review generated incidents for false positive rate
5. Tune queries as needed (add exclusions, adjust thresholds)
6. Proceed to next batch

### Comparison validation

```kql
// Compare Sentinel alerts vs Splunk notables (during parallel run)
// Run this in Sentinel to see detection volume
SecurityAlert
| where TimeGenerated > ago(24h)
| summarize AlertCount = count() by AlertName, ProviderName
| sort by AlertCount desc

// Compare with Splunk notable count for the same period
// (run equivalent query in Splunk during parallel run)
```

### MITRE ATT&CK coverage check

```kql
// Verify MITRE ATT&CK coverage after rule deployment
SecurityAlert
| where TimeGenerated > ago(7d)
| extend Tactics = parse_json(ExtendedProperties).Tactics
| mv-expand Tactics
| summarize RuleCount = dcount(AlertName) by tostring(Tactics)
| sort by RuleCount desc
```

---

## Step 8: Iterate and complete

### Migration tracking dashboard

Create a workbook to track migration progress:

```kql
// Migration progress summary
let total_rules = 500; // Total Splunk rules in scope
let migrated = toscalar(
    SentinelAudit
    | where OperationName == "Create Analytics Rule"
    | summarize dcount(ExtendedProperties.RuleName)
);
let enabled = toscalar(
    SentinelHealth
    | where OperationName == "Analytics Rule" and Status == "Enabled"
    | summarize dcount(SentinelResourceName)
);
print
    TotalSplunkRules = total_rules,
    MigratedToSentinel = migrated,
    EnabledInSentinel = enabled,
    MigrationPercent = round(100.0 * migrated / total_rules, 1),
    EnablementPercent = round(100.0 * enabled / total_rules, 1)
```

### Common issues and resolutions

| Issue                         | Cause                                                 | Resolution                                                             |
| ----------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------- |
| Rule generates no alerts      | Data connector not configured or data not flowing     | Verify data connector status and run test query                        |
| Excessive false positives     | KQL translation too broad compared to SPL             | Add watchlist exclusions, tighten filters                              |
| Missing fields in translation | Splunk field extraction not mapped to Sentinel schema | Update DCR transforms or add `extend`/`extract` in KQL                 |
| Macro references unresolved   | Splunk macros not expanded before export              | Expand macros in SPL before re-uploading                               |
| Lookup table not available    | Splunk lookup not migrated to watchlist               | Create watchlist with lookup data, update KQL to use `_GetWatchlist()` |

---

## Summary

The SIEM Migration Experience significantly accelerates Splunk-to-Sentinel detection rule migration:

1. **Export** Splunk detection rules (correlation searches, saved searches, alerts)
2. **Upload** to the SIEM Migration tool in the Defender portal
3. **Review** Copilot-translated KQL rules side-by-side with original SPL
4. **Configure** required data connectors
5. **Deploy** validated analytics rules to Sentinel
6. **Validate** detection coverage and tune false positives
7. **Iterate** until full detection library is migrated

For rules that require manual conversion, see [Detection Rules Migration](detection-rules-migration.md) and [Tutorial: SPL to KQL](tutorial-spl-to-kql.md).

---

**Next steps:**

- [Tutorial: SPL to KQL](tutorial-spl-to-kql.md) -- manual conversion examples for complex rules
- [Detection Rules Migration](detection-rules-migration.md) -- comprehensive conversion patterns
- [SOAR Migration](soar-migration.md) -- migrate automation playbooks

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
