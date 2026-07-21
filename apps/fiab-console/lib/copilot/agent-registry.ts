/**
 * agent-registry — WS-9 Sovereign Agent Mesh: the PURE model + policy spine for a
 * governed, in-VNet multi-agent mesh (BTB-4 / BTB-9).
 *
 * A `MeshAgentDef` is a NAMED agent registered in the tenant's mesh (persisted in
 * the Cosmos `agent-registry` container, PK /tenantId — see agent-registry-store.ts).
 * Each agent carries:
 *   - a `kind` (governance / pipeline / bi / orchestrator / custom) that seeds its
 *     default instructions + tool scope,
 *   - an optional bound Loom item (`itemId` + `itemType` — an agent-flow / data-agent
 *     whose grounded config it runs),
 *   - a PER-AGENT TOOL SCOPE (`toolScope` native kinds + `mcpServerIds`) so an agent
 *     can only reach the tools it is explicitly granted (least privilege), and
 *   - an EGRESS PROFILE (`commercial` / `gov` / `air-gap`) that governs whether any
 *     external tool call is permitted — `air-gap` is FAIL-CLOSED.
 *
 * This module is PURE (no JSX / React / Azure SDK / Cosmos) so it unit-tests without
 * the Fluent bundle. It composes only other pure modules (mcp-catalog, agent-tool-
 * catalog). The impure Cosmos CRUD lives in agent-registry-store.ts and the mesh
 * runner (with real authorize() + chatGrounded()) in agent-mesh.ts / agent-mesh-run.ts.
 *
 * No Microsoft Fabric anywhere (no-fabric-dependency.md): every native tool kind maps
 * to an Azure-native backend and Gov AOAI is reached DIRECT (*.openai.azure.us) with
 * no Power BI / Fabric / OneLake dependency.
 */

import type { AgentToolKind } from './agent-tool-catalog';
import type { SubAgentItemType } from './connected-agents';
import { MCP_CATALOG, airGapSafeServers, type McpCatalogEntry } from '@/lib/azure/mcp-catalog';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The role a mesh agent plays. Drives its default instructions + tool scope. */
export const MESH_AGENT_KINDS = ['governance', 'pipeline', 'bi', 'orchestrator', 'custom'] as const;
export type MeshAgentKind = (typeof MESH_AGENT_KINDS)[number];

/** Item types a mesh agent can bind to for its grounded config. */
export const MESH_BINDABLE_ITEM_TYPES = ['data-agent', 'operations-agent', 'agent-flow'] as const;
export type MeshBindableItemType = (typeof MESH_BINDABLE_ITEM_TYPES)[number];

/**
 * Egress profile for a mesh agent. Governs whether an external tool/A2A call is
 * permitted:
 *   - commercial → external egress allowed (public cloud).
 *   - gov        → only Azure Government / gov-internal hosts (or an explicit
 *                  allow-list) — commercial-cloud hosts are refused.
 *   - air-gap    → FAIL-CLOSED: no external host at all unless the operator has
 *                  explicitly allow-listed its suffix (sovereign / disconnected).
 * Native in-VNet backends (Synapse / ADLS / ADX / AI Search / Gov AOAI via private
 * endpoint) are NOT external egress and are always reachable on every profile.
 */
export const MESH_EGRESS_PROFILES = ['commercial', 'gov', 'air-gap'] as const;
export type MeshEgressProfile = (typeof MESH_EGRESS_PROFILES)[number];

/** Native, Azure-native, in-VNet tool kinds that never leave the boundary. These
 *  are the Tier-0 air-gap-safe native kinds selectable in a sovereign profile. */
export const TIER0_NATIVE_TOOL_KINDS: readonly AgentToolKind[] = [
  'warehouse', // Synapse dedicated SQL (in-VNet TDS)
  'lakehouse', // ADLS Gen2 + Delta (in-VNet)
  'kql', // Azure Data Explorer (in-VNet)
  'search-index', // Azure AI Search (in-VNet)
  'knowledge-base', // grounded KB over in-VNet stores
  'ontology-object', // Weave ontology (Cosmos / AGE, in-VNet)
  'code-interpreter', // sandboxed compute (in-VNet)
  'function', // Loom-hosted function (in-VNet)
] as const;

