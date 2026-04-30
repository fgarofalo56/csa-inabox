# Tutorial: Entra Join a Windows Device

**Step-by-step tutorial for migrating a Windows device from Active Directory domain join to Microsoft Entra Join with Intune management and Autopilot provisioning.**

**Duration:** 1--2 hours
**Prerequisites:** Windows 10/11 Pro or Enterprise, Entra ID tenant with Intune license (M365 E3/E5), user with Entra ID credentials, network connectivity to Entra ID endpoints

---

## What you will accomplish

By the end of this tutorial, you will have:

1. Configured Entra Join settings in the Entra admin center
2. Created a Windows Autopilot deployment profile
3. Migrated a Windows device from domain-joined to Entra-joined
4. Enrolled the device in Intune for cloud management
5. Validated SSO and compliance policy application

---

## Step 1: Configure Entra Join settings

### 1.1 Enable Entra Join

```
1. Sign in to the Entra admin center (https://entra.microsoft.com)
2. Navigate to Identity > Devices > Device settings
3. Configure:
   - Users may join devices to Entra ID: "All" or selected group
   - Require multi-factor authentication to register or join: "Yes"
   - Maximum number of devices per user: 15 (or as appropriate)
4. Save
```

### 1.2 Configure MDM auto-enrollment

```
1. Navigate to Identity > Mobility (MDM and WIP) > Microsoft Intune
2. Configure:
   - MDM user scope: "All" or selected group
   - MDM terms of use URL: (leave default)
   - MDM discovery URL: https://enrollment.manage.microsoft.com/enrollmentserver/discovery.svc
   - MDM compliance URL: (leave default)
3. Save
```

### 1.3 Verify Entra Join settings via PowerShell

```powershell
# Verify device settings
Connect-MgGraph -Scopes "Policy.Read.All"

$deviceSettings = Get-MgPolicyDeviceRegistrationPolicy
$deviceSettings | Select-Object DisplayName, MultiFactorAuthConfiguration,
    @{N="JoinScope"; E={$_.AzureADJoin.AllowedUsers}}
```

---

## Step 2: Create Autopilot deployment profile

### 2.1 Register device hardware hash

```powershell
# Run on the target device (as Administrator)
# Install the script
Install-Script -Name Get-WindowsAutoPilotInfo -Force

# Collect hardware hash
Get-WindowsAutoPilotInfo -OutputFile "$env:TEMP\autopilot-device.csv"

# Display the CSV content
Get-Content "$env:TEMP\autopilot-device.csv"
# Output: Device Serial Number, Windows Product ID, Hardware Hash
```

### 2.2 Upload hardware hash to Intune

```
1. Sign in to the Intune admin center (https://intune.microsoft.com)
2. Navigate to Devices > Enrollment > Windows Autopilot > Devices
3. Click Import
4. Upload the CSV file from Step 2.1
5. Wait for the import to complete (may take 15 minutes)
```

### 2.3 Create deployment profile

```powershell
# Via Microsoft Graph API
Connect-MgGraph -Scopes "DeviceManagementServiceConfig.ReadWrite.All"

$profile = @{
    "@odata.type" = "#microsoft.graph.azureADWindowsAutopilotDeploymentProfile"
    displayName = "CSA-in-a-Box Standard Entra Join"
    description = "Standard Entra Join profile for data platform users"
    language = "en-US"
    extractHardwareHash = $true
    deviceNameTemplate = "CSA-%SERIAL%"
    outOfBoxExperienceSettings = @{
        "@odata.type" = "microsoft.graph.outOfBoxExperienceSettings"
        hidePrivacySettings = $true
        hideEULA = $true
        userType = "standard"
        hideEscapeLink = $true
        skipKeyboardSelectionPage = $true
        deviceUsageType = "singleUser"
    }
    enrollmentStatusScreenSettings = @{
        "@odata.type" = "microsoft.graph.windowsEnrollmentStatusScreenSettings"
        hideInstallationProgress = $false
        allowDeviceUseBeforeProfileAndAppInstallComplete = $false
        blockDeviceSetupRetryByUser = $true
        allowLogCollectionOnInstallFailure = $true
        installProgressTimeoutInMinutes = 60
    }
}

$createdProfile = New-MgDeviceManagementWindowsAutopilotDeploymentProfile `
    -BodyParameter $profile

Write-Host "Profile created: $($createdProfile.DisplayName)"
Write-Host "Profile ID: $($createdProfile.Id)"
```

### 2.4 Assign profile to device group

```powershell
# Create a dynamic device group for Autopilot devices
$groupParams = @{
    displayName = "CSA-Autopilot-Devices"
    description = "Dynamic group for Autopilot-registered devices"
    groupTypes = @("DynamicMembership")
    membershipRule = '(device.devicePhysicalIDs -any (_ -contains "[ZTDId]"))'
    membershipRuleProcessingState = "On"
    securityEnabled = $true
    mailEnabled = $false
    mailNickname = "csa-autopilot-devices"
}

