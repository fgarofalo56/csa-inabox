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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export type SourceType = 'internal' | 'adls' | 'blob' | 's3' | 's3compatible' | 'gcs' | 'dataverse';
const SOURCE_TYPES: SourceType[] = ['internal', 'adls', 'blob', 's3', 's3compatible', 'gcs', 'dataverse'];
/** Sources whose credential MUST be persisted to Key Vault to resolve later. */
const SECRET_REQUIRED = new Set<SourceType>(['s3', 's3compatible', 'gcs']);

function err(error: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...(extra || {}) }, { status });
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

  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return err('workspace not found', 404);

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

    const now = new Date().toISOString();
    const item: WorkspaceItem = {
      id, workspaceId, itemType: 'lakehouse-shortcut',
      displayName, description: body?.description,
      state: {
        sourceType,
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
    return NextResponse.json({ ok: true, shortcut: resource ? shortcutView(resource as WorkspaceItem) : null, resolution: r });
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
    // Best-effort: read the row first so we can also delete its KV secret.
    try {
      const { resource } = await items.item(id, workspaceId).read<WorkspaceItem>();
      const secretRef = (resource?.state as any)?.secretRef;
      if (secretRef) await deleteShortcutSecret(secretRef);
    } catch { /* proceed to delete the pointer regardless */ }
    await items.item(id, workspaceId).delete();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: true });
    return err(sanitize(e), 500);
  }
}
