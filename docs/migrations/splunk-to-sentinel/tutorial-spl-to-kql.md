# Tutorial: SPL to KQL Query Conversion

**Status:** Authored 2026-04-30
**Audience:** SOC Analysts, Detection Engineers, Threat Hunters
**Purpose:** 20+ common Splunk SPL queries converted to KQL with detailed explanations for SOC analysts transitioning to Microsoft Sentinel

---

## How to use this tutorial

Each example includes:

1. **Scenario** -- the security use case
2. **SPL query** -- the original Splunk query
3. **KQL query** -- the Sentinel equivalent
4. **Explanation** -- line-by-line breakdown of the conversion
5. **Key differences** -- important behavioral differences to watch for

Work through these examples sequentially to build your KQL fluency, or jump to specific scenarios relevant to your SOC operations.

---

## Authentication and access

### 1. Failed authentication attempts (brute force detection)

**Scenario:** Detect accounts with excessive failed logon attempts in the last hour.

**SPL:**

```spl
index=auth sourcetype=WinEventLog:Security EventCode=4625
| stats count as failure_count, values(src_ip) as source_ips by user
| where failure_count > 20
| sort -failure_count
```

**KQL:**

```kql
SecurityEvent
| where TimeGenerated > ago(1h)
| where EventID == 4625
| summarize
    failure_count = count(),
    source_ips = make_set(IpAddress, 10)
    by TargetAccount
| where failure_count > 20
| sort by failure_count desc
```

**Explanation:**

- `index=auth` becomes the specific table `SecurityEvent`
- `EventCode=4625` becomes `EventID == 4625` (field name changes)
- `stats count` becomes `summarize count()`
- `values(src_ip)` becomes `make_set(IpAddress, 10)` (KQL limits set size for performance)
- `sort -failure_count` becomes `sort by failure_count desc` (explicit direction)

### 2. Password spray detection

**Scenario:** Detect a single IP attempting to authenticate against many accounts.

**SPL:**

```spl
index=auth sourcetype=WinEventLog:Security EventCode=4625
| stats dc(user) as unique_users, count as total_attempts by src_ip
| where unique_users > 10 AND total_attempts > 50
```

**KQL:**

```kql
SecurityEvent
| where TimeGenerated > ago(1h)
| where EventID == 4625
| summarize
    unique_users = dcount(TargetAccount),
    total_attempts = count()
    by IpAddress
| where unique_users > 10 and total_attempts > 50
```

**Key differences:**

- `dc()` (distinct count) maps to `dcount()`
- `AND` (SPL) maps to `and` (KQL, case-insensitive)

### 3. Successful logon after multiple failures

**Scenario:** Detect a successful logon following multiple failed attempts (potential compromise).

**SPL:**

```spl
index=auth sourcetype=WinEventLog:Security (EventCode=4625 OR EventCode=4624)
| stats count(eval(EventCode=4625)) as failures,
        count(eval(EventCode=4624)) as successes,
        latest(_time) as last_event
    by src_ip, user
| where failures > 10 AND successes > 0
```

**KQL:**

```kql
SecurityEvent
| where TimeGenerated > ago(1h)
| where EventID in (4624, 4625)
| summarize
    failures = countif(EventID == 4625),
    successes = countif(EventID == 4624),
    last_event = max(TimeGenerated)
    by IpAddress, TargetAccount
| where failures > 10 and successes > 0
```

**Explanation:**

- `count(eval(EventCode=4625))` becomes `countif(EventID == 4625)` -- cleaner syntax
- `latest(_time)` becomes `max(TimeGenerated)`
- `(EventCode=4625 OR EventCode=4624)` becomes `EventID in (4624, 4625)`

### 4. Logon from unusual country (Entra ID)

**Scenario:** Detect sign-ins from countries not in the approved list.

**SPL:**

```spl
index=azure sourcetype=azure:aad:signin Status.errorCode=0
| lookup approved_countries Country
| where NOT match(approved, "yes")
| stats count by UserPrincipalName, Country, City, IPAddress
```

