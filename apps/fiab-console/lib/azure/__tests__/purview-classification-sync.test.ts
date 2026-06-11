/**
 * Specs for the taxonomy → Purview classification sync mapper.
 * Verifies the matchStrategy → regex-pattern translation, the LOOM.<TENANT>
 * namespacing, the happy-path push (defs + custom rules + scan rule sets), the
 * honest gate when LOOM_PURVIEW_ACCOUNT is unset, and the best-effort error
 * capture when the scan plane rejects.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../purview-client', () => {
  class PurviewNotConfiguredError extends Error {
    hint: any;
    constructor(hint: any) { super('not configured'); this.hint = hint; }
  }
  class PurviewError extends Error {
    status: number; body: unknown;
    constructor(s: number, b: unknown, m?: string) { super(m || 'purview err'); this.status = s; this.body = b; }
  }
  return {
    PurviewNotConfiguredError,
    PurviewError,
    ensureClassificationDefs: vi.fn(async () => {}),
    upsertCustomClassificationRule: vi.fn(async (r: any) => ({ name: r.name, classificationName: r.classificationName })),
    upsertScanRuleset: vi.fn(async (rs: any) => ({ name: rs.name, kind: rs.kind })),
    deleteCustomClassificationRule: vi.fn(async () => true),
    isPurviewConfigured: vi.fn(() => true),
    getPurviewAccountName: vi.fn(() => 'purview-test'),
    notConfiguredHint: vi.fn((missing: string) => ({
      missingEnvVar: missing,
      bicepModule: 'platform/fiab/bicep/modules/admin-plane/catalog.bicep',
      bicepStatus: 'classic Data Map account',
      rolesRequired: [],
      followUp: 'set LOOM_PURVIEW_ACCOUNT',
    })),
  };
});

import * as client from '../purview-client';
import {
  syncClassificationTaxonomyToPurview,
  rulePatterns,
  classificationName,
  classificationRuleName,
  scanRulesetName,
  DEFAULT_SCAN_RULESET_KINDS,
  type LoomClassificationRule,
} from '../purview-classification-sync';

const TENANT = 'aaaabbbb-1111-2222-3333-444455556666';

function rule(p: Partial<LoomClassificationRule>): LoomClassificationRule {
  return { id: 'r1', name: 'My Rule', matchStrategy: 'data-regex', matchValue: 'x', classification: 'PII', ...p };
}

beforeEach(() => {
  vi.clearAllMocks();
  (client.isPurviewConfigured as any).mockReturnValue(true);
  (client.getPurviewAccountName as any).mockReturnValue('purview-test');
});

describe('rulePatterns translation', () => {
  it('column-name-regex → columnPatterns', () => {
    expect(rulePatterns(rule({ matchStrategy: 'column-name-regex', matchValue: '.*email.*' })))
      .toEqual({ columnPatterns: ['.*email.*'], dataPatterns: [] });
  });
  it('data-regex → dataPatterns', () => {
    expect(rulePatterns(rule({ matchStrategy: 'data-regex', matchValue: '\\d{3}-\\d{2}-\\d{4}' })))
      .toEqual({ columnPatterns: [], dataPatterns: ['\\d{3}-\\d{2}-\\d{4}'] });
  });
  it('dictionary → escaped \\b(...) alternation dataPattern', () => {
    const out = rulePatterns(rule({ matchStrategy: 'dictionary', matchValue: 'visa, master.card, amex' }));
    expect(out.columnPatterns).toEqual([]);
    expect(out.dataPatterns).toEqual(['\\b(visa|master\\.card|amex)\\b']);
  });
  it('empty matchValue → no patterns', () => {
    expect(rulePatterns(rule({ matchValue: '' }))).toEqual({ columnPatterns: [], dataPatterns: [] });
  });
});

describe('namespacing helpers', () => {
  it('classificationName is LOOM.<TENANT8>.<CLASS>', () => {
    expect(classificationName(TENANT, 'PII')).toBe('LOOM.AAAABBBB.PII');
    expect(classificationName(TENANT, 'Highly Confidential')).toBe('LOOM.AAAABBBB.HIGHLY_CONFIDENTIAL');
  });
  it('classificationRuleName slugs to alphanumeric/underscore', () => {
    expect(classificationRuleName(TENANT, 'Email columns!')).toBe('Loom_AAAABBBB_Email_columns');
  });
  it('scanRulesetName is per-kind', () => {
    expect(scanRulesetName(TENANT, 'AdlsGen2')).toBe('Loom_AAAABBBB_AdlsGen2');
  });
});

describe('syncClassificationTaxonomyToPurview', () => {
  it('pushes defs + custom rules + one scan rule set per default kind', async () => {
    const rules = [
      rule({ id: 'r1', name: 'SSN', matchStrategy: 'data-regex', matchValue: '\\d{3}-\\d{2}-\\d{4}', classification: 'PII' }),
      rule({ id: 'r2', name: 'Email', matchStrategy: 'column-name-regex', matchValue: '.*email.*', classification: 'PII' }),
    ];
    const res = await syncClassificationTaxonomyToPurview(rules, TENANT);
    expect(res.synced).toBe(true);
    expect(res.purviewConfigured).toBe(true);
    expect(res.ruleCount).toBe(2);
    // ensureClassificationDefs called with the de-duped namespaced classification
    expect(client.ensureClassificationDefs).toHaveBeenCalledWith(['LOOM.AAAABBBB.PII']);
    expect(client.upsertCustomClassificationRule).toHaveBeenCalledTimes(2);
    // one scan rule set per default kind, each including both rule names
    expect(client.upsertScanRuleset).toHaveBeenCalledTimes(DEFAULT_SCAN_RULESET_KINDS.length);
    expect(res.scanRulesets.map((r) => r.kind).sort()).toEqual([...DEFAULT_SCAN_RULESET_KINDS].sort());
    const firstRulesetCall = (client.upsertScanRuleset as any).mock.calls[0][0];
    expect(firstRulesetCall.includedCustomClassificationRuleNames).toEqual(['Loom_AAAABBBB_SSN', 'Loom_AAAABBBB_Email']);
  });

  it('honest gate (no error) when LOOM_PURVIEW_ACCOUNT unset', async () => {
    (client.isPurviewConfigured as any).mockReturnValue(false);
    const res = await syncClassificationTaxonomyToPurview([rule({})], TENANT);
    expect(res.purviewConfigured).toBe(false);
    expect(res.synced).toBe(false);
    // Hint is computed deterministically from notConfiguredHint — NOT via a
    // dead empty-array probe (ensureClassificationDefs early-returns on []).
    expect(client.notConfiguredHint).toHaveBeenCalledWith('LOOM_PURVIEW_ACCOUNT');
    expect(res.hint?.missingEnvVar).toBe('LOOM_PURVIEW_ACCOUNT');
    expect(client.ensureClassificationDefs).not.toHaveBeenCalled();
    expect(client.upsertCustomClassificationRule).not.toHaveBeenCalled();
  });

  it('captures an upstream error without throwing (Cosmos write is preserved)', async () => {
    (client.upsertCustomClassificationRule as any).mockRejectedValueOnce(
      new (client as any).PurviewError(403, null, 'UAMI lacks Data Source Administrator'),
    );
    const res = await syncClassificationTaxonomyToPurview([rule({})], TENANT);
    expect(res.synced).toBe(false);
    expect(res.purviewConfigured).toBe(true);
    expect(res.error).toContain('Data Source Administrator');
  });
});
