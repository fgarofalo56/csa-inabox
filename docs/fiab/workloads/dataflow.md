# Dataflow Gen2 — workload reference

> **Family:** Data Engineering
> **Loom slug:** `dataflow`
> **Editor file:** `apps/fiab-console/lib/editors/dataflow-gen2-editor.tsx`
> **BFF routes:** `app/api/items/dataflow/**`
> **Parity spec:** [`fiab/dataflow-parity-spec.md`](../dataflow-parity-spec.md)

## Purpose

Power Query / M-language dataflow. The Loom workspace item stores the
M (Power Query) source as a base64 inline part (`mashup.pq`) plus
optional dataflow settings. Refresh dispatches to ADF Mapping Data Flow
or Power Query Online endpoint based on what's deployed.

## Fabric-parity gap

| Fabric feature | Loom state |
|---|---|
| Edit M code | Shipped — Monaco with `language=powerquery` (best-effort) |
| Save | Shipped — PUT inline `mashup.pq` |
| Refresh | Shipped — calls `/api/items/dataflow/[id]/refresh` |
| Visual M designer | Not wired — text-only editor |
| Lineage view | Gated — Purview integration deferred |

## Real backend it calls

- Cosmos `items` for dataflow metadata + M source.
- ADF Mapping Data Flow refresh (when ADF is the dataflow target) via
  `adf-client.ts`.

## Sample usage

1. Open `/items/dataflow/new?workspaceId=…`.
2. Author M in the editor (or paste from Power Query Online).
3. **Save** → persists to Cosmos.
4. **Refresh** → triggers the configured dataflow runtime.

## Bicep + env vars

| Env | Purpose | Bicep module |
|---|---|---|
| `LOOM_ADF_NAME` | Refresh dispatch target | `landing-zone/adf.bicep` |
| `LOOM_DLZ_RG` | Resource group | `landing-zone/main.bicep` |
| `LOOM_UAMI_CLIENT_ID` | Console UAMI | `identity.bicep` |
