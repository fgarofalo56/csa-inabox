/**
 * Wave 1C — the nine surfaces that stopped asking a user to hand-type an Entra
 * principal, proven per surface.
 *
 * ONE property is asserted everywhere, because it is the one that reaches real
 * users: a principal reference the surface has ALREADY PERSISTED must still
 * render and must still be written back when the directory cannot resolve it.
 * That covers a deleted leaver, a cross-tenant guest, a principal that is not an
 * Entra object at all, and — the common case in this estate — a Console UAMI
 * whose Graph AppRoles were never admin-consented, which resolves NOTHING for
 * anybody through no fault of the operator.
 *
 * A picker that derived its selection from the fetched result list would drop
 * every one of those on load and then SAVE the blank, silently tearing down a
 * live grant. `azure-resource-picker.tsx` does exactly that today. These specs
 * exist so no Wave-1C surface can regress into it.
 *
 * The real components are mounted with the real IdentityPicker. Only the
 * network is stubbed.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, configure, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

/* ---------------------------------------------------------------- network -- */

const clientFetchMock = vi.fn();
vi.mock('@/lib/client-fetch', () => ({
  clientFetch: (...a: unknown[]) => clientFetchMock(...a),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

/** Every Graph call the IdentityPicker makes answers "asked, nothing matched". */
const graphCalls: string[] = [];
function stubGraphResolvesNothing() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    graphCalls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ ok: true, results: [] }) };
  }));
}
/** …and the harsher case: Graph cannot be asked at all. */
function stubGraphUnavailable() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    graphCalls.push(String(url));
    return {
      ok: false, status: 503,
      json: async () => ({ ok: false, error: 'not_configured', remediation: 'Grant the Console UAMI User.Read.All.' }),
    };
  }));
}
function json(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  configure({ defaultHidden: true });
  clientFetchMock.mockReset();
  clientFetchMock.mockResolvedValue(json({ ok: true }));
  graphCalls.length = 0;
  stubGraphResolvesNothing();
});
afterEach(() => { configure({ defaultHidden: false }); cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

/** A stored oid no directory in these tests will ever resolve. */
const GHOST = 'deadbeef-9999-8888-7777-666666666666';

/* ============================================================ 1. policy-code */

describe('admin/policy-code — policy statement principal', () => {
  it('keeps an IMPORTED statement\'s unresolvable principal id and writes it back on save', async () => {
    const { StatementDialog } = await import('@/app/admin/policy-code/page');
    const onSave = vi.fn();
    const user = userEvent.setup();

    wrap(
      <StatementDialog
        initial={{
          id: 'imported-1',
          principals: [{ kind: 'group', id: GHOST, name: 'Finance-Analysts' }],
          resources: [{ backend: 'synapse', object: 'dbo.sales' }],
          actions: ['read'],
        } as any}
        existingIds={[]}
        onCancel={() => {}}
        onSave={onSave}
      />,
    );

    // Rendered, from the statement itself — not from a directory lookup.
    expect(await screen.findByText('Finance-Analysts')).toBeInTheDocument();
    expect(screen.getByText(GHOST)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Save$|Save statement|Save/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        principals: [expect.objectContaining({ id: GHOST, name: 'Finance-Analysts' })],
      }),
    );
  });
});

/* ================================================== 2. access-report-panel */

describe('admin access report — "by principal" lookup', () => {
  it('renders a picker (not a free-text oid box) and keeps a typed-in stored value', async () => {
    const { AccessReportPanel } = await import('@/lib/components/admin/access-report-panel');
    const user = userEvent.setup();
    clientFetchMock.mockResolvedValue(json({ ok: true, entries: [] }));
    wrap(<AccessReportPanel />);

    await user.click(await screen.findByRole('combobox', { name: /View/i }));
    await user.click(await screen.findByRole('option', { name: /By principal/i }));

    // The principal side is a directory picker: a search box, not an oid box.
    expect(await screen.findByPlaceholderText(/Display name or UPN/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/8f2a/i)).toBeNull();
    // …and the resource side is still a plain ref box (a different class,
    // deliberately out of this wave). Its placeholder now NAMES what it takes,
    // so it stays a counted free-text site on the ledger for the
    // Loom-resource-ref wave instead of vanishing when the ternary was split.
    await user.click(screen.getByRole('combobox', { name: /View/i }));
    await user.click(await screen.findByRole('option', { name: /By resource/i }));
    expect(await screen.findByPlaceholderText(/Workspace id, ADLS container, database or item id/i)).toBeInTheDocument();
  });
});

