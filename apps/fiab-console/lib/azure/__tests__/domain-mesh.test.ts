/**
 * Vitest specs for the federated data-mesh READ side (lib/azure/domain-mesh,
 * issue #1483 Wave 4).
 *
 * Verifies:
 *   - a domain's catalog footprint ROLLS UP over its whole subtree (a parent
 *     owns the workspaces + items of every descendant, at arbitrary depth).
 *   - the Unity Catalog target for a deep descendant is computed under its ROOT
 *     ancestor's catalog (root → catalog, descendant → schema).
 *   - each surface degrades to an honest gate (configured:false + hint) when its
 *     back-end is unconfigured — never a fabricated count.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Deep tree: dept → agency → office (3 levels), plus an unrelated root.
const DOMAINS = [
  { id: 'dept', name: 'Department', createdAt: '', createdBy: '', status: 'active', subscriptionIds: ['s1'] },
  { id: 'agency', name: 'Agency', parentId: 'dept', createdAt: '', createdBy: '' },
  { id: 'office', name: 'Office', parentId: 'agency', createdAt: '', createdBy: '' },
  { id: 'lone', name: 'Lone', createdAt: '', createdBy: '' },
];

vi.mock('../domain-registry', () => ({
  loadOrSeedDomains: async () => ({ id: 'domains:t', tenantId: 't', kind: 'domains', items: DOMAINS, updatedAt: '' }),
}));

// Workspaces: 1 tagged to 'agency', 1 to 'office', 1 to 'lone'. Items per ws.
vi.mock('../cosmos-client', () => ({
  workspacesContainer: async () => ({
    items: {
      query: () => ({
        fetchAll: async () => ({
          resources: [
            { id: 'ws-a', domain: 'agency' },
            { id: 'ws-o', domain: 'office' },
            { id: 'ws-l', domain: 'lone' },
          ],
        }),
      }),
    },
  }),
  itemsContainer: async () => ({
    items: {
      query: () => ({
        fetchAll: async () => ({
          resources: [
            { w: 'ws-a', n: 3 },
            { w: 'ws-o', n: 5 },
            { w: 'ws-l', n: 2 },
          ],
        }),
      }),
    },
  }),
}));

let unityConfigured = true;
let purviewConfigured = true;
vi.mock('../unified-domain-mapper', () => ({
  unityName: (id: string) => (id || 'domain').toLowerCase().replace(/[^a-z0-9_]+/g, '_') || 'domain',
  unityLinkStatus: async () => (unityConfigured
    ? { configured: true, catalogs: ['dept'], schemasByCatalog: { dept: ['agency', 'office'] } }
    : { configured: false, catalogs: [], schemasByCatalog: {}, hint: 'set LOOM_DATABRICKS_HOSTNAME' }),
}));
vi.mock('../purview-client', () => ({
  isPurviewConfigured: () => purviewConfigured,
  domainCollectionName: (id: string) => (id || 'domain').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 36),
}));

import { getDomainMesh } from '../domain-mesh';

describe('getDomainMesh (federated read)', () => {
  beforeEach(() => { unityConfigured = true; purviewConfigured = true; });

  it('rolls catalog workspaces + items up the whole subtree', async () => {
    const mesh = await getDomainMesh('t', 'me');
    const byId = Object.fromEntries(mesh.rows.map((r) => [r.id, r]));

    // office (leaf): only its own ws + items (ws-o = 5 items).
    expect(byId.office.rolledWorkspaces).toBe(1);
    expect(byId.office.rolledItems).toBe(5);
    // agency: its own ws-a (3 items) + office's ws-o (5 items) = 2 ws / 8 items.
    expect(byId.agency.rolledWorkspaces).toBe(2);
    expect(byId.agency.rolledItems).toBe(8);
    // dept (root): whole subtree = agency(ws-a) + office(ws-o) = 2 ws / 8 items.
    expect(byId.dept.rolledWorkspaces).toBe(2);
    expect(byId.dept.rolledItems).toBe(8);
    // lone: independent (ws-l = 2 items).
    expect(byId.lone.rolledWorkspaces).toBe(1);
    expect(byId.lone.rolledItems).toBe(2);
  });

  it('maps a deep descendant onto its ROOT ancestor UC catalog', async () => {
    const mesh = await getDomainMesh('t', 'me');
    const office = mesh.rows.find((r) => r.id === 'office')!;
    // office is level 3; its UC target is a schema under the ROOT (dept) catalog.
    expect(office.unity.target).toBe('dept.office');
    expect(office.unity.present).toBe(true);
    expect(office.depth).toBe(3);
  });

  it('lineage is traceable when a source is configured AND the domain has assets', async () => {
    const mesh = await getDomainMesh('t', 'me');
    // Both sources on → lineage active, listing both.
    expect(mesh.surfaces.lineage.configured).toBe(true);
    expect(mesh.surfaces.lineage.sources).toEqual(['Purview Data Map', 'Unity Catalog']);
    const dept = mesh.rows.find((r) => r.id === 'dept')!;
    expect(dept.lineage.present).toBe(true); // dept has rolled-up assets
  });

  it('honest-gates every surface when the back-end is unconfigured', async () => {
    unityConfigured = false;
    purviewConfigured = false;
    const mesh = await getDomainMesh('t', 'me');
    expect(mesh.surfaces.unity.configured).toBe(false);
    expect(mesh.surfaces.unity.hint).toMatch(/LOOM_DATABRICKS_HOSTNAME/);
    expect(mesh.surfaces.purview.configured).toBe(false);
    expect(mesh.surfaces.purview.hint).toMatch(/LOOM_PURVIEW_ACCOUNT/);
    // No lineage source configured → lineage honest-gated too.
    expect(mesh.surfaces.lineage.configured).toBe(false);
    expect(mesh.surfaces.lineage.sources).toEqual([]);
    const dept = mesh.rows.find((r) => r.id === 'dept')!;
    expect(dept.unity.present).toBe(false);
    expect(dept.purview.present).toBe(false);
    expect(dept.lineage.present).toBe(false);
    // Catalog still works (Cosmos), so the rollup is unaffected by the gates.
    expect(dept.rolledWorkspaces).toBe(2);
  });
});