**KQL:**

```kql
SigninLogs
| where TimeGenerated > ago(24h)
| where ResultType == 0
| where LocationDetails.countryOrRegion !in (
    _GetWatchlist('ApprovedCountries') | project Country
)
| summarize
    count() by UserPrincipalName,
    Country = tostring(LocationDetails.countryOrRegion),
    City = tostring(LocationDetails.city),
    IPAddress
```

**Key differences:**

- Splunk `lookup` maps to KQL `_GetWatchlist()` + `in`/`!in` operator
- JSON field access in KQL uses dot notation: `LocationDetails.countryOrRegion`

---

## Lateral movement

### 5. RDP lateral movement

**Scenario:** Detect hosts making RDP connections to multiple internal hosts.

**SPL:**

```spl
index=firewall sourcetype=pan:traffic dest_port=3389 action=allowed
| stats dc(dest_ip) as unique_destinations by src_ip
| where unique_destinations > 5
| lookup asset_db ip AS src_ip OUTPUT hostname, department
```

**KQL:**

```kql
CommonSecurityLog
| where TimeGenerated > ago(1h)
| where DestinationPort == 3389 and DeviceAction == "Allow"
| summarize
    unique_destinations = dcount(DestinationIP)
    by SourceIP
| where unique_destinations > 5
| join kind=leftouter (
    _GetWatchlist('AssetInventory')
    | project SourceIP = IPAddress, hostname = HostName, department = Department
) on SourceIP
```

### 6. PsExec / remote service installation

**Scenario:** Detect new service installations that may indicate PsExec or similar remote execution.

**SPL:**

```spl
index=windows sourcetype=WinEventLog:System EventCode=7045
| rex field=Service_File_Name "(?<executable>[^\\\]+)$"
| where NOT match(Service_Name, "^(Windows|Microsoft|vmware)")
| stats count by ComputerName, Service_Name, executable, Service_Start_Type
```

**KQL:**

```kql
Event
| where TimeGenerated > ago(24h)
| where EventLog == "System" and EventID == 7045
| extend ServiceName = extract("Service Name:\\s+(.*?)\\.", 1, RenderedDescription)
| extend ServiceFile = extract("Service File Name:\\s+(.*?)\\.", 1, RenderedDescription)
| extend executable = extract("[^\\\\]+$", 0, ServiceFile)
| where ServiceName !startswith "Windows"
    and ServiceName !startswith "Microsoft"
    and ServiceName !startswith "vmware"
| summarize count() by Computer, ServiceName, executable
```

---

## Data exfiltration

### 7. Large outbound data transfer

**Scenario:** Detect hosts sending unusually large amounts of data externally.

**SPL:**

```spl
index=firewall sourcetype=pan:traffic direction=outbound
| stats sum(bytes_out) as total_bytes by src_ip
| eval total_mb = round(total_bytes/1024/1024, 2)
| where total_mb > 500
| sort -total_mb
```

**KQL:**

```kql
CommonSecurityLog
| where TimeGenerated > ago(1h)
| where CommunicationDirection == "Outbound"
| summarize total_bytes = sum(SentBytes) by SourceIP
| extend total_mb = round(total_bytes / 1048576.0, 2)
| where total_mb > 500
| sort by total_mb desc
```

### 8. DNS exfiltration detection

**Scenario:** Detect anomalous DNS query patterns that may indicate DNS tunneling.

**SPL:**

```spl
index=dns sourcetype=dns
| eval query_length=len(query)
| stats avg(query_length) as avg_len, max(query_length) as max_len,
        count as query_count by src_ip
| where avg_len > 50 OR query_count > 1000
```

**KQL:**

```kql
DnsEvents
| where TimeGenerated > ago(1h)
| extend query_length = strlen(Name)
| summarize
    avg_len = avg(query_length),
    max_len = max(query_length),
    query_count = count()
    by ClientIP
| where avg_len > 50 or query_count > 1000
```

