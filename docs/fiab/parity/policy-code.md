# policy-code — Governance-as-Code (WS-10.2 / BTB-8)

Loom-only surface (no single Fabric/Azure analog — it composes over the existing
per-engine governance UIs). Baseline: Microsoft Purview "policies as code" +
Databricks Unity Catalog grants/ABAC + Azure portal RBAC, unified into one
authored policy set that compiles to every backend in a single pass.

Source references (grounded, not from memory):
- Unity Catalog GRANT / ROW FILTER / COLUMN MASK / ABAC POLICY — `lib/sql/uc-security-builders.ts`, Databricks docs.
- Synapse SQL SECURITY POLICY (RLS) + column/table DENY — `lib/azure/rls-compiler.ts`.
- ADX row_level_security + database-role principals — `lib/azure/kusto-client.ts`, ADX docs.
- Purview Data Map classification — `lib/azure/purview-client.ts`.

## Capability inventory → Loom coverage

| Capability | Loom coverage | Backend / call |
|---|---|---|
| Author a typed policy set (principals × resources × actions × conditions) via wizard (no freeform JSON) | ✅ built | `lib/governance/policy-code/dsl.ts`; `admin/policy-code` StatementDialog |
| Import / export the set as YAML/JSON | ✅ built | `toYaml` / `parsePolicyCodeSet`; PUT `/api/admin/policy-code` |
| Compile to Synapse SQL — GRANT / table+column DENY / SECURITY POLICY RLS | ✅ built | `compilers/synapse.ts` → real T-SQL |
| Compile to Unity Catalog — GRANT/REVOKE + ROW FILTER + COLUMN MASK (Databricks) | ✅ built | `compilers/unity-catalog.ts` → Databricks SQL |
| Compile to Unity Catalog — grants via REST (OSS-UC, **no Databricks/Fabric capacity**) | ✅ built | `compilers/unity-catalog.ts` `rest` payload → `updatePermissions` |
| Compile to ADX — `.add database` principals + `row_level_security` | ✅ built | `compilers/adx.ts` → KQL mgmt commands |
| Compile to Purview — classification / sensitivity marking | ✅ built | `compilers/purview.ts` → `addAssetClassification` |
| Compile to API scope gates (route → allowed groups) | ✅ built | `compilers/api-scope.ts` → api-scope registry doc |
| **One policy set compiles to ≥ 4 backends in one pass** | ✅ built | `compile.ts` `compileAll`; tested (`__tests__/compilers.test.ts`) |
| Reconcile loop — read live, diff, apply delta, audit | ✅ built | `reconcile.ts` `reconcilePolicyCode` |
| **Self-heal drift** (out-of-band removal re-applies; policy removal revokes) | ✅ built | `reconcile.ts` `diffOps` (pure, tested) |
| Dry-run drift preview (no mutation) | ✅ built | GET/POST `/api/admin/policy-code/reconcile` `apply:false` |
| Honest gate per unconfigured backend (names exact env var) | ✅ built | `backendGate()` per backend |
| `loom policy apply` CLI | ✅ built | `apps/loom-cli/src/commands/policy.ts` (`show`/`compile`/`diff`/`apply`) |
| Admin UI — author, compiled preview per backend, reconcile, drift status | ✅ built | `app/admin/policy-code/page.tsx` (AdminShell + SplitPane + tokens) |

Zero ❌. Honest-gate rows (⚠️): a backend whose env is unset reports a
`status:'gated'` receipt row naming the exact var — the full UI still renders.

## No-Fabric-dependency

The OSS-UC path (`LOOM_UC_BACKEND=oss` + `LOOM_UNITY_URL`) applies grants through
the UC permissions REST — no Databricks SQL warehouse, no Fabric capacity. Row
filters / column masks (a Databricks-only surface) become an honest compiler
warning on the OSS path, with enforcement delegated to the Synapse/ADX resources
on the same statement. Every default path is Azure-native.

## Verification

- `npx tsc -p tsconfig.build.json --noEmit` → clean.
- `npx vitest run lib/governance/policy-code/__tests__` → 20 passing (DSL,
  5 compilers, one-pass ≥4-backend acceptance, reconcile drift self-heal).
- CI guards: env-sync, route-guards, file-size, bff-errors, health-coverage,
  no-freeform → all OK.

## Owed (Track-0)

Browser-E2E receipt (G1): one policy set compiling to 4 backends + self-healing
drift, walked in a real browser against live Azure backends. Tracked as the
standing WS-11.6 receipt sweep item.
