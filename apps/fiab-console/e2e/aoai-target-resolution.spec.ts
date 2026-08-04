/**
 * aoai-target-resolution.spec.ts — the G1 browser receipt for the AOAI
 * target-resolution path (#2557 / #2568 / #2583).
 *
 * WHY THIS EXISTS. #2568 rewrote the resolution chain
 *   aoaiChatJson → resolveAoaiTarget → listConnections() → pagedList('/connections')
 * (`lib/azure/aoai-chat-client.ts:405/461/518`, `lib/azure/copilot-orchestrator.ts:276`,
 * `lib/azure/foundry-client.ts` `pagedList`). It changed BOTH the timing (a
 * short-TTL memo over the Foundry-hub connection walk) AND — the part the
 * adversarial review caught — the failure mode an operator SEES: a paging
 * deadline used to collapse into `NoAoaiDeploymentError` ("Deploy a gpt-4o /
 * gpt-4.1-class model first"), telling the operator to deploy a model that
 * already existed. It was rebuilt in an isolated worktree with no cloud
 * credentials, so it carries no live receipt — exactly the #2583 gap. Per
 * `ux-baseline.md` G1, tsc + vitest are NOT completion evidence for a change to
 * a request-path seam; only a real browser against a live deployment is.
 *
 * WHAT THIS SPEC ASSERTS — the target-resolution path is a BACKEND seam, so the
 * receipt exercises it through the two request paths that await it plus the UI
 * Copilot surface that renders its outcome:
 *
 *   • GET  /api/copilot/status      (`app/api/copilot/status/route.ts:56`) —
 *       the read-only diagnostic the /copilot page loads. Calls
 *       resolveAoaiTarget(cfg) and reports the RESOLVED target
 *       ({ configured, endpoint, model, aoai:{ ok, endpoint, deployment,
 *       error, remediation } }).
 *   • POST /api/copilot/orchestrate (`app/api/copilot/orchestrate/route.ts:100`) —
 *       the real streaming Copilot turn. Pre-flights resolveAoaiTarget and maps
 *       NoAoaiDeploymentError → 503, anything else (incl. AoaiDiscoveryTimeoutError)
 *       → 502, then opens the real AOAI SSE turn on success.
 *   • /copilot page (`app/copilot/page.tsx`) — the "Ready" badge (`:326`) vs the
 *       honest-gate MessageBar "Orchestrator not fully ready" / "Azure OpenAI is
 *       not reachable" (`:391`/`:395`), and the Launch → "Ask anything" box
 *       (`lib/editors/cross-item-copilot-editor.tsx:758`) → "Send" (`:773`) walk.
 *
 * The receipt is real-data-or-honest-gate tolerant (`no-vaporware.md`): a live
 * AOAI turn (SSE `final`) AND a documented AOAI-not-configured gate are both
 * PASS; the only failures are the vaporware tells (a route 404, a broken Loom
 * session, an unexpected shape) and — the whole point of #2568 — a paging
 * deadline MISWORDED as a missing-deployment gate.
 *
 * THE #2568 REGRESSION, ENCODED SO IT CAN ACTUALLY FAIL. `classifyResolutionError`
 * distinguishes the two resolution error families by their stable marker phrases
 * (grounded to `lib/azure/aoai-errors.ts:44-48/66-72` and
 * `lib/azure/copilot-orchestrator.ts:307/337/349`):
 *   - a TIMEOUT says "do not deploy anything in response to it" and never
 *     "Deploy a gpt-4o …";
 *   - a MISSING deployment says "Deploy a gpt-4o / gpt-4.1-class model first".
 * Test 1 is a NON-VACUITY self-check (no backend) proving the classifier calls
 * the timeout text 'timeout' and the missing text 'missing' — so this spec CAN
 * fail if the regression returns (the failure mode the sm-tab-clickwalk /
 * Copilot-evals post-mortems taught: a gate that only runs against a fixed
 * estate can't tell "bug gone" from "measures nothing"). Tests 2 and 3 then
 * apply that same wording rule to WHATEVER the live estate surfaces, and Test 4
 * arms the deterministic #2583-item-2 deadline case when the operator has set
 * the tiny server budget.
 *
 * WHAT IT DOES NOT ASSERT — stated plainly rather than implied:
 *   • It does NOT prove, from the browser, that a warm turn skips the ARM page
 *     walk (the 5-min memo is a server-internal optimisation invisible to a
 *     black box). That mechanism is proven by the unit tests cited in #2557
 *     (`lib/azure/__tests__/paging-budget.test.ts`, `ttl-memo.test.ts`,
 *     `aoai-discovery-deadline.test.ts`). What Test 5 CAN assert is the
 *     observable consequence: repeated resolution returns an IDENTICAL target
 *     (a re-page that resolved differently, or a flapping resolution, fails
 *     here), and it records the per-call latency profile as evidence — but it
 *     does NOT hard-assert a latency threshold, because Front Door + cold-start
 *     make absolute timing flaky.
 *   • Test 4 (the #2583-item-2 deadline path) needs the SERVER env
 *     `LOOM_FOUNDRY_CONNECTIONS_BUDGET_MS` set tiny AND resolution falling to
 *     Foundry discovery — an estate config this spec cannot make. It is armed
 *     by the operator via `LOOM_E2E_EXPECT_DISCOVERY_TIMEOUT=1`; unset, it
 *     skips with that reason rather than pretending.
 *
 * Auth: minted session (SESSION_SECRET) via the `mint` dependency + storageState,
 * same as `sm-tab-clickwalk`. No workspaces created; nothing to clean up.
 *
 * Project: `aoai-target-resolution` (playwright.config.ts). NOT a required check.
 * Run: SESSION_SECRET=<kv> LOOM_URL=<url> \
 *        pnpm exec playwright test --project=aoai-target-resolution
 * CI:  gh workflow run loom-ui-verify.yml --ref main \
 *        -f extra_projects="aoai-target-resolution"
 */
