/**
 * Ops Admin Copilot — tools + intention executor.
 *
 * The Ops persona never executes directly. The flow is two-phase:
 *
 *   1. classifyOpsIntent(prompt)  → calls AOAI with the ops_* tool schemas
 *      (tool_choice 'required'), parses the single tool call, READS the current
 *      Azure state, and returns an OpsIntention + a human "before → after" diff.
 *      Nothing is mutated.
 *
 *   2. executeOpsIntention(intention, callerOid) → after the admin approves the
 *      diff in the UI, performs the REAL ARM / Cosmos write:
 *        - scale_sql_pool   → synapse-dev-client.updateDedicatedPoolSku
 *        - scale_adx        → kusto-arm-client.updateKustoClusterSku
 *        - toggle_oap       → arm-client.setSynapseWorkspaceOap
 *        - workspace_create → cosmos workspacesContainer.items.create
 *
 * Every read/write hits real Azure. An ARM 403 (UAMI missing the role) is thrown
 * verbatim so the route/pane can render an honest remediation MessageBar. No
 * mock data, no fake success. Azure-native by default — no Fabric dependency.
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import crypto from 'node:crypto';
import { cogScope } from '../azure/cloud-endpoints';
import type { AoaiTarget } from '../azure/copilot-orchestrator';

// ---------------------------------------------------------------------------
// Intention model
// ---------------------------------------------------------------------------

export type OpsIntention =
  | { action: 'scale_sql_pool'; pool: string; targetSku: string; currentSku?: string; state?: string }
  | { action: 'scale_adx'; targetSku: string; capacity?: number; currentSku?: string; currentCapacity?: number }
  | { action: 'toggle_oap'; workspace: string; enable: boolean; currentValue?: boolean }
  | { action: 'workspace_create'; name: string; description?: string }
  | { action: 'clarify'; question: string };

export interface OpsClassification {
  intention: OpsIntention;
  /** One-line "before → after" summary rendered in the approval-diff card. */
  diffSummary: string;
  /** Structured before/after rows for the diff grid. */
  diff?: { label: string; before: string; after: string }[];
}

// ---------------------------------------------------------------------------
// AOAI tool schemas (OpenAI function-calling shape)
// ---------------------------------------------------------------------------

const S_STRING = { type: 'string' } as const;

function obj(props: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties: props, required, additionalProperties: false };
}

