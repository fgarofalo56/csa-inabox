# Profile Migration: Citrix UPM to FSLogix

**Audience:** VDI Engineers, Desktop Administrators
**Scope:** Migrating user profiles from Citrix User Profile Management (UPM) to FSLogix Profile Containers and Office Containers on Azure Files or Azure NetApp Files.
**Last updated:** 2026-04-30

---

## Overview

Profile management is the foundation of a good VDI user experience. Users expect their settings, application configurations, browser bookmarks, and cached data to persist across sessions. Citrix UPM and FSLogix solve this problem with fundamentally different architectures.

| Characteristic        | Citrix UPM                                    | FSLogix                                             |
| --------------------- | --------------------------------------------- | --------------------------------------------------- |
| **Architecture**      | File-level synchronization                    | Block-level VHDx container mount                    |
| **Login time**        | 15--60+ seconds (profile sync)                | 2--5 seconds (disk mount)                           |
| **Data capture**      | Redirected folders + registry                 | Entire profile (all AppData, registry, local state) |
| **Office data**       | Separate Outlook cache, Search index handling | Office Container (dedicated VHDx)                   |
| **Conflict handling** | Last-write-wins merge (data loss risk)        | Per-user container (no merge needed)                |
| **Storage**           | SMB file share (folder structure)             | SMB file share (VHDx files)                         |
| **Licensing**         | Included in CVAD                              | Included in M365 E3/E5                              |

---

## 1. FSLogix Profile Container fundamentals

### 1.1 How it works

FSLogix creates a VHDx (virtual hard disk) for each user. At login, the VHDx is mounted as a virtual disk, and the local profile directory (C:\Users\username) is redirected to the mounted disk via a filter driver. The OS and applications see a standard local profile -- they have no awareness that the profile is backed by a network-attached VHDx.

At logoff, the VHDx is cleanly detached and the file is closed on the SMB share. No file-level synchronization occurs. The entire profile state is captured in the VHDx.

### 1.2 Profile Container vs Office Container

FSLogix provides two container types:

| Container             | Contents                                                                     | Purpose               |
| --------------------- | ---------------------------------------------------------------------------- | --------------------- |
| **Profile Container** | Entire user profile (AppData, Desktop, Documents, registry, etc.)            | Full profile roaming  |
| **Office Container**  | Outlook OST/OSC, Teams cache, OneDrive cache, SharePoint cache, Search index | Office data isolation |

**Recommended configuration:** use both. The Profile Container holds the general profile. The Office Container holds large, frequently changing Office data. This separation allows:

- Independent sizing (Office data is typically 5--15 GB per user)
- Independent backup/retention policies
- Office Container can be placed on higher-performance storage if needed

### 1.3 Storage options

| Storage backend                  | IOPS/user               | Cost         | Best for                             |
| -------------------------------- | ----------------------- | ------------ | ------------------------------------ |
| **Azure Files Premium (SMB)**    | High (provisioned IOPS) | $$           | Most AVD deployments                 |
| **Azure Files Standard (SMB)**   | Moderate (burst)        | $            | Small deployments, cost-sensitive    |
| **Azure NetApp Files (ANF)**     | Very high (dedicated)   | $$$          | Large deployments, extreme IOPS      |
| **On-prem file server (hybrid)** | Depends on hardware     | $ (existing) | Hybrid AVD with on-prem connectivity |

**Azure Files Premium is the recommended default** for most AVD deployments. It provides predictable IOPS, Entra ID authentication (Kerberos), and private endpoint support.

---

## 2. Storage preparation

### 2.1 Create Azure Files share for profiles

```bash
# Create storage account
az storage account create \
  --name stavdprofiles \
  --resource-group rg-avd-prod \
  --location eastus2 \
  --sku Premium_LRS \
  --kind FileStorage \
  --enable-large-file-share \
  --default-action Deny

# Create profile container share
az storage share-rm create \
  --name profiles \
  --storage-account stavdprofiles \
  --enabled-protocol SMB \
  --quota 1024  # 1 TB provisioned (IOPS scales with size)

# Create Office container share
az storage share-rm create \
  --name odfc \
  --storage-account stavdprofiles \
  --enabled-protocol SMB \
  --quota 512  # 512 GB
```

### 2.2 Configure Entra ID authentication (Kerberos)

For Entra ID-joined session hosts:

