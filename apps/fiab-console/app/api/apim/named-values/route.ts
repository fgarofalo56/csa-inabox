/**
 * Named values in the deployment-default APIM service (the APIM navigator →
 * Named values group). Lists / creates / deletes named values (APIM
 * "properties") via the real ARM REST.
 *
 *   GET    /api/apim/named-values             → { ok, namedValues: [{name, displayName, secret, value?, keyVault?}] }
 *   POST   /api/apim/named-values             body { displayName, name?, tags?, ... } → create/update
 *                                               inline mode:   { value, secret? }
 *                                               Key Vault mode:{ keyVault: { secretIdentifier } }
 *   DELETE /api/apim/named-values?id=NAME     → delete
 *
 * Named values support two value modes: an inline value (optionally secret,
 * encrypted at rest and never returned on GET) or a Key Vault-backed reference
 * (properties.keyVault.secretIdentifier). For a KV-backed value the APIM
 * service's managed identity must have GET on the referenced KV secret.
 *
 * APIM is shared tenant infrastructure, so mutation + read are gated to tenant
 * admins (requireTenantAdmin), mirroring the sibling admin routes. Honest 503
 * gate when the APIM service is unset. Real ARM REST. No mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import {
  apimConfigGate, listNamedValues, upsertNamedValue, deleteNamedValue, ApimError,
} from '@/lib/azure/apim-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

// displayName for a named value must match ^[A-Za-z0-9-._]+$.
function nvId(s: string): string {
  return s.replace(/[^A-Za-z0-9-._]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 256) || `nv-${Date.now()}`;
}

// A Key Vault secret identifier: https://<vault>.vault.<suffix>/secrets/<name>[/<version>].
// Sovereign suffixes (vault.azure.net / vault.usgovcloudapi.net / vault.azure.cn) all match `.vault.`.
const KV_SECRET_ID_RE = /^https:\/\/[a-z0-9-]+\.vault\.[a-z0-9.-]+\/secrets\/[^/\s]+(\/[^/\s]+)?\/?$/i;

function fail(e: any) {
  const status = e instanceof ApimError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET() {
  const session = getSession();
  const forbidden = requireTenantAdmin(session); if (forbidden) return forbidden;
  const g = gate(); if (g) return g;
  try {
    return NextResponse.json({ ok: true, namedValues: await listNamedValues() });
  } catch (e: any) { return fail(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  const forbidden = requireTenantAdmin(session); if (forbidden) return forbidden;
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const displayName = body?.displayName ? String(body.displayName) : '';
  if (!displayName) return NextResponse.json({ ok: false, error: 'displayName is required' }, { status: 400 });

  // Key Vault-backed mode: a secret identifier replaces the inline value.
  const secretIdentifier = body?.keyVault?.secretIdentifier
    ? String(body.keyVault.secretIdentifier).trim()
    : (body?.secretIdentifier ? String(body.secretIdentifier).trim() : '');
  const isKeyVault = !!secretIdentifier;

  if (isKeyVault) {
    if (!KV_SECRET_ID_RE.test(secretIdentifier)) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'keyVault.secretIdentifier must be a Key Vault secret URI, e.g. ' +
            'https://my-vault.vault.azure.net/secrets/my-secret (versionless to auto-refresh).',
        },
        { status: 400 },
      );
    }
  } else if (body?.value === undefined || body?.value === null || String(body.value).trim() === '') {
    return NextResponse.json({ ok: false, error: 'value is required and may not be empty' }, { status: 400 });
  }

  const id = (body.id && String(body.id)) || nvId(displayName);
  try {
    const namedValue = await upsertNamedValue(id, {
      displayName: nvId(displayName),
      ...(isKeyVault
        ? { keyVault: { secretIdentifier } }
        : { value: String(body.value), secret: !!body.secret }),
      tags: Array.isArray(body.tags) ? body.tags : undefined,
    });
    // Honest note: KV-backed values only resolve if APIM's managed identity can
    // read the secret. Surfaced (not thrown) so the create still succeeds and
    // the UI can prompt the admin to grant access.
    const note = isKeyVault
      ? "Key Vault-backed named value created. Ensure the APIM service's managed " +
        'identity has GET on this secret (Key Vault Secrets User, or a Get secret ' +
        'access policy) — otherwise APIM cannot resolve the value at runtime. ' +
        'See aka.ms/apimmsi.'
      : undefined;
    return NextResponse.json(note ? { ok: true, namedValue, note } : { ok: true, namedValue });
  } catch (e: any) { return fail(e); }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  const forbidden = requireTenantAdmin(session); if (forbidden) return forbidden;
  const g = gate(); if (g) return g;
  const id = req.nextUrl.searchParams.get('id')?.trim();
  if (!id) return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 });
  try {
    await deleteNamedValue(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return fail(e); }
}
