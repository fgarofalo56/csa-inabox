/**
 * POST /api/items/warehouse/migrate/import
 *
 * Step 2 of the SQL DB migration assistant. Re-parses the uploaded .dacpac
 * (multipart/form-data, field `file`), re-generates the Dedicated SQL pool DDL
 * (so the executed script is exactly what the scan reported — the client never
 * supplies raw SQL), and executes each statement against the LIVE Synapse
 * Dedicated SQL pool via the real TDS path (synapse-sql-client.executeQuery).
 *
 * - The pool must be Online (honest 409 with the resume hint otherwise).
 * - `kinds` (query param, comma list) optionally restricts which object kinds
 *   are imported (schema,table,view,procedure,function) — the wizard uses this
 *   to let the operator import schema-only first.
 * - Each statement is executed independently; the response carries a per-object
 *   result (applied / failed + the real SQL error) so partial failures are
 *   visible. No simulated success.
 *
 * Azure-native by default (no-fabric-dependency.md): the backend is the Synapse
 * Dedicated SQL pool — no Fabric workspace is read or required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { parseDacpac } from '@/lib/azure/dacpac-model';
import { generateDdl, type GeneratedDdl } from '@/lib/azure/synapse-compat';
import { dedicatedTarget, executeQuery } from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 50 * 1024 * 1024;
const ALL_KINDS = new Set(['schema', 'table', 'view', 'procedure', 'function']);

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // Parse the kind filter (default: all).
  const kindsParam = req.nextUrl.searchParams.get('kinds');
  const kinds = kindsParam
    ? new Set(kindsParam.split(',').map((k) => k.trim().toLowerCase()).filter((k) => ALL_KINDS.has(k)))
    : ALL_KINDS;
  const continueOnError = req.nextUrl.searchParams.get('continueOnError') !== 'false';

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Expected multipart/form-data with a "file" field (.dacpac).' },
      { status: 400 },
    );
  }
  const file = form.get('file');
  if (!file || !(file instanceof Blob)) {
    return NextResponse.json({ ok: false, error: '"file" field is required (.dacpac).' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ ok: false, error: `File too large. Max ${MAX_BYTES} bytes.` }, { status: 413 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  let ddl: GeneratedDdl;
  try {
    const model = parseDacpac(bytes);
    ddl = generateDdl(model);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 400 });
  }

  // Honest infra gate: dedicatedTarget() throws when LOOM_SYNAPSE_* is unset.
  let target;
  try {
    target = dedicatedTarget();
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        gate: {
          reason: e?.message || 'Synapse Dedicated SQL pool not configured.',
          remediation: 'Set LOOM_SYNAPSE_WORKSPACE and LOOM_SYNAPSE_DEDICATED_POOL, and grant the Console UAMI Synapse Administrator on the workspace.',
        },
        error: e?.message || String(e),
      },
      { status: 409 },
    );
  }

  // Pool must be Online to run DDL.
  const state = await getPoolState().catch(() => null);
  if (state && state.state !== 'Online') {
    return NextResponse.json(
      {
        ok: false,
        state: state.state,
        error: `Warehouse compute is ${state.state}. Resume the Dedicated SQL pool before importing.`,
      },
      { status: 409 },
    );
  }

  const selected = ddl.statements.filter((s) => kinds.has(s.kind));
  if (selected.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'No statements to import for the selected object kinds.' },
      { status: 400 },
    );
  }

  const results: {
    kind: string;
    name: string;
    status: 'applied' | 'failed';
    recordsAffected?: number;
    error?: string;
  }[] = [];

  for (const stmt of selected) {
    try {
      const r = await executeQuery(target, stmt.sql, 120_000);
      results.push({ kind: stmt.kind, name: stmt.name, status: 'applied', recordsAffected: r.recordsAffected });
    } catch (e: any) {
      results.push({ kind: stmt.kind, name: stmt.name, status: 'failed', error: e?.message || String(e) });
      if (!continueOnError) break;
    }
  }

  const applied = results.filter((r) => r.status === 'applied').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  return NextResponse.json({
    ok: failed === 0,
    summary: { total: selected.length, applied, failed },
    results,
    warehouse: process.env.LOOM_SYNAPSE_DEDICATED_POOL,
    database: target.database,
    importedBy: session.claims.upn || session.claims.email || session.claims.oid,
  });
}
