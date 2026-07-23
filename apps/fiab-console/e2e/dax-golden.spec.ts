/**
 * A5 — DAX golden numeric harness (loom-next-level ws-lineage-depth A5).
 *
 * Rides the `dax-golden` Playwright project stubbed by the Phase-1 test-projects
 * batch (#2411): minted-session auth (mint dependency + storageState), live
 * target via LOOM_UAT_BASE_URL / LOOM_URL.
 *
 *   pnpm exec playwright test --project=dax-golden
 *
 * WHAT IT GATES. For every `status:'implemented'` fixture in
 * lib/azure/__tests__/dax-golden/expected-results.json it runs the DAX query
 * against the loom-native tabular backend (Synapse serverless, via the real BFF
 * /api/items/semantic-model/[id]/dax-query) over the SEEDED Sales/Date/Customer
 * star schema and asserts the NUMERIC result equals the golden. This is the
 * G1-grade correctness gate for A1–A4: A5 seeds the harness + the baseline rows
 * (the functions foldable today); A1/A2/A3 add their rows to the SAME fixture
 * file as they implement each fold. The harness gates the *result*, not its own
 * existence.
 *
 * SEEDING. The seeded tables are provisioned by scripts/csa-loom/seed-dax-golden.sh
 * into the `loom_dax_golden` serverless database (run in-VNet — the serverless
 * endpoint is private-endpoint-locked, same context as this harness's gh-aca
 * runner). Until that seed has run in the target environment, every fixture
 * records an HONEST SKIP (the BFF returns a 502/412 because [Sales] does not
 * exist) — never a false fail. A numeric MISMATCH on seeded data is a hard FAIL
 * (that is the whole point — it proves the fold is real).
 *
 * The offline provenance gate (every golden recomputed from the CSV reference
 * data in pure JS) is lib/azure/__tests__/dax-golden-fixtures.test.ts — it runs
 * in ordinary vitest CI with no Synapse dependency.
 *
 * DISPOSABLE STATE: one `uat-dax-golden-*` workspace + model, removed in afterAll.
 */
import { test, expect } from '@playwright/test';
import { BASE, signIn, createWorkspace, createItem, cleanupWorkspaces } from './_lib/uat';
import {
  implementedFixtures,
  MODEL_CONTENT,
  SEED_DATABASE,
  extractActual,
  matchNumber,
} from '../lib/azure/__tests__/dax-golden/fixtures';

test.describe.configure({ mode: 'serial' });

const createdWorkspaces: string[] = [];
let wsId = '';
let modelId = '';
let contentBound = false;

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  try {
    wsId = await createWorkspace(page, `uat-dax-golden-${Date.now()}`);
    createdWorkspaces.push(wsId);
    modelId = await createItem(page, wsId, 'semantic-model', 'DAX Golden Reference Model');

    // Author the star-schema content so the model is bound (never the 412
    // "unbound" gate) and folds to the seeded serverless views. sourceTarget
    // 'lakehouse' + sourceDatabase carries the seeded DB for the UI; the harness
    // ALSO passes `database` explicitly on every /dax-query so the fold targets
    // loom_dax_golden regardless of how modelBackingDatabase resolves.
    const put = await page.request.put(`${BASE}/api/items/semantic-model/${modelId}/content`, {
      data: { content: MODEL_CONTENT, sourceTarget: 'lakehouse', sourceDatabase: SEED_DATABASE },
      timeout: 60_000,
    });
    contentBound = put.ok();
    if (!contentBound) {
      console.warn(
        `[dax-golden] PUT /content failed: ${put.status()} ${await put.text().catch(() => '')}`,
      );
    }
  } finally {
    await ctx.close();
  }
});

test.afterAll(async () => {
  await cleanupWorkspaces(createdWorkspaces);
});

// The implemented golden set — one live BFF round-trip per fixture.
const impl = implementedFixtures();

test('dax-golden endpoint answers with a structured envelope (smoke)', async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  try {
    test.skip(!modelId, 'model was not created in beforeAll');
    const res = await page.request.post(`${BASE}/api/items/semantic-model/${modelId}/dax-query`, {
      data: { op: 'run', dax: 'EVALUATE Sales', database: SEED_DATABASE },
      timeout: 60_000,
    });
    const body = await res.json().catch(() => ({}));
    // Either a real result (ok:true) or an honest error envelope (ok:false with
    // an `error` string). Never an unstructured 500 / HTML.
    expect(typeof body.ok, `envelope shape: ${JSON.stringify(body).slice(0, 200)}`).toBe('boolean');
  } finally {
    await ctx.close();
  }
});

for (const fx of impl) {
  test(`golden[${fx.id}] ${fx.fn} → ${fx.expect.kind} ${fx.expect.value}`, async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await browser.newContext();
    await signIn(ctx);
    const page = await ctx.newPage();
    try {
      test.skip(!modelId, 'model was not created in beforeAll');
      test.skip(!contentBound, 'model content PUT failed — cannot bind the seeded schema');

      const res = await page.request.post(
        `${BASE}/api/items/semantic-model/${modelId}/dax-query`,
        { data: { op: 'run', dax: fx.dax, database: SEED_DATABASE }, timeout: 90_000 },
      );
      const status = res.status();
      const body = await res.json().catch(() => ({}));

      if (!body?.ok) {
        // Honest SKIP when the seeded backend is not provisioned in this env:
        //   502 → executeQuery could not resolve [Sales]/[Date]/[Customer]
        //   412 → model gated as unbound (content not persisted / empty)
        // Any OTHER non-ok for an IMPLEMENTED fold is a real defect → FAIL.
        const err = String(body?.error || '').slice(0, 300);
        if (status === 502 || status === 412 || status === 404) {
          test.skip(
            true,
            `seeded serverless not provisioned (HTTP ${status}: ${err}). ` +
              `Run scripts/csa-loom/seed-dax-golden.sh against ${SEED_DATABASE}.`,
          );
        }
        throw new Error(
          `[${fx.id}] implemented fixture returned an error envelope (HTTP ${status}): ${err}`,
        );
      }

      const rows: Array<Record<string, unknown>> = Array.isArray(body.rows) ? body.rows : [];
      const actual = extractActual(fx, rows);
      const m = matchNumber(actual, fx.expect);
      expect(
        m.ok,
        `[${fx.id}] ${fx.dax} — ${m.detail} (backend=${body.backend}, sql=${String(body.sql ?? '').slice(0, 160)})`,
      ).toBe(true);
    } finally {
      await ctx.close();
    }
  });
}
