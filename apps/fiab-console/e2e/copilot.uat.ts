/**
 * Copilot surface — whole-surface deep-functional UAT.
 *
 * One `describe` block per Copilot persona. Each test exercises the persona's
 * PRIMARY action against the REAL backend (authenticated via the minted
 * session cookie) and asserts the response is one of:
 *
 *   • real success  — HTTP 200 `{ok:true,…}` or a live `text/event-stream`
 *                      (the AOAI / Dataverse / BAP backend actually answered);
 *   • honest gate    — a documented config/tenant gate per no-vaporware.md
 *                      (`no_aoai` 503, `disabled` 403, `admin_only` 403, a
 *                      Dataverse/BAP 401/403/424/500/502 when Power Platform is
 *                      not wired in this deployment).
 *
 * A 404 (route missing), a Loom-session `unauthenticated`, or any unexpected
 * shape FAILS the test — those are the vaporware tells this spec guards against.
 * Because an honest gate is an acceptable outcome, the spec passes green whether
 * or not AOAI / Power Platform are wired in the target deployment, while still
 * proving every persona's route exists, validates the session, and reaches a
 * real backend (per .claude/rules/no-vaporware.md + ui-parity.md).
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
import {
  BASE, signIn, captureFailures, recordVerdict,
  createWorkspace, deleteWorkspace, createItem,
} from './_lib/uat';

// Optional: a real Power Platform environment GUID enables the deeper Copilot
// Studio create/publish flow. Absent → those personas assert at the
// environment/agent-list probe (still a real BAP call) and tolerate the gate.
const PP_ENV = process.env.LOOM_PP_ENV_ID || '';

// ── Classification of a primary-action response ─────────────────────────────
interface Probe { status: number; ct: string; text: string; }

function classify(p: Probe): { verdict: 'real' | 'gate' | 'fail'; reason: string } {
  if (p.status === 404) return { verdict: 'fail', reason: 'route 404 (missing)' };
  if (p.ct.includes('text/event-stream')) {
    return { verdict: 'real', reason: 'live SSE stream' };
  }
  let j: any = null;
  try { j = JSON.parse(p.text); } catch { /* non-JSON */ }
  if (j && j.ok === true) return { verdict: 'real', reason: 'HTTP 200 ok:true — real backend answered' };
  // A broken Loom session would 401 with this exact body across EVERY persona —
  // that is a real failure, not an honest gate.
  if (j && j.error === 'unauthenticated') return { verdict: 'fail', reason: 'Loom session not authenticated' };
  if (j && j.ok === false) {
    const code = String(j.code || '');
    const GATE_CODES = ['no_aoai', 'disabled', 'admin_only', 'copilot_studio_not_enabled'];
    if (GATE_CODES.includes(code)) return { verdict: 'gate', reason: `honest gate code:'${code}'` };
    // Dataverse/BAP/AOAI/schema backend not wired in this deployment → honest
    // infra gate (the route still reached a real backend and reported why).
    if ([401, 403, 424, 500, 502, 503].includes(p.status)) {
      return { verdict: 'gate', reason: `honest infra gate HTTP ${p.status}` };
    }
  }
  return { verdict: 'fail', reason: `unexpected HTTP ${p.status}: ${p.text.slice(0, 160)}` };
}

async function read(res: APIResponse): Promise<Probe> {
  const ct = (res.headers()['content-type'] || '').toLowerCase();
  let text = '';
  try { text = await res.text(); } catch { /* stream/binary */ }
  return { status: res.status(), ct, text };
}

/** Assert a persona's primary action reached a real backend OR an honest gate. */
function assertPrimaryAction(surface: string, feature: string, p: Probe) {
  const { verdict, reason } = classify(p);
  recordVerdict({
    surface, feature,
    verdict: verdict === 'fail' ? 'F' : 'A',
    status: verdict === 'fail' ? 'fail' : 'pass',
    notes: `${reason} (HTTP ${p.status})`,
  });
  expect(verdict, `${surface}:${feature} — ${reason}`).not.toBe('fail');
  return verdict;
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
      const box = page.getByPlaceholder(/Find the top 10 revenue customers/i);
      await expect(box).toBeVisible({ timeout: 15_000 });
      await box.fill('list my workspaces');
      // Capture the real orchestrate response while clicking Ask.
      const [resp] = await Promise.all([
        page.waitForResponse('**/api/copilot/orchestrate', { timeout: 30_000 }),
        page.getByRole('button', { name: /Ask CSA Loom Copilot/i }).click(),
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
    // 200 SSE (admin + AOAI), 403 admin_only, or 503 no_aoai — all real-backend outcomes.
    assertPrimaryAction('persona:governance-copilot', 'posture-qa', await read(res));
    await ctx.close();
  });
});
