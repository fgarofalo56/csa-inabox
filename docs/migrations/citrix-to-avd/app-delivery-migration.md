# App Delivery Migration: Citrix Published Apps to AVD RemoteApp

**Audience:** VDI Engineers, Application Packaging, Desktop Administrators
**Scope:** Migrating Citrix published applications, App Layering, and App-V to AVD RemoteApp, MSIX app attach, and application groups.
**Last updated:** 2026-04-30

---

## Overview

Citrix excels at application publishing -- delivering individual applications to users without a full desktop session. AVD provides equivalent functionality through RemoteApp application groups and MSIX app attach. This guide maps every Citrix application delivery mechanism to its AVD equivalent.

---

## 1. Citrix to AVD application delivery mapping

| Citrix mechanism                  | AVD equivalent                          | Description                                              |
| --------------------------------- | --------------------------------------- | -------------------------------------------------------- |
| **Published application**         | RemoteApp (application group)           | Individual app published to users via AVD feed           |
| **Published desktop**             | Desktop application group               | Full desktop session                                     |
| **Delivery Group (apps)**         | RemoteApp application group             | Collection of published apps assigned to users           |
| **Delivery Group (desktops)**     | Desktop application group               | Desktop assigned to users                                |
| **Application folder**            | Workspace organization                  | Logical grouping of apps in the user feed                |
| **App Layering (Elastic Layers)** | MSIX app attach                         | Application layering without image modification          |
| **App-V**                         | MSIX app attach or native App-V         | Virtualized application packages                         |
| **File type association (FTA)**   | RemoteApp FTA                           | File-type-to-app mapping for seamless launch             |
| **Application limits**            | Entra ID group assignment               | Control which users see which apps                       |
| **Application visibility**        | Entra ID group assignment per app group | Hide/show apps based on group membership                 |
| **Keyword filtering**             | Not available (use multiple workspaces) | Citrix keyword-based app filtering has no AVD equivalent |
| **Pre-launch**                    | Not available                           | AVD does not support session pre-launch                  |

---

## 2. Publishing applications as RemoteApp

### 2.1 Create a RemoteApp application group

```bash
# Create RemoteApp application group
az desktopvirtualization applicationgroup create \
  --name ag-finance-apps \
  --resource-group rg-avd-prod \
  --location eastus2 \
  --host-pool-id /subscriptions/.../hp-analytics-prod \
  --application-group-type RemoteApp \
  --friendly-name "Finance Applications"

# Register application group with workspace
az desktopvirtualization workspace update \
  --name ws-analytics-prod \
  --resource-group rg-avd-prod \
  --application-group-references \
    /subscriptions/.../ag-finance-apps \
    /subscriptions/.../dag-analytics-desktop
```

### 2.2 Add applications to the group

```bash
# Publish Excel as RemoteApp
az desktopvirtualization application create \
  --name excel \
  --application-group-name ag-finance-apps \
  --resource-group rg-avd-prod \
  --file-path "C:\Program Files\Microsoft Office\root\Office16\EXCEL.EXE" \
  --friendly-name "Microsoft Excel" \
  --icon-path "C:\Program Files\Microsoft Office\root\Office16\EXCEL.EXE" \
  --icon-index 0 \
  --show-in-portal true \
  --command-line-setting DoNotAllow

# Publish Power BI Desktop as RemoteApp
az desktopvirtualization application create \
  --name powerbi-desktop \
  --application-group-name ag-finance-apps \
  --resource-group rg-avd-prod \
  --file-path "C:\Program Files\Microsoft Power BI Desktop\bin\PBIDesktop.exe" \
  --friendly-name "Power BI Desktop" \
  --icon-path "C:\Program Files\Microsoft Power BI Desktop\bin\PBIDesktop.exe" \
  --icon-index 0 \
  --show-in-portal true \
  --command-line-setting DoNotAllow

# Publish Azure Data Studio as RemoteApp
az desktopvirtualization application create \
  --name azure-data-studio \
  --application-group-name ag-finance-apps \
  --resource-group rg-avd-prod \
  --file-path "C:\Program Files\Azure Data Studio\azuredatastudio.exe" \
  --friendly-name "Azure Data Studio" \
  --icon-path "C:\Program Files\Azure Data Studio\azuredatastudio.exe" \
  --icon-index 0 \
  --show-in-portal true \
  --command-line-setting DoNotAllow

# Publish a custom LOB application
az desktopvirtualization application create \
  --name finance-analyzer \
  --application-group-name ag-finance-apps \
  --resource-group rg-avd-prod \
  --file-path "C:\Program Files\FinanceApp\analyzer.exe" \
  --friendly-name "Finance Analyzer" \
  --icon-path "C:\Program Files\FinanceApp\analyzer.exe" \
  --icon-index 0 \
  --show-in-portal true \
  --command-line-setting Allow \
  --command-line-arguments "--config production"
```

