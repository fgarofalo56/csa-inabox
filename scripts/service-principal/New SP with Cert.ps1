<#
.SYNOPSIS
    Creates a service principal with a self-signed certificate and assigns RBAC roles.

.DESCRIPTION
    Generates a self-signed certificate, creates an Azure AD service principal,
    and assigns specified roles at resource group and/or subscription scope.
    Certificates are exported to a specified directory.

.PARAMETER ServicePrincipalName
    Display name for the service principal.

.PARAMETER CertName
    Name for the self-signed certificate.

.PARAMETER CertOutputPath
    Directory to export certificate files. Created if it doesn't exist.

.PARAMETER ResourceGroupName
    Resource group to assign Contributor role.

.PARAMETER Location
    Azure region for the resource group (if creating).

.PARAMETER RoleDefinitionName
    Role to assign at resource group scope. Default: Contributor.

.PARAMETER SubscriptionRole
    Role to assign at subscription scope. Default: Reader.

.EXAMPLE
    .\New-SP-with-Cert.ps1 -ServicePrincipalName "my-deploy-sp" `
        -CertName "my-cert" -CertOutputPath "C:\certs" `
        -ResourceGroupName "rg-dev"
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$ServicePrincipalName,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$CertName,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$CertOutputPath,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$ResourceGroupName,

    [string]$Location = "East US 2",

    [string]$RoleDefinitionName = "Contributor",

    [string]$SubscriptionRole = "Reader"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

try {
    # Ensure output directory exists
    if (-not (Test-Path $CertOutputPath)) {
        New-Item -ItemType Directory -Path $CertOutputPath -Force | Out-Null
    }

    $certExportPath = Join-Path $CertOutputPath $CertName

    # Generate self-signed certificate
    Write-Host "Generating self-signed certificate: $CertName"
    $cert = New-SelfSignedCertificate `
        -Subject "CN=$CertName" `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -KeyExportPolicy Exportable `
        -KeySpec Signature `
        -NotAfter (Get-Date).AddYears(2)

    # Export PFX (with private key)
    $certSecurePassword = Read-Host -Prompt "Enter certificate export password" -AsSecureString
    Export-PfxCertificate -Cert $cert -FilePath "$certExportPath.pfx" -Password $certSecurePassword | Out-Null
    Write-Host "  Exported PFX: $certExportPath.pfx"

    # Export CER (public key only)
    Export-Certificate -Cert $cert -FilePath "$certExportPath.cer" | Out-Null
    Write-Host "  Exported CER: $certExportPath.cer"

    # Read certificate bytes for SP creation
    $certBytes = [System.IO.File]::ReadAllBytes("$certExportPath.cer")
    $certBase64 = [System.Convert]::ToBase64String($certBytes)

    # Create service principal
    Write-Host "`nCreating service principal: $ServicePrincipalName"
    if ($PSCmdlet.ShouldProcess($ServicePrincipalName, "Create Service Principal")) {
        $sp = New-AzADServicePrincipal -DisplayName $ServicePrincipalName -CertValue $certBase64
        Write-Host "  App ID: $($sp.AppId)"
        Write-Host "  Object ID: $($sp.Id)"
    }

    # Create resource group if needed
    $existingRg = Get-AzResourceGroup -Name $ResourceGroupName -ErrorAction SilentlyContinue
    if (-not $existingRg) {
        Write-Host "`nCreating resource group: $ResourceGroupName in $Location"
        if ($PSCmdlet.ShouldProcess($ResourceGroupName, "Create Resource Group")) {
            New-AzResourceGroup -Name $ResourceGroupName -Location $Location | Out-Null
        }
    }

    # Assign resource group role
    $subId = (Get-AzContext).Subscription.Id
    $rgScope = "/subscriptions/$subId/resourceGroups/$ResourceGroupName"

    Write-Host "`nAssigning $RoleDefinitionName role at resource group scope"
    if ($PSCmdlet.ShouldProcess("$RoleDefinitionName on $ResourceGroupName", "Assign Role")) {
        New-AzRoleAssignment -ObjectId $sp.Id -RoleDefinitionName $RoleDefinitionName -Scope $rgScope | Out-Null
    }

    # Assign subscription role
    Write-Host "Assigning $SubscriptionRole role at subscription scope"
    if ($PSCmdlet.ShouldProcess("$SubscriptionRole on subscription", "Assign Role")) {
        New-AzRoleAssignment -ObjectId $sp.Id -RoleDefinitionName $SubscriptionRole -Scope "/subscriptions/$subId" | Out-Null
    }

    # Verify
    Write-Host "`nRole assignments for service principal:"
    Get-AzRoleAssignment -ObjectId $sp.Id | Format-Table RoleDefinitionName, Scope -AutoSize

    Write-Host "`nService principal created successfully." -ForegroundColor Green
    Write-Host "IMPORTANT: Store the certificate files securely. Consider importing into Azure Key Vault." -ForegroundColor Yellow
}
catch {
    Write-Error "Failed to create service principal: $_"
    exit 1
}
