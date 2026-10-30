/**
 * Manage panes under the hub (W1-5), jsdom.
 *
 * Breaking values (assertion-design.md):
 *  - the URL assertions break if a pane drops `?gateway=<id>` for a non-default gateway
 *    (the fetched URL would equal the bare route), or ADDS `gateway=` for the default
 *    (the URL would carry the param);
 *  - the heading assertions break if a pane is not mounted for its tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ManagePanes } from '../gateway-detail';
import { withGateway } from '@/lib/components/admin/apim-pane-fetch';

const urls: string[] = [];

beforeEach(() => {
  urls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    urls.push(String(input));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        ok: true, apis: [], products: [], subscriptions: [], namedValues: [], backends: [],
        service: { name: 'apim-x', location: 'eastus', sku: { name: 'Developer', capacity: 1 }, provisioningState: 'Succeeded' },
        revisions: [], value: '<policies />',
      }),
    };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// [tab, heading text, the first (list) URL the pane must fetch]
const PANES = [
  ['service', 'Service overview', '/api/apim/service'],
  ['apis', 'APIs', '/api/items/apim-api'],
  ['products', 'Products', '/api/items/apim-product'],
  ['subscriptions', 'Subscriptions', '/api/apim/subscriptions'],
  ['named-values', 'Named values', '/api/apim/named-values'],
  ['backends', 'Backends', '/api/apim/backends'],
  ['policies', 'Global & scoped policies', '/api/apim/apis'],
  ['developer-portal', 'Developer portal', '/api/apim/developer-portal'],
] as const;

describe('Manage panes - eight panes, scoped by gatewayId', () => {
  for (const [tab, heading, route] of PANES) {
    it(`${tab}: registered gateway fetches ${route}?gateway=gw-b`, async () => {
      render(<ManagePanes tab={tab} gatewayId="gw-b" />);
      await waitFor(() => expect(urls).toContain(`${route}?gateway=gw-b`));
      expect(screen.getAllByText(heading).length).toBeGreaterThan(0);
      // Every request this pane made carries the gateway (a pane that scoped only its first call fails here).
      for (const u of urls) expect(u, `${tab} made an unscoped request ${u}`).toContain('gateway=gw-b');
    });

    it(`${tab}: default gateway fetches ${route} with NO gateway param`, async () => {
      render(<ManagePanes tab={tab} gatewayId={undefined} />);
      await waitFor(() => expect(urls).toContain(route));
      expect(screen.getAllByText(heading).length).toBeGreaterThan(0);
      for (const u of urls) expect(u, `${tab} leaked a gateway param ${u}`).not.toContain('gateway=');
    });
  }
});

describe('withGateway', () => {
  it('appends with ? or & and encodes the id', () => {
    expect(withGateway('/api/apim/x', 'a b')).toBe('/api/apim/x?gateway=a%20b');
    expect(withGateway('/api/apim/x?id=1', 'g')).toBe('/api/apim/x?id=1&gateway=g');
    expect(withGateway('/api/apim/x', undefined)).toBe('/api/apim/x');
    expect(withGateway('/api/apim/x', '')).toBe('/api/apim/x');
  });
});
