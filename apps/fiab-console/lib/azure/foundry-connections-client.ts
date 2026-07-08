/**
 * Azure AI Foundry — project/hub CONNECTIONS write client (AIF-9).
 *
 * Sibling of `foundry-client.ts` (which owns the read-only `listConnections`).
 * This module adds create / delete against the workspace connections REST so the
 * Foundry hub editor's Connections tab can do full CRUD — the backbone that lets
 * agents / flows / knowledge sources reference a NAMED connection instead of a
 * hard-coded endpoint (prerequisite plumbing for AIF-1 and AIF-2).
 *
 *   PUT    .../workspaces/{ws}/connections/{name}?api-version=2024-10-01
 *   DELETE .../workspaces/{ws}/connections/{name}
 *   GET    .../workspaces/{ws}/connections/{name}
 *
 * Auth: the Loom Console UAMI via ChainedTokenCredential (ACA MSI → UAMI →
 * DefaultAzureCredential), same ARM scope as `foundry-client.ts`. The UAMI holds
 * Contributor at the workspace scope (connection-write role).
 *
 * SECRET HANDLING: pure `buildConnectionBody` (in foundry-connection-shapes.ts)
 * defaults to Microsoft Entra ID (`AAD`, workspace managed identity, no secret)
 * and REJECTS any raw plaintext secret — key-based connections must reference a
 * Key Vault secret identifier. A raw key can never appear in the request body.
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armBase, armScope } from './cloud-endpoints';
import { FoundryError, type FoundryConnection } from './foundry-client';
import {
  buildConnectionBody,
  isValidConnectionName,
  type CreateConnectionInput,
} from './foundry-connection-shapes';

// Re-export the pure surface so callers can import everything from the client.
export {
  buildConnectionBody,
  isKeyVaultSecretUri,
  isValidConnectionName,
  RawSecretRejectedError,
  CONNECTION_CATEGORIES,
} from './foundry-connection-shapes';
export type {
  ConnectionCategory,
  ConnectionAuthMode,
  CreateConnectionInput,
} from './foundry-connection-shapes';

const ARM_SCOPE = armScope();
const ML_API = '2024-10-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

function required(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var: ${k}`);
  return v;
}

// Same resolution as foundry-client.foundrySub()/foundryBase() so a connection
// created here lands on the SAME hub the read path lists.
function foundrySub(): string {
  return process.env.LOOM_FOUNDRY_SUB || required('LOOM_SUBSCRIPTION_ID');
}
function foundryRg(): string {
  return process.env.LOOM_FOUNDRY_RG || 'rg-csa-loom-admin-eastus2';
}
function foundryName(): string {
  return process.env.LOOM_FOUNDRY_NAME || 'aifoundry-csa-loom-eastus2';
}
function workspaceBase(): string {
  return (
    `${armBase()}/subscriptions/${foundrySub()}/resourceGroups/${foundryRg()}` +
    `/providers/Microsoft.MachineLearningServices/workspaces/${foundryName()}`
  );
}

async function armFetch(
  fullPath: string,
  init: RequestInit & { apiVersion?: string } = {},
): Promise<Response> {
  const token = await credential.getToken(ARM_SCOPE);
  if (!token?.token) throw new Error('Failed to acquire ARM token for Foundry connections');
  const apiVer = init.apiVersion || ML_API;
  const sep = fullPath.includes('?') ? '&' : '?';
  const url = `${fullPath}${sep}api-version=${apiVer}`;
  const { apiVersion: _av, ...rest } = init;
  return fetchWithTimeout(url, {
    ...rest,
    headers: {
      ...(rest.headers || {}),
      authorization: `Bearer ${token.token}`,
      'content-type': 'application/json',
    },
  });
}

async function readOrThrow<T>(res: Response, ctx: string): Promise<T> {
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!res.ok) {
    const msg =
      (parsed as any)?.error?.message ||
      (typeof parsed === 'string' && parsed ? parsed : `${ctx} (${res.status})`);
    throw new FoundryError(res.status, parsed, String(msg).slice(0, 400));
  }
  return (parsed as T) ?? ({} as T);
}

function shapeConnection(raw: any): FoundryConnection {
  const p = raw?.properties || {};
  return {
    id: raw?.id,
    name: raw?.name,
    category: p.category,
    target: p.target,
    authType: p.authType,
    isSharedToAll: p.isSharedToAll,
    createdAt: raw?.systemData?.createdAt,
    metadata: p.metadata,
  };
}

/** GET one connection. 404 → null. */
export async function getConnection(name: string): Promise<FoundryConnection | null> {
  const res = await armFetch(`${workspaceBase()}/connections/${encodeURIComponent(name)}`);
  if (res.status === 404) return null;
  const j = await readOrThrow<any>(res, `get connection ${name}`);
  return shapeConnection(j);
}

/**
 * PUT a connection (create-or-update). Real ARM write — a 404/non-2xx throws
 * FoundryError (never a faked success over a null effect).
 */
export async function createConnection(input: CreateConnectionInput): Promise<FoundryConnection> {
  const name = (input.name || '').trim();
  if (!name) throw new FoundryError(400, input, 'connection name is required');
  if (!isValidConnectionName(name)) {
    throw new FoundryError(400, input, 'connection name must be 2–63 chars: letters, digits, _ . -');
  }
  const body = buildConnectionBody(input); // throws RawSecretRejectedError on a raw secret
  const res = await armFetch(`${workspaceBase()}/connections/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  const j = await readOrThrow<any>(res, `create connection ${name}`);
  return shapeConnection({ ...j, name: j?.name || name });
}

/** DELETE a connection. 404/204 → ok (idempotent). */
export async function deleteConnection(name: string): Promise<void> {
  const res = await armFetch(`${workspaceBase()}/connections/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (res.status === 404 || res.status === 204 || res.ok) return;
  await readOrThrow(res, `delete connection ${name}`);
}
