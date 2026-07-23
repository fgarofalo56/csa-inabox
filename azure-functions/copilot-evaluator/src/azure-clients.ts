/**
 * copilot-evaluator — real Azure data-plane clients:
 *
 *   - probeConsole()        — POST the console's internal eval-probe route
 *                             (/api/internal/copilot/eval-probe) so retrieval +
 *                             the Copilot turn are BYTE-IDENTICAL to production
 *                             (the console runs the real searchDocs + one
 *                             aoai-chat-client turn; wiring (a) of the E2 spec).
 *   - readCorpusManifest()  — GET the same route → the staged corpus commit.
 *   - judgeAnswer()         — AOAI chat-completions under the Function's managed
 *                             identity via the UNIFIED contract: bearer on the
 *                             sovereign-correct Cognitive Services scope,
 *                             `max_completion_tokens` (never `max_tokens`), one
 *                             retry without `temperature` on the
 *                             unsupported-sampling-param 400.
 *   - writeRun/writeResults — Cosmos `loom-copilot-evals` (PK /surface; results
 *                             carry ttl 180d, run summaries are retained).
 *   - judge-spend ledger    — one Cosmos doc per UTC day enforcing the
 *                             LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP across replicas.
 *
 * No keys anywhere (identity-based storage + AAD Cosmos + AAD AOAI); the only
 * shared secret is the VNet-internal trust token for the console probe call.
 * Azure-native, no Microsoft Fabric dependency.
 *
 * Model names are NEVER hardcoded: the judge deployment resolves via the env
 * chain (evaluator-core.resolveJudgeDeployment) and honest-gate messages name
 * the best per-cloud reasoning model via the console's Learn-grounded
 * availability matrix (bestReasoningModelFor — shared pure module, E2
 * cross-cutting "import-both" rule).
 */
import { DefaultAzureCredential } from '@azure/identity';
import { CosmosClient, type Container } from '@azure/cosmos';
import { bestReasoningModelFor } from '../../../apps/fiab-console/lib/foundry/model-tier-router';
import type { LoomCloud } from '../../../apps/fiab-console/lib/azure/cloud-endpoints';
import type { EvalResult, JudgeScores, ProbeResult, RunTotals, SearchHitRef, SearchEvalResult } from './evaluator-core';
import { parseJudge } from './evaluator-core';

const cred = new DefaultAzureCredential();

export const EVALS_CONTAINER = 'loom-copilot-evals';
/** 180 days, per the E2 data-model TTL contract for eval-result docs. */
const RESULT_TTL_SECONDS = 180 * 24 * 60 * 60;
const INTERNAL_TOKEN_HEADER = 'x-loom-internal-token';

/** Sovereign boundary detection from the AOAI endpoint host (Gov = *.azure.us). */
export function cloudForEndpoint(aoaiEndpoint: string): LoomCloud {
  return /\.azure\.us/i.test(aoaiEndpoint || '') ? 'GCC-High' : 'Commercial';
}

/** The best per-cloud reasoning model name for honest-gate messaging (never hardcoded). */
export function judgeModelHint(aoaiEndpoint: string): string {
  return bestReasoningModelFor(cloudForEndpoint(aoaiEndpoint));
}

async function tokenFor(scope: string): Promise<string> {
  const t = await cred.getToken(scope);
  if (!t?.token) throw new Error(`failed to acquire token for ${scope}`);
  return t.token;
}

// ── Console eval-probe (wiring (a): byte-identical retrieval + tier routing) ─

export interface ProbeRequest {
  question: string;
  surface?: string;
  top?: number;
}

/** POST the console's internal eval-probe: real searchDocs + one real Copilot
 *  turn through aoai-chat-client. Auth = the shared VNet-internal trust token.
 *  Returns the probe result + the retrieved-chunk previews (judge evidence). */
