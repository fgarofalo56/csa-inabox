/**
 * Power BI workspace BINDING PRECEDENCE for the Semantic Model editor.
 *
 * THE BUG THIS PINS. The editor bound its Power BI workspace with:
 *
 *     if (!pbiWorkspaceId && ws.workspaces?.length) setPbiWorkspaceId(ws.workspaces[0].id);
 *
 * i.e. whichever group the tenant listing happened to return FIRST. That is an
 * arbitrary THIRD workspace — neither the item's own Loom workspace nor the one
 * an operator mapped in Workspace settings (`pbiWorkspaceMapping`). Every
 * downstream /api/powerbi/{datasets,reports,dashboards,dataflows} call then
 * addressed a group the caller may hold no role on, which Power BI answers 401
 * (learn.microsoft.com/power-bi/developer/embedded/troubleshoot-rest-api
 * #troubleshoot-401-errors-in-power-bi-rest-api-calls).
 *
 * `lib/azure/powerbi-workspace-mapping.ts` already documents the correct
 * precedence (explicit → mapped → env default) — the editor simply never used
 * it. These cases pin the resolution rule the editor now follows, including the
 * RACE: while the mapping is still resolving the arbitrary fallback must not
 * win.
 */
import { describe, it, expect } from 'vitest';
import { pickPbiWorkspaceId } from '../powerbi-workspace-mapping';
import { resolveEditorPbiBinding } from '../powerbi-editor-binding';

const MAPPED = '11111111-1111-1111-1111-111111111111';
const FIRST_LISTED = '22222222-2222-2222-2222-222222222222';
const EXPLICIT = '33333333-3333-3333-3333-333333333333';

describe('pickPbiWorkspaceId — documented precedence', () => {
  it('prefers an explicit per-item binding over the workspace mapping', () => {
    expect(pickPbiWorkspaceId({ explicit: EXPLICIT, mapped: MAPPED, envDefault: FIRST_LISTED })).toBe(EXPLICIT);
  });

  it('prefers the workspace MAPPING over the env default', () => {
    expect(pickPbiWorkspaceId({ mapped: MAPPED, envDefault: FIRST_LISTED })).toBe(MAPPED);
  });

  it('returns undefined when nothing is bound (never invents a workspace)', () => {
    expect(pickPbiWorkspaceId({})).toBeUndefined();
    expect(pickPbiWorkspaceId({ explicit: '   ', mapped: '', envDefault: null })).toBeUndefined();
  });
});

describe('resolveEditorPbiBinding — the rule the editor executes', () => {
  it('binds the MAPPED workspace, not the first one the tenant listing returned', () => {
    const got = resolveEditorPbiBinding({
      mapped: MAPPED,
      listed: [{ id: FIRST_LISTED }, { id: MAPPED }],
      loomWorkspaceId: 'loom-ws-1',
    });
    // MUTATION-PROOF: reverting to `ws.workspaces[0].id` yields FIRST_LISTED and
    // fails here — that revert is exactly the bug that produced the "third id".
    expect(got).toBe(MAPPED);
    expect(got).not.toBe(FIRST_LISTED);
  });

  it('WAITS while the mapping is still resolving so the arbitrary fallback cannot win the race', () => {
    const got = resolveEditorPbiBinding({
      mapped: null, // still in flight
      listed: [{ id: FIRST_LISTED }],
      loomWorkspaceId: 'loom-ws-1',
    });
    // MUTATION-PROOF for the race: without the `mapped === null` guard the
    // effect fires on the first render that has a workspace list and pins the
    // arbitrary group before the mapping ever arrives.
    expect(got).toBeUndefined();
  });

  it('falls back to the first listed workspace only once the item is confirmed UNMAPPED', () => {
    const got = resolveEditorPbiBinding({
      mapped: '', // resolved: no mapping
      listed: [{ id: FIRST_LISTED }, { id: MAPPED }],
      loomWorkspaceId: 'loom-ws-1',
    });
    expect(got).toBe(FIRST_LISTED);
  });

  it('ignores a mapping that points at a workspace the caller cannot see', () => {
    // A stale mapping must not pin an invisible group — that would guarantee the
    // 401 this change is meant to remove.
    const got = resolveEditorPbiBinding({
      mapped: MAPPED,
      listed: [{ id: FIRST_LISTED }],
      loomWorkspaceId: 'loom-ws-1',
    });
    expect(got).toBe(FIRST_LISTED);
  });

  it('does not block a `new` item (no Loom workspace to map from)', () => {
    const got = resolveEditorPbiBinding({ mapped: null, listed: [{ id: FIRST_LISTED }], loomWorkspaceId: '' });
    expect(got).toBe(FIRST_LISTED);
  });

  it('binds nothing when the caller can see no workspaces at all', () => {
    expect(resolveEditorPbiBinding({ mapped: MAPPED, listed: [], loomWorkspaceId: 'loom-ws-1' })).toBeUndefined();
  });
});
