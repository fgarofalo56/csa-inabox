/**
 * Unity Catalog table lineage — resolves the workspace host server-side from
 * LOOM_DATABRICKS_HOSTNAME so the editor's Lineage tab only needs the table
 * full_name (catalog.schema.table).
 *
 *   GET /api/databricks/unity-catalog/lineage?full_name=c.s.t
 *     → { ok, nodes: CanvasLineageNode[], edges: CanvasLineageEdge[], focusId }
 *
 * Real Databricks REST: POST /api/2.0/lineage-tracking/table-lineage (public
 * preview). Returns upstream + downstream edges; this route composes a focus-
 * centred subgraph shaped like the catalog-browser lineage canvas.
 * Learn: https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/data-lineage
 *
 * Lineage tracking is a preview feature not enabled on Azure Government
 * (GCC-High/DoD) workspaces; the underlying call 404/501s there and the error
 * is surfaced verbatim.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate } from '@/lib/azure/databricks-client';
import {
  getTableLineage,
  UnityCatalogNotConfiguredError,
  UnityCatalogError,
} from '@/lib/azure/unity-catalog-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CanvasLineageNode { id: string; label: string; type?: string; source: 'unity-catalog'; focus?: boolean; }
interface CanvasLineageEdge { from: string; to: string; }

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const g = databricksConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Databricks workspace not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  const fullName = req.nextUrl.searchParams.get('full_name')?.trim();
  if (!fullName || fullName.split('.').length !== 3) {
    return NextResponse.json({ ok: false, error: 'full_name (catalog.schema.table) is required' }, { status: 400 });
  }
  const host = (process.env.LOOM_DATABRICKS_HOSTNAME || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

  try {
    const ucEdges = await getTableLineage(host, fullName);
    const seen = new Set<string>();
    const nodes: CanvasLineageNode[] = [];
    const edges: CanvasLineageEdge[] = [];
    // Always include the focus table itself, even with no edges.
    seen.add(fullName);
    nodes.push({ id: fullName, label: fullName, type: 'table', source: 'unity-catalog', focus: true });
    for (const e of ucEdges) {
      if (!seen.has(e.source)) { seen.add(e.source); nodes.push({ id: e.source, label: e.source, type: 'table', source: 'unity-catalog', focus: e.source === fullName }); }
      if (!seen.has(e.target)) { seen.add(e.target); nodes.push({ id: e.target, label: e.target, type: 'table', source: 'unity-catalog', focus: e.target === fullName }); }
      edges.push({ from: e.source, to: e.target });
    }
    return NextResponse.json({ ok: true, nodes, edges, focusId: fullName });
  } catch (e: any) {
    if (e instanceof UnityCatalogNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: (e as any).hint }, { status: 501 });
    }
    const status = e instanceof UnityCatalogError ? e.status : (e?.status || 502);
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: status || 502 });
  }
}
