# Tutorial: Migrate Citrix UPM Profiles to FSLogix

**Audience:** VDI Engineers, Desktop Administrators
**Duration:** 1--2 hours
**Prerequisites:** Existing Citrix UPM profile share accessible from Azure, AVD session hosts with FSLogix installed, Azure Files Premium share for FSLogix profiles
**Last updated:** 2026-04-30

---

## What you will accomplish

This tutorial walks through migrating user profiles from Citrix User Profile Management (UPM) to FSLogix Profile Containers on Azure Files. By the end:

1. Citrix UPM profile data is exported and cataloged
2. FSLogix Profile Containers are configured on Azure Files
3. User data is migrated from UPM folders to FSLogix VHDx containers
4. Profile loading is validated on AVD session hosts

---

## Step 1: Assess current Citrix UPM profiles

### 1.1 Locate Citrix UPM profile store

Citrix UPM stores profiles in a file share configured via Citrix Policy. Find the path:

```powershell
# On an existing Citrix session host, check the UPM path
Get-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Citrix\UserProfileManager" -Name "PathToUserStore"

# Or check via Citrix PowerShell
Add-PSSnapin Citrix.*
Get-BrokerSite | Select-Object -ExpandProperty UserProfilePath

# Typical paths:
# \\fileserver\profiles$\%username%
# \\fileserver\profiles$\%username%.%userdomain%\!CTX_PROFILEVER!!CTX_OSBITNESS!
```

### 1.2 Inventory profile sizes

```powershell
# Scan UPM share for profile sizes
$upmShare = "\\fileserver\profiles$"
$profiles = Get-ChildItem -Path $upmShare -Directory

$inventory = foreach ($profile in $profiles) {
    $size = (Get-ChildItem -Path $profile.FullName -Recurse -Force -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum).Sum

    [PSCustomObject]@{
        Username     = $profile.Name
        SizeMB       = [math]::Round($size / 1MB, 2)
        SizeGB       = [math]::Round($size / 1GB, 2)
        FileCount    = (Get-ChildItem -Path $profile.FullName -Recurse -Force -ErrorAction SilentlyContinue).Count
        LastModified = $profile.LastWriteTime
    }
}

# Summary
$inventory | Sort-Object SizeMB -Descending | Format-Table -AutoSize

# Export for planning
$inventory | Export-Csv "C:\Migration\upm-inventory.csv" -NoTypeInformation

# Key metrics
Write-Host "Total profiles: $($inventory.Count)"
Write-Host "Total size (GB): $(($inventory | Measure-Object SizeGB -Sum).Sum)"
Write-Host "Average size (MB): $(($inventory | Measure-Object SizeMB -Average).Average)"
Write-Host "Largest profile (GB): $(($inventory | Measure-Object SizeGB -Maximum).Maximum)"
```

### 1.3 Identify profile issues before migration

```powershell
# Find profiles over 5 GB (may need cleanup before migration)
$largeProfiles = $inventory | Where-Object { $_.SizeGB -gt 5 }
Write-Host "Profiles over 5 GB: $($largeProfiles.Count)"
$largeProfiles | Format-Table Username, SizeGB

# Find profiles not accessed in 90+ days (candidates for skip/archive)
$staleProfiles = $inventory | Where-Object { $_.LastModified -lt (Get-Date).AddDays(-90) }
Write-Host "Stale profiles (90+ days): $($staleProfiles.Count)"

# Find common large files in profiles
$sampleProfile = ($largeProfiles | Select-Object -First 1).Username
$largeFolders = Get-ChildItem -Path "$upmShare\$sampleProfile" -Directory -Recurse |
    ForEach-Object {
        $folderSize = (Get-ChildItem -Path $_.FullName -Recurse -Force -ErrorAction SilentlyContinue |
            Measure-Object -Property Length -Sum).Sum
        [PSCustomObject]@{
            Path = $_.FullName.Replace("$upmShare\$sampleProfile\", "")
            SizeMB = [math]::Round($folderSize / 1MB, 2)
        }
    } | Sort-Object SizeMB -Descending | Select-Object -First 20

$largeFolders | Format-Table -AutoSize
```

