<#
.SYNOPSIS
    Toggle Claude Code between direct Anthropic API and a local
    GitHub-Copilot-flavored proxy.

.DESCRIPTION
    The maintainer runs a local proxy that translates Anthropic API
    calls to GitHub Copilot's hosted Claude models, billed against
    the Copilot subscription instead of the Anthropic API.

    This script flips the two env vars Claude Code respects without
    requiring you to edit ~/.claude/settings.json.

    Two functions are exported:

      Use-CopilotProxy   — point Claude Code at http://localhost:4141
      Use-DirectClaude   — fall back to direct Anthropic API + key

    Drop this file in your $PROFILE (paste a `. ./scripts/dev/Use-CopilotProxy.ps1`
    line into the file at notepad $PROFILE) and the functions are
    available in every new shell.

.EXAMPLE
    Use-CopilotProxy
    claude  # now talks to the proxy

.EXAMPLE
    Use-DirectClaude
    claude  # talks to api.anthropic.com directly

.NOTES
    Per-shell only — env vars don't persist across shells unless you
    export them via [Environment]::SetEnvironmentVariable() with
    'User' scope. Default behavior here is intentionally session-scoped
    so you don't accidentally leave the proxy on for an unrelated
    session.
#>

function Use-CopilotProxy {
    [CmdletBinding()]
    param(
        [string]$ProxyUrl = "http://localhost:4141",
        [string]$Token = "proxy"
    )

    # Probe the proxy first — fail fast if it isn't running.
    try {
        $null = Invoke-WebRequest -Uri "$ProxyUrl/health" -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
    } catch {
        try {
            # Some proxies don't expose /health — try root path
            $null = Invoke-WebRequest -Uri $ProxyUrl -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
        } catch {
            Write-Host "[Use-CopilotProxy] proxy at $ProxyUrl is not reachable" -ForegroundColor Red
            Write-Host "  Check that your container is running: docker ps" -ForegroundColor Red
            return
        }
    }

    $env:ANTHROPIC_BASE_URL = $ProxyUrl
    $env:ANTHROPIC_AUTH_TOKEN = $Token
    Write-Host "[Use-CopilotProxy] Claude Code -> $ProxyUrl (Copilot subscription)" -ForegroundColor Yellow
}

function Use-DirectClaude {
    [CmdletBinding()]
    param()
    Remove-Item Env:ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
    Write-Host "[Use-DirectClaude] Claude Code -> api.anthropic.com (direct, Max subscription via OAuth or API key)" -ForegroundColor Green
}

function Get-ClaudeRouting {
    [CmdletBinding()]
    param()
    if ($env:ANTHROPIC_BASE_URL) {
        Write-Host "Claude is routed via: $env:ANTHROPIC_BASE_URL" -ForegroundColor Yellow
    } else {
        Write-Host "Claude is using direct Anthropic endpoint" -ForegroundColor Green
    }
}
