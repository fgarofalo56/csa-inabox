/**
 * Copilot surface — whole-surface deep-functional UAT.
 *
 * One `describe` block per Copilot persona. Each test exercises the persona's
 * PRIMARY action against the REAL backend (authenticated via the minted
 * session cookie) and asserts the response is one of:
 *
 *   • real success  — HTTP 200 `{ok:true,…}` or a live `text/event-stream`
 *                      (the AOAI / Dataverse / BAP backend actually answered);
 *   • honest gate    — a DOCUMENTED config/tenant gate per no-vaporware.md,
 *                      i.e. one carrying a gate `code` (`no_aoai`, `disabled`,
 *                      `admin_only`, `copilot_studio_not_enabled`), or a
 *                      codeless Dataverse/BAP 401/403/424 when Power Platform
 *                      is not wired in this deployment.
 *
 * A 404 (route missing), a Loom-session `unauthenticated`, or any unexpected
 * shape FAILS the test — those are the vaporware tells this spec guards against.
 *
 * TWO THINGS A GATE IS NOT (both learned while verifying the #4432 fix):
 *
 *   1. A CODELESS 5xx is not a gate, it is the server failing. An honest gate
 *      names its remediation; a 500 with no code asserts nothing. 500/502/503
 *      used to sit in the tolerated-status list beside 401/403/424.
 *
 *      To be precise about the history, because the obvious story is wrong:
 *      this spec would have CAUGHT #4432. That 500 carried a non-JSON body, so
 *      `JSON.parse` threw and the walk fell through to `fail`. The tolerance
 *      only started mattering once the fix made the response well-formed
 *      (`{ok:false, code:'orchestrate_failed'}` at 500) — a parseable 500 that
 *      the old list scored as a gate. The rule below closes the window the fix
 *      opened; it is not a retelling of the original bug.
 *   2. For an AOAI-BACKED persona, even a well-formed gate is a defect. Loom
 *      deploys its own Foundry/AOAI account in every boundary, so "AOAI is not
 *      wired" is a broken deployment, not a supported shape — see
 *      auto-bind-by-default.md §5. Those personas pass only on a REAL answer.
 *      Opt out deliberately with LOOM_UAT_ALLOW_AOAI_GATE=true; never silently.
 *
 * WHICH personas are gate-tolerant is DATA, not prose: the partition lives in
 * `_lib/copilot-verdict.ts` as `AOAI_BACKED_PERSONAS` /
 * `NON_AOAI_BACKED_PERSONAS`, and a unit test requires the two together to
 * cover every persona this file drives. An earlier revision of this comment
 * asserted as fact that "Power Platform / Dataverse personas remain
 * gate-tolerant" — true of the Copilot Studio surfaces, and FALSE of
 * `persona:governance-copilot`, which the code classified as Power Platform
 * while `app/api/governance/govern/copilot/route.ts` runs on Azure OpenAI and
 * emits `code:'no_aoai'`. A comment that states a classification the code does
 * not hold is a deploy-integrity.md R7 untruth with a very long shelf life, so
 * the classification is no longer stated here at all — only where it is
 * executable.
 * (per .claude/rules/no-vaporware.md + ui-parity.md + auto-bind-by-default.md)
 *
 * Run:  SESSION_SECRET=<from-KV> LOOM_URL=<deployment> pnpm uat
 *       # optional deeper Copilot Studio create/publish flow:
 *       LOOM_PP_ENV_ID=<power-platform-env-guid> …
 *
 * Receipts: each persona records a verdict to test-results/uat/verdicts.ndjson
 * and (for the UI walks) a screenshot under test-results/uat/artifacts/.
 */
import { test, expect, type APIResponse } from '@playwright/test';
import path from 'node:path';
import { classify, scorePersona, type Probe } from './_lib/copilot-verdict';
import {
  BASE, signIn, captureFailures, recordVerdict,
  createWorkspace, deleteWorkspace, createItem,
} from './_lib/uat';

