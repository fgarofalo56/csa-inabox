/**
 * lib/semantic-model/calc-objects.ts
 *
 * The semantic model's calculation groups + field parameters (Advanced tab,
 * concern B), extracted verbatim from
 * app/api/items/semantic-model/[id]/model/route.ts (rel-T64) — behaviour-
 * preserving. The DEFAULT (loom-native) path persists to the item's Cosmos
 * content (emitted in TMSL at provision time); opt-in AAS-XMLA / Fabric writes are
 * each honestly gated. Also owns `backendName()` — the LOOM_SEMANTIC_BACKEND
 * selector the route's GET reads.
 */

import { NextRequest, NextResponse } from 'next/server';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  getFabricModelDefinition, updateFabricModelDefinition, PowerBiError,
  type TmslCalcGroup, type FieldParamDef, type ModelWriteRequest,
} from '@/lib/azure/powerbi-client';
import {
  isLoomContentId, cosmosIdFromLoomId, loadContentBackedItem,
} from '@/app/api/items/_lib/pbi-content-fallback';
import {
  aasAvailabilityGate, executeTmsl, buildCalcGroupTmsl, buildFieldParamTmsl, AasError,
} from '@/lib/azure/aas-client';

export function backendName(): string {
  return (process.env.LOOM_SEMANTIC_BACKEND || 'loom-native').trim().toLowerCase();
}

/** Decode a Fabric definition part (base64) into JSON. */
function decodePart(payload: string): any {
  return JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));
}

function encodePart(obj: any): string {
  return Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64');
}

/** Locate the model.bim (TMSL) part in a Fabric definition payload. */
function findModelPart(parts: { path: string; payload: string }[]): { path: string; payload: string } | undefined {
  return parts.find((p) => /model\.bim$/i.test(p.path)) || parts.find((p) => {
    try { return !!decodePart(p.payload)?.model; } catch { return false; }
  });
}

/** Reconstruct calc groups + field params from a TMSL model object. */
function extractFromTmsl(bim: any): { calculationGroups: TmslCalcGroup[]; fieldParameters: FieldParamDef[] } {
  const tables: any[] = Array.isArray(bim?.model?.tables) ? bim.model.tables : [];
  const calculationGroups: TmslCalcGroup[] = [];
  const fieldParameters: FieldParamDef[] = [];
  for (const t of tables) {
    if (t.calculationGroup) {
      calculationGroups.push({
        name: t.name,
        precedence: Number(t.calculationGroup.precedence) || 0,
        items: (t.calculationGroup.calculationItems || []).map((ci: any) => ({
          name: ci.name,
          expression: ci.expression,
          formatStringDefinition: ci.formatStringDefinition?.expression,
          ordinal: typeof ci.ordinal === 'number' ? ci.ordinal : undefined,
        })),
      });
    } else if ((t.annotations || []).some((a: any) => a.name === 'PBI_ResultType' && a.value === 'Table')
      && /NAMEOF/i.test(String(t.partitions?.[0]?.source?.expression || ''))) {
      const dax = String(t.partitions[0].source.expression);
      const fields: FieldParamDef['fields'] = [];
      const re = /\(\s*"((?:[^"]|"")*)"\s*,\s*NAMEOF\(([^)]+)\)\s*,\s*(\d+)\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(dax)) !== null) {
        fields.push({ displayName: m[1].replace(/""/g, '"'), fieldRef: m[2].trim(), order: Number(m[3]) });
      }
      fieldParameters.push({ name: t.name, fields });
    }
  }
  return { calculationGroups, fieldParameters };
}

/**
 * Load calc groups + field parameters for the GET response. Never throws — a
 * backend read failure degrades to empty arrays so the model-view payload still
 * renders. Returns the effective backend used.
 */
export async function loadCalcObjects(
  req: NextRequest, id: string, tenantId: string,
): Promise<{ calculationGroups: TmslCalcGroup[]; fieldParameters: FieldParamDef[]; backend: string }> {
  const backend = backendName();
  if (backend === 'fabric') {
    const workspaceId = req.nextUrl.searchParams.get('workspaceId') || process.env.LOOM_DEFAULT_FABRIC_WORKSPACE;
    if (workspaceId && !isLoomContentId(id)) {
      try {
        const def = await getFabricModelDefinition(workspaceId, id);
        const modelPart = findModelPart(def.definition?.parts || []);
        const bim = modelPart ? decodePart(modelPart.payload) : null;
        const { calculationGroups, fieldParameters } = extractFromTmsl(bim);
        return { calculationGroups, fieldParameters, backend };
      } catch {
        // fall through to Cosmos content
      }
    }
  }
  const item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'semantic-model', tenantId);
  const content = (item?.state as any)?.content || {};
  return {
    calculationGroups: Array.isArray(content.calculationGroups) ? content.calculationGroups : [],
    fieldParameters: Array.isArray(content.fieldParameters) ? content.fieldParameters : [],
    backend: backend === 'fabric' ? 'loom-native' : backend,
  };
}

