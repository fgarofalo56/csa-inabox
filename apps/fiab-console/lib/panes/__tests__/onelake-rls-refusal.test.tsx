/**
 * OnelakeRlsPredicateEditor: a refused RLS test or save shows the route's own
 * sentence and its next step, not a bare code.
 *
 * Seam test: the pane is fed the REAL refusal bodies. `clientFetch` routes the
 * two POSTs to the actual route handlers, called with a signed-in session that
 * is not a tenant admin, and the expected text is read from those same bodies
 * at runtime, never transcribed.
 *
 * What value breaks each assertion:
 *   - "Test failed": a pane that shows `j.error` alone. The rls-test refusal
 *     comes from `requireTenantAdmin`, whose `error` is the bare code
 *     'forbidden'; the sentence is in `reason` and the next step in
 *     `remediation`, so the rendered text lacks both.
 *   - "Could not save policy": a pane that drops `remediation`. The permissions
 *     write refusal carries its sentence in `error`, so only the next step is
 *     missing, and the `remediation` lookup fails.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const ADMIN_OID = 'oid-the-admin';

vi.mock('@/lib/auth/session', () => ({
  getSession: () => ({ claims: { oid: 'oid-member', upn: 'member@contoso.com' }, exp: Date.now() / 1000 + 3600 }),
}));
vi.mock('@/lib/components/editor/monaco-textarea', () => ({
  MonacoTextarea: () => <textarea aria-label="Row-level security WHERE predicate" />,
}));

/** A request object with the two members the routes read. */
function routeReq(url: string, body: unknown) {
  return { nextUrl: new URL(url), json: async () => body } as any;
}

vi.mock('@/lib/client-fetch', async () => {
  const rls = await import('@/app/api/lakehouse/permissions/rls-test/route');
  const perms = await import('@/app/api/lakehouse/permissions/route');
  return {
    clientFetch: async (url: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      if (url.startsWith('/api/lakehouse/permissions/rls-test')) {
        return (rls.POST as any)(routeReq(`http://x${url}`, body), {});
      }
      if (url.startsWith('/api/lakehouse/permissions?tab=column&list=columns')) {
        return new Response(JSON.stringify({ ok: true, columns: [{ columnId: 3, name: 'region', dataType: 'varchar' }] }));
      }
      if (url === '/api/lakehouse/permissions') {
        return (perms.POST as any)(routeReq(`http://x${url}`, body), {});
      }
      return new Response(JSON.stringify({ ok: false, error: `fixture: ${url} not under test` }));
    },
  };
});

import { OnelakeRlsPredicateEditor } from '../onelake-security-tab';
import { POST as rlsPOST } from '@/app/api/lakehouse/permissions/rls-test/route';
import { POST as permsPOST } from '@/app/api/lakehouse/permissions/route';

let savedAdmin: string | undefined;
beforeEach(() => {
  savedAdmin = process.env.LOOM_TENANT_ADMIN_OID;
  process.env.LOOM_TENANT_ADMIN_OID = ADMIN_OID;
});
afterEach(() => {
  cleanup();
  if (savedAdmin === undefined) delete process.env.LOOM_TENANT_ADMIN_OID;
  else process.env.LOOM_TENANT_ADMIN_OID = savedAdmin;
});

async function mountWithTableAndColumn() {
  render(
    <FluentProvider theme={webLightTheme}>
      <OnelakeRlsPredicateEditor tables={[{ objectId: 7, schema: 'dbo', name: 'orders', type: 'U' }]} />
    </FluentProvider>,
  );
  const [tableDd, colDd] = screen.getAllByRole('combobox');
  fireEvent.click(tableDd);
  fireEvent.click(await screen.findByRole('option', { name: 'dbo.orders' }));
  // The column list loads after the table is picked.
  await vi.waitFor(() => expect(colDd).not.toBeDisabled());
  fireEvent.click(colDd);
  fireEvent.click(await screen.findByRole('option', { name: 'region (varchar)' }));
}

describe('OnelakeRlsPredicateEditor refusals', () => {
  it('shows the rls-test refusal sentence and its next step', async () => {
    const refused = await (await (rlsPOST as any)(routeReq('http://x/api/lakehouse/permissions/rls-test', {}), {})).json();
    // The fixture reaches the rule: a 403 whose error is the bare code.
    expect([refused.error, typeof refused.reason, typeof refused.remediation]).toEqual(['forbidden', 'string', 'string']);

    await mountWithTableAndColumn();
    fireEvent.click(screen.getByRole('button', { name: 'Test predicate' }));
    const title = await screen.findByText('Test failed');
    const bar = title.closest('[class*="fui-MessageBarBody"]') as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.textContent).toContain(refused.reason);
    expect(bar.textContent).toContain(refused.remediation);
  });

  it('shows the save refusal sentence and its next step', async () => {
    const refused = await (await (permsPOST as any)(routeReq('http://x/api/lakehouse/permissions', { tab: 'row' }), {})).json();
    expect([refused.code, typeof refused.error, typeof refused.remediation]).toEqual(['admin_only', 'string', 'string']);

    await mountWithTableAndColumn();
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    const title = await screen.findByText('Could not save policy');
    const bar = title.closest('[class*="fui-MessageBarBody"]') as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.textContent).toContain(refused.error);
    expect(bar.textContent).toContain(refused.remediation);
  });
});