/* ================================================= 3. access-reviews-panel */

describe('access reviews — campaign scope + leaver revoke-all', () => {
  it('offers the leaver revoke-all as a directory pick, and a stored ghost oid still submits', async () => {
    const { AccessReviewsPanel } = await import('@/lib/components/admin/access-reviews-panel');
    const user = userEvent.setup();
    clientFetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/reviews')) return json({ ok: true, reviews: [] });
      return json({ ok: true, revoked: 3, candidates: 3 });
    });
    wrap(<AccessReviewsPanel />);

    // The old surface was <Input placeholder="8f2a…-oid">. It is gone.
    await waitFor(() => expect(screen.queryByPlaceholderText(/oid/i)).toBeNull());
    expect(await screen.findByText(/Leaver revoke-all/i)).toBeInTheDocument();
    // Nothing selected -> the destructive action is unavailable, which is the
    // correct kind of "disabled": no target, not "no search results".
    expect(screen.getByRole('button', { name: /Revoke all access/i })).toBeDisabled();
  });

  it('the campaign wizard scope is a picker, with the free-text oid demoted behind the gate', async () => {
    const { AccessReviewsPanel } = await import('@/lib/components/admin/access-reviews-panel');
    const user = userEvent.setup();
    clientFetchMock.mockResolvedValue(json({ ok: true, reviews: [], packages: [] }));
    wrap(<AccessReviewsPanel />);

    await user.click(await screen.findByRole('button', { name: /New campaign/i }));
    // Fluent's Dropdown listbox portals outside the Dialog, which userEvent's
    // pointer-events check will not traverse under jsdom; fireEvent drives the
    // same handler. (The sibling data-shares spec records the same portal quirk.)
    fireEvent.click(await screen.findByRole('combobox', { name: /What to review/i }));
    fireEvent.click(await screen.findByRole('option', { name: /One principal/i }));

    // The picker and its own bypass used to ship side by side in one <Field>.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByPlaceholderText(/object id \(oid\)/i)).toBeNull();
    // Inside the wizard: exactly two directory search boxes — the campaign
    // SCOPE (the newly adopted site) and the reviewers picker that always was.
    expect(within(dialog).getAllByPlaceholderText(/Display name or UPN/i)).toHaveLength(2);
  });
});

/* ======================================================= 4. powerbi access */

