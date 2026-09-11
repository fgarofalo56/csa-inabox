/**
 * The Copilot UAT's scoring decision, under test.
 *
 * This decision had no test at all, and for two rounds it was the only thing
 * standing between a dead copilot and a green suite. The cases below are
 * written from the RESPONSES THE ROUTES ACTUALLY EMIT (each names its source
 * file), not from the shapes the classifier happens to handle — a fixture
 * invented to match the implementation proves the implementation matches
 * itself.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  classify,
  gateIsFailure,
  scorePersona,
  aoaiGateAllowed,
  GATE_CODES,
  DELIBERATE_GATE_CODES,
  AOAI_BACKED_PERSONAS,
  NON_AOAI_BACKED_PERSONAS,
  type Probe,
} from '../e2e/_lib/copilot-verdict';

const json = (status: number, body: unknown): Probe => ({
  status,
  ct: 'application/json',
  text: JSON.stringify(body),
});

describe('classify — real answers', () => {
  it('an SSE stream is real, whatever the body', () => {
    expect(classify({ status: 200, ct: 'text/event-stream', text: '' }).verdict).toBe('real');
  });

  it('HTTP 200 ok:true is real', () => {
    expect(classify(json(200, { ok: true, data: {} })).verdict).toBe('real');
  });
});

describe('classify — the #4432 family', () => {
  // app/api/copilot/orchestrate/route.ts documents this exact shape: before the
  // fix a throw escaped to Next.js, which answers 500 with a NON-JSON body.
  it('the ORIGINAL #4432 500 (non-JSON body) fails — it always did', () => {
    const p: Probe = {
      status: 500,
      ct: 'text/html; charset=utf-8',
      text: '<!DOCTYPE html><html><body>Internal Server Error</body></html>',
    };
    expect(classify(p).verdict).toBe('fail');
  });

  // The fix made the body well-formed. That is right, and it is what moved a
  // 500 out of "unparseable, so fail" and into a branch that used to tolerate
  // it. This case is the regression guard for that window.
  it('the POST-FIX 500 (parseable, non-gate code) fails', () => {
    const p = json(500, { ok: false, code: 'orchestrate_failed', error: 'boom' });
    expect(classify(p).verdict).toBe('fail');
    expect(classify(p).reason).toContain('server error, not a gate');
  });

  it('a codeless 502/503 fails — a gate must name itself', () => {
    for (const status of [502, 503]) {
      expect(classify(json(status, { ok: false, error: 'nope' })).verdict).toBe('fail');
    }
  });
});

describe('classify — honest gates survive', () => {
  it.each(GATE_CODES)('code %s at 503 is a gate', (code) => {
    expect(classify(json(503, { ok: false, code })).verdict).toBe('gate');
  });

  // app/api/copilot/orchestrate/route.ts and app/api/help-copilot/chat/route.ts
  // emit `no_aoai` at 503 — a 5xx that IS a documented gate.
  it('no_aoai at 503 is a gate even though 503 is a 5xx', () => {
    expect(classify(json(503, { ok: false, code: 'no_aoai' })).verdict).toBe('gate');
  });

  it('a codeless 401/403/424 is still an honest infra gate', () => {
    for (const status of [401, 403, 424]) {
      expect(classify(json(status, { ok: false, error: 'Dataverse not wired' })).verdict)
        .toBe('gate');
    }
  });

  it('but a Loom-session 401 is a real failure, not a gate', () => {
    expect(classify(json(401, { ok: false, error: 'unauthenticated' })).verdict).toBe('fail');
  });

  it('a 404 is always a fail — the route is missing', () => {
    expect(classify(json(404, { ok: false, code: 'no_aoai' })).verdict).toBe('fail');
  });
});

describe('gateIsFailure — AOAI-backed personas must answer', () => {
  const noAoai = json(503, { ok: false, code: 'no_aoai' });

  it('does nothing unless the caller asks for it', () => {
    expect(gateIsFailure(noAoai, 'gate', {})).toBe(false);
  });

  it('fails a no_aoai gate on a requireReal persona', () => {
    expect(gateIsFailure(noAoai, 'gate', { requireReal: true })).toBe(true);
  });

  it('the opt-out downgrades it', () => {
    expect(gateIsFailure(noAoai, 'gate', { requireReal: true, allowAoaiGate: true })).toBe(false);
  });

  // app/api/copilot/complete/route.ts returns code:'disabled' for a tenant
  // admin org-wide toggle. Calling a switch someone chose to turn off a broken
  // deployment is the same R7 error pointed the other way.
  it.each(DELIBERATE_GATE_CODES)('tolerates the deliberate choice %s', (code) => {
    expect(gateIsFailure(json(403, { ok: false, code }), 'gate', { requireReal: true }))
      .toBe(false);
  });

  it('never turns a real answer into a failure', () => {
    expect(gateIsFailure(json(200, { ok: true }), 'real', { requireReal: true })).toBe(false);
  });
});

/**
 * The COMBINATION, not just its halves.
 *
 * A re-review killed the first version of this suite by mutating the glue
 * instead of the module: deleting `|| mustAnswer` from the caller removed the
 * must-answer rule entirely and all 20 tests stayed green, because every
 * assertion sat one layer below where the rule was applied. These cases assert
 * on `bad` — the field that mutation flips — so the rule is covered where it
 * actually takes effect.
 */
