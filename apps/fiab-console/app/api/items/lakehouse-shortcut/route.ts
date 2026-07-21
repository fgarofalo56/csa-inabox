/**
 * Lakehouse shortcut item — the Azure-native equivalent of a OneLake shortcut.
 *
 * A shortcut is a NAMED POINTER to external data that a lakehouse reads IN PLACE
 * without copying. The pointer (name + a CONNECTOR: source type + non-secret
 * coordinates + an optional Key Vault `secretRef`) persists as a Cosmos workspace
 * item; every source resolves against a REAL Azure/cloud backend so a shortcut is
 * proven to resolve WITHOUT moving a byte. No Microsoft Fabric / OneLake
 * dependency (no-fabric-dependency.md).
 *
 * Source types (Azure-native parity with Fabric's New-shortcut dialog):
 *   internal      internal lakehouse-to-lakehouse (primary ADLS Gen2 medallion) — UAMI
 *   adls          external ADLS Gen2 account + container + path                 — UAMI (or SAS)
 *   blob          Azure Blob account + container + path                         — UAMI (or SAS)
 *   s3            Amazon S3 bucket (region + access key)                        — KV secret
 *   s3compatible  S3-compatible store (endpoint host + access key)             — KV secret
 *   gcs           Google Cloud Storage bucket (service-account JSON)           — KV secret
 *   dataverse     Dataverse via its Azure Synapse Link ADLS Gen2 export path   — UAMI
 *
 *   GET    /api/items/lakehouse-shortcut?workspaceId=…          → { ok, shortcuts, adlsConfigured, kvConfigured }
 *   POST   /api/items/lakehouse-shortcut?workspaceId=…  { sourceType, displayName, …connector, secret? }
 *   POST   /api/items/lakehouse-shortcut?workspaceId=…  { action:'verify', sourceType, …connector, secret? }
 *   DELETE /api/items/lakehouse-shortcut?workspaceId=…&id=…     → delete the pointer (+ its KV secret)
 *
 * Secrets (S3/GCS access keys, SAS) go to Key Vault via the shortcut vault and
 * only a `secretRef` is persisted — never raw secret material in Cosmos
 * (no-vaporware.md). Honest gate: when a source needs a secret but no shortcut
 * Key Vault is configured, create returns 503 naming LOOM_SHORTCUT_KEYVAULT.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { assertOwner } from '@/lib/auth/workspace-guard';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { getAccountName, hasConfiguredContainers } from '@/lib/azure/adls-client';
import { getDfsSuffix } from '@/lib/azure/cloud-endpoints';
import {
  browseAdls, listS3Objects, listGcsObjects, listAdlsWithSas, listDataverseEntities,
  ShortcutSourceError, type BrowseResult, type GcsServiceAccount,
} from '@/lib/azure/shortcut-client';
import {
  putShortcutSecret, deleteShortcutSecret, shortcutKeyVaultConfigGate,
} from '@/lib/azure/kv-secrets-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import { apiError } from '@/lib/api/respond';
import {
  pickTablesEngine, createTablesShortcut, dropShortcutObject, bindExternalSource,
  dropExternalBinding, type TablesRegistration, type EngineGate,
} from '@/lib/azure/shortcut-engines';
import type { ShortcutCredentialRef } from '@/lib/azure/lakehouse-shortcuts';
import { executeQuery, serverlessTarget } from '@/lib/azure/synapse-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export type SourceType = 'internal' | 'adls' | 'blob' | 's3' | 's3compatible' | 'gcs' | 'dataverse';
const SOURCE_TYPES: SourceType[] = ['internal', 'adls', 'blob', 's3', 's3compatible', 'gcs', 'dataverse'];
/** Sources whose credential MUST be persisted to Key Vault to resolve later. */
const SECRET_REQUIRED = new Set<SourceType>(['s3', 's3compatible', 'gcs']);

/** A shortcut is a named POINTER (kind='files') or a zero-copy queryable external
 *  TABLE/VIEW (kind='tables') the lakehouse SQL endpoint reads in place. */
export type ShortcutKind = 'files' | 'tables';
const SHORTCUT_KINDS: ShortcutKind[] = ['files', 'tables'];
type TableFormat = 'delta' | 'parquet' | 'csv' | 'json';
const TABLE_FORMATS: TableFormat[] = ['delta', 'parquet', 'csv', 'json'];

