/**
 * The 503 classifier's MEMBERSHIP RULE — #4342 review blocker.
 *
 * `configGateFor` attaches a registry gate to a 503 so the surface can render an
 * inline Fix-it (`ux-baseline.md` G2). That is only honest when resolving the
 * named gate ACTUALLY closes the gap the error reported; otherwise the wizard
 * declares success, fires `onResolved()`, and the caller 503s again with an
 * identical envelope under a bar asserting a state the registry already
 * considers wired (`deploy-integrity.md` R7).
 *
 * These arms run the REAL gate registry and the REAL `readAcaConfig` against a
 * REAL process.env — no mocks — because the defect this file exists to catch is
 * a DISAGREEMENT between two real readers of the environment, and any fixture
 * that stands in for either one can only agree with itself.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACA_GAPS_THE_SUBSCRIPTION_GATE_RESOLVES,
  ACA_GATE_ID,
  configGateFor,
} from '../config-gate';
import { getGate, gateStatus } from '@/lib/gates/registry';
import { AcaNotConfiguredError, readAcaConfig } from '@/lib/azure/container-apps-arm-client';

/** Every env var either reader consults, so each arm starts from a known estate. */
const ENV_KEYS = ['LOOM_SUBSCRIPTION_ID', 'LOOM_ACA_RG', 'LOOM_ADMIN_RG', 'LOOM_DLZ_RG'] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('a mapped gate must actually cover the gap it is attached to (#4342)', () => {
  it('every var a whitelisted gap denotes is a setting the mapped gate carries', () => {
    const gate = getGate(ACA_GATE_ID);
    expect(gate, `gate '${ACA_GATE_ID}' is not in the registry`).toBeDefined();
    // requiredSettings ∪ aliasOf — the same surface the Fix-it dialog can write,
    // and the same union `remediation-gate-registry.test.ts` measures.
    const settable = new Set<string>();
    for (const s of gate!.requiredSettings) {
      settable.add(s.envVar);
      for (const a of s.aliasOf || []) settable.add(a);
    }
    for (const [gap, envVars] of ACA_GAPS_THE_SUBSCRIPTION_GATE_RESOLVES) {
      for (const v of envVars) {
        expect(
          settable.has(v),
          `gap '${gap}' denotes ${v}, which gate '${ACA_GATE_ID}' cannot set ` +
            `(it carries: ${[...settable].sort().join(', ')}). Attaching this gate ` +
            `would print a remediation that cannot close the stated gap.`,
        ).toBe(true);
      }
    }
  });

  it('the gate cannot read `configured` while a whitelisted gap is still open', () => {
    // The STRONGER property, and the one that makes the Fix-it work: a gap may
    // be mapped only when `status:'configured'` IMPLIES it is closed. A var that
    // is merely an `anyOf` alternative is satisfiable by a SIBLING, so reaching
    // 'configured' says nothing about it — which is precisely how the shipped
    // whitelist admitted a gap the gate never closes.
    for (const [gap, envVars] of ACA_GAPS_THE_SUBSCRIPTION_GATE_RESOLVES) {
      for (const k of ENV_KEYS) delete process.env[k];
      // Satisfy EVERY other settable var on the gate, leaving only this gap open.
      const denoted = new Set(envVars);
      for (const s of getGate(ACA_GATE_ID)!.requiredSettings) {
        if (!denoted.has(s.envVar)) process.env[s.envVar] = `probe-${s.envVar.toLowerCase()}`;
      }
      const st = gateStatus(ACA_GATE_ID);
      expect(
        st?.status,
        `with ${envVars.join(' / ')} unset and every other '${ACA_GATE_ID}' setting present, ` +
          `the gate reads '${st?.status}' (missing: ${JSON.stringify(st?.missing)}). ` +
          `Gap '${gap}' is therefore NOT closed by resolving this gate, and the ` +
          `Fix-it poll would declare success over a still-broken caller.`,
      ).not.toBe('configured');
    }
  });

  it('THE MEASURED COUNTERFACTUAL: sub + DLZ_RG satisfies the gate while ACA config still throws', () => {
    // The exact estate shape from the review. Both readers are real here.
    process.env.LOOM_SUBSCRIPTION_ID = '00000000-0000-0000-0000-000000000000';
    process.env.LOOM_DLZ_RG = 'rg-csa-loom-dlz-eastus2';

    const st = gateStatus(ACA_GATE_ID);
    expect(st?.status).toBe('configured');
    expect(st?.missing).toEqual([]);

    let thrown: unknown = null;
    try {
      readAcaConfig();
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'readAcaConfig should still refuse — it reads LOOM_ACA_RG || LOOM_ADMIN_RG').
      toBeInstanceOf(AcaNotConfiguredError);
    const missing = (thrown as AcaNotConfiguredError).missing;
    expect(missing).toEqual(['LOOM_ACA_RG (or LOOM_ADMIN_RG)']);

    // So this error must NOT carry the 'subscription' envelope: the gate the
    // envelope names is already 'configured', so its Fix-it has nothing to do and
    // the surface would re-503 behind a wizard that reported success.
    expect(configGateFor(thrown)).toBeNull();
  });
});

describe('the classifier still names a gate when the gate genuinely closes the gap', () => {
  it('a subscription-id-only gap carries the subscription envelope', () => {
    const gate = configGateFor(new AcaNotConfiguredError(['LOOM_SUBSCRIPTION_ID']));
    expect(gate).toEqual({ id: ACA_GATE_ID, missing: ['LOOM_SUBSCRIPTION_ID'] });
  });

  it('an empty gap list establishes nothing, so it names nothing', () => {
    expect(configGateFor(new AcaNotConfiguredError([]))).toBeNull();
  });

  it('a gap outside the whitelist keeps the bare honest 503', () => {
    // `readAcaConfig` is not the only thrower of this class: siblings raise it
    // for a missing LOOM_ACA_ENVIRONMENT and for the MCP-files resource group,
    // neither of which the 'subscription' gate sets.
    expect(
      configGateFor(new AcaNotConfiguredError(['LOOM_ACA_ENVIRONMENT (managed environment name)'])),
    ).toBeNull();
    expect(
      configGateFor(
        new AcaNotConfiguredError(['LOOM_SUBSCRIPTION_ID', 'LOOM_MCP_FILES_RG (or LOOM_ACA_RG / LOOM_ADMIN_RG)']),
      ),
    ).toBeNull();
  });

  it('an unrelated error class is never classified', () => {
    expect(configGateFor(new Error('ARG refused the query'))).toBeNull();
    expect(configGateFor(null)).toBeNull();
  });
});
