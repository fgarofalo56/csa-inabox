/**
 * MirrorSourceWizard — Snowflake "Include Iceberg tables" option (Fabric Build
 * 2026 parity). Verifies the checkbox is Snowflake-only and that selecting it
 * flows through to the create POST payload + mirroring.json definition.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MirrorSourceWizard } from '../mirror-source-wizard';
import { installFetchMock } from '../../__tests__/test-helpers';

function mountNew() {
  return render(
    <MirrorSourceWizard
      open
      editing={false}
      workspaceId="ws-1"
      onClose={() => {}}
      onCreated={() => {}}
      onUpdated={() => {}}
    />,
  );
}

describe('MirrorSourceWizard — Snowflake Iceberg option', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('hides the Iceberg checkbox for non-Snowflake sources and shows it for Snowflake', async () => {
    installFetchMock({ '/api/connections': () => ({ ok: true, connections: [] }) });
    mountNew();
    // Default source is Azure SQL Database — no Iceberg checkbox.
    await waitFor(() => expect(screen.getByText(/Choose a source/i)).toBeInTheDocument());
    expect(screen.queryByText(/Include Iceberg tables/i)).toBeNull();

    // Pick Snowflake → checkbox appears.
    fireEvent.click(screen.getByText('Snowflake'));
    await waitFor(() => expect(screen.getByText(/Include Iceberg tables/i)).toBeInTheDocument());
  });

  it('sends includeIcebergTables in the create payload + definition when checked', async () => {
    const { calls } = installFetchMock({
      '/api/connections': () => ({ ok: true, connections: [] }),
      '/api/items/mirrored-database': () => ({ ok: true, mirroredDatabase: { id: 'm-new' } }),
    });
    mountNew();
    await waitFor(() => expect(screen.getByText(/Choose a source/i)).toBeInTheDocument());

    fireEvent.click(screen.getByText('Snowflake'));
    await waitFor(() => expect(screen.getByText(/Include Iceberg tables/i)).toBeInTheDocument());

    // Fill required fields.
    const inputs = document.querySelectorAll('input');
    // Server, Database, then Name (the order they render in the DOM).
    fireEvent.change(screen.getByPlaceholderText('server.database.windows.net'), { target: { value: 'acct.snowflakecomputing.com' } });
    fireEvent.change(screen.getByPlaceholderText('prod'), { target: { value: 'SALES_DB' } });
    fireEvent.change(screen.getByPlaceholderText('prod-sales-mirror'), { target: { value: 'snow-mirror' } });
    expect(inputs.length).toBeGreaterThan(0);

    // Check Iceberg.
    fireEvent.click(screen.getByLabelText(/Include Iceberg tables/i));

    // Submit. Use getByRole('button') to disambiguate from the DialogTitle
    // "Create mirrored database" which also matches /Create mirror/i.
    fireEvent.click(screen.getByRole('button', { name: /Create mirror/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.init?.method === 'POST' && c.url.includes('/api/items/mirrored-database') && !c.url.includes('source-tables'));
      expect(post).toBeTruthy();
    });
    const post = calls.find((c) => c.init?.method === 'POST' && c.url.includes('/api/items/mirrored-database') && !c.url.includes('source-tables'))!;
    const payload = JSON.parse(String(post.init!.body));
    expect(payload.sourceType).toBe('Snowflake');
    expect(payload.includeIcebergTables).toBe(true);
    const defJson = JSON.parse(Buffer.from(payload.definition.parts[0].payload, 'base64').toString('utf-8'));
    expect(defJson.properties.source.typeProperties.includeIcebergTables).toBe(true);
  });
});
