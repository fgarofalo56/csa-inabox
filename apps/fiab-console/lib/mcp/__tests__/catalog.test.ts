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
  MCP_DEPLOY_CATALOG as MCP_CATALOG, getCatalogEntry, validateConfigValues,
  entryEgress, reachesExternalSaas, deployServersForCloud, type McpCatalogEntry,
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

  it('every entry carries gov metadata (egress, license, govSafe, airGapSafe)', () => {
    for (const e of MCP_CATALOG) {
      expect(['air-gap-safe', 'azure-internal', 'external-saas']).toContain(entryEgress(e));
      expect(typeof e.govSafe).toBe('boolean');
      expect(typeof e.airGapSafe).toBe('boolean');
      // external-SaaS entries must declare the hosts they reach (drives the warning).
      if (entryEgress(e) === 'external-saas') expect((e.externalHosts || []).length).toBeGreaterThan(0);
      // air-gap-safe entries reach nothing external.
      if (entryEgress(e) === 'air-gap-safe') expect((e.externalHosts || []).length).toBe(0);
    }
  });
});

describe('gov metadata helpers', () => {
  it('reachesExternalSaas is true only for external-saas entries', () => {
    for (const e of MCP_CATALOG) {
      expect(reachesExternalSaas(e)).toBe(entryEgress(e) === 'external-saas');
    }
  });

  it('deployServersForCloud narrows by boundary', () => {
    const commercial = deployServersForCloud('commercial');
    const gcc = deployServersForCloud('gcc');
    const il5 = deployServersForCloud('il5');
    expect(commercial.length).toBe(MCP_CATALOG.length);
    // gcc is a subset of commercial, all govSafe.
    expect(gcc.length).toBeLessThanOrEqual(commercial.length);
    expect(gcc.every((e) => e.govSafe === true)).toBe(true);
    // il5 only air-gap-safe servers (zero external egress).
    expect(il5.every((e) => e.airGapSafe === true)).toBe(true);
    expect(il5.every((e) => entryEgress(e) === 'air-gap-safe')).toBe(true);
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
