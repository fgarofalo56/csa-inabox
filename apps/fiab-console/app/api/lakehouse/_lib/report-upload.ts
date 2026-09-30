/**
 * Report-scoped upload target for `/api/lakehouse/upload`.
 *
 * The shared Get Data gallery stages a file for the item it is open in: a
 * report, a semantic model or a paginated report. That file belongs to THAT
 * item, not to a lakehouse, so the upload route accepts `reportId` (+
 * `reportItemType`, default `report`) as its item: the item is authorized with
 * edit rights via `resolveItemAccessByOid`, and the target is pinned to
 * `landing/report-uploads/<item id>/<file name>` — one file-name segment,
 * nothing else.
 *
 * Refusals carry `code` and `remediation`.
 */
import { NextResponse } from 'next/server';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import type { SessionPayload } from '@/lib/auth/session';
import { pathSegments } from './item-scope';

export const REPORT_UPLOAD_CONTAINER = 'landing';
export const REPORT_UPLOAD_PREFIX = 'report-uploads';

/** Item types whose editors host the Get Data gallery and may stage an upload. */
export const REPORT_UPLOAD_ITEM_TYPES = ['report', 'semantic-model', 'paginated-report'] as const;
export type ReportUploadItemType = (typeof REPORT_UPLOAD_ITEM_TYPES)[number];

const ITEM_LABEL: Record<ReportUploadItemType, string> = {
  report: 'report',
  'semantic-model': 'semantic model',
  'paginated-report': 'paginated report',
};

/** The one path an item may upload to for `fileName`. */
export function reportUploadPath(itemId: string, fileName: string): string {
  return `${REPORT_UPLOAD_PREFIX}/${itemId}/${fileName}`;
}

function refusal(status: number, error: string, code: string, remediation: string): NextResponse {
  return NextResponse.json({ ok: false, error, code, remediation }, { status });
}

/**
 * Authorize `itemId` (of `itemType`) for writing and check that `container` +
 * `rawPath` name a file directly under that item's upload folder. Returns the
 * scoped target or the refusal: 400 for an unknown item type or a malformed
 * path, 404 when the caller cannot reach the item, 403 for a read-only role or
 * a target outside the folder.
 */
export async function scopeReportUpload(
  session: SessionPayload,
  itemId: string,
  container: string,
  rawPath: string,
  itemType: string = 'report',
): Promise<{ container: string; path: string } | NextResponse> {
  if (!(REPORT_UPLOAD_ITEM_TYPES as readonly string[]).includes(itemType)) {
    return refusal(
      400,
      `reportItemType must be one of ${REPORT_UPLOAD_ITEM_TYPES.join(', ')}.`,
      'bad_request',
      'Upload from the Get Data gallery of a report, semantic model or paginated report.',
    );
  }
  const label = ITEM_LABEL[itemType as ReportUploadItemType];
  const access = await resolveItemAccessByOid(session, itemId, itemType);
  if (!access) {
    return refusal(
      404,
      `${label} not found`,
      'item_not_found',
      `Check that the ${label} still exists and that you have access to it in its workspace, then reopen it.`,
    );
  }
  if (!access.canWrite) {
    return refusal(
      403,
      `Your role on this ${label} is read-only, so Loom did not upload the file. A workspace `
      + 'Member/Admin, or an item grant that includes Edit, can add data to it.',
      'read_only',
      'Ask a workspace Member or Admin to make the change, or to give you an item grant that includes Edit.',
    );
  }
  const segments = pathSegments(rawPath);
  if (!segments) {
    return refusal(
      400,
      'invalid path: expected a relative path inside the container, with no leading "/" and no "." or ".." segments',
      'bad_request',
      'Correct the value named in the message and retry.',
    );
  }
  const inFolder =
    (container || REPORT_UPLOAD_CONTAINER) === REPORT_UPLOAD_CONTAINER
    && segments.length === 3
    && segments[0] === REPORT_UPLOAD_PREFIX
    && segments[1] === itemId;
  if (!inFolder) {
    return refusal(
      403,
      `An upload for this ${label} goes to ${REPORT_UPLOAD_CONTAINER}/${REPORT_UPLOAD_PREFIX}/${itemId}/<file name>.`,
      'outside_upload_folder',
      'Upload from the Get Data gallery of the item, which names the folder for you.',
    );
  }
  return { container: REPORT_UPLOAD_CONTAINER, path: segments.join('/') };
}
