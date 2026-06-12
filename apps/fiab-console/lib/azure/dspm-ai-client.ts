/**
 * dspm-ai-client — DSPM for AI posture: which agents / Copilots touch
 * sensitive-labeled data (Fabric Build 2026 #34).
 *
 * This is the Azure-native 1:1 of Microsoft Purview DSPM for AI →
 * "Discover › Apps and agents": for every AI agent in the estate it surfaces
 * the sensitivity labels of the data it is grounded on, how much it is used,
 * and whether the most-sensitive data it touches is protected (RMS/AIP).
 *
 * Backends (NO Microsoft Fabric / Power BI dependency):
 *   - Cosmos `items`/`workspaces` — the data-agent items + every item's bound
 *     `state.sensitivityLabel` (the label-exposure join is pure Cosmos).
 *   - Microsoft Graph Information Protection — label ordering (sensitivity
 *     ordinal) + protection flag, via `listSensitivityLabels()`. Degrades to a
 *     static label rank + a `gates.mip` hint when MIP is unconfigured.
 *   - Azure Monitor Log Analytics — real per-agent usage (call count + last
 *     used) from the `copilot.usage` custom events the data-agent chat path now
 *     emits with an `agent_id` dimension. Degrades to a `gates.usage` hint when
 *     the Log Analytics workspace is unset (the label-exposure report still
 *     renders — usage columns are simply blank).
 *
 * The only HARD gate is `LOOM_COSMOS_ENDPOINT` (no estate ⇒ no report).
 * Per .claude/rules/no-vaporware.md every absent backend is an honest gate, not
 * a mock. Auth for all reads is owned by the wrapped clients (cosmos-client /
 * mip-graph-client / monitor-client), each using the Console UAMI
 * ChainedTokenCredential — cloud-agnostic (Commercial / GCC / GCC-High / IL5).
 */

import { workspacesContainer, itemsContainer } from './cosmos-client';
import { listSensitivityLabels, MipNotConfiguredError, type SensitivityLabel } from './mip-graph-client';
import { queryLogs, MonitorNotConfiguredError } from './monitor-client';
import type { NotConfiguredHint } from '../components/admin-security/not-configured-bar';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One data source the agent is grounded on + the label of the bound item. */
export interface DspmAiSourceRow {
  name: string;
  type: string;
  /** Sensitivity label of the bound item, or null when unlabeled / unresolved. */
  label: string | null;
}

/** One AI agent / Copilot row in the posture report. */
export interface DspmAiAgentRow {
  agentId: string;
  agentName: string;
  workspaceId: string;
  itemType: string;
  sources: DspmAiSourceRow[];
  totalSourceCount: number;
  /** Sources whose bound item carries a sensitivity label. */
  sensitiveSourceCount: number;
  /** Distinct labels the agent touches + how many of its sources carry each. */
  labelDistribution: { label: string; count: number }[];
  /** Highest-ranked label across all touched sources (null = touches nothing labeled). */
  maxLabel: string | null;
  /** True when `maxLabel` is a protected (RMS/AIP-encrypted) label per Graph. */
  protected: boolean;
  /** Real usage from copilot.usage telemetry (0 when none / gated). */
  usageCalls: number;
  /** ISO timestamp of the agent's most recent Copilot call (null = none / gated). */
  lastUsedAt: string | null;
}

export interface DspmAiSummary {
  agentCount: number;
  agentsTouchingSensitive: number;
  /** Per-label: how many agents touch data carrying that label. */
  labelCounts: { label: string; agents: number; protected: boolean }[];
  /** True when usage metering is gated (Monitor unconfigured) — usage cols blank. */
  usageGated: boolean;
  windowDays: number;
}

export interface DspmAiResult {
  agents: DspmAiAgentRow[];
  summary: DspmAiSummary;
  gates: Partial<Record<'mip' | 'usage', NotConfiguredHint>>;
  source: 'live';
  updatedAt: string;
}

/** Thrown when LOOM_COSMOS_ENDPOINT is unset — the whole surface gates. */
export class DspmAiNotConfiguredError extends Error {
  hint: NotConfiguredHint;
  constructor(hint: NotConfiguredHint) {
    super(`DSPM for AI is not wired in this deployment: missing ${hint.missingEnvVar}`);
    this.hint = hint;
  }
}

// ---------------------------------------------------------------------------
// Label ranking — Graph ordinal first, deterministic static fallback otherwise
// ---------------------------------------------------------------------------

