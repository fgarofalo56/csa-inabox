/**
 * EstatePowerPanel (#5099 phase B): a held-out database names the exact consumer
 * that pins it, a "consumers unknown" hold-out is explicit, and a flexible-server
 * row discloses Azure's auto-restart (7 days PostgreSQL, 30 days MySQL). jsdom
 * only - NOT a G1 browser E2E. Each `it` names the input that breaks it.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

vi.mock('@/lib/client-fetch', () => ({ clientFetch: vi.fn() }));
const jsonGet = vi.fn();
vi.mock('@/lib/components/admin-scaling/json-get', () => ({ jsonGet: (...a: unknown[]) => jsonGet(...a) }));

import { EstatePowerPanel } from '../estate-power-panel';
import { autoRestartCaption } from '@/lib/estate/pause-autorestart';

const styles = new Proxy({}, { get: (_t, k) => String(k) }) as Record<string, string>;
const mount = () => render(<FluentProvider theme={webLightTheme}><EstatePowerPanel styles={styles} /></FluentProvider>);

const row = (name: string, resourceType: string) => ({
  resourceId: `/subscriptions/s/resourceGroups/r/providers/x/${name}`, name, resourceType, resourceGroup: 'r',
  subscriptionId: 's', mechanism: 'arm-stop-action', ownershipSource: 'ownership-tag', ownershipReason: 'tagged',
  owningTagKey: 'loom-estate-id', owningTagValue: 'loom:e',
});
const state = (over: Record<string, unknown>) => ({
  ok: true, state: 'RUNNING', estateId: 'loom:e',
  preview: { wouldPause: [], wouldLeaveRunning: [], summary: '' },
  population: {
    examined: 2, pausable: 2, empty: false, armed: true, namedByDeploy: 0, statement: 's',
    byEvidence: { ownershipTag: 2, deployManifest: 0 },
    tagCensus: { loomEstateId: 2, loomItemId: 0, loomManaged: 0, untagged: 0 },
  },
  outOfTier: [], unresolved: [], readFailures: [], absent: [], risks: [], highRisk: 0, throttled: 0,
  discovery: { queried: true, incomplete: false, matched: 0, heldOut: [] },
  ...over,
});

beforeEach(() => { vi.useFakeTimers(); jsonGet.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };

describe('EstatePowerPanel phase-B rows', () => {
  // Breaks if: the pinning consumer is dropped from the held-out list (the operator then cannot see WHAT pins the server).
  it('a held-out server shows the pinning consumer as a badge and in its reason', async () => {
    jsonGet.mockResolvedValue(state({
      outOfTier: [{
        resourceId: 'x1', name: 'psql-unity', resourceType: 'microsoft.dbforpostgresql/flexibleservers',
        pinnedBy: 'loom-unity', reason: 'psql-unity is pinned by loom-unity, which is on the never-pause list. Left RUNNING.',
      }],
    }));
    mount();
    await settle();
    expect(screen.getByText('pinned by loom-unity')).toBeTruthy(); // the badge
    expect(screen.getByText(/never-pause list/)).toBeTruthy(); // the reason
  });

  // Breaks if: a "consumers unknown" hold-out is hidden or relabelled (nothing pins it; nothing is known).
  it('a consumers-unknown hold-out renders its reason and NO pinned-by badge', async () => {
    jsonGet.mockResolvedValue(state({
      outOfTier: [{
        resourceId: 'x2', name: 'psql-mystery', resourceType: 'microsoft.dbforpostgresql/flexibleservers',
        reason: 'psql-mystery is held out: consumers unknown (no loom-estate-pause-consumers tag). Left RUNNING.',
      }],
    }));
    mount();
    await settle();
    expect(screen.getByText(/consumers unknown/)).toBeTruthy();
    expect(screen.queryByText(/^pinned by /)).toBeNull();
  });

  // Breaks if: the auto-restart disclosure is missing from a flexible-server preview row, or shown for other types.
  it('a PostgreSQL preview row discloses the 7-day auto-restart; a Container App row does not', async () => {
    jsonGet.mockResolvedValue(state({
      preview: {
        wouldPause: [row('psql-ok', 'microsoft.dbforpostgresql/flexibleservers'), row('app-a', 'microsoft.app/containerapps')],
        wouldLeaveRunning: [], summary: '',
      },
    }));
    mount();
    await settle();
    expect(screen.getAllByText(/restarts a stopped server of this type on its own after 7 days/)).toHaveLength(1);
  });
});

describe('autoRestartCaption', () => {
  // Breaks if: the two engines share a number (Learn: PostgreSQL 7 days, MySQL 30 days), or other types get a caption.
  it('PostgreSQL says 7 days, MySQL says 30 days, anything else is null', () => {
    expect(autoRestartCaption('Microsoft.DBforPostgreSQL/flexibleServers')).toContain('after 7 days');
    expect(autoRestartCaption('microsoft.dbformysql/flexibleservers')).toContain('after 30 days');
    expect(autoRestartCaption('microsoft.kusto/clusters')).toBeNull();
    expect(autoRestartCaption('')).toBeNull();
  });
});
