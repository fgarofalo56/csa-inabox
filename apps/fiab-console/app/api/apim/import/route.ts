/**
 * Import an API from an OpenAPI / Swagger definition into the deployment-default
 * APIM service (the APIM editor → "Import from OpenAPI" affordance). Real ARM
 * REST via importApiFromOpenApi; APIM parses the spec into operations. No mocks.
 *
 *   POST /api/apim/import
 *     body { apiId, displayName?, path, format, value }
 *       format ∈ openapi | openapi+json | swagger-link-json | openapi-link
 *       value  = inline OpenAPI document (for openapi/openapi+json)
 *                OR a URL (for the *-link formats)
 *     → { ok:true, api: { id, name, path, displayName, ... } }
 *
 * Honest 503 gate when LOOM_SUBSCRIPTION_ID / the APIM service is unset
 * (mirrors /api/apim/apis exactly). 401 when unauthenticated; 400 on missing
 * apiId/path/value; ApimError → its own status; anything else → 502.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apimConfigGate, importApiFromOpenApi, ApimError } from '@/lib/azure/apim-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FORMATS = ['openapi', 'openapi+json', 'swagger-link-json', 'openapi-link'] as const;
type ImportFormat = (typeof FORMATS)[number];

function gate() {
  const g = apimConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `APIM service not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

function fail(e: any) {
  const status = e instanceof ApimError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const apiId = body?.apiId && String(body.apiId).trim();
  const path = body?.path !== undefined && body?.path !== null ? String(body.path).trim() : '';
  const value = body?.value && String(body.value);
  if (!apiId) return NextResponse.json({ ok: false, error: 'apiId is required' }, { status: 400 });
  if (!path) return NextResponse.json({ ok: false, error: 'path is required' }, { status: 400 });
  if (!value) return NextResponse.json({ ok: false, error: 'value is required' }, { status: 400 });
  const format: ImportFormat = FORMATS.includes(body?.format) ? body.format : 'openapi+json';
  try {
    const api = await importApiFromOpenApi({
      apiId,
      displayName: body?.displayName ? String(body.displayName) : undefined,
      path,
      format,
      value,
    });
    return NextResponse.json({ ok: true, api });
  } catch (e: any) { return fail(e); }
}