describe('scorePersona — the combined decision', () => {
  const noAoai = json(503, { ok: false, code: 'no_aoai' });

  it('an AOAI persona that gates is BAD (the `|| mustAnswer` arm)', () => {
    const s = scorePersona('persona:help-copilot', 'act', noAoai);
    expect(s.verdict).toBe('gate');
    expect(s.mustAnswer).toBe(true);
    expect(s.bad).toBe(true);
    expect(s.message).toContain('broken deployment');
    expect(s.notes).toContain('must answer, not gate');
  });

  it('the same gate on a NON-requireReal persona is not bad', () => {
    const s = scorePersona('persona:copilot-studio-agent', 'act', noAoai);
    expect(s.bad).toBe(false);
    expect(s.mustAnswer).toBe(false);
    expect(s.message).not.toContain('broken deployment');
  });

  it('the opt-out downgrades it (the `!REQUIRE_REAL_AOAI` arm)', () => {
    const s = scorePersona('persona:help-copilot', 'act', noAoai, { env: { LOOM_UAT_ALLOW_AOAI_GATE: 'true' } as any });
    expect(s.bad).toBe(false);
    expect(s.mustAnswer).toBe(false);
  });

  it('a plain fail is bad regardless of requireReal (the `verdict === fail` arm)', () => {
    const s = scorePersona('persona:copilot-studio-agent', 'act', json(500, { ok: false, code: 'orchestrate_failed' }));
    expect(s.verdict).toBe('fail');
    expect(s.mustAnswer).toBe(false);
    expect(s.bad).toBe(true);
  });

  it('a real answer is never bad', () => {
    const s = scorePersona('persona:help-copilot', 'act', json(200, { ok: true }));
    expect(s.verdict).toBe('real');
    expect(s.bad).toBe(false);
  });

  it('a deliberate tenant toggle is not bad even on an AOAI persona', () => {
    const s = scorePersona('persona:help-copilot', 'act', json(403, { ok: false, code: 'disabled' }));
    expect(s.verdict).toBe('gate');
    expect(s.bad).toBe(false);
  });
});

/**
 * The fields the Playwright caller plumbs.
 *
 * `assertPrimaryAction` deliberately contains no decision — grade, status and
 * the asserted value all come off `PersonaScore`. A re-review mutated each of
 * those expressions while they still lived in the caller and the suite stayed
 * green every time, because glue that needs the Playwright runner is
 * unreachable from here. Pinning them as module fields is what makes them
 * testable at all.
 */
describe('scorePersona — the reported fields', () => {
  const noAoai = json(503, { ok: false, code: 'no_aoai' });

  it('grade/status/actual all follow `bad` when the persona must answer', () => {
    const s = scorePersona('persona:help-copilot', 'act', noAoai);
    expect(s.bad).toBe(true);
    expect(s.grade).toBe('F');
    expect(s.status).toBe('fail');
    // The value the caller asserts on. If this stops tracking `bad`, an
    // AOAI-backed persona can gate and still pass.
    expect(s.actual).toBe('fail');
  });

  it('grade/status/actual all follow `bad` when the answer is real', () => {
    const s = scorePersona('persona:help-copilot', 'act', json(200, { ok: true }));
    expect(s.bad).toBe(false);
    expect(s.grade).toBe('A');
    expect(s.status).toBe('pass');
    expect(s.actual).toBe('real');
  });

  it('a tolerated gate reports the gate verdict, not a failure', () => {
    const s = scorePersona('persona:copilot-studio-agent', 'act', noAoai);
    expect(s.grade).toBe('A');
    expect(s.status).toBe('pass');
    expect(s.actual).toBe('gate');
  });
});

