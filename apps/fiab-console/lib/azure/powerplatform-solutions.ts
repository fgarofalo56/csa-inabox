/**
 * Power Platform / Dataverse solution ALM — export, stage, import, publish.
 *
 * Split out of `powerplatform-client.ts` so that client stays under the
 * monolith-creep ratchet (`scripts/ci/check-file-size.mjs`) — the guard is
 * doing its job, and the honest answer to "the file grew" is a module, not a
 * baseline bump.
 *
 * Shares ONE transport with the parent client (`ppCall` + `dataverseBase`)
 * rather than re-implementing dual-identity auth and error shaping, which is
 * how those two would drift apart.
 *
 * Closes audit-T28 / parity row I5. Grounded in Microsoft Learn "Solution
 * staging, with asynchronous import and export"
 * (https://learn.microsoft.com/power-platform/alm/solution-async) and the
 * Dataverse Web API action reference. Azure-native — Dataverse is the backing
 * service, no Fabric / Power BI tenant required (`no-fabric-dependency.md`).
 */
import crypto from 'node:crypto';
import { ppCall, dataverseBase, PowerPlatformError } from './powerplatform-client';

/** A staged/queued solution job the UI can poll. */
export interface SolutionJobRef {
  /** Async operation id — poll `asyncoperations({id})` for statecode/statuscode. */
  asyncOperationId?: string;
  /** Import job id — poll `importjobs({id})` for `progress` + the result XML. */
  importJobId?: string;
  /** Export job id — pass to `downloadSolutionExportData`. */
  exportJobId?: string;
}

/** Progress of a running/finished solution import. */
export interface SolutionImportStatus {
  importJobId: string;
  /** 0-100. Dataverse reports fractional progress; rounded here for display. */
  progress: number;
  /** Async-operation state when the job was queued asynchronously. */
  state?: string;
  status?: string;
  startedOn?: string;
  completedOn?: string;
  /** Human-readable failure text extracted from the job when it failed. */
  error?: string;
}

/**
 * Export a solution as a .zip. Synchronous `ExportSolution` action — returns the
 * base64 `ExportSolutionFile`. Used for solutions small enough to export inline;
 * `exportSolutionAsync` handles the large/timeout-prone case.
 *
 * `managed` selects a managed (true) or unmanaged (false) export, matching the
 * maker portal's Export choice.
 */
export async function exportSolution(
  envId: string,
  uniqueName: string,
  managed: boolean,
  opts: {
    exportAutoNumberingSettings?: boolean;
    exportCalendarSettings?: boolean;
    exportCustomizationSettings?: boolean;
    exportEmailTrackingSettings?: boolean;
    exportGeneralSettings?: boolean;
    exportIsvConfig?: boolean;
    exportMarketingSettings?: boolean;
    exportOutlookSynchronizationSettings?: boolean;
    exportRelationshipRoles?: boolean;
    exportSales?: boolean;
  } = {},
): Promise<{ fileBase64: string; fileName: string }> {
  const { url, scope } = await dataverseBase(envId);
  const j = await ppCall<{ ExportSolutionFile: string }>(
    `${url}/api/data/v9.2/ExportSolution`,
    scope,
    {
      method: 'POST',
      body: {
        SolutionName: uniqueName,
        Managed: managed,
        ExportAutoNumberingSettings: !!opts.exportAutoNumberingSettings,
        ExportCalendarSettings: !!opts.exportCalendarSettings,
        ExportCustomizationSettings: !!opts.exportCustomizationSettings,
        ExportEmailTrackingSettings: !!opts.exportEmailTrackingSettings,
        ExportGeneralSettings: !!opts.exportGeneralSettings,
        ExportIsvConfig: !!opts.exportIsvConfig,
        ExportMarketingSettings: !!opts.exportMarketingSettings,
        ExportOutlookSynchronizationSettings: !!opts.exportOutlookSynchronizationSettings,
        ExportRelationshipRoles: !!opts.exportRelationshipRoles,
        ExportSales: !!opts.exportSales,
      },
    },
  );
  if (!j?.ExportSolutionFile) {
    throw new PowerPlatformError(
      `Dataverse returned no ExportSolutionFile for solution "${uniqueName}".`,
      502, j, undefined,
      'The export succeeded but carried no payload. Retry, or use the asynchronous export for a large solution.',
    );
  }
  return {
    fileBase64: j.ExportSolutionFile,
    fileName: `${uniqueName}_${managed ? 'managed' : 'unmanaged'}.zip`,
  };
}

