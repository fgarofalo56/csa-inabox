/**
 * subscription-engine — the core of the report-subscriptions timer Function.
 *
 * On each tick it:
 *   1. reads enabled report subscriptions from the shared Cosmos `loom`
 *      database (`report-subscriptions`, PK /reportId),
 *   2. for each subscription due in the current window (cron-match.isDueWithin),
 *      renders the report via the REAL Power BI ExportTo REST job
 *      (start → poll → download) to PDF/PPTX/PNG,
 *   3. archives the rendered file to ADLS Gen2 (report-exports container) via
 *      the storage data-plane REST,
 *   4. delivers it as an email attachment via the report-subscription delivery
 *      Logic App (ARM listCallbackUrl → POST), and
 *   5. writes a `report-delivery-log` row (PK /subscriptionId) and stamps
 *      lastRunAt / lastStatus / lastError on the subscription.
 *
 * No Microsoft Fabric dependency: Power BI REST is the Azure-native rendering
 * backend, ADLS Gen2 is the archive, and a Consumption Logic App + Office 365
 * connector is the Azure-native delivery path.
 *
 * Auth: the Function App identity (system-assigned by default; set
 * AZURE_CLIENT_ID / LOOM_UAMI_CLIENT_ID for a user-assigned identity). It must
 * hold:
 *   - Cosmos DB Built-in Data Contributor on the Loom Cosmos account,
 *   - Storage Blob Data Contributor on LOOM_ADLS_ACCOUNT,
 *   - Logic App Contributor on the delivery workflow,
 *   - membership in each Power BI workspace it exports from (Member+),
 * all wired in bicep + post-deploy bootstrap.
 */
import { CosmosClient, Container } from '@azure/cosmos';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
  type TokenCredential,
} from '@azure/identity';
import { isDueWithin } from './cron-match';

export type ExportFormat = 'PDF' | 'PPTX' | 'PNG';

const MIME: Record<ExportFormat, string> = {
  PDF: 'application/pdf',
  PPTX: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  PNG: 'image/png',
};

const POWERBI_BASE = process.env.LOOM_POWERBI_BASE || 'https://api.powerbi.com/v1.0/myorg';
const POWERBI_SCOPE = process.env.LOOM_POWERBI_SCOPE || 'https://analysis.windows.net/powerbi/api/.default';
const ARM_BASE = process.env.LOOM_ARM_ENDPOINT || 'https://management.azure.com';
const ARM_SCOPE = process.env.LOOM_ARM_SCOPE || 'https://management.azure.com/.default';
const STORAGE_SCOPE = process.env.LOOM_STORAGE_SCOPE || 'https://storage.azure.com/.default';
const STORAGE_SUFFIX = process.env.LOOM_STORAGE_SUFFIX || 'core.windows.net';
const EXPORT_CONTAINER = process.env.LOOM_REPORT_EXPORTS_CONTAINER || 'report-exports';
const LOGIC_API = process.env.LOOM_LOGIC_API_VERSION || '2019-05-01';

/** Minimal logger surface — InvocationContext satisfies this without importing it. */
export interface EngineLog {
  log: (msg: string) => void;
  warn?: (msg: string) => void;
  error: (msg: string) => void;
}

export interface SubscriptionDoc {
  id: string;
  reportId: string;
  workspaceId: string;
  itemId?: string;
  format: ExportFormat;
  cron: string;
  recipients: string[];
  subject?: string;
  enabled: boolean;
  createdBy: string;
  createdByName?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastStatus?: 'succeeded' | 'failed';
  lastError?: string;
}

interface ExportJob {
  id: string;
  status: 'NotStarted' | 'Running' | 'Succeeded' | 'Failed' | 'Undefined';
  error?: { message?: string };
}

let _client: CosmosClient | null = null;
let _cred: TokenCredential | null = null;

