/**
 * THE DEFAULT DEPLOYMENT — every adopted surface, against the REAL gate.
 *
 * `LOOM_IDENTITY_PICKER_ENABLED` is false on every deploy path in this repo
 * (main.bicep:134, admin-plane/main.bicep:2082, commercial.bicepparam hard-false,
 * commercial-full / tenant-dmlz via readEnvironmentVariable(…,'false'), unset in
 * gcc / gcc-high / il5, set by no workflow). So the DEFAULT state of every
 * surface that adopted <IdentityPicker> is: the BFF 503s `not_configured` and
 * the picker cannot search.
 *
 * The first review of this wave shipped the escape hatch OPT-IN, which made ten
 * of those surfaces unusable in exactly that default — each having shipped a
 * working `<Input>` beforehand. The jsdom suites did not catch it because they
 * stub `fetch` with hand-written bodies and therefore never exercised the gate.
 *
 * So this spec does NOT hand-write the 503. It runs the REAL route handler with
 * the env unset, captures the REAL response body, and feeds THAT to the picker
 * — per `csa_loom_fixtures_that_model_the_code`: run the real dependency and
 * compare byte-for-byte, because a fixture that models the code instead of
 * executing it will agree with a bug.
 */
import React from 'react';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, configure, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const clientFetchMock = vi.fn();
vi.mock('@/lib/client-fetch', () => ({ clientFetch: (...a: unknown[]) => clientFetchMock(...a) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/', useSearchParams: () => new URLSearchParams(),
}));
// The route requires a session + admin.permissions::Reader. Both are satisfied
// so the test exercises the ENV gate specifically, not the auth gate.
vi.mock('@/lib/auth/session', () => ({ getSession: () => ({ oid: 'op', upn: 'op@contoso.com' }) }));
vi.mock('@/lib/auth/feature-gate', () => ({ enforceCapability: async () => null }));

/** The REAL 503 body, captured from the REAL handler with the env unset. */
let GATE_BODY: any;
let GATE_STATUS = 0;

beforeAll(async () => {
  delete process.env.LOOM_IDENTITY_PICKER_ENABLED;
  process.env.LOOM_UAMI_CLIENT_ID = 'test-uami';
  const { GET } = await import('@/app/api/governance/identities/search/route');
  const res: any = await GET(
    { nextUrl: { searchParams: new URLSearchParams({ q: 'ada', kind: 'user' }) } } as any,
    { params: Promise.resolve({}) } as any,
  );
  GATE_STATUS = res.status;
  GATE_BODY = await res.json();
});

const GHOST = 'deadbeef-9999-8888-7777-666666666666';

