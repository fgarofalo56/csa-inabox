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
import {
  classify,
  gateIsFailure,
  scorePersona,
  GATE_CODES,
  DELIBERATE_GATE_CODES,
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
    const s = scorePersona('persona:x', 'act', noAoai, { requireReal: true });
    expect(s.verdict).toBe('gate');
    expect(s.mustAnswer).toBe(true);
    expect(s.bad).toBe(true);
    expect(s.message).toContain('broken deployment');
    expect(s.notes).toContain('must answer, not gate');
  });

  it('the same gate on a NON-requireReal persona is not bad', () => {
    const s = scorePersona('persona:x', 'act', noAoai, {});
    expect(s.bad).toBe(false);
    expect(s.mustAnswer).toBe(false);
    expect(s.message).not.toContain('broken deployment');
  });

  it('the opt-out downgrades it (the `!REQUIRE_REAL_AOAI` arm)', () => {
    const s = scorePersona('persona:x', 'act', noAoai, {
      requireReal: true, allowAoaiGate: true,
    });
    expect(s.bad).toBe(false);
    expect(s.mustAnswer).toBe(false);
  });

  it('a plain fail is bad regardless of requireReal (the `verdict === fail` arm)', () => {
    const s = scorePersona('persona:x', 'act', json(500, { ok: false, code: 'orchestrate_failed' }), {});
    expect(s.verdict).toBe('fail');
    expect(s.mustAnswer).toBe(false);
    expect(s.bad).toBe(true);
  });

  it('a real answer is never bad', () => {
    const s = scorePersona('persona:x', 'act', json(200, { ok: true }), { requireReal: true });
    expect(s.verdict).toBe('real');
    expect(s.bad).toBe(false);
  });

  it('a deliberate tenant toggle is not bad even on an AOAI persona', () => {
    const s = scorePersona('persona:x', 'act', json(403, { ok: false, code: 'disabled' }), {
      requireReal: true,
    });
    expect(s.verdict).toBe('gate');
    expect(s.bad).toBe(false);
  });
});
