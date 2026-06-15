using namespace System.Net

# DLP compliance-policy sidecar — a second HTTP handler in the SCC PowerShell
# Function app that performs Data Loss Prevention POLICY + RULE CRUD via
# Security & Compliance PowerShell (Connect-IPPSSession). This is the ONLY
# Microsoft-supported management surface for DLP policies — Microsoft Graph has
# NO create/edit/delete API for DLP (the /beta informationProtection/
# dataLossPreventionPolicies segment is read-only and preview-gated), so the
# CSA Loom Console proxies authoring here with a Functions host key.
#
# Reuses the SAME app identity + auth cert as labels/run.ps1: the app holds the
# Graph app-role Exchange.ManageAsApp + the Entra directory role Compliance
# Administrator — exactly the rights Get/New/Set/Remove-DlpCompliancePolicy and
# the *-DlpComplianceRule cmdlets require. No new credential.
#
# Env (set on the Function app by scc-labels-function.bicep + bootstrap):
#   SCC_APP_ID            — Entra app (client) id of the SCC sidecar app
#   SCC_CERT_THUMBPRINT   — thumbprint of the auth cert (also in WEBSITE_LOAD_CERTIFICATES)
#   SCC_ORGANIZATION      — tenant onmicrosoft.com domain (Connect-IPPSSession -Organization)
#   SCC_CONNECTION_URI    — optional SCC PSWS endpoint override for sovereign clouds
#
# Request body (JSON):
#   { "action": "list" | "get" | "create" | "update" | "delete",
#     "id": "<policy name or guid>",            # get/update/delete
#     "policy": {
#        name, comment, mode,                   # mode: Enable|TestWithNotifications|TestWithoutNotifications|Disable
#        exchange, sharePoint, oneDrive, teams,  # bool — include this workload ('All') in scope
#        rule: {                                # initial/updated rule (a policy is inert without one)
#           name, sensitiveTypes[], blockAccess, generateAlert, notifyUser
#        }
#     } }
#
# Sensitive info types map 1:1 to New-DlpComplianceRule
# -ContentContainsSensitiveInformation @{ Name = '<SIT>' } (the guided form sends
# Microsoft built-in SIT display names; no freeform JSON rule authoring is exposed).
#
# Response: { "ok": true, "data": <result> } | { "ok": false, "error": "<msg>" }

param($Request, $TriggerMetadata)

function Send-Json([int]$Status, $Payload) {
    Push-OutputBinding -Name Response -Value ([HttpResponseContext]@{
        StatusCode  = $Status
        Headers     = @{ 'Content-Type' = 'application/json' }
        Body        = ($Payload | ConvertTo-Json -Depth 10 -Compress)
    })
}

$ErrorActionPreference = 'Stop'

function ConvertTo-StringArray($value) {
    if ($null -eq $value) { return @() }
    return @($value | ForEach-Object { [string]$_ } | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() })
}

# Map a live DLP compliance policy (+ its rules) to the JSON shape the Console renders.
function ConvertTo-PolicyView($p) {
    $rules = @()
    try {
        $rules = @(Get-DlpComplianceRule -Policy ([string]$p.Name) -ErrorAction SilentlyContinue | ForEach-Object {
            @{
                id            = [string]$_.Guid
                name          = [string]$_.Name
                priority      = [int]$_.Priority
                blockAccess   = [bool]$_.BlockAccess
                generateAlert = ($null -ne $_.GenerateAlert)
                disabled      = [bool]$_.Disabled
                sensitiveTypes = @(if ($_.ContentContainsSensitiveInformation) { $_.ContentContainsSensitiveInformation | ForEach-Object { [string]$_.Name } | Where-Object { $_ } })
            }
        })
    } catch { $rules = @() }
    return @{
        id          = [string]$p.Guid
        name        = [string]$p.Name
        displayName = [string]$p.Name
        comment     = [string]$p.Comment
        mode        = [string]$p.Mode
        enabled     = [bool]$p.Enabled
        workload    = [string]$p.Workload
        locations   = @(
            $(if (ConvertTo-StringArray $p.ExchangeLocation)   { 'Exchange' })
            $(if (ConvertTo-StringArray $p.SharePointLocation) { 'SharePoint' })
            $(if (ConvertTo-StringArray $p.OneDriveLocation)   { 'OneDrive' })
            $(if (ConvertTo-StringArray $p.TeamsLocation)      { 'Teams' })
        ) | Where-Object { $_ }
        ruleCount   = $rules.Count
        rules       = $rules
    }
}

