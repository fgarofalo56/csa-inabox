/**
 * mcp-catalog — unit tests for the vetted catalog allow-list + image resolution.
 *
 * Pure logic only (no Azure SDK / network): the catalog shape, the egress
 * vetting, the container-app name sanitiser, and resolveCatalogImage()'s
 * mirror-rebasing for air-gapped boundaries.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  MCP_CATALOG,
  getCatalogEntry,
  resolveCatalogImage,
  catalogForUi,
} from '../mcp-catalog';
import { mcpContainerAppName } from '../mcp-deploy-client';

const SAVED = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED };
});

describe('MCP_CATALOG', () => {
  it('has only permissive licenses (no AGPL/SSPL/commercial)', () => {
    for (const e of MCP_CATALOG) {
      expect(['Apache-2.0', 'MIT', 'BSD-3-Clause']).toContain(e.license);
    }
  });

  it('uses unique, DNS-safe ids', () => {
    const ids = MCP_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('includes the air-gap-safe Tier-0 reference servers', () => {
    const airgap = MCP_CATALOG.filter((e) => e.egress === 'air-gap-safe').map((e) => e.id);
    expect(airgap).toEqual(expect.arrayContaining(['filesystem', 'git', 'memory', 'time', 'sequentialthinking']));
  });

  it('marks external-SaaS servers with a secret env var', () => {
    for (const e of MCP_CATALOG.filter((x) => x.egress === 'external-saas')) {
      expect(e.secretEnv && e.secretEnv.length).toBeTruthy();
    }
  });
});

describe('getCatalogEntry', () => {
  it('resolves a known id and rejects an unknown one', () => {
    expect(getCatalogEntry('filesystem')?.name).toBe('Filesystem');
    expect(getCatalogEntry('definitely-not-vetted')).toBeUndefined();
  });
});

describe('resolveCatalogImage', () => {
  it('passes a fully-qualified image through unchanged when no mirror is set', () => {
    delete process.env.LOOM_MCP_CATALOG_REGISTRY;
    const e = getCatalogEntry('playwright')!;
    expect(resolveCatalogImage(e)).toBe('mcr.microsoft.com/playwright/mcp:latest');
  });

  it('rebases a bare repo path onto docker.io by default', () => {
    delete process.env.LOOM_MCP_CATALOG_REGISTRY;
    const e = getCatalogEntry('filesystem')!;
    expect(resolveCatalogImage(e)).toBe('docker.io/mcp/filesystem:latest');
  });

  it('rebases onto an ACR mirror when LOOM_MCP_CATALOG_REGISTRY is set', () => {
    process.env.LOOM_MCP_CATALOG_REGISTRY = 'loomacr.azurecr.io';
    expect(resolveCatalogImage(getCatalogEntry('filesystem')!)).toBe('loomacr.azurecr.io/mcp/filesystem:latest');
    // A fully-qualified MS image is rebased by dropping its original host.
    expect(resolveCatalogImage(getCatalogEntry('playwright')!)).toBe('loomacr.azurecr.io/playwright/mcp:latest');
  });
});

describe('mcpContainerAppName', () => {
  it('produces a DNS-safe name within Container Apps limits', () => {
    const n = mcpContainerAppName('filesystem');
    expect(n).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
    expect(n.length).toBeLessThanOrEqual(32);
    expect(n.startsWith('mcp-filesystem')).toBe(true);
  });

  it('sanitises an id with illegal characters', () => {
    const n = mcpContainerAppName('Weird_Id!!');
    expect(n).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
    expect(n.length).toBeLessThanOrEqual(32);
  });
});

describe('catalogForUi', () => {
  it('returns a copy (mutating it does not affect the source)', () => {
    const copy = catalogForUi();
    copy[0].name = 'mutated';
    expect(MCP_CATALOG[0].name).not.toBe('mutated');
  });
});