/**
 * The persona set as DATA.
 *
 * It was `{ requireReal: true }` at six call sites; deleting one silently
 * removed the rule for that persona with every test green, because a call-site
 * annotation cannot be reached from a unit test. As module data, dropping a
 * persona changes something under test.
 */
describe('AOAI_BACKED_PERSONAS', () => {
  const noAoai = json(503, { ok: false, code: 'no_aoai' });

  it('every member fails on an AOAI gate', () => {
    expect(AOAI_BACKED_PERSONAS.size).toBeGreaterThan(0);
    for (const persona of AOAI_BACKED_PERSONAS) {
      expect(scorePersona(persona, 'primary', noAoai).bad, persona).toBe(true);
    }
  });

  it('covers each AOAI-backed surface the spec drives', () => {
    // Named explicitly so REMOVING one from the set fails here, rather than
    // silently shrinking the population the loop above iterates.
    for (const persona of [
      'persona:notebook-in-cell-copilot',
      'persona:warehouse-copilot',
      'persona:azure-sql-copilot',
      'persona:cross-item-copilot',
      'persona:help-copilot',
      'persona:notebook-inline-complete',
      // app/api/governance/govern/copilot/route.ts — "Real backend: Azure
      // OpenAI chat-completions via resolveAoaiTarget()", and it emits
      // code:'no_aoai' with missingEnvVar:'LOOM_AOAI_ENDPOINT'. A previous
      // revision of this file asserted the OPPOSITE — that this persona is
      // Power Platform and its no_aoai gate is acceptable — which made the
      // rule silently inapplicable to an AOAI route and PINNED that with a
      // regression test. The exclusion was wrong, not the rule.
      'persona:governance-copilot',
    ]) {
      expect(AOAI_BACKED_PERSONAS.has(persona), persona).toBe(true);
    }
  });

  it('does NOT cover the surfaces Loom genuinely does not provision', () => {
    // Dataverse / BAP (no Power Platform environment is deployed by Loom) and
    // the Cosmos-backed gallery, which makes no model call at all. Each of
    // these is checked against a route in NON_AOAI_BACKED_PERSONAS' comments —
    // "not AOAI-backed" is a claim about a backend, so it needs a referent
    // exactly as much as the positive claim does.
    for (const persona of ['persona:copilot-studio-agent', 'persona:copilot-template-library']) {
      expect(AOAI_BACKED_PERSONAS.has(persona), persona).toBe(false);
      expect(scorePersona(persona, 'primary', noAoai).bad, persona).toBe(false);
    }
  });

  it('the two sets are disjoint', () => {
    for (const persona of AOAI_BACKED_PERSONAS) {
      expect(NON_AOAI_BACKED_PERSONAS.has(persona), `${persona} is in BOTH sets`).toBe(false);
    }
  });
});

/**
 * The set must describe the SPEC, not just itself.
 *
 * A re-review pointed out that every test above asserts membership in
 * `AOAI_BACKED_PERSONAS` — so renaming a surface string at the call site in
 * `copilot.uat.ts` left the whole suite green while silently removing the
 * must-answer rule from that persona. Membership in a set nothing checks
 * against is the same class of gap as the call-site flag this set replaced.
 *
 * So the population comes off the SPEC FILE, and the two are required to agree.
 */
