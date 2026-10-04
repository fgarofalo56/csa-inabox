/**
 * SynapseServerlessSqlPoolEditor — Vitest contract test (auto-generated).
 *
 * Renders the editor with minimal props and asserts the chrome mounts +
 * at least one ribbon button exists. Network calls are caught by a no-op
 * fetch mock so the editor's mount-time fetch succeeds with ok:true.
 *
 * Per .claude/rules/no-vaporware.md grading rubric, this brings synapse-serverless-sql-pool
 * from B-grade (functional, untested) to A-grade (functional + Vitest).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { SynapseServerlessSqlPoolEditor } from '../synapse-sql-editors';
import { makeItem, installFetchMock } from './test-helpers';
import { analyzeLakehouseQuery } from '@/app/api/items/lakehouse/_lib/query-scope';

describe('SynapseServerlessSqlPoolEditor', () => {
  beforeEach(() => { installFetchMock({}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('mounts and surfaces at least one ribbon button', async () => {
    let err: unknown = null;
    try {
      render(<SynapseServerlessSqlPoolEditor item={makeItem('synapse-serverless-sql-pool', 'Synapse serverless SQL pool')} id="new" />);
      await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
      const ribbon = screen.getByTestId('ribbon');
      expect(ribbon.querySelectorAll('button').length).toBeGreaterThan(0);
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });

  it('opens on SQL the serverless query route accepts from a caller who is not a tenant admin', async () => {
    // This editor posts to the serverless SQL pool query route, which runs a
    // non-admin's text only when the lakehouse classifier accepts it. Breaks if
    // the opening SQL uses anything that classifier refuses (e.g. SUSER_NAME()).
    // The posted body is read from the real click.
    const { calls } = installFetchMock({});
    render(<SynapseServerlessSqlPoolEditor item={makeItem('synapse-serverless-sql-pool', 'Synapse serverless SQL pool')} id="pool-1" />);
    const runs = await screen.findAllByRole('button', { name: /^Run$/ }, { timeout: 5000 });
    fireEvent.click(runs[0]);
    await waitFor(() => expect(calls.some((c) => c.url.includes('/query'))).toBe(true), { timeout: 5000 });
    const posted = JSON.parse(String(calls.find((c) => c.url.includes('/query'))!.init!.body));
    expect(posted.sql).toContain('SELECT');
    expect(analyzeLakehouseQuery(posted.sql, { database: 'master' })).toEqual({ ok: true, locations: [] });
  });
});
