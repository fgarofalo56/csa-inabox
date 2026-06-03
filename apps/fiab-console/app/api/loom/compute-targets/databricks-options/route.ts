/**
 * GET /api/loom/compute-targets/databricks-options
 *
 * Feeds the "New cluster" guided dialog in <ComputePicker> with REAL Databricks
 * metadata so every field is a dropdown (no raw JSON, per loom_no_freeform_config):
 *   - sparkVersions  → /api/2.0/clusters/spark-versions  (runtime picker)
 *   - nodeTypes      → /api/2.0/clusters/list-node-types (VM size picker)
 *
 * Honest gate (no-vaporware): if Databricks isn't configured/reachable the
 * route returns ok:false with the error — the dialog shows a warning MessageBar
 * naming Databricks, not an empty form.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listNodeTypes, listSparkVersions } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  try {
    const [versions, nodeTypes] = await Promise.all([listSparkVersions(), listNodeTypes()]);
    // Keep only fields the form needs; sort node types by cores for a sensible
    // small→large dropdown and label them with cores + memory.
    const nodes = nodeTypes
      .map((n) => ({
        node_type_id: n.node_type_id,
        label: `${n.node_type_id}${n.num_cores ? ` · ${n.num_cores} cores` : ''}${
          n.memory_mb ? ` · ${Math.round(n.memory_mb / 1024)} GB` : ''
        }`,
        num_cores: n.num_cores ?? 0,
        category: n.category,
      }))
      .sort((a, b) => a.num_cores - b.num_cores);
    return NextResponse.json({ ok: true, sparkVersions: versions, nodeTypes: nodes });
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        error: e?.message || String(e),
        hint:
          'Databricks must be configured (LOOM_DATABRICKS_WORKSPACE_URL + the Console identity granted access) to create clusters.',
      },
      { status: 200 },
    );
  }
}
