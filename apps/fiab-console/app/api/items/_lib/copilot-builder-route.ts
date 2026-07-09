/**
 * copilot-builder-route.ts — SHARED server orchestration for the inline Copilot
 * builder pane, generalized from the proven semantic-model `copilot-structure`
 * route (audit-T82) so the 7 remaining design surfaces (eventstream,
 * stream-analytics, lakehouse, materialized-lake-view, mirrored-database,
 * ml-experiment/automl, graph) each ship a REAL AOAI-grounded assist route
 * without re-implementing the two-phase propose → checkpoint → apply → restore
 * flow.
 *
 * Contract (identical across every surface):
 *   POST { action:'propose', prompt }        → AOAI parses the request into a
 *                                               structured EDIT PLAN (no write)
 *   POST { action:'apply', plan, label? }     → checkpoint THEN apply each op
 *   POST { action:'restore', checkpointId }   → restore a checkpoint
 *   POST { action:'checkpoint', label? }      → manual save point
 *   GET  ?action=checkpoints                   → list checkpoints (newest first)
 *
 * NO-VAPORWARE (.claude/rules/no-vaporware.md): real AOAI chat call (unified
 * aoai-chat-client), real Cosmos read/write via the owned-item store. No mocks,
 * no `return []`. When AOAI is not configured the route returns an honest 502
 * gate naming the exact env var to set.
 *
 * NO-FABRIC-DEPENDENCY (.claude/rules/no-fabric-dependency.md): the DEFAULT
 * backend is the Loom-native Cosmos item.state authoring doc — every builder
 * works with LOOM_DEFAULT_FABRIC_WORKSPACE UNSET and never contacts
 * api.fabric.microsoft.com / api.powerbi.com. Surfaces that ALSO mirror to a
 * live Azure backend (ADX, Event Hubs, Synapse) do so best-effort inside their
 * own applyOps — the Cosmos write is always the source of truth.
 *
 * Auth: session via getSession() + ownership via loadOwnedItem (the shared
 * store gates to WRITE-capable workspace access by default, so a shared
 * read-only Viewer can never mutate through this route — the known
 * gated-only-on-getSession security bug class is avoided).
 *
 * Underscore-prefixed folder — Next.js does not treat this as a route.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { aoaiChat } from '@/lib/azure/aoai-chat-client';
import { loadOwnedItem, updateOwnedItem } from './item-crud';
import {
  captureBuilderCheckpoint,
  listBuilderCheckpoints,
  restoreBuilderCheckpoint,
  type CheckpointStoreConfig,
} from './copilot-builder-checkpoints';

/** Badge colours the pane understands (a subset of Fluent Badge colors). */
export type BuilderOpBadgeColor = 'brand' | 'success' | 'informative' | 'warning' | 'danger';

/**
 * A single normalized, display-ready plan op. `kind` + `describe` + `badge` are
 * rendered by the shared pane; every other field is surface-specific backend
 * payload carried through to applyOps. Kept index-signature-open so each surface
 * can attach its own typed fields.
 */
export interface BuilderOp {
  kind: string;
  /** One-line human description rendered in the plan list. */
  describe: string;
  /** Short badge label (e.g. "Add source"). */
  badge: string;
  /** Badge colour. */
  badgeColor: BuilderOpBadgeColor;
  [k: string]: unknown;
}

export interface BuilderPlan {
  summary: string;
  ops: BuilderOp[];
}

/** Result of applying approved ops to the doc. */
export interface ApplyResult {
  /** Partial item.state to merge (only the surface's doc keys). */
  patch: Record<string, unknown>;
  applied: string[];
  skipped: string[];
}

/**
 * Per-surface builder configuration. `Doc` is the surface's authoring doc shape
 * read out of item.state; the generic route never inspects its internals.
 */
export interface CopilotBuilderConfig<Doc> {
  itemType: string;
  /** item.state keys that hold the authoring doc (snapshotted for checkpoints). */
  docKeys: readonly string[];
  /** item.state key for the checkpoint array (default `<itemType>Checkpoints`). */
  checkpointsKey?: string;
  /** Read the surface's authoring doc from item.state (with sane defaults). */
  readDoc: (state: Record<string, unknown>) => Doc;
  /** Small stat map for the checkpoint list UI. */
  computeStats: (doc: Doc) => Record<string, number>;
  /** Persona system prompt (grounding is appended by the route). MUST NOT
   *  mention Microsoft Fabric per no-fabric-dependency.md. */
  systemPrompt: string;
  /** Compact, REAL grounding text derived from the live doc (tables/sources/…). */
  groundingText: (doc: Doc) => string;
  /**
   * Validate + normalize the raw AOAI ops against the REAL doc. Drops anything
   * that references names not present in the doc. Returns display-ready ops.
   */
  normalizeOps: (rawOps: unknown[], doc: Doc) => BuilderOp[];
  /** Apply the (approved, revalidated) ops to the doc → state patch + messages. */
  applyOps: (doc: Doc, ops: BuilderOp[], state: Record<string, unknown>) => ApplyResult | Promise<ApplyResult>;
  /** Token cap for the propose call. */
  maxCompletionTokens?: number;
  /** Honest-gate hint surfaced when AOAI is not configured. */
  gate?: { missing: string; detail: string };
}

