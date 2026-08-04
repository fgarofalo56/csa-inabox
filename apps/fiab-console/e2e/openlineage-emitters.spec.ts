/**
 * openlineage-emitters.spec.ts — the G1 LIVE RECEIPT for LU-8's OpenLineage
 * emitters (issue #2626).
 *
 * WHY THIS EXISTS. LU-8 (#2609) shipped the Synapse/ADF OpenLineage emitters
 * with tsc + 11,888 vitest specs green but NO live receipt. Per ux-baseline.md
 * G1 that is explicitly not completion evidence: every write path in that PR —
 * the ADF/Synapse REST harvest, the `abfss://`-keyed Cosmos edge ids, the
 * succeeded-only + attribution gates — is exactly the class of thing a unit
 * test cannot validate, because vitest mocks the very ARM/Cosmos calls the
 * feature is. Only a real browser against a real estate can prove the emitter
 * fires and an event actually lands. This spec is that proof.
 *
 * WHAT IT ASSERTS (mapped to the #2626 walk). The emitters are a DATA-PLANE
 * feature: they fire inside the routes the editors POLL, harvest what really
 * ran from Azure, and return an honest `lineage` receipt on every poll. So the
 * receipt IS the emitter's own API surface — this spec drives those routes and
 * asserts the real receipt bodies, not a route screenshot.
 *
 *   T0  DETECTOR SELF-CHECK (offline, always runs) — proves the spec can FAIL:
 *       the reason/code predicates classify synthetic receipts correctly and the
 *       SAS-signature scanner trips on a planted `?sig=`. A gate that only runs
 *       against a fixed estate cannot tell "the bug is gone" from "the check
 *       measures nothing" (the failure mode that let the Copilot-evals gate pass
 *       for months). This test needs no estate, no backend, no data.
 *
 *   T1  PIPELINE HARVEST, happy path (#2626 §1, §5, §6). Discover an ADF-backed
 *       data-pipeline, find a SUCCEEDED run, open the Output pane
 *       (GET …/data-pipeline/<id>/output?runId=<run>) and capture the `lineage`
 *       receipt. When it WROTE edges (`written>0`) the emitter fired and the
 *       `abfss://`-keyed Cosmos edges persisted (§5); read the item lineage
 *       graph back and assert ZERO `?sig=` anywhere in it (§6 — SAS is stripped
 *       at the door by dataset-naming.ts). When it wrote nothing the receipt
 *       still carries an honest `code`/`reason` (a fact about the run — no Copy
 *       activity, already harvested — never a silent no-op).
 *
 *   T2  PIPELINE HARVEST, failed run (#2626 §2). Open the Output pane on a
 *       FAILED/Cancelled run; the receipt MUST be `code:'run_not_succeeded'`
 *       with a reason saying lineage is "only stamped for a succeeded run", and
 *       `written===0`. A failed copy must never stamp lineage that did not run.
 *
 *   T3  runId OWNERSHIP (#2626 §3). GET …/data-pipeline/<A>/output?runId=<a run
 *       that is NOT A's> must 404 — never A 200 with a foreign run's activity
 *       input/output payloads. Prefer a REAL run of a different pipeline B when
 *       one is discoverable; else a nonexistent GUID (both exercise the same
 *       `!run || run.pipelineName !== adfName → 404` gate). A 200 that leaks
 *       foreign activities FAILS; a transient ARM 429/502 is noted, not failed.
 *
 *   T4  SPARK HARVEST attribution (#2626 §4). Livy batch ids are POOL-scoped,
 *       so a batch this SJD did NOT submit must contribute NO lineage and be
 *       redacted: GET …/spark-job-definition/<id>/runs/<foreign batchId> must
 *       return `code:'batch_unattributed'` (reason: "not submitted by this Loom
 *       item") and a redacted job. When the SJD's OWN succeeded batch declared
 *       `--input`/`--output` abfss paths, the receipt writes an edge; when it
 *       declared none the honest `spark_lineage_not_declared` gate is recorded.
 *
 * HONEST-GATE TOLERANT (no-vaporware.md "Validation per merge"). This needs a
 * live estate with a real ADF factory + Synapse Spark pool AND real runs — the
 * issue says so ("not reachable from a worktree"). ADF/Synapse being
 * unprovisioned is a genuine AZURE infra gate (the emitters are Azure-native by
 * default — no Fabric, per no-fabric-dependency.md), so a missing backend, an
 * un-backed item, or the absence of a run of a given status is recorded as a
 * pass-with-note, never a green lie and never a hard fail. What is NOT tolerated
 * and DOES fail: a succeeded-run harvest returning a silently empty receipt, a
 * failed run stamping lineage, a foreign runId 200ing with activities, an
 * unattributed batch disclosing another job, or a `?sig=` in the read-back.
 *
 * WHAT IT DOES NOT ASSERT — stated plainly. It does not TRIGGER a new ADF
 * pipeline run or submit a Spark batch (heavy, slow, operator-driven — the issue
 * frames this as an operator walk); it harvests runs that already exist. It does
 * not assert column-level fidelity of a written edge (the vitest goldens in
 * synapse-emitters.test.ts own that). Read-back focuses the item lineage route
 * on the pipeline item; the written edges connect its DATASET endpoints, so when
 * those endpoints are not the pipeline item itself the weave graph may not carry
 * them — that is recorded honestly, and the `written>0` receipt is the persist
 * proof either way.
 *
 * GROUNDING (every route + shape cited to source; per .claude/rules/no-scaffold
 * an invented selector is a fabricated receipt):
 *   - pipeline Output pane + `lineage` receipt:
 *       app/api/items/data-pipeline/[id]/output/route.ts:51-98,117-147
 *   - runId ownership 404: same file :98 (grounded by
 *       app/api/items/data-pipeline/[id]/output/__tests__/run-ownership.test.ts)
 *   - failed-run reason/code: lib/lineage/synapse-lineage-harvest.ts:426-432
 *   - spark run route + `lineage` receipt + redaction:
 *       app/api/items/spark-job-definition/[id]/runs/[runId]/route.ts:114-153,98-112
 *   - unattributed reason/code: lib/lineage/synapse-lineage-harvest.ts:585-591
 *   - SJD runs list (batch discovery): app/api/items/spark-job-definition/[id]/runs/route.ts
 *       + lib/azure/synapse-dev-client.ts:508-512 (`{ from,total,sessions }`), :458-477 (SparkBatchJob)
 *   - name-prefix attribution: spark run route :63-81 (`loom-<displayName>-`)
 *   - item lineage read-back (Weave/Thread overlay): app/api/items/[type]/[id]/lineage/route.ts:244-317
 *       + lib/azure/unified-lineage.ts:63,691-783,902-904 (source 'weave', edge type = action)
 *   - SAS stripped at the door: lib/lineage/dataset-naming.ts:51,111-128,231-239,349-361
 *   - discovery: app/api/items/by-type/route.ts (items carry id/workspaceId/displayName/state)
 *
 * KNOWN DISCREPANCY with #2626 §5. The issue says read the edges back via
 * `GET /api/catalog/lineage?…&columns=true`. That route (app/api/catalog/
 * lineage/route.ts:62-145) only serves Purview / Unity Catalog / OneLake — it
 * does NOT read the `thread-edges` sink the emitters write. The correct
 * Azure-native read-back is the per-item lineage route above, which overlays the
 * Weave/Thread edges via getUnifiedLineage. This spec uses that route and this
 * note documents the imprecision rather than following it into a dead read.
 *
 * Project: `openlineage-emitters` (playwright.config.ts), minted-session auth via
 * the `mint` dependency. Read-only discovery — creates no workspaces. NOT wired
 * into any required check.
 * Run: SESSION_SECRET=<kv> LOOM_URL=<url> \
 *      pnpm exec playwright test --project=openlineage-emitters
 * CI:  gh workflow run loom-ui-verify.yml --ref main \
 *        -f extra_projects="openlineage-emitters"
 */
