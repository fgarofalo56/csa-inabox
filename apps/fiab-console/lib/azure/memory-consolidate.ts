/**
 * CTS-13 — nightly memory consolidation pass (REM-analog, Cosmos-native).
 *
 * For each memory scope it: pulls the recent memories, merges near-duplicates
 * (dropping the lower-salience side), flags contradictory pairs into the
 * `copilot-memory-contradictions` review queue, promotes recurring tags into
 * `copilot-topic-pages`, and emits a per-scope ConsolidationReport. Relationship
 * reinforcement is the usage-weighted `recallCount` maintained on recall (not a
 * graph traversal) — no Neo4j, per the PRP.
 *
 * The dedupe/contradiction/topic logic is the PURE reducer in
 * memory-consolidate-core.ts; this module is the Cosmos I/O + orchestration.
 * All writes go through the store's delete path (which also prunes the vector
 * mirror). Azure-native — Cosmos + AI Search, no Fabric dependency.
 */

import {
  copilotMemoryContainer,
  copilotMemoryContradictionsContainer,
  copilotTopicPagesContainer,
} from './cosmos-client';
import { listMemories, deleteMemory } from './memory-store';
import {
  planDedupe,
  detectContradictions,
  promoteTopics,
  type ConsolidationReport,
} from '@/lib/copilot/memory-consolidate-core';

const intEnv = (name: string, def: number) => Math.max(1, parseInt(process.env[name] || String(def), 10) || def);

/** Enumerate every distinct memory scope key (cross-partition — infrequent job). */
async function listScopeKeys(limit: number): Promise<string[]> {
  const c = await copilotMemoryContainer();
  const { resources } = await c.items
    .query<{ scopeKey: string }>({
      query: 'SELECT DISTINCT c.scopeKey FROM c OFFSET 0 LIMIT @n',
      parameters: [{ name: '@n', value: limit }],
    })
    .fetchAll();
  return resources.map((r) => r.scopeKey).filter(Boolean);
}

/** Consolidate one scope. Returns its report. */
export async function consolidateScope(scopeKey: string): Promise<ConsolidationReport> {
  const at = new Date().toISOString();
  const records = await listMemories([scopeKey], intEnv('LOOM_COPILOT_MEMORY_CONSOLIDATE_SCAN', 400));
  const report: ConsolidationReport = { scopeKey, scanned: records.length, merged: 0, contradictions: 0, topics: 0, at };
  if (records.length < 2) return report;

  const simThreshold = Number(process.env.LOOM_COPILOT_MEMORY_DEDUPE_SIM || '0.6') || 0.6;
  const dedupe = planDedupe(records, simThreshold);
  for (const id of dedupe.drop) {
    if (await deleteMemory(scopeKey, id)) report.merged += 1;
  }

  const contradictions = detectContradictions(records, 0.5);
  if (contradictions.length) {
    const cc = await copilotMemoryContradictionsContainer();
    for (const c of contradictions) {
      try {
        await cc.items.upsert({
          id: `contra:${c.a}:${c.b}`,
          scopeKey,
          docType: 'contradiction',
          a: c.a,
          b: c.b,
          similarity: c.similarity,
          status: 'open',
          at,
        });
        report.contradictions += 1;
      } catch {
        /* continue */
      }
    }
  }

  const topics = promoteTopics(records, intEnv('LOOM_COPILOT_MEMORY_TOPIC_MIN', 3));
  if (topics.length) {
    const tp = await copilotTopicPagesContainer();
    for (const t of topics) {
      try {
        await tp.items.upsert({
          id: `topic:${t.tag}`,
          scopeKey,
          docType: 'topic-page',
          tag: t.tag,
          count: t.count,
          memoryIds: t.memoryIds,
          updatedAt: at,
        });
        report.topics += 1;
      } catch {
        /* continue */
      }
    }
  }
  return report;
}

export interface ConsolidationRun {
  scopes: number;
  reports: ConsolidationReport[];
  totalMerged: number;
  totalContradictions: number;
  totalTopics: number;
  at: string;
}

/** Run consolidation across every scope. Bounded by LOOM_COPILOT_MEMORY_CONSOLIDATE_MAX_SCOPES. */
export async function runConsolidation(): Promise<ConsolidationRun> {
  const at = new Date().toISOString();
  const scopeKeys = await listScopeKeys(intEnv('LOOM_COPILOT_MEMORY_CONSOLIDATE_MAX_SCOPES', 2000));
  const reports: ConsolidationReport[] = [];
  for (const scopeKey of scopeKeys) {
    try {
      reports.push(await consolidateScope(scopeKey));
    } catch {
      /* one bad scope must not fail the whole run */
    }
  }
  return {
    scopes: reports.length,
    reports,
    totalMerged: reports.reduce((s, r) => s + r.merged, 0),
    totalContradictions: reports.reduce((s, r) => s + r.contradictions, 0),
    totalTopics: reports.reduce((s, r) => s + r.topics, 0),
    at,
  };
}
