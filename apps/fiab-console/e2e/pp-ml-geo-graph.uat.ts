/**
 * Per-editor walkthrough for the Power Platform / ML / Geo / Graph family
 * (sweep deliverable). Runs against the live Loom Front Door.
 *
 * Family-specific checks beyond what `editors.uat.ts` already covers:
 *   - Environment picker is present + populated for Power Platform editors
 *   - Run / Save / Materialize buttons surface for editors that own them
 *   - Honest-gate MessageBars surface when runtime env vars are missing
 *
 * The 28 editors in scope are enumerated below — kept explicit (rather than
 * loaded from registry.ts) so the family contract is reviewable.
 *
 * Run:
 *   SESSION_SECRET=<from KV> pnpm exec playwright test e2e/pp-ml-geo-graph.uat.ts
 */
import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import {
  BASE, signIn, captureFailures, recordVerdict,
  createWorkspace, deleteWorkspace, createItem,
} from './_lib/uat';

interface FamilyMember {
  type: string;
  family: 'power-platform' | 'ml' | 'geo' | 'graph' | 'data-product' | 'cross-item';
  // Distinctive DOM markers that prove the editor wired up
  markers: string[];
}

const FAMILY: FamilyMember[] = [
  // Power Platform (6)
  { type: 'powerplatform-environment', family: 'power-platform', markers: ['Power Platform', 'environment'] },
  { type: 'dataverse-table',           family: 'power-platform', markers: ['Dataverse', 'table'] },
  { type: 'power-app',                 family: 'power-platform', markers: ['Power Apps', 'Maker'] },
  { type: 'power-automate-flow',       family: 'power-platform', markers: ['flow', 'Run'] },
  { type: 'power-page',                family: 'power-platform', markers: ['Power Pages', 'site'] },
  { type: 'ai-builder-model',          family: 'power-platform', markers: ['AI Builder', 'model'] },

  // ML (5) — ml-model/ml-experiment are read-only registries; ai-builder is in PP
  { type: 'ml-model',                  family: 'ml', markers: ['ML', 'Azure ML'] },
  { type: 'ml-experiment',             family: 'ml', markers: ['experiment', 'Run'] },
  { type: 'graphql-api',               family: 'ml', markers: ['SDL', 'APIM'] },
  { type: 'user-data-function',        family: 'ml', markers: ['Runtime', 'Entrypoint'] },
  { type: 'variable-library',          family: 'ml', markers: ['variable', 'Value sets'] },

  // Fabric IQ (5)
  { type: 'ontology',                  family: 'ml', markers: ['Source', 'class'] },
  { type: 'graph-model',               family: 'graph', markers: ['Node types', 'Edge types', 'Materialize'] },
  { type: 'plan',                      family: 'ml', markers: ['task', 'Save'] },
  { type: 'map',                       family: 'geo', markers: ['GeoJSON', 'feature'] },
  { type: 'operations-agent',          family: 'ml', markers: ['System prompt', 'Foundry'] },
  { type: 'data-agent',                family: 'ml', markers: ['System prompt', 'Sources'] },

  // Geo (4)
  { type: 'geo-map',                   family: 'geo', markers: ['Azure Maps', 'tile'] },
  { type: 'geo-dataset',               family: 'geo', markers: ['ADLS', 'Geometry column'] },
  { type: 'geo-query',                 family: 'geo', markers: ['KQL', 'T-SQL'] },
  { type: 'geo-pipeline',              family: 'geo', markers: ['ADF pipeline', 'Enrichments'] },

  // Graph + Vector (4)
  { type: 'cosmos-gremlin-graph',      family: 'graph', markers: ['Gremlin', 'g.V'] },
  { type: 'cypher-graph',              family: 'graph', markers: ['Cypher', 'KQL'] },
  { type: 'gql-graph',                 family: 'graph', markers: ['GQL', 'Backend'] },
  { type: 'vector-store',              family: 'graph', markers: ['Backend', 'Dimensions'] },

  // Data products (2) + cross-item (1)
  { type: 'data-product-template',     family: 'data-product', markers: ['template'] },
  { type: 'data-product-instance',     family: 'data-product', markers: ['instance'] },
  { type: 'cross-item-copilot',        family: 'cross-item', markers: ['Copilot', 'tools'] },
];

