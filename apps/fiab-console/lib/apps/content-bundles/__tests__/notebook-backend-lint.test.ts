/**
 * Bundle-lint: no UNGUARDED `dbutils.*` survives on a non-Databricks render.
 *
 * The live "NameError: name 'dbutils' is not defined" bug came from content
 * bundles hard-coding Databricks-only `dbutils.*` calls in notebook cells that
 * actually run on the Synapse Spark default (or Azure ML). This test walks EVERY
 * registered bundle's notebook code cells and asserts that any `dbutils.`
 * reference is GUARDED — i.e. it appears only:
 *   • inside the shared backend-util shim (which probes `dbutils` behind
 *     `except NameError` and dispatches per engine), or
 *   • inside an explicit `if _loom_runtime() == 'dbutils'` / `if dbutils is not
 *     None` / `def f(dbutils=None)` guard (defensive, Databricks-only-with-
 *     fallback code).
 * A raw, un-guarded `dbutils.*` in an executable cell fails the test.
 *
 * Markdown cells are intentionally excluded — teaching bundles (e.g. the
 * Hitchhiker's Guide) document the `dbutils` ↔ `mssparkutils` mapping as prose,
 * which is correct content, not an executable dependency.
 *
 * Renders with NO Databricks configured (Synapse default) so the assertion is
 * against the engine the bug actually manifested on.
 */
import { describe, it, expect } from 'vitest';

import { getBundle, listBundleIds } from '../index';
import type { AppBundle } from '../types';
import type { NotebookCell } from '@/lib/types/notebook-cell';

/** Tokens that make a `dbutils.` reference safe (guarded / self-detecting). */
const GUARD =
  /_loom_runtime|CSA Loom backend-util shim|except NameError|dbutils is not None|dbutils\s*=\s*None/;

const RAW_DBUTILS = /\bdbutils\./;

/** Collect every notebook cell across a bundle's items (any content with cells). */
function notebookCells(bundle: AppBundle): { itemName: string; cell: NotebookCell }[] {
  const out: { itemName: string; cell: NotebookCell }[] = [];
  for (const item of bundle.items) {
    const cells = (item.content as { cells?: NotebookCell[] })?.cells;
    if (!Array.isArray(cells)) continue;
    for (const cell of cells) out.push({ itemName: item.displayName, cell });
  }
  return out;
}

describe('content-bundle notebook cells — no unguarded dbutils on non-Databricks render', () => {
  it('every registered bundle passes the guard', async () => {
    for (const id of listBundleIds()) {
      const bundle = await getBundle(id);
      expect(bundle, `${id} loads`).toBeDefined();
      for (const { itemName, cell } of notebookCells(bundle!)) {
        if (cell.type !== 'code') continue; // markdown teaching content is exempt
        if (!RAW_DBUTILS.test(cell.source)) continue;
        expect(
          GUARD.test(cell.source),
          `${id} / "${itemName}" / cell ${cell.id}: raw dbutils.* must be guarded ` +
            `(shim, _loom_runtime, "dbutils is not None", or "dbutils=None")`,
        ).toBe(true);
      }
    }
  });
});

describe('refactored bundles are wired to the backend-util shim', () => {
  const SHIM_IDS = [
    'app-azure-realtime-analytics',
    'app-change-feed-processor',
    'app-ml-pipeline',
  ] as const;

  it('each ships the shim helper + calls loom_* instead of raw dbutils secrets', async () => {
    const SHIM_BLOCK = /# === CSA Loom backend-util shim[\s\S]*?# === end CSA Loom backend-util shim ===/g;
    for (const id of SHIM_IDS) {
      const bundle = (await getBundle(id)) as AppBundle;
      const allCode = notebookCells(bundle)
        .filter((c) => c.cell.type === 'code')
        .map((c) => c.cell.source)
        .join('\n');
      // The shim is present …
      expect(allCode, `${id} ships the backend-util shim`).toContain('def loom_get_secret');
      // … and outside the guarded shim block no cell reads a secret via a raw
      // dbutils.secrets.get (the original bug).
      const outsideShim = allCode.replace(SHIM_BLOCK, '');
      expect(outsideShim, `${id} has no raw dbutils.secrets.get outside the shim`).not.toMatch(
        /dbutils\.secrets\.get/,
      );
    }
  });

  it('the RTA bootstrap notebook resolves ADLS via loom_ helpers (no raw dbutils.fs.mount)', async () => {
    const rta = (await getBundle('app-azure-realtime-analytics')) as AppBundle;
    const mountCell = notebookCells(rta).find((c) => c.cell.id === 'boot-code-mount');
    expect(mountCell, 'boot-code-mount exists').toBeDefined();
    const src = mountCell!.cell.source;
    expect(src).toContain('loom_mount_adls');
    expect(src).toContain('loom_get_secret');
    expect(src).not.toMatch(/\bdbutils\./);
  });
});