$group = New-MgGroup -BodyParameter $groupParams

# Assign the Autopilot profile to the group
# Intune admin center > Devices > Enrollment > Deployment profiles
# Select profile > Assignments > Add group
```

---

## Step 3: Prepare compliance and configuration policies

### 3.1 Create device compliance policy

```
1. Intune admin center > Devices > Compliance > Create policy
2. Platform: Windows 10 and later
3. Name: "CSA-in-a-Box Device Compliance"
4. Settings:
   - Device Health:
     - Require BitLocker: Yes
     - Require Secure Boot: Yes
     - Require Code Integrity: Yes
   - Device Properties:
     - Minimum OS version: 10.0.22621 (Windows 11 22H2)
   - System Security:
     - Require a password: Yes
     - Minimum password length: 12
     - Firewall: Require
     - Antivirus: Require
     - Encryption of data storage: Require
5. Actions for noncompliance:
   - Mark device noncompliant: After 1 day
   - Send email to user: After 1 day
6. Assignments: Assign to "CSA-Autopilot-Devices" group
```

### 3.2 Create configuration profile

```
1. Intune admin center > Devices > Configuration > Create > Settings Catalog
2. Name: "CSA-in-a-Box Device Configuration"
3. Add settings:
   - Windows Hello for Business:
     - Use Windows Hello for Business: Enable
     - Minimum PIN Length: 6
     - Use Biometrics: Enable
   - BitLocker:
     - Require Device Encryption: Yes
     - Recovery Options: Entra ID backup enabled
   - Windows Update:
     - Quality Update Deferral: 7 days
     - Feature Update Deferral: 30 days
4. Assignments: Assign to "CSA-Autopilot-Devices" group
```

---

## Step 4: Migrate the device

### Option A: Autopilot reset (recommended for existing devices)

```powershell
# Trigger Autopilot reset from Intune
# This wipes the device and re-provisions it with Entra Join

# From Intune admin center:
# Devices > All devices > [Select device] > Autopilot reset
# The device will reboot, wipe, and enter OOBE

# Or via Graph API:
$deviceId = "managed-device-id"
Invoke-MgGraphRequest -Method POST `
    -Uri "https://graph.microsoft.com/v1.0/deviceManagement/managedDevices/$deviceId/wipe" `
    -Body '{"keepEnrollmentData": false, "keepUserData": false}'
```

### Option B: Manual domain unjoin and Entra Join

```powershell
# Step 1: Backup data
# Ensure user data is backed up to OneDrive or external storage

# Step 2: Backup BitLocker recovery key
$bv = Get-BitLockerVolume -MountPoint "C:"
$rk = $bv.KeyProtector | Where-Object { $_.KeyProtectorType -eq "RecoveryPassword" }
Write-Host "SAVE THIS KEY: $($rk.RecoveryPassword)"

# Step 3: Leave the domain (requires local admin or domain admin)
# Settings > Accounts > Access work or school
# Click on the AD domain connection > Disconnect
# OR via PowerShell:
Remove-Computer -Force -Restart

# Step 4: After reboot, join Entra ID
# Settings > Accounts > Access work or school > Connect
# Click "Join this device to Azure Active Directory"
# Sign in with Entra ID credentials (user@contoso.com)

# Step 5: Restart the device
# After restart, sign in with Entra ID credentials
# Intune enrollment happens automatically (MDM auto-enrollment configured in Step 1.2)
```

### Option C: New device with Autopilot OOBE

```
1. Unbox new device and connect to network (Wi-Fi or Ethernet)
2. Windows OOBE starts automatically
3. Select region and keyboard layout
4. Connect to network
5. Autopilot profile detected (device hash was uploaded in Step 2.2)
6. Organization branding appears
7. User signs in with Entra ID credentials
8. Windows Hello for Business enrollment
9. Enrollment Status Page shows app and policy installation progress
10. Desktop appears --- device is Entra-joined and Intune-managed
```

---

## Step 5: Validate the migration

### 5.1 Verify Entra Join status

```powershell
# Run on the migrated device
dsregcmd /status

# Expected output:
# +----------------------------------------------------------------------+
# | Device State                                                          |
# +----------------------------------------------------------------------+
#
#              AzureAdJoined : YES          <-- Entra Joined
#           EnterpriseJoined : NO
#               DomainJoined : NO           <-- NOT domain-joined
#
# +----------------------------------------------------------------------+
# | SSO State                                                             |
# +----------------------------------------------------------------------+
#
#             AzureAdPrt : YES              <-- Primary Refresh Token
#    AzureAdPrtUpdateTime : 2026-04-30 10:00:00 UTC
#    AzureAdPrtExpiryTime : 2026-05-14 10:00:00 UTC
```

### 5.2 Verify Intune enrollment

```powershell
# Check Intune enrollment status on the device
Get-ChildItem "HKLM:\SOFTWARE\Microsoft\Enrollments" |
    Get-ItemProperty |
    Where-Object { $_.ProviderID -eq "MS DM Server" } |
    Select-Object PSChildName, UPN, ProviderID, EnrollmentState

