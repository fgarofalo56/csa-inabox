/**
 * Shared Azure Static Web Apps publish path for the Loom app-builder items
 * (slate-app + workshop-app). Extracted verbatim from the two identical
 * `/api/items/<type>/[id]/publish` routes so the real provisioning sequence
 * lives in ONE place:
 *
 *   1. idempotent ARM PUT of a Microsoft.Web/staticSites resource (Free SKU,
 *      standalone — no repo link);
 *   2. poll for the default hostname (SWA populates it shortly after create);
 *   3. retrieve the SWA deployment token via the ARM `listSecrets` action — the
 *      exact credential the SWA CLI / GitHub Action uses to push the generated
 *      bundle. The raw token is never persisted or returned to the browser.
 *
 * Plus the shared honest infra-gate (`swaConfig` → 503 naming
 * LOOM_SWA_SUBSCRIPTION_ID / LOOM_SWA_RESOURCE_GROUP) and the shared 403 / 502
 * ARM error mapping. 100% Azure-native (ARM staticSites) — no Microsoft Fabric.
 */

import crypto from 'node:crypto';
import { armGet, armPut, armPost } from '@/lib/azure/arm-client';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';

export const SWA_API = '2024-04-01';

/** Resource-name slug (per-item `fallback`, e.g. 'slate' / 'workshop'). */
export function slug(v: string, fallback: string): string {
  return (v || fallback).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || fallback;
}

/** Honest gate — SWA needs a subscription + resource group + location. */
export function swaConfig(): { sub: string; rg: string; location: string } | { missing: string[] } {
  const sub = (process.env.LOOM_SWA_SUBSCRIPTION_ID || process.env.LOOM_SUBSCRIPTION_ID || '').trim();
  const rg = (process.env.LOOM_SWA_RESOURCE_GROUP || process.env.LOOM_SWA_RG || '').trim();
  const location = (process.env.LOOM_SWA_LOCATION || process.env.LOOM_LOCATION || 'eastus2').trim();
  const missing: string[] = [];
  if (!sub) missing.push('LOOM_SWA_SUBSCRIPTION_ID');
  if (!rg) missing.push('LOOM_SWA_RESOURCE_GROUP');
  if (missing.length) return { missing };
  return { sub, rg, location };
}

/** Structured error payload both publish routes feed into their `err()` helper. */
export interface SwaPublishError {
  error: string;
  status: number;
  code: string;
  gate?: { reason: string; remediation: string };
}

/** The shared 503 honest infra-gate body returned when `swaConfig()` is unset. */
export function swaNotConfiguredError(missing: string[]): SwaPublishError {
  return {
    error: `Azure Static Web Apps not configured: set ${missing.join(' + ')}.`,
    status: 503,
    code: 'swa_not_configured',
    gate: {
      reason: 'Publish provisions a real Azure Static Web App (Microsoft.Web/staticSites) and retrieves its deployment token.',
      remediation: `Set ${missing.join(' + ')} (and optionally LOOM_SWA_LOCATION) on the Console, and grant the Console UAMI "Website Contributor" on the resource group. No Microsoft Fabric required.`,
    },
  };
}

/** The shared 403 (UAMI rights) / 502 (everything else) ARM error mapping. */
export function mapSwaPublishError(e: unknown): SwaPublishError {
  const msg = e instanceof Error ? e.message : String(e);
  if (/403|forbidden|authoriz/i.test(msg)) {
    return {
      error: `ARM authorization failed creating the Static Web App: ${msg.slice(0, 300)}`,
      status: 403,
      code: 'swa_forbidden',
      gate: { reason: 'The Console UAMI needs rights on the SWA resource group.', remediation: 'Grant the Console UAMI "Website Contributor" (or Contributor) on LOOM_SWA_RESOURCE_GROUP.' },
    };
  }
  return { error: `Static Web App publish failed: ${msg.slice(0, 400)}`, status: 502, code: 'publish_failed' };
}

export interface PublishStaticSiteResult {
  url: string;
  hostname: string;
  staticSiteName: string;
  tokenRetrieved: boolean;
}

/**
 * The real ARM provisioning sequence (create + hostname poll + deployment
 * token). Throws on ARM failure — callers map with {@link mapSwaPublishError}.
 */