const DEFAULT_GATE = {
  missing: 'LOOM_AOAI_ENDPOINT / LOOM_AOAI_DEPLOYMENT',
  detail:
    'This Copilot builder needs an Azure OpenAI chat deployment. Set LOOM_AOAI_ENDPOINT + ' +
    'LOOM_AOAI_DEPLOYMENT (or configure the tenant Copilot account in Admin → Copilot), and grant ' +
    'the Console UAMI Cognitive Services OpenAI User on the account. No Microsoft Fabric / Power BI required.',
};

function checkpointStore<Doc>(cfg: CopilotBuilderConfig<Doc>): CheckpointStoreConfig {
  return {
    itemType: cfg.itemType,
    docKeys: cfg.docKeys,
    checkpointsKey: cfg.checkpointsKey ?? `${cfg.itemType}Checkpoints`,
    computeStats: (doc) => cfg.computeStats(cfg.readDoc(doc)),
  };
}

async function aoaiPlanRaw(userOid: string, system: string, user: string, maxTokens: number): Promise<string> {
  const { loadTenantCopilotConfig } = await import('@/lib/azure/copilot-config-store');
  const cfg = await loadTenantCopilotConfig(userOid).catch(() => null);
  return await aoaiChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    maxCompletionTokens: maxTokens,
    temperature: 0.1,
    responseFormat: 'json_object',
    cfg,
  });
}

function parseRawOps(raw: string): { summary: string; ops: unknown[] } {
  let parsed: any = {};
  try { parsed = JSON.parse(raw || '{}'); } catch { parsed = {}; }
  const ops = Array.isArray(parsed?.ops) ? parsed.ops : [];
  const summary = typeof parsed?.summary === 'string' ? parsed.summary.trim() : '';
  return { summary, ops };
}

/**
 * Build the `{ GET, POST }` handlers for a Copilot builder route. Usage:
 *
 *   const cfg = makeEventstreamBuilderConfig();
 *   export const { GET, POST } = makeCopilotBuilderRoute(cfg);
 *   export const runtime = 'nodejs';
 *   export const dynamic = 'force-dynamic';
 */