### 9. Unusual file sharing activity

**Scenario:** Detect users sharing an unusual number of files externally via SharePoint/OneDrive.

**SPL:**

```spl
index=o365 sourcetype=o365:management:activity Operation=SharingSet
| stats dc(ObjectId) as files_shared, values(ObjectId) as shared_files by UserId
| where files_shared > 20
```

**KQL:**

```kql
OfficeActivity
| where TimeGenerated > ago(24h)
| where Operation == "SharingSet"
| summarize
    files_shared = dcount(OfficeObjectId),
    shared_files = make_set(OfficeObjectId, 25)
    by UserId
| where files_shared > 20
```

---

## Privileged access

### 10. New admin account creation

**Scenario:** Detect creation of new accounts with administrative privileges.

**SPL:**

```spl
index=windows sourcetype=WinEventLog:Security EventCode=4720
| join user [search index=windows EventCode=4732 TargetSid="S-1-5-32-544"]
| table _time, SubjectUserName, user, ComputerName
```

**KQL:**

```kql
SecurityEvent
| where TimeGenerated > ago(24h)
| where EventID == 4720
| join kind=inner (
    SecurityEvent
    | where EventID == 4732
    | where TargetSid == "S-1-5-32-544"  // Administrators group
    | project AddedAccount = MemberName, AddedTime = TimeGenerated, AddedBy = SubjectAccount
) on $left.TargetAccount == $right.AddedAccount
| project TimeGenerated, CreatedBy = SubjectAccount, NewAdmin = TargetAccount, Computer
```

### 11. Privilege escalation via group modification

**Scenario:** Detect users being added to high-privilege security groups.

**SPL:**

```spl
index=windows sourcetype=WinEventLog:Security EventCode=4728 OR EventCode=4732 OR EventCode=4756
| lookup privileged_groups TargetSid OUTPUT group_name, risk_level
| where isnotnull(risk_level)
| stats count by SubjectUserName, MemberName, group_name, risk_level
```

**KQL:**

```kql
SecurityEvent
| where TimeGenerated > ago(24h)
| where EventID in (4728, 4732, 4756)
| join kind=inner (
    _GetWatchlist('PrivilegedGroups')
    | project TargetSid = SID, group_name = GroupName, risk_level = RiskLevel
) on TargetSid
| summarize count() by SubjectAccount, MemberName, group_name, risk_level
```

### 12. Service account interactive logon

**Scenario:** Detect service accounts used for interactive (non-automated) logon.

**SPL:**

```spl
index=auth sourcetype=WinEventLog:Security EventCode=4624 Logon_Type=2 OR Logon_Type=10
| lookup service_accounts user
| where is_service_account="yes"
| stats count by user, src_ip, Logon_Type, ComputerName
```

**KQL:**

```kql
SecurityEvent
| where TimeGenerated > ago(24h)
| where EventID == 4624
| where LogonType in (2, 10)  // Interactive, RemoteInteractive
| where TargetAccount in (
    _GetWatchlist('ServiceAccounts') | project Account
)
| summarize count() by TargetAccount, IpAddress, LogonType, Computer
```

---

## Malware and endpoint

### 13. Suspicious process execution

**Scenario:** Detect known-malicious process names or suspicious parent-child process relationships.

**SPL:**

```spl
index=sysmon sourcetype=XmlWinEventLog:Microsoft-Windows-Sysmon/Operational EventCode=1
| eval proc_lower=lower(Image)
| where match(proc_lower, "(mimikatz|psexec|procdump|lazagne|bloodhound)")
  OR (ParentImage="*\\cmd.exe" AND Image="*\\powershell.exe")
```

**KQL:**

```kql
DeviceProcessEvents
| where TimeGenerated > ago(24h)
| where FileName has_any ("mimikatz", "psexec", "procdump", "lazagne", "bloodhound")
    or (InitiatingProcessFileName == "cmd.exe" and FileName == "powershell.exe")
| project TimeGenerated, DeviceName, AccountName, FileName,
    ProcessCommandLine, InitiatingProcessFileName
```

