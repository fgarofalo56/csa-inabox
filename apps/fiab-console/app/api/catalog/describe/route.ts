/**
 * POST /api/catalog/describe
 *
 * Bulk AI auto-description for a semantic-model catalog asset. Surfaced as the
 * "Generate AI descriptions" action on the OneLake catalog detail page
 * (CrossSourceActions, source='onelake'). It generates business-friendly
 * descriptions for EVERY measure AND table column on a Loom-native semantic
 * model in one shot — the catalog-level companion to the DAX Copilot's
 * per-measure `dax_describe_model` tool.
 *
 * Azure-native by default (.claude/rules/no-fabric-dependency.md): the model
 * metadata is read from / written to the Cosmos `items` container
 * (item.state.content for content-backed models + item.state.model for
 * editor-authored measures). Descriptions are produced by Azure OpenAI
 * (cloud-aware via resolveAoaiTarget). NO api.fabric.microsoft.com /
 * api.powerbi.com call anywhere on this path — it works with
 * LOOM_DEFAULT_FABRIC_WORKSPACE UNSET.
 *
 * Body: {
 *   itemId:   string,                 // the catalog asset id (loom: prefix tolerated)
 *   itemType?: string,                // defaults to 'semantic-model'
 *   apply?:   boolean,                // false (default) → proposals only; true → persist
 *   targets?: ('measures'|'columns')[],  // default both
 *   overwrite?: boolean,              // when applying, replace existing descriptions (default false: only fill blanks)
 * }
 *
 * 200 OK → {
 *   ok: true, applied: boolean,
 *   measures: DescribeProposal[], columns: DescribeProposal[],
 *   counts: { measures, columns, applied? }, backend: 'loom-native'
 * }
 * 200 (honest gate) → { ok: false, aoaiUnavailable: true, missing, detail }
 * 4xx → { ok: false, error }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  isLoomContentId, cosmosIdFromLoomId, loadContentBackedItem,
} from '../../items/_lib/pbi-content-fallback';
import { readModelState } from '../../items/_lib/model-store';
import {
  resolveBulkDescribeTarget, generateMeasureDescriptions, generateColumnDescriptions,
  AoaiNotConfiguredError,
  type DescribeProposal, type MeasureInput, type ColumnInput,
} from '@/lib/copilot/bulk-describe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DescribeBody {
  itemId?: string;
  itemType?: string;
  apply?: boolean;
  targets?: string[];
  overwrite?: boolean;
}

interface ContentTable {
  name: string;
  columns?: Array<{ name: string; dataType?: string; description?: string }>;
}
interface ContentMeasure {
  table: string;
  name: string;
  expression?: string;
  description?: string;
}

/** Collect the model's measures (content + model-store) and table columns. */
function collectModelObjects(
  content: { tables?: ContentTable[]; measures?: ContentMeasure[] } | undefined,
  storedMeasures: Array<{ name: string; expression?: string }>,
): { measures: MeasureInput[]; columns: ColumnInput[] } {
  const measureMap = new Map<string, MeasureInput>();
  for (const m of content?.measures || []) {
    if (m?.name) measureMap.set(m.name, { name: m.name, expression: m.expression });
  }
  for (const m of storedMeasures) {
    if (m?.name && !measureMap.has(m.name)) measureMap.set(m.name, { name: m.name, expression: m.expression });
  }
  const columns: ColumnInput[] = [];
  for (const t of content?.tables || []) {
    for (const c of t.columns || []) {
      if (c?.name) columns.push({ table: t.name, name: c.name, dataType: c.dataType });
    }
  }
  return { measures: [...measureMap.values()], columns };
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;

  const body = (await req.json().catch(() => ({}))) as DescribeBody;
  const rawId = String(body.itemId || '').trim();
  if (!rawId) return NextResponse.json({ ok: false, error: 'itemId is required' }, { status: 400 });
  const itemType = (body.itemType || 'semantic-model').trim() || 'semantic-model';
  const apply = body.apply === true;
  const overwrite = body.overwrite === true;
  const targets = Array.isArray(body.targets) && body.targets.length
    ? body.targets
    : ['measures', 'columns'];
  const wantMeasures = targets.includes('measures');
  const wantColumns = targets.includes('columns');

  // Resolve the Cosmos item id (catalog ids may carry the loom: prefix).
  const cosmosId = isLoomContentId(rawId) ? cosmosIdFromLoomId(rawId) : rawId;

  // Load the content-backed item (source of truth for tables/columns/measures).
  const item = await loadContentBackedItem(cosmosId, itemType, tenantId);
  if (!item) {
    return NextResponse.json(
      { ok: false, error: `Semantic model ${rawId} not found or not owned by you.` },
      { status: 404 },
    );
  }
  const content = ((item.state as any)?.content || {}) as { kind?: string; tables?: ContentTable[]; measures?: ContentMeasure[] };

  // Editor-authored measures live in item.state.model (model-store).
  const { state: modelState } = await readModelState(cosmosId, itemType, tenantId);

  const { measures, columns } = collectModelObjects(content, modelState.measures || []);

  if ((!wantMeasures || measures.length === 0) && (!wantColumns || columns.length === 0)) {
    return NextResponse.json({
      ok: true,
      applied: false,
      measures: [],
      columns: [],
      counts: { measures: 0, columns: 0 },
      backend: 'loom-native',
      note: 'This model has no measures or table columns to describe yet. Define tables/measures first, then re-run.',
    });
  }

  // Resolve the AOAI target — honest gate (200) when not configured.
  let target;
  try {
    target = await resolveBulkDescribeTarget(tenantId);
  } catch (e: any) {
    if (e instanceof AoaiNotConfiguredError) {
      return NextResponse.json({ ok: false, aoaiUnavailable: true, missing: e.missing, detail: e.detail });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }

  // Generate descriptions (measures + columns in parallel).
  let measureProposals: DescribeProposal[] = [];
  let columnProposals: DescribeProposal[] = [];
  try {
    [measureProposals, columnProposals] = await Promise.all([
      wantMeasures ? generateMeasureDescriptions(target, measures) : Promise.resolve([]),
      wantColumns ? generateColumnDescriptions(target, columns) : Promise.resolve([]),
    ]);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }

  if (!apply) {
    return NextResponse.json({
      ok: true,
      applied: false,
      measures: measureProposals,
      columns: columnProposals,
      counts: { measures: measureProposals.length, columns: columnProposals.length },
      backend: 'loom-native',
      note: 'These are PROPOSED descriptions — nothing was written. Re-POST with apply:true to persist them to the model in Cosmos (Azure-native, no Fabric/Power BI).',
    });
  }

  // ── Persist back to the item's Cosmos content (Azure-native source of truth) ──
  const measureDesc = new Map(measureProposals.map((p) => [p.name, p.description]));
  const columnDesc = new Map(columnProposals.map((p) => [p.name.toLowerCase(), p.description]));
  let appliedMeasures = 0;
  let appliedColumns = 0;

  const nextMeasures = (content.measures || []).map((m) => {
    const proposed = measureDesc.get(m.name);
    if (proposed && (overwrite || !m.description)) {
      appliedMeasures += 1;
      return { ...m, description: proposed };
    }
    return m;
  });

  const nextTables = (content.tables || []).map((t) => {
    const cols = (t.columns || []).map((c) => {
      const proposed = columnDesc.get(`${t.name}.${c.name}`.toLowerCase());
      if (proposed && (overwrite || !c.description)) {
        appliedColumns += 1;
        return { ...c, description: proposed };
      }
      return c;
    });
    return { ...t, columns: cols };
  });

  const nextContent = {
    ...content,
    kind: content.kind || 'semantic-model',
    ...(wantMeasures ? { measures: nextMeasures } : {}),
    ...(wantColumns ? { tables: nextTables } : {}),
  };
  const next: WorkspaceItem = {
    ...item,
    state: { ...(item.state || {}), content: nextContent },
    updatedAt: new Date().toISOString(),
  } as WorkspaceItem;

  try {
    const items = await itemsContainer();
    await items.item(item.id, item.workspaceId).replace(next);
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `Generated descriptions but failed to persist: ${e?.message || String(e)}` },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    applied: true,
    measures: measureProposals,
    columns: columnProposals,
    counts: {
      measures: measureProposals.length,
      columns: columnProposals.length,
      appliedMeasures,
      appliedColumns,
      applied: appliedMeasures + appliedColumns,
    },
    backend: 'loom-native',
    note: `Wrote ${appliedMeasures} measure + ${appliedColumns} column description(s) to the model in Cosmos. They surface on the model's Tables/Measures tabs and are emitted in TMSL at provision time. No Microsoft Fabric / Power BI workspace required.`,
  });
}