function isGate(x: unknown): x is EngineGate {
  return !!x && typeof x === 'object' && (x as EngineGate).gated === true;
}

/**
 * Register a Tables shortcut as a REAL zero-copy external table/view on the
 * default Azure-native engine (Synapse Serverless view via OPENROWSET, or —
 * when only Databricks is configured — a Unity Catalog external table over the
 * abfss/object location). The lakehouse SQL analytics endpoint then queries it
 * by its 3-part `engineObject` name WITHOUT copying a byte. No Fabric REST.
 *
 * `resolved` is the proven read address from resolveByType(); `secretRef` is the
 * Key Vault secret name for S3/GCS credentials (bindExternalSource resolves it).
 * Returns a TablesRegistration on success or an EngineGate (honest, Fix-it-able).
 */
async function registerTablesObject(opts: {
  id: string;
  displayName: string;
  sourceType: SourceType;
  resolved: ResolveOk;
  secretRef?: string;
  format?: TableFormat;
}): Promise<TablesRegistration | EngineGate> {
  const { id, displayName, sourceType, resolved, secretRef, format } = opts;
  // Namespace the engine object by the shortcut id so two shortcuts of the same
  // display name (across workspaces) never collide in the shared `shortcuts`
  // schema / `loom` UC catalog, and never leak across tenants.
  const engName = `${id.slice(0, 8)}_${displayName}`;
  const lakehouseNs = `sc_${id.slice(0, 8)}`;

  // S3 / GCS: bind the external cloud source (UC external location / Synapse
  // data source over a Key-Vault-stored credential) then register the table.
  if (sourceType === 's3' || sourceType === 'gcs') {
    if (!secretRef) {
      return { gated: true, code: 'needs_credential', hint: `${sourceType.toUpperCase()} Tables shortcuts need a stored credential — save a Key Vault-backed shortcut secret first.` };
    }
    const targetType = sourceType === 'gcs' ? 'gcs' : 's3';
    const credentialRef: ShortcutCredentialRef = {
      kind: sourceType === 'gcs' ? 'gcsServiceAccount' : 'awsKeys',
      keyVaultSecret: secretRef,
    };
    const bind = await bindExternalSource({ lakehouseId: lakehouseNs, name: engName, targetType, targetUri: resolved.targetUri, credentialRef });
    if (isGate(bind)) return bind;
    const m = bind.readUri.match(/^(?:s3a?|gs):\/\/[^/]+\/?(.*)$/i);
    return createTablesShortcut({
      lakehouseId: lakehouseNs, name: engName, abfssUri: bind.readUri, format,
      external: { objectUri: bind.readUri, ucExternalLocation: bind.ucExternalLocation, synapseDataSource: bind.synapse?.dataSource, objectKey: m ? m[1] : '' },
    });
  }

  // S3-compatible (MinIO/Wasabi/etc): no Synapse/UC external-location binding on
  // the default path — surface as a Files shortcut, or use the lakehouse editor's
  // Shortcuts tab which carries the full external-credential engine.
  if (sourceType === 's3compatible') {
    return { gated: true, code: 's3compatible_files_only', hint: 'S3-compatible sources register as Files shortcuts (read in a notebook via the stored credential). Use kind=files, or create the Tables shortcut from the lakehouse editor Shortcuts tab.' };
  }

  // ADLS / Blob / internal / Dataverse: an abfss read address the engine reads
  // in place on the Console UAMI (OPENROWSET / UC external table over abfss).
  const abfss = resolved.abfss;
  if (!abfss) {
    return { gated: true, code: 'no_abfss_target', hint: 'A Tables shortcut needs an ADLS Gen2 (abfss) target the query engine can read in place.' };
  }
  return createTablesShortcut({ lakehouseId: lakehouseNs, name: engName, abfssUri: abfss, format });
}

function err(error: string, status: number, extra?: Record<string, unknown>) {
  return apiError(error, status, extra);
}