**Key differences:**

- Sysmon data in Splunk often uses `XmlWinEventLog` sourcetype; in Sentinel, use `DeviceProcessEvents` (Defender for Endpoint) or `Event` (Sysmon via AMA)
- SPL `match()` with regex maps to KQL `has_any()` for simple substring matching or `matches regex` for full regex

### 14. PowerShell encoded command detection

**Scenario:** Detect Base64-encoded PowerShell commands often used by malware.

**SPL:**

```spl
index=sysmon sourcetype=XmlWinEventLog EventCode=1
| where Image="*\\powershell.exe"
| where match(CommandLine, "-[eE]nc|-[eE]ncodedCommand")
| rex field=CommandLine "-[eE]nc(?:odedCommand)?\s+(?<encoded_cmd>\S+)"
| eval decoded=base64decode(encoded_cmd)
```

**KQL:**

```kql
DeviceProcessEvents
| where TimeGenerated > ago(24h)
| where FileName =~ "powershell.exe"
| where ProcessCommandLine matches regex "-[eE]nc(odedCommand)?\\s+"
| extend encoded_cmd = extract("-[eE]nc(?:odedCommand)?\\s+(\\S+)", 1, ProcessCommandLine)
| extend decoded = base64_decode_tostring(encoded_cmd)
| project TimeGenerated, DeviceName, AccountName, ProcessCommandLine, decoded
```

---

## Network and firewall

### 15. Port scan detection

**Scenario:** Detect hosts scanning multiple ports on a target.

**SPL:**

```spl
index=firewall sourcetype=pan:traffic action=denied
| stats dc(dest_port) as ports_scanned, count as connection_attempts
    by src_ip, dest_ip
| where ports_scanned > 20
```

**KQL:**

```kql
CommonSecurityLog
| where TimeGenerated > ago(1h)
| where DeviceAction == "Deny"
| summarize
    ports_scanned = dcount(DestinationPort),
    connection_attempts = count()
    by SourceIP, DestinationIP
| where ports_scanned > 20
```

### 16. Connection to known-bad IP (threat intelligence)

**Scenario:** Detect outbound connections to IP addresses on the threat intelligence list.

**SPL:**

```spl
index=firewall sourcetype=pan:traffic action=allowed direction=outbound
| lookup threat_intel_ip ip AS dest_ip OUTPUT threat_category, threat_source, confidence
| where isnotnull(threat_category)
| stats count, values(threat_category) as categories by src_ip, dest_ip, threat_source
```

**KQL:**

```kql
CommonSecurityLog
| where TimeGenerated > ago(1h)
| where DeviceAction == "Allow" and CommunicationDirection == "Outbound"
| join kind=inner (
    ThreatIntelligenceIndicator
    | where Active == true
    | where ExpirationDateTime > now()
    | where isnotempty(NetworkIP)
    | project ThreatIP = NetworkIP, ThreatType, ConfidenceScore, SourceSystem
) on $left.DestinationIP == $right.ThreatIP
| summarize
    count(),
    ThreatTypes = make_set(ThreatType)
    by SourceIP, DestinationIP, SourceSystem
```

### 17. DNS to suspicious TLD

**Scenario:** Detect DNS queries to suspicious top-level domains.

**SPL:**

```spl
index=dns sourcetype=dns
| rex field=query "\.(?<tld>[^.]+)$"
| where tld IN ("xyz", "top", "club", "work", "buzz", "tk", "ml", "ga", "cf", "gq")
| stats count, dc(query) as unique_queries by src_ip, tld
| where count > 10
```

**KQL:**

```kql
DnsEvents
| where TimeGenerated > ago(24h)
| extend tld = tostring(split(Name, ".")[-1])
| where tld in ("xyz", "top", "club", "work", "buzz", "tk", "ml", "ga", "cf", "gq")
| summarize
    query_count = count(),
    unique_queries = dcount(Name)
    by ClientIP, tld
| where query_count > 10
```

