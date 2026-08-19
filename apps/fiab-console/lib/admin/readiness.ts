/**
 * CSA Loom — Readiness UX compute (WS-H).
 *
 * PURE derivation layer for the /admin/readiness surface. Given the REAL gate
 * registry state (lib/gates/registry.ts — GATES + allGateStatuses(), the exact
 * env-presence checks the per-client *ConfigGate() helpers gate on) and the
 * REAL live health probes (lib/admin/health-probes.ts via the self-audit run),
 * this module computes:
 *
 *   H1  Capability dependency graph — one node per capability (gate) carrying
 *       its backend deps (owning surfaces), required env vars (present/missing),
 *       RBAC role, provisioning bicep module, live probe status, and the exact
 *       unmet prerequisites + fix path when blocked.
 *   H2  Workload readiness scorecard — capabilities grouped into named
 *       workloads (Data Integration, Real-Time Intelligence, Governance, AI &
 *       Copilot, …). Each workload gets a Ready / Partial / Blocked go/no-go
 *       computed ONLY from the live gate + probe state, with drill-down to the
 *       failing capabilities and their remediation.
 *   H3  Ready-to-run tenant profile — a machine-readable (JSON) + human-readable
 *       (markdown) export of the whole posture: which capabilities are ready,
 *       which are gated, and the exact remediation for each.
 *
 * NO synthetic status (no-vaporware.md): every state is derived from data the
 * caller passes in. A capability with no live probe is honestly marked
 * verified:'config-only' (env-presence verified, not exercised end-to-end) —
 * never a fabricated live green. This module reads NO process.env and performs
 * NO I/O, so it is fully unit-testable (lib/admin/__tests__/readiness.test.ts).
 */
import type { AuditCategory, AuditSeverity, AuditStatus } from './env-checks';
import type { FixitKind, GateDef, GateStatus } from '@/lib/gates/registry';

// ── public types ─────────────────────────────────────────────────────────────

/**
 * Go/no-go readiness of a single capability or a whole workload.
 *
 * `unknown` is a capability-only state and it is deliberately NOT a synonym for
 * `partial`: it means the live probe did not finish, so nothing at all was
 * established — neither that the backend works nor that it is broken
 * (deploy-integrity.md R7). It exists because #3729 measured the alternative:
 * a 6 s ARM-probe timeout was scored `blocked` with an invented connectivity
 * diagnosis, which took the whole Core platform workload no-go on a fact that
 * had never been observed.
 */
export type ReadinessState = 'ready' | 'partial' | 'blocked' | 'opt-in' | 'unknown';

/** How a 'ready' capability was verified. */
export type VerifiedBy = 'live-probe' | 'config-only';

export interface RequiredEnv {
  envVar: string;
  /** True when part of a `required` group (vs an anyOf alternative). */
  required: boolean;
  /** True when the value is present in the running deployment. */
  present: boolean;
}

export interface ProbeSummary {
  id: string;
  status: AuditStatus;
  detail: string;
  remediation?: string;
  /** True when the probe did not complete — its result establishes NOTHING. */
  inconclusive?: boolean;
}

/** Minimal probe input shape (a self-audit CheckResult, narrowed). */
export interface ProbeLite {
  id: string;
  status: AuditStatus;
  detail: string;
  remediation?: string;
  inconclusive?: boolean;
}

export interface CapabilityNode {
  id: string;
  title: string;
  category: AuditCategory;
  severity: AuditSeverity;
  /** Go/no-go for this capability. */
  state: ReadinessState;
  /** For a 'ready' node: whether a live probe confirmed it or only config presence. */
  verified: VerifiedBy;
  /** The raw env-presence gate status the feature actually gates on. */
  gateStatus: 'configured' | 'blocked' | 'opt-in';
  /** Missing env vars (the exact unmet prerequisites). */
  missing: string[];
  /** Every env var / alias that satisfies the gate, with live presence. */
  requiredEnv: RequiredEnv[];
  /** Backend surfaces this capability powers (feature → backend dependency). */
  backends: string[];
  /** The exact RBAC role / tenant action needed once values are set. */
  role?: string;
  /** The bicep module that wires this on a push-button deploy. */
  provisionedBy?: string;
  /** Exact operator remediation for the blocked/partial state. */
  remediation: string;
  /** Live probe result mapped to this capability (null when none exists). */
  probe: ProbeSummary | null;
  /** How the inline Fix-it wizard resolves this gate. */
  fixitKind: FixitKind;
  /** True when a push-button deploy auto-fills the values (zero operator input). */
  canAutoResolve: boolean;
}

