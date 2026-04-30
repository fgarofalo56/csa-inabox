# Best Practices: AVD Operations and Optimization

**Audience:** VDI Engineers, Platform Engineers, Cloud Architects, Operations Teams
**Scope:** Image management lifecycle, scaling plans, cost optimization, user acceptance testing, and the CSA-in-a-Box data analyst desktop pattern.
**Last updated:** 2026-04-30

---

## 1. Image management lifecycle

### 1.1 Golden image strategy

Maintain a minimal number of golden images. Each additional image multiplies the maintenance burden.

| Image type             | Purpose                                                         | Recommended for         |
| ---------------------- | --------------------------------------------------------------- | ----------------------- |
| **Base image**         | Windows 11 multi-session + Office + FSLogix + security baseline | All users (default)     |
| **Data analyst image** | Base + Power BI Desktop + Azure Data Studio + Python + VS Code  | CSA-in-a-Box data users |
| **GPU image**          | Base + GPU drivers + CAD/GIS applications                       | GPU workstation users   |
| **Task worker image**  | Base (minimal) + single LOB application                         | Task workers            |

**Target: 2--4 images maximum.** Use MSIX app attach for application layering rather than creating additional images for each application set.

### 1.2 Image build pipeline

Automate image building with Azure DevOps or GitHub Actions:

```yaml
# .github/workflows/avd-image-build.yml
name: Build AVD Golden Image
on:
    schedule:
        - cron: "0 2 * * 1" # Weekly Monday 2 AM
    workflow_dispatch:

jobs:
    build-image:
        runs-on: ubuntu-latest
        steps:
            - name: Create image build VM
              uses: azure/cli@v2
              with:
                  inlineScript: |
                      az vm create \
                        --name vm-image-build \
                        --resource-group rg-avd-images \
                        --image MicrosoftWindowsDesktop:windows-11:win11-24h2-avd:latest \
                        --size Standard_D8s_v5 \
                        --admin-username imagebuilder \
                        --admin-password ${{ secrets.IMAGE_BUILD_PASSWORD }}

            - name: Run customization script
              uses: azure/cli@v2
              with:
                  inlineScript: |
                      az vm run-command invoke \
                        --name vm-image-build \
                        --resource-group rg-avd-images \
                        --command-id RunPowerShellScript \
                        --scripts @scripts/customize-image.ps1

            - name: Install applications
              uses: azure/cli@v2
              with:
                  inlineScript: |
                      az vm run-command invoke \
                        --name vm-image-build \
                        --resource-group rg-avd-images \
                        --command-id RunPowerShellScript \
                        --scripts @scripts/install-apps.ps1

            - name: Run VDOT optimization
              uses: azure/cli@v2
              with:
                  inlineScript: |
                      az vm run-command invoke \
                        --name vm-image-build \
                        --resource-group rg-avd-images \
                        --command-id RunPowerShellScript \
                        --scripts @scripts/run-vdot.ps1

            - name: Sysprep and capture
              uses: azure/cli@v2
              with:
                  inlineScript: |
                      az vm run-command invoke \
                        --name vm-image-build \
                        --resource-group rg-avd-images \
                        --command-id RunPowerShellScript \
                        --scripts "C:\Windows\System32\Sysprep\sysprep.exe /generalize /oobe /shutdown /mode:vm"

                      # Wait for VM to stop
                      az vm wait --name vm-image-build -g rg-avd-images --custom "instanceView.statuses[?code=='PowerState/stopped']"

                      # Capture to gallery
                      az sig image-version create \
                        --gallery-name galAVDImages \
                        --resource-group rg-avd-images \
                        --gallery-image-definition win11-multisession-analytics \
                        --gallery-image-version $(date +%Y.%m.%d) \
                        --managed-image $(az vm show -n vm-image-build -g rg-avd-images --query id -o tsv) \
                        --replica-count 2 \
                        --target-regions eastus2 westus2

                      # Clean up build VM
                      az vm delete --name vm-image-build -g rg-avd-images --yes
```

### 1.3 Image update cadence

| Update type             | Frequency                        | Trigger                                                  |
| ----------------------- | -------------------------------- | -------------------------------------------------------- |
| **Security patches**    | Monthly (Patch Tuesday + 7 days) | Windows Update cumulative update                         |
| **Application updates** | Bi-weekly or monthly             | New version of Power BI Desktop, Azure Data Studio, etc. |
| **OS feature update**   | Semi-annual                      | New Windows 11 feature update (e.g., 24H2)               |
| **Emergency patch**     | As needed                        | Critical/zero-day vulnerability                          |

