# Stream Analytics Job — workload reference

> **Family:** Data Engineering
> **Loom slug:** `stream-analytics-job`
> **Editor file:** `apps/fiab-console/lib/editors/stream-analytics-editor.tsx`
> **BFF routes:** `app/api/items/stream-analytics-job/**`
> **Bicep module:** `platform/fiab/bicep/modules/landing-zone/stream-analytics.bicep` (added in the Data Engineering sweep, 2026-05-27)

## Purpose

Authoring + lifecycle control for Azure Stream Analytics (ASA) jobs.
Replaces the deprecated U-SQL / ADLA editor (the underlying service is
retired). The editor lists every ASA job in the configured RG, shows
state (`Stopped` / `Starting` / `Started` / `Stopping` / `Failed`),
exposes the SAQL query (Stream Analytics Query Language — SQL over
time-windowed streams), and supports **Save query** / **Start** /
**Stop** via ARM REST.

## Fabric-parity gap

Stream Analytics is **not** a Fabric native item — Fabric's equivalent
is Eventstream (which Loom ships as a separate editor, `eventstream`).
ASA exists in this catalog for the streaming use-cases that need:

- Native joins across Event Hubs + Blob/SQL reference data
- ASA's deterministic windowing semantics
- Customers who already run ASA in production

| Capability | Loom state |
|---|---|
| List jobs | Shipped — ARM `streamingjobs?api-version=2020-03-01` |
| Job detail (inputs/outputs/transformation) | Shipped — `$expand=inputs,outputs,transformation,functions` |
| Edit + save SAQL query | Shipped — PUT `streamingjobs/{name}/transformations/{xName}` |
| Start / Stop | Shipped — POST `/start` and `/stop` |
| Create new input / output | Gated — surfaced as MessageBar pointing at portal until v2 |
| Monitoring metrics (SU%, watermark) | Surfaced from `lastOutputEventTime` + `streamingUnits`; deep Azure Monitor link is roadmap |

## Real backend it calls

- `@/lib/azure/stream-analytics-client.ts` (added in this sweep) — ARM
  REST against `Microsoft.StreamAnalytics/streamingjobs` using
  ChainedTokenCredential(UAMI, default).
- 501 gating: if `LOOM_ASA_RG` is unset, the BFF returns
  `{ok: false, hint: …}` with the env var + bicep module the operator
  must wire. The editor renders that as a Fluent `MessageBar`.

## Sample usage

1. Deploy the optional ASA module with `enableStreamAnalytics=true`.
2. Open `/items/stream-analytics-job`.
3. Pick a job from the left list.
4. Edit the SAQL query (e.g. tumbling-window average per device).
5. **Save** to PUT the transformation.
6. **Start** to begin processing.

## Bicep + env vars

| Env | Purpose | Bicep module |
|---|---|---|
| `LOOM_ASA_RG` | RG containing ASA jobs | `landing-zone/stream-analytics.bicep` |
| `LOOM_ASA_SUB` | Subscription (defaults to `LOOM_SUBSCRIPTION_ID`) | same |
| `LOOM_UAMI_CLIENT_ID` | Console UAMI | `identity.bicep` |

The UAMI needs `Stream Analytics Contributor` on the configured RG;
the bicep module issues that role assignment automatically.
