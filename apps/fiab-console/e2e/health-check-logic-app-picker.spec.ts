/**
 * health-check-logic-app-picker.spec.ts — the G1 CLICK-WALK producer for #3541.
 *
 * WHY THIS EXISTS
 * ---------------
 * #3541 has two acceptance criteria. The CODE half landed in PR #4314:
 * `lib/editors/palantir/health-check-editor.tsx:808` is an
 * `<AzureBackedField kind="logic-app">` and no longer the raw
 * `<Input placeholder="/subscriptions/…/Microsoft.Logic/workflows/notify">` the
 * issue names. That half is guarded by the `no-freeform` ratchet in CI.
 *
 * The SECOND criterion has kept the issue open since 2026-09-07:
 *
 *   > Live browser E2E: open the notification config, confirm the picker lists
 *   > real Logic Apps, complete a wiring.
 *
 * Nothing in this repo could produce it. `scripts/csa-loom/e2e-receipt.mjs` —
 * the `target_route` receipt producer in `loom-ui-verify.yml` — is a
 * `page.goto` + `waitForSelector` + screenshot + trace. It has NO click. And the
 * picker is not even mounted on a fresh load: `logicApps` starts `[]`
 * (health-check-editor.tsx:642), so the row containing the picker exists only
 * AFTER a real click on "Add Logic App" (`:820`). A route-load receipt therefore
 * cannot witness the picker enumerating anything, which is exactly the
 * distinction the issue's own verification comment asks for — "a picker that
 * renders correctly and lists NOTHING is the dead-end-bind shape
 * auto-bind-by-default.md forbids, and source cannot distinguish that from a
 * working picker".
 *
 * This spec is that producer. It drives real `locator.click()`s against the live
 * console with the suite's minted session.
 *
 * ── HOW THE LOCATORS WERE VERIFIED (not "they look right") ──────────────────
 * The first version of this file scoped every lookup through
 * `page.getByRole('group')`. NOTHING in the ancestor chain carries that role:
 * `@fluentui/react-field@9.5.1`'s `useFieldBase.js:12-18` builds its root with
 * `getIntrinsicElementProps('div', …)` and never sets one. That locator matched
 * ZERO elements on every estate, so the spec could only ever take the
 * discovery-failed branch and then fail on a row-scoped lookup — a fixture that
 * could not PASS (`assertion-design.md`, the fourth row of its table), and a
 * false RED against correct product code.
 *
 * The locators live in `./fixtures/logic-app-picker/locators.ts` and are PROVEN
 * by `./fixtures/logic-app-picker/locator-proof.spec.ts`, which imports the
 * SAME module — so the proof measures these locators, not a copy of them. (An
 * earlier revision transcribed them into a standalone probe, which meant
 * dropping `{ exact: true }` here left every proof row green. It also could not
 * run at all: it imported the bare `playwright` package, which this app does
 * not depend on.) Run the proof with:
 *
 *   pnpm exec playwright test --project=logic-app-locator-proof
 *
 * It renders the real `azure-resource-picker.tsx:550-603` composition with the
 * console's own `@fluentui/react-components` and queries it with Playwright's
 * own engine — no estate, no session, no network. Measured counts, success /
 * discovery-failed / #3541-defect fixtures respectively:
 *
 *   getByRole('group')                                  0 / 0 / 0   <- the old bug
 *   getByRole('combobox', { name: 'Logic App' })        1 / 0 / 0
 *   getByRole('button',   { name: 'Refresh resource list' })
 *                                                       1 / 1 / 0
 *   getByLabel('Logic App resource ID', { exact:true }) 0 / 1 / 0
 *   getByRole('button',   { name: 'Enter manually' })   1 / 0 / 0
 *
 * The third column is the NEGATIVE CONTROL and is the point: against the bare
 * `<Input>` shape #3541 condemns, the arm-A locator matches 0, so the assertion
 * genuinely reds on the defect. The name "Logic App" reaches the combobox
 * because `useCombobox.js:23` opts into the Field context with
 * `supportsLabelFor: true`, so `getFieldControlProps`
 * (`useFieldControlProps.js`) assigns the Field's `generatedControlId` to the
 * control and the `<Label>` carries the matching `htmlFor` — the intervening
 * `<div className={s.row}>` is irrelevant because the association is by id, not
 * by nesting. The probe prints that id/`for` pair and fails if it breaks.
 *
 * ── WHAT MAKES EACH ASSERTION KILLABLE (assertion-design.md) ────────────────
 * Every load-bearing assertion below names, at its site, the concrete mutation
 * that turns it RED. The two that carry the weight:
 *
 * A) STRUCTURAL ASSERTION — "Refresh resource list".
 *    `azure-resource-picker.tsx:589-593` renders that button UNCONDITIONALLY:
 *    it sits outside the `{!discoveryFailed && …}` guard around the Combobox
 *    (`:555`) and outside the `{manualVisible && …}` guard around the manual
 *    Input (`:607`). So it is present on EVERY branch the picker can take —
 *    real rows, `no_access` honest gate, hard discovery error — and absent from
 *    the shape #3541 condemns, as the negative control above measures.
 *    FAILING INPUT: revert health-check-editor.tsx:808-814 to
 *    `<Input … placeholder="/subscriptions/…/Microsoft.Logic/workflows/notify" />`
 *    -> no Refresh control -> RED.
 *
 *    ITS EXACT SCOPE, stated honestly. An earlier revision of this header
 *    claimed this arm "never skips". That was FALSE: the assertion lives in the
 *    walk test, which opens with `test.skip(!scratch, …)`, so a workspace/item
 *    creation hiccup skipped the only arm that reds on the #3541 mutation. The
 *    claim is now accurate: the arm runs unconditionally ONCE THE EDITOR OPENS,
 *    and there is no estate condition — gate, empty list, monitor block — that
 *    bypasses it. If the surface cannot be opened at all, NOTHING is measured
 *    and this spec says so in the terms below rather than passing quietly.
 *
 * B) SUCCESS-ONLY REAL-DATA ASSERTION — the ARM read-back `logicAppCount`.
 *    After picking a workflow from the combobox and clicking "Save channels",
 *    the spec re-reads GET /api/items/health-check/{id}/action-group and asserts
 *    the saved group's `logicAppCount >= 1`.
 *
 *    WHY AN ERROR PATH CANNOT SATISFY IT:
 *      1. `logicAppCount` is not pane text and not an echo of the request. It is
 *         computed at monitor-client.ts:1548 as
 *         `(p.logicAppReceivers || []).length` over the `properties` bag of the
 *         ARM **GET** of the action group returned by `listActionGroups()`.
 *         An error never produces that field: `listActionGroups()` throws and
 *         the route answers 502 with no `groups` at all
 *         (action-group/route.ts:85-89, the 502 itself at :89). There is no
 *         branch that synthesises an integer receiver count from a failure, so
 *         `Error: HTTP 500` rendered into a pane — the trap this assertion is
 *         written against — cannot reach it.
 *      2. For that count to be >= 1, ARM must have ACCEPTED a logicAppReceiver,
 *         and `action-group-body.ts:144` admits one only when BOTH `resourceId`
 *         AND a non-empty `callbackUrl` are present. `callbackUrl` has exactly
 *         one producer: `getLogicAppCallbackUrl()` (action-group/route.ts:126),
 *         a real ARM `listCallbackUrl` POST against the picked resource id. A
 *         fabricated or stale id makes it throw -> 502 -> the count stays 0.
 *         So the assertion witnesses a real Azure round-trip, not a DOM string.
 *      3. The id whose round-trip succeeded came from the PICKER, by
 *         construction: this spec only ever clicks an `<Option>`, and an Option
 *         exists only for a row in `resources`, which is filled solely at
 *         azure-resource-picker.tsx:406 inside `if (j.ok && Array.isArray(j.resources))`.
 *         The spec never focuses or types into the manual `<Input>`, and pins
 *         that it was not even present — a check that is NOT vacuous, because
 *         the same locator measures 1 on the discovery-failed fixture above.
 *
 *    FAILING INPUTS, all three concrete:
 *      • Delete `const callbackUrl = await getLogicAppCallbackUrl(...)` and pass
 *        `callbackUrl: ''` — `action-group-body.ts:144` then silently DROPS the
 *        receiver, ARM stores none, `logicAppCount` stays 0 -> RED. (This is the
 *        exact silent-drop that would otherwise ship invisibly: the UI would
 *        still say "saved".)
 *      • Add `microsoft.logic/workflows` to `UNSUPPORTED_TYPES`
 *        (app/api/azure/resources/route.ts:176) — discovery declines,
 *        `discoveryFailed` hides the Combobox, no Option to click -> RED.
 *      • Revert the editor field to the raw `<Input>` (mutation A) -> RED too.
 *
 * ── A NO-MEASUREMENT IS `status:'skip'`, AND THE RUN SAYS SO ────────────────
 * Following `openlineage-emitters.spec.ts:68-95` verbatim, and for the same
 * reason it was written: this spec exists to produce the #3541 RECEIPT, so what
 * it reports when it measures NOTHING is the whole question. An earlier revision
 * could exit 0 having captured no evidence at all — test 1 passes on the
 * `no_access` branch, test 2 skips, Playwright returns rc 0, and
 * `loom-ui-verify.yml` checks only that rc. Green over nothing.
 *
 *   - `pass` — an assertion RAN against the live estate and could have failed.
 *   - `skip` — nothing was measured. Notes are prefixed `NO MEASUREMENT:`.
 *   - `fail` — a structural defect.
 *
 * EVERY terminal branch writes a verdict, including the `test.skip()` site,
 * which previously wrote none. And `afterAll` prints a
 * `HC_LOGIC_APP_RECEIPT=obtained|NOT-OBTAINED` line (once per ATTEMPT — read
 * the last) plus a summary verdict. Only the `wired` outcome is the #3541
 * receipt.
 *
 * BUT stdout and NDJSON are not the caller's channel: `loom-ui-verify.yml`
 * gates on the exit code alone and opens neither. That is what the STRICT
 * project below exists for — it turns "no receipt" into a non-zero exit, which
 * is the only signal the dispatcher actually reads.
 *
 * ── WHAT THIS LEAVES BEHIND, DISCLOSED (not a silent side effect) ──────────
 * The scratch workspace + item are removed in `afterAll`. The Azure Monitor
 * ACTION GROUP is NOT, because the console has no delete path for one: there is
 * no `deleteActionGroup` in `lib/azure/monitor-client.ts` and no `DELETE` on
 * `/api/monitor/action-groups` or `/api/items/health-check/[id]/action-group`
 * (the only `DELETE` under health-check is on `rule/[ruleId]`). So a `wired` run
 * upserts one real `Microsoft.Insights/actionGroups` into `LOOM_ALERT_RG` and
 * leaves it.
 *
 * The name is UNIQUE per run (`hc-3541-<epoch>`) so arm B cannot read an
 * earlier run's group. Two reasons, both of which hold:
 *   - `retries: 2` on this project, and concurrent dispatches, can put more
 *     than one attempt in flight against the same `LOOM_ALERT_RG`; a fixed name
 *     would have them upsert and read back the SAME group.
 *   - it keeps arm B off `action-group-body.ts:152-161`'s merge semantics
 *     (`receivers[kind] = supplied[kind] ?? existing.byKind[kind]`), which a
 *     future edit could invert without touching this spec.
 *
 * An earlier revision justified this differently — "if this run's save 502'd, a
 * prior group would still carry `logicAppCount >= 1` and the read-back would
 * pass on someone else's evidence". That path CANNOT OCCUR, twice over: a
 * non-ok save returns at the `save-gated` branch before the read-back is
 * reached, and because the route always supplies `logicAppReceivers`, an
 * explicit empty array REPLACES rather than falls through, so a fixed-name
 * group would be cleared to 0 and red anyway. The decision was right; only that
 * reason was wrong, and it is deleted rather than reworded.
 *
 * The run prints the group it created (see `afterAll`) so an operator can
 * remove it — best-effort: the name is recorded only after an ok PUT body, so a
 * PUT that reached ARM but whose response was lost leaves a group that is not
 * printed. That the product can CREATE an action group from Loom but never
 * DELETE one is a real gap, tracked as #4743 — it is outside #3541 and wants a
 * product fix, not a test-only workaround.
 *
 * TWO PROJECTS, same `testMatch` (playwright.config.ts), minted-session auth via
 * the `mint` dependency. Neither is wired into a required check.
 *
 *   health-check-logic-app-picker          LENIENT. Estate-dependent branches
 *                                          record `skip` and the run is green.
 *   health-check-logic-app-picker-receipt  STRICT. Anything but a `wired`
 *                                          outcome FAILS the walk, so the run's
 *                                          exit code — the only thing
 *                                          `loom-ui-verify.yml` reads — says
 *                                          whether the receipt exists.
 *
 * Local: SESSION_SECRET=<kv> LOOM_URL=<url> \
 *        pnpm exec playwright test --project=health-check-logic-app-picker-receipt
 * CI:    gh workflow run loom-ui-verify.yml --ref main \
 *          -f extra_projects="health-check-logic-app-picker-receipt"
 *
 * Use the STRICT project when dispatching FOR the receipt. There is no env var
 * to set: the workflow's `env:` list is fixed and would not forward one.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  combobox, refreshBtn, manualInput, enterManuallyBtn, MANUAL_LABEL,
} from './fixtures/logic-app-picker/locators';
import {
  BASE, signIn, createWorkspace, createItem, cleanupWorkspaces,
  captureFailures, recordVerdict,
} from './_lib/uat';

/** The creatable catalog slug whose editor hosts the pane (fabric-iq.ts:268). */
const ITEM_TYPE = 'health-check';

