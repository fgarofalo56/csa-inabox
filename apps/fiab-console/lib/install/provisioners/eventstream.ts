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
import { EventHubsArmError } from '@/lib/azure/eventhubs-client';
import {
  standUpEventstreamAzure,
  bundleContentToTopology,
  EventstreamConfigGateError,
} from '@/lib/azure/eventstream-standup';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
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

/**
 * Persist the Azure-native backend refs onto the Cosmos item's state so the
 * editor's GET reports runtimeStatus:'live' (Event Hub / ASA job) instead of
 * 'draft'.
 *
 * #3695 — THIS WRITE USED TO BE BEST-EFFORT, AND ITS JUSTIFYING COMMENT WAS
 * FALSE. The swallowing catch claimed the editor would re-provision the item
 * the next time it was opened. It does not:
 * `app/api/items/eventstream/[id]/route.ts` computes
 * `azureLive = !!item.state.ehId` and, with no `ehId` recorded, reports
 * `runtimeStatus:'draft'` with "design the topology and Provision to Azure" —
 * a button the user has to find and press, against an Event Hub that is
 * ALREADY live. Nothing re-provisions on open. Per deploy-integrity.md R7 a
 * message must not assert something the code did not establish; that false
 * comment is what licensed the swallow, so it is deleted rather than softened,
 * and `__tests__/eventstream.test.ts` asserts the sentence stays gone.
 *
 * The write now retries with bounded backoff and FAILS CLOSED — it reports its
 * outcome to the caller instead of appending to steps[] and returning as if
 * nothing happened, matching the shape landed for the activator in #3693
 * (`persistRulesToItem`). Open-time self-heal is explicitly OUT OF SCOPE here
 * (auto-bind-by-default.md §3): re-provisioning on GET would make a read
 * request create Azure resources, which is a bigger change than this defect
 * warrants and belongs with the editor route, not the installer.
 */
const PERSIST_ATTEMPTS = 3;
const PERSIST_BACKOFF_MS = [150, 400];

type PersistOutcome =
  | { ok: true; attempts: number }
  | {
      ok: false;
      attempts: number;
      reason: 'item-not-found' | 'write-failed';
      /** The message, for the step log / receipt text. */
      error: string;
      /** The ORIGINAL thrown error, so `resolveInfraResidual` can classify a
       *  Cosmos 403/429 from its STATUS rather than from prose that carries no
       *  infra keyword. Undefined for 'item-not-found', which is not a throw. */
      cause?: unknown;
    };

async function persistBackendRefs(
  input: any,
  refs: { ehId: string; transportHub: string; asaJobId: string | null; asaJobName: string | null; provisionedAt: string },
  steps: string[],
): Promise<PersistOutcome> {
  let reason: 'item-not-found' | 'write-failed' = 'write-failed';
  let error = '';
  let cause: unknown;
  for (let attempt = 1; attempt <= PERSIST_ATTEMPTS; attempt++) {
    try {
      const items = await itemsContainer();
      // Re-read on EVERY attempt so a retry merges against the CURRENT document
      // (and so an item still replicating is picked up by a later attempt).
      const { resource: cur } = await items.item(input.cosmosItemId, input.workspaceId).read<WorkspaceItem>();
      if (!cur) {
        reason = 'item-not-found';
        cause = undefined;
        error = `item '${input.cosmosItemId}' not found in workspace '${input.workspaceId}' (the Cosmos read returned no document)`;
      } else {
        const next: WorkspaceItem = {
          ...cur,
          state: {
            ...(cur.state || {}),
            ehId: refs.ehId,
            transportHub: refs.transportHub,
            asaJobId: refs.asaJobId,
            asaJobName: refs.asaJobName,
            provisionedAt: refs.provisionedAt,
          },
          updatedAt: new Date().toISOString(),
        };
        await items.item(cur.id, cur.workspaceId).replace(next);
        steps.push(
          'Persisted Event Hub / Stream Analytics refs to the item so the editor opens live (not draft)' +
            (attempt > 1 ? ` on attempt ${attempt}/${PERSIST_ATTEMPTS}` : '') +
            '.',
        );
        return { ok: true, attempts: attempt };
      }
    } catch (e: any) {
      reason = 'write-failed';
      cause = e;
      error = e?.message || String(e);
    }
    if (attempt < PERSIST_ATTEMPTS) {
      steps.push(`Backend-ref write attempt ${attempt}/${PERSIST_ATTEMPTS} did not complete (${error}); retrying.`);
      await new Promise((r) => setTimeout(r, PERSIST_BACKOFF_MS[attempt - 1] ?? 400));
    }
  }
  return { ok: false, attempts: PERSIST_ATTEMPTS, reason, error, cause };
}

