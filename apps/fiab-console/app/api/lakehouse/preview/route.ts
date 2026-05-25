/**
 * GET /api/lakehouse/preview?container=&path=&format=
 * Previews first 100 rows of a file via Synapse Serverless OPENROWSET.
 * Format defaults to detect from extension. _delta_log/ in the path
 * forces FORMAT='DELTA'.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { KNOWN_CONTAINERS, pathToHttpsUrl } from '@/lib/azure/adls-client';
import { executeQuery, serverlessTarget } from '@/lib/azure/synapse-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Fmt = 'PARQUET' | 'CSV' | 'JSON' | 'DELTA';

function detectFormat(path: string, explicit?: string | null): Fmt {
  if (explicit) {
    const up = explicit.toUpperCase();
    if (up === 'PARQUET' || up === 'CSV' || up === 'JSON' || up === 'DELTA') return up;
  }
  if (path.includes('/_delta_log/') || path.endsWith('/_delta_log')) return 'DELTA';
  const ext = path.toLowerCase().split('.').pop() || '';
  if (ext === 'parquet') return 'PARQUET';
  if (ext === 'csv' || ext === 'tsv') return 'CSV';
  if (ext === 'json' || ext === 'jsonl' || ext === 'ndjson') return 'JSON';
  return 'PARQUET';
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

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const container = req.nextUrl.searchParams.get('container') || '';
  const path = req.nextUrl.searchParams.get('path') || '';
  const explicit = req.nextUrl.searchParams.get('format');

  if (!container || !path) {
    return NextResponse.json({ ok: false, error: 'container and path are required' }, { status: 400 });
  }
  if (!(KNOWN_CONTAINERS as readonly string[]).includes(container)) {
    return NextResponse.json({ ok: false, error: `unknown container: ${container}` }, { status: 404 });
  }

  const fmt = detectFormat(path, explicit);
  const bulkPath = normalizeBulkPath(path, fmt);
  const url = pathToHttpsUrl(container, bulkPath);
  const safeUrl = escapeSingleQuotes(url);

  let sqlText: string;
  if (fmt === 'CSV') {
    sqlText = `SELECT TOP 100 *
FROM OPENROWSET(BULK '${safeUrl}', FORMAT = 'CSV', PARSER_VERSION = '2.0',
  HEADER_ROW = TRUE, FIELDTERMINATOR = ',', FIELDQUOTE = '"') AS r;`;
  } else {
    sqlText = `SELECT TOP 100 *
FROM OPENROWSET(BULK '${safeUrl}', FORMAT = '${fmt}') AS r;`;
  }

  try {
    const result = await executeQuery(serverlessTarget('master'), sqlText);
    return NextResponse.json({
      ok: true,
      container,
      path,
      format: fmt,
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
