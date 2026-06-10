/**
 * POST /api/items/warehouse/migrate/scan
 *
 * Step 1 of the SQL DB migration assistant. Accepts a .dacpac upload
 * (multipart/form-data, field `file`), parses the embedded DacFx model, runs a
 * compatibility assessment against the Azure Synapse Dedicated SQL pool surface
 * area (the Azure-native default backing for the Loom "Warehouse"), and returns
 * a structured report PLUS the generated migration T-SQL.
 *
 * Real backend: the parse + assessment are computed entirely from the uploaded
 * bytes (no mocks). This step does NOT touch the pool — it is read-only against
 * the upload, so it works regardless of whether compute is paused/configured.
 * The /import step executes the script against the live pool.
 *
 * Azure-native by default (no-fabric-dependency.md): no Fabric workspace is
 * read or required at any point.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { parseDacpac } from '@/lib/azure/dacpac-model';
import { assessModel, generateDdl } from '@/lib/azure/synapse-compat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 50 * 1024 * 1024; // 50 MiB — model.xml only; data is not in a .dacpac

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

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
    return NextResponse.json(
      { ok: false, error: `File too large (${file.size} bytes). Max ${MAX_BYTES} bytes.` },
      { status: 413 },
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  let model;
  try {
    model = parseDacpac(bytes);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 400 });
  }

  const report = assessModel(model);
  const ddl = generateDdl(model);

  return NextResponse.json({
    ok: true,
    fileName: (file as File).name || 'package.dacpac',
    report,
    // The full migration script + per-statement breakdown the import will run.
    ddl: {
      statements: ddl.statements,
      script: ddl.script,
    },
    scannedBy: session.claims.upn || session.claims.email || session.claims.oid,
  });
}
