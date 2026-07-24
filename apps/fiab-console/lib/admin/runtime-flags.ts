/**
 * runtime-flags — Cosmos-backed runtime kill-switch substrate (FLAG0).
 *
 * Every rollout control before this was a `LOOM_*_ENABLED` env var: flipping
 * one requires an ACA revision roll, and a pure-UX change had NO flag at all,
 * so the only revert was git-revert + rebuild + roll (~15–30 min MTTR). The
 * GuidedPickerRail incident (#2079) proved a user-visible regression can pass
 * every CI gate — this module cuts that MTTR to "toggle" (seconds).
 *
 * Design (per PRPs/active/loom-next-level ws-verification-dr.md FLAG0):
 *   • Docs live in the `loom-runtime-flags` Cosmos container (PK /id → the
 *     hot-path read is a single-partition point-read), created lazily via the
 *     existing cosmos-client createIfNotExists plumbing.
 *   • DEFAULT-ON (loom_default_on_opt_out): a MISSING doc — or an unreadable
 *     Cosmos — means the flag is enabled. Flags are OPERATIONAL KILL-SWITCHES
 *     only, never spend/config gates: absence can never gate a surface.
 *   • Hot-path reads go through `getOrComputeCached` (in-process tier, short
 *     TTL) so a flag check adds ~0 cost per request. A toggle calls
 *     `invalidateModel` so the WRITING replica flips instantly; sibling
 *     replicas converge within the cache TTL (≤15 s) — still "seconds", no
 *     revision roll.
 *   • EVERY flip writes an `_auditLog` row via the existing
 *     `auditLogContainer()` helper (actor who/oid, action, prior/new, ts) and
 *     fans out through `emitAuditEvent` (SIEM + webhooks) — the same audit
 *     standard as every other admin-plane mutation.
 *
 * The REGISTRY below is the typed list of known flags. Only registered flags
 * are toggleable from /admin (the API route enforces it); `runtimeFlag()`
 * itself accepts any id so a surface and its registry row can land in the
 * same PR without ordering constraints.
 */

import { runtimeFlagsContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import { getOrComputeCached, invalidateModel } from '@/lib/azure/query-result-cache';
import { emitAuditEvent } from '@/lib/admin/audit-stream';

// ── Registry ───────────────────────────────────────────────────────────────

/** One registered runtime kill-switch. */
export interface RuntimeFlagDef {
  /** Stable flag id (kebab-case, prefixed with the owning PRP item). */
  id: string;
  /** Short human label for the admin panel row. */
  label: string;
  /** What flipping the flag OFF reverts, in operator terms. */
  description: string;
  /** Owning PRP item id (e.g. 'U10') — provenance for the admin panel. */
  ownerItem: string;
  /** The user-visible surface(s) the switch controls. */
  surface: string;
}

/**
 * The typed list of known runtime flags. Scope (FLAG0): the user-visible N/U
 * items of the loom-next-level program — every entry is an operational
 * kill-switch whose OFF state falls back to the surface's pre-item behavior.
 * Items register their flag here in the SAME PR that ships the flagged path.
 */
export const RUNTIME_FLAGS: readonly RuntimeFlagDef[] = [
  {
    id: 'u10-browse-virtualization',
    label: 'Browse & marketplace virtualization',
    description:
      'Windowed rendering (VirtualizedGrid + windowed table rows) for 200+-item collections on /browse and the marketplace. OFF reverts every adopting surface to the pre-U10 full-render path on the next load — the GuidedPickerRail-class revert this substrate exists for.',
    ownerItem: 'U10',
    surface: '/browse (pins, workspaces, all-items table) + /marketplace grids',
  },
  {
    id: 'u1-report-designer-g3',
    label: 'Report designer — resizable canvas (G3)',
    description:
      'User-resizable report-canvas height (shared ResizableCanvasRegion: drag grip + keyboard, persisted under loom.canvasHeight.report-designer-canvas). OFF reverts the report designer to the pre-U1 fixed fill-height canvas on the next load. The Pages/Build width SplitPanes predate U1 (R1 #1857) and are unaffected by this switch.',
    ownerItem: 'U1',
    surface: 'Report designer canvas (/items/report/[id])',
  },
  {
    id: 'u3-notebook-cell-resize',
    label: 'Notebook per-cell resize grips',
    description:
      'Per-cell drag/keyboard height grips on notebook code cells (auto-fit until the first resize; the chosen height then persists per cell in the browser). OFF reverts every notebook surface to the pre-U3 auto-height-only cells on the next load — saved per-cell heights are simply ignored, nothing is deleted.',
    ownerItem: 'U3',
    surface: 'Notebook editors (Loom, Synapse, Databricks) — code cells',
  },
  {
    id: 'u6-monaco-divider',
    label: 'Query editors — query↔results split divider',
    description:
      'The U6 draggable query↔results divider (resizable workspace + SplitPane) across the 11 Monaco query editors (warehouse, KQL database/queryset, SQL database, unified SQL, Databricks SQL warehouse, lakehouse SQL, graph Gremlin/Cypher/GQL/vector-search). OFF reverts every adopter to the pre-U6 flow layout with the fixed 360px results cap on the next render — no roll required.',
    ownerItem: 'U6',
    surface: 'Query↔results panes of the 11 Monaco-based query editors',
  },
  {
    id: 'v1-journeys-tab',
    label: 'Health hub — Journeys tab',
    description: 'OFF reverts /admin/health to the pre-V1 self-audit-only layout (hides the synthetic-journey Journeys tab). The scheduled loom-synthetic-monitor job itself keeps running either way — this only controls the admin surface.',
    ownerItem: 'V1',
    surface: '/admin/health?tab=journeys',
  },
  {
    id: 'a10-spark-tab',
    label: 'Health hub — Spark pools tab',
    description: 'OFF reverts /admin/health to the pre-A10 layout (hides the Spark pools tab). The warm pool, leaked-session reaper, and keep-warm heartbeat keep running either way — this only controls the admin surface.',
    ownerItem: 'A10',
    surface: '/admin/health?tab=spark',
  },
  {
    id: 'a11-spark-autorecover',
    label: 'Spark pools — FAULTED auto-recovery',
    description:
      'Auto-detect + delete/recreate a FAULTED or "Succeeded-but-can\'t-launch" Synapse Spark pool from the keep-warm heartbeat (thrash-guarded, operator-alerted). OFF keeps detection + alerting and the manual "Recreate pool" button on /admin/health → Spark pools, but stops the AUTOMATIC recreate on the next heartbeat — the seconds-fast revert if an auto-recreate ever misbehaves. The warm pool, reaper, and keep-warm heartbeat keep running either way. LOOM_SPARK_AUTORECOVER_ENABLED=0 is the env-level equivalent.',
    ownerItem: 'A11',
    surface: '/admin/health?tab=spark (auto-recovery + the keep-warm auto-recover tick)',
  },
  {
    id: 'a6-small-multiples-grid',
    label: 'Report designer — small-multiples grid controls',
    description:
      'Wires the report Format-pane "Small multiples" grid controls (columns count, shared-Y axis, and the Facet-by picker) into the trellis renderer. OFF reverts the report designer to the pre-A6 behaviour on the next render — small multiples still facet by the Small-multiples field well, but the columns/shared-Y controls and the Format-pane facet picker have no effect (auto-fill columns, shared Y). No roll required.',
    ownerItem: 'A6',
    surface: 'Report designer cartesian visuals with a Small-multiples facet (/items/report/[id])',
  },
  {
    id: 'slo1-slo-tab',
    label: 'Health hub — SLO & error budgets tab',
    description: 'OFF hides the SLO / error-budget tab on /admin/health (reverts to the pre-SLO1 layout). The underlying SLIs (synthetic-journey verdicts, Copilot latency SLOs, cache counters) keep being measured either way — this only controls the admin surface. The burn-rate P2 dispatch is driven by the /api/admin/slo read, so flipping the tab off also stops the read that pages.',
    ownerItem: 'SLO1',
    surface: '/admin/health?tab=slo',
  },
  {
    id: 'a8-map-shape-fallback',
    label: 'Report map — basemap-free shape-map fallback (Gov)',
    description:
      'When the report Map visual is gated because Azure Maps is unavailable (GCC/Gov, and no self-hosted MapLibre tileserver), render a basemap-free choropleth / point plot via the offline GeoJsonMap SVG renderer over bundled OSS boundaries — no external tiles. OFF reverts the gate to the pre-A8 config-message + aggregated-rows table (no map) on the next render. Commercial Azure Maps and the MapLibre tileserver paths are unaffected.',
    ownerItem: 'A8',
    surface: 'Report Map visual on the Azure-Maps honest gate (/items/report/[id])',
  },
  {
    id: 'e5-copilot-quality-page',
    label: 'Copilot quality admin page',
    description:
      'The /admin/copilot-quality surface: per-surface Copilot eval scorecards (retrieval hit-rate / grounding / pass-rate), run-history trends, floor status, and "Run now". OFF hides the page body (a guided notice replaces it) without a roll — the kill-switch for a rendering regression on this new admin surface. The copilot-evaluator Function, its nightly/per-roll runs, and the Cosmos data are unaffected; only this read-only admin view is gated.',
    ownerItem: 'E5',
    surface: '/admin/copilot-quality',
  },
  {
    id: 'e6-tier-routing-tab',
    label: 'Copilot quality — Tier routing tab',
    description:
      'The E6 "Tier routing" tab on /admin/copilot-quality: tier-router decision accuracy, the tier confusion heatmap, per-task-class accuracy, and the per-tier cost-per-quality view over the copilot-evaluator tier-run docs. OFF hides the tab body behind a guided notice (no roll) — the kill-switch for a rendering regression on this new tab. The copilot-evaluator tier mode, its nightly/per-roll runs, and the Cosmos data are unaffected; only this read-only view is gated.',
    ownerItem: 'E6',
    surface: '/admin/copilot-quality (Tier routing tab)',
  },
  {
    id: 'c4-finops-hub',
    label: 'FinOps hub (/admin/finops)',
    description:
      'The C4 FinOps cockpit (/admin/finops): forecast chart, cost-anomaly feed + rules editor, per-scope breakdown, and real Azure Budgets CRUD. OFF reverts the surface to a pointer at the existing /admin/chargeback + /admin/usage-chargeback pages (which keep working) on the next load — the hub is additive, nothing else changes. The scheduled C3 cost-anomaly monitor keeps running either way; this only controls the admin surface.',
    ownerItem: 'C4',
    surface: '/admin/finops',
  },
  {
    id: 'rum1-client-telemetry',
    label: 'Client RUM telemetry',
    description:
      'Browser-side real-user monitoring: page-load timings, Web Vitals and unhandled-error beacons from every console page → App Insights. OFF stops capture on the next page load AND drops in-flight beacons at the ingest route (seconds, no roll) — the passive-capture revert story. Server-side telemetry and the synthetic journeys are unaffected.',
    ownerItem: 'RUM1',
    surface: 'Every console page (passive capture) + /admin/rum',
  },
  {
    id: 'u7-dataflow-debug',
    label: 'Mapping data flow — Debug mode (preview/inspect/stats)',
    description:
      'The U7 ADF-Studio-parity Debug experience on the mapping-dataflow designer: the held debug-session lifecycle, the per-transform Data Preview / Inspect (schema + drift) / Statistics tabs, and the preview-grid quick-actions. OFF reverts the mapping-dataflow editor to the pre-U7 single-stream inline preview on the next load — the real ADF data-flow debug session, factory, and authoring path are unaffected; only the richer bottom Debug panel is hidden. Data preview / debug still require a data-flow-capable Azure Integration Runtime either way (honest gate).',
    ownerItem: 'U7',
    surface: 'Mapping data flow editor (/items/mapping-dataflow/[id]) — bottom Debug panel',
  },
  {
    id: 'a9-matrix-conditional-format',
    label: 'Report matrix — conditional formatting on cells',
    description:
      'Paints the pivoted report matrix value cells with the same conditional-format rules (backgrounds, font color, icons, data bars) the plain table already honors — Power BI parity uniformity. OFF reverts the matrix to unpainted value cells on the next render (the table, chart, and card conditional formatting are unaffected). No roll required.',
    ownerItem: 'A9',
    surface: 'Report designer pivoted matrix visual (/items/report/[id])',
  },
  {
    id: 'i6-ws-identity-panel',
    label: 'Workspace settings — Identity panel (per-workspace enforcement)',
    description:
      'The I6 Workspace Settings → Identity panel: current identity mode, the provisioned uami-ws-<id> + per-backend grant readiness (green/red), the 14-day shadow-divergence rollup, the I9 security-review status line, and the (operator-gated, disabled-until-ready) Enable-enforcement toggle. OFF hides the Identity tab on the next open — the workspace keeps running exactly as it is (the shared Console UAMI on the default off/shadow path); nothing about provisioning, the shadow audit, or the credential factory is affected. The GET/POST enforce route stays reachable either way (tenant-admin only); this only controls the admin surface.',
    ownerItem: 'I6',
    surface: 'Workspace Settings flyout → Identity tab (/workspaces, admin)',
  },
  {
    id: 'n10-answer-receipts',
    label: 'Copilot — answer receipts + verified badge',
    description:
      'The per-answer Receipt panel in the Copilot dock: the plan the loop followed, the exact SQL/KQL/Cypher executed with real row counts, grounding sources + graph paths + metrics, the model tier, token cost, and the Verified/Unverified/Refused verdict — plus the persisted governance-audit reference. OFF hides the collapsible Receipt panel under each answer on the next render (the answer, citations, and metadata bar are unaffected); receipts still persist to loom-answer-receipts either way — this only controls the reader surface. No roll required.',
    ownerItem: 'N10',
    surface: 'Copilot dock transcript — per-answer Receipt panel (cross-item + per-surface Copilots)',
  },
  {
    id: 'a3-dax-fold-engine',
    label: 'Semantic model — DAX fold engine',
    description:
      'The A1/A2/A3 loom-native DAX tokenizer + parser + SQL-fold engine behind the semantic-model DAX query view and measure test (evalDax → Synapse serverless). OFF instantly reverts to the pre-A-chain 3-regex translator (EVALUATE <Table> / TOPN / ROW(CALCULATE(AGG)) only; everything else → the honest unsupported-DAX message, or the opt-in AAS backend if configured) — a true revert with zero roll if a fold ever mis-plans. The report path (field-wells → SQL) is unaffected either way.',
    ownerItem: 'A3',
    surface: 'Semantic-model DAX query view + measure test (/items/semantic-model/[id])',
  },
  {
    id: 'n9-verified-queries-tab',
    label: 'Semantic model — Verified Queries tab',
    description:
      'The N9 "Verified Queries" tab on the semantic-model editor: the governed metric registry + the Verified Query Repository (approved question→query pairs a data agent retrieves FIRST, refusing out-of-contract questions instead of guessing). OFF hides the tab body behind a guided notice on the next load (no roll) — the read/write routes and the data-agent contract evaluation are unaffected; only this authoring surface is gated.',
    ownerItem: 'N9',
    surface: 'Semantic-model editor → Verified Queries tab (/items/semantic-model/[id])',
  },
  {
    id: 'n13-prompt-registry',
    label: 'Copilot quality — Prompts tab (LLMOps prompt registry)',
    description:
      'The N13 "Prompts" tab on /admin/copilot-quality: semver\'d prompt versions with their REAL copilot-evaluator scores, publish (which requests a run from the EXISTING E2 evaluator), and the audited approve / rollback controls. OFF hides the tab body behind a guided notice on the next load (no roll) — the registry Cosmos store, the runtime getActivePrompt() read, and the evaluator itself are unaffected; only this authoring surface is gated. Approval history is never deleted by a flip.',
    ownerItem: 'N13',
    surface: '/admin/copilot-quality (Prompts tab)',
  },
  {
    id: 'n13-token-budgets',
    label: 'Per-workspace / per-agent token budgets (enforcement + attribution)',
    description:
      'The N13 token-budget plane: hot-path enforcement in aoai-chat-client (an exhausted workspace/agent budget refuses the turn with an honest 429-class message + Fix-it instead of truncating), the real per-turn spend attribution written to loom-token-budgets, and the /admin/copilot-quality Budgets tab. OFF stops enforcement AND attribution on the very next turn (seconds, no roll) — the estate-wide release valve if a budget ever misfires. Configured budgets and the accumulated usage ledger are retained; the E6 tier router, model selection, and every other part of the turn are unaffected.',
    ownerItem: 'N13',
    surface: 'Every Azure OpenAI chat turn (aoai-chat-client hot path) + /admin/copilot-quality (Budgets tab)',
  },
  {
    id: 'n11-graphrag-grounding',
    label: 'Data agents — GraphRAG grounding over the authored ontology',
    description:
      'N11 GraphRAG retrieval: a relational (multi-hop) data-agent question extracts seed entities from the authored Weave ontology, traverses the REAL Apache AGE graph (in-VNet PostgreSQL, zero external egress), attaches the precomputed community summaries, and layers the resulting graph facts + graph-path citations onto the planner and every execute step (and into the Answer Receipt). OFF reverts every data agent to the pre-N11 table-only grounding on the very next turn — the ontology, its instances, and the GraphRAG index are untouched, they are simply not consulted.',
    ownerItem: 'N11',
    surface: 'Data-agent test chat + published agent turns (/items/data-agent/[id]) — Graph grounding',
  },
  {
    id: 'n1-lakehouse-interop-tab',
    label: 'Lakehouse — Interop tab (Delta ↔ Iceberg)',
    description:
      'The N1 Interop tab on the lakehouse editor: per-table "expose as Iceberg" toggles (a real Synapse Spark job writing Delta UniForm / Apache XTable metadata beside the Delta log), the Iceberg REST Catalog connection string, and the copy-paste connect snippets for Spark / Trino / DuckDB / Snowflake / Databricks. OFF hides the tab on the next render — already-emitted Iceberg metadata stays in the lake and external engines keep reading it (nothing is unregistered or deleted), and every other lakehouse tab is unaffected.',
    ownerItem: 'N1',
    surface: 'Lakehouse editor → Interop tab (/items/lakehouse/[id])',
  },
  {
    id: 'n4-transform-plan-apply',
    label: 'Transformation project — plan/apply wizard + model DAG',
    description:
      'The N4 plan/apply surface on the transformation-project editor: the environment picker, the impact-diff grid (model, change type, breaking / non-breaking, downstream, column-level), the apply step (SQLMesh virtual-environment view swap, or `dbt build`), and the software-defined-asset model DAG. OFF hides the wizard + canvas behind a guided notice on the next load and leaves the project authoring, code generation, and file preview fully working — the seconds-fast revert for a rendering regression on the new surface. The loom-transform-runner Container App, the /api/transform/** routes, and the recorded plan history are unaffected.',
    ownerItem: 'N4',
    surface: 'Transformation project editor (/items/transformation-project/[id]) — Plan & apply + Model DAG tabs',
  },
  {
    id: 'n6-data-contracts',
    label: 'Data contracts — governance registry',
    description:
      'The N6 Governance → Data contracts registry (ODCS 3.1 contracts, their ingestion bindings, and the pass/fail enforcement trend). OFF makes /governance/data-contracts render an honest "turned off" state on the next load and the registry API return an empty payload. It does NOT stop enforcement: contracts already bound to the mirroring engine, pipeline sinks, and eventstream keep quarantining violating rows to the Bronze `_rejected` dead-letter path and alerting — disable enforcement per contract (Enforcement → off) if that is what you need.',
    ownerItem: 'N6',
    surface: '/governance/data-contracts (registry page + /api/governance/data-contracts)',
  },
];

/** Union of registered flag ids (`never` while the list is empty). */
export type RuntimeFlagId = (typeof RUNTIME_FLAGS)[number]['id'];

/** True when `id` is in the typed registry (the admin toggle gate). */
export function isRegisteredFlag(id: string): boolean {
  return RUNTIME_FLAGS.some((f) => f.id === id);
}

// ── Storage + cached reads ─────────────────────────────────────────────────

/** The Cosmos doc shape for one flag (id = flag id, PK /id). MISSING = ON. */
export interface RuntimeFlagDoc {
  id: string;
  enabled: boolean;
  updatedAt: string;
  /** UPN/email of the last actor (audit convenience; the audit-log row is authoritative). */
  updatedBy?: string;
  updatedByOid?: string;
}

/** Cache namespace — one `invalidateModel` call drops every flag slot. */
const CACHE_MODEL_ID = 'runtime-flags';
/** Hot-path cache TTL. Also the cross-replica convergence bound for a flip. */
export const RUNTIME_FLAG_CACHE_TTL_MS = 15_000;

async function readFlagDoc(id: string): Promise<RuntimeFlagDoc | null> {
  const c = await runtimeFlagsContainer();
  try {
    const { resource } = await c.item(id, id).read<RuntimeFlagDoc>();
    return resource ?? null;
  } catch (e: unknown) {
    if ((e as { code?: number })?.code === 404) return null;
    throw e;
  }
}

/**
 * Read one runtime flag (default-ON). The ONLY read path surfaces should use.
 *
 *   if (await runtimeFlag('u10-browse-virtualization')) { …new path… }
 *
 * Fail-open by design: a missing doc, an unregistered id, or an unreachable
 * Cosmos all return `opts.default` (true) — a kill-switch subsystem outage
 * must never take a surface down with it.
 */
export async function runtimeFlag(
  id: string,
  opts: { default: boolean } = { default: true },
): Promise<boolean> {
  try {
    const { value } = await getOrComputeCached<RuntimeFlagDoc | null>(
      `runtime-flag:${id}`,
      CACHE_MODEL_ID,
      () => readFlagDoc(id),
      { ttlMs: RUNTIME_FLAG_CACHE_TTL_MS },
    );
    if (!value || typeof value.enabled !== 'boolean') return opts.default;
    return value.enabled;
  } catch {
    return opts.default;
  }
}

// ── Admin list + audited toggle ────────────────────────────────────────────

/** A registry entry joined with its live state, for the /admin panel. */
export interface RuntimeFlagState extends RuntimeFlagDef {
  enabled: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

/**
 * Every registered flag joined with its live Cosmos state (uncached — the
 * admin panel is a cold read and must show the truth immediately).
 */
export async function listRuntimeFlags(): Promise<RuntimeFlagState[]> {
  const c = await runtimeFlagsContainer();
  const { resources } = await c.items
    .query<RuntimeFlagDoc>({ query: 'SELECT * FROM c' })
    .fetchAll();
  const byId = new Map(resources.map((d) => [d.id, d]));
  return RUNTIME_FLAGS.map((def) => {
    const doc = byId.get(def.id);
    return {
      ...def,
      enabled: doc && typeof doc.enabled === 'boolean' ? doc.enabled : true,
      updatedAt: doc?.updatedAt,
      updatedBy: doc?.updatedBy,
    };
  });
}

/** Count of registered flags currently flipped OFF (admin-overview tile). */
export async function countFlagsOff(): Promise<number> {
  return (await listRuntimeFlags()).filter((f) => !f.enabled).length;
}

/** Actor context for the audit trail (from the admin session). */
export interface RuntimeFlagActor {
  oid: string;
  /** UPN / email / display fallback. */
  who: string;
  tenantId: string;
}

/**
 * Flip a flag and audit the flip. Upserts the doc, drops the in-process cache
 * slots (`invalidateModel`) so the writing replica honors the new state on the
 * very next read, writes the authoritative `_auditLog` row (prior/new state,
 * actor, ts), and fans the mutation out via `emitAuditEvent` (SIEM/webhooks).
 * Registration is enforced by the API route, not here, so unit tests and
 * same-PR surface+registry landings stay order-independent.
 */
export async function setRuntimeFlag(
  id: string,
  enabled: boolean,
  actor: RuntimeFlagActor,
): Promise<RuntimeFlagDoc> {
  const prior = await readFlagDoc(id);
  const priorEnabled = prior && typeof prior.enabled === 'boolean' ? prior.enabled : true;
  const now = new Date().toISOString();
  const doc: RuntimeFlagDoc = {
    id,
    enabled,
    updatedAt: now,
    updatedBy: actor.who,
    updatedByOid: actor.oid,
  };
  const c = await runtimeFlagsContainer();
  await c.items.upsert(doc);
  // Same-replica reads flip immediately; siblings converge within the TTL.
  invalidateModel(CACHE_MODEL_ID);

  // Authoritative Cosmos audit row (best-effort — a flip is never blocked by
  // an audit hiccup, matching every other admin mutation in this repo).
  try {
    const audit = await auditLogContainer();
    await audit.items
      .create({
        id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        itemId: `runtime-flag:${id}`,
        tenantId: actor.tenantId,
        who: actor.who,
        actorOid: actor.oid,
        at: now,
        kind: enabled ? 'runtime-flag.enable' : 'runtime-flag.disable',
        target: id,
        detail: { prior: priorEnabled, next: enabled },
      })
      .catch(() => undefined);
  } catch {
    /* audit failures are non-blocking */
  }
  emitAuditEvent({
    actorOid: actor.oid,
    actorUpn: actor.who,
    action: 'runtime-flag.set',
    targetType: 'runtime-flag',
    targetId: id,
    tenantId: actor.tenantId,
    detail: { prior: priorEnabled, next: enabled },
  });
  return doc;
}
