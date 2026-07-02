/**
 * GET / PUT / PATCH /api/items/report/[id]/endorsement
 *
 * WAVE-9 report ENDORSEMENT (Promote / Certify / Master data) — Power BI
 * parity, Azure-native.
 *
 * Power BI lets a workspace contributor PROMOTE a report (a soft, self-service
 * "this is good to use" signal) and lets a workspace reviewer/admin CERTIFY it
 * (an authoritative org seal of approval). Loom reproduces both as a single
 * persisted endorsement on the report item's Cosmos `state.endorsement`
 * ('Promoted' | 'Certified' | 'Master data' | <absent>) — read by the
 * governance catalog (`governance-catalog-shapes.docForGovernanceItem` surfaces
 * `state.endorsement` as the catalog endorsement badge). There is NO Power BI /
 * Fabric endorsement API on this path (no-fabric-dependency.md): the signal is
 * stored + read entirely in the Azure-native Cosmos item, and the catalog
 * renders it.
 *
 * Verbs + wire contract: this STATIC `report` segment shadows the generic
 * dynamic /api/items/[type]/[id]/endorsement route in the App Router, so it
 * must serve the SAME wire contract for the same verbs. The shared editor-
 * chrome EndorsementControl (lib/editors/endorsement-control.tsx) writes with
 * PATCH and sends 'Promoted' | 'Certified' | 'Master data' | 'None' (clear);
 * the report EndorsementDialog (lib/editors/report/endorsement.tsx) writes with
 * PUT and sends 'Promoted' | 'Certified' | null. Both verbs share one handler
 * that accepts the union of both contracts (a strict superset of the previous
 * PUT contract — existing callers are unchanged).
 *
 * Authorization (no-vaporware.md — the Certify gate is real, not cosmetic):
 *   • Anyone who owns the report (workspace-ownership verified by
 *     loadContentBackedItem) may PROMOTE it or clear the endorsement.
 *   • CERTIFY is restricted. `canCertify` is true when the caller is a
 *     workspace reviewer — an effective workspace role of Admin or Member
 *     resolved via workspace-roles-client.resolveEffectiveRole (direct +
 *     transitive group assignments) — OR the caller's identity is in the
 *     LOOM_REPORT_CERTIFIERS env allow-list (csv of oid / upn / email) — OR,
 *     for the single-tenant operator who owns every workspace, the caller is an
 *     Azure RBAC admin on the DLZ RG (checkRbacAdminCapability). A PUT/PATCH to
 *     'Certified' or 'Master data' without that capability returns 403, so the
 *     editor's Certify / Master-data controls are never dead buttons.
 *
 * Persistence key (catalog reads this): state.endorsement.
 * The value is ADDITIVE + optional, so the read-only viewer and the PBIR
 * provisioner ignore it (no-freeform-config.md — the editor offers a Promote
 * Switch + a Certify Button, never a free-form field).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { getSession, type SessionPayload } from '@/lib/auth/session';
import {
  isLoomContentId,
  cosmosIdFromLoomId,
  loadContentBackedItem,
} from '../../../_lib/pbi-content-fallback';
import { updateOwnedItem } from '../../../_lib/item-crud';
import { resolveEffectiveRole, checkRbacAdminCapability } from '@/lib/azure/workspace-roles-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Canonical endorsement values — identical to the generic
 *  /api/items/[type]/[id]/endorsement route this static segment shadows. */
type Endorsement = 'Promoted' | 'Certified' | 'Master data';
const VALID: readonly Endorsement[] = ['Promoted', 'Certified', 'Master data'];
/** Endorsements gated on the certifier capability (resolveCanCertify). */
const ELEVATED: ReadonlySet<Endorsement> = new Set<Endorsement>(['Certified', 'Master data']);

/** Read a persisted endorsement back as the strict union (anything else → null). */
function normalizeEndorsement(v: unknown): Endorsement | null {
  return typeof v === 'string' && (VALID as readonly string[]).includes(v) ? (v as Endorsement) : null;
}

/**
 * Parse the PUT/PATCH body's `endorsement`. Distinguishes a valid CLEAR (`null`
 * or the string 'None' — the shared EndorsementControl sends 'None') from an
 * invalid/absent value so the route can 400 on garbage but accept an explicit
 * clear. Returns `{ ok:false }` for anything that is not a valid endorsement,
 * null, or 'None'.
 */
