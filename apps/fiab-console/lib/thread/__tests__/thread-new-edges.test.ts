/**
 * Registry + manifest-gating tests for the three Wave-N Weave Thread edges:
 * `analyze-with-dax`, `materialize-to-kql`, and `promote-medallion`. These are
 * pure (no Azure / Cosmos) — they assert each edge is registered with the
 * correct manifest-derived `fromTypes`, that the manifest stays consistent, and
 * that the wizard fields are all dropdown/picker/toggle (no freeform).
 */
import { describe, it, expect } from 'vitest';
import { THREAD_ACTIONS, actionsFor } from '@/lib/thread/thread-actions';
import {
  daxAnalyzableTypes,
  lakehouseKqlMaterializableTypes,
  medallionPromotableTypes,
  getItemManifest,
  checkManifestConsistency,
} from '@/lib/items/manifest/registry';

function action(id: string) {
  const a = THREAD_ACTIONS.find((x) => x.id === id);
  if (!a) throw new Error(`ThreadAction '${id}' not registered`);
  return a;
}

describe('new Weave edges — registration + manifest gating', () => {
  it('analyze-with-dax is gated on daxAnalyzableTypes() (semantic-model)', () => {
    const a = action('analyze-with-dax');
    expect(a.fromTypes).toEqual(daxAnalyzableTypes());
    expect(daxAnalyzableTypes()).toEqual(['semantic-model']);
    expect(actionsFor('semantic-model').some((x) => x.id === 'analyze-with-dax')).toBe(true);
    expect(a.route).toBe('/api/thread/analyze-with-dax');
  });

  it('materialize-to-kql is gated on lakehouseKqlMaterializableTypes() (lakehouse)', () => {
    const a = action('materialize-to-kql');
    expect(a.fromTypes).toEqual(lakehouseKqlMaterializableTypes());
    expect(lakehouseKqlMaterializableTypes()).toEqual(['lakehouse']);
    expect(actionsFor('lakehouse').some((x) => x.id === 'materialize-to-kql')).toBe(true);
    expect(a.route).toBe('/api/thread/materialize-to-kql');
  });

  it('promote-medallion is gated on medallionPromotableTypes() (lakehouse)', () => {
    const a = action('promote-medallion');
    expect(a.fromTypes).toEqual(medallionPromotableTypes());
    expect(medallionPromotableTypes()).toEqual(['lakehouse']);
    expect(actionsFor('lakehouse').some((x) => x.id === 'promote-medallion')).toBe(true);
    expect(a.route).toBe('/api/thread/promote-medallion');
  });

  it('every new-edge field is a dropdown/picker/toggle (no freeform text/textarea)', () => {
    for (const id of ['analyze-with-dax', 'materialize-to-kql', 'promote-medallion']) {
      for (const f of action(id).fields) {
        expect(['select', 'loom-item', 'toggle'], `${id}.${f.name}`).toContain(f.kind);
      }
    }
  });

  it('the source types carry the new capability flags', () => {
    expect(getItemManifest('semantic-model')?.capabilities.daxAnalyzable).toBe(true);
    expect(getItemManifest('lakehouse')?.capabilities.lakehouseKqlMaterializable).toBe(true);
    expect(getItemManifest('lakehouse')?.capabilities.medallionPromotable).toBe(true);
    // A non-source type does not.
    expect(getItemManifest('warehouse')?.capabilities.daxAnalyzable).toBe(false);
    expect(getItemManifest('report')?.capabilities.medallionPromotable).toBe(false);
  });

  it('the manifest stays internally consistent after the new capability lists', () => {
    const report = checkManifestConsistency();
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  });
});