function credential(): TokenCredential {
  if (_cred) return _cred;
  const clientId = process.env.AZURE_CLIENT_ID || process.env.LOOM_UAMI_CLIENT_ID;
  const chain: TokenCredential[] = [];
  if (clientId) chain.push(new ManagedIdentityCredential({ clientId }));
  chain.push(new DefaultAzureCredential());
  _cred = new ChainedTokenCredential(...chain);
  return _cred;
}

function cosmos(): CosmosClient {
  if (_client) return _client;
  const endpoint = process.env.LOOM_COSMOS_ENDPOINT;
  if (!endpoint) throw new Error('LOOM_COSMOS_ENDPOINT not set');
  _client = new CosmosClient({ endpoint, aadCredentials: credential() });
  return _client;
}

async function token(scope: string): Promise<string> {
  const t = await credential().getToken(scope);
  if (!t?.token) throw new Error(`Failed to acquire AAD token for ${scope}`);
  return t.token;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Power BI ExportTo — start → poll → download (real REST, groupId-scoped).
// ---------------------------------------------------------------------------
async function pbiFetch(path: string, init?: RequestInit): Promise<Response> {
  const tok = await token(POWERBI_SCOPE);
  return fetch(`${POWERBI_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${tok}`,
      'content-type': 'application/json',
      accept: 'application/json',
      ...(init?.headers || {}),
    },
    cache: 'no-store',
  });
}

/** Render a report to bytes via the Power BI ExportTo async job. */
export async function exportReport(
  workspaceId: string,
  reportId: string,
  format: ExportFormat,
  deadlineMs = 90_000,
): Promise<Uint8Array> {
  const startRes = await pbiFetch(
    `/groups/${encodeURIComponent(workspaceId)}/reports/${encodeURIComponent(reportId)}/ExportTo`,
    { method: 'POST', body: JSON.stringify({ format }) },
  );
  if (!startRes.ok) {
    const t = await startRes.text().catch(() => '');
    throw new Error(`ExportTo start failed (${startRes.status}): ${t || startRes.statusText}`);
  }
  const job = (await startRes.json()) as ExportJob;
  let exportId = job.id;
  let status = job.status;

  const deadline = Date.now() + deadlineMs;
  while ((status === 'Running' || status === 'NotStarted') && Date.now() < deadline) {
    await sleep(2500);
    const pollRes = await pbiFetch(
      `/groups/${encodeURIComponent(workspaceId)}/reports/${encodeURIComponent(reportId)}/exports/${encodeURIComponent(exportId)}`,
    );
    if (!pollRes.ok) {
      const t = await pollRes.text().catch(() => '');
      throw new Error(`ExportTo poll failed (${pollRes.status}): ${t || pollRes.statusText}`);
    }
    const s = (await pollRes.json()) as ExportJob;
    status = s.status;
    exportId = s.id || exportId;
    if (status === 'Failed') throw new Error(s.error?.message || 'Power BI export job failed');
  }
  if (status !== 'Succeeded') throw new Error(`export still ${status} after ${Math.round(deadlineMs / 1000)}s`);

  const fileRes = await pbiFetch(
    `/groups/${encodeURIComponent(workspaceId)}/reports/${encodeURIComponent(reportId)}/exports/${encodeURIComponent(exportId)}/file`,
  );
  if (!fileRes.ok) {
    const t = await fileRes.text().catch(() => '');
    throw new Error(`ExportTo file download failed (${fileRes.status}): ${t || fileRes.statusText}`);
  }
  return new Uint8Array(await fileRes.arrayBuffer());
}

// ---------------------------------------------------------------------------
// ADLS Gen2 archive — storage data-plane REST PUT block blob (UAMI bearer).
// ---------------------------------------------------------------------------
/** Archive the rendered file to ADLS; returns the blob path. Best-effort: a
 * storage failure does NOT block email delivery (the caller logs it). */