beforeEach(() => {
  configure({ defaultHidden: true });
  clientFetchMock.mockReset();
  clientFetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
  // Every picker call answers with the REAL gate the real deployment produces.
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/security-roles')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, roles: [], aclEnabled: true, allowedPermissions: ['Read', 'ReadWrite'] }) };
    }
    return { ok: false, status: GATE_STATUS, json: async () => GATE_BODY };
  }));
});
afterEach(() => { configure({ defaultHidden: false }); cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

/** Type into the search box, wait for the gate, then return the hatch. */
async function driveToHatch(user: ReturnType<typeof userEvent.setup>, box: HTMLElement) {
  await user.type(box, 'ada');
  return screen.findByPlaceholderText(/Entra object id/i, {}, { timeout: 3000 });
}

/* ------------------------------------------------------------------ */

describe('the captured gate is the real one', () => {
  it('the REAL route 503s not_configured when the env is unset — the default deployment', () => {
    expect(GATE_STATUS).toBe(503);
    expect(GATE_BODY.ok).toBe(false);
    expect(GATE_BODY.error).toBe('not_configured');
    expect(GATE_BODY.hint.missingEnvVar).toBe('LOOM_IDENTITY_PICKER_ENABLED');
    // The three AppRoles the operator must consent, straight from the client.
    expect(GATE_BODY.hint.rolesRequired.map((r: any) => r.name)).toEqual(
      expect.arrayContaining(['User.Read.All', 'Group.Read.All', 'Application.Read.All']),
    );
  });
});

describe('default deployment — every adopted surface stays usable', () => {
  it('policy-code statement dialog: the principal can still be set', async () => {
    const { StatementDialog } = await import('@/app/admin/policy-code/page');
    const onSave = vi.fn();
    const user = userEvent.setup();
    wrap(
      <StatementDialog
        initial={{ id: 's1', principals: [{ kind: 'group', id: '' }], resources: [{ backend: 'synapse', object: 'dbo.t' }], actions: ['read'] } as any}
        existingIds={[]} onCancel={() => {}} onSave={onSave}
      />,
    );
    const hatch = await driveToHatch(user, screen.getByPlaceholderText(/Group display name/i));
    fireEvent.change(hatch, { target: { value: GHOST } });
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    expect(await screen.findByText(GHOST)).toBeInTheDocument();
  });

  it('access-reviews leaver revoke-all: the principal can still be set', async () => {
    const { AccessReviewsPanel } = await import('@/lib/components/admin/access-reviews-panel');
    const user = userEvent.setup();
    clientFetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, reviews: [] }) });
    wrap(<AccessReviewsPanel />);
    const boxes = await screen.findAllByPlaceholderText(/Display name or UPN/i);
    const hatch = await driveToHatch(user, boxes[boxes.length - 1]);
    fireEvent.change(hatch, { target: { value: GHOST } });
    await user.click(screen.getAllByRole('button', { name: /^Add$/ })[0]);
    expect(await screen.findByText(GHOST)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Revoke all access/i })).not.toBeDisabled();
  });

  it('powerbi manage access: the identifier can still be set and Add enables', async () => {
    const { ManageAccessPanel } = await import('@/lib/components/powerbi/powerbi-governance');
    const user = userEvent.setup();
    clientFetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, users: [] }) });
    wrap(<ManageAccessPanel enabled workspaceId="ws-1" />);
    const hatch = await driveToHatch(user, await screen.findByPlaceholderText(/Display name or UPN/i));
    fireEvent.change(hatch, { target: { value: GHOST } });
    // The panel has its own "Add" button for the ACL row; the hatch's is the
    // one inside the picker's Field, so scope to the hatch's own row.
    await user.click(within(hatch.closest('div')!.parentElement!).getByRole('button', { name: /^Add$/ }));
    expect(await screen.findByText(GHOST)).toBeInTheDocument();
  });

  it('lakehouse Share dialog: the recipient can still be set and Grant stays live', async () => {
    const { ShareDialog } = await import('@/lib/editors/lakehouse/dialogs/small-dialogs');
    const mod = await import('@/lib/editors/lakehouse/lakehouse-editor-context');
    const user = userEvent.setup();
    let principal = '';
    const ctx: any = {
      shareOpen: true, setShareOpen: vi.fn(),
      sharePrincipal: principal, setSharePrincipal: (v: string) => { principal = v; },
      sharePrincipalType: 'User', setSharePrincipalType: vi.fn(),
      shareRole: 'Storage Blob Data Reader', setShareRole: vi.fn(),
      shareError: null, shareSuccess: null, setShareError: vi.fn(), setShareSuccess: vi.fn(),
      shareBusy: false, grantShare: vi.fn(), activeContainer: 'gold',
    };
    wrap(<mod.LakehouseEditorContext.Provider value={ctx}><ShareDialog /></mod.LakehouseEditorContext.Provider>);
    const hatch = await driveToHatch(user, screen.getByPlaceholderText(/Display name or UPN/i));
    fireEvent.change(hatch, { target: { value: GHOST } });
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    // The dialog is a controlled surface: the id reached the caller's setter.
    expect(principal).toBe(GHOST);
  });

  it('semantic-model role members: a member can still be added', async () => {
    const { SemanticModelSecurityTab } = await import('@/lib/editors/phase3/semantic-model-editor/security-tab');
    const onSetMembers = vi.fn();
    const user = userEvent.setup();
    wrap(
      <SemanticModelSecurityTab
        s={{}} tables={[]} roles={[{ name: 'R', modelPermission: 'read', tablePermissions: [], members: [] }]}
        busy={false} saving={false} err={null} gate={null} saveMsg={null} selectedRole="R" olsTable=""
        testUpn="" testQuery="" testBusy={false} testResult={null} testErr={null}
        onReload={() => {}} onAddRole={() => {}} onDeleteRole={() => {}} onRenameRole={() => {}}
        onSelectRole={() => {}} onSetFilter={() => {}} onSetTableOls={() => {}} onSetColumnOls={() => {}}
        onSetMembers={onSetMembers} onChangeOlsTable={() => {}} onSave={() => {}}
        onTestUpn={() => {}} onTestQuery={() => {}} onRunTest={() => {}}
      />,
    );
    const hatch = await driveToHatch(user, screen.getByPlaceholderText(/Display name or UPN/i));
    fireEvent.change(hatch, { target: { value: GHOST } });
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    expect(onSetMembers).toHaveBeenCalledWith('R', [GHOST]);
  });

  it('setup wizard admin group: the group can still be set', async () => {
    const { SetupIdentityCard } = await import('@/lib/panes/setup-identity-step');
    const user = userEvent.setup();
    clientFetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        ok: true, msal: { configured: true, recommendation: 'new' },
        appRegistrations: { reachable: true, items: [] },
        bootstrapAdmin: { recommendedOid: 'x', recommendedUpn: 'op@contoso.com', configured: false },
      }),
    });
    wrap(<SetupIdentityCard />);
    fireEvent.click(await screen.findByRole('combobox', { name: /Bootstrap tenant admin/i }));
    fireEvent.click(await screen.findByRole('option', { name: /An Entra group/i }));
    const hatch = await driveToHatch(user, await screen.findByPlaceholderText(/Group display name/i));
    fireEvent.change(hatch, { target: { value: GHOST } });
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    expect(await screen.findByText(GHOST)).toBeInTheDocument();
  });
});

