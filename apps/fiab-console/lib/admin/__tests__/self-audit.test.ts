import { describe, it, expect } from 'vitest';
import { ENV_CHECKS, VALUE_HINT } from '../self-audit';

/**
 * Self-audit engine — structural + day-one-coverage tests.
 *
 * These do NOT fake backend behavior (no-vaporware.md): runSelfAudit's live
 * probes (Cosmos / AOAI / Purview / Search / Databricks / DLP / posture-fn) are
 * NOT exercised here — they require real Azure. Instead we assert the
 * declarative ENV_CHECKS backbone covers every new surface + data-plane item we
 * promised, with honest severities, and that VALUE_HINT names each new var.
 */
describe('self-audit ENV_CHECKS — day-one surface coverage', () => {
  const byId = new Map(ENV_CHECKS.map((c) => [c.id, c]));

  it('has unique check ids', () => {
    expect(byId.size).toBe(ENV_CHECKS.length);
  });

  it('covers every new surface + data-plane day-one item', () => {
    for (const id of [
      'svc-mcp-deploy',
      'svc-mcp-catalog',
      'svc-warp-engine',
      'svc-deploy-planner',
      'svc-org-visuals',
      'svc-learning-hub',
      'svc-databricks',
    ]) {
      expect(byId.has(id), `missing check ${id}`).toBe(true);
    }
  });

  it('keeps the new surface checks non-critical (legitimately-unconfigured ≠ failing)', () => {
    for (const id of ['svc-mcp-deploy', 'svc-mcp-catalog', 'svc-deploy-planner', 'svc-org-visuals', 'svc-learning-hub', 'svc-databricks']) {
      expect(byId.get(id)!.severity, id).not.toBe('critical');
    }
  });

  it('every check carries a remediation and a provisionedBy source', () => {
    for (const c of ENV_CHECKS) {
      expect(c.remediation, `${c.id} remediation`).toBeTruthy();
      expect(c.provisionedBy, `${c.id} provisionedBy`).toBeTruthy();
    }
  });

  it('names a VALUE_HINT for the new env vars', () => {
    for (const k of ['LOOM_DATABRICKS_HOSTNAME', 'LOOM_PURVIEW_UC_ENDPOINT', 'LOOM_DLP_ENABLED', 'LOOM_ACA_ENV_ID', 'LOOM_BUILTIN_MCP_URL']) {
      expect(VALUE_HINT[k], `VALUE_HINT[${k}]`).toBeTruthy();
    }
  });
});

// NOTE: runSelfAudit's live probes (Cosmos/AOAI/Purview/Search/Databricks/DLP/
// posture-fn) import @azure/identity transitively; the shared-worktree
// node_modules layout cannot ESM-resolve @azure/core-rest-pipeline under vitest
// (see .claude memory fiab-console-pnpm-worktree-gotcha), so a runtime
// runSelfAudit() invocation is exercised live server-side (the audit runs as the
// Console managed identity), not in this unit harness. The structural assertions
// above are the unit-testable surface and they cover that every new probe is
// declared with an honest non-critical severity + a precise remediation.
