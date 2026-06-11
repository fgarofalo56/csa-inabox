# profile.ps1 — runs once per PowerShell worker cold start.
# Imports the Exchange/SCC management module so the per-invocation handler
# (labels/run.ps1) can call Connect-IPPSSession + the *-Label cmdlets without
# paying the import cost on every request.
if (Get-Module -ListAvailable -Name ExchangeOnlineManagement) {
    Import-Module ExchangeOnlineManagement -ErrorAction SilentlyContinue
}
