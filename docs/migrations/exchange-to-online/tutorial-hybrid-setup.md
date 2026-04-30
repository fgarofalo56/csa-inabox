# Tutorial: Hybrid Exchange Setup

**Status:** Authored 2026-04-30
**Audience:** Exchange administrators setting up hybrid Exchange deployment for the first time.
**Time to complete:** 2--4 hours
**Prerequisites:** Exchange 2016 CU23+ or 2019 CU14+, Entra Connect deployed, M365 tenant provisioned, valid SSL certificate.

---

## What you will build

By the end of this tutorial, you will have:

1. A working hybrid Exchange deployment.
2. OAuth authentication between on-premises Exchange and Exchange Online.
3. Free/busy sharing between on-prem and cloud mailboxes.
4. A pilot batch of mailboxes migrated to Exchange Online.
5. Validated mail flow, calendar sharing, and Outlook connectivity.

---

## Step 1: Verify prerequisites

### Check Exchange Server version

```powershell
# On-premises Exchange Management Shell
Get-ExchangeServer | Format-Table Name, ServerRole, AdminDisplayVersion, Site

# Expected output should show Exchange 2016 CU23+ or 2019 CU14+
# Example: Version 15.1 (Build 2507.x) = Exchange 2016 CU23
# Example: Version 15.2 (Build 1544.x) = Exchange 2019 CU14
```

### Verify Entra Connect

```powershell
# On the Entra Connect server
Import-Module ADSync
Get-ADSyncScheduler | Format-List AllowedSyncCycleInterval, CurrentlyEffectiveSyncCycleInterval, SyncCycleEnabled

# Verify sync status
Get-ADSyncConnectorRunStatus

# Force a delta sync to ensure latest changes are reflected
Start-ADSyncSyncCycle -PolicyType Delta
```

### Verify SSL certificate

```powershell
# On-premises Exchange Management Shell
Get-ExchangeCertificate | Where-Object {$_.Services -match "IIS"} |
    Format-List Subject, CertificateDomains, NotAfter, Thumbprint, Status

# Certificate must include:
# - mail.domain.com (your external hostname)
# - autodiscover.domain.com
# Certificate must NOT be expired
# Certificate must be from a trusted CA (not self-signed)
```

### Verify DNS

```powershell
# From any machine with internet access
nslookup -type=CNAME autodiscover.domain.com
# Should return: autodiscover.domain.com -> autodiscover.outlook.com (if already pointed to EXO)
# OR your on-premises autodiscover endpoint (if not yet migrated)

nslookup -type=MX domain.com
# Should return your current MX record (on-prem or EOP)

nslookup -type=TXT domain.com
# Should return your SPF record
```

### Verify network connectivity

```powershell
# Test connectivity from Exchange server to Exchange Online
Test-NetConnection -ComputerName outlook.office365.com -Port 443
Test-NetConnection -ComputerName autodiscover.outlook.com -Port 443

# For GCC-High:
# Test-NetConnection -ComputerName outlook.office365.us -Port 443
```

---

## Step 2: Run the Hybrid Configuration Wizard

### Download and launch HCW

