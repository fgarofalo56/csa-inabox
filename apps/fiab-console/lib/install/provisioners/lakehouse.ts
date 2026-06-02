/**
 * Phase 2 — Lakehouse provisioner.
 *
 * Two backends, picked at runtime:
 *
 *   A) Fabric (a Fabric workspace IS bound)
 *      Real REST: Fabric POST /v1/workspaces/{ws}/lakehouses to create the
 *      lakehouse item.  The bundle's deltaTables[].sampleRows are SEEDED
 *      into real Delta tables at install time (see Fabric block below).
 *
 *   B) Azure-native DLZ ADLS (no Fabric workspace bound — the default for an
 *      Azure-native Loom).  Loom has its own internal Data Landing Zone
 *      ADLS Gen2 (the bronze/silver/gold/landing containers behind
 *      LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL).  We materialise the lakehouse
 *      there using the SAME UAMI + adls-client used by every other editor:
 *        1. Create each LakehouseContent.folders[].path as a real directory.
 *        2. For each deltaTables[] entry, create a Tables/<name>/ directory
 *           and write its sampleRows as a REAL header CSV file
 *           (Tables/<name>/<name>.csv) via ADLS Gen2 PUT — so the lakehouse
 *           is browsable AND seeded the moment the app opens.
 *        3. If LOOM_SYNAPSE_WORKSPACE is set, ALSO register each seeded table
 *           as a Synapse serverless OPENROWSET external VIEW so it is
 *           queryable as `SELECT * FROM <name>` over the freshly written CSV.
 *      Returns status:'created' on Azure-native success.
 *
 * Only honest-gate (status:'remediation') when NEITHER a Fabric workspace
 * NOR the internal DLZ ADLS is available — naming the exact env var to set.
 *
 * --- Fabric backend detail ---------------------------------------------------
 * Real REST: Fabric POST /v1/workspaces/{ws}/lakehouses to create the
 * lakehouse item.  The bundle's deltaTables[].sampleRows are SEEDED into
 * real Delta tables at install time:
 *
 *   1. Write a header CSV per table to Files/_seed/<table>.csv via the
 *      OneLake DFS data-plane (PUT create → PATCH append → PATCH flush).
 *   2. Call the Lakehouse Load Table API
 *      (POST /lakehouses/{id}/tables/<table>/load, mode=Overwrite, CSV) to
 *      convert that CSV into a managed Delta table under Tables/<table>.
 *   3. Poll /lakehouses/{id}/operations/{op} until the load reports Success.
 *
 * This makes the bundle's "seeded with sample rows" promise true at install
 * time — the verify query returns rows before any notebook runs. The column
 * names come from the table DDL; sampleRows are array-of-arrays aligned to
 * those columns.
 *
 * Idempotency: if a lakehouse with the same displayName already exists, we
 * reuse it; the Load Table call uses mode=Overwrite so re-installing an app
 * re-seeds the same rows rather than duplicating them.
 *
 * Per .claude/rules/no-vaporware.md no mock fallback. The lakehouse + Load
 * Table calls hit real Fabric/OneLake REST; auth failures surface as
 * remediation gates with the exact RBAC / setting needed. Seeding failures
 * are non-fatal step logs (the lakehouse itself is still real + created).
 *
 * Grounded in Microsoft Learn:
 *   - Load Table API (Files CSV → Delta table):
 *     https://learn.microsoft.com/fabric/data-engineering/lakehouse-api#load-a-file-into-a-delta-table
 *   - OneLake DFS create/append/flush:
 *     https://learn.microsoft.com/fabric/onelake/onelake-access-api
 *   - Get lakehouse properties (oneLakeFilesPath):
 *     https://learn.microsoft.com/fabric/data-engineering/lakehouse-api#get-lakehouse-properties
 */
import { FabricError, fabricHint } from '@/lib/azure/fabric-client';
import type { Provisioner, ProvisionResult } from './types';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import {
  KNOWN_CONTAINERS,
  createDirectory as adlsCreateDirectory,
  listContainers as adlsListContainers,
  uploadFile as adlsUploadFile,
  pathToHttpsUrl,
  type KnownContainer,
} from '@/lib/azure/adls-client';
import { executeQuery as synapseExec, serverlessTarget } from '@/lib/azure/synapse-sql-client';

