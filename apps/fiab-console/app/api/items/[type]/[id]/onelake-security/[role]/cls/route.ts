/**
 * OneLake Security — Column-Level Security (CLS) authoring for a role.
 *
 *   GET  /api/items/[type]/[id]/onelake-security/[role]/cls
 *        → { ok, rls, cls, lastReceipt }
 *   POST /api/items/[type]/[id]/onelake-security/[role]/cls
 *        body { rules: ColumnLevelRule[] }  (alias: { cls })
 *        → validate each column list (isValidColumnList; 400 on invalid),
 *          persist onto the role (onelake-security-client.upsertRole), call
 *          reconcileRoleRlsCls, return { ok, cls, receipt }.
 *
 * ADDITIVE + Azure-native (no-fabric): CLS allow-lists are materialized to the
 * SOURCE engine the item resolves to — per-member column GRANT/REVOKE on a
 * Synapse SQL pool, or an ADX row_level_security `| project` — by
 * `reconcileRoleRlsCls`. The persist is the source of truth and survives a
 * deploy failure / honest gate (surfaced in the receipt). The PDP also reads
 * role.cls as obligations. Session-gated + PDP-admin-checked like the sibling
 * security-roles route.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { pdpCheck } from '@/lib/auth/pdp/enforce';
import {
  getRole,
  upsertRole,
  roleDocId,
  isValidColumnList,
  type OneLakeSecurityItemType,
  type ColumnLevelRule,
} from '@/lib/azure/onelake-security-client';
import { reconcileRoleRlsCls } from '@/lib/azure/onelake-rls-reconciler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPES: OneLakeSecurityItemType[] = ['lakehouse', 'mirrored-database', 'mirrored-catalog'];

function parseItemType(v: string): OneLakeSecurityItemType | null {
  return (ITEM_TYPES as string[]).includes(v) ? (v as OneLakeSecurityItemType) : null;
}

/** Validate the incoming CLS rule array; returns the cleaned rules or an error string. */
function validateRules(raw: unknown): { rules: ColumnLevelRule[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'rules must be an array of { table, allowedColumns }' };
  const rules: ColumnLevelRule[] = [];
  const seen = new Set<string>();
  for (const r of raw as any[]) {
    const table = String(r?.table || '').trim();
    if (!table) return { error: 'each rule requires a non-empty table' };
    const allowedColumns = Array.isArray(r?.allowedColumns) ? r.allowedColumns.map((c: unknown) => String(c).trim()) : [];
    const v = isValidColumnList(allowedColumns);
    if (!v.ok) return { error: `table "${table}": ${v.error}` };
    const key = table.toLowerCase();
    if (seen.has(key)) return { error: `duplicate CLS rule for table "${table}"` };
    seen.add(key);
    rules.push({ table, allowedColumns });
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
  const v = validateRules(body?.rules ?? body?.cls);
  if ('error' in v) return NextResponse.json({ ok: false, error: v.error }, { status: 400 });

  try {
    const role = await getRole(params.id, roleDocId(params.id, params.role));
    if (!role) return NextResponse.json({ ok: false, error: 'role not found' }, { status: 404 });

    // Persist FIRST (source of truth; survives a reconcile failure / honest gate).
    role.cls = v.rules;
    role.updatedAt = new Date().toISOString();
    const receipt = await reconcileRoleRlsCls({ id: role.itemId, itemType: role.itemType }, role);
    role.lastReceipt = receipt;
    const saved = await upsertRole(role);

    return NextResponse.json({ ok: true, cls: saved.cls || [], receipt });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