/** Tool kinds that MAY reach outside the boundary (blocked on air-gap unless
 *  the concrete server/endpoint is allow-listed). */
export const EXTERNAL_TOOL_KINDS: readonly AgentToolKind[] = ['openapi', 'bing-grounding'] as const;

/** One registered agent in the tenant's mesh. */
export interface MeshAgentDef {
  /** Stable id (also the A2A agent-card id + registry doc id). */
  id: string;
  /** Cosmos partition key. */
  tenantId: string;
  /** Display name (mesh graph node, A2A card, audit trail). */
  name: string;
  /** Agent role. */
  kind: MeshAgentKind;
  /** One-line description (A2A card + picker). */
  description?: string;
  /** System instructions the agent runs under (the orchestrator prompt / persona). */
  instructions: string;
  /** Optional bound Loom item whose grounded config this agent runs. */
  itemId?: string;
  itemType?: MeshBindableItemType;
  /** PER-AGENT native tool scope — only these kinds may be attached/called. */
  toolScope: AgentToolKind[];
  /** PER-AGENT MCP scope — catalog/registry ids of the ONLY MCP servers this
   *  agent may call (least privilege). Empty ⇒ no MCP tools for this agent. */
  mcpServerIds: string[];
  /** Egress profile. */
  egressProfile: MeshEgressProfile;
  /** Whether this agent may be invoked BY EXTERNAL agents via the A2A hub. */
  publishA2A: boolean;
  /** Whether this agent is a built-in seed (governance/pipeline/bi). */
  builtin?: boolean;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Normalize / validate
// ---------------------------------------------------------------------------

function asKind(v: unknown): MeshAgentKind {
  return (MESH_AGENT_KINDS as readonly string[]).includes(String(v)) ? (v as MeshAgentKind) : 'custom';
}
function asProfile(v: unknown): MeshEgressProfile {
  return (MESH_EGRESS_PROFILES as readonly string[]).includes(String(v)) ? (v as MeshEgressProfile) : 'commercial';
}
function asToolKinds(raw: unknown): AgentToolKind[] {
  const all = [...TIER0_NATIVE_TOOL_KINDS, ...EXTERNAL_TOOL_KINDS, 'mcp'] as string[];
  if (!Array.isArray(raw)) return [];
  const out: AgentToolKind[] = [];
  for (const r of raw) {
    const s = String(r);
    if (all.includes(s) && !out.includes(s as AgentToolKind)) out.push(s as AgentToolKind);
  }
  return out;
}
function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(new Set(raw.map((r) => String(r || '').trim()).filter(Boolean)));
}

/** Normalize a persisted / posted agent row into a clean MeshAgentDef. */
export function normalizeMeshAgent(raw: unknown, tenantId: string): MeshAgentDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = String(r.name || '').trim();
  if (!name) return null;
  const kind = asKind(r.kind);
  const itemType = (MESH_BINDABLE_ITEM_TYPES as readonly string[]).includes(String(r.itemType))
    ? (r.itemType as MeshBindableItemType)
    : undefined;
  let toolScope = asToolKinds(r.toolScope);
  if (toolScope.length === 0) toolScope = defaultToolScope(kind);
  return {
    id: String(r.id || '').trim() || genAgentId(kind),
    tenantId: String(r.tenantId || tenantId),
    name,
    kind,
    description: r.description ? String(r.description).slice(0, 400) : undefined,
    instructions: String(r.instructions || defaultInstructions(kind, name)).slice(0, 4000),
    itemId: r.itemId ? String(r.itemId) : undefined,
    itemType: r.itemId ? itemType : undefined,
    toolScope,
    mcpServerIds: asStringArray(r.mcpServerIds),
    egressProfile: asProfile(r.egressProfile),
    publishA2A: r.publishA2A === true,
    builtin: r.builtin === true || undefined,
    createdBy: r.createdBy ? String(r.createdBy) : undefined,
    createdAt: r.createdAt ? String(r.createdAt) : undefined,
    updatedAt: r.updatedAt ? String(r.updatedAt) : undefined,
  };
}