/** The discovery BFF the picker queries (azure-resource-picker.tsx:389). */
const RESOURCES_API = '/api/azure/resources';

/** The ARM type `logic-app` maps to (azure-backed-field.tsx:236). */
const LOGIC_APP_ARM_TYPE = 'Microsoft.Logic/workflows';

/**
 * A well-formed Consumption Logic App ARM id. Case-insensitive on every
 * segment keyword because ARM echoes the provider namespace with the casing the
 * writer used, and Resource Graph's `id` column preserves it — pinning
 * `Microsoft.Logic` exactly would make this fail on a correctly discovered
 * resource, which is the "could not PASS" failure mode assertion-design.md's
 * fourth row records.
 */
const LOGIC_APP_ID_RE =
  /^\/subscriptions\/[0-9a-f-]{36}\/resourcegroups\/[^/]+\/providers\/microsoft\.logic\/workflows\/[^/]+$/i;

/** Every outcome the walk can legitimately reach. Used to give the walk's final
 *  assertion real kill power: a branch that returns an unclassified outcome is
 *  not a member and reds. */
const KNOWN_OUTCOMES = new Set(['wired', 'save-gated', 'no-workflows', 'discovery-failed']);

/**
 * STRICT MODE is selected by PROJECT, not by an environment variable.
 *
 * Round 3 gated it on `HC_REQUIRE_RECEIPT=1`, which could never fire through a
 * dispatch: `loom-ui-verify.yml` has seven dispatch inputs (none of them
 * `require_receipt`) and the extra-projects step forwards a fixed six-entry
 * `env:` list, so nothing carried the variable into the process. A dispatch
 * input is an expression, not an environment variable. The mitigation was
 * documented as active while being unable to fire — worse than the open hole it
 * was meant to close, because it invited a dispatch made in the belief that a
 * green check meant something.
 *
 * `playwright.config.ts` is already in this change's ownership, so strict mode
 * is a SIBLING PROJECT over the same `testMatch`, armed through the
 * `extra_projects` input the workflow already has:
 *
 *   -f extra_projects="health-check-logic-app-picker"          lenient
 *   -f extra_projects="health-check-logic-app-picker-receipt"  strict
 */