function parseEndorsementInput(
  v: unknown,
): { ok: true; value: Endorsement | null } | { ok: false } {
  if (v === null || v === 'None' || v === 'none') return { ok: true, value: null };
  if (typeof v === 'string' && (VALID as readonly string[]).includes(v)) return { ok: true, value: v as Endorsement };
  return { ok: false };
}

/**
 * Whether the caller may CERTIFY this report. True for a workspace reviewer
 * (effective role Admin or Member), an identity in LOOM_REPORT_CERTIFIERS, or
 * the Azure RBAC-admin operator. Never throws — any Graph/Cosmos/ARM failure
 * fails closed (returns false) so Certify is only ever granted on a positive
 * signal.
 */
async function resolveCanCertify(session: SessionPayload, workspaceId: string): Promise<boolean> {
  const identities = [session.claims.oid, session.claims.upn, session.claims.email]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());

  // 1) Explicit env allow-list (csv of oid / upn / email).
  const certifiers = new Set(
    (process.env.LOOM_REPORT_CERTIFIERS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  if (certifiers.size && identities.some((id) => certifiers.has(id))) return true;

  // 2) Workspace reviewer — Admin or Member (direct or transitive group).
  try {
    const role = await resolveEffectiveRole(session.claims.oid, workspaceId);
    if (role === 'Admin' || role === 'Member') return true;
  } catch {
    /* Graph/Cosmos unavailable — fall through to the RBAC-admin probe. */
  }

  // 3) Operator fallback — an Azure RBAC admin on the DLZ RG (the single-tenant
  //    operator who owns every workspace) may certify without an explicit
  //    workspace-role assignment. Cheap no-op (returns ok:false) when the RBAC
  //    env / grant is absent.
  try {
    const probe = await checkRbacAdminCapability();
    if (probe.ok) return true;
  } catch {
    /* swallow — fail closed. */
  }

  return false;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const rawId = (await ctx.params).id;
  const cosmosId = isLoomContentId(rawId) ? cosmosIdFromLoomId(rawId) : rawId;

  const item = await loadContentBackedItem(cosmosId, 'report', session.claims.oid);
  if (!item) {
    return NextResponse.json({ ok: false, error: 'report item not found or not owned by you' }, { status: 404 });
  }

  const endorsement = normalizeEndorsement((item.state as Record<string, unknown> | undefined)?.endorsement);
  const canCertify = await resolveCanCertify(session, item.workspaceId);

  return NextResponse.json({ ok: true, endorsement, canCertify });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const rawId = (await ctx.params).id;
  const cosmosId = isLoomContentId(rawId) ? cosmosIdFromLoomId(rawId) : rawId;

  let body: { endorsement?: unknown } = {};
  try { body = await req.json(); } catch { /* empty/invalid body → validation below */ }

  const parsed = parseEndorsementInput(body.endorsement);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, error: `endorsement must be one of ${VALID.map((v) => `"${v}"`).join(', ')}, or null/"None" to clear` },
      { status: 400 },
    );
  }
  const value = parsed.value;

  const item = await loadContentBackedItem(cosmosId, 'report', session.claims.oid);
  if (!item) {
    return NextResponse.json({ ok: false, error: 'report item not found or not owned by you' }, { status: 404 });
  }

  // Certify / Master data are gated; promote / clear are open to the report owner.
  if (value && ELEVATED.has(value)) {
    const canCertify = await resolveCanCertify(session, item.workspaceId);
    if (!canCertify) {
      return NextResponse.json(
        { ok: false, error: `Setting a report's endorsement to "${value}" is restricted to workspace reviewers/admins` },
        { status: 403 },
      );
    }
  }

  // ADDITIVE persist: spread existing state, set/clear ONLY state.endorsement.
  const st = { ...((item.state as Record<string, unknown>) || {}) };
  if (value === null) delete st.endorsement;
  else st.endorsement = value;

  const updated = await updateOwnedItem(cosmosId, 'report', session.claims.oid, { state: st });
  if (!updated) {
    return NextResponse.json({ ok: false, error: 'failed to persist endorsement' }, { status: 502 });
  }

  return NextResponse.json({ ok: true, endorsement: value });
}

/**
 * PATCH — the SAME handler as PUT (identical body contract, auth gates, and
 * response shape). The shared cross-item EndorsementControl in the editor
 * chrome (lib/editors/endorsement-control.tsx) writes with HTTP PATCH against
 * the generic /api/items/[type]/[id]/endorsement contract; because this static
 * `report` segment shadows that dynamic route, the missing PATCH export made
 * every report endorsement write from the chrome return 405 (a dead
 * Promote/Certify/Master-data menu on reports).
 */
export const PATCH = PUT;