import { test, expect, type Response as PwResponse } from '@playwright/test';
import { BASE, signIn, captureFailures, recordVerdict } from './_lib/uat';

/* ----------------------------------------------------------- error wordings */

/**
 * The two resolution error families, keyed on the STABLE marker phrases the
 * source hard-codes. Order matters: TIMEOUT is checked first, because the whole
 * #2568 defect is a timeout being surfaced with the MISSING wording — so a
 * regression produces text that matches the missing marker and NOT the timeout
 * one, which classifies 'missing' and Test 4 (armed) flags it.
 *
 * Grounding:
 *   TIMEOUT  → `lib/azure/aoai-errors.ts:46` ("do not deploy anything in
 *              response to it") and `:69` ("does NOT mean no model is deployed
 *              — do not deploy anything"). Both timeout builders
 *              (aoaiDiscoveryTimeout / aoaiDiscoveryIncomplete) carry
 *              "do not deploy anything", so it is the family-wide marker.
 *   MISSING  → `lib/azure/copilot-orchestrator.ts:337`/`:349` ("Deploy a gpt-4o
 *              / gpt-4.1-class model first") and `:307` ("no Copilot chat-model
 *              deployment is chosen … deploy a gpt-4o / gpt-4.1 class model
 *              first"). `/deploy a gpt-4o/i` matches both hyphenations.
 */
const TIMEOUT_MARKER = /do not deploy anything/i;
const MISSING_MARKER = /deploy a gpt-4o|no Copilot chat-model deployment is chosen/i;

type ResolutionErrorKind = 'timeout' | 'missing' | 'other';

/** Classify a surfaced resolution-error string into its family. */
function classifyResolutionError(text: string): ResolutionErrorKind {
  if (TIMEOUT_MARKER.test(text)) return 'timeout';
  if (MISSING_MARKER.test(text)) return 'missing';
  return 'other';
}

