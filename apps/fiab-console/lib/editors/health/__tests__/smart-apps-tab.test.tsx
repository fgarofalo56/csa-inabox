/**
 * health-tenant "Apps" tab (#5454 A6): SMART app list, launch dialog, honest
 * patient-search unavailable state.
 *
 * These prove the component against a faked BFF. G1 (the live browser walk) is
 * NOT done here. Each assertion names the value that breaks it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { renderWithProviders, installFetchMock, makeItem } from '../../__tests__/test-helpers';
import { generateKeyPairSync } from 'node:crypto';
import { SmartAppsTab, SCOPE_CHOICES, keySourceText, unavailableText } from '../smart-apps-tab';
import { BACKEND_ROLE_CHOICES } from '@/lib/health/smart-registration';
import { HealthTenantEditor } from '../tenant-editor';
import { SMART_SCOPE_CHOICES } from '@/app/api/health/tenants/_lib/smart-apps';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const APP = {
  clientId: 'growth-chart', displayName: 'Growth Chart', status: 'active', kind: 'public', allowedScopes: ['patient/*.rs'],
  redirectUris: ['https://app.example/cb'], launchUri: 'https://app.example/launch', jwksUrl: null,
};
const LAUNCH_URL = 'https://app.example/launch?iss=https%3A%2F%2Fedge%2Fmercy%2Ffhir&launch=h1';

function bff(o: { apps?: unknown[]; search?: Record<string, unknown> } = {}) {
  return installFetchMock({
    '/apps/patient-search': () => ({ ok: true, ...(o.search ?? { patients: [] }) }),
    '/launch': () => ({ ok: true, url: LAUNCH_URL }),
    '/apps': () => ({ ok: true, tenant: 'mercy', apps: o.apps ?? [APP] }),
  });
}

describe('SCOPE_CHOICES', () => {
  it('is exactly the list the BFF accepts (lifted from the BFF module, not transcribed)', () => {
    // Breaks if either list gains or loses a scope: the dialog would offer one the BFF refuses, or hide one it accepts.
    expect(SCOPE_CHOICES.map((c) => c.scope)).toEqual(SMART_SCOPE_CHOICES.map((c) => c.scope));
  });
});

describe('unavailableText (deploy-integrity R7: claim only what the CP established)', () => {
  const EDGE = /did not answer|FHIR edge/;
  it('edge wording ONLY for timeout / no response', () => {
    // Breaks if the edge wording is dropped for the two reasons that mean "no answer".
    expect(unavailableText('timeout')).toMatch(/did not answer \(timeout\).*FHIR edge/);
    expect(unavailableText('no response')).toMatch(/did not answer \(no response\).*FHIR edge/);
  });
  it('an HTTP 403 says the endpoint ANSWERED 403 and never claims it did not answer', () => {
    // Breaks if every reason gets the edge wording (the pre-fix behaviour): 'HTTP 403' would match EDGE.
    expect(unavailableText('HTTP 403')).toMatch(/answered HTTP 403/);
    expect(unavailableText('HTTP 403')).not.toMatch(EDGE);
  });
  it('a role-check failure says role membership could not be checked, not the edge', () => {
    const t = unavailableText('role membership could not be established');
    expect(t).toMatch(/role membership in this tenant could not be checked/);
    expect(t).not.toMatch(EDGE); // breaks on the pre-fix wording
  });
  it('any other reason is shown verbatim', () => {
    expect(unavailableText('response was not a Bundle')).toContain('response was not a Bundle');
    expect(unavailableText('response was not a Bundle')).not.toMatch(EDGE);
  });
});

describe('SmartAppsTab register', () => {
  it('has NO client id input; after registering, the generated id is shown read-only with Copy', async () => {
    const GEN = 'growth-chart-k3x9a2bq';
    const { calls } = installFetchMock({
      '/apps': (_u, init) => (init?.method === 'POST' ? { ok: true, app: { ...APP, clientId: GEN } } : { ok: true, apps: [] }),
    });
    renderWithProviders(<SmartAppsTab id="item-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Register app' }));
    await screen.findByText('Register a SMART client');
    expect(screen.queryByRole('textbox', { name: /client id/i })).toBeNull(); // breaks if the free-text input returns
    fireEvent.change(screen.getByRole('textbox', { name: /Display name/ }), { target: { value: 'Growth Chart' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Redirect URIs/ }), { target: { value: 'https://app.example/cb' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Launch URL/ }), { target: { value: 'https://app.example/launch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    expect(await screen.findByText('Registered Growth Chart')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: `Copy client id ${GEN}` }).length).toBeGreaterThan(0);
    const post = calls.find((c) => c.init?.method === 'POST');
    expect('clientId' in JSON.parse(String(post?.init?.body))).toBe(false); // breaks if the tab still sends one
  });
});

describe('SmartAppsTab register: client kind and key source (#5151)', () => {
  const RSA_KP = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const RSA_PUB = { ...(RSA_KP.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'inferno-rsa', alg: 'RS384' };
  const RSA_PRIV = { ...(RSA_KP.privateKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'inferno-rsa', alg: 'RS384' };
  const open = async () => {
    const mock = installFetchMock({
      '/apps': (_u, init) => (init?.method === 'POST'
        ? { ok: true, app: { ...APP, clientId: 'inferno-bulk-aaaaaaaa', displayName: 'Inferno Bulk', clientType: 'backend', kind: 'asymmetric', keySource: 'inline', keyCount: 1, kids: ['inferno-rsa'], launchUri: null, redirectUris: [] } }
        : { ok: true, apps: [] }),
    });
    renderWithProviders(<SmartAppsTab id="item-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Register app' }));
    await screen.findByText('Register a SMART client');
    return mock;
  };
  const registerBtn = () => screen.getByRole('button', { name: 'Register' }) as HTMLButtonElement;

  it('first open is the existing app form: redirect + launch shown, no roles, no JWKS box, no error', async () => {
    await open();
    expect(screen.getByRole('textbox', { name: /Redirect URIs/ })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: /Launch URL/ })).toBeTruthy();
    // Breaks if the dialog opens on the backend branch or the paste box.
    expect(screen.queryByRole('group', { name: /Roles/ })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /Public JWKS/ })).toBeNull();
    expect(screen.queryByText(/private key material/)).toBeNull();
  });

  it('Backend service hides redirect + launch, shows the role picker and system/ scopes, and needs a role to register', async () => {
    const { calls } = await open();
    fireEvent.change(screen.getByRole('textbox', { name: /Display name/ }), { target: { value: 'Inferno Bulk' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Backend service (system, no user)' }));
    // Breaks if the backend branch still renders the app-only fields.
    expect(screen.queryByRole('textbox', { name: /Redirect URIs/ })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /Launch URL/ })).toBeNull();
    // Role choices come from the shared list (a picker), never a typed id. The group query is the positive control
    // for the first-open test's `queryByRole('group', {name: /Roles/})` being null.
    expect(screen.getByRole('group', { name: /Roles/ })).toBeTruthy();
    for (const r of BACKEND_ROLE_CHOICES) expect(screen.getByRole('checkbox', { name: `${r.label} (${r.id})` })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /^patient\// })).toBeNull();
    expect((screen.getByRole('checkbox', { name: /^system\/\*\.rs/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Paste JWKS (public keys)' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Public JWKS/ }), { target: { value: JSON.stringify({ keys: [RSA_PUB] }) } });
    expect(await screen.findByText('1 public key: inferno-rsa')).toBeTruthy();
    expect(registerBtn().disabled).toBe(true); // breaks if a backend client can be sent without a role
    fireEvent.click(screen.getByRole('checkbox', { name: 'FHIR Data Exporter (fhir-data-exporter)' }));
    expect(registerBtn().disabled).toBe(false);
    const sw = screen.getByRole('switch', { name: /introspection/i }) as HTMLInputElement;
    expect(sw.checked).toBe(false); // default off; breaks if it opens on
    fireEvent.click(registerBtn());
    expect(await screen.findByText('Registered Inferno Bulk')).toBeTruthy();
    const body = JSON.parse(String(calls.find((c) => c.init?.method === 'POST')?.init?.body));
    // Breaks if the dialog sends app fields for a backend client, drops roles, sends the JWKS as text / with a URL,
    // or sends introspect when the switch is off.
    expect(body).toEqual({
      displayName: 'Inferno Bulk', clientType: 'backend', kind: 'asymmetric', allowedScopes: ['system/*.rs'],
      roleIds: ['fhir-data-exporter'], jwks: { keys: [RSA_PUB] },
    });
  });

  it('the introspection switch is backend-only and sends introspect:true when on', async () => {
    const { calls } = await open();
    expect(screen.queryByRole('switch', { name: /introspection/i })).toBeNull(); // breaks if an app client is offered it
    fireEvent.change(screen.getByRole('textbox', { name: /Display name/ }), { target: { value: 'Inferno Bulk' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Backend service (system, no user)' }));
    fireEvent.change(screen.getByRole('textbox', { name: /^JWKS URL/ }), { target: { value: 'https://k.example/jwks' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'FHIR Data Reader (fhir-data-reader)' }));
    fireEvent.click(screen.getByRole('switch', { name: /introspection/i }));
    fireEvent.click(registerBtn());
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'POST')).toBe(true));
    const body = JSON.parse(String(calls.find((c) => c.init?.method === 'POST')?.init?.body));
    expect(body).toMatchObject({ clientType: 'backend', introspect: true, jwksUrl: 'https://k.example/jwks', roleIds: ['fhir-data-reader'] });
  });

  it('a pasted PRIVATE key is refused in the dialog with the member named, and nothing is posted', async () => {
    const { calls } = await open();
    fireEvent.change(screen.getByRole('textbox', { name: /Display name/ }), { target: { value: 'Inferno' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Confidential asymmetric (private_key_jwt)' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Paste JWKS (public keys)' }));
    expect(screen.queryByRole('textbox', { name: /^JWKS URL/ })).toBeNull(); // the URL box is replaced, not added
    fireEvent.change(screen.getByRole('textbox', { name: /Public JWKS/ }), { target: { value: JSON.stringify({ keys: [RSA_PRIV] }) } });
    // Breaks if the dialog does not run the validator (no message) or lets Register through.
    expect(await screen.findByText(/private key material \(d, p, q, dp, dq, qi\)/)).toBeTruthy();
    expect(registerBtn().disabled).toBe(true);
    fireEvent.click(registerBtn());
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);
  });

  it('switching back to JWKS URL sends jwksUrl only', async () => {
    const { calls } = await open();
    fireEvent.change(screen.getByRole('textbox', { name: /Display name/ }), { target: { value: 'Conf' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Redirect URIs/ }), { target: { value: 'https://app.example/cb' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Launch URL/ }), { target: { value: 'https://app.example/launch' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Confidential asymmetric (private_key_jwt)' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Paste JWKS (public keys)' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Public JWKS/ }), { target: { value: JSON.stringify({ keys: [RSA_PUB] }) } });
    fireEvent.click(screen.getByRole('radio', { name: 'JWKS URL' }));
    fireEvent.change(screen.getByRole('textbox', { name: /^JWKS URL/ }), { target: { value: 'https://k.example/jwks' } });
    fireEvent.click(registerBtn());
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'POST')).toBe(true));
    const body = JSON.parse(String(calls.find((c) => c.init?.method === 'POST')?.init?.body));
    // Breaks if the stale pasted keys ride along with the URL (the BFF would 400 on two key sources).
    expect(body.jwksUrl).toBe('https://k.example/jwks');
    expect('jwks' in body).toBe(false);
    expect(body.clientType).toBe('app');
  });

  it('the table shows client kind and key source; inline keys as count + kids; no Launch for a backend client', async () => {
    bff({ apps: [
      APP,
      { ...APP, clientId: 'conf', displayName: 'Conf App', kind: 'asymmetric', keySource: 'url', jwksUrl: 'https://k.example/jwks' },
      { ...APP, clientId: 'svc', displayName: 'Inferno Bulk', clientType: 'backend', kind: 'asymmetric', keySource: 'inline', keyCount: 2, kids: ['a1', 'b2'], launchUri: null, redirectUris: [], introspect: true },
    ] });
    renderWithProviders(<SmartAppsTab id="item-1" />);
    const table = await screen.findByRole('table', { name: 'SMART apps' });
    // Breaks if keySourceText ignores the source or prints keys instead of the count + kids.
    expect(within(table).getByText('Inline: 2 public keys (a1, b2)')).toBeTruthy();
    expect(within(table).getByText('JWKS URL: https://k.example/jwks')).toBeTruthy();
    expect(within(table).getByText('None (public client)')).toBeTruthy();
    expect(within(table).getByText('backend service')).toBeTruthy();
    expect(within(table).getAllByText('introspection')).toHaveLength(1); // breaks if the flag is not shown, or shown on every row
    expect(screen.queryByRole('button', { name: 'Launch Inferno Bulk' })).toBeNull(); // breaks if backend rows keep Launch
    expect(screen.getByRole('button', { name: 'Disable Inferno Bulk' })).toBeTruthy(); // but can still be disabled
    expect(screen.getByRole('button', { name: 'Launch Growth Chart' })).toBeTruthy();
  });
});

describe('keySourceText', () => {
  it('reads an older BFF row (no keySource) from jwksUrl', () => {
    expect(keySourceText({ ...(APP as any), jwksUrl: 'https://k.example/j' })).toBe('JWKS URL: https://k.example/j');
    expect(keySourceText(APP as any)).toBe('None (public client)');
    expect(keySourceText({ ...(APP as any), keySource: 'inline', keyCount: 1, kids: ['k'] })).toBe('Inline: 1 public key (k)');
  });
});

describe('SmartAppsTab', () => {
  it('renders an HTTP 403 unavailable reason without the edge wording', async () => {
    bff({ search: { unavailable: true, reason: 'HTTP 403', patients: [] } });
    renderWithProviders(<SmartAppsTab id="item-1" navigate={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Launch Growth Chart' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Patient name' }), { target: { value: 'ada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/answered HTTP 403/)).toBeTruthy(); // breaks if the reason is not passed through
    expect(screen.queryByText(/did not answer/)).toBeNull();
    expect(screen.queryByRole('table', { name: 'Matching patients' })).toBeNull();
  });

  it('with no apps shows the EmptyState launcher with Register app, and no error banner', async () => {
    bff({ apps: [] });
    renderWithProviders(<SmartAppsTab id="item-1" />);
    expect(await screen.findByText('No SMART apps yet')).toBeTruthy(); // breaks if the empty branch is a bare div
    expect(screen.getByRole('button', { name: 'Register app' })).toBeTruthy();
    expect(screen.queryByText(/Could not list/)).toBeNull(); // clean first open
  });

  it('lists apps with type and status badges, and Launch disabled for a disabled app', async () => {
    bff({ apps: [APP, { ...APP, clientId: 'off', displayName: 'Off App', status: 'disabled', kind: 'asymmetric' }] });
    renderWithProviders(<SmartAppsTab id="item-1" />);
    const table = await screen.findByRole('table', { name: 'SMART apps' });
    expect(within(table).getByText('public')).toBeTruthy();
    expect(within(table).getByText('asymmetric')).toBeTruthy();
    expect(within(table).getByText('disabled')).toBeTruthy();
    // Breaks if the status check on Launch is removed.
    expect((screen.getByRole('button', { name: 'Launch Off App' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Launch Growth Chart' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('patient search unavailable renders the MessageBar and ZERO patient rows; Launch without a patient navigates to the BFF url', async () => {
    const { calls } = bff({ search: { unavailable: true, reason: 'no response', patients: [] } });
    const navigate = vi.fn();
    renderWithProviders(<SmartAppsTab id="item-1" navigate={navigate} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Launch Growth Chart' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Patient name' }), { target: { value: 'ada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    // Breaks if the unavailable flag is ignored (no title) or rendered as an empty result set.
    expect(await screen.findByText('Patient search is unavailable')).toBeTruthy();
    expect(screen.getByText(/did not answer \(no response\)/)).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Matching patients' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Launch without a patient' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(LAUNCH_URL));
    const launch = calls.find((c) => c.url.endsWith('/apps/growth-chart/launch'));
    expect(JSON.parse(String(launch?.init?.body))).toEqual({}); // no patient, and never an oid
  });

  it('a search result launches with that patient id', async () => {
    const { calls } = bff({ search: { patients: [{ id: 'pat-1', name: 'Ada Smith', birthDate: '1970-01-02' }] } });
    const navigate = vi.fn();
    renderWithProviders(<SmartAppsTab id="item-1" navigate={navigate} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Launch Growth Chart' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Patient name' }), { target: { value: 'ada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Launch with Ada Smith' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(LAUNCH_URL));
    const launch = calls.find((c) => c.url.endsWith('/apps/growth-chart/launch'));
    expect(JSON.parse(String(launch?.init?.body))).toEqual({ patient: 'pat-1' }); // breaks if the picked id is dropped
    const search = calls.find((c) => c.url.endsWith('/apps/patient-search'));
    expect(search?.init?.method).toBe('POST'); // PHI in the body, never the query string
    expect(search?.url).not.toContain('ada');
  });
});

describe('HealthTenantEditor Apps tab', () => {
  it('has an Apps tab that opens the SMART apps surface for a bound tenant', async () => {
    const BINDING = { tenantId: 'mercy', sourceName: 'Mercy', tenantIdSanitized: false, stampId: 's', status: 'bound', resources: [] };
    installFetchMock({
      '/apps': () => ({ ok: true, apps: [] }),
      '/api/health/tenants/': () => ({ ok: true, phase: 'bound', binding: BINDING, tenant: null, job: null }),
      '/api/admin/gates': () => ({ gates: [] }),
    });
    renderWithProviders(<HealthTenantEditor item={makeItem('health-tenant', 'Mercy')} id="item-1" />);
    await screen.findByText('0 resources read back from Azure.');
    fireEvent.click(screen.getByRole('tab', { name: 'Apps' }));
    // Breaks if the tab is not wired to SmartAppsTab.
    expect(await screen.findByText('No SMART apps yet')).toBeTruthy();
  });
});
