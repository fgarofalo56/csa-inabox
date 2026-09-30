/**
 * POST /api/thread/materialize-to-kql — Loom Thread (Weave) edge.
 *
 * From a `lakehouse`, bind one of its ADLS Gen2 Delta tables to an Azure Data
 * Explorer (ADX) EXTERNAL TABLE in a target Loom `kql-database` / `eventhouse`,
 * so the Delta data is queryable with KQL — the Azure-native "lakehouse → KQL"
 * bridge. Real ADX management command
 * (`.create-or-alter external table … kind=delta`, storage auth via the
 * cluster's system-assigned MI) + optional query-acceleration policy for
 * sub-second reads. NO Fabric RTI Eventhouse required (no-fabric-dependency.md);
 * NO mock (no-vaporware.md).
 *
 * Honest gates: `LOOM_KUSTO_CLUSTER_URI` unset → 503 naming it; no lakehouse
 * storage configured → 503; a KustoError (401/403 = UAMI needs AllDatabasesAdmin
 * / cluster MI needs Storage Blob Data Reader on the ADLS account) surfaces
 * verbatim with its status.
 *
 * Body: { from:{id,type,name}, values:{ table:'name|adlsPath', kqlDatabaseId, accelerate? } }
 * Returns: { ok, message, externalTable, database, link, linkLabel } | { ok:false, error }
 *
 * ── THE TABLE NAME IS ONE PATH SEGMENT ──────────────────────────────────────
 * The storage location is built as `<lakehouse root>/Tables/<name>`, and
 * `<name>` arrives in the request body. It is validated as a single path
 * segment (`tableNameProblem`) BEFORE any Cosmos, storage or ADX call, and a
 * name that is not one is refused with 400 rather than rewritten, so the
 * location handed to ADX always names a folder directly under the item's own
 * `Tables/`. The segment rules are the lakehouse path validator's
 * (`pathSegments`, app/api/lakehouse/path/route.ts); on top of it this route
 * refuses control characters and the characters that carry meaning in the ADX
 * storage connection string / URI (`;` separates the auth properties, `?` and
 * `#` end the path, `%` is an escape), because the name is placed into that
 * string verbatim. Names are NOT restricted to `[A-Za-z0-9_]`: a Delta table
 * folder with a hyphen or a space is a real table, and rewriting it would bind
 * a different (usually missing) folder.
 *
 * On the ADX side the name never reaches a KQL identifier raw: the external
 * table name is `adxIdent(...)` (`[A-Za-z0-9_]` only) and bracket-quoted by
 * `qName`; the connection string is a verbatim literal (`kqlVerbatimSingle`);
 * the docstring is `kqlEscapeDouble`-escaped.
 *
 * Route-toolkit: withSession (R3), behind a 1-arg `POST` adapter — this route
 * is a Weave bridge that `app/api/estate/execute/route.ts` dynamic-imports as
 * `(req: NextRequest) => Promise<Response>` (same shape as mirror-to-notebook).
 */
import { trimEdges } from '@/lib/util/trim';
import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import type { SessionPayload } from '@/lib/auth/session';
import { pathSegments } from '@/app/api/lakehouse/path/route';
import { loadOwnedItem } from '../../items/_lib/item-crud';
import { recordThreadEdge } from '@/lib/thread/thread-edges';
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
import {
  createExternalDeltaTable,
  setQueryAccelerationPolicy,
  kustoConfigGate,
  defaultDatabase,
  KustoError,
} from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Default hot-cache window (days) when query acceleration is enabled. */
const ACCEL_HOT_DAYS = 7;

function bad(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status });
}

/** ADX identifier from a free string (letters/digits/underscore; never empty). */
function adxIdent(s: string): string {
  const cleaned = trimEdges(String(s).replace(/[^A-Za-z0-9_]/g, '_'), '_');
  return cleaned || 'loom';
}

/**
 * The ADX database name backing a Loom kql-database / eventhouse item. Prefers a
 * name the provisioner stamped in state; else derives it exactly as the kql-db
 * provisioner does (sanitized displayName, ≤50 chars); else the env default.
 */