export function makeCopilotBuilderRoute<Doc>(cfg: CopilotBuilderConfig<Doc>) {
  const store = checkpointStore(cfg);
  const gate = cfg.gate ?? DEFAULT_GATE;

  async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const session = getSession();
    if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
    const { id } = await ctx.params;
    const action = req.nextUrl.searchParams.get('action') || 'checkpoints';
    if (action === 'checkpoints') {
      const checkpoints = await listBuilderCheckpoints(store, id, session.claims.oid);
      if (checkpoints === null) {
        return NextResponse.json({ ok: false, error: `${cfg.itemType} not found or not owned by you.` }, { status: 404 });
      }
      return NextResponse.json({ ok: true, checkpoints });
    }
    if (action === 'doc') {
      // Return the surface's current authoring doc so a host editor can load the
      // latest Copilot-produced draft into its live query box (read-only fetch,
      // WRITE access not required).
      const item = await loadOwnedItem(id, cfg.itemType, session.claims.oid, { allowReadRoles: true });
      if (!item) return NextResponse.json({ ok: false, error: `${cfg.itemType} not found or not owned by you.` }, { status: 404 });
      const doc = cfg.readDoc((item.state || {}) as Record<string, unknown>);
      return NextResponse.json({ ok: true, doc });
    }
    return NextResponse.json({ ok: false, error: `unknown action "${action}"` }, { status: 400 });
  }

  async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const session = getSession();
    if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
    const { id } = await ctx.params;
    const tenantId = session.claims.oid;
    const body = await req.json().catch(() => ({} as any));
    const action = String(body?.action || '').trim();

    // ── propose: NL → structured edit plan (no write) ────────────────────────
    if (action === 'propose') {
      const prompt = String(body?.prompt || '').trim();
      if (!prompt) return NextResponse.json({ ok: false, error: 'prompt is required' }, { status: 400 });
      const item = await loadOwnedItem(id, cfg.itemType, tenantId);
      if (!item) return NextResponse.json({ ok: false, error: `${cfg.itemType} not found or not owned by you.` }, { status: 404 });
      const doc = cfg.readDoc((item.state || {}) as Record<string, unknown>);

      const system = `${cfg.systemPrompt}\n\n--- LIVE ITEM CONTEXT (ground every op in these REAL names — never invent names) ---\n${cfg.groundingText(doc)}`;

      let raw: string;
      try {
        raw = await aoaiPlanRaw(tenantId, system, prompt, cfg.maxCompletionTokens ?? 900);
      } catch (e: any) {
        return NextResponse.json({ ok: false, error: e?.message || String(e), gate }, { status: 502 });
      }
      const { summary, ops: rawOps } = parseRawOps(raw);
      const ops = cfg.normalizeOps(rawOps, doc);
      const plan: BuilderPlan = { summary: summary || `${ops.length} proposed edit(s).`, ops };
      return NextResponse.json({
        ok: true,
        plan,
        pendingApproval: true,
        note: 'Nothing was written. Review the plan, then POST { action:"apply", plan } to apply it (a checkpoint is captured first).',
      });
    }

    // ── apply: checkpoint THEN apply the (approved) plan ─────────────────────
    if (action === 'apply') {
      const plan = body?.plan as BuilderPlan | undefined;
      const rawOps = Array.isArray(plan?.ops) ? plan!.ops : [];
      if (rawOps.length === 0) return NextResponse.json({ ok: false, error: 'plan.ops is empty — nothing to apply.' }, { status: 400 });
      const item = await loadOwnedItem(id, cfg.itemType, tenantId);
      if (!item) return NextResponse.json({ ok: false, error: `${cfg.itemType} not found or not owned by you.` }, { status: 404 });
      const state = (item.state || {}) as Record<string, unknown>;
      const doc = cfg.readDoc(state);

      // Re-validate the plan ops against the CURRENT doc (the plan may be stale).
      const revalidated = cfg.normalizeOps(rawOps, doc);
      if (revalidated.length === 0) {
        return NextResponse.json({ ok: false, error: 'None of the plan ops are valid against the current item (names may have changed). Re-run propose.' }, { status: 409 });
      }

      // 1) Checkpoint current doc first (the restore target).
      const label = (String(body?.label || '').trim() || `Before Copilot: ${plan?.summary || `${revalidated.length} edit(s)`}`).slice(0, 140);
      const checkpoint = await captureBuilderCheckpoint(store, id, tenantId, label, 'copilot');
      if (!checkpoint) return NextResponse.json({ ok: false, error: 'Failed to capture a checkpoint; aborting before any edit.' }, { status: 500 });

      // 2) Apply to the Loom-native store (Azure-native DEFAULT — always works).
      const { patch, applied, skipped } = await cfg.applyOps(doc, revalidated, state);
      const wrote = await updateOwnedItem(id, cfg.itemType, tenantId, { state: { ...state, ...patch } });
      if (!wrote) return NextResponse.json({ ok: false, error: 'Failed to persist the edited item.', checkpointId: checkpoint.id }, { status: 500 });

      return NextResponse.json({
        ok: true,
        applied,
        skipped,
        checkpoint,
        backend: 'loom-native',
        note: 'Edits persisted Azure-native to the Loom item. A checkpoint was captured first, so you can restore.',
      });
    }

    // ── restore ──────────────────────────────────────────────────────────────
    if (action === 'restore') {
      const checkpointId = String(body?.checkpointId || '').trim();
      if (!checkpointId) return NextResponse.json({ ok: false, error: 'checkpointId is required' }, { status: 400 });
      const result = await restoreBuilderCheckpoint(store, id, tenantId, checkpointId);
      if (!result) return NextResponse.json({ ok: false, error: 'Checkpoint not found (or the item is not owned by you).' }, { status: 404 });
      return NextResponse.json({
        ok: true,
        restoredFrom: result.restoredFrom,
        note: 'Item restored. A pre-restore snapshot was captured automatically so this restore is itself reversible.',
      });
    }

    // ── checkpoint: manual save point ──────────────────────────────────────────
    if (action === 'checkpoint') {
      const label = String(body?.label || '').trim() || 'Manual checkpoint';
      const checkpoint = await captureBuilderCheckpoint(store, id, tenantId, label, 'manual');
      if (!checkpoint) return NextResponse.json({ ok: false, error: `${cfg.itemType} not found or not owned by you.` }, { status: 404 });
      return NextResponse.json({ ok: true, checkpoint });
    }

    return NextResponse.json({ ok: false, error: `unknown action "${action}"` }, { status: 400 });
  }

  return { GET, POST };
}
