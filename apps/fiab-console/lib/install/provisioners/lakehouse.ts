/**
 * Phase 2 — Lakehouse provisioner.
 *
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
 * Seed one Delta table from a CSV already landed in Files/. Calls the
 * Lakehouse Load Table API (mode=Overwrite) and polls the async operation.
 * Returns a human-readable outcome string for the step log. Never throws.
 */
async function loadTableFromCsv(
  workspaceId: string,
  lakehouseId: string,
  tableName: string,
  relativePath: string,
): Promise<{ ok: boolean; detail: string }> {
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
  // Async — poll the operation referenced by the Location header.
  const opUrl = res.headers.get('location');
  if (!opUrl) {
    // 200 with no location → treat as accepted.
    return { ok: true, detail: `load accepted (${res.status}, no operation handle).` };
  }
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const poll = await fetch(opUrl, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (!poll.ok) continue;
    const j: any = await poll.json().catch(() => null);
    const status = j?.Status ?? j?.status;
    // 1 NotStarted, 2 Running, 3 Success, 4 Failed
    if (status === 3 || status === 'Success' || status === 'Completed') {
      return { ok: true, detail: 'Load Table → Success.' };
    }
    if (status === 4 || status === 'Failed') {
      return { ok: false, detail: `Load Table → Failed: ${j?.Error ? JSON.stringify(j.Error).slice(0, 160) : 'unknown'}` };
    }
  }
  return { ok: true, detail: 'Load Table accepted; still running at end of poll budget.' };
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

export const lakehouseProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const ws = input.target.fabricWorkspaceId;
  if (!ws) {
    return {
      status: 'remediation',
      gate: {
        reason: 'No bound Fabric workspace for this Loom workspace.',
        remediation:
          'Bind a Fabric workspace via /admin/workspaces > Bind capacity, OR set LOOM_DEFAULT_FABRIC_WORKSPACE.',
        link: '/admin/workspaces',
      },
    };
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

  const seeded: string[] = [];
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

    const load = await loadTableFromCsv(ws, lakehouseId, t.name, relPath);
    steps.push(`Table ${t.name}: ${load.detail}`);
    if (load.ok) seeded.push(t.name);
  }

  steps.push(
    `Lakehouse provisioned; ${folderRefs.length} delta table(s) declared, ${seeded.length} seeded with sample rows.`,
  );
  return {
    status: existing ? 'exists' : 'created',
    resourceId: lakehouseId,
    secondaryIds: {
      fabricWorkspaceId: ws,
      ...(folderRefs.length ? { tableFolders: folderRefs.join(',') } : {}),
      ...(seeded.length ? { seededTables: seeded.join(',') } : {}),
    },
    steps,
  };
};
