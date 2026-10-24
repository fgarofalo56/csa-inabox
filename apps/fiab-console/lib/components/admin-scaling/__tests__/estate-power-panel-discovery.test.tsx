/**
 * EstatePowerPanel (#5099): an incomplete tag discovery is rendered as "discovery
 * incomplete", never as the "safe answer" for an empty plan. jsdom only - NOT a G1
 * browser E2E. Each `it` names the input that breaks it.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

vi.mock('@/lib/client-fetch', () => ({ clientFetch: vi.fn() }));
const jsonGet = vi.fn();
vi.mock('@/lib/components/admin-scaling/json-get', () => ({ jsonGet: (...a: unknown[]) => jsonGet(...a) }));

import { EstatePowerPanel } from '../estate-power-panel';

const styles = new Proxy({}, { get: (_t, k) => String(k) }) as Record<string, string>;
const mount = () => render(<FluentProvider theme={webLightTheme}><EstatePowerPanel styles={styles} /></FluentProvider>);

const NOTE = 'discovery incomplete: the Azure Resource Graph tag query failed. Raw: AuthorizationFailed-xyz';
const running = (discovery: Record<string, unknown>) => ({
  ok: true,
  state: 'RUNNING',
  estateId: 'loom:e',
  preview: { wouldPause: [], wouldLeaveRunning: [], summary: '' },
  population: {
    examined: 0, pausable: 0, empty: true, armed: true, namedByDeploy: 0, statement: 'NOTHING would be paused.',
    byEvidence: { ownershipTag: 0, deployManifest: 0 },
    tagCensus: { loomEstateId: 0, loomItemId: 0, loomManaged: 0, untagged: 0 },
  },
  outOfTier: [], unresolved: [], readFailures: [], absent: [], risks: [], highRisk: 0, throttled: 0,
  discovery,
});

beforeEach(() => { vi.useFakeTimers(); jsonGet.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };

describe('EstatePowerPanel discovery banner', () => {
  // Breaks if: an incomplete discovery is not rendered (an empty plan then reads as the safe answer).
  it('shows the incomplete banner with the raw reason, and does NOT title the empty plan "the safe answer"', async () => {
    jsonGet.mockResolvedValue(running({ queried: true, incomplete: true, note: NOTE, matched: 0, heldOut: [] }));
    mount();
    await settle();
    expect(screen.getByTestId('estate-discovery-incomplete').textContent).toContain('AuthorizationFailed-xyz');
    expect(screen.queryByText(/and that is the safe answer/)).toBeNull();
    expect(screen.getByText(/but discovery is incomplete/)).toBeTruthy();
  });

  // Breaks if: the banner is unconditional (positive control: a complete discovery keeps the original wording).
  it('a complete discovery shows no banner and keeps the original empty-plan title', async () => {
    jsonGet.mockResolvedValue(running({ queried: true, incomplete: false, matched: 0, heldOut: [] }));
    mount();
    await settle();
    expect(screen.queryByTestId('estate-discovery-incomplete')).toBeNull();
    expect(screen.getByText(/and that is the safe answer/)).toBeTruthy();
  });

  // Breaks if: held-out tagged resources (the console's AKS) are hidden from the operator.
  it('lists a tagged resource that was deliberately left running, with its reason', async () => {
    jsonGet.mockResolvedValue(running({
      queried: true, incomplete: false, matched: 1,
      heldOut: [{ name: 'aks-console', reason: 'hosting this console' }],
    }));
    mount();
    await settle();
    const t = screen.getByTestId('estate-discovery-heldout').textContent ?? '';
    expect(t).toContain('aks-console');
    expect(t).toContain('hosting this console');
  });
});
