# access-governance-sweeper

Timer Function that drives the CSA Loom **expiry sweeper** (access-governance W3).

Every 15 minutes it calls `POST {LOOM_CONSOLE_URL}/api/access-governance/sweep`
with the shared `x-loom-system-token`. The Console does the real work: find
entitlement-ledger assignments that are `active` and past `expiresAt`, revoke the
Azure grant (`revokeStructuredGrant` for Synapse SQL / ADX + `revokeAccessGrant`
for the ARM role assignment), and mark the ledger row `expired`. Keeping the logic
in the Console means there is one implementation of revoke (no ARM/SQL/ADX logic
duplicated in Python).

## Endpoints
- Timer: `0 */15 * * * *` → sweep.
- `GET /api/sweep-now[?dryRun=1]` (function key) — run once on demand.
- `GET /api/health` (anonymous).

## Config (app settings)
| Setting | Purpose |
|---|---|
| `LOOM_CONSOLE_URL` | Console base URL (no trailing slash). |
| `LOOM_SWEEPER_TOKEN` | Shared secret; must equal `LOOM_SWEEPER_TOKEN` on the Console. Store as a Key Vault secretRef on both. |

If either is missing the Function no-ops (honest gate) — the admin can still run
the sweep manually from **Admin → Access report → Run sweep**.

## Deploy
```
az deployment group create -g <function-rg> \
  -f deploy/main.bicep \
  -p loomConsoleUrl=https://<console-host> loomSweeperToken=<secret>
func azure functionapp publish <functionName>
```
Then set the SAME `LOOM_SWEEPER_TOKEN` on the Console app.

Day-one: the sweep runs manually from the Access report with **no** Function
deployed; this app just automates it on a schedule.
