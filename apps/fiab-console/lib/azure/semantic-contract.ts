/**
 * semantic-contract.ts — the Cosmos-backed store + contract evaluator for N9
 * (Verified Semantic Contract + Verified Query Repository + refuse-not-guess).
 *
 * Store: the `loom-semantic-contract` Cosmos container (PK /tenantId; owner-
 * scoped like Prep-for-AI). Two doc kinds share the partition — `MetricDoc`
 * (the governed metric registry) and `VerifiedQueryDoc` (the VQR). Doc shapes,
 * the MIG1 migrator registration, and the PURE matching layer live in the leaf
 * `semantic-contract-model.ts` (imported by cosmos-client at module scope). The
 * container is created lazily via cosmos-client's createIfNotExists — a fresh
 * environment needs no extra ARM/Bicep step beyond the account+database.
 *
 * Every privileged mutation (approveVerifiedQuery) writes an `_auditLog` row via
 * `auditLogContainer()` AND fans out through `emitAuditEvent` — the same audit
 * standard as every other admin-plane mutation (see runtime-flags.ts).
 *
 * CROSS-WIRE (N15): N15's metrics service compiles FROM `listMetrics` — this
 * module OWNS the metric-definition substrate. Keep the returned `MetricDoc`
 * shape stable.
 *
 * Per-cloud: identical all clouds (pure metadata; no Fabric). IL5: in-boundary
 * Cosmos; the refusal path (evaluateContract → 'refuse') is the compliance
 * posture and runs fully disconnected.
 */

import crypto from 'node:crypto';
import { semanticContractContainer, auditLogContainer } from './cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import {
  SEMANTIC_CONTRACT_SCHEMA_VERSION,
  SEMANTIC_SPEC_DOC_ID,
  VQR_MATCH_THRESHOLD,
  METRIC_MATCH_MIN,
  bestVerifiedMatch,
  bestMetricMatch,
  resolveSynonymIn,
  type MetricDoc,
  type MetricSourceKind,
  type SemanticSpecDoc,
  type VerifiedQueryDoc,
} from './semantic-contract-model';

export type {
  MetricDoc,
  MetricSourceKind,
  SemanticSpecDoc,
  VerifiedQueryDoc,
} from './semantic-contract-model';
export { VQR_MATCH_THRESHOLD, METRIC_MATCH_MIN } from './semantic-contract-model';

const now = () => new Date().toISOString();

/** Actor context threaded from an owned route session (for the audit trail). */
export interface ContractActor {
  oid: string;
  /** UPN / email / display fallback. */
  who: string;
  tenantId: string;
}

// ── Metric registry ──────────────────────────────────────────────────────────

/** Input shape for {@link registerMetric} (ids/timestamps stamped server-side). */
export interface MetricInput {
  metricId: string;
  label: string;
  owner: string;
  description: string;
  synonyms?: string[];
  grain: string;
  sourceKind: MetricSourceKind;
  sourceRef: string;
}

function metricDocId(metricId: string): string {
  return `metric:${String(metricId || '').trim()}`;
}

function normalizeSynonyms(s: unknown): string[] {
  if (Array.isArray(s)) {
    return Array.from(
      new Set(s.map((x) => String(x || '').trim()).filter(Boolean)),
    ).slice(0, 40);
  }
  if (typeof s === 'string') {
    return Array.from(
      new Set(s.split(',').map((x) => x.trim()).filter(Boolean)),
    ).slice(0, 40);
  }
  return [];
}

/**
 * Register (or update) a governed metric. Upserts by `metric:<metricId>` under
 * the owner's partition. Owner-scoped — `tenantId` is the caller's oid.
 */