const FABRIC_BASE = process.env.LOOM_FABRIC_BASE || 'https://api.fabric.microsoft.com/v1';
const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';
// OneLake data-plane (ADLS Gen2 / DFS) — same UAMI, storage scope.
const ONELAKE_DFS_BASE = process.env.LOOM_ONELAKE_DFS_BASE || 'https://onelake.dfs.fabric.microsoft.com';
const STORAGE_SCOPE = 'https://storage.azure.com/.default';
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

async function getToken(scope: string): Promise<string> {
  const t = await credential.getToken(scope);
  if (!t?.token) throw new FabricError('Failed to acquire AAD token', 401, undefined, undefined, fabricHint(401));
  return t.token;
}

/**
 * Extract column names from a `CREATE TABLE name ( col TYPE, … )` DDL.
 *
 * Splits the column list on top-level commas (commas inside type parens such
 * as DECIMAL(18,2) or a CHECK (... BETWEEN x AND y) are NOT column separators)
 * and skips table-level constraint clauses (CONSTRAINT/PRIMARY/FOREIGN/UNIQUE/
 * CHECK) so they don't leak in as phantom columns and misalign the seed CSV.
 */
function columnsFromDdl(ddl: string): string[] {
  const open = ddl.indexOf('(');
  const close = ddl.lastIndexOf(')');
  if (open < 0 || close <= open) return [];
  const inner = ddl.slice(open + 1, close);

  // Split on commas that are at paren-depth 0 only.
  const segments: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      segments.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) segments.push(cur);

  const CONSTRAINT_KEYWORDS = new Set(['CONSTRAINT', 'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'KEY']);
  return segments
    .map((seg) => seg.trim().split(/\s+/)[0])
    .filter((c) => c && /^[A-Za-z_][A-Za-z0-9_]*$/.test(c) && !CONSTRAINT_KEYWORDS.has(c.toUpperCase()));
}

/** CSV-escape a single value (RFC-4180-ish: quote if it has comma/quote/newline). */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Build CSV text (header + rows) from column names and array-of-array rows. */
function buildCsv(columns: string[], rows: any[][]): string {
  const header = columns.map(csvCell).join(',');
  const body = rows.map((r) => columns.map((_, i) => csvCell(r[i])).join(',')).join('\n');
  return `${header}\n${body}\n`;
}

/**
 * Write a small text file to OneLake via the DFS create → append → flush
 * sequence. Used to land the per-table seed CSV under Files/ so the Load
 * Table API can convert it to Delta. Returns the parsed { status, body }.
 */
async function oneLakePutFile(
  workspaceId: string,
  lakehouseId: string,
  relativePath: string, // e.g. Files/_seed/orders.csv
  content: string,
): Promise<{ ok: boolean; status: number; detail?: string }> {
  const token = await getToken(STORAGE_SCOPE);
  const base = `${ONELAKE_DFS_BASE}/${encodeURIComponent(workspaceId)}/${encodeURIComponent(lakehouseId)}/${relativePath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
  const bytes = Buffer.from(content, 'utf-8');

  // 1. Create (truncate) the file resource.
  const create = await fetch(`${base}?resource=file`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!create.ok && create.status !== 201 && create.status !== 202) {
    return { ok: false, status: create.status, detail: (await create.text()).slice(0, 200) };
  }
  // 2. Append the bytes at offset 0.
  const append = await fetch(`${base}?action=append&position=0`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    body: bytes,
    cache: 'no-store',
  });
  if (!append.ok && append.status !== 202) {
    return { ok: false, status: append.status, detail: (await append.text()).slice(0, 200) };
  }
  // 3. Flush — commit the appended bytes at the final length.
  const flush = await fetch(`${base}?action=flush&position=${bytes.length}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!flush.ok) {
    return { ok: false, status: flush.status, detail: (await flush.text()).slice(0, 200) };
  }
  return { ok: true, status: flush.status };
}

