/**
 * Synapse Workspace Resources tree — notebook write affordance (#4619).
 *
 * The tree has no Loom item context, so it cannot send the `itemId` the
 * notebook write routes need from a non-admin; notebook create/delete here is
 * a tenant-admin action and is disabled, with a label that says why, for
 * everyone else. This pins the pure helper only. It does NOT witness that the
 * component passes the real `useIsTenantAdmin()` value into it (a call-site
 * mutation such as passing `true` would stay green here) — disclosed, not
 * counted as coverage of the wiring.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/components/ui/use-runtime-flag', () => ({ useRuntimeFlag: () => true }));

import { notebookWriteAction, NOTEBOOK_ADMIN_ONLY_HINT } from '../synapse-workspace-tree';

describe('notebookWriteAction', () => {
  it('a tenant admin gets enabled, plain-labelled actions (positive pair)', () => {
    // Breaks if admins are disabled too, or the hint leaks into the admin label.
    expect(notebookWriteAction('new', true, false)).toEqual({ label: 'New notebook', disabled: false });
    expect(notebookWriteAction('delete', true, false)).toEqual({ label: 'Delete', disabled: false });
  });

  it('a non-admin gets disabled actions whose label says why', () => {
    // Breaks if `!isTenantAdmin` is dropped from `disabled` (the action would
    // be clickable and every click a 403), or the explanatory hint is removed.
    for (const kind of ['new', 'delete'] as const) {
      const a = notebookWriteAction(kind, false, false);
      expect(a.disabled).toBe(true);
      expect(a.label).toContain(NOTEBOOK_ADMIN_ONLY_HINT);
    }
  });

  it('a busy tree disables the action even for an admin', () => {
    // Breaks if `busy` is dropped from `disabled` (double-submit while a
    // create/delete is in flight).
    expect(notebookWriteAction('new', true, true).disabled).toBe(true);
  });
});