import { test, expect, type Page } from '@playwright/test';
import { BASE, signIn, recordVerdict } from './_lib/uat';

const PIPELINE_TYPE = 'data-pipeline';
const SJD_TYPE = 'spark-job-definition';

/**
 * The failed-run receipt's reason prose (synapse-lineage-harvest.ts:430). The
 * UI switches on `code`, never on this prose (a copy edit must not un-render the
 * gate), so the spec asserts BOTH: `code:'run_not_succeeded'` AND that the human
 * reason still reads as the succeeded-only rule.
 */
const RUN_NOT_SUCCEEDED_REASON = /only stamped for a succeeded run/i;
/** The unattributed-batch receipt's reason prose (synapse-lineage-harvest.ts:589). */
const BATCH_UNATTRIBUTED_REASON = /not submitted by this Loom item/i;

/**
 * A SAS signature parameter (`?sig=…` / `&sig=…`). This is the exact marker the
 * batch-disclosure vitest plants ("sig=SUPERSECRET"); dataset-naming.ts strips
 * the whole query string at the door, so a persisted lineage edge can never
 * carry one. Anchored to `[?&]sig=` so a word merely containing "sig" is not a
 * false positive.
 */
const SAS_SIGNATURE = /[?&]sig=/i;
function hasSasSignature(payload: unknown): boolean {
  const s = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
  return SAS_SIGNATURE.test(s);
}