export async function registerMetric(
  tenantId: string,
  input: MetricInput,
): Promise<MetricDoc> {
  const metricId = String(input.metricId || '').trim();
  if (!metricId) throw new Error('registerMetric: metricId is required');
  if (!String(input.label || '').trim()) throw new Error('registerMetric: label is required');
  const c = await semanticContractContainer();
  const id = metricDocId(metricId);
  let createdAt = now();
  let createdBy = tenantId;
  try {
    const { resource } = await c.item(id, tenantId).read<MetricDoc>();
    if (resource) {
      createdAt = resource.createdAt || createdAt;
      createdBy = resource.createdBy || createdBy;
    }
  } catch (e: unknown) {
    if ((e as { code?: number })?.code !== 404) throw e;
  }
  const doc: MetricDoc = {
    id,
    tenantId,
    docType: 'metric',
    schemaVersion: SEMANTIC_CONTRACT_SCHEMA_VERSION,
    metricId,
    label: String(input.label).trim(),
    owner: String(input.owner || '').trim(),
    description: String(input.description || '').trim(),
    synonyms: normalizeSynonyms(input.synonyms),
    grain: String(input.grain || '').trim(),
    sourceKind: input.sourceKind === 'measure' ? 'measure' : 'metric-view',
    sourceRef: String(input.sourceRef || '').trim(),
    createdAt,
    createdBy,
    updatedAt: now(),
    updatedBy: tenantId,
  };
  await c.items.upsert(doc);
  return doc;
}

/** List every governed metric for an owner. */
export async function listMetrics(tenantId: string): Promise<MetricDoc[]> {
  const c = await semanticContractContainer();
  const { resources } = await c.items
    .query<MetricDoc>({
      query: "SELECT * FROM c WHERE c.tenantId = @t AND c.docType = 'metric'",
      parameters: [{ name: '@t', value: tenantId }],
    })
    .fetchAll();
  return resources;
}

/**
 * Resolve a free-text term to a governed metric via the synonym index
 * (synonyms / label / metricId, case-insensitive). Returns null when nothing
 * in the owner's registry claims the term.
 */
export async function resolveSynonym(tenantId: string, term: string): Promise<MetricDoc | null> {
  const metrics = await listMetrics(tenantId);
  return resolveSynonymIn(term, metrics);
}

/** Best metric match for a question (label + synonyms overlap). */
export async function matchMetric(
  tenantId: string,
  question: string,
): Promise<{ metric: MetricDoc; confidence: number } | null> {
  const metrics = await listMetrics(tenantId);
  const hit = bestMetricMatch(question, metrics);
  return hit && hit.confidence >= METRIC_MATCH_MIN ? hit : null;
}

// ── N15: MetricFlow semantic spec (the compilable substrate) ─────────────────

/**
 * Read the tenant's stored MetricFlow-compatible semantic spec (the compilable
 * substrate N15's compiler folds to SQL). Owner-scoped; returns the parsed
 * `spec` payload (a MetricFlowSpec from lib/metrics/metricflow-spec.ts) or null
 * when the owner has imported none. EXTENDS N9's store (same container) — not a
 * fork. Fail-open at the caller (a metrics route falls through to an honest gate).
 */
export async function getSemanticSpec(tenantId: string): Promise<unknown | null> {
  const c = await semanticContractContainer();
  try {
    const { resource } = await c.item(SEMANTIC_SPEC_DOC_ID, tenantId).read<SemanticSpecDoc>();
    return resource?.spec ?? null;
  } catch (e: unknown) {
    if ((e as { code?: number })?.code === 404) return null;
    throw e;
  }
}

/**
 * Upsert the tenant's MetricFlow semantic spec (owner-scoped). Stamps the MIG1
 * schema version + created/updated provenance. The `spec` payload shape is owned
 * by lib/metrics/metricflow-spec.ts; this store keeps it opaque (`unknown`) so
 * the leaf model stays import-cycle-free.
 */
export async function putSemanticSpec(tenantId: string, spec: unknown): Promise<SemanticSpecDoc> {
  const c = await semanticContractContainer();
  let createdAt = now();
  let createdBy = tenantId;
  try {
    const { resource } = await c.item(SEMANTIC_SPEC_DOC_ID, tenantId).read<SemanticSpecDoc>();
    if (resource) {
      createdAt = resource.createdAt || createdAt;
      createdBy = resource.createdBy || createdBy;
    }
  } catch (e: unknown) {
    if ((e as { code?: number })?.code !== 404) throw e;
  }
  const doc: SemanticSpecDoc = {
    id: SEMANTIC_SPEC_DOC_ID,
    tenantId,
    docType: 'semantic-spec',
    schemaVersion: SEMANTIC_CONTRACT_SCHEMA_VERSION,
    spec,
    createdAt,
    createdBy,
    updatedAt: now(),
    updatedBy: tenantId,
  };
  await c.items.upsert(doc);
  return doc;
}