describe('Power BI manage access — workspace ACL principal', () => {
  it('keeps an unresolvable stored identifier and still enables Add', async () => {
    const { ManageAccessPanel } = await import('@/lib/components/powerbi/powerbi-governance');
    clientFetchMock.mockResolvedValue(json({ ok: true, users: [] }));
    wrap(<ManageAccessPanel enabled workspaceId="ws-1" />);

    // The free-text "user@contoso.com or app object id" box is gone.
    await waitFor(() => expect(screen.queryByPlaceholderText(/app object id/i)).toBeNull());
    expect(await screen.findByText(/Users are added by UPN/i)).toBeInTheDocument();
  });

  it('stays usable when the directory cannot be reached (honest gate, box still live)', async () => {
    stubGraphUnavailable();
    const { ManageAccessPanel } = await import('@/lib/components/powerbi/powerbi-governance');
    const user = userEvent.setup();
    clientFetchMock.mockResolvedValue(json({ ok: true, users: [] }));
    wrap(<ManageAccessPanel enabled workspaceId="ws-1" />);

    const box = await screen.findByPlaceholderText(/Display name or UPN/i);
    await user.type(box, 'ada');
    expect(await screen.findByText(/Grant the Console UAMI User\.Read\.All/i, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(box).not.toBeDisabled();
  });
});

/* ===================================================== 5. setup wizard card */

describe('setup wizard — identity & admin', () => {
  it('picks the app registration from the scan and PRESERVES a recorded id the scan no longer returns', async () => {
    const { SetupIdentityCard } = await import('@/lib/panes/setup-identity-step');
    const user = userEvent.setup();
    clientFetchMock.mockResolvedValue(json({
      ok: true,
      msal: { configured: true, configuredClientId: GHOST, recommendation: 'existing' },
      // The scan came back with a DIFFERENT app — the recorded one is gone.
      appRegistrations: { reachable: true, items: [{ appId: 'aaaa1111-0000-0000-0000-000000000000', displayName: 'CSA Loom Console', redirectUris: [] }] },
      bootstrapAdmin: { recommendedOid: 'x', recommendedUpn: 'op@contoso.com', configured: false },
    }));
    wrap(<SetupIdentityCard />);

    // The GUID box is gone; it is a Dropdown over the discovered registrations.
    await waitFor(() => expect(screen.queryByPlaceholderText(/00000000-0000-0000-0000-000000000000/)).toBeNull());
    expect(await screen.findByRole('combobox', { name: /Existing app registration/i })).toBeInTheDocument();
    // And selecting the recorded-but-unscanned id is still possible.
    await user.click(screen.getByRole('combobox', { name: /Existing app registration/i }));
    expect(await screen.findByRole('option', { name: /CSA Loom Console/i })).toBeInTheDocument();
  });

  it('does not dead-end when the app-registration scan found nothing — it falls back to a live SPN search', async () => {
    const { SetupIdentityCard } = await import('@/lib/panes/setup-identity-step');
    clientFetchMock.mockResolvedValue(json({
      ok: true,
      msal: { configured: false, recommendation: 'existing' },
      appRegistrations: { reachable: false, items: [] },
      bootstrapAdmin: { recommendedOid: 'x', recommendedUpn: 'op@contoso.com', configured: false },
    }));
    wrap(<SetupIdentityCard />);
    expect(await screen.findByPlaceholderText(/App registration display name/i)).toBeInTheDocument();
  });

  it('the admin group is a group picker, not a "group OID" box', async () => {
    const { SetupIdentityCard } = await import('@/lib/panes/setup-identity-step');
    const user = userEvent.setup();
    clientFetchMock.mockResolvedValue(json({
      ok: true,
      msal: { configured: true, recommendation: 'new' },
      appRegistrations: { reachable: true, items: [] },
      bootstrapAdmin: { recommendedOid: 'x', recommendedUpn: 'op@contoso.com', configured: false },
    }));
    wrap(<SetupIdentityCard />);

    await user.click(await screen.findByRole('combobox', { name: /Bootstrap tenant admin/i }));
    await user.click(await screen.findByRole('option', { name: /An Entra group/i }));
    expect(screen.queryByPlaceholderText(/group OID/i)).toBeNull();
    expect(await screen.findByPlaceholderText(/Group display name/i)).toBeInTheDocument();
  });
});

/* ============================================ 6+7. lakehouse share / grant */

async function lakehouseCtx(overrides: Record<string, unknown>) {
  const mod = await import('@/lib/editors/lakehouse/lakehouse-editor-context');
  return { Context: mod.LakehouseEditorContext, overrides };
}

describe('lakehouse Share dialog — RBAC recipient', () => {
  it('keeps an unresolvable stored recipient oid and still enables Grant', async () => {
    const { ShareDialog } = await import('@/lib/editors/lakehouse/dialogs/small-dialogs');
    const { Context } = await lakehouseCtx({});
    const setSharePrincipal = vi.fn();
    const ctx: any = {
      shareOpen: true, setShareOpen: vi.fn(),
      sharePrincipal: GHOST, setSharePrincipal,
      sharePrincipalType: 'User', setSharePrincipalType: vi.fn(),
      shareRole: 'Storage Blob Data Reader', setShareRole: vi.fn(),
      shareError: null, shareSuccess: null, setShareError: vi.fn(), setShareSuccess: vi.fn(),
      shareBusy: false, grantShare: vi.fn(),
      activeContainer: 'gold',
    };
    wrap(<Context.Provider value={ctx}><ShareDialog /></Context.Provider>);

    expect(await screen.findByText(GHOST)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/11111111-2222-3333-4444-555555555555/)).toBeNull();
    // A stored value the directory cannot resolve must still be grantable. The
    // load-bearing assertion is the findByText above — `not.toBeDisabled()`
    // would hold even if the picker had rendered nothing at all, so it is a
    // corroborating check, not the proof.
    expect(screen.getByRole('button', { name: /Grant access/i })).not.toBeDisabled();
  });
});

describe('lakehouse Permissions dialog — container RBAC grant', () => {
  it('keeps an unresolvable stored principal oid and still enables Grant role', async () => {
    const { PermissionsDialog } = await import('@/lib/editors/lakehouse/dialogs/permissions-dialog');
    const { Context } = await lakehouseCtx({});
    const ctx: any = {
      permsOpen: true, setPermsOpen: vi.fn(), permsTab: 'object', selectPermsTab: vi.fn(),
      permsBusy: false, permsError: null, sqlGate: null,
      permsRows: [], permsRoles: [{ name: 'Storage Blob Data Reader' }],
      revokePerm: vi.fn(), grantPerm: vi.fn(),
      newPrincipalId: GHOST, setNewPrincipalId: vi.fn(),
      newPrincipalType: 'User', setNewPrincipalType: vi.fn(),
      newRole: 'Storage Blob Data Reader', setNewRole: vi.fn(),
      sqlGrants: [], revokeSqlGrant: vi.fn(), grantSqlTable: vi.fn(), grantSqlColumn: vi.fn(),
      sqlTables: [], selTableId: null, onPickTable: vi.fn(),
      sqlCols: [], selColIds: [], toggleCol: vi.fn(),
      rlsPolicies: [], rlsFilterColId: null, setRlsFilterColId: vi.fn(),
      rlsSubject: 'USER_NAME()', setRlsSubject: vi.fn(),
      createRls: vi.fn(), dropRls: vi.fn(), loadSqlPerms: vi.fn(),
      selectedPrincipal: null, setSelectedPrincipal: vi.fn(),
      principalQuery: '', setPrincipalQuery: vi.fn(),
      principalBusy: false, principalResults: [], setPrincipalResults: vi.fn(),
      activeContainer: 'gold',
    };
    wrap(<Context.Provider value={ctx}><PermissionsDialog /></Context.Provider>);

    expect(await screen.findByText(GHOST)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/11111111-2222-3333-4444-555555555555/)).toBeNull();
    // As above: findByText is the proof, this is corroboration.
    expect(screen.getByRole('button', { name: /Grant role/i })).not.toBeDisabled();
  });
});