### 1.4 Image rollback

Maintain at least 3 image versions in Azure Compute Gallery:

- **Current** (latest, in production)
- **Previous** (last known good, for rollback)
- **Archive** (two versions back, for investigation)

To rollback:

```bash
# Update host pool to use previous image version
# 1. Create new session hosts from previous image
# 2. Drain sessions from current hosts
# 3. Delete current hosts
# 4. New hosts with previous image serve users
```

---

## 2. Scaling plans

### 2.1 Design principles

| Principle                          | Implementation                                                           |
| ---------------------------------- | ------------------------------------------------------------------------ |
| **Match business hours**           | Schedule ramp-up 30 min before first users arrive                        |
| **Use depth-first for cost**       | DepthFirst during ramp-down fills remaining hosts before stopping others |
| **Buffer for burst**               | Set ramp-up minimum at 20--30% of peak capacity                          |
| **Notify before logoff**           | 30-minute warning message before forced logoff                           |
| **Don't force logoff during peak** | ForceLogoffUsers = false during ramp-down; let sessions drain            |

### 2.2 Scaling plan templates

**Standard business hours (US East):**

| Phase     | Start time | Load balancing | Min hosts % | Capacity threshold % |
| --------- | ---------- | -------------- | ----------- | -------------------- |
| Ramp-up   | 07:00      | BreadthFirst   | 25%         | 60%                  |
| Peak      | 09:00      | BreadthFirst   | 100%        | 80%                  |
| Ramp-down | 17:00      | DepthFirst     | 10%         | 90%                  |
| Off-peak  | 19:00      | DepthFirst     | 0%          | 100%                 |

**24/7 operations (shift work):**

| Phase                     | Start time | Load balancing | Min hosts % | Capacity threshold % |
| ------------------------- | ---------- | -------------- | ----------- | -------------------- |
| Day shift ramp-up         | 06:00      | BreadthFirst   | 30%         | 60%                  |
| Day shift peak            | 08:00      | BreadthFirst   | 100%        | 80%                  |
| Day-to-evening transition | 16:00      | DepthFirst     | 60%         | 80%                  |
| Evening shift             | 18:00      | DepthFirst     | 40%         | 80%                  |
| Night shift               | 22:00      | DepthFirst     | 20%         | 90%                  |

**Weekend/holiday:**

Create separate scaling plans for weekends with lower minimum hosts and earlier off-peak start.

### 2.3 Start VM on Connect

Enable Start VM on Connect for off-peak hours to avoid maintaining always-on VMs:

```bash
az desktopvirtualization hostpool update \
  --name hp-analytics-prod \
  --resource-group rg-avd-prod \
  --start-vm-on-connect true
```

When all VMs are deallocated (off-peak, 0% minimum), the first user connection triggers a VM start. Connection time increases by 1--2 minutes for the cold-start user, but compute cost drops to zero during idle periods.

---

## 3. Cost optimization

### 3.1 Reserved Instances strategy

| Commitment        | Savings | Best for                    |
| ----------------- | ------- | --------------------------- |
| **No commitment** | 0%      | Dev/test, POC, temporary    |
| **1-year RI**     | 30--40% | Production steady-state     |
| **3-year RI**     | 50--60% | Long-term production        |
| **Savings Plan**  | 15--30% | Flexible across VM families |

**Recommended approach:** purchase RIs for the minimum number of VMs needed during peak (the steady-state base). Use pay-as-you-go for burst capacity above the base.

Example: if peak requires 100 VMs and off-peak requires 10:

- Buy 1-year RIs for 40 VMs (the reliable daytime minimum)
- Pay-as-you-go for 0--60 additional VMs (scaled by autoscale plan)
- Off-peak: 10 VMs running, 30 RIs unused but amortized

### 3.2 VM right-sizing

Monitor actual usage and right-size:

```kusto
// Identify over-provisioned host pools
Perf
| where TimeGenerated > ago(7d)
| where ObjectName == "Processor Information" and CounterName == "% Processor Time" and InstanceName == "_Total"
| summarize AvgCPU = avg(CounterValue), P95CPU = percentile(CounterValue, 95) by Computer
| where P95CPU < 40  // P95 CPU below 40% suggests over-provisioning
| order by AvgCPU asc
```