/* --------------------------------------------------------------- SSE reader */

/** Content-type of an SSE turn (orchestrate/route.ts:157). Typed against the
 *  network `Response` (what `waitForResponse` yields), not `APIResponse`. */
function isEventStream(res: PwResponse): boolean {
  return (res.headers()['content-type'] || '').includes('text/event-stream');
}

/**
 * A minimal read of what an orchestrate SSE turn produced. `APIResponse.text()`
 * buffers the whole body once the stream closes — the orchestrate route always
 * closes it (`finally → send('done') → controller.close()`), so this returns.
 */
interface SseOutcome {
  sawSession: boolean;   // `event: session` — always first (orchestrate/route.ts:136)
  sawFinal: boolean;     // a `"kind":"final"` step — the model actually answered
  sawError: boolean;     // a `"kind":"error"` step — the turn started then failed
  steps: number;         // count of `event: step` frames
  head: string;          // first 300 chars, for the receipt
}
async function readSse(res: PwResponse): Promise<SseOutcome> {
  const body = await res.text();
  return {
    sawSession: /event:\s*session/.test(body),
    sawFinal: /"kind"\s*:\s*"final"/.test(body),
    sawError: /"kind"\s*:\s*"error"/.test(body),
    steps: (body.match(/event:\s*step/g) || []).length,
    head: body.replace(/\s+/g, ' ').slice(0, 300),
  };
}

/**
 * The outcome of a target-resolution attempt on a request path, normalised
 * across the status diagnostic and the orchestrate turn so both surfaces are
 * held to the same rule.
 */
type ResolutionOutcome =
  | { verdict: 'resolved'; endpoint?: string; deployment?: string; detail: string }
  | { verdict: 'gate'; kind: ResolutionErrorKind; error: string; detail: string }
  | { verdict: 'fail'; detail: string };

/* ------------------------------------------------------------------- suite */

