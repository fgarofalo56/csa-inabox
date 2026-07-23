/**
 * E5 — server-only reads for /admin/copilot-quality.
 *
 * The copilot-evaluator Function (E2) WRITES `eval-run` / `eval-result` docs to
 * Cosmos `loom-copilot-evals` (PK /surface); this module READS them for the
 * admin quality page through `copilotEvalsContainer()` (which wraps the
 * container in the MIG1 migrate-on-read chain). The E3 per-surface floors
 * (content/evals/eval-floors.json) are read from the in-image staged corpus
 * (copilot-corpus/evals/, per scripts/csa-loom/stage-copilot-corpus.sh) or the
 * repo checkout. No mocks, no Fabric dependency — pure Cosmos + FS reads.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { copilotEvalsContainer } from '@/lib/azure/cosmos-client';
import type {
  CopilotEvalRunDoc, CopilotEvalResultDoc, CopilotSearchRunDoc, CopilotSearchResultDoc,
  CopilotTierRunDoc, CopilotTierResultDoc,
} from '@/lib/azure/copilot-evals-model';
import type { EvalFloors, SearchFloors, TierFloors } from '@/lib/admin/copilot-quality';

/** Bound the run scan — 10 surfaces × retained runs; ~200 is generous. */
const MAX_RUN_DOCS = 400;
/** Bound a single surface's per-question drill-in read. */
const MAX_RESULT_DOCS = 200;

// ── Floors (content/evals/eval-floors.json) ──────────────────────────────────

export interface EvalFloorsFile {
  floors: EvalFloors;
  searchFloors: SearchFloors;
  tierFloors: TierFloors;
  meta?: { lastRatchet?: string | null; note?: string };
}

/** Candidate locations for eval-floors.json, first hit wins (mirrors E2 resolveEvalRoot). */
function resolveFloorsPath(): string | null {
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, 'copilot-corpus', 'evals', 'eval-floors.json'),
    path.join(cwd, 'evals', 'eval-floors.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  let dir = cwd;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'content', 'evals', 'eval-floors.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Read the E3 floors file. Missing file ⇒ empty floors ({}) so every metric
 * reports 'no-floor' (honest — never a fabricated floor). A parse error is
 * swallowed to empty floors (the page still renders scores; the floor column
 * just shows no-floor) rather than 500ing the whole surface.
 */
export function loadEvalFloors(): EvalFloorsFile {
  const p = resolveFloorsPath();
  if (!p) return { floors: {}, searchFloors: {}, tierFloors: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      floors?: EvalFloors; searchFloors?: SearchFloors; tierFloors?: TierFloors;
      _meta?: { lastRatchet?: string | null; note?: string };
    };
    return { floors: raw.floors ?? {}, searchFloors: raw.searchFloors ?? {}, tierFloors: raw.tierFloors ?? {}, meta: raw._meta };
  } catch {
    return { floors: {}, searchFloors: {}, tierFloors: {} };
  }
}

// ── Cosmos reads ─────────────────────────────────────────────────────────────

/**
 * Every retained `eval-run` roll-up doc across all surfaces (cross-partition,
 * bounded MAX_RUN_DOCS, newest first). The '#ledger' judge-spend docs are
 * excluded by the docType filter. Returns [] when the container has no runs yet
 * (the page renders the guided EmptyState).
 */
export async function listEvalRuns(): Promise<CopilotEvalRunDoc[]> {
  const c = await copilotEvalsContainer();
  const { resources } = await c.items
    .query<CopilotEvalRunDoc>(
      {
        query:
          "SELECT * FROM c WHERE c.docType = 'eval-run' ORDER BY c.finishedAt DESC OFFSET 0 LIMIT @n",
        parameters: [{ name: '@n', value: MAX_RUN_DOCS }],
      },
      { maxItemCount: MAX_RUN_DOCS },
    )
    .fetchAll();
  return resources;
}

/** The list of surfaces (partition keys) that have at least one run, for a targeted read. */
export async function surfaceRunHistory(surface: string): Promise<CopilotEvalRunDoc[]> {
  const c = await copilotEvalsContainer();
  const { resources } = await c.items
    .query<CopilotEvalRunDoc>(
      {
        query:
          "SELECT * FROM c WHERE c.docType = 'eval-run' AND c.surface = @s ORDER BY c.finishedAt DESC",
        parameters: [{ name: '@s', value: surface }],
      },
      { partitionKey: surface },
    )
    .fetchAll();
  return resources;
}

/**
 * The per-question `eval-result` docs for one surface run (single-partition —
 * PK /surface). Bounded MAX_RESULT_DOCS. When `runId` is omitted the latest
 * run's results are returned (resolved from the surface's newest run doc).
 */