export async function archiveToAdls(blobPath: string, bytes: Uint8Array, contentType: string): Promise<string> {
  const account = process.env.LOOM_ADLS_ACCOUNT;
  if (!account) throw new Error('LOOM_ADLS_ACCOUNT not set');
  const tok = await token(STORAGE_SCOPE);
  const url = `https://${account}.blob.${STORAGE_SUFFIX}/${encodeURIComponent(EXPORT_CONTAINER)}/${blobPath}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${tok}`,
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-version': '2021-12-02',
      'content-type': contentType,
      'content-length': String(bytes.byteLength),
    },
    body: bytes as unknown as BodyInit,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`ADLS archive failed (${res.status}): ${t || res.statusText}`);
  }
  return `${EXPORT_CONTAINER}/${blobPath}`;
}

// ---------------------------------------------------------------------------
// Delivery Logic App — ARM listCallbackUrl → POST the attachment.
// ---------------------------------------------------------------------------
function deliveryGate(): string | null {
  const missing: string[] = [];
  if (!process.env.LOOM_SUBSCRIPTION_ID) missing.push('LOOM_SUBSCRIPTION_ID');
  if (!process.env.LOOM_SUBSCRIPTION_LOGIC_APP_NAME) missing.push('LOOM_SUBSCRIPTION_LOGIC_APP_NAME');
  if (!(process.env.LOOM_SUBSCRIPTION_LOGIC_APP_RG || process.env.LOOM_DLZ_RG)) {
    missing.push('LOOM_SUBSCRIPTION_LOGIC_APP_RG (or LOOM_DLZ_RG)');
  }
  return missing.length ? `delivery Logic App not configured (missing ${missing.join(', ')})` : null;
}

let _callbackUrl: string | null = null;
/** Resolve the delivery Logic App HTTP trigger URL via ARM listCallbackUrl. */
async function resolveDeliveryUrl(): Promise<string> {
  if (_callbackUrl) return _callbackUrl;
  const gate = deliveryGate();
  if (gate) throw new Error(gate);
  const sub = process.env.LOOM_SUBSCRIPTION_ID!;
  const rg = (process.env.LOOM_SUBSCRIPTION_LOGIC_APP_RG || process.env.LOOM_DLZ_RG)!;
  const wf = process.env.LOOM_SUBSCRIPTION_LOGIC_APP_NAME!;
  const trigger = process.env.LOOM_SUBSCRIPTION_LOGIC_APP_TRIGGER || 'manual';
  const url =
    `${ARM_BASE}/subscriptions/${sub}/resourceGroups/${encodeURIComponent(rg)}` +
    `/providers/Microsoft.Logic/workflows/${encodeURIComponent(wf)}` +
    `/triggers/${encodeURIComponent(trigger)}/listCallbackUrl?api-version=${LOGIC_API}`;
  const tok = await token(ARM_SCOPE);
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`listCallbackUrl failed (${res.status}): ${t || res.statusText}`);
  }
  const body = (await res.json()) as { value?: string };
  if (!body.value) throw new Error('listCallbackUrl returned no value');
  _callbackUrl = body.value;
  return _callbackUrl;
}

/** POST the rendered report to the delivery Logic App as a base64 attachment. */
export async function deliverEmail(args: {
  recipients: string[];
  subject: string;
  reportName: string;
  attachmentName: string;
  attachmentContentType: string;
  bytes: Uint8Array;
}): Promise<void> {
  const triggerUrl = await resolveDeliveryUrl();
  const attachmentBase64 = Buffer.from(args.bytes).toString('base64');
  const res = await fetch(triggerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      recipients: args.recipients.join(';'),
      subject: args.subject,
      reportName: args.reportName,
      attachmentName: args.attachmentName,
      attachmentContentType: args.attachmentContentType,
      attachmentBase64,
    }),
  });
  if (!res.ok && res.status !== 202) {
    const t = await res.text().catch(() => '');
    throw new Error(`Logic App delivery failed (${res.status}): ${t || res.statusText}`);
  }
}

// ---------------------------------------------------------------------------
// Tick orchestration.
// ---------------------------------------------------------------------------
function db() {
  const dbId = process.env.LOOM_COSMOS_DATABASE || 'loom';
  return cosmos().database(dbId);
}