function validateCalcGroups(groups: TmslCalcGroup[]): string | null {
  for (const cg of groups) {
    if (!cg.name || !cg.name.trim()) return 'Each calculation group needs a name.';
    if (!Array.isArray(cg.items) || cg.items.length === 0) return `Calculation group '${cg.name}' needs at least one item.`;
    for (const it of cg.items) {
      if (!it.name || !it.name.trim()) return `An item in '${cg.name}' is missing a name.`;
      if (!it.expression || !it.expression.trim()) return `Item '${it.name}' in '${cg.name}' is missing a DAX expression.`;
    }
  }
  return null;
}

function validateFieldParams(params: FieldParamDef[]): string | null {
  for (const fp of params) {
    if (!fp.name || !fp.name.trim()) return 'Each field parameter needs a name.';
    if (!Array.isArray(fp.fields) || fp.fields.length === 0) return `Field parameter '${fp.name}' needs at least one field.`;
    for (const f of fp.fields) {
      if (!f.displayName || !f.displayName.trim()) return `A field in '${fp.name}' is missing a display name.`;
      if (!f.fieldRef || !f.fieldRef.trim()) return `Field '${f.displayName}' in '${fp.name}' is missing a NAMEOF reference.`;
    }
  }
  return null;
}

async function persistCalcToCosmos(
  id: string,
  tenantId: string,
  calculationGroups: TmslCalcGroup[],
  fieldParameters: FieldParamDef[],
  steps: string[],
): Promise<void> {
  const item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'semantic-model', tenantId);
  if (!item) {
    steps.push('No Cosmos-backed semantic-model item resolved for this id; config not persisted to content (a live-only model id was supplied).');
    return;
  }
  const existingContent = (item.state as any)?.content || { kind: 'semantic-model' };
  const next: WorkspaceItem = {
    ...item,
    state: {
      ...(item.state || {}),
      content: { ...existingContent, kind: 'semantic-model', calculationGroups, fieldParameters },
    },
    updatedAt: new Date().toISOString(),
  } as WorkspaceItem;
  const items = await itemsContainer();
  await items.item(item.id, item.workspaceId).replace(next);
  steps.push(`Saved ${calculationGroups.length} calc group(s) and ${fieldParameters.length} field parameter(s) to this item.`);
}

/** Merge calc groups + field params into a TMSL model object (replace by name). */
function mergeIntoTmsl(bim: any, groups: TmslCalcGroup[], params: FieldParamDef[]): void {
  if (!bim.model) bim.model = {};
  if (!Array.isArray(bim.model.tables)) bim.model.tables = [];
  if (groups.length) bim.model.discourageImplicitMeasures = true;
  const tables: any[] = bim.model.tables;
  const upsert = (tbl: any) => {
    const i = tables.findIndex((t) => t.name === tbl.name);
    if (i >= 0) tables[i] = tbl; else tables.push(tbl);
  };
  for (const cg of groups) {
    upsert({
      name: cg.name,
      calculationGroup: {
        precedence: cg.precedence,
        calculationItems: cg.items.map((ci) => ({
          name: ci.name,
          expression: ci.expression,
          ...(ci.formatStringDefinition ? { formatStringDefinition: { expression: ci.formatStringDefinition } } : {}),
          ...(typeof ci.ordinal === 'number' ? { ordinal: ci.ordinal } : {}),
        })),
      },
      columns: [
        { name: cg.name, dataType: 'string', sourceColumn: 'Name', sortByColumn: 'Ordinal', summarizeBy: 'none' },
        { name: 'Ordinal', dataType: 'int64', isHidden: true, sourceColumn: 'Ordinal', summarizeBy: 'sum' },
      ],
      partitions: [{ name: 'Partition', mode: 'import', source: { type: 'calculationGroup' } }],
    });
  }
  for (const fp of params) {
    const rows = fp.fields.map((f, i) => `\t("${(f.displayName || '').replace(/"/g, '""')}", NAMEOF(${f.fieldRef}), ${typeof f.order === 'number' ? f.order : i})`).join(',\n');
    upsert({
      name: fp.name,
      columns: [
        { name: fp.name, dataType: 'string', sourceColumn: '[Value1]', summarizeBy: 'none' },
        { name: 'Fields', dataType: 'string', sourceColumn: '[Value2]', summarizeBy: 'none', isHidden: true },
        { name: 'Order', dataType: 'int64', sourceColumn: '[Value3]', summarizeBy: 'sum', isHidden: true, sortByColumn: 'Order' },
      ],
      partitions: [{ name: 'Partition', mode: 'import', source: { type: 'calculated', expression: `{\n${rows}\n}` } }],
      annotations: [{ name: 'PBI_ResultType', value: 'Table' }],
    });
  }
}

