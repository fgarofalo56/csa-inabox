/**
 * App Service deployment-slots client — the Azure-native execution backend for
 * release-environment "Promote / Swap". Drives real Microsoft.Web/sites slot
 * operations via ARM REST so a Loom release environment that targets an App
 * Service can swap staging↔production (blue-green) and roll back by re-swapping.
 *
 * Backend: ARM REST (api-version 2023-12-01)
 *   GET  .../Microsoft.Web/sites/{site}/slots                       (list slots)
 *   POST .../sites/{site}[/slots/{slot}]/slotsswap                  (swap / complete)
 *   POST .../sites/{site}[/slots/{slot}]/applySlotConfig            (swap-with-preview phase 1)
 *   POST .../sites/{site}[/slots/{slot}]/resetSlotConfig            (cancel preview)
 * Docs: https://learn.microsoft.com/azure/app-service/deploy-staging-slots
 *       https://learn.microsoft.com/rest/api/appservice/web-apps/swap-slot
 *
 * Auth: ChainedTokenCredential(UAMI → DefaultAzureCredential) — identical to
 * every other Loom ARM client. The Console UAMI needs at least "Website
 * Contributor" on the target site to swap.
 *
 * Honest gate: when LOOM_SUBSCRIPTION_ID is unset this throws
 * AppServiceNotConfiguredError, which the BFF maps to a Fluent MessageBar
 * naming the exact env var. Azure-native — no Microsoft Fabric required.
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armBase, armScope } from './cloud-endpoints';

const ARM = armBase();
const ARM_SCOPE = armScope();
const WEB_API = '2023-12-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class AppServiceSlotsError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'AppServiceSlotsError';
    this.status = status;
    this.body = body;
  }
}

export class AppServiceNotConfiguredError extends Error {
  constructor(public missing: string[]) {
    super(`App Service slots not configured. Missing env: ${missing.join(', ')}`);
    this.name = 'AppServiceNotConfiguredError';
  }
}

/** Is the App Service backend even configured (drives the editor's honest gate)? */
export function appServiceConfigured(): boolean {
  return !!process.env.LOOM_SUBSCRIPTION_ID;
}

function subscription(): string {
  const sub = process.env.LOOM_SUBSCRIPTION_ID || '';
  if (!sub) throw new AppServiceNotConfiguredError(['LOOM_SUBSCRIPTION_ID']);
  return sub;
}

async function token(): Promise<string> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new AppServiceSlotsError('Failed to acquire ARM token', 401);
  return t.token;
}

async function armReq(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: any; operationLocation?: string }> {
  const tk = await token();
  const res = await fetchWithTimeout(`${ARM}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${tk}`,
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok && res.status !== 202) {
    const msg = (json?.error?.message || text || `ARM ${method} failed (${res.status})`).toString();
    throw new AppServiceSlotsError(msg, res.status, json || text);
  }
  return {
    status: res.status,
    json,
    operationLocation: res.headers.get('location') || res.headers.get('azure-asyncoperation') || undefined,
  };
}

export interface SiteRef {
  resourceGroup: string;
  /** App Service site (web app) name. */
  site: string;
}

export interface DeploymentSlot {
  name: string;
  state?: string;          // Running | Stopped
  defaultHostName?: string;
  lastModifiedTimeUtc?: string;
  kind?: string;
}

/** List the deployment slots of an App Service site (newest config first). */
export async function listSlots(ref: SiteRef): Promise<DeploymentSlot[]> {
  const sub = subscription();
  if (!ref.resourceGroup || !ref.site) throw new AppServiceSlotsError('resourceGroup and site are required', 400);
  const { json } = await armReq(
    'GET',
    `/subscriptions/${sub}/resourceGroups/${encodeURIComponent(ref.resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(ref.site)}/slots?api-version=${WEB_API}`,
  );
  const out: DeploymentSlot[] = [];
  for (const s of json?.value || []) {
    const p = s?.properties || {};
    // Slot resource names come back as "{site}/{slot}"; surface just the slot.
    const raw = String(s?.name || '');
    out.push({
      name: raw.includes('/') ? raw.split('/').pop()! : raw,
      state: p?.state,
      defaultHostName: p?.defaultHostName,
      lastModifiedTimeUtc: p?.lastModifiedTimeUtc,
      kind: s?.kind,
    });
  }
  return out;
}

/**
 * Slot swap actions:
 *  - `swap`     full swap of `sourceSlot` (or production) ↔ `targetSlot`
 *  - `apply`    swap-with-preview phase 1: apply targetSlot config to the source
 *  - `complete` swap-with-preview phase 2: finish the swap after validation
 *  - `cancel`   reset the preview (resetSlotConfig)
 * `cancel` re-running a prior swap (source↔target) is the rollback path.
 */
export type SwapAction = 'swap' | 'apply' | 'complete' | 'cancel';

export interface SwapInput extends SiteRef {
  /** Slot whose config is being swapped/applied. Omit (or "production") for the production slot. */
  sourceSlot?: string;
  /** The other slot in the swap (the one whose live config moves). */
  targetSlot: string;
  preserveVnet?: boolean;
  action?: SwapAction;
}

export interface SwapResult {
  ok: true;
  status: number;
  action: SwapAction;
  operationLocation?: string;
}

export async function swapSlots(input: SwapInput): Promise<SwapResult> {
  const sub = subscription();
  if (!input.resourceGroup || !input.site || !input.targetSlot) {
    throw new AppServiceSlotsError('resourceGroup, site and targetSlot are required', 400);
  }
  const action: SwapAction = input.action || 'swap';
  const base = `/subscriptions/${sub}/resourceGroups/${encodeURIComponent(input.resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(input.site)}`;
  const onProd = !input.sourceSlot || input.sourceSlot.toLowerCase() === 'production';
  const scopePath = onProd ? base : `${base}/slots/${encodeURIComponent(input.sourceSlot!)}`;
  const verb = action === 'apply' ? 'applySlotConfig' : action === 'cancel' ? 'resetSlotConfig' : 'slotsswap';
  const path = `${scopePath}/${verb}?api-version=${WEB_API}`;
  const body = action === 'cancel'
    ? undefined
    : { targetSlot: input.targetSlot, preserveVnet: input.preserveVnet ?? true };
  const { status, operationLocation } = await armReq('POST', path, body);
  return { ok: true, status, action, operationLocation };
}
