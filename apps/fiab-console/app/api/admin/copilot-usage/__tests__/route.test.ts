/**
 * BFF contract tests for GET /api/admin/copilot-usage.
 *
 * Pins the fix for the "Could not load Copilot usage" bug: on a fresh
 * workspace the AppEvents table is not yet materialized, so a bare table
 * reference returns a SemanticError (HTTP 400). The route now (a) uses
 * `union isfuzzy=true (AppEvents | ...)` so a missing table yields 0 rows and
 * the friendly noEvents state fires, and (b) maps any residual missing-table
 * resolve error to noEvents rather than a hard 500. Genuine permission errors
 * still surface as { ok:false, error } and an unset workspace still honest-gates.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'tenant-oid', upn: 'admin@contoso.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

// monitor-client double — keep the real error classes, stub queryLogs.
const queryLogsMock = vi.fn();
vi.mock('@/lib/azure/monitor-client', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, queryLogs: (...a: unknown[]) => queryLogsMock(...a) };
});

import { GET } from '../route';
import { MonitorError, MonitorNotConfiguredError } from '@/lib/azure/monitor-client';

function req(days = 30) {
  return { nextUrl: { searchParams: new URLSearchParams({ days: String(days) }) } } as any;
}
const empty = { columns: [], rows: [], rowCount: 0 };

beforeEach(() => {
  queryLogsMock.mockReset();
  getSessionMock.mockReturnValue({ claims: { oid: 'o' }, exp: Date.now() / 1000 + 3600 } as any);
});

describe('GET /api/admin/copilot-usage', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('uses union isfuzzy so the AppEvents reference tolerates a not-yet-created table', async () => {
    queryLogsMock.mockResolvedValue(empty);
    await GET(req());
    expect(queryLogsMock).toHaveBeenCalled();
    for (const call of queryLogsMock.mock.calls) {
      expect(String(call[0])).toContain('union isfuzzy=true (AppEvents');
    }
  });

  it('returns noEvents (not an error) when all three summaries are empty', async () => {
    queryLogsMock.mockResolvedValue(empty);
    const res = await GET(req());
    const body = await res.json();
    expect(body).toEqual({ ok: true, data: null, noEvents: true });
  });

  it('maps a missing-table resolve error to noEvents instead of a 500', async () => {
    queryLogsMock.mockRejectedValue(
      new MonitorError("SemanticError: Failed to resolve table or column expression named 'AppEvents'", 400),
    );
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, data: null, noEvents: true });
  });

  it('honest-gates when the workspace env var is unset', async () => {
    queryLogsMock.mockRejectedValue(new MonitorNotConfiguredError(['LOOM_LOG_ANALYTICS_WORKSPACE_ID']));
    const res = await GET(req());
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.gate.missing).toContain('LOOM_LOG_ANALYTICS_WORKSPACE_ID');
  });

  it('still surfaces a genuine permission error as { ok:false, error }', async () => {
    queryLogsMock.mockRejectedValue(new MonitorError('Forbidden: caller lacks Log Analytics Reader', 403));
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/Forbidden/);
  });

  it('aggregates real per-persona token counts when events exist', async () => {
    const byPersona = {
      columns: ['persona', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'calls'],
      rows: [['analyst', 1000, 400, 1400, 5]],
      rowCount: 1,
    };
    queryLogsMock
      .mockResolvedValueOnce(byPersona) // byPersona
      .mockResolvedValueOnce(empty) // byDay
      .mockResolvedValueOnce(empty); // byUser
    const res = await GET(req());
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.byPersona[0]).toMatchObject({ persona: 'analyst', totalTokens: 1400, calls: 5 });
    expect(body.data.totals).toMatchObject({ promptTokens: 1000, totalTokens: 1400, calls: 5 });
  });
});