export interface WorkloadBlocker {
  id: string;
  title: string;
  /**
   * The capability's readiness state.
   *
   * Carried explicitly because `blockers` enumerates every NON-READY
   * capability, and those are not all the same thing: `blocked` is a proven
   * unmet prerequisite, `partial` is degraded-but-observed, `unknown` is a
   * live check that never completed, and `opt-in` is a feature deliberately
   * not deployed. Without this field the exported profile filed all four under
   * one "Blocked" heading — so a report handed to an auditor during a slow ARM
   * window read as an outage (#3729).
   */
  state: ReadinessState;
  missing: string[];
  remediation: string;
  role?: string;
  provisionedBy?: string;
}

export interface WorkloadScore {
  id: string;
  title: string;
  /** One-line description of the workload. */
  description: string;
  /** Emoji/glyph hint for the tile (rendered as a Fluent icon by the page). */
  glyph: string;
  state: ReadinessState;
  /** 0–100, severity-weighted (ready=1, partial=0.5, blocked=0). */
  score: number;
  summary: { ready: number; partial: number; blocked: number; unknown: number; total: number };
  /** Capability (gate) ids composing this workload that exist in the registry. */
  capabilityIds: string[];
  /** The blocked/partial capabilities, with their remediation, for drill-down. */
  blockers: WorkloadBlocker[];
}

export interface ReadinessInput {
  gates: GateDef[];
  statuses: GateStatus[];
  probes: ProbeLite[];
}

export interface ReadinessSummary {
  capabilities: { ready: number; partial: number; blocked: number; unknown: number; total: number };
  workloads: { ready: number; partial: number; blocked: number; total: number };
  /** 0–100 overall severity-weighted capability score. */
  score: number;
  /** Number of capabilities whose 'ready' rests on config presence only (not live-probed). */
  configOnly: number;
}

export interface ReadinessReport {
  generatedAt: string;
  cloud?: string;
  summary: ReadinessSummary;
  workloads: WorkloadScore[];
  capabilities: CapabilityNode[];
}

export interface TenantEnvironment {
  app?: string;
  subscription?: string;
  adminResourceGroup?: string;
  dlzResourceGroup?: string;
  tenant?: string;
  cloud?: string;
}

export interface TenantProfile extends ReadinessReport {
  environment: TenantEnvironment;
  /** Every gated capability with the exact remediation (H3 "failed dependencies"). */
  blockers: WorkloadBlocker[];
}

// ── workload registry (H2) ───────────────────────────────────────────────────
// Named workloads → the capability (gate) ids that compose them. Ids reference
// the REAL gate registry; readiness.test.ts asserts every id exists in GATES so
// this map can never silently drift from the registry. A capability may belong
// to more than one workload (e.g. Synapse powers both Data Integration and Data
// Engineering) — each workload aggregates independently.

export interface WorkloadDef {
  id: string;
  title: string;
  description: string;
  glyph: string;
  capabilityIds: string[];
}

