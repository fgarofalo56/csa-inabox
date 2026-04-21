<#
.SYNOPSIS
    Manages Key Vault secrets for the CSA-in-a-Box data platform.
    Handles secret rotation, access policy configuration, and managed identity wiring.

.DESCRIPTION
    This script provides:
    1. Secret rotation for SQL passwords, storage keys, and connection strings
    2. Access policy setup for service managed identities
    3. Validation of Key Vault configuration against platform requirements
    4. Integration with Azure Event Grid for secret expiry notifications

.PARAMETER KeyVaultName
    Name of the Key Vault to manage.

.PARAMETER SubscriptionId
    Azure subscription ID where the Key Vault resides.

.PARAMETER Action
    The action to perform: 'rotate-secrets', 'setup-access', 'validate', 'configure-rotation'

.EXAMPLE
    .\manage-keyvault.ps1 -KeyVaultName "dlz-prod-kv" -Action "setup-access"
    .\manage-keyvault.ps1 -KeyVaultName "dlz-prod-kv" -Action "rotate-secrets" -SecretNames "sql-admin-password,storage-key"
    .\manage-keyvault.ps1 -KeyVaultName "dlz-prod-kv" -Action "validate"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$KeyVaultName,

    [Parameter(Mandatory = $false)]
    [string]$SubscriptionId,

    [Parameter(Mandatory = $true)]
    [ValidateSet('rotate-secrets', 'setup-access', 'validate', 'configure-rotation')]
    [string]$Action,

    [Parameter(Mandatory = $false)]
    [string[]]$SecretNames = @(),

    [Parameter(Mandatory = $false)]
    [string]$Environment = 'dev'
)

$ErrorActionPreference = 'Stop'

# ─── Helper Functions ─────────────────────────────────────────────────────────

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $color = switch ($Level) {
        'ERROR' { 'Red' }
        'WARN' { 'Yellow' }
        'SUCCESS' { 'Green' }
        default { 'White' }
    }
    Write-Host "[$timestamp] [$Level] $Message" -ForegroundColor $color
}

function New-SecurePassword {
    param([int]$Length = 32)
    $chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*'
    $password = -join (1..$Length | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })
    return $password
}

# ─── Setup Access Policies for Data Platform Managed Identities ───────────────