---

## Step 2: Prepare Azure Files for FSLogix

### 2.1 Verify storage account and shares exist

If you followed the [AVD Deployment Tutorial](tutorial-avd-deployment.md), the storage account already exists. If not:

```bash
# Create storage account (if not already created)
az storage account create \
  --name stavdprofiles \
  --resource-group rg-avd-prod \
  --location eastus2 \
  --sku Premium_LRS \
  --kind FileStorage \
  --enable-large-file-share \
  --default-action Deny

# Create profile share
az storage share-rm create \
  --name profiles \
  --storage-account stavdprofiles \
  --enabled-protocol SMB \
  --quota 1024

# Create Office container share (optional but recommended)
az storage share-rm create \
  --name odfc \
  --storage-account stavdprofiles \
  --enabled-protocol SMB \
  --quota 512
```

### 2.2 Verify NTFS permissions

Mount the share and verify permissions:

```powershell
# Mount share (use storage account key for initial setup)
$storageKey = az storage account keys list --account-name stavdprofiles --resource-group rg-avd-prod --query "[0].value" -o tsv
net use Z: "\\stavdprofiles.file.core.windows.net\profiles" /user:Azure\stavdprofiles $storageKey

# Verify or set NTFS permissions
icacls Z:\ /grant "CREATOR OWNER:(OI)(CI)(IO)(F)"
icacls Z:\ /grant "Users:(M)"
icacls Z:\ /grant "Administrators:(OI)(CI)(F)"

# Verify
icacls Z:\
```

---

## Step 3: Configure FSLogix on session hosts

### 3.1 Verify FSLogix installation

```powershell
# Check FSLogix is installed
$fslogixService = Get-Service "frxsvc" -ErrorAction SilentlyContinue
if ($fslogixService) {
    Write-Host "FSLogix service: $($fslogixService.Status)" -ForegroundColor Green
} else {
    Write-Host "FSLogix not installed" -ForegroundColor Red
    # Install if needed (see session-host-migration.md)
}

# Check version
$version = (Get-ItemProperty "HKLM:\SOFTWARE\FSLogix\Apps" -Name "InstallPath" -ErrorAction SilentlyContinue)
& "$($version.InstallPath)\frx.exe" version
```

### 3.2 Apply FSLogix registry configuration

```powershell
# Profile Container configuration
$regPath = "HKLM:\SOFTWARE\FSLogix\Profiles"
New-Item -Path $regPath -Force | Out-Null

$settings = @{
    "Enabled"                          = @{ Value = 1; Type = "DWord" }
    "VHDLocations"                     = @{ Value = "\\stavdprofiles.file.core.windows.net\profiles"; Type = "String" }
    "DeleteLocalProfileWhenVHDShouldApply" = @{ Value = 1; Type = "DWord" }
    "FlipFlopProfileDirectoryName"     = @{ Value = 1; Type = "DWord" }
    "SizeInMBs"                        = @{ Value = 30000; Type = "DWord" }
    "VolumeType"                       = @{ Value = "VHDX"; Type = "String" }
    "IsDynamic"                        = @{ Value = 1; Type = "DWord" }
    "LockedRetryCount"                 = @{ Value = 3; Type = "DWord" }
    "LockedRetryInterval"              = @{ Value = 15; Type = "DWord" }
    "PreventLoginWithFailure"          = @{ Value = 1; Type = "DWord" }
    "PreventLoginWithTempProfile"      = @{ Value = 1; Type = "DWord" }
}

foreach ($key in $settings.Keys) {
    Set-ItemProperty -Path $regPath -Name $key -Value $settings[$key].Value -Type $settings[$key].Type
    Write-Host "Set $key = $($settings[$key].Value)"
}

Write-Host "`nFSLogix Profile Container configured" -ForegroundColor Green
```

### 3.3 Configure profile exclusions

```powershell
# Create redirections.xml for temp data exclusion
$redirectionsDir = "C:\FSLogix\Redirections"
New-Item -Path $redirectionsDir -ItemType Directory -Force

