/**
 * S3GatewayEditor — silent-failure regression (loom-apex A3, page-errors.md #9).
 *
 * Before the fix this was the repo's ONLY useQuery consumer with zero error
 * references: `fetchInfo` throws on !res.ok / transport failure, and the
 * editor rendered only q.isLoading — so a failed GET /api/s3-gateway/info
 * left the body silently blank below the toolbar. This spec pins the honest
 * error branch: intent="error" MessageBar with Retry, toolbar still visible.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup } from '@testing-library/react';
import { S3GatewayEditor } from '../s3-gateway-editor';
import { makeItem, renderWithProviders } from './test-helpers';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function installFetch(onInfo: () => Response | never) {
  vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
    const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
    if (url.includes('/api/s3-gateway/info')) return onInfo() as any;
    // /api/runtime-flags etc. — generic ok (flag falls back to default ON).
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }) as any;
  });
}

describe('S3GatewayEditor transport-failure honesty (A3)', () => {
  it('renders an error MessageBar with Retry — not a blank body — when the info fetch rejects', async () => {
    installFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    renderWithProviders(
      <S3GatewayEditor item={makeItem('s3-gateway', 'S3 Gateway')} id="s3-fixture" />,
    );
    await waitFor(() =>
      expect(screen.getByText('Could not read the S3 gateway configuration')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // Toolbar (partial surface) stays up alongside the honest error.
    expect(screen.getByText('S3-compatible ADLS gateway')).toBeInTheDocument();
  });

  it('renders the error branch for an HTTP failure too (fetchInfo throws on !res.ok)', async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ ok: false, error: 'boom' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
    );
    renderWithProviders(
      <S3GatewayEditor item={makeItem('s3-gateway', 'S3 Gateway')} id="s3-fixture" />,
    );
    await waitFor(() =>
      expect(screen.getByText('Could not read the S3 gateway configuration')).toBeInTheDocument(),
    );
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
  });
});