// Optional: a real Power Platform environment GUID enables the deeper Copilot
// Studio create/publish flow. Absent → those personas assert at the
// environment/agent-list probe (still a real BAP call) and tolerate the gate.
const PP_ENV = process.env.LOOM_PP_ENV_ID || '';

async function read(res: APIResponse): Promise<Probe> {
  const ct = (res.headers()['content-type'] || '').toLowerCase();
  let text = '';
  try { text = await res.text(); } catch { /* stream/binary */ }
  return { status: res.status(), ct, text };
}

/**
 * Record and assert one persona's primary action.
 *
 * Deliberately contains NO decision. Which personas must answer rather than
 * gate, whether the opt-out applies, the letter grade, the pass/fail status
 * and the value asserted on all come off `scorePersona` -- because a
 * re-review mutated each of them here in turn and the suite stayed green
 * every time. Glue that needs the Playwright runner cannot be unit-tested,
 * so the answer is to leave no decision in it.
 */
function assertPrimaryAction(surface: string, feature: string, p: Probe) {
  const s = scorePersona(surface, feature, p);
  recordVerdict({ surface, feature, verdict: s.grade, status: s.status, notes: s.notes });
  expect(s.actual, s.message).not.toBe('fail');
  return s.verdict;
}

// ── Shared workspace + item ids ─────────────────────────────────────────────
let wsId: string;
let sqlPoolId = '';
let azureSqlId = '';
let notebookId = '';

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  wsId = await createWorkspace(page, `uat-copilot-${Date.now()}`);
  // Items the AOAI personas act on. createItem asserts ok internally.
  sqlPoolId = await createItem(page, wsId, 'synapse-dedicated-sql-pool');
  azureSqlId = await createItem(page, wsId, 'azure-sql-database');
  notebookId = await createItem(page, wsId, 'notebook');
  await ctx.close();
});

test.afterAll(async ({ browser }) => {
  if (!wsId) return;
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  await deleteWorkspace(page, wsId);
  await ctx.close();
});