describe('default deployment — the gate itself is G2-compliant', () => {
  it('renders through HonestGate with a Fix-it and a registry link, not a bare MessageBar', async () => {
    const { IdentityPicker } = await import('../identity-picker');
    const user = userEvent.setup();
    wrap(<IdentityPicker kind="user" />);
    await user.type(screen.getByRole('textbox'), 'ada');

    // G2: an inline Fix-it that opens the wizard, plus the registry link.
    const fixIt = await screen.findByRole('button', { name: /Fix it/i }, { timeout: 3000 });
    expect(fixIt).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Gate registry/i })).toHaveAttribute('href', '/admin/gates');
    // And the gate is IN the registry — an unknown id renders the generic bar.
    expect(screen.queryByText(/is not in the registry/i)).toBeNull();
  });

  it('the gate id resolves in the central registry so /admin/gates lists it', async () => {
    const { getGate } = await import('@/lib/gates/registry');
    const g = getGate('identity-picker');
    expect(g).toBeTruthy();
    expect(g!.requiredSettings.map((s: any) => s.envVar)).toContain('LOOM_IDENTITY_PICKER_ENABLED');
    expect(g!.surfaces.length).toBeGreaterThanOrEqual(8);
  });
});

describe('a 403 from the capability gate is a sentence, not a code', () => {
  it('renders "You do not have permission…" rather than the literal word forbidden', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 403, json: async () => ({ ok: false, error: 'forbidden' }),
    })));
    const { IdentityPicker } = await import('../identity-picker');
    const user = userEvent.setup();
    wrap(<IdentityPicker kind="user" />);
    await user.type(screen.getByRole('textbox'), 'ada');

    expect(await screen.findByText(/do not have permission to search the directory/i, {}, { timeout: 3000 })).toBeInTheDocument();
    // The raw code must not be what the operator reads.
    expect(screen.queryByText('forbidden')).toBeNull();
    // And the operator is not stuck: the hatch is there.
    expect(await screen.findByPlaceholderText(/Entra object id/i)).toBeInTheDocument();
  });
});