test.describe('AOAI target-resolution G1 receipt (#2557 / #2568 / #2583)', () => {
  /** Resolved target observed by Test 2, cross-checked by Test 3. */
  let statusConfigured: boolean | null = null;

  // --------------------------------------------------------------------------
  // TEST 1 — NON-VACUITY SELF-CHECK (no estate, no backend, no data).
  //
  // Proves the spec can FAIL on the #2568 regression: the classifier must call
  // the timeout wording 'timeout' and the missing wording 'missing', and the
  // two must be genuinely different. Without this, Tests 2-4 could pass
  // vacuously against a fixed estate — the exact failure class the sm-tab-
  // clickwalk detector self-check and the hollow-Copilot-evals post-mortem
  // exist to prevent. The fixtures reproduce the source strings verbatim
  // (grounded to file:line); if a source wording drifts, these are the
  // canonical copy a reviewer updates alongside it.
  // --------------------------------------------------------------------------
  test('self-check — the timeout and missing wordings are distinct and correctly classified', () => {
    // `lib/azure/aoai-errors.ts:43-48` — aoaiDiscoveryTimeout().
    const timeoutText =
      "Timed out listing the Foundry hub's connections while resolving the Copilot model (deadline). " +
      'This is a TIMEOUT talking to Azure Resource Manager, NOT a missing deployment — do not deploy ' +
      'anything in response to it. Retry; if it persists, check ARM / private-endpoint reachability ' +
      'from the Console, or raise LOOM_FOUNDRY_CONNECTIONS_BUDGET_MS.';
    // `lib/azure/aoai-errors.ts:66-72` — aoaiDiscoveryIncomplete('time').
    const incompleteText =
      "Could not resolve the Copilot model: the Foundry hub's connection list was cut short by its " +
      'time ceiling, and no Azure OpenAI connection appeared in the part that was read. ' +
      'Because the list is INCOMPLETE this does NOT mean no model is deployed — do not deploy ' +
      'anything in response to it. Retry; if it persists, raise LOOM_FOUNDRY_CONNECTIONS_BUDGET_MS.';
    // `lib/azure/copilot-orchestrator.ts:337/349` — the honest missing gate.
    const missingText =
      'No AOAI deployment on Foundry hub. Deploy a gpt-4o / gpt-4.1-class model first. ' +
      'For Commercial, the expected endpoint suffix is openai.azure.com.';
    // `lib/azure/copilot-orchestrator.ts:306-310` — the tenant-settings variant.
    const missingTenantText =
      'A Foundry account is selected in admin tenant-settings but no Copilot chat-model deployment is ' +
      'chosen. Pick one under Admin → Tenant settings → Copilot & Agents (deploy a gpt-4o / gpt-4.1 ' +
      'class model first).';

    // The classifier calls each family correctly.
    expect(classifyResolutionError(timeoutText), 'aoaiDiscoveryTimeout must classify timeout').toBe('timeout');
    expect(classifyResolutionError(incompleteText), 'aoaiDiscoveryIncomplete must classify timeout').toBe('timeout');
    expect(classifyResolutionError(missingText), 'the deploy-a-model gate must classify missing').toBe('missing');
    expect(classifyResolutionError(missingTenantText), 'the tenant-settings gate must classify missing').toBe('missing');

    // NON-VACUITY: the two families are genuinely different text — a timeout
    // never carries the "Deploy a gpt-4o" instruction, and a missing gate never
    // carries the "do not deploy anything" instruction. This is the exact #2568
    // swap: if a timeout is ever surfaced with the missing wording again, its
    // text would match MISSING_MARKER and classify 'missing', failing Test 4.
    expect(MISSING_MARKER.test(timeoutText), 'a timeout must NOT tell the operator to deploy a model').toBeFalsy();
    expect(MISSING_MARKER.test(incompleteText), 'an incomplete-list timeout must NOT tell the operator to deploy').toBeFalsy();
    expect(TIMEOUT_MARKER.test(missingText), 'a real missing gate must NOT carry the timeout disclaimer').toBeFalsy();

    recordVerdict({
      surface: 'lib:aoai-errors', feature: 'resolution-error-classification', verdict: 'A', status: 'pass',
      notes: 'self-check: timeout vs missing wordings distinct and classified (the #2568 regression guard)',
    });
  });

  // --------------------------------------------------------------------------
  // TEST 2 — the status diagnostic resolves a REAL target OR the honest gate.
  //
  // GET /api/copilot/status calls resolveAoaiTarget(cfg) and reports the
  // resolved endpoint+deployment or the gate. This is the read-only real-data
  // receipt: a resolved target (happy path, #2583 item 1) or a documented gate,
  // and — either way — the gate wording obeys the #2568 rule.
  // --------------------------------------------------------------------------
  test('status — resolveAoaiTarget surfaces a real target or an honestly-worded gate', async ({ page, context }, testInfo) => {
    await signIn(context).catch(() => { /* storageState already set */ });

    const res = await page.request.get(`${BASE}/api/copilot/status`);
    expect(res.status(), 'status route must exist and answer (a 404 is the vaporware tell)').not.toBe(404);
    expect(res.ok(), `GET /api/copilot/status returned ${res.status()}`).toBeTruthy();
    const j = await res.json();
    // A broken Loom session 401s identically on every route — a real failure.
    expect(j?.error, 'Loom session must be authenticated').not.toBe('unauthenticated');
    expect(j?.ok, 'status envelope ok:true').toBeTruthy();
    expect(typeof j?.configured, 'status reports a boolean `configured`').toBe('boolean');

    let outcome: ResolutionOutcome;
    if (j.configured === true) {
      // Happy path: the resolver returned a real target. Both the top-level
      // task-contract fields and the nested aoai block must agree.
      expect(j.aoai?.ok, 'configured=true implies aoai.ok=true').toBeTruthy();
      expect(typeof j.endpoint === 'string' && j.endpoint.length > 0, 'a real resolved endpoint').toBeTruthy();
      expect(typeof j.model === 'string' && j.model.length > 0, 'a real resolved deployment/model').toBeTruthy();
      outcome = { verdict: 'resolved', endpoint: j.endpoint, deployment: j.model, detail: `${j.endpoint} :: ${j.model}` };
    } else {
      // Honest gate. The error must be a real string, and its WORDING must obey
      // the #2568 rule for whichever family it is.
      const err = String(j.aoai?.error || '');
      expect(err.length, 'a false `configured` must carry a real aoai.error string').toBeGreaterThan(0);
      const kind = classifyResolutionError(err);
      if (kind === 'missing') {
        // A real missing-deployment gate must also carry the actionable
        // remediation the pane renders (status/route.ts:70-74).
        expect(String(j.aoai?.remediation || ''), 'a missing-deployment gate names the remediation')
          .toMatch(/Admin|Tenant settings|Copilot & Agents|LOOM_AOAI_ENDPOINT/i);
      } else if (kind === 'timeout') {
        // The estate surfaced an ARM discovery timeout on its own — the #2568
        // path, live. It must NOT be misworded as a missing deployment.
        expect(err, 'a discovery timeout must not carry the deploy-a-model wording').not.toMatch(MISSING_MARKER);
      }
      // kind === 'other' is tolerated (e.g. a sovereign-endpoint mismatch gate,
      // orchestrator.ts:236) — still a real, worded gate, not vaporware.
      outcome = { verdict: 'gate', kind, error: err.slice(0, 300), detail: `gate:${kind}` };
    }

    statusConfigured = j.configured === true;
    testInfo.annotations.push({ type: 'status', description: `configured=${j.configured} ${outcome.detail} tools=${j?.tools?.count ?? 0}` });
    recordVerdict({
      surface: 'api:/api/copilot/status', feature: 'aoai-target-resolution', verdict: 'A', status: 'pass',
      notes: outcome.detail,
    });
  });

  // --------------------------------------------------------------------------
  // TEST 3 — the /copilot UI reflects resolution, and a real turn resolves the
  // target end-to-end (SSE) OR surfaces the honest gate.
  //
  // Drives the actual browser surface: the landing badge/gate, then Launch →
  // "Ask anything" → Send, capturing the real orchestrate response. The turn
  // pre-flights resolveAoaiTarget (orchestrate/route.ts:100), so a 200 SSE is
  // itself proof the target resolved on a request path; an SSE `final` is the
  // full happy path (#2583 item 1). A 503/502 gate is real-data-or-gate PASS,
  // held to the #2568 wording rule.
  // --------------------------------------------------------------------------
  test('copilot UI — the surface reflects resolution and a real turn resolves the target or gates honestly', async ({ page, context }, testInfo) => {
    // A real AOAI turn behind Front Door on a shared console is variable; give
    // it room so a slow-but-successful turn is not a false fail. Raised
    // 180s→240s to also cover the slow COLD-LOAD landing render measured below
    // (the /copilot page can take ~30s to commit its first data render on a cold
    // Front Door replica) plus the orchestrate turn, without a false timeout.
    test.setTimeout(240_000);
    await signIn(context).catch(() => { /* storageState already set */ });

    // The callback RETURNS the outcome (read back off `.result`) rather than
    // assigning an outer `let` — an assignment inside the closure would leave TS
    // narrowing the outer variable to its 'fail' seed. On any thrown expect the
    // callback propagates and the test fails, so there is no 'fail' return path.
    const { result: outcome, consoleErrors } = await captureFailures(page, async (): Promise<ResolutionOutcome> => {
      await page.goto(`${BASE}/copilot`, { waitUntil: 'domcontentloaded' });

      // (a) THE LANDING SURFACE reflects the resolution outcome — no blank box.
      // Either the "Ready" chip (page.tsx:326) OR the honest-gate MessageBar
      // "Orchestrator not fully ready" (page.tsx:391) must appear once status
      // settles. Both are gated on the client `/api/copilot/status` fetch: while
      // it is in flight the chip reads "Checking orchestrator…" (page.tsx:323),
      // and ONLY once `statusLoading` clears does one of the two states render.
      //
      // DIAGNOSTIC FIRST: confirm the data path actually answered. The page fires
      // the status fetch from a mount effect a few seconds after DOMContentLoaded,
      // so register the wait AFTER goto (the response cannot precede it). A route
      // that never answers is the real vaporware/backend tell — surface it as a
      // clear annotation instead of a vague "blank box" (the failure that a prior
      // reviewer misread as an orchestrate-turn failure when it was really this
      // landing check timing out).
      const statusResp = await page
        .waitForResponse((r) => r.url().includes('/api/copilot/status'), { timeout: 60_000 })
        .catch(() => null);
      testInfo.annotations.push({
        type: 'landing-status',
        description: statusResp ? `status ${statusResp.status()} answered` : 'status route did not answer within 60s',
      });

      // Then wait for the rendered state. TIMEOUT GROUNDED IN THE LIVE COLD-LOAD
      // PROFILE (loom-ui-verify trace 30875024127): the status network resolves
      // in <0.5s, but on a cold Front Door replica the client render that clears
      // `statusLoading` and paints the "Ready" chip commits ~30s after
      // navigation (both fetch results — status AND sessions — land together, a
      // main-thread/hydration lag, not an AOAI failure). A 30s inner budget
      // therefore false-failed a page that DOES render "Ready"; 90s gives margin
      // while still failing a genuinely blank page (bounded by the 240s test
      // budget above). The status/turn assertions this spec exists to make are
      // NOT held hostage to the cold-hydration budget.
      const readyChip = page.getByText(/^Ready$/).first();
      const gateBar = page.getByText(/Orchestrator not fully ready|Azure OpenAI is not reachable/i).first();
      const surfaced = await Promise.race([
        readyChip.waitFor({ state: 'visible', timeout: 90_000 }).then(() => 'ready').catch(() => ''),
        gateBar.waitFor({ state: 'visible', timeout: 90_000 }).then(() => 'gate').catch(() => ''),
      ]);
      await page.screenshot({ path: testInfo.outputPath('copilot-landing.png') }).catch(() => {});
      expect(
        surfaced,
        'the /copilot landing must render EITHER the Ready badge OR the honest AOAI gate (never a blank box)',
      ).not.toBe('');

      // (b) THE REAL TURN. Launch the console (page.tsx:348) and Send a prompt,
      // capturing the orchestrate response. The console textarea placeholder is
      // "Ask anything …" and the submit is aria-label "Send"
      // (cross-item-copilot-editor.tsx:758/773).
      await page.getByRole('button', { name: /Launch Copilot/i }).click();
      const box = page.getByPlaceholder(/Ask anything/i);
      await expect(box, 'the console prompt box mounts').toBeVisible({ timeout: 20_000 });
      await box.fill('List my workspaces.');
      const [resp] = await Promise.all([
        page.waitForResponse('**/api/copilot/orchestrate', { timeout: 60_000 }),
        page.getByRole('button', { name: /^Send$/i }).click(),
      ]);
      await page.screenshot({ path: testInfo.outputPath('copilot-turn.png') }).catch(() => {});

      const status = resp.status();
      if (status === 200 && isEventStream(resp)) {
        // Preflight resolveAoaiTarget passed → the SSE opened → the target
        // resolved on a request path. Read the stream to confirm it progressed.
        const sse = await readSse(resp);
        expect(sse.sawSession, 'the SSE turn emitted its session event').toBeTruthy();
        return {
          verdict: 'resolved',
          detail: `SSE final=${sse.sawFinal} error=${sse.sawError} steps=${sse.steps} :: ${sse.head}`,
        };
      }
      // A gate. 503 = NoAoaiDeploymentError (orchestrate/route.ts:103);
      // 502 = any other resolution failure incl. AoaiDiscoveryTimeoutError
      // (:105). Read the JSON body and hold it to the #2568 wording rule.
      const body = await resp.json().catch(() => ({} as Record<string, unknown>));
      const err = String((body as { error?: unknown })?.error ?? '');
      expect(err, 'Loom session must be authenticated').not.toBe('unauthenticated');
      expect([502, 503], `an AOAI-gate turn is 502/503, got ${status}`).toContain(status);
      expect(err.length, 'a gated turn carries a real error string').toBeGreaterThan(0);
      const kind = classifyResolutionError(err);
      if (status === 502) {
        // The route maps AoaiDiscoveryTimeoutError here — it must be the
        // timeout wording, never the deploy-a-model one (#2568).
        expect(err, 'a 502 resolution failure must not be misworded as a missing deployment').not.toMatch(MISSING_MARKER);
      }
      return { verdict: 'gate', kind, error: err.slice(0, 300), detail: `orchestrate ${status} gate:${kind}` };
    }, { label: 'copilot-orchestrate' });

    // Cross-check: the UI turn's verdict must AGREE with the status diagnostic.
    // Both call resolveAoaiTarget; they cannot disagree about whether AOAI is
    // configured on the same estate (a disagreement is the exact bug the status
    // route's own comment records — bare resolveAoaiTarget() vs cfg-passing).
    if (statusConfigured !== null) {
      const uiResolved = outcome.verdict === 'resolved';
      expect(
        uiResolved,
        `status reported configured=${statusConfigured} but the orchestrate turn ${uiResolved ? 'resolved' : 'gated'} — ` +
          'the two surfaces call the same resolveAoaiTarget and must agree',
      ).toBe(statusConfigured);
    }

    testInfo.annotations.push({ type: 'orchestrate', description: outcome.detail });
    if (consoleErrors.length) testInfo.attach('console', { body: consoleErrors.join('\n'), contentType: 'text/plain' });
    recordVerdict({
      surface: 'ui:/copilot', feature: 'aoai-target-resolution-turn',
      verdict: outcome.verdict === 'resolved' ? 'A' : 'B', status: 'pass', notes: outcome.detail,
    });
  });

  // --------------------------------------------------------------------------
  // TEST 4 — the #2583-item-2 DEADLINE path (armed by the operator).
  //
  // The exact #2568 regression: with the server's LOOM_FOUNDRY_CONNECTIONS_BUDGET_MS
  // tiny and resolution falling to Foundry discovery, the surfaced error MUST be
  // the AoaiDiscoveryTimeoutError wording and MUST NOT be "Deploy a gpt-4o …".
  // Triggering it needs a SERVER env this spec cannot set, so it is armed by
  // LOOM_E2E_EXPECT_DISCOVERY_TIMEOUT=1; unset, it skips with that reason rather
  // than pretending. When armed and the estate instead resolves happily, that is
  // ALSO a fail — the operator asked for the deadline case and it did not occur,
  // so the assertion is not silently vacuous.
  // --------------------------------------------------------------------------
  test('deadline path — a paging timeout surfaces AS a timeout, never as "deploy a model" (#2583 item 2)', async ({ page, context }, testInfo) => {
    test.skip(
      !process.env.LOOM_E2E_EXPECT_DISCOVERY_TIMEOUT,
      'requires the SERVER env LOOM_FOUNDRY_CONNECTIONS_BUDGET_MS set tiny (e.g. 50) AND resolution falling to ' +
        'Foundry discovery (tenant cfg with no endpoint + LOOM_AOAI_ENDPOINT unset) — an estate config this spec ' +
        'cannot make. Set LOOM_E2E_EXPECT_DISCOVERY_TIMEOUT=1 once configured to arm this deterministic assertion.',
    );
    await signIn(context).catch(() => { /* storageState already set */ });

    // Surface the error via the status diagnostic (a GET — no chat cost).
    const res = await page.request.get(`${BASE}/api/copilot/status`);
    const j = await res.json().catch(() => ({} as any));
    const err = String(j?.aoai?.error || '');
    const kind = classifyResolutionError(err);
    testInfo.annotations.push({ type: 'deadline', description: `configured=${j?.configured} kind=${kind} err=${err.slice(0, 200)}` });

    expect(
      j?.configured,
      'the estate is configured to time out ARM paging, so resolution must NOT report configured=true',
    ).not.toBe(true);
    expect(
      kind,
      `with the tiny paging budget the surfaced error must be the discovery-TIMEOUT wording, got '${kind}': ${err.slice(0, 300)}`,
    ).toBe('timeout');
    // The precise #2568 regression assertion.
    expect(err, 'a paging deadline must NEVER tell the operator to "Deploy a gpt-4o …"').not.toMatch(MISSING_MARKER);

    recordVerdict({
      surface: 'api:/api/copilot/status', feature: 'aoai-discovery-deadline-wording', verdict: 'A', status: 'pass',
      notes: `deadline surfaced as timeout (not missing): ${err.slice(0, 200)}`,
    });
  });

  // --------------------------------------------------------------------------
  // TEST 5 — resolution STABILITY (the observable half of the 5-min memo).
  //
  // #2583 item 1 asks that a warm turn not re-page ARM. That is a server-
  // internal optimisation a black box cannot see; it is proven by the #2557
  // unit tests. What the browser CAN prove is the consequence: repeated
  // resolution returns an IDENTICAL target. A flapping resolution, or a re-page
  // that resolved a different endpoint/deployment, fails here. Latency is
  // recorded as evidence but NOT hard-asserted (Front Door + cold-start make
  // absolute timing flaky).
  // --------------------------------------------------------------------------
  test('resolution is stable across repeated reads (observable memo consequence)', async ({ page, context }, testInfo) => {
    await signIn(context).catch(() => { /* storageState already set */ });

    const reads: Array<{ configured: boolean; target: string; ms: number }> = [];
    for (let i = 0; i < 3; i += 1) {
      const t0 = Date.now();
      const res = await page.request.get(`${BASE}/api/copilot/status`);
      const ms = Date.now() - t0;
      expect(res.ok(), `read #${i + 1} of /api/copilot/status returned ${res.status()}`).toBeTruthy();
      const j = await res.json();
      reads.push({
        configured: j?.configured === true,
        target: j?.configured === true ? `${j.endpoint} :: ${j.model}` : `gate:${classifyResolutionError(String(j?.aoai?.error || ''))}`,
        ms,
      });
    }

    testInfo.annotations.push({
      type: 'stability',
      description: reads.map((r, i) => `#${i + 1} ${r.ms}ms ${r.target}`).join(' | '),
    });

    // Every read must agree on configured-ness and on the resolved target.
    const first = reads[0];
    for (let i = 1; i < reads.length; i += 1) {
      expect(reads[i].configured, `read #${i + 1} configured must match read #1`).toBe(first.configured);
      expect(
        reads[i].target,
        `read #${i + 1} resolved "${reads[i].target}" but read #1 resolved "${first.target}" — resolution is not stable`,
      ).toBe(first.target);
    }

    recordVerdict({
      surface: 'api:/api/copilot/status', feature: 'aoai-resolution-stability', verdict: 'A', status: 'pass',
      notes: `stable across 3 reads: ${first.target} (latency ${reads.map((r) => `${r.ms}ms`).join('/')})`,
    });
  });
});
