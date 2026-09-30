/**
 * GET /api/lakehouse/preview?lakehouseId=|refId=&container=&path=&format=&top=
 * Previews the first N rows of a file via Synapse Serverless OPENROWSET.
 * Format defaults to detect from extension. _delta_log/ in the path
 * forces FORMAT='DELTA'. `top` is the row sample size (default 100,
 * clamped 1..1000) — Fabric's lakehouse table preview maxes at 1000 rows.
 *
 * Three request forms, each deciding the file before any query runs:
 *
 *   ITEM FORM (`lakehouseId`) — read access to the lakehouse item; the path
 *   must sit strictly below the item's root in its own container.
 *
 *   REFERENCE FORM (`refId`) — Reference-Lakehouse federation (F8): read access
 *   to the REFERENCED lakehouse item; the path must sit below that item's root,
 *   and its storage account is the host of that item's binding (`scopeReferencePath`).
 *
 *   STORAGE FORM (neither) — names a container + path on the primary account
 *   directly. Only a tenant admin may use it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { KNOWN_CONTAINERS, pathToHttpsUrl, pathToHttpsUrlFor } from '@/lib/azure/adls-client';
import { executeQuery, serverlessTarget } from '@/lib/azure/synapse-sql-client';
import { classifyTransientSynapseError } from '@/lib/azure/synapse-transient';
import { escapeSqlLiteral } from '@/lib/sql/quoting';
import { withSession } from '@/lib/api/route-toolkit';
import { scopeItem } from '../_lib/refusal-envelope';
import { scopeReferencePath } from '../_lib/reference-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Fmt = 'PARQUET' | 'CSV' | 'JSON' | 'DELTA' | 'TEXT' | 'IMAGE' | 'BINARY';

const TEXT_EXTS = new Set(['txt', 'log', 'md', 'yaml', 'yml', 'xml', 'html', 'htm', 'sql', 'py', 'ipynb', 'scala', 'r', 'js', 'ts', 'kql', 'sh', 'ps1', 'bicep', 'tf', 'toml', 'ini', 'conf', 'cfg', 'env']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
const TABULAR_EXTS = new Set(['parquet', 'csv', 'tsv', 'json', 'jsonl', 'ndjson']);

function detectFormat(path: string, explicit?: string | null): Fmt {
  if (explicit) {
    const up = explicit.toUpperCase();
    if (['PARQUET', 'CSV', 'JSON', 'DELTA', 'TEXT', 'IMAGE', 'BINARY'].includes(up)) return up as Fmt;
  }
  if (path.includes('/_delta_log/') || path.endsWith('/_delta_log')) return 'DELTA';
  const ext = path.toLowerCase().split('.').pop() || '';
  if (ext === 'parquet') return 'PARQUET';
  if (ext === 'csv' || ext === 'tsv') return 'CSV';
  if (ext === 'json' || ext === 'jsonl' || ext === 'ndjson') return 'JSON';
  if (TEXT_EXTS.has(ext)) return 'TEXT';
  if (IMAGE_EXTS.has(ext)) return 'IMAGE';
  // v3.28: any unrecognized extension is BINARY — return metadata-only,
  // NOT a forced-PARQUET OPENROWSET attempt that errors with cryptic
  // "file is not parquet/json" messages.
  return 'BINARY';
}

/**
 * For Delta tables, the BULK target is the *table directory* (parent of
 * _delta_log). Trim if the caller pointed at a file inside _delta_log.
 */
function normalizeBulkPath(path: string, fmt: Fmt): string {
  if (fmt !== 'DELTA') return path;
  const idx = path.indexOf('/_delta_log');
  if (idx >= 0) return path.substring(0, idx);
  return path;
}

function escapeSingleQuotes(s: string): string {
  return escapeSqlLiteral(s);
}

const DEFAULT_TOP = 100;
const MAX_TOP = 1000;

