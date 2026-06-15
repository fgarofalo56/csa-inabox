/**
 * Microsoft Graph Entra principal search — shared by the feature-RBAC grant
 * dialog and the data-product access-policy dialog. Real Graph REST via the
 * Console UAMI's app-only token (User.Read.All + Group.Read.All granted during
 * bootstrap). Cloud-aware (Commercial / GCC-High / IL5) via cloud-endpoints.
 *
 * No mock principal list. When Graph permissions aren't granted yet, the
 * caller surfaces the structured `remediation` from GraphPrincipalsError so the
 * UI shows the exact admin step.
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { graphBase, graphScope } from './cloud-endpoints';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

export type PrincipalKind = 'user' | 'group';

export interface EntraPrincipal {
  id: string;
  type: PrincipalKind;
  displayName: string;
  upn?: string;
  mail?: string;
  description?: string;
}

/** Thrown when Graph cannot be reached / authorized; carries an HTTP status + actionable remediation. */
export class GraphPrincipalsError extends Error {
  readonly status: number;
  readonly remediation?: string;
  constructor(message: string, status: number, remediation?: string) {
    super(message);
    this.name = 'GraphPrincipalsError';
    this.status = status;
    this.remediation = remediation;
  }
}

async function graphToken(): Promise<string> {
  let t;
  try {
    t = await credential.getToken(graphScope());
  } catch (e: any) {
    throw new GraphPrincipalsError(
      'graph_token_failed',
      503,
      'Console UAMI cannot acquire a Microsoft Graph token. Grant Graph application permissions User.Read.All + Group.Read.All to the UAMI and admin-consent them.',
    );
  }
  if (!t?.token) {
    throw new GraphPrincipalsError(
      'graph_token_failed',
      503,
      'Console UAMI cannot acquire a Microsoft Graph token. Grant Graph application permissions User.Read.All + Group.Read.All to the UAMI and admin-consent them.',
    );
  }
  return t.token;
}

/**
 * Search Entra users or groups by `startswith` on displayName (and
 * userPrincipalName for users). Returns up to 20 real principals, each with a
 * resolved UPN where available. Empty query → empty result (no Graph call).
 */
export async function searchEntraPrincipals(q: string, kind: PrincipalKind): Promise<EntraPrincipal[]> {
  const term = (q || '').trim();
  if (!term) return [];
  const token = await graphToken();
  const safe = encodeURIComponent(term.replace(/'/g, "''"));
  const base = graphBase();
  const endpoint = kind === 'group'
    ? `${base}/groups?$filter=startswith(displayName,'${safe}')&$top=20&$select=id,displayName,description,mail`
    : `${base}/users?$filter=startswith(displayName,'${safe}') or startswith(userPrincipalName,'${safe}')&$top=20&$select=id,displayName,userPrincipalName,mail`;

  const res = await fetchWithTimeout(endpoint, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    cache: 'no-store',
  });
  if (res.status === 401 || res.status === 403) {
    throw new GraphPrincipalsError(
      `graph_${res.status}`,
      503,
      kind === 'group'
        ? 'UAMI lacks Graph Group.Read.All permission. Run: az ad sp permission add --id <uami-objectid> --api 00000003-0000-0000-c000-000000000046 --api-permissions 5b567255-7703-4780-807c-7be8301ae99b=Role; then admin-consent.'
        : 'UAMI lacks Graph User.Read.All permission. Run: az ad sp permission add --id <uami-objectid> --api 00000003-0000-0000-c000-000000000046 --api-permissions df021288-bdef-4463-88db-98f22de89214=Role; then admin-consent.',
    );
  }
  if (!res.ok) {
    const body = await res.text();
    throw new GraphPrincipalsError(`graph_${res.status}`, res.status >= 500 ? 502 : res.status, body.slice(0, 300));
  }
  const json = await res.json();
  return ((json?.value || []) as any[]).map((p) => ({
    id: p.id,
    type: kind,
    displayName: p.displayName,
    upn: p.userPrincipalName,
    mail: p.mail,
    description: p.description,
  }));
}
