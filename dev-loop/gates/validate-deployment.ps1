<#
.SYNOPSIS
    Validates a deployment by running az deployment what-if.

.DESCRIPTION
    Runs what-if analysis for each landing zone to validate deployment templates
    against a target Azure subscription without making actual changes.

    Exit codes:
      0 - every landing zone was what-if'd, and every one succeeded
      1 - a what-if ran and failed
      2 - COULD NOT RUN. NO landing zone was actually validated: az is absent,
          there is no usable Azure session, a zone was skipped for a missing
          template/params file, a zone was skipped because the template needs a
          parameter this gate does not hold, or a what-if exceeded the gate's
          time budget. Also returned when only SOME zones were validated - a
          partial run is not a pass.

    All of the exit-2 cases previously returned 0 and printed
    "All deployment validations passed!", which is a pass claimed over zero
    zones. See #3811.

    This gate is bounded. It will not block `make validate` waiting on an az
    call that never returns - see the timeout block below.
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$RepoRoot,
    [string]$Environment = "dev",
    [string]$Location = "eastus",

    # Total wall-clock budget for every what-if this run performs. 0 means
    # "read it from dev-loop/config.yaml", which is the documented source.
    [int]$TimeoutSeconds = 0
)

# Under Windows PowerShell 5.1, $PSScriptRoot is EMPTY inside a param DEFAULT
# when the script carries [CmdletBinding()] and is invoked with
# `powershell.exe -File`. The old default
# `(Split-Path -Parent (Split-Path -Parent $PSScriptRoot))` therefore threw
# "Cannot bind argument to parameter 'Path' because it is an empty string"
# and the script died at parameter binding, before its first line of output.
#
# Measured across both hosts and four invocation modes (5.1.26100.9168 and
# pwsh 7.6.5; `&`, dot-source, -Command, -File). Exactly one cell is broken:
# 5.1 + -File. So `make validate` (pwsh -File, Makefile:107) was never
# affected, and neither was validate-all.ps1, which invokes each gate with
# `&`. The consumer that builds a -File argv and falls back to `powershell`
# when pwsh is absent is apps/copilot/tools/readonly.py:551-559.
#
# Bisected further: the same script with a bare param() and no
# [CmdletBinding()] resolves correctly even under 5.1 -File, so the attribute
# is what empties it. Resolving in the BODY works in every combination.
# See #3811.
if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}

$ErrorActionPreference = 'Continue'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# dev-loop/config.yaml declares `deployment: timeout_seconds: 600`. Nothing read
# it, so the value was decorative and an az what-if that never returned blocked
# `make validate` for as long as the operator was willing to wait. Windows
# PowerShell 5.1 has no ConvertFrom-Yaml, so the one block that matters is
# parsed by hand - the same approach validate-all.ps1 already uses for the gate
# names. Returns a count of SECONDS.
function Get-ConfiguredTimeout {
    param(
        [string]$ConfigPath,
        [string]$GateName
    )

    if (-not (Test-Path $ConfigPath)) { return $null }

    $inGates = $false
    $inGate = $false
    foreach ($line in (Get-Content $ConfigPath -Encoding UTF8)) {
        if ($line -match '^validation_gates:') { $inGates = $true; continue }
        if (-not $inGates) { continue }
        if ($line -match '^\S') { break }
        # The gate's own key must be tested BEFORE the generic "some other gate
        # starts here" reset, or the gate would reset itself on entry.
        if ($line -match ('^  ' + [regex]::Escape($GateName) + ':\s*$')) { $inGate = $true; continue }
        if ($line -match '^  [A-Za-z0-9_-]+:') { $inGate = $false; continue }
        if ($inGate -and $line -match '^\s+timeout_seconds:\s*(\d+)\s*$') { return [int]$Matches[1] }
    }
    return $null
}

