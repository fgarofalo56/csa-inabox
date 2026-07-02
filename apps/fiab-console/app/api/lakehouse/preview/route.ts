/**
 * GET /api/lakehouse/preview?container=&path=&format=&top=
 * Previews the first N rows of a file via Synapse Serverless OPENROWSET.
 * Format defaults to detect from extension. _delta_log/ in the path
 * forces FORMAT='DELTA'. `top` is the row sample size (default 100,
 * clamped 1..1000) — Fabric's lakehouse table preview maxes at 1000 rows.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { KNOWN_CONTAINERS, pathToHttpsUrl, pathToHttpsUrlFor } from '@/lib/azure/adls-client';
import { executeQuery, serverlessTarget } from '@/lib/azure/synapse-sql-client';

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
  return s.replace(/'/g, "''");
}

const DEFAULT_TOP = 100;
const MAX_TOP = 1000;

/** Clamp the row-sample size to 1..1000 (Fabric lakehouse preview cap); default 100. */
function parseTop(raw: string | null): number {
  const n = parseInt(raw || '', 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOP;
  return Math.min(n, MAX_TOP);
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const container = req.nextUrl.searchParams.get('container') || '';
  const path = req.nextUrl.searchParams.get('path') || '';
  const explicit = req.nextUrl.searchParams.get('format');
  const top = parseTop(req.nextUrl.searchParams.get('top'));
  // Reference-Lakehouse federation (F8): an explicit `account` previews a file
  // that lives in a REFERENCED lakehouse's storage account (any account the
  // Console UAMI + Synapse Serverless MI hold Storage Blob Data Reader on). When
  // omitted, the PRIMARY LOOM account is used and the standard medallion
  // container allow-list applies.
  const account = (req.nextUrl.searchParams.get('account') || '').trim();

  if (!container || !path) {
    return NextResponse.json({ ok: false, error: 'container and path are required' }, { status: 400 });
  }
  if (account) {
    // Validate the account name (storage account naming: 3-24 lowercase
    // alphanumerics) to prevent host injection into the OPENROWSET URL.
    if (!/^[a-z0-9]{3,24}$/.test(account)) {
      return NextResponse.json({ ok: false, error: `invalid storage account: ${account}` }, { status: 400 });
    }
  } else if (!(KNOWN_CONTAINERS as readonly string[]).includes(container)) {
    return NextResponse.json({ ok: false, error: `unknown container: ${container}` }, { status: 404 });
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
}