/**
 * Process all enabled subscriptions due in (windowStartMs, windowEndMs]. The
 * window is the Function's own tick interval (from scheduleStatus, with a
 * fallback). Returns a summary for the invocation log.
 */
export async function runSubscriptions(
  log: EngineLog,
  windowStartMs: number,
  windowEndMs: number,
): Promise<{ scanned: number; due: number; delivered: number; failed: number }> {
  const subsC: Container = db().container('report-subscriptions');
  const logC: Container = db().container('report-delivery-log');

  const { resources: subs } = await subsC.items
    .query<SubscriptionDoc>('SELECT * FROM c WHERE c.enabled = true')
    .fetchAll();

  let due = 0;
  let delivered = 0;
  let failed = 0;

  for (const sub of subs) {
    if (!isDueWithin(sub.cron, windowStartMs, windowEndMs)) continue;
    due++;
    const reportName = sub.subject || `report-${sub.reportId}`;
    const ext = sub.format.toLowerCase();
    const attachmentName = `${reportName.replace(/[^\w.-]+/g, '_')}.${ext}`;
    const deliveredAt = new Date().toISOString();
    const blobPath = `${sub.id.replace(/[^\w.-]+/g, '_')}/${deliveredAt.replace(/[:.]/g, '-')}.${ext}`;

    try {
      const bytes = await exportReport(sub.workspaceId, sub.reportId, sub.format);

      // Archive to ADLS (best-effort — a storage gap should not block email).
      let archivedPath: string | undefined;
      try {
        archivedPath = await archiveToAdls(blobPath, bytes, MIME[sub.format]);
      } catch (e: any) {
        log.warn?.(`subscription ${sub.id}: ADLS archive skipped — ${e?.message || e}`);
      }

      await deliverEmail({
        recipients: sub.recipients,
        subject: sub.subject || `Scheduled report: ${reportName}`,
        reportName,
        attachmentName,
        attachmentContentType: MIME[sub.format],
        bytes,
      });

      await logC.items.create({
        id: `del:${cryptoRandom()}`,
        subscriptionId: sub.id,
        reportId: sub.reportId,
        workspaceId: sub.workspaceId,
        format: sub.format,
        recipients: sub.recipients,
        deliveredAt,
        status: 'succeeded',
        fileSizeBytes: bytes.byteLength,
        blobPath: archivedPath,
      });
      sub.lastRunAt = deliveredAt;
      sub.lastStatus = 'succeeded';
      sub.lastError = undefined;
      await subsC.item(sub.id, sub.reportId).replace(sub);
      delivered++;
      log.log(`subscription ${sub.id}: delivered ${sub.format} (${bytes.byteLength} bytes) to ${sub.recipients.length} recipient(s)`);
    } catch (e: any) {
      const error = e?.message || String(e);
      failed++;
      try {
        await logC.items.create({
          id: `del:${cryptoRandom()}`,
          subscriptionId: sub.id,
          reportId: sub.reportId,
          workspaceId: sub.workspaceId,
          format: sub.format,
          recipients: sub.recipients,
          deliveredAt,
          status: 'failed',
          error,
        });
        sub.lastRunAt = deliveredAt;
        sub.lastStatus = 'failed';
        sub.lastError = error;
        await subsC.item(sub.id, sub.reportId).replace(sub);
      } catch (inner: any) {
        log.error(`subscription ${sub.id}: failed to record delivery error — ${inner?.message || inner}`);
      }
      log.error(`subscription ${sub.id}: delivery failed — ${error}`);
    }
  }

  log.log(`report-subscriptions: scanned ${subs.length}, due ${due}, delivered ${delivered}, failed ${failed}`);
  return { scanned: subs.length, due, delivered, failed };
}

/** crypto.randomUUID without importing node:crypto types at module scope. */
function cryptoRandom(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return (globalThis.crypto?.randomUUID?.() as string) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