### 2.3 Assign users to application groups

```bash
# Assign Entra ID group to RemoteApp application group
az role assignment create \
  --role "Desktop Virtualization User" \
  --assignee-object-id <entra-group-object-id> \
  --scope /subscriptions/.../ag-finance-apps
```

---

## 3. MSIX app attach (replacing Citrix App Layering)

### 3.1 What MSIX app attach replaces

| Citrix App Layering              | MSIX app attach                |
| -------------------------------- | ------------------------------ |
| Elastic Layers (user/app layers) | MSIX packages mounted at login |
| OS Layer (base image)            | Azure Compute Gallery image    |
| Platform Layer (driver/config)   | Image configuration or Intune  |
| Layer management (ELM console)   | Azure Portal or PowerShell     |

MSIX app attach delivers applications as MSIX packages stored on Azure file shares. At session login, the package is mounted as a virtual filesystem overlay -- the application appears installed without modifying the session host OS disk. This provides:

- **Independent app lifecycle:** update an application without updating the golden image
- **Per-user/per-group assignment:** different users get different apps on the same session host
- **Reduced image management:** fewer golden images needed (one base + MSIX layers vs multiple images per app set)

### 3.2 Convert applications to MSIX

**Option A: Use MSIX Packaging Tool (GUI)**

1. Install the MSIX Packaging Tool from the Microsoft Store
2. Launch the tool and select "Application package"
3. Install the application through the capture wizard
4. Save the resulting .msix package

**Option B: Convert existing installers with PSF**

For applications with known compatibility issues, use the Package Support Framework (PSF):

```powershell
# Example: package a traditional installer into MSIX
# 1. Create a clean VM
# 2. Install MSIX Packaging Tool
# 3. Start capture
# 4. Run the traditional installer
# 5. Complete capture and save .msix

# Convert MSI to MSIX (if straightforward installer)
MsixPackagingTool.exe create-package `
  --template "C:\Packaging\finance-app-template.xml"
```

**Option C: Repackage App-V to MSIX**

```powershell
# Convert existing App-V package to MSIX
# Requires MSIX Packaging Tool
MsixPackagingTool.exe create-package `
  --conversion-type appv `
  --appv-file "C:\AppVPackages\FinanceApp.appv" `
  --output "C:\MSIX\FinanceApp.msix"
```

### 3.3 Create MSIX image (VHDx or CimFS)

MSIX app attach requires applications stored in VHDx or CimFS format:

```powershell
# Create VHDx for MSIX app attach
$vhdxPath = "C:\MSIX\Images\FinanceApp.vhdx"
$msixPath = "C:\MSIX\Packages\FinanceApp.msix"

# Create and mount VHDx
$disk = New-VHD -Path $vhdxPath -SizeBytes 1GB -Dynamic
$mount = Mount-VHD -Path $vhdxPath -Passthru
$partition = Initialize-Disk -Number $mount.DiskNumber -PassThru | New-Partition -UseMaximumSize -AssignDriveLetter
Format-Volume -Partition $partition -FileSystem NTFS -Confirm:$false

# Extract MSIX to the VHDx
$driveLetter = $partition.DriveLetter
& msixmgr.exe -Unpack -packagePath $msixPath -destination "${driveLetter}:\Apps" -applyACLs

# Dismount
Dismount-VHD -Path $vhdxPath
```

