/**
 * How a Copilot persona's primary-action response is scored.
 *
 * Lives here, apart from `copilot.uat.ts`, for one reason: `e2e/**` is excluded
 * from vitest collection and the spec file cannot be imported outside the
 * Playwright runner (its top level calls `test.describe`). Pulling the pure
 * decision into a module with NO Playwright import makes it unit-testable, and
 * this decision is exactly the kind that needs a test — for two rounds it was
 * the thing standing between a dead copilot and a green suite.
 *
 * See `copilot.uat.ts` for what each verdict means to the suite.
 */

export interface Probe {
  status: number;
  ct: string;
  text: string;
}

export type Verdict = 'real' | 'gate' | 'fail';

/**
 * Gate codes that make a refusal DOCUMENTED, per no-vaporware.md — the response
 * names why, so it is a gate rather than a fault.
 */
export const GATE_CODES = ['no_aoai', 'disabled', 'admin_only', 'copilot_studio_not_enabled'];

/**
 * Gate codes recording a DELIBERATE operator or tenant CHOICE rather than an
 * absent backing service. `requireReal` must not call these a broken
 * deployment: `disabled` is a tenant admin org-wide toggle
 * (app/api/copilot/complete/route.ts), `admin_only` is a role check, and
 * `copilot_studio_not_enabled` is a Power Platform opt-in. Asserting "this is
 * broken" over a switch someone chose to turn off is the same R7 error in the
 * opposite direction.
 */
export const DELIBERATE_GATE_CODES = ['disabled', 'admin_only', 'copilot_studio_not_enabled'];

export function gateCodeOf(p: Probe): string {
  try {
    return String(JSON.parse(p.text)?.code || '');
  } catch {
    return '';
  }
}

export function classify(p: Probe): { verdict: Verdict; reason: string } {
  if (p.status === 404) return { verdict: 'fail', reason: 'route 404 (missing)' };
  if (p.ct.includes('text/event-stream')) {
    return { verdict: 'real', reason: 'live SSE stream' };
  }
  let j: any = null;
  try { j = JSON.parse(p.text); } catch { /* non-JSON */ }
  if (j && j.ok === true) return { verdict: 'real', reason: 'HTTP 200 ok:true — real backend answered' };
  // A broken Loom session would 401 with this exact body across EVERY persona —
  // that is a real failure, not an honest gate.
  if (j && j.error === 'unauthenticated') return { verdict: 'fail', reason: 'Loom session not authenticated' };
  if (j && j.ok === false) {
    const code = String(j.code || '');
    if (GATE_CODES.includes(code)) return { verdict: 'gate', reason: `honest gate code:'${code}'` };
    // Dataverse/BAP/schema backend not wired in this deployment → honest infra
    // gate: the route reached a real backend and that backend refused it.
    if ([401, 403, 424].includes(p.status)) {
      return { verdict: 'gate', reason: `honest infra gate HTTP ${p.status}` };
    }
    // A codeless 5xx is NOT a gate. An honest gate is DOCUMENTED — per
    // no-vaporware.md it names the exact env var / role / resource, which is
    // what `code` carries and what GATE_CODES above matches. A 5xx with no code
    // is the server failing, and calling it a gate asserts a cause the response
    // never established (deploy-integrity.md R7).
    //
    // WHY THIS RULE IS NEW, and not the thing that missed #4432. The #4432-era
    // 500 was a bare Next.js error whose body was NOT JSON (see the header
    // comment on app/api/copilot/orchestrate/route.ts). `JSON.parse` therefore
    // threw, `j` stayed null, every `if (j && …)` above was skipped, and the
    // walk fell through to the terminal `verdict: 'fail'`. The OLD classifier
    // would have gone RED on #4432.
    //
    // The blindness arrived WITH the fix: the new wrapper guarantees a
    // parseable `{ok:false, code:'orchestrate_failed'}` — a JSON body at HTTP
    // 500 whose code is not in GATE_CODES — which the old tolerated-status list
    // then scored as an honest gate. Making the response well-formed is right;
    // it just moved a 500 from "unparseable, so fail" into "parseable, so
    // tolerated". This rule closes that window.
    if ([500, 502, 503].includes(p.status)) {
      return {
        verdict: 'fail',
        reason: `HTTP ${p.status} with no gate code — server error, not a gate: ${p.text.slice(0, 120)}`,
      };
    }
  }
  return { verdict: 'fail', reason: `unexpected HTTP ${p.status}: ${p.text.slice(0, 160)}` };
}

