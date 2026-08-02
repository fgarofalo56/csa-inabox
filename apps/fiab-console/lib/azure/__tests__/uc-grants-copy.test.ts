/**
 * #2651 — the Grants pane's effective-permissions copy must be selected on the
 * BACKEND THAT ANSWERED, not only on `effective` / `forPrincipal` /
 * `closureResolved`.
 *
 * The regression these lock down: on the Databricks backend the pane rendered
 * "Nobody holds any privilege here — no direct grant, no inherited grant, no
 * owner." for `CATALOG finance`, which demonstrably HAS an owner. Databricks'
 * permissions APIs never return an owner's implied privileges, so an empty
 * effective answer is not evidence of an unowned securable.
 *
 * The OSS cases are CONTROLS: that backend's resolver folds ownership into the
 * assignments itself, so its copy is correct and must stay byte-identical. They
 * pass with and without the fix — an over-broad change to "make Databricks
 * honest" that also rewrote the OSS strings would fail here.
 */
import { describe, it, expect } from 'vitest';
import { ucEffectiveEmptyState, ucGrantsCaption } from '../uc-grants-copy';

const OWNER = 'f4f25dd9-0000-0000-0000-000000000000';

describe('ucEffectiveEmptyState — Databricks backend (#2651)', () => {
  it('never claims "no owner" — the backend answer does not cover ownership', () => {
    const s = ucEffectiveEmptyState({ backend: 'databricks', securableType: 'CATALOG', owner: OWNER });
    expect(s).not.toContain('no owner');
    expect(s).not.toContain('Nobody holds any privilege here');
  });

  it('names the owner Loom read alongside the passthrough', () => {
    const s = ucEffectiveEmptyState({ backend: 'databricks', securableType: 'CATALOG', owner: OWNER });
    expect(s).toContain(OWNER);
    expect(s).toContain('owns this catalog');
    expect(s).toContain('Databricks reported no privilege assignments here.');
  });

  it('states the omission even when the backend records no owner at all', () => {
    const s = ucEffectiveEmptyState({ backend: 'databricks', securableType: 'METASTORE' });
    expect(s).not.toContain('no owner');
    expect(s).toContain('Ownership is not part of that answer');
  });

  it('does not assert "unowned" — and names nobody — when the owner read FAILED', () => {
    const s = ucEffectiveEmptyState({ backend: 'databricks', securableType: 'SCHEMA', ownerUnreadable: true });
    expect(s).toContain('could not read this schema');
    expect(s).toContain('not evidence that it is unowned');
    expect(s).not.toContain('no owner');
    expect(s).not.toContain(OWNER);
  });

  it('an unreadable owner wins over a stale owner value — never names one it could not confirm', () => {
    const s = ucEffectiveEmptyState({
      backend: 'databricks', securableType: 'TABLE', owner: OWNER, ownerUnreadable: true,
    });
    expect(s).not.toContain(OWNER);
    expect(s).toContain("could not read this table's owner");
    expect(s).toContain('Databricks reported no privilege assignments here.');
  });

  it('scoped to a principal: no ownership claim, and no phantom group warning', () => {
    const s = ucEffectiveEmptyState({
      backend: 'databricks', securableType: 'CATALOG', forPrincipal: 'ada@contoso.com',
      closureResolved: false, owner: OWNER,
    });
    expect(s).toContain('Databricks reported no effective privilege for ada@contoso.com here.');
    // The old copy pointed at a "warning above" that only the OSS resolver emits.
    expect(s).not.toContain('Group memberships were NOT resolved');
    expect(s).not.toContain('not through ownership');
    expect(s).toContain(OWNER);
  });

  it('is never the OSS sentence for any Databricks input shape', () => {
    for (const input of [
      { backend: 'databricks' as const, securableType: 'CATALOG' },
      { backend: 'databricks' as const, securableType: 'CATALOG', owner: OWNER },
      { backend: 'databricks' as const, securableType: 'CATALOG', ownerUnreadable: true },
      { backend: 'databricks' as const, securableType: 'CATALOG', forPrincipal: 'ada@contoso.com', closureResolved: true },
      { backend: 'databricks' as const, securableType: 'CATALOG', forPrincipal: 'ada@contoso.com', closureResolved: false },
    ]) {
      expect(ucEffectiveEmptyState(input)).not.toContain('no owner');
    }
  });
});

describe('ucEffectiveEmptyState — OSS backend (CONTROL: copy must not change)', () => {
  it('keeps the unscoped sentence verbatim — the OSS resolver DID check ownership', () => {
    expect(ucEffectiveEmptyState({ backend: 'oss', securableType: 'CATALOG' }))
      .toBe('Nobody holds any privilege here — no direct grant, no inherited grant, no owner.');
  });

  it('keeps the resolved-closure sentence verbatim', () => {
    expect(ucEffectiveEmptyState({
      backend: 'oss', securableType: 'CATALOG', forPrincipal: 'ada@contoso.com', closureResolved: true,
    })).toBe('ada@contoso.com holds no privileges here — not directly, not from a parent, not through ownership, and not through any group it belongs to.');
  });

  it('keeps the unresolved-closure sentence verbatim', () => {
    expect(ucEffectiveEmptyState({
      backend: 'oss', securableType: 'CATALOG', forPrincipal: 'ada@contoso.com', closureResolved: false,
    })).toBe('ada@contoso.com holds no privileges here from any grant, parent or owner that Loom could read. Group memberships were NOT resolved (see the warning above), so a privilege held via a group would not appear.');
  });

  it('trims the principal, as the pane did inline', () => {
    expect(ucEffectiveEmptyState({
      backend: 'oss', securableType: 'CATALOG', forPrincipal: '  ada@contoso.com  ', closureResolved: true,
    })).toContain('ada@contoso.com holds no privileges');
  });
});

describe('ucGrantsCaption', () => {
  it('Databricks: describes what THAT backend computed, and discloses the ownership gap', () => {
    const c = ucGrantsCaption({ effective: true, backend: 'databricks' });
    expect(c).toContain('Ownership is NOT part of that answer');
    expect(c).toContain('Loom does not re-compute any of it');
    // The old caption promised the OSS resolver's work on this backend.
    expect(c).not.toContain('add what ownership implies');
    expect(c).not.toContain('union in its transitive group memberships');
  });

  it('OSS (CONTROL): still describes the resolver it actually runs', () => {
    const c = ucGrantsCaption({ effective: true, backend: 'oss' });
    expect(c).toContain('add what ownership implies');
    expect(c).toContain('union in its transitive group memberships');
    expect(c).toContain('Resolved by the Loom BFF from the OSS catalog’s direct grants.');
  });

  it('direct-grants mode (CONTROL): identical on both backends', () => {
    const dbx = ucGrantsCaption({ effective: false, backend: 'databricks' });
    expect(dbx).toBe(ucGrantsCaption({ effective: false, backend: 'oss' }));
    expect(dbx).toBe('Showing the grants recorded directly on this securable. Tick “Effective (inherited)” to include everything inherited from its parents and from ownership.');
  });
});