export const OPS_TOOL_SCHEMAS: unknown[] = [
  {
    type: 'function',
    function: {
      name: 'ops_scale_sql_pool',
      description:
        'Scale a Synapse dedicated SQL pool to a new DWU SKU (e.g. DW100c, DW200c, DW1000c). Omit pool to use the deployment default pool.',
      parameters: obj({ pool: S_STRING, sku: S_STRING }, ['sku']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'ops_scale_adx',
      description:
        'Scale the Azure Data Explorer (ADX) cluster to a new VM SKU (e.g. Standard_E4ads_v5), optionally setting the instance count (capacity).',
      parameters: obj({ sku: S_STRING, capacity: { type: 'number' } }, ['sku']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'ops_toggle_oap',
      description:
        'Toggle the Synapse workspace outbound-access policy (trustedServiceBypassEnabled). enable=true allows trusted Azure services to access the workspace. Omit workspace to use the deployment default.',
      parameters: obj({ enable: { type: 'boolean' }, workspace: S_STRING }, ['enable']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'ops_workspace_create',
      description: 'Create a new CSA Loom workspace with the given name (and optional description).',
      parameters: obj({ name: S_STRING, description: S_STRING }, ['name']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'ops_clarify',
      description: 'Ask the admin a brief clarifying question when the request is ambiguous or names an unconfigured resource.',
      parameters: obj({ question: S_STRING }, ['question']),
    },
  },
];

// ---------------------------------------------------------------------------
// Credential (AOAI classify call)
// ---------------------------------------------------------------------------

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

async function aoaiToken(): Promise<string> {
  const t = await credential.getToken(cogScope());
  if (!t?.token) throw new Error('Failed to acquire AOAI token');
  return t.token;
}

/** A resource named in a request that this deployment hasn't configured. */
export class OpsUnconfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpsUnconfiguredError';
  }
}

function normalizeSku(raw: string): string {
  // "DW 200 c" / "dw200C" → "DW200c"
  const m = String(raw || '').replace(/\s+/g, '').match(/^dw(\d+)c$/i);
  return m ? `DW${m[1]}c` : String(raw || '').trim();
}

// ---------------------------------------------------------------------------
// Phase 1 — classify + read current state (no mutation)
// ---------------------------------------------------------------------------

export async function classifyOpsIntent(
  prompt: string,
  target: AoaiTarget,
  systemPrompt: string,
): Promise<OpsClassification> {
  const url = `${target.endpoint}/openai/deployments/${encodeURIComponent(target.deployment)}/chat/completions?api-version=${target.apiVersion}`;
  const token = await aoaiToken();
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ];
  const base: Record<string, unknown> = {
    messages,
    tools: OPS_TOOL_SCHEMAS,
    tool_choice: 'required',
  };

  const send = (withTemp: boolean) =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(withTemp ? { ...base, temperature: 0 } : base),
    });

  let res = await send(true);
  if (res.status === 400) {
    const t = await res.text();
    if (/unsupported_value|does not support|Only the default \(1\) value is supported/i.test(t) && /temperature|top_p/i.test(t)) {
      res = await send(false);
    } else {
      throw new Error(`AOAI classify failed 400: ${t.slice(0, 400)}`);
    }
  }
  if (!res.ok) {
    throw new Error(`AOAI classify failed ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }

  const j = await res.json();
  const msg = j?.choices?.[0]?.message;
  const call = msg?.tool_calls?.[0];
  if (!call) {
    // Model declined to call a tool — treat its prose as a clarification.
    const q = (msg?.content || '').trim() || 'Could you rephrase that as a scale / OAP / workspace-create request?';
    return { intention: { action: 'clarify', question: q }, diffSummary: q };
  }

  let args: any = {};
  try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch {}

  switch (call.function.name) {
    case 'ops_scale_sql_pool':
      return buildScaleSqlPoolIntention(args.pool, normalizeSku(args.sku));
    case 'ops_scale_adx':
      return buildScaleAdxIntention(normalizeSku(args.sku), typeof args.capacity === 'number' ? args.capacity : undefined);
    case 'ops_toggle_oap':
      return buildToggleOapIntention(!!args.enable, args.workspace);
    case 'ops_workspace_create':
      return buildWorkspaceCreateIntention(args.name, args.description);
    case 'ops_clarify':
    default:
      return {
        intention: { action: 'clarify', question: String(args.question || 'Please clarify the operation.') },
        diffSummary: String(args.question || 'Please clarify the operation.'),
      };
  }
}

async function buildScaleSqlPoolIntention(poolArg: string | undefined, targetSku: string): Promise<OpsClassification> {
  const pool = (poolArg && String(poolArg).trim()) || process.env.LOOM_SYNAPSE_DEDICATED_POOL || '';
  if (!process.env.LOOM_SYNAPSE_WORKSPACE || !pool) {
    throw new OpsUnconfiguredError(
      'No Synapse dedicated SQL pool is configured in this deployment. Set LOOM_SYNAPSE_WORKSPACE and LOOM_SYNAPSE_DEDICATED_POOL (the Azure-native warehouse backend) to enable pool scaling.',
    );
  }
  if (!/^DW\d+c$/i.test(targetSku)) {
    return {
      intention: { action: 'clarify', question: `"${targetSku}" is not a valid SQL pool SKU. Use a DWU tier like DW100c, DW200c, DW500c or DW1000c.` },
      diffSummary: `Invalid SKU "${targetSku}".`,
    };
  }
  let currentSku: string | undefined;
  let state: string | undefined;
  try {
    const { getDedicatedPool } = await import('../azure/synapse-dev-client');
    const p = await getDedicatedPool(pool);
    currentSku = p?.sku?.name;
    state = p?.properties?.status;
  } catch { /* current read best-effort; the diff still shows the target */ }
  return {
    intention: { action: 'scale_sql_pool', pool, targetSku, currentSku, state },
    diffSummary: `Synapse dedicated SQL pool "${pool}" — SKU ${currentSku || 'current'} → ${targetSku}`,
    diff: [
      { label: 'Resource', before: pool, after: pool },
      { label: 'SKU', before: currentSku || '(unknown)', after: targetSku },
      ...(state ? [{ label: 'State', before: state, after: 'Scaling' }] : []),
    ],
  };
}

async function buildScaleAdxIntention(targetSku: string, capacity?: number): Promise<OpsClassification> {
  if (!process.env.LOOM_KUSTO_CLUSTER_NAME && !process.env.LOOM_KUSTO_CLUSTER_URI) {
    throw new OpsUnconfiguredError(
      'No Azure Data Explorer cluster is configured in this deployment. Set LOOM_KUSTO_CLUSTER_NAME / LOOM_KUSTO_RG to enable ADX scaling.',
    );
  }
  let currentSku: string | undefined;
  let currentCapacity: number | undefined;
  try {
    const { getKustoClusterArm } = await import('../azure/kusto-arm-client');
    const c: any = await getKustoClusterArm();
    currentSku = c?.sku?.name;
    currentCapacity = c?.sku?.capacity;
  } catch { /* best-effort */ }
  return {
    intention: { action: 'scale_adx', targetSku, capacity, currentSku, currentCapacity },
    diffSummary: `ADX cluster — SKU ${currentSku || 'current'} → ${targetSku}${typeof capacity === 'number' ? ` (capacity ${capacity})` : ''}`,
    diff: [
      { label: 'SKU', before: currentSku || '(unknown)', after: targetSku },
      ...(typeof capacity === 'number'
        ? [{ label: 'Capacity', before: String(currentCapacity ?? '(unknown)'), after: String(capacity) }]
        : []),
    ],
  };
}

function synapseTriple(workspaceArg?: string): { sub: string; rg: string; ws: string } | null {
  const sub = process.env.LOOM_SUBSCRIPTION_ID;
  const rg = process.env.LOOM_DLZ_RG;
  const ws = (workspaceArg && String(workspaceArg).trim()) || process.env.LOOM_SYNAPSE_WORKSPACE;
  if (!sub || !rg || !ws) return null;
  return { sub, rg, ws };
}

async function buildToggleOapIntention(enable: boolean, workspaceArg?: string): Promise<OpsClassification> {
  const t = synapseTriple(workspaceArg);
  if (!t) {
    throw new OpsUnconfiguredError(
      'No Synapse workspace is configured in this deployment. Set LOOM_SUBSCRIPTION_ID, LOOM_DLZ_RG and LOOM_SYNAPSE_WORKSPACE to manage the outbound-access policy.',
    );
  }
  let currentValue: boolean | undefined;
  try {
    const { getSynapseWorkspaceOap } = await import('../azure/arm-client');
    const s = await getSynapseWorkspaceOap(t.sub, t.rg, t.ws);
    currentValue = s.trustedServiceBypassEnabled;
  } catch { /* best-effort */ }
  return {
    intention: { action: 'toggle_oap', workspace: t.ws, enable, currentValue },
    diffSummary: `Synapse workspace "${t.ws}" outbound-access (trusted services) — ${currentValue === undefined ? 'current' : currentValue ? 'enabled' : 'disabled'} → ${enable ? 'enabled' : 'disabled'}`,
    diff: [
      { label: 'Workspace', before: t.ws, after: t.ws },
      {
        label: 'Trusted-service bypass',
        before: currentValue === undefined ? '(unknown)' : currentValue ? 'Enabled' : 'Disabled',
        after: enable ? 'Enabled' : 'Disabled',
      },
    ],
  };
}

async function buildWorkspaceCreateIntention(nameArg: string, description?: string): Promise<OpsClassification> {
  const name = String(nameArg || '').trim();
  if (!name) {
    return { intention: { action: 'clarify', question: 'What should the new workspace be named?' }, diffSummary: 'Workspace name required.' };
  }
  if (name.length > 120) {
    return { intention: { action: 'clarify', question: 'Workspace name is too long (max 120 characters). Pick a shorter name.' }, diffSummary: 'Name too long.' };
  }
  return {
    intention: { action: 'workspace_create', name, description: description ? String(description).trim() : undefined },
    diffSummary: `Create CSA Loom workspace "${name}"`,
    diff: [
      { label: 'New workspace', before: '(none)', after: name },
      ...(description ? [{ label: 'Description', before: '(none)', after: String(description).trim() }] : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// Phase 2 — execute the approved intention (REAL writes)
// ---------------------------------------------------------------------------

export interface OpsExecuteResult {
  ok: boolean;
  detail: string;
  result?: unknown;
}

export async function executeOpsIntention(
  intention: OpsIntention,
  callerOid: string,
): Promise<OpsExecuteResult> {
  switch (intention.action) {
    case 'scale_sql_pool': {
      const { updateDedicatedPoolSku } = await import('../azure/synapse-dev-client');
      const r = await updateDedicatedPoolSku(intention.pool, intention.targetSku);
      return {
        ok: true,
        detail: `Scale requested. Synapse pool "${intention.pool}" is moving to ${intention.targetSku} (Scaling, ~5 min to Online).`,
        result: r,
      };
    }
    case 'scale_adx': {
      const { updateKustoClusterSku } = await import('../azure/kusto-arm-client');
      const r: any = await updateKustoClusterSku(intention.targetSku, intention.capacity);
      return {
        ok: true,
        detail: `Scale requested. ADX cluster is moving to ${intention.targetSku} (${r?.state || r?.provisioningState || 'Updating'}).`,
        result: r,
      };
    }
    case 'toggle_oap': {
      const t = synapseTriple(intention.workspace);
      if (!t) throw new OpsUnconfiguredError('Synapse workspace no longer configured (LOOM_SYNAPSE_WORKSPACE).');
      const { setSynapseWorkspaceOap } = await import('../azure/arm-client');
      const r = await setSynapseWorkspaceOap(t.sub, t.rg, t.ws, intention.enable);
      return {
        ok: true,
        detail: `Outbound-access policy on "${t.ws}" set to ${r.trustedServiceBypassEnabled ? 'enabled' : 'disabled'}.`,
        result: r,
      };
    }
    case 'workspace_create': {
      const { workspacesContainer } = await import('../azure/cosmos-client');
      const c = await workspacesContainer();
      const now = new Date().toISOString();
      const ws = {
        id: crypto.randomUUID(),
        tenantId: callerOid,
        name: intention.name,
        description: intention.description,
        createdBy: callerOid,
        createdAt: now,
        updatedAt: now,
      };
      const { resource } = await c.items.create(ws);
      return {
        ok: true,
        detail: `Workspace "${intention.name}" created.`,
        result: { id: resource?.id ?? ws.id, name: ws.name },
      };
    }
    case 'clarify':
      return { ok: false, detail: intention.question };
    default:
      return { ok: false, detail: 'Unsupported intention.' };
  }
}