function kqlDatabaseName(item: { displayName: string; state?: unknown }): string {
  const state = (item.state as Record<string, any>) || {};
  const stamped =
    (typeof state.databaseName === 'string' && state.databaseName.trim()) ||
    (typeof state.provisioning?.secondaryIds?.database === 'string' && state.provisioning.secondaryIds.database.trim()) ||
    '';
  if (stamped) return stamped;
  const derived = String(item.displayName || '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 50);
  return derived || defaultDatabase() || 'loomdb';
}

/** Control characters U+0000–U+001F and U+007F. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
/** Characters with meaning in the ADX storage connection string / URI. */
const CONN_STRING_META_RE = /[;?#%]/;

/**
 * Why `name` is not usable as the single `Tables/<name>` segment, or null when
 * it is. Checked in this order so the message names the first rule it breaks.
 */
function tableNameProblem(name: string): string | null {
  if (!name) return 'invalid table selection: the table name is empty';
  if (CONTROL_CHAR_RE.test(name)) return 'invalid table name: it contains a control character';
  // `pathSegments` treats "\" as a separator, refuses "." / ".." / NUL / an
  // absolute form, and collapses doubled or trailing separators — so the
  // result must be exactly the input, as ONE segment, to be accepted.
  const segs = pathSegments(name);
  if (!segs || segs.length !== 1 || segs[0] !== name) {
    return 'invalid table name: expected a single folder name under Tables/ — no "/" or "\\", and not "." or ".."';
  }
  if (CONN_STRING_META_RE.test(name)) {
    return 'invalid table name: ";", "?", "#" and "%" are not accepted in a table name';
  }
  return null;
}

async function materialize(req: NextRequest, session: SessionPayload): Promise<NextResponse> {
  const oid = session.claims.oid;

  const body = await req.json().catch(() => ({} as any));
  const from = body?.from || {};
  const values = body?.values || {};
  const tableSel = String(values.table || '').trim();
  const kqlDatabaseId = String(values.kqlDatabaseId || '').trim();
  const accelerate = values.accelerate !== false; // default on

  if (from.type !== 'lakehouse' || !from.id) return bad('this edge is for lakehouse items', 400);
  if (!tableSel) return bad('pick a Delta table', 400);
  if (!kqlDatabaseId) return bad('pick a KQL database', 400);

  // Shape check first: nothing is read or called for a name that is not one
  // path segment.
  const tableName = tableSel.split('|')[0]?.trim() ?? '';
  const nameProblem = tableNameProblem(tableName);
  if (nameProblem) return bad(nameProblem, 400);

  // Honest infra gate: no ADX cluster configured.
  const gate = kustoConfigGate();
  if (gate) {
    return NextResponse.json(
      {
        ok: false,
        gate,
        error:
          `Azure Data Explorer is not configured in this deployment. Set ${gate.missing} (an ADX cluster ` +
          `deployed by platform/fiab/bicep) to materialize lakehouse Delta tables to KQL.`,
      },
      { status: 503 },
    );
  }

  // Load both endpoints owner-scoped.
  const lake = await loadOwnedItem(from.id, from.type, oid, { allowReadRoles: true });
  if (!lake) return bad('lakehouse not found', 404);
  let kqlItem = await loadOwnedItem(kqlDatabaseId, 'kql-database', oid, { allowReadRoles: true });
  if (!kqlItem) kqlItem = await loadOwnedItem(kqlDatabaseId, 'eventhouse', oid, { allowReadRoles: true });
  if (!kqlItem) return bad('KQL database not found', 404);

  // Resolve the lakehouse's REAL ADLS root, then the Delta table's abfss folder.
  const root = await resolveLakehouseAbfss(from.id, lake.workspaceId);
  if (!root) {
    return NextResponse.json(
      {
        ok: false,
        gate: { missing: 'LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL' },
        error:
          'No lakehouse storage configured — set LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL and grant the ' +
          'Console UAMI Storage Blob Data Reader on the container.',
      },
      { status: 503 },
    );
  }
  const abfssUri = `${root.abfss.replace(/\/+$/, '')}/Tables/${tableName}`;

  const db = kqlDatabaseName(kqlItem);
  const extName = adxIdent(`${lake.displayName}_${tableName}`).slice(0, 100);

  // Bind the Delta table as an ADX external table (real mgmt command).
  try {
    await createExternalDeltaTable(db, extName, abfssUri, {
      folder: 'Lakehouse (Weave)',
      docString: `Weaved from lakehouse "${lake.displayName}" table ${tableName}.`,
    });
  } catch (e: any) {
    if (e instanceof KustoError) {
      const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
      const hint =
        status === 401 || status === 403
          ? ' The Console UAMI needs AllDatabasesAdmin on the ADX cluster, and the cluster’s managed identity needs Storage Blob Data Reader on the ADLS account.'
          : '';
      return NextResponse.json({ ok: false, error: `${e.message}${hint}` }, { status });
    }
    return bad(`Could not create the ADX external table: ${e?.message || String(e)}`, 502);
  }

  // Optional query acceleration (best-effort — the external table already works
  // without it; a failure here is reported but not fatal).
  let accelerated = false;
  let accelNote = '';
  if (accelerate) {
    try {
      await setQueryAccelerationPolicy(db, extName, ACCEL_HOT_DAYS);
      accelerated = true;
    } catch (e: any) {
      accelNote = ` (query acceleration could not be enabled: ${e?.message || String(e)} — the external table still queries the Delta files directly)`;
    }
  }

  await recordThreadEdge(session, {
    fromItemId: from.id,
    fromType: from.type,
    fromName: from.name || lake.displayName,
    toItemId: kqlItem.id,
    toType: kqlItem.itemType,
    toName: kqlItem.displayName,
    toLink: `/items/${kqlItem.itemType}/${kqlItem.id}`,
    action: 'materialize-to-kql',
  });

  return NextResponse.json({
    ok: true,
    externalTable: extName,
    database: db,
    accelerated,
    message:
      `Bound lakehouse table "${tableName}" to ADX external table ["${extName}"] in database "${db}"` +
      `${accelerated ? ' with query acceleration on' : ''}. Query it with KQL: external_table("${extName}") | take 100.${accelNote}`,
    link: `/items/${kqlItem.itemType}/${kqlItem.id}`,
    linkLabel: `Open ${kqlItem.itemType === 'eventhouse' ? 'the Eventhouse' : 'the KQL database'}`,
  });
}

/**
 * 1-arg adapter: keeps the Weave bridge contract (see the header); this route
 * has no `[param]` segment. The handler is a named function CALLED from here,
 * not a `const x = withSession(...)` binding, so the route-inventory analyzer
 * (scripts/ci/_route-auth-scope.mjs), which follows call sites from the
 * exported verb, still reaches the item loads and backend calls in its body.
 */
export async function POST(req: NextRequest): Promise<Response> {
  return withSession((r: NextRequest, { session }) => materialize(r, session))(req, {
    params: Promise.resolve({}),
  });
}