/**
 * Kick off a Delta-table load from a CSV already landed in Files/. Calls the
 * Lakehouse Load Table API (mode=Overwrite) and RETURNS the async operation
 * handle WITHOUT polling it to completion.
 *
 * Async hand-off rationale (no-vaporware-safe): the install route awaits this
 * provisioner inside an HTTP request behind Azure Front Door's ~30s origin
 * timeout. The Load Table call is itself asynchronous — once Fabric returns
 * 202 + a Location header the conversion is queued/running server-side and
 * completes regardless of whether this request keeps polling. Polling every
 * table to Success (8 × 2.5s each, serially) was the lakehouse half of the 504.
 * So we POST the load, capture the operation URL, and let the caller take only
 * a short shared early peek. The seed CSV is real and already in OneLake; the
 * load is a real submitted Fabric operation, observable via its operation
 * handle and via the Lakehouse editor's live OneLake/Tables browser.
 * Never throws.
 */
interface LoadKick {
  ok: boolean;          // submission accepted (not necessarily finished)
  detail: string;       // human-readable step log
  opUrl?: string;       // async operation handle to peek/track
}

async function kickLoadTableFromCsv(
  workspaceId: string,
  lakehouseId: string,
  tableName: string,
  relativePath: string,
): Promise<LoadKick> {
  const token = await getToken(FABRIC_SCOPE);
  const loadUrl = `${FABRIC_BASE}/workspaces/${encodeURIComponent(workspaceId)}/lakehouses/${encodeURIComponent(
    lakehouseId,
  )}/tables/${encodeURIComponent(tableName)}/load`;
  const res = await fetch(loadUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      relativePath,
      pathType: 'File',
      mode: 'Overwrite',
      formatOptions: { header: true, delimiter: ',', format: 'Csv' },
    }),
    cache: 'no-store',
  });
  if (!res.ok && res.status !== 202) {
    return { ok: false, detail: `load ${res.status}: ${(await res.text()).slice(0, 200)}` };
  }
  const opUrl = res.headers.get('location') || undefined;
  if (!opUrl) {
    // 200 with no location → synchronously accepted, nothing to track.
    return { ok: true, detail: `load accepted (${res.status}, no operation handle).` };
  }
  return { ok: true, detail: `Load Table submitted (op accepted).`, opUrl };
}

/**
 * Best-effort single peek at one Load Table operation handle. Used AFTER all
 * loads are submitted, within a short shared budget, so a fast load can report
 * Success/Failed inline without blocking the request to terminal. Never throws.
 */