/**
 * Whether an otherwise-acceptable response must still fail because the persona
 * runs on a backend Loom itself deploys.
 *
 * Loom provisions its own Foundry/AOAI account in every boundary, so "AOAI is
 * not wired" is not a shape Loom ships — it is a broken one, and tolerating it
 * is the lenient reading auto-bind-by-default.md §5 forbids. A gate recording a
 * deliberate choice is exempt.
 */
export function gateIsFailure(
  p: Probe,
  verdict: Verdict,
  opts: { requireReal?: boolean; allowAoaiGate?: boolean } = {},
): boolean {
  if (!opts.requireReal) return false;
  if (opts.allowAoaiGate) return false;
  if (verdict !== 'gate') return false;
  return !DELIBERATE_GATE_CODES.includes(gateCodeOf(p));
}

/**
 * Personas whose backend LOOM ITSELF DEPLOYS, as DATA rather than a flag each
 * call site passes.
 *
 * It was `{ requireReal: true }` at six call sites, and a re-review showed that
 * deleting one of them silently removed the rule for that persona with every
 * test still green — a call-site annotation is unreachable from a unit test.
 * As a set in the module it is covered: the test below asserts every member
 * fails on a gate, so dropping a persona changes data under test.
 */
export const AOAI_BACKED_PERSONAS: ReadonlySet<string> = new Set([
  'persona:notebook-in-cell-copilot',
  'persona:warehouse-copilot',
  'persona:azure-sql-copilot',
  'persona:cross-item-copilot',
  'persona:help-copilot',
  'persona:notebook-inline-complete',
]);

/**
 * The opt-out, read HERE and not at the call site.
 *
 * It used to be inverted into `allowAoaiGate: !REQUIRE_REAL_AOAI` by the
 * caller. A re-review mutated that `!` away and the suite stayed green,
 * because the inversion lived in glue no unit test could reach. Reading the
 * env in the module puts it under test.
 */
export function aoaiGateAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LOOM_UAT_ALLOW_AOAI_GATE === 'true';
}

export interface PersonaScore {
  verdict: Verdict;
  /** True when the persona must be reported as a failure. */
  bad: boolean;
  /** The gate was well-formed but this persona is not allowed to gate. */
  mustAnswer: boolean;
  reason: string;
  notes: string;
  message: string;
  /** Letter grade for the verdict log. */
  grade: 'A' | 'F';
  /** Status for the verdict log. */
  status: 'pass' | 'fail';
  /**
   * The value the caller asserts on. Carried here so the `bad -> 'fail'`
   * mapping is a module field a unit test can pin, rather than an expression
   * inside the one line that needs the Playwright runner.
   */
  actual: 'fail' | Verdict;
}

/**
 * The WHOLE scoring decision for one persona — classification, the
 * must-answer rule, and the reported strings.
 *
 * Why this exists rather than living in `assertPrimaryAction`: the first
 * extraction stopped one function short, and a re-review proved the cost by
 * mutation. Deleting `|| mustAnswer` from the caller — which removes the
 * must-answer rule outright, the headline behaviour of the change that
 * introduced it — left all 20 tests GREEN, because everything under test sat
 * one layer below the glue. A rule is only covered where it is COMBINED, so
 * the combination is here and `assertPrimaryAction` is left with nothing but
 * `recordVerdict` + `expect`.
 */
export function scorePersona(
  surface: string,
  feature: string,
  p: Probe,
  opts: { env?: NodeJS.ProcessEnv } = {},
): PersonaScore {
  const { verdict, reason } = classify(p);
  const mustAnswer = gateIsFailure(p, verdict, {
    // Derived from DATA and the environment, not from a caller-supplied flag.
    requireReal: AOAI_BACKED_PERSONAS.has(surface),
    allowAoaiGate: aoaiGateAllowed(opts.env),
  });
  const bad = verdict === 'fail' || mustAnswer;
  return {
    verdict,
    bad,
    mustAnswer,
    reason,
    grade: bad ? 'F' : 'A',
    status: bad ? 'fail' : 'pass',
    actual: bad ? 'fail' : verdict,
    notes: `${reason} (HTTP ${p.status})${mustAnswer ? ' — AOAI-backed persona must answer, not gate' : ''}`,
    message: mustAnswer
      ? `${surface}:${feature} — AOAI-backed persona returned ${reason}. Loom deploys its own `
        + 'Foundry/AOAI account, so this is a broken deployment, not an honest gate.'
      : `${surface}:${feature} — ${reason}`,
  };
}
