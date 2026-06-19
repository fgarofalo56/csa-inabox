import { describe, it, expect } from 'vitest';
import { OPS_TOOL_SCHEMAS, executeOpsIntention, type OpsIntention } from '../ops-tools';
import { OPS_COPILOT_PERSONAS, OPS_PERSONA_ID } from '../../azure/copilot-personas';

/**
 * Offline unit coverage for the Ops Admin Copilot wiring. The AOAI-classify and
 * ARM-execute paths hit real Azure (covered by the live E2E in the PR receipt);
 * here we assert the pure contracts that keep persona ↔ tools ↔ executor in sync.
 */

describe('ops persona', () => {
  it('exposes the ops-admin persona with an RBAC gate env var', () => {
    const p = OPS_COPILOT_PERSONAS[OPS_PERSONA_ID];
    expect(p).toBeDefined();
    expect(p!.requiredGroupEnvVar).toBe('LOOM_OPS_ADMIN_ENTRA_GROUP');
    expect(p!.requiredArmActions && p!.requiredArmActions.length).toBeGreaterThan(0);
    expect(p!.toolFilter).not.toBe('all');
  });

  it('persona toolFilter matches the registered ops tool schemas exactly', () => {
    const schemaNames = OPS_TOOL_SCHEMAS.map((t: any) => t.function.name).sort();
    const filter = [...(OPS_COPILOT_PERSONAS[OPS_PERSONA_ID].toolFilter as string[])].sort();
    expect(schemaNames).toEqual(filter);
  });

  it('every ops tool schema is a valid OpenAI function def with an object param schema', () => {
    for (const t of OPS_TOOL_SCHEMAS as any[]) {
      expect(t.type).toBe('function');
      expect(typeof t.function.name).toBe('string');
      expect(typeof t.function.description).toBe('string');
      expect(t.function.parameters.type).toBe('object');
      expect(t.function.parameters.additionalProperties).toBe(false);
    }
  });
});

describe('executeOpsIntention — offline branches', () => {
  it('a clarify intention never mutates and returns ok:false with the question', async () => {
    const intention: OpsIntention = { action: 'clarify', question: 'Which pool?' };
    const r = await executeOpsIntention(intention, 'oid-123');
    expect(r.ok).toBe(false);
    expect(r.detail).toBe('Which pool?');
  });
});