const STRICT_PROJECT = 'health-check-logic-app-picker-receipt';

/** Discovery probe of the Logic Apps the picker will offer. */
interface Probe {
  status: number;
  ok: boolean;
  code: string | null;
  error: string | null;
  via: string | null;
  ids: string[];
}

/** Probe the discovery BFF with the suite's minted session (page.request carries it). */
async function probeLogicApps(page: Page): Promise<Probe> {
  const r = await page.request.get(
    `${BASE}${RESOURCES_API}?type=${encodeURIComponent(LOGIC_APP_ARM_TYPE)}`,
  );
  const body = await r.json().catch(() => ({} as any));
  return {
    status: r.status(),
    ok: !!body?.ok,
    code: body?.code ?? null,
    error: body?.error ?? null,
    via: body?.via ?? null,
    ids: Array.isArray(body?.resources)
      ? body.resources.map((x: any) => String(x?.id || '')).filter(Boolean)
      : [],
  };
}

/**
 * The first discovered workflow that CAN back a receiver — i.e. the
 * trigger-inspector (`/api/monitor/logic-app-triggers`) reports a resolvable
 * HTTP-request trigger and no `problem` (#4748). Picking the combobox's first
 * option is not enough: a workflow with no HTTP trigger would fail the save even
 * with the wiring correct, so the receipt must select a callable one or record a
 * NO MEASUREMENT skip. Returns null when none of the discovered workflows is
 * callable (or the caller lacks Azure rights to inspect them).
 */
