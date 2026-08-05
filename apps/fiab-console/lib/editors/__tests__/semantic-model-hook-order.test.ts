/**
 * semantic-model-hook-order.test.ts — R10 decomposition regression guard.
 *
 * `SemanticModelEditorInner` is being decomposed slice by slice (see
 * docs/fiab/decomposition-plan.md). Every slice claims to be "purely
 * structural". React's Rules of Hooks make that claim checkable: the component's
 * hook-call sequence — with each extracted sibling hook expanded inline at its
 * call site — must be IDENTICAL to the pre-decomposition monolith's.
 *
 * The golden in `fixtures/semantic-model-hook-order.txt` was generated from
 * commit 20b3fe93 (`apps/fiab-console/lib/editors/phase3/semantic-model-editor.tsx`
 * at 3,025 LOC, before any R10 slice landed). It was 193 entries; it is now 197.
 *
 * The legitimate hook ADDITIONS since, both regenerated in the commit that made
 * them (per the regeneration policy at the foot of this comment):
 *
 *   +2 at index 6 — #2649 split the editor's single `workspaceId` into
 *   `pbiWorkspaceId` (a Power BI groupId) and `loomWorkspaceId` (the item's own
 *   Loom workspace, resolved from its record), because feeding one value to both
 *   namespaces 404'd every assertOwner-guarded Loom item route on open.
 *
 *   +2 at index 6 — the Power BI workspace BINDING PRECEDENCE fix: a `useState`
 *   holding the Loom-workspace -> Power BI-workspace mapping (three-state:
 *   null = resolving) plus the `useEffect` that resolves it. Without them the
 *   editor bound `ws.workspaces[0].id` — an ARBITRARY group the caller may hold
 *   no role on — and every workspace-scoped Power BI call 401'd. Both are
 *   unconditional top-level hooks in the component body (before any conditional
 *   return), so hook order stays stable across renders; the fixture diff is
 *   +1 `useState` +1 `useEffect` with NO reordering of the remaining 193.
 *
 * This guard is not theoretical. The first push of PR #2565 (commit 25e464b0)
 * collapsed the incremental-refresh cluster into a single
 * `useSemanticModelIncrementalRefresh()` hook, which moved its 17-`useState` run
 * from sequence position 92 to position 162 — 70 hook registrations later —
 * while the PR body claimed "hook order and effect order in
 * SemanticModelEditorInner are unchanged". Point the expansion map below at that
 * tree's single-hook export and the golden diff reports the divergence at index
 * 92; run this spec unmodified against that tree and `extractFunctionSource`
 * throws on the missing `…State` / `…Actions` exports. Either way it is red.
 *
 * When a future slice legitimately ADDS or REMOVES a hook (as opposed to moving
 * one), regenerate the golden in the same commit — the fixture diff is then the
 * reviewable artifact showing exactly which hook changed.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { expandedHookSequence, hookSequence, extractFunctionSource, stripNonCode } from './helpers/hook-order';

const EDITORS = path.resolve(__dirname, '..');
const DIR = path.join(EDITORS, 'phase3', 'semantic-model-editor');
const read = (p: string) => fs.readFileSync(p, 'utf8');

describe('R10 decomposition — SemanticModelEditorInner hook order', () => {
  it('matches the pre-decomposition golden sequence exactly', () => {
    const golden = read(path.join(__dirname, 'fixtures', 'semantic-model-hook-order.txt'))
      .split('\n').map((l) => l.trim()).filter(Boolean);

    const actual = expandedHookSequence(
      read(path.join(EDITORS, 'phase3', 'semantic-model-editor.tsx')),
      'SemanticModelEditorInner',
      {
        usePbiWorkspaceBinding: read(path.join(DIR, 'pbi-workspace-binding.ts')),
        useSemanticModelAggregations: read(path.join(DIR, 'aggregations-tab.tsx')),
        useSemanticModelDirectLake: read(path.join(DIR, 'direct-lake-tab.tsx')),
        useSemanticModelIncrementalRefreshState: read(path.join(DIR, 'incremental-refresh-tab.tsx')),
        useSemanticModelIncrementalRefreshActions: read(path.join(DIR, 'incremental-refresh-tab.tsx')),
      },
    );

    expect(golden.length).toBe(197);
    // Compare as joined strings so a failure prints the first differing region
    // rather than 193 lines of noise.
    const firstDiff = actual.findIndex((h, i) => h !== golden[i]);
    expect(
      firstDiff === -1 && actual.length === golden.length
        ? 'identical'
        : `index ${firstDiff}: golden=${golden.slice(Math.max(0, firstDiff - 2), firstDiff + 4).join(',')} actual=${actual.slice(Math.max(0, firstDiff - 2), firstDiff + 4).join(',')} (lengths ${golden.length} vs ${actual.length})`,
    ).toBe('identical');
  });

  it('registers the incremental-refresh state block BEFORE the aggregations hook', () => {
    // The specific regression the first push of #2565 introduced: the cluster's
    // useState block must stay ahead of `useSemanticModelAggregations`, which is
    // where it sat in the monolith.
    const src = read(path.join(EDITORS, 'phase3', 'semantic-model-editor.tsx'));
    const seq = hookSequence(extractFunctionSource(src, 'SemanticModelEditorInner'));
    const irState = seq.indexOf('useSemanticModelIncrementalRefreshState');
    const agg = seq.indexOf('useSemanticModelAggregations');
    const irActions = seq.indexOf('useSemanticModelIncrementalRefreshActions');
    expect(irState).toBeGreaterThan(-1);
    expect(agg).toBeGreaterThan(-1);
    expect(irActions).toBeGreaterThan(-1);
    expect(irState).toBeLessThan(agg);
    expect(irActions).toBeGreaterThan(agg);
  });

  it('calls every extracted hook unconditionally at the top level of the component', () => {
    // Rules of Hooks: none of the R10 hook call sites may sit inside an `if`,
    // a loop, or a callback. Assert each is a top-level `const … = useX(` at
    // exactly two-space indentation inside the component body.
    const body = stripNonCode(
      extractFunctionSource(read(path.join(EDITORS, 'phase3', 'semantic-model-editor.tsx')), 'SemanticModelEditorInner'),
    );
    for (const hook of [
      'useSemanticModelAggregations',
      'useSemanticModelDirectLake',
      'useSemanticModelIncrementalRefreshState',
      'useSemanticModelIncrementalRefreshActions',
    ]) {
      const line = body.split('\n').find((l) => l.includes(`${hook}(`));
      expect(line, `${hook} call site`).toBeDefined();
      expect(line!.startsWith('  const '), `${hook} must be a top-level const, got: ${line}`).toBe(true);
    }
  });
});
