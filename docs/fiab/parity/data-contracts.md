# data-contracts — parity with the Open Data Contract Standard (ODCS) v3.1 + Purview data-product contracts/SLA

Source UI / spec:
- Open Data Contract Standard (Linux Foundation / Bitol) v3.1 — https://bitol-io.github.io/open-data-contract-standard/latest/
- ODCS v3.1 JSON schema — https://github.com/bitol-io/open-data-contract-standard/blob/main/schema/odcs-json-schema-v3.1.0.json
- Microsoft Purview — data products, terms of use / SLA — https://learn.microsoft.com/purview/concept-data-products
- Microsoft Purview — data quality overview — https://learn.microsoft.com/purview/data-quality-overview
- Azure Data Factory — fault tolerance / skipped-row redirect (the dead-letter analogue) — https://learn.microsoft.com/azure/data-factory/copy-activity-fault-tolerance

Surfaces:
- `lib/editors/data-contract-editor.tsx` + `lib/editors/components/data-contract-odcs-panel.tsx` (the `data-contract` item)
- `app/governance/data-contracts/page.tsx` (the registry)
- `lib/ingest/contract-rules.ts` + `lib/ingest/contract-enforcement.ts` (the enforcement engine)

Azure-native and Loom-native — works with `LOOM_DEFAULT_FABRIC_WORKSPACE`
**UNSET**. No Microsoft Fabric, no Power BI workspace, no Bitol/GitHub call at
runtime (the ODCS shape is compiled in). **IL5**: every leg — Cosmos registry,
ADLS Gen2 dead-letter, Azure Monitor action group — is in-boundary, so the
whole contract lifecycle runs DISCONNECTED in an air-gapped enclave.

## ODCS v3.1 inventory → Loom coverage