/** Static fallback rank for common label names when Graph (MIP) is gated. */
const STATIC_LABEL_RANK: Array<[string, number]> = [
  ['top secret', 6],
  ['secret', 5],
  ['restricted', 4],
  ['highly confidential', 4],
  ['confidential', 3],
  ['internal', 2],
  ['general', 1],
  ['public', 0],
];

function staticRank(name: string): number {
  const n = name.toLowerCase();
  for (const [needle, rank] of STATIC_LABEL_RANK) {
    if (n.includes(needle)) return rank;
  }
  return 1; // unknown labels are treated as ~Internal so they aren't ignored
}

interface LabelMeta {
  /** Higher = more sensitive. */
  rank: number;
  protected: boolean;
}

/** Build a case-insensitive name→meta map from the tenant's Graph labels. */
function buildLabelIndex(labels: SensitivityLabel[]): Map<string, LabelMeta> {
  const m = new Map<string, LabelMeta>();
  for (const l of labels) {
    const name = (l.name || l.displayName || '').trim();
    if (!name) continue;
    // Graph `sensitivity` is the ordinal priority (higher = more sensitive).
    const rank = typeof l.sensitivity === 'number' ? l.sensitivity : staticRank(name);
    m.set(name.toLowerCase(), { rank, protected: !!l.hasProtection });
  }
  return m;
}

function metaFor(label: string, idx: Map<string, LabelMeta> | null): LabelMeta {
  const hit = idx?.get(label.toLowerCase());
  if (hit) return hit;
  return { rank: staticRank(label), protected: false };
}

