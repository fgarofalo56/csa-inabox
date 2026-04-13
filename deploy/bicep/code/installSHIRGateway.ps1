# Copyright (c) Microsoft Corporation.
# Licensed under the MIT license.
#
# installSHIRGateway.ps1
# Self-Hosted Integration Runtime (SHIR) installation and registration script
# for Azure Data Factory. Deployed via VMSS CustomScriptExtension (customData).
#
# Usage (invoked automatically by Bicep CustomScriptExtension):
#   .\installSHIRGateway.ps1 -gatewayKey "<ADF-IR-Auth-Key>"
#
# Exit Codes:
#   0 = Success
#   1 = Download failure
#   2 = Installation failure
#   3 = Registration failure

param(
    [Parameter(Mandatory = $true, HelpMessage = "ADF Integration Runtime authentication key")]
    [string]$gatewayKey,

    [Parameter(Mandatory = $false, HelpMessage = "Custom node name (defaults to hostname)")]
    [string]$NodeName = $env:COMPUTERNAME,

    [Parameter(Mandatory = $false, HelpMessage = "Enable remote access on port 8060")]
    [bool]$EnableRemoteAccess = $false,

    [Parameter(Mandatory = $false, HelpMessage = "Maximum concurrent jobs")]
    [int]$MaxConcurrentJobs = 20
)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"  # Speeds up Invoke-WebRequest

$shirDir         = "C:\SHIR"
$logFile         = "$shirDir\install.log"
$installerPath   = "$shirDir\IntegrationRuntime.msi"
$downloadUrl     = "https://download.microsoft.com/download/E/4/7/E47A6841-5DDD-4E76-A8D6-3D47B1595723/IntegrationRuntime.msi"
$maxRetries      = 3
$retryDelaySec   = 15
$eventLogSource  = "SHIRInstaller"
$eventLogName    = "Application"

# ---------------------------------------------------------------------------
# Helper Functions
# ---------------------------------------------------------------------------

function Write-Log {
    <#
    .SYNOPSIS
        Writes a timestamped message to both the console and transcript log.
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message,

        [ValidateSet("INFO", "WARN", "ERROR")]
        [string]$Level = "INFO"
    )
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $entry = "[$timestamp] [$Level] $Message"
    switch ($Level) {
        "ERROR" { Write-Error $entry }
        "WARN"  { Write-Warning $entry }
        default { Write-Output $entry }
    }
}

function Get-DmgCmdPath {
    <#
    .SYNOPSIS
        Locates dmgcmd.exe across installed SHIR versions using a wildcard path.
    .OUTPUTS
        Full path to dmgcmd.exe, or $null if not found.
    #>
    $searchPaths = @(
        "C:\Program Files\Microsoft Integration Runtime\*\Shared\dmgcmd.exe"
    )
    foreach ($pattern in $searchPaths) {
        $found = Get-Item -Path $pattern -ErrorAction SilentlyContinue |
                 Sort-Object { $_.Directory.Parent.Name } -Descending |
                 Select-Object -First 1
        if ($found) {
            return $found.FullName
        }
    }
    return $null
}

function Test-ShirInstalled {
    <#
    .SYNOPSIS
        Checks if SHIR is already installed by looking for dmgcmd.exe.
    #>
    $dmgCmd = Get-DmgCmdPath
    return ($null -ne $dmgCmd)
}

function Get-ShirVersion {
    <#
    .SYNOPSIS
        Returns the installed SHIR version from the registry, or "Unknown".
    #>
    try {
        $reg = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\DataTransfer\DataManagementGateway\ConfigurationManager" `
               -ErrorAction SilentlyContinue
        if ($reg -and $reg.LatestVersion) {
            return $reg.LatestVersion
        }
        # Fallback: check uninstall registry
        $uninstall = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*" `
                     -ErrorAction SilentlyContinue |
                     Where-Object { $_.DisplayName -like "*Integration Runtime*" } |
                     Select-Object -First 1
        if ($uninstall) {
            return $uninstall.DisplayVersion
        }
    }
    catch { }
    return "Unknown"
}

