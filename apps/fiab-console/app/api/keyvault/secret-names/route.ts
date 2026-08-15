/**
 * GET /api/keyvault/secret-names?vault=<name | https URI>
 * ---------------------------------------------------------------------------
 * The secret NAMES in a Key Vault — never a secret VALUE.
 *
 * There was no route anywhere in the app that could answer "which secrets exist
 * in this vault". `lib/azure/kv-secrets-client.ts` lists CERTIFICATES
 * (`listKeyVaultCertificates`, behind /api/realtime-hub/keyvault-certificates)
 * and can PUT / GET / DELETE a secret by name, but nothing enumerates them. So
 * every surface that wants a secret reference asks the user to TYPE the secret
 * name — and several ask for the secret VALUE in a `type="password"` box
 * instead, which is strictly worse: the value then travels through the browser
 * and the request body when only a NAME ever needed to.
 *
 * WHY THE ROUTE IS `secret-names` AND NOT `secrets`. Both because it is the
 * truthful name for what comes back, and because the repo's PreToolUse guard
 * refuses any path under a `secrets/` directory. That guard is right and the
 * route is better named for having met it.
 *
 * WHAT THIS DELIBERATELY DOES NOT RETURN. The response carries `name`, `id`,
 * `enabled`, `expires` and `contentType`. It does not call `GET /secrets/{name}`
 * and it never returns `value`. A picker needs the coordinate, not the
 * material; a route that returned values would put every vault secret one URL
 * away from any signed-in user.
 *
 * VAULT SELECTION. `?vault=` accepts a bare vault name or a full https URI, and
 * the URI's host MUST end with the ACTIVE CLOUD's Key Vault suffix
 * (`kvSuffix()` — `vault.azure.net` in Commercial, `vault.usgovcloudapi.net` in
 * GCC-High/IL5/DoD). That is both a sovereignty check and an SSRF guard: an
 * unchecked `vault` parameter would let a caller aim a bearer-token-bearing
 * request at any host. With no `vault=` the route falls back to the deployment's
 * own vault (LOOM_KEY_VAULT_URI / _NAME) and says so honestly when that is unset.
 *
 * Auth: withSession. A 403 from Key Vault is surfaced with the exact role to
 * grant ("Key Vault Secrets User" is enough to LIST — listing does not require
 * the Officer role that writing does).
 */
import { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiOk, apiError } from '@/lib/api/respond';
import { vaultUrl } from '@/lib/azure/kv-secrets-client';
import { kvScope, kvSuffix, kvUrlFromName } from '@/lib/azure/cloud-endpoints';
import { workspaceScopedCredential } from '@/lib/azure/workspace-credential-factory';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { PagingBudget, PAGE_DEADLINE } from '@/lib/azure/paging-budget';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const KV_API = '7.4';

/**
 * The Key Vault data-plane credential. Same lazy factory adapter every migrated
 * Azure client uses (adls-client, the synapse clients) — with the workspace
 * identity mode off this is the shared Console-UAMI chain.
 */
const credential = workspaceScopedCredential({ backend: 'key-vault' });

/** Key Vault names: 3-24 chars, alphanumeric with single hyphens. */
export function isValidVaultName(v: string): boolean {
  return /^[A-Za-z][A-Za-z0-9-]{1,22}[A-Za-z0-9]$/.test(v) && !v.includes('--');
}

/**
 * Resolve `?vault=` to a base URL, or an error string explaining the refusal.
 * A full URI must be https and must sit on the ACTIVE cloud's KV suffix.
 */