---

## Cloud and identity

### 18. Impossible travel detection

**Scenario:** Detect a user signing in from two geographically distant locations within a short time window.

**SPL:**

```spl
index=azure sourcetype=azure:aad:signin Status.errorCode=0
| stats earliest(_time) as first_login, latest(_time) as last_login,
        values(Country) as countries, dc(Country) as country_count
    by UserPrincipalName
| where country_count > 1
| eval time_diff_hours = round((last_login - first_login) / 3600, 2)
| where time_diff_hours < 2
```

**KQL:**

```kql
SigninLogs
| where TimeGenerated > ago(24h)
| where ResultType == 0
| summarize
    first_login = min(TimeGenerated),
    last_login = max(TimeGenerated),
    countries = make_set(tostring(LocationDetails.countryOrRegion)),
    country_count = dcount(tostring(LocationDetails.countryOrRegion))
    by UserPrincipalName
| where country_count > 1
| extend time_diff_hours = round(datetime_diff('hour', last_login, first_login) * 1.0, 2)
| where time_diff_hours < 2
```

### 19. Azure resource deletion spree

**Scenario:** Detect a principal deleting multiple Azure resources in a short time.

**SPL:**

```spl
index=azure sourcetype=azure:activity operationName="*delete*"
| stats count, dc(resourceId) as resources_deleted,
        values(resourceType) as resource_types
    by caller
| where resources_deleted > 5
```

**KQL:**

```kql
AzureActivity
| where TimeGenerated > ago(1h)
| where OperationNameValue contains "delete"
| where ActivityStatusValue == "Success"
| summarize
    count(),
    resources_deleted = dcount(ResourceId),
    resource_types = make_set(ResourceProviderValue)
    by Caller
| where resources_deleted > 5
```

### 20. Conditional access policy bypass

**Scenario:** Detect sign-ins that bypassed conditional access policies.

**SPL:**

```spl
index=azure sourcetype=azure:aad:signin
| spath output=ca_results path=ConditionalAccessPolicies{}.result
| mvexpand ca_results
| where ca_results="notApplied" OR ca_results="reportOnlyNotApplied"
| stats count by UserPrincipalName, AppDisplayName, IPAddress
| where count > 5
```

**KQL:**

```kql
SigninLogs
| where TimeGenerated > ago(24h)
| mv-expand CAPolicy = ConditionalAccessPolicies
| where CAPolicy.result == "notApplied" or CAPolicy.result == "reportOnlyNotApplied"
| summarize count() by UserPrincipalName, AppDisplayName, IPAddress
| where count_ > 5
```

---

## Advanced patterns

### 21. Time-based anomaly detection

**Scenario:** Detect logon activity outside normal business hours.

**SPL:**

```spl
index=auth sourcetype=WinEventLog:Security EventCode=4624 Logon_Type=10
| eval hour=strftime(_time, "%H")
| eval day_of_week=strftime(_time, "%u")
| where (hour < 6 OR hour > 22) OR day_of_week > 5
| stats count by user, src_ip, ComputerName
| where count > 3
```

**KQL:**

```kql
SecurityEvent
| where TimeGenerated > ago(24h)
| where EventID == 4624 and LogonType == 10
| extend hour = datetime_part("hour", TimeGenerated)
| extend day_of_week = dayofweek(TimeGenerated) / 1d  // 0=Sun, 6=Sat
| where (hour < 6 or hour > 22) or day_of_week in (0, 6)
| summarize count() by TargetAccount, IpAddress, Computer
| where count_ > 3
```

### 22. Statistical outlier detection

**Scenario:** Detect data transfer volumes that are statistical outliers (more than 3 standard deviations from normal).

**SPL:**

```spl
index=proxy sourcetype=web_proxy
| stats sum(bytes_out) as total_bytes by user
| eventstats avg(total_bytes) as mean_bytes, stdev(total_bytes) as std_bytes
| eval zscore = (total_bytes - mean_bytes) / std_bytes
| where zscore > 3
```

