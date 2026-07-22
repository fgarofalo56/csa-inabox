/**
 * secret-expiry-monitor — REAL data-plane clients (Microsoft Graph app read,
 * Key Vault secret attributes, action-group createNotifications, blob state,
 * GitHub issue dedup). All Azure calls use the Function's managed identity via
 * DefaultAzureCredential — identity-based, no keys, no mocks (no-vaporware).
 *
 * Sovereign-cloud aware: the Graph base, ARM endpoint, and storage suffix are
 * injected via env (LOOM_GRAPH_BASE / LOOM_ARM_ENDPOINT / LOOM_STORAGE_SUFFIX)
 * by secret-expiry-monitor-function.bicep; the Key Vault scope derives from the
 * vault URI host so `.us` vaults acquire a Gov-scoped token.
 */
import { DefaultAzureCredential } from '@azure/identity';
import type { GraphPasswordCredential, KvSecretInfo } from './expiry-core';

const cred = new DefaultAzureCredential();

async function tokenFor(scope: string): Promise<string> {
  const t = await cred.getToken(scope);
  if (!t?.token) throw new Error(`failed to acquire token for ${scope}`);
  return t.token;
}

// ── Microsoft Graph: the MSAL app registration's password credentials ────────

export interface AppCredentialRead {
  displayName: string;
  passwordCredentials: GraphPasswordCredential[];
}

/** GET {graphBase}/v1.0/applications(appId='{clientId}') — requires the
 * Application.Read.All app role on the Function identity (one-time admin
 * consent; docs/fiab/runbooks/secret-rotation.md has the exact script). */
