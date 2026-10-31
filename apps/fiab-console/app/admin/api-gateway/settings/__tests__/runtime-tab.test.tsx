/**
 * Settings -> Runtime (W1-8): shows the group holding apiplane-admin, or the remediation
 * with a Fix it link to /admin/permissions when none does.
 *
 * Breaking values: a tab that ignores `groups` never renders the display name below; a tab that
 * drops the remediation branch never renders the "No Entra group" text or the Grant link.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

let payload: unknown = {};
vi.mock('@/lib/client-fetch', () => ({
  clientFetch: async () => ({ status: 200, json: async () => payload }),
}));

import { RuntimeTab } from '../runtime-tab';

afterEach(cleanup);

describe('RuntimeTab', () => {
  it('names the group that holds the capability', async () => {
    payload = { ok: true, data: { capability: 'apiplane-admin', groups: [{ id: 'grp-1', displayName: 'Loom API Plane Admins', role: 'Admin' }], users: 0, capabilityUsed: 'tenant-admin', remediation: null } };
    render(<RuntimeTab />);
    await waitFor(() => expect(screen.getByText('Loom API Plane Admins')).toBeTruthy());
    expect(screen.queryByText(/No Entra group holds/)).toBeNull();
  });

  it('with no holder shows the remediation and a Grant link to /admin/permissions', async () => {
    payload = { ok: true, data: { capability: 'apiplane-admin', groups: [], users: 0, capabilityUsed: 'tenant-admin', remediation: 'No Entra group holds the apiplane-admin capability yet.' } };
    render(<RuntimeTab />);
    await waitFor(() => expect(screen.getByText(/No Entra group holds the apiplane-admin capability yet/)).toBeTruthy());
    expect(screen.getByText('Grant to a group').closest('a')?.getAttribute('href')).toBe('/admin/permissions');
  });
});
