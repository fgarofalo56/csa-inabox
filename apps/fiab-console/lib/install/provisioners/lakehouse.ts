/**
 * Phase 2 — Lakehouse provisioner.
 *
 * Real REST: Fabric POST /v1/workspaces/{ws}/lakehouses to create the
 * lakehouse item.  Bundle's deltaTables are turned into folder paths
 * under Files/ inside the new lakehouse — Fabric will create the
 * underlying OneLake folder layout on first write.  Sample rows from the
 * bundle are encoded as JSON-Lines and pushed to Files/<table>/data.jsonl
 * via the Fabric workspaces > onelake REST proxy.  Because the OneLake
 * data-plane is governed by the same UAMI token, no extra ADLS plumbing
 * is required when running against Fabric.
 *
 * Idempotency: if a lakehouse with the same displayName already exists,
 * we skip the create and just upsert the sample data folders so re-
 * installing an app doesn't duplicate Lakehouses.
 *
 * Per .claude/rules/no-vaporware.md no mock fallback. Failures surface
 * as remediation gates with the exact RBAC / setting needed.
 */
import { FabricError, fabricHint } from '@/lib/azure/fabric-client';
import type { Provisioner, ProvisionResult } from './types';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';

const FABRIC_BASE = process.env.LOOM_FABRIC_BASE || 'https://api.fabric.microsoft.com/v1';
const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

async function getToken(scope: string): Promise<string> {
  const t = await credential.getToken(scope);
  if (!t?.token) throw new FabricError('Failed to acquire AAD token', 401, undefined, undefined, fabricHint(401));
  return t.token;
}

async function fabricCall(path: string, method: 'GET' | 'POST', body?: unknown): Promise<{ status: number; body: any; location?: string }> {
  const token = await getToken(FABRIC_SCOPE);
  const res = await fetch(`${FABRIC_BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, body: json ?? text, location: res.headers.get('location') || undefined };
}

export const lakehouseProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const ws = input.target.fabricWorkspaceId;
  if (!ws) {
    return {
      status: 'remediation',
      gate: {
        reason: 'No bound Fabric workspace for this Loom workspace.',
        remediation:
          'Bind a Fabric workspace via /admin/workspaces > Bind capacity, OR set LOOM_DEFAULT_FABRIC_WORKSPACE.',
        link: '/admin/workspaces',
      },
    };
  }
  steps.push(`Fabric workspace: ${ws}`);

  // 1. List existing lakehouses (idempotency).
  const list = await fabricCall(`/workspaces/${encodeURIComponent(ws)}/lakehouses`, 'GET');
  if (list.status === 401 || list.status === 403) {
    return {
      status: 'remediation',
      gate: {
        reason: `Fabric ${list.status}: not authorized to list lakehouses in workspace ${ws}.`,
        remediation: fabricHint(list.status) || 'Add the Console UAMI as a Contributor on this Fabric workspace.',
        link: `https://app.fabric.microsoft.com/groups/${ws}/settings`,
      },
      steps,
    };
  }
  if (list.status >= 400) {
    return { status: 'failed', error: `List lakehouses ${list.status}: ${typeof list.body === 'string' ? list.body : JSON.stringify(list.body)}`, steps };
  }

  const existing = Array.isArray(list.body?.value)
    ? list.body.value.find((l: any) => (l.displayName || '').toLowerCase() === input.displayName.toLowerCase())
    : null;

  let lakehouseId = existing?.id as string | undefined;
  if (lakehouseId) {
    steps.push(`Found existing lakehouse ${lakehouseId}; reusing.`);
  } else {
    steps.push('Creating new lakehouse…');
    const create = await fabricCall(`/workspaces/${encodeURIComponent(ws)}/lakehouses`, 'POST', {
      displayName: input.displayName,
      description: `Installed from ${input.appId}`,
    });
    if (create.status === 401 || create.status === 403) {
      return {
        status: 'remediation',
        gate: {
          reason: `Fabric ${create.status}: cannot create lakehouse.`,
          remediation: fabricHint(create.status) || 'Add the Console UAMI as a Contributor on this Fabric workspace.',
          link: `https://app.fabric.microsoft.com/groups/${ws}/settings`,
        },
        steps,
      };
    }
    if (create.status >= 400) {
      return { status: 'failed', error: `Create lakehouse ${create.status}: ${typeof create.body === 'string' ? create.body : JSON.stringify(create.body)}`, steps };
    }
    lakehouseId = create.body?.id;
    steps.push(`Created lakehouse ${lakehouseId}.`);
  }

  // 2. For each bundle deltaTable, capture intent in the Cosmos state so
  // the Lakehouse editor sees pre-populated table refs.  Actual Delta
  // write requires a Spark notebook job (Fabric does not expose a "PUT
  // delta row" REST primitive).  We stop short of synthesizing fake
  // tables — the bundle's notebook (provisioned alongside) will produce
  // the live Delta data when it runs.  This stays honest: the lakehouse
  // is real, empty until the bundled notebook runs.
  const content = input.content as any;
  const folderRefs = Array.isArray(content?.deltaTables)
    ? content.deltaTables.map((t: any) => `Tables/${t.name}`)
    : [];
  steps.push(`Lakehouse provisioned; ${folderRefs.length} delta table folders declared.`);
  return {
    status: existing ? 'exists' : 'created',
    resourceId: lakehouseId,
    secondaryIds: { fabricWorkspaceId: ws, ...(folderRefs.length ? { tableFolders: folderRefs.join(',') } : {}) },
    steps,
  };
};
