/**
 * Secret & credential health (S1) — LIVE inventory of every tracked standing
 * credential with days-to-expiry.
 *
 * Server-only. Reads the REAL backends under the Console UAMI:
 *   - Microsoft Graph GET /applications(appId='{LOOM_MSAL_CLIENT_ID}')
 *     → passwordCredentials[].endDateTime (the 2-year MSAL secret clock;
 *     Application.Read.All is already granted to the Console UAMI in
 *     post-deploy bootstrap — see lib/azure/graph-identity-client.ts),
 *   - Key Vault GET {vault}/secrets/{name} → attributes.exp / attributes.updated
 *     for the tracked secrets (loom-msal-client-secret, synthetic-login-secret).
 *
 * Threshold math + band semantics MIRROR the scheduled alerting core in
 * azure-functions/secret-expiry-monitor/src/expiry-core.ts (unit-tested there);
 * keep the two in sync when changing bands. The Function alerts on a cron via
 * the shared action group; this module powers the on-demand admin surface —
 * neither depends on the other (no-vaporware: both are real reads).
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { kvScope } from '@/lib/azure/cloud-endpoints';
import { vaultUrl } from '@/lib/azure/kv-secrets-client';

export type SecretBand = 'expired' | 'critical' | 'warn30' | 'warn60' | 'ok' | 'no-expiry';

export const SECRET_BAND_SEVERITY: Record<SecretBand, number> = {
  'no-expiry': 0, ok: 0, warn60: 1, warn30: 2, critical: 3, expired: 4,
};

export interface SecretHealthItem {
  id: string;
  source: 'entra-app' | 'key-vault';
  label: string;
  expiresAt: string | null;
  daysToExpiry: number | null;
  band: SecretBand;
  detail?: string;
  drift?: boolean;
}

export interface SecretHealthReport {
  generatedAt: string;
  warnDays: number;
  items: SecretHealthItem[];
  /** Honest gates — populated with the exact remediation when a source could
   * not be read (missing env / missing Graph app-role). */
  gates: { graph?: string; keyVault?: string };
}

const DAY_MS = 86_400_000;
const TRACKED_KV_SECRETS = ['loom-msal-client-secret', 'synthetic-login-secret'];
const DRIFT_SLACK_MS = 15 * 60_000;

export function secretDaysToExpiry(nowMs: number, endIso: string | null | undefined): number | null {
  if (!endIso) return null;
  const end = Date.parse(endIso);
  if (Number.isNaN(end)) return null;
  return Math.floor((end - nowMs) / DAY_MS);
}

export function secretBandFor(days: number | null, warnDays = 60): SecretBand {
  if (days === null) return 'no-expiry';
  if (days < 0) return 'expired';
  if (days <= 7) return 'critical';
  if (days <= 30) return 'warn30';
  if (days <= Math.max(warnDays, 30)) return 'warn60';
  return 'ok';
}