describe('AOAI_BACKED_PERSONAS agrees with the spec that uses it', () => {
  const specPath = path.join(__dirname, '..', 'e2e', 'copilot.uat.ts');
  const spec = readFileSync(specPath, 'utf-8');
  const driven = new Set(
    [...spec.matchAll(/assertPrimaryAction\(\s*'([^']+)'/g)].map((m) => m[1]),
  );

  it('the spec really does drive personas (a zero match would pass everything)', () => {
    expect(driven.size).toBeGreaterThan(5);
  });

  it('every AOAI-backed persona is a surface the spec actually drives', () => {
    for (const persona of AOAI_BACKED_PERSONAS) {
      // If this fails, either the set has a stale name or the spec renamed a
      // call site — and in the second case that persona silently stopped being
      // required to answer.
      expect(driven.has(persona), `${persona} is in the set but not driven by the spec`)
        .toBe(true);
    }
  });

  /**
   * THE OTHER DIRECTION — the one that was missing.
   *
   * The check above is set → spec. It cannot see a persona the spec drives that
   * is in NEITHER set: adding a new AOAI-backed surface to `copilot.uat.ts`
   * without listing it here would leave it permanently gate-tolerant, with every
   * test green. That is how `persona:governance-copilot` stayed on the wrong side
   * of the rule — an omission is invisible to a membership check, which is why
   * the classification has to be a PARTITION of the driven population rather
   * than a filter over it.
   *
   * Deciding which side a new persona belongs on is the author's job. Being
   * FORCED to decide is this test's.
   */
  it('every persona the spec drives is classified — neither set may omit it', () => {
    const unclassified = [...driven].filter(
      (p) => !AOAI_BACKED_PERSONAS.has(p) && !NON_AOAI_BACKED_PERSONAS.has(p),
    );
    expect(
      unclassified,
      'driven by copilot.uat.ts but in neither AOAI_BACKED_PERSONAS nor '
      + 'NON_AOAI_BACKED_PERSONAS — add it to the one that names its real backend',
    ).toEqual([]);
  });

  it('neither set names a persona the spec no longer drives', () => {
    // The mirror of the rule above, for the non-AOAI half: a stale entry here
    // would silently enlarge the tolerated population.
    for (const persona of NON_AOAI_BACKED_PERSONAS) {
      expect(driven.has(persona), `${persona} is classified but not driven by the spec`)
        .toBe(true);
    }
  });
});

/**
 * GATE_CODES must name codes that are actually EMITTED.
 *
 * `copilot_studio_not_enabled` sat in both GATE_CODES and DELIBERATE_GATE_CODES
 * while NOTHING under `app/api/**` emitted it — the real Copilot Studio gate
 * came back as a codeless 503 and the codeless-5xx rule scored it a fault. A
 * classifier branch keyed on an unreachable string is not tolerance; it is a
 * rule that quietly does not apply, and no test could tell the difference.
 *
 * So the list is checked against the routes. This greps the emitted source
 * rather than importing the routes because the route modules pull in the whole
 * Next/Azure graph; the grep is the cheap instrument, and the positive control
 * below is what stops it passing by matching nothing.
 */
describe('GATE_CODES are emitted by real routes', () => {
  const apiRoot = path.join(__dirname, '..', 'app', 'api');

  function collect(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(full, acc);
      else if (entry.name.endsWith('.ts') && !full.includes('__tests__')) acc.push(full);
    }
    return acc;
  }

  const sources = collect(apiRoot).map((f) => readFileSync(f, 'utf-8'));
  // Codes emitted by a LIBRARY the routes hand to the response envelope rather
  // than writing inline. `copilot_studio_not_enabled` is thrown by
  // lib/azure/copilot-studio-client.ts and reaches the wire through
  // copilotStudioErrorEnvelope(), so the route files never contain the literal.
  const libSources = [
    readFileSync(path.join(__dirname, '..', 'lib', 'azure', 'copilot-studio-client.ts'), 'utf-8'),
  ];
  const emitted = [...sources, ...libSources].join('\n');

  it('read a non-trivial number of route sources (a zero read would pass everything)', () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  it('every GATE_CODE appears in an emitting source', () => {
    for (const code of GATE_CODES) {
      expect(emitted.includes(`'${code}'`), `${code} is in GATE_CODES but nothing emits it`)
        .toBe(true);
    }
  });

  it('a code nothing emits would be caught (negative control)', () => {
    expect(emitted.includes("'no_such_gate_code_exists'")).toBe(false);
  });
});

describe('aoaiGateAllowed — the opt-out, read in the module', () => {
  it('is off by default', () => {
    expect(aoaiGateAllowed({} as any)).toBe(false);
  });

  it('is on only for the exact string "true"', () => {
    expect(aoaiGateAllowed({ LOOM_UAT_ALLOW_AOAI_GATE: 'true' } as any)).toBe(true);
    for (const v of ['TRUE', '1', 'yes', '']) {
      expect(aoaiGateAllowed({ LOOM_UAT_ALLOW_AOAI_GATE: v } as any), v).toBe(false);
    }
  });
});
