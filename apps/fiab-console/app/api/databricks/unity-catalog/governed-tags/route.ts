/**
 * Unity Catalog GOVERNED TAGS — account-level governed tag definitions + their
 * tag policies (allowed values).
 *
 *   GET  /api/databricks/unity-catalog/governed-tags[?pattern=][&describe=key][&warehouseId=]
 *          → { ok, governedTags[] }  (SHOW GOVERNED TAGS [LIKE pattern])
 *          → { ok, describe[] }      (DESCRIBE GOVERNED TAG key)
 *   POST /api/databricks/unity-catalog/governed-tags
 *          body { action:'create'|'alter-description'|'alter-values'|'drop',
 *                 key, description?, values?:[], warehouseId? }
 *          → { ok, sql, executionMs }
 *
 * Real Databricks SQL DDL (Learn-grounded), executed over the SQL Statement
 * Execution API — no mocks:
 *   CREATE/ALTER/DROP/DESCRIBE GOVERNED TAG · SHOW GOVERNED TAGS
 *   https://learn.microsoft.com/azure/databricks/admin/governed-tags/manage-governed-tags
 *
 * Governed tags are an account-level resource: CREATE needs the account-level
 * `CREATE` permission; ALTER/DROP need `MANAGE` on the governed tag. UC errors
 * (incl. permission denials) are surfaced verbatim. Honest gate at the GCC-High
 * / DoD boundary (UC requires an Entra-connected metastore).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate, listWarehouses } from '@/lib/azure/databricks-client';
import { isGovCloud, cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';
import {
  listUcGovernedTags, describeUcGovernedTag, mutateUcGovernedTag,
  type GovernedTagAction,
} from '@/lib/azure/unity-catalog-client';
import { UcBuildError } from '@/lib/sql/uc-security-builders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Gate { gated: true; error: string }

function resolveGate(): Gate | null {
  const cfg = databricksConfigGate();
  if (cfg) {
    return { gated: true, error: `Databricks is not configured in this deployment. Set ${cfg.missing} on the Console (landing-zone bicep deploys the Databricks workspace).` };
  }
  if (isGovCloud()) {
    return {
      gated: true,
      error:
        `Governed tags are not available at the ${cloudBoundaryLabel()} boundary. ` +
        `They require a Commercial or GCC Databricks account (Microsoft Entra-connected metastore, DBR 18.1+).`,
    };
  }
  return null;
}

async function resolveWarehouseId(requested?: string): Promise<string> {
  if (requested) return requested;
  const warehouses = await listWarehouses();
  const running = warehouses.find((w) => w.state === 'RUNNING') || warehouses[0];
  if (!running) throw new Error('No SQL warehouse found. Create or start a SQL warehouse in the Databricks workspace.');
  return running.id;
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = resolveGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });

  const pattern = req.nextUrl.searchParams.get('pattern')?.trim() || undefined;
  const describe = req.nextUrl.searchParams.get('describe')?.trim() || undefined;

  let warehouseId: string;
  try {
    warehouseId = await resolveWarehouseId(req.nextUrl.searchParams.get('warehouseId')?.trim() || undefined);
  } catch (e: any) {
    return NextResponse.json({ ok: false, gated: true, error: e?.message || String(e) }, { status: 200 });
  }

  try {
    if (describe) {
      const rows = await describeUcGovernedTag(warehouseId, describe);
      return NextResponse.json({ ok: true, describe: rows });
    }
    const governedTags = await listUcGovernedTags(warehouseId, pattern);
    return NextResponse.json({ ok: true, governedTags });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = resolveGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  const allowed: GovernedTagAction[] = ['create', 'alter-description', 'alter-values', 'drop'];
  const action = String(body?.action || '') as GovernedTagAction;
  const key = String(body?.key || '').trim();
  if (!allowed.includes(action)) return NextResponse.json({ ok: false, error: `action must be one of ${allowed.join(', ')}` }, { status: 400 });
  if (!key) return NextResponse.json({ ok: false, error: 'key is required' }, { status: 400 });

  const description = body?.description !== undefined ? String(body.description) : undefined;
  const values: string[] | undefined = Array.isArray(body?.values)
    ? body.values.map((v: any) => String(v || '').trim()).filter(Boolean)
    : undefined;

  let warehouseId: string;
  try {
    warehouseId = await resolveWarehouseId(body?.warehouseId ? String(body.warehouseId).trim() : undefined);
  } catch (e: any) {
    return NextResponse.json({ ok: false, gated: true, error: e?.message || String(e) }, { status: 200 });
  }

  try {
    const r = await mutateUcGovernedTag(warehouseId, { action, key, description, values });
    return NextResponse.json({ ok: true, sql: r.sql, executionMs: r.executionMs, executedBy: session.claims.upn });
  } catch (e: any) {
    const status = e instanceof UcBuildError ? 400 : (e?.status || 502);
    return NextResponse.json({ ok: false, error: e?.message || String(e), code: e?.code }, { status });
  }
}
