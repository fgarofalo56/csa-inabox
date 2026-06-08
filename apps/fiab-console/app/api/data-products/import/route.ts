/**
 * POST /api/data-products/import?workspaceId=<id>
 *
 * Bulk-creates DRAFT `data-product` items from an uploaded CSV (≤1000 rows) and
 * tracks the run in a `dataproduct-jobs` Cosmos document so the flyout's Monitor
 * tab can poll live success/fail counts (F2 import + F18 job monitoring).
 *
 * Flow (all real — no mock):
 *   1. Authenticate + verify the caller's tenant owns the target workspace.
 *   2. Parse multipart/form-data, extract the "file" Blob, decode UTF-8 text.
 *   3. Authoritative server-side parse + validation (lib/util/csv-parse.ts) —
 *      a second fence behind the client-side pre-validation.
 *   4. Stage the raw CSV bytes to ADLS Gen2 csv-imports/<jobId>.csv (best-effort
 *      — when LOOM_CSV_IMPORTS_URL is unset the storage gate fires, staging is
 *      skipped, and the import still runs inline; the gate is disclosed).
 *   5. Write a `running` job doc with totalRows, return 202 { ok, jobId }.
 *   6. In the background: per-row createOwnedItem('data-product', …). A row that
 *      fails (empty required cell, etc.) is recorded in rowErrors and DOES NOT
 *      abort the valid rows. Progress is persisted so the Monitor shows live
 *      counts; the final status is done | partial | failed.
 *
 * Column contract (see the /template route): name, description, domain, owner,
 * tags? — name/description/domain/owner are required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  workspacesContainer,
  dataproductJobsContainer,
  type DataProductImportJob,
} from '@/lib/azure/cosmos-client';
import { createOwnedItem } from '@/app/api/items/_lib/item-crud';
import { uploadFile } from '@/lib/azure/adls-client';
import { validateImportCsv, splitTags, MAX_IMPORT_ROWS } from '@/lib/util/csv-parse';
import type { Workspace } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB hard cap on the uploaded CSV

function err(error: string, status: number, extra?: object) {
  return NextResponse.json({ ok: false, error, ...(extra || {}) }, { status });
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401);
  const tenantId = session.claims.oid;

  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId is required', 400);

  // 1. Verify the workspace belongs to this tenant before touching anything.
  const wsContainer = await workspacesContainer();
  try {
    const { resource: ws } = await wsContainer.item(workspaceId, tenantId).read<Workspace>();
    if (!ws || ws.tenantId !== tenantId) return err('workspace not found', 404);
  } catch (e: any) {
    if (e?.code === 404) return err('workspace not found', 404);
    return err(e?.message || String(e), 500);
  }

  // 2. Parse multipart/form-data.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return err('Expected multipart/form-data with a "file" field', 400);
  }
  const file = form.get('file');
  if (!file || !(file instanceof Blob)) return err('"file" field is required', 400);

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length === 0) return err('Uploaded CSV is empty', 400);
  if (bytes.length > MAX_BYTES) {
    return err(`CSV exceeds the ${MAX_BYTES / (1024 * 1024)} MB limit`, 413);
  }
  const text = bytes.toString('utf-8');

  // 3. Authoritative server-side parse + validation.
  const v = validateImportCsv(text);
  if (v.parsed.rows.length === 0) {
    return err('CSV has a header but no data rows', 400);
  }
  if (v.tooLarge) {
    return err(`CSV has ${v.parsed.rows.length} rows — the limit is ${MAX_IMPORT_ROWS}. Trim the file and re-upload.`, 400);
  }
  // Missing-required-column errors carry sheet row 1 (the header). If any exist
  // the whole file is malformed — reject before creating a job.
  const headerErrors = v.errors.filter((e) => e.row === 1);
  if (headerErrors.length > 0) {
    return err(headerErrors.map((e) => e.error).join('; '), 400, { columnErrors: headerErrors });
  }

  const totalRows = v.parsed.rows.length;
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();

  // 4. Stage the raw CSV to ADLS (best-effort, honest gate when unconfigured).
  let staged = false;
  let blobPath = '';
  let storageGate: { missing: string; message: string } | null = null;
  if (process.env.LOOM_CSV_IMPORTS_URL) {
    try {
      blobPath = `${jobId}.csv`;
      await uploadFile('csv-imports', blobPath, bytes, 'text/csv');
      staged = true;
    } catch (e: any) {
      staged = false;
      blobPath = '';
      storageGate = {
        missing: 'LOOM_CSV_IMPORTS_URL',
        message: `CSV staging to ADLS failed (${e?.message || e}). Import still runs inline (Cosmos only).`,
      };
    }
  } else {
    storageGate = {
      missing: 'LOOM_CSV_IMPORTS_URL',
      message: 'ADLS csv-imports container not configured — CSV not archived to Blob. Import still runs inline (Cosmos only). Set LOOM_CSV_IMPORTS_URL and grant the Console UAMI Storage Blob Data Contributor to enable archival.',
    };
  }

  // 5. Write the running job doc, then return 202.
  const jobs = await dataproductJobsContainer();
  const initial: DataProductImportJob = {
    id: jobId,
    tenantId,
    status: 'running',
    totalRows,
    successCount: 0,
    failCount: 0,
    rowErrors: [],
    createdAt: now,
    updatedAt: now,
    workspaceId,
    blobPath,
    staged,
    createdBy: session.claims.upn || session.claims.email || tenantId,
  };
  try {
    await jobs.items.create<DataProductImportJob>(initial);
  } catch (e: any) {
    return err(`Failed to create import job: ${e?.message || e}`, 500);
  }

  // 6. Process rows in the background (floating promise). The Container App
  //    Node process stays alive across the response, so the loop completes and
  //    the Monitor tab observes the progressing counts. Each row is fenced —
  //    a failure is recorded and never aborts the remaining valid rows.
  void processRows(session, workspaceId, tenantId, jobId, v.parsed.rows);

  return NextResponse.json(
    {
      ok: true,
      jobId,
      totalRows,
      staged,
      ...(storageGate ? { gate: storageGate } : {}),
    },
    { status: 202 },
  );
}

/**
 * Per-row import loop. Persists progress every few rows (and at the end) so the
 * Monitor tab's 5s poll reflects live counts. Best-effort — every Cosmos write
 * is fenced so a transient failure never crashes the worker.
 */
