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
import { SmartAppsTab, SCOPE_CHOICES, unavailableText } from '../smart-apps-tab';
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
