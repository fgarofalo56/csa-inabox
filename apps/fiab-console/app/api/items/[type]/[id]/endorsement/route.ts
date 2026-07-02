/**
 * GET / PATCH /api/items/[type]/[id]/endorsement
 *
 * GENERIC item ENDORSEMENT (Promote / Certify / Master data) for ANY Loom item
 * type — Fabric/Power-BI endorsement parity, Azure-native. Fabric lets an item
 * owner PROMOTE an item (a soft, self-service "this is good to use" signal) and
 * lets an authorized reviewer CERTIFY it (an org seal of approval) or mark it as
 * MASTER DATA. Loom reproduces all three as a single persisted endorsement on the
 * item's Cosmos `state.endorsement` ('Promoted' | 'Certified' | 'Master data' |
 * <absent>) — read by the governance catalog (governance-catalog-shapes
 * `docForGovernanceItem` surfaces `state.endorsement` as the catalog endorsement
 * badge, and the OneLake/catalog tiles render it).
 *
 * There is NO Fabric / Power BI endorsement API on this path
 * (no-fabric-dependency.md): the signal is stored + read entirely in the
 * Azure-native Cosmos item, and the catalog renders it. This generalizes the
 * type-specific `items/report/[id]/endorsement` route to every item type (the
 * static `report` / `powerbi` segments still take precedence for those types;
 * this dynamic `[type]` route serves the rest).
 *
 * Authorization (no-vaporware.md — the Certify gate is real, not cosmetic):
 *   • Anyone whose tenant owns the item (workspace-ownership verified by
 *     loadOwnedItem) may PROMOTE it or clear the endorsement.
 *   • CERTIFY and MASTER DATA are restricted to a tenant admin (the certifier)
 *     — reuse of `isTenantAdmin` (LOOM_TENANT_ADMIN_OID / _GROUP_ID). A PATCH to
 *     'Certified' / 'Master data' without that capability returns 403, so the
 *     editor's Certify control is never a dead button.
 *
 * Persistence key (catalog reads this): state.endorsement. ADDITIVE + optional —
 * every other reader/provisioner ignores it (no-freeform-config.md: the editor
 * offers a radio + a certify action, never a free-form field).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Canonical endorsement values — the exact strings the governance catalog +
 *  OneLake/catalog tiles render as a badge. 'Master data' matches Fabric's
 *  "Master data" endorsement (Power BI API value `masterData`). */
type Endorsement = 'Promoted' | 'Certified' | 'Master data';
const VALID: readonly Endorsement[] = ['Promoted', 'Certified', 'Master data'];
/** Endorsements that require the tenant-admin (certifier) capability. */
const ELEVATED: ReadonlySet<Endorsement> = new Set<Endorsement>(['Certified', 'Master data']);

/** Read a persisted endorsement back as the strict union (anything else → null). */
function normalizeEndorsement(v: unknown): Endorsement | null {
  return typeof v === 'string' && (VALID as readonly string[]).includes(v) ? (v as Endorsement) : null;
}

/**
 * Parse the PATCH body's `endorsement`. Distinguishes a valid CLEAR (`null` or
 * the string 'None') from an invalid/absent value so the route can 400 on
 * garbage but accept an explicit clear. Returns `{ ok:false }` for anything that
 * is not a valid endorsement, null, or 'None'.
 */
function parseEndorsementInput(
  v: unknown,
): { ok: true; value: Endorsement | null } | { ok: false } {
  if (v === null || v === 'None' || v === 'none') return { ok: true, value: null };
  if (typeof v === 'string' && (VALID as readonly string[]).includes(v)) return { ok: true, value: v as Endorsement };
  return { ok: false };
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { type, id } = await ctx.params;
  const item = await loadOwnedItem(id, type, session.claims.oid);
  if (!item) {
    return NextResponse.json({ ok: false, error: 'item not found or not owned by you' }, { status: 404 });
  }

  const endorsement = normalizeEndorsement((item.state as Record<string, unknown> | undefined)?.endorsement);
  return NextResponse.json({ ok: true, endorsement, canCertify: isTenantAdmin(session) });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { type, id } = await ctx.params;

  let body: { endorsement?: unknown } = {};
  try { body = await req.json(); } catch { /* empty/invalid body → validation below */ }

  const parsed = parseEndorsementInput(body.endorsement);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, error: `endorsement must be one of ${VALID.join(', ')}, or null/None to clear` },
      { status: 400 },
    );
  }
  const value = parsed.value;

  // Owner gate: loadOwnedItem verifies the caller's tenant owns the parent
  // workspace — the promote/clear authorization.
  const item = await loadOwnedItem(id, type, session.claims.oid);
  if (!item) {
    return NextResponse.json({ ok: false, error: 'item not found or not owned by you' }, { status: 404 });
  }

  // Certify / Master data are gated on the tenant-admin (certifier) capability.
  if (value && ELEVATED.has(value) && !isTenantAdmin(session)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Setting an item's endorsement to "${value}" is restricted to a tenant admin (certifier).`,
        code: 'certifier_required',
      },
      { status: 403 },
    );
  }

  // ADDITIVE persist: spread existing state, set/clear ONLY state.endorsement.
  const st = { ...((item.state as Record<string, unknown>) || {}) };
  if (value === null) delete st.endorsement;
  else st.endorsement = value;

  const updated = await updateOwnedItem(id, type, session.claims.oid, { state: st });
  if (!updated) {
    return NextResponse.json({ ok: false, error: 'failed to persist endorsement' }, { status: 502 });
  }

  return NextResponse.json({ ok: true, endorsement: value, canCertify: isTenantAdmin(session) });
}
