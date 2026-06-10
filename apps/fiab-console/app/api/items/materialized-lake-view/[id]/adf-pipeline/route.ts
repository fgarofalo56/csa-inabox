/**
 * POST /api/items/materialized-lake-view/[id]/adf-pipeline
 *
 * Creates (idempotent PUT) the "Refresh materialized lake view" Azure Data
 * Factory pipeline for this MLV — the orchestration artifact an operator
 * schedules in ADF for recurring refresh. The single activity is a Web activity
 * that calls back into this MLV's /refresh route (MSI-authenticated), carrying
 * the MLV identity in userProperties so it is visible in ADF monitoring.
 *
 * Optionally fires an on-demand run when body.run === true.
 *
 * GET returns whether the pipeline already exists + its run-now URL.
 *
 * Real ARM REST via adf-client. Honest gate (503) when the ADF factory env vars
 * are not configured — names the exact vars. No Microsoft Fabric required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadMlvItem, specFromItem } from '../../_lib/load';
import { adfConfigGate, upsertPipeline, runPipeline, getPipeline } from '@/lib/azure/adf-client';
import { buildRefreshAdfPipeline, mlvFqn, safeSegment } from '@/lib/azure/materialized-lake-view-model';
import { resolveMlvDeltaUrl } from '@/lib/azure/materialized-lake-view-engine';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function pipelineName(item: WorkspaceItem): string {
  return `loom-refresh-mlv-${safeSegment(item.displayName)}-${item.id}`.slice(0, 140);
}

/** Resolve the absolute URL of this MLV's /refresh route for the ADF callback. */
function refreshCallbackUrl(req: NextRequest, id: string): string {
  const base =
    process.env.LOOM_CONSOLE_BASE_URL ||
    process.env.LOOM_PUBLIC_BASE_URL ||
    req.nextUrl.origin;
  return `${base.replace(/\/$/, '')}/api/items/materialized-lake-view/${encodeURIComponent(id)}/refresh`;
}

function gate() {
  const g = adfConfigGate();
  if (!g) return null;
  return NextResponse.json(
    {
      ok: false,
      gate: 'adf_not_configured',
      error: `Azure Data Factory is not configured (${g.missing}).`,
      remediation:
        'Set LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG / LOOM_ADF_NAME (the ADF deployed by ' +
        'platform/fiab/bicep/modules/landing-zone/adf.bicep) and grant the Console UAMI the Data Factory ' +
        'Contributor role. No Microsoft Fabric required.',
      link: 'https://learn.microsoft.com/azure/data-factory/quickstart-create-data-factory-rest-api',
    },
    { status: 503 },
  );
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const item = await loadMlvItem(id, session.claims.oid).catch(() => null);
  if (!item) return NextResponse.json({ ok: false, error: 'MLV not found' }, { status: 404 });

  const g = gate();
  if (g) return g;

  const name = pipelineName(item);
  try {
    const p = await getPipeline(name);
    return NextResponse.json({ ok: true, exists: true, pipelineName: name, description: p.properties?.description });
  } catch {
    return NextResponse.json({ ok: true, exists: false, pipelineName: name });
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const item = await loadMlvItem(id, session.claims.oid).catch(() => null);
  if (!item) return NextResponse.json({ ok: false, error: 'MLV not found' }, { status: 404 });

  const spec = specFromItem(item);
  if (!spec) return NextResponse.json({ ok: false, error: 'No MLV definition — author + save it first.' }, { status: 400 });

  const g = gate();
  if (g) return g;

  let body: any = {};
  try { body = await req.json(); } catch { /* empty ok */ }

  const name = pipelineName(item);
  const fqn = mlvFqn(spec);
  const deltaUrl = resolveMlvDeltaUrl(spec) || '';
  const refreshUrl = refreshCallbackUrl(req, id);

  const built = buildRefreshAdfPipeline({ refreshUrl, fqn, deltaUrl });
  built.name = name;

  try {
    const created = await upsertPipeline(name, { name, properties: built.properties });
    let run: { runId: string } | undefined;
    if (body?.run === true) {
      run = await runPipeline(name);
    }
    return NextResponse.json({
      ok: true,
      pipelineName: created.name || name,
      fqn,
      refreshUrl,
      activity: 'RefreshMaterializedLakeView',
      runId: run?.runId,
    });
  } catch (e: any) {
    const msg = (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (/\b401\b|\b403\b|forbidden|authoriz/i.test(msg)) {
      return NextResponse.json(
        {
          ok: false,
          gate: 'adf_forbidden',
          error: `ADF rejected the pipeline upsert (${msg.slice(0, 160)}).`,
          remediation: 'Grant the Console UAMI the Data Factory Contributor role on the factory.',
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: msg.slice(0, 300) }, { status: 502 });
  }
}
