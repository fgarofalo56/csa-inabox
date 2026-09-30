/**
 * refusalText / isAdminOnlyRefusal — the one reading of a BFF refusal envelope
 * shared by the #4619 surfaces. Each assertion names the input that breaks it.
 */
import { describe, it, expect } from 'vitest';
import { refusalText, isAdminOnlyRefusal } from '../admin-refusal';
import { tierQuery } from '@/lib/components/onelake/tier-dialog';

const ADMIN_ONLY = {
  ok: false, error: 'forbidden', code: 'admin_only',
  reason: 'Rules on a shared account can only be changed by a tenant admin.',
  remediation: 'Ask a tenant admin.',
};

describe('refusalText', () => {
  it('renders reason + remediation for admin_only, never the bare "forbidden" token', () => {
    // Breaks if the admin_only branch were removed: the fallback would return
    // j.error, which is "forbidden".
    const t = refusalText(ADMIN_ONLY, 403);
    expect(t).toBe(`${ADMIN_ONLY.reason} ${ADMIN_ONLY.remediation}`);
    expect(t).not.toMatch(/^forbidden$/);
  });

  it('falls back to a tenant-admin sentence when admin_only carries no text', () => {
    // Breaks if an empty join were returned: the user would see "".
    expect(refusalText({ ok: false, code: 'admin_only', error: 'forbidden' }, 403)).toMatch(/tenant admin/);
  });

  it('uses error for any other refusal (positive pair: the fallback still works)', () => {
    // Breaks if every refusal were rendered as the admin text.
    expect(refusalText({ ok: false, error: 'lakehouse not found' }, 404)).toBe('lakehouse not found');
    expect(refusalText({ ok: false, code: 'other', error: 'x', reason: 'r' }, 400)).toBe('x');
  });

  it('uses the HTTP status when there is no error text', () => {
    // Breaks if the status fallback were dropped.
    expect(refusalText({ ok: false }, 502)).toBe('HTTP 502');
    expect(refusalText(null)).toBe('The request failed.');
  });
});

describe('isAdminOnlyRefusal', () => {
  it('true only for ok:false + code admin_only', () => {
    // Breaks if it keyed on status or on error==="forbidden" alone.
    expect(isAdminOnlyRefusal(ADMIN_ONLY)).toBe(true);
    expect(isAdminOnlyRefusal({ ok: false, error: 'forbidden' })).toBe(false);
    expect(isAdminOnlyRefusal({ ok: true, code: 'admin_only' })).toBe(false);
    expect(isAdminOnlyRefusal(undefined)).toBe(false);
  });
});

describe('tierQuery (TierDialog GET)', () => {
  it('sends lakehouseId so the route can item-scope the read', () => {
    // Breaks if the dialog stopped sending lakehouseId: a non-admin's GET
    // would then be refused admin_only by the route.
    const qs = new URLSearchParams(tierQuery('lh-1', 'bronze', 'lakehouses/Sales/Files/a b.csv'));
    expect(qs.get('lakehouseId')).toBe('lh-1');
    expect(qs.get('container')).toBe('bronze');
    expect(qs.get('path')).toBe('lakehouses/Sales/Files/a b.csv');
  });

  it('omits lakehouseId when none is given (the unscoped admin tool)', () => {
    // Breaks if an empty lakehouseId= were sent (the route trims it to "" and
    // treats it as absent either way; this pins the wire shape only).
    expect(new URLSearchParams(tierQuery(undefined, 'bronze', 'a.csv')).has('lakehouseId')).toBe(false);
  });
});