/** POST handler for the Advanced tab's calc groups + field parameters save. */
export async function handleCalcPost(
  req: NextRequest, id: string, tenantId: string, body: ModelWriteRequest,
): Promise<NextResponse> {
  const calculationGroups = Array.isArray(body.calculationGroups) ? body.calculationGroups : [];
  const fieldParameters = Array.isArray(body.fieldParameters) ? body.fieldParameters : [];
  if (calculationGroups.length === 0 && fieldParameters.length === 0) {
    return NextResponse.json({ ok: false, error: 'Provide at least one calculation group or field parameter.' }, { status: 400 });
  }
  const cgErr = validateCalcGroups(calculationGroups);
  if (cgErr) return NextResponse.json({ ok: false, error: cgErr }, { status: 400 });
  const fpErr = validateFieldParams(fieldParameters);
  if (fpErr) return NextResponse.json({ ok: false, error: fpErr }, { status: 400 });

  const backend = backendName();
  const steps: string[] = [];

  // Always persist to Cosmos content first so the config survives regardless of
  // which engine backend is configured (and so provisioning emits it in TMSL).
  await persistCalcToCosmos(id, tenantId, calculationGroups, fieldParameters, steps);

  if (backend === 'aas') {
    const gate = aasAvailabilityGate();
    if (gate) return NextResponse.json({ ok: false, error: gate.detail, gate, backend, steps }, { status: 400 });
    const server = process.env.LOOM_AAS_SERVER;
    const database = process.env.LOOM_AAS_DATABASE;
    if (!server || !database) {
      return NextResponse.json({
        ok: false,
        backend,
        steps,
        error: 'The AAS backend requires LOOM_AAS_SERVER (asazure://{region}.asazure.windows.net/{server}) and LOOM_AAS_DATABASE (model name). The config has been saved to this item; set these env vars to persist it to the live model.',
      }, { status: 400 });
    }
    try {
      for (const cg of calculationGroups) {
        await executeTmsl(server, database, buildCalcGroupTmsl(database, cg));
        steps.push(`Created/replaced calculation group '${cg.name}' on AAS model ${database}.`);
      }
      for (const fp of fieldParameters) {
        await executeTmsl(server, database, buildFieldParamTmsl(database, fp));
        steps.push(`Created/replaced field parameter '${fp.name}' on AAS model ${database}.`);
      }
    } catch (e: any) {
      const status = e instanceof AasError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e), backend, steps }, { status });
    }
    return NextResponse.json({ ok: true, backend, steps });
  }

  if (backend === 'fabric') {
    const workspaceId = req.nextUrl.searchParams.get('workspaceId') || process.env.LOOM_DEFAULT_FABRIC_WORKSPACE;
    if (!workspaceId || isLoomContentId(id)) {
      return NextResponse.json({
        ok: false,
        backend,
        steps,
        error: 'The Fabric backend requires a bound workspace and a live semantic model id. The config has been saved to this item and will be emitted in TMSL at provision time.',
      }, { status: 400 });
    }
    try {
      const def = await getFabricModelDefinition(workspaceId, id);
      const parts = def.definition?.parts || [];
      const modelPart = findModelPart(parts);
      if (!modelPart) throw new PowerBiError('model.bim part not found in Fabric definition', 422);
      const bim = decodePart(modelPart.payload);
      mergeIntoTmsl(bim, calculationGroups, fieldParameters);
      const nextParts = parts.map((p) => (p.path === modelPart.path ? { ...p, payload: encodePart(bim), payloadType: 'InlineBase64' as const } : p));
      await updateFabricModelDefinition(workspaceId, id, nextParts as any);
      steps.push(`Pushed ${calculationGroups.length} calc group(s) + ${fieldParameters.length} field parameter(s) to Fabric model ${id}.`);
    } catch (e: any) {
      const status = e instanceof PowerBiError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e), backend, steps }, { status });
    }
    return NextResponse.json({ ok: true, backend, steps });
  }

  if (backend === 'powerbi') {
    return NextResponse.json({
      ok: false,
      backend,
      steps,
      error: 'Writing calculation groups + field parameters to a live Power BI model requires the XMLA endpoint (Premium Per User, Premium Per Capacity, or Fabric capacity). Set LOOM_SEMANTIC_BACKEND=aas or =fabric to persist to a live model. The config has been saved to this item for provision-time TMSL.',
      hint: 'https://learn.microsoft.com/power-bi/enterprise/service-premium-connect-tools',
    }, { status: 400 });
  }

  // loom-native DEFAULT — already persisted to Cosmos above.
  steps.push('These will be included in TMSL when the model is provisioned to a tabular engine (AAS or Fabric).');
  return NextResponse.json({ ok: true, backend: 'loom-native', steps });
}