export const WORKLOADS: WorkloadDef[] = [
  {
    id: 'core-platform',
    title: 'Core platform',
    description: 'Identity, the Loom store, and ARM access every workload depends on.',
    glyph: '🧩',
    capabilityIds: ['session-secret', 'entra-app', 'uami', 'cosmos-config', 'subscription', 'bootstrap-admin'],
  },
  {
    id: 'data-integration',
    title: 'Data Integration',
    description: 'Pipelines, mirroring CDC, and integration runtimes (Data Factory family).',
    glyph: '🔀',
    capabilityIds: ['svc-synapse', 'svc-adf', 'svc-shir', 'svc-approval-logicapp', 'svc-param-sources', 'svc-copyjob-control', 'svc-csv-imports'],
  },
  {
    id: 'data-engineering',
    title: 'Data Engineering',
    description: 'Lakehouse, warehouse, Spark, and medallion layers.',
    glyph: '🏗️',
    capabilityIds: ['svc-adls', 'svc-synapse', 'svc-databricks', 'svc-synapse-spark-pool', 'svc-medallion-layers', 'svc-data-wrangler', 'svc-lakebase', 'svc-warp-engine'],
  },
  {
    id: 'real-time-intelligence',
    title: 'Real-Time Intelligence',
    description: 'Eventstreams, KQL/Eventhouse, activators, and streaming alerts.',
    glyph: '⚡',
    capabilityIds: ['svc-adx', 'svc-eventhubs', 'svc-stream-analytics', 'svc-eventgrid-topics', 'svc-rti-export', 'svc-activator-adx-scope', 'svc-monitor-alerts'],
  },
  {
    id: 'governance',
    title: 'Governance & Security',
    description: 'Purview catalog, sensitivity labels, DLP, and audit posture.',
    glyph: '🛡️',
    capabilityIds: ['purview', 'svc-purview-uc', 'svc-mip', 'svc-dlp', 'svc-onelake-acl', 'audit-la-workspace', 'svc-audit-siem-stream'],
  },
  {
    id: 'ai-copilot',
    title: 'AI & Copilot',
    description: 'Azure OpenAI, RAG indexes, embeddings, and the Copilot / MCP surface.',
    glyph: '✨',
    capabilityIds: ['svc-aoai', 'svc-aisearch', 'svc-aoai-embeddings', 'svc-ai-enrich', 'svc-learning-hub', 'svc-mcp-catalog', 'svc-iq-mcp'],
  },
  {
    id: 'business-intelligence',
    title: 'Business Intelligence',
    description: 'Semantic models, Direct Lake, DAX, and map visuals.',
    glyph: '📊',
    capabilityIds: ['svc-aas', 'svc-loom-directlake', 'svc-databricks-sql', 'svc-azure-maps'],
  },
  {
    id: 'machine-learning',
    title: 'Machine Learning',
    description: 'Azure ML workspaces, AutoML, and Spark-backed model runs.',
    glyph: '🤖',
    capabilityIds: ['svc-aml', 'svc-synapse-spark-pool'],
  },
  {
    id: 'app-development',
    title: 'App Development',
    description: 'Data API builder, user functions, published apps/APIs, and Power Platform.',
    glyph: '🧱',
    capabilityIds: ['svc-dab-runtime', 'svc-udf-function', 'svc-swa-publish', 'svc-mcp-deploy', 'svc-apim', 'svc-dataverse', 'svc-powerplatform'],
  },
  {
    id: 'eventing-messaging',
    title: 'Eventing & Messaging',
    description: 'Service Bus, Event Grid, IoT Hub, Digital Twins, and webhooks.',
    glyph: '📡',
    capabilityIds: ['svc-servicebus', 'svc-eventgrid', 'svc-webhooks-eventgrid', 'svc-iothub', 'svc-digital-twins', 'svc-eh-schema-registry'],
  },
];

// ── gate → live probe mapping ────────────────────────────────────────────────
// Which self-audit probe (lib/admin/health-probes.ts + self-audit.ts) verifies
// a given gate end-to-end. When present, its live status upgrades a configured
// capability from 'config-only' to 'live-probe' (pass) or downgrades it to
// partial/blocked (warn/fail) — catching the configured-but-broken class an env
// gate alone can't see. Gates with no probe stay verified:'config-only'.