```bash
# Enable Entra ID Kerberos authentication on the storage account
az storage account update \
  --name stavdprofiles \
  --resource-group rg-avd-prod \
  --enable-files-aadkerb true

# Assign RBAC roles for user access
# Storage File Data SMB Share Contributor for profile users
az role assignment create \
  --role "Storage File Data SMB Share Contributor" \
  --assignee-object-id <user-group-object-id> \
  --scope /subscriptions/.../resourceGroups/rg-avd-prod/providers/Microsoft.Storage/storageAccounts/stavdprofiles

# Storage File Data SMB Share Elevated Contributor for admins
az role assignment create \
  --role "Storage File Data SMB Share Elevated Contributor" \
  --assignee-object-id <admin-group-object-id> \
  --scope /subscriptions/.../resourceGroups/rg-avd-prod/providers/Microsoft.Storage/storageAccounts/stavdprofiles
```

### 2.3 Configure private endpoint

```bash
# Create private endpoint for Azure Files
az network private-endpoint create \
  --name pe-avd-profiles \
  --resource-group rg-avd-prod \
  --vnet-name vnet-avd-prod \
  --subnet snet-privateendpoints \
  --private-connection-resource-id /subscriptions/.../storageAccounts/stavdprofiles \
  --group-id file \
  --connection-name pec-avd-profiles
```

### 2.4 Set NTFS permissions

After mounting the share on an AD-joined or Entra ID-joined machine:

```powershell
# Mount the share
net use Z: \\stavdprofiles.file.core.windows.net\profiles

# Set NTFS permissions for FSLogix
# Creator/Owner: Full Control (subfolders and files only)
# Users group: Modify (this folder only)
# Admins: Full Control (this folder, subfolders, files)

icacls Z:\ /grant "CREATOR OWNER:(OI)(CI)(F)" /T
icacls Z:\ /grant "Users:(M)" /T
icacls Z:\ /grant "Administrators:(OI)(CI)(F)" /T
# Remove inheritance from parent
icacls Z:\ /inheritance:r
```

---

## 3. FSLogix configuration

### 3.1 Profile Container GPO or registry settings

```powershell
# Core Profile Container settings
$profilesKey = "HKLM:\SOFTWARE\FSLogix\Profiles"

# Enable Profile Container
Set-ItemProperty -Path $profilesKey -Name "Enabled" -Value 1 -Type DWord

# VHD location (Azure Files share)
Set-ItemProperty -Path $profilesKey -Name "VHDLocations" -Value "\\stavdprofiles.file.core.windows.net\profiles" -Type String

# Delete local profile when VHD should apply
Set-ItemProperty -Path $profilesKey -Name "DeleteLocalProfileWhenVHDShouldApply" -Value 1 -Type DWord

# Use the username_SID folder naming convention
Set-ItemProperty -Path $profilesKey -Name "FlipFlopProfileDirectoryName" -Value 1 -Type DWord

# Maximum VHD size (30 GB dynamic)
Set-ItemProperty -Path $profilesKey -Name "SizeInMBs" -Value 30000 -Type DWord

# Use VHDx format (more resilient than VHD)
Set-ItemProperty -Path $profilesKey -Name "VolumeType" -Value "VHDX" -Type String

# Dynamic disk (grows as needed up to SizeInMBs)
Set-ItemProperty -Path $profilesKey -Name "IsDynamic" -Value 1 -Type DWord

# Lock retry settings (for concurrent access handling)
Set-ItemProperty -Path $profilesKey -Name "LockedRetryCount" -Value 3 -Type DWord
Set-ItemProperty -Path $profilesKey -Name "LockedRetryInterval" -Value 15 -Type DWord

# Redirect temp data to local disk (reduces VHD I/O)
Set-ItemProperty -Path $profilesKey -Name "RedirXMLSourceFolder" -Value "C:\FSLogix\Redirections" -Type String
```

### 3.2 Office Container settings