// ── Verified Query Repository (VQR) ──────────────────────────────────────────

/** Input for {@link addVerifiedQuery}. */
export interface VerifiedQueryInput {
  question: string;
  query: string;
  queryLang: VerifiedQueryDoc['queryLang'];
  sourceName: string;
  metricId?: string;
}

/**
 * Add a verified query as a DRAFT (unapproved → NOT retrieved at run time until
 * a steward approves it). Owner-scoped.
 */
export async function addVerifiedQuery(
  tenantId: string,
  input: VerifiedQueryInput,
): Promise<VerifiedQueryDoc> {
  const question = String(input.question || '').trim();
  const query = String(input.query || '').trim();
  if (!question) throw new Error('addVerifiedQuery: question is required');
  if (!query) throw new Error('addVerifiedQuery: query is required');
  const lang = (['sql', 'kql', 'dax', 'sparksql'] as const).includes(input.queryLang)
    ? input.queryLang
    : 'sql';
  const doc: VerifiedQueryDoc = {
    id: `vqr:${crypto.randomUUID()}`,
    tenantId,
    docType: 'vqr',
    schemaVersion: SEMANTIC_CONTRACT_SCHEMA_VERSION,
    question,
    query,
    queryLang: lang,
    sourceName: String(input.sourceName || '').trim(),
    status: 'draft',
    version: 1,
    metricId: input.metricId ? String(input.metricId).trim() : undefined,
    createdAt: now(),
    createdBy: tenantId,
    updatedAt: now(),
  };
  const c = await semanticContractContainer();
  await c.items.create(doc);
  return doc;
}

/**
 * List verified queries for an owner. `opts.approvedOnly` restricts to the rows
 * the runtime actually retrieves (default: all, for the editor's management view).
 */
export async function listVerifiedQueries(
  tenantId: string,
  opts: { approvedOnly?: boolean } = {},
): Promise<VerifiedQueryDoc[]> {
  const c = await semanticContractContainer();
  const query = opts.approvedOnly
    ? "SELECT * FROM c WHERE c.tenantId = @t AND c.docType = 'vqr' AND c.status = 'approved'"
    : "SELECT * FROM c WHERE c.tenantId = @t AND c.docType = 'vqr'";
  const { resources } = await c.items
    .query<VerifiedQueryDoc>({ query, parameters: [{ name: '@t', value: tenantId }] })
    .fetchAll();
  return resources;
}

/**
 * Approve a verified query (draft → approved), bumping its version so an
 * edit→re-approve is versioned. Writes the authoritative `_auditLog` row
 * `{ kind:'semantic.vqr.approve', who, oid, … }` and fans out via emitAuditEvent
 * (best-effort — an audit hiccup never blocks the approval, matching every other
 * admin mutation in this repo).
 */