**KQL:**

```kql
let baseline = CommonSecurityLog
    | where TimeGenerated > ago(24h)
    | summarize total_bytes = sum(SentBytes) by SourceUserName
    | summarize mean_bytes = avg(total_bytes), std_bytes = stdev(total_bytes);
CommonSecurityLog
| where TimeGenerated > ago(24h)
| summarize total_bytes = sum(SentBytes) by SourceUserName
| extend zscore = (total_bytes - toscalar(baseline | project mean_bytes))
    / toscalar(baseline | project std_bytes)
| where zscore > 3
```

### 23. Multi-stage attack correlation

**Scenario:** Correlate reconnaissance (port scan), initial access (brute force), and lateral movement (RDP) from the same source IP.

**SPL:**

```spl
index=firewall action=denied
| stats dc(dest_port) as scan_ports by src_ip
| where scan_ports > 20
| join src_ip [
    search index=auth action=failure
    | stats count as brute_attempts by src_ip
    | where brute_attempts > 50
]
| join src_ip [
    search index=firewall dest_port=3389 action=allowed
    | stats dc(dest_ip) as rdp_targets by src_ip
    | where rdp_targets > 3
]
| table src_ip, scan_ports, brute_attempts, rdp_targets
```

**KQL:**

```kql
let reconnaissance = CommonSecurityLog
    | where TimeGenerated > ago(4h)
    | where DeviceAction == "Deny"
    | summarize scan_ports = dcount(DestinationPort) by SourceIP
    | where scan_ports > 20;
let brute_force = SecurityEvent
    | where TimeGenerated > ago(4h)
    | where EventID == 4625
    | summarize brute_attempts = count() by IpAddress
    | where brute_attempts > 50
    | project SourceIP = IpAddress, brute_attempts;
let lateral_movement = CommonSecurityLog
    | where TimeGenerated > ago(4h)
    | where DestinationPort == 3389 and DeviceAction == "Allow"
    | summarize rdp_targets = dcount(DestinationIP) by SourceIP
    | where rdp_targets > 3;
reconnaissance
| join kind=inner brute_force on SourceIP
| join kind=inner lateral_movement on SourceIP
| project SourceIP, scan_ports, brute_attempts, rdp_targets
```

---

## Quick reference card

| SPL concept               | KQL equivalent                                   | Example                      |
| ------------------------- | ------------------------------------------------ | ---------------------------- |
| `index=X`                 | Table name                                       | `SecurityEvent`              |
| `sourcetype=Y`            | Table name or `where` filter                     | `SigninLogs`                 |
| `earliest=-1h`            | `where TimeGenerated > ago(1h)`                  | Always add time filter first |
| `\| stats count by field` | `\| summarize count() by field`                  | Core aggregation             |
| `\| eval x=if(a,b,c)`     | `\| extend x=iff(a,b,c)`                         | Conditional logic            |
| `\| rex "(?<f>regex)"`    | `\| extend f=extract("regex",1,field)`           | Regex extraction             |
| `\| lookup table key`     | `\| join (_GetWatchlist('name'))`                | Reference data lookup        |
| `\| dedup field`          | `\| summarize arg_max(TimeGenerated,*) by field` | Deduplication                |
| `\| transaction id`       | `\| summarize make_list() by id`                 | Session grouping             |
| `isnotnull(x)`            | `isnotempty(x)`                                  | Null checking                |
| `\| timechart span=1h`    | `\| summarize by bin(TimeGenerated,1h)`          | Time bucketing               |

---

**Next steps:**

- [Detection Rules Migration](detection-rules-migration.md) -- complete conversion pattern reference
- [Tutorial: SIEM Migration Experience](tutorial-siem-migration-tool.md) -- automated conversion tool
- [Feature Mapping](feature-mapping-complete.md) -- full feature comparison

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
