/**
 * Shared "Generate descriptions" (bulk AI auto-description) catalog action for
 * the Loom-native tabular Model view. Used by the warehouse / synapse / and
 * Databricks `…/model` BFF routes.
 *
 * Two operations, both grounded on the REAL Azure OpenAI backend
 * (lib/copilot/dax-describe.ts — the SAME backend the per-measure DAX Copilot
 * uses) and persisted Azure-native in Cosmos (item.state.model). No mocks, no
 * `return []` placeholder, no Power BI / Fabric dependency
 * (no-vaporware.md + no-fabric-dependency.md):
 *
 *   describe-all      → POST proposals for EVERY measure + table (no write).
 *                       Returns { proposals: { measures[], tables[] } } for the
 *                       review dialog. When AOAI isn't configured it returns an
 *                       honest gate (200, aiUnavailable:true) naming the env var.
 *   save-descriptions → POST the approved { measures[], tables[] } and persist
 *                       them via applyDescriptions → writeModelState.
 *
 * Underscore-prefixed folder — Next.js does not treat this as a route.
 */

import { NextResponse } from 'next/server';
import {
  readModelState, writeModelState, applyDescriptions,
  type DescriptionUpdate,
} from './model-store';
import {
  proposeMeasureDescriptions, proposeTableDescriptions,
  type DescribeMeasureInput, type DescribeTableInput,
} from '@/lib/copilot/dax-describe';

/** Minimal table shape the describe action needs (matches the route ModelTable). */
export interface DescribeTable {
  id: string;
  name: string;
  columns?: Array<{ name: string; type?: string }>;
}

/** True when an Azure OpenAI chat target is configured for this deployment. */
export function aiConfigured(): boolean {
  return !!(process.env.LOOM_AOAI_ENDPOINT && process.env.LOOM_AOAI_DEPLOYMENT);
}

const AI_GATE = {
  ok: false as const,
  aiUnavailable: true as const,
  missing: 'LOOM_AOAI_ENDPOINT',
  detail:
    'AI auto-description needs an Azure OpenAI chat deployment. Set LOOM_AOAI_ENDPOINT (the AOAI account ' +
    'endpoint) and LOOM_AOAI_DEPLOYMENT (the chat deployment name) on the Console container app, and grant ' +
    'the Console UAMI the "Cognitive Services OpenAI User" role on that account. No Microsoft Fabric / Power ' +
    'BI workspace required.',
};

/**
 * Run the bulk auto-describe over a model's measures + the live tables. Returns
 * an honest gate response (200) when AOAI isn't configured, otherwise proposals
 * for measures and tables. Never writes.
 */
export async function handleDescribeAll(opts: {
  itemId: string;
  itemType: string;
  tenantId: string;
  tables: DescribeTable[];
}): Promise<NextResponse> {
  const { itemId, itemType, tenantId, tables } = opts;
  const { state: model, itemFound } = await readModelState(itemId, itemType, tenantId);
  if (!itemFound) return NextResponse.json({ ok: false, error: 'item not found' }, { status: 404 });

  if (!aiConfigured()) {
    return NextResponse.json(AI_GATE);
  }

  const measureInputs: DescribeMeasureInput[] = model.measures.map((m) => ({
    name: m.name,
    expression: m.expression,
    description: m.description,
  }));
  const tableInputs: DescribeTableInput[] = (tables || []).map((t) => ({
    id: t.id,
    name: t.name,
    columns: t.columns,
  }));

  if (measureInputs.length === 0 && tableInputs.length === 0) {
    return NextResponse.json({
      ok: true,
      proposals: { measures: [], tables: [] },
      note: 'No measures or tables found to describe. Add measures, or resume the compute to load tables, then re-run.',
    });
  }

  try {
    const [measures, tableProposals] = await Promise.all([
      proposeMeasureDescriptions(measureInputs, tenantId),
      proposeTableDescriptions(tableInputs, tenantId),
    ]);
    return NextResponse.json({
      ok: true,
      proposals: { measures, tables: tableProposals },
      note: 'These are PROPOSED descriptions — nothing was saved. Review and edit, then click "Save descriptions" to persist them to the model catalog.',
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

/** Body shape for save-descriptions. */
export interface SaveDescriptionsBody {
  measures?: Array<{ name?: string; description?: string }>;
  tables?: Array<{ name?: string; description?: string }>;
}

/** Persist approved measure + table descriptions to the Loom model (Cosmos). */
export async function handleSaveDescriptions(opts: {
  itemId: string;
  itemType: string;
  tenantId: string;
  body: SaveDescriptionsBody;
}): Promise<NextResponse> {
  const { itemId, itemType, tenantId, body } = opts;
  const measureUpdates: DescriptionUpdate[] = (body.measures || [])
    .filter((d) => d && typeof d.name === 'string' && typeof d.description === 'string' && d.description!.trim())
    .map((d) => ({ name: d.name!.trim(), description: d.description!.trim() }));
  const tableUpdates: DescriptionUpdate[] = (body.tables || [])
    .filter((d) => d && typeof d.name === 'string' && typeof d.description === 'string' && d.description!.trim())
    .map((d) => ({ name: d.name!.trim(), description: d.description!.trim() }));

  if (measureUpdates.length === 0 && tableUpdates.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'Provide at least one measure or table description to save.' },
      { status: 400 },
    );
  }

  const { state: model, itemFound } = await readModelState(itemId, itemType, tenantId);
  if (!itemFound) return NextResponse.json({ ok: false, error: 'item not found' }, { status: 404 });

  const { next, measuresUpdated, tablesUpdated } = applyDescriptions(model, measureUpdates, tableUpdates);
  const ok = await writeModelState(itemId, itemType, tenantId, next);
  if (!ok) return NextResponse.json({ ok: false, error: 'failed to persist descriptions' }, { status: 500 });

  return NextResponse.json({
    ok: true,
    measuresUpdated,
    tablesUpdated,
    measures: next.measures,
    tableDescriptions: next.tableDescriptions || {},
  });
}
