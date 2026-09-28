/**
 * render-fixtures.cjs — build the DOM fixtures the locator proof runs against.
 *
 * WHY THIS IS COMMITTED
 * ---------------------
 * `health-check-logic-app-picker.spec.ts` carries a table of measured locator
 * counts, and a table nobody can re-run is a transcription. This harness is the
 * instrument that produced it, so the next reviewer can re-derive the numbers
 * instead of trusting them.
 *
 * It renders the real composition from
 * `lib/components/azure/azure-resource-picker.tsx:550-603` with the REAL
 * `@fluentui/react-components`, in four states:
 *
 *   picker-success.html  discovery returned rows      -> Combobox present
 *   picker-empty.html    discovery ok, zero rows      -> Combobox, no Options
 *   picker-failed.html   discovery failed             -> manual field instead
 *   picker-defect.html   the #3541 DEFECT (raw Input) -> the negative control
 *
 * The defect fixture is LIFTED, not transcribed: its `<Field label>` and
 * `placeholder` are copied from
 * `git show e1b9d07d9^:apps/fiab-console/lib/editors/palantir/health-check-editor.tsx`
 * lines 802-803 — the commit (PR #4314) that replaced the hand-typed field. The
 * label's lowercase `id` is the whole point of the `{ exact: true }` arm in
 * `probe-locators.cjs`; "fixing" it silently would delete that proof.
 *
 * Run (from apps/fiab-console):
 *   node e2e/fixtures/logic-app-picker/render-fixtures.cjs
 *   node e2e/fixtures/logic-app-picker/probe-locators.cjs
 *
 * Requires the console's node_modules (react, react-dom, @fluentui/react-components).
 * Neither script is part of any Playwright project or CI check; they are an
 * on-demand instrument.
 */
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const F = require('@fluentui/react-components');

const h = React.createElement;
const OUT = __dirname;

/**
 * The picker composition, structurally mirroring azure-resource-picker.tsx:
 * Field(label) > div.row > [Combobox(+Options), Button(aria-label=Refresh),
 * Button("Enter manually")], including the intervening <div> that a naive
 * reading might assume breaks the Field->control association. (It does not:
 * the association is by generated id, which is what the probe demonstrates.)
 */
function Picker({ discoveryFailed, manualVisible, options }) {
  return h(F.FluentProvider, { theme: F.webLightTheme },
    h('div', null,
      h(F.Field, { label: 'Logic App' },
        h('div', null,
          !discoveryFailed && h(F.Combobox, {
            value: '', selectedOptions: [], placeholder: 'Select a resource', disabled: false,
          }, (options || []).map((o) =>
            h(F.OptionGroup, { key: o.group, label: o.group },
              o.items.map((it) => h(F.Option, { key: it.value, value: it.value, text: it.text }, it.text))))),
          h(F.Button, { size: 'small', appearance: 'subtle', 'aria-label': 'Refresh resource list' }),
          !manualVisible && h(F.Button, { size: 'small', appearance: 'subtle' }, 'Enter manually'),
        )),
      manualVisible && h(F.Field, { label: 'Logic App resource ID' },
        h('div', null,
          h(F.Input, { value: '', 'aria-label': 'Logic App resource ID' }),
          h(F.Button, { size: 'small', appearance: 'primary' }, 'Use this value'))),
    ));
}

const page = (node) =>
  '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
  renderToStaticMarkup(node) + '</body></html>';

const SUB = '3f2a91c4-7b6d-4e18-9a52-c08d5b17e6f1';
const OPTS = [{
  group: `Subscription ${SUB.slice(0, 8)} (2)`,
  items: [
    { value: `/subscriptions/${SUB}/resourceGroups/rg-loom/providers/Microsoft.Logic/workflows/notify-oncall`, text: 'notify-oncall' },
    { value: `/subscriptions/${SUB}/resourceGroups/rg-loom/providers/Microsoft.Logic/workflows/notify-sev1`, text: 'notify-sev1' },
  ],
}];

const write = (name, node) => fs.writeFileSync(path.join(OUT, name), page(node), 'utf8');

/**
 * Render all four fixtures. Exported so `locator-proof.spec.ts` can produce
 * them in `beforeAll` — the proof must never run against a stale `.html` left
 * on disk, and the generated files are gitignored for the same reason.
 */
function renderAll() {
  write('picker-success.html', h(Picker, { discoveryFailed: false, manualVisible: false, options: OPTS }));
  write('picker-empty.html', h(Picker, { discoveryFailed: false, manualVisible: false, options: [] }));
  write('picker-failed.html', h(Picker, { discoveryFailed: true, manualVisible: true, options: [] }));

  // THE NEGATIVE CONTROL. Label + placeholder lifted from e1b9d07d9^ (see header).
  //
  // The row's siblings — the "Common Alert Schema" Switch and the Remove button
  // (health-check-editor.tsx:805-806 at that revision) — are deliberately
  // OMITTED. None of the probed accessible names can match them, so they cannot
  // change a single count; including them would only make the fixture look more
  // faithful than the probe actually requires. Noted so the omission is a
  // decision on the record rather than an oversight.
  write('picker-defect.html',
    h(F.FluentProvider, { theme: F.webLightTheme },
      h(F.Field, { label: 'Logic App resource id' },
        h(F.Input, { value: '', placeholder: '/subscriptions/…/providers/Microsoft.Logic/workflows/notify' }))));

  return OUT;
}

module.exports = { renderAll, OUT };

// CLI use: `node e2e/fixtures/logic-app-picker/render-fixtures.cjs`
if (require.main === module) {
  renderAll();
  console.log('WROTE 4 fixtures into ' + OUT);
  console.log('role="group" present in success fixture? ' +
    /role="group"/.test(fs.readFileSync(path.join(OUT, 'picker-success.html'), 'utf8')));
}
