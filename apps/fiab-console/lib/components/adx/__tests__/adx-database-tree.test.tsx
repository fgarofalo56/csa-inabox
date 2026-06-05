/**
 * AdxDatabaseTree — vitest jsdom render smoke test.
 *
 * Mounts the KQL database object navigator with a mocked fetch that returns a
 * configured (non-gated) database carrying a single read-only retention policy,
 * and confirms:
 *   - the component mounts without throwing,
 *   - the new read-only "Policies" group renders with its label + the live
 *     count (1) derived from the policy returned by /api/adx/policies.
 *
 * The "Policies" group is a collapsed Fluent v9 Tree branch by default, so its
 * leaf subtree (the retention row) is intentionally not mounted until expanded;
 * the group header label + count is the load-bearing, always-rendered signal
 * that the policy data flowed through loadAll → setPolicies → the group.
 *
 * The mock satisfies the component's `readJson` (which reads `res.text()`),
 * so this exercises the real loadAll → setPolicies → group-render path. No
 * backend behavior is faked beyond the HTTP envelope. (Per no-vaporware.md.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { AdxDatabaseTree } from '../adx-database-tree';

const BODY = {
  ok: true,
  database: 'loomdb-default',
  tables: [],
  functions: [],
  materializedViews: [],
  mappings: [],
  continuousExports: [],
  policies: [
    { kind: 'retention', policy: { SoftDeletePeriod: '365.00:00:00' }, raw: '{}' },
  ],
};

describe('AdxDatabaseTree', () => {
  beforeEach(() => {
    // Every ADX route fetch (tables/functions/mviews/mappings/overview/policies)
    // returns the same non-gated envelope. readJson() calls res.text(), so the
    // mock Response must back text() with the serialized body.
    const json = JSON.stringify(BODY);
    vi.spyOn(global, 'fetch').mockImplementation(async () =>
      ({
        ok: true,
        status: 200,
        text: async () => json,
        json: async () => BODY,
      }) as any,
    );
  });

  // globals:false → @testing-library/react does not auto-cleanup; unmount
  // explicitly so each test asserts against a single fresh tree.
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('mounts and renders the read-only Policies group with the loaded policy count', async () => {
    render(
      <FluentProvider theme={webLightTheme}>
        <AdxDatabaseTree itemId="x" />
      </FluentProvider>,
    );

    // Mounts without throwing: the navigator header is present immediately.
    expect(screen.getByText(/KQL database/)).toBeInTheDocument();

    // The Policies group header shows the live count once loadAll resolves —
    // proving /api/adx/policies flowed through to setPolicies and the group.
    await waitFor(() => {
      expect(screen.getByText(/Policies \(1\)/)).toBeInTheDocument();
    });
  });
});