# Every parameter a bicep template declares REQUIRED - `param <name> <type>`
# with no `= <default>` - tagged with whether it carries an @secure() decorator.
#
# Testing for `=` on the param line is exact rather than approximate: bicep puts
# the assignment operator on the declaration line even when the value spans
# lines, so `param x object = {` on one line and `}` on the next still shows the
# `=` here. A parameter this function calls required is one az will demand.
function Get-RequiredBicepParam {
    param([string]$TemplatePath)

    $required = @()
    $pendingSecure = $false

    foreach ($raw in (Get-Content $TemplatePath)) {
        $line = $raw.Trim()
        if ($line -eq '' -or $line.StartsWith('//')) { continue }

        if ($line -match '^@secure\s*\(') { $pendingSecure = $true; continue }
        # Any other decorator (@minLength, @description, ...) keeps a pending
        # @secure() alive - decorators stack above one declaration.
        if ($line.StartsWith('@')) { continue }

        if ($line -match '^param\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$') {
            $paramName = $Matches[1]
            $afterName = $Matches[2]
            if ($afterName -notmatch '=') {
                $required += [pscustomobject]@{ Name = $paramName; Secure = $pendingSecure }
            }
            $pendingSecure = $false
            continue
        }

        $pendingSecure = $false
    }

    return $required
}

# The parameter names an ARM params JSON file supplies. Returns $null - NOT an
# empty list - when the file cannot be read, so the caller can tell "supplies
# nothing" from "I could not find out", and say which.
function Get-SuppliedParamName {
    param([string]$ParamsPath)

    try {
        $doc = Get-Content $ParamsPath -Raw -ErrorAction Stop | ConvertFrom-Json
    } catch {
        return $null
    }
    if ($null -eq $doc -or $null -eq $doc.parameters) { return @() }
    return @($doc.parameters.PSObject.Properties.Name)
}

function ConvertTo-QuotedArgument {
    param([string]$Value)
    if ($Value -match '\s' -and -not $Value.StartsWith('"')) { return '"' + $Value + '"' }
    return $Value
}

# Did any zone end up in the named outcome class? The summary keys on the Class
# each branch recorded rather than on the prose of its Reason string, so
# rewording a message can never silently change which explanation is printed.
function Test-AnyResultClass {
    param(
        [object[]]$Results,
        [string]$ClassName
    )
    return (@($Results | Where-Object { $_.Class -eq $ClassName }).Count -gt 0)
}