# Or check via Intune admin center:
# Devices > All devices > [Device name] > Overview
# Verify: Managed by = Intune, Compliance = Compliant
```

### 5.3 Verify SSO to CSA-in-a-Box services

```powershell
# Test SSO to Microsoft services (should not prompt for credentials)
Start-Process "https://app.fabric.microsoft.com"      # Fabric portal
Start-Process "https://app.powerbi.com"                # Power BI
Start-Process "https://portal.azure.com"               # Azure Portal
Start-Process "https://web.purview.azure.com"          # Purview

# Each should sign in automatically using the Primary Refresh Token
# If prompted for credentials, verify:
# 1. dsregcmd /status shows AzureAdPrt: YES
# 2. Edge is signed in with the same Entra ID account
# 3. No Conditional Access policy is blocking access
```

### 5.4 Verify compliance policy

```powershell
# Check device compliance from the device
# Settings > Accounts > Access work or school > [Connection] > Info
# Verify: Device compliance = Compliant

# Via Graph API (from admin context):
$device = Get-MgDeviceManagementManagedDevice -Filter `
    "deviceName eq 'CSA-DEVICE01'"

$device | Select-Object DeviceName, ComplianceState,
    LastSyncDateTime, OperatingSystem, AzureADRegistered,
    @{N="Management"; E={$_.ManagementAgent}}
```

### 5.5 Verify BitLocker key escrow

```powershell
# Verify BitLocker recovery key is in Entra ID
# Entra admin center > Identity > Devices > All devices > [Device] > BitLocker keys

# Or via Graph API:
$deviceObjectId = "device-object-id-from-entra"
$keys = Get-MgInformationProtectionBitlockerRecoveryKey -Filter `
    "deviceId eq '$deviceObjectId'"
Write-Host "BitLocker keys escrowed: $($keys.Count)"
```

---

## Step 6: Post-migration validation

### 6.1 Application access testing

| Application                        | Expected behavior                     | Test method                           |
| ---------------------------------- | ------------------------------------- | ------------------------------------- |
| Microsoft 365 (Word, Excel, Teams) | SSO via PRT                           | Open app; verify no credential prompt |
| Power BI                           | SSO via PRT + Conditional Access pass | Open app.powerbi.com                  |
| Fabric portal                      | SSO via PRT + Conditional Access pass | Open app.fabric.microsoft.com         |
| Azure Portal                       | SSO via PRT + Conditional Access pass | Open portal.azure.com                 |
| On-prem web app via App Proxy      | SSO via App Proxy                     | Access external URL                   |
| VPN (if still needed)              | Entra ID auth instead of AD auth      | Connect to VPN                        |

### 6.2 User experience verification

- [ ] User can sign in with Entra ID credentials
- [ ] Windows Hello for Business is enrolled (face, fingerprint, or PIN)
- [ ] OneDrive Known Folder Move is syncing
- [ ] Printers are available (via Universal Print or Intune deployment)
- [ ] Network drives (if needed) are mapped via Intune script
- [ ] Previously installed applications are accessible
- [ ] Microsoft 365 apps activate without issue

---

## Troubleshooting

| Issue                            | Symptom                            | Resolution                                                    |
| -------------------------------- | ---------------------------------- | ------------------------------------------------------------- |
| Autopilot not detected           | Device goes to standard OOBE       | Verify hardware hash uploaded; wait 30 min for sync           |
| Join fails with error 0x801c0003 | "Something went wrong" during join | Verify device settings allow user to join; check MFA          |
| PRT not issued                   | `AzureAdPrt: NO` in dsregcmd       | Check connectivity; clear token broker cache; re-register     |
| Intune not enrolling             | Device joined but not in Intune    | Verify MDM auto-enrollment configured; check user license     |
| Compliance check failing         | Device shows non-compliant         | Wait 8 hours for initial sync; check specific failing control |
| WHfB enrollment fails            | Cannot set up PIN/biometric        | Verify WHfB policy in Intune; check TPM status                |

```powershell
# Force Intune sync (if enrollment stalled)
Get-ScheduledTask | Where-Object { $_.TaskName -like "*Intune*" -or $_.TaskName -like "*MDM*" } |
    Start-ScheduledTask

# Clear Windows token broker cache (if SSO issues)
# Settings > Accounts > Access work or school > [Connection] > Disconnect
# Then re-connect
```

---

## Next steps

After completing this tutorial:

1. **Deploy to pilot group** (50--100 devices) for 2-week validation
2. **Configure Conditional Access** to require compliant devices for CSA-in-a-Box access
3. **Deploy Windows Hello for Business** for passwordless authentication
4. **Begin GPO migration** to Intune configuration profiles (see [GPO Migration](group-policy-migration.md))
5. **Expand to production** using wave-based approach (see [Device Migration](device-migration.md))

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