// ── Azure-native DEFAULT: Azure Event Hubs (+ Stream Analytics for transforms) ─
// Delegates to the SHARED standUpEventstreamAzure() — the SAME code path the
// editor's "Provision to Azure" button calls — so an installed eventstream
// stands up the identical live backend a hand-provisioned one does.
async function provisionEventHubs(input: any, steps: string[]): Promise<ProvisionResult> {
  const topology = bundleContentToTopology(input.content);
  try {
    const result = await standUpEventstreamAzure(input.displayName, input.cosmosItemId, topology, steps);

    // Write the backend refs back onto the item so the editor opens 'live'.
    const persisted = await persistBackendRefs(input, result, steps);

    if (result.partial && result.hint) steps.push(result.hint);
    if (result.kustoHint) steps.push(result.kustoHint);

    // #3695 — the status now reflects whether the RECORD landed, not only
    // whether Azure accepted the stand-up. `created` over a lost write is
    // deploy-integrity.md R6's "report success on an unverified outcome": the
    // Event Hub is real, and the editor shows a draft with a Provision button.
    if (!persisted.ok) {
      steps.push(
        `Stood up the Event Hub (${result.transportHub}) but the backend refs could not be written to the eventstream item after ${persisted.attempts} attempt(s).`,
      );
      // Only what was ESTABLISHED (R7): the hub exists, and the write did not
      // confirm. No cause is asserted — the underlying error is carried
      // verbatim by resolveInfraResidual, and the ORIGINAL error object is
      // handed over so a Cosmos 403/429 is classified from its status.
      return resolveInfraResidual(
        persisted.cause ?? persisted.error,
        'Retry this install step. The retry is idempotent: the Event Hub, consumer groups and Stream Analytics job are upserted by name, so it will not create duplicates. ' +
          'Until the refs are recorded the editor opens this eventstream as a DRAFT with a Provision button even though the Event Hub is live — there is no re-provision on open. ' +
          'If the retry keeps failing, check the underlying error below and verify the Console UAMI holds the Cosmos DB Built-in Data Contributor role on the Loom Cosmos account.',
        {
          reason:
            `Stood up the Azure-native Event Hubs backend (${result.transportHub}) but could not record it on the eventstream item: ` +
            (persisted.reason === 'item-not-found'
              ? `reading item '${input.cosmosItemId}' in workspace '${input.workspaceId}' returned no document.`
              : 'the Cosmos write did not complete.'),
          link: 'https://learn.microsoft.com/azure/cosmos-db/nosql/security/how-to-grant-data-plane-role-based-access',
          errorPrefix: 'Stood up the Event Hub but failed to persist the backend refs: ',
          resourceId: result.transportHub,
          secondaryIds: {
            backend: 'eventhubs',
            eventHub: result.transportHub,
            ehId: result.ehId,
            ...(result.asaJobName ? { asaJobName: result.asaJobName } : {}),
            ...(result.asaJobId ? { asaJobId: result.asaJobId } : {}),
            provisionedAt: result.provisionedAt,
            refsPersisted: 'false',
          },
          steps,
        },
      );
    }

    return {
      status: 'created',
      resourceId: result.transportHub,
      secondaryIds: {
        backend: 'eventhubs',
        eventHub: result.transportHub,
        ehId: result.ehId,
        ...(result.asaJobName ? { asaJobName: result.asaJobName } : {}),
        ...(result.asaJobId ? { asaJobId: result.asaJobId } : {}),
        provisionedAt: result.provisionedAt,
        refsPersisted: 'true',
      },
      steps,
    };
  } catch (e: any) {
    if (e instanceof EventstreamConfigGateError) {
      return {
        status: 'remediation',
        gate: {
          reason: 'Azure Event Hubs namespace is not configured for this deployment.',
          remediation: `Set ${e.missing} (and LOOM_EVENTHUB_SUB / LOOM_EVENTHUB_RG, or LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG) so the eventstream can create its Event Hub. No Microsoft Fabric required.`,
          link: 'https://learn.microsoft.com/azure/event-hubs/event-hubs-create',
        },
        steps,
      };
    }
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
    return resolveInfraResidual(e, 'Confirm LOOM_EVENTHUB_NAMESPACE points at a deployed Event Hubs namespace and grant the Console UAMI "Azure Event Hubs Data Owner" + Contributor on it so it can create hubs + consumer groups.', { link: 'https://learn.microsoft.com/azure/event-hubs/authenticate-application', steps });
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