export async function readAppCredentials(graphBase: string, appClientId: string): Promise<AppCredentialRead> {
  const base = graphBase.replace(/\/+$/, '');
  const token = await tokenFor(`${base}/.default`);
  const url = `${base}/v1.0/applications(appId='${encodeURIComponent(appClientId)}')?$select=displayName,passwordCredentials`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  if (!res.ok) throw new Error(`Graph applications read ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j: any = await res.json();
  return {
    displayName: String(j?.displayName || ''),
    passwordCredentials: (j?.passwordCredentials || []).map((c: any) => ({
      keyId: String(c?.keyId || ''),
      displayName: c?.displayName ?? null,
      startDateTime: c?.startDateTime ?? null,
      endDateTime: c?.endDateTime ?? null,
    })),
  };
}

// ── Key Vault: tracked secret attributes (exp / updated) ─────────────────────

function kvScopeFromUri(vaultUri: string): string {
  // https://<name>.vault.azure.net → https://vault.azure.net/.default
  const host = new URL(vaultUri).hostname;
  return `https://${host.substring(host.indexOf('.') + 1)}/.default`;
}

/** GET {vault}/secrets/{name}?api-version=7.4 for each tracked secret —
 * needs only "Key Vault Secrets User" (granted in bicep). 404 → notFound;
 * other failures land in `error` so the inventory row is honest, not dropped. */
export async function readKvSecretAttributes(vaultUri: string, names: string[]): Promise<KvSecretInfo[]> {
  const base = vaultUri.replace(/\/+$/, '');
  const token = await tokenFor(kvScopeFromUri(base));
  const out: KvSecretInfo[] = [];
  for (const name of names) {
    try {
      const res = await fetch(`${base}/secrets/${encodeURIComponent(name)}?api-version=7.4`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      if (res.status === 404) { out.push({ name, notFound: true }); continue; }
      if (!res.ok) { out.push({ name, error: `${res.status} ${(await res.text()).slice(0, 120)}` }); continue; }
      const j: any = await res.json();
      out.push({
        name,
        exp: typeof j?.attributes?.exp === 'number' ? j.attributes.exp : null,
        updated: typeof j?.attributes?.updated === 'number' ? j.attributes.updated : null,
        enabled: j?.attributes?.enabled !== false,
      });
    } catch (e: any) {
      out.push({ name, error: e?.message || String(e) });
    }
  }
  return out;
}

// ── Azure Monitor: fire the shared action group (O1 alert convention) ────────

/** Fire the shared loom-default-alerts action group via the createNotifications
 * API, mirroring its live receivers — the same mechanism the Console's
 * sendActionGroupTestNotification uses (monitor-client.ts). Needs Monitoring
 * Contributor on the admin RG (granted in bicep). Structured so O1's unified
 * alert-dispatch module can absorb this call verbatim. */
export async function fireActionGroup(
  armEndpoint: string,
  actionGroupId: string,
  _subject: string,
): Promise<{ status: number }> {
  const m = /\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/[Mm]icrosoft\.[Ii]nsights\/actionGroups\/([^/?]+)/.exec(actionGroupId || '');
  if (!m) throw new Error('LOOM_ALERT_ACTION_GROUP_ID is not a valid action group ARM id');
  const [, sub, rg, name] = m;
  const arm = armEndpoint.replace(/\/+$/, '');
  const token = await tokenFor(`${arm}/.default`);
  const agRes = await fetch(
    `${arm}/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Insights/actionGroups/${name}?api-version=2023-01-01`,
    { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } },
  );
  if (!agRes.ok) throw new Error(`action group read ${agRes.status}: ${(await agRes.text()).slice(0, 200)}`);
  const p: any = (await agRes.json())?.properties || {};
  const res = await fetch(
    `${arm}/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Insights/actionGroups/${name}/createNotifications?api-version=2023-01-01`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        alertType: 'logalertv2',
        emailReceivers: p.emailReceivers || [],
        smsReceivers: p.smsReceivers || [],
        webhookReceivers: p.webhookReceivers || [],
        logicAppReceivers: p.logicAppReceivers || [],
        armRoleReceivers: p.armRoleReceivers || [],
      }),
    },
  );
  if (!res.ok && res.status !== 202) {
    throw new Error(`createNotifications ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return { status: res.status };
}

// ── Blob state: last-alerted band per credential (escalation dedup) ──────────

const BLOB_API = '2021-08-06';

function blobUrl(account: string, suffix: string, container: string, blob: string): string {
  return `https://${account}.blob.${suffix}/${container}/${blob}`;
}

export async function readStateBlob(account: string, suffix: string, container: string, blob: string): Promise<any> {
  const token = await tokenFor('https://storage.azure.com/.default');
  const res = await fetch(blobUrl(account, suffix, container, blob), {
    headers: { authorization: `Bearer ${token}`, 'x-ms-version': BLOB_API },
  });
  if (res.status === 404) return {};
  if (!res.ok) throw new Error(`state blob read ${res.status}`);
  try { return await res.json(); } catch { return {}; }
}

export async function writeStateBlob(account: string, suffix: string, container: string, blob: string, state: unknown): Promise<void> {
  const token = await tokenFor('https://storage.azure.com/.default');
  const res = await fetch(blobUrl(account, suffix, container, blob), {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'x-ms-version': BLOB_API,
      'x-ms-blob-type': 'BlockBlob',
      'content-type': 'application/json',
    },
    body: JSON.stringify(state),
  });
  if (!res.ok) throw new Error(`state blob write ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// ── GitHub: dedup issue per credential+band ──────────────────────────────────

const GH_API = 'https://api.github.com';
const GH_HEADERS = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'csa-loom-secret-expiry-monitor',
  'x-github-api-version': '2022-11-28',
});

/** Open (or comment on) the dedup issue for one escalated credential. The
 * TITLE is the dedup key: an open issue with the exact title gets a comment
 * instead of a duplicate. Honest no-op when no token is configured. */
export async function upsertGithubIssue(
  token: string,
  owner: string,
  repo: string,
  title: string,
  body: string,
): Promise<{ action: 'created' | 'commented'; number: number }> {
  const q = encodeURIComponent(`repo:${owner}/${repo} state:open in:title "${title}"`);
  const search = await fetch(`${GH_API}/search/issues?q=${q}`, { headers: GH_HEADERS(token) });
  if (!search.ok) throw new Error(`GitHub search ${search.status}`);
  const found: any = await search.json();
  const existing = (found?.items || []).find((i: any) => i?.title === title);
  if (existing) {
    const res = await fetch(`${GH_API}/repos/${owner}/${repo}/issues/${existing.number}/comments`, {
      method: 'POST',
      headers: { ...GH_HEADERS(token), 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`GitHub comment ${res.status}`);
    return { action: 'commented', number: existing.number };
  }
  const res = await fetch(`${GH_API}/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: { ...GH_HEADERS(token), 'content-type': 'application/json' },
    body: JSON.stringify({ title, body }),
  });
  if (!res.ok) throw new Error(`GitHub issue create ${res.status}`);
  const j: any = await res.json();
  return { action: 'created', number: j?.number || 0 };
}