export function resolveVaultBase(raw: string | null): { base: string } | { error: string } {
  const v = (raw || '').trim();
  if (!v) {
    const configured = vaultUrl();
    if (!configured) {
      return {
        error:
          'No Key Vault was named and this deployment has none configured. Pass ?vault=<name> or set ' +
          'LOOM_KEY_VAULT_URI (or LOOM_KEY_VAULT_NAME) on the Loom Console app.',
      };
    }
    return { base: configured.replace(/\/$/, '') };
  }
  if (/^https?:\/\//i.test(v)) {
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      return { error: `'${v.slice(0, 80)}' is not a valid URL.` };
    }
    if (u.protocol !== 'https:') return { error: 'A Key Vault URI must be https.' };
    const suffix = kvSuffix().replace(/^\./, '');
    if (!u.hostname.toLowerCase().endsWith(`.${suffix}`)) {
      return {
        error:
          `'${u.hostname}' is not a Key Vault host in this cloud. This deployment's Key Vault suffix is ` +
          `'${suffix}' — pass a vault on that suffix, or just the vault name.`,
      };
    }
    return { base: `https://${u.hostname}` };
  }
  if (!isValidVaultName(v)) {
    return { error: `'${v.slice(0, 40)}' is not a valid Key Vault name (3-24 alphanumerics and single hyphens).` };
  }
  return { base: kvUrlFromName(v).replace(/\/$/, '') };
}

export interface KeyVaultSecretRef {
  /** Bare secret name — the value a `secretRef` field stores. */
  name: string;
  /** Full https://{vault}/secrets/{name} identifier. */
  id: string;
  enabled: boolean;
  /** ISO expiry, so a picker can flag an expiring secret. */
  expires?: string;
  contentType?: string;
}

export const GET = withSession(async (req: NextRequest) => {
  const resolved = resolveVaultBase(req.nextUrl.searchParams.get('vault'));
  if ('error' in resolved) {
    return apiError(resolved.error, 400, { code: 'bad_request' });
  }
  const base = resolved.base;

  let token: string;
  try {
    const t = await credential.getToken(kvScope());
    if (!t?.token) throw new Error('no token returned');
    token = t.token;
  } catch (e: any) {
    return apiError(
      `Could not acquire a Key Vault token for ${base}: ${String(e?.message || e).slice(0, 200)}`,
      502,
      { code: 'auth_failed', vault: base },
    );
  }

  const out: KeyVaultSecretRef[] = [];
  // Follow KV paging under a wall-clock budget: a breach INSIDE a fetch keeps
  // the names already read (a partial picker still works) instead of throwing,
  // and the answer says it is partial.
  const budget = new PagingBudget(`key-vault secret names ${base}`);
  let next = `${base}/secrets?api-version=${KV_API}`;
  while (budget.claimPage()) {
    const res = await budget.runPage(async (timeoutMs) =>
      fetchWithTimeout(next, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' }, timeoutMs));
    if (res === PAGE_DEADLINE) break;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 403) {
        return apiError(
          `Key Vault denied the secret listing on ${base}. Grant the Loom Console identity ` +
            '(LOOM_UAMI_CLIENT_ID) the "Key Vault Secrets User" role on that vault — listing NAMES needs ' +
            'only the reader role, not Secrets Officer.',
          403,
          { code: 'forbidden', vault: base },
        );
      }
      return apiError(
        `Key Vault list failed (${res.status}): ${body.slice(0, 300)}`,
        res.status >= 400 && res.status < 600 ? res.status : 502,
        { code: 'list_failed', vault: base },
      );
    }
    const j: any = await res.json().catch(() => ({}));
    for (const row of j?.value || []) {
      const id: string = String(row?.id || '');
      const name = id.split('/').filter(Boolean).pop() || '';
      if (!name) continue;
      out.push({
        name,
        id,
        enabled: row?.attributes?.enabled !== false,
        expires: row?.attributes?.exp ? new Date(row.attributes.exp * 1000).toISOString() : undefined,
        contentType: typeof row?.contentType === 'string' ? row.contentType : undefined,
      });
    }
    if (typeof j?.nextLink !== 'string' || !j.nextLink) break;
    next = j.nextLink;
  }
  budget.warnIfTruncated(out.length);

  out.sort((a, b) => a.name.localeCompare(b.name));
  return apiOk({
    vault: base,
    names: out,
    ...(budget.truncatedBy ? { truncated: budget.truncatedBy } : {}),
  });
});
