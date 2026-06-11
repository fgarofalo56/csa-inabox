using namespace System.Net

# SCC labels sidecar — single HTTP handler that performs sensitivity-label and
# label-policy CRUD via Security & Compliance PowerShell. This is the ONLY way
# to create/edit/delete labels + policies (Microsoft Graph has no write API),
# so the CSA Loom Console proxies these calls here with a Functions host key.
#
# Auth to SCC: certificate-based app-only (unattended). The app holds the Graph
# app-role Exchange.ManageAsApp + the Entra directory role Compliance
# Administrator. The cert is loaded into the worker via WEBSITE_LOAD_CERTIFICATES
# (thumbprint in SCC_CERT_THUMBPRINT) and selected from the CurrentUser\My store.
#
# Env (set on the Function app by scc-labels-function.bicep + bootstrap):
#   SCC_APP_ID            — Entra app (client) id of the SCC sidecar app
#   SCC_CERT_THUMBPRINT   — thumbprint of the auth cert (also in WEBSITE_LOAD_CERTIFICATES)
#   SCC_ORGANIZATION      — tenant onmicrosoft.com domain (e.g. contoso.onmicrosoft.com)
#   SCC_CONNECTION_URI    — optional SCC PSWS endpoint override for sovereign clouds
#                           (Commercial default; GCC-High/DoD/Gov use their own host)
#
# Request body (JSON):
#   { "action": "list-policies" | "create-label" | "update-label" | "delete-label"
#               | "create-policy" | "update-policy" | "delete-policy",
#     "id": "<label/policy guid>",         # update/delete
#     "label":  { displayName, tooltip, comment, color, parentId, encryptionEnabled },
#     "policy": { name, comment, labels[], exchangeLocation[], sharePointLocation[], mandatory, defaultLabelId } }
#
# Response: { "ok": true, "data": <result> } | { "ok": false, "error": "<msg>" }

param($Request, $TriggerMetadata)

function Send-Json([int]$Status, $Payload) {
    Push-OutputBinding -Name Response -Value ([HttpResponseContext]@{
        StatusCode  = $Status
        Headers     = @{ 'Content-Type' = 'application/json' }
        Body        = ($Payload | ConvertTo-Json -Depth 8 -Compress)
    })
}