export function secretWarnDays(): number {
  const n = Number(process.env.LOOM_SECRET_EXPIRY_WARN_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60;
}

// ── credential (same UAMI→DefaultAzureCredential chain as every Loom client) ──
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: TokenCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

async function tokenFor(scope: string): Promise<string> {
  const t = await credential.getToken(scope);
  if (!t?.token) throw new Error(`failed to acquire token for ${scope}`);
  return t.token;
}

// ── live inventory ───────────────────────────────────────────────────────────

/** Build the live secret-health report (Graph + Key Vault reads, no cache). */
export async function getSecretHealthReport(): Promise<SecretHealthReport> {
  const nowMs = Date.now();
  const warnDays = secretWarnDays();
  const items: SecretHealthItem[] = [];
  const gates: SecretHealthReport['gates'] = {};

  // 1. Graph — the MSAL app's password credentials.
  const msalClientId = (process.env.LOOM_MSAL_CLIENT_ID || '').trim();
  let newestCredStart = 0;
  if (!msalClientId) {
    gates.graph = 'LOOM_MSAL_CLIENT_ID is not set — the MSAL app-registration credential inventory is unavailable. It is wired automatically by modules/admin-plane/main.bicep (entra-app-registration.bicep).';
  } else {
    try {
      const graphBase = (process.env.LOOM_GRAPH_BASE || 'https://graph.microsoft.com').replace(/\/+$/, '');
      const token = await tokenFor(`${graphBase}/.default`);
      const res = await fetchWithTimeout(
        `${graphBase}/v1.0/applications(appId='${encodeURIComponent(msalClientId)}')?$select=displayName,passwordCredentials`,
        { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, cache: 'no-store' },
      );
      if (!res.ok) {
        gates.graph = res.status === 403
          ? 'Microsoft Graph returned 403 — grant the Console UAMI the Application.Read.All app role (post-deploy bootstrap; see docs/fiab/runbooks/secret-rotation.md).'
          : `Microsoft Graph application read failed (${res.status}).`;
      } else {
        const j: any = await res.json();
        const displayName = String(j?.displayName || 'MSAL app');
        for (const c of j?.passwordCredentials || []) {
          const start = c?.startDateTime ? Date.parse(c.startDateTime) : NaN;
          if (!Number.isNaN(start) && start > newestCredStart) newestCredStart = start;
          const days = secretDaysToExpiry(nowMs, c?.endDateTime ?? null);
          items.push({
            id: `entra-app:${c?.keyId || ''}`,
            source: 'entra-app',
            label: `${displayName} — client secret ${c?.displayName || String(c?.keyId || '').slice(0, 8)}`,
            expiresAt: c?.endDateTime ?? null,
            daysToExpiry: days,
            band: secretBandFor(days, warnDays),
          });
        }
        if (!(j?.passwordCredentials || []).length) {
          items.push({
            id: 'entra-app:none',
            source: 'entra-app',
            label: `${displayName} — no client secrets`,
            expiresAt: null, daysToExpiry: null, band: 'no-expiry',
            detail: 'The app registration has zero password credentials (federated credential / S2 end state, or not yet provisioned).',
          });
        }
      }
    } catch (e: any) {
      gates.graph = `Microsoft Graph read failed: ${e?.message || String(e)}`;
    }
  }

  // 2. Key Vault — tracked secret attributes.
  const base = vaultUrl();
  if (!base) {
    gates.keyVault = 'No Key Vault configured — set LOOM_KEY_VAULT_URI (or LOOM_KEY_VAULT_NAME); it is wired automatically by modules/admin-plane/main.bicep.';
  } else {
    try {
      const token = await tokenFor(kvScope());
      for (const name of TRACKED_KV_SECRETS) {
        try {
          const res = await fetchWithTimeout(`${base}/secrets/${encodeURIComponent(name)}?api-version=7.4`, {
            headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, cache: 'no-store',
          });
          if (res.status === 404) {
            items.push({
              id: `kv:${name}`, source: 'key-vault', label: `Key Vault secret ${name}`,
              expiresAt: null, daysToExpiry: null, band: 'no-expiry',
              detail: 'Not found in the vault — the tracked secret has not been provisioned yet.',
            });
            continue;
          }
          if (!res.ok) {
            items.push({
              id: `kv:${name}`, source: 'key-vault', label: `Key Vault secret ${name}`,
              expiresAt: null, daysToExpiry: null, band: 'no-expiry',
              detail: `Vault read failed (${res.status})${res.status === 403 ? ' — grant the Console UAMI "Key Vault Secrets Officer" on the vault' : ''}.`,
            });
            continue;
          }
          const j: any = await res.json();
          const exp = typeof j?.attributes?.exp === 'number' ? j.attributes.exp : null;
          const updated = typeof j?.attributes?.updated === 'number' ? j.attributes.updated : null;
          const expiresAt = exp ? new Date(exp * 1000).toISOString() : null;
          const days = secretDaysToExpiry(nowMs, expiresAt);
          const drift =
            name === 'loom-msal-client-secret' &&
            newestCredStart > 0 &&
            updated !== null &&
            newestCredStart - updated * 1000 > DRIFT_SLACK_MS;
          items.push({
            id: `kv:${name}`,
            source: 'key-vault',
            label: `Key Vault secret ${name}`,
            expiresAt,
            daysToExpiry: days,
            band: drift ? 'critical' : secretBandFor(days, warnDays),
            drift: drift || undefined,
            detail: drift
              ? 'DRIFT: the app registration has a newer client secret than this vault copy — the running app may hold a stale secret (the 2026-07-19 outage mode). Run the rotation runbook.'
              : days === null
                ? (updated !== null
                    ? `No expiry attribute set (last updated ${new Date(updated * 1000).toISOString().slice(0, 10)}).`
                    : 'No expiry attribute set.')
                : undefined,
          });
        } catch (e: any) {
          items.push({
            id: `kv:${name}`, source: 'key-vault', label: `Key Vault secret ${name}`,
            expiresAt: null, daysToExpiry: null, band: 'no-expiry',
            detail: `Vault read failed: ${e?.message || String(e)}`,
          });
        }
      }
    } catch (e: any) {
      gates.keyVault = `Key Vault token acquisition failed: ${e?.message || String(e)}`;
    }
  }

  items.sort((a, b) => {
    const sev = SECRET_BAND_SEVERITY[b.band] - SECRET_BAND_SEVERITY[a.band];
    if (sev !== 0) return sev;
    const ad = a.daysToExpiry ?? Number.MAX_SAFE_INTEGER;
    const bd = b.daysToExpiry ?? Number.MAX_SAFE_INTEGER;
    return ad - bd;
  });

  return { generatedAt: new Date(nowMs).toISOString(), warnDays, items, gates };
}
