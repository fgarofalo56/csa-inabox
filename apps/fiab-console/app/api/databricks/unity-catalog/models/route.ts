/**
 * Unity Catalog REGISTERED MODELS as securables — wave c3 finish.
 *
 *   GET /api/databricks/unity-catalog/models?catalog=&schema=        → { ok, models[] }
 *   GET /api/databricks/unity-catalog/models?full_name=c.s.m          → { ok, model }
 *   GET /api/databricks/unity-catalog/models?full_name=c.s.m&versions=true
 *                                                                     → { ok, model, versions[] }
 *
 * Read-only browse of registered models (a SUBTYPE of the FUNCTION securable in
 * Unity Catalog) over the documented stable UC Models REST:
 *   GET /api/2.1/unity-catalog/models
 *   GET /api/2.1/unity-catalog/models/{full_name}
 *   GET /api/2.1/unity-catalog/models/{full_name}/versions
 *   https://learn.microsoft.com/azure/databricks/machine-learning/manage-model-lifecycle/
 *
 * Models are GOVERNED through the FUNCTION permissions path
 * (PATCH /permissions/function/{full_name}) — so the existing UC grant dialog's
 * FUNCTION securable type already grants EXECUTE / APPLY TAG / MANAGE on a model.
 *
 * Honest gate when Databricks is not configured and at the GCC-High / DoD
 * boundary (registered models are a Unity Catalog feature; the Gov Hive path has
 * no UC). CREATE / registration is an MLflow-side flow — surfaced as a UI note.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate } from '@/lib/azure/databricks-client';
import { isGovCloud, cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';
import {
  primaryWorkspaceHost, listRegisteredModels, getRegisteredModel, listModelVersions,
} from '@/lib/azure/unity-catalog-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Gate { gated: true; error: string }

function resolveGate(): Gate | null {
  const cfg = databricksConfigGate();
  if (cfg) {
    return { gated: true, error: `Databricks is not configured in this deployment. Set ${cfg.missing} on the Console (landing-zone bicep deploys the Databricks workspace).` };
  }
  if (isGovCloud()) {
    return {
      gated: true,
      error:
        `Unity Catalog registered models are not available at the ${cloudBoundaryLabel()} boundary. ` +
        `They require a Commercial or GCC Databricks account (Microsoft Entra-connected Unity Catalog metastore). ` +
        `At this boundary models are tracked in the workspace MLflow registry instead.`,
    };
  }
  return null;
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = resolveGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });

  const sp = req.nextUrl.searchParams;
  let host: string;
  try {
    host = await primaryWorkspaceHost();
  } catch (e: any) {
    return NextResponse.json({ ok: false, gated: true, error: e?.message || String(e) }, { status: 200 });
  }

  // ---- Single model (+ optional versions) ----
  const fullName = sp.get('full_name')?.trim();
  if (fullName) {
    if (fullName.split('.').length !== 3) {
      return NextResponse.json({ ok: false, error: 'full_name must be catalog.schema.model' }, { status: 400 });
    }
    try {
      if (sp.get('versions') === 'true') {
        // Model header is best-effort (the EXECUTE grant on the model is enough to
        // list versions even when the get-model read is restricted).
        const [model, versions] = await Promise.all([
          getRegisteredModel(host, fullName).catch(() => null),
          listModelVersions(host, fullName),
        ]);
        return NextResponse.json({ ok: true, model, versions });
      }
      const model = await getRegisteredModel(host, fullName);
      return NextResponse.json({ ok: true, model });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
    }
  }

  // ---- List models in a schema ----
  const catalog = sp.get('catalog')?.trim();
  const schema = sp.get('schema')?.trim();
  if (!catalog || !schema) {
    return NextResponse.json({ ok: false, error: 'catalog and schema are required (or full_name for a single model)' }, { status: 400 });
  }
  try {
    const models = await listRegisteredModels(host, catalog, schema);
    return NextResponse.json({ ok: true, models });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
