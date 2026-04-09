<#
.SYNOPSIS
    Registers Azure resource providers across subscriptions.

.DESCRIPTION
    Copies resource provider registrations from a source subscription to target
    subscriptions, or synchronizes registrations across all subscriptions.

.PARAMETER SourceSubscriptionId
    The subscription to read registered providers from.

.PARAMETER TargetSubscriptionId
    The subscription to register providers in. If not specified, registers across all subscriptions.

.PARAMETER SyncAll
    If specified, synchronizes all registered providers across ALL subscriptions.

.PARAMETER WhatIf
    Preview the registrations without executing them.

.EXAMPLE
    .\resourceProviders.ps1 -SourceSubscriptionId "xxx" -TargetSubscriptionId "yyy"

.EXAMPLE
    .\resourceProviders.ps1 -SyncAll -WhatIf
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(ParameterSetName = 'CopyProviders')]
    [ValidateNotNullOrEmpty()]
    [string]$SourceSubscriptionId,

    [Parameter(ParameterSetName = 'CopyProviders')]
    [ValidateNotNullOrEmpty()]
    [string]$TargetSubscriptionId,

    [Parameter(ParameterSetName = 'SyncAll')]
    [switch]$SyncAll
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

try {
    # Ensure connected
    $context = Get-AzContext
    if (-not $context) {
        Write-Host "No Azure context found. Please login first."
        Connect-AzAccount
    }

    if ($SyncAll) {
        # Sync registered providers across ALL subscriptions
        Write-Host "Gathering registered providers from all subscriptions..."

        $subscriptions = Get-AzSubscription
        $allProviders = [System.Collections.Generic.HashSet[string]]::new()

        foreach ($sub in $subscriptions) {
            Set-AzContext -SubscriptionId $sub.Id | Out-Null
            $registered = Get-AzResourceProvider |
                Where-Object { $_.RegistrationState -eq "Registered" } |
                Select-Object -ExpandProperty ProviderNamespace

            foreach ($provider in $registered) {
                [void]$allProviders.Add($provider)
            }
            Write-Host "  $($sub.Name): $($registered.Count) providers"
        }

        Write-Host "`nTotal unique providers: $($allProviders.Count)"

        # Register all providers in each subscription
        foreach ($sub in $subscriptions) {
            Set-AzContext -SubscriptionId $sub.Id | Out-Null
            $existing = Get-AzResourceProvider |
                Where-Object { $_.RegistrationState -eq "Registered" } |
                Select-Object -ExpandProperty ProviderNamespace

            $toRegister = $allProviders | Where-Object { $_ -notin $existing }

            if ($toRegister.Count -eq 0) {
                Write-Host "  $($sub.Name): All providers already registered"
                continue
            }

            Write-Host "  $($sub.Name): Registering $($toRegister.Count) providers..."
            foreach ($provider in $toRegister) {
                if ($PSCmdlet.ShouldProcess($provider, "Register in $($sub.Name)")) {
                    Register-AzResourceProvider -ProviderNamespace $provider | Out-Null
                    Write-Host "    Registered: $provider"
                }
            }
        }
    }
    else {
        # Copy providers from source to target
        if (-not $SourceSubscriptionId -or -not $TargetSubscriptionId) {
            throw "Both -SourceSubscriptionId and -TargetSubscriptionId are required when not using -SyncAll"
        }

        Write-Host "Reading registered providers from source: $SourceSubscriptionId"
        Set-AzContext -Subscription $SourceSubscriptionId | Out-Null

        $sourceProviders = Get-AzResourceProvider |
            Where-Object { $_.RegistrationState -eq "Registered" } |
            Select-Object -ExpandProperty ProviderNamespace

        Write-Host "Found $($sourceProviders.Count) registered providers"

        Write-Host "`nRegistering providers in target: $TargetSubscriptionId"
        Set-AzContext -Subscription $TargetSubscriptionId | Out-Null

        $existingProviders = Get-AzResourceProvider |
            Where-Object { $_.RegistrationState -eq "Registered" } |
            Select-Object -ExpandProperty ProviderNamespace

        $toRegister = $sourceProviders | Where-Object { $_ -notin $existingProviders }

        if ($toRegister.Count -eq 0) {
            Write-Host "All providers already registered in target subscription."
            return
        }

        Write-Host "Registering $($toRegister.Count) new providers..."
        foreach ($provider in $toRegister) {
            if ($PSCmdlet.ShouldProcess($provider, "Register in target subscription")) {
                Register-AzResourceProvider -ProviderNamespace $provider | Out-Null
                Write-Host "  Registered: $provider"
            }
        }
    }

    Write-Host "`nResource provider registration complete." -ForegroundColor Green
}
catch {
    Write-Error "Failed to register resource providers: $_"
    exit 1
}
