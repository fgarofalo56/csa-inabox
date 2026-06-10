/**
 * /api/aml/data-assets
 *
 * Registered Azure ML Data assets — used to populate the AutoML wizard's
 * training/validation dataset dropdown (AutoML needs an MLTable input).
 *
 *   GET /api/aml/data-assets                       → listDataAssets()
 *   GET /api/aml/data-assets?name=x&version=1      → getDataAssetVersion() (resolve dataUri/type)
 *
 * Real backend (lib/azure/aml-client.ts):
 *   GET <ws>/data
 *   GET <ws>/data/{name}/versions/{version}
 * https://learn.microsoft.com/rest/api/azureml/data-containers/list
 *
 * Honest gate: 200 with { ok: true, configured: false, missing, hint } when the
 * AML workspace env isn't set.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listDataAssets,
  getDataAssetVersion,
  amlConfigGate,
  AmlError,
} from '@/lib/azure/aml-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const gate = amlConfigGate();
  if (gate) {
    return NextResponse.json({
      ok: true,
      configured: false,
      dataAssets: [],
      missing: gate.missing,
      hint:
        `Azure ML workspace not addressable (missing ${gate.missing}). ` +
        'Register an MLTable data asset (az ml data create --type mltable) once ' +
        'the workspace env is set and the Console UAMI has AzureML Data Scientist.',
    });
  }

  const url = new URL(req.url);
  const name = url.searchParams.get('name');
  const version = url.searchParams.get('version');

  try {
    if (name && version) {
      const asset = await getDataAssetVersion(name, version);
      if (!asset) return NextResponse.json({ ok: false, error: 'data asset version not found' }, { status: 404 });
      return NextResponse.json({ ok: true, configured: true, dataAsset: asset });
    }
    const dataAssets = await listDataAssets();
    return NextResponse.json({ ok: true, configured: true, dataAssets });
  } catch (e: any) {
    const status = e instanceof AmlError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
