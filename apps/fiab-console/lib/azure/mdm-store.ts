/**
 * Cosmos-backed MDM stores (tenant-settings docs), Azure-native, no Fabric:
 *   mdm-models:<tenantId>   — match/survivorship model definitions
 *   mdm-refdata:<tenantId>  — managed reference-data / code lists (versioned)
 *   mdm-runs:<tenantId>     — match/merge run history
 *
 * All upserts validate against strict enums (no free-form JSON persisted), echoing
 * the attribute-groups pattern. One doc per tenant per kind.
 */
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import {
  SURVIVORSHIP_STRATEGIES, MATCH_TYPES,
  type MdmModel, type MatchAttribute, type SurvivorshipRule, type SurvivorshipStrategy, type MatchType,
} from '@/lib/azure/mdm-match-merge';

// --------------------------- Models ---------------------------
interface MdmModelsDoc { id: string; tenantId: string; kind: 'mdm-models'; items: MdmModel[]; updatedAt: string }
function modelsId(t: string) { return `mdm-models:${t}`; }

export async function listModels(tenantId: string): Promise<MdmModel[]> {
  const c = await tenantSettingsContainer();
  try {
    const { resource } = await c.item(modelsId(tenantId), tenantId).read<MdmModelsDoc>();
    return resource?.items || [];
  } catch (e: any) { if (e?.code === 404) return []; throw e; }
}

export async function getModel(tenantId: string, id: string): Promise<MdmModel | null> {
  return (await listModels(tenantId)).find((m) => m.id === id) || null;
}