Common right-sizing actions:

| Observation                 | Action                                | Savings     |
| --------------------------- | ------------------------------------- | ----------- |
| Avg CPU < 25% on D8s_v5     | Try D4s_v5 with lower density         | ~50% per VM |
| High memory, low CPU        | Switch to memory-optimized (E-series) | 10--20%     |
| GPU VMs under-utilizing GPU | Use smaller GPU partition             | 30--50%     |

### 3.3 Ephemeral OS disks

Use ephemeral OS disks for pooled session hosts:

- **No managed disk cost** (OS disk uses VM cache/temp storage)
- **Faster VM reimage** (no disk detach/attach)
- **Better security** (OS disk resets on reimage)

```bicep
storageProfile: {
  osDisk: {
    createOption: 'FromImage'
    diffDiskSettings: { option: 'Local' }
    caching: 'ReadOnly'
    managedDisk: { storageAccountType: 'Standard_LRS' }
  }
}
```

### 3.4 Dev/test pricing

Use Azure Dev/Test subscriptions for non-production AVD environments:

- No Windows license charge on VMs
- Reduced rates on Azure services
- Suitable for: UAT, staging, training, development

### 3.5 Profile storage optimization

| Action                                                               | Impact                      |
| -------------------------------------------------------------------- | --------------------------- |
| Configure FSLogix exclusions (redirections.xml)                      | 20--30% smaller profiles    |
| Use Office Container (separate VHDx for Outlook/Teams)               | Better IOPS distribution    |
| Set dynamic VHDx (grow on demand)                                    | Pay only for actual usage   |
| Clean up stale profiles (90+ days inactive)                          | Reduce storage volume       |
| Right-size Azure Files quota (IOPS scales with provisioned capacity) | Match IOPS to actual demand |

---

## 4. User acceptance testing (UAT)

### 4.1 UAT plan

| Phase                    | Duration | Activities                          |
| ------------------------ | -------- | ----------------------------------- |
| **Technical validation** | 1 week   | IT team validates all features      |
| **Pilot group**          | 2 weeks  | 50--100 users with diverse profiles |
| **Expanded pilot**       | 2 weeks  | 200--500 users across departments   |
| **Go/no-go decision**    | 1 day    | Review metrics, feedback, issues    |

### 4.2 UAT checklist

**Desktop experience:**

- [ ] Desktop loads within 15 seconds
- [ ] Multi-monitor configuration works correctly
- [ ] Display scaling is correct on high-DPI monitors
- [ ] Copy/paste between local desktop and AVD session works
- [ ] File drag-and-drop works (if enabled)

**Applications:**

- [ ] Microsoft Office applications launch and function correctly
- [ ] Line-of-business applications launch and function correctly
- [ ] Power BI Desktop connects to Fabric Direct Lake (CSA-in-a-Box)
- [ ] Azure Data Studio connects to Databricks SQL endpoints
- [ ] Web applications render correctly in Edge
- [ ] Teams video calls work with media optimization

**Peripherals:**

- [ ] Printers (network and USB) accessible
- [ ] Webcam and microphone work for video calls
- [ ] USB devices redirect (if configured)
- [ ] Audio playback quality acceptable

**Profile:**

- [ ] User settings persist across sessions
- [ ] Application configurations roam correctly
- [ ] Browser bookmarks and history preserved
- [ ] Outlook email and calendar load correctly

**Performance:**

- [ ] Application response time acceptable (< 100ms input delay)
- [ ] Scrolling is smooth in Office and web browsers
- [ ] Video playback (YouTube, internal training) at acceptable quality
- [ ] No visible screen artifacts or tearing

### 4.3 UAT feedback collection

```markdown
## AVD Pilot Feedback Form

**User name:** ******\_\_\_******
**Department:** ******\_\_\_******
**Pilot dates:** ******\_\_\_******

**Rate your experience (1-5, 5 being best):**

1. Overall desktop responsiveness: [ ]
2. Application performance: [ ]
3. Login speed: [ ]
4. Printing: [ ]
5. Video call quality (Teams/Zoom): [ ]
6. Multi-monitor experience: [ ]
7. Profile persistence (settings, bookmarks): [ ]

**What works well?**

---

**What needs improvement?**

---

**Any applications that don't work correctly?**

---

**Would you recommend AVD to your colleagues?** [ ] Yes [ ] No [ ] Need improvement first
```

