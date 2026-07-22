/**
 * Nav-registry guard tests — the 2026-07-22 nav-IA reorg unified the two
 * previously-diverging governance registries (GovernanceShell sidebar +
 * /governance overview grid) into ONE exported GOVERNANCE_SECTIONS constant,
 * and re-homed /catalog onto the rail. If a refactor drops an entry from
 * either shared registry (re-orphaning a surface) these tests catch it
 * before merge.
 *
 * Pure-data imports only (nav-items.ts / governance-sections.ts are
 * deliberately free of React/icon imports), so this runs in node-env vitest.
 */
import { describe, it, expect } from 'vitest';
import { NAV_ITEMS, NAV_SECTIONS, DEMOTED_NAV_ITEMS } from '@/lib/nav/nav-items';
import { GOVERNANCE_SECTIONS, GOVERNANCE_ITEMS } from '@/lib/nav/governance-sections';

describe('GOVERNANCE_SECTIONS (shared sidebar + overview registry)', () => {
  // The union of the pre-unification sidebar (14) + overview grid (15)
  // + the formerly-orphaned glossary. NOTHING here may ever be dropped.
  const REQUIRED_HREFS = [
    '/governance',
    '/governance/govern',
    '/governance/catalog',
    '/admin/domains',
    '/governance/glossary',
    '/governance/scans',
    '/admin/classifications',
    '/admin/sensitivity-labels',
    '/catalog',
    '/governance/lineage',
    '/governance/policies',
    '/governance/protection-policies',
    '/governance/workspace-egress',
    '/governance/access-requests',
    '/governance/data-quality',
    '/governance/mdm',
    '/governance/irm',
    '/governance/insights',
    '/governance/purview',
  ];

  it('contains every governance destination (union of both legacy registries + glossary)', () => {
    const hrefs = GOVERNANCE_ITEMS.map((i) => i.href);
    for (const required of REQUIRED_HREFS) {
      expect(hrefs, `missing governance destination ${required}`).toContain(required);
    }
  });

  it('has no duplicate hrefs', () => {
    const hrefs = GOVERNANCE_ITEMS.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('mirrors the Purview left-nav grouping', () => {
    const groups = GOVERNANCE_SECTIONS.map((g) => g.label);
    for (const g of [
      'Catalog management',
      'Data Map',
      'Discovery & lineage',
      'Policies & protection',
      'Health & quality',
      'Purview portal',
    ]) {
      expect(groups, `missing Purview group ${g}`).toContain(g);
    }
  });

  it('marks Admin-portal destinations adminOnly (rel-T53 — no per-page 403 dumps)', () => {
    for (const item of GOVERNANCE_ITEMS.filter((i) => i.href.startsWith('/admin/'))) {
      expect(item.adminOnly, `${item.href} must be adminOnly`).toBe(true);
    }
  });

  it('every entry carries a label and a description (sidebar + card copy)', () => {
    for (const item of GOVERNANCE_ITEMS) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.desc.length).toBeGreaterThan(0);
    }
  });
});

describe('NAV_SECTIONS / NAV_ITEMS (rail + palette + Copilot allow-list)', () => {
  it('re-homes /catalog on the rail under the Data group', () => {
    const data = NAV_SECTIONS.find((s) => s.label === 'Data');
    expect(data).toBeDefined();
    expect(data!.items.map((i) => i.href)).toContain('/catalog');
  });

  it('keeps the /experience hub reachable via the demoted set (palette + Copilot)', () => {
    expect(DEMOTED_NAV_ITEMS.map((i) => i.href)).toContain('/experience');
  });

  it('flat NAV_ITEMS = rail + demoted, with no duplicate hrefs', () => {
    const hrefs = NAV_ITEMS.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    const railCount = NAV_SECTIONS.reduce((n, s) => n + s.items.length, 0);
    expect(hrefs.length).toBe(railCount + DEMOTED_NAV_ITEMS.length);
  });
});