function Invoke-DownloadWithRetry {
    <#
    .SYNOPSIS
        Downloads a file with retry logic for transient failures.
    .OUTPUTS
        $true if download succeeded, $false otherwise.
    #>
    param(
        [string]$Url,
        [string]$DestinationPath,
        [int]$MaxAttempts = 3,
        [int]$DelaySeconds = 15
    )

    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            Write-Log "Download attempt $attempt of $MaxAttempts from $Url"
            Invoke-WebRequest -Uri $Url -OutFile $DestinationPath -UseBasicParsing -TimeoutSec 600
            if (Test-Path $DestinationPath) {
                $fileSize = (Get-Item $DestinationPath).Length
                Write-Log "Download complete. File size: $([math]::Round($fileSize / 1MB, 2)) MB"
                return $true
            }
        }
        catch {
            Write-Log "Download attempt $attempt failed: $($_.Exception.Message)" -Level WARN
            if ($attempt -lt $MaxAttempts) {
                Write-Log "Retrying in $DelaySeconds seconds..."
                Start-Sleep -Seconds $DelaySeconds
                # Exponential back-off
                $DelaySeconds = $DelaySeconds * 2
            }
        }
    }
    return $false
}

function Initialize-EventLogSource {
    <#
    .SYNOPSIS
        Creates a Windows Event Log source for SHIR monitoring.
    #>
    try {
        if (-not [System.Diagnostics.EventLog]::SourceExists($eventLogSource)) {
            [System.Diagnostics.EventLog]::CreateEventSource($eventLogSource, $eventLogName)
            Write-Log "Created Event Log source '$eventLogSource' in '$eventLogName'"
        }
        else {
            Write-Log "Event Log source '$eventLogSource' already exists"
        }
    }
    catch {
        Write-Log "Could not create Event Log source: $($_.Exception.Message)" -Level WARN
    }
}

