/**
 * capacity-broker-client — unit tests for the HYP-9 broker client wrapper.
 *
 * Covers the honest-gate behaviour (env unset → BrokerNotConfiguredError), URL
 * normalization, and the admit/report/ledger calls against a mocked fetch. No
 * live broker is contacted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  capacityBrokerUrl,
  capacityBrokerConfigured,
  admit,
  report,
  ledgerState,
  BrokerNotConfiguredError,
} from '../capacity-broker-client';

const ENV_KEY = 'LOOM_CAPACITY_BROKER_URL';

describe('capacity-broker-client', () => {
  const original = process.env[ENV_KEY];

  beforeEach(() => {
    delete process.env[ENV_KEY];
    vi.restoreAllMocks();
  });
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it('reports not-configured when the env var is unset', () => {
    expect(capacityBrokerUrl()).toBeNull();
    expect(capacityBrokerConfigured()).toBe(false);
  });

  it('normalizes the base URL (trims + strips trailing slashes)', () => {
    process.env[ENV_KEY] = '  https://loom-capacity-broker.internal//  ';
    expect(capacityBrokerUrl()).toBe('https://loom-capacity-broker.internal');
    expect(capacityBrokerConfigured()).toBe(true);
  });

  it('admit() throws BrokerNotConfiguredError (honest gate) when unset', async () => {
    await expect(
      admit({ tenantId: 't', engine: 'spark', requestedUnits: 30 }),
    ).rejects.toBeInstanceOf(BrokerNotConfiguredError);
  });

  it('admit() POSTs to /admit and returns the decision', async () => {
    process.env[ENV_KEY] = 'https://broker.internal';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, decision: 'allow', reason: 'ok', backend: 'memory' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const res = await admit({ tenantId: 't', workspaceId: 'w', engine: 'spark', requestedUnits: 30, class: 'background' });
    expect(res.decision).toBe('allow');
    expect(res.backend).toBe('memory');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://broker.internal/admit');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toMatchObject({ tenantId: 't', engine: 'spark', requestedUnits: 30 });
  });

  it('admit() surfaces the broker error body on non-2xx', async () => {
    process.env[ENV_KEY] = 'https://broker.internal';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'tenantId required' }), { status: 400 }),
    );
    await expect(admit({ tenantId: '', engine: 'spark', requestedUnits: 1 })).rejects.toThrow(
      /tenantId required/,
    );
  });

  it('report() POSTs actual consumption', async () => {
    process.env[ENV_KEY] = 'https://broker.internal';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, recorded: true, backend: 'memory' }), { status: 200 }),
    );
    const res = await report({ tenantId: 't', workspaceId: 'w', actualLcu: 12 });
    expect(res.recorded).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://broker.internal/report');
  });

  it('ledgerState() GETs the timepoint window with encoded path + horizon', async () => {
    process.env[ENV_KEY] = 'https://broker.internal';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, backend: 'memory', timepoint: 1, lastHourLcu: 0, future: [0, 0] }),
        { status: 200 },
      ),
    );
    const res = await ledgerState('ten ant', 'work/space', 60);
    expect(res.future).toHaveLength(2);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/ledger/ten%20ant/work%2Fspace');
    expect(url).toContain('horizon=60');
  });
});
