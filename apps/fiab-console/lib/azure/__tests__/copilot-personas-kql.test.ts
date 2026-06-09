import { describe, it, expect, vi } from 'vitest';

// KQL_TOOL_NAMES lives in kql-tools, which imports copilot-orchestrator (pulls
// @azure/identity + the full client graph) and kusto-client. Stub both so the
// import stays light — we only need the exported const tuple.
vi.mock('@/lib/azure/copilot-orchestrator', () => ({
  LoomToolRegistry: class { register() {} list() { return []; } get() { return undefined; } },
}));
vi.mock('@/lib/azure/kusto-client', () => ({
  executeQuery: vi.fn(), executeMgmtCommand: vi.fn(), listDatabases: vi.fn(),
  listTables: vi.fn(), getDatabaseSchemaJson: vi.fn(), kustoConfigGate: vi.fn(() => null),
}));

import {
  KQL_COPILOT_PERSONA,
  LOOM_COPILOT_PERSONA,
  COPILOT_PERSONAS,
  getPersona,
  injectSchema,
  SCHEMA_PLACEHOLDER,
} from '../copilot-personas-kql';
import { KQL_TOOL_NAMES } from '@/lib/copilot/kql-tools';

describe('copilot-personas', () => {
  it('KQL persona allowedTools matches the KQL tool registry names exactly', () => {
    expect([...KQL_COPILOT_PERSONA.allowedTools].sort()).toEqual([...KQL_TOOL_NAMES].sort());
  });

  it('KQL persona generate/fix prompts carry the schema placeholder; explain does not', () => {
    expect(KQL_COPILOT_PERSONA.generateSystemPrompt).toContain(SCHEMA_PLACEHOLDER);
    expect(KQL_COPILOT_PERSONA.fixSystemPrompt).toContain(SCHEMA_PLACEHOLDER);
    expect(KQL_COPILOT_PERSONA.explainSystemPrompt).not.toContain(SCHEMA_PLACEHOLDER);
  });

  it('persona temperatures are within [0, 1]', () => {
    for (const p of Object.values(COPILOT_PERSONAS)) {
      expect(p.temperature).toBeGreaterThanOrEqual(0);
      expect(p.temperature).toBeLessThanOrEqual(1);
    }
  });

  it('LOOM persona has empty allowedTools (unrestricted)', () => {
    expect(LOOM_COPILOT_PERSONA.allowedTools).toEqual([]);
  });

  it('getPersona resolves known ids and returns undefined for unknown', () => {
    expect(getPersona('kql-copilot')).toBe(KQL_COPILOT_PERSONA);
    expect(getPersona('loom-copilot')).toBe(LOOM_COPILOT_PERSONA);
    expect(getPersona('nope')).toBeUndefined();
  });

  describe('injectSchema', () => {
    it('replaces the placeholder with the supplied schema', () => {
      const out = injectSchema(KQL_COPILOT_PERSONA.generateSystemPrompt, 'TABLE Events (ts:datetime)');
      expect(out).toContain('TABLE Events (ts:datetime)');
      expect(out).not.toContain(SCHEMA_PLACEHOLDER);
    });

    it('removes the schema-grounding preamble + placeholder when schema is empty', () => {
      const out = injectSchema(KQL_COPILOT_PERSONA.generateSystemPrompt, '   ');
      expect(out).not.toContain(SCHEMA_PLACEHOLDER);
      // The "Database schema (ground all KQL …):" preamble line is gone…
      expect(out).not.toMatch(/Database schema \(ground all KQL/i);
      // …but the core instruction text (which also mentions "database schema") survives.
      expect(out).toContain('KQL (Kusto Query Language) query generator');
      expect(out.trimEnd()).toBe(out); // no dangling trailing whitespace
    });

    it('returns the template unchanged when there is no placeholder', () => {
      expect(injectSchema(KQL_COPILOT_PERSONA.explainSystemPrompt, 'X')).toBe(
        KQL_COPILOT_PERSONA.explainSystemPrompt,
      );
    });
  });
});