export async function surfaceResults(
  surface: string,
  runId?: string,
): Promise<{ runId: string | null; results: CopilotEvalResultDoc[] }> {
  const c = await copilotEvalsContainer();
  let targetRun = runId;
  if (!targetRun) {
    const history = await surfaceRunHistory(surface);
    targetRun = history[0]?.runId;
  }
  if (!targetRun) return { runId: null, results: [] };
  const { resources } = await c.items
    .query<CopilotEvalResultDoc>(
      {
        query:
          "SELECT * FROM c WHERE c.docType = 'eval-result' AND c.surface = @s AND c.runId = @r OFFSET 0 LIMIT @n",
        parameters: [
          { name: '@s', value: surface },
          { name: '@r', value: targetRun },
          { name: '@n', value: MAX_RESULT_DOCS },
        ],
      },
      { partitionKey: surface },
    )
    .fetchAll();
  return { runId: targetRun, results: resources };
}

// ── SRCH1 — federated-search relevance reads ─────────────────────────────────

/** Every retained `search-run` doc across all domains (bounded, newest first). */
export async function listSearchRuns(): Promise<CopilotSearchRunDoc[]> {
  const c = await copilotEvalsContainer();
  const { resources } = await c.items
    .query<CopilotSearchRunDoc>(
      {
        query:
          "SELECT * FROM c WHERE c.docType = 'search-run' ORDER BY c.finishedAt DESC OFFSET 0 LIMIT @n",
        parameters: [{ name: '@n', value: MAX_RUN_DOCS }],
      },
      { maxItemCount: MAX_RUN_DOCS },
    )
    .fetchAll();
  return resources;
}

/** The per-query `search-result` docs for one domain's latest (or given) run. */
export async function searchDomainResults(
  domain: string,
  runId?: string,
): Promise<{ runId: string | null; results: CopilotSearchResultDoc[] }> {
  const c = await copilotEvalsContainer();
  const surface = `search:${domain}`;
  let targetRun = runId;
  if (!targetRun) {
    const { resources } = await c.items
      .query<CopilotSearchRunDoc>(
        {
          query:
            "SELECT * FROM c WHERE c.docType = 'search-run' AND c.surface = @s ORDER BY c.finishedAt DESC OFFSET 0 LIMIT 1",
          parameters: [{ name: '@s', value: surface }],
        },
        { partitionKey: surface },
      )
      .fetchAll();
    targetRun = resources[0]?.runId;
  }
  if (!targetRun) return { runId: null, results: [] };
  const { resources } = await c.items
    .query<CopilotSearchResultDoc>(
      {
        query:
          "SELECT * FROM c WHERE c.docType = 'search-result' AND c.surface = @s AND c.runId = @r OFFSET 0 LIMIT @n",
        parameters: [
          { name: '@s', value: surface },
          { name: '@r', value: targetRun },
          { name: '@n', value: MAX_RESULT_DOCS },
        ],
      },
      { partitionKey: surface },
    )
    .fetchAll();
  return { runId: targetRun, results: resources };
}

// ── E6 — tier-router decision reads (PK 'tier:router') ───────────────────────

/** Every retained `tier-run` doc (single partition 'tier:router', newest first). */
export async function listTierRuns(): Promise<CopilotTierRunDoc[]> {
  const c = await copilotEvalsContainer();
  const { resources } = await c.items
    .query<CopilotTierRunDoc>(
      {
        query:
          "SELECT * FROM c WHERE c.docType = 'tier-run' AND c.surface = 'tier:router' ORDER BY c.finishedAt DESC OFFSET 0 LIMIT @n",
        parameters: [{ name: '@n', value: MAX_RUN_DOCS }],
      },
      { partitionKey: 'tier:router' },
    )
    .fetchAll();
  return resources;
}

/** The per-decision `tier-result` docs for the latest (or given) tier run. */
export async function tierRunResults(
  runId?: string,
): Promise<{ runId: string | null; results: CopilotTierResultDoc[] }> {
  const c = await copilotEvalsContainer();
  let targetRun = runId;
  if (!targetRun) {
    const { resources } = await c.items
      .query<CopilotTierRunDoc>(
        {
          query:
            "SELECT * FROM c WHERE c.docType = 'tier-run' AND c.surface = 'tier:router' ORDER BY c.finishedAt DESC OFFSET 0 LIMIT 1",
        },
        { partitionKey: 'tier:router' },
      )
      .fetchAll();
    targetRun = resources[0]?.runId;
  }
  if (!targetRun) return { runId: null, results: [] };
  const { resources } = await c.items
    .query<CopilotTierResultDoc>(
      {
        query:
          "SELECT * FROM c WHERE c.docType = 'tier-result' AND c.surface = 'tier:router' AND c.runId = @r OFFSET 0 LIMIT @n",
        parameters: [
          { name: '@r', value: targetRun },
          { name: '@n', value: MAX_RESULT_DOCS },
        ],
      },
      { partitionKey: 'tier:router' },
    )
    .fetchAll();
  return { runId: targetRun, results: resources };
}