$redirectionsXml = @"
<?xml version="1.0" encoding="UTF-8"?>
<FrxProfileFolderRedirection ExcludeCommonFolders="0">
  <Excludes>
    <Exclude Copy="0">AppData\Local\Temp</Exclude>
    <Exclude Copy="0">AppData\Local\Microsoft\Windows\INetCache</Exclude>
    <Exclude Copy="0">AppData\Local\Microsoft\Windows\Explorer</Exclude>
    <Exclude Copy="0">AppData\Local\Google\Chrome\User Data\Default\Cache</Exclude>
    <Exclude Copy="0">AppData\Local\Microsoft\Edge\User Data\Default\Cache</Exclude>
    <Exclude Copy="0">AppData\Local\CrashDumps</Exclude>
    <Exclude Copy="0">AppData\Local\Citrix</Exclude>
  </Excludes>
</FrxProfileFolderRedirection>
"@

$redirectionsXml | Out-File "$redirectionsDir\redirections.xml" -Encoding UTF8

# Point FSLogix to the redirections file
Set-ItemProperty -Path "HKLM:\SOFTWARE\FSLogix\Profiles" `
  -Name "RedirXMLSourceFolder" -Value $redirectionsDir -Type String

Write-Host "Redirections.xml configured" -ForegroundColor Green
```

---

## Step 4: Migrate profiles

### 4.1 Option A: Selective migration (recommended)

Migrate only essential user data. This is the recommended approach because:

- UPM profiles contain Citrix-specific data that is irrelevant on AVD
- Browser caches and temp data do not need migration
- OneDrive KFM handles Documents/Desktop/Pictures

```powershell
# Selective migration: copy key user data into a new FSLogix profile
param(
    [string]$UPMShare = "\\fileserver\profiles$",
    [string]$FSLogixShare = "\\stavdprofiles.file.core.windows.net\profiles",
    [string[]]$UsersToMigrate = @("jsmith", "jdoe")  # or import from CSV
)

foreach ($username in $UsersToMigrate) {
    Write-Host "`n=== Migrating: $username ===" -ForegroundColor Cyan

    # Resolve SID
    try {
        $userObj = New-Object System.Security.Principal.NTAccount($username)
        $sid = $userObj.Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
        Write-Warning "Cannot resolve SID for $username - skipping"
        continue
    }

    # Create FSLogix VHDx
    $vhdxDir = Join-Path $FSLogixShare "${username}_${sid}"
    $vhdxPath = Join-Path $vhdxDir "Profile_${username}.vhdx"

    if (Test-Path $vhdxPath) {
        Write-Host "  VHDx already exists - skipping creation" -ForegroundColor Yellow
        continue
    }

    New-Item -Path $vhdxDir -ItemType Directory -Force | Out-Null

    # Create and mount VHDx
    $diskpartScript = @"