export async function publishStaticSite(opts: {
  sub: string;
  rg: string;
  /** Stable per-item resource name so re-publishing updates the same SWA. */
  name: string;
  location: string;
}): Promise<PublishStaticSiteResult> {
  const armBase = `/subscriptions/${opts.sub}/resourceGroups/${opts.rg}/providers/Microsoft.Web/staticSites/${encodeURIComponent(opts.name)}`;

  // 1) Create / update the Static Web App (Free SKU, standalone — no repo link).
  await armPut(`${armBase}?api-version=${SWA_API}`, {
    location: opts.location,
    sku: { name: 'Free', tier: 'Free' },
    properties: { allowConfigFileUpdates: true, stagingEnvironmentPolicy: 'Enabled', publicNetworkAccess: 'Enabled' },
  });

  // 2) Poll for the default hostname (SWA populates it shortly after create).
  let hostname = '';
  for (let i = 0; i < 6 && !hostname; i++) {
    const got = await armGet<{ properties?: { defaultHostname?: string } }>(`${armBase}?api-version=${SWA_API}`);
    hostname = String(got?.properties?.defaultHostname || '').trim();
    if (!hostname) await new Promise((r) => setTimeout(r, 1500));
  }
  const url = hostname ? `https://${hostname}` : '';

  // 3) Retrieve the deployment token (the credential to push the bundle). Proves
  //    the SWA is publishable; the token is NOT persisted or returned.
  let tokenRetrieved = false;
  try {
    const secrets = await armPost<{ properties?: { apiKey?: string } }>(`${armBase}/listSecrets?api-version=${SWA_API}`, {});
    tokenRetrieved = !!secrets?.properties?.apiKey;
  } catch { /* token retrieval is best-effort; resource is still live */ }

  return { url, hostname, staticSiteName: opts.name, tokenRetrieved };
}

// ── real content deployment (the half that makes the URL actually serve the app) ──

function bundleHmacKey(): Buffer {
  const secret = (process.env.SESSION_SECRET || '').trim();
  if (!secret) throw new Error('SESSION_SECRET is not configured');
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf-8'), Buffer.alloc(32), Buffer.from('loom-swa-bundle-v1'), 32));
}

/**
 * Sign a short-lived anonymous bundle-download token. The SWA zipdeploy
 * service fetches `appZipUrl` unauthenticated, so the download route is
 * public-but-signed: HMAC over `${itemType}:${itemId}:${exp}` — nothing
 * beyond the referenced item's generated bundle is reachable with it.
 */
export function signSwaBundleToken(itemType: string, itemId: string, ttlSecs = 1800): { exp: number; sig: string } {
  const exp = Math.floor(Date.now() / 1000) + ttlSecs;
  const sig = crypto.createHmac('sha256', bundleHmacKey()).update(`${itemType}:${itemId}:${exp}`).digest('base64url');
  return { exp, sig };
}

export function verifySwaBundleToken(itemType: string, itemId: string, exp: number, sig: string): boolean {
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expect = crypto.createHmac('sha256', bundleHmacKey()).update(`${itemType}:${itemId}:${exp}`).digest();
  const got = Buffer.from(String(sig || ''), 'base64url');
  return got.length === expect.length && crypto.timingSafeEqual(got, expect);
}

/**
 * Published-app READ token (Power-BI publish-to-web semantics): embedded in
 * the deployed bundle so anyone with the app URL can view its data — reads
 * ONLY (list/aggregate/distinct); writes stay session-gated. Scoped to one
 * item and revocable by bumping the item's `pubTokenVersion` state field
 * (re-publish rotates; unpublish invalidates).
 */
export function signAppReadToken(itemId: string, tokenVersion: number): string {
  const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from((process.env.SESSION_SECRET || '').trim(), 'utf-8'), Buffer.alloc(32), Buffer.from('loom-swa-app-read-v1'), 32));
  return crypto.createHmac('sha256', key).update(`pub-read:${itemId}:${tokenVersion}`).digest('base64url');
}

export function verifyAppReadToken(itemId: string, tokenVersion: number, token: string): boolean {
  const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from((process.env.SESSION_SECRET || '').trim(), 'utf-8'), Buffer.alloc(32), Buffer.from('loom-swa-app-read-v1'), 32));
  const expect = crypto.createHmac('sha256', key).update(`pub-read:${itemId}:${tokenVersion}`).digest();
  const got = Buffer.from(String(token || ''), 'base64url');
  return got.length === expect.length && crypto.timingSafeEqual(got, expect);
}

/**
 * Deploy zipped content to the Static Web App via the ARM
 * `StaticSites_CreateZipDeploymentForStaticSite` action. `appZipUrl` must be
 * fetchable by the SWA service (we hand it the signed public bundle route on
 * this console — the estate storage accounts are PE-locked, so a SAS blob
 * would be unreachable from SWA's fetcher).
 */
export async function deployZipToStaticSite(opts: {
  sub: string; rg: string; name: string; appZipUrl: string; title: string;
}): Promise<void> {
  const armBase = `/subscriptions/${opts.sub}/resourceGroups/${opts.rg}/providers/Microsoft.Web/staticSites/${encodeURIComponent(opts.name)}`;
  await armPost(`${armBase}/zipdeploy?api-version=${SWA_API}`, {
    properties: { appZipUrl: opts.appZipUrl, deploymentTitle: opts.title, provider: 'LoomConsole' },
  });
}

/**
 * Poll the published site until it serves the Loom bundle instead of the SWA
 * placeholder. Returns true once live within the budget; false = still
 * propagating (callers surface an honest "deploying" status, never a fake
 * success).
 */
export async function waitForContentLive(url: string, marker: string, budgetMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchWithTimeout(url, { cache: 'no-store' }, 10_000);
      const text = await res.text();
      if (res.ok && text.includes(marker)) return true;
    } catch { /* transient — keep polling */ }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}