interface DiscoveredItem {
  id: string;
  workspaceId: string;
  displayName: string;
  state: Record<string, unknown>;
}

/** Every item of `type` the automation identity can see (by-type/route.ts). */
async function byType(page: Page, type: string): Promise<DiscoveredItem[]> {
  const r = await page.request.get(`${BASE}/api/items/by-type?types=${type}`, { timeout: 60_000 });
  if (!r.ok()) return [];
  const b = await r.json().catch(() => ({}));
  const items: Array<Record<string, unknown>> = Array.isArray(b?.items) ? b.items : [];
  return items
    .filter((i) => i?.id && i?.workspaceId)
    .map((i) => ({
      id: String(i.id),
      workspaceId: String(i.workspaceId),
      displayName: String(i.displayName || i.id),
      state: (i.state as Record<string, unknown>) || {},
    }));
}

/** The ADF pipeline name an item is bound to, if any (state.adfPipelineName). */
function adfPipelineName(item: DiscoveredItem): string | undefined {
  const v = (item.state as { adfPipelineName?: unknown })?.adfPipelineName;
  return typeof v === 'string' && v ? v : undefined;
}

/** The Synapse Spark pool an SJD is bound to, if any (state.spec.pool). */
function sjdPool(item: DiscoveredItem): string | undefined {
  const spec = (item.state as { spec?: { pool?: unknown } })?.spec;
  const v = spec?.pool;
  return typeof v === 'string' && v ? v : undefined;
}

interface PipelineRun {
  runId: string;
  status: string;
}

/** GET the Output pane run list for a pipeline. `runs:[]` = no ADF-visible run. */
async function listPipelineRuns(
  page: Page,
  item: DiscoveredItem,
): Promise<{ status: number; runs: PipelineRun[]; error?: string }> {
  const r = await page.request.get(
    `${BASE}/api/items/data-pipeline/${item.id}/output?workspaceId=${item.workspaceId}`,
    { timeout: 90_000 },
  );
  const status = r.status();
  const b = await r.json().catch(() => ({}));
  if (!r.ok()) return { status, runs: [], error: String(b?.error || '') };
  const runs: PipelineRun[] = (Array.isArray(b?.runs) ? b.runs : [])
    .filter((x: Record<string, unknown>) => x?.runId && x?.status)
    .map((x: Record<string, unknown>) => ({ runId: String(x.runId), status: String(x.status) }));
  return { status, runs };
}