/**
 * Start an ASYNCHRONOUS solution export (`ExportSolutionAsync`). Returns the
 * `AsyncOperationId` (track the job) + `ExportJobId` (fetch the file when the
 * job reaches statecode 3 / statuscode 30). This is the documented path for a
 * solution large enough that the synchronous export times out.
 */
export async function exportSolutionAsync(
  envId: string, uniqueName: string, managed: boolean,
): Promise<SolutionJobRef> {
  const { url, scope } = await dataverseBase(envId);
  const j = await ppCall<{ AsyncOperationId?: string; ExportJobId?: string }>(
    `${url}/api/data/v9.2/ExportSolutionAsync`,
    scope,
    { method: 'POST', body: { SolutionName: uniqueName, Managed: managed } },
  );
  return { asyncOperationId: j?.AsyncOperationId, exportJobId: j?.ExportJobId };
}

/**
 * Download the file produced by `exportSolutionAsync` once its async operation
 * has succeeded (`DownloadSolutionExportData` → `ExportSolutionFile`).
 */
export async function downloadSolutionExportData(
  envId: string, exportJobId: string,
): Promise<{ fileBase64: string }> {
  const { url, scope } = await dataverseBase(envId);
  const j = await ppCall<{ ExportSolutionFile: string }>(
    `${url}/api/data/v9.2/DownloadSolutionExportData`,
    scope,
    { method: 'POST', body: { ExportJobId: exportJobId } },
  );
  if (!j?.ExportSolutionFile) {
    throw new PowerPlatformError(
      'The export job produced no file yet.', 409, j, undefined,
      'The asynchronous export has not finished. Poll the async operation until it reports Succeeded, then download again.',
    );
  }
  return { fileBase64: j.ExportSolutionFile };
}

/**
 * Stage a solution (`StageSolution`) — validates the .zip and returns the
 * validation results plus a `StageSolutionUploadId` for `ImportSolutionAsync`.
 *
 * Staging first is what makes the import surface honest: the operator sees the
 * missing-dependency / version-conflict findings BEFORE anything is applied,
 * which is exactly what the maker portal's import wizard shows.
 */
export async function stageSolution(
  envId: string, customizationFileBase64: string,
): Promise<{
  uploadId?: string;
  status?: string;
  solutionDetails?: any;
  validationResults: Array<{ errorCode?: number; message?: string; solutionValidationResultType?: string }>;
}> {
  const { url, scope } = await dataverseBase(envId);
  const j = await ppCall<any>(
    `${url}/api/data/v9.2/StageSolution`,
    scope,
    { method: 'POST', body: { CustomizationFile: customizationFileBase64 } },
  );
  const r = j?.StageSolutionResults || j || {};
  return {
    uploadId: r.StageSolutionUploadId,
    status: r.StageSolutionStatus,
    solutionDetails: r.SolutionDetails,
    validationResults: Array.isArray(r.SolutionValidationResults)
      ? r.SolutionValidationResults.map((v: any) => ({
        errorCode: v?.ErrorCode,
        message: v?.Message,
        solutionValidationResultType: v?.SolutionValidationResultType,
      }))
      : [],
  };
}

/**
 * Import a solution asynchronously (`ImportSolutionAsync`). Accepts either a
 * staged upload id (preferred — the solution was already validated) or a raw
 * base64 .zip.
 *
 * Returns `ImportJobKey` (→ `importjobs`, for progress) and `AsyncOperationId`
 * (→ `asyncoperations`, for job status), per Learn.
 */