```powershell
$odfcKey = "HKLM:\SOFTWARE\Policies\FSLogix\ODFC"
New-Item -Path $odfcKey -Force

Set-ItemProperty -Path $odfcKey -Name "Enabled" -Value 1 -Type DWord
Set-ItemProperty -Path $odfcKey -Name "VHDLocations" -Value "\\stavdprofiles.file.core.windows.net\odfc" -Type String
Set-ItemProperty -Path $odfcKey -Name "VolumeType" -Value "VHDX" -Type String
Set-ItemProperty -Path $odfcKey -Name "IsDynamic" -Value 1 -Type DWord
Set-ItemProperty -Path $odfcKey -Name "SizeInMBs" -Value 15000 -Type DWord

# Include Outlook data in Office Container
Set-ItemProperty -Path $odfcKey -Name "IncludeOutlookPersonalization" -Value 1 -Type DWord

# Include Teams data
Set-ItemProperty -Path $odfcKey -Name "IncludeTeams" -Value 1 -Type DWord

# Include OneDrive data
Set-ItemProperty -Path $odfcKey -Name "IncludeOneDrive" -Value 1 -Type DWord
```

### 3.3 Profile exclusions (redirections.xml)

Create `C:\FSLogix\Redirections\redirections.xml` to exclude temporary data from the profile VHDx:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<FrxProfileFolderRedirection ExcludeCommonFolders="0">
  <Excludes>
    <!-- Temporary files -->
    <Exclude Copy="0">AppData\Local\Temp</Exclude>
    <Exclude Copy="0">AppData\Local\Microsoft\Windows\INetCache</Exclude>
    <Exclude Copy="0">AppData\Local\Microsoft\Windows\Explorer</Exclude>

    <!-- Browser caches (reconstructed on next launch) -->
    <Exclude Copy="0">AppData\Local\Google\Chrome\User Data\Default\Cache</Exclude>
    <Exclude Copy="0">AppData\Local\Microsoft\Edge\User Data\Default\Cache</Exclude>

    <!-- Windows Error Reporting -->
    <Exclude Copy="0">AppData\Local\CrashDumps</Exclude>
    <Exclude Copy="0">AppData\Local\Microsoft\Windows\WER</Exclude>

    <!-- Citrix UPM leftovers (safe to exclude post-migration) -->
    <Exclude Copy="0">AppData\Local\Citrix</Exclude>
  </Excludes>
  <Includes>
    <!-- Ensure critical data is always included -->
    <Include>AppData\Local\Microsoft\Outlook</Include>
    <Include>AppData\Local\Microsoft\Office</Include>
  </Includes>
</FrxProfileFolderRedirection>
```

---

## 4. Cloud Cache configuration

FSLogix Cloud Cache provides active-active profile replication across multiple storage locations. This is useful for:

- **Multi-region AVD deployments:** profiles available in both regions without cross-region SMB latency
- **DR scenarios:** profile data survives a regional storage outage
- **Migration:** gradual cutover from on-prem file shares to Azure Files

### 4.1 Cloud Cache setup

```powershell
# Replace VHDLocations with CCDLocations for Cloud Cache
$profilesKey = "HKLM:\SOFTWARE\FSLogix\Profiles"

# Remove VHDLocations (Cloud Cache uses CCDLocations instead)
Remove-ItemProperty -Path $profilesKey -Name "VHDLocations" -ErrorAction SilentlyContinue

# Configure Cloud Cache with two locations
# Azure Files (primary) + Azure NetApp Files (secondary)
Set-ItemProperty -Path $profilesKey -Name "CCDLocations" -Value `
  "type=smb,connectionString=\\stavdprofiles.file.core.windows.net\profiles;type=smb,connectionString=\\anfvol.anfaccount.file.core.windows.net\profiles-dr" `
  -Type String

# Enable Cloud Cache
Set-ItemProperty -Path $profilesKey -Name "CloudCacheEnabled" -Value 1 -Type DWord
```

---

## 5. Migrating Citrix UPM profiles to FSLogix

### 5.1 Migration strategies

| Strategy                | Description                                                                   | Downtime           | Effort |
| ----------------------- | ----------------------------------------------------------------------------- | ------------------ | ------ |
| **Start fresh**         | Users start with empty FSLogix profiles                                       | None               | XS     |
| **Selective migration** | Migrate specific folders (Desktop, Documents, Favorites, AppData\Roaming)     | Minimal            | S      |
| **Full migration**      | Convert entire UPM profile into FSLogix VHDx                                  | Per-user (minutes) | M      |
| **Hybrid**              | FSLogix for new sessions; UPM folders accessible read-only for data retrieval | None               | M      |

**Recommendation for most migrations:** use **selective migration** for critical settings and **OneDrive Known Folder Move** for Documents, Desktop, and Pictures. This gives users their important data without migrating transient caches.

### 5.2 Using frx copy-profile

FSLogix includes a built-in profile migration tool:

```powershell
# Migrate a single user profile from UPM share to FSLogix VHDx
frx copy-profile `
  -filename "\\stavdprofiles.file.core.windows.net\profiles\%username%_%usersid%\Profile_%username%.vhdx" `
  -sid S-1-5-21-xxxx-xxxx-xxxx-1234 `
  -username jsmith `
  -dynamic 1 `
  -size-mbs 30000 `
  -src "\\citrixprofileserver\profiles$\jsmith"
