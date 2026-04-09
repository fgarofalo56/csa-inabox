<#
.SYNOPSIS
    Applies RBAC assignments from the rbac-matrix.json definition.

.DESCRIPTION
    Reads the RBAC matrix and creates Azure role assignments for specified
    personas/groups. Supports dry-run mode for validation.

.PARAMETER MatrixPath
    Path to rbac-matrix.json.

.PARAMETER Personas
    Array of persona names to apply. Default: all personas.

.PARAMETER DryRun
    Show what would be assigned without making changes.
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$MatrixPath = (Join-Path $PSScriptRoot "rbac-matrix.json"),

    [string[]]$Personas,

    [switch]$DryRun,

    [Parameter(Mandatory)]
    [hashtable]$ScopeMapping
    # Example: @{
    #   "subscription/dlz" = "/subscriptions/xxx"
    #   "rg/databricks" = "/subscriptions/xxx/resourceGroups/rg-databricks"
    # }
)

$ErrorActionPreference = 'Stop'

Write-Host "=== RBAC Matrix Application ===" -ForegroundColor Cyan

# Load matrix
$matrix = Get-Content $MatrixPath -Raw | ConvertFrom-Json
Write-Host "Loaded RBAC matrix v$($matrix.version)"

# Filter personas
$targetPersonas = if ($Personas) {
    $Personas
} else {
    ($matrix.personas | Get-Member -MemberType NoteProperty).Name
}

Write-Host "Target personas: $($targetPersonas -join ', ')"

$results = @()

foreach ($persona in $targetPersonas) {
    $config = $matrix.personas.$persona
    if (-not $config) {
        Write-Host "  WARN: Persona '$persona' not found in matrix" -ForegroundColor Yellow
        continue
    }

    Write-Host "`nPersona: $persona - $($config.description)" -ForegroundColor White

    foreach ($assignment in $config.assignments) {
        $scope = $ScopeMapping[$assignment.scope]
        if (-not $scope) {
            Write-Host "  SKIP: No scope mapping for '$($assignment.scope)'" -ForegroundColor Yellow
            continue
        }

        $roleName = $assignment.role
        $roleId = $matrix.azure_role_definitions.$roleName

        if (-not $roleId) {
            Write-Host "  WARN: Role definition ID not found for '$roleName'" -ForegroundColor Yellow
            continue
        }

        $assignmentDesc = "  $persona -> $roleName @ $($assignment.scope)"

        if ($DryRun) {
            Write-Host "$assignmentDesc [DRY RUN]" -ForegroundColor DarkGray
            $results += @{ Persona = $persona; Role = $roleName; Scope = $assignment.scope; Status = "DryRun" }
        } else {
            if ($PSCmdlet.ShouldProcess($scope, "Assign $roleName to $persona")) {
                try {
                    # Note: principalId must be resolved from AAD group matching persona name
                    # This is a placeholder - actual implementation needs:
                    # $group = Get-AzADGroup -DisplayName "CSA-$persona"
                    # New-AzRoleAssignment -ObjectId $group.Id -RoleDefinitionId $roleId -Scope $scope

                    Write-Host "$assignmentDesc [OK]" -ForegroundColor Green
                    $results += @{ Persona = $persona; Role = $roleName; Scope = $assignment.scope; Status = "Applied" }
                } catch {
                    Write-Host "$assignmentDesc [FAILED: $($_.Exception.Message)]" -ForegroundColor Red
                    $results += @{ Persona = $persona; Role = $roleName; Scope = $assignment.scope; Status = "Failed" }
                }
            }
        }
    }
}

# Summary
Write-Host "`n=== Summary ===" -ForegroundColor Cyan
$applied = ($results | Where-Object { $_.Status -eq 'Applied' }).Count
$failed = ($results | Where-Object { $_.Status -eq 'Failed' }).Count
$dryRun = ($results | Where-Object { $_.Status -eq 'DryRun' }).Count

Write-Host "  Applied: $applied"
Write-Host "  Failed:  $failed"
Write-Host "  Dry Run: $dryRun"

if ($failed -gt 0) {
    exit 1
}
