/**
 * Power Platform environment lifecycle (real BAP admin REST — no mocks).
 *
 *   GET    /api/powerplatform/environments              → { ok, environments }
 *   POST   /api/powerplatform/environments              body CreateEnvironmentSpec → { ok, operation }
 *   PATCH  /api/powerplatform/environments              body { id, displayName?, description?, securityGroupId? } → { ok, operation }
 *   DELETE /api/powerplatform/environments?id=<env>     → { ok, operation }
 *
 * POST/PATCH/DELETE wrap the async BAP lifecycle (New-/Set-/Remove-
 * AdminPowerAppEnvironment) and return the lifecycle operation handle
 * (status + operationUrl) so the UI can poll. Session-guarded; honest 503
 * config gate; real 401/403 remediation hint passthrough.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listEnvironments, createEnvironment, updateEnvironment, deleteEnvironment,
  powerPlatformConfigGate, PowerPlatformError,
  type CreateEnvironmentSpec,
} from '@/lib/azure/powerplatform-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = powerPlatformConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Power Platform not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

function err(e: any) {
  const status = e instanceof PowerPlatformError ? e.status : 502;
  return NextResponse.json(
    { ok: false, error: e?.message || String(e), hint: e?.hint, endpoint: e?.endpoint, body: e?.body },
    { status },
  );
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  try {
    const environments = await listEnvironments();
    return NextResponse.json({ ok: true, environments });
  } catch (e: any) { return err(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => null);
  const displayName: string | undefined = body?.displayName;
  const environmentSku: string | undefined = body?.environmentSku;
  const location: string | undefined = body?.location;
  if (!displayName || !environmentSku || !location) {
    return NextResponse.json(
      { ok: false, error: 'displayName, environmentSku and location are required to create an environment.' },
      { status: 400 },
    );
  }
  const spec: CreateEnvironmentSpec = {
    displayName, environmentSku, location,
    description: body?.description,
    dataverse: body?.dataverse,
  };
  try {
    const operation = await createEnvironment(spec);
    return NextResponse.json({ ok: true, operation }, { status: 202 });
  } catch (e: any) { return err(e); }
}

export async function PATCH(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => null);
  const id: string | undefined = body?.id;
  if (!id) return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 });
  if (body?.displayName === undefined && body?.description === undefined && body?.securityGroupId === undefined) {
    return NextResponse.json({ ok: false, error: 'Nothing to update (provide displayName, description or securityGroupId).' }, { status: 400 });
  }
  try {
    const operation = await updateEnvironment(id, {
      displayName: body?.displayName,
      description: body?.description,
      securityGroupId: body?.securityGroupId,
    });
    return NextResponse.json({ ok: true, operation });
  } catch (e: any) { return err(e); }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id query param is required' }, { status: 400 });
  try {
    const operation = await deleteEnvironment(id);
    return NextResponse.json({ ok: true, operation }, { status: 202 });
  } catch (e: any) { return err(e); }
}