/** Pick the highest-ranked label from a set (null when empty). */
function pickMaxLabel(labels: string[], idx: Map<string, LabelMeta> | null): string | null {
  let best: string | null = null;
  let bestRank = -1;
  for (const l of labels) {
    const r = metaFor(l, idx).rank;
    if (r > bestRank) { bestRank = r; best = l; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Estate label index — id/name → sensitivity label (the exposure join key)
// ---------------------------------------------------------------------------

interface EstateItem {
  id: string;
  displayName?: string;
  itemType?: string;
  workspaceId?: string;
  state?: Record<string, any>;
}

/** Load every item in the tenant's workspaces (state carries label + sources). */
async function loadTenantItems(tenantId: string): Promise<EstateItem[]> {
  const wsC = await workspacesContainer();
  const itC = await itemsContainer();

  const { resources: workspaces } = await wsC.items.query<{ id: string }>({
    query: 'SELECT c.id FROM c WHERE c.tenantId = @t',
    parameters: [{ name: '@t', value: tenantId }],
  }, { partitionKey: tenantId }).fetchAll();
  const wsIds = workspaces.map((w) => w.id);
  if (!wsIds.length) return [];

  const { resources } = await itC.items.query<EstateItem>({
    query: 'SELECT c.id, c.displayName, c.itemType, c.workspaceId, c.state FROM c WHERE ARRAY_CONTAINS(@w, c.workspaceId) AND (NOT IS_DEFINED(c.state._recycled) OR c.state._recycled = null)',
    parameters: [{ name: '@w', value: wsIds }],
  }).fetchAll();
  return resources;
}

/** name/id → label lookup so an agent source resolves to its bound item label. */
function buildExposureIndex(items: EstateItem[]): { byId: Map<string, string>; byName: Map<string, string> } {
  const byId = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const it of items) {
    const label = it.state?.sensitivityLabel;
    if (!label) continue;
    if (it.id) byId.set(it.id, label);
    if (it.displayName) byName.set(it.displayName.toLowerCase(), label);
  }
  return { byId, byName };
}

function resolveSourceLabel(
  src: { id?: string; name?: string },
  idx: { byId: Map<string, string>; byName: Map<string, string> },
): string | null {
  if (src.id && idx.byId.has(src.id)) return idx.byId.get(src.id)!;
  if (src.name && idx.byName.has(src.name.toLowerCase())) return idx.byName.get(src.name.toLowerCase())!;
  return null;
}

/**
 * Resolve the distinct sensitivity labels a set of agent sources touch + the
 * highest-ranked one. Used by the data-agent chat path to stamp the
 * `copilot.usage` telemetry with the data dimension (fire-and-forget, so the
 * label rank uses the static fallback to avoid a Graph round-trip on the hot
 * path). Returns `{ labels: [], maxLabel: null }` when nothing is labeled.
 */
export async function resolveAgentSourceLabels(
  tenantId: string,
  sources: Array<{ id?: string; name?: string }>,
): Promise<{ labels: string[]; maxLabel: string | null }> {
  if (!process.env.LOOM_COSMOS_ENDPOINT || !sources.length) return { labels: [], maxLabel: null };
  try {
    const items = await loadTenantItems(tenantId);
    const idx = buildExposureIndex(items);
    const labels = Array.from(new Set(
      sources.map((s) => resolveSourceLabel(s, idx)).filter((l): l is string => !!l),
    ));
    return { labels, maxLabel: pickMaxLabel(labels, null) };
  } catch {
    return { labels: [], maxLabel: null };
  }
}

// ---------------------------------------------------------------------------
// Usage join — real per-agent call volume from copilot.usage telemetry
// ---------------------------------------------------------------------------

interface AgentUsage { calls: number; lastUsedAt: string | null }

const USAGE_GATE_HINT: NotConfiguredHint = {
  missingEnvVar: 'LOOM_LOG_ANALYTICS_WORKSPACE_ID',
  bicepModule: 'platform/fiab/bicep/modules/admin-plane/monitoring.bicep',
  bicepStatus: 'Deploys the Log Analytics workspace + grants the Console UAMI Log Analytics Reader. Wire LOOM_LOG_ANALYTICS_WORKSPACE_ID into the apps[].env list.',
  rolesRequired: [{
    name: 'Log Analytics Reader',
    scope: 'Loom Log Analytics workspace',
    reason: 'Read the copilot.usage events to attribute Copilot calls + sensitive-data access to each agent.',
  }],
  followUp: 'Set LOOM_LOG_ANALYTICS_WORKSPACE_ID to the workspace customerId (GUID). Per-agent usage appears after the next real data-agent chat call (the agent_id dimension is emitted by the chat path). For GCC-High/IL5 also set LOOM_LOG_ANALYTICS_ENDPOINT=https://api.loganalytics.us.',
};

async function computeAgentUsage(days: number): Promise<{ byAgent: Map<string, AgentUsage>; gate?: NotConfiguredHint }> {
  const kql = `AppEvents
| where Name == "copilot.usage"
| extend agent_id = tostring(Properties.agent_id)
| where isnotempty(agent_id)
| summarize calls = count(), lastUsed = max(TimeGenerated) by agent_id`;
  try {
    const res = await queryLogs(kql, `P${days}D`);
    const ai = res.columns.indexOf('agent_id');
    const ci = res.columns.indexOf('calls');
    const li = res.columns.indexOf('lastUsed');
    const byAgent = new Map<string, AgentUsage>();
    for (const row of res.rows) {
      const id = String(ai >= 0 ? row[ai] ?? '' : '');
      if (!id) continue;
      const last = li >= 0 ? row[li] : null;
      byAgent.set(id, {
        calls: Number(ci >= 0 ? row[ci] ?? 0 : 0) || 0,
        lastUsedAt: last ? new Date(String(last)).toISOString() : null,
      });
    }
    return { byAgent };
  } catch (e) {
    if (e instanceof MonitorNotConfiguredError) return { byAgent: new Map(), gate: USAGE_GATE_HINT };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function assertCosmosConfigured(): void {
  if (!process.env.LOOM_COSMOS_ENDPOINT) {
    throw new DspmAiNotConfiguredError({
      missingEnvVar: 'LOOM_COSMOS_ENDPOINT',
      bicepModule: 'platform/fiab/bicep/modules/admin-plane/main.bicep',
      bicepStatus: 'Deploys the Cosmos account + database and wires LOOM_COSMOS_ENDPOINT into the Console app. Grant the Console UAMI the Cosmos DB Built-in Data Contributor role.',
      followUp: 'Set LOOM_COSMOS_ENDPOINT to the Cosmos account URI (https://<account>.documents.azure.com:443/).',
    });
  }
}

/**
 * Loom item types that are AI agents / Copilots grounding on data sources —
 * the equivalent of the "Apps and agents" inventory in Microsoft Purview
 * DSPM for AI. Each grounds on data via `state.sources` (resolved to the
 * bound item's sensitivity label below):
 *   - data-agent       — conversational Q&A grounded on warehouse/lakehouse/semantic models
 *   - operations-agent — monitors items/workspaces/streams + recommends actions (preview)
 *   - prompt-flow      — LLM/tool graph that can ground on data sources
 * Scoping to only `data-agent` previously made the report show "no AI agents"
 * for tenants that had prompt-flows / operations-agents — an under-count vs.
 * the report's own "every agent in the estate" promise. Override the set with
 * a comma-separated LOOM_DSPM_AI_AGENT_ITEM_TYPES if the estate models agents
 * under additional item types.
 */
const DEFAULT_AGENT_ITEM_TYPES = ['data-agent', 'operations-agent', 'prompt-flow'];
const AGENT_ITEM_TYPES = new Set(
  (process.env.LOOM_DSPM_AI_AGENT_ITEM_TYPES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .concat(DEFAULT_AGENT_ITEM_TYPES),
);

/**
 * Compute the DSPM-for-AI posture for one tenant: every AI agent, the
 * sensitivity labels of the data it touches, its real usage, and whether the
 * most-sensitive data is protected. Live from Cosmos + Graph + Monitor; each
 * non-Cosmos source degrades to a `gates[...]` entry.
 */
export async function computeDspmAiPosture(tenantId: string, days = 30): Promise<DspmAiResult> {
  assertCosmosConfigured();

  const items = await loadTenantItems(tenantId);
  const exposureIdx = buildExposureIndex(items);

  // Graph label ordering / protection (gated → static rank, protected=false).
  let labelIndex: Map<string, LabelMeta> | null = null;
  let mipGate: NotConfiguredHint | undefined;
  try {
    const labels = await listSensitivityLabels();
    labelIndex = buildLabelIndex(labels);
  } catch (e) {
    if (e instanceof MipNotConfiguredError) { mipGate = e.hint; }
    else throw e;
  }

  // Real per-agent usage (gated → blank usage columns).
  const usage = await computeAgentUsage(days);

  const agents: DspmAiAgentRow[] = [];
  for (const it of items) {
    if (!AGENT_ITEM_TYPES.has(String(it.itemType))) continue;
    const rawSources = Array.isArray(it.state?.sources) ? (it.state!.sources as any[]) : [];
    const sources: DspmAiSourceRow[] = rawSources.map((s) => ({
      name: String(s?.name || s?.id || 'source'),
      type: String(s?.type || 'unknown'),
      label: resolveSourceLabel({ id: s?.id ? String(s.id) : undefined, name: s?.name ? String(s.name) : undefined }, exposureIdx),
    }));

    const touched = sources.map((s) => s.label).filter((l): l is string => !!l);
    const distMap = new Map<string, number>();
    for (const l of touched) distMap.set(l, (distMap.get(l) || 0) + 1);
    const labelDistribution = Array.from(distMap.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => metaFor(b.label, labelIndex).rank - metaFor(a.label, labelIndex).rank);
    const maxLabel = pickMaxLabel(touched, labelIndex);
    const u = usage.byAgent.get(it.id);

    agents.push({
      agentId: it.id,
      agentName: it.displayName || it.id,
      workspaceId: it.workspaceId || '',
      itemType: String(it.itemType),
      sources,
      totalSourceCount: sources.length,
      sensitiveSourceCount: touched.length,
      labelDistribution,
      maxLabel,
      protected: maxLabel ? metaFor(maxLabel, labelIndex).protected : false,
      usageCalls: u?.calls ?? 0,
      lastUsedAt: u?.lastUsedAt ?? null,
    });
  }

  // Sort: most-sensitive first, then most-used.
  agents.sort((a, b) => {
    const ra = a.maxLabel ? metaFor(a.maxLabel, labelIndex).rank : -1;
    const rb = b.maxLabel ? metaFor(b.maxLabel, labelIndex).rank : -1;
    if (rb !== ra) return rb - ra;
    return b.usageCalls - a.usageCalls;
  });

  // Per-label agent counts for the summary.
  const labelAgentMap = new Map<string, { agents: number; protected: boolean }>();
  for (const a of agents) {
    for (const { label } of a.labelDistribution) {
      const cur = labelAgentMap.get(label) || { agents: 0, protected: metaFor(label, labelIndex).protected };
      cur.agents += 1;
      labelAgentMap.set(label, cur);
    }
  }
  const labelCounts = Array.from(labelAgentMap.entries())
    .map(([label, v]) => ({ label, agents: v.agents, protected: v.protected }))
    .sort((a, b) => metaFor(b.label, labelIndex).rank - metaFor(a.label, labelIndex).rank);

  const gates: DspmAiResult['gates'] = {};
  if (mipGate) gates.mip = mipGate;
  if (usage.gate) gates.usage = usage.gate;

  return {
    agents,
    summary: {
      agentCount: agents.length,
      agentsTouchingSensitive: agents.filter((a) => a.sensitiveSourceCount > 0).length,
      labelCounts,
      usageGated: !!usage.gate,
      windowDays: days,
    },
    gates,
    source: 'live',
    updatedAt: new Date().toISOString(),
  };
}
