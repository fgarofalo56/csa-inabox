/**
 * lineage-extractor — one-shot entrypoint (loom-next-level WS-L, L3).
 *
 * Invoked once per Container App Job scheduled execution (LINEAGE_EXTRACTOR_CRON,
 * default every 15 min). It derives column-level lineage from COMPLETED ADF /
 * Synapse Copy-activity runs and UPSERTs it into the Loom `thread-edges` store
 * (the L1 column model). Idempotent: edges use a deterministic id and processed
 * run ids are cached in the watermark, so re-processing a run never duplicates.
 *
 * Exit policy mirrors synthetic-monitor: an HONEST config gate (no ADF/Synapse
 * configured, no Cosmos) logs and exits 0 (not a failure); only a real,
 * unexpected error exits 1 so the Job execution is marked Failed and alerting
 * fires.
 */
import {
  readWatermark, writeWatermark, runSources, listCompletedRuns,
  getPipelineDef, resolveDataset, upsertLineageEdge, type Watermark, type PipelineRun,
} from './clients';
import { extractLineageEdges, readCopyColumnMappings, type DatasetEndpoint } from './extract';

/** Collect the distinct dataset names a pipeline def's Copy activities touch. */
function copyDatasetNames(pipelineDef: unknown): string[] {
  const names = new Set<string>();
  for (const c of readCopyColumnMappings(pipelineDef)) {
    if (c.sourceDataset) names.add(c.sourceDataset);
    if (c.sinkDataset) names.add(c.sinkDataset);
  }
  return [...names];
}

export async function runOnce(): Promise<{ runs: number; edges: number; skipped: number }> {
  if (!process.env.LOOM_COSMOS_ENDPOINT) {
    console.log('[lineage-extractor] LOOM_COSMOS_ENDPOINT unset — nothing to write; exiting cleanly (honest gate).');
    return { runs: 0, edges: 0, skipped: 0 };
  }
  const sources = await runSources();
  if (!sources.length) {
    console.log('[lineage-extractor] no ADF factory / Synapse workspace configured — exiting cleanly (honest gate).');
    return { runs: 0, edges: 0, skipped: 0 };
  }

  const wm: Watermark = await readWatermark();
  const processed = new Set(wm.processedRunIds);
  let maxRunEnd = wm.lastRunEnd;
  let runCount = 0;
  let edgeCount = 0;
  let skipped = 0;

  for (const src of sources) {
    let runs: PipelineRun[] = [];
    try {
      runs = await listCompletedRuns(src, wm.lastRunEnd);
    } catch (e: any) {
      console.error(`[lineage-extractor] ${src.kind} queryPipelineRuns failed: ${e?.message || e}`);
      continue;
    }
    for (const run of runs) {
      if (processed.has(run.runId)) continue;
      try {
        const pipelineDef = await getPipelineDef(src, run.pipelineName);
        const datasetNames = copyDatasetNames(pipelineDef);
        const endpoints: Record<string, DatasetEndpoint> = {};
        for (const name of datasetNames) {
          endpoints[name] = await resolveDataset(src, name);
        }
        const edges = extractLineageEdges(pipelineDef, endpoints, { action: 'adf-copy', runId: run.runId });
        for (const edge of edges) {
          await upsertLineageEdge(edge);
          edgeCount++;
        }
        if (!edges.length) skipped++;
        runCount++;
      } catch (e: any) {
        console.error(`[lineage-extractor] run ${run.runId} (${run.pipelineName}) failed: ${e?.message || e}`);
        skipped++;
      }
      processed.add(run.runId);
      if (run.runEnd && run.runEnd > maxRunEnd) maxRunEnd = run.runEnd;
    }
  }

  await writeWatermark({ lastRunEnd: maxRunEnd, processedRunIds: [...processed] });
  console.log(`[lineage-extractor] processed ${runCount} run(s), wrote ${edgeCount} edge(s), ${skipped} without column-resolvable endpoints. Watermark → ${maxRunEnd}`);
  return { runs: runCount, edges: edgeCount, skipped };
}

runOnce()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`[lineage-extractor] FATAL: ${e?.stack || e?.message || e}`);
    process.exit(1);
  });
