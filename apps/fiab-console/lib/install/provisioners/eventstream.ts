/**
 * Phase 2 — Eventstream provisioner.
 *
 * Per .claude/rules/no-fabric-dependency.md a Loom eventstream NEVER requires a
 * real Fabric workspace. It defaults to the Azure-native **Azure Event Hubs**
 * backend: the eventstream becomes a real Event Hub (the central stream) in the
 * configured namespace, with one consumer group per destination, and — when
 * transforms are present and Stream Analytics is configured — a Stream
 * Analytics transformation. A Fabric Eventstream is an opt-in alternative
 * selected via LOOM_EVENT_BACKEND=fabric + a bound workspace; if fabric is
 * selected but no workspace is bound, we transparently fall back to Event Hubs.
 *
 * Honest Azure gate (not a Fabric gate): when the Event Hubs namespace env vars
 * aren't set, the item installs to Cosmos and surfaces the exact env var to set.
 *   https://learn.microsoft.com/azure/event-hubs/event-hubs-about
 */
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { FabricError, fabricHint } from '@/lib/azure/fabric-client';
import {
  eventhubsConfigGate,
  listEventHubs,
  createEventHub,
  listConsumerGroups,
  createConsumerGroup,
  EventHubsArmError,
} from '@/lib/azure/eventhubs-client';
import type { Provisioner, ProvisionResult } from './types';
import { resolveInfraResidual } from './types';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';

const FABRIC_BASE = process.env.LOOM_FABRIC_BASE || 'https://api.fabric.microsoft.com/v1';
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

async function token(): Promise<string> {
  const t = await credential.getToken('https://api.fabric.microsoft.com/.default');
  if (!t?.token) throw new FabricError('Failed to acquire AAD token', 401);
  return t.token;
}

/** Event Hub entity names: alnum, -, ., _, /; ≤ 256. Keep it portable. */
function safeHubName(displayName: string): string {
  const cleaned = displayName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 200);
  return cleaned || 'loom-eventstream';
}

/** Derive the consumer-group name for a destination/consumer entry. */
function consumerName(entry: any, i: number): string {
  const raw = entry?.name || entry?.id || entry?.type || `dest${i}`;
  return String(raw).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || `dest${i}`;
}