/** Clamp the row-sample size to 1..1000 (Fabric lakehouse preview cap); default 100. */
function parseTop(raw: string | null): number {
  const n = parseInt(raw || '', 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOP;
  return Math.min(n, MAX_TOP);
}

export const GET = withSession(async (req: NextRequest, { session }) => {
  const sp = req.nextUrl.searchParams;
  const lakehouseId = (sp.get('lakehouseId') || '').trim();
  const refId = (sp.get('refId') || '').trim();
  const rawContainer = (sp.get('container') || '').trim();
  const rawPath = sp.get('path') || '';
  const explicit = sp.get('format');
  const top = parseTop(sp.get('top'));

  if (!rawPath) {
    return NextResponse.json({ ok: false, error: 'path is required' }, { status: 400 });
  }
  if (sp.get('account') && !refId) {
    return NextResponse.json(
      { ok: false, error: 'account is not accepted here; preview a referenced lakehouse with refId.' },
      { status: 400 },
    );
  }

  let container: string;
  let path: string;
  let account: string | undefined;
  if (refId && !lakehouseId) {
    const scoped = await scopeReferencePath(session, refId, rawContainer, rawPath, true);
    if (scoped instanceof NextResponse) return scoped;
    ({ container, path, account } = scoped);
  } else {
    const scoped = await scopeItem(
      session,
      { lakehouseId, container: rawContainer, rawPath },
      { knownContainers: KNOWN_CONTAINERS },
    );
    if (scoped instanceof NextResponse) return scoped;
    ({ container, path } = scoped);
    account = undefined;
  }

  const fmt = detectFormat(path, explicit);
  const bulkPath = normalizeBulkPath(path, fmt);
  const url = account ? pathToHttpsUrlFor(account, container, bulkPath) : pathToHttpsUrl(container, bulkPath);
  const safeUrl = escapeSingleQuotes(url);

  // v3.28: non-tabular formats return metadata-only — no Synapse Serverless
  // OPENROWSET attempt that would error with cryptic 'not a parquet file'.
  if (fmt === 'TEXT' || fmt === 'IMAGE' || fmt === 'BINARY') {
    return NextResponse.json({
      ok: true,
      container,
      path,
      format: fmt,
      bulkUrl: url,
      message: fmt === 'TEXT'
        ? 'Text file. Use Download to view the raw content.'
        : fmt === 'IMAGE'
        ? 'Image file. Use Download to view the binary content.'
        : 'Binary file. Use Download — this file type is not tabular and is not previewable in-browser. All standard Fabric Lakehouse file types are supported for upload.',
      previewable: false,
      kind: fmt.toLowerCase(),
      // Fabric also previews text + images inline — that path lands in a future
      // PR that streams the bytes via a /download passthrough route.
    });
  }

  let sqlText: string;
  if (fmt === 'CSV') {
    sqlText = `SELECT TOP ${top} *
FROM OPENROWSET(BULK '${safeUrl}', FORMAT = 'CSV', PARSER_VERSION = '2.0',
  HEADER_ROW = TRUE, FIELDTERMINATOR = ',', FIELDQUOTE = '"') AS r;`;
  } else {
    sqlText = `SELECT TOP ${top} *
FROM OPENROWSET(BULK '${safeUrl}', FORMAT = '${fmt}') AS r;`;
  }

  try {
    const result = await executeQuery(serverlessTarget('master'), sqlText);
    return NextResponse.json({
      ok: true,
      container,
      path,
      format: fmt,
      top,
      bulkUrl: url,
      sql: sqlText,
      ...result,
    });
  } catch (e: any) {
    // Right after an upload two warm-up windows stack (serverless cold start +
    // storage RBAC/visibility propagation). Classify them so the editor shows
    // an honest "warming up — retrying" state instead of a raw SQL error.
    const transient = classifyTransientSynapseError(e?.message || String(e));
    if (transient) {
      return NextResponse.json(
        {
          ok: false,
          transient: true,
          format: fmt,
          bulkUrl: url,
          sql: sqlText,
          error: transient.friendly,
          code: transient.code,
          retryAfterMs: transient.retryAfterMs,
          detail: e?.message || String(e),
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        format: fmt,
        bulkUrl: url,
        sql: sqlText,
        error: e?.message || String(e),
        code: e?.code,
        sqlNumber: e?.number,
      },
      { status: 502 },
    );
  }
});
