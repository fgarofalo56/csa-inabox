/**
 * Structural coverage tests (operator review 3.1/3.2) — assert the coverage
 * registry, the family-derivation engine, and the new wave-3 checks stay
 * coherent. The LIVE probes are exercised server-side against real Azure (they
 * need the Console managed identity); here we verify the STRUCTURE that CI +
 * the health page derive coverage from — no backend behavior is faked.
 */
import { describe, it, expect } from 'vitest';
import { ENV_CHECKS, VALUE_HINT } from '../self-audit';
import coverageMap from '../health-coverage-map.json';
import { familyCoverageChecks } from '../health-coverage';
import { FABRIC_ITEM_TYPES } from '@/lib/catalog/fabric-item-types';
import type { CheckResult } from '../self-audit';

const envIds = new Set(ENV_CHECKS.map((c) => c.id));

describe('coverage registry (health-coverage-map.json)', () => {
  it('maps every workload category in the live item-type catalog', () => {
    const cats = new Set(FABRIC_ITEM_TYPES.filter((t) => !t.deprecated).map((t) => t.category));
    for (const cat of cats) {
      const entry = (coverageMap as any).families[cat];
      expect(entry?.checks?.length, `families["${cat}"]`).toBeGreaterThan(0);
    }
  });

  it('every allowlisted client carries a real justification', () => {
    for (const [name, entry] of Object.entries<any>((coverageMap as any).clients)) {
      if (entry.allow !== undefined) {
        expect(entry.allow.length, `clients["${name}"].allow`).toBeGreaterThanOrEqual(20);
      } else {
        expect(entry.checks?.length, `clients["${name}"].checks`).toBeGreaterThan(0);
      }
    }
  });
});

describe('wave-3 env checks (previously-unmonitored backends)', () => {
  const NEW_IDS = [
    'svc-aas', 'svc-aml', 'svc-apim', 'svc-powerplatform', 'svc-keyvault',
    'svc-servicebus', 'svc-stream-analytics', 'svc-azure-sql', 'svc-postgres',
    'svc-eventgrid', 'svc-batch', 'svc-redis-result-cache',
  ];
  it('declares each new backend check with remediation + provisionedBy', () => {
    for (const id of NEW_IDS) {
      const c = ENV_CHECKS.find((x) => x.id === id);
      expect(c, id).toBeTruthy();
      expect(c!.remediation, `${id} remediation`).toBeTruthy();
      expect(c!.provisionedBy, `${id} provisionedBy`).toBeTruthy();
      expect(c!.severity, id).not.toBe('critical'); // optional workloads never hard-fail
    }
  });
  it('keeps unique check ids after the expansion', () => {
    expect(envIds.size).toBe(ENV_CHECKS.length);
  });
  it('names a VALUE_HINT for each newly-editable env var', () => {
    for (const k of ['LOOM_AAS_SERVER', 'LOOM_AML_WORKSPACE', 'LOOM_KEY_VAULT_URI',
      'LOOM_SERVICEBUS_NAMESPACE', 'LOOM_POSTGRES_HOST', 'LOOM_BATCH_ACCOUNT',
      'LOOM_RESULT_CACHE_REDIS']) {
      expect(VALUE_HINT[k], `VALUE_HINT[${k}]`).toBeTruthy();
    }
  });
  it('flags the result-cache Redis as optionalDefault (in-memory fallback loses zero function)', () => {
    const c = ENV_CHECKS.find((x) => x.id === 'svc-redis-result-cache')!;
    expect(c.optionalDefault).toBe(true);
    expect(c.optionalDefaultDetail).toMatch(/in-memory/i);
  });
});

describe('family derivation (auto-expanding coverage)', () => {
  const mk = (id: string, status: CheckResult['status']): CheckResult => ({
    id, category: 'azure-services', title: id, severity: 'optional', status,
    detail: 'x', remediation: status === 'pass' ? undefined : `fix ${id}`,
  });

  it('derives one check per catalog family, aggregating the WORST mapped status', async () => {
    // Feed synthetic results covering every mapped check id (pass), except make
    // one Data-Engineering backend warn — the family must surface warn.
    const allIds = new Set<string>();
    for (const e of Object.values<any>((coverageMap as any).families)) {
      for (const id of e.checks || []) allIds.add(id);
    }
    const results = [...allIds].map((id) => mk(id, id === 'probe-adls' ? 'warn' : 'pass'));
    const fams = await familyCoverageChecks(results);

    const cats = new Set(FABRIC_ITEM_TYPES.filter((t) => !t.deprecated).map((t) => t.category));
    expect(fams.length).toBe(cats.size);
    for (const f of fams) {
      expect(f.category).toBe('workloads');
      expect(f.id).toMatch(/^family-/);
    }
    const de = fams.find((f) => f.id === 'family-data-engineering')!;
    expect(de.status).toBe('warn');
    expect(de.remediation).toBeTruthy();          // inline remediation carried up
    const foundry = fams.find((f) => f.id === 'family-azure-ai-foundry')!;
    expect(foundry.status).toBe('pass');
  });

  it('turns a DANGLING mapping into an honest fail (never a fabricated green)', async () => {
    // No results at all → every family's mapped ids are missing → fail.
    const fams = await familyCoverageChecks([]);
    for (const f of fams) {
      expect(f.status).toBe('fail');
      expect(f.detail).toMatch(/did not run|stale/i);
    }
  });
});