export async function importSolutionAsync(
  envId: string,
  input: { stageSolutionUploadId?: string; customizationFileBase64?: string },
  opts: {
    publishWorkflows?: boolean;
    overwriteUnmanagedCustomizations?: boolean;
    skipProductUpdateDependencies?: boolean;
    importAsHoldingSolution?: boolean;
  } = {},
): Promise<SolutionJobRef> {
  if (!input.stageSolutionUploadId && !input.customizationFileBase64) {
    throw new PowerPlatformError(
      'importSolutionAsync needs either a staged upload id or a solution file.', 400, null, undefined,
      'Stage the solution first (recommended, so validation runs), or supply the .zip contents.',
    );
  }
  const { url, scope } = await dataverseBase(envId);
  const body: Record<string, unknown> = {
    PublishWorkflows: opts.publishWorkflows !== false,
    OverwriteUnmanagedCustomizations: !!opts.overwriteUnmanagedCustomizations,
    SkipProductUpdateDependencies: !!opts.skipProductUpdateDependencies,
    ImportJobId: crypto.randomUUID(),
    ComponentParameters: [],
  };
  if (opts.importAsHoldingSolution) body.HoldingSolution = true;
  if (input.stageSolutionUploadId) {
    body.SolutionParameters = { StageSolutionUploadId: input.stageSolutionUploadId };
    // ImportSolutionAsync still requires the CustomizationFile property to be
    // present; an empty string is the documented value when importing a
    // previously-staged solution by upload id.
    body.CustomizationFile = '';
  } else {
    body.CustomizationFile = input.customizationFileBase64;
  }
  const j = await ppCall<{ ImportJobKey?: string; AsyncOperationId?: string }>(
    `${url}/api/data/v9.2/ImportSolutionAsync`, scope, { method: 'POST', body },
  );
  return { importJobId: j?.ImportJobKey, asyncOperationId: j?.AsyncOperationId };
}

/**
 * Poll an import job's progress. Reads `importjobs({id})` for `progress` and,
 * when available, the async operation for state/status + the failure message.
 *
 * Per deploy-integrity R7 a not-yet-created job row is reported as "queued, no
 * progress yet" rather than as a failure — the job record appears a moment
 * after ImportSolutionAsync returns.
 */
export async function getSolutionImportStatus(
  envId: string, importJobId: string, asyncOperationId?: string,
): Promise<SolutionImportStatus> {
  const { url, scope } = await dataverseBase(envId);
  const out: SolutionImportStatus = { importJobId, progress: 0 };
  try {
    const job = await ppCall<any>(
      `${url}/api/data/v9.2/importjobs(${encodeURIComponent(importJobId)})`,
      scope,
      { query: { '$select': 'importjobid,progress,startedon,completedon,data' } },
    );
    out.progress = Math.round(Number(job?.progress ?? 0));
    out.startedOn = job?.startedon;
    out.completedOn = job?.completedon;
  } catch (e: any) {
    // 404 = the job row has not materialized yet. Anything else is real.
    if (e?.status !== 404) throw e;
  }
  if (asyncOperationId) {
    try {
      const op = await ppCall<any>(
        `${url}/api/data/v9.2/asyncoperations(${encodeURIComponent(asyncOperationId)})`,
        scope,
        { query: { '$select': 'statecode,statuscode,message,friendlymessage' } },
      );
      out.state = ASYNC_STATE[String(op?.statecode)] ?? String(op?.statecode ?? '');
      out.status = ASYNC_STATUS[String(op?.statuscode)] ?? String(op?.statuscode ?? '');
      if (op?.statuscode === 31 || op?.statuscode === 32) {
        out.error = op?.friendlymessage || op?.message || 'The import job failed.';
      }
    } catch (e: any) {
      if (e?.status !== 404) throw e;
    }
  }
  return out;
}

/** Dataverse asyncoperation statecode → label. */
const ASYNC_STATE: Record<string, string> = { '0': 'Ready', '1': 'Suspended', '2': 'Locked', '3': 'Completed' };
/** Dataverse asyncoperation statuscode → label (the subset that matters for ALM). */
const ASYNC_STATUS: Record<string, string> = {
  '0': 'WaitingForResources', '10': 'Waiting', '20': 'InProgress', '21': 'Pausing', '22': 'Canceling',
  '30': 'Succeeded', '31': 'Failed', '32': 'Canceled',
};

/**
 * Publish all customizations (`PublishAllXml`) — the step the maker portal runs
 * after an unmanaged import so the changes become visible to users.
 */
export async function publishAllCustomizations(envId: string): Promise<void> {
  const { url, scope } = await dataverseBase(envId);
  await ppCall(`${url}/api/data/v9.2/PublishAllXml`, scope, { method: 'POST', body: {} });
}

/**
 * Delete a solution by id (the maker portal's Delete on the Solutions grid).
 */
export async function deleteSolution(envId: string, solutionId: string): Promise<void> {
  const { url, scope } = await dataverseBase(envId);
  await ppCall(
    `${url}/api/data/v9.2/solutions(${encodeURIComponent(solutionId)})`,
    scope, { method: 'DELETE' },
  );
}