$ErrorActionPreference = 'Stop'

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

        'list-policies' {
            $rows = Get-LabelPolicy -ErrorAction Stop | ForEach-Object {
                @{
                    id           = [string]$_.Guid
                    name         = [string]$_.Name
                    displayName  = [string]$_.Name
                    description  = [string]$_.Comment
                    isMandatory  = [bool]$_.Mandatory
                    defaultLabelId = [string]$_.DefaultLabel
                    enabled      = [bool]$_.Enabled
                    labels       = @($_.Labels)
                    scopes       = @($_.Settings | Where-Object { $_ -like '*scope*' })
                }
            }
            Send-Json 200 @{ ok = $true; data = @($rows) }
        }

        'create-label' {
            $l = $body.label
            if (-not $l.displayName) { Send-Json 400 @{ ok = $false; error = 'label.displayName is required' }; return }
            $args = @{
                Name        = ([string]$l.displayName)
                DisplayName = ([string]$l.displayName)
                ErrorAction = 'Stop'
            }
            if ($l.tooltip) { $args['Tooltip'] = [string]$l.tooltip }
            if ($l.comment) { $args['Comment'] = [string]$l.comment }
            if ($l.parentId) { $args['ParentId'] = [string]$l.parentId }
            if ($l.encryptionEnabled -eq $true) { $args['EncryptionEnabled'] = $true }
            $created = New-Label @args
            if ($l.color) { Set-Label -Identity $created.Guid -AdvancedSettings @{ color = ([string]$l.color) } -ErrorAction Stop | Out-Null }
            Send-Json 200 @{ ok = $true; data = @{ id = [string]$created.Guid; raw = @{ name = [string]$created.Name } } }
        }

        'update-label' {
            if (-not $body.id) { Send-Json 400 @{ ok = $false; error = 'id is required' }; return }
            $l = $body.label
            $args = @{ Identity = ([string]$body.id); ErrorAction = 'Stop' }
            if ($l.displayName) { $args['DisplayName'] = [string]$l.displayName }
            if ($l.tooltip) { $args['Tooltip'] = [string]$l.tooltip }
            if ($l.comment) { $args['Comment'] = [string]$l.comment }
            if ($null -ne $l.encryptionEnabled) { $args['EncryptionEnabled'] = [bool]$l.encryptionEnabled }
            Set-Label @args | Out-Null
            if ($l.color) { Set-Label -Identity ([string]$body.id) -AdvancedSettings @{ color = ([string]$l.color) } -ErrorAction Stop | Out-Null }
            Send-Json 200 @{ ok = $true; data = @{ id = [string]$body.id } }
        }

        'delete-label' {
            if (-not $body.id) { Send-Json 400 @{ ok = $false; error = 'id is required' }; return }
            Remove-Label -Identity ([string]$body.id) -Confirm:$false -ErrorAction Stop
            Send-Json 200 @{ ok = $true; data = @{ id = [string]$body.id } }
        }

        'create-policy' {
            $p = $body.policy
            if (-not $p.name) { Send-Json 400 @{ ok = $false; error = 'policy.name is required' }; return }
            $labels = @($p.labels)
            if ($labels.Count -eq 0) { Send-Json 400 @{ ok = $false; error = 'a policy must publish at least one label' }; return }
            $args = @{ Name = ([string]$p.name); Labels = $labels; ErrorAction = 'Stop' }
            if ($p.comment) { $args['Comment'] = [string]$p.comment }
            if ($p.exchangeLocation) { $args['ExchangeLocation'] = @($p.exchangeLocation) }
            if ($p.sharePointLocation) { $args['SharePointLocation'] = @($p.sharePointLocation) }
            $created = New-LabelPolicy @args
            $adv = @{}
            if ($p.mandatory -eq $true) { $adv['mandatory'] = 'true' }
            if ($p.defaultLabelId) { $adv['defaultlabelid'] = [string]$p.defaultLabelId }
            if ($adv.Count -gt 0) { Set-LabelPolicy -Identity $created.Guid -AdvancedSettings $adv -ErrorAction Stop | Out-Null }
            Send-Json 200 @{ ok = $true; data = @{ id = [string]$created.Guid; raw = @{ name = [string]$created.Name } } }
        }

        'update-policy' {
            if (-not $body.id) { Send-Json 400 @{ ok = $false; error = 'id is required' }; return }
            $p = $body.policy
            $args = @{ Identity = ([string]$body.id); ErrorAction = 'Stop' }
            if ($p.comment) { $args['Comment'] = [string]$p.comment }
            if ($p.labels) { $args['Labels'] = @($p.labels) }
            if ($p.exchangeLocation) { $args['AddExchangeLocation'] = @($p.exchangeLocation) }
            if ($p.sharePointLocation) { $args['AddSharePointLocation'] = @($p.sharePointLocation) }
            $adv = @{}
            if ($null -ne $p.mandatory) { $adv['mandatory'] = ([bool]$p.mandatory).ToString().ToLower() }
            if ($p.defaultLabelId) { $adv['defaultlabelid'] = [string]$p.defaultLabelId }
            if ($adv.Count -gt 0) { $args['AdvancedSettings'] = $adv }
            Set-LabelPolicy @args | Out-Null
            Send-Json 200 @{ ok = $true; data = @{ id = [string]$body.id } }
        }

        'delete-policy' {
            if (-not $body.id) { Send-Json 400 @{ ok = $false; error = 'id is required' }; return }
            Remove-LabelPolicy -Identity ([string]$body.id) -Confirm:$false -ErrorAction Stop
            Send-Json 200 @{ ok = $true; data = @{ id = [string]$body.id } }
        }

        default {
            Send-Json 400 @{ ok = $false; error = "unknown action '$action'" }
        }
    }
} catch {
    Send-Json 502 @{ ok = $false; error = "SCC cmdlet failed: $($_.Exception.Message)" }
} finally {
    try { Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue } catch {}
}