export const GATE_PROBE_MAP: Record<string, string> = {
  'cosmos-config': 'probe-cosmos',
  subscription: 'probe-arm-reader',
  'svc-adls': 'probe-adls',
  'svc-synapse': 'probe-synapse',
  'svc-adx': 'probe-kusto',
  'svc-eventhubs': 'probe-eventhubs',
  'svc-adf': 'probe-adf',
  'svc-monitor-alerts': 'probe-log-analytics',
  'graph-users': 'probe-graph-directory',
  'svc-powerplatform': 'probe-powerplatform',
  'svc-servicebus': 'probe-servicebus',
  'svc-apim': 'probe-apim',
  'svc-keyvault': 'probe-keyvault',
  'svc-aas': 'probe-aas',
  'svc-aml': 'probe-aml',
  'svc-azure-sql': 'probe-azure-sql',
  'svc-postgres': 'probe-postgres',
  'svc-stream-analytics': 'probe-stream-analytics',
  'svc-eventgrid': 'probe-eventgrid',
  'svc-batch': 'probe-batch',
  'svc-aoai': 'probe-aoai',
  purview: 'probe-purview-datamap',
  'svc-databricks': 'probe-databricks',
  'svc-dab-runtime': 'probe-dab-runtime',
  'svc-udf-function': 'probe-udf-runtime',
  'svc-mcp-catalog': 'probe-builtin-mcp',
  // The env half of this gate can only ever observe that SOME authorization var
  // is set. It cannot see whether a DEPLOYED catalog actually rejects an
  // anonymous caller — and that is the only question worth asking (issue #2643).
  // probe-loom-unity-authz makes a real unauthenticated GET against
  // LOOM_UNITY_URL and returns fail/critical on an HTTP 200, so a catalog that
  // answers anonymous callers now drives this capability to 'blocked' with
  // verified:'live-probe' instead of resting on env presence.
  'svc-loom-unity-authz': 'probe-loom-unity-authz',
};

// ── weighting ────────────────────────────────────────────────────────────────

// There is no `optional` weight — the tier was deleted in #3347 (see the
// AuditSeverity doc in env-checks/core.ts). It weighed 1, so a blocked
// capability carrying it cost the score a third of what a blocked critical did
// while the operator was told the deploy had "wired everything up". The 113
// capabilities that held it are now `recommended` and weigh 2, which roughly
// doubled the denominator (155 → 268). The score therefore moves DOWN slightly
// at any given blocked count; that is the correction landing, not a regression.
const SEVERITY_WEIGHT: Record<AuditSeverity, number> = { critical: 3, recommended: 2 };
// 'opt-in' scores as 1 (a healthy, deliberately-not-deployed additive feature is
// NOT a deduction against the deployment — its absence removes no capability).
// 'unknown' scores as 0.5: the probe established nothing, so the score neither
// credits the capability nor condemns it. Scoring it 0 would let a transient
// timeout move the operator's headline number (#3729); scoring it 1 would hide
// a real outage behind a check that never completed.
const STATE_VALUE: Record<ReadinessState, number> = { ready: 1, partial: 0.5, blocked: 0, 'opt-in': 1, unknown: 0.5 };

// ── H1: capability nodes ─────────────────────────────────────────────────────

/**
 * Build the capability dependency graph nodes from the live gate + probe state.
 * Pure: every field is derived from the passed-in registry state.
 */
