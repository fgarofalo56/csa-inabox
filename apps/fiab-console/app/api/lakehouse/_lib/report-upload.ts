/**
 * Report-scoped upload target for `/api/lakehouse/upload`.
 *
 * The report editor's Get Data gallery stages a file for a report data source.
 * That file belongs to the REPORT item, not to a lakehouse, so the upload route
 * accepts `reportId` as its item: the report is authorized with edit rights via
 * `resolveItemAccessByOid`, and the target is pinned to
 * `landing/report-uploads/<reportId>/<file name>` — one file-name segment,
 * nothing else.
 */
import { NextResponse } from 'next/server';
import { apiBadRequest, apiForbidden, apiNotFound } from '@/lib/api/respond';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import type { SessionPayload } from '@/lib/auth/session';
import { pathSegments } from './item-scope';

export const REPORT_UPLOAD_CONTAINER = 'landing';
export const REPORT_UPLOAD_PREFIX = 'report-uploads';

/** The one path a report may upload to for `fileName`. */
export function reportUploadPath(reportId: string, fileName: string): string {
  return `${REPORT_UPLOAD_PREFIX}/${reportId}/${fileName}`;
}

/**
 * Authorize `reportId` for writing and check that `container` + `rawPath` name
 * a file directly under that report's upload folder. Returns the scoped target
 * or the refusal: 404 when the caller cannot reach the report, 403 for a
 * read-only role or a target outside the folder, 400 for a malformed path.
 */
export async function scopeReportUpload(
  session: SessionPayload,
  reportId: string,
  container: string,
  rawPath: string,
): Promise<{ container: string; path: string } | NextResponse> {
  const access = await resolveItemAccessByOid(session, reportId, 'report');
  if (!access) return apiNotFound('report not found');
  if (!access.canWrite) {
    return apiForbidden(
      'Your role on this report is read-only, so Loom did not upload the file. A workspace '
      + 'Member/Admin, or an item grant that includes Edit, can add data to it.',
    );
  }
  const segments = pathSegments(rawPath);
  if (!segments) {
    return apiBadRequest(
      'invalid path: expected a relative path inside the container, with no leading "/" and no "." or ".." segments',
    );
  }
  const inFolder =
    (container || REPORT_UPLOAD_CONTAINER) === REPORT_UPLOAD_CONTAINER
    && segments.length === 3
    && segments[0] === REPORT_UPLOAD_PREFIX
    && segments[1] === reportId;
  if (!inFolder) {
    return apiForbidden(
      `A report upload goes to ${REPORT_UPLOAD_CONTAINER}/${REPORT_UPLOAD_PREFIX}/${reportId}/<file name>.`,
    );
  }
  return { container: REPORT_UPLOAD_CONTAINER, path: segments.join('/') };
}
