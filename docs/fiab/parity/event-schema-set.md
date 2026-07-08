# event-schema-set — parity with a schema registry (Azure Event Hubs Schema Registry / Confluent-style)

> Parity audit per `.claude/rules/ui-parity.md` + `.claude/rules/no-vaporware.md`
> + `.claude/rules/no-fabric-dependency.md`. Graded conservatively.

**What this is.** An **Event schema set** is a **schema registry** (Avro / JSON
Schema / Protobuf) shared across Eventstream sources, KQL ingestion, and
downstream consumers powering DeltaFlow CDC — the Kafka/Confluent "subjects →
versions → compatibility policy" model. It is a first-class Loom catalog item in
the **Real-Time Intelligence** category
(`apps/fiab-console/lib/catalog/item-types/real-time-intelligence.ts`,
`slug: 'event-schema-set'`, `restType: 'EventSchemaSet'`).

Microsoft Fabric has no distinct "schema set" item; the real-world parity target
is a **schema registry**. Loom's Azure-native enforcement backend is **Azure
Event Hubs Schema Registry** (opt-in) with an **in-process Avro validator** as
the always-on default — no Fabric, no external registry required.

**Source UI (grounded in Microsoft Learn, not memory):**
- Azure Event Hubs Schema Registry: https://learn.microsoft.com/azure/event-hubs/schema-registry-overview
- Schema compatibility / evolution: https://learn.microsoft.com/azure/event-hubs/schema-registry-concepts
- Avro schema evolution semantics (BACKWARD/FORWARD/FULL/NONE) — Confluent reference model: https://learn.microsoft.com/azure/event-hubs/schema-registry-json-schema-kafka-python
- Loom guide: `docs/fiab/event-schema-registry` (`loomDocUrl('fiab/event-schema-registry')`)

**No-Fabric note.** No Fabric/OneLake dependency. Default enforcement is
in-process against Cosmos-persisted schemas; setting `LOOM_EH_SCHEMA_GROUP`
(+ `LOOM_EVENTHUB_NAMESPACE`) delegates enforcement to a real **Event Hubs Schema
Registry** schema group. Either way the full surface renders and works.

**Loom surface:**
- Editor: `apps/fiab-console/lib/editors/event-schema-set-editor.tsx` — left tree
  of schema sets + tabs **Subjects · Versions · Compatibility · Settings**.
- BFF: `app/api/items/event-schema-set/route.ts` (list/create),
  `…/[id]/route.ts` (get / PATCH policy), `…/[id]/versions` (register a version),
  `…/[id]/check-compat` (pre-publish dry-run compatibility).

**Backend reality check.** Every action calls a real Cosmos-backed endpoint
(`itemsContainer`); no mock arrays. Register enforces the set's compatibility
policy server-side (HTTP 409 with the specific breaking changes) before
persisting — via the in-process Avro validator (default) or Event Hubs Schema
Registry (HTTP 400 from the service) when `eventhubs-sr` is configured. The
Register dialog runs a **live debounced dry-run** check and an explicit "Check
compatibility" button, both hitting `check-compat`.

---

## Schema-registry feature inventory → Loom coverage → backend

Legend: built ✅ · honest-gate ⚠️ · MISSING ❌

| # | Schema-registry capability | Loom | Where / backend |
|---|---|---|---|
| 1 | List schema sets in a workspace | ✅ built | left tree → `GET /api/items/event-schema-set?workspaceId=` |
| 2 | **Create a schema set** (name, description, default format) | ✅ built | New-set dialog → `POST …/event-schema-set` |
| 3 | Default format Avro / JSON Schema / Protobuf | ✅ built | create dialog dropdown |
| 4 | **Subjects** list (name, format, version count, latest) | ✅ built | Subjects tab table (sortable) |
| 5 | **Register a new schema version** under a subject | ✅ built | Register dialog → `POST …/[id]/versions` |
| 6 | Local JSON validation before round-trip | ✅ built | `JSON.parse` guard in the dialog |
| 7 | **Compatibility check** (pre-publish, non-persisting) | ✅ built | `POST …/[id]/check-compat` (button + live) |
| 8 | **Live/auto compatibility feedback** as you edit | ✅ built | debounced 500 ms dry-run (in-process validator) |
| 9 | Registration **blocked on incompatible schema** with named violations | ✅ built | 409 → violation list surfaced in dialog |
| 10 | **Versions view** — full schema per version, latest badge | ✅ built | Versions tab version cards |
| 11 | **Compatibility policy** BACKWARD / FORWARD / FULL / NONE | ✅ built | Compatibility tab dropdown → `PATCH …/[id]` |
| 12 | Show which backend enforces (EH Schema Registry vs in-process) | ✅ built | policy badge + MessageBar (`compatBackend`) |
| 13 | Delegate enforcement to **Event Hubs Schema Registry** | ✅ built (opt-in) | set `LOOM_EH_SCHEMA_GROUP`; `check-compat` uses `eventhubs-sr` |
| 14 | **Settings** — id, default format, policy, enforced-by, external registry | ✅ built | Settings tab grid |
| 15 | Avro structural evolution rules (add/remove field, defaults, promotion) | ✅ built | in-process Avro validator |
| 16 | JSON Schema / Protobuf **structural** compatibility checks | ❌ MISSING | treated as NONE (matches EH SR behavior — disclosed in the MessageBar) |
| 17 | Delete a subject / a version / a schema set | ❌ MISSING | create + register + policy only; no delete affordance |
| 18 | Consumer/producer usage view (which streams reference a subject) | ❌ MISSING | not surfaced in this editor |

**Grade: B.** The core registry loop — create set → register version → **enforced
compatibility (with live dry-run + blocking violations)** → policy management → per-version
history — is real and Cosmos/EH-SR backed, with the JSON/Protobuf-NONE limitation
honestly disclosed in-surface (not hidden). Gaps are delete affordances and a
cross-reference usage view — tracked, not stubs; never Fabric-gated.
