---
name: loom-data-pipeline
description: Azure-native data pipeline in CSA Loom — back it with a Synapse pipeline (or ADF), never a Fabric Data pipeline. Call synapse-dev-client.ts + adf-client.ts via /api/adf and /api/synapse. Triggers on data pipeline, copy activity, dataflow, orchestration, trigger, integration runtime, ADF, Synapse pipeline.
allowed-tools: Read, Grep, Glob, Bash
---

# loom-data-pipeline — Synapse pipeline / ADF (the Azure-native Fabric Data pipeline)

A Loom **data-pipeline** is a **Synapse pipeline** (or Azure Data Factory) with
copy/dataflow/notebook activities. It is NOT a Fabric Data pipeline.

## Clients

`apps/fiab-console/lib/azure/adf-client.ts` and `synapse-dev-client.ts` (the
Synapse dev/artifacts plane). `cloud-endpoints.ts` supplies the ADF Studio
deep-link base (`adfStudioBase()`, `adfFactoryDeepLinkId()`).

Real exported symbols:

```ts
// adf-client.ts
export function adfConfigGate(): { missing: string } | null;   // honest gate
export function factoryResourceId(): string;
export function defaultFactoryName(): string;
export async function getDefaultFactory(): Promise<{ /* id, name, location, ... */ }>;
export interface AdfPipeline { /* name, properties: { activities, parameters } */ }
export async function listPipelines(): Promise<AdfPipeline[]>;
export async function getPipeline(name: string): Promise<AdfPipeline>;
export async function getPipelineParameters(name: string): Promise<...>;
export async function upsertPipeline(name: string, spec: AdfPipeline): Promise<AdfPipeline>;
export async function deletePipeline(name: string): Promise<void>;
export interface PipelineRunResponse { runId: string; }
export async function runPipeline(/* name, params */): Promise<PipelineRunResponse>;
```

`armBase()` (used inside `adf-client.ts` as the gold-standard `armBase()` the
cloud-endpoints module mirrors) keeps the control-plane host sovereign-correct.

## Auth

UAMI-first chain at `armScope()`. The UAMI needs **Data Factory Contributor**
(or Synapse equivalent) on the factory/workspace (bicep `integration`).

## BFF routes

`/api/adf/**` and `/api/synapse/**`. Validate session → `adfConfigGate()` →
real ARM call (`listPipelines()`, `runPipeline()`, …) → `{ ok, data }`. The UI
canvas builds the pipeline JSON; the route persists it via `upsertPipeline()`.

## Do / don't

- DO author activities through the canvas → `upsertPipeline()`; trigger via
  `runPipeline()` and poll the real `runId`.
- DO offer the ADF Studio deep-link via `adfStudioBase()` + `adfFactoryDeepLinkId()`.
- DON'T call the Fabric pipeline REST API on the default path.
- DON'T present a raw-JSON textbox as the only editor — use the canvas/guided
  forms (loom-no-freeform-config).

## Cross-links

UI parity: `docs/fiab/parity/adf-pipeline.md`, `adf-*`, `synapse-*`. Backend map
row: data-pipeline in `.claude/rules/no-fabric-dependency.md`.