# Apply the guided rule form to a New-/Set-DlpComplianceRule argument set.
function Add-RuleArgs([hashtable]$args, $rule) {
    $sits = ConvertTo-StringArray $rule.sensitiveTypes
    if ($sits.Count -gt 0) {
        $args['ContentContainsSensitiveInformation'] = @($sits | ForEach-Object { @{ Name = $_ } })
    }
    if ($rule.blockAccess -eq $true)   { $args['BlockAccess']   = $true }
    if ($rule.generateAlert -eq $true) { $args['GenerateAlert'] = $true }
    $notify = ConvertTo-StringArray $rule.notifyUser
    if ($notify.Count -gt 0) { $args['NotifyUser'] = $notify }
}

# --- Validate sidecar configuration ----------------------------------------
$appId       = $env:SCC_APP_ID
$thumbprint  = $env:SCC_CERT_THUMBPRINT
$org         = $env:SCC_ORGANIZATION
$connectionUri = $env:SCC_CONNECTION_URI

if (-not $appId -or -not $thumbprint -or -not $org) {
    Send-Json 503 @{ ok = $false; error = 'SCC sidecar not configured: set SCC_APP_ID, SCC_CERT_THUMBPRINT and SCC_ORGANIZATION on the Function app.' }
    return
}

$body = $Request.Body
if ($body -is [string]) {
    try { $body = $body | ConvertFrom-Json } catch { Send-Json 400 @{ ok = $false; error = 'invalid JSON body' }; return }
}
$action = [string]$body.action
if (-not $action) { Send-Json 400 @{ ok = $false; error = 'action is required' }; return }

# --- Connect to Security & Compliance PowerShell ---------------------------
try {
    $cert = Get-ChildItem -Path "Cert:\CurrentUser\My\$thumbprint" -ErrorAction SilentlyContinue
    if (-not $cert) { $cert = Get-ChildItem -Path "Cert:\LocalMachine\My\$thumbprint" -ErrorAction SilentlyContinue }
    if (-not $cert) { throw "Auth certificate with thumbprint $thumbprint not found in the worker certificate store (check WEBSITE_LOAD_CERTIFICATES)." }

    $connectArgs = @{
        AppId        = $appId
        Certificate  = $cert
        Organization = $org
        ShowBanner   = $false
        ErrorAction  = 'Stop'
    }
    if ($connectionUri) { $connectArgs['ConnectionUri'] = $connectionUri }
    Connect-IPPSSession @connectArgs
} catch {
    Send-Json 502 @{ ok = $false; error = "Connect-IPPSSession failed: $($_.Exception.Message)" }
    return
}