function genAgentId(kind: MeshAgentKind): string {
  return `mesh-${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** True when an agent is runnable (has a name + at least one tool or a bound item). */
export function isMeshAgentRunnable(a: MeshAgentDef): boolean {
  return !!a.name && (a.toolScope.length > 0 || !!a.itemId || a.kind === 'orchestrator' || a.kind === 'governance');
}

// ---------------------------------------------------------------------------
// Kind defaults + built-in seeds
// ---------------------------------------------------------------------------

/** Default native tool scope for a mesh-agent kind (least-privilege starting point). */
export function defaultToolScope(kind: MeshAgentKind): AgentToolKind[] {
  switch (kind) {
    case 'governance':
      return ['ontology-object', 'knowledge-base', 'search-index'];
    case 'pipeline':
      return ['lakehouse', 'warehouse', 'function'];
    case 'bi':
      return ['warehouse', 'kql', 'search-index'];
    case 'orchestrator':
      return ['knowledge-base'];
    default:
      return ['knowledge-base'];
  }
}

/** Default system instructions for a mesh-agent kind. */
export function defaultInstructions(kind: MeshAgentKind, name: string): string {
  switch (kind) {
    case 'governance':
      return `You are ${name}, a data-governance agent. You assess policy, sensitivity labels, DLP posture and access boundaries for a request. Only report what the in-VNet governance stores (Purview / DLP / access policies) actually say. Never carry regulated data outside the boundary.`;
    case 'pipeline':
      return `You are ${name}, a data-pipeline agent. You plan and describe Azure-native data movement (Synapse / ADF over ADLS + Delta) needed to satisfy a request. You operate only on in-VNet lakehouse/warehouse tools.`;
    case 'bi':
      return `You are ${name}, a business-intelligence agent. You answer analytical questions grounded on the in-VNet warehouse / KQL data your tools expose. You cite the tables you used.`;
    case 'orchestrator':
      return `You are ${name}, the mesh orchestrator. You decompose a task, delegate to the connected governance / pipeline / BI agents, and synthesize a single governed answer. Every delegation is policy-checked and audited.`;
    default:
      return `You are ${name}, a Loom mesh agent.`;
  }
}

/**
 * The built-in seed agents for a tenant's mesh — governance + pipeline + BI (the
 * WS-9 acceptance trio) plus an orchestrator. Registered on first access so the
 * mesh is functional day-one (default-on, opt-out per loom_default_on_opt_out).
 * `profile` seeds their egress profile (a Gov/air-gap deployment seeds 'air-gap').
 */
export function builtinMeshAgents(tenantId: string, profile: MeshEgressProfile = 'commercial'): MeshAgentDef[] {
  const now = new Date().toISOString();
  const mk = (id: string, name: string, kind: MeshAgentKind, publishA2A: boolean): MeshAgentDef => ({
    id,
    tenantId,
    name,
    kind,
    description: defaultInstructions(kind, name).split('.')[0] + '.',
    instructions: defaultInstructions(kind, name),
    toolScope: defaultToolScope(kind),
    mcpServerIds: [],
    egressProfile: profile,
    publishA2A,
    builtin: true,
    createdBy: 'system',
    createdAt: now,
    updatedAt: now,
  });
  return [
    mk('mesh-orchestrator', 'Mesh Orchestrator', 'orchestrator', false),
    mk('mesh-governance', 'Governance Agent', 'governance', true),
    mk('mesh-pipeline', 'Pipeline Agent', 'pipeline', true),
    mk('mesh-bi', 'BI Agent', 'bi', true),
  ];
}

// ---------------------------------------------------------------------------
// Tier-0 air-gap-safe tool catalog
// ---------------------------------------------------------------------------

export interface Tier0Catalog {
  /** Native in-VNet tool kinds (zero external egress). */
  nativeKinds: AgentToolKind[];
  /** Air-gap-safe MCP servers (from the vetted MCP catalog). */
  mcpServers: McpCatalogEntry[];
  /** Whether Gov AOAI direct (*.openai.azure.us) is the model backend. */
  govAoaiDirect: boolean;
}

/**
 * The Tier-0 air-gap-safe tool catalog: the native in-VNet tool kinds plus the
 * air-gap-safe MCP servers from the vetted catalog (zero external calls). This is
 * the selectable tool surface for a sovereign / air-gap agent — everything here
 * runs entirely inside the VNet boundary. `govAoaiDirect` reflects whether the
 * deployment reaches Azure OpenAI on the Gov host directly.
 */
export function tier0ToolCatalog(govAoaiDirect: boolean): Tier0Catalog {
  return {
    nativeKinds: [...TIER0_NATIVE_TOOL_KINDS],
    mcpServers: airGapSafeServers(),
    govAoaiDirect,
  };
}

/** True when a native tool kind is Tier-0 air-gap-safe (in-VNet, no egress). */
export function isTier0NativeKind(kind: AgentToolKind): boolean {
  return (TIER0_NATIVE_TOOL_KINDS as readonly string[]).includes(kind);
}

// ---------------------------------------------------------------------------
// Per-agent MCP scoping
// ---------------------------------------------------------------------------

/** A tenant MCP server row as scoping needs it (subset of McpServerConfig). */
export interface ScopableMcpServer {
  name: string;
  endpoint?: string;
  catalogId?: string;
  id?: string;
}

/** Result of scoping the tenant's MCP servers down to one agent's grant. */
export interface McpScopeResult<T extends ScopableMcpServer> {
  /** The servers this agent is permitted to call. */
  allowed: T[];
  /** Servers dropped because the egress profile forbids them (e.g. non-air-gap-safe
   *  server on an air-gap agent) — surfaced as honest per-server gates. */
  blockedByProfile: Array<{ server: T; reason: string }>;
}

const AIR_GAP_SAFE_CATALOG_IDS = new Set(
  MCP_CATALOG.filter((e) => e.airGapSafe).map((e) => e.id),
);

/**
 * Scope the tenant's enabled MCP servers down to exactly the set a single agent may
 * call: intersect with `agent.mcpServerIds` (matched by catalogId / id / name), then
 * — when the agent's egress profile is `air-gap` — drop any server that is not
 * air-gap-safe (its egress would leave the boundary). Returns the allowed set plus
 * the profile-blocked set so the caller can surface an honest gate instead of a
 * silent drop (no-vaporware.md).
 */
export function scopeMcpServersForAgent<T extends ScopableMcpServer>(
  agent: Pick<MeshAgentDef, 'mcpServerIds' | 'egressProfile'>,
  tenantServers: T[],
): McpScopeResult<T> {
  const grant = new Set(agent.mcpServerIds);
  const allowed: T[] = [];
  const blockedByProfile: Array<{ server: T; reason: string }> = [];
  if (grant.size === 0) return { allowed, blockedByProfile };
  for (const srv of tenantServers) {
    const ids = [srv.catalogId, srv.id, srv.name].filter(Boolean).map(String);
    if (!ids.some((i) => grant.has(i))) continue;
    if (agent.egressProfile === 'air-gap') {
      const catId = srv.catalogId ? String(srv.catalogId) : '';
      if (!catId || !AIR_GAP_SAFE_CATALOG_IDS.has(catId)) {
        blockedByProfile.push({
          server: srv,
          reason: `MCP server "${srv.name}" is not air-gap-safe (reaches outside the VNet), so it is refused for an air-gap agent. Use a Tier-0 air-gap-safe server, or move this agent to a gov/commercial profile.`,
        });
        continue;
      }
    }
    allowed.push(srv);
  }
  return { allowed, blockedByProfile };
}

// ---------------------------------------------------------------------------
// Egress classification (fail-closed for air-gap)
// ---------------------------------------------------------------------------

/** Azure Government / gov-internal host suffixes reachable on a `gov` profile. */
const GOV_INTERNAL_SUFFIXES = [
  'azure.us', // openai.azure.us, *.blob.core.usgovcloudapi.net handled below
  'usgovcloudapi.net',
  'microsoftonline.us',
  'usgovtrafficmanager.net',
  'azure-api.us',
  'applicationinsights.us',
];

/** Commercial-cloud hosts a `gov` profile must NOT reach (would cross boundary). */
const COMMERCIAL_ONLY_SUFFIXES = [
  'openai.azure.com',
  'microsoftonline.com',
  'api.fabric.microsoft.com',
  'api.powerbi.com',
];
function isCommercialOnlyHost(host: string): boolean {
  // Exact-or-dotted-subdomain match (never a bare substring endsWith, which would
  // treat `notopenai.azure.com` as a match) — same discipline as matchesSuffix.
  return matchesSuffix(host, COMMERCIAL_ONLY_SUFFIXES);
}

export interface EgressDecision {
  allowed: boolean;
  reason: string;
}

function normHost(raw: string): string {
  let h = String(raw || '').trim().toLowerCase();
  try {
    if (h.includes('://')) h = new URL(h).hostname;
  } catch {
    /* not a URL — treat as bare host */
  }
  return h.replace(/\.$/, '');
}

function matchesSuffix(host: string, suffixes: string[]): boolean {
  return suffixes.some((s) => {
    const suf = s.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
    return !!suf && (host === suf || host.endsWith('.' + suf));
  });
}

/**
 * Decide whether a mesh agent on `profile` may make an OUTBOUND external call to
 * `host`. FAIL-CLOSED for air-gap: nothing external is permitted unless the operator
 * has explicitly allow-listed its suffix (`allowSuffixes`, from LOOM_A2A_EGRESS_ALLOW
 * / LOOM_MCP_EGRESS_ALLOW). This is the sovereign guarantee — an empty allow-list on
 * an air-gap agent blocks ALL egress.
 *
 *   - allow-listed suffix → allowed (operator opt-in) on every profile.
 *   - commercial          → allowed.
 *   - gov                 → allowed for gov-internal hosts; refused for commercial-cloud hosts.
 *   - air-gap             → refused (fail-closed) unless allow-listed.
 *
 * PURE — resolves nothing over the network (DNS SSRF pinning is layered on top by
 * the runtime egress guard, mcp-egress-guard.ts).
 */
export function classifyMeshEgress(
  profile: MeshEgressProfile,
  host: string,
  allowSuffixes: string[],
): EgressDecision {
  const h = normHost(host);
  if (!h) return { allowed: false, reason: 'no host to evaluate' };

  // Operator allow-list wins on every profile (explicit opt-in).
  if (matchesSuffix(h, allowSuffixes)) {
    return { allowed: true, reason: `host "${h}" is on the mesh egress allow-list` };
  }

  if (profile === 'commercial') {
    return { allowed: true, reason: `commercial profile permits external egress to "${h}"` };
  }

  if (profile === 'gov') {
    if (isCommercialOnlyHost(h)) {
      return {
        allowed: false,
        reason: `gov profile refuses commercial-cloud host "${h}" — use the Azure Government equivalent (*.azure.us) or add its suffix to LOOM_A2A_EGRESS_ALLOW.`,
      };
    }
    if (matchesSuffix(h, GOV_INTERNAL_SUFFIXES)) {
      return { allowed: true, reason: `gov profile permits Azure Government host "${h}"` };
    }
    return {
      allowed: false,
      reason: `gov profile refuses non-gov external host "${h}" — add its suffix to LOOM_A2A_EGRESS_ALLOW to permit it.`,
    };
  }

  // air-gap — FAIL-CLOSED.
  return {
    allowed: false,
    reason: `air-gap profile refuses ALL external egress (host "${h}") — nothing may leave the boundary. Add the host suffix to LOOM_A2A_EGRESS_ALLOW only if an approved in-boundary proxy exists.`,
  };
}

// ---------------------------------------------------------------------------
// Inter-agent structural policy (the sovereignty rules, PDP-independent)
// ---------------------------------------------------------------------------

export interface InterAgentPolicyCtx {
  /** True when the CALLER is an EXTERNAL agent delegating IN via the A2A hub. */
  external?: boolean;
}

export interface InterAgentDecision {
  effect: 'allow' | 'deny';
  reason: string;
}

/**
 * The STRUCTURAL inter-agent policy applied on EVERY hop, independent of (and
 * BEFORE) the PDP. These are the hard sovereignty rules that must hold regardless
 * of policy-bundle state — a deny here is final:
 *
 *   1. An EXTERNAL agent (A2A delegate-in) may only invoke a mesh agent that
 *      explicitly `publishA2A` — otherwise the agent is not exposed to the hub.
 *   2. NO BOUNDARY DOWNGRADE: an air-gap caller may not delegate to a
 *      commercial-profile callee (that callee could egress, breaking the
 *      boundary the air-gap caller runs under). Gov may not downgrade to
 *      commercial either.
 *
 * Everything else is allowed here (default-on), leaving fine-grained data-access
 * decisions to the PDP layer composed on top. PURE + fully unit-tested.
 */
export function meshInterAgentPolicy(
  caller: MeshAgentDef,
  callee: MeshAgentDef,
  ctx: InterAgentPolicyCtx = {},
): InterAgentDecision {
  if (ctx.external && !callee.publishA2A) {
    return {
      effect: 'deny',
      reason: `Agent "${callee.name}" is not published to the A2A hub — external delegation refused.`,
    };
  }
  const rank: Record<MeshEgressProfile, number> = { 'air-gap': 0, gov: 1, commercial: 2 };
  if (rank[callee.egressProfile] > rank[caller.egressProfile]) {
    return {
      effect: 'deny',
      reason: `Boundary downgrade refused: a ${caller.egressProfile} agent may not delegate to a ${callee.egressProfile} agent (the callee could egress outside the caller's boundary).`,
    };
  }
  return { effect: 'allow', reason: `structural policy permits ${caller.kind} → ${callee.kind} delegation` };
}