```

### 5.3 Batch migration script

```powershell
# Batch migrate UPM profiles to FSLogix
param(
    [string]$UPMShare = "\\citrixprofileserver\profiles$",
    [string]$FSLogixShare = "\\stavdprofiles.file.core.windows.net\profiles",
    [int]$SizeMB = 30000
)

$users = Get-ChildItem -Path $UPMShare -Directory

foreach ($user in $users) {
    $username = $user.Name
    Write-Host "Migrating profile for: $username"

    # Get user SID
    try {
        $userObj = New-Object System.Security.Principal.NTAccount($username)
        $sid = $userObj.Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
        Write-Warning "Cannot resolve SID for $username - skipping"
        continue
    }

    # Create VHDx path
    $vhdxPath = Join-Path $FSLogixShare "${username}_${sid}" "Profile_${username}.vhdx"
    $vhdxDir = Split-Path $vhdxPath -Parent

    # Create directory
    if (-not (Test-Path $vhdxDir)) {
        New-Item -Path $vhdxDir -ItemType Directory -Force
    }

    # Run migration
    & frx copy-profile `
        -filename $vhdxPath `
        -sid $sid `
        -username $username `
        -dynamic 1 `
        -size-mbs $SizeMB `
        -src $user.FullName

    if ($LASTEXITCODE -eq 0) {
        Write-Host "  SUCCESS: $username" -ForegroundColor Green
    } else {
        Write-Warning "  FAILED: $username (exit code: $LASTEXITCODE)"
    }
}
```

### 5.4 OneDrive Known Folder Move

For Documents, Desktop, and Pictures, OneDrive Known Folder Move (KFM) is often a better migration path than embedding large user data in FSLogix VHDx files:

```powershell
# Configure KFM via Intune or GPO
# HKLM\SOFTWARE\Policies\Microsoft\OneDrive
Set-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\OneDrive" `
  -Name "KFMSilentOptIn" -Value "<TenantID>" -Type String
Set-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\OneDrive" `
  -Name "KFMSilentOptInWithNotification" -Value 1 -Type DWord
```

---

## 6. Validation

### 6.1 Verify FSLogix profile mount

After a user logs in to an AVD session:

```powershell
# Check FSLogix status
& "C:\Program Files\FSLogix\Apps\frx.exe" list

# Expected output:
# User: jsmith
# Profile VHD: \\stavdprofiles.file.core.windows.net\profiles\jsmith_S-1-5-21...\Profile_jsmith.vhdx
# Status: Attached
# Type: VHDX (Dynamic)
```

### 6.2 Check Event Viewer

Check **Applications and Services Logs > FSLogix > Operational** for:

- Event 25 (profile loaded successfully)
- Event 26 (profile unloaded successfully)
- Any error events (red) indicating mount failures

### 6.3 Performance baseline

| Metric                   | Target                                              | How to measure                                           |
| ------------------------ | --------------------------------------------------- | -------------------------------------------------------- |
| Profile load time        | < 5 seconds                                         | FSLogix event log (Event 25 timestamp minus logon start) |
| VHDx size (initial)      | < 1 GB (fresh profile)                              | Check VHDx file size on share                            |
| VHDx size (steady state) | 2--8 GB (knowledge worker), 5--15 GB (data analyst) | Monitor over 2 weeks                                     |
| Office Container size    | 3--10 GB                                            | Check ODFC VHDx file size                                |

---

## 7. Citrix UPM cleanup

After successful migration and validation:

1. **Retain UPM profiles** for 90 days as rollback insurance
2. **Archive** UPM profile shares to Azure Blob Cool tier for long-term retention
3. **Remove** Citrix UPM GPO settings from migrated OUs
4. **Decommission** Citrix Profile Management servers

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