# --- Dispatch ---------------------------------------------------------------
try {
    switch ($action) {

        'list' {
            $rows = @(Get-DlpCompliancePolicy -ErrorAction Stop | ForEach-Object { ConvertTo-PolicyView $_ })
            Send-Json 200 @{ ok = $true; data = @($rows) }
        }

        'get' {
            if (-not $body.id) { Send-Json 400 @{ ok = $false; error = 'id is required' }; return }
            $p = Get-DlpCompliancePolicy -Identity ([string]$body.id) -ErrorAction Stop
            Send-Json 200 @{ ok = $true; data = (ConvertTo-PolicyView $p) }
        }

        'create' {
            $p = $body.policy
            if (-not $p.name) { Send-Json 400 @{ ok = $false; error = 'policy.name is required' }; return }
            $args = @{ Name = ([string]$p.name); ErrorAction = 'Stop' }
            if ($p.comment) { $args['Comment'] = [string]$p.comment }
            if ($p.mode)    { $args['Mode']    = [string]$p.mode }
            # Workload scope — include 'All' for each workload the operator selected.
            if ($p.exchange   -eq $true) { $args['ExchangeLocation']   = @('All') }
            if ($p.sharePoint -eq $true) { $args['SharePointLocation'] = @('All') }
            if ($p.oneDrive   -eq $true) { $args['OneDriveLocation']   = @('All') }
            if ($p.teams      -eq $true) { $args['TeamsLocation']      = @('All') }
            $created = New-DlpCompliancePolicy @args
            # A DLP policy is inert without a rule — create the guided rule now.
            if ($p.rule -and $p.rule.name) {
                $rargs = @{ Name = ([string]$p.rule.name); Policy = ([string]$p.name); ErrorAction = 'Stop' }
                Add-RuleArgs $rargs $p.rule
                New-DlpComplianceRule @rargs | Out-Null
            }
            Send-Json 200 @{ ok = $true; data = @{ id = [string]$created.Guid; name = [string]$created.Name } }
        }

        'update' {
            if (-not $body.id) { Send-Json 400 @{ ok = $false; error = 'id is required' }; return }
            $p = $body.policy
            $args = @{ Identity = ([string]$body.id); ErrorAction = 'Stop' }
            if ($null -ne $p.comment) { $args['Comment'] = [string]$p.comment }
            if ($p.mode) { $args['Mode'] = [string]$p.mode }
            # Set-DlpCompliancePolicy exposes Add*/Remove* for locations; turning a
            # workload on adds 'All', turning it off removes 'All'.
            if ($null -ne $p.exchange)   { if ($p.exchange   -eq $true) { $args['AddExchangeLocation']   = @('All') } else { $args['RemoveExchangeLocation']   = @('All') } }
            if ($null -ne $p.sharePoint) { if ($p.sharePoint -eq $true) { $args['AddSharePointLocation'] = @('All') } else { $args['RemoveSharePointLocation'] = @('All') } }
            if ($null -ne $p.oneDrive)   { if ($p.oneDrive   -eq $true) { $args['AddOneDriveLocation']   = @('All') } else { $args['RemoveOneDriveLocation']   = @('All') } }
            if ($null -ne $p.teams)      { if ($p.teams      -eq $true) { $args['AddTeamsLocation']      = @('All') } else { $args['RemoveTeamsLocation']      = @('All') } }
            Set-DlpCompliancePolicy @args | Out-Null
            # Optionally upsert the named rule on this policy.
            if ($p.rule -and $p.rule.name) {
                $existingRule = Get-DlpComplianceRule -Policy ([string]$body.id) -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq ([string]$p.rule.name) } | Select-Object -First 1
                if ($existingRule) {
                    $rargs = @{ Identity = ([string]$existingRule.Guid); ErrorAction = 'Stop' }
                    Add-RuleArgs $rargs $p.rule
                    Set-DlpComplianceRule @rargs | Out-Null
                } else {
                    $rargs = @{ Name = ([string]$p.rule.name); Policy = ([string]$body.id); ErrorAction = 'Stop' }
                    Add-RuleArgs $rargs $p.rule
                    New-DlpComplianceRule @rargs | Out-Null
                }
            }
            Send-Json 200 @{ ok = $true; data = @{ id = [string]$body.id } }
        }

        'delete' {
            if (-not $body.id) { Send-Json 400 @{ ok = $false; error = 'id is required' }; return }
            Remove-DlpCompliancePolicy -Identity ([string]$body.id) -Confirm:$false -ErrorAction Stop
            Send-Json 200 @{ ok = $true; data = @{ id = [string]$body.id } }
        }

        default {
            Send-Json 400 @{ ok = $false; error = "unknown action '$action'" }
        }
    }
} catch {
    Send-Json 502 @{ ok = $false; error = "DLP cmdlet failed: $($_.Exception.Message)" }
} finally {
    try { Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue } catch {}
}
