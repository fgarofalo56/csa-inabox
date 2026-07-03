# Dimension: live verification (loom-uat + browser walk)

> Live signal to complement the code-level audit, 2026-07-02. Console under
> test: rev serving `https://<your-console-hostname>` (Front Door),
> centralus DMLZ sub e093f4fd. Auth = minted session cookie.

## loom-uat — use-case apps sweep (execution `loom-uat-q0yfdio`, Succeeded)

- Scope: `UAT_GREP="use-case app"` → the 29 use-case-app install-via-UI tests
  (`e2e/use-case-apps-uat.uat.ts`), each: create workspace → open
  `/apps/<id>` → click Install → pick workspace in dialog → confirm → POST
  `/api/apps/<id>/install` → poll job → classify provision steps.
- **Result: `pass=3 fail=27 skip=0 realFails=0 infraGated=0`.**
- **The `realFails=0` is VACUOUS** (documented UAT trap): all 27 failures are at
  the **UI interaction step** — `expect(dialog).toBeVisible()` failed, or
  `locator.click Timeout 15000ms` — i.e. the tests die at the Install dialog
  BEFORE reaching the provisioning classifier, so "0 real fails" means "no
  verdict produced," not "clean."
- **Signature = systemic, not per-app:** all 27 fail identically at the Install
  dialog; the only recent commit touching these pages is `a34ee904` (Web-5.0
  Waves 7+8, which redesigned top-level pages incl. `/apps`). Prime suspect:
  the redesign changed the `/apps/<id>` Install button or the `InstallAppDialog`
  structure (role/name/combobox/confirm-button) that the test drives.
- Current code (post-redesign): `app/apps/[id]/page.tsx:158-160` button label is
  **"Install into workspace"** (still matches the test's `/^Install/i`), opening
  `InstallAppDialog` (`lib/components/apps/install-app-dialog.tsx`). The test
  expects: Install button visible (30s) → `getByRole('dialog')` visible (15s) →
  `getByRole('combobox')` workspace picker → confirm button `/Install|Deploy/i`
  → POST install returning `{jobId}`.
- **VERDICT (live browser diagnosis, browser-walk agent): REAL product
  regression = release blocker.** Reproduced identically on `/apps/app-ml-pipeline`
  and `/apps/app-fedramp-tracker`: the "Install into workspace" button opens a
  dialog that IS fully usable by mouse (workspace combobox with 436 real
  options, "Deploy to live Azure" switch, folder picker, Cancel/Install). BUT
  the active `fui-DialogSurface` carries `role="dialog"` + `aria-modal="true"`
  **AND `aria-hidden="true"` on the same element** — the Tabster modalizer is
  inverted (`{isOthersAccessible:false,isTrapped:true}` but it hid the active
  modal, not the background app root, and did not trap focus). Zero JS console
  errors — it is purely an a11y-tree defect.
- **Two consequences, both blocking for a public GOV product:** (1) **Section
  508 break** on the primary install flow — screen-reader/keyboard users can't
  reach the live modal. (2) Playwright's role engine excludes `aria-hidden`
  nodes → `getByRole('dialog')` returns 0 → `toBeVisible()` times out
  ("dialog toBeVisible failed"); scoped `combobox`/`button` → 0 → "click
  Timeout 15000ms"; the run dies before the confirm click, so **POST install
  never fires → the vacuous `realFails=0`.** One fix re-greens all 27 apps; NO
  test change is needed (`getByRole('dialog')` is the correct assertion).
- **Root cause (main-loop confirmation):** `install-app-dialog.tsx` is a plain
  Fluent `<Dialog><DialogSurface>` and never sets `aria-hidden` — it is applied
  at runtime by Fluent/Tabster. `package.json` declares
  `@fluentui/react-components: ^9.54.0` but the lockfile resolved **9.73.8**
  (`@fluentui/react-tabster@9.26.14`, `tabster@8.8.0`) on **React 19.2** — the
  known-regression band for Tabster emitting `aria-hidden` on the modal itself.
  Commit `a34ee904` (Web-5.0 Waves 7+8) reordered `app/apps/page.tsx` + many
  pages but did NOT touch the provider/layout roots (only 2 `FluentProvider`
  roots exist: `theme/fluent-ssr.tsx`, `theme/theme-context.tsx`), so this is a
  dependency-interaction regression the DOM reordering EXPOSED, not provider
  nesting. **Fix direction:** pin/upgrade `@fluentui/react-components` +
  `react-tabster` to a version past the modalizer aria-hidden-on-self fix (and/or
  ensure the Dialog portal mounts under the FluentProvider/Tabster root); add a
  Playwright a11y assertion (`getByRole('dialog')` visible + no `aria-hidden` on
  the surface) so it can't regress silently. Screenshot: `11a-app-detail.png`.
- Note per UAT memory: the provisioner runs in **loom-console**, not the uat
  job; a provisioner fix must be rolled into the console image, then re-run uat.

## Browser walk — status

In progress at time of writing (minted-session Playwright walk of home / nav /
workspaces / `/new` / 5 editors / marketplace / governance / learn / admin /
setup / error states + the `/apps` install diagnosis above). Findings fold in
on completion.

## Follow-on live gates (recommended, per no-vaporware quarterly mandate)

1. Re-run `no-cuts-sweep-v3` (`UAT_GREP=ribbon`) for functional (create-item +
   real backend call) signal, not just render/smoke.
2. Batched `deep-functional` `/new` sweep (≤30 slugs/batch — full 117 hits the
   2h replicaTimeout and drops the buffer).
3. **Clean-slate Gov validation** on the operator's single Azure Government
   subscription once Wave-0/1 land — this is the true "customer clones repo and
   deploys" proof for the release scenario (Commercial + GCC + MAG/GCC-High).
