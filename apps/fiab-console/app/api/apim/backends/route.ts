/**
 * Backends in the deployment-default APIM service (the APIM navigator →
 * Backends group). Lists / creates / deletes backends via the real ARM REST.
 *
 *   GET    /api/apim/backends             → { ok, backends: [{name, url, protocol, title?, credentials?, tls?}] }
 *   POST   /api/apim/backends             body { name, url, protocol?, title?, description?, credentials?, tls? } → create
 *   DELETE /api/apim/backends?id=NAME     → delete
 *
 * `credentials` maps onto ARM BackendCredentialsContract (authorization header /
 * custom request header / query param). `tls` toggles certificate-chain / name
 * validation. All real ARM REST (PUT /backends/{id}). No mocks.
 *
 * url is required; protocol defaults to 'http'. Honest 503 gate when the APIM
 * service is unset. Real ARM REST. No mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  apimConfigGate, listBackends, upsertBackend, deleteBackend, ApimError,
  type ApimBackendCredentials, type ApimBackendTls,
} from '@/lib/azure/apim-client';
import { apiHonestGateError } from '@/lib/api/gate-envelope';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// WS-D2: APIM config gate normalized onto the shared svc-apim gate envelope.
function gate() {
  const g = apimConfigGate();
  if (g) {
    return apiHonestGateError('svc-apim', {
      missing: [g.missing],
      message: `APIM service not configured: set ${g.missing}.`,
    });
  }
  return null;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || `backend-${Date.now()}`;
}

function fail(e: any) {
  const status = e instanceof ApimError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

// WS-D1: session-only routes adopted onto `withSession`.
export const GET = withSession(async () => {
  const g = gate(); if (g) return g;
  try {
    return NextResponse.json({ ok: true, backends: await listBackends() });
  } catch (e: any) { return fail(e); }
});

export const POST = withSession(async (req: NextRequest) => {
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const url = body?.url ? String(body.url) : '';
  if (!url) return NextResponse.json({ ok: false, error: 'url is required' }, { status: 400 });
  const protocol = body?.protocol === 'soap' ? 'soap' : 'http';
  const id = (body.name && slug(String(body.name))) || slug(url);

  // Normalize optional auth credentials (authorization header / custom header /
  // query param) onto the ARM BackendCredentialsContract shape.
  let credentials: ApimBackendCredentials | undefined;
  if (body?.credentials && typeof body.credentials === 'object') {
    const c: ApimBackendCredentials = {};
    const auth = body.credentials.authorization;
    if (auth && auth.scheme && auth.parameter) {
      c.authorization = { scheme: String(auth.scheme), parameter: String(auth.parameter) };
    }
    if (body.credentials.header && typeof body.credentials.header === 'object') c.header = body.credentials.header;
    if (body.credentials.query && typeof body.credentials.query === 'object') c.query = body.credentials.query;
    if (c.authorization || c.header || c.query) credentials = c;
  }
  let tls: ApimBackendTls | undefined;
  if (body?.tls && typeof body.tls === 'object') {
    tls = {
      validateCertificateChain: body.tls.validateCertificateChain !== false,
      validateCertificateName: body.tls.validateCertificateName !== false,
    };
  }

  try {
    const backend = await upsertBackend(id, {
      url,
      protocol,
      title: body.title || undefined,
      description: body.description || undefined,
      credentials,
      tls,
    });
    return NextResponse.json({ ok: true, backend });
  } catch (e: any) { return fail(e); }
});

export const DELETE = withSession(async (req: NextRequest) => {
  const g = gate(); if (g) return g;
  const id = req.nextUrl.searchParams.get('id')?.trim();
  if (!id) return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 });
  try {
    await deleteBackend(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return fail(e); }
});
