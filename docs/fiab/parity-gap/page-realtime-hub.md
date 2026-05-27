# Parity gap — `/realtime-hub`

**Loom route:** `/realtime-hub` (rendered by `apps/fiab-console/app/realtime-hub/page.tsx` → `ItemsByTypePane` filtered to eventstream, eventhouse, kql-database, kql-queryset, kql-dashboard, activator)
**Fabric reference:** Microsoft Fabric Real-Time hub — https://learn.microsoft.com/fabric/real-time-hub/real-time-hub-overview (28 streaming sources, Microsoft / External / Fabric event categories)
**Loom screenshot:** `temp/parity/page-realtime-hub-loom.png` — 4 real items rendered
**Captured:** 2026-05-26

## Phase 3 — Side-by-side gap matrix

| # | Fabric Real-Time hub element | Loom Real-Time hub element | Status | Severity |
|---|---|---|---|---|
| 1 | Page header "Real-Time hub" | Present with full subtitle | present | — |
| 2 | Tab strip: All data streams / Microsoft sources / Fabric events / My streams | Not present — flat grid only | missing | MAJOR |
| 3 | "Connect data source" wizard with 28 source connectors (IoT Hub, Event Hubs, Azure SQL CDC, Kafka, Cosmos changefeed, Pub/Sub, Kinesis, Confluent, ServiceBus, AWS S3, GCP, etc.) | "New item" opens generic Fabric-style picker (no streaming-source wizard) | missing | MAJOR |
| 4 | Stream cards showing source type icon, throughput, last event timestamp | Cards show item type + name + Updated date, no throughput / live indicator | partial | MAJOR |
| 5 | Filter input | Present (real client-side filter) | present | — |
| 6 | Microsoft / External / Fabric event grouping | Not grouped — flat list | missing | MAJOR |
| 7 | Per-stream "Set destination" / "Add transformation" / "Add Activator alert" actions | Not present on cards (would be inside item editor) | missing | MAJOR |
| 8 | Live/stopped state indicator per stream | Not present | missing | MAJOR |
| 9 | "Recent events preview" per stream | Not present | missing | MINOR |
| 10 | Lineage hint per stream | Not present | missing | MINOR |
| 11 | Activator alerts surface | `activator` is in the included item types but no specific alerts panel | partial | MINOR |
| 12 | Empty state | "No real-time items in this tenant yet" | present | — |

## Phase 4 — Functional verification

| Control | Source | Result |
|---|---|---|
| Filter input | Real client-side filter on `displayName + description` | OK |
| + New item | Generic `NewItemDialog` (not streaming-source wizard) | OK as generic |
| Item card link | href `/items/[type]/[id]` | OK |
| Backend | `/api/items/by-type?type=eventstream&type=eventhouse&type=kql-database&...` Cosmos query | OK |
| 4 live items rendered | Real Cosmos records (parity-kql-queryset, parity-kql-database, parity-eventhouse, parity-eventstream) | OK |

## Honest grade

**Grade: C+**

Reasoning:
- Phase 3: 0 BLOCKER, 6 MAJOR (no tab grouping, no source-connector wizard, no live state, no per-stream actions, no Microsoft/External/Fabric grouping, no throughput).
- Phase 4: 0 BROKEN — what's there is real.
- The page renders 4 real items with real navigation. It is *not* vaporware.
- BUT it is a thin re-skin of `/onelake` catalog (same `ItemsByTypePane`) filtered to real-time types. Fabric's Real-Time hub has a distinctive UX (28 source connectors + Microsoft/External/Fabric tabs + per-stream live state) that Loom doesn't approximate.

Not D because no fake data is rendered. Not B because Loom's Real-Time hub is essentially a category-filter of OneLake catalog rather than a distinct hub.

## Recommended next actions

1. Add a 3-tab structure: **All streams / Microsoft sources / Fabric events** (per Fabric's Real-Time hub).
2. Add a "Connect data source" wizard with at least the 12 most-used connectors (IoT Hub, Event Hubs, Azure SQL CDC, Cosmos changefeed, Kafka, Kinesis, ServiceBus, AWS S3, Pub/Sub, Confluent, Snowflake CDC, Postgres logical replication) — each wiring to a real bicep module per the no-vaporware bicep-sync requirement.
3. Per-card live state indicator (Live / Stopped / Errored) — wired to the real Eventstream API state.
4. Per-card "Recent events" sparkline + "Set destination" + "Add Activator alert" quick actions.
5. Move Activator alerts to a dedicated section ("Active alerts") within Real-Time hub rather than mixing with stream sources.