export function buildCapabilityNodes(input: ReadinessInput): CapabilityNode[] {
  const statusById = new Map(input.statuses.map((s) => [s.id, s]));
  const probeById = new Map(input.probes.map((p) => [p.id, p]));

  return input.gates.map((g) => {
    const st = statusById.get(g.id);
    // X2: 'cloud-unavailable' folds into 'blocked' for readiness purposes — the
    // node's remediation (the gate remediation / fallbackNote) stays honest.
    // 'opt-in' is preserved distinctly (issue #2753): an additive non-default
    // feature whose absence removes no capability must render neutral, not red.
    const gateStatus: 'configured' | 'blocked' | 'opt-in' =
      st?.status === 'configured' ? 'configured'
        : st?.status === 'opt-in' ? 'opt-in'
          : 'blocked';
    const missing = st?.missing ?? [];

    const requiredEnv: RequiredEnv[] = g.requiredSettings.map((rs) => ({
      envVar: rs.envVar,
      required: rs.required,
      present: !missing.includes(rs.envVar),
    }));

    const probeId = GATE_PROBE_MAP[g.id];
    const probeRaw = probeId ? probeById.get(probeId) : undefined;
    const probe: ProbeSummary | null = probeRaw
      ? { id: probeRaw.id, status: probeRaw.status, detail: probeRaw.detail, remediation: probeRaw.remediation, inconclusive: probeRaw.inconclusive }
      : null;

    // A probe that did not COMPLETE proves nothing (deploy-integrity.md R7).
    // It must never be read as a negative result — see #3729, where a 6 s ARM
    // timeout scored `blocked` with a fabricated connectivity diagnosis and
    // took the entire Core platform workload no-go.
    const probeInconclusive = !!probe && probe.status !== 'pass' && !!probe.inconclusive;
    /** Map a COMPLETED probe result onto a capability state. */
    const stateFromProbe = (p: ProbeSummary): ReadinessState =>
      p.status === 'pass' ? 'ready' : p.status === 'warn' ? 'partial' : 'blocked';

    let state: ReadinessState;
    let verified: VerifiedBy = 'config-only';
    if (gateStatus === 'opt-in') {
      // Additive opt-in feature, not deployed. Never blocked (its absence costs
      // no capability); a live probe can still upgrade it to ready if the
      // operator did opt in and the backend answers.
      if (probe?.status === 'pass') { state = 'ready'; verified = 'live-probe'; }
      else { state = 'opt-in'; }
    } else if (gateStatus === 'blocked') {
      // Missing required configuration is a hard blocker — unless the gate is a
      // fully-functional default when unset (canAutoResolve). Even then the
      // promotion is NOT unconditional: when a live probe exists its REAL result
      // decides (D15 honest-scoring — 'blocked + canAutoResolve' used to map
      // straight to 'ready' without consulting the probe, so a derived var the
      // deploy never filled scored ready while the backend answered 'fail').
      // Only a probe-less canAutoResolve gate keeps the config-only promotion.
      if (!g.canAutoResolve) {
        // The env values really ARE missing — that is established, and the
        // Fix-it env form is the correct remediation for it.
        state = 'blocked';
      } else if (probe) {
        state = probeInconclusive ? 'unknown' : stateFromProbe(probe);
        verified = 'live-probe';
      } else {
        state = 'ready';
        verified = 'config-only';
      }
    } else if (probe) {
      // Configured. The probe is the only remaining question — and when it did
      // not finish, the honest answer is 'unknown', not 'blocked'.
      state = probeInconclusive ? 'unknown' : stateFromProbe(probe);
      verified = 'live-probe';
    } else {
      // Configured, no live probe — env-presence verified but not exercised.
      state = 'ready';
      verified = 'config-only';
    }

    const remediation = state === 'blocked'
      ? (probe && probe.status === 'fail' && probe.remediation ? probe.remediation : g.remediation)
      : state === 'partial' || state === 'unknown'
        ? (probe?.remediation || g.remediation)
        : g.remediation;

    return {
      id: g.id,
      title: g.title,
      category: g.category,
      severity: g.severity,
      state,
      verified,
      gateStatus,
      missing,
      requiredEnv,
      backends: g.surfaces.map((s) => s.label),
      role: g.role,
      provisionedBy: g.provisionedBy,
      remediation,
      probe,
      fixitKind: g.fixit.kind,
      canAutoResolve: g.canAutoResolve,
    };
  });
}

// ── H2: workload scorecard ───────────────────────────────────────────────────

function severityWeightedScore(nodes: CapabilityNode[]): number {
  let num = 0;
  let den = 0;
  for (const n of nodes) {
    const w = SEVERITY_WEIGHT[n.severity];
    num += w * STATE_VALUE[n.state];
    den += w;
  }
  return den ? Math.round((num / den) * 100) : 100;
}

/**
 * Compute one workload score from its member capability nodes. Go/no-go:
 *   blocked — any CRITICAL capability blocked, or every capability blocked.
 *   ready   — every capability ready.
 *   partial — otherwise (a mix; nothing critical hard-blocks it).
 *
 * An `unknown` member NEVER contributes to `blocked`: a probe that did not
 * finish has established nothing, and a workload must not go no-go on a
 * non-observation (#3729).
 */