# az.cmd is a shim that launches python; killing only the .cmd leaves the real
# what-if running and holding the console.
#
# Named with the Invoke- verb rather than Stop-: PSScriptAnalyzer requires any
# Stop-* function to implement ShouldProcess, and wiring ShouldProcess into this
# helper would make it a silent no-op under the -WhatIf this script now
# supports - while the timeout branch above still reported the process as
# terminated. A message that says "terminated" about a process still running is
# exactly the untrue error this gate exists to remove.
function Invoke-ProcessTreeKill {
    param([int]$ProcessId)

    if (Get-Command taskkill -ErrorAction SilentlyContinue) {
        # The result is deliberately not the source of truth here - the caller
        # re-checks whether the process actually exited and reports if it did
        # not, so a taskkill that silently failed cannot be mistaken for a kill.
        & taskkill /PID $ProcessId /T /F 2>&1 | Out-Null
        return
    }

    # Non-Windows / no taskkill: .NET can kill a tree from Core 3.0 onward.
    try {
        (Get-Process -Id $ProcessId -ErrorAction Stop).Kill($true)
        return
    } catch {
        Write-Host "  Tree kill via .NET failed: $($_.Exception.Message)" -ForegroundColor DarkGray
        Write-Host "  Falling back to killing only the parent process." -ForegroundColor DarkGray
    }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

# Runs a native command with a hard wall-clock bound and captures its output.
#
# stdin is redirected from an EMPTY file on purpose. az PROMPTS when a required
# parameter was not supplied ("Please provide object value for 'x' (? for
# help):"), and against an inherited console stdin that prompt blocks for as
# long as the console lives. With stdin already at EOF it cannot block. The
# timeout is the hard bound behind that, for every other reason az might not
# return.
function Invoke-BoundedProcess {
    param(
        [string]$FilePath,
        [string[]]$ArgumentList,
        [int]$TimeoutSeconds
    )

    $stamp = [guid]::NewGuid().ToString('N')
    $tmpDir = [System.IO.Path]::GetTempPath()
    $outFile = Join-Path $tmpDir "loom-gate-$stamp.out"
    $errFile = Join-Path $tmpDir "loom-gate-$stamp.err"
    $inFile = Join-Path $tmpDir "loom-gate-$stamp.in"

    $result = [pscustomobject]@{
        TimedOut     = $false
        ExitCode     = $null
        Output       = ''
        LaunchError  = $null
        SurvivedKill = $false
    }

    try {
        Set-Content -Path $inFile -Value ([string]::Empty) -NoNewline -Encoding ASCII -ErrorAction Stop

        $quoted = @($ArgumentList | ForEach-Object { ConvertTo-QuotedArgument $_ })
        $proc = Start-Process -FilePath $FilePath -ArgumentList $quoted -NoNewWindow -PassThru `
            -RedirectStandardOutput $outFile -RedirectStandardError $errFile `
            -RedirectStandardInput $inFile -ErrorAction Stop

        if ($proc.WaitForExit($TimeoutSeconds * 1000)) {
            # The parameterless overload waits for the redirected streams to
            # finish flushing; the timed one does not.
            $proc.WaitForExit()
            $result.ExitCode = $proc.ExitCode
        } else {
            $result.TimedOut = $true
            Invoke-ProcessTreeKill -ProcessId $proc.Id
            if (-not $proc.WaitForExit(10000)) { $result.SurvivedKill = $true }
        }
    } catch {
        $result.LaunchError = $_.Exception.Message
        return $result
    }

    $text = ''
    foreach ($f in @($outFile, $errFile)) {
        if (Test-Path $f) {
            $chunk = Get-Content $f -Raw -ErrorAction SilentlyContinue
            if ($chunk) { $text += $chunk }
        }
    }
    $result.Output = $text

    foreach ($f in @($outFile, $errFile, $inFile)) {
        Remove-Item $f -Force -ErrorAction SilentlyContinue
    }
    return $result
}

# ---------------------------------------------------------------------------
# Time budget
# ---------------------------------------------------------------------------
# Measured on this repo, signed in, with stdin already at /dev/null:
#
#   pwsh -File validate-deployment.ps1 -Environment dev
#       -> killed at 900s, RC=124, 5 lines of output, never past "Validating: DLZ"
#   az deployment sub what-if DLZ params.dev.json
#       -> killed at 420s, RC=124, 64,647 bytes of bicep linter warnings,
#          ZERO error lines, no result and not even a prompt
#
# config.yaml declared a 600s budget for this gate the whole time. Nothing read
# it. It is now enforced as a DEADLINE across the run rather than per zone,
# because config.yaml declares one value for the gate, not one per zone.
$configPath = Join-Path (Split-Path -Parent $PSScriptRoot) "config.yaml"
$timeoutSource = ''
if ($TimeoutSeconds -gt 0) {
    $timeoutSource = "-TimeoutSeconds argument"
} else {
    $fromConfig = Get-ConfiguredTimeout -ConfigPath $configPath -GateName 'deployment'
    if ($fromConfig) {
        $TimeoutSeconds = $fromConfig
        $timeoutSource = "dev-loop/config.yaml (validation_gates.deployment.timeout_seconds)"
    } else {
        $TimeoutSeconds = 600
        # Say what was actually established. "config.yaml says 600" would be a
        # claim this branch specifically failed to verify.
        $timeoutSource = "built-in default - no deployment.timeout_seconds was readable at $configPath"
    }
}
$gateDeadline = (Get-Date).AddSeconds($TimeoutSeconds)

Write-Host "=== Deployment Validation Gate ===" -ForegroundColor Cyan
Write-Host "Environment: $Environment"
Write-Host "Location: $Location"
Write-Host "Time budget: $TimeoutSeconds s total, from $timeoutSource"

$results = @()

# Landing zones to validate
$landingZones = @(
    @{
        Name   = "DLZ"
        Template = Join-Path $RepoRoot "deploy/bicep/DLZ/main.bicep"
        Params = Join-Path $RepoRoot "deploy/bicep/DLZ/params.$Environment.json"
    },
    @{
        Name   = "DMLZ"
        Template = Join-Path $RepoRoot "deploy/bicep/DMLZ/main.bicep"
        Params = Join-Path $RepoRoot "deploy/bicep/DMLZ/params.$Environment.json"
    }
)

# -WhatIf is HONOURED, not merely tolerated. apps/copilot/tools/readonly.py:551-559
# builds `-File <gate>.ps1 -WhatIf` for every gate on its dry-run allowlist, and
# no gate declared SupportsShouldProcess - so parameter binding failed and the
# tool returned RC=1 with EMPTY stdout on every host, for all five gates.
# Measured before this change:
#   [validate-deployment -WhatIf] RC=1 :: A parameter cannot be found that
#                                         matches parameter name 'WhatIf'.
# The $PSScriptRoot fix above could not help that consumer: the script never
# reached its body, on any host, in any mode. See #3811.
#
# A dry run measures NOTHING, so it exits 2 (COULD NOT RUN) rather than 0.
# It also does not touch az - not even `az account show`.
if ($WhatIfPreference) {
    Write-Host "  Would run 'az deployment sub what-if' for:" -ForegroundColor White
    foreach ($lz in $landingZones) {
        Write-Host "    $($lz.Name)"
        Write-Host "      template: $($lz.Template)  (exists: $(Test-Path $lz.Template))"
        Write-Host "      params:   $($lz.Params)  (exists: $(Test-Path $lz.Params))"
    }
    Write-Host "  az was NOT invoked. Nothing was validated and nothing was measured." -ForegroundColor Yellow
    Write-Host "  This is NOT a pass." -ForegroundColor Yellow
    exit 2
}

# Toolchain check FIRST. Previously the only check was
# `az account show 2>$null | ConvertFrom-Json`, which cannot tell "az is not
# installed" from "az is installed but nobody is signed in": with az absent,
# the CommandNotFoundException is non-terminating under 'Continue',
# $azAccount ends up $null, and the script printed "Not logged into Azure
# CLI" - asserting a cause it had not established. Errors must be true.
$azPath = Get-Command az -ErrorAction SilentlyContinue
if (-not $azPath) {
    Write-Host "az CLI not found in PATH - CANNOT VALIDATE." -ForegroundColor Yellow
    Write-Host "  Install the Azure CLI: https://aka.ms/installazurecli" -ForegroundColor Yellow
    Write-Host "  Reporting NOT VERIFIED, not a pass." -ForegroundColor Yellow
    exit 2
}

# ---------------------------------------------------------------------------
# Is there a usable Azure session?
# ---------------------------------------------------------------------------
# The streams are SPLIT here rather than merged. `az account show 2>&1` puts
# stderr records into the SAME object stream as stdout, and feeding that merged
# text to ConvertFrom-Json makes any single stderr line break the parse - at
# which point $azAccount is $null and the gate declares there is no session.
#
# az writes warnings to stderr routinely. Measured with two stubs identical
# except for one stderr line, both exiting 0:
#
#   variant=control  azExit=0  parsedAccount=True
#   variant=warn     azExit=0  parsedAccount=False
#     parseErr: Additional text encountered after finished reading JSON content
#
# End to end that was "Azure account: <name> | Validating: DLZ" versus "No
# usable Azure CLI session - CANNOT VALIDATE | GATE_EXITCODE=2" - on an az that
# exited 0 both times. A live "WARNING: A new Bicep release is available:
# v0.46.1" reproduces it. That message asserted a cause the code never
# established, which is the R7 defect this gate was written to remove.
#
# There are THREE states here, and they are now told apart:
#   az exited non-zero            -> genuinely no session; quote az's own stderr
#   az exited 0, output not JSON  -> say exactly that; do NOT claim "no session"
#   az exited 0, output parses    -> there is a session
$azRaw = az account show 2>&1
$azExit = $LASTEXITCODE
$azOut = (($azRaw | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) | Out-String)
$azErr = (($azRaw | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] }) | Out-String)

