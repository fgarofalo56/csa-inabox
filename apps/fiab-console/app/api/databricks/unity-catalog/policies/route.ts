/**
 * Unity Catalog ABAC POLICIES — tag-driven row-filter + column-mask policies.
 *
 *   GET  /api/databricks/unity-catalog/policies?securable_type=&securable_name=[&effective=true][&describe=name][&warehouseId=]
 *          → { ok, policies[] }   (SHOW [EFFECTIVE] POLICIES ON …)
 *          → { ok, describe[] }   (DESCRIBE POLICY name ON …)
 *   POST /api/databricks/unity-catalog/policies
 *          body { action:'create', preview?, params:{…UcPolicyParams}, warehouseId? }
 *          body { action:'drop', name, securable_type, securable_name, warehouseId? }
 *          → { ok, sql, executionMs? }
 *
 * Real Databricks SQL DDL (Learn-grounded), executed over the SQL Statement
 * Execution API — no mocks:
 *   CREATE [OR REPLACE] POLICY … {ROW FILTER|COLUMN MASK} … [WHEN has_tag_value(…)]
 *     [MATCH COLUMNS has_tag(…) AS alias] [ON COLUMN alias] [USING COLUMNS (…)]
 *   DROP POLICY · SHOW [EFFECTIVE] POLICIES · DESCRIBE POLICY
 *   https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/abac/policies
 *
 * The data-plane REST equivalent (/api/2.1/unity-catalog/policies) exists but is
 * preview; we drive the Learn-grounded SQL DDL on the warehouse for reliability.
 * Console UAMI needs `MANAGE` on the scope securable + `EXECUTE` on the UDF.
 * Honest gate at the GCC-High / DoD boundary.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate, listWarehouses } from '@/lib/azure/databricks-client';
import { isGovCloud, cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';
import { listUcPolicies, describeUcPolicy, createUcPolicy, dropUcPolicy } from '@/lib/azure/unity-catalog-client';
import {
  UcBuildError,
  type UcPolicyParams, type UcPolicySecurableType, type UcPolicyType,
  type UcTagCondition, type UcUsingArg,
} from '@/lib/sql/uc-security-builders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SECURABLES = new Set<UcPolicySecurableType>(['CATALOG', 'SCHEMA', 'TABLE']);
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
        `ABAC policies are not available at the ${cloudBoundaryLabel()} boundary. ` +
        `They require a Commercial or GCC Databricks workspace (Microsoft Entra-connected metastore, DBR 16.4+). ` +
        `At this boundary use the Synapse Dedicated SQL pool column-GRANT + Row-Level Security wizards instead.`,
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

function asSecurableType(v: string): UcPolicySecurableType | null {
  const t = String(v || '').toUpperCase().trim() as UcPolicySecurableType;
  return SECURABLES.has(t) ? t : null;
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = resolveGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });

  const securableType = asSecurableType(req.nextUrl.searchParams.get('securable_type') || '');
  const securableName = req.nextUrl.searchParams.get('securable_name')?.trim();
  const effective = req.nextUrl.searchParams.get('effective') === 'true';
  const describe = req.nextUrl.searchParams.get('describe')?.trim() || undefined;
  if (!securableType) return NextResponse.json({ ok: false, error: `securable_type must be one of ${[...SECURABLES].join(', ')}` }, { status: 400 });
  if (!securableName) return NextResponse.json({ ok: false, error: 'securable_name is required' }, { status: 400 });

  let warehouseId: string;
  try {
    warehouseId = await resolveWarehouseId(req.nextUrl.searchParams.get('warehouseId')?.trim() || undefined);
  } catch (e: any) {
    return NextResponse.json({ ok: false, gated: true, error: e?.message || String(e) }, { status: 200 });
  }

  try {
    if (describe) {
      const rows = await describeUcPolicy(warehouseId, { name: describe, securableType, securableName });
      return NextResponse.json({ ok: true, describe: rows });
    }
    const policies = await listUcPolicies(warehouseId, { securableType, securableName, effective });
    return NextResponse.json({ ok: true, securableType, securableName, effective, policies });
  } catch (e: any) {
    const status = e instanceof UcBuildError ? 400 : (e?.status || 502);
    return NextResponse.json({ ok: false, error: e?.message || String(e), code: e?.code }, { status });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = resolveGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const action = String(body?.action || 'create');

  let warehouseId: string;
  try {
    warehouseId = await resolveWarehouseId(body?.warehouseId ? String(body.warehouseId).trim() : undefined);
  } catch (e: any) {
    return NextResponse.json({ ok: false, gated: true, error: e?.message || String(e) }, { status: 200 });
  }

  // ---- Drop ----
  if (action === 'drop') {
    const name = String(body?.name || '').trim();
    const securableType = asSecurableType(body?.securable_type || '');
    const securableName = String(body?.securable_name || '').trim();
    if (!name || !securableType || !securableName) {
      return NextResponse.json({ ok: false, error: 'drop requires name, securable_type and securable_name' }, { status: 400 });
    }
    try {
      const r = await dropUcPolicy(warehouseId, { name, securableType, securableName });
      return NextResponse.json({ ok: true, sql: r.sql, executionMs: r.executionMs, executedBy: session.claims.upn });
    } catch (e: any) {
      const status = e instanceof UcBuildError ? 400 : (e?.status || 502);
      return NextResponse.json({ ok: false, error: e?.message || String(e), code: e?.code }, { status });
    }
  }

  // ---- Create (or preview) ----
  const raw = body?.params ?? {};
  const securableType = asSecurableType(raw?.securableType || raw?.securable_type || '');
  const policyType = String(raw?.policyType || raw?.policy_type || '').toUpperCase().trim() as UcPolicyType;
  if (!securableType) return NextResponse.json({ ok: false, error: `params.securableType must be one of ${[...SECURABLES].join(', ')}` }, { status: 400 });
  if (policyType !== 'ROW FILTER' && policyType !== 'COLUMN MASK') {
    return NextResponse.json({ ok: false, error: "params.policyType must be 'ROW FILTER' or 'COLUMN MASK'" }, { status: 400 });
  }

  const toPrincipals: string[] = Array.isArray(raw?.toPrincipals) ? raw.toPrincipals.map((x: any) => String(x || '').trim()).filter(Boolean) : [];
  const exceptPrincipals: string[] = Array.isArray(raw?.exceptPrincipals) ? raw.exceptPrincipals.map((x: any) => String(x || '').trim()).filter(Boolean) : [];
  const matchColumns: UcTagCondition[] = Array.isArray(raw?.matchColumns)
    ? raw.matchColumns.map((m: any) => ({ tagKey: String(m?.tagKey || '').trim(), tagValue: m?.tagValue ? String(m.tagValue).trim() : undefined, alias: m?.alias ? String(m.alias).trim() : undefined })).filter((m: UcTagCondition) => m.tagKey)
    : [];
  const usingColumns: UcUsingArg[] = Array.isArray(raw?.usingColumns)
    ? raw.usingColumns.map((u: any) => ({ kind: (u?.kind === 'int' || u?.kind === 'string') ? u.kind : 'alias', value: String(u?.value ?? '').trim() })).filter((u: UcUsingArg) => u.value)
    : [];
  const when: UcTagCondition | undefined = raw?.when && String(raw.when?.tagKey || '').trim()
    ? { tagKey: String(raw.when.tagKey).trim(), tagValue: raw.when.tagValue ? String(raw.when.tagValue).trim() : undefined }
    : undefined;

  const params: UcPolicyParams = {
    name: String(raw?.name || '').trim(),
    orReplace: raw?.orReplace === true,
    securableType,
    securableName: String(raw?.securableName || raw?.securable_name || '').trim(),
    comment: raw?.comment ? String(raw.comment) : undefined,
    policyType,
    functionName: String(raw?.functionName || raw?.function_name || '').trim(),
    toPrincipals,
    exceptPrincipals: exceptPrincipals.length ? exceptPrincipals : undefined,
    when,
    matchColumns: matchColumns.length ? matchColumns : undefined,
    onColumnAlias: raw?.onColumnAlias ? String(raw.onColumnAlias).trim() : undefined,
    usingColumns: usingColumns.length ? usingColumns : undefined,
  };

  try {
    const r = await createUcPolicy(warehouseId, params, body?.preview === true);
    return NextResponse.json({ ok: true, preview: body?.preview === true, sql: r.sql, executionMs: r.executionMs, executedBy: session.claims.upn });
  } catch (e: any) {
    const status = e instanceof UcBuildError ? 400 : (e?.status || 502);
    return NextResponse.json({ ok: false, error: e?.message || String(e), code: e?.code }, { status });
  }
}
