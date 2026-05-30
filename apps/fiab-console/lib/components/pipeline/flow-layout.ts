/**
 * ELK auto-layout for the pipeline canvas — the same engine atlas-diag uses.
 *
 * Activities have no persisted coordinates (ADF/Synapse/Fabric JSON has no
 * viewport concept), so positions are computed deterministically from the
 * dependsOn[] DAG. ELK's `layered` algorithm laid out left→right gives the
 * canonical ADF-Studio look (sources on the left, sinks on the right).
 */

import ELK from 'elkjs/lib/elk.bundled.js';
import type { PipelineActivity } from './types';

const elk = new ELK();

export interface XY { x: number; y: number }

const LAYOUT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.layered.spacing.nodeNodeBetweenLayers': '90',
  'elk.spacing.nodeNode': '44',
  'elk.layered.spacing.edgeNodeBetweenLayers': '40',
  'elk.edgeRouting': 'POLYLINE',
  'elk.padding': '[top=24,left=24,bottom=24,right=24]',
};

/**
 * Run ELK over the activity DAG. Returns absolute top-left positions keyed by
 * activity name. `nodeW`/`nodeH` are the rendered node box size.
 */
export async function elkLayout(
  activities: PipelineActivity[],
  nodeW: number,
  nodeH: number,
): Promise<Map<string, XY>> {
  const out = new Map<string, XY>();
  if (activities.length === 0) return out;

  const names = new Set(activities.map((a) => a.name));
  const graph = {
    id: 'root',
    layoutOptions: LAYOUT_OPTIONS,
    children: activities.map((a) => ({ id: a.name, width: nodeW, height: nodeH })),
    edges: activities.flatMap((a) =>
      (a.dependsOn || [])
        .filter((d) => names.has(d.activity))
        .map((d, i) => ({
          id: `${d.activity}__${a.name}__${i}`,
          sources: [d.activity],
          targets: [a.name],
        })),
    ),
  };

  try {
    const res = await elk.layout(graph as any);
    for (const c of res.children || []) {
      out.set(c.id as string, { x: c.x ?? 0, y: c.y ?? 0 });
    }
  } catch {
    // Fallback: simple topological columns if ELK fails for any reason.
    return topoFallback(activities, nodeW, nodeH);
  }
  return out;
}

/** Deterministic fallback layout (rank by longest dependency path). */
export function topoFallback(activities: PipelineActivity[], nodeW: number, nodeH: number): Map<string, XY> {
  const ranks = new Map<string, number>();
  for (const a of activities) ranks.set(a.name, 0);
  for (let pass = 0; pass < activities.length; pass++) {
    let changed = false;
    for (const a of activities) {
      let r = 0;
      for (const dep of a.dependsOn || []) {
        const dr = ranks.get(dep.activity);
        if (dr !== undefined && dr + 1 > r) r = dr + 1;
      }
      if (r !== ranks.get(a.name)) { ranks.set(a.name, r); changed = true; }
    }
    if (!changed) break;
  }
  const cols = new Map<number, PipelineActivity[]>();
  for (const a of activities) {
    const r = ranks.get(a.name) ?? 0;
    if (!cols.has(r)) cols.set(r, []);
    cols.get(r)!.push(a);
  }
  const out = new Map<string, XY>();
  for (const [rank, list] of cols) {
    list.forEach((a, idx) => {
      out.set(a.name, { x: 24 + rank * (nodeW + 90), y: 24 + idx * (nodeH + 44) });
    });
  }
  return out;
}
