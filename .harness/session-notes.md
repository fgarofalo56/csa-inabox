# FINISHLINE session notes

## Session 2 — 2026-08-08

### THE NUMBER THAT MATTERS

Main advanced to **`d7d681b9`**; the estate is at **`10365e76`**. Release
**0.89.0** (#3072), C24 (#3119), C23 (#3120) and the Gov PRs are **merged, not
deployed**. Nothing below is claimed as live unless it says "verified live".

### VERIFIED LIVE this session

- **D18** — the #3012 trino/iceberg console env IS deployed. The
  `https://0.0.0.0:3000/...` placeholder is gone; `LOOM_TRINO_*` and
  `LOOM_UNITY_*` are all present. Measured with `az containerapp show`, not
  inferred from bicep. `LOOM_TRINO_POLICY_TOKEN` is a **secretRef** — its empty
  `value` is ACA's rendering, not a gap.
- **D11** — post-deploy bootstrap **SUCCESS** (run 31239422563), first since
  07-19, and verified **non-hollow**: 22+ steps actually executed including the
  cross-sub DLZ Reader grant and the Synapse managed PE.

### THE FEDERATION 502 IS ROOT-CAUSED (RC-9)

```
{"error_code":"UNAUTHENTICATED","message":"Invalid issuer"}
```
The catalog rejects **its own tenant's tokens**. The entrypoint's
`allowed-issuers` carries the **v2.0 form only**, but the Console app
registration has `requestedAccessTokenVersion: null` → Entra emits **v1.0**
tokens whose issuer is `https://sts.windows.net/{tenant}/`.
Re-measured independently: `az ad app show → requestedAccessTokenVersion=None`.

**Fix lives in `apps/loom-unity/bin/loom-entrypoint.sh`** — baked into the
`loom-unity` IMAGE that BOTH `loom-unity` and `iceberg-catalog` run. It needs an
**image rebuild + a roll of both apps**. That is a DIFFERENT path from the
console rolls; a console roll will NOT carry it.

**Do NOT hardcode the issuer.** Measured: the tenant's own discovery document is
authoritative for both forms —
`…/.well-known/openid-configuration` → `https://sts.windows.net/<tenant>/`, and
`…/v2.0/.well-known/openid-configuration` → `https://login.microsoftonline.com/<tenant>/v2.0`.
Deriving them at the per-cloud authority host (`login.microsoftonline.us` in
Gov) yields the correct **Gov** issuer without anyone knowing what it is —
cloud-parity by construction instead of a hostname table. Must **fail closed**
if discovery is unreachable.

**Do NOT set `requestedAccessTokenVersion: 2`** as the fix — it changes token
shape for every consumer of that app registration including console sign-in, and
MSAL breakage has already caused one production outage here.

Federation grade stays **D** (19 ✅ / 13 ⚠️ / 27 ❌). No authenticated catalog
read has returned 200 on this estate.

### GOV: THE BIGGEST DEFECT WAS NOT ON THE TASK LIST

**`deploy-fiab-gcc` and `deploy-fiab-gcch` are `disabled_manually`.** gcch failed
**12 consecutive** scheduled runs (07-23 → 08-03) and was then *disabled rather
than fixed*; gcc was "SUCCESS daily" while deploying **zero Container Apps**
(#3078). Verified independently: exactly **three** workflows are non-active
repo-wide. **Only visible via `gh api .../actions/workflows`** — `gh run list`
shows an old result and looks quiet.

**`deploy/bicep/gov/main.bicep` had 7 compile errors and had NEVER compiled**
(verified on origin/main: BCP036 ×1, BCP120 ×3, BCP139 ×3). The Gov deploy path
was structurally incapable of running. R1 P0.

Both GCC lanes were left **disabled on purpose** — they are nightly
validate-and-**teardown** rings that target RGs by name (#3028 hazard). I proved
the fix executes by enabling → dispatching `whatif-only` (teardown is gated off
that) → **re-disabling immediately**, so the cron stays off. Re-enabling is an
operator decision.

`gov-provision-trino` **still never run** — Gov Iceberg/Trino federation is
unexercised, the exact inversion `cloud-parity.md` names.

### DO-NOT-REPEAT (measured this session)

- **A green `guardrails` step can still hide a broken guard.** C24's guard passed
  10/10 on a tree containing three live `|| true`s. Guards that scan
  *per-physical-line* miss shell **continuation lines**, and a scan limited to
  `.github/workflows/` never sees `scripts/`.
- **A bare non-zero command in a bash EXIT trap does NOT change exit status**
  (`cleanup(){ false; }; trap cleanup EXIT; exit 0` → 0). Deleting `|| true`
  there is cosmetic; capture `$?` and `exit 1`.
- **`VAR="${VAR:-$(az … 2>/dev/null)}"` under `set -euo pipefail` aborts the
  step** with az's code, message already destroyed — which made
  streaming-migrate's honest-skip branch **unreachable code**.
- **`{ __proto__: true }` in an object literal is prototype-SETTER syntax** and
  creates no own key. A fixture built that way tests nothing — use `JSON.parse`.
- **Absent checks are not passing checks, again.** #3072 sat BLOCKED on two
  required checks that never reported; `loom-guardrails` has no path filter, so
  it was the webhook-drop class. close+reopen re-triggered both.
- **Secondary rate limits are separate from core.** A 403 on `/actions/runs`
  while core showed 4747/5000 — 8 agents plus orchestrator polling. Back off on
  Actions polling, not on everything.
- **Check which branch you are on before reading the ledger.** The ledger lives
  on `harness/finishline-s1-b`; a stray checkout of `…-wave0` showed a stale
  41-task file and briefly looked like data loss.
- **A stale `.git/index.lock` will be your own timed-out command.** Worktrees
  have their own index files, so a 0-byte lock on the MAIN repo that has not
  moved in minutes is orphaned — but confirm mtime is static first.

### OPERATOR QUEUE (highest leverage first)

1. **Re-enable `deploy-fiab-gcc` + `deploy-fiab-gcch`** (repo Actions admin) —
   accepting that both resume a **daily teardown ring** into sovereign estates.
   The gcch guard fix (#3079) landed 08-07 but has **never executed**.
2. **Gov Databricks SQL warehouses** — `TEMPORARILY_UNAVAILABLE` on all 8 list +
   8 create attempts over ~6 minutes. Sixteen responses in six minutes is not
   transient; plausibly a `cloud-parity.md` §3 case needing an Azure-native/OSS
   equivalent. The old RBAC blocker is genuinely **cleared**.
3. **#3078 needs a COMMERCIAL-cloud image producer** — GCC is `AzureCloud`+eastus,
   not Gov. The green Gov image lane does **not** unblock it. Easy to misread.
4. **Tag Contributor on the ACR** for the deploy identity (OP-15).
5. **#2643** Gov unity auth window · **#2330** Gov SP UAA grant (not re-measured)
   · seven idle Function Apps · svc-postgres cost ruling.

### IN FLIGHT

Eight lanes: F1 (federation, reworking RC-9 to discovery-derived issuers),
#3056 (token single-writer), C22 (route-guard enforcement), C20 (silent-failure
sweep), C15+C21 (G2 Fix-it coverage), C17+C16 (inert features), C18+D8 (floating
`:latest` + PE zone-group). Gov PRs #3124 #3125 #3126 #3127 awaiting checks.
