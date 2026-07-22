/**
 * UX-Wave 11 (second half) — B-grade adopt-shared sweep guard.
 *
 * Per .claude/rules/ux-baseline.md §7.2 ("teaching toast" is a checklist item)
 * and the fabric-ux-observations "teaching toasts/banners everywhere" bar, each
 * of these already-B-grade editors adopts the shared <TeachingBanner> (SC-6
 * guidance UX) so the surface teaches its real-backend model on first open.
 *
 * This is a source-scan guard (no DOM): it asserts each surface imports the
 * shared component from the canonical module and wires a DISTINCT surfaceKey,
 * so a future refactor can't silently drop the guidance banner. The component's
 * own render/dismiss behaviour is covered by
 * lib/components/shared/__tests__/teaching-toast.test.tsx.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const EDITORS_ROOT = resolve(__dirname, '..');

/**
 * Read a surface's source. After WS-E1 decomposition an editor's TeachingBanner
 * can live in a sibling module (e.g. phase3/semantic-model-editor/aas-panel.tsx),
 * so concatenate the main file with any files in its decomposed `<base>/` dir —
 * the banner is still present, just relocated.
 */
function read(rel: string): string {
  let src = readFileSync(resolve(EDITORS_ROOT, rel), 'utf-8');
  const dir = resolve(EDITORS_ROOT, rel.replace(/\.tsx?$/, ''));
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (/\.tsx?$/.test(f)) src += '\n' + readFileSync(resolve(dir, f), 'utf-8');
    }
  }
  return src;
}

/** file (relative to lib/editors) → the surfaceKey the banner must carry. */
const SURFACES: Record<string, string> = {
  'materialized-lake-view-editor.tsx': 'materialized-lake-view',
  'tapestry-editor.tsx': 'tapestry',
  'notebook-editor.tsx': 'notebook',
  'synapse-notebook-editor.tsx': 'synapse-notebook',
  'phase3/warehouse-editor.tsx': 'warehouse',
  'phase3/semantic-model-editor.tsx': 'semantic-model',
  'phase4/ontology-editor.tsx': 'ontology',
  'phase4/plan-editor.tsx': 'plan',
};

describe('UX-11b — shared TeachingBanner adopted on every reworked surface', () => {
  for (const [file, surfaceKey] of Object.entries(SURFACES)) {
    it(`${file} imports TeachingBanner and wires surfaceKey="${surfaceKey}"`, () => {
      const src = read(file);
      expect(src).toContain("from '@/lib/components/shared/teaching-toast'");
      expect(src).toContain('TeachingBanner');
      expect(src).toContain(`surfaceKey="${surfaceKey}"`);
      // The banner carries a Learn link (baseline guidance UX).
      expect(src).toContain('loomDocUrl(');
    });
  }

  it('every surface uses a distinct surfaceKey (dismissal is persisted per key)', () => {
    const keys = Object.values(SURFACES);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
