<#
.SYNOPSIS
    Validates the repo's TypeScript with a type-only compile (tsc --noEmit).

.DESCRIPTION
    Exit codes (the convention shared by every gate in dev-loop/gates):
      0 - tsc compiled the project and reported no type errors
      1 - tsc reported type errors
      2 - COULD NOT RUN (node absent, TypeScript not installed, project or
          tsconfig missing). NOT a pass - validate-all.ps1 renders this as
          [NOT VERIFIED].

    WHY THIS GATE EXISTS
    dev-loop/gates had NO TypeScript leg at all. apps/fiab-console is the
    largest surface in the repo and the one every UI die-hard rule governs, and
    no gate here mentioned it - so a console-only change matched zero gates and
    `make validate` returned having measured nothing. See #3811.

    NOTE ON SCOPE - read this before quoting a pass. This gate runs
    `tsc --noEmit` against tsconfig.build.json and NOTHING ELSE. It does not run
    `next build`, eslint, vitest, or the console's own guards
    (no-bare-server-fetch.mjs, check-circular-deps.mjs). Those run in the
    fiab-console-ci workflow, which remains the full console gate. A pass here
    means "the types compile", not "the console is verified".

    THIS GATE NEVER INSTALLS ANYTHING. `pnpm install` inside a git worktree is
    destructive in this repo - the console's node_modules is a junction shared
    with the main checkout, and removing it there destroys the main checkout's
    modules. A missing toolchain is therefore reported as COULD NOT RUN with the
    exact command to fix it, and is never silently repaired.

    LOCAL VERIFIABILITY
    LOOM_TSC_BIN overrides the compiler entry point (a .js file run with node),
    matching the LOOM_AZ_BIN pattern the scripts/ci helpers already use. It
    exists so this gate can be executed - and mutation-tested - somewhere other
    than the job it gates, which is the defect shape recorded in #3704. When the
    override is used the gate SAYS SO on stdout, so an override can never sit
    silently underneath a green receipt.

.PARAMETER ProjectDir
    Repo-relative directory holding the tsconfig. Defaults to the console.
    Parameterised so the gate's own self-test can point it at a fixture whose
    verdict is known in advance (gate-selftest.ps1).
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$RepoRoot,
    [string]$ProjectDir = "apps/fiab-console",
    [string]$TsConfig = "tsconfig.build.json"
)

# Resolved in the BODY, not in the param default: under Windows PowerShell 5.1
# $PSScriptRoot is empty inside a param default when the script carries
# [CmdletBinding()] AND is invoked with `powershell.exe -File`. Same reason as
# every sibling gate. See #3811.
if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}

$ErrorActionPreference = 'Continue'

# An absolute -ProjectDir is honoured as-is. Join-Path would otherwise glue a
# rooted path onto the repo root and produce nonsense ("C:\repo\D:\tmp\x"),
# and the self-test needs to point this gate at a generated fixture outside the
# working tree without writing anything into the repo to do it.
if ([System.IO.Path]::IsPathRooted($ProjectDir)) {
    $projectPath = $ProjectDir
} else {
    $projectPath = Join-Path $RepoRoot $ProjectDir
}
$tsConfigPath = Join-Path $projectPath $TsConfig

# -WhatIf is HONOURED, not merely tolerated - apps/copilot/tools/readonly.py
# builds `-File <gate>.ps1 -WhatIf` for every gate on its dry-run allowlist.
# A dry run measures NOTHING, so it exits 2 (COULD NOT RUN), never 0.
if ($WhatIfPreference) {
    Write-Host "=== TypeScript Validation Gate (-WhatIf) ===" -ForegroundColor Cyan
    Write-Host "  Would run: tsc --noEmit --project $tsConfigPath"
    Write-Host "  Nothing was compiled and nothing was measured. This is NOT a pass." -ForegroundColor Yellow
    exit 2
}

Write-Host "=== TypeScript Validation Gate ===" -ForegroundColor Cyan
Write-Host "  Project:  $projectPath"
Write-Host "  tsconfig: $TsConfig"

if (-not (Test-Path $projectPath)) {
    Write-Host "Project directory not found: $projectPath - CANNOT VALIDATE." -ForegroundColor Yellow
    Write-Host "  Reporting NOT VERIFIED, not a pass." -ForegroundColor Yellow
    exit 2
}

if (-not (Test-Path $tsConfigPath)) {
    Write-Host "tsconfig not found: $tsConfigPath - CANNOT VALIDATE." -ForegroundColor Yellow
    Write-Host "  Reporting NOT VERIFIED, not a pass." -ForegroundColor Yellow
    exit 2
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "node not found on PATH - CANNOT VALIDATE." -ForegroundColor Yellow
    Write-Host "  Install Node.js 20+ and re-run." -ForegroundColor Yellow
    Write-Host "  Reporting NOT VERIFIED, not a pass." -ForegroundColor Yellow
    exit 2
}