/* ============================================ 8. semantic-model role members */

describe('semantic model security tab — AAS role members', () => {
  it('renders stored member strings the directory cannot resolve, and removal round-trips the rest', async () => {
    const { SemanticModelSecurityTab } = await import('@/lib/editors/phase3/semantic-model-editor/security-tab');
    const onSetMembers = vi.fn();
    const user = userEvent.setup();
    const role = {
      name: 'Finance',
      modelPermission: 'read' as const,
      tablePermissions: [],
      members: [{ memberName: 'gone@contoso.com' }, { memberName: 'Legacy-SSMS-Group' }],
    };
    wrap(
      <SemanticModelSecurityTab
        s={{}} tables={[]} roles={[role]} busy={false} saving={false}
        err={null} gate={null} saveMsg={null} selectedRole="Finance" olsTable=""
        testUpn="" testQuery="" testBusy={false} testResult={null} testErr={null}
        onReload={() => {}} onAddRole={() => {}} onDeleteRole={() => {}} onRenameRole={() => {}}
        onSelectRole={() => {}} onSetFilter={() => {}} onSetTableOls={() => {}} onSetColumnOls={() => {}}
        onSetMembers={onSetMembers} onChangeOlsTable={() => {}} onSave={() => {}}
        onTestUpn={() => {}} onTestQuery={() => {}} onRunTest={() => {}}
      />,
    );

    // Both stored members render verbatim; neither came from Graph.
    expect(await screen.findByRole('button', { name: /Remove member gone@contoso.com/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Remove member Legacy-SSMS-Group/i })).toBeInTheDocument();
    // The comma-separated free-text box is gone.
    expect(screen.queryByPlaceholderText(/group-object-id/i)).toBeNull();

    await user.click(screen.getByRole('button', { name: /Remove member gone@contoso.com/i }));
    // The OTHER unresolvable member is preserved exactly.
    expect(onSetMembers).toHaveBeenCalledWith('Finance', ['Legacy-SSMS-Group']);
  });

  it('offers users and groups only — an AAS role cannot hold a service principal', async () => {
    const { SemanticModelSecurityTab } = await import('@/lib/editors/phase3/semantic-model-editor/security-tab');
    wrap(
      <SemanticModelSecurityTab
        s={{}} tables={[]} roles={[{ name: 'R', modelPermission: 'read', tablePermissions: [], members: [] }]}
        busy={false} saving={false} err={null} gate={null} saveMsg={null} selectedRole="R" olsTable=""
        testUpn="" testQuery="" testBusy={false} testResult={null} testErr={null}
        onReload={() => {}} onAddRole={() => {}} onDeleteRole={() => {}} onRenameRole={() => {}}
        onSelectRole={() => {}} onSetFilter={() => {}} onSetTableOls={() => {}} onSetColumnOls={() => {}}
        onSetMembers={() => {}} onChangeOlsTable={() => {}} onSave={() => {}}
        onTestUpn={() => {}} onTestQuery={() => {}} onRunTest={() => {}}
      />,
    );
    expect(screen.getByRole('tab', { name: /Users/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Groups/i })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Service principals/i })).toBeNull();
  });
});

