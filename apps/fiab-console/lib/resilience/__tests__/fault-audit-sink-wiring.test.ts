/**
 * The per-injection audit sink is WIRED — the outcome, not the mechanism (#4040).
 *
 * `fault-injection.ts` used to fan injections out with
 * `await import('@/lib/admin/audit-stream')`. `tsc` resolves a literal dynamic
 * specifier, so that one line put the alias — and audit-stream's whole static
 * graph behind it — inside the emit closure of every build that reaches
 * `fetchWithTimeout`, including the Brain scan CLI, which declares no `paths`
 * mapping on purpose and therefore failed with TS2307.
 *
 * Replacing it with an injected sink moves the audit wiring OUT of that module
 * and into `app/api/admin/chaos/dependency/route.ts`. That trade has a specific
 * hazard, and it is the reason this file exists: nothing in the repo asserted
 * that injections are audited at all, so an unwired sink would have disabled an
 * audit control with every gate still green.
 *
 * So this asserts the OUTCOME through the production path — import the only
 * module that can arm a fault, arm one, cause an injection, and require that an
 * audit event actually came out. Deleting `setFaultAuditSink(emitAuditEvent)`
 * from the route turns this red (proven by mutation). A test that registered its
 * own sink would prove the mechanism and nothing about the wiring.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const emitted: Array<Record<string, unknown>> = [];
vi.mock('@/lib/admin/audit-stream', () => ({
  emitAuditEvent: (ev: Record<string, unknown>) => {
    emitted.push(ev);
  },
}));

// The subject. Imported for its MODULE-LOAD side effect — that is the wiring
// under test, so it must not be a lazy import inside a case (a second `import()`
// hits the module cache and the side effect does not re-run).
import '@/app/api/admin/chaos/dependency/route';

import {
  armFault,
  fetchFaultForUrl,
  setFaultAuditSink,
  _faultAuditSinkForTest,
  _resetFaultRegistryForTest,
} from '../fault-injection';

// Captured BEFORE any case can register one of its own.
const SINK_AFTER_ROUTE_LOAD = _faultAuditSinkForTest();

const KV_URL = 'https://myvault.vault.azure.net/secrets/foo?api-version=7.4';

beforeEach(() => {
  emitted.length = 0;
  _resetFaultRegistryForTest();
  setFaultAuditSink(SINK_AFTER_ROUTE_LOAD);
  process.env.LOOM_DEPENDENCY_CHAOS_ENABLED = 'true';
});
afterEach(() => {
  _resetFaultRegistryForTest();
  setFaultAuditSink(SINK_AFTER_ROUTE_LOAD);
  delete process.env.LOOM_DEPENDENCY_CHAOS_ENABLED;
});

describe('the injection audit sink is wired by the chaos route', () => {
  it('importing the route registers a sink', () => {
    expect(SINK_AFTER_ROUTE_LOAD).not.toBeNull();
  });

  it('THE OUTCOME: arm -> inject -> an audit event is emitted', () => {
    armFault('kv-throttle', { occurrences: 2, armedBy: 'drill@loom' });
    emitted.length = 0; // arming is audited by the route handler, not by this path

    const directive = fetchFaultForUrl(KV_URL);
    expect(directive).not.toBeNull(); // the injection really happened

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      action: 'chaos.fault.injected',
      targetType: 'resilience-fault',
      targetId: 'kv-throttle',
      tenantId: 'system',
    });
    expect(String(emitted[0].actorUpn)).toContain('drill@loom');
  });

  it('EMBEDDED CONTROL: with NO sink registered, the same run emits nothing', () => {
    // Without this, an `emitted` array that filled up for some unrelated reason
    // would make the case above pass while the wiring was dead.
    setFaultAuditSink(null);
    armFault('kv-throttle', { occurrences: 2 });
    emitted.length = 0;
    expect(fetchFaultForUrl(KV_URL)).not.toBeNull();
    expect(emitted).toEqual([]);
  });

  it('an injection is never BLOCKED by a throwing sink', () => {
    setFaultAuditSink(() => {
      throw new Error('SIEM is down');
    });
    armFault('kv-throttle', { occurrences: 1 });
    expect(() => fetchFaultForUrl(KV_URL)).not.toThrow();
  });
});