export async function probeConsole(
  baseUrl: string,
  internalToken: string,
  body: ProbeRequest,
): Promise<{ probe: ProbeResult; excerpts: string[] }> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/internal/copilot/eval-probe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [INTERNAL_TOKEN_HEADER]: internalToken },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`eval-probe ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j: any = await res.json();
  if (!j?.ok) throw new Error(`eval-probe returned ok:false — ${String(j?.error || '').slice(0, 200)}`);
  const chunks: any[] = Array.isArray(j.retrievedChunks) ? j.retrievedChunks : [];
  return {
    probe: {
      retrievedChunks: chunks.map((c: any) => String(c?.id ?? c)),
      answer: String(j.answer ?? ''),
      tier: String(j.tier ?? ''),
      taskClass: j.taskClass ? String(j.taskClass) : undefined,
      backend: j.backend ? String(j.backend) : undefined,
      latencyMs: Number(j.latencyMs ?? 0),
    },
    excerpts: chunks.map((c: any) => String(c?.preview ?? '')).filter(Boolean),
  };
}

export interface CorpusManifestInfo {
  corpusCommit: string;
  total?: number;
}

/** GET the eval-probe route → the staged corpus manifest (commit + counts). */
export async function readCorpusManifest(
  baseUrl: string,
  internalToken: string,
): Promise<CorpusManifestInfo | null> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/internal/copilot/eval-probe`, {
    method: 'GET',
    headers: { [INTERNAL_TOKEN_HEADER]: internalToken },
  });
  if (!res.ok) return null;
  const j: any = await res.json().catch(() => null);
  if (!j?.ok) return null;
  return { corpusCommit: String(j.corpusCommit || ''), total: Number(j.corpusTotal ?? 0) || undefined };
}

// ── Federated-search eval-probe (SRCH1: real searchCatalog ranking) ──────────

/** POST the console's internal search eval-probe → the REAL federated catalog
 *  search ranking for one query, run AS the evaluator identity (ACL-scoped). */