---

## 5. CSA-in-a-Box data analyst desktop pattern

### 5.1 Pattern overview

The CSA-in-a-Box data analyst desktop is a pre-configured AVD host pool optimized for users accessing Azure data and analytics services. It combines:

- Windows 11 multi-session golden image with analytics tools
- FSLogix profile containers preserving analyst configurations
- Private Link connectivity to Fabric, Databricks, and ADLS Gen2
- Conditional Access policies restricting data access to AVD sessions
- Intune compliance policies for endpoint security

### 5.2 Golden image specification

| Component                  | Version/Configuration                                                       |
| -------------------------- | --------------------------------------------------------------------------- |
| **OS**                     | Windows 11 Enterprise 24H2 multi-session                                    |
| **Power BI Desktop**       | Latest (per-machine install)                                                |
| **Azure Data Studio**      | Latest                                                                      |
| **VS Code**                | Latest + Python, Jupyter, Azure extensions                                  |
| **Python**                 | 3.12 (per-machine) + pip + common data packages (pandas, numpy, matplotlib) |
| **R**                      | 4.4+ (optional, per-machine)                                                |
| **Azure CLI**              | Latest                                                                      |
| **Azure Storage Explorer** | Latest                                                                      |
| **SSMS**                   | Latest (optional)                                                           |
| **Git**                    | Latest                                                                      |
| **Microsoft Edge**         | Latest (with enterprise policies)                                           |
| **FSLogix**                | Latest                                                                      |
| **VDOT optimizations**     | Applied                                                                     |
| **Defender for Endpoint**  | Configured via Intune                                                       |

### 5.3 Network architecture

```
AVD Session Host (10.100.1.0/24)
  ├── Private Endpoint → Microsoft Fabric (10.100.2.x)
  ├── Private Endpoint → Databricks (10.100.2.x)
  ├── Private Endpoint → ADLS Gen2 (10.100.2.x)
  ├── Private Endpoint → Azure AI Foundry (10.100.2.x)
  ├── Private Endpoint → Azure Files/FSLogix (10.100.2.x)
  └── Outbound → AVD service, Entra ID, Windows Update (via NSG)
```

All data service connectivity traverses Azure backbone via Private Link. No data flows over the public internet.

### 5.4 Conditional Access policies

```
Policy: Restrict Fabric access to AVD sessions
- Cloud apps: Microsoft Fabric, Power BI Service
- Conditions:
  - Device platforms: Windows
  - Filter for devices: device.extensionAttribute1 == "AVD-DataAnalyst"
- Grant: Require device compliance + MFA
- Session: App-enforced restrictions

Policy: Block Fabric access from unmanaged devices
- Cloud apps: Microsoft Fabric, Power BI Service
- Conditions:
  - Device filter: NOT (device.extensionAttribute1 == "AVD-DataAnalyst")
- Grant: Block access
```

This ensures Fabric and Databricks data can only be accessed from governed AVD desktops, not personal devices or unmanaged endpoints.

### 5.5 User experience

Data analysts connect to the "Analytics Desktop" workspace in the Remote Desktop client. They see a Windows 11 desktop pre-configured with:

- **Power BI Desktop** pinned to taskbar -- connected to Fabric Direct Lake semantic models
- **Azure Data Studio** pinned to taskbar -- pre-configured with Databricks SQL connection profiles
- **VS Code** with Jupyter extension -- for Python/R notebook work
- **Azure Storage Explorer** -- for browsing ADLS Gen2 data lakes
- **Edge** with bookmarks to Fabric portal, Databricks workspace, and Purview catalog

FSLogix preserves:

- Jupyter notebooks and Python virtual environments
- VS Code settings and extensions
- Power BI .pbix files and recent connections
- Azure Data Studio connection profiles
- Browser bookmarks and session history
- Edge profiles and saved passwords

### 5.6 Scaling for data workloads

Data analyst workloads are more memory-intensive than standard knowledge workers. Recommended VM sizing:

