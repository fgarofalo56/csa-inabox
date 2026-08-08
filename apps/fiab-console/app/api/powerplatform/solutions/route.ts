/**
 * Power Platform solution ALM — list / export / import / delete.
 *
 *   GET    /api/powerplatform/solutions?envId=<env>
 *            → { ok, solutions: DataverseSolution[] }
 *
 *   POST   /api/powerplatform/solutions?envId=<env>
 *            body { action: 'export', uniqueName, managed?, async? }
 *              → sync : { ok, fileName, fileBase64 }
 *              → async: { ok, asyncOperationId, exportJobId }
 *            body { action: 'download-export', exportJobId }
 *              → { ok, fileBase64 }
 *            body { action: 'stage', fileBase64 }
 *              → { ok, uploadId, status, validationResults[] }
 *            body { action: 'import', stageSolutionUploadId? | fileBase64?, … }
 *              → { ok, importJobId, asyncOperationId }
 *            body { action: 'import-status', importJobId, asyncOperationId? }
 *              → { ok, progress, state, status, error? }
 *            body { action: 'publish' }
 *              → { ok }
 *
 *   DELETE /api/powerplatform/solutions?envId=<env>&solutionId=<id>
 *            → { ok }
 *
 * Closes audit-T28 / parity row I5 ("Solutions / ALM (managed/unmanaged,
 * import/export)"), which previously had `listSolutions` and an honest ⚠️ row
 * pointing the operator at the maker portal — deep-link-as-parity, which
 * `ui-parity.md` explicitly rejects.
 *
 * Every action is a real Dataverse Web API call (ExportSolution /
 * ExportSolutionAsync / DownloadSolutionExportData / StageSolution /
 * ImportSolutionAsync / importjobs / asyncoperations / PublishAllXml), grounded
 * in Microsoft Learn "Solution staging, with asynchronous import and export".
 * No Fabric / Power BI dependency — Dataverse is the Azure-native backing
 * service (`no-fabric-dependency.md`).
 *
 * Gating is layered exactly like /api/powerplatform/tables:
 *   - no LOOM_UAMI_CLIENT_ID       → 503 code:'not_configured'
 *   - no LOOM_DATAVERSE_CLIENT_ID  → 503 code:'dataverse_not_configured'
 * The second is a genuine Microsoft platform restriction, not something the
 * deploy can perform for the customer: a UAMI token is NOT a valid Dataverse
 * Application User, so a dedicated SP must be registered as an Application User
 * on the environment by a Power Platform admin. That is the narrowly-allowed
 * tenant-consent case in `auto-bind-by-default.md`.
 *
 * Solution .zip payloads are base64 and can be large; the route caps the
 * accepted upload so a runaway body cannot exhaust the container's memory.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listSolutions, exportSolution, exportSolutionAsync, downloadSolutionExportData,
  stageSolution, importSolutionAsync, getSolutionImportStatus,
  publishAllCustomizations, deleteSolution,
  powerPlatformConfigGate, dataverseConfigGate, PowerPlatformError,
} from '@/lib/azure/powerplatform-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Staging + importing a solution is a long Dataverse operation.
export const maxDuration = 300;

/** Largest accepted base64 solution payload (~48 MB of base64 ≈ 36 MB of zip). */
const MAX_SOLUTION_B64 = 48 * 1024 * 1024;

function err(e: any) {
  const status = e instanceof PowerPlatformError ? e.status : 502;
  return NextResponse.json(
    { ok: false, error: e?.message || String(e), hint: e?.hint, endpoint: e?.endpoint },
    { status },
  );
}

/**
 * Shared gate ladder. Returns a response to send, or null when configured.
 * `what` names the operation so the gate text says what is actually blocked.
 */
