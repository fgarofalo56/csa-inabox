# PowerShell module dependencies for the SCC labels sidecar.
# ExchangeOnlineManagement ships Connect-IPPSSession (Security & Compliance
# PowerShell) plus the *-Label / *-LabelPolicy cmdlets used for sensitivity
# label + policy CRUD. We pin a major version so cold starts are deterministic.
#
# NOTE: with managedDependency disabled in host.json, this module is installed
# at deploy time by the bootstrap step (Save-Module -Name ExchangeOnlineManagement
# into the Modules/ folder of the deployment package). Listed here for clarity
# and for environments that re-enable managed dependencies.
@{
    'ExchangeOnlineManagement' = '3.*'
}