export async function approveVerifiedQuery(
  tenantId: string,
  vqrId: string,
  actor: ContractActor,
): Promise<VerifiedQueryDoc> {
  const c = await semanticContractContainer();
  const { resource } = await c.item(vqrId, tenantId).read<VerifiedQueryDoc>();
  if (!resource) throw new Error('Verified query not found on this contract.');
  const priorStatus = resource.status;
  const priorVersion = resource.version || 1;
  const stamped = now();
  const next: VerifiedQueryDoc = {
    ...resource,
    status: 'approved',
    // Bump the version on a re-approval (already-approved → edited → re-approved);
    // the first draft→approved keeps version 1.
    version: priorStatus === 'approved' ? priorVersion + 1 : priorVersion,
    approvedAt: stamped,
    approvedBy: actor.who,
    approvedByOid: actor.oid,
    updatedAt: stamped,
  };
  await c.items.upsert(next);

  try {
    const audit = await auditLogContainer();
    await audit.items
      .create({
        id: `audit-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
        itemId: `semantic-contract:${vqrId}`,
        tenantId: actor.tenantId,
        who: actor.who,
        actorOid: actor.oid,
        oid: actor.oid,
        at: stamped,
        kind: 'semantic.vqr.approve',
        target: vqrId,
        detail: {
          question: next.question,
          sourceName: next.sourceName,
          priorStatus,
          version: next.version,
        },
      })
      .catch(() => undefined);
  } catch {
    /* audit failures are non-blocking */
  }
  emitAuditEvent({
    actorOid: actor.oid,
    actorUpn: actor.who,
    action: 'semantic.vqr.approve',
    targetType: 'semantic-contract-vqr',
    targetId: vqrId,
    tenantId: actor.tenantId,
    detail: { question: next.question, version: next.version, priorStatus },
  });
  return next;
}

/** Delete a verified query (owner-scoped). Returns true when a row was removed. */
export async function deleteVerifiedQuery(tenantId: string, vqrId: string): Promise<boolean> {
  const c = await semanticContractContainer();
  try {
    await c.item(vqrId, tenantId).delete();
    return true;
  } catch (e: unknown) {
    if ((e as { code?: number })?.code === 404) return false;
    throw e;
  }
}

/**
 * Best APPROVED verified-query match for a question + its confidence. Only
 * approved rows are considered (refuse-not-guess). Returns null when the owner
 * has no approved VQR at all.
 */
export async function matchVerifiedQuery(
  tenantId: string,
  question: string,
): Promise<{ vqr: VerifiedQueryDoc; confidence: number } | null> {
  const vqrs = await listVerifiedQueries(tenantId, { approvedOnly: true });
  return bestVerifiedMatch(question, vqrs);
}

// ── Contract evaluation (the runtime decision, consumed by the reasoning loop) ─

/**
 * The runtime decision the reasoning loop acts on:
 *   • `verified`  — an approved VQR cleared the threshold; run it verbatim.
 *   • `metric`    — no VQR, but a governed metric matches; ground generation on it.
 *   • `refuse`    — the contract is ACTIVE (has metrics and/or approved VQRs) but
 *                   nothing matched → decline with a guided message (no guessing).
 *   • `none`      — the contract is NOT in force (owner registered nothing) →
 *                   the agent behaves exactly as it did pre-N9 (non-breaking).
 */
export type ContractDecision =
  | { mode: 'none' }
  | { mode: 'verified'; vqr: VerifiedQueryDoc; confidence: number }
  | { mode: 'metric'; metric: MetricDoc; confidence: number }
  | { mode: 'refuse'; reason: string; suggestions: string[]; metricLabels: string[] };

/**
 * Evaluate the governed contract for a question. Fail-SAFE: any error (Cosmos
 * unreachable, no endpoint configured, …) yields `{ mode:'none' }` so a contract
 * subsystem hiccup NEVER takes an agent turn down — the turn falls through to the
 * normal grounded path exactly as before N9.
 *
 * The refuse path fires ONLY when the contract is active (the owner has
 * registered at least one metric OR one approved verified query); an owner who
 * has adopted nothing is never refused.
 */
export async function evaluateContract(
  tenantId: string | undefined,
  question: string,
): Promise<ContractDecision> {
  if (!tenantId || !String(question || '').trim()) return { mode: 'none' };
  try {
    const [metrics, approvedVqrs] = await Promise.all([
      listMetrics(tenantId),
      listVerifiedQueries(tenantId, { approvedOnly: true }),
    ]);
    // Contract not in force → behave exactly as pre-N9.
    if (metrics.length === 0 && approvedVqrs.length === 0) return { mode: 'none' };

    // 1) Verified-query retrieval FIRST.
    const vqrHit = bestVerifiedMatch(question, approvedVqrs);
    if (vqrHit && vqrHit.confidence >= VQR_MATCH_THRESHOLD) {
      return { mode: 'verified', vqr: vqrHit.vqr, confidence: vqrHit.confidence };
    }

    // 2) Metric-grounded generation for an in-contract-but-unmatched question.
    const metricHit = bestMetricMatch(question, metrics);
    if (metricHit && metricHit.confidence >= METRIC_MATCH_MIN) {
      return { mode: 'metric', metric: metricHit.metric, confidence: metricHit.confidence };
    }

    // 3) Out of contract → REFUSE with a guided message (never guess).
    const suggestions = approvedVqrs.slice(0, 5).map((v) => v.question);
    const metricLabels = metrics.slice(0, 8).map((m) => m.label);
    return {
      mode: 'refuse',
      reason:
        'This question is outside the governed semantic contract for this agent — no approved verified query matched it and it does not reference a governed metric.',
      suggestions,
      metricLabels,
    };
  } catch {
    return { mode: 'none' };
  }
}
