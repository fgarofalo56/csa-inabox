/**
 * Loom-native deployment-pipeline COMPARE engine.
 *
 * Pairs the items of a source stage and a target stage by (itemType, name) and
 * runs a CONTENT-level diff over their serialized definitions — the capability
 * Fabric's REST surface has no endpoint for. Serialization is deterministic:
 *
 *   - semantic-model      → buildTmsl(state.content)  (model.bim TMSL JSON)
 *   - report / paginated-report / scorecard / default → stable JSON.stringify
 *     of state.content
 *
 * Two items are "Same" iff their serialized defs are byte-for-byte equal,
 * "Different" otherwise. Unpaired source items are "OnlyInSource"; unpaired
 * target items are "NotInSource". No Azure / Fabric call — pure transform.
 */
import { buildTmsl } from './provisioners/semantic-model';
import type { WorkspaceItem } from '@/lib/types/workspace';

export type DiffStatus = 'Same' | 'Different' | 'OnlyInSource' | 'NotInSource';

export interface PipelineDiffPair {
  itemType: string;
  sourceItemId?: string;
  sourceItemDisplayName?: string;
  targetItemId?: string;
  targetItemDisplayName?: string;
  status: DiffStatus;
  /** Human-readable summary of what differs, e.g. "TMSL changed (2 tables)". */
  diffSummary?: string;
}

export interface PipelineDiffResult {
  pairs: PipelineDiffPair[];
  summary: { same: number; different: number; onlyInSource: number; notInSource: number };
}

/** Stable stringify so key order never produces a false "Different". */
function stableStringify(value: unknown): string {
  const seen = new WeakSet();
  const norm = (v: any): any => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return undefined;
    seen.add(v);
    if (Array.isArray(v)) return v.map(norm);
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
    return out;
  };
  return JSON.stringify(norm(value) ?? null);
}

/**
 * Serialize a workspace item's definition to a canonical string for diffing.
 * Semantic models go through buildTmsl (the same TMSL the provisioner emits);
 * everything else uses a stable JSON of state.content.
 */
export function serializeItemDef(item: WorkspaceItem): string {
  const content = (item.state as any)?.content ?? null;
  if (item.itemType === 'semantic-model') {
    try {
      return buildTmsl(content, item.displayName, []);
    } catch {
      // A malformed model still diffs by its raw content rather than throwing.
      return stableStringify(content);
    }
  }
  // report / paginated-report / scorecard / kql-dashboard / everything else.
  return stableStringify(content);
}

/** Pairing key: item type + case-insensitive display name. */
export function pairKey(item: WorkspaceItem): string {
  return `${item.itemType}::${(item.displayName || '').toLowerCase()}`;
}

/** Count the tables in a semantic-model content (best-effort, for the summary). */
function tableCount(item: WorkspaceItem): number {
  const t = (item.state as any)?.content?.tables;
  return Array.isArray(t) ? t.length : 0;
}

/**
 * Compute the per-item diff between a source stage and a target stage.
 * Source items pair to target items by (type, name); the serialized defs are
 * compared to label Same / Different. Unpaired items are reported on the
 * appropriate side.
 */
export function computePipelineDiff(
  sourceItems: WorkspaceItem[],
  targetItems: WorkspaceItem[],
): PipelineDiffResult {
  const targetByKey = new Map<string, WorkspaceItem>();
  for (const it of targetItems) targetByKey.set(pairKey(it), it);

  const pairs: PipelineDiffPair[] = [];
  const matchedTargetKeys = new Set<string>();

  for (const src of sourceItems) {
    const key = pairKey(src);
    const tgt = targetByKey.get(key);
    if (!tgt) {
      pairs.push({
        itemType: src.itemType,
        sourceItemId: src.id,
        sourceItemDisplayName: src.displayName,
        status: 'OnlyInSource',
        diffSummary: 'Present in source, absent in target — will be created on deploy.',
      });
      continue;
    }
    matchedTargetKeys.add(key);
    const a = serializeItemDef(src);
    const b = serializeItemDef(tgt);
    const same = a === b;
    pairs.push({
      itemType: src.itemType,
      sourceItemId: src.id,
      sourceItemDisplayName: src.displayName,
      targetItemId: tgt.id,
      targetItemDisplayName: tgt.displayName,
      status: same ? 'Same' : 'Different',
      diffSummary: same
        ? 'Identical definition.'
        : src.itemType === 'semantic-model'
          ? `TMSL changed (source ${tableCount(src)} table(s), target ${tableCount(tgt)} table(s)).`
          : `Definition changed (${a.length} vs ${b.length} serialized bytes).`,
    });
  }

  for (const tgt of targetItems) {
    const key = pairKey(tgt);
    if (matchedTargetKeys.has(key)) continue;
    pairs.push({
      itemType: tgt.itemType,
      targetItemId: tgt.id,
      targetItemDisplayName: tgt.displayName,
      status: 'NotInSource',
      diffSummary: 'Present in target only — left untouched by a source-driven deploy.',
    });
  }

  const summary = { same: 0, different: 0, onlyInSource: 0, notInSource: 0 };
  for (const p of pairs) {
    if (p.status === 'Same') summary.same++;
    else if (p.status === 'Different') summary.different++;
    else if (p.status === 'OnlyInSource') summary.onlyInSource++;
    else summary.notInSource++;
  }

  return { pairs, summary };
}
