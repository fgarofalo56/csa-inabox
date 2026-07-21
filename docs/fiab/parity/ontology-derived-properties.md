# ontology-derived-properties — parity with Palantir Foundry derived properties + functions on objects

**Category:** Fabric IQ · **Loom slug:** `ontology` (Derived + Functions tabs) ·
**Editor:** `OntologyEditor` → `OntologyDerivedPanel` /
`OntologyFunctionsPanel` in `apps/fiab-console/lib/editors/phase4/`.
**WS-4.2 (Foundry moat depth). Last authored: 2026-07-20 against current code.**

**Backend (default, Azure-native, NO Fabric):**
- Rollups computed **live** in the object-view route from real Apache-AGE
  linked-object traversal (`weave-explore.traverseObject`) — never stored on the
  vertex, recomputed on every read.
- Functions-on-objects execute on the **Loom UDF runtime** (`loom-udf-runtime`
  Container App / any Azure Function App via `LOOM_UDF_FUNCTION_BASE`), invoked
  as `POST {base}/api/<path>`.
- The function registry is a tenant-scoped **Cosmos** doc (`function-registry`
  container, id `function-registry:<tenantId>`).
- Object-level security (WS-4.3) applies **before** derived compute — rollups +
  function inputs use only the caller's masked/cleared linked data.

Source UI: Palantir Foundry
- Derived properties: https://www.palantir.com/docs/foundry/object-link-types/derived-properties-overview
- Functions on objects: https://www.palantir.com/docs/foundry/functions/functions-overview
- Action validation (submission criteria / functions): https://www.palantir.com/docs/foundry/action-types/overview

## Foundry feature inventory → Loom coverage

| # | Foundry capability | Loom coverage | Backend / file |
|---|--------------------|---------------|----------------|
| 1 | Derived property = aggregation over a linked object set (count/sum/avg/min/max) | ✅ | `computeRollup` / `computeRollups` in `lib/foundry/derived-properties.ts`; fed by `traverseObject` in the view route |
| 2 | Rollup scoped by link type + direction | ✅ | `OntoDerivedProperty.linkType` + `direction` (`out`/`in`/`any`) |
| 3 | Rollup scoped by linked object type | ✅ | `OntoDerivedProperty.targetType` |
| 4 | Aggregate a specific linked property | ✅ | `OntoDerivedProperty.targetProperty` (numeric coercion; honest `—` when absent) |
| 5 | Derived property computed live on object read (not materialised) | ✅ | `objects/[vertexId]/view/route.ts` → response `derived[]`; rendered in `ObjectViewPanel` |
| 6 | Custom derived value via a function | ✅ | `kind:'function'` derived prop → `invokeFunction` on the UDF runtime |
| 7 | Functions on objects — registry | ✅ | `function-registry` Cosmos store + `/api/ontology-functions` |
| 8 | Function **versioning** (pin / latest) | ✅ | `RegisteredFunction.version`; `resolveFunction` (pinned else latest); `OntologyFunctionsPanel` lists versions |
| 9 | Typed function signature (params + returns) | ✅ | `LoomFunctionParam[]` + `returns`; registration wizard |
| 10 | Action validation calls a function before write-back | ✅ | `OntoActionType.validationFunction` → `run-action/route.ts` invokes it; non-`valid` verdict → **422** before `runActionType` |
| 11 | Function runtime is a real callable endpoint (Azure-native, Gov-safe) | ✅ | `loom-function-runtime.ts` → `POST {LOOM_UDF_FUNCTION_BASE}/api/<path>` |
| 12 | Honest gate when the runtime is not configured | ⚠️ honest-gate | `functionRuntimeGate` → 503 (`svc-udf-function` gate, Fix-it env-picker) on run-action; per-property "not available" on the object view |
| 13 | Authoring without freeform (wizard/pickers) | ✅ | `OntologyDerivedPanel` + `OntologyFunctionsPanel` — typed Dropdowns only (`loom-no-freeform-config`) |
| 14 | Foundry: derived-prop over an *aggregation function pipeline* (multi-hop) | ❌ (P2) | single-hop rollups + single-function today; multi-hop pipelines are a follow-up |

Zero ❌ on the WS-4.2 acceptance rows (1–13). Row 14 is an explicit P2 follow-up
(multi-hop derived pipelines), tracked for a later wave.

## Backend per control

| Control | Backend call |
|---------|--------------|
| Add rollup derived property | Cosmos `state.derivedProperties[<type>]` (item save) |
| View rollup value | `GET /objects/[vertexId]/view` → `computeRollups` over AGE `traverseObject` |
| Register/version a function | `POST /api/ontology-functions` → `function-registry` Cosmos |
| Function-kind derived value | `invokeFunction` → `POST {LOOM_UDF_FUNCTION_BASE}/api/<path>` |
| Action validation function | `POST /run-action` → `getRegisteredFunction` → `invokeFunction` → `interpretVerdict` (422 on invalid) |

## Sovereignty

AGE (PostgreSQL Flexible Server) + the Loom UDF runtime (ACA / Azure Functions) +
Cosmos — all Gov-available. No `api.fabric.microsoft.com` / Power BI / Foundry
REST on any path. Fabric is not required.

## Owed (Track-0)

Browser-E2E receipt: a derived rollup computes live on an object instance; an
ontology action calls a registered validation function (200 on valid, 422 on
invalid). To be attached against a live Weave-PG + UDF-runtime deployment.