if ($azExit -ne 0) {
    Write-Host "No usable Azure CLI session - CANNOT VALIDATE." -ForegroundColor Yellow
    Write-Host "  'az account show' exited $azExit." -ForegroundColor Yellow
    if ($azErr.Trim()) {
        Write-Host "  It reported:" -ForegroundColor Yellow
        Write-Host "    $($azErr.Trim())" -ForegroundColor DarkGray
    } elseif ($azOut.Trim()) {
        Write-Host "  It printed:" -ForegroundColor Yellow
        Write-Host "    $($azOut.Trim())" -ForegroundColor DarkGray
    } else {
        Write-Host "  It printed nothing on either stream." -ForegroundColor DarkGray
    }
    Write-Host "  Run 'az login' to enable deployment validation." -ForegroundColor Yellow
    Write-Host "  Reporting NOT VERIFIED, not a pass." -ForegroundColor Yellow
    exit 2
}

$azAccount = $null
$azParseError = $null
try { $azAccount = $azOut | ConvertFrom-Json } catch { $azParseError = $_.Exception.Message }

if (-not $azAccount) {
    # NOT "no session". az exited 0, so az believes there is one. State only
    # what was established: its stdout did not parse.
    Write-Host "'az account show' exited 0 but its stdout was not JSON - CANNOT VALIDATE." -ForegroundColor Yellow
    Write-Host "  This is not a claim about your sign-in state; az reported success." -ForegroundColor Yellow
    if ($azParseError) { Write-Host "  Parser: $azParseError" -ForegroundColor DarkGray }
    Write-Host "  stdout was:" -ForegroundColor Yellow
    Write-Host "    $($azOut.Trim())" -ForegroundColor DarkGray
    if ($azErr.Trim()) {
        Write-Host "  stderr (shown for context; it is NOT parsed):" -ForegroundColor Yellow
        Write-Host "    $($azErr.Trim())" -ForegroundColor DarkGray
    }
    Write-Host "  Reporting NOT VERIFIED, not a pass." -ForegroundColor Yellow
    exit 2
}

