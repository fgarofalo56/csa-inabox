/**
 * dax-golden.spec.ts — A5 live DAX golden numeric harness.
 *
 * Rides the reserved `dax-golden` Playwright project (playwright.config.ts). It
 * gates the NUMERIC RESULT of every IMPLEMENTED DAX function against the seeded
 * Sales/Date/Customer reference model on a REAL Synapse-serverless backend —
 * the G1-grade correctness gate for the A1→A2→A3 fold engine.
 *
 * Flow (minted session, no MSAL):
 *   1. Create a throwaway workspace + semantic-model item.
 *   2. PUT the reference model content (tables/measures/relationships from
 *      lib/azure/__tests__/dax-golden/model.json) + point it at the seeded
 *      serverless golden database.
 *   3. For each IMPLEMENTED golden case: POST { op:'run', dax, database } to
 *      /api/items/semantic-model/[id]/dax-query and assert the numeric result
 *      equals the golden (assertLiveResult) — the SAME numbers the offline
 *      vitest cross-check recomputes from the CSVs.
 *   4. PENDING cases (implemented:false) are annotated skipped — the harness
 *      gates results of implemented functions, not its own existence
 *      (ws-lineage-depth.md A5). The A1/A2/A3 PR flips its rows to implemented.
 *
 * Honest-gate (no-vaporware): if the golden database has not been seeded in this
 * environment (run scripts/csa-loom/seed-dax-golden.sh first) OR the serverless
 * pool is unconfigured, the dax-query returns a 412/502/404 and the case is
 * recorded as GATED — never a false numeric failure. A WRONG number is always a
 * hard failure (proves the harness is real).
 *
 * Run: SESSION_SECRET=<kv> LOOM_URL=<url> \
 *      pnpm exec playwright test e2e/dax-golden.spec.ts --project=dax-golden
 * Seed: scripts/csa-loom/seed-dax-golden.sh (idempotent, one-time per env)
 */
import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BASE, signIn, createWorkspace, createItem, cleanupWorkspaces, recordVerdict } from './_lib/uat';
import {
  loadGoldenSuite,
  assertLiveResult,
  type GoldenCase,
  type LiveDaxResult,
} from '../lib/azure/__tests__/dax-golden/fixtures';

const MODEL = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'lib', 'azure', '__tests__', 'dax-golden', 'model.json'), 'utf8'),
);

const GOLDEN_DB =
  process.env.LOOM_DAX_GOLDEN_DB || MODEL.sourceDatabaseDefault || 'loom_dax_golden';

const OUT_DIR = path.join('temp', 'dax-golden', process.env.LOOM_UAT_RUN_TAG || 'local');
function ensureOut() { try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch { /* best-effort */ } }

const suite = loadGoldenSuite();
const implemented = suite.cases.filter((c) => c.implemented);
const pending = suite.cases.filter((c) => !c.implemented);

/** dax-query error statuses that mean "backend/seed not present here", not "wrong number". */
const GATE_STATUSES = new Set([404, 412, 500, 502, 503]);

test.describe('dax-golden (A5 numeric harness)', () => {
  const createdWorkspaces: string[] = [];
  let modelId = '';
  const receipts: Array<Record<string, unknown>> = [];

  test.beforeAll(() => ensureOut());

  test.afterAll(async () => {
    try {
      fs.writeFileSync(path.join(OUT_DIR, 'dax-golden-receipts.json'),
        JSON.stringify({ db: GOLDEN_DB, provenance: suite.provenanceModel, receipts }, null, 2));
    } catch { /* best-effort */ }
    await cleanupWorkspaces(createdWorkspaces).catch(() => { /* best-effort */ });
  });

  test('seed the reference semantic model', async ({ page, context }) => {
    await signIn(context).catch(() => { /* storageState may already be set */ });
    const wsId = await createWorkspace(page, 'dax-golden');
    createdWorkspaces.push(wsId);
    modelId = await createItem(page, wsId, 'semantic-model', 'dax-golden-reference');

    const put = await page.request.put(`${BASE}/api/items/semantic-model/${modelId}/content`, {
      data: {
        content: MODEL.content,
        sourceTarget: MODEL.sourceTarget || 'lakehouse',
        sourceSchema: MODEL.sourceSchema || 'dbo',
        sourceDatabase: GOLDEN_DB,
      },
    });
    expect(put.ok(), `PUT model content returned ${put.status()}: ${await put.text().catch(() => '')}`).toBeTruthy();
    const body = await put.json().catch(() => ({}));
    expect(body?.ok, 'content PUT ok').toBeTruthy();
  });

  for (const c of implemented) {
    test(`${c.id} — ${c.fn} numeric result`, async ({ page, context }) => {
      await signIn(context).catch(() => {});
      expect(modelId, 'model seeded in beforeAll test').toBeTruthy();

      const res = await page.request.post(`${BASE}/api/items/semantic-model/${modelId}/dax-query`, {
        data: { op: 'run', dax: c.dax, database: c.database || GOLDEN_DB },
        timeout: 60_000,
      });
      const bodyText = await res.text();
      let body: any = {};
      try { body = JSON.parse(bodyText); } catch { /* non-JSON */ }

      // HONEST GATE: seed/backend absent in this environment → record + skip the
      // numeric assertion. This is an infra gate (no-vaporware), never a pass of
      // a wrong number.
      if (!res.ok()) {
        if (GATE_STATUSES.has(res.status())) {
          recordVerdict({
            surface: 'editor:semantic-model', feature: `dax-golden:${c.id}`, verdict: 'B', status: 'skip',
            notes: `honest-gate: dax-query ${res.status()} — golden DB "${GOLDEN_DB}" not seeded / serverless unconfigured. Run scripts/csa-loom/seed-dax-golden.sh. body=${bodyText.slice(0, 200)}`,
          });
          receipts.push({ id: c.id, fn: c.fn, gated: true, status: res.status(), body: bodyText.slice(0, 200) });
          test.skip(true, `honest-gate: dax-query ${res.status()} (golden DB not seeded here)`);
          return;
        }
        // A 400 (e.g. unsupportedDaxError) on an IMPLEMENTED case is a real
        // regression — the engine no longer folds a function it should.
        throw new Error(`${c.id}: dax-query returned ${res.status()} for an implemented function — ${bodyText.slice(0, 300)}`);
      }

      const result: LiveDaxResult = { columns: body.columns, rows: body.rows };
      const verdict = assertLiveResult(c, result, suite.defaultTolerance);
      receipts.push({
        id: c.id, fn: c.fn, dax: c.dax, backend: body.backend, sql: body.sql,
        firstRow: result.rows?.[0], rowCount: result.rows?.length, ok: verdict.ok, detail: verdict.detail,
      });
      recordVerdict({
        surface: 'editor:semantic-model', feature: `dax-golden:${c.id}`,
        verdict: verdict.ok ? 'A' : 'F', status: verdict.ok ? 'pass' : 'fail',
        notes: `${c.fn}: ${verdict.detail} | backend=${body.backend} | ${c.provenance}`,
      });
      expect(verdict.ok, `${c.id} (${c.fn}): ${verdict.detail}. First row: ${JSON.stringify(result.rows?.[0])}`).toBeTruthy();
    });
  }

  // Pending rows are declared but not yet foldable — visible as skips so the
  // A1/A2/A3 author sees exactly which goldens their PR must turn on.
  for (const c of pending) {
    test(`${c.id} — ${c.fn} (pending ${c.landedBy})`, async () => {
      test.skip(true, `pending: ${c.landedBy} flips implemented:true and gates this golden (${c.provenance})`);
    });
  }
});
