/**
 * MCP catalog — pure-function guards for the browse-catalog + deploy wizard.
 *
 * The catalog drives both the wizard (one Fluent control per configSchema field)
 * and the deploy route (secret routing + env). These tests pin the invariants the
 * deploy path relies on: every entry has a real image + schema, secret-field
 * routing, required-field enforcement, enum/bool validation, and default fill-in.
 * Pure (no Azure SDK / network), so they run under the node vitest env.
 */
import { describe, it, expect } from 'vitest';
import {
  MCP_DEPLOY_CATALOG as MCP_CATALOG,
  getCatalogEntry,
  validateConfigValues,
  MCP_CATALOG as MCP_GOV_CATALOG,
  govMetaFor,
  deployCatalogWithGovMeta,
  defaultRecommendedServers,
  airGapSafeServers,
  serversForCloud,
  type McpCatalogEntry,
} from '../catalog';

describe('MCP_CATALOG integrity', () => {
  it('every entry has a real image, port, mcpPath and at least metadata', () => {
    expect(MCP_CATALOG.length).toBeGreaterThan(0);
    for (const e of MCP_CATALOG) {
      expect(e.id).toMatch(/^[a-z0-9-]+$/);
      expect(e.image).toMatch(/[^/]+\/.+|.+:.+/); // registry/repo[:tag]
      expect(e.ingressPort).toBeGreaterThan(0);
      expect(e.mcpPath.startsWith('/')).toBe(true);
      expect(Array.isArray(e.configSchema)).toBe(true);
    }
  });

  it('config field keys are unique per entry and map to a distinct env var', () => {
    for (const e of MCP_CATALOG) {
      const keys = e.configSchema.map((f) => f.key);
      const envs = e.configSchema.map((f) => f.envVar);
      expect(new Set(keys).size).toBe(keys.length);
      expect(new Set(envs).size).toBe(envs.length);
    }
  });

  it('enum fields declare options; defaults (when present) are valid', () => {
    for (const e of MCP_CATALOG) {
      for (const f of e.configSchema) {
        if (f.type === 'enum') expect(f.options && f.options.length).toBeTruthy();
        if (f.type === 'enum' && f.default) expect(f.options).toContain(f.default);
        if (f.type === 'bool' && f.default) expect(['true', 'false']).toContain(f.default);
        // Secret fields must not carry a default (no plaintext default secrets).
        if (f.secret) expect(f.default).toBeUndefined();
      }
    }
  });

  it('getCatalogEntry resolves known ids and rejects unknown', () => {
    expect(getCatalogEntry(MCP_CATALOG[0].id)?.id).toBe(MCP_CATALOG[0].id);
    expect(getCatalogEntry('does-not-exist')).toBeUndefined();
  });
});

describe('validateConfigValues', () => {
  const entry: McpCatalogEntry = {
    id: 'test', name: 'Test', description: 'd', category: 'reference',
    image: 'repo/test:latest', transport: 'http', ingressPort: 8080, mcpPath: '/mcp',
    configSchema: [
      { key: 'token', label: 'Token', type: 'string', required: true, secret: true, envVar: 'TOKEN' },
      { key: 'mode', label: 'Mode', type: 'enum', options: ['a', 'b'], default: 'a', envVar: 'MODE' },
      { key: 'flag', label: 'Flag', type: 'bool', default: 'false', envVar: 'FLAG' },
      { key: 'count', label: 'Count', type: 'number', envVar: 'COUNT' },
    ],
  };

  it('throws when a required field is missing', () => {
    expect(() => validateConfigValues(entry, {})).toThrow(/required/i);
  });

  it('fills defaults for omitted optional fields', () => {
    const out = validateConfigValues(entry, { token: 'abc' });
    expect(out.token).toBe('abc');
    expect(out.mode).toBe('a');
    expect(out.flag).toBe('false');
    expect(out.count).toBeUndefined();
  });

  it('rejects an out-of-range enum value', () => {
    expect(() => validateConfigValues(entry, { token: 'abc', mode: 'zzz' })).toThrow(/one of/i);
  });

  it('rejects a non-numeric number and a non-bool bool', () => {
    expect(() => validateConfigValues(entry, { token: 'abc', count: 'NaN-ish' })).toThrow(/number/i);
    expect(() => validateConfigValues(entry, { token: 'abc', flag: 'yes' })).toThrow(/true or false/i);
  });

  it('passes through valid values and trims', () => {
    const out = validateConfigValues(entry, { token: '  abc  ', mode: 'b', flag: 'true', count: '5' });
    expect(out.token).toBe('abc');
    expect(out.mode).toBe('b');
    expect(out.flag).toBe('true');
    expect(out.count).toBe('5');
  });
});

