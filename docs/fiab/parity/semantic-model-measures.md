# semantic-model-measures — parity with Power BI / Analysis Services measure authoring

Source UI:
- Power BI Desktop — Model view → New measure (DAX bar) + Measure tools ribbon (Format string, Display folder)
- Tabular Editor — Measure properties (Expression, Format String, Display Folder)
- Microsoft Learn: https://learn.microsoft.com/analysis-services/tmsl/createorreplace-command-tmsl
- Microsoft Learn: https://learn.microsoft.com/analysis-services/azure-analysis-services/analysis-services-async-refresh#authentication

## Azure/Fabric feature inventory (measure authoring)

| Capability | Source UI |
|---|---|
| Author a DAX measure with a syntax-highlighted DAX editor | PBI Desktop DAX formula bar / Tabular Editor expression editor |
| Validate the DAX expression (real engine errors) | PBI Desktop red squiggle / "EVALUATE" in DAX query view |
| Pick the home table for the measure | PBI Desktop "Home table" in Measure tools |
| Set the measure name | PBI Desktop / Tabular Editor |
| Set a **format string** (currency / percent / custom) | PBI Desktop Measure tools → Format; Tabular Editor "Format String" |
| Set a **display folder** | PBI Desktop "Display folder"; Tabular Editor "Display Folder" |
| Persist the measure into the model (createOrReplace) | PBI Desktop save / Tabular Editor "Save to model" (XMLA) |
| Confirm the measure computes a value | PBI Desktop visual / DAX query EVALUATE |
| List existing measures + their expressions | PBI Desktop Fields pane / Tabular Editor tree |

## Loom coverage

| Inventory row | Status | Notes |
|---|---|---|
| DAX editor with syntax highlighting | built ✅ | `MonacoTextarea language="dax"` — new Monarch tokenizer (80+ DAX functions, `[Column]`/`[Measure]` highlighting, `--` `//` `/* */` comments) |
| Validate DAX (real errors) | built ✅ | `POST /measures` → Power BI `executeQueries` (`DEFINE MEASURE … EVALUATE ROW`) returns the engine's real syntax/semantic error |
| Home table picker | built ✅ | `<Select>` populated from the model's tables |
| Measure name | built ✅ | `<Input>` |
| Format string | built ✅ | `<Input>` → TMSL `measure.formatString` via `createOrReplace` |
| Display folder | built ✅ | `<Input>` → TMSL `measure.displayFolder` via `createOrReplace` |
| Persist measure (createOrReplace) | built ✅ / honest-gate ⚠️ | `PUT /model` → `aas-client.upsertMeasure` → SOAP XMLA `Execute`. Honest 501 gate when `LOOM_SEMANTIC_BACKEND≠analysis-services` or `LOOM_AAS_SERVER` unset |
| Confirm measure computes | built ✅ | `PUT /model` evaluates the saved measure (`EVALUATE ROW("value",[M])`) and returns the value in the response |
| List existing measures | built ✅ | pre-existing — renders each table's measures + expressions |

Zero ❌. The only non-functional state is the honest XMLA infra-gate (allowed
per `no-vaporware.md`); the full surface still renders and DAX validation works
on every backend.

## Backend per control

| Control | Backend |
|---|---|
| DAX editor | client-only (Monaco DAX language registration) |
| Validate DAX | Power BI REST `POST /datasets/{id}/executeQueries` (opt-in; Azure-Government host via `getPbiGovHost()`) |
| Save to model (XMLA) | AAS XMLA SOAP `Execute` → TMSL `createOrReplace` (`aas-client.upsertMeasure`); audience `https://*.asazure.<suffix>/.default` |
| Evaluate after save | AAS XMLA SOAP `Execute` → DAX `EVALUATE` (`aas-client.evaluateMeasure`) |
| Backend probe (Save button affordance) | `GET /model` → `{ backend, xmlaPersistence }` |
| Existing measures list | Power BI dataset detail (Loom-native tabular metadata) |

## No-Fabric-dependency posture

Azure Analysis Services is an **Azure-native** service (not Fabric / Power BI),
and is the sanctioned optional backend for the semantic-model item type per
`.claude/rules/no-fabric-dependency.md`. The default `loom-native` backend and
the Power BI Premium XMLA path are surfaced as honest gates — no hard dependency
on a Fabric capacity / workspace. AAS is available in Azure Government regions
(`asazure.usgovcloudapi.net`), so the format-string + display-folder + persist
flow works in every sovereign boundary.

## Bicep sync

- `loomAasServer` / `loomAasDatabase` params + `LOOM_AAS_SERVER` / `LOOM_AAS_DATABASE`
  env vars in `platform/fiab/bicep/modules/admin-plane/main.bicep`.
- One-time admin grant documented inline (ARM cannot set admins on an existing
  AAS server): `az analysis-services server update --admin-users <consolePrincipalId>`.

## Verification

- `npx vitest run lib/azure/__tests__/aas-client.test.ts lib/azure/__tests__/cloud-matrix.test.ts`
- Default-path receipt (AAS unset): `PUT /api/items/semantic-model/<id>/model` →
  `501 { ok:false, gate:'XMLA', remediation:'Set LOOM_SEMANTIC_BACKEND=analysis-services …' }`
  (the allowed honest infra-gate; DAX validation continues to work).
- Wired receipt: with `LOOM_SEMANTIC_BACKEND=analysis-services` + `LOOM_AAS_SERVER`
  bound, save a measure with format `$#,0.00` → `200 { ok:true, persisted:true, evaluate:{ value } }`
  and the formatted value renders in a report visual.
