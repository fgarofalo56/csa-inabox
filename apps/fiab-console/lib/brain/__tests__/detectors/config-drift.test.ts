/**
 * LOOM BRAIN — `config-drift`: the four drift kinds, and the false-positive guard.
 *
 * The last describe block is the most important one in this file. This detector's
 * failure mode is not missing drift — it is flagging EVERYTHING, because a bicep
 * value is an expression (`'https://${loomX!.outputs.fqdn}'`) and a live value is
 * a resolved FQDN, and those strings never match. A surface that flags every wire
 * on the estate gets ignored, which is worse than one that flags nothing: nothing
 * is a visible gap, everything is invisible noise.
 */

import { describe, it, expect } from 'vitest';
import { CONFIG_DRIFT, configDrift, normalizeLiteral } from '../../detectors';
import {
  BROKER_FQDN,
  BROKER_ID,
  CONSOLE_ID,
  DIRECTLAKE_FQDN,
  DIRECTLAKE_ID,
  buildFixtureGraph,
} from './fixtures';

describe('normalizeLiteral — comparison is on the value, not on its punctuation', () => {
  it('trims, unquotes, drops a trailing slash and case-folds', () => {
    expect(normalizeLiteral("  'https://Example.COM/' ")).toBe('https://example.com');
    expect(normalizeLiteral('https://example.com')).toBe('https://example.com');
  });
});

describe('config-drift — NEGATIVE: the base estate has no drift', () => {
  const graph = buildFixtureGraph();
  const result = configDrift(graph);

  it('a wire that resolves to the same node on both sides is not drift', () => {
    // LOOM_DIRECTLAKE_URL: the template resolves via moduleTargets, the live app
    // resolves via its FQDN, and BOTH land on direct-lake. This is the case a
    // naive string comparison would flag, and it must not.
    expect(result.detector).toBe(CONFIG_DRIFT);
    const dl = result.findings.filter((f) => f.subjects.includes(DIRECTLAKE_ID));
    expect(dl).toEqual([]);
  });

  it('a wire that is empty on BOTH sides is not drift either — the sides AGREE', () => {
    // LOOM_BROKER_URL is '' in the template and '' on the live app. They agree,
    // and they are both wrong — which is `dangling-wire`'s finding, not this
    // one. Reporting it here would triple-count a single defect.
    const broker = result.findings.filter((f) => f.subjects.includes(BROKER_ID));
    expect(broker).toEqual([]);
  });

  it('but the pairs WERE compared — the population proves it did not simply skip everything', () => {
    // A detector that skipped both pairs would produce the same empty result.
    expect(result.population.scope).toMatch(/2 pair\(s\) joined on \(from, symbol\)/);
    expect(result.population.blind).toBe(false);
  });
});

describe('config-drift — POSITIVE: live-empty (the deployment LOST a wire)', () => {
  const graph = buildFixtureGraph({
    consoleEnvOverride: [
      { name: 'LOOM_BROKER_URL', value: '' },
      // The template declares a real target; the running app carries ''.
      { name: 'LOOM_DIRECTLAKE_URL', value: '' },
    ],
    extraConsoleBindings: { LOOM_DIRECTLAKE_URL: DIRECTLAKE_ID },
  });
  const result = configDrift(graph);

  it('is reported at HIGH severity', () => {
    const f = result.findings.find((x) => x.title.includes('live-empty'));
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
    expect(f!.summary).toContain('LOOM_DIRECTLAKE_URL');
  });

  it('and names deploy-integrity R2 — merged is not deployed', () => {
    const f = result.findings.find((x) => x.title.includes('live-empty'))!;
    expect(f.evidence.notes.join('\n')).toMatch(/merged is not deployed/);
    expect(f.remediation.proposedChange).toMatch(/Roll the app/);
  });
});

describe('config-drift — POSITIVE: declared-empty (someone patched the LIVE app by hand)', () => {
  // Measured on the real estate: the live console carries a hand-added
  // `LOOM_CAPACITY_BROKER_URL` alongside the bicep-emitted `LOOM_BROKER_URL`.
  // Only a `configured` edge can ever see this; no amount of reading bicep will.
  const graph = buildFixtureGraph({
    consoleEnvOverride: [
      { name: 'LOOM_BROKER_URL', value: `https://${BROKER_FQDN}` },
      { name: 'LOOM_DIRECTLAKE_URL', value: `https://${DIRECTLAKE_FQDN}` },
    ],
  });
  const result = configDrift(graph);

  it('is reported, and identifies the live value as having no template origin', () => {
    const f = result.findings.find((x) => x.title.includes('declared-empty'));
    expect(f).toBeDefined();
    expect(f!.severity).toBe('medium');
    expect(f!.summary).toContain('LOOM_BROKER_URL');
    expect(f!.evidence.notes.join('\n')).toMatch(/hand-patch/);
  });

  it('and warns the next deploy will revert it', () => {
    const f = result.findings.find((x) => x.title.includes('declared-empty'))!;
    expect(f.evidence.notes.join('\n')).toMatch(/silently reverted by the next deploy/);
    expect(f.remediation.proposedChange).toMatch(/Move the working value INTO the template/);
  });

  it('the broker becomes REACHABLE in this graph, which is why the two detectors differ', () => {
    // The same edit that creates this drift finding also gives the broker a
    // resolved inbound configured edge — so `unreachable-service` would no longer
    // report it. Two detectors, two questions, and this fixture shows they move
    // independently.
    expect(graph.inboundEdges(BROKER_ID, 'configured').result).toHaveLength(1);
  });
});