async function firstCallableWorkflow(page: Page, ids: string[]): Promise<{ id: string; triggerName: string } | null> {
  for (const id of ids) {
    const r = await page.request.get(`${BASE}/api/monitor/logic-app-triggers?workflowResourceId=${encodeURIComponent(id)}`).catch(() => null);
    if (!r) continue;
    const j = await r.json().catch(() => ({} as any));
    if (j?.ok && j?.triggerName && !j?.problem) return { id, triggerName: String(j.triggerName) };
  }
  return null;
}

test.describe.serial('health-check Logic App notification picker (#3541 G1)', () => {
  const createdWorkspaces: string[] = [];
  let scratch: { id: string; workspaceId: string } | null = null;
  let probe: Probe | null = null;
  /** Why setup failed, surfaced instead of swallowed (it used to be swallowed). */
  let setupError: string | null = null;
  /** Set by the walk; drives the end-of-run receipt line. */
  let walkOutcome: string | null = null;
  /** The action group this run upserted, as far as this run could OBSERVE. Set
   *  only after an ok PUT body, so a PUT that reached ARM but whose response was
   *  lost (timeout, dropped socket) leaves a group that is NOT printed below.
   *  The disclosure is therefore best-effort, not a guarantee of completeness. */
  let createdActionGroup: string | null = null;

  test.beforeAll(async ({ browser }) => {
    // Best-effort — a throwing beforeAll takes the whole file with it. The
    // reason is RECORDED rather than discarded, so a skip downstream can say
    // what actually went wrong.
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await signIn(context).catch(() => { /* storageState may already be set */ });
      probe = await probeLogicApps(page).catch(() => null);
      const wsId = await createWorkspace(page, 'hc-logicapp-picker');
      createdWorkspaces.push(wsId);
      const id = await createItem(page, wsId, ITEM_TYPE, `hc-logicapp-${Date.now()}`);
      scratch = { id, workspaceId: wsId };
      console.log(
        `[hc-logic-app] probe status=${probe?.status} ok=${probe?.ok} code=${probe?.code} ` +
          `via=${probe?.via} workflows=${probe?.ids.length} scratch=${scratch?.id}`,
      );
    } catch (e: any) {
      setupError = (e?.message || String(e)).split('\n')[0];
      console.log(`[hc-logic-app] beforeAll partial: ${setupError}`);
    } finally {
      await page.close();
      await context.close();
    }
  });

  test.afterAll(async () => {
    // One line per ATTEMPT, not one per run: `retries: 2` on this project means
    // a flaky attempt can emit this up to three times. Read the LAST one.
    const obtained = walkOutcome === 'wired';
    console.log(`HC_LOGIC_APP_RECEIPT=${obtained ? 'obtained' : 'NOT-OBTAINED'} outcome=${walkOutcome ?? 'none'}`);
    if (createdActionGroup) {
      console.log(
        `HC_LOGIC_APP_LEFTOVER_ACTION_GROUP=${createdActionGroup} ` +
        `(in LOOM_ALERT_RG; the console has no delete path for an action group — remove it manually)`,
      );
    }
    recordVerdict({
      surface: `editor:${ITEM_TYPE}`, feature: 'logic-app-picker:receipt', verdict: 'A',
      status: obtained ? 'pass' : 'skip',
      notes: obtained
        ? `#3541 G1 receipt OBTAINED (outcome=wired)`
        : `NO MEASUREMENT: #3541 G1 receipt NOT obtained (outcome=${walkOutcome ?? 'none'}${setupError ? `; setup: ${setupError}` : ''})`,
    });
    await cleanupWorkspaces(createdWorkspaces).catch(() => { /* best-effort */ });
  });

  // --------------------------------------------------------------------------
  // A) DISCOVERY BFF — the picker's data source answers real rows or a
  //    resolvable honest gate, never a bare error.
  // --------------------------------------------------------------------------
  test('discovery BFF serves Microsoft.Logic/workflows or an honest gate', async ({ page, context }) => {
    test.setTimeout(120_000);
    await signIn(context).catch(() => { /* storageState may already be set */ });
    const p = await probeLogicApps(page);

    // FAILING INPUT: adding 'microsoft.logic/workflows' to UNSUPPORTED_TYPES
    // (app/api/azure/resources/route.ts:176) makes the route answer
    // code:'unsupported_type', which is neither ok nor no_access -> RED.
    expect(
      p.ok || p.code === 'no_access',
      `discovery answered neither rows nor the no_access gate: status=${p.status} code=${p.code} error=${p.error}`,
    ).toBeTruthy();

    if (!p.ok) {
      // Honest gate. Paired POSITIVE assertion (assertion-design.md #4): the
      // gate must NAME its remediation, not merely be absent of rows.
      // FAILING INPUT: a route answering code:'no_access' with `error: ''`.
      expect(String(p.error || ''), 'a no_access gate must carry a remediation sentence').not.toEqual('');
      // NOTHING WAS MEASURED about the picker itself here — the gate assertion
      // ran, but no Logic App was enumerated. `skip`, per the header's rule.
      recordVerdict({
        surface: `editor:${ITEM_TYPE}`, feature: 'logic-app-picker:discovery', verdict: 'A', status: 'skip',
        notes: `NO MEASUREMENT: discovery gated, code=${p.code} — ${String(p.error).slice(0, 160)}`,
      });
      return;
    }

    // Real rows. Assert the ROW SET, never a bare predicate over a possibly
    // empty list: `every()` over [] is vacuously true and would be un-killable,
    // so the shape check is explicitly guarded by a non-empty length.
    if (p.ids.length > 0) {
      const malformed = p.ids.filter((id) => !LOGIC_APP_ID_RE.test(id));
      // FAILING INPUT: a route that projected `name` into the `id` column (or
      // dropped the subscription prefix) -> every row malformed -> RED.
      expect(malformed, `rows whose id is not a Microsoft.Logic/workflows ARM id:\n${malformed.join('\n')}`).toEqual([]);
      recordVerdict({
        surface: `editor:${ITEM_TYPE}`, feature: 'logic-app-picker:discovery', verdict: 'A', status: 'pass',
        notes: `ok via=${p.via} workflows=${p.ids.length}, all ids well-formed`,
      });
    } else {
      // ok:true with zero rows measures nothing about the shape of a row.
      recordVerdict({
        surface: `editor:${ITEM_TYPE}`, feature: 'logic-app-picker:discovery', verdict: 'A', status: 'skip',
        notes: `NO MEASUREMENT: ok via=${p.via} but the tenant has zero Microsoft.Logic/workflows`,
      });
    }
  });

  // --------------------------------------------------------------------------
  // B) CLICK-WALK — Notifications tab -> Add Logic App -> pick from the combobox
  //    -> Save channels -> ARM read-back. This is the #3541 receipt.
  // --------------------------------------------------------------------------
  test('Notifications -> Add Logic App -> pick -> save -> ARM read-back (G1)', async ({ page, context }, testInfo) => {
    test.setTimeout(240_000);
    await signIn(context).catch(() => { /* storageState may already be set */ });

    if (!scratch) {
      // This site used to record NOTHING, so a setup hiccup produced a green
      // run with no row at all — an absent row is a silent no-measurement.
      walkOutcome = 'setup-failed';
      recordVerdict({
        surface: `editor:${ITEM_TYPE}`, feature: 'logic-app-picker:clickwalk', verdict: 'A', status: 'skip',
        notes: `NO MEASUREMENT: no scratch ${ITEM_TYPE} item was created${setupError ? ` — ${setupError}` : ''}`,
      });
      // In STRICT mode a skip is still rc 0, so the caller could not tell this
      // from a receipt. Fail instead — see the strict-mode block at the end.
      if (testInfo.project.name === STRICT_PROJECT) {
        throw new Error(
          `[${STRICT_PROJECT}] no scratch ${ITEM_TYPE} item was created, so nothing could be measured` +
          `${setupError ? `: ${setupError}` : ''}`,
        );
      }
      test.skip(true, `no scratch health-check item was created${setupError ? `: ${setupError}` : ''}`);
      return;
    }
    const target = scratch;

    const { result } = await captureFailures(page, async () => {
      await page.goto(`${BASE}/items/${ITEM_TYPE}/${target.id}`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => { /* best-effort */ });

      // 1) Notifications tab (health-check-editor.tsx:446) — a real click that
      //    must land, not a DOM query.
      const notifTab = page.getByRole('tab', { name: 'Notifications', exact: true });
      await notifTab.waitFor({ state: 'visible', timeout: 30_000 });
      await notifTab.click();
      await expect(notifTab, 'the Notifications tab click must land').toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });

      // 2) "Add Logic App" (health-check-editor.tsx:820). The picker is NOT
      //    mounted before this click — `logicApps` starts [] — which is exactly
      //    why a route-load receipt could never witness this surface.
      const addBtn = page.getByRole('button', { name: 'Add Logic App', exact: true });
      await addBtn.waitFor({ state: 'visible', timeout: 20_000 });
      await addBtn.click();

      // 3) ── ARM A (see header). Runs on every picker branch. ───────────────
      //    FAILING INPUT: revert health-check-editor.tsx:808-814 to the raw
      //    ARM-id <Input> -> this locator measures 0 (proven against the defect
      //    fixture) -> RED.
      await expect(
        refreshBtn(page).first(),
        'the Logic App channel must render the AzureResourcePicker (its "Refresh resource list" control), not a hand-typed ARM-id Input — #3541',
      ).toBeVisible({ timeout: 30_000 });

      await page.screenshot({ path: testInfo.outputPath('hc-logic-app-picker.png'), fullPage: true }).catch(() => {});

      // 4) Classify the picker's branch, then take the strongest arm available.
      const hasCombo = (await combobox(page).count()) > 0;

      if (!hasCombo) {
        // Discovery failed -> the Combobox is replaced by the manual field
        // (azure-resource-picker.tsx:555/607). Per auto-bind-by-default.md this
        // is allowed ONLY because it is not a dead end, so pin the POSITIVE:
        // the escape hatch and the retry are both actually there.
        // FAILING INPUT: restore the pre-#4314 `disabled={loading || !resources.length}`
        // dead end (the picker header's DEFECT 2) -> manual field absent -> RED.
        await expect(manualInput(page), 'discovery failed, so the manual escape hatch MUST be present — a disabled empty box is the forbidden dead end').toBeVisible({ timeout: 10_000 });
        await expect(refreshBtn(page).first(), 'a failed discovery must still offer Retry').toBeEnabled();
        recordVerdict({
          surface: `editor:${ITEM_TYPE}`, feature: 'logic-app-picker:clickwalk', verdict: 'A', status: 'skip',
          notes: 'NO MEASUREMENT: discovery-failed — escape hatch + retry present (no dead end), but no workflow was enumerated or wired',
        });
        return { outcome: 'discovery-failed' };
      }

      // The combobox is mounted. Open it with a real click and read its options.
      await expect(combobox(page), 'the picker must not stay disabled once discovery settles').toBeEnabled({ timeout: 30_000 });
      await combobox(page).click();
      const options = page.getByRole('option');
      await options.first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => { /* none discovered */ });
      const optionCount = await options.count();

      if (optionCount === 0) {
        // The tenant genuinely has no Microsoft.Logic/workflows. Not a defect —
        // but assert the POSITIVE anti-dead-end property rather than stopping at
        // the absence, which deleting the picker would also satisfy.
        await page.keyboard.press('Escape').catch(() => {});
        await expect(refreshBtn(page).first(), 'an empty list must still offer Retry').toBeEnabled();
        await expect(enterManuallyBtn(page), 'an empty list must still offer the manual escape hatch — otherwise it is the forbidden dead end').toBeVisible({ timeout: 10_000 });
        recordVerdict({
          surface: `editor:${ITEM_TYPE}`, feature: 'logic-app-picker:clickwalk', verdict: 'A', status: 'skip',
          notes: `NO MEASUREMENT: no-workflows — combobox enabled, retry + manual hatch present; probe saw ${probe?.ids.length ?? '?'} workflows; nothing was wired`,
        });
        return { outcome: 'no-workflows', optionCount };
      }

      // 5) Pick a CALLABLE workflow — one whose HTTP-request trigger resolves
      //    (#4748). The first discovered option may have no HTTP trigger and
      //    would fail the save even with the wiring correct, so ask the
      //    trigger-inspector which workflows are callable and select one of
      //    those. If none is callable, record a NO MEASUREMENT skip — never a
      //    green over a save that could not complete for a data reason.
      const callable = await firstCallableWorkflow(page, probe?.ids ?? []);
      if (!callable) {
        await page.keyboard.press('Escape').catch(() => {});
        recordVerdict({
          surface: `editor:${ITEM_TYPE}`, feature: 'logic-app-picker:clickwalk', verdict: 'A', status: 'skip',
          notes: `NO MEASUREMENT: no-callable-workflow — ${optionCount} option(s) discovered but none has a resolvable HTTP-request trigger (or the account cannot inspect them); nothing was wired`,
        });
        return { outcome: 'no-callable-workflow', optionCount };
      }
      const wantName = callable.id.split('/').pop() || '';
      const callableOption = options.filter({ hasText: wantName }).first();
      if ((await callableOption.count()) === 0) {
        await page.keyboard.press('Escape').catch(() => {});
        recordVerdict({
          surface: `editor:${ITEM_TYPE}`, feature: 'logic-app-picker:clickwalk', verdict: 'A', status: 'skip',
          notes: `NO MEASUREMENT: label-mismatch — a callable workflow "${wantName}" was found via the trigger inspector but no combobox option matched its name; nothing was wired`,
        });
        return { outcome: 'label-mismatch', optionCount };
      }
      const optionLabel = (await callableOption.textContent())?.trim() || wantName;
      await callableOption.click();
      await page.keyboard.press('Escape').catch(() => { /* may already be closed */ });

      // PAIRED assertions (assertion-design.md #4). The absence check is NOT
      // vacuous: this exact locator measures 1 against the discovery-failed
      // fixture (header table), so a manual field appearing here would red it.
      // And it is paired with a POSITIVE pin that the pick actually stuck —
      // absence alone would be satisfied by a picker that committed nothing.
      await expect(
        manualInput(page),
        'the manual ARM-id field must stay hidden on the discovery-succeeded path — #3541 is about not typing this value',
      ).toHaveCount(0);
      // FAILING INPUT: the `onSelect` miss-branch calling `onChange(null)` on a
      // real row (azure-resource-picker.tsx:492) -> the box clears -> RED.
      await expect(
        combobox(page),
        'picking an option must leave a committed selection in the combobox',
      ).not.toHaveValue('', { timeout: 10_000 });

      // 6) Name the group and save. A name is required (editor :824 disables
      //    Save on an empty name), so this also exercises that guard.
      const agName = `hc-3541-${Date.now()}`;
      await page.getByLabel('Action group name', { exact: true }).fill(agName);
      const savePromise = page.waitForResponse(
        (r) => r.url().includes(`/api/items/${ITEM_TYPE}/${target.id}/action-group`) && r.request().method() === 'PUT',
        { timeout: 120_000 },
      ).catch(() => null);
      await page.getByRole('button', { name: 'Save channels', exact: true }).click();
      const saveResp = await savePromise;
      const saveBody = saveResp ? await saveResp.json().catch(() => ({} as any)) : null;
      await page.screenshot({ path: testInfo.outputPath('hc-logic-app-saved.png'), fullPage: true }).catch(() => {});

      if (!saveResp || !saveBody?.ok) {
        // Monitor-side honest gate (LOOM_SUBSCRIPTION_ID / LOOM_ALERT_RG unset,
        // or the UAMI lacks Monitoring Contributor — action-group/route.ts:40-67),
        // or a real 502. Classified, never faked into a pass on the wiring.
        //
        // The assertion is on the BODY, not on a derived string. An earlier
        // revision built `gate || error || \`HTTP ${status}\`` and asserted it
        // non-empty — which the template literal made ALWAYS true, and whose
        // named failing input (an empty body) actually PASSED.
        if (saveResp) {
          // FAILING INPUT: the route answering `{ ok:false }` with neither
          // `error` nor `gate.remediation` — a bare failure -> RED.
          expect(
            saveBody?.gate?.remediation || saveBody?.error,
            `a failed save must carry a cause or a remediation, never a bare {ok:false}: ${JSON.stringify(saveBody).slice(0, 200)}`,
          ).toBeTruthy();
        }
        const why = saveBody?.gate?.remediation || saveBody?.error || `no PUT response within 120s`;
        recordVerdict({
          surface: `editor:${ITEM_TYPE}`, feature: 'logic-app-picker:clickwalk', verdict: 'A', status: 'skip',
          notes: `NO MEASUREMENT: picked "${optionLabel.slice(0, 80)}" from ${optionCount} option(s) but the save was gated: ${String(why).slice(0, 160)}`,
        });
        return { outcome: 'save-gated', optionCount };
      }

      // The PUT succeeded, so a real Microsoft.Insights/actionGroups now exists
      // in LOOM_ALERT_RG. Record it so afterAll can PRINT it — there is no
      // delete path to call (see the header).
      createdActionGroup = agName;

      // The id the editor sent is the one the picker produced. Assert its SHAPE
      // — this is what distinguishes "an ARM id came back" from "a name did".
      const savedId = String(saveBody?.current?.logicApps?.[0]?.resourceId || '');
      expect(
        savedId,
        `the saved Logic App value must be a Microsoft.Logic/workflows ARM id, got "${savedId}"`,
      ).toMatch(LOGIC_APP_ID_RE);

      // 7) ── ARM B: the success-only real-data assertion. ────────────────────
      //    Re-read the action group FROM AZURE. `logicAppCount` is
      //    `(p.logicAppReceivers || []).length` over the ARM GET
      //    (monitor-client.ts:1548) — see the header for why no error path can
      //    produce it, and for the three mutations that turn it RED.
      const readBack = await page.request.get(`${BASE}/api/items/${ITEM_TYPE}/${target.id}/action-group`);
      const rb = await readBack.json().catch(() => ({} as any));
      expect(rb?.ok, `the action-group read-back must succeed: HTTP ${readBack.status()} ${JSON.stringify(rb).slice(0, 200)}`).toBeTruthy();
      const groups: any[] = Array.isArray(rb?.groups) ? rb.groups : [];
      const mine = groups.find((g) => String(g?.name || '') === agName) || null;
      expect(mine, `the saved action group "${agName}" must appear in the ARM listing (${groups.length} group(s) read back)`).toBeTruthy();
      expect(
        Number(mine?.logicAppCount ?? 0),
        'Azure must report at least one logicAppReceiver on the group — 0 means the receiver was dropped, which is what happens when getLogicAppCallbackUrl stops resolving (action-group-body.ts:144 requires a non-empty callbackUrl)',
      ).toBeGreaterThanOrEqual(1);

      recordVerdict({
        surface: `editor:${ITEM_TYPE}`, feature: 'logic-app-picker:clickwalk', verdict: 'A', status: 'pass',
        notes: `WIRED — picked "${optionLabel.slice(0, 80)}" from ${optionCount} discovered option(s); saved id=${savedId}; ARM read-back logicAppCount=${mine?.logicAppCount}`,
      });
      return { outcome: 'wired', optionCount, savedId };
    }, { label: 'hc-logic-app-picker' });

    walkOutcome = result?.outcome ?? null;
    // Real kill power, not `toBeTruthy()` on an always-truthy object.
    // FAILING INPUT: a branch that returns an outcome not in KNOWN_OUTCOMES
    // (adding a fifth classification and forgetting to register it) reds here.
    expect(
      walkOutcome !== null && KNOWN_OUTCOMES.has(walkOutcome),
      `the walk must end in a classified outcome, got ${JSON.stringify(walkOutcome)}`,
    ).toBeTruthy();

    // ── STRICT MODE. Fail THE TEST, deliberately not `afterAll`. ─────────────
    // Failing here rather than in the hook is what makes strict mode correct
    // under `retries: 2`, and it is not a stylistic choice:
    //
    //   • An `afterAll` throw fires on EVERY attempt, so attempt 1 failing and
    //     the retry coming back `wired` would still throw for attempt 1 — a
    //     false RED on a run that DID obtain the receipt.
    //   • Restricting that throw to the last attempt (`testInfo.retry` vs
    //     `project.retries`) does not fix it either, and fails the other way:
    //     Playwright only retries FAILED tests, so a `no-workflows` outcome
    //     PASSES, no retry is scheduled, `retry` stays 0 < 2, and strict mode
    //     never fires — green over nothing, which is the thing it exists to
    //     prevent.
    //
    // Failing the test instead hands both cases to Playwright's own retry
    // machinery: not-wired is a failure, so it IS retried; a `wired` retry
    // makes the run flaky and rc 0; every attempt not-wired makes it rc 1.
    //
    // FAILING INPUT: running the `health-check-logic-app-picker-receipt`
    // project against an estate where the outcome is anything but `wired` —
    // gated discovery, zero Logic Apps, or a gated save.
    if (testInfo.project.name === STRICT_PROJECT && walkOutcome !== 'wired') {
      throw new Error(
        `[${STRICT_PROJECT}] the #3541 G1 receipt was NOT obtained (outcome=${walkOutcome ?? 'none'}). ` +
        `This project exists to fail in exactly this case: a run that measured nothing must not report success. ` +
        `Use the lenient 'health-check-logic-app-picker' project to walk an estate that legitimately gates.`,
      );
    }
  });
});