async function processRows(
  session: Parameters<typeof createOwnedItem>[0],
  workspaceId: string,
  tenantId: string,
  jobId: string,
  rows: Array<Record<string, string>>,
): Promise<void> {
  const rowErrors: DataProductImportJob['rowErrors'] = [];
  let successCount = 0;
  let failCount = 0;

  const persist = async (status: DataProductImportJob['status']) => {
    try {
      const jobs = await dataproductJobsContainer();
      const { resource } = await jobs.item(jobId, tenantId).read<DataProductImportJob>();
      if (!resource) return;
      const next: DataProductImportJob = {
        ...resource,
        status,
        successCount,
        failCount,
        rowErrors,
        updatedAt: new Date().toISOString(),
      };
      await jobs.item(jobId, tenantId).replace<DataProductImportJob>(next);
    } catch {
      // best-effort progress write — never throw out of the worker
    }
  };

  for (let i = 0; i < rows.length; i++) {
    const sheetRow = i + 2; // header = row 1
    const r = rows[i];
    const name = (r.name || '').trim();
    try {
      if (!name) throw new Error('"name" is empty');
      if (!(r.owner || '').trim()) throw new Error('"owner" is empty');
      const res = await createOwnedItem(session, 'data-product', {
        workspaceId,
        displayName: name,
        description: (r.description || '').trim() || undefined,
        state: {
          displayName: name,
          description: (r.description || '').trim(),
          domain: (r.domain || '').trim(),
          owner: (r.owner || '').trim(),
          certified: false,
          sla: '',
          bundle: splitTags(r.tags).map((t) => `Tag: ${t}`),
        },
      });
      if (res.ok) successCount++;
      else { failCount++; rowErrors.push({ row: sheetRow, name, error: res.error }); }
    } catch (e: any) {
      failCount++;
      rowErrors.push({ row: sheetRow, name, error: e?.message || String(e) });
    }
    // Persist progress every 5 rows so the Monitor shows it advancing.
    if ((i + 1) % 5 === 0) await persist('running');
  }

  const finalStatus: DataProductImportJob['status'] =
    failCount === rows.length ? 'failed' : failCount > 0 ? 'partial' : 'done';
  await persist(finalStatus);
}
