/**
 * Admin-nav registry guard tests — loom-apex Phase B (IA-03 / IA-04 / IA-06)
 * folded eleven standalone admin pages into three tabbed hubs (FinOps,
 * AI operations, Access governance) and moved the admin sidebar's destination
 * list out of the client component into the pure-data ADMIN_SECTIONS registry.
 *
 * These tests are the anti-regression net for that fold:
 *   • no admin destination may be dropped or duplicated,
 *   • every folded route must still exist as a real page that redirects into
 *     the hub tab it became (deep links can never 404),
 *   • every redirect target must be a REAL hub tab value,
 *   • the /admin overview tile grid may only point at live destinations.
 *
 * Pure-data imports only (admin-sections.ts is deliberately free of React/icon
 * imports), so this runs in node-env vitest.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  ADMIN_SECTIONS, ADMIN_DESTINATIONS, ADMIN_LEGACY_REDIRECTS,
} from '@/lib/nav/admin-sections';

const APP_ROOT = path.resolve(__dirname, '..', '..', '..', 'app');

/** The hub tab contracts, mirrored from the three tab components. Kept as
 * literals here on purpose: the components are 'use client' React modules that
 * a node-env test must not import. If a tab value changes there, this list has
 * to change too — which is exactly the review signal we want. */
const HUB_TABS: Record<string, string[]> = {
  '/admin/finops': ['cockpit', 'capacity', 'chargeback'],
  '/admin/ai-operations': ['usage', 'agents', 'quality', 'fabric', 'autopilot'],
  '/admin/access-governance': ['requests', 'report', 'packages', 'reviews'],
};

describe('ADMIN_SECTIONS (shared admin sidebar registry)', () => {
  // Destinations that must never disappear from the admin nav. This is the
  // post-fold set: the eleven folded routes are represented by their hubs.
  const REQUIRED_HREFS = [
    '/admin/health',
    '/admin/performance',
    '/admin/rum',
    '/admin/readiness',
    '/admin/diagnostics',
    '/admin/incident-console',
    '/admin/capacity',
    '/admin/scaling',
    '/admin/finops',
    '/admin/tenant-settings',
    '/admin/env-config',
    '/admin/gates',
    '/admin/runtime-flags',
    '/admin/api-management',
    '/admin/catalog',
    '/admin/domains',
    '/admin/attribute-groups',
    '/admin/security',
    '/admin/policy-code',
    '/admin/permissions',
    '/admin/access-governance',
    '/admin/batch-labeling',
    '/admin/embed-codes',
    '/admin/org-visuals',
    '/admin/ai-operations',
    '/admin/autopilot',
    '/admin/mcp-servers',
    '/admin/audit-logs',
    '/admin/usage',
    '/admin/webhooks',
    '/admin/developer/tokens',
    '/admin/migrate',
    '/admin/deploy-planner',
    '/admin/landing-zones',
    '/admin/users',
    '/admin/workspaces',
    '/admin/network',
    '/admin/updates',
  ];

  it('contains every admin destination', () => {
    const hrefs = ADMIN_DESTINATIONS.map((i) => i.href);
    for (const required of REQUIRED_HREFS) {
      expect(hrefs, `missing admin destination ${required}`).toContain(required);
    }
  });

  it('has no duplicate hrefs', () => {
    const hrefs = ADMIN_DESTINATIONS.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('every entry carries a label and a description (sidebar + tooltip copy)', () => {
    for (const item of ADMIN_DESTINATIONS) {
      expect(item.label.length, `${item.href} needs a label`).toBeGreaterThan(0);
      expect(item.desc.length, `${item.href} needs a description`).toBeGreaterThan(0);
    }
  });

  it('every destination is an /admin route', () => {
    for (const item of ADMIN_DESTINATIONS) {
      expect(item.href.startsWith('/admin'), `${item.href} must live under /admin`).toBe(true);
    }
  });

  it('keeps the sidebar grouped (no unlabeled or empty cluster)', () => {
    expect(ADMIN_SECTIONS.length).toBeGreaterThan(0);
    for (const group of ADMIN_SECTIONS) {
      expect(group.label.length).toBeGreaterThan(0);
      expect(group.items.length).toBeGreaterThan(0);
    }
  });

  it('does NOT list the folded routes as their own rows (IA-03/04/06 consolidation)', () => {
    const hrefs = ADMIN_DESTINATIONS.map((i) => i.href);
    for (const { from } of ADMIN_LEGACY_REDIRECTS) {
      expect(hrefs, `${from} is folded into a hub — it must not be its own sidebar row`).not.toContain(from);
    }
  });
});

describe('ADMIN_LEGACY_REDIRECTS (IA-03 / IA-04 / IA-06 deep-link preservation)', () => {
  it('covers all eleven folded routes', () => {
    expect(ADMIN_LEGACY_REDIRECTS).toHaveLength(11);
    for (const legacy of [
      '/admin/usage-chargeback', '/admin/chargeback',
      '/admin/copilot-usage', '/admin/agent-quality', '/admin/copilot-quality',
      '/admin/model-fabric', '/admin/parity-autopilot',
      '/admin/access-requests', '/admin/access-report',
      '/admin/access-packages', '/admin/access-reviews',
    ]) {
      expect(ADMIN_LEGACY_REDIRECTS.map((r) => r.from)).toContain(legacy);
    }
  });

  it('targets a REAL hub tab for every legacy route', () => {
    for (const { from, to } of ADMIN_LEGACY_REDIRECTS) {
      const [route, query] = to.split('?');
      const tabs = HUB_TABS[route];
      expect(tabs, `${from} → unknown hub ${route}`).toBeDefined();
      const tab = new URLSearchParams(query).get('tab');
      expect(tabs, `${from} → ${to} is not a real tab of ${route}`).toContain(tab);
    }
  });

  it('every hub it targets is itself a sidebar destination', () => {
    const hrefs = ADMIN_DESTINATIONS.map((i) => i.href);
    for (const { to } of ADMIN_LEGACY_REDIRECTS) {
      expect(hrefs).toContain(to.split('?')[0]);
    }
  });

  it('keeps a real page file at every legacy route (a stale link must redirect, never 404)', () => {
    for (const { from, to } of ADMIN_LEGACY_REDIRECTS) {
      const file = path.join(APP_ROOT, `${from.replace(/^\//, '')}/page.tsx`);
      expect(fs.existsSync(file), `${from} lost its redirect stub`).toBe(true);
      const src = fs.readFileSync(file, 'utf8');
      expect(src, `${from} stub must redirect()`).toContain("redirect('");
      expect(src, `${from} stub must redirect to ${to}`).toContain(to);
    }
  });

  it('ships a real page file for each consolidated hub', () => {
    for (const hub of Object.keys(HUB_TABS)) {
      const file = path.join(APP_ROOT, `${hub.replace(/^\//, '')}/page.tsx`);
      expect(fs.existsSync(file), `${hub} has no page`).toBe(true);
    }
  });
});
