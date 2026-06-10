/**
 * GET /api/items/rayfin-app/models
 *
 * Lists the semantic models a Rayfin app can bind to (Fabric Apps Build 2026
 * #28 — "build a web app backed by a semantic model"). The Azure-native DEFAULT
 * backend is Azure Analysis Services: the bindable models are the tabular
 * databases on the env-pinned AAS server (real ARM list).
 *
 * Per no-fabric-dependency.md this requires NO Fabric / Power BI workspace. When
 * AAS is not configured it returns { ok:false, gate } with 503 so the builder
 * renders an honest Fluent MessageBar naming the env var to set — never an empty
 * picker (no-vaporware.md).
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { AasError } from '@/lib/azure/aas-client';
import {
  modelBindingGate,
  listBindableModels,
  envAasServerName,
  envAasServerRegion,
} from '@/lib/azure/rayfin-model-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const gate = modelBindingGate();
  if (gate) {
    return NextResponse.json(
      {
        ok: false,
        backend: 'analysis-services',
        error: `Azure Analysis Services not configured: ${gate.missing} — ${gate.detail}`,
        gate,
      },
      { status: 503 },
    );
  }

  try {
    const models = await listBindableModels();
    const out = {
      ok: true as const,
      backend: 'analysis-services' as const,
      serverName: envAasServerName(),
      region: envAasServerRegion(),
      models,
    };
    try { console.info(`[rayfin-app/models.GET] receipt: ${JSON.stringify(out).slice(0, 300)}`); } catch { /* noop */ }
    return NextResponse.json(out);
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