create vdisk file="$vhdxPath" maximum=30000 type=expandable
select vdisk file="$vhdxPath"
attach vdisk
create partition primary
format fs=ntfs label="Profile" quick
assign letter=P
"@

    $diskpartScript | diskpart

    # Create profile directory structure
    $profileDirs = @(
        "P:\Profile\AppData\Roaming",
        "P:\Profile\AppData\Local\Microsoft\Office",
        "P:\Profile\Desktop",
        "P:\Profile\Documents",
        "P:\Profile\Favorites",
        "P:\Profile\Downloads"
    )

    foreach ($dir in $profileDirs) {
        New-Item -Path $dir -ItemType Directory -Force | Out-Null
    }

    # Copy selective data from UPM
    $upmProfile = Join-Path $UPMShare $username
    $foldersToMigrate = @(
        @{ Source = "AppData\Roaming\Microsoft\Signatures"; Dest = "P:\Profile\AppData\Roaming\Microsoft\Signatures" },
        @{ Source = "AppData\Roaming\Microsoft\Templates"; Dest = "P:\Profile\AppData\Roaming\Microsoft\Templates" },
        @{ Source = "AppData\Roaming\Microsoft\Proof"; Dest = "P:\Profile\AppData\Roaming\Microsoft\Proof" },
        @{ Source = "Favorites"; Dest = "P:\Profile\Favorites" },
        @{ Source = "Desktop"; Dest = "P:\Profile\Desktop" }
    )

    foreach ($folder in $foldersToMigrate) {
        $sourcePath = Join-Path $upmProfile $folder.Source
        if (Test-Path $sourcePath) {
            Copy-Item -Path $sourcePath -Destination $folder.Dest -Recurse -Force
            Write-Host "  Copied: $($folder.Source)" -ForegroundColor Green
        }
    }

    # Copy UPM registry (NTUSER.DAT) if exists
    $ntuserDat = Join-Path $upmProfile "NTUSER.DAT"
    if (Test-Path $ntuserDat) {
        Copy-Item -Path $ntuserDat -Destination "P:\Profile\NTUSER.DAT" -Force
        Write-Host "  Copied: NTUSER.DAT" -ForegroundColor Green
    }

    # Dismount VHDx
    $dismountScript = @"
select vdisk file="$vhdxPath"
detach vdisk
"@
    $dismountScript | diskpart

    Write-Host "  Migration complete for $username" -ForegroundColor Green
}

Write-Host "`n=== Migration complete ===" -ForegroundColor Cyan
```

### 4.2 Option B: Full migration using frx copy-profile

For environments where all UPM profile data must be preserved:

```powershell
# Full migration using FSLogix frx tool
param(
    [string]$UPMShare = "\\fileserver\profiles$",
    [string]$FSLogixShare = "\\stavdprofiles.file.core.windows.net\profiles"
)

$frxPath = "C:\Program Files\FSLogix\Apps\frx.exe"

$users = Get-ChildItem -Path $UPMShare -Directory