function gate(what: string): NextResponse | null {
  const cp = powerPlatformConfigGate();
  if (cp) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Power Platform not configured: set ${cp.missing}.`, missing: cp.missing },
      { status: 503 },
    );
  }
  const dv = dataverseConfigGate();
  if (dv) {
    return NextResponse.json(
      {
        ok: false, code: 'dataverse_not_configured',
        error: `${what} needs a dedicated Dataverse Application-User SP: set ${dv.missing}.`,
        hint: 'Set LOOM_DATAVERSE_CLIENT_ID / LOOM_DATAVERSE_CLIENT_SECRET / LOOM_DATAVERSE_TENANT_ID and register that SP as a Dataverse Application User with the System Administrator (or System Customizer) role on this environment. A managed identity cannot be a Dataverse Application User — this is a Microsoft platform restriction, not a Loom limitation.',
        missing: dv.missing,
      },
      { status: 503 },
    );
  }
  return null;
}

function requireEnv(req: NextRequest): { envId: string } | NextResponse {
  const envId = req.nextUrl.searchParams.get('envId');
  if (!envId) return NextResponse.json({ ok: false, error: 'envId query param is required' }, { status: 400 });
  return { envId };
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate('Listing solutions');
  if (g) return g;
  const e = requireEnv(req);
  if (e instanceof NextResponse) return e;
  try {
    const solutions = await listSolutions(e.envId);
    return NextResponse.json({ ok: true, solutions });
  } catch (ex: any) { return err(ex); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate('Solution import/export');
  if (g) return g;
  const e = requireEnv(req);
  if (e instanceof NextResponse) return e;
  const { envId } = e;

  let body: any;
  try { body = await req.json(); } catch { body = null; }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ ok: false, error: 'JSON body required' }, { status: 400 });
  }
  const action = String(body.action || '');

  try {
    switch (action) {
      case 'export': {
        const uniqueName = String(body.uniqueName || '').trim();
        if (!uniqueName) return NextResponse.json({ ok: false, error: 'uniqueName is required' }, { status: 400 });
        const managed = !!body.managed;
        if (body.async) {
          const job = await exportSolutionAsync(envId, uniqueName, managed);
          return NextResponse.json({ ok: true, ...job });
        }
        const out = await exportSolution(envId, uniqueName, managed, {
          exportAutoNumberingSettings: !!body.exportAutoNumberingSettings,
          exportCalendarSettings: !!body.exportCalendarSettings,
          exportCustomizationSettings: !!body.exportCustomizationSettings,
          exportEmailTrackingSettings: !!body.exportEmailTrackingSettings,
          exportGeneralSettings: !!body.exportGeneralSettings,
          exportIsvConfig: !!body.exportIsvConfig,
          exportMarketingSettings: !!body.exportMarketingSettings,
          exportOutlookSynchronizationSettings: !!body.exportOutlookSynchronizationSettings,
          exportRelationshipRoles: !!body.exportRelationshipRoles,
          exportSales: !!body.exportSales,
        });
        return NextResponse.json({ ok: true, ...out });
      }

      case 'download-export': {
        const exportJobId = String(body.exportJobId || '').trim();
        if (!exportJobId) return NextResponse.json({ ok: false, error: 'exportJobId is required' }, { status: 400 });
        const out = await downloadSolutionExportData(envId, exportJobId);
        return NextResponse.json({ ok: true, ...out });
      }

      case 'stage': {
        const fileBase64 = String(body.fileBase64 || '');
        if (!fileBase64) return NextResponse.json({ ok: false, error: 'fileBase64 (the solution .zip) is required' }, { status: 400 });
        if (fileBase64.length > MAX_SOLUTION_B64) {
          return NextResponse.json({ ok: false, error: 'Solution file is too large for an in-console import (48 MB base64 limit).' }, { status: 413 });
        }
        const out = await stageSolution(envId, fileBase64);
        return NextResponse.json({ ok: true, ...out });
      }

      case 'import': {
        const stageSolutionUploadId = body.stageSolutionUploadId ? String(body.stageSolutionUploadId) : undefined;
        const fileBase64 = body.fileBase64 ? String(body.fileBase64) : undefined;
        if (!stageSolutionUploadId && !fileBase64) {
          return NextResponse.json({ ok: false, error: 'stageSolutionUploadId or fileBase64 is required' }, { status: 400 });
        }
        if (fileBase64 && fileBase64.length > MAX_SOLUTION_B64) {
          return NextResponse.json({ ok: false, error: 'Solution file is too large for an in-console import (48 MB base64 limit).' }, { status: 413 });
        }
        const job = await importSolutionAsync(envId, { stageSolutionUploadId, customizationFileBase64: fileBase64 }, {
          publishWorkflows: body.publishWorkflows !== false,
          overwriteUnmanagedCustomizations: !!body.overwriteUnmanagedCustomizations,
          skipProductUpdateDependencies: !!body.skipProductUpdateDependencies,
          importAsHoldingSolution: !!body.importAsHoldingSolution,
        });
        return NextResponse.json({ ok: true, ...job });
      }

      case 'import-status': {
        const importJobId = String(body.importJobId || '').trim();
        if (!importJobId) return NextResponse.json({ ok: false, error: 'importJobId is required' }, { status: 400 });
        const asyncOperationId = body.asyncOperationId ? String(body.asyncOperationId) : undefined;
        const status = await getSolutionImportStatus(envId, importJobId, asyncOperationId);
        return NextResponse.json({ ok: true, ...status });
      }

      case 'publish': {
        await publishAllCustomizations(envId);
        return NextResponse.json({ ok: true, published: true });
      }

      default:
        return NextResponse.json(
          { ok: false, error: "action must be one of 'export', 'download-export', 'stage', 'import', 'import-status', 'publish'" },
          { status: 400 },
        );
    }
  } catch (ex: any) { return err(ex); }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate('Deleting a solution');
  if (g) return g;
  const e = requireEnv(req);
  if (e instanceof NextResponse) return e;
  const solutionId = req.nextUrl.searchParams.get('solutionId');
  if (!solutionId) return NextResponse.json({ ok: false, error: 'solutionId query param is required' }, { status: 400 });
  try {
    await deleteSolution(e.envId, solutionId);
    return NextResponse.json({ ok: true });
  } catch (ex: any) { return err(ex); }
}