### 3.4 Upload and configure MSIX app attach

```bash
# Upload VHDx to Azure Files share
az storage file upload \
  --account-name stavdprofiles \
  --share-name msixappattach \
  --source "C:\MSIX\Images\FinanceApp.vhdx" \
  --path "FinanceApp.vhdx"

# Register MSIX package with AVD
az desktopvirtualization msix-package create \
  --host-pool-name hp-analytics-prod \
  --resource-group rg-avd-prod \
  --msix-package-full-name "FinanceApp_1.0.0.0_x64__publisher" \
  --display-name "Finance Analyzer" \
  --image-path "\\stavdprofiles.file.core.windows.net\msixappattach\FinanceApp.vhdx" \
  --is-active true \
  --is-regular-registration true
```

---

## 4. Application group architecture

### 4.1 Design pattern: one host pool, multiple application groups

A single AVD host pool can serve multiple application groups. This mirrors the Citrix pattern of one Delivery Group serving both desktops and published apps.

```
Host Pool: hp-analytics-prod
├── Desktop Application Group: dag-analytics-desktop
│   └── Full desktop (all apps on image)
│   └── Assigned to: SG-AVD-Desktop-Users
├── RemoteApp Group: ag-finance-apps
│   ├── Excel
│   ├── Power BI Desktop
│   └── Finance Analyzer
│   └── Assigned to: SG-Finance-Team
├── RemoteApp Group: ag-data-tools
│   ├── Azure Data Studio
│   ├── VS Code
│   └── Python (Jupyter)
│   └── Assigned to: SG-Data-Engineers
└── RemoteApp Group: ag-governance-tools
    ├── Purview Studio
    └── Azure Portal
    └── Assigned to: SG-Data-Stewards
```

### 4.2 User experience

Users see their assigned applications in the Remote Desktop client or web client, organized by application group. Clicking an application launches it in a seamless window on their local desktop -- identical to the Citrix Workspace app experience with published applications.

### 4.3 Limitations vs Citrix

| Capability                            | Citrix                       | AVD                     | Workaround                                       |
| ------------------------------------- | ---------------------------- | ----------------------- | ------------------------------------------------ |
| Application folders (nested grouping) | Yes (hierarchical folders)   | No (flat per app group) | Use multiple app groups for organization         |
| Keyword-based filtering               | Yes                          | No                      | Use Entra ID group assignment per app group      |
| Application pre-launch                | Yes                          | No                      | Consider Start VM on Connect for fast cold-start |
| Application probing                   | Yes (built-in health checks) | No                      | Use Azure Automation + custom health scripts     |
| Application instance limits           | Yes (per-app user limits)    | No                      | Use session limits on host pool                  |

---

## 5. Per-user application assignment

### 5.1 Entra ID group-based assignment

Create Entra ID security groups for each application set and assign them to the corresponding application group:

| Entra ID group    | Application group     | Applications                        |
| ----------------- | --------------------- | ----------------------------------- |
| SG-AVD-All-Users  | dag-analytics-desktop | Full desktop                        |
| SG-Finance-Team   | ag-finance-apps       | Excel, Power BI, Finance Analyzer   |
| SG-Data-Engineers | ag-data-tools         | Azure Data Studio, VS Code, Jupyter |
| SG-Data-Stewards  | ag-governance-tools   | Purview Studio, Azure Portal        |

Users who are members of multiple groups see all their assigned applications in the AVD feed. A data engineer who is also a data steward would see the full desktop, data tools, and governance tools.

### 5.2 Dynamic group assignment

Use Entra ID dynamic groups to automatically assign applications based on user attributes:

```
# Dynamic group rule for data engineers
(user.department -eq "Data Engineering") or (user.jobTitle -contains "Data Engineer")

# Dynamic group rule for finance team
(user.department -eq "Finance") and (user.accountEnabled -eq true)
```

