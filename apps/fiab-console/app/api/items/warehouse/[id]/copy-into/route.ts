/**
 * GET  /api/items/warehouse/[id]/copy-into?container=&prefix=
 *   Source picker: lists ADLS containers (KNOWN_CONTAINERS) and, for a chosen
 *   container, its folders/files under `prefix` — so the wizard builds the
 *   source path from real storage, not a free-text URL.
 *
 * POST /api/items/warehouse/[id]/copy-into
 *   Builds + runs a REAL `COPY INTO [schema].[table] FROM '<https storage url>'
 *   WITH ( FILE_TYPE=…, … CREDENTIAL=(IDENTITY='Managed Identity') )` on the
 *   backing Synapse Dedicated SQL pool. Every option is a validated dropdown /
 *   whitelist value — no free-text SQL. The pool's workspace MI reads storage.
 *
 * Fabric parity: the Azure-native equivalent of the Fabric Warehouse
 * `COPY INTO` data-ingestion statement.
 *   https://learn.microsoft.com/sql/t-sql/statements/copy-into-transact-sql?view=azure-sqldw-latest
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiServerError, apiUnauthorized } from '@/lib/api/respond';
import { dedicatedTarget, executeQuery } from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';
import { KNOWN_CONTAINERS, listPaths, getAccountName } from '@/lib/azure/adls-client';
import { toHttps } from '@/lib/azure/delta-source-uri';
import { cleanTablePath, isKnownContainer } from '@/lib/azure/delta-history';
import { bracket, escapeSqlLiteral } from '@/lib/sql/quoting';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FILE_TYPES = new Set(['CSV', 'PARQUET', 'ORC']);
const ENCODINGS = new Set(['UTF8', 'UTF16']);

function safeIdent(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s || s.length > 128 || !/^[A-Za-z0-9_ .$#@-]+$/.test(s)) return null;
  return s;
}

// A single-quoted terminator literal (e.g. ',' or '0x0A'); keep it short and
// escape any embedded quote so it can never break out of the WITH clause.
function terminator(v: unknown, fallback: string): string {
  const s = String(v ?? '').trim();
  if (!s || s.length > 8) return fallback;
  return escapeSqlLiteral(s);
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();

  const container = req.nextUrl.searchParams.get('container') || '';
  if (!container) {
    return apiOk({ containers: [...KNOWN_CONTAINERS] });
  }
  if (!isKnownContainer(container)) return apiError(`unknown container: ${container}`, 404);
  const prefix = (req.nextUrl.searchParams.get('prefix') || '').replace(/^\/+|\/+$/g, '');
  if (prefix.includes('..')) return apiError('invalid prefix', 400);
  try {
    const entries = await listPaths(container, prefix, 200);
    return apiOk({
      container,
      prefix,
      entries: entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory, size: e.size })),
    });
  } catch (e) {
    return apiServerError(e, 'Failed to list storage paths', 'list_failed');
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();

  const body = await req.json().catch(() => ({}));
  const tgtSchema = safeIdent(body?.targetSchema ?? 'dbo');
  const tgtTable = safeIdent(body?.targetTable);
  const container = String(body?.container || '');
  const sourcePath = cleanTablePath(String(body?.sourcePath || '')) ?? '';
  const fileType = String(body?.fileType || 'CSV').toUpperCase();
  const encoding = String(body?.encoding || 'UTF8').toUpperCase();
  const firstRow = Number.isInteger(Number(body?.firstRow)) ? Math.max(1, Number(body.firstRow)) : 1;
  const fieldTerm = terminator(body?.fieldTerminator, ',');
  const rowTerm = terminator(body?.rowTerminator, '0x0A');

  if (!tgtSchema || !tgtTable) return apiError('targetSchema and targetTable are required', 400);
  if (!isKnownContainer(container)) return apiError(`unknown container: ${container}`, 404);
  if (!FILE_TYPES.has(fileType)) return apiError(`fileType must be one of ${[...FILE_TYPES].join(', ')}`, 400);
  if (!ENCODINGS.has(encoding)) return apiError('encoding must be UTF8 or UTF16', 400);

  const state = await getPoolState().catch(() => null);
  if (state && state.state !== 'Online') {
    return apiError(`Warehouse compute is ${state.state}. Resume the Synapse Dedicated SQL pool, then run COPY INTO.`, 409, { code: 'pool_offline', state: state.state });
  }

  let account: string;
  try { account = getAccountName(); }
  catch (e) { return apiServerError(e, 'Could not resolve storage account', 'setup_failed'); }

  // https storage URL from validated parts; single-quoted literal (quote-doubled).
  const url = toHttps({ account, container, path: sourcePath });
  const target = `${bracket(tgtSchema)}.${bracket(tgtTable)}`;

  // CSV-only options (FIELDTERMINATOR/ROWTERMINATOR/FIRSTROW/ENCODING) — Parquet
  // and ORC are self-describing. All values are whitelisted / integer / escaped.
  const opts: string[] = [`FILE_TYPE = '${fileType}'`, "CREDENTIAL = ( IDENTITY = 'Managed Identity' )"];
  if (fileType === 'CSV') {
    opts.push(
      `FIELDTERMINATOR = '${fieldTerm}'`,
      `ROWTERMINATOR = '${rowTerm}'`,
      `FIRSTROW = ${firstRow}`,
      `ENCODING = '${encoding}'`,
    );
  }
  const sql = `COPY INTO ${target}\nFROM '${escapeSqlLiteral(url)}'\nWITH (\n  ${opts.join(',\n  ')}\n);`;

  try {
    const result = await executeQuery(dedicatedTarget(), sql, 300_000);
    return apiOk({
      target: `${tgtSchema}.${tgtTable}`, source: url, fileType, sql,
      rowsLoaded: result.recordsAffected, executionMs: result.executionMs,
      executedBy: session.claims.upn,
    });
  } catch (e) {
    return apiServerError(e, 'COPY INTO failed', 'copy_failed');
  }
}