/** Normalize + validate a raw model payload (rejects unknown enums). */
export function normalizeModel(raw: any, fallbackId?: string): { model?: MdmModel; errors: string[] } {
  const errors: string[] = [];
  if (!raw?.name) errors.push('name is required');
  if (!raw?.entity) errors.push('entity is required');
  if (!raw?.sourceTable) errors.push('sourceTable is required');
  if (!raw?.recordIdColumn) errors.push('recordIdColumn is required');
  if (!raw?.goldenTable) errors.push('goldenTable is required');

  const matchAttributes: MatchAttribute[] = (Array.isArray(raw?.matchAttributes) ? raw.matchAttributes : [])
    .map((a: any) => {
      const matchType: MatchType = MATCH_TYPES.includes(a?.matchType) ? a.matchType : 'exact';
      return {
        column: String(a?.column || '').trim(),
        matchType,
        ...(typeof a?.threshold === 'number' ? { threshold: a.threshold } : {}),
      };
    })
    .filter((a: MatchAttribute) => a.column);
  if (!matchAttributes.length) errors.push('at least one match attribute is required');
  if (!matchAttributes.some((a) => a.matchType === 'exact')) {
    errors.push('at least one EXACT match attribute is required (it forms the deterministic golden cluster)');
  }

  const survivorship: SurvivorshipRule[] = (Array.isArray(raw?.survivorship) ? raw.survivorship : [])
    .map((r: any) => {
      const strategy: SurvivorshipStrategy = SURVIVORSHIP_STRATEGIES.includes(r?.strategy) ? r.strategy : 'most-complete';
      return { column: String(r?.column || '').trim(), strategy };
    })
    .filter((r: SurvivorshipRule) => r.column);

  if (errors.length) return { errors };

  const model: MdmModel = {
    id: String(raw?.id || fallbackId || `mdm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    name: String(raw.name).trim(),
    entity: String(raw.entity).trim(),
    sourceTable: String(raw.sourceTable).trim(),
    catalog: raw?.catalog ? String(raw.catalog).trim() : undefined,
    schema: raw?.schema ? String(raw.schema).trim() : undefined,
    recordIdColumn: String(raw.recordIdColumn).trim(),
    sourceSystemColumn: raw?.sourceSystemColumn ? String(raw.sourceSystemColumn).trim() : undefined,
    timestampColumn: raw?.timestampColumn ? String(raw.timestampColumn).trim() : undefined,
    matchAttributes,
    survivorship,
    sourcePriority: Array.isArray(raw?.sourcePriority) ? raw.sourcePriority.map((s: any) => String(s)).filter(Boolean) : undefined,
    goldenTable: String(raw.goldenTable).trim(),
  };
  return { model, errors: [] };
}

export async function upsertModel(tenantId: string, model: MdmModel): Promise<MdmModel[]> {
  const c = await tenantSettingsContainer();
  const id = modelsId(tenantId);
  let doc: MdmModelsDoc;
  try {
    const { resource } = await c.item(id, tenantId).read<MdmModelsDoc>();
    doc = resource || { id, tenantId, kind: 'mdm-models', items: [], updatedAt: '' };
  } catch (e: any) { if (e?.code !== 404) throw e; doc = { id, tenantId, kind: 'mdm-models', items: [], updatedAt: '' }; }
  const idx = doc.items.findIndex((m) => m.id === model.id);
  if (idx >= 0) doc.items[idx] = model; else doc.items.push(model);
  doc.updatedAt = new Date().toISOString();
  await c.items.upsert<MdmModelsDoc>(doc);
  return doc.items;
}

export async function deleteModel(tenantId: string, id: string): Promise<MdmModel[]> {
  const c = await tenantSettingsContainer();
  const did = modelsId(tenantId);
  const items = await listModels(tenantId);
  const next = items.filter((m) => m.id !== id);
  await c.items.upsert<MdmModelsDoc>({ id: did, tenantId, kind: 'mdm-models', items: next, updatedAt: new Date().toISOString() });
  return next;
}

// ----------------------- Reference data -----------------------
export interface RefDataEntry { code: string; label: string; description?: string; active?: boolean }
export interface ReferenceDataSet {
  id: string;
  name: string;
  domain: string;
  description?: string;
  version: number;
  entries: RefDataEntry[];
  updatedAt: string;
}
interface RefDataDoc { id: string; tenantId: string; kind: 'mdm-refdata'; items: ReferenceDataSet[]; updatedAt: string }
function refId(t: string) { return `mdm-refdata:${t}`; }

export async function listReferenceData(tenantId: string): Promise<ReferenceDataSet[]> {
  const c = await tenantSettingsContainer();
  try {
    const { resource } = await c.item(refId(tenantId), tenantId).read<RefDataDoc>();
    return resource?.items || [];
  } catch (e: any) { if (e?.code === 404) return []; throw e; }
}

export function normalizeRefSet(raw: any, prevVersion = 0, fallbackId?: string): { set?: ReferenceDataSet; errors: string[] } {
  const errors: string[] = [];
  if (!raw?.name) errors.push('name is required');
  if (!raw?.domain) errors.push('domain is required');
  const entries: RefDataEntry[] = (Array.isArray(raw?.entries) ? raw.entries : [])
    .map((e: any) => ({
      code: String(e?.code || '').trim(),
      label: String(e?.label || '').trim(),
      description: e?.description ? String(e.description) : undefined,
      active: e?.active !== false,
    }))
    .filter((e: RefDataEntry) => e.code);
  if (errors.length) return { errors };
  const set: ReferenceDataSet = {
    id: String(raw?.id || fallbackId || `ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    name: String(raw.name).trim(),
    domain: String(raw.domain).trim(),
    description: raw?.description ? String(raw.description) : undefined,
    version: prevVersion + 1,
    entries,
    updatedAt: new Date().toISOString(),
  };
  return { set, errors: [] };
}

export async function upsertReferenceData(tenantId: string, raw: any): Promise<{ items: ReferenceDataSet[]; set?: ReferenceDataSet; errors: string[] }> {
  const items = await listReferenceData(tenantId);
  const existing = raw?.id ? items.find((s) => s.id === raw.id) : undefined;
  const { set, errors } = normalizeRefSet(raw, existing?.version || 0, raw?.id);
  if (errors.length || !set) return { items, errors };
  const c = await tenantSettingsContainer();
  const did = refId(tenantId);
  const idx = items.findIndex((s) => s.id === set.id);
  if (idx >= 0) items[idx] = set; else items.push(set);
  await c.items.upsert<RefDataDoc>({ id: did, tenantId, kind: 'mdm-refdata', items, updatedAt: new Date().toISOString() });
  return { items, set, errors: [] };
}

export async function deleteReferenceData(tenantId: string, id: string): Promise<ReferenceDataSet[]> {
  const c = await tenantSettingsContainer();
  const did = refId(tenantId);
  const items = (await listReferenceData(tenantId)).filter((s) => s.id !== id);
  await c.items.upsert<RefDataDoc>({ id: did, tenantId, kind: 'mdm-refdata', items, updatedAt: new Date().toISOString() });
  return items;
}

// ------------------------- Run history -------------------------
export interface MdmRunRecord {
  id: string;
  modelId: string;
  modelName: string;
  kind: 'match' | 'merge';
  ranAt: string;
  ranBy: string;
  /** match: candidate count; merge: golden record count. */
  count: number | null;
  sourceRecordCount?: number | null;
  goldenTable?: string;
  detail?: string;
}
interface MdmRunsDoc { id: string; tenantId: string; kind: 'mdm-runs'; items: MdmRunRecord[]; updatedAt: string }
function runsId(t: string) { return `mdm-runs:${t}`; }
const MAX_RUNS = 50;

export async function listMdmRuns(tenantId: string): Promise<MdmRunRecord[]> {
  const c = await tenantSettingsContainer();
  try {
    const { resource } = await c.item(runsId(tenantId), tenantId).read<MdmRunsDoc>();
    return resource?.items || [];
  } catch (e: any) { if (e?.code === 404) return []; throw e; }
}

export async function appendMdmRun(tenantId: string, rec: MdmRunRecord): Promise<MdmRunRecord[]> {
  const c = await tenantSettingsContainer();
  const id = runsId(tenantId);
  let doc: MdmRunsDoc;
  try {
    const { resource } = await c.item(id, tenantId).read<MdmRunsDoc>();
    doc = resource || { id, tenantId, kind: 'mdm-runs', items: [], updatedAt: '' };
  } catch (e: any) { if (e?.code !== 404) throw e; doc = { id, tenantId, kind: 'mdm-runs', items: [], updatedAt: '' }; }
  doc.items = [rec, ...(doc.items || [])].slice(0, MAX_RUNS);
  doc.updatedAt = new Date().toISOString();
  await c.items.upsert<MdmRunsDoc>(doc);
  return doc.items;
}