// ---------------------------------------------------------------------------
// A2A hub — agent cards
// ---------------------------------------------------------------------------
/** An A2A "skill" advertised on an agent card. */
export interface A2ASkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

/**
 * An A2A agent card (the well-known `agent.json` an external ADK / Foundry agent
 * fetches to discover a Loom mesh agent and delegate a task to it). Shaped to the
 * A2A agent-card schema (name / description / url / provider / capabilities /
 * skills). Loom publishes these OUT so external agents can delegate IN — every
 * inbound call is still policy-checked + audited by the mesh runner.
 */
export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  provider: { organization: string; url?: string };
  capabilities: { streaming: boolean; pushNotifications: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2ASkill[];
  /** Loom extension: the egress profile this agent runs under (sovereignty signal). */
  loomEgressProfile: MeshEgressProfile;
}

/** Build the A2A agent card for a mesh agent (published at /api/mesh/a2a/[id]/card). */
export function buildA2AAgentCard(agent: MeshAgentDef, baseUrl: string): A2AAgentCard {
  const url = `${baseUrl.replace(/\/$/, '')}/api/mesh/a2a/${encodeURIComponent(agent.id)}`;
  const skill: A2ASkill = {
    id: `delegate-${agent.kind}`,
    name: `${agent.name} task`,
    description:
      agent.description ||
      `Delegate a natural-language task to the "${agent.name}" ${agent.kind} agent. It answers grounded on its in-VNet tools; the result is policy-governed.`,
    tags: [agent.kind, 'loom', 'governed', agent.egressProfile],
  };
  return {
    name: agent.name,
    description: skill.description,
    url,
    version: '1.0.0',
    provider: { organization: 'CSA Loom — Sovereign Agent Mesh' },
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [skill],
    loomEgressProfile: agent.egressProfile,
  };
}