# ---------------------------------------------------------------------------
# Resolve the TypeScript compiler entry point.
#
# Deliberately NOT `Get-Command tsc`: a globally-installed tsc would compile the
# project against a DIFFERENT compiler version than the one the console pins and
# CI uses, and a version skew that changes the verdict is precisely the kind of
# thing a gate must not do quietly. Only the workspace's own TypeScript, or an
# explicit LOOM_TSC_BIN, is accepted.
# ---------------------------------------------------------------------------
$tscEntry = $null
$tscSource = $null

if ($env:LOOM_TSC_BIN) {
    if (Test-Path $env:LOOM_TSC_BIN) {
        $tscEntry = (Resolve-Path $env:LOOM_TSC_BIN).Path
        $tscSource = "LOOM_TSC_BIN override"
    } else {
        # An override that points at nothing is an ERROR, not a silent fallback.
        # Falling through to the workspace compiler here would mean the operator
        # believes they measured one thing while the gate measured another.
        Write-Host "LOOM_TSC_BIN is set to a path that does not exist:" -ForegroundColor Yellow
        Write-Host "  $($env:LOOM_TSC_BIN)" -ForegroundColor Yellow
        Write-Host "  Refusing to fall back to the workspace compiler - the override was explicit." -ForegroundColor Yellow
        Write-Host "  Reporting NOT VERIFIED, not a pass." -ForegroundColor Yellow
        exit 2
    }
}

if (-not $tscEntry) {
    # Walk from the project directory up to the repo root. pnpm workspaces may
    # hoist typescript to the root rather than the package.
    $searchDir = $projectPath
    $rootFull = (Resolve-Path $RepoRoot).Path
    while ($searchDir) {
        $candidate = Join-Path $searchDir "node_modules/typescript/bin/tsc"
        if (Test-Path $candidate) {
            $tscEntry = (Resolve-Path $candidate).Path
            $tscSource = "workspace ($searchDir)"
            break
        }
        $parent = Split-Path -Parent $searchDir
        if (-not $parent -or $parent -eq $searchDir) { break }
        # Stop at the repo root; do not wander into the parent filesystem.
        if ((Resolve-Path $searchDir).Path -eq $rootFull) { break }
        $searchDir = $parent
    }
}

if (-not $tscEntry) {
    Write-Host "TypeScript compiler not found - CANNOT VALIDATE." -ForegroundColor Yellow
    Write-Host "  Looked for node_modules/typescript/bin/tsc from $projectPath up to $RepoRoot." -ForegroundColor Yellow
    Write-Host "  Install the console's dependencies in the MAIN checkout:" -ForegroundColor Yellow
    Write-Host "    pnpm --dir apps/fiab-console install" -ForegroundColor Yellow
    Write-Host "  Do NOT run pnpm install from a git worktree: the console's node_modules" -ForegroundColor Yellow
    Write-Host "  is a junction shared with the main checkout and removing it there" -ForegroundColor Yellow
    Write-Host "  destroys the main checkout's modules." -ForegroundColor Yellow
    Write-Host "  Or set LOOM_TSC_BIN to a typescript/bin/tsc entry point." -ForegroundColor Yellow
    Write-Host "  Reporting NOT VERIFIED, not a pass." -ForegroundColor Yellow
    exit 2
}

Write-Host "  compiler: $tscEntry"
Write-Host "  resolved: $tscSource"
Write-Host ""
Write-Host "Running tsc --noEmit..."

# --incremental false is explicit: a gate must not return a verdict computed
# from a cached .tsbuildinfo it did not verify, and non-incremental keeps the
# run from writing build artifacts into the tree it is only meant to read.
# --pretty false keeps the output greppable and free of ANSI escapes.
$LASTEXITCODE = $null
$tscOutput = & $nodeCmd.Source $tscEntry --noEmit --pretty false --incremental false --project $tsConfigPath 2>&1
$tscExit = $LASTEXITCODE

foreach ($line in $tscOutput) {
    Write-Host "  $line"
}

# $LASTEXITCODE is not written when the call itself could not be made, and would
# otherwise retain a stale value from earlier in the session. Reset above, so
# $null here means "the compiler was never actually invoked" - which is NOT RUN,
# not a pass. This is the same trap that made three sibling gates print [PASS]
# over a lint that never ran. See #3811.
if ($null -eq $tscExit) {
    Write-Host "tsc could not be invoked - CANNOT VALIDATE." -ForegroundColor Yellow
    Write-Host "  Reporting NOT VERIFIED, not a pass." -ForegroundColor Yellow
    exit 2
}

$errorCount = @($tscOutput | Where-Object { $_ -match 'error TS\d+' }).Count

if ($tscExit -eq 0) {
    Write-Host ""
    Write-Host "=== TYPESCRIPT TYPECHECK PASSED ===" -ForegroundColor Green
    Write-Host "  (typecheck only - next build, eslint and vitest are NOT covered here)" -ForegroundColor DarkGray
    exit 0
}

Write-Host ""
Write-Host "=== TYPESCRIPT TYPECHECK FAILED ===" -ForegroundColor Red
Write-Host "  tsc exit $tscExit, $errorCount type error(s)." -ForegroundColor Red
exit 1
