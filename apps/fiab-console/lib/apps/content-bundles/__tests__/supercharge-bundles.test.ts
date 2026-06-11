/**
 * Supercharge-Fabric → Loom-native bundle contract tests.
 *
 * The 7 app-supercharge-* bundles are GENERATED from the converted notebooks
 * under examples/supercharge-fabric/notebooks/ by
 * scripts/csa-loom/import-supercharge-notebooks.mjs. These tests pin the
 * generator's invariants so a future regeneration that drifts (re-introduces a
 * Fabric dependency, drops a notebook, breaks the registry/catalog wiring) is
 * caught in CI — no real Azure traffic, pure static-data assertions.
 */
import { describe, it, expect } from 'vitest';

import { getBundle, listBundleIds, resolveBundleItem } from '../index';
import { CATALOG_META } from '../catalog-meta';
import type { AppBundle, NotebookContent } from '../types';

const SUPERCHARGE_IDS = [
  'app-supercharge-bronze',
  'app-supercharge-silver',
  'app-supercharge-gold',
  'app-supercharge-ml',
  'app-supercharge-streaming',
  'app-supercharge-utils',
  'app-supercharge-guide',
] as const;

// Per-layer notebook counts (upstream Suppercharge_Microsoft_Fabric/notebooks).
const EXPECTED_COUNT: Record<string, number> = {
  'app-supercharge-bronze': 28,
  'app-supercharge-silver': 28,
  'app-supercharge-gold': 34,
  'app-supercharge-ml': 8,
  'app-supercharge-streaming': 9, // 8 streaming + 1 real-time notebook
  'app-supercharge-utils': 3,
  'app-supercharge-guide': 7,
};

// no-fabric-dependency.md forbidden control-plane hosts.
const FORBIDDEN = /api\.fabric\.microsoft\.com|api\.powerbi\.com|onelake\.dfs\.fabric/;

const VALID_LANGS = new Set(['pyspark', 'spark', 'sparksql', 'sparkr', 'python', 'tsql']);

describe('Supercharge-Fabric Loom-native bundles', () => {
  it('every bundle is registered and discoverable in the catalog', () => {
    for (const id of SUPERCHARGE_IDS) {
      const bundle = getBundle(id);
      expect(bundle, `${id} registered in index.ts`).toBeDefined();
      expect(bundle!.appId).toBe(id);
      const meta = CATALOG_META[id];
      expect(meta, `${id} present in CATALOG_META`).toBeDefined();
      expect(meta.id).toBe(id); // id MUST equal appId so install → getBundle resolves
      expect(listBundleIds()).toContain(id);
    }
  });

  it('ships exactly the converted notebook corpus (117 notebooks)', () => {
    let total = 0;
    for (const id of SUPERCHARGE_IDS) {
      const bundle = getBundle(id) as AppBundle;
      expect(bundle.items.length, `${id} item count`).toBe(EXPECTED_COUNT[id]);
      total += bundle.items.length;
    }
    expect(total).toBe(117);
  });

  it('every item is a notebook with non-empty cells and valid languages', () => {
    for (const id of SUPERCHARGE_IDS) {
      const bundle = getBundle(id) as AppBundle;
      for (const item of bundle.items) {
        expect(item.itemType, `${id}/${item.displayName} itemType`).toBe('notebook');
        const content = item.content as NotebookContent;
        expect(content.kind).toBe('notebook');
        expect(VALID_LANGS.has(content.defaultLang)).toBe(true);
        expect(content.cells.length).toBeGreaterThan(0);
        // At least one executable code cell (these are runnable Spark notebooks).
        expect(content.cells.some((c) => c.type === 'code' && c.source.trim().length > 0)).toBe(true);
        for (const cell of content.cells) {
          expect(['code', 'markdown']).toContain(cell.type);
          if (cell.type === 'code') expect(VALID_LANGS.has(cell.lang ?? 'pyspark')).toBe(true);
        }
      }
    }
  });

  it('carries zero hard Microsoft Fabric dependency (no Fabric/OneLake/Power BI hosts)', () => {
    for (const id of SUPERCHARGE_IDS) {
      const bundle = getBundle(id) as AppBundle;
      for (const item of bundle.items) {
        const content = item.content as NotebookContent;
        for (const cell of content.cells) {
          expect(FORBIDDEN.test(cell.source), `${id}/${item.displayName} cell ${cell.id} must not reference a Fabric/OneLake/Power BI host`).toBe(false);
        }
      }
    }
  });

  it('routes ADLS Gen2 (not OneLake) on the Azure-native default path', () => {
    // The medallion notebooks that reference object storage must use the ADLS
    // host placeholder, never the OneLake host (converted by the generator).
    const bronze = getBundle('app-supercharge-bronze') as AppBundle;
    const allSource = bronze.items
      .flatMap((i) => (i.content as NotebookContent).cells)
      .map((c) => c.source)
      .join('\n');
    expect(allSource).not.toMatch(/onelake\.dfs\.fabric/);
    // ABFSS references resolve to ADLS Gen2.
    if (/abfss:\/\//.test(allSource)) {
      expect(allSource).toMatch(/dfs\.core\.windows\.net/);
    }
  });

  it('install path resolves each bundle item by (type, displayName)', () => {
    const utils = getBundle('app-supercharge-utils') as AppBundle;
    for (const item of utils.items) {
      const resolved = resolveBundleItem('app-supercharge-utils', 'notebook', item.displayName);
      expect(resolved, `resolve ${item.displayName}`).toBeDefined();
      expect(resolved!.displayName).toBe(item.displayName);
      expect((resolved!.content as NotebookContent).kind).toBe('notebook');
    }
  });
});
