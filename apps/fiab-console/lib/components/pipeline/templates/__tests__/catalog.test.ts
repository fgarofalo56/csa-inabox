import { describe, it, expect } from 'vitest';
import { PIPELINE_TEMPLATES } from '../catalog';
import { findByType } from '../../activity-catalog';

/** Recursively collect every activity type (incl. nested ForEach children). */
function collectTypes(activities: any[]): string[] {
  const out: string[] = [];
  for (const a of activities || []) {
    if (a?.type) out.push(a.type);
    const nested = a?.typeProperties?.activities;
    if (Array.isArray(nested)) out.push(...collectTypes(nested));
  }
  return out;
}

describe('pipeline template catalog', () => {
  it('ships a non-empty gallery (no empty gallery)', () => {
    expect(PIPELINE_TEMPLATES.length).toBeGreaterThanOrEqual(4);
  });

  it('every template has a unique id and a valid PipelineSpec shape', () => {
    const ids = new Set<string>();
    for (const t of PIPELINE_TEMPLATES) {
      expect(t.id).toBeTruthy();
      expect(ids.has(t.id)).toBe(false);
      ids.add(t.id);
      expect(t.title).toBeTruthy();
      expect(t.description.length).toBeGreaterThan(20);
      expect(Array.isArray(t.spec.properties.activities)).toBe(true);
      expect(t.spec.properties.activities.length).toBeGreaterThan(0);
    }
  });

  it('every activity type (incl. nested) resolves to a runnable catalog entry', () => {
    for (const t of PIPELINE_TEMPLATES) {
      for (const type of collectTypes(t.spec.properties.activities as any[])) {
        const def = findByType(type);
        expect(def, `type "${type}" in template "${t.id}" must exist in ACTIVITY_CATALOG`).toBeTruthy();
        expect(def!.runnable, `type "${type}" must be runnable`).toBe(true);
      }
    }
  });

  it('includes the four canonical copy patterns', () => {
    const ids = PIPELINE_TEMPLATES.map((t) => t.id);
    expect(ids).toContain('simple-copy');
    expect(ids).toContain('foreach-copy');
    expect(ids).toContain('incremental-watermark');
    expect(ids).toContain('metadata-driven');
  });
});
