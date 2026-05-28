/**
 * Phase 2 — Eventstream provisioner.
 *
 * Real REST: Fabric POST /v1/workspaces/{ws}/eventstreams with
 * definition parts. Source/destination/transform topology from the
 * bundle is serialized into the eventstream definition JSON.
 *
 * Note: Fabric Eventstream create-with-definition is GA in v1; we hit
 * the standard endpoint and surface verbatim errors.
 */
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { FabricError, fabricHint } from '@/lib/azure/fabric-client';
import type { Provisioner, ProvisionResult } from './types';

const FABRIC_BASE = process.env.LOOM_FABRIC_BASE || 'https://api.fabric.microsoft.com/v1';
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

async function token(): Promise<string> {
  const t = await credential.getToken('https://api.fabric.microsoft.com/.default');
  if (!t?.token) throw new FabricError('Failed to acquire AAD token', 401);
  return t.token;
}

function buildDefinition(content: any, displayName: string): { format: string; parts: Array<{ path: string; payload: string; payloadType: 'InlineBase64' }> } {
  const esJson = {
    sources: Array.isArray(content?.sources) ? content.sources : [],
    destinations: Array.isArray(content?.destinations) ? content.destinations : [],
    operators: Array.isArray(content?.transforms) ? content.transforms : [],
    compatibilityLevel: '1.0',
  };
  return {
    format: 'eventstream',
    parts: [
      { path: 'eventstream.json', payload: Buffer.from(JSON.stringify(esJson), 'utf-8').toString('base64'), payloadType: 'InlineBase64' },
      {
        path: '.platform',
        payload: Buffer.from(JSON.stringify({
          $schema: 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json',
          metadata: { type: 'Eventstream', displayName },
          config: { version: '2.0' },
        }), 'utf-8').toString('base64'),
        payloadType: 'InlineBase64',
      },
    ],
  };
}

export const eventstreamProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const ws = input.target.fabricWorkspaceId;
  if (!ws) {
    return {
      status: 'remediation',
      gate: { reason: 'No bound Fabric workspace.', remediation: 'Bind a Fabric workspace.', link: '/admin/workspaces' },
      steps,
    };
  }
  const tok = await token();
  // List existing
  const listRes = await fetch(`${FABRIC_BASE}/workspaces/${encodeURIComponent(ws)}/eventstreams`, {
    headers: { authorization: `Bearer ${tok}` },
    cache: 'no-store',
  });
  if (listRes.status === 401 || listRes.status === 403) {
    return {
      status: 'remediation',
      gate: { reason: `Fabric ${listRes.status}: not authorized.`, remediation: fabricHint(listRes.status) || '', link: `https://app.fabric.microsoft.com/groups/${ws}/settings` },
      steps,
    };
  }
  let existing: any[] = [];
  if (listRes.ok) {
    const j = await listRes.json().catch(() => null);
    existing = Array.isArray(j?.value) ? j.value : [];
  }
  const match = existing.find((e: any) => (e.displayName || '').toLowerCase() === input.displayName.toLowerCase());
  const definition = buildDefinition(input.content, input.displayName);

  if (match?.id) {
    const updateRes = await fetch(`${FABRIC_BASE}/workspaces/${encodeURIComponent(ws)}/eventstreams/${encodeURIComponent(match.id)}/updateDefinition`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ definition }),
      cache: 'no-store',
    });
    if (!updateRes.ok && updateRes.status !== 202) {
      const t = await updateRes.text();
      return { status: 'failed', error: `Fabric updateDefinition ${updateRes.status}: ${t.slice(0, 300)}`, steps };
    }
    steps.push(`Updated eventstream ${match.id}.`);
    return { status: 'exists', resourceId: match.id, secondaryIds: { fabricWorkspaceId: ws }, steps };
  }

  const createRes = await fetch(`${FABRIC_BASE}/workspaces/${encodeURIComponent(ws)}/eventstreams`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: input.displayName, description: `Installed from ${input.appId}`, definition }),
    cache: 'no-store',
  });
  if (createRes.status === 401 || createRes.status === 403) {
    return {
      status: 'remediation',
      gate: { reason: `Fabric ${createRes.status}: cannot create eventstream.`, remediation: fabricHint(createRes.status) || '', link: `https://app.fabric.microsoft.com/groups/${ws}/settings` },
      steps,
    };
  }
  if (!createRes.ok && createRes.status !== 202) {
    const t = await createRes.text();
    return { status: 'failed', error: `Fabric eventstreams ${createRes.status}: ${t.slice(0, 300)}`, steps };
  }
  let body: any = null;
  try { body = await createRes.clone().json(); } catch {}
  steps.push(`Created eventstream ${body?.id || '(long-running)'}.`);
  return { status: 'created', resourceId: body?.id, secondaryIds: { fabricWorkspaceId: ws }, steps };
};
