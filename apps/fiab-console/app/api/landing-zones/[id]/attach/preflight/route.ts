/**
 * POST /api/landing-zones/[id]/attach/preflight
 * ---------------------------------------------
 * Real preflight for the brownfield attach wizard's Validate step (§2.2 / §2.3).
 * Body: { services: { armResourceId, kind }[] }.
 *
 * For each pick it returns an HONEST verdict (no fakes — no-vaporware.md):
 *   - reachability   — can the Console (UAMI) see the resource control plane?
 *   - networkPosture — public / private-endpoint / service-endpoint (read from
 *                      the resource's properties bag), so a PE-locked brownfield
 *                      resource is flagged, not silently broken later.
 *   - rbacState + rbacRoleName + rbacScope — the exact navigator role the Console
 *                      UAMI needs on the resource (the auto-grant is Phase 2).
 *   - remediation    — precise next action for any non-green signal.
 *
 * Reachability + posture come from ONE Azure Resource Graph query by id (uniform
 * across resource types — no per-RP api-version juggling), run with the Console
 * UAMI token (Loom's reachability perspective), falling back to the caller's
 * delegated token. Gated to `admin.attach-service` (Admin).
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { getUserArmToken } from '@/lib/azure/user-token-store';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';
import { composePreflight, type PreflightResult } from '@/lib/azure/attach-preflight';
import { isAttachedServiceKind, armTypeToKind, type AttachedServiceKind } from '@/lib/azure/attached-service-kinds';
import { decodeLandingZoneId } from '@/lib/azure/landing-zone-id';
import { escapeSqlLiteral } from '@/lib/sql/quoting';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CAP = 'admin.attach-service';
const ARG_URL = `${armBase()}/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01`;

interface RequestedService {
  armResourceId: string;
  kind?: AttachedServiceKind;
}

interface ArgIdRow {
  id: string;
  type: string;
  kind?: string;
  properties?: any;
}

/** ARG query fetching properties for a specific set of resource ids. */
function buildIdQuery(ids: string[]): string {
  const list = ids.map((i) => `'${escapeSqlLiteral(i)}'`).join(',');
  return `resources | where id in~ (${list}) | project id, type, kind, properties`;
}

async function runArgById(token: string, ids: string[]): Promise<{ ok: boolean; rows: ArgIdRow[] }> {
  try {
    const res = await fetch(ARG_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: buildIdQuery(ids), options: { resultFormat: 'objectArray' } }),
    });
    if (!res.ok) return { ok: false, rows: [] };
    const body: any = await res.json().catch(() => ({}));
    return { ok: true, rows: Array.isArray(body?.data) ? body.data : [] };
  } catch {
    return { ok: false, rows: [] };
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSession();
  const gate = await enforceCapability(session, CAP, 'Admin');
  if (gate) return gate;
  const landingZoneId = decodeLandingZoneId(params.id);

  const body = await req.json().catch(() => ({}));
  const requested: RequestedService[] = Array.isArray(body?.services) ? body.services : [];
  if (requested.length === 0) return apiError('services (array of { armResourceId, kind }) required', 400);

  const ids = requested.map((s) => (s?.armResourceId || '').trim()).filter(Boolean);
  if (ids.length === 0) return apiError('no valid armResourceId in services', 400);

  // Reachability + posture from ARG (UAMI first — Loom's perspective — then the
  // caller's delegated token). ARG can silently return zero for one identity
  // even with Reader, so we try both before concluding "not visible".
  let rows: ArgIdRow[] = [];
  let argOk = false;
  try {
    const tok = await uamiArmCredential().getToken(armScope());
    if (tok?.token) {
      const r = await runArgById(tok.token, ids);
      argOk = argOk || r.ok;
      if (r.rows.length) rows = r.rows;
    }
  } catch { /* fall through to user token */ }
  if (rows.length === 0) {
    try {
      const userToken = await getUserArmToken(session!.claims.oid);
      if (userToken) {
        const r = await runArgById(userToken, ids);
        argOk = argOk || r.ok;
        if (r.rows.length) rows = r.rows;
      }
    } catch { /* leave rows empty */ }
  }

  const byId = new Map(rows.map((r) => [r.id.toLowerCase(), r]));
  const results: PreflightResult[] = requested.map((svc) => {
    const armResourceId = (svc.armResourceId || '').trim();
    const row = byId.get(armResourceId.toLowerCase());
    // Resolve the kind: explicit from the client, else inferred from the ARG row.
    const kind: AttachedServiceKind =
      (svc.kind && isAttachedServiceKind(svc.kind) ? svc.kind : undefined) ??
      (row ? armTypeToKind(row.type, row.kind) ?? 'storage-adls' : 'storage-adls');
    if (row) {
      return composePreflight(armResourceId, kind, { status: 200, properties: row.properties });
    }
    // Not returned by ARG. If ARG itself failed we can't conclude 'blocked'
    // (unknown); if ARG worked but omitted this id, the identity can't see it.
    return composePreflight(armResourceId, kind, {
      status: argOk ? 403 : 0,
      error: argOk ? undefined : 'Resource Graph did not return a result for this resource.',
    });
  });

  const allOk = results.every((r) => r.ok);
  return NextResponse.json({ ok: true, landingZoneId, allOk, results });
}
