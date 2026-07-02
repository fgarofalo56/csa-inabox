/**
 * GET    /api/connections/[id]   → return one connection doc (no secret)
 * PATCH  /api/connections/[id]   → update editable fields; rotate KV secret only when a new one is supplied
 * DELETE /api/connections/[id]   → remove from Cosmos + best-effort KV secret delete
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  loadConnection, deleteConnection, authNeedsSecret,
  type AuthMethod,
} from '@/lib/azure/connections-store';
import { putKeyVaultSecret, kvSecretsConfigGate } from '@/lib/azure/kv-secrets-client';
import { connectionsContainer } from '@/lib/azure/cosmos-client';
import type { LoomConnection } from '@/lib/azure/connections-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ─── helpers ────────────────────────────────────────────────────────────────

function toView(c: LoomConnection) {
  const { secretRef, ...rest } = c;
  return { ...rest, hasSecret: !!secretRef };
}

// ─── GET ─────────────────────────────────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const conn = await loadConnection(session.claims.oid, params.id);
    if (!conn) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    return NextResponse.json({ ok: true, connection: toView(conn) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

// ─── PATCH ───────────────────────────────────────────────────────────────────

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = session.claims.oid;

  let body: any;
  try { body = await req.json(); } catch { body = {}; }

  try {
    // Load the existing document so we can merge edits.
    const existing = await loadConnection(tenantId, params.id);
    if (!existing) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

    // Only update the subset of editable fields that were explicitly supplied.
    const name = body?.name !== undefined ? String(body.name).trim() : existing.name;
    const host = body?.host !== undefined ? (String(body.host).trim() || undefined) : existing.host;
    const database = body?.database !== undefined ? (String(body.database).trim() || undefined) : existing.database;
    const username = body?.username !== undefined ? (String(body.username).trim() || undefined) : existing.username;
    const spnTenantId = body?.spnTenantId !== undefined ? (String(body.spnTenantId).trim() || undefined) : existing.spnTenantId;
    const spnClientId = body?.spnClientId !== undefined ? (String(body.spnClientId).trim() || undefined) : existing.spnClientId;
    const description = body?.description !== undefined ? (String(body.description).trim() || undefined) : existing.description;
    const authMethod: AuthMethod = body?.authMethod ?? existing.authMethod;

    if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });

    // Rotate KV secret ONLY when a new non-empty secret is supplied.
    let secretRef = existing.secretRef;
    const newSecret = body?.secret ? String(body.secret) : undefined;
    if (newSecret) {
      if (!authNeedsSecret(authMethod)) {
        return NextResponse.json(
          { ok: false, error: `The "${authMethod}" auth method does not use a Key Vault secret` },
          { status: 400 },
        );
      }
      const gate = kvSecretsConfigGate();
      if (gate) {
        const e: any = new Error(gate.detail);
        e.status = 503;
        e.missing = gate.missing;
        throw e;
      }
      // Reuse the existing secret name so we overwrite in place (no orphaned KV secrets).
      const kvName = existing.secretRef || `loom-conn-${params.id}`;
      const { name: storedName } = await putKeyVaultSecret(kvName, newSecret);
      secretRef = storedName;
    }

    const now = new Date().toISOString();
    const updated: LoomConnection = {
      ...existing,
      name,
      authMethod,
      host,
      database,
      username,
      spnTenantId,
      spnClientId,
      description,
      secretRef,
      updatedAt: now,
    };

    const c = await connectionsContainer();
    const { resource } = await c.items.upsert<LoomConnection>(updated);
    return NextResponse.json({ ok: true, connection: toView((resource as LoomConnection) ?? updated) });
  } catch (e: any) {
    const status = e?.status || 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e), missing: e?.missing }, { status });
  }
}

// ─── DELETE ──────────────────────────────────────────────────────────────────

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    await deleteConnection(session, params.id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