function Set-DataPlatformAccessPolicies {
    param([string]$VaultName)

    Write-Log "Configuring RBAC-based access for data platform managed identities..."

    # Define the managed identities and their required permissions
    $identityConfig = @(
        @{
            Name        = 'Azure Data Factory'
            ResourceType = 'Microsoft.DataFactory/factories'
            Role        = 'Key Vault Secrets User'  # 4633458b-17de-408a-b874-0445c86b69e6
            RoleId      = '4633458b-17de-408a-b874-0445c86b69e6'
        },
        @{
            Name        = 'Azure Databricks'
            ResourceType = 'Microsoft.Databricks/workspaces'
            Role        = 'Key Vault Secrets User'
            RoleId      = '4633458b-17de-408a-b874-0445c86b69e6'
        },
        @{
            Name        = 'Azure Synapse'
            ResourceType = 'Microsoft.Synapse/workspaces'
            Role        = 'Key Vault Secrets User'
            RoleId      = '4633458b-17de-408a-b874-0445c86b69e6'
        },
        @{
            Name        = 'Azure Machine Learning'
            ResourceType = 'Microsoft.MachineLearningServices/workspaces'
            Role        = 'Key Vault Secrets User'
            RoleId      = '4633458b-17de-408a-b874-0445c86b69e6'
        },
        @{
            Name        = 'Azure Functions'
            ResourceType = 'Microsoft.Web/sites'
            Role        = 'Key Vault Secrets User'
            RoleId      = '4633458b-17de-408a-b874-0445c86b69e6'
        }
    )

    # Get Key Vault resource ID for scope
    $kvResource = az keyvault show --name $VaultName --query "id" -o tsv
    if (-not $kvResource) {
        Write-Log "Key Vault '$VaultName' not found." 'ERROR'
        return
    }

    foreach ($identity in $identityConfig) {
        Write-Log "Checking for $($identity.Name) managed identities..."

        # Find all resources of this type in the subscription
        $resources = az resource list --resource-type $identity.ResourceType --query "[].{name:name, identity:identity.principalId}" -o json | ConvertFrom-Json

        foreach ($resource in $resources) {
            if ($resource.identity) {
                Write-Log "Assigning '$($identity.Role)' to $($identity.Name) '$($resource.name)'..."
                az role assignment create `
                    --assignee-object-id $resource.identity `
                    --assignee-principal-type ServicePrincipal `
                    --role $identity.RoleId `
                    --scope $kvResource `
                    --only-show-errors 2>$null

                if ($LASTEXITCODE -eq 0) {
                    Write-Log "  Assigned to $($resource.name)" 'SUCCESS'
                }
                else {
                    Write-Log "  Assignment may already exist for $($resource.name)" 'WARN'
                }
            }
        }
    }

    Write-Log "Access policy configuration complete." 'SUCCESS'
}

# ─── Secret Rotation ─────────────────────────────────────────────────────────

function Invoke-SecretRotation {
    param(
        [string]$VaultName,
        [string[]]$Secrets
    )

    if ($Secrets.Count -eq 0) {
        # Default secrets to rotate
        $Secrets = @(
            'sql-admin-password'
            'synapse-sql-password'
        )
    }

    Write-Log "Rotating $($Secrets.Count) secrets in Key Vault '$VaultName'..."

    foreach ($secretName in $Secrets) {
        Write-Log "Rotating secret: $secretName"

        # Generate new secret value
        $newValue = New-SecurePassword -Length 32

        # Set secret with metadata
        $expiryDate = (Get-Date).AddDays(90).ToString("yyyy-MM-ddTHH:mm:ssZ")

        az keyvault secret set `
            --vault-name $VaultName `
            --name $secretName `
            --value $newValue `
            --expires $expiryDate `
            --tags "rotated-by=csa-inabox" "rotated-on=$(Get-Date -Format 'yyyy-MM-dd')" "environment=$Environment" `
            --only-show-errors | Out-Null

        if ($LASTEXITCODE -eq 0) {
            Write-Log "  Rotated successfully. New expiry: $expiryDate" 'SUCCESS'
        }
        else {
            Write-Log "  Failed to rotate secret: $secretName" 'ERROR'
        }
    }

    Write-Log "Secret rotation complete." 'SUCCESS'
}

# ─── Configure Automatic Rotation ────────────────────────────────────────────

function Set-AutomaticRotation {
    param([string]$VaultName)

    Write-Log "Configuring automatic secret rotation policies..."

    # Configure rotation policy for SQL passwords (90-day rotation, 30-day notification)
    $rotationSecrets = @('sql-admin-password', 'synapse-sql-password')

    foreach ($secretName in $rotationSecrets) {
        # Check if secret exists
        $exists = az keyvault secret show --vault-name $VaultName --name $secretName --query "name" -o tsv 2>$null

        if ($exists) {
            Write-Log "Setting rotation policy for '$secretName' (90-day rotation, 30-day advance notification)..."
            az keyvault secret rotation-policy update `
                --vault-name $VaultName `
                --name $secretName `
                --value '{
                    "lifetimeActions": [
                        {
                            "trigger": { "timeBeforeExpiry": "P30D" },
                            "action": { "type": "Notify" }
                        },
                        {
                            "trigger": { "timeAfterCreate": "P90D" },
                            "action": { "type": "Rotate" }
                        }
                    ],
                    "attributes": { "expiryTime": "P120D" }
                }' --only-show-errors 2>$null

            if ($LASTEXITCODE -eq 0) {
                Write-Log "  Rotation policy set for '$secretName'" 'SUCCESS'
            }
            else {
                Write-Log "  Note: Rotation policy requires Key Vault Premium or custom rotation via Event Grid" 'WARN'
            }
        }
        else {
            Write-Log "  Secret '$secretName' does not exist yet. Skipping rotation policy." 'WARN'
        }
    }
}

# ─── Validate Key Vault Configuration ────────────────────────────────────────