| ODCS v3.1 capability | Loom coverage | Backend per control |
|---|---|---|
| `apiVersion` / `kind` / `id` / `version` / `status` fundamentals | ✅ emitted + validated (all five required) | `data-contract-model.toOdcs` / `validateOdcs` |
| `name` / `domain` / `dataProduct` / `tenant` | ✅ derived from the item + its domain | `toOdcs` (meta) |
| `description.purpose|limitations|usage` | ✅ round-tripped on import/export | `validateOdcs` → `contract.description` |
| `schema[]` objects (table/document) | ✅ one object per contract, `logicalType:'object'` | `toOdcs` / `fromOdcs` |
| `schema[].properties[]` (columns/fields) | ✅ typed designer grid | `DataContractDesigner` |
| property `logicalType` (string/date/number/integer/object/array/boolean) | ✅ mapped both ways from the Loom column types | `LOOM_TYPE_TO_ODCS` / `loomTypeFromOdcs` |
| property `physicalType` | ✅ emitted (bigint/decimal/timestamp/…) and used to reverse-map exactly | `LOOM_TYPE_TO_ODCS` |
| property `required` / `unique` / `primaryKey` / `primaryKeyPosition` | ✅ | designer toggles → `toOdcs` |
| property `classification` (PII/PHI/PCI/…) | ✅ dropdown, round-tripped | `CONTRACT_CLASSIFICATIONS` |
| property `description` | ✅ | designer |
| `quality[]` type `library` (nullValues / duplicateValues / invalidValues / rowCount) | ✅ emitted for the rules that map exactly | `odcsRuleFromExpectation` |
| `quality[]` type `custom` (+ `engine`/`implementation`) | ✅ for min/max/range/regex/freshness | `odcsRuleFromExpectation` |
| `quality[].dimension` / `severity` | ✅ (DAMA dimensions + info/warning/error) | `ODCS_QUALITY_DIMENSIONS` / `ODCS_SEVERITIES` |
| object-level (table-scoped) `quality[]` | ✅ row-count and other table rules | `toOdcs` object `quality` |
| `slaProperties[]` (`property`/`value`/`unit`/`element`/`driver`) | ✅ frequency, availability, latency, completeness, retention, supportResponse | `LOOM_SLO_TO_ODCS` |
| `tags` / `customProperties` | ✅ preserved verbatim on import/export | `validateOdcs` |
| `team` / `roles` / `support` / `servers` / `price` | ⚠️ preserved on the stored document but not surfaced in the designer v1 (access + support are governed by Loom's own access-request/approval surfaces) | Cosmos `loom-data-contracts` |
| Import a third-party ODCS document | ✅ file picker; validated with PRECISE `{path, message}` per-field errors | `POST /api/items/data-contract/[id]/odcs` |
| Export a portable ODCS document | ✅ downloads `<id>.odcs.json` | `GET …/odcs` |
| Register / version the contract | ✅ Register button (audited) | `PUT …/odcs` → `data-contract-store.saveContractDoc` |

Zero ❌ — every inventory row is built ✅ or an honest, documented ⚠️.

## Enforcement inventory (the part that makes a contract more than a document)

| Capability | Loom coverage | Backend |
|---|---|---|
| Derive the schema from the REAL bound table (no hand typing) | ✅ "Derive from table" — merges, never wipes annotations | `POST …/introspect` → ADX `.show table <T> schema as json` |
| Bind a contract to an ingestion path | ✅ dropdown pickers (mirrored database / pipeline sink / eventstream) | `PATCH …/odcs {action:'bind'}` (audited) |
| Enforce at the **mirroring engine** | ✅ between the source read and the Bronze upload | `mirror-engine.writeCsvSnapshot` / `writeDeltaCsv` → `enforceOrPassThrough` |
| Enforce at **pipeline sinks** | ✅ pre-flight against the REAL introspected sink shape | `data-pipeline/[id]/run` → ADF `getPipeline` + `getDataset` → `enforceSinkSchema` |
| Enforce at the **eventstream** | ✅ before events reach Event Hubs | `items/eventstream/[id]/events` POST → `enforceBeforeLanding` |
| Quarantine violating rows (dead letter) | ✅ `<basePath>/_rejected/<dataset>/rejected-<ts>.jsonl` in ADLS Bronze — replayable JSONL with the violations attached | `adls-client.uploadFile` |
| Alert on a violation | ✅ O1 unified dispatch, deduped per contract+dataset | `alert-dispatch.dispatchAlert` (P2 quarantine / P1 blocked batch / P3 warnings) |
| Pass/fail trend | ✅ bounded per-contract run history + registry chart | Cosmos `loom-data-contracts.runs[]` |
| Default posture | ✅ **default-ON in `warn-quarantine`** — quarantine the violators, LAND the rest | `DEFAULT_ENFORCEMENT_MODE` (unit-tested) |
| Strict posture | ✅ `hard-reject` is a per-contract OPT-IN dropdown | `PATCH …/odcs {mode}` (audited) |
| Fail-open safety | ✅ an unreadable registry / failed dead-letter write / failed alert never takes the ingestion down; the outcome carries an honest note | `enforceOrPassThrough` |

### Why `warn-quarantine` is the default (operator-confirmed)

A contract authored on Monday must not be able to drop Monday night's
production load. In the default mode a violating row is diverted and reported;
every conforming row still lands, and the diverted rows are recoverable from
the dead-letter JSONL after the producer or the contract is fixed. Only once a
contract is proven does an owner opt into `hard-reject`, which blocks the whole
batch (and still dead-letters every row, so nothing is lost). This is asserted
directly in `lib/ingest/__tests__/contract-rules.test.ts` and
`contract-enforcement.test.ts`.

## Governance registry (`/governance/data-contracts`)

| Capability | Loom coverage | Backend |
|---|---|---|
| List every registered contract | ✅ sortable/filterable `LoomDataTable` | `GET /api/governance/data-contracts` → Cosmos single-partition query |
| ODCS version + status per contract | ✅ badges | same |
| Enforcement mode per contract (default vs opt-in) | ✅ badge + `select` filter | same |
| Bindings per contract, incl. "not bound — nothing is enforced yet" | ✅ | same |
| Pass-rate bar + last decision | ✅ from the real run trend | same |
| Posture roll-up KPIs | ✅ TileGrid | same |
| Guided empty state (never fabricated rows) | ✅ `GuidedEmptyState` | — |
| Runtime kill switch | ✅ FLAG0 `n6-data-contracts` (default-ON); OFF hides the registry, enforcement keeps running | `lib/admin/runtime-flags.ts` |

## Rule compliance

- **no-vaporware** — every control calls a real backend (Cosmos, ADLS Gen2, ADX, ADF REST, Azure Monitor). No mock arrays; the empty registry renders a guided empty state.
- **no-fabric-dependency** — nothing here reads `fabricWorkspaceId`, `LOOM_DEFAULT_FABRIC_WORKSPACE`, or any `*.fabric.microsoft.com` / `api.powerbi.com` host.
- **loom_no_freeform_config** — schema comes from real introspection, rules and SLAs from typed pickers, enforcement mode and bindings from dropdowns. ODCS import is a **file picker**, not a JSON textarea.
- **web3-ui / ux-baseline** — Fluent v9 + Loom tokens only; `Section` / `TileGrid` / `LoomDataTable` / `GuidedEmptyState` / `TeachingBanner` primitives; every badge row uses `flexWrap` + `minWidth: 0`; a freshly created contract's first open shows guidance (an info MessageBar telling you to register), never red.
- **G2** — no day-one gate: enforcement is default-ON and a deployment with no contracts pays one single-partition Cosmos read. The one honest gate (ADX unset, on *Derive from table*) names the exact env var and the bicep module that deploys it.
- **AUDIT (ATO)** — register, import, enforcement-mode change, bind, and unbind each write an `_auditLog` row via `auditLogContainer()` and fan out through `emitAuditEvent`.
- **MIG1** — `loom-data-contracts` registers its migrator chain at module scope from the LEAF `data-contract-model.ts`; the container is ARM-provisioned in `landing-zone/cosmos.bicep` with `createIfNotExists` as the hotfix fallback.