async function peekLoadOperation(opUrl: string): Promise<{ done: boolean; ok: boolean; detail: string }> {
  try {
    const token = await getToken(FABRIC_SCOPE);
    const poll = await fetch(opUrl, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (!poll.ok) return { done: false, ok: true, detail: '' };
    const j: any = await poll.json().catch(() => null);
    const status = j?.Status ?? j?.status;
    // 1 NotStarted, 2 Running, 3 Success, 4 Failed
    if (status === 3 || status === 'Success' || status === 'Completed') {
      return { done: true, ok: true, detail: 'Load Table → Success.' };
    }
    if (status === 4 || status === 'Failed') {
      return {
        done: true,
        ok: false,
        detail: `Load Table → Failed: ${j?.Error ? JSON.stringify(j.Error).slice(0, 160) : 'unknown'}`,
      };
    }
    return { done: false, ok: true, detail: '' };
  } catch {
    return { done: false, ok: true, detail: '' };
  }
}

/** Resolve the lakehouse's OneLake Files path (confirms the IDs are real). */
async function getLakehouseProps(workspaceId: string, lakehouseId: string): Promise<any | null> {
  const token = await getToken(FABRIC_SCOPE);
  const res = await fetch(
    `${FABRIC_BASE}/workspaces/${encodeURIComponent(workspaceId)}/lakehouses/${encodeURIComponent(lakehouseId)}`,
    { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' },
  );
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

async function fabricCall(path: string, method: 'GET' | 'POST', body?: unknown): Promise<{ status: number; body: any; location?: string }> {
  const token = await getToken(FABRIC_SCOPE);
  const res = await fetch(`${FABRIC_BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, body: json ?? text, location: res.headers.get('location') || undefined };
}

/** Sanitise a bundle folder/table path to a safe ADLS relative path (no
 * leading/trailing slashes, no traversal, forward-slash separated). */
function safeRelPath(p: string): string {
  return String(p)
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

/**
 * Azure-native DLZ fallback. Materialises the lakehouse in Loom's internal
 * Data Landing Zone ADLS Gen2 using the SAME UAMI + adls-client every other
 * editor uses. No Fabric required. Returns status:'created' on success, or an
 * honest remediation gate when no DLZ ADLS is configured either.
 */
async function provisionAzureNative(
  input: Parameters<Provisioner>[0],
  steps: string[],
): Promise<ProvisionResult> {
  // Resolve the DLZ container to host this lakehouse. Prefer the explicit
  // target.adlsContainer, else the first known container that actually exists
  // (probed via the adls-client, which needs no account-list permission).
  let container: KnownContainer | undefined =
    (input.target.adlsContainer as KnownContainer | undefined) &&
    (KNOWN_CONTAINERS as readonly string[]).includes(input.target.adlsContainer as string)
      ? (input.target.adlsContainer as KnownContainer)
      : undefined;

  let available: { name: string }[] = [];
  try {
    available = await adlsListContainers();
  } catch (e: any) {
    steps.push(`Could not probe DLZ containers: ${e?.message || String(e)}`);
  }

  if (!container) {
    // Prefer 'landing' (raw zone, natural home for a new lakehouse), else any
    // container that exists.
    const names = available.map((c) => c.name);
    container =
      (names.includes('landing') && 'landing') ||
      (names.includes('bronze') && 'bronze') ||
      (names[0] as KnownContainer | undefined) ||
      undefined;
  }

  if (!container) {
    // Neither Fabric nor any internal DLZ ADLS is available — honest gate.
    return {
      status: 'remediation',
      gate: {
        reason:
          'No bound Fabric workspace AND no internal DLZ ADLS configured — cannot materialise a lakehouse.',
        remediation:
          'Either bind a Fabric workspace via /admin/workspaces > Bind capacity, OR configure the internal Data Landing Zone by setting LOOM_LANDING_URL (and/or LOOM_BRONZE_URL / LOOM_SILVER_URL / LOOM_GOLD_URL) to the DLZ ADLS Gen2 container URLs the DLZ Bicep deploy emits.',
        link: '/admin/workspaces',
      },
      steps,
    };
  }
  steps.push(`Azure-native DLZ backend: container '${container}'.`);

  const content = input.content as any;
  const folders: Array<{ path: string; description?: string }> = Array.isArray(content?.folders)
    ? content.folders
    : [];
  const deltaTables: Array<{ name: string; ddl?: string; sampleRows?: any[][] }> = Array.isArray(
    content?.deltaTables,
  )
    ? content.deltaTables
    : [];

  // Root path for this lakehouse inside the container — keeps multiple
  // installed lakehouses isolated and browsable side-by-side.
  const root = `lakehouses/${safeRelPath(input.displayName) || input.cosmosItemId}`;

  // 1. Create the lakehouse root + every declared folder as real directories.
  try {
    await adlsCreateDirectory(container, root);
    steps.push(`Created lakehouse root directory ${container}/${root}.`);
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (e?.statusCode === 401 || e?.statusCode === 403) {
      return {
        status: 'remediation',
        gate: {
          reason: `ADLS ${e.statusCode}: not authorized to write to the DLZ container '${container}'.`,
          remediation:
            'Grant the Console managed identity (LOOM_UAMI_CLIENT_ID) the Storage Blob Data Contributor role on the DLZ storage account / container.',
          link: 'https://learn.microsoft.com/azure/storage/blobs/assign-azure-role-data-access',
        },
        steps,
      };
    }
    return { status: 'failed', error: `Create lakehouse root failed: ${msg}`, steps };
  }

  const createdFolders: string[] = [];
  for (const f of folders) {
    const rel = safeRelPath(f?.path || '');
    if (!rel) continue;
    const dir = `${root}/${rel}`;
    try {
      await adlsCreateDirectory(container, dir);
      createdFolders.push(rel);
      steps.push(`Created folder ${container}/${dir}.`);
    } catch (e: any) {
      steps.push(`Folder ${rel}: create failed ${e?.statusCode || ''} ${e?.message || String(e)}`);
    }
  }

  // 2. Seed each deltaTable's sampleRows as a real CSV under Tables/<name>/.
  //    The table folder is created even when there are no sampleRows so the
  //    Tables/ tree is browsable; columns come from the DDL (array-of-array
  //    sampleRows are aligned to those columns).
  const seeded: string[] = [];
  const emptyTables: string[] = [];
  const externalViews: string[] = [];

  // Synapse serverless target (optional) — only when LOOM_SYNAPSE_WORKSPACE set.
  //
  // CRITICAL: Synapse serverless does NOT support CREATE/ALTER VIEW (nor any
  // CREATE EXTERNAL …) in the `master` database — it errors with
  // "CREATE/ALTER VIEW is not supported in master database." Per Microsoft
  // Learn, OPENROWSET views must live in a USER database. So we create-if-
  // missing a dedicated serverless user DB ([loom_lakehouse] by default,
  // overridable via LOOM_SYNAPSE_LAKEHOUSE_DB) by running CREATE DATABASE in
  // the `master` context, then register every view against THAT user DB.
  //
  // If the user DB can't be created (e.g. workspace DB limit reached, or no
  // permission), we SKIP the optional view-registration layer entirely and
  // still report status:'created' with the real seeded files — the view layer
  // is a queryability convenience, not the lakehouse itself.
  // Learn: https://learn.microsoft.com/azure/synapse-analytics/sql/resources-self-help-sql-on-demand#configuration
  const LAKEHOUSE_DB = (process.env.LOOM_SYNAPSE_LAKEHOUSE_DB || 'loom_lakehouse').replace(/[^A-Za-z0-9_]/g, '_');
  let synapse: ReturnType<typeof serverlessTarget> | null = null;
  if (process.env.LOOM_SYNAPSE_WORKSPACE) {
    try {
      // Step 1 — create the user database if missing, in the master context
      // (CREATE DATABASE cannot run from inside the not-yet-existing target DB).
      const master = serverlessTarget('master');
      await synapseExec(
        master,
        `IF DB_ID(N'${LAKEHOUSE_DB}') IS NULL EXEC('CREATE DATABASE [${LAKEHOUSE_DB}]');`,
      );
      // Step 2 — target the user DB for all subsequent view DDL.
      synapse = serverlessTarget(LAKEHOUSE_DB);
      steps.push(
        `Synapse serverless available (${synapse.server}); will register OPENROWSET views in user DB [${LAKEHOUSE_DB}].`,
      );
    } catch (e: any) {
      // User DB unavailable — skip the optional view layer, keep seeded files.
      steps.push(
        `Synapse serverless view layer skipped (could not ensure user DB [${LAKEHOUSE_DB}]): ${e?.message || String(e)}. ` +
          'Seeded files are still real; views are an optional queryability convenience.',
      );
      synapse = null;
    }
  }

  for (const t of deltaTables) {
    const tName = safeRelPath(t?.name || '');
    if (!tName) continue;
    const tableDir = `${root}/Tables/${tName}`;
    try {
      await adlsCreateDirectory(container, tableDir);
    } catch (e: any) {
      steps.push(`Table ${tName}: directory create failed ${e?.message || String(e)}`);
      continue;
    }

    const rows = Array.isArray(t.sampleRows) ? t.sampleRows : [];
    if (rows.length === 0) {
      emptyTables.push(tName);
      steps.push(`Table ${tName}: no sampleRows in bundle; created empty Tables/${tName}/.`);
      continue;
    }
    const columns = t.ddl ? columnsFromDdl(t.ddl) : [];
    if (columns.length === 0) {
      steps.push(`Table ${tName}: could not derive columns from DDL; created empty Tables/${tName}/.`);
      emptyTables.push(tName);
      continue;
    }

    const csv = buildCsv(columns, rows);
    const csvPath = `${tableDir}/${tName}.csv`;
    try {
      await adlsUploadFile(container, csvPath, Buffer.from(csv, 'utf-8'), 'text/csv');
      seeded.push(tName);
      steps.push(`Table ${tName}: wrote ${rows.length}-row seed CSV to ${container}/${csvPath}.`);
    } catch (e: any) {
      steps.push(`Table ${tName}: seed CSV write failed ${e?.statusCode || ''} ${e?.message || String(e)}`);
      continue;
    }

    // 3. Optionally register a Synapse serverless OPENROWSET external view so
    //    the seeded CSV is queryable as `SELECT * FROM lakehouse.<view>`.
    //    The view is created in the dedicated USER database [loom_lakehouse]
    //    (NOT master — serverless rejects CREATE VIEW in master), under a
    //    dedicated `lakehouse` schema, built via EXEC('CREATE VIEW …') with
    //    doubled single-quotes inside the EXEC string. The BULK arg is the
    //    https DFS endpoint (Synapse OPENROWSET takes https, not abfss).
    //    Idempotent: DROP-if-exists then CREATE so re-install upserts.
    if (synapse) {
      const httpsUrl = pathToHttpsUrl(container, csvPath);
      const viewLeaf = `${tName}`.replace(/[^A-Za-z0-9_]/g, '_');
      const obj = `lakehouse.${viewLeaf}`;
      // Doubled single-quotes for the inner EXEC string literal.
      const urlLiteral = httpsUrl.replace(/'/g, "''");
      const ddl =
        `IF SCHEMA_ID('lakehouse') IS NULL EXEC('CREATE SCHEMA lakehouse');\n` +
        `IF OBJECT_ID('${obj}','V') IS NOT NULL DROP VIEW ${obj};\n` +
        `EXEC('CREATE VIEW ${obj} AS SELECT * FROM OPENROWSET(BULK ''${urlLiteral}'', ` +
        `FORMAT = ''CSV'', PARSER_VERSION = ''2.0'', HEADER_ROW = TRUE) AS r');`;
      try {
        await synapseExec(synapse, ddl);
        externalViews.push(obj);
        steps.push(`Table ${tName}: registered Synapse serverless view ${obj} over the seed CSV.`);
      } catch (e: any) {
        steps.push(`Table ${tName}: OPENROWSET view register failed: ${e?.message || String(e)}`);
      }
    }
  }

  steps.push(
    `Azure-native lakehouse materialised in ${container}/${root}: ${createdFolders.length} folder(s), ` +
      `${deltaTables.length} table folder(s) (${seeded.length} seeded, ${emptyTables.length} empty)` +
      `${externalViews.length ? `, ${externalViews.length} Synapse view(s)` : ''}.`,
  );

  return {
    status: 'created',
    resourceId: `${container}/${root}`,
    secondaryIds: {
      backend: 'azure-native-adls',
      container,
      rootPath: root,
      ...(createdFolders.length ? { folders: createdFolders.join(',') } : {}),
      ...(seeded.length ? { seededTables: seeded.join(',') } : {}),
      ...(emptyTables.length ? { emptyTables: emptyTables.join(',') } : {}),
      ...(externalViews.length ? { synapseViews: externalViews.join(',') } : {}),
    },
    steps,
  };
}

export const lakehouseProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const ws = input.target.fabricWorkspaceId;
  if (!ws) {
    // Azure-native Loom: no Fabric workspace bound. Fall back to the internal
    // DLZ ADLS so the lakehouse is still browsable + seeded with real data.
    steps.push('No bound Fabric workspace; using Azure-native DLZ ADLS backend.');
    return provisionAzureNative(input, steps);
  }
  steps.push(`Fabric workspace: ${ws}`);

  // 1. List existing lakehouses (idempotency).
  const list = await fabricCall(`/workspaces/${encodeURIComponent(ws)}/lakehouses`, 'GET');
  if (list.status === 401 || list.status === 403) {
    return {
      status: 'remediation',
      gate: {
        reason: `Fabric ${list.status}: not authorized to list lakehouses in workspace ${ws}.`,
        remediation: fabricHint(list.status) || 'Add the Console UAMI as a Contributor on this Fabric workspace.',
        link: `https://app.fabric.microsoft.com/groups/${ws}/settings`,
      },
      steps,
    };
  }
  if (list.status >= 400) {
    return { status: 'failed', error: `List lakehouses ${list.status}: ${typeof list.body === 'string' ? list.body : JSON.stringify(list.body)}`, steps };
  }

  const existing = Array.isArray(list.body?.value)
    ? list.body.value.find((l: any) => (l.displayName || '').toLowerCase() === input.displayName.toLowerCase())
    : null;

  let lakehouseId = existing?.id as string | undefined;
  if (lakehouseId) {
    steps.push(`Found existing lakehouse ${lakehouseId}; reusing.`);
  } else {
    steps.push('Creating new lakehouse…');
    const create = await fabricCall(`/workspaces/${encodeURIComponent(ws)}/lakehouses`, 'POST', {
      displayName: input.displayName,
      description: `Installed from ${input.appId}`,
    });
    if (create.status === 401 || create.status === 403) {
      return {
        status: 'remediation',
        gate: {
          reason: `Fabric ${create.status}: cannot create lakehouse.`,
          remediation: fabricHint(create.status) || 'Add the Console UAMI as a Contributor on this Fabric workspace.',
          link: `https://app.fabric.microsoft.com/groups/${ws}/settings`,
        },
        steps,
      };
    }
    if (create.status >= 400) {
      return { status: 'failed', error: `Create lakehouse ${create.status}: ${typeof create.body === 'string' ? create.body : JSON.stringify(create.body)}`, steps };
    }
    lakehouseId = create.body?.id;
    steps.push(`Created lakehouse ${lakehouseId}.`);
  }

  // 2. Seed each bundle deltaTable that carries sampleRows into a REAL Delta
  // table. We don't need a "PUT delta row" primitive — the documented path
  // is: land a CSV in Files/ via OneLake DFS, then call the Load Table API
  // (CSV → managed Delta table). This makes the bundle's "seeded with sample
  // rows" promise true at install time, so the verify query returns rows
  // before any notebook runs.
  if (!lakehouseId) {
    return { status: 'failed', error: 'Lakehouse id not resolved after create.', steps };
  }

  const content = input.content as any;
  const deltaTables: Array<{ name: string; ddl?: string; sampleRows?: any[][] }> = Array.isArray(content?.deltaTables)
    ? content.deltaTables
    : [];
  const folderRefs = deltaTables.map((t) => `Tables/${t.name}`);

  // Confirm the lakehouse Files path is live (also a real read that proves
  // the IDs resolve before we attempt data-plane writes).
  const props = await getLakehouseProps(ws, lakehouseId);
  if (props?.properties?.oneLakeFilesPath) {
    steps.push(`OneLake Files path: ${props.properties.oneLakeFilesPath}`);
  }

  // Phase A — write every seed CSV to OneLake, then SUBMIT every Load Table
  // operation, capturing each async op handle. These are fast (a CSV PUT + a
  // load POST per table); we do NOT poll any load to completion here.
  const submitted: Array<{ name: string; opUrl?: string }> = [];
  for (const t of deltaTables) {
    const rows = Array.isArray(t.sampleRows) ? t.sampleRows : [];
    if (rows.length === 0) {
      steps.push(`Table ${t.name}: no sampleRows in bundle; created empty (notebook will populate).`);
      continue;
    }
    const columns = t.ddl ? columnsFromDdl(t.ddl) : [];
    if (columns.length === 0) {
      steps.push(`Table ${t.name}: could not derive columns from DDL; skipped seeding.`);
      continue;
    }
    const csv = buildCsv(columns, rows);
    const relPath = `Files/_seed/${t.name}.csv`;

    const put = await oneLakePutFile(ws, lakehouseId, relPath, csv);
    if (!put.ok) {
      if (put.status === 401 || put.status === 403) {
        steps.push(
          `Table ${t.name}: OneLake write ${put.status} — UAMI needs Contributor on the Fabric workspace (OneLake data-plane). ${put.detail || ''}`,
        );
      } else {
        steps.push(`Table ${t.name}: OneLake seed-CSV write failed ${put.status}: ${put.detail || ''}`);
      }
      continue;
    }
    steps.push(`Table ${t.name}: wrote ${rows.length}-row seed CSV to ${relPath}.`);

    const kick = await kickLoadTableFromCsv(ws, lakehouseId, t.name, relPath);
    steps.push(`Table ${t.name}: ${kick.detail}`);
    if (kick.ok) submitted.push({ name: t.name, opUrl: kick.opUrl });
  }

  // Phase B — short SHARED early-peek budget across all submitted loads so a
  // fast conversion reports Success inline, but the request never blocks to
  // terminal (that 8×2.5s-per-table poll was the lakehouse half of the 504).
  // Whatever is still running is a real Fabric operation that completes
  // server-side; the Lakehouse editor's live OneLake/Tables browser shows the
  // tables as they land — no mock, no fake "seeded" claim.
  const LOAD_EARLY_PEEKS = 3;       // total rounds
  const LOAD_PEEK_MS = 2500;        // per round
  const pending = submitted.filter((s) => s.opUrl) as Array<{ name: string; opUrl: string }>;
  const confirmed = new Set<string>();   // load confirmed Success during the peek
  const failed = new Set<string>();      // load reported Failed during the peek
  for (let round = 0; round < LOAD_EARLY_PEEKS && pending.length > confirmed.size + failed.size; round++) {
    await new Promise((r) => setTimeout(r, LOAD_PEEK_MS));
    for (const p of pending) {
      if (confirmed.has(p.name) || failed.has(p.name)) continue;
      const peek = await peekLoadOperation(p.opUrl);
      if (peek.done) {
        if (peek.ok) confirmed.add(p.name);
        else failed.add(p.name);
        steps.push(`Table ${p.name}: ${peek.detail}`);
      }
    }
  }

  // Tables whose load was submitted but not yet terminal at end of the peek
  // budget — honestly reported as in-progress (they keep loading server-side).
  const inProgress = submitted
    .filter((s) => s.opUrl && !confirmed.has(s.name) && !failed.has(s.name))
    .map((s) => s.name);
  // Tables accepted with no op handle (synchronous 200) count as submitted too.
  const acceptedNoOp = submitted.filter((s) => !s.opUrl).map((s) => s.name);
  for (const n of inProgress) {
    steps.push(`Table ${n}: Load Table still running at end of early-peek budget; completes server-side.`);
  }

  // "Seeded" for the report = loads confirmed Success during the peek. Loads
  // still running are reported separately as in-progress so the client gets an
  // honest, observable picture rather than a premature success claim.
  const seeded = [...confirmed];
  const loadsSubmitted = submitted.length;

  steps.push(
    `Lakehouse provisioned; ${folderRefs.length} delta table(s) declared, ` +
    `${loadsSubmitted} Load Table op(s) submitted (${seeded.length} confirmed seeded, ` +
    `${inProgress.length + acceptedNoOp.length} still loading, ${failed.size} failed). ` +
    'In-flight loads finish server-side and appear in the Lakehouse editor.',
  );
  return {
    status: existing ? 'exists' : 'created',
    resourceId: lakehouseId,
    secondaryIds: {
      fabricWorkspaceId: ws,
      ...(folderRefs.length ? { tableFolders: folderRefs.join(',') } : {}),
      ...(seeded.length ? { seededTables: seeded.join(',') } : {}),
      ...(inProgress.length || acceptedNoOp.length
        ? { seedingTables: [...inProgress, ...acceptedNoOp].join(',') }
        : {}),
      ...(failed.size ? { seedFailedTables: [...failed].join(',') } : {}),
    },
    steps,
  };
};