1. Download the Hybrid Configuration Wizard from [https://aka.ms/HybridWizard](https://aka.ms/HybridWizard).
2. Run the installer on your Exchange 2016/2019 server.
3. Launch the HCW.

### HCW configuration walkthrough

The HCW presents several configuration screens. Here are the recommended choices:

**Screen 1: Exchange Server detection**

- HCW auto-detects your Exchange organization.
- Verify the detected server is your intended hybrid endpoint.

**Screen 2: Credentials**

- On-premises: Domain\ExchangeAdmin (Organization Management role).
- Exchange Online: Global Administrator or Exchange Administrator.

**Screen 3: Hybrid topology**

- Select **Full Hybrid Configuration** for coexistence during migration.
- Select **Minimal Hybrid** only if you plan to migrate all mailboxes within 30 days.

**Screen 4: Hybrid server**

- Select the Exchange 2016/2019 server that will serve as the hybrid endpoint.
- This server must be internet-accessible on port 443.

**Screen 5: Transport certificate**

- Select the third-party SSL certificate installed on the hybrid server.
- The certificate must include the external hostname (mail.domain.com).

**Screen 6: Mail flow**

- **Centralized mail transport:** All internet mail routes through on-premises Exchange first.
- **Decentralized mail transport (recommended):** MX points to EOP; on-prem mail routes via connector.

**Screen 7: Organization FQDN**

- Enter the external FQDN of your Exchange server (e.g., `mail.domain.com`).

**Screen 8: Configure**

- HCW configures organization relationships, connectors, OAuth, and certificates.
- This takes 5--15 minutes.

!!! info "HCW can be re-run"
If the HCW encounters errors, it can be re-run safely. Each run is idempotent --- it will correct any misconfiguration from a previous run.

---

## Step 3: Validate OAuth authentication

OAuth enables cross-premises features like free/busy sharing and mailbox permissions.

```powershell
# On-premises Exchange Management Shell
# Test OAuth connectivity to Exchange Online
Test-OAuthConnectivity -Service EWS `
    -TargetUri https://outlook.office365.com/ews/exchange.asmx `
    -Mailbox admin@domain.com `
    -Verbose

# Expected result:
# ResultType : Success
# Identity   : Microsoft.Exchange.Security.OAuth.ValidationResultNodeId

# If OAuth fails, check:
# 1. Auth certificate is valid (Get-AuthConfig)
# 2. Auth Server configuration (Get-AuthServer)
# 3. Partner Application (Get-PartnerApplication)

# Verify Auth configuration
Get-AuthConfig | Format-List CurrentCertificateThumbprint, PreviousCertificateThumbprint
Get-AuthServer | Format-List Name, AuthMetadataUrl, IsDefaultAuthorizationEndpoint
Get-PartnerApplication | Format-List Name, ApplicationIdentifier, Enabled
```

### Troubleshoot OAuth failures

```powershell
# If Test-OAuthConnectivity fails with certificate errors:
# Check the auth certificate
$authConfig = Get-AuthConfig
$cert = Get-ExchangeCertificate -Thumbprint $authConfig.CurrentCertificateThumbprint
$cert | Format-List Subject, NotAfter, Status

# If certificate is expired, create a new one:
$newCert = New-ExchangeCertificate -KeySize 2048 -PrivateKeyExportable $true `
    -SubjectName "cn=Microsoft Exchange Server Auth Certificate" `
    -DomainName "domain.com" `
    -Services SMTP

Set-AuthConfig -NewCertificateThumbprint $newCert.Thumbprint -NewCertificateEffectiveDate (Get-Date)
Set-AuthConfig -PublishCertificate
```

---

## Step 4: Test free/busy sharing

```powershell
# On-premises Exchange Management Shell
# Verify organization relationship
Get-OrganizationRelationship | Format-List Name, DomainNames, FreeBusyAccessEnabled, FreeBusyAccessLevel, TargetAutodiscoverEpr

# Test free/busy from on-premises to cloud
# Create a test mailbox on-premises and a test mailbox in EXO
# In Outlook (on-prem user): create a meeting, invite a cloud user
# Check that the cloud user's availability shows correctly

# Verify from Exchange Online PowerShell
Connect-ExchangeOnline -UserPrincipalName admin@domain.com
Get-OrganizationRelationship | Format-List Name, DomainNames, FreeBusyAccessEnabled

# Test availability from cloud side
# In Outlook (cloud user): create a meeting, invite an on-prem user
# Check that the on-prem user's availability shows correctly
```

### Expected results

| Test                                            | Expected result                         |
| ----------------------------------------------- | --------------------------------------- |
| On-prem user views cloud user's calendar        | Shows free/busy or limited details      |
| Cloud user views on-prem user's calendar        | Shows free/busy or limited details      |
| On-prem user sends meeting to cloud user        | Meeting delivered, calendar updated     |
| Cloud user sends meeting to on-prem user        | Meeting delivered, calendar updated     |
| On-prem user opens cloud user's shared calendar | Calendar opens (if permissions granted) |

---

## Step 5: Move pilot mailboxes

### Select pilot users

Choose 5--10 users for the pilot:

- Include at least one IT staff member.
- Include users with shared calendars.
- Include users with mobile devices (test ActiveSync).
- Include users with delegates (test cross-premises permissions).
- Avoid users with litigation holds (test separately).

### Create pilot migration batch

```powershell
# Connect to Exchange Online PowerShell
Connect-ExchangeOnline -UserPrincipalName admin@domain.com

# Create CSV file for pilot users
# C:\Migration\pilot-users.csv:
# EmailAddress
# itadmin@domain.com
# pilot1@domain.com
# pilot2@domain.com
# pilot3@domain.com
# pilot4@domain.com

# Create migration batch
New-MigrationBatch -Name "Pilot-IT" `
    -SourceEndpoint "Hybrid Migration Endpoint - EWS (Default Web Site)" `
    -TargetDeliveryDomain "domain.mail.onmicrosoft.com" `
    -CSVData ([System.IO.File]::ReadAllBytes("C:\Migration\pilot-users.csv")) `
    -AutoStart

# Monitor progress
Get-MigrationBatch "Pilot-IT" | Format-List Status, TotalCount, SyncedCount, FailedCount

# Watch individual mailbox progress
Get-MoveRequest | Get-MoveRequestStatistics |
    Format-Table DisplayName, StatusDetail, PercentComplete, TotalMailboxSize

# Wait for sync to complete (Status: Synced)
# Then complete the batch
Complete-MigrationBatch -Identity "Pilot-IT"
```

### Validate pilot mailboxes

```powershell
# Verify mailbox is in Exchange Online
Get-Mailbox -Identity pilot1@domain.com | Format-List RecipientTypeDetails, Database, ServerName

# Verify mail flow (send test email)
Send-MailMessage -From admin@domain.com -To pilot1@domain.com -Subject "Migration Test" -Body "This is a post-migration test." -SmtpServer smtp.office365.com -Port 587 -UseSsl -Credential (Get-Credential)

# Verify message trace
Get-MessageTrace -RecipientAddress pilot1@domain.com -StartDate (Get-Date).AddHours(-1) -EndDate (Get-Date)
```

### Pilot validation checklist

- [ ] Outlook auto-reconfigured and connected to Exchange Online.
- [ ] Email send/receive working (internal and external).
- [ ] Calendar showing correctly (own calendar and shared calendars).
- [ ] Free/busy sharing with on-premises users working.
- [ ] Mobile device (ActiveSync) reconnected.
- [ ] Outlook on the web (outlook.office365.com) accessible.
- [ ] Distribution group membership intact.
- [ ] Shared mailbox access working.
- [ ] Outlook search returning results.
- [ ] Offline mode (cached Exchange mode) functioning.

---

## Step 6: Review and plan production migration

After pilot validation:

1. **Document any issues** encountered during pilot and their resolutions.
2. **Adjust migration batch settings** (concurrent migrations, bad item limits).
3. **Plan production waves** by department, geography, or function.
4. **Schedule communication** to end users.
5. **Plan DNS cutover** timing (after all mailboxes are migrated or mid-migration if using decentralized routing).

Continue to [Tutorial: Mailbox Move](tutorial-mailbox-move.md) for production migration steps.

---

## Troubleshooting

| Issue                                                | Likely cause                            | Resolution                                                  |
| ---------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------- |
| HCW fails at "Configuring Organization Relationship" | Firewall blocking EXO to on-prem        | Open port 443 from Exchange Online IPs to hybrid server     |
| OAuth test fails                                     | Auth certificate expired                | Regenerate auth certificate (see Step 3)                    |
| Free/busy shows "no information"                     | Organization relationship misconfigured | Re-run HCW; verify `Get-OrganizationRelationship`           |
| Migration batch fails to create                      | Migration endpoint unreachable          | Verify hybrid server is accessible from internet            |
| Mailbox move stuck at 95%                            | Large items or corrupted items          | Increase bad item limit: `Set-MoveRequest -BadItemLimit 50` |
| Outlook loops on credential prompt                   | Autodiscover returning wrong endpoint   | Verify SCP in AD; check Autodiscover DNS                    |

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