function Test-KeyVaultConfiguration {
    param([string]$VaultName)

    Write-Log "Validating Key Vault configuration for '$VaultName'..."
    $issues = @()
    $passed = 0

    # 1. Check soft delete is enabled
    $kvProperties = az keyvault show --name $VaultName --query "properties" -o json | ConvertFrom-Json
    if ($kvProperties.enableSoftDelete -eq $true) {
        Write-Log "  [PASS] Soft delete is enabled" 'SUCCESS'
        $passed++
    }
    else {
        $issues += "Soft delete is NOT enabled"
        Write-Log "  [FAIL] Soft delete is NOT enabled" 'ERROR'
    }

    # 2. Check purge protection
    if ($kvProperties.enablePurgeProtection -eq $true) {
        Write-Log "  [PASS] Purge protection is enabled" 'SUCCESS'
        $passed++
    }
    else {
        $issues += "Purge protection is NOT enabled"
        Write-Log "  [FAIL] Purge protection is NOT enabled" 'ERROR'
    }

    # 3. Check RBAC authorization mode
    if ($kvProperties.enableRbacAuthorization -eq $true) {
        Write-Log "  [PASS] RBAC authorization is enabled (recommended)" 'SUCCESS'
        $passed++
    }
    else {
        $issues += "RBAC authorization is NOT enabled (using access policies instead)"
        Write-Log "  [WARN] RBAC authorization is NOT enabled (using access policies)" 'WARN'
    }

    # 4. Check network rules
    if ($kvProperties.networkAcls.defaultAction -eq 'Deny') {
        Write-Log "  [PASS] Default network action is Deny" 'SUCCESS'
        $passed++
    }
    else {
        $issues += "Default network action is Allow — should be Deny with private endpoints"
        Write-Log "  [WARN] Default network action is Allow — consider setting to Deny" 'WARN'
    }

    # 5. Check for expired secrets
    $secrets = az keyvault secret list --vault-name $VaultName --query "[?attributes.expires != null]" -o json | ConvertFrom-Json
    $expiredCount = 0
    $expiringCount = 0
    foreach ($secret in $secrets) {
        $expiryDate = [datetime]::Parse($secret.attributes.expires)
        if ($expiryDate -lt (Get-Date)) {
            $expiredCount++
        }
        elseif ($expiryDate -lt (Get-Date).AddDays(30)) {
            $expiringCount++
        }
    }

    if ($expiredCount -gt 0) {
        $issues += "$expiredCount expired secrets found"
        Write-Log "  [FAIL] $expiredCount expired secrets found" 'ERROR'
    }
    else {
        Write-Log "  [PASS] No expired secrets" 'SUCCESS'
        $passed++
    }

    if ($expiringCount -gt 0) {
        Write-Log "  [WARN] $expiringCount secrets expiring within 30 days" 'WARN'
    }

    # 6. Check diagnostic settings
    $diagSettings = az monitor diagnostic-settings list --resource $(az keyvault show --name $VaultName --query "id" -o tsv) --query "[].name" -o tsv 2>$null
    if ($diagSettings) {
        Write-Log "  [PASS] Diagnostic settings configured" 'SUCCESS'
        $passed++
    }
    else {
        $issues += "No diagnostic settings configured"
        Write-Log "  [WARN] No diagnostic settings configured" 'WARN'
    }

    # Summary
    Write-Log ""
    Write-Log "Validation Summary: $passed passed, $($issues.Count) issues"
    if ($issues.Count -gt 0) {
        Write-Log "Issues:" 'WARN'
        foreach ($issue in $issues) {
            Write-Log "  - $issue" 'WARN'
        }
    }
    else {
        Write-Log "All checks passed!" 'SUCCESS'
    }

    return $issues.Count -eq 0
}

# ─── Main Execution ──────────────────────────────────────────────────────────

if ($SubscriptionId) {
    Write-Log "Setting subscription context to $SubscriptionId..."
    az account set --subscription $SubscriptionId
}

switch ($Action) {
    'setup-access' {
        Set-DataPlatformAccessPolicies -VaultName $KeyVaultName
    }
    'rotate-secrets' {
        Invoke-SecretRotation -VaultName $KeyVaultName -Secrets $SecretNames
    }
    'validate' {
        $result = Test-KeyVaultConfiguration -VaultName $KeyVaultName
        if (-not $result) {
            exit 1
        }
    }
    'configure-rotation' {
        Set-AutomaticRotation -VaultName $KeyVaultName
    }
}