foreach ($user in $users) {
    $username = $user.Name
    Write-Host "Migrating: $username"

    try {
        $userObj = New-Object System.Security.Principal.NTAccount($username)
        $sid = $userObj.Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
        Write-Warning "Cannot resolve SID for $username - skipping"
        continue
    }

    $vhdxPath = Join-Path $FSLogixShare "${username}_${sid}\Profile_${username}.vhdx"

    & $frxPath copy-profile `
        -filename $vhdxPath `
        -sid $sid `
        -username $username `
        -dynamic 1 `
        -size-mbs 30000 `
        -src $user.FullName `
        -verbose

    if ($LASTEXITCODE -eq 0) {
        Write-Host "  SUCCESS" -ForegroundColor Green
    } else {
        Write-Warning "  FAILED (exit code: $LASTEXITCODE)"
    }
}
```

---

## Step 5: Validate profile loading

### 5.1 Test with a pilot user

1. Log into an AVD session host with a migrated user account
2. Check FSLogix profile mount:

```powershell
# Verify profile is mounted
& "C:\Program Files\FSLogix\Apps\frx.exe" list

# Expected output shows the VHDx attached and profile path

# Verify user data was migrated
Test-Path "$env:USERPROFILE\Desktop"
Test-Path "$env:USERPROFILE\Favorites"
Test-Path "$env:APPDATA\Microsoft\Signatures"
```

3. Check Event Viewer: **Applications and Services Logs > FSLogix > Operational**
    - Event ID 25: Profile loaded successfully
    - Check for any Error events

### 5.2 Measure login performance

```powershell
# Check total logon time from FSLogix logs
$fslogixLogs = Get-WinEvent -LogName "FSLogix-Apps/Operational" -MaxEvents 10 |
    Where-Object { $_.Id -eq 25 }

foreach ($log in $fslogixLogs) {
    Write-Host "User: $($log.Properties[0].Value) | Load time: $($log.Properties[1].Value)ms"
}

# Target: < 5000ms (5 seconds)
```

### 5.3 Verify application settings

After login, check that migrated settings are intact:

- [ ] Outlook signatures present (if migrated)
- [ ] Office custom templates available
- [ ] Browser favorites/bookmarks visible
- [ ] Desktop shortcuts present
- [ ] Custom dictionary (spell check) words preserved

---

## Step 6: Enable OneDrive Known Folder Move

For ongoing document sync (replaces Citrix folder redirection for Documents/Desktop/Pictures):

```powershell
# Configure KFM via registry (or Intune policy)
$oneDriveKey = "HKLM:\SOFTWARE\Policies\Microsoft\OneDrive"
New-Item -Path $oneDriveKey -Force | Out-Null

# Silently opt-in to KFM with tenant ID
Set-ItemProperty -Path $oneDriveKey -Name "KFMSilentOptIn" -Value "<your-tenant-id>" -Type String

# Show notification to users (recommended for first-time)
Set-ItemProperty -Path $oneDriveKey -Name "KFMSilentOptInWithNotification" -Value 1 -Type DWord

# Block KFM opt-out (prevent users from undoing)
Set-ItemProperty -Path $oneDriveKey -Name "KFMBlockOptOut" -Value 1 -Type DWord
```

---

## Step 7: Post-migration cleanup

### 7.1 Monitor for 30 days

- Monitor FSLogix event logs for errors daily
- Track profile load times via AVD Insights
- Collect user feedback on missing settings or data
- Address any profile-related helpdesk tickets

### 7.2 Archive UPM profiles

```powershell
# After 30-day validation, archive UPM profiles
# Option 1: Copy to Azure Blob Cool tier
azcopy copy "\\fileserver\profiles$" "https://starchive.blob.core.windows.net/upm-profiles/" --recursive

# Option 2: Compress and move to archive storage
Compress-Archive -Path "\\fileserver\profiles$" -DestinationPath "D:\Archives\upm-profiles-$(Get-Date -Format 'yyyyMMdd').zip"
```

### 7.3 Remove Citrix UPM configuration

```powershell
# Remove Citrix UPM GPO settings (via Group Policy Management Console)
# Navigate to the OU containing migrated session hosts
# Remove or unlink the Citrix Profile Management GPO

# On individual hosts (if GPO is not feasible)
Remove-Item -Path "HKLM:\SOFTWARE\Policies\Citrix\UserProfileManager" -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Citrix UPM registry configuration removed"
```

---

## Troubleshooting

| Issue                     | Cause                                                     | Solution                                                                    |
| ------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| FSLogix VHDx not mounting | Incorrect permissions on Azure Files share                | Verify RBAC and NTFS permissions (Step 2)                                   |
| Profile loads but empty   | Incorrect VHD path or flip-flop setting                   | Verify `FlipFlopProfileDirectoryName = 1` and path format                   |
| Login takes > 30 seconds  | VHDx too large or storage IOPS insufficient               | Check profile size; increase Azure Files quota for IOPS                     |
| "Temp profile" assigned   | FSLogix could not attach VHDx                             | Check Event Viewer for specific error; verify network connectivity to share |
| Outlook data missing      | Office data in UPM was not migrated to Office Container   | Migrate Outlook OST separately or let Outlook resync from Exchange          |
| Application settings lost | Settings stored in registry locations not captured by UPM | Use `frx copy-profile` with NTUSER.DAT to capture full registry             |

---

## Next steps

- [Best Practices](best-practices.md) -- optimize FSLogix for production
- [Monitoring Migration](monitoring-migration.md) -- track profile performance with AVD Insights
- [Session Host Migration](session-host-migration.md) -- complete the session host conversion

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