// ── Azure-native DEFAULT: Azure Event Hubs ──────────────────────────────────
async function provisionEventHubs(input: any, steps: string[]): Promise<ProvisionResult> {
  const gate = eventhubsConfigGate();
  if (gate) {
    return {
      status: 'remediation',
      gate: {
        reason: 'Azure Event Hubs namespace is not configured for this deployment.',
        remediation: `Set ${gate.missing} (and LOOM_EVENTHUB_SUB / LOOM_EVENTHUB_RG, or LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG) so the eventstream can create its Event Hub. No Microsoft Fabric required.`,
        link: 'https://learn.microsoft.com/azure/event-hubs/event-hubs-create',
      },
      steps,
    };
  }

  const content = input.content as any;
  const hubName = safeHubName(input.displayName);
  const destinations: any[] = Array.isArray(content?.destinations) ? content.destinations : [];
  const transforms: any[] = Array.isArray(content?.transforms) ? content.transforms : [];

  try {
    // Idempotent create: skip if the hub already exists.
    let existed = false;
    try {
      const hubs = await listEventHubs();
      existed = hubs.some((h) => (h.name || '').toLowerCase() === hubName.toLowerCase());
    } catch { /* list may fail on RBAC; create will surface it */ }

    if (!existed) {
      await createEventHub({ name: hubName, partitionCount: 4, messageRetentionInDays: 1 });
      steps.push(`Created Event Hub '${hubName}' (4 partitions, 1-day retention).`);
    } else {
      steps.push(`Event Hub '${hubName}' already exists; reusing.`);
    }

    // One consumer group per destination so each downstream consumer reads the
    // stream independently (the Event Hubs analogue of eventstream destinations).
    let existingCgs = new Set<string>();
    try {
      const cgs = await listConsumerGroups(hubName);
      existingCgs = new Set(cgs.map((c) => (c.name || '').toLowerCase()));
    } catch { /* fine */ }
    let cgCount = 0;
    for (let i = 0; i < destinations.length; i++) {
      const cg = consumerName(destinations[i], i);
      if (cg === '$default' || existingCgs.has(cg)) continue;
      try {
        await createConsumerGroup(hubName, cg, `Loom eventstream destination from ${input.appId}`);
        cgCount += 1;
        steps.push(`Created consumer group '${cg}'.`);
      } catch (e: any) {
        steps.push(`Could not create consumer group '${cg}': ${e?.message || e}`);
      }
    }

    if (transforms.length > 0) {
      steps.push(`${transforms.length} transform(s) declared — wire an Azure Stream Analytics job (LOOM_ASA_*) to process '${hubName}' into the destinations. The Event Hub stream + consumer groups are live now.`);
    }

    return {
      status: 'created',
      resourceId: hubName,
      secondaryIds: { backend: 'eventhubs', eventHub: hubName, consumerGroups: String(cgCount) },
      steps,
    };
  } catch (e: any) {
    if (e instanceof EventHubsArmError && (e.status === 401 || e.status === 403)) {
      return {
        status: 'remediation',
        gate: {
          reason: `Event Hubs ${e.status}: cannot manage the namespace.`,
          remediation: 'Grant the Console UAMI (LOOM_UAMI_CLIENT_ID) the "Azure Event Hubs Data Owner" + a management role (Contributor on the namespace) so it can create hubs + consumer groups.',
          link: 'https://learn.microsoft.com/azure/event-hubs/authenticate-application',
        },
        steps,
      };
    }
    return resolveInfraResidual(e, 'Confirm LOOM_EVENTHUBS_NAMESPACE points at a deployed Event Hubs namespace and grant the Console UAMI "Azure Event Hubs Data Owner" + Contributor on it so it can create hubs + consumer groups.', { link: 'https://learn.microsoft.com/azure/event-hubs/authenticate-application', steps });
  }
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

// ── Fabric Eventstream backend (opt-in: LOOM_EVENT_BACKEND=fabric + bound ws) ─
async function provisionFabricEventstream(input: any, steps: string[], ws: string): Promise<ProvisionResult> {
  const tok = await token();
  const listRes = await fetchWithTimeout(`${FABRIC_BASE}/workspaces/${encodeURIComponent(ws)}/eventstreams`, {
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
    const updateRes = await fetchWithTimeout(`${FABRIC_BASE}/workspaces/${encodeURIComponent(ws)}/eventstreams/${encodeURIComponent(match.id)}/updateDefinition`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ definition }),
      cache: 'no-store',
    });
    if (!updateRes.ok && updateRes.status !== 202) {
      const t = await updateRes.text();
      return resolveInfraResidual(`Fabric updateDefinition ${updateRes.status}: ${t.slice(0, 300)}`, fabricHint(updateRes.status) || 'Add the Console UAMI to this Fabric workspace as a Contributor (and bind it to a capacity).', { status: updateRes.status, link: `https://app.fabric.microsoft.com/groups/${ws}/settings`, steps });
    }
    steps.push(`Updated eventstream ${match.id}.`);
    return { status: 'exists', resourceId: match.id, secondaryIds: { backend: 'fabric', fabricWorkspaceId: ws }, steps };
  }

  const createRes = await fetchWithTimeout(`${FABRIC_BASE}/workspaces/${encodeURIComponent(ws)}/eventstreams`, {
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
    return resolveInfraResidual(`Fabric eventstreams ${createRes.status}: ${t.slice(0, 300)}`, fabricHint(createRes.status) || 'Add the Console UAMI to this Fabric workspace as a Contributor (and bind it to a capacity).', { status: createRes.status, link: `https://app.fabric.microsoft.com/groups/${ws}/settings`, steps });
  }
  let body: any = null;
  try { body = await createRes.clone().json(); } catch {}
  steps.push(`Created eventstream ${body?.id || '(long-running)'}.`);
  return { status: 'created', resourceId: body?.id, secondaryIds: { backend: 'fabric', fabricWorkspaceId: ws }, steps };
}

export const eventstreamProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const ws = input.target.fabricWorkspaceId;
  const backend = input.target.eventBackend || 'eventhubs';

  if (backend === 'fabric' && ws) {
    steps.push('Provisioning eventstream on the Fabric Eventstream backend (opt-in).');
    return provisionFabricEventstream(input, steps, ws);
  }
  if (backend === 'fabric' && !ws) {
    steps.push('LOOM_EVENT_BACKEND=fabric but no Fabric workspace bound — falling back to the Azure-native Event Hubs backend.');
  } else {
    steps.push('Provisioning eventstream on the Azure-native Event Hubs backend.');
  }
  return provisionEventHubs(input, steps);
};
