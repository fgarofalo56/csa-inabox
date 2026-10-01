/**
 * The Access report's "Grants not yet settled" section: access-request grants
 * whose outcome is not recorded as in place, held before, or removed (the
 * report's `grantRecords`, lib/access/grant-intents.ts).
 *
 * Each assertion names the value that breaks it:
 *   - every unsettled row renders with its state in words and its age. Breaks
 *     if the panel ignores `grantRecords` (the table is not found), drops a
 *     state's label (its text is missing), or shows no age ('12 min' missing);
 *   - with no unsettled rows the section is absent, and the grants' own empty
 *     state still shows. Breaks if the section renders unconditionally;
 *   - a read failure is said, not shown as "nothing unsettled". Breaks if
 *     `grantRecordsError` is dropped.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

const fetchMock = vi.fn();
vi.mock('@/lib/client-fetch', () => ({ clientFetch: (...a: unknown[]) => fetchMock(...a) }));
vi.mock('@/lib/components/ui/identity-picker', () => ({ IdentityPicker: () => null }));

import { AccessReportPanel, GRANT_RECORD_STATE_LABEL, ageLabel } from '../access-report-panel';

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

function record(id: string, state: string, createdAt: string, patch: Record<string, unknown> = {}) {
  return {
    id, requestId: `req-${id}`, principalId: 'p1', principalName: 'ann@contoso.com',
    scopeType: 'adls-container', scopeRef: 'gold', assetName: 'Gold sales', permission: 'read',
    state, createdAt, ...patch,
  };
}

function serve(body: Record<string, unknown>) {
  fetchMock.mockImplementation(async () => ({
    status: 200, ok: true, json: async () => ({ ok: true, entries: [], groupExpansion: 'n/a', ...body }),
  }));
}

beforeEach(() => { fetchMock.mockReset(); });

describe('Access report — grants not yet settled', () => {
  it('lists each unsettled grant with its state in words and its age', async () => {
    serve({
      grantRecords: [
        record('g1', 'pending', ago(12)),
        record('g2', 'failed', ago(180), { detail: 'ARM 403 on gold' }),
        record('g3', 'absent', ago(60 * 50)),
      ],
    });
    render(<AccessReportPanel />);
    const table = await screen.findByRole('table', { name: 'Grants not yet settled' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).getByText(GRANT_RECORD_STATE_LABEL.pending)).toBeInTheDocument();
    expect(within(table).getByText(GRANT_RECORD_STATE_LABEL.failed)).toBeInTheDocument();
    expect(within(table).getByText(GRANT_RECORD_STATE_LABEL.absent)).toBeInTheDocument();
    expect(within(table).getByText('12 min')).toBeInTheDocument();
    expect(within(table).getByText('3 h')).toBeInTheDocument();
    expect(within(table).getByText('2 d')).toBeInTheDocument();
    expect(within(table).getByText('ARM 403 on gold')).toBeInTheDocument();
    expect(within(table).getByText('req-g1')).toBeInTheDocument();
  });

  it('shows no section when every grant is settled, and keeps the empty state', async () => {
    serve({ grantRecords: [] });
    render(<AccessReportPanel />);
    expect(await screen.findByText('No access grants to show')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Grants not yet settled' })).not.toBeInTheDocument();
  });

  it('says when the grant records could not be read', async () => {
    const msg = 'The access-request grant records could not be read, so grants not yet settled are not listed.';
    serve({ grantRecords: [], grantRecordsError: msg });
    render(<AccessReportPanel />);
    expect(await screen.findByText(msg)).toBeInTheDocument();
  });
});

describe('ageLabel', () => {
  it('reads minutes, hours past the hour, and days past two days', () => {
    // Breaks on an off-by-one at a boundary: 59 min must not read '0 h', 47 h not '1 d'.
    const now = Date.parse('2026-10-01T12:00:00.000Z');
    const at = (ms: number) => new Date(now - ms).toISOString();
    expect(ageLabel(at(59 * 60_000), now)).toBe('59 min');
    expect(ageLabel(at(60 * 60_000), now)).toBe('1 h');
    expect(ageLabel(at(47 * 3_600_000), now)).toBe('47 h');
    expect(ageLabel(at(48 * 3_600_000), now)).toBe('2 d');
    expect(ageLabel('not a date', now)).toBe('—');
  });
});
