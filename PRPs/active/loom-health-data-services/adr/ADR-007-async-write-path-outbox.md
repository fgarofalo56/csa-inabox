# ADR-007 — Async write path: transactional outbox, Event Hubs, idempotent consumers

Status: Proposed. Date: 2026-10-22. Evidence: `../research/terminology-conformance-ops-facts.md` section C (Event Hubs limits), `../research/azure-gov-availability.md`.

## Context
Downstream consumers (lakehouse sink, subscriptions, DICOM-to-FHIR
`ImagingStudy`, audit index, MPI) must never lose a change and must never slow
the synchronous write path. Event Hubs Premium/Dedicated are in Gov audit
scope (research; Premium/Dedicated Gov SKU availability UNVERIFIED — W0 confirms).

## Options
1. Engine-native subscriptions pushing to consumers — rejected: at-most-once in practice, no replay.
2. Change-data-capture from PostgreSQL (logical decoding) — strong, but couples consumers to engine schemas; kept as the backfill tool.
3. **Transactional outbox** in each tenant database written in the same transaction as the resource (engine interceptor for HAPI; dcm4chee's audit/export hooks for DICOM), relayed to Event Hubs by a relay worker with offsets, consumed idempotently — chosen.
4. Service Bus instead of Event Hubs — Service Bus is the right fit for work queues (conversion jobs, de-id jobs, export jobs: FIFO, dead-letter, sessions); Event Hubs for the change stream (replayable log). **Both are used, by role.**

## Decision
- Outbox row: `(seq bigserial, tenant, kind: fhir|dicom, resourceType, id, versionId, op, occurredAt, hash)`; no payload (consumers fetch by id/version; keeps PHI out of the event path).
- Relay: one worker per tenant partition, publishes to the tenant's hub with `seq` as the idempotency key; marks rows relayed; retention 7 days in the table, 90 days in Event Hubs Premium (cited max).
- Consumers: `(tenant, kind, id, versionId)` upsert semantics; a consumer records the highest contiguous `seq` and alerts on a gap > 60 s (the "exactly-once-ish" contract: at-least-once + idempotent + gap detection).
- Work queues (conversion, de-id, export, reindex, evacuation copy) use Service Bus queues/sessions with dead-letter + alert; KEDA scales workers on queue length.
- Change feed APIs exposed to tenants (AHDS shape) read from the outbox table with `seq` paging.

## Consequences
A second durable write per resource (one row); relay lag is an SLO (5 s p95).
Replay/backfill is a query over the outbox or a CDC run, both without touching
the engines' hot path.

## Reversal cost
Low; the outbox table is additive and consumers are isolated.
