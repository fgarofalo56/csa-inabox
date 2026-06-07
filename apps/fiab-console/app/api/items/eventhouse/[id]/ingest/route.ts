/**
 * POST /api/items/eventhouse/[id]/ingest
 *
 * Three modes (selected by request `Content-Type`):
 *
 *   1. multipart/form-data:
 *        fields: database, table, file (CSV/JSON)
 *        Behavior: parse small file server-side (<= 5 MB / 50k rows) and
 *        push to ADX via `.ingest inline`. This is the real, end-to-end
 *        Loom path and works against the shared ADX cluster.
 *
 *   2. application/json with kind === 'eventhub':
 *        Body: { kind: 'eventhub', database, table, eventHubName, consumerGroup }
 *        Behavior: provisions an ADX → Event Hub data connection via ARM
 *        (PUT Microsoft.Kusto/clusters/{c}/databases/{d}/dataConnections/{n}).
 *        Returns provisioningState; runtime ingestion is driven by ADX.
 *
 *   3. application/json with kind === 'onelake':
 *        Body: { kind: 'onelake', database, table, oneLakePath }
 *        Behavior: runs `.ingest into table ['<table>'] (h'<path>')` against
 *        ADX. Storage auth is via the cluster's managed identity; if it
 *        lacks RBAC on the path the editor surfaces the ADX error verbatim.
 *
 * Per .claude/rules/no-vaporware.md — no mock arrays. All three modes either
 * succeed with real data or return a structured error explaining what's
 * missing.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  executeMgmtCommand, ingestInline, KustoError,
} from '@/lib/azure/kusto-client';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_INLINE_ROWS = 50_000;

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

function sanitizeId(s: string, max = 200): string {
  return String(s || '').trim().slice(0, max);
}

function validKustoIdent(s: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_\-]{0,127}$/.test(s);
}

/** Parse a CSV line respecting RFC-4180 double-quote escaping. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else {
        cur += c;
      }
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"') inQ = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text: string): unknown[][] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  return lines.map(parseCsvLine);
}

function parseJsonLines(text: string): unknown[][] {
  // Accept either JSON array of objects OR JSONL. We flatten to a stable
  // column order from the union of keys in the first row.
  const trimmed = text.trim();
  let rows: any[] = [];
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('JSON root must be an array of objects');
    rows = parsed;
  } else {
    rows = trimmed.split(/\r?\n/).filter((l) => l).map((l) => JSON.parse(l));
  }
  if (!rows.length) return [];
  const keys = Array.from(new Set(rows.flatMap((r) => Object.keys(r ?? {}))));
  const header = keys;
  const data = rows.map((r) => keys.map((k) => r?.[k] ?? null));
  return [header, ...data];
}

async function handleFile(_id: string, req: NextRequest): Promise<NextResponse> {
  const form = await req.formData();
  const database = sanitizeId(form.get('database') as string);
  const table = sanitizeId(form.get('table') as string);
  const file = form.get('file') as File | null;
  if (!database || !table) return NextResponse.json({ ok: false, error: 'database + table required' }, { status: 400 });
  if (!validKustoIdent(database)) return NextResponse.json({ ok: false, error: 'invalid database name' }, { status: 400 });
  if (!validKustoIdent(table)) return NextResponse.json({ ok: false, error: 'invalid table name' }, { status: 400 });
  if (!file) return NextResponse.json({ ok: false, error: 'file is required' }, { status: 400 });
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({
      ok: false,
      error: `file too large (${(file.size / 1024 / 1024).toFixed(1)} MB > 5 MB cap for inline ingest). For larger loads use Eventstream or a OneLake shortcut.`,
    }, { status: 413 });
  }

  const buffer = await file.arrayBuffer();
  const text = new TextDecoder().decode(buffer);
  const name = (file.name || '').toLowerCase();
  let rows: unknown[][];
  try {
    if (name.endsWith('.json') || name.endsWith('.jsonl') || name.endsWith('.ndjson')) {
      rows = parseJsonLines(text);
    } else {
      rows = parseCsv(text);
    }
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: `parse failed: ${e?.message || String(e)}` }, { status: 400 });
  }

  if (!rows.length) return NextResponse.json({ ok: false, error: 'file appears empty' }, { status: 400 });
  if (rows.length > MAX_INLINE_ROWS) {
    return NextResponse.json({
      ok: false,
      error: `too many rows (${rows.length} > ${MAX_INLINE_ROWS} inline cap). For larger loads use Eventstream or a OneLake shortcut.`,
    }, { status: 413 });
  }

  // Strip header row from CSV/JSON; we don't auto-create the table — caller
  // must `.create table` first. If the table doesn't exist ADX will return a
  // structured error which we surface verbatim.
  const dataRows = rows.slice(1);
  if (!dataRows.length) return NextResponse.json({ ok: false, error: 'file has only a header row' }, { status: 400 });

  try {
    const result = await ingestInline(database, table, dataRows);
    return NextResponse.json({
      ok: true,
      tableName: table,
      rows: dataRows.length,
      executionMs: result.executionMs,
      mode: 'inline',
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

async function handleEventHub(_id: string, body: any): Promise<NextResponse> {
  const database = sanitizeId(body?.database);
  const table = sanitizeId(body?.table);
  const eventHubName = sanitizeId(body?.eventHubName);
  const consumerGroup = sanitizeId(body?.consumerGroup) || '$Default';
  if (!database || !table || !eventHubName) {
    return NextResponse.json({ ok: false, error: 'database, table, eventHubName required' }, { status: 400 });
  }
  if (!validKustoIdent(database) || !validKustoIdent(table)) {
    return NextResponse.json({ ok: false, error: 'invalid database or table name' }, { status: 400 });
  }

  // The Event Hub resource ID needs to be supplied or resolved. We require
  // the operator to set LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID (full ARM id) and
  // we append /eventhubs/<eventHubName>.
  const nsResourceId = process.env.LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID;
  if (!nsResourceId) {
    return NextResponse.json({
      ok: false,
      error: 'LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID env var not set. Set the namespace ARM id to enable Event Hub → ADX data connections.',
    }, { status: 503 });
  }
  const eventHubResourceId = `${nsResourceId}/eventhubs/${eventHubName}`;

  const sub = process.env.LOOM_SUBSCRIPTION_ID;
  const rg = process.env.LOOM_KUSTO_RG || 'rg-csa-loom-admin-eastus2';
  const cluster = process.env.LOOM_KUSTO_CLUSTER_NAME || 'adx-csa-loom-shared';
  const location = process.env.LOOM_KUSTO_LOCATION || 'eastus2';
  if (!sub) return NextResponse.json({ ok: false, error: 'LOOM_SUBSCRIPTION_ID env var not set' }, { status: 503 });

  const armToken = await credential.getToken(armScope());
  if (!armToken?.token) return NextResponse.json({ ok: false, error: 'failed to acquire ARM token' }, { status: 401 });

  const connName = `${table}-eh-${eventHubName}`.slice(0, 40).replace(/[^A-Za-z0-9_-]/g, '-');
  const url =
    `${armBase()}/subscriptions/${sub}/resourceGroups/${rg}` +
    `/providers/Microsoft.Kusto/clusters/${cluster}/databases/${encodeURIComponent(database)}` +
    `/dataConnections/${encodeURIComponent(connName)}?api-version=2023-08-15`;
  const payload = {
    location,
    kind: 'EventHub',
    properties: {
      eventHubResourceId,
      consumerGroup,
      tableName: table,
      dataFormat: 'JSON',
      compression: 'None',
    },
  };
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'authorization': `Bearer ${armToken.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const msg = (json?.error?.message || text || `ARM ${res.status}`).toString();
    return NextResponse.json({ ok: false, error: msg, status: res.status }, { status: res.status });
  }
  return NextResponse.json({
    ok: true,
    tableName: table,
    mode: 'eventhub',
    provisioningState: json?.properties?.provisioningState || 'Accepted',
    dataConnectionId: json?.id,
  });
}

async function handleOneLake(_id: string, body: any): Promise<NextResponse> {
  const database = sanitizeId(body?.database);
  const table = sanitizeId(body?.table);
  const path = String(body?.oneLakePath || '').trim();
  if (!database || !table || !path) {
    return NextResponse.json({ ok: false, error: 'database, table, oneLakePath required' }, { status: 400 });
  }
  if (!validKustoIdent(database) || !validKustoIdent(table)) {
    return NextResponse.json({ ok: false, error: 'invalid database or table name' }, { status: 400 });
  }
  if (!/^(abfss|https):\/\//i.test(path)) {
    return NextResponse.json({ ok: false, error: 'oneLakePath must be abfss:// or https:// URL' }, { status: 400 });
  }
  // .ingest into table T (h'<url>') ; storage authn is via the cluster's
  // managed identity. If the cluster's MI doesn't have RBAC on the path,
  // ADX will return a clear error which we surface.
  const command = `.ingest into table ["${table}"] (h'${path.replace(/'/g, "\\'")}')`;
  try {
    const result = await executeMgmtCommand(database, command);
    return NextResponse.json({
      ok: true,
      tableName: table,
      mode: 'onelake',
      executionMs: result.executionMs,
      rows: result.rowCount,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const ct = (req.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('multipart/form-data')) {
    return handleFile(ctx.params.id, req);
  }
  const body = await req.json().catch(() => ({}));
  const kind = String(body?.kind || '').toLowerCase();
  if (kind === 'eventhub') return handleEventHub(ctx.params.id, body);
  if (kind === 'onelake') return handleOneLake(ctx.params.id, body);
  return NextResponse.json({ ok: false, error: 'unknown ingest kind; expected file / eventhub / onelake' }, { status: 400 });
}
