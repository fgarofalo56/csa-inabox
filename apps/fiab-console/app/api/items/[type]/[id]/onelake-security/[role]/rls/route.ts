/**
 * OneLake Security — Row-Level Security (RLS) authoring for a role.
 *
 *   GET  /api/items/[type]/[id]/onelake-security/[role]/rls
 *        → { ok, rls, cls, lastReceipt }
 *   POST /api/items/[type]/[id]/onelake-security/[role]/rls
 *        body { rules: RowLevelRule[] }  (alias: { rls })
 *        → validate each predicate (isValidRlsPredicate; 400 on invalid),
 *          persist onto the role (onelake-security-client.upsertRole), call
 *          reconcileRoleRlsCls, return { ok, rls, receipt }.
 *
 * ADDITIVE + Azure-native (no-fabric): RLS predicates are materialized to the
 * SOURCE engine the item resolves to — a Synapse SECURITY POLICY + inline TVF,
 * or an ADX row_level_security policy — by `reconcileRoleRlsCls`. The persist is
 * the source of truth and survives a deploy failure / honest gate (surfaced in
 * the receipt). The PDP (lib/auth/pdp) also reads role.rls as obligations, so a
 * Delta-on-ADLS item with no SQL engine is still enforced. Session-gated +
 * PDP-admin-checked exactly like the sibling security-roles route.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { pdpCheck } from '@/lib/auth/pdp/enforce';
import {
  getRole,
  upsertRole,
  roleDocId,
  isValidRlsPredicate,
  type OneLakeSecurityItemType,
  type RowLevelRule,
} from '@/lib/azure/onelake-security-client';
import { reconcileRoleRlsCls } from '@/lib/azure/onelake-rls-reconciler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPES: OneLakeSecurityItemType[] = ['lakehouse', 'mirrored-database', 'mirrored-catalog'];

function parseItemType(v: string): OneLakeSecurityItemType | null {
  return (ITEM_TYPES as string[]).includes(v) ? (v as OneLakeSecurityItemType) : null;
}

/** Validate the incoming RLS rule array; returns the cleaned rules or an error string.
 *  isValidRlsPredicate is the PORTABLE, conservative safe-subset gate (defense in
 *  depth) — its char allow-list passes the common KQL operators too, so an
 *  ADX-resolved item's predicate normally passes here and is then re-validated by
 *  the engine-specific validateKustoRlsQuery inside reconcileAdx. A predicate must
 *  therefore satisfy BOTH the portable gate (here) and its engine gate (reconciler). */
function validateRules(raw: unknown): { rules: RowLevelRule[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'rules must be an array of { table, predicate }' };
  const rules: RowLevelRule[] = [];
  const seen = new Set<string>();
  for (const r of raw as any[]) {
    const table = String(r?.table || '').trim();
    if (!table) return { error: 'each rule requires a non-empty table' };
    const predicate = String(r?.predicate ?? '').trim();
    const v = isValidRlsPredicate(predicate);
    if (!v.ok) return { error: `table "${table}": ${v.error}` };
    const key = table.toLowerCase();
    if (seen.has(key)) return { error: `duplicate RLS rule for table "${table}"` };
    seen.add(key);
    rules.push({ table, predicate });
  }
  return { rules };
}

export async function GET(_req: NextRequest, props: { params: Promise<{ type: string; id: string; role: string }> }) {
  const params = await props.params;
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const itemType = parseItemType(params.type);
  if (!itemType) return NextResponse.json({ ok: false, error: `unsupported item type: ${params.type}` }, { status: 400 });
  const blocked = await pdpCheck(session, { level: 'item', id: params.id, itemType: params.type }, 'read');
  if (blocked) return blocked;

  try {
    const role = await getRole(params.id, roleDocId(params.id, params.role));
    if (!role) return NextResponse.json({ ok: false, error: 'role not found' }, { status: 404 });
    return NextResponse.json({
      ok: true,
      rls: role.rls || [],
      cls: role.cls || [],
      lastReceipt: role.lastReceipt || null,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ type: string; id: string; role: string }> }) {
  const params = await props.params;
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const itemType = parseItemType(params.type);
  if (!itemType) return NextResponse.json({ ok: false, error: `unsupported item type: ${params.type}` }, { status: 400 });
  const blocked = await pdpCheck(session, { level: 'item', id: params.id, itemType: params.type }, 'admin');
  if (blocked) return blocked;

  const body = await req.json().catch(() => ({}));
  const v = validateRules(body?.rules ?? body?.rls);
  if ('error' in v) return NextResponse.json({ ok: false, error: v.error }, { status: 400 });

  try {
    const role = await getRole(params.id, roleDocId(params.id, params.role));
    if (!role) return NextResponse.json({ ok: false, error: 'role not found' }, { status: 404 });

    // Persist FIRST (source of truth; survives a reconcile failure / honest gate).
    role.rls = v.rules;
    role.updatedAt = new Date().toISOString();
    const receipt = await reconcileRoleRlsCls({ id: role.itemId, itemType: role.itemType }, role);
    role.lastReceipt = receipt;
    const saved = await upsertRole(role);

    return NextResponse.json({ ok: true, rls: saved.rls || [], receipt });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