Write-Host "Azure account: $($azAccount.name)"

foreach ($lz in $landingZones) {
    Write-Host "`nValidating: $($lz.Name)" -ForegroundColor White

    if (-not (Test-Path $lz.Template)) {
        Write-Host "  Template not found: $($lz.Template)" -ForegroundColor Yellow
        $results += @{ Zone = $lz.Name; Status = "SKIP"; Class = "NoTemplate"; Reason = "Template not found" }
        continue
    }

    if (-not (Test-Path $lz.Params)) {
        Write-Host "  Params not found: $($lz.Params)" -ForegroundColor Yellow
        $results += @{ Zone = $lz.Name; Status = "SKIP"; Class = "NoParams"; Reason = "Params not found" }
        continue
    }

    # -----------------------------------------------------------------------
    # Static pre-check: could az even run this?
    # -----------------------------------------------------------------------
    # Reading the template beats calling az, for two measured reasons.
    #
    # 1. az does NOT print "Missing input parameters" for these templates. It
    #    PROMPTS. Measured against DMLZ/params.dev.json, which omits the
    #    required `privateDNSZones`:
    #
    #        Please provide object value for 'privateDNSZones' (? for help):
    #        ERROR: EOF when reading a line
    #
    #    Against a console stdin that prompt blocks; against a closed stdin it
    #    becomes an EOF error that lands in the FAIL branch and reports a defect
    #    in a template az never evaluated. Either way the phrase the SKIP branch
    #    below matches on never appeared, so that branch was unreachable for
    #    BOTH landing zones - including the DLZ case its own comment described
    #    as "the normal state".
    #
    # 2. Reaching the prompt at all is expensive. DLZ's what-if was killed at
    #    420s having emitted 64,647 bytes of bicep linter warnings, zero error
    #    lines, and no result.
    #
    # So it is settled here, deterministically, in milliseconds, naming the
    # exact parameters - and az is never invoked on a call it must refuse.
    $requiredParams = @()
    $preCheckError = $null
    try {
        $requiredParams = @(Get-RequiredBicepParam -TemplatePath $lz.Template)
    } catch {
        $preCheckError = "could not read $($lz.Template): $($_.Exception.Message)"
    }

    $suppliedParams = $null
    if (-not $preCheckError) {
        $suppliedParams = Get-SuppliedParamName -ParamsPath $lz.Params
        if ($null -eq $suppliedParams) {
            $preCheckError = "$($lz.Params) is not readable as JSON"
        }
    }

    if ($preCheckError) {
        # Do not proceed and do not guess. An unbounded what-if launched on an
        # input this gate could not read is the hang it was just fixed for.
        Write-Host "  [SKIP] Could not pre-check required parameters: $preCheckError" -ForegroundColor Yellow
        Write-Host "  az was NOT invoked. Nothing was validated, and nothing is claimed about the template." -ForegroundColor DarkGray
        $results += @{ Zone = $lz.Name; Status = "SKIP"; Class = "PreCheckUnavailable"; Reason = "Pre-check unavailable: $preCheckError" }
        continue
    }

    $missingParams = @($requiredParams | Where-Object { $suppliedParams -notcontains $_.Name })
    if ($missingParams.Count -gt 0) {
        $secureMissing = @($missingParams | Where-Object { $_.Secure } | ForEach-Object { $_.Name })
        $plainMissing = @($missingParams | Where-Object { -not $_.Secure } | ForEach-Object { $_.Name })
        $allMissing = ($missingParams | ForEach-Object { $_.Name }) -join ', '

        Write-Host "  [SKIP] Required parameters not supplied: $allMissing" -ForegroundColor Yellow
        Write-Host "  az was NOT invoked - it would prompt for these and could not proceed." -ForegroundColor DarkGray
        if ($secureMissing.Count -gt 0) {
            Write-Host "    @secure(), correctly NOT committed: $($secureMissing -join ', ')" -ForegroundColor DarkGray
            Write-Host "    Supply them at call time to what-if this zone. This gate holds no secrets and will not." -ForegroundColor DarkGray
        }
        if ($plainMissing.Count -gt 0) {
            Write-Host "    NOT secret and genuinely absent from params.$Environment.json: $($plainMissing -join ', ')" -ForegroundColor DarkGray
            Write-Host "    That is a defect in that params file, not a secret-handling constraint." -ForegroundColor DarkGray
        }
        $results += @{
            Zone   = $lz.Name
            Status = "SKIP"
            Class  = "MissingRequiredParams"
            Reason = "Required parameters not supplied: $allMissing"
            Secure = $secureMissing
            Plain  = $plainMissing
        }
        continue
    }

    # -----------------------------------------------------------------------
    # Bounded what-if
    # -----------------------------------------------------------------------
    $remainingSeconds = [int][math]::Floor(($gateDeadline - (Get-Date)).TotalSeconds)
    if ($remainingSeconds -le 0) {
        Write-Host "  [SKIP] The gate's $TimeoutSeconds s budget was already spent before this zone started." -ForegroundColor Yellow
        Write-Host "  az was NOT invoked. Nothing was validated." -ForegroundColor DarkGray
        $results += @{ Zone = $lz.Name; Status = "SKIP"; Class = "BudgetExhausted"; Reason = "Time budget exhausted before this zone ran" }
        continue
    }

    $azArgs = @(
        'deployment', 'sub', 'what-if',
        '--location', $Location,
        '--template-file', $lz.Template,
        '--parameters', $lz.Params,
        '--no-pretty-print'
    )

    $run = Invoke-BoundedProcess -FilePath $azPath.Source -ArgumentList $azArgs -TimeoutSeconds $remainingSeconds
    $outText = $run.Output

    if ($run.LaunchError) {
        Write-Host "  [SKIP] az could not be started: $($run.LaunchError)" -ForegroundColor Yellow
        Write-Host "  Nothing was validated. This says nothing about the template." -ForegroundColor DarkGray
        $results += @{ Zone = $lz.Name; Status = "SKIP"; Class = "LaunchFailed"; Reason = "az could not be started: $($run.LaunchError)" }
        continue
    }

    if ($run.TimedOut) {
        # NOT a failure. The gate established nothing about this template - it
        # ran out of time. Calling it FAIL would assert a defect never observed.
        Write-Host "  [SKIP] az what-if did not return within $remainingSeconds s and was terminated." -ForegroundColor Yellow
        Write-Host "  Nothing was validated. This is NOT a pass, and it is NOT a claim that the template is wrong." -ForegroundColor DarkGray
        if ($run.SurvivedKill) {
            Write-Host "  The az process did not exit within 10s of being killed; it may still be running." -ForegroundColor Yellow
        }
        if ($outText.Trim()) {
            $tail = @($outText.TrimEnd() -split "`n" | Select-Object -Last 3)
            Write-Host "  Last output before the kill:" -ForegroundColor DarkGray
            foreach ($t in $tail) { Write-Host "    $($t.Trim())" -ForegroundColor DarkGray }
        }
        $results += @{ Zone = $lz.Name; Status = "SKIP"; Class = "TimedOut"; Reason = "Timed out after $remainingSeconds s" }
        continue
    }

    if ($run.ExitCode -eq 0) {
        Write-Host "  [PASS] What-if succeeded" -ForegroundColor Green
        $results += @{ Zone = $lz.Name; Status = "PASS" }
        continue
    }

    # az emits every bicep linter warning for every transitively-referenced
    # module - measured at 60,587 bytes / 205 lines for DLZ - so an UNANCHORED
    # substring search over $outText searches ~60KB of unrelated text. Worse,
    # that test used to run BEFORE the FAIL branch, so the phrase appearing
    # ANYWHERE won unconditionally. Measured with two az stubs:
    #
    #   ERROR: CannotSetResourceIdentity ...          -> [FAIL], RC=1
    #   ... the same, PLUS
    #   ERROR: Missing input parameters: adminPassword -> [SKIP], RC=2
    #
    # RC=2 maps to NotRun in validate-all.ps1, which exits 0 - so adding one
    # line to az's output turned a caught deployment failure into a green
    # `make validate`. The failure class hidden that way is exactly the one
    # this gate's own receipt cites as proof it works.
    #
    # A missing-parameter error therefore only means "az refused the call" when
    # it is the ONLY error az raised. A second ERROR line means az got far
    # enough to find something else wrong, and that is a FAIL.
    #
    # [regex]::Match is used rather than -match so the capture cannot be
    # disturbed by the -match inside the Where-Object above it.
    $errorLines = @($outText -split "`n" | Where-Object { $_ -match '^\s*ERROR:' })
    $missingMatch = [regex]::Match($outText, 'Missing input parameters:\s*(.+)')

    if ($errorLines.Count -le 1 -and $missingMatch.Success) {
        # az rejected the INVOCATION before it evaluated the template, so
        # nothing was what-if'd. That is COULD NOT RUN, not a failure.
        #
        # Measured note: no az version exercised here produced this phrase for
        # DLZ or DMLZ - az 2.x prompts instead, which the pre-check above now
        # settles before we get anywhere near this branch. It is kept because
        # other az versions and other templates do emit it, and because a
        # prompt-free az is the better future.
        $missingNames = $missingMatch.Groups[1].Value.Trim()
        Write-Host "  [SKIP] Required parameters not supplied: $missingNames" -ForegroundColor Yellow
        Write-Host "  az rejected the call before evaluating the template; nothing was validated." -ForegroundColor DarkGray
        $results += @{ Zone = $lz.Name; Status = "SKIP"; Class = "MissingRequiredParams"; Reason = "Required parameters not supplied: $missingNames"; Secure = @(); Plain = @() }
        continue
    }

    Write-Host "  [FAIL] What-if failed (az exited $($run.ExitCode))" -ForegroundColor Red
    Write-Host $outText -ForegroundColor Yellow
    # Only a bounded excerpt goes in the summary. The full text is printed
    # directly above; the linter-warning volume made the one-line summary
    # unreadable.
    $short = ($errorLines | Select-Object -First 1)
    if (-not $short) { $short = ($outText.Trim() -split "`n")[-1] }
    $results += @{ Zone = $lz.Name; Status = "FAIL"; Class = "WhatIfFailed"; Reason = $short.Trim() }
}

