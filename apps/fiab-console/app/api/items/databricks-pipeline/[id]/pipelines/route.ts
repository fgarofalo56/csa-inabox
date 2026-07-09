/**
 * GET /api/items/databricks-pipeline/[id]/pipelines
 * Lists the Lakeflow Declarative Pipelines (DLT) in the bound Databricks
 * workspace — the picker the DLT editor opens with.
 *
 * Honest-gates (503 `not_configured`) with the exact env var to set when no
 * Databricks workspace is wired (no-vaporware / no-fabric-dependency: this item
 * only applies when Databricks is the chosen backend; Loom's Synapse/ADF
 * `data-pipeline` is the Azure-native default pipeline surface).
 */

import { getSession } from '@/lib/auth/session';
import { apiOk, apiUnauthorized, apiError } from '@/lib/api/respond';
import { databricksConfigGate, listDltPipelines } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return apiUnauthorized();

  const gate = databricksConfigGate();
  if (gate) {
    return apiError(
      `No Databricks workspace is wired. Set ${gate.missing} on the Loom Console to author Lakeflow Declarative Pipelines, or use the Azure-native Data pipeline item.`,
      503,
      { code: 'not_configured', missing: gate.missing },
    );
  }

  try {
    const pipelines = await listDltPipelines();
    return apiOk({ pipelines });
  } catch (e: any) {
    // Upstream Databricks failure (502 passthrough — not a literal-500 leak).
    return apiError(e?.message || String(e), 502);
  }
}