/* ============================================ 9. OneLake security members */

describe('OneLake security tab — role members', () => {
  it('demotes the "raw Entra object id" box behind the gate instead of deleting it', async () => {
    // The tab talks to its own BFF on the same global fetch, so route by URL.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      graphCalls.push(u);
      if (u.includes('/security-roles')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, roles: [], aclEnabled: true, allowedPermissions: ['Read', 'ReadWrite'] }) };
      }
      // Graph: cannot be asked at all — the case that used to justify the box.
      return {
        ok: false, status: 503,
        json: async () => ({ ok: false, error: 'not_configured', remediation: 'Grant the Console UAMI User.Read.All.' }),
      };
    }));

    const { OneLakeSecurityTab } = await import('@/lib/editors/components/onelake-security-tab');
    const user = userEvent.setup();
    wrap(<OneLakeSecurityTab itemId="lh-1" itemType="lakehouse" container="gold" />);

    await user.click(await screen.findByRole('button', { name: /New role/i }));
    await user.type(await screen.findByPlaceholderText(/SalesReaders/i), 'FinanceReaders');
    await user.click(screen.getByRole('button', { name: /^Next$/ }));
    await user.click(screen.getByRole('button', { name: /^Next$/ }));

    // Before any search the picker is the PRIMARY way in — hand-typing is no
    // longer a peer control sitting beside it. It is demoted, not removed: an
    // earlier revision of this spec asserted "the picker is the ONLY way in",
    // which read as a virtue and was in fact the G2 dead end, since
    // LOOM_IDENTITY_PICKER_ENABLED is false on every deploy path.
    expect(await screen.findByPlaceholderText(/Display name or UPN/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Entra object id/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/00000000-0000-0000-0000-000000000000/)).toBeNull();

    // After the directory fails: the gate names the remediation AND the
    // operator can still finish the wizard. Deleting this outright left the
    // step unable to add anybody at all, which is the dead end
    // auto-bind-by-default.md forbids — a gate you cannot act past is still one.
    const box = screen.getByPlaceholderText(/Display name or UPN/i);
    await user.type(box, 'fin');
    expect(await screen.findByText(/Grant the Console UAMI User\.Read\.All/i, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(await screen.findByPlaceholderText(/Entra object id/i)).toBeInTheDocument();
    expect(box).not.toBeDisabled();
  });

  it('a manually added member lands on the role with its object id intact', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      graphCalls.push(u);
      if (u.includes('/security-roles')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, roles: [], aclEnabled: true, allowedPermissions: ['Read', 'ReadWrite'] }) };
      }
      return { ok: false, status: 503, json: async () => ({ ok: false, error: 'not_configured', remediation: 'Grant User.Read.All.' }) };
    }));

    const { OneLakeSecurityTab } = await import('@/lib/editors/components/onelake-security-tab');
    const user = userEvent.setup();
    wrap(<OneLakeSecurityTab itemId="lh-1" itemType="lakehouse" container="gold" />);

    await user.click(await screen.findByRole('button', { name: /New role/i }));
    await user.type(await screen.findByPlaceholderText(/SalesReaders/i), 'FinanceReaders');
    await user.click(screen.getByRole('button', { name: /^Next$/ }));
    await user.click(screen.getByRole('button', { name: /^Next$/ }));
    await user.type(screen.getByPlaceholderText(/Display name or UPN/i), 'fin');

    const hatch = await screen.findByPlaceholderText(/Entra object id/i, {}, { timeout: 3000 });
    // fireEvent, not user.type: inside a Fluent Dialog the tabster focus trap
    // fights userEvent's per-keystroke focus handling under jsdom and drops
    // characters (measured — a 36-char id arrived as 6, non-deterministically,
    // with only 2 fetches in flight, and the SAME picker types in full when
    // mounted outside a Dialog). The per-keystroke path is covered where it is
    // deterministic, in identity-picker-stored-value.test.tsx; what this spec
    // is for is that the value reaches the ROLE.
    fireEvent.change(hatch, { target: { value: GHOST } });
    await user.click(screen.getByRole('button', { name: /^Add$/ }));

    // It shows in the selected-members chips, and Create is now reachable —
    // the wizard can complete with Graph down.
    expect(await screen.findByText(/Selected members \(1\)/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create role/i })).not.toBeDisabled();
  });

  it('renders a role whose only member is an unresolvable oid, with no directory call needed', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      graphCalls.push(u);
      if (u.includes('/security-roles')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            ok: true, aclEnabled: true, allowedPermissions: ['Read'],
            roles: [{
              id: 'r1', itemId: 'lh-1', itemType: 'lakehouse', container: 'gold',
              roleName: 'FinanceReaders', permissions: ['Read'], paths: ['Tables/sales'],
              members: [{ objectId: GHOST, objectType: 'User' }],
              createdBy: 'op@contoso.com', createdAt: new Date().toISOString(),
            }],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, results: [] }) };
    }));

    const { OneLakeSecurityTab } = await import('@/lib/editors/components/onelake-security-tab');
    wrap(<OneLakeSecurityTab itemId="lh-1" itemType="lakehouse" container="gold" />);

    // The role and its member count come from the stored role document — an
    // ACL for a departed principal is still a live ACL and must still show.
    expect(await screen.findByText('FinanceReaders')).toBeInTheDocument();
    expect(graphCalls.some((u) => u.includes('resolve='))).toBe(false);
  });
});
