/**
 * Azure IO for the report-subscriptions timer Function (WS-C2). Managed-identity
 * (DefaultAzureCredential) only — no keys, no mocks (no-vaporware). Azure-native:
 * Cosmos for the subscription + delivery-log store, the paginated-report-renderer
 * for the export (NOT Power BI ExportTo — no Fabric dependency), and the
 * Consumption delivery Logic App for Office 365 email.
 */
import { DefaultAzureCredential } from '@azure/identity';
import { CosmosClient, type Container } from '@azure/cosmos';
import type { ReportSubscriptionLite } from './schedule';

const cred = new DefaultAzureCredential();

function cosmos(): CosmosClient {
  const endpoint = process.env.LOOM_COSMOS_ENDPOINT;
  if (!endpoint) throw new Error('LOOM_COSMOS_ENDPOINT not set');
  return new CosmosClient({ endpoint, aadCredentials: cred });
}
function db() {
  return cosmos().database(process.env.LOOM_COSMOS_DATABASE || 'loom');
}
export function subscriptionsContainer(): Container { return db().container('report-subscriptions'); }
export function deliveryLogContainer(): Container { return db().container('report-delivery-log'); }

export interface ReportSubscription extends ReportSubscriptionLite {
  itemId?: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  lastStatus?: 'succeeded' | 'failed';
  lastError?: string;
}

/** Read every enabled subscription. Cross-partition query (small collection). */
export async function readEnabledSubscriptions(): Promise<ReportSubscription[]> {
  const { resources } = await subscriptionsContainer().items
    .query<ReportSubscription>({ query: 'SELECT * FROM c WHERE c.enabled = true' })
    .fetchAll();
  return resources || [];
}

/** Bearer token for a resource (ARM, renderer). */
async function tokenFor(resource: string): Promise<string> {
  const t = await cred.getToken(`${resource.replace(/\/$/, '')}/.default`);
  if (!t?.token) throw new Error(`no token for ${resource}`);
  return t.token;
}

/**
 * Render the report to bytes via the Azure-native paginated-report-renderer
 * (LOOM_REPORT_RENDERER_URL). Returns { bytes, sizeBytes } or throws an honest
 * error naming the missing config (no-vaporware) — NEVER a Power BI ExportTo /
 * Fabric call. Power BI export is unavailable in GCC-High; this path is Gov-safe.
 */
export async function renderReport(sub: ReportSubscription): Promise<{ base64: string; sizeBytes: number }> {
  const url = process.env.LOOM_REPORT_RENDERER_URL;
  if (!url) {
    throw new Error('LOOM_REPORT_RENDERER_URL not set — deploy azure-functions/paginated-report-renderer and wire its URL so subscriptions render Azure-native (no Power BI ExportTo).');
  }
  const armLike = process.env.LOOM_REPORT_RENDERER_RESOURCE || url;
  const bearer = await tokenFor(armLike).catch(() => '');
  const res = await fetch(url.replace(/\/$/, '') + '/api/render', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify({ reportId: sub.reportId, workspaceId: sub.workspaceId, format: sub.format }),
  });
  if (!res.ok) throw new Error(`renderer ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString('base64'), sizeBytes: buf.length };
}

/** Resolve the delivery Logic App's manual-trigger callback URL via ARM, then
 *  POST the rendered report so it emails the recipients. Returns nothing on
 *  success; throws an honest error otherwise. */
export async function deliverViaLogicApp(sub: ReportSubscription, base64: string): Promise<void> {
  const workflow = process.env.LOOM_SUBSCRIPTION_LOGIC_APP_NAME;
  if (!workflow) throw new Error('LOOM_SUBSCRIPTION_LOGIC_APP_NAME not set — deploy integration/report-subscription-logicapp.bicep.');
  const sub_ = process.env.LOOM_SUBSCRIPTION_ID;
  const rg = process.env.LOOM_SUBSCRIPTION_LOGIC_APP_RG || process.env.LOOM_DLZ_RG;
  const arm = (process.env.LOOM_ARM_ENDPOINT || 'https://management.azure.com').replace(/\/$/, '');
  if (!sub_ || !rg) throw new Error('LOOM_SUBSCRIPTION_ID / LOOM_SUBSCRIPTION_LOGIC_APP_RG not set for the Logic App lookup.');
  const armToken = await tokenFor(arm);
  const cbUrl = `${arm}/subscriptions/${sub_}/resourceGroups/${rg}`
    + `/providers/Microsoft.Logic/workflows/${workflow}/triggers/manual/listCallbackUrl?api-version=2016-06-01`;
  const cbRes = await fetch(cbUrl, { method: 'POST', headers: { authorization: `Bearer ${armToken}` } });
  if (!cbRes.ok) throw new Error(`listCallbackUrl ${cbRes.status}: ${(await cbRes.text()).slice(0, 200)}`);
  const invokeUrl = (await cbRes.json())?.value;
  if (!invokeUrl) throw new Error('Logic App callback URL missing from listCallbackUrl response');
  const post = await fetch(invokeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      recipients: sub.recipients,
      subject: sub.subject || `Scheduled report: ${sub.reportId}`,
      format: sub.format,
      contentBytes: base64,
      fileName: `${sub.reportId}.${sub.format.toLowerCase()}`,
    }),
  });
  if (!post.ok) throw new Error(`Logic App POST ${post.status}: ${(await post.text()).slice(0, 200)}`);
}

/** Append a delivery-log row + patch the subscription's lastRun fields. */
export async function recordDelivery(
  sub: ReportSubscription,
  outcome: { status: 'succeeded' | 'failed'; sizeBytes?: number; error?: string },
  now: Date,
): Promise<void> {
  const id = `del:${now.getTime()}-${Math.floor((now.getTime() % 100000))}`;
  await deliveryLogContainer().items.create({
    id,
    subscriptionId: sub.id,
    reportId: sub.reportId,
    workspaceId: sub.workspaceId,
    format: sub.format,
    recipients: sub.recipients,
    deliveredAt: now.toISOString(),
    status: outcome.status,
    ...(outcome.sizeBytes != null ? { fileSizeBytes: outcome.sizeBytes } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  });
  // Patch lastRun on the subscription (best-effort; partition key is /reportId).
  try {
    const item = subscriptionsContainer().item(sub.id, sub.reportId);
    const { resource } = await item.read<ReportSubscription>();
    if (resource) {
      resource.lastRunAt = now.toISOString();
      resource.lastStatus = outcome.status;
      resource.lastError = outcome.status === 'failed' ? (outcome.error || 'delivery failed') : undefined;
      await item.replace(resource);
    }
  } catch { /* the log row is the durable record; a patch race is non-fatal */ }
}
