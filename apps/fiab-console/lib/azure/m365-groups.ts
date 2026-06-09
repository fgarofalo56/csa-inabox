/**
 * Microsoft 365 unified-group client — the Azure-native backend behind the
 * workspace settings "Teams and SharePoint" / M365 tab. Links a Loom workspace
 * to a real Microsoft 365 (Entra) unified group and surfaces that group's
 * SharePoint site URL, one-for-one with the Fabric workspace "Teams and
 * SharePoint" setting (a Fabric workspace is backed by an M365 group whose
 * SharePoint document library hosts files).
 *
 * This is a Microsoft Graph / Entra ID surface — NOT a Fabric / Power BI API —
 * so it is permitted on the default code path (see no-fabric-dependency.md).
 * The workspace itself functions fully without an M365 group bound; linking one
 * is strictly additive collaboration metadata.
 *
 * Auth: Console UAMI (LOOM_UAMI_CLIENT_ID) app-only Graph token, sovereign-cloud
 * correct via cloud-endpoints (graphBase / graphScope → graph.microsoft.com,
 * graph.microsoft.us, dod-graph.microsoft.us).
 *
 * Permissions:
 *   - searchM365Groups / getM365Group  → Group.Read.All (already granted at bootstrap)
 *   - createM365Group                  → Group.Create or Group.ReadWrite.All
 *     (a NEW UAMI Graph grant — gated behind LOOM_WORKSPACE_M365_LINK so existing
 *      deployments don't get a surprise consent prompt; see identity-graph-rbac.bicep)
 *   - getGroupSiteUrl                  → Sites.Read.All (best-effort; absence just
 *     leaves the SharePoint URL blank — never blocks linking)
 *
 * No mocks. Every call hits real Graph REST.
 */
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { graphBase, graphScope } from './cloud-endpoints';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

export class M365GroupError extends Error {
  status: number;
  remediation?: string;
  constructor(message: string, status: number, remediation?: string) {
    super(message);
    this.name = 'M365GroupError';
    this.status = status;
    this.remediation = remediation;
  }
}

/** True when workspace ↔ M365-group linking is enabled for this deployment. */
export function m365LinkEnabled(): boolean {
  return (process.env.LOOM_WORKSPACE_M365_LINK || '').trim().toLowerCase() === 'true';
}

export interface M365Group {
  id: string;
  displayName: string;
  mail?: string;
  description?: string;
  /** SharePoint site URL of the group's team site (resolved best-effort). */
  siteUrl?: string;
}

async function graphToken(): Promise<string> {
  let t;
  try {
    t = await credential.getToken(graphScope());
  } catch {
    throw new M365GroupError(
      'graph_token_failed', 503,
      'Console UAMI cannot acquire a Microsoft Graph token. Grant Group.ReadWrite.All (or Group.Create) to the UAMI and admin-consent it.',
    );
  }
  if (!t?.token) {
    throw new M365GroupError('graph_token_failed', 503, 'Console UAMI cannot acquire a Microsoft Graph token.');
  }
  return t.token;
}

function permHint(status: number): string | undefined {
  if (status === 401 || status === 403) {
    return 'The Console UAMI lacks the Graph permission for this operation. For group creation grant Group.Create (or Group.ReadWrite.All); for reads grant Group.Read.All. Run: az ad sp permission add --id <uami-objectid> --api 00000003-0000-0000-c000-000000000046 --api-permissions <appRoleId>=Role ; then admin-consent.';
  }
  return undefined;
}

async function graphFetch(path: string, init?: RequestInit): Promise<any> {
  const token = await graphToken();
  const url = path.startsWith('http') ? path : `${graphBase()}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = (json?.error?.message || text || `Graph ${res.status}`).toString();
    throw new M365GroupError(msg, res.status, permHint(res.status));
  }
  return json;
}

/** Slugify a workspace name into a valid Graph mailNickname (letters/digits/dashes). */
export function mailNicknameFor(name: string): string {
  const base = (name || 'loom-workspace')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56);
  return base || `loom-ws-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Resolve the SharePoint team-site web URL for a group's root site. Best-effort:
 * needs Sites.Read.All — when that's not granted (or the group has no
 * provisioned site yet) we swallow the error and return undefined so linking
 * still succeeds with a blank SharePoint URL.
 */
export async function getGroupSiteUrl(groupId: string): Promise<string | undefined> {
  try {
    const j = await graphFetch(`/groups/${encodeURIComponent(groupId)}/sites/root?$select=webUrl`);
    const url = j?.webUrl;
    return typeof url === 'string' && url ? url : undefined;
  } catch {
    return undefined;
  }
}

/** GET a single M365 group's display metadata + resolved SharePoint site URL. */
export async function getM365Group(groupId: string): Promise<M365Group> {
  const j = await graphFetch(`/groups/${encodeURIComponent(groupId)}?$select=id,displayName,mail,description`);
  const siteUrl = await getGroupSiteUrl(groupId);
  return { id: j.id, displayName: j.displayName, mail: j.mail, description: j.description, siteUrl };
}

/** Search M365 unified groups by displayName startswith (link-existing picker). */
export async function searchM365Groups(q: string): Promise<M365Group[]> {
  const term = (q || '').trim();
  if (!term) return [];
  const safe = encodeURIComponent(term.replace(/'/g, "''"));
  // Restrict to unified (Microsoft 365) groups — those are the SharePoint-backed
  // collaboration groups a Fabric/Loom workspace links to.
  const j = await graphFetch(
    `/groups?$filter=startswith(displayName,'${safe}') and groupTypes/any(c:c eq 'Unified')&$top=20&$select=id,displayName,mail,description`,
  );
  return ((j?.value || []) as any[]).map((g) => ({
    id: g.id, displayName: g.displayName, mail: g.mail, description: g.description,
  }));
}

/**
 * Create a new Microsoft 365 unified group to back a workspace. Returns the
 * created group with its SharePoint site URL resolved best-effort. The owner is
 * added so the creating admin can manage the group. Requires the UAMI to hold
 * Group.Create (or Group.ReadWrite.All) — gated behind LOOM_WORKSPACE_M365_LINK.
 */
export async function createM365Group(input: {
  displayName: string;
  description?: string;
  /** Object id of the user to set as group owner (the creating admin). */
  ownerObjectId?: string;
}): Promise<M365Group> {
  if (!m365LinkEnabled()) {
    throw new M365GroupError(
      'M365 group linking is disabled in this deployment.', 503,
      'Set LOOM_WORKSPACE_M365_LINK=true and grant the Console UAMI Group.Create (or Group.ReadWrite.All) Graph permission. See platform/fiab/bicep/modules/admin-plane/identity-graph-rbac.bicep.',
    );
  }
  const nickname = mailNicknameFor(input.displayName);
  const body: Record<string, unknown> = {
    displayName: input.displayName,
    description: input.description || `Microsoft 365 group for the ${input.displayName} Loom workspace`,
    mailEnabled: true,
    mailNickname: nickname,
    securityEnabled: false,
    groupTypes: ['Unified'],
  };
  if (input.ownerObjectId) {
    const host = graphBase().replace(/\/v1\.0\/?$/, '/v1.0');
    body['owners@odata.bind'] = [`${host}/directoryObjects/${input.ownerObjectId}`];
  }
  const created = await graphFetch('/groups', { method: 'POST', body: JSON.stringify(body) });
  // Site provisioning is async — resolve best-effort; blank URL is fine.
  const siteUrl = await getGroupSiteUrl(created.id);
  return { id: created.id, displayName: created.displayName, mail: created.mail, description: created.description, siteUrl };
}