export async function probeSearch(
  baseUrl: string,
  internalToken: string,
  body: { query: string; oid?: string; top?: number; types?: string[] },
): Promise<{ results: SearchHitRef[]; backend?: string; latencyMs: number }> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/internal/search/eval-probe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [INTERNAL_TOKEN_HEADER]: internalToken },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`search eval-probe ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j: any = await res.json();
  if (!j?.ok) throw new Error(`search eval-probe returned ok:false — ${String(j?.error || '').slice(0, 200)}`);
  const hits: any[] = Array.isArray(j.results) ? j.results : [];
  return {
    results: hits.map((h: any) => ({
      id: String(h?.id ?? ''),
      displayName: String(h?.displayName ?? ''),
      itemType: h?.itemType ? String(h.itemType) : undefined,
    })),
    backend: j.backend ? String(j.backend) : undefined,
    latencyMs: Number(j.latencyMs ?? 0),
  };
}

/** Write a domain's per-query search results as `eval-result` docs (surface
 *  'search:<domain>') so E5's drill-in + check-eval-regression read them
 *  through the SAME container/machinery. */
export async function writeSearchResults(
  endpoint: string,
  database: string,
  runId: string,
  surface: string,
  results: SearchEvalResult[],
): Promise<void> {
  const c = await evalsContainer(endpoint, database);
  for (const r of results) {
    await c.items.upsert({
      id: `${runId}:${r.queryId}`,
      surface,
      runId,
      docType: 'eval-result',
      schemaVersion: 1,
      ttl: RESULT_TTL_SECONDS,
      questionId: r.queryId,
      question: r.query,
      expectedChunks: r.expectedResults,
      retrievedChunks: r.retrievedResults,
      retrievalHit: r.hit,
      mrr: r.mrr,
      ndcg: r.ndcg,
      mentionPass: true,
      forbiddenHit: false,
      judgeStatus: 'deferred',
      pass: r.hit,
      answer: '',
      tier: '',
      latencyMs: r.latencyMs,
      backend: r.backend,
    });
  }
}

// ── AOAI judge (unified contract: max_completion_tokens + sampling retry) ────

function isUnsupportedSamplingParam(body: string): boolean {
  return /unsupported[_ ]?(value|parameter)|does not support|only the default temperature/i.test(body || '');
}

/** One judge chat-completion. Sovereign-correct scope; `max_completion_tokens`
 *  per the unified AOAI contract; one retry without `temperature` on the
 *  reasoning-model sampling rejection. Returns parsed rubric scores or null. */
export async function judgeAnswer(
  aoaiEndpoint: string,
  deployment: string,
  messages: { role: string; content: string }[],
): Promise<JudgeScores | null> {
  const base = aoaiEndpoint.replace(/\/$/, '');
  const scope = /\.azure\.us/i.test(base)
    ? 'https://cognitiveservices.azure.us/.default'
    : 'https://cognitiveservices.azure.com/.default';
  const token = await tokenFor(scope);
  const url = `${base}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=2024-08-01-preview`;
  const send = (withTemperature: boolean) =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messages,
        max_completion_tokens: 400,
        ...(withTemperature ? { temperature: 0 } : {}),
        response_format: { type: 'json_object' },
      }),
    });
  let res = await send(true);
  if (res.status === 400) {
    const t = await res.text();
    if (isUnsupportedSamplingParam(t)) res = await send(false);
    else throw new Error(`AOAI judge 400: ${t.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`AOAI judge ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j: any = await res.json();
  return parseJudge(String(j?.choices?.[0]?.message?.content ?? ''));
}

// ── Cosmos: loom-copilot-evals (PK /surface) ─────────────────────────────────

let _container: Container | null = null;

async function evalsContainer(endpoint: string, database: string): Promise<Container> {
  if (_container) return _container;
  const client = new CosmosClient({ endpoint, aadCredentials: cred });
  const { database: db } = await client.databases.createIfNotExists({ id: database });
  // defaultTtl -1 = TTL enabled, no default expiry: result docs carry ttl 180d,
  // run summaries carry none (retained indefinitely) — the E2 data model.
  const { container } = await db.containers.createIfNotExists({
    id: EVALS_CONTAINER,
    partitionKey: { paths: ['/surface'] },
    defaultTtl: -1,
  });
  _container = container;
  return container;
}

export interface EvalRunDoc {
  id: string;
  surface: string;
  runId: string;
  docType: 'eval-run';
  /** MIG1 versioned-doc convention (lib/azure/cosmos-migrations.ts): v1. */
  schemaVersion: 1;
  corpusCommit: string;
  startedAt: string;
  finishedAt: string;
  judgeModel: string;
  trigger: 'corpus' | 'nightly' | 'manual';
  totals: RunTotals;
}

export async function writeRun(
  endpoint: string,
  database: string,
  doc: EvalRunDoc,
): Promise<void> {
  const c = await evalsContainer(endpoint, database);
  await c.items.upsert(doc);
}

export async function writeResults(
  endpoint: string,
  database: string,
  runId: string,
  results: (EvalResult & { question: string; expectedChunks: string[]; retrievedChunks: string[]; answer: string; tier: string })[],
): Promise<void> {
  const c = await evalsContainer(endpoint, database);
  for (const r of results) {
    await c.items.upsert({
      id: `${runId}:${r.questionId}`,
      docType: 'eval-result',
      schemaVersion: 1,
      runId,
      ttl: RESULT_TTL_SECONDS,
      ...r,
    });
  }
}

/** Read today's judge-spend ledger (cross-replica daily-cap enforcement). */
export async function readJudgedToday(
  endpoint: string,
  database: string,
  day: string,
): Promise<number> {
  const c = await evalsContainer(endpoint, database);
  try {
    const { resource } = await c.item(`judge-ledger:${day}`, '#ledger').read<any>();
    return Number(resource?.count ?? 0) || 0;
  } catch {
    return 0; // 404 = nothing judged today
  }
}

/** Persist the incremented judge-spend count (ttl 7d — the ledger self-evicts). */
export async function writeJudgedToday(
  endpoint: string,
  database: string,
  day: string,
  count: number,
): Promise<void> {
  const c = await evalsContainer(endpoint, database);
  await c.items.upsert({
    id: `judge-ledger:${day}`,
    surface: '#ledger',
    docType: 'judge-ledger',
    schemaVersion: 1,
    day,
    count,
    ttl: 7 * 24 * 60 * 60,
  });
}