export function scoreWorkload(def: WorkloadDef, allNodes: CapabilityNode[]): WorkloadScore {
  const byId = new Map(allNodes.map((n) => [n.id, n]));
  const nodes = def.capabilityIds
    .map((id) => byId.get(id))
    .filter((n): n is CapabilityNode => !!n);

  const summary = {
    ready: nodes.filter((n) => n.state === 'ready').length,
    partial: nodes.filter((n) => n.state === 'partial').length,
    blocked: nodes.filter((n) => n.state === 'blocked').length,
    unknown: nodes.filter((n) => n.state === 'unknown').length,
    total: nodes.length,
  };

  const criticalBlocked = nodes.some((n) => n.state === 'blocked' && n.severity === 'critical');
  let state: ReadinessState;
  if (nodes.length === 0) {
    state = 'blocked';
  } else if (criticalBlocked || summary.blocked === nodes.length) {
    state = 'blocked';
  } else if (summary.ready === nodes.length) {
    state = 'ready';
  } else {
    state = 'partial';
  }

  const blockers: WorkloadBlocker[] = nodes
    .filter((n) => n.state !== 'ready')
    .map((n) => ({
      id: n.id,
      title: n.title,
      state: n.state,
      missing: n.missing,
      remediation: n.remediation,
      role: n.role,
      provisionedBy: n.provisionedBy,
    }));

  return {
    id: def.id,
    title: def.title,
    description: def.description,
    glyph: def.glyph,
    state,
    score: severityWeightedScore(nodes),
    summary,
    capabilityIds: nodes.map((n) => n.id),
    blockers,
  };
}

export function computeWorkloads(allNodes: CapabilityNode[]): WorkloadScore[] {
  return WORKLOADS.map((def) => scoreWorkload(def, allNodes));
}

// ── report assembly ──────────────────────────────────────────────────────────

function summarize(nodes: CapabilityNode[], workloads: WorkloadScore[]): ReadinessSummary {
  return {
    capabilities: {
      ready: nodes.filter((n) => n.state === 'ready').length,
      partial: nodes.filter((n) => n.state === 'partial').length,
      blocked: nodes.filter((n) => n.state === 'blocked').length,
      unknown: nodes.filter((n) => n.state === 'unknown').length,
      total: nodes.length,
    },
    workloads: {
      ready: workloads.filter((w) => w.state === 'ready').length,
      partial: workloads.filter((w) => w.state === 'partial').length,
      blocked: workloads.filter((w) => w.state === 'blocked').length,
      total: workloads.length,
    },
    score: severityWeightedScore(nodes),
    configOnly: nodes.filter((n) => n.state === 'ready' && n.verified === 'config-only').length,
  };
}

/** Assemble the full readiness report (H1 + H2) for the BFF route. */
export function buildReadiness(
  input: ReadinessInput,
  meta: { generatedAt: string; cloud?: string } = { generatedAt: new Date(0).toISOString() },
): ReadinessReport {
  const capabilities = buildCapabilityNodes(input);
  const workloads = computeWorkloads(capabilities);
  return {
    generatedAt: meta.generatedAt,
    cloud: meta.cloud,
    summary: summarize(capabilities, workloads),
    workloads,
    capabilities,
  };
}

/** Assemble the ready-to-run tenant profile (H3) — report + environment + blockers. */
export function buildTenantProfile(
  input: ReadinessInput,
  meta: { generatedAt: string; cloud?: string; environment?: TenantEnvironment } = { generatedAt: new Date(0).toISOString() },
): TenantProfile {
  const report = buildReadiness(input, meta);
  const blockers: WorkloadBlocker[] = report.capabilities
    .filter((n) => n.state !== 'ready')
    .map((n) => ({
      id: n.id,
      title: n.title,
      state: n.state,
      missing: n.missing,
      remediation: n.remediation,
      role: n.role,
      provisionedBy: n.provisionedBy,
    }));
  return {
    ...report,
    environment: meta.environment ?? {},
    blockers,
  };
}

