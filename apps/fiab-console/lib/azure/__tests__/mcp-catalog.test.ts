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
  MCP_CATALOG_SIZE,
  getCatalogEntry,
  resolveCatalogImage,
  catalogForUi,
  serversForCloud,
  defaultRecommendedServers,
  airGapSafeServers,
} from '../mcp-catalog';
import { mcpContainerAppName } from '../mcp-deploy-client';

const SAVED = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED };
});

describe('MCP_CATALOG', () => {
  it('is the curated library of exactly 25 deployable servers', () => {
    expect(MCP_CATALOG.length).toBe(25);
    expect(MCP_CATALOG_SIZE).toBe(25);
  });

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

  it('every entry maps to a real, pullable image (mcp/* | mcr.microsoft.com/* | ghcr.io/*)', () => {
    for (const e of MCP_CATALOG) {
      expect(e.image).toMatch(/^(mcp\/|mcr\.microsoft\.com\/|ghcr\.io\/)/);
    }
  });

  it('every entry carries a separate health probe path (not the MCP endpoint)', () => {
    for (const e of MCP_CATALOG) {
      expect(e.healthPath.startsWith('/')).toBe(true);
      expect(['/health', '/healthz']).toContain(e.healthPath);
    }
  });

  it('includes the air-gap-safe Tier-0 reference servers', () => {
    const airgap = MCP_CATALOG.filter((e) => e.egress === 'air-gap-safe').map((e) => e.id);
    expect(airgap).toEqual(expect.arrayContaining(['filesystem', 'git', 'memory', 'time', 'sequentialthinking']));
  });

  it('marks external-SaaS servers that need credentials with a secret env var', () => {
    // fetch is the only external-saas server that needs no credential (it reaches
    // arbitrary URLs but takes no API key); everything else SaaS is secret-gated.
    for (const e of MCP_CATALOG.filter((x) => x.egress === 'external-saas' && x.id !== 'fetch')) {
      expect(e.secretEnv && e.secretEnv.length).toBeTruthy();
    }
  });

  it('air-gap-safe servers make zero external calls (no externalHosts)', () => {
    for (const e of MCP_CATALOG.filter((x) => x.airGapSafe)) {
      expect(e.externalHosts).toHaveLength(0);
    }
  });
});

describe('cloud filters', () => {
  it('il5 hides ungated external-SaaS tiles (only air-gap + Azure-native)', () => {
    const ids = serversForCloud('il5').map((e) => e.id);
    expect(ids).toContain('filesystem');
    expect(ids).toContain('azure');
    expect(ids).toContain('postgres');
    expect(ids).not.toContain('slack');
    expect(ids).not.toContain('github');
  });

  it('commercial returns the full catalog', () => {
    expect(serversForCloud('commercial').length).toBe(MCP_CATALOG.length);
  });

  it('gcc-high returns only gov-safe servers', () => {
    expect(serversForCloud('gcc-high').every((e) => e.govSafe)).toBe(true);
  });

  it('defaultRecommended + airGapSafe selectors return real subsets', () => {
    expect(defaultRecommendedServers().length).toBeGreaterThan(0);
    expect(defaultRecommendedServers().every((e) => e.defaultRecommended)).toBe(true);
    expect(airGapSafeServers().every((e) => e.airGapSafe)).toBe(true);
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
