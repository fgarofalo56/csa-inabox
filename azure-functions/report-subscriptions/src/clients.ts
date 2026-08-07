/**
 * Azure IO for the report-subscriptions timer Function (WS-C2). Managed-identity
 * (DefaultAzureCredential) only — no keys, no mocks (no-vaporware). Azure-native:
 * Cosmos for the subscription + delivery-log store, the paginated-report-renderer
 * for the export (NOT Power BI ExportTo — no Fabric dependency), and the
 * Consumption delivery Logic App for Office 365 email.
 */
import { DefaultAzureCredential } from '@azure/identity';
import { deliveryPayload, FORMAT_MIME, type DeliveryMessage } from './delivery-payload';
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

/** The shared Loom Cosmos database handle — reused by the B-N19d insights engine. */
export const loomDb = db;

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
 * Bearer token for an explicit AAD *scope* (already `/.default`-suffixed).
 * `tokenFor` takes a resource and appends the suffix; the B-N19d insights
 * engine works in scopes (ARM, Azure OpenAI), so it uses this one.
 */
export async function acquireToken(scope: string): Promise<string> {
  const t = await cred.getToken(scope);
  if (!t?.token) throw new Error(`Failed to acquire AAD token for ${scope}`);
  return t.token;
}

/**
 * The delivery infrastructure this Function needs before it can send ANYTHING
 * (a report attachment or a B-N19d digest body). Returns a human remediation
 * string when a required value is missing, or `''` when delivery is configured.
 *
 * Reported identically by both the subscription path and the digest path so an
 * operator sees one reason, not two dialects of the same gap.
 */
export function deliveryConfigGate(): string {
  if (!process.env.LOOM_SUBSCRIPTION_LOGIC_APP_NAME) {
    return 'LOOM_SUBSCRIPTION_LOGIC_APP_NAME not set — deploy integration/report-subscription-logicapp.bicep (reportSubscriptionsEnabled=true) so deliveries have a mail path.';
  }
  if (!process.env.LOOM_SUBSCRIPTION_ID) {
    return 'LOOM_SUBSCRIPTION_ID not set — the Logic App listCallbackUrl lookup needs the subscription id.';
  }
  if (!process.env.LOOM_SUBSCRIPTION_LOGIC_APP_RG && !process.env.LOOM_DLZ_RG) {
    return 'LOOM_SUBSCRIPTION_LOGIC_APP_RG (or LOOM_DLZ_RG) not set — the Logic App listCallbackUrl lookup needs the resource group.';
  }
  return '';
}

/**
 * Resolve the delivery Logic App's manual-trigger callback URL via ARM.
 * Cached per process — the callback URL is stable for the workflow's lifetime
 * and every tick would otherwise re-POST listCallbackUrl per delivery.
 */
let _callbackUrl: string | null = null;
async function resolveDeliveryUrl(): Promise<string> {
  if (_callbackUrl) return _callbackUrl;
  const gate = deliveryConfigGate();
  if (gate) throw new Error(gate);
  const workflow = process.env.LOOM_SUBSCRIPTION_LOGIC_APP_NAME!;
  const sub_ = process.env.LOOM_SUBSCRIPTION_ID!;
  const rg = (process.env.LOOM_SUBSCRIPTION_LOGIC_APP_RG || process.env.LOOM_DLZ_RG)!;
  const trigger = process.env.LOOM_SUBSCRIPTION_LOGIC_APP_TRIGGER || 'manual';
  const arm = (process.env.LOOM_ARM_ENDPOINT || 'https://management.azure.com').replace(/\/$/, '');
  const armToken = await tokenFor(arm);
  const cbUrl = `${arm}/subscriptions/${sub_}/resourceGroups/${encodeURIComponent(rg)}`
    + `/providers/Microsoft.Logic/workflows/${encodeURIComponent(workflow)}`
    + `/triggers/${encodeURIComponent(trigger)}/listCallbackUrl?api-version=${process.env.LOOM_LOGIC_API_VERSION || '2016-06-01'}`;
  const cbRes = await fetch(cbUrl, { method: 'POST', headers: { authorization: `Bearer ${armToken}` } });
  if (!cbRes.ok) throw new Error(`listCallbackUrl ${cbRes.status}: ${(await cbRes.text()).slice(0, 200)}`);
  const invokeUrl = (await cbRes.json())?.value;
  if (!invokeUrl) throw new Error('Logic App callback URL missing from listCallbackUrl response');
  _callbackUrl = invokeUrl as string;
  return _callbackUrl;
}

/** Test seam: drop the cached callback URL. */
export function _resetDeliveryUrlCache(): void { _callbackUrl = null; }

/**
 * The Logic App body shape lives in the pure `delivery-payload` module so it can
 * be asserted against the bicep trigger schema without the Azure SDK in the
 * test graph. Re-exported here so callers have one import site.
 */
export { deliveryPayload, FORMAT_MIME, type DeliveryMessage };

/**
 * POST a message to the delivery Logic App. A report subscription supplies the
 * rendered file (base64 attachment); a B-N19d insight digest supplies
 * `bodyHtml` with no attachment. Both go through the SAME workflow and the SAME
 * O365 connection — the workflow picks the shape from what is present.
 */
export async function deliverEmail(msg: DeliveryMessage): Promise<void> {
  const triggerUrl = await resolveDeliveryUrl();
  const res = await fetch(triggerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(deliveryPayload(msg)),
  });
  if (!res.ok && res.status !== 202) {
    const t = await res.text().catch(() => '');
    throw new Error(`Logic App delivery failed (${res.status}): ${t.slice(0, 200) || res.statusText}`);
  }
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

/**
 * Deliver a rendered report as an email attachment through the delivery Logic
 * App. Thin wrapper over `deliverEmail` so the subscription path and the
 * B-N19d digest path share ONE payload builder and ONE callback resolution.
 */
export async function deliverViaLogicApp(sub: ReportSubscription, base64: string): Promise<void> {
  await deliverEmail({
    recipients: sub.recipients,
    subject: sub.subject || `Scheduled report: ${sub.reportId}`,
    reportName: sub.reportId,
    attachmentName: `${sub.reportId}.${sub.format.toLowerCase()}`,
    attachmentContentType: FORMAT_MIME[sub.format] || 'application/octet-stream',
    attachmentBase64: base64,
  });
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
