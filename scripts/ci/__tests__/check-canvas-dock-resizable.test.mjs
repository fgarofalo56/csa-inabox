// Tests for scripts/ci/check-canvas-dock-resizable.mjs (assertion-design.md:
// each assertion names the input that breaks it).
// Override the module under test (used by the mutation run against a scratch
// copy): CANVAS_DOCK_GUARD_PATH=/abs/path/to/mutated.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.env.CANVAS_DOCK_GUARD_PATH
  ? pathToFileURL(process.env.CANVAS_DOCK_GUARD_PATH).href
  : pathToFileURL(path.join(here, '..', 'check-canvas-dock-resizable.mjs')).href;
const { scanSource, scanTree, evaluate, ALLOWLIST } = await import(target);

const EDITOR = 'apps/fiab-console/lib/editors/new-thing-editor.tsx';

const FIXED_DOCK = `
const useStyles = makeStyles({
  validationDock: {
    height: 220,
    overflow: 'auto',
  },
});
export function X() { return <div className={s.validationDock} />; }
`;

test('(a) fixed-height dock class with no primitive is flagged R1 -- breaks if the height regex or name match is dropped', () => {
  const hits = scanSource(EDITOR, FIXED_DOCK);
  assert.deepEqual(hits.map((h) => h.rule), ['R1'], 'expected exactly one R1 hit on the "height: 220" dock');
  // And the guard-level verdict is red: a hit with an empty allowlist.
  const counts = new Map([[`R1|${EDITOR}`, hits.length]]);
  assert.equal(evaluate(counts, new Map()).length, 1);
});

test('(a2) px-string height is also flagged; minHeight/maxHeight are not', () => {
  const px = FIXED_DOCK.replace('height: 220,', "height: '240px',");
  assert.equal(scanSource(EDITOR, px).length, 1, "'240px' must be flagged");
  const flexible = FIXED_DOCK.replace('height: 220,', 'minHeight: 120, maxHeight: 400,');
  assert.equal(scanSource(EDITOR, flexible).length, 0, 'min/max-height is resizable-friendly and must pass');
});

test('(b) the same dock wrapped in StackedSplit passes -- breaks if the primitive check is removed', () => {
  const wrapped = `import { StackedSplit } from '@/lib/components/shared/stacked-split';\n${FIXED_DOCK}\nexport const Y = () => <StackedSplit panes={[]} />;`;
  assert.deepEqual(scanSource(EDITOR, wrapped), [], 'primitive present in file -> no R1');
});

test('(c) hand-rolled row-resize handle is flagged R2 even when a primitive is imported', () => {
  const handle = `import { SplitPane } from 'x';\nconst s = makeStyles({ grip: { cursor: 'row-resize', height: 4 } });`;
  const hits = scanSource(EDITOR, handle);
  assert.deepEqual(hits.map((h) => h.rule), ['R2'], 'cursor row-resize outside a primitive file must fail');
  const sep = `<div role="separator"\n  onPointerDown={start} />`;
  assert.deepEqual(scanSource(EDITOR, sep).map((h) => h.rule), ['R2'], 'separator + onPointerDown must fail');
  const plainRule = `<div role="separator" style={{ height: 1 }} />`;
  assert.deepEqual(scanSource(EDITOR, plainRule), [], 'a decorative separator is not a resize handle');
});

test("(d) a sanctioned primitive's own file is exempt -- breaks if SANCTIONED_FILES stops covering it", () => {
  const own = 'apps/fiab-console/lib/components/shared/split-pane.tsx';
  assert.deepEqual(scanSource(own, `const s = { grip: { cursor: 'row-resize' } };`), []);
  // Same text in a non-sanctioned path IS flagged, so the exemption is what passes it.
  assert.equal(scanSource(EDITOR, `const s = { grip: { cursor: 'row-resize' } };`).length, 1);
});

test('comments mentioning a violation do not trip the guard', () => {
  assert.deepEqual(scanSource(EDITOR, `// cursor: 'row-resize'\n/* validationDock: { height: 5, } */`), []);
});

test('ratchet: a stale allowlist entry fails (allowance 4, found 0)', () => {
  const problems = evaluate(new Map(), new Map([['R2|some/file.tsx', 4]]));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /STALE/);
});

test('POSITIVE CONTROL: the real tree scans a non-zero file count, finds the known handle file, and is clean vs the allowlist', () => {
  const { scanned, counts } = scanTree();
  assert.ok(scanned > 100, `scanned ${scanned} files; an empty scan must not report clean`);
  assert.ok(
    counts.get('R2|apps/fiab-console/lib/editors/report/free-form-canvas.tsx') >= 4,
    'detector must still see the known free-form-canvas handles (a blind detector would see 0)',
  );
  assert.deepEqual(evaluate(counts, ALLOWLIST), []);
});