describe('MCP_CATALOG (gov-safety metadata source)', () => {
  it('has unique ids and a complete gov-safety facet on every entry', () => {
    expect(MCP_GOV_CATALOG.length).toBeGreaterThanOrEqual(25);
    const ids = MCP_GOV_CATALOG.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const licenses = new Set(['Apache-2.0', 'MIT', 'BSD', 'Proprietary']);
    for (const s of MCP_GOV_CATALOG) {
      expect(s.id).toMatch(/^[a-z0-9-]+$/);
      expect(typeof s.govSafe).toBe('boolean');
      expect(typeof s.airGapSafe).toBe('boolean');
      expect(licenses.has(s.license)).toBe(true);
      expect(Array.isArray(s.externalHosts)).toBe(true);
      expect(Array.isArray(s.configSchema)).toBe(true);
      // No AGPL/SSPL in the gov catalog (license bucket enforces it by type).
      // Air-gap-safe servers must declare zero external hosts.
      if (s.airGapSafe) expect(s.externalHosts.length).toBe(0);
    }
  });

  it('the gov default-recommended set is non-empty and gov-safe + air-gap-safe leaning', () => {
    const def = defaultRecommendedServers();
    expect(def.length).toBeGreaterThan(0);
    for (const s of def) expect(s.govSafe).toBe(true);
    expect(airGapSafeServers().length).toBeGreaterThan(0);
  });

  it('serversForCloud narrows for the il5 boundary', () => {
    const all = serversForCloud('commercial');
    const il5 = serversForCloud('il5');
    expect(all.length).toBe(MCP_GOV_CATALOG.length);
    expect(il5.length).toBeLessThanOrEqual(all.length);
    // Every il5-permitted server is air-gap-safe or an Azure-native data plane.
    for (const s of il5) {
      expect(s.airGapSafe || ['azure', 'postgres', 'kubernetes'].includes(s.id)).toBe(true);
    }
  });
});

describe('govMetaFor bridge (operational ⇄ gov metadata)', () => {
  it('resolves gov metadata for an operational id present in the gov catalog', () => {
    const m = govMetaFor('github');
    expect(m).toBeDefined();
    expect(typeof m!.govSafe).toBe('boolean');
    expect(m!.license).toBeTruthy();
  });

  it('returns undefined for an id with no research-doc provenance', () => {
    expect(govMetaFor('does-not-exist')).toBeUndefined();
  });

  it('joins every operational entry to its (optional) gov facet by id', () => {
    const joined = deployCatalogWithGovMeta();
    expect(joined.length).toBe(MCP_CATALOG.length);
    for (const row of joined) {
      expect(row.entry.id).toMatch(/^[a-z0-9-]+$/);
      // gov is either a full facet or honestly undefined (never a fabricated default).
      if (row.gov) expect(typeof row.gov.govSafe).toBe('boolean');
    }
    // The operational deploy ids that exist in the gov catalog must resolve.
    const grafana = joined.find((r) => r.entry.id === 'grafana');
    expect(grafana?.gov?.govSafe).toBe(true);
  });
});
