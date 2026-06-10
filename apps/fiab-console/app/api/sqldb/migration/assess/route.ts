/**
 * POST /api/sqldb/migration/assess   (multipart: file=<.dacpac>)
 *
 * SQL DB migration assistant — step 1. Parses an uploaded SQL Server / Azure
 * SQL `.dacpac` (a ZIP whose `model.xml` carries the schema) entirely in-process
 * (dependency-free ZIP + XML readers), assesses every object against the Azure
 * Synapse **Dedicated SQL pool** feature set, and returns:
 *   { ok, summary, findings[], plan: { statements[] } }
 *
 * No backend service call is needed for assessment — it's pure analysis of the
 * uploaded bytes. The generated `plan.statements[]` is what
 * `/api/sqldb/migration/import` replays over the real TDS connection.
 *
 * Azure-native: targets the env-bound Synapse Dedicated pool. No Microsoft
 * Fabric dependency — works with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 *
 * Reference (compatibility rules): see dacpac-migration.ts header.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { assessDacpac, buildDdlPlan, DacpacError } from '@/lib/azure/dacpac-migration';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_DACPAC_BYTES = 100 * 1024 * 1024; // 100 MB — model.xml is small; schema-only DACPACs are tiny, but be generous.

function err(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return err('expected multipart/form-data with a "file" field', 400);
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return err('file is required (.dacpac)', 400);

  const fileName = (file.name || 'database.dacpac').trim();
  if (!/\.dacpac$/i.test(fileName)) {
    return err('file must be a .dacpac (a Data-tier Application package produced by SqlPackage/SSDT)', 400);
  }

  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length === 0) return err('uploaded file is empty', 400);
  if (buf.length > MAX_DACPAC_BYTES) return err(`file exceeds ${MAX_DACPAC_BYTES} bytes`, 413);

  try {
    const assessment = assessDacpac(buf);
    const plan = buildDdlPlan(assessment.model, assessment.findings);
    return NextResponse.json({
      ok: true,
      fileName,
      databaseName: assessment.model.databaseName,
      summary: assessment.summary,
      findings: assessment.findings,
      schemas: assessment.model.schemas,
      tables: assessment.model.tables.map((t) => ({
        schema: t.schema,
        name: t.name,
        columnCount: t.columns.length,
        columns: t.columns.map((c) => ({ name: c.name, dataType: c.dataType, nullable: c.nullable, isIdentity: c.isIdentity })),
      })),
      plan,
    });
  } catch (e: any) {
    if (e instanceof DacpacError) return err(e.message, 422);
    return err(e?.message || String(e), 500);
  }
}