| Analyst profile                                             | VM size   | Max users | Notes                      |
| ----------------------------------------------------------- | --------- | --------- | -------------------------- |
| **Light analyst** (Power BI consumer, SQL queries)          | D8s_v5    | 12--14    | Standard density           |
| **Heavy analyst** (Power BI author, Python, large datasets) | D8s_v5    | 8--10     | Reduced density for memory |
| **Data engineer** (Spark, Docker, large notebooks)          | D16s_v5   | 12--16    | More memory per user       |
| **Data scientist** (ML training, GPU)                       | NCasT4_v3 | 4--6      | GPU for model training     |

---

## 6. Operational runbooks

### 6.1 Image update procedure

1. Build new image from pipeline (automated weekly)
2. Deploy 2--3 session hosts with new image to validation host pool
3. Run automated smoke tests (application launch, FSLogix, Teams)
4. If tests pass, begin rolling update:
   a. Set existing hosts to drain mode (no new sessions)
   b. Deploy new hosts with updated image
   c. Wait for existing sessions to end (max 24 hours)
   d. Delete old hosts
5. Verify AVD Insights shows no degradation

### 6.2 Session host troubleshooting

| Symptom                  | Check                   | Action                                      |
| ------------------------ | ----------------------- | ------------------------------------------- |
| Host shows "Unavailable" | AVD agent heartbeat     | Restart agent service or reimage VM         |
| High login times         | FSLogix event log       | Check storage IOPS, profile size            |
| Poor performance         | CPU/memory metrics      | Right-size VM or reduce session limit       |
| Application crash        | Event Viewer app log    | Check app compatibility with multi-session  |
| Profile errors           | FSLogix operational log | Verify storage permissions and connectivity |

### 6.3 Scaling plan troubleshooting

```kusto
// Check scaling plan evaluation events
WVDAutoscaleEvaluationPooled
| where TimeGenerated > ago(1h)
| project TimeGenerated,
    HostPoolName = split(HostPoolArmPath, "/")[-1],
    Phase = ScalingPlanPhase,
    ActiveHosts = ActiveSessionHostCount,
    TotalSessions = TotalSessionCount,
    Action = ScalingAction
| order by TimeGenerated desc
```

---

## 7. Security hardening

### 7.1 Session host hardening checklist

- [ ] Apply Windows 11 security baseline (Intune or GPO)
- [ ] Enable BitLocker encryption on OS disk
- [ ] Configure Microsoft Defender for Endpoint
- [ ] Enable attack surface reduction rules
- [ ] Disable unnecessary Windows features and services (VDOT)
- [ ] Configure Windows Firewall with strict rules
- [ ] Enable Credential Guard (if supported by VM size)
- [ ] Configure AppLocker or WDAC for application whitelisting
- [ ] Disable local administrator account (use LAPS if needed)
- [ ] Enable screen capture protection for sensitive environments
- [ ] Configure session timeouts (idle: 15 min, disconnect: 30 min)
- [ ] Enable clipboard and drive redirection restrictions via Conditional Access

### 7.2 Network hardening

- [ ] NSG rules: outbound-only, restricted to AVD and Azure services
- [ ] Private Link for all PaaS services (storage, Fabric, Databricks)
- [ ] Azure Firewall or NVA for egress inspection (optional)
- [ ] No public IP on session hosts
- [ ] Private DNS zones for Private Link resolution
- [ ] Azure DDoS Protection on VNet (inherited from Azure)

---

## 8. Monitoring and alerting

### 8.1 Key metrics to monitor

| Metric                       | Threshold             | Alert severity |
| ---------------------------- | --------------------- | -------------- |
| Session host unavailable     | > 0 hosts             | Sev 2          |
| Connection failures (15 min) | > 10                  | Sev 1          |
| FSLogix errors               | > 0                   | Sev 2          |
| Average login time           | > 30 seconds          | Sev 3          |
| User input delay             | > 200ms               | Sev 2          |
| CPU utilization (per host)   | > 80% sustained       | Sev 3          |
| Memory available (per host)  | < 2 GB                | Sev 2          |
| Storage IOPS throttling      | Any throttling events | Sev 3          |
| Scaling plan failures        | Any failures          | Sev 2          |

### 8.2 Dashboard recommendations

Deploy these AVD Insights workbooks:

1. **Overview** -- session counts, host health, connection status
2. **Connection diagnostics** -- per-user connection quality, errors
3. **Host performance** -- CPU, memory, disk, network per host
4. **User experience** -- login times, input delay, session duration
5. **Utilization** -- session density, scaling plan effectiveness, cost metrics

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
