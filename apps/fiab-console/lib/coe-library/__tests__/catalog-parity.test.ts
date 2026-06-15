/**
 * Catalog parity + integrity tests for the CoE template library.
 *
 * 1. The app-bundled COE_CATALOG must equal the canonical published
 *    docs/fiab/org-visuals/coe-library/catalog.json (no drift — both are
 *    generated from temp/gen-coe.mjs, but only catalog.json is the source of
 *    truth the publish script + external tooling read).
 * 2. Every catalog template must have bundled PBIP file contents, and the
 *    referenced .pbip path must be present among them.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { COE_CATALOG } from '../catalog';
import { TEMPLATE_FILES } from '../templates-content';

const CATALOG_JSON = path.resolve(
  __dirname,
  '../../../../../docs/fiab/org-visuals/coe-library/catalog.json',
);

describe('CoE catalog parity', () => {
  it('bundled COE_CATALOG matches published catalog.json', () => {
    const onDisk = JSON.parse(fs.readFileSync(CATALOG_JSON, 'utf-8'));
    expect(COE_CATALOG).toEqual(onDisk);
  });

  it('has at least 6 templates with required fields', () => {
    expect(COE_CATALOG.templates.length).toBeGreaterThanOrEqual(6);
    for (const t of COE_CATALOG.templates) {
      expect(t.id).toBeTruthy();
      expect(t.title).toBeTruthy();
      expect(t.category).toBeTruthy();
      expect(t.pbipPath).toMatch(/\.pbip$/);
      expect(Array.isArray(t.dataSources)).toBe(true);
      expect(Array.isArray(t.requiredRoles)).toBe(true);
      expect(t.measures).toBeGreaterThan(0);
    }
  });
});

describe('CoE bundled template files', () => {
  it('every template has bundled PBIP files incl. its .pbip', () => {
    for (const t of COE_CATALOG.templates) {
      const files = TEMPLATE_FILES[t.id];
      expect(files, `files for ${t.id}`).toBeTruthy();
      expect(files.length).toBeGreaterThan(0);
      // pbipPath is "<slug>/<Name>.pbip"; bundled file paths are relative to the slug.
      const rel = t.pbipPath.split('/').slice(1).join('/');
      expect(files.some((f) => f.path === rel)).toBe(true);
      // TMDL model + at least one table per template.
      expect(files.some((f) => f.path.endsWith('model.tmdl'))).toBe(true);
      expect(files.some((f) => /tables\/.*\.tmdl$/.test(f.path))).toBe(true);
    }
  });
});