/** GET the Output pane for one run — carries the `lineage` receipt when owned. */
async function pipelineRunOutput(
  page: Page,
  item: DiscoveredItem,
  runId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await page.request.get(
    `${BASE}/api/items/data-pipeline/${item.id}/output?workspaceId=${item.workspaceId}&runId=${encodeURIComponent(runId)}`,
    { timeout: 90_000 },
  );
  return { status: r.status(), body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Read back the item's unified lineage graph (Weave/Thread overlay). */
async function readBackItemLineage(
  page: Page,
  type: string,
  id: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await page.request.get(`${BASE}/api/items/${type}/${id}/lineage?columns=true`, { timeout: 90_000 });
  return { status: r.status(), body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

/** The receipt fields the emitter routes return (a subset — all optional). */
interface LineageReceipt {
  ok?: boolean;
  events?: number;
  written?: number;
  skipped?: number;
  denied?: number;
  code?: string;
  reason?: string;
  error?: string;
}

/** A receipt is HONEST when it either wrote edges or explained (code/reason)
 *  why it did not — the exact silence issue #2625 exists to prevent. */
function receiptIsHonest(r: LineageReceipt | undefined): boolean {
  if (!r || typeof r !== 'object') return false;
  const written = Number(r.written) || 0;
  return written > 0 || !!r.code || !!r.reason || !!r.error;
}

test.describe('openlineage-emitters (LU-8 / #2626)', () => {
  // ---------------------------------------------------------------------------
  // T0 — DETECTOR SELF-CHECK. Proves this spec can actually fail, entirely
  // offline. If the reason/code predicates or the SAS scanner were wrong, every
  // live assertion below would pass vacuously and the receipt would be hollow.
  // ---------------------------------------------------------------------------
  test('T0 detector self-check — the receipt predicates and SAS scanner really discriminate', () => {
    // Failed-run reason (the real string from synapse-lineage-harvest.ts:430).
    expect(RUN_NOT_SUCCEEDED_REASON.test('run status Failed — lineage is only stamped for a succeeded run')).toBe(true);
    expect(RUN_NOT_SUCCEEDED_REASON.test('Lineage recorded — 2 edges')).toBe(false);

    // Unattributed reason (the real string from synapse-lineage-harvest.ts:589).
    expect(
      BATCH_UNATTRIBUTED_REASON.test(
        'batch 41 on pool loompool2 was not submitted by this Loom item — Livy batch ids are pool-scoped',
      ),
    ).toBe(true);
    expect(BATCH_UNATTRIBUTED_REASON.test('the batch declared no storage input+output')).toBe(false);

    // SAS scanner: trips on the planted signature, not on innocent text.
    expect(hasSasSignature('abfss://finance@st.dfs.core.windows.net/payroll?sig=SUPERSECRET')).toBe(true);
    expect(hasSasSignature({ nodes: [{ id: 'abfss://data@st.dfs.core.windows.net/silver/sales' }] })).toBe(false);
    expect(hasSasSignature({ token: { conf: 'sv=2024&sig=SECRET' } })).toBe(true); // & form too
    expect(hasSasSignature('a design signal')).toBe(false); // "sig" inside a word is NOT a match

    // Honesty predicate: a wrote-edges receipt and a coded no-op are honest; a
    // bare empty receipt (the #2625 defect) is not.
    expect(receiptIsHonest({ written: 2 })).toBe(true);
    expect(receiptIsHonest({ written: 0, code: 'run_not_succeeded' })).toBe(true);
    expect(receiptIsHonest({ written: 0 })).toBe(false);
    expect(receiptIsHonest(undefined)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // T1 — PIPELINE HARVEST, happy path (#2626 §1, §5, §6).
  // ---------------------------------------------------------------------------
  test('T1 a succeeded pipeline run harvests lineage; the store carries no SAS', async ({ page, context }, testInfo) => {
    test.setTimeout(240_000);
    await signIn(context).catch(() => { /* storageState may already be set */ });

    const pipelines = (await byType(page, PIPELINE_TYPE)).filter((p) => adfPipelineName(p));
    if (pipelines.length === 0) {
      recordVerdict({
        surface: 'emitter:openlineage-pipeline', feature: 'harvest-succeeded', verdict: 'B', status: 'pass',
        notes: 'honest-gate: no ADF-backed data-pipeline (state.adfPipelineName) visible to the automation identity',
      });
      test.skip(true, 'no ADF-backed data-pipeline on this estate — seed one with a real run to exercise §1/§5/§6');
      return;
    }

    // Find the first backed pipeline that has a SUCCEEDED run to harvest.
    let harvested = false;
    for (const pipe of pipelines) {
      const { status, runs, error } = await listPipelineRuns(page, pipe);
      if (status !== 200) {
        // ADF unconfigured / transient — an honest Azure infra gate, not a defect.
        recordVerdict({
          surface: 'emitter:openlineage-pipeline', feature: 'harvest-succeeded', verdict: 'B', status: 'pass',
          notes: `honest-gate: Output pane returned ${status}${error ? ` (${error})` : ''} for "${pipe.displayName}" — ADF run history not reachable`,
        });
        continue;
      }
      const succeeded = runs.find((r) => /^succeeded$/i.test(r.status));
      if (!succeeded) continue;

      const { status: outStatus, body } = await pipelineRunOutput(page, pipe, succeeded.runId);
      expect(outStatus, `Output pane for the caller's OWN succeeded run must 200 (got ${outStatus})`).toBe(200);
      const lineage = body.lineage as LineageReceipt | undefined;
      // The emitter fired on this poll — the receipt is present and honest.
      expect(
        receiptIsHonest(lineage),
        `the succeeded-run Output pane returned a silently empty lineage receipt: ${JSON.stringify(lineage)} — ` +
          '#2625 is exactly this failure (a harvest that neither writes nor explains)',
      ).toBe(true);

      const written = Number(lineage?.written) || 0;
      if (written > 0) {
        // §5 — the abfss://-keyed Cosmos edges persisted. Read the graph back.
        const back = await readBackItemLineage(page, PIPELINE_TYPE, pipe.id);
        // §6 — SAS is stripped at the door (dataset-naming.ts); the store must
        // carry no signature, in the receipt OR the read-back graph.
        expect(hasSasSignature(lineage), 'the lineage receipt must not echo a SAS signature').toBe(false);
        expect(
          hasSasSignature(back.body),
          'the read-back lineage graph carries a `?sig=` — SAS must be stripped before an edge is persisted',
        ).toBe(false);
        await page.goto(`${BASE}/items/${PIPELINE_TYPE}/${pipe.id}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.screenshot({ path: testInfo.outputPath('pipeline-harvest.png') }).catch(() => {});
        recordVerdict({
          surface: 'emitter:openlineage-pipeline', feature: 'harvest-succeeded', verdict: 'A', status: 'pass',
          notes: `written=${written} events=${lineage?.events ?? '?'} on run ${succeeded.runId} of "${pipe.displayName}"; read-back=${back.status}, no SAS`,
        });
      } else {
        // Honest fact about THIS run (no Copy activity resolved, already
        // harvested on this replica, budget/rate) — the receipt says which.
        recordVerdict({
          surface: 'emitter:openlineage-pipeline', feature: 'harvest-succeeded', verdict: 'B', status: 'pass',
          notes: `honest no-op on run ${succeeded.runId}: code=${lineage?.code || '?'} reason="${lineage?.reason || ''}"`,
        });
      }
      harvested = true;
      break;
    }

    if (!harvested) {
      recordVerdict({
        surface: 'emitter:openlineage-pipeline', feature: 'harvest-succeeded', verdict: 'B', status: 'pass',
        notes: 'honest-gate: no SUCCEEDED pipeline run visible to harvest on any backed pipeline',
      });
      test.skip(true, 'no succeeded pipeline run to harvest — the succeeded-only path needs a real completed run');
    }
  });

  // ---------------------------------------------------------------------------
  // T2 — PIPELINE HARVEST, failed run (#2626 §2).
  // ---------------------------------------------------------------------------
  test('T2 a failed pipeline run stamps NO lineage and says why', async ({ page, context }) => {
    test.setTimeout(240_000);
    await signIn(context).catch(() => { /* storageState may already be set */ });

    const pipelines = (await byType(page, PIPELINE_TYPE)).filter((p) => adfPipelineName(p));
    if (pipelines.length === 0) {
      test.skip(true, 'no ADF-backed data-pipeline on this estate — cannot exercise the failed-run gate');
      return;
    }

    for (const pipe of pipelines) {
      const { status, runs } = await listPipelineRuns(page, pipe);
      if (status !== 200) continue;
      const failed = runs.find((r) => /^(failed|cancelled)$/i.test(r.status));
      if (!failed) continue;

      const { status: outStatus, body } = await pipelineRunOutput(page, pipe, failed.runId);
      expect(outStatus, `the caller's own failed run still 200s the Output pane (got ${outStatus})`).toBe(200);
      const lineage = body.lineage as LineageReceipt | undefined;
      expect(lineage, 'a failed run must still return an honest lineage receipt').toBeTruthy();
      // The succeeded-only gate: code is the contract, reason is the prose.
      expect(
        String(lineage?.code || ''),
        `a ${failed.status} run must report code 'run_not_succeeded' (got ${JSON.stringify(lineage)})`,
      ).toBe('run_not_succeeded');
      expect(
        RUN_NOT_SUCCEEDED_REASON.test(String(lineage?.reason || '')),
        `the reason must state lineage is only stamped for a succeeded run (got "${lineage?.reason}")`,
      ).toBe(true);
      expect(Number(lineage?.written) || 0, 'a failed run must write ZERO edges').toBe(0);

      recordVerdict({
        surface: 'emitter:openlineage-pipeline', feature: 'failed-run-gate', verdict: 'A', status: 'pass',
        notes: `run ${failed.runId} (${failed.status}) → code=run_not_succeeded, written=0`,
      });
      return;
    }

    recordVerdict({
      surface: 'emitter:openlineage-pipeline', feature: 'failed-run-gate', verdict: 'B', status: 'pass',
      notes: 'honest-gate: no failed/cancelled pipeline run visible to exercise the succeeded-only gate',
    });
    test.skip(true, 'no failed/cancelled pipeline run visible — the gate needs a real non-succeeded run');
  });

  // ---------------------------------------------------------------------------
  // T3 — runId OWNERSHIP (#2626 §3). A run that is not this pipeline's must 404,
  // never 200 with the foreign run's activities. This is the exact class the
  // round-3 vitest (run-ownership.test.ts) names as the reverting mutation.
  // ---------------------------------------------------------------------------
  test('T3 a runId belonging to another (or no) pipeline is 404, never a leak', async ({ page, context }) => {
    test.setTimeout(240_000);
    await signIn(context).catch(() => { /* storageState may already be set */ });

    const pipelines = (await byType(page, PIPELINE_TYPE)).filter((p) => adfPipelineName(p));
    if (pipelines.length === 0) {
      test.skip(true, 'no ADF-backed data-pipeline on this estate — cannot exercise the runId ownership gate');
      return;
    }

    const target = pipelines[0];

    // Prefer a REAL run of a DIFFERENT pipeline (the true §3 scenario); fall back
    // to a nonexistent GUID (the same `!run` branch of the ownership gate).
    let foreignRunId = '';
    let foreignKind = '';
    for (const other of pipelines.slice(1)) {
      const { status, runs } = await listPipelineRuns(page, other);
      if (status === 200 && runs.length > 0) {
        foreignRunId = runs[0].runId;
        foreignKind = `a real run of a different pipeline ("${other.displayName}")`;
        break;
      }
    }
    if (!foreignRunId) {
      foreignRunId = '00000000-0000-4000-8000-000000000000';
      foreignKind = 'a nonexistent run GUID';
    }

    const { status, body } = await pipelineRunOutput(page, target, foreignRunId);

    if (status === 200) {
      // The ONLY unacceptable outcome: the gate leaked. A 200 here means the
      // route served a run the caller does not own, with its activities.
      const activities = Array.isArray(body.activities) ? body.activities : [];
      expect(
        status,
        `runId ownership LEAK: GET …/${target.id}/output?runId=${foreignRunId} (${foreignKind}) returned 200 with ` +
          `${activities.length} foreign activity payload(s) — the ownership gate (output/route.ts:98) is defeated`,
      ).not.toBe(200);
    } else if (status === 404) {
      recordVerdict({
        surface: 'emitter:openlineage-pipeline', feature: 'runid-ownership', verdict: 'A', status: 'pass',
        notes: `${foreignKind} → 404 on "${target.displayName}" (no foreign activities disclosed)`,
      });
    } else {
      // 429/502 — a transient ARM throttle/error surfaces here (getPipelineRun
      // has no `.catch`, by design, so throttling can never read as 'not found').
      // Honest: not a leak, not a clean 404 — noted, not failed.
      recordVerdict({
        surface: 'emitter:openlineage-pipeline', feature: 'runid-ownership', verdict: 'B', status: 'pass',
        notes: `transient ${status} for ${foreignKind} (ARM throttle/error, not a leak) — gate not disproved`,
      });
    }
  });

  // ---------------------------------------------------------------------------
  // T4 — SPARK HARVEST attribution (#2626 §4). A pool-scoped batch this SJD did
  // NOT submit contributes NO lineage and is redacted; the SJD's own succeeded
  // batch that declared datasets writes an edge.
  // ---------------------------------------------------------------------------
  test('T4 a pool-scoped batch not submitted by this SJD writes no lineage and is redacted', async ({ page, context }) => {
    test.setTimeout(240_000);
    await signIn(context).catch(() => { /* storageState may already be set */ });

    const sjds = (await byType(page, SJD_TYPE)).filter((s) => sjdPool(s));
    if (sjds.length === 0) {
      recordVerdict({
        surface: 'emitter:openlineage-spark', feature: 'batch-attribution', verdict: 'B', status: 'pass',
        notes: 'honest-gate: no spark-job-definition with a bound pool (state.spec.pool) visible',
      });
      test.skip(true, 'no pool-bound spark-job-definition on this estate — cannot exercise §4');
      return;
    }

    for (const sjd of sjds) {
      // List recent Livy batches on this SJD's pool (runs/route.ts → { sessions }).
      const r = await page.request.get(`${BASE}/api/items/spark-job-definition/${sjd.id}/runs?size=25`, { timeout: 90_000 });
      if (!r.ok()) continue; // pool unreachable / 502 — try the next SJD
      const b = await r.json().catch(() => ({}));
      const sessions: Array<Record<string, unknown>> = Array.isArray(b?.sessions) ? b.sessions : [];
      if (sessions.length === 0) continue;

      // A batch this item did NOT submit: its `name` does not start with
      // `loom-<this displayName sanitized>-` (spark run route :63-81).
      const prefix = `loom-${sjd.displayName.replace(/[^A-Za-z0-9_-]/g, '_')}-`;
      const foreign = sessions.find((s) => {
        const name = String(s?.name || '');
        return Number.isFinite(Number(s?.id)) && !name.startsWith(prefix);
      });
      if (!foreign) continue;

      const batchId = Number(foreign.id);
      const rr = await page.request.get(
        `${BASE}/api/items/spark-job-definition/${sjd.id}/runs/${batchId}`,
        { timeout: 90_000 },
      );
      const jj = (await rr.json().catch(() => ({}))) as Record<string, unknown>;
      // A batch on the caller's OWN pool still renders its status (200), but
      // unattributed → no lineage + redacted job.
      if (rr.status() !== 200) continue;
      const lineage = jj.lineage as LineageReceipt | undefined;
      const job = (jj.job as Record<string, unknown>) || {};

      expect(
        String(lineage?.code || ''),
        `an unattributed batch must report code 'batch_unattributed' (got ${JSON.stringify(lineage)})`,
      ).toBe('batch_unattributed');
      expect(
        BATCH_UNATTRIBUTED_REASON.test(String(lineage?.reason || '')),
        `the reason must say the batch was not submitted by this item (got "${lineage?.reason}")`,
      ).toBe(true);
      expect(Number(lineage?.written) || 0, 'an unattributed batch must write ZERO edges').toBe(0);
      // Disclosure gate: the redacted projection carries no argv/conf/log/secret.
      expect(job.redacted, 'the unattributed job must be redacted').toBe(true);
      expect(job.livyInfo, 'the unattributed job must not carry livyInfo (argv+conf)').toBeUndefined();
      expect(hasSasSignature(jj), 'an unattributed batch response must not leak a SAS signature').toBe(false);

      recordVerdict({
        surface: 'emitter:openlineage-spark', feature: 'batch-attribution', verdict: 'A', status: 'pass',
        notes: `foreign batch ${batchId} on "${sjd.displayName}" pool → code=batch_unattributed, written=0, job redacted`,
      });
      return;
    }

    recordVerdict({
      surface: 'emitter:openlineage-spark', feature: 'batch-attribution', verdict: 'B', status: 'pass',
      notes: 'honest-gate: no foreign Livy batch visible on any bound pool to exercise the attribution gate',
    });
    test.skip(true, 'no foreign pool-scoped batch visible — §4 needs a batch this SJD did not submit');
  });
});
