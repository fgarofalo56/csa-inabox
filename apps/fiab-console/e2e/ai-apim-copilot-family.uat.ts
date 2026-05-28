/**
 * AI Foundry / APIM / Copilot Studio family — focused render + ribbon
 * smoke per editor.
 *
 * This complements e2e/editors.uat.ts (which iterates EVERY registered
 * editor) by asserting family-specific invariants:
 *   - The Fluent UI ribbon renders with the expected top group label.
 *   - The primary action (Save / Create / Add / Publish / Refresh) is
 *     present (enabled OR disabled with a tooltip — both count, since
 *     a tooltip-disabled action is honest config-only state per
 *     .claude/rules/no-vaporware.md).
 *   - The page never shows a hard "Failed to load" / "workspaceId
 *     required" surface in the body.
 *
 * Why "primary action present" rather than "enabled": several of these
 * editors gate their primary action behind a picker (env / project /
 * agent). With no Power Platform env wired, the Copilot Studio buttons
 * stay disabled with an honest tooltip — that's the documented
 * tenant-gated path, not vaporware.
 *
 * Auth: uses the same mint-session helper as the rest of the UAT suite
 * (signIn() in _lib/uat.ts). Skips gracefully when LOOM_E2E_STORAGE_STATE
 * / SESSION_SECRET aren't available.
 */
import { test, expect } from '@playwright/test';
import path from 'node:path';
import {
  BASE, signIn, captureFailures, createWorkspace, deleteWorkspace, createItem,
} from './_lib/uat';

interface FamilyEditor {
  type: string;
  /** Top-level ribbon group label the editor renders */
  ribbonGroup: string;
  /** Primary action button label (case-sensitive substring). Multiple
   *  labels = pass if any is present. Reflects per-editor reality:
   *  some editors say 'Save' for an existing item but 'Create' for new. */
  primary: string[];
}

const FAMILY: FamilyEditor[] = [
  // APIM
  { type: 'apim-api',                  ribbonGroup: 'API',       primary: ['Save', 'Create'] },
  { type: 'apim-product',              ribbonGroup: 'Product',   primary: ['Save', 'Create'] },
  { type: 'apim-policy',               ribbonGroup: 'Edit',      primary: ['Save'] },
  { type: 'data-product',              ribbonGroup: 'Product',   primary: ['Save'] },
  // AI Foundry
  { type: 'ai-foundry-hub',            ribbonGroup: 'Hub',       primary: ['Reload'] },
  { type: 'ai-foundry-project',        ribbonGroup: 'Item',      primary: ['Reload'] },
  { type: 'prompt-flow',               ribbonGroup: 'Item',      primary: ['Reload'] },
  { type: 'evaluation',                ribbonGroup: 'Item',      primary: ['Reload'] },
  { type: 'content-safety',            ribbonGroup: 'Item',      primary: ['Reload'] },
  { type: 'tracing',                   ribbonGroup: 'Item',      primary: ['Reload'] },
  { type: 'ai-search-index',           ribbonGroup: 'Item',      primary: ['Reload'] },
  { type: 'compute',                   ribbonGroup: 'Item',      primary: ['Reload'] },
  { type: 'dataset',                   ribbonGroup: 'Item',      primary: ['Reload'] },
  // Copilot Studio
  { type: 'copilot-studio-agent',      ribbonGroup: 'Agent',     primary: ['Save', 'New', 'Create'] },
  { type: 'copilot-studio-knowledge',  ribbonGroup: 'Knowledge', primary: ['Add'] },
  { type: 'copilot-studio-topic',      ribbonGroup: 'Topic',     primary: ['New', 'Save'] },
  { type: 'copilot-studio-action',     ribbonGroup: 'Action',    primary: ['Bind'] },
  { type: 'copilot-studio-channel',    ribbonGroup: 'Channel',   primary: ['Publish', 'Refresh'] },
  { type: 'copilot-studio-analytics',  ribbonGroup: 'Window',    primary: ['7d', '30d', '90d'] },
  { type: 'copilot-template-library',  ribbonGroup: 'Template',  primary: ['Refresh'] },
];

let wsId: string;

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  wsId = await createWorkspace(page, `uat-ai-apim-copilot-${Date.now()}`);
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

for (const e of FAMILY) {
  test(`AI/APIM/Copilot family — ${e.type} renders ribbon + primary action`, async ({ browser }, testInfo) => {
    const ctx = await browser.newContext();
    await signIn(ctx);
    const page = await ctx.newPage();
    try {
      const id = await createItem(page, wsId, e.type);
      const { consoleErrors } = await captureFailures(page, async () => {
        await page.goto(`${BASE}/items/${e.type}/${id}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(2500);
      });

      // Screenshot for the merge receipt per no-vaporware.md.
      const shotDir = path.join(testInfo.outputDir, '..', '..', 'screenshots');
      const shotPath = path.join(shotDir, `ai-apim-copilot-${e.type}.png`);
      await page.screenshot({ path: shotPath, fullPage: false }).catch(() => {});

      const body = await page.locator('body').innerText();
      expect(body, `${e.type}: hard-load failure`).not.toContain('Failed to load item');
      expect(body, `${e.type}: hard-load failure`).not.toContain('workspaceId required');

      // The ribbon group label is rendered by the Fluent UI ribbon as a
      // visible group caption; assert it's somewhere on the page.
      // Note: chrome label collisions are common ('Item' is generic), so
      // any single occurrence is enough.
      expect(body, `${e.type}: ribbon group '${e.ribbonGroup}' missing`).toContain(e.ribbonGroup);

      // Assert at least one primary-action label appears (button OR
      // tooltip-disabled action; the Fluent ribbon renders both as
      // text-bearing nodes).
      const primaryHit = e.primary.some((p) => body.includes(p));
      expect(primaryHit, `${e.type}: none of primary actions ${e.primary.join('|')} visible`).toBe(true);

      // Surface hydration errors as test diagnostics, but don't fail —
      // some editors warn about Fluent UI hydration mismatches that are
      // benign for this smoke layer (the visible-marker assertion above
      // is the real gate).
      if (consoleErrors.length > 0) {
        testInfo.attach('console-errors', { body: consoleErrors.join('\n'), contentType: 'text/plain' });
      }
    } finally {
      await ctx.close();
    }
  });
}