describe('config-drift — POSITIVE: target-mismatch (two concrete, different endpoints)', () => {
  const graph = buildFixtureGraph({
    consoleEnvOverride: [
      { name: 'LOOM_BROKER_URL', value: '' },
      // The template resolves LOOM_DIRECTLAKE_URL to direct-lake; the live app
      // points the SAME variable at the broker.
      { name: 'LOOM_DIRECTLAKE_URL', value: `https://${BROKER_FQDN}` },
    ],
  });
  const result = configDrift(graph);

  it('is reported at HIGH severity with both resolved node names', () => {
    const f = result.findings.find((x) => x.title.includes('target-mismatch'));
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
    expect(f!.summary).toContain('loom-direct-lake');
    expect(f!.summary).toContain('loom-capacity-broker');
    // Both endpoints are subjects, so the finding is navigable from either.
    expect(f!.subjects).toContain(DIRECTLAKE_ID);
    expect(f!.subjects).toContain(BROKER_ID);
    expect(f!.confidence).toBe('high');
  });
});

describe('config-drift — THE FALSE-POSITIVE GUARD: an uncomparable pair is SKIPPED', () => {
  const graph = buildFixtureGraph({
    // A template expression with NO moduleTargets mapping, so the declared side
    // stays an unresolved interpolation …
    extraBicepLines: ["            { name: 'LOOM_MYSTERY_URL', value: 'https://${loomMystery!.outputs.fqdn}' }"],
    // … against a live literal that resolves to nothing either.
    extraConsoleEnv: [{ name: 'LOOM_MYSTERY_URL', value: 'https://mystery.example.invalid' }],
  });
  const result = configDrift(graph);

  it('produces NO finding — comparing an ARM expression to an endpoint as strings would flag everything', () => {
    expect(result.findings.every((f) => !f.summary.includes('LOOM_MYSTERY_URL'))).toBe(true);
  });

  it('and records the pair as NOT COMPARABLE with the reason and the remedy', () => {
    // Silence here would be the detector answering a narrower question than its
    // name implies. The skip is what makes the narrowing visible.
    const s = result.skipped.find((x) => x.subject.includes('LOOM_MYSTERY_URL'));
    expect(s).toBeDefined();
    expect(s!.reason).toMatch(/NOT COMPARABLE/);
    expect(s!.reason).toMatch(/unresolved bicep expression/);
    expect(s!.reason).toMatch(/Supply `moduleTargets`/);
  });

  it('and the SAME pair becomes comparable once moduleTargets is supplied', () => {
    // The remedy the skip names actually works — otherwise it is advice the code
    // cannot honour.
    const wired = buildFixtureGraph({
      extraBicepLines: ["            { name: 'LOOM_MYSTERY_URL', value: 'https://${loomMystery!.outputs.fqdn}' }"],
      extraModuleTargets: { loomMystery: DIRECTLAKE_FQDN },
      extraConsoleEnv: [{ name: 'LOOM_MYSTERY_URL', value: `https://${BROKER_FQDN}` }],
    });
    const r2 = configDrift(wired);
    expect(r2.skipped.some((x) => x.subject.includes('LOOM_MYSTERY_URL'))).toBe(false);
    const f = r2.findings.find((x) => x.summary.includes('LOOM_MYSTERY_URL'));
    expect(f).toBeDefined();
    expect(f!.title).toContain('target-mismatch');
  });
});

describe('config-drift — a declared wire with no live counterpart is NOT drift', () => {
  it('it is left to `declared-but-dead` rather than double-reported', () => {
    const graph = buildFixtureGraph({
      consoleEnvOverride: [{ name: 'LOOM_BROKER_URL', value: '' }],
    });
    const result = configDrift(graph);
    // LOOM_DIRECTLAKE_URL is declared and absent from the live env. No pair, no
    // finding here.
    expect(result.findings.every((f) => !f.summary.includes('LOOM_DIRECTLAKE_URL'))).toBe(true);
    expect(result.population.scope).toMatch(/is NOT drift and is left to `declared-but-dead`/);
    expect(CONSOLE_ID).toBeTruthy();
  });
});
