/**
 * Domain RBAC group provisioning — Microsoft Graph security-group client behind
 * the D2 domain-admin / domain-contributor tiers.
 *
 * Each Loom business domain is backed by TWO Entra SECURITY groups
 * (securityEnabled, NOT Unified/M365 — those are reserved for the workspace ↔
 * SharePoint linkage in m365-groups.ts; security groups match Fabric's
 * tenant-setting group restriction):
 *   • loom-domain-<id>-admins        → members are domain ADMINS
 *   • loom-domain-<id>-contributors  → members are domain CONTRIBUTORS
 *
 * The group object-ids are stored on the DomainItem as `adminGroupId` /
 * `contributorGroupId` and checked (cached) against the session `groups` claim
 * by lib/auth/domain-role.ts. Domains are RUNTIME Cosmos data, so the groups
 * can't be provisioned at deploy time — they are created on demand at
 * domain-create time through this client.
 *
 * This is a Microsoft Graph / Entra ID surface — NOT a Fabric / Power BI API —
 * so it is permitted on the default code path (see no-fabric-dependency.md).
 * Domains function fully WITHOUT backing groups (the legacy admins[] /
 * contributors model still applies); provisioning groups is strictly additive.
 *
 * Auth: Console UAMI (LOOM_UAMI_CLIENT_ID) app-only Graph token, sovereign-cloud
 * correct via cloud-endpoints (graphBase / graphScope → graph.microsoft.com,
 * graph.microsoft.us, dod-graph.microsoft.us).
 *
 * Permission: Group.ReadWrite.All (a NEW UAMI Graph grant — gated behind
 * LOOM_DOMAIN_GROUP_PROVISIONING so existing deployments don't get a surprise
 * consent prompt; see identity-graph-rbac.bicep). Until consented, group
 * creation returns 503 with structured remediation (honest gate, no-vaporware).
 *
 * No mocks. Every call hits real Graph REST.
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { graphBase, graphScope } from './cloud-endpoints';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

export class DomainGroupError extends Error {
  status: number;
  remediation?: string;
  constructor(message: string, status: number, remediation?: string) {
    super(message);
    this.name = 'DomainGroupError';
    this.status = status;
    this.remediation = remediation;
  }
}

/** True when per-domain Entra group provisioning is enabled for this deployment. */
export function domainGroupProvisioningEnabled(): boolean {
  return (process.env.LOOM_DOMAIN_GROUP_PROVISIONING || '').trim().toLowerCase() === 'true';
}

export interface DomainGroupPair {
  adminGroupId: string;
  contributorGroupId: string;
}

const PROVISIONING_REMEDIATION =
  'Set LOOM_DOMAIN_GROUP_PROVISIONING=true and grant the Console UAMI the Microsoft Graph ' +
  'Group.ReadWrite.All application permission (admin-consent required — it cannot be granted ' +
  'via ARM/Bicep). See platform/fiab/bicep/modules/admin-plane/identity-graph-rbac.bicep ' +
  '(set domainGroupProvisioningEnabled=true) and run ' +
  'scripts/csa-loom/grant-identity-graph-approles.sh. Until then, domains use the legacy ' +
  'admins[] / contributors model with no backing Entra groups.';

async function graphToken(): Promise<string> {
  let t;
  try {
    t = await credential.getToken(graphScope());
  } catch {
    throw new DomainGroupError('graph_token_failed', 503, PROVISIONING_REMEDIATION);
  }
  if (!t?.token) throw new DomainGroupError('graph_token_failed', 503, PROVISIONING_REMEDIATION);
  return t.token;
}

async function graphFetch(path: string, init?: RequestInit): Promise<any> {
  const token = await graphToken();
  const url = path.startsWith('http') ? path : `${graphBase()}${path}`;
  const res = await fetchWithTimeout(url, {
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
    const remediation = res.status === 401 || res.status === 403 ? PROVISIONING_REMEDIATION : undefined;
    throw new DomainGroupError(msg, res.status, remediation);
  }
  return json;
}

/** Valid mailNickname for a security group (letters/digits/dashes, <=64). */
function nicknameFor(domainId: string, suffix: 'admins' | 'contributors'): string {
  const base = `loom-domain-${domainId}-${suffix}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return base || `loom-domain-${suffix}`;
}

async function createSecurityGroup(input: {
  displayName: string;
  mailNickname: string;
  description: string;
  ownerObjectId?: string;
}): Promise<string> {
  const body: Record<string, unknown> = {
    displayName: input.displayName,
    description: input.description,
    // Security group — NOT a Unified/M365 group. No groupTypes, no mail.
    mailEnabled: false,
    mailNickname: input.mailNickname,
    securityEnabled: true,
  };
  if (input.ownerObjectId) {
    const host = graphBase().replace(/\/v1\.0\/?$/, '/v1.0');
    body['owners@odata.bind'] = [`${host}/directoryObjects/${input.ownerObjectId}`];
  }
  const created = await graphFetch('/groups', { method: 'POST', body: JSON.stringify(body) });
  if (!created?.id) throw new DomainGroupError('Graph returned no group id', 502);
  return created.id as string;
}

/**
 * Provision the admin + contributor security-group pair for a domain. Returns
 * the two object-ids to persist on the DomainItem. Throws DomainGroupError
 * (with a remediation string for 401/403/503) so the route can surface an honest
 * MessageBar — it NEVER fabricates ids.
 */
export async function provisionDomainGroups(input: {
  domainId: string;
  domainName: string;
  ownerObjectId?: string;
}): Promise<DomainGroupPair> {
  if (!domainGroupProvisioningEnabled()) {
    throw new DomainGroupError('domain_group_provisioning_disabled', 503, PROVISIONING_REMEDIATION);
  }
  const adminGroupId = await createSecurityGroup({
    displayName: `Loom Domain Admins — ${input.domainName}`,
    mailNickname: nicknameFor(input.domainId, 'admins'),
    description: `Domain administrators for the "${input.domainName}" Loom business domain (full control of its workspaces, DLZ panes, and members).`,
    ownerObjectId: input.ownerObjectId,
  });
  const contributorGroupId = await createSecurityGroup({
    displayName: `Loom Domain Contributors — ${input.domainName}`,
    mailNickname: nicknameFor(input.domainId, 'contributors'),
    description: `Domain contributors for the "${input.domainName}" Loom business domain (create/assign workspaces within the domain).`,
    ownerObjectId: input.ownerObjectId,
  });
  return { adminGroupId, contributorGroupId };
}