function Write-EventLogEntry {
    <#
    .SYNOPSIS
        Writes an entry to the Windows Event Log.
    #>
    param(
        [string]$Message,
        [System.Diagnostics.EventLogEntryType]$EntryType = [System.Diagnostics.EventLogEntryType]::Information,
        [int]$EventId = 1000
    )
    try {
        if ([System.Diagnostics.EventLog]::SourceExists($eventLogSource)) {
            Write-EventLog -LogName $eventLogName -Source $eventLogSource `
                           -EventId $EventId -EntryType $EntryType -Message $Message
        }
    }
    catch {
        Write-Log "Could not write Event Log entry: $($_.Exception.Message)" -Level WARN
    }
}

# ---------------------------------------------------------------------------
# Main Installation Logic
# ---------------------------------------------------------------------------

# Ensure working directory exists
New-Item -Path $shirDir -ItemType Directory -Force | Out-Null

# Start transcript logging
Start-Transcript -Path $logFile -Append -Force
Write-Log "============================================================"
Write-Log "SHIR Installation Script Started"
Write-Log "Hostname     : $env:COMPUTERNAME"
Write-Log "Node Name    : $NodeName"
Write-Log "Timestamp    : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss UTC' -AsUTC)"
Write-Log "OS           : $((Get-CimInstance Win32_OperatingSystem).Caption)"
Write-Log "Remote Access: $EnableRemoteAccess"
Write-Log "Max Jobs     : $MaxConcurrentJobs"
Write-Log "============================================================"

try {
    # -----------------------------------------------------------------------
    # Step 0: Set up Event Log source for monitoring
    # -----------------------------------------------------------------------
    Write-Log "Step 0: Initializing Windows Event Log source..."
    Initialize-EventLogSource

    # -----------------------------------------------------------------------
    # Step 1: Check for existing installation
    # -----------------------------------------------------------------------
    Write-Log "Step 1: Checking for existing SHIR installation..."

    if (Test-ShirInstalled) {
        $currentVersion = Get-ShirVersion
        Write-Log "SHIR is already installed (version: $currentVersion). Proceeding with upgrade path."

        # For upgrades, still download the latest MSI — msiexec handles in-place upgrade
        $isUpgrade = $true
    }
    else {
        Write-Log "No existing SHIR installation detected. Performing fresh install."
        $isUpgrade = $false
    }

    # -----------------------------------------------------------------------
    # Step 2: Download SHIR installer
    # -----------------------------------------------------------------------
    Write-Log "Step 2: Downloading SHIR installer..."

    # Clean up previous installer if present
    if (Test-Path $installerPath) {
        Remove-Item -Path $installerPath -Force
        Write-Log "Removed previous installer file"
    }

    $downloadSuccess = Invoke-DownloadWithRetry -Url $downloadUrl `
                                                 -DestinationPath $installerPath `
                                                 -MaxAttempts $maxRetries `
                                                 -DelaySeconds $retryDelaySec

    if (-not $downloadSuccess) {
        $errorMsg = "Failed to download SHIR installer after $maxRetries attempts"
        Write-Log $errorMsg -Level ERROR
        Write-EventLogEntry -Message $errorMsg -EntryType Error -EventId 1001
        Stop-Transcript
        exit 1
    }

    Write-EventLogEntry -Message "SHIR installer downloaded successfully" -EventId 1010

    # -----------------------------------------------------------------------
    # Step 3: Install / Upgrade SHIR
    # -----------------------------------------------------------------------
    Write-Log "Step 3: Installing SHIR (silent mode)..."

    $msiArgs = @(
        "/i"
        "`"$installerPath`""
        "/quiet"
        "/norestart"
        "/passive"
        "ADDLOCAL=ALL"
        "/L*v"
        "`"$shirDir\msi-install.log`""
    )

    Write-Log "Running: msiexec.exe $($msiArgs -join ' ')"

    $installProcess = Start-Process -FilePath "msiexec.exe" `
                                     -ArgumentList $msiArgs `
                                     -Wait -PassThru -NoNewWindow

    # MSI exit codes: 0 = success, 3010 = success (reboot required)
    if ($installProcess.ExitCode -ne 0 -and $installProcess.ExitCode -ne 3010) {
        $errorMsg = "SHIR MSI installation failed with exit code: $($installProcess.ExitCode). Check $shirDir\msi-install.log for details."
        Write-Log $errorMsg -Level ERROR
        Write-EventLogEntry -Message $errorMsg -EntryType Error -EventId 1002
        Stop-Transcript
        exit 2
    }

    Write-Log "MSI installation completed with exit code: $($installProcess.ExitCode)"

    if ($installProcess.ExitCode -eq 3010) {
        Write-Log "Exit code 3010 indicates a reboot is recommended but not required for SHIR to function." -Level WARN
    }

    # Wait for services to initialize
    Write-Log "Waiting for SHIR services to initialize..."
    Start-Sleep -Seconds 30

    # Verify dmgcmd.exe is available after install
    $dmgCmdPath = Get-DmgCmdPath
    if (-not $dmgCmdPath) {
        $errorMsg = "dmgcmd.exe not found after installation. SHIR may not have installed correctly."
        Write-Log $errorMsg -Level ERROR
        Write-EventLogEntry -Message $errorMsg -EntryType Error -EventId 1003
        Stop-Transcript
        exit 2
    }

    $installedVersion = Get-ShirVersion
    Write-Log "SHIR installed successfully. Version: $installedVersion"
    Write-Log "dmgcmd.exe located at: $dmgCmdPath"
    Write-EventLogEntry -Message "SHIR version $installedVersion installed successfully" -EventId 1020

    # -----------------------------------------------------------------------
    # Step 4: Register with Azure Data Factory
    # -----------------------------------------------------------------------
    Write-Log "Step 4: Registering SHIR node with Azure Data Factory..."

    # Build registration command
    $regArgs = @("-RegisterNewNode", $gatewayKey, $NodeName)
    Write-Log "Running: dmgcmd.exe -RegisterNewNode <key> $NodeName"

    $regProcess = Start-Process -FilePath $dmgCmdPath `
                                 -ArgumentList $regArgs `
                                 -Wait -PassThru -NoNewWindow `
                                 -RedirectStandardOutput "$shirDir\register-stdout.log" `
                                 -RedirectStandardError "$shirDir\register-stderr.log"

    # Read registration output for logging
    $regStdout = ""
    $regStderr = ""
    if (Test-Path "$shirDir\register-stdout.log") {
        $regStdout = Get-Content "$shirDir\register-stdout.log" -Raw -ErrorAction SilentlyContinue
        if ($regStdout) { Write-Log "Registration output: $regStdout" }
    }
    if (Test-Path "$shirDir\register-stderr.log") {
        $regStderr = Get-Content "$shirDir\register-stderr.log" -Raw -ErrorAction SilentlyContinue
        if ($regStderr) { Write-Log "Registration stderr: $regStderr" -Level WARN }
    }

    if ($regProcess.ExitCode -ne 0) {
        $errorMsg = "SHIR registration failed with exit code: $($regProcess.ExitCode). Stdout: $regStdout | Stderr: $regStderr"
        Write-Log $errorMsg -Level ERROR
        Write-EventLogEntry -Message $errorMsg -EntryType Error -EventId 1004
        Stop-Transcript
        exit 3
    }

    Write-Log "SHIR node registered successfully with ADF"
    Write-EventLogEntry -Message "SHIR node '$NodeName' registered with ADF" -EventId 1030

    # -----------------------------------------------------------------------
    # Step 5: Configure SHIR node
    # -----------------------------------------------------------------------
    Write-Log "Step 5: Configuring SHIR node..."

    # Enable remote access if requested
    if ($EnableRemoteAccess) {
        Write-Log "Enabling remote access on port 8060..."
        try {
            $raProcess = Start-Process -FilePath $dmgCmdPath `
                                        -ArgumentList @("-EnableRemoteAccess", "8060") `
                                        -Wait -PassThru -NoNewWindow
            if ($raProcess.ExitCode -eq 0) {
                Write-Log "Remote access enabled on port 8060"

                # Open firewall for port 8060
                $fwRuleName = "SHIR-RemoteAccess-8060"
                $existingRule = Get-NetFirewallRule -DisplayName $fwRuleName -ErrorAction SilentlyContinue
                if (-not $existingRule) {
                    New-NetFirewallRule -DisplayName $fwRuleName `
                                       -Direction Inbound `
                                       -Protocol TCP `
                                       -LocalPort 8060 `
                                       -Action Allow `
                                       -Profile Domain, Private | Out-Null
                    Write-Log "Firewall rule '$fwRuleName' created for port 8060"
                }
            }
            else {
                Write-Log "Failed to enable remote access (exit code: $($raProcess.ExitCode))" -Level WARN
            }
        }
        catch {
            Write-Log "Error enabling remote access: $($_.Exception.Message)" -Level WARN
        }
    }

    # Set concurrent job limit
    Write-Log "Setting max concurrent jobs to $MaxConcurrentJobs..."
    try {
        $jobProcess = Start-Process -FilePath $dmgCmdPath `
                                     -ArgumentList @("-SetMaxConcurrentJobs", $MaxConcurrentJobs.ToString()) `
                                     -Wait -PassThru -NoNewWindow
        if ($jobProcess.ExitCode -eq 0) {
            Write-Log "Max concurrent jobs set to $MaxConcurrentJobs"
        }
        else {
            Write-Log "Failed to set concurrent jobs (exit code: $($jobProcess.ExitCode))" -Level WARN
        }
    }
    catch {
        Write-Log "Error setting concurrent jobs: $($_.Exception.Message)" -Level WARN
    }

    # -----------------------------------------------------------------------
    # Step 6: Validate installation
    # -----------------------------------------------------------------------
    Write-Log "Step 6: Validating SHIR installation..."

    # Check SHIR services
    $shirServices = @(
        @{ Name = "DIAHostService";                          DisplayName = "SHIR Host Service" },
        @{ Name = "Microsoft Integration Runtime Service";   DisplayName = "SHIR Management Service" }
    )

    $allServicesHealthy = $true
    foreach ($svcInfo in $shirServices) {
        $svc = Get-Service -Name $svcInfo.Name -ErrorAction SilentlyContinue
        if ($null -eq $svc) {
            Write-Log "Service '$($svcInfo.DisplayName)' ($($svcInfo.Name)) not found" -Level WARN
            $allServicesHealthy = $false
        }
        elseif ($svc.Status -ne "Running") {
            Write-Log "Service '$($svcInfo.DisplayName)' status: $($svc.Status) — attempting to start..." -Level WARN
            try {
                Start-Service -Name $svcInfo.Name -ErrorAction Stop
                Start-Sleep -Seconds 5
                $svc.Refresh()
                Write-Log "Service '$($svcInfo.DisplayName)' is now: $($svc.Status)"
            }
            catch {
                Write-Log "Failed to start '$($svcInfo.DisplayName)': $($_.Exception.Message)" -Level WARN
                $allServicesHealthy = $false
            }
        }
        else {
            Write-Log "Service '$($svcInfo.DisplayName)' is Running"
        }
    }

    # Query node status via dmgcmd
    Write-Log "Querying SHIR node status..."
    try {
        $statusProcess = Start-Process -FilePath $dmgCmdPath `
                                        -ArgumentList @("-GetStatus") `
                                        -Wait -PassThru -NoNewWindow `
                                        -RedirectStandardOutput "$shirDir\status-stdout.log"
        if (Test-Path "$shirDir\status-stdout.log") {
            $statusOutput = Get-Content "$shirDir\status-stdout.log" -Raw -ErrorAction SilentlyContinue
            if ($statusOutput) {
                Write-Log "SHIR Node Status: $statusOutput"
            }
        }
    }
    catch {
        Write-Log "Could not query node status: $($_.Exception.Message)" -Level WARN
    }

    # -----------------------------------------------------------------------
    # Summary
    # -----------------------------------------------------------------------
    Write-Log "============================================================"
    if ($isUpgrade) {
        Write-Log "SHIR UPGRADE completed successfully"
    }
    else {
        Write-Log "SHIR FRESH INSTALL completed successfully"
    }
    Write-Log "  Version       : $installedVersion"
    Write-Log "  Node Name     : $NodeName"
    Write-Log "  Remote Access : $EnableRemoteAccess"
    Write-Log "  Max Jobs      : $MaxConcurrentJobs"
    Write-Log "  Services OK   : $allServicesHealthy"
    Write-Log "  Log File      : $logFile"
    Write-Log "============================================================"

    Write-EventLogEntry -Message "SHIR installation completed successfully. Version: $installedVersion, Node: $NodeName" -EventId 1100

    # Clean up installer to save disk space
    if (Test-Path $installerPath) {
        Remove-Item -Path $installerPath -Force -ErrorAction SilentlyContinue
        Write-Log "Cleaned up installer MSI"
    }
}
catch {
    $errorMsg = "Unhandled exception during SHIR installation: $($_.Exception.Message)`n$($_.ScriptStackTrace)"
    Write-Log $errorMsg -Level ERROR
    Write-EventLogEntry -Message $errorMsg -EntryType Error -EventId 1099
    Stop-Transcript
    exit 2
}
finally {
    Stop-Transcript
}

exit 0