---

## 6. Migrating from Citrix application catalog

### 6.1 Export Citrix published application inventory

```powershell
# Export all published applications from Citrix
Add-PSSnapin Citrix.*

Get-BrokerApplication | Select-Object `
  Name, PublishedName, CommandLineExecutable, CommandLineArguments, `
  WorkingDirectory, Description, Enabled, @{
    N='UserGroups'; E={($_ | Get-BrokerAccessPolicyRule).IncludedUsers.Name -join ';'}
  } | Export-Csv "C:\Migration\CitrixApps.csv" -NoTypeInformation
```

### 6.2 Map to AVD application groups

Review the exported CSV and group applications by:

1. **User audience:** applications used by the same user groups become one AVD application group
2. **Business function:** group by department or function (Finance, Data, Governance)
3. **Licensing:** separate applications with per-device or per-user licensing constraints

### 6.3 Create AVD applications from inventory

```powershell
# Read Citrix export and create AVD applications
$apps = Import-Csv "C:\Migration\CitrixApps.csv"

foreach ($app in $apps) {
    if ($app.Enabled -eq "True") {
        az desktopvirtualization application create `
          --name ($app.Name -replace '\s','').ToLower() `
          --application-group-name "ag-migrated-apps" `
          --resource-group "rg-avd-prod" `
          --file-path $app.CommandLineExecutable `
          --friendly-name $app.PublishedName `
          --command-line-setting $(if ($app.CommandLineArguments) { "Allow" } else { "DoNotAllow" }) `
          --command-line-arguments $app.CommandLineArguments `
          --show-in-portal true

        Write-Host "Published: $($app.PublishedName)"
    }
}
```

---

## 7. Application compatibility testing

### 7.1 Pre-migration testing checklist

For each application being migrated:

- [ ] Application installs on Windows 10/11 multi-session image
- [ ] Application launches correctly in a multi-user session
- [ ] Application writes user data to the correct profile location (captured by FSLogix)
- [ ] Application works with Entra ID-joined session hosts (no AD dependency in app)
- [ ] Application file type associations work correctly as RemoteApp
- [ ] Printing from the application works (Universal Print or redirected)
- [ ] Clipboard copy/paste between local desktop and RemoteApp works
- [ ] USB devices (if required) redirect correctly into the application session

### 7.2 Known compatibility considerations

| Scenario                                 | Issue                                | Solution                                                      |
| ---------------------------------------- | ------------------------------------ | ------------------------------------------------------------- |
| App checks for desktop OS                | Fails on Windows Server (Citrix SBC) | Works natively on Windows 10/11 multi-session (AVD advantage) |
| App writes to C:\ProgramData             | Shared across users in multi-session | Use FSLogix App Masking or per-user ProgramData redirection   |
| App uses COM/DCOM inter-process          | May conflict in multi-session        | Test; consider personal desktop for problematic apps          |
| App requires elevated privileges         | UAC prompts in multi-session         | Use Intune Endpoint Privilege Management or app repackaging   |
| App uses local database (SQLite, Access) | File locking in multi-session        | Ensure database files are in per-user profile (FSLogix)       |

---

## 8. CSA-in-a-Box application pattern

For data analyst desktops, the CSA-in-a-Box pattern publishes analytics tools both as full desktop applications and as individual RemoteApps:

**Full desktop (dag-analytics-desktop):** users who need all tools get a complete Windows 11 desktop with pre-installed analytics software.

**Individual RemoteApps (ag-analytics-tools):** users who only need specific tools get individual app windows:

- Power BI Desktop -- for report authoring against Fabric Direct Lake
- Azure Data Studio -- for SQL queries against Databricks SQL endpoints
- VS Code -- for notebook and Python development
- Azure Storage Explorer -- for browsing ADLS Gen2 data

This dual-delivery pattern mirrors common Citrix deployments where some users get a published desktop and others get published applications from the same infrastructure.

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
