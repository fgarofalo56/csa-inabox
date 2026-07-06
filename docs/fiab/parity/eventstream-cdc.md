# eventstream-cdc — parity with Fabric Eventstream CDC (mirror change feed + DeltaFlow)

Source UI:
- Fabric Eventstream — mirrored/CDC database sources: https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/add-source-azure-sql-database-change-data-capture
- Delta change data feed in Fabric mirroring: https://learn.microsoft.com/fabric/mirroring/extended-capabilities-delta-change-data-feed
- DeltaFlow output transformation (Preview): https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/delta-flow-output-transformation
- Use change data feed with Delta tables (readChangeFeed): https://learn.microsoft.com/fabric/data-engineering/delta-lake-change-data-feed

CSA Loom builds both as **canvas nodes on the existing Eventstream React-Flow
designer** (`lib/components/eventstream/visual-designer.tsx`) + the Operators tab
(`lib/editors/phase3/eventstream-editor.tsx`), Azure-native by default — **no
Microsoft Fabric** (`no-fabric-dependency.md`). Both compile through the shared
ASA SAQL compiler (`lib/azure/asa-query-compiler.ts`), the single source of truth.

## rel-T90 — Mirrored-DB change feed → Eventstream connector (SOURCE)

Fabric routes a mirrored database's change feed into an eventstream via a managed
connector. Loom reproduces this 1:1 with a **Delta change-data-feed reader** over
the mirror's Azure-native managed Delta table (ADLS Gen2 Bronze
`mirrors/<ws>/<mirrorId>/Tables/<table>`) that **produces to Azure Event Hubs**.

| Fabric / Delta capability | Loom coverage | Backend |
| --- | --- | --- |
| Pick the mirrored database as a source | Built ✅ — "Mirrored-DB change feed (Delta CDF)" source kind; mirror dropdown lists the workspace's mirrored databases | `GET /api/items/eventstream/[id]/mirror-cdf` → owner-scoped Cosmos query |
| Choose tables to capture | Built ✅ — per-table checkboxes from the mirror's replicated tables | mirror `state.tablesStatus` / `state.tables` |
| Read the Delta change data feed (`readChangeFeed`, `startingVersion`) | Built ✅ — Synapse Spark Livy batch reads CDF; falls back to snapshot-as-inserts + enables CDF when not yet on | `provisionMirrorCdf` → `submitSparkBatchJob` (`lib/azure/mirror-cdf-producer.ts`) |
| Emit change rows with change metadata (`_change_type`/`_commit_version`/`_commit_timestamp`) | Built ✅ — Spark writes flattened change rows (+ `__source_table`) as staged JSON | Delta CDF output columns per Learn |
| Produce to the ingest endpoint downstream operators read | Built ✅ — real Event Hubs produce over the HTTPS data plane; the hub IS the source endpoint | `drainMirrorCdf` → `sendEvents` (`eventhubs-data-client`) |
| Start version selector | Built ✅ — "Start from Delta version" spinner | `cdfStartingVersion` arg |
| No Event Hubs namespace / Bronze / Synapse yet | Honest gate ⚠️ — MessageBar names `LOOM_EVENTHUB_NAMESPACE` / `LOOM_BRONZE_URL` / `LOOM_SYNAPSE_WORKSPACE`; full canvas still renders | `cdfGate()` |

Flow: **Provision endpoint** → ensures the sink Event Hub (real ARM PUT) + submits
the Spark CDF reader batch → **Produce staged changes to Event Hub** drains the
Spark-staged change rows to the hub (real produce). Both halves reuse existing,
proven primitives (`submitSparkBatchJob`, `sendEvents`, `listPaths`,
`downloadFile`) — no mocks (`no-vaporware.md`).

## rel-T91 — DeltaFlow CDC-flatten (OPERATOR)

Fabric DeltaFlow flattens a raw Debezium CDC envelope into analytics-ready rows +
change-metadata columns. Loom adds a **CDC flatten** operator that compiles into
the ASA query the eventstream already generates.

| DeltaFlow capability | Loom coverage | Backend (emitted SQL) |
| --- | --- | --- |
| Flatten `after` / `before` into top-level columns | Built ✅ — `COALESCE(after.col, before.col) AS col` per selected column (delete rows keep keys from `before`) | `cdcFlattenSelectList()` in `asa-query-compiler.ts` |
| `__op` change type (Insert/Update/Delete) | Built ✅ — `CASE op WHEN 'c'/'r' → Insert, 'u' → Update, 'd' → Delete` | ASA `CASE` |
| `__changed_at` change timestamp | Built ✅ — `DATEADD(millisecond, ts_ms, epoch)` | ASA `DATEADD`/`CAST` |
| `__schema` / `__table` source metadata | Built ✅ — optional, from a Debezium `source` record field | ASA record navigation |
| Configurable envelope field names (after/before/op/ts) | Built ✅ — typed inputs, no freeform JSON | operator config |
| Live generated-SAQL preview | Built ✅ — read-only Monaco preview in the transform inspector | `compileToSaql` |
| Compiles into the ASA job | Built ✅ — real SAQL, applied via the existing asa-sync / sql-operator routes | `stream-analytics-client` |

Available on both operator surfaces: the visual designer's transform inspector and
the editor's Operators tab / ribbon ("CDC flatten"). The operator is a `TransformNode`
in the same `transforms[]` wire model, so the canvas, the guided builder, and the
Azure-native ASA provisioner stay one model.

## Verification

- `LOOM_DEFAULT_FABRIC_WORKSPACE` unset — both features are Azure-native (Event
  Hubs + Synapse Spark + ADLS Delta + Stream Analytics); no Fabric/OneLake host is
  reached on the default path.
- Guard cascade green: `check-bff-errors`, `check-route-guards`, `check-env-sync`,
  `check-no-freeform`, `check-docs-hygiene` (+ `check-no-raw-px`,
  `check-no-bare-client-fetch`).
- Real-data path: the new BFF route returns `{ok,...}` via `apiOk`/`apiError`/
  `apiServerError`; the mirror change-feed drain produces real Event Hubs events;
  the cdc-flatten operator emits real ASA SAQL (preview visible in the inspector).