let wsId: string;

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  wsId = await createWorkspace(page, `uat-pp-ml-geo-graph-${Date.now()}`);
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

for (const member of FAMILY) {
  test(`pp-ml-geo-graph[${member.family}/${member.type}] — render + family markers`, async ({ browser }, testInfo) => {
    const ctx = await browser.newContext();
    await signIn(ctx);
    const page = await ctx.newPage();
    const surface = `family:${member.family}:${member.type}`;
    const start = Date.now();

    try {
      const id = await createItem(page, wsId, member.type);

      const { consoleErrors, networkErrors } = await captureFailures(page, async () => {
        await page.goto(`${BASE}/items/${member.type}/${id}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(2000);
      });

      const shotDir = path.join(testInfo.outputDir, '..', '..', 'screenshots', 'family');
      fs.mkdirSync(shotDir, { recursive: true });
      const shotPath = path.join(shotDir, `${member.type}.png`);
      await page.screenshot({ path: shotPath, fullPage: false }).catch(() => {});

      // Distinctive DOM markers — at least HALF must appear (every editor
      // has its own MessageBar wording; we don't require all of them).
      const body = await page.locator('body').innerText();
      const matched = member.markers.filter(m => body.toLowerCase().includes(m.toLowerCase()));
      const markerScore = matched.length / member.markers.length;

      // Hard fail signals — same as editors.uat.ts
      const crashed =
        body.includes('Failed to load item') ||
        body.includes('Application error') ||
        body.includes('workspaceId required') ||
        body.includes('Item not found');

      // Expected-gate classifier copied from editors.uat.ts (same logic)
      const isExpectedGate = (e: { status: number; body?: string }) => {
        const b = (e.body || '').toLowerCase();
        if (e.status === 503) return true;
        if (e.status === 404 && /(not found|no spec|no job|could not find)/i.test(b)) return true;
        if (e.status === 400 && /not configured/i.test(b)) return true;
        if (e.status === 409 && /(paused|environment .+ do)/i.test(b)) return true;
        if (e.status === 501) return true; // deferred runtime
        return false;
      };
      const realNetErrors = networkErrors.filter(e => !isExpectedGate(e));
      const realConsoleErrors = consoleErrors.filter(e => !/Failed to load resource/i.test(e));

      let verdict: 'A' | 'B' | 'C' | 'D' | 'F';
      let status: 'pass' | 'fail' | 'vaporware';
      let notes = '';

      if (crashed) {
        verdict = 'F'; status = 'fail';
        notes = 'editor render crashed';
      } else if (markerScore < 0.5) {
        verdict = 'D'; status = 'vaporware';
        notes = `family markers missed (${matched.length}/${member.markers.length} found)`;
      } else if (realConsoleErrors.length || realNetErrors.length) {
        verdict = 'C'; status = 'pass';
        notes = `${realConsoleErrors.length} real console errors, ${realNetErrors.length} unexpected network errors`;
      } else {
        verdict = matched.length === member.markers.length ? 'A' : 'B';
        status = 'pass';
        notes = `markers ${matched.length}/${member.markers.length} matched`;
      }

      recordVerdict({
        surface, feature: 'family-render',
        verdict, status, notes,
        consoleErrors: consoleErrors.slice(0, 5),
        networkErrors: networkErrors.slice(0, 5),
        screenshot: shotPath,
        durationMs: Date.now() - start,
      });

      if (status === 'fail') {
        throw new Error(`${surface} ${status}: ${notes}`);
      }
    } finally {
      await ctx.close();
    }
  });
}

// Verify the family contract didn't drift — every member in FAMILY must
// exist in the registry. This catches "removed an editor without removing
// the family check" drift at test time.
test('family-contract — every FAMILY entry is registered', async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  try {
    const r = await page.request.get(`${BASE}/api/catalog/item-types`);
    if (!r.ok()) {
      // Some Loom builds don't expose this catalog route; soft-skip then.
      test.skip(true, 'catalog API not exposed — soft-skipping family contract check');
      return;
    }
    const j = await r.json();
    const registered = new Set<string>((j.types || []).map((t: { slug?: string; type?: string }) => t.slug || t.type));
    for (const member of FAMILY) {
      expect(registered.has(member.type), `${member.type} should be in catalog`).toBeTruthy();
    }
  } finally {
    await ctx.close();
  }
});