// ── H3: human-readable markdown ──────────────────────────────────────────────

const STATE_LABEL: Record<ReadinessState, string> = {
  ready: 'Ready',
  partial: 'Partial',
  blocked: 'Blocked',
  'opt-in': 'Opt-in',
  unknown: 'Not established',
};

/** Render a readable markdown report of the tenant profile (H3). */
export function renderProfileMarkdown(profile: TenantProfile): string {
  const L: string[] = [];
  const env = profile.environment;
  L.push('# CSA Loom — Ready-to-run tenant profile');
  L.push('');
  L.push(`- Generated: ${profile.generatedAt}`);
  if (profile.cloud) L.push(`- Cloud: ${profile.cloud}`);
  if (env.app) L.push(`- Console app: ${env.app}`);
  if (env.subscription) L.push(`- Subscription: ${env.subscription}`);
  if (env.adminResourceGroup) L.push(`- Admin resource group: ${env.adminResourceGroup}`);
  if (env.dlzResourceGroup) L.push(`- Data landing zone RG: ${env.dlzResourceGroup}`);
  if (env.tenant) L.push(`- Tenant: ${env.tenant}`);
  L.push('');

  const cs = profile.summary.capabilities;
  const ws = profile.summary.workloads;
  L.push('## Summary');
  L.push('');
  L.push(`- Overall readiness score: **${profile.summary.score}/100**`);
  L.push(`- Capabilities: ${cs.ready} ready, ${cs.partial} partial, ${cs.blocked} blocked, ${cs.unknown} not established (of ${cs.total})`);
  L.push(`- Workloads: ${ws.ready} ready, ${ws.partial} partial, ${ws.blocked} blocked (of ${ws.total})`);
  L.push(`- Config-only (not live-probed): ${profile.summary.configOnly}`);
  L.push('');

  L.push('## Workload readiness');
  L.push('');
  L.push('| Workload | Status | Score | Ready | Partial | Blocked | Not established |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const w of profile.workloads) {
    L.push(`| ${w.title} | ${STATE_LABEL[w.state]} | ${w.score}/100 | ${w.summary.ready} | ${w.summary.partial} | ${w.summary.blocked} | ${w.summary.unknown} |`);
  }
  L.push('');

  /** Render one blocker's detail block. */
  const renderBlocker = (b: WorkloadBlocker) => {
    L.push(`### ${b.title} (\`${b.id}\`)`);
    if (b.missing.length) L.push(`- Missing: ${b.missing.map((m) => `\`${m}\``).join(', ')}`);
    if (b.role) L.push(`- Required role: ${b.role}`);
    if (b.provisionedBy) L.push(`- Provisioned by: \`${b.provisionedBy}\``);
    if (b.remediation) L.push(`- Remediation: ${b.remediation}`);
    L.push('');
  };

  // A capability whose live check DID NOT COMPLETE is not a blocker and must
  // not be filed as one. Before #3729 every non-ready capability landed under a
  // single "Blocked" heading, so an export taken during a slow ARM window read
  // to its reader as an outage while the summary above it said "not
  // established". The exported artifact now draws the same distinction the
  // screen does.
  const unestablished = profile.blockers.filter((b) => b.state === 'unknown');
  const realBlockers = profile.blockers.filter((b) => b.state !== 'unknown');

  if (realBlockers.length) {
    L.push('## Blocked / partial dependencies + remediation');
    L.push('');
    for (const b of realBlockers) renderBlocker(b);
  } else if (!unestablished.length) {
    L.push('## Blocked / partial dependencies');
    L.push('');
    L.push('All capabilities are ready. 🎉');
    L.push('');
  }

  if (unestablished.length) {
    L.push('## Not established — the live check did not complete');
    L.push('');
    L.push('These capabilities were NOT found broken. Their live probe did not finish, so nothing was observed either way; re-run the readiness check to re-probe them.');
    L.push('');
    for (const b of unestablished) renderBlocker(b);
  }

  return L.join('\n');
}