function sanitize(e: any): string {
  return (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

async function loadWs(id: string, tenantId: string): Promise<Workspace | null> {
  const c = await workspacesContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<Workspace>();
    return resource?.tenantId === tenantId ? resource : null;
  } catch (e: any) { if (e?.code === 404) return null; throw e; }
}

/** Sovereign-cloud-correct abfss:// for an ADLS-family target (bare account name). */
function buildAbfss(account: string, container: string, path: string): string {
  const acct = (account || '').replace(/^https?:\/\//, '').split('.')[0];
  const clean = (path || '').replace(/^\/+|\/+$/g, '');
  return `abfss://${container}@${acct}.${getDfsSuffix()}/${clean}`;
}

function sampleOf(r: BrowseResult) {
  return r.entries.slice(0, 10).map((e) => ({ name: e.name, isDirectory: e.isDirectory, size: e.size }));
}

interface Connector {
  container?: string; path?: string; account?: string;
  bucket?: string; region?: string; endpointHost?: string;
  environmentUrl?: string; exportAbfssUri?: string;
}

type ResolveOk = { resolved: true; targetUri: string; abfss?: string; entryCount: number; sample: any[] };
type ResolveNo = { resolved: false; reason: string; code?: string; status: number };

/**
 * Resolve + prove a source connector against its REAL backend by listing one
 * level (no copy). `secret` is the plaintext credential the caller supplied for
 * this request only (never persisted here). Returns the resolved read address +
 * entry count, or an honest not-resolved reason with a machine code + status.
 */
async function resolveByType(sourceType: SourceType, cfg: Connector, secret?: string): Promise<ResolveOk | ResolveNo> {
  const path = (cfg.path || '').replace(/^\/+|\/+$/g, '');
  const sas = (secret || '').trim();
  try {
    if (sourceType === 'internal') {
      const container = (cfg.container || '').trim();
      if (!container) return { resolved: false, reason: 'Target container is required.', status: 400 };
      if (!hasConfiguredContainers()) {
        return {
          resolved: false,
          code: 'not_configured',
          reason: 'No ADLS Gen2 data lake is configured. Set LOOM_BRONZE_URL / LOOM_SILVER_URL / LOOM_GOLD_URL (the DLZ medallion containers) so shortcuts can resolve internal paths.',
          status: 503,
        };
      }
      const account = getAccountName();
      const r = await browseAdls({ account, container, prefix: path });
      const abfss = buildAbfss(account, container, path);
      return { resolved: true, targetUri: abfss, abfss, entryCount: r.entries.length, sample: sampleOf(r) };
    }

    if (sourceType === 'adls' || sourceType === 'blob') {
      const account = (cfg.account || '').trim().replace(/^https?:\/\//, '').split('.')[0];
      const container = (cfg.container || '').trim();
      if (!account || !container) return { resolved: false, reason: 'Storage account and container/filesystem are required.', status: 400 };
      const r: BrowseResult = sas
        ? await listAdlsWithSas({ account, container, path, sasToken: sas })
        : await browseAdls({ account, container, prefix: path });
      const abfss = buildAbfss(account, container, path);
      return { resolved: true, targetUri: abfss, abfss, entryCount: r.entries.length, sample: sampleOf(r) };
    }

    if (sourceType === 's3' || sourceType === 's3compatible') {
      const bucket = (cfg.bucket || '').trim();
      const region = (cfg.region || 'us-east-1').trim();
      if (!bucket) return { resolved: false, reason: 'S3 bucket is required.', status: 400 };
      if (!sas || !sas.includes(':')) {
        return { resolved: false, code: 'needs_credential', reason: "S3 requires an access key in 'AccessKeyId:SecretAccessKey' form.", status: 400 };
      }
      const idx = sas.indexOf(':');
      const accessKeyId = sas.slice(0, idx);
      const secretAccessKey = sas.slice(idx + 1);
      let endpointHost: string | undefined;
      if (sourceType === 's3compatible') {
        endpointHost = (cfg.endpointHost || '').trim();
        if (!endpointHost) return { resolved: false, reason: 'An S3-compatible endpoint host is required (e.g. minio.example.com).', status: 400 };
      }
      const r = await listS3Objects({ bucket, region, prefix: path, accessKeyId, secretAccessKey, endpointHost });
      return { resolved: true, targetUri: `s3://${bucket}/${path}`, entryCount: r.entries.length, sample: sampleOf(r) };
    }

    if (sourceType === 'gcs') {
      const bucket = (cfg.bucket || '').trim();
      if (!bucket) return { resolved: false, reason: 'GCS bucket is required.', status: 400 };
      if (!sas) return { resolved: false, code: 'needs_credential', reason: 'GCS requires a service-account JSON key.', status: 400 };
      let serviceAccount: GcsServiceAccount;
      try { serviceAccount = JSON.parse(sas); } catch {
        return { resolved: false, reason: 'The GCS service-account key must be valid JSON (client_email + private_key).', status: 400 };
      }
      const r = await listGcsObjects({ bucket, prefix: path, serviceAccount });
      return { resolved: true, targetUri: `gs://${bucket}/${path}`, entryCount: r.entries.length, sample: sampleOf(r) };
    }

    if (sourceType === 'dataverse') {
      const exportUri = (cfg.exportAbfssUri || '').trim();
      if (!exportUri) return { resolved: false, reason: 'The Dataverse Azure Synapse Link export path (abfss://…) is required.', status: 400 };
      const r = await listDataverseEntities({ exportAbfssUri: exportUri, prefix: path });
      return { resolved: true, targetUri: exportUri, abfss: exportUri, entryCount: r.entries.length, sample: sampleOf(r) };
    }

    return { resolved: false, reason: `Unknown source type: ${sourceType}`, status: 400 };
  } catch (e: any) {
    if (e instanceof ShortcutSourceError) return { resolved: false, reason: sanitize(e), code: e.code, status: e.status || 502 };
    return { resolved: false, reason: sanitize(e), code: e?.code, status: (typeof e?.statusCode === 'number' ? e.statusCode : 502) };
  }
}

/** Pull the connector coordinates out of a request body. */
function connectorFromBody(body: any): Connector {
  return {
    container: typeof body?.container === 'string' ? body.container.trim() : undefined,
    path: typeof body?.path === 'string' ? body.path.trim() : undefined,
    account: typeof body?.account === 'string' ? body.account.trim() : undefined,
    bucket: typeof body?.bucket === 'string' ? body.bucket.trim() : undefined,
    region: typeof body?.region === 'string' ? body.region.trim() : undefined,
    endpointHost: typeof body?.endpointHost === 'string' ? body.endpointHost.trim() : undefined,
    environmentUrl: typeof body?.environmentUrl === 'string' ? body.environmentUrl.trim() : undefined,
    exportAbfssUri: typeof body?.exportAbfssUri === 'string' ? body.exportAbfssUri.trim() : undefined,
  };
}

/** Legacy rows (pre source-type) carried only container/path on the primary account. */
function shortcutView(r: WorkspaceItem) {
  const st = (r.state as any) || {};
  const sourceType: SourceType = (st.sourceType as SourceType) || 'internal';
  return {
    id: r.id,
    displayName: r.displayName,
    sourceType,
    kind: (st.kind as ShortcutKind) || 'files',
    format: st.format,
    engine: st.engine || 'none',
    engineObject: st.engineObject,
    engineStatus: st.engineStatus || (st.engineObject ? 'active' : undefined),
    engineDetail: st.engineDetail,
    container: st.container,
    path: st.path,
    account: st.account,
    bucket: st.bucket,
    targetUri: st.targetUri || st.abfss || (st.container ? `${st.container}/${st.path || ''}` : undefined),
    abfss: st.abfss,
    hasSecret: !!st.secretRef,
    entryCount: st.entryCount,
    lastVerifiedAt: st.lastVerifiedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return err('workspace not found', 404);
    const items = await itemsContainer();
    const { resources } = await items.items.query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.workspaceId = @w AND c.itemType = @t ORDER BY c.updatedAt DESC',
      parameters: [{ name: '@w', value: workspaceId }, { name: '@t', value: 'lakehouse-shortcut' }],
    }, { partitionKey: workspaceId }).fetchAll();
    return NextResponse.json({
      ok: true, workspaceId,
      adlsConfigured: hasConfiguredContainers(),
      kvConfigured: !shortcutKeyVaultConfigGate(),
      shortcuts: resources.map(shortcutView),
    });
  } catch (e: any) { return err(sanitize(e), 500); }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));

  const sourceType = (String(body?.sourceType || 'internal') as SourceType);
  if (!SOURCE_TYPES.includes(sourceType)) return err(`sourceType must be one of ${SOURCE_TYPES.join(', ')}`, 400);
  const cfg = connectorFromBody(body);
  const secret = typeof body?.secret === 'string' ? body.secret : '';
  const kind: ShortcutKind = SHORTCUT_KINDS.includes(body?.kind) ? body.kind : 'files';
  const format: TableFormat = TABLE_FORMATS.includes(body?.format) ? body.format : 'delta';

  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return err('workspace not found', 404);

    // Zero-copy QUERY: run SELECT TOP n over a Tables shortcut's engine object
    // through the Synapse Serverless SQL endpoint (the lakehouse SQL endpoint) —
    // reading the external data IN PLACE, no copy. Proves the acceptance in-editor.
    if (body?.action === 'query') {
      const id = String(body?.id || '').trim();
      if (!id) return err('id required', 400);
      const items = await itemsContainer();
      let row: WorkspaceItem | undefined;
      try {
        const { resource } = await items.item(id, workspaceId).read<WorkspaceItem>();
        row = resource || undefined;
      } catch (e: any) { if (e?.code !== 404) throw e; }
      if (!row || row.itemType !== 'lakehouse-shortcut') return err('shortcut not found', 404);
      const stt = (row.state as any) || {};
      if ((stt.kind || 'files') !== 'tables' || !stt.engineObject) {
        return err('This shortcut is not a queryable Tables shortcut. Create it with kind=tables.', 400, { code: 'not_queryable' });
      }
      if (stt.engine === 'databricks') {
        // The UC external table is queryable from a Databricks SQL editor; the
        // Synapse TDS client cannot read a UC catalog. Return the queryable name
        // honestly rather than a fake grid (no-vaporware).
        return NextResponse.json({
          ok: true, engineObject: stt.engineObject, engine: 'databricks',
          columns: [], rows: [],
          note: `Query zero-copy in a Databricks SQL editor: SELECT * FROM ${stt.engineObject} LIMIT 100;`,
        });
      }
      if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
        return err(
          'Synapse Serverless SQL endpoint not provisioned. Set LOOM_SYNAPSE_WORKSPACE and grant the Console UAMI Synapse SQL admin + Storage Blob Data Reader to query shortcuts zero-copy.',
          503, { code: 'synapse_not_configured' },
        );
      }
      const top = Math.min(Math.max(parseInt(String(body?.top || '100'), 10) || 100, 1), 1000);
      try {
        const result = await executeQuery(serverlessTarget('master'), `SELECT TOP ${top} * FROM ${stt.engineObject};`);
        return NextResponse.json({ ok: true, engineObject: stt.engineObject, engine: 'synapse', columns: result.columns, rows: result.rows, rowCount: result.rowCount });
      } catch (e: any) {
        const raw = sanitize(e);
        const isEmpty = /cannot be listed|does not exist|not found|no files|0x80070002/i.test(raw);
        if (isEmpty) return NextResponse.json({ ok: true, engineObject: stt.engineObject, engine: 'synapse', columns: [], rows: [], rowCount: 0, note: 'The shortcut target is empty or not yet populated — no rows (expected until the source has data).' });
        return err(raw, 502, { code: 'query_failed' });
      }
    }

    // Verify-only: resolve the target without persisting a pointer or a secret.
    if (body?.action === 'verify') {
      const r = await resolveByType(sourceType, cfg, secret || undefined);
      if (!r.resolved) return NextResponse.json({ ok: true, resolved: false, reason: r.reason, code: r.code });
      return NextResponse.json({ ok: true, resolved: true, targetUri: r.targetUri, abfss: r.abfss, entryCount: r.entryCount, sample: r.sample });
    }

    const displayName = String(body?.displayName || '').trim();
    if (!displayName) return err('displayName required', 400);

    const needsSecret = SECRET_REQUIRED.has(sourceType);
    if (needsSecret && !secret.trim()) return err('This source requires a credential.', 400, { code: 'needs_credential' });

    // A shortcut whose secret must persist can only be created when a shortcut
    // Key Vault is configured (so the pointer resolves later). Honest gate.
    const willPersistSecret = !!secret.trim() && (needsSecret || sourceType === 'adls' || sourceType === 'blob');
    if (willPersistSecret) {
      const gate = shortcutKeyVaultConfigGate();
      if (gate) return err(gate.detail, 503, { code: 'kv_not_configured', missing: gate.missing });
    }

    // Resolve against the real backend BEFORE persisting — never a dangling pointer.
    const r = await resolveByType(sourceType, cfg, secret || undefined);
    if (!r.resolved) {
      return NextResponse.json(
        { ok: false, error: r.reason, code: r.code || 'not_resolved' },
        { status: r.status >= 400 ? r.status : 502 },
      );
    }

    const id = crypto.randomUUID();
    let secretRef: string | undefined;
    if (willPersistSecret) {
      const { name } = await putShortcutSecret(`loom-shortcut-${id}`, secret);
      secretRef = name;
    }

    // Tables shortcut → register a REAL zero-copy external table/view on the
    // Azure-native engine so the lakehouse SQL endpoint can query it in place.
    let engine: 'synapse' | 'databricks' | 'none' = 'none';
    let engineObject: string | undefined;
    let engineStatus: 'active' | 'pending' | 'error' | undefined;
    let engineDetail: string | undefined;
    let tablesGate: EngineGate | undefined;
    if (kind === 'tables') {
      if (!pickTablesEngine()) {
        // Honest infra-gate: no query engine configured. Persist the pointer as
        // pending so it's visible + retryable; the editor renders a Fix-it.
        tablesGate = {
          gated: true, code: 'no_tables_engine',
          hint: 'A Tables shortcut registers a zero-copy external table, which needs a query engine. Set LOOM_SYNAPSE_WORKSPACE (Synapse Serverless — preferred) or LOOM_DATABRICKS_HOSTNAME (Databricks Unity Catalog). Files shortcuts work without either.',
        };
        engineStatus = 'pending';
        engineDetail = tablesGate.hint;
      } else {
        try {
          const reg = await registerTablesObject({ id, displayName, sourceType, resolved: r, secretRef, format });
          if (isGate(reg)) { tablesGate = reg; engineStatus = 'pending'; engineDetail = reg.hint; }
          else { engine = reg.engine as 'synapse' | 'databricks'; engineObject = reg.engineObject; engineStatus = 'active'; }
        } catch (e: any) {
          engineStatus = 'error';
          engineDetail = sanitize(e);
        }
      }
    }

    const now = new Date().toISOString();
    const item: WorkspaceItem = {
      id, workspaceId, itemType: 'lakehouse-shortcut',
      displayName, description: body?.description,
      state: {
        sourceType,
        kind, format: kind === 'tables' ? format : undefined,
        engine, engineObject, engineStatus, engineDetail,
        container: cfg.container, path: cfg.path, account: cfg.account,
        bucket: cfg.bucket, region: cfg.region, endpointHost: cfg.endpointHost,
        environmentUrl: cfg.environmentUrl, exportAbfssUri: cfg.exportAbfssUri,
        secretRef,
        targetUri: r.targetUri, abfss: r.abfss,
        entryCount: r.entryCount, lastVerifiedAt: now,
      },
      createdBy: s.claims.upn || s.claims.email || s.claims.oid,
      createdAt: now, updatedAt: now,
    };
    const items = await itemsContainer();
    const { resource } = await items.items.create(item);
    const view = resource ? shortcutView(resource as WorkspaceItem) : null;
    // Tables shortcut whose engine object could not be created → honest 503 with
    // the exact remediation, but the pointer row exists (visible + retryable).
    if (tablesGate) {
      return NextResponse.json(
        { ok: false, code: tablesGate.code, error: tablesGate.hint, hint: tablesGate.hint, shortcut: view, resolution: r },
        { status: 503 },
      );
    }
    if (engineStatus === 'error') {
      return NextResponse.json(
        { ok: false, code: 'engine_error', error: engineDetail, shortcut: view, resolution: r },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, shortcut: view, resolution: r, engineObject });
  } catch (e: any) { return err(sanitize(e), 500); }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  const id = req.nextUrl.searchParams.get('id');
  if (!workspaceId || !id) return err('workspaceId and id required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return err('workspace not found', 404);
  try {
    const items = await itemsContainer();
    // Best-effort: read the row first so we can also drop the engine object +
    // delete its KV secret. The engine object (Synapse view / UC table) is
    // dropped — NEVER the underlying source bytes (matches UC/Fabric semantics).
    try {
      const { resource } = await items.item(id, workspaceId).read<WorkspaceItem>();
      const st = (resource?.state as any) || {};
      if (st.engine && st.engine !== 'none' && st.engineObject) {
        await dropShortcutObject({ engine: st.engine, engineObject: st.engineObject }).catch(() => { /* already-dropped/missing must not block */ });
        if ((st.sourceType === 's3' || st.sourceType === 'gcs') && st.engine === 'databricks') {
          await dropExternalBinding(`sc_${id.slice(0, 8)}`, `${id.slice(0, 8)}_${resource?.displayName || ''}`).catch(() => { /* best-effort */ });
        }
      }
      if (st.secretRef) await deleteShortcutSecret(st.secretRef);
    } catch { /* proceed to delete the pointer regardless */ }
    await items.item(id, workspaceId).delete();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: true });
    return err(sanitize(e), 500);
  }
}