# Summary
Write-Host "`n=== Deployment Validation Summary ===" -ForegroundColor Cyan
$passCount = 0
$failCount = 0
$skipCount = 0
foreach ($r in $results) {
    switch ($r.Status) {
        "PASS"  { $passCount++; $color = "Green" }
        "SKIP"  { $skipCount++; $color = "Yellow" }
        default { $failCount++; $color = "Red" }
    }
    Write-Host "  $($r.Zone): [$($r.Status)]$(if ($r.Reason) { " - $($r.Reason)" })" -ForegroundColor $color
}

# The verdict is driven by what was actually what-if'd, not by the absence of
# failures. The old code set $allPassed = $true before the loop and only ever
# cleared it on FAIL, so SKIP counted as success: with no params.$Environment
# .json for either landing zone - which is EVERY value of -Environment except
# the handful that have one, including `stage`, an option the shipped Copilot
# skill score-deployment-readiness.yaml offers in its own enum - this printed
#
#     DLZ:  [SKIP] - Params not found
#     DMLZ: [SKIP] - Params not found
#     All deployment validations passed!
#
# and exited 0. Zero zones validated, reported as a pass. See #3811.
Write-Host ""
if ($failCount -gt 0) {
    Write-Host "$failCount of $($results.Count) landing zone(s) FAILED what-if." -ForegroundColor Red
    exit 1
}
if ($passCount -eq 0) {
    Write-Host "NOT VERIFIED - 0 of $($results.Count) landing zone(s) were validated." -ForegroundColor Yellow
    Write-Host "  Every zone was skipped; nothing was what-if'd. This is NOT a pass." -ForegroundColor Yellow

    # Report only the reasons that actually occurred, keyed on the Class each
    # branch recorded rather than on the prose of its Reason string. An earlier
    # draft named the params file unconditionally, which would have asserted a
    # params problem for a run whose zones were skipped for a missing TEMPLATE -
    # the same class of untrue message this gate exists to stop.
    if (Test-AnyResultClass $results 'NoParams') {
        Write-Host "  Environment '$Environment' resolves to params.$Environment.json, which is missing" -ForegroundColor Yellow
        Write-Host "  for at least one zone. Pass -Environment <name> for one that exists." -ForegroundColor Yellow
    }
    if (Test-AnyResultClass $results 'NoTemplate') {
        Write-Host "  At least one main.bicep was not found under -RepoRoot '$RepoRoot'." -ForegroundColor Yellow
    }
    if (Test-AnyResultClass $results 'MissingRequiredParams') {
        $allSecure = @($results | Where-Object { $_.Class -eq 'MissingRequiredParams' } | ForEach-Object { $_.Secure } | Where-Object { $_ })
        $allPlain = @($results | Where-Object { $_.Class -eq 'MissingRequiredParams' } | ForEach-Object { $_.Plain } | Where-Object { $_ })
        Write-Host "  At least one template declares a required parameter that params.$Environment.json" -ForegroundColor Yellow
        Write-Host "  does not supply, so az would have had to prompt for it." -ForegroundColor Yellow
        if ($allSecure.Count -gt 0) {
            Write-Host "    - @secure() and CORRECTLY not committed: $(($allSecure | Sort-Object -Unique) -join ', ')" -ForegroundColor Yellow
            Write-Host "      Supply them at call time; this gate does not hold secrets and will not." -ForegroundColor Yellow
        }
        if ($allPlain.Count -gt 0) {
            Write-Host "    - NOT secret and genuinely missing from the params file: $(($allPlain | Sort-Object -Unique) -join ', ')" -ForegroundColor Yellow
            Write-Host "      That is a defect in that params file. Fix it and this zone will validate." -ForegroundColor Yellow
        }
        if ($allSecure.Count -eq 0 -and $allPlain.Count -eq 0) {
            # This zone was named by az itself rather than by the static
            # pre-check, so the @secure() split was never determined. Saying
            # "told apart above" here would claim a distinction that was not made.
            Write-Host "    az named the parameters; this run did not determine which of them are @secure()." -ForegroundColor Yellow
            Write-Host "    Check the @secure() decorator in the template to tell a withheld secret from a params-file defect." -ForegroundColor Yellow
        }
        Write-Host "  Either way NOTHING was what-if'd, so this is NOT VERIFIED rather than a failure." -ForegroundColor Yellow
    }
    if (Test-AnyResultClass $results 'TimedOut') {
        Write-Host "  At least one what-if exceeded the gate's $TimeoutSeconds s budget and was terminated." -ForegroundColor Yellow
        Write-Host "  The budget comes from $timeoutSource. Raise it with -TimeoutSeconds <n> or in" -ForegroundColor Yellow
        Write-Host "  dev-loop/config.yaml, then re-run. Nothing is claimed about those templates." -ForegroundColor Yellow
    }
    if (Test-AnyResultClass $results 'BudgetExhausted') {
        Write-Host "  At least one zone never started: the $TimeoutSeconds s budget was spent by earlier zones." -ForegroundColor Yellow
    }
    if (Test-AnyResultClass $results 'PreCheckUnavailable') {
        Write-Host "  At least one zone could not be pre-checked, so az was deliberately not invoked on it." -ForegroundColor Yellow
    }
    if (Test-AnyResultClass $results 'LaunchFailed') {
        Write-Host "  At least one az invocation could not be started at all." -ForegroundColor Yellow
    }
    exit 2
}
if ($skipCount -gt 0) {
    Write-Host "PARTIALLY VERIFIED - $passCount of $($results.Count) landing zone(s) validated, $skipCount skipped." -ForegroundColor Yellow
    Write-Host "  This is NOT a full pass. See the SKIP reason(s) above." -ForegroundColor Yellow
    exit 2
}
Write-Host "All $passCount deployment validation(s) passed!" -ForegroundColor Green
exit 0
