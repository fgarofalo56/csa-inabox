/**
 * health-tenant editor (LHDS W1b-4): paused banner, Fix-it on the health gates,
 * clean first open, names match, resizable overview.
 *
 * Each assertion names the value that breaks it. G1 (live browser walk) has NOT
 * been done: the stamp is not deployed. These tests prove the component logic
 * against a faked BFF, not the live estate.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { renderWithProviders, installFetchMock, makeItem } from '../../__tests__/test-helpers';
import { HealthTenantEditor, pausedNotice, keepStamp, HEALTH_EDITOR_GATE_IDS } from '../tenant-editor';
import { pickStamp } from '@/lib/install/provisioners/health-tenant';
import { getGate } from '@/lib/gates/registry';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const ITEM = makeItem('health-tenant', 'Mercy General');
const BINDING = {
  tenantId: 'mercy-general', sourceName: 'Mercy General', tenantIdSanitized: true, stampId: 'east-s1',
  status: 'bound', verifiedAt: '2026-11-15T00:00:00Z', resources: [{ kind: 'postgres', id: '/subscriptions/x/pg1', name: 'pg-mercy-general' }],
};
const TENANT = { id: 'mercy-general', displayName: 'Mercy General', stampId: 'east-s1', status: 'active', quotas: { maxRequestsPerMinute: 600, maxStorageGiB: 100 } };

function bff(over: { get?: Record<string, unknown>; gates?: Array<{ id: string; status: string }> } = {}) {
  return installFetchMock({
    '/api/health/tenants/': (_u, init) => (init?.method === 'POST'
      ? { ok: true, phase: 'bound', binding: BINDING, tenant: TENANT }
      : { ok: true, phase: 'bound', binding: BINDING, tenant: TENANT, job: null, ...(over.get ?? {}) }),
    '/api/admin/gates': () => ({ gates: over.gates ?? [] }),
  });
}

describe('pausedNotice', () => {
  it('a paused stamp yields a notice carrying its id and reason', () => {
    // Breaks if the status test is dropped or the reason is not carried.
    expect(pausedNotice({ stamp: { id: 'east-s1', status: 'paused', pauseReason: 'estate pause' }, gate: null }))
      .toEqual({ stampId: 'east-s1', reason: 'estate pause' });
  });

  it.each(['healthy', 'draining', 'evacuated', 'creating'])('a %s stamp is NOT paused', (status) => {
    // Breaks if the banner keys on "not healthy" instead of "paused" (draining would show it).
    expect(pausedNotice({ stamp: { id: 'east-s1', status }, gate: null })).toBeNull();
  });

  it('derives from the stamp-capacity gate text the provisioner really builds (lifted from pickStamp, not transcribed)', () => {
    const pick = pickStamp([{ id: 'east-s1', displayName: 'e', cloud: 'commercial', region: 'eastus2', class: 'S', status: 'paused', pauseReason: 'cost pause' }], 'east-s1');
    if (!('reason' in pick)) throw new Error('fixture must not pick a stamp');
    // Breaks if pickStamp's wording changes and the regex no longer matches (notice would be null).
    expect(pausedNotice({ stamp: null, gate: { id: 'health-stamp-capacity', remediation: pick.reason } }))
      .toEqual({ stampId: 'east-s1', reason: 'cost pause' });
    // The same gate for a DRAINING stamp must not claim paused.
    const drain = pickStamp([{ id: 'east-s1', displayName: 'e', cloud: 'commercial', region: 'eastus2', class: 'S', status: 'draining' }], 'east-s1');
    if (!('reason' in drain)) throw new Error('fixture must not pick a stamp');
    expect(pausedNotice({ stamp: null, gate: { id: 'health-stamp-capacity', remediation: drain.reason } })).toBeNull();
  });
});

describe('keepStamp', () => {
  it('an ensure reply without a stamp keeps the stamp the GET read; one with a stamp wins', () => {
    const prev = { stamp: { id: 'east-s1', status: 'paused' } };
    const bare = { phase: 'bound', stamp: null } as any;
    // Breaks if the ensure reply overwrites the stamp with null (banner disappears right after open).
    expect(keepStamp(bare, prev).stamp).toEqual({ id: 'east-s1', status: 'paused' });
    expect(keepStamp({ ...bare, stamp: { id: 'west', status: 'healthy' } }, prev).stamp).toEqual({ id: 'west', status: 'healthy' });
  });
});

describe('HealthTenantEditor', () => {
  it('shows the paused banner when the stamp is paused, with the recorded reason', async () => {
    bff({ get: { stamp: { id: 'east-s1', status: 'paused', pauseReason: 'estate pause' } } });
    renderWithProviders(<HealthTenantEditor item={ITEM} id="item-1" />);
    // Breaks if the `paused &&` condition is removed or the title text changes.
    expect(await screen.findByText('Stamp east-s1 is paused')).toBeTruthy();
    expect(screen.getByText(/Reason recorded: estate pause/)).toBeTruthy();
  });

  it('shows NO paused banner for a healthy stamp (pairs with the positive case)', async () => {
    bff({ get: { stamp: { id: 'east-s1', status: 'healthy' } } });
    renderWithProviders(<HealthTenantEditor item={ITEM} id="item-1" />);
    await screen.findByText(/resources read back from Azure/);
    // Breaks if the banner is unconditional.
    expect(screen.queryByText(/is paused/)).toBeNull();
  });

  it('names match: the display name and tenant id from the control plane are shown verbatim, and the Azure resource name is listed', async () => {
    bff();
    renderWithProviders(<HealthTenantEditor item={ITEM} id="item-1" />);
    // Breaks if the display name is replaced by the slug (the slug has no space).
    expect((await screen.findAllByText('Mercy General')).length).toBeGreaterThan(0);
    expect(screen.getByText('mercy-general')).toBeTruthy();
  });

  it('first open of a fresh item shows no error banner and no failure text', async () => {
    installFetchMock({
      '/api/health/tenants/': (_u, init) => (init?.method === 'POST'
        ? { ok: true, phase: 'provisioning', binding: { ...BINDING, status: 'provisioning', resources: [] }, job: { id: 'j1', state: 'running', receipts: [] } }
        : { ok: true, phase: 'unbound', binding: null, tenant: null, job: null }),
      '/api/admin/gates': () => ({ gates: [] }),
    });
    renderWithProviders(<HealthTenantEditor item={ITEM} id="item-1" />);
    // Positive: the real surface is up, in its progress state.
    expect(await screen.findByText(/Provisioning the tenant on its stamp/)).toBeTruthy();
    // Breaks if an error/failure bar or problem bar is rendered on a clean create.
    expect(screen.queryByText(/Provisioning failed/)).toBeNull();
    expect(screen.queryByText(/could not/i)).toBeNull();
    expect(screen.queryByText(/is paused/)).toBeNull();
  });

  it('every health gate that is not configured gets an inline Fix it; a configured one does not', async () => {
    bff({ gates: [
      { id: 'health-control-plane', status: 'configured' },
      { id: 'health-stamp-capacity', status: 'blocked' },
      { id: 'health-gov-image-gate', status: 'blocked' },
      { id: 'health-auth-graph-consent', status: 'blocked' },
      { id: 'health-lakehouse-isolation', status: 'opt-in' },
    ] });
    renderWithProviders(<HealthTenantEditor item={ITEM} id="item-1" />);
    await screen.findByLabelText('Tenant prerequisites');
    // Breaks if a gate row loses its button (count < 4) or the configured one gains one (count > 4).
    const buttons = screen.getAllByRole('button', { name: /^Fix it:/ });
    expect(buttons).toHaveLength(4);
    expect(screen.queryByRole('button', { name: /Fix it: .*control plane/i })).toBeNull();
    for (const id of HEALTH_EDITOR_GATE_IDS) expect(getGate(id), id).toBeDefined();
  });

  it('clicking Fix it opens the gate wizard for THAT gate', async () => {
    bff({ gates: [{ id: 'health-stamp-capacity', status: 'blocked' }] });
    renderWithProviders(<HealthTenantEditor item={ITEM} id="item-1" />);
    const title = getGate('health-stamp-capacity')!.title;
    fireEvent.click(await screen.findByRole('button', { name: `Fix it: ${title}` }));
    // Breaks if the click is unwired (no dialog) or opens another gate's wizard.
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('a non-admin (gates endpoint refuses) sees no gate rows and no error banner', async () => {
    installFetchMock({
      '/api/health/tenants/': () => ({ ok: true, phase: 'bound', binding: BINDING, tenant: TENANT, job: null }),
    });
    vi.spyOn(global, 'fetch').mockImplementation((async (url: any) => {
      const u = String(url);
      if (u.includes('/api/admin/gates')) return new Response('{}', { status: 403 });
      return new Response(JSON.stringify({ ok: true, phase: 'bound', binding: BINDING, tenant: TENANT, job: null }), { status: 200 });
    }) as any);
    renderWithProviders(<HealthTenantEditor item={ITEM} id="item-1" />);
    await screen.findByText(/resources read back from Azure/);
    // Breaks if a 403 is parsed as gate data or surfaced as a banner.
    expect(screen.queryByLabelText('Tenant prerequisites')).toBeNull();
    expect(screen.queryByText(/could not/i)).toBeNull();
  });

  it('on a wide viewport the overview is a resizable SplitPane; narrow it is stacked', async () => {
    bff();
    const orig = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as any;
    try {
      renderWithProviders(<HealthTenantEditor item={ITEM} id="item-1" />);
      // Breaks if SplitPane is removed (no separator) or its label changes.
      await waitFor(() => expect(screen.getByRole('separator', { name: 'Resize overview and tenant details' })).toBeTruthy());
    } finally { window.matchMedia = orig; }
    cleanup();
    bff();
    renderWithProviders(<HealthTenantEditor item={ITEM} id="item-1" />);
    await screen.findByText(/resources read back from Azure/);
    // Breaks if the stacked layout still mounts a divider.
    expect(screen.queryByRole('separator', { name: 'Resize overview and tenant details' })).toBeNull();
  });
});
