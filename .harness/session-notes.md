# FINISHLINE session notes

## Session 1 — 2026-08-06/07

### MERGED TO MAIN: 17 PRs

D9 (loom-uat CVE) · D1 (risingwave probe + netns port-seal) · D4-D6 (brownfield
idempotency) · D13 (workflow hygiene + guards) · C7 ×2 (workspace wizard +
register truth) · C14 (14 parity docs, 9 editor specs) · **C19 (editor
DATA-LOSS fix)** · C1 (apex Phase-E artifacts) · P2-DOCS (docs currency + D17) ·
E2-E4 (corpus-wide BM25) · D15 (honest day-one scoring) · D3 (AcrPull
sequencing) · D2 (privatelink zone + unity) · ledger ×2 · release 0.88.1.

**D10 (#3062) is the last queue PR** — green except the known main-branch evals
gate, awaiting final checks.

### DEPLOYMENT TRUTH (the number that matters)

Estate advanced `f534d87c` → **`a6dc9e58`** during the session (auto-roll works).

- **LIVE:** D9, D1.
- **MERGED, NOT DEPLOYED:** the other ~12, including the C19 data-loss fix.
- `full-app-deploy-commercial` run **31143181962** dispatched with
  **`region=centralus` EXPLICIT** — the input defaults to `eastus2` (#3029) and
  D7 hasn't landed. **Any dispatch must pass region until D7 merges.**
  `skip_supply_chain` deliberately NOT used.

### THE BIG PICTURE FOR FEDERATION (operator's live question)

`iceberg-catalog`, `loom-trino`, `loom-unity` are all **Succeeded/Running** on
internal ingress. The console still holds the placeholder
`LOOM_ICEBERG_CATALOG_URL=https://0.0.0.0:3000/...` and has **no `LOOM_TRINO_*`**.
main's bicep ALREADY emits the right values (D2 moved it in-orchestrator) — so
this is merged-not-deployed and lights up on the next **admin-plane deploy**.

**Do NOT hand-wire it with `az containerapp update`** — the bicep comment names
that as the anti-pattern the next deploy silently reverts.

- **Audience registered 2026-08-07:** `api://5c59f3f3-e26d-4122-a707-a04e21ff5255`
  added to `CSA Loom Console (kv-loom-k6mvh5sm6z7do)` (`identifierUris` was `[]`).
  Console root 200 and `/api/auth/me` 401 verified after — sign-in intact.
- **Blocker: D7** (safe deploy inputs). `deploy-fiab-commercial` still defaults
  `keep_resources=false` (tears down the admin RG, #3028) and `region=eastus2`
  (#3029). **OP-13 is blocked by D7, not just operator availability.**

### NEW DIE-HARD RULE — `.claude/rules/cloud-parity.md`

Operator, 2026-08-07: *"parallel support offering the same capabilities and
features no matter the cloud."* A Commercial-only capability is **INCOMPLETE**,
not "Commercial-first". Load-bearing: **Unity Catalog is not in MAG**, so Loom
Unity + Iceberg/Trino federation IS the Gov catalog story. "That service isn't
in Gov" is the START of the design problem — supply the Azure-native/OSS
equivalent.

### IN FLIGHT

- **D7** — safe deploy inputs + mutation-proved refusal guards (gates federation).
- **Gov parity lane** — re-briefed under cloud-parity; capability-by-capability
  Commercial↔Gov, store-cutover verdict, sequenced dispatch plan.
- **Deploy run 31143181962** — queued behind this session's own CI fan-out.

### OPERATOR QUEUE (highest leverage first)

1. **#2330** Gov SP UAA grant on the Gov admin RG — needs rights a workflow
   can't self-grant; several Gov items unblock behind it.
2. **#2643** Gov unity auth DISABLED live (anonymous read+mutate since 07-15) —
   needs a 3.5-4.5h attended window, or say the word for an interim IP-restrict.
3. **Function App teardown** — 7 apps billing while executing nothing
   (FunctionExecutionCount sum=0/13d). Duplicate timers already disabled by the
   orchestrator; DELETION needs explicit approval.
4. **svc-postgres** default-ON vs policy-accepted opt-in (cost call).
5. **D6 screenshots** (0/159) and the **Esri license**.

### DO-NOT-REPEAT (measured this session)

- Absent checks are NOT passing checks — a webhook-throttled incident silently
  creates zero runs; re-trigger with close+reopen.
- `--admin` ONLY to drain strict BEHIND-staleness on a PR whose OWN checks are
  green, then WATCH main. The evals-gate clearance was justified by it failing on
  main across 3 SHAs BEFORE any queued PR existed — not a precedent.
- Compiled artifacts (`deploy-templates/main.json`, `route-inventory.md`) are
  REGENERATED on conflict, never hand-merged. A hand-merge silently dropped a
  sibling's fix in one measured case.
- Never run a `--family=` codemod (scope creep); use `--file=`.
- Gov: **never local az**, Actions only.
- Junctions: `cmd //c mklink` is mangled — use PowerShell `New-Item -ItemType Junction`.