// ────────────────────────────────────────────────────────────────────────────
// Persona 1–7 — Copilot Studio family (Power Platform / Dataverse / BAP)
// ────────────────────────────────────────────────────────────────────────────
test.describe('Copilot Studio family — real BAP/Dataverse primary actions', () => {
  test('Agent — list Power Platform environments (BAP)', async ({ browser }) => {
    const ctx = await browser.newContext(); await signIn(ctx);
    const page = await ctx.newPage();
    const res = await page.request.get(`${BASE}/api/items/copilot-studio-agent?envs=1`);
    assertPrimaryAction('persona:copilot-studio-agent', 'list-environments', await read(res));
    await ctx.close();
  });

  test('Agent — create agent (deep, gated on LOOM_PP_ENV_ID)', async ({ browser }) => {
    test.skip(!PP_ENV, 'LOOM_PP_ENV_ID not set — Copilot Studio create flow skipped');
    const ctx = await browser.newContext(); await signIn(ctx);
    const page = await ctx.newPage();
    const res = await page.request.post(`${BASE}/api/items/copilot-studio-agent`, {
      data: { envId: PP_ENV, name: `uat-agent-${Date.now()}`, description: 'UAT agent', instructions: 'Be helpful.' },
    });
    assertPrimaryAction('persona:copilot-studio-agent', 'create-agent', await read(res));
    await ctx.close();
  });

  test('Topic — list topics for an agent', async ({ browser }) => {
    const ctx = await browser.newContext(); await signIn(ctx);
    const page = await ctx.newPage();
    // envId required; with no env wired this returns an honest 400/gate — but
    // the env-list probe above already proves the real backend. Here we hit the
    // topics route with a synthetic agent id to prove the route + backend path.
    const env = PP_ENV || '00000000-0000-0000-0000-000000000000';
    const res = await page.request.get(`${BASE}/api/items/copilot-studio-topic?envId=${env}&agentId=uat-agent`);
    const probe = await read(res);
    // A 400 "agentId/envId required" is a validation gate, not a backend reach;
    // only fail on 404 / unauthenticated / unexpected.
    const v = classify(probe);
    recordVerdict({ surface: 'persona:copilot-studio-topic', feature: 'list-topics',
      verdict: v.verdict === 'fail' && probe.status !== 400 ? 'F' : 'A',
      status: v.verdict === 'fail' && probe.status !== 400 ? 'fail' : 'pass', notes: `${v.reason}` });
    expect(probe.status, 'topic route reachable').not.toBe(404);
    if (probe.status !== 400) expect(v.verdict, v.reason).not.toBe('fail');
    await ctx.close();
  });

  test('Action — list bound actions route reachable', async ({ browser }) => {
    const ctx = await browser.newContext(); await signIn(ctx);
    const page = await ctx.newPage();
    const env = PP_ENV || '00000000-0000-0000-0000-000000000000';
    const res = await page.request.get(`${BASE}/api/items/copilot-studio-action?envId=${env}&agentId=uat-agent`);
    const probe = await read(res);
    expect(probe.status, 'action route reachable').not.toBe(404);
    if (probe.status !== 400) expect(classify(probe).verdict).not.toBe('fail');
    recordVerdict({ surface: 'persona:copilot-studio-action', feature: 'list-actions', verdict: 'A', status: 'pass', notes: `HTTP ${probe.status}` });
    await ctx.close();
  });

  test('Knowledge — list knowledge sources route reachable', async ({ browser }) => {
    const ctx = await browser.newContext(); await signIn(ctx);
    const page = await ctx.newPage();
    const env = PP_ENV || '00000000-0000-0000-0000-000000000000';
    const res = await page.request.get(`${BASE}/api/items/copilot-studio-knowledge?envId=${env}&agentId=uat-agent`);
    const probe = await read(res);
    expect(probe.status, 'knowledge route reachable').not.toBe(404);
    if (probe.status !== 400) expect(classify(probe).verdict).not.toBe('fail');
    recordVerdict({ surface: 'persona:copilot-studio-knowledge', feature: 'list-knowledge', verdict: 'A', status: 'pass', notes: `HTTP ${probe.status}` });
    await ctx.close();
  });

  test('Channel — publish to Web channel (BAP)', async ({ browser }) => {
    test.skip(!PP_ENV, 'LOOM_PP_ENV_ID not set — channel publish skipped');
    const ctx = await browser.newContext(); await signIn(ctx);
    const page = await ctx.newPage();
    const res = await page.request.post(`${BASE}/api/items/copilot-studio-channel/uat-agent/publish`, {
      data: { envId: PP_ENV, channelType: 'web', config: {} },
    });
    assertPrimaryAction('persona:copilot-studio-channel', 'publish-channel', await read(res));
    await ctx.close();
  });

  test('Analytics — KPI fetch route reachable', async ({ browser }) => {
    const ctx = await browser.newContext(); await signIn(ctx);
    const page = await ctx.newPage();
    const env = PP_ENV || '00000000-0000-0000-0000-000000000000';
    const res = await page.request.get(`${BASE}/api/items/copilot-studio-analytics/uat-agent?envId=${env}&days=30`);
    const probe = await read(res);
    expect(probe.status, 'analytics route reachable').not.toBe(404);
    if (probe.status !== 400) expect(classify(probe).verdict).not.toBe('fail');
    recordVerdict({ surface: 'persona:copilot-studio-analytics', feature: 'kpi-fetch', verdict: 'A', status: 'pass', notes: `HTTP ${probe.status}` });
    await ctx.close();
  });

  test('Template library — gallery loads (Cosmos-backed)', async ({ browser }) => {
    const ctx = await browser.newContext(); await signIn(ctx);
    const page = await ctx.newPage();
    const res = await page.request.get(`${BASE}/api/items/copilot-template-library`);
    const probe = await read(res);
    // The gallery is Cosmos-backed and cloud-agnostic — it should return ok:true.
    const v = assertPrimaryAction('persona:copilot-template-library', 'gallery-load', probe);
    if (v === 'real') {
      const j = JSON.parse(probe.text);
      expect(Array.isArray(j.templates), 'templates array present').toBe(true);
    }
    await ctx.close();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Persona 8 — Notebook in-cell Copilot (AOAI)
// ────────────────────────────────────────────────────────────────────────────
test.describe('Notebook in-cell Copilot — AOAI primary action', () => {
  test('explain a code cell', async ({ browser }) => {
    const ctx = await browser.newContext(); await signIn(ctx);
    const page = await ctx.newPage();
    const res = await page.request.post(`${BASE}/api/notebook/${notebookId}/assist`, {
      data: { mode: 'explain', lang: 'pyspark', source: 'df = spark.read.parquet("bronze/sales")\ndf.show()' },
    });
    assertPrimaryAction('persona:notebook-in-cell-copilot', 'explain-cell', await read(res));
    await ctx.close();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Persona 9 — Warehouse Copilot (NL→SQL, AOAI)
// ────────────────────────────────────────────────────────────────────────────
test.describe('Warehouse Copilot — NL→SQL primary action', () => {
  test('generate SQL from natural language', async ({ browser }) => {
    const ctx = await browser.newContext(); await signIn(ctx);
    const page = await ctx.newPage();
    const res = await page.request.post(`${BASE}/api/items/synapse-dedicated-sql-pool/${sqlPoolId}/assist`, {
      data: { mode: 'generate', prompt: 'list all tables in the warehouse' },
    });
    assertPrimaryAction('persona:warehouse-copilot', 'nl2sql-generate', await read(res));
    await ctx.close();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Persona 10 — Azure SQL Copilot (Fix, SSE)
// ────────────────────────────────────────────────────────────────────────────
test.describe('Azure SQL Copilot — Fix primary action', () => {
  test('fix a broken query (SSE)', async ({ browser }) => {
    const ctx = await browser.newContext(); await signIn(ctx);
    const page = await ctx.newPage();
    const res = await page.request.post(`${BASE}/api/items/azure-sql-database/${azureSqlId}/copilot`, {
      data: { command: 'fix', sql: 'SELCT TOP 5 * FORM dbo.Customer' },
    });
    assertPrimaryAction('persona:azure-sql-copilot', 'fix-query', await read(res));
    await ctx.close();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Persona 11 — Cross-item Copilot orchestrator (37-tool AOAI) — UI + backend
// ────────────────────────────────────────────────────────────────────────────
test.describe('Cross-item Copilot orchestrator — ask + tool plan', () => {
  test('status reports registered tools', async ({ browser }) => {
    const ctx = await browser.newContext(); await signIn(ctx);
    const page = await ctx.newPage();
    const res = await page.request.get(`${BASE}/api/copilot/status`);
    const probe = await read(res);
    assertPrimaryAction('persona:cross-item-copilot', 'status', probe);
    const j = JSON.parse(probe.text);
    expect(j.tools?.count, 'at least one orchestrator tool registered').toBeGreaterThan(0);
    await ctx.close();
  });

  test('orchestrate a prompt (real UI walk → SSE or honest AOAI gate)', async ({ browser }, testInfo) => {
    const ctx = await browser.newContext(); await signIn(ctx);
    const page = await ctx.newPage();
    const { consoleErrors } = await captureFailures(page, async () => {
      await page.goto(`${BASE}/copilot`, { waitUntil: 'networkidle' });
      // Launch the full-screen console from the landing hero.
      await page.getByRole('button', { name: /Launch Copilot/i }).click();
      // The full-screen console's prompt box placeholder is "Ask anything — e.g.
      // …" and the submit control is a "Send" button (was "Find the top 10…" /
      // "Ask CSA Loom Copilot" — both renamed; verified live).
      const box = page.getByPlaceholder(/Ask anything/i);
      await expect(box).toBeVisible({ timeout: 15_000 });
      await box.fill('list my workspaces');
      // Capture the real orchestrate response while clicking Send.
      const [resp] = await Promise.all([
        page.waitForResponse('**/api/copilot/orchestrate', { timeout: 30_000 }),
        page.getByRole('button', { name: /^Send$/i }).click(),
      ]);
      const probe = await read(resp);
      assertPrimaryAction('persona:cross-item-copilot', 'orchestrate', probe);
    });
    await page.screenshot({
      path: path.join(testInfo.outputDir, '..', '..', 'artifacts', 'copilot-cross-item-receipt.png'),
      fullPage: false,
    }).catch(() => {});
    if (consoleErrors.length) testInfo.attach('console', { body: consoleErrors.join('\n'), contentType: 'text/plain' });
    await ctx.close();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Persona 12 — Docs/Help agent (AOAI + doc index), reached via the unified window
// ────────────────────────────────────────────────────────────────────────────
test.describe('Docs/Help agent — backend + unified window', () => {
  test('help-copilot chat route reaches a real backend (or honest AOAI gate)', async ({ browser }) => {
    const ctx = await browser.newContext(); await signIn(ctx);
    const page = await ctx.newPage();
    const res = await page.request.post(`${BASE}/api/help-copilot/chat`, {
      data: { prompt: 'What is CSA Loom?' },
    });
    assertPrimaryAction('persona:help-copilot', 'chat', await read(res));
    await ctx.close();
  });

  test('the single Copilot window opens via the Sparkle button (no second popup)', async ({ browser }, testInfo) => {
    const ctx = await browser.newContext(); await signIn(ctx);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /Open Loom Copilot/i }).click();
    // Exactly one window, and the retired floating widget is gone.
    await expect(page.getByTestId('copilot-pane')).toHaveCount(1);
    await expect(page.getByTestId('help-copilot-widget')).toHaveCount(0);
    await page.screenshot({
      path: path.join(testInfo.outputDir, '..', '..', 'artifacts', 'copilot-unified-window-receipt.png'),
    }).catch(() => {});
    recordVerdict({ surface: 'copilot:unified', feature: 'single-window', verdict: 'A', status: 'pass' });
    await ctx.close();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Persona 13 — Inline code completion (ghost text, AOAI)
// ────────────────────────────────────────────────────────────────────────────
test.describe('Inline code completion — primary action', () => {
  test('complete route returns a suggestion or honest gate', async ({ browser }) => {
    const ctx = await browser.newContext(); await signIn(ctx);
    const page = await ctx.newPage();
    const res = await page.request.post(`${BASE}/api/copilot/complete`, {
      data: { prefix: '# read a csv into a spark dataframe\n', lang: 'pyspark', priorCells: [] },
    });
    // 200 ok:true {completion} (possibly empty), 503 no_aoai, or 403 disabled.
    assertPrimaryAction('persona:notebook-inline-complete', 'complete', await read(res));
    await ctx.close();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Persona 14 — Governance Copilot (admin-gated AOAI, SSE) — UI + backend
// ────────────────────────────────────────────────────────────────────────────
test.describe('Governance Copilot — admin-gated AOAI Q&A', () => {
  test('govern copilot route reaches a real backend (or honest gate)', async ({ browser }) => {
    const ctx = await browser.newContext(); await signIn(ctx);
    const page = await ctx.newPage();
    const res = await page.request.post(`${BASE}/api/governance/govern/copilot`, {
      data: { question: 'Which governance dimension has the lowest coverage?', chartData: { dimensions: [{ name: 'Lineage', coverage: 0.42 }] } },
    });
    // 200 SSE (admin + AOAI) or 403 admin_only (a deliberate role check).
    // NOT 503 no_aoai: this route is AOAI-backed (its own header says "Real
    // backend: Azure OpenAI chat-completions via resolveAoaiTarget()"), so it is
    // in AOAI_BACKED_PERSONAS and an AOAI gate here fails the test — Loom
    // deploys the account, so "not wired" is broken, not honest.
    assertPrimaryAction('persona:governance-copilot', 'posture-qa', await read(res));
    await ctx.close();
  });
});
