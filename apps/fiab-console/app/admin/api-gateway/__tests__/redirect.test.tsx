/**
 * Legacy route redirects (W1-5).
 *
 * Breaking values: with the flag unset or "true" the page must call redirect() with the hub path
 * (fails if it renders the legacy page or targets another path); with LOOM_APIPLANE_ENABLED=false
 * redirect must NOT be called and the legacy page renders (fails if the flag is ignored).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const redirectMock = vi.fn((to: string) => { throw new Error(`NEXT_REDIRECT:${to}`); });
vi.mock('next/navigation', async (orig) => ({ ...(await orig<object>()), redirect: (to: string) => redirectMock(to) }));
vi.mock('../_legacy/api-management-legacy', () => ({ default: () => <div>legacy-api-management</div> }));
vi.mock('../_legacy/mcp-servers-legacy', () => ({ default: () => <div>legacy-mcp</div> }));

import ApiManagementPage from '../../api-management/page';
import McpServersPage from '../../mcp-servers/page';
import { isApiPlaneEnabled, legacyRedirectTarget } from '../_lib/flag';

afterEach(() => { vi.unstubAllEnvs(); redirectMock.mockClear(); });

describe('flag parsing', () => {
  it('only the literal "false" (any case) disables; unset/true/garbage enable', () => {
    expect(isApiPlaneEnabled({})).toBe(true);
    expect(isApiPlaneEnabled({ LOOM_APIPLANE_ENABLED: 'true' })).toBe(true);
    expect(isApiPlaneEnabled({ LOOM_APIPLANE_ENABLED: 'FALSE' })).toBe(false);
    expect(isApiPlaneEnabled({ LOOM_APIPLANE_ENABLED: 'false' })).toBe(false);
    expect(legacyRedirectTarget('/x', { LOOM_APIPLANE_ENABLED: 'false' })).toBeNull();
  });
});

describe('/admin/api-management', () => {
  it('flag on: redirects to the hub', () => {
    vi.stubEnv('LOOM_APIPLANE_ENABLED', 'true');
    expect(() => ApiManagementPage()).toThrow('NEXT_REDIRECT:/admin/api-gateway');
    expect(redirectMock).toHaveBeenCalledWith('/admin/api-gateway');
  });
  it('flag off: no redirect, legacy page renders', () => {
    vi.stubEnv('LOOM_APIPLANE_ENABLED', 'false');
    const { getByText } = render(ApiManagementPage());
    expect(redirectMock).not.toHaveBeenCalled();
    expect(getByText('legacy-api-management')).toBeTruthy();
  });
});

describe('/admin/mcp-servers', () => {
  it('flag on: redirects to the hub MCP tab', () => {
    vi.stubEnv('LOOM_APIPLANE_ENABLED', 'true');
    expect(() => McpServersPage()).toThrow('NEXT_REDIRECT:/admin/api-gateway?tab=mcp');
  });
  it('flag off: no redirect, legacy page renders', () => {
    vi.stubEnv('LOOM_APIPLANE_ENABLED', 'false');
    const { getByText } = render(McpServersPage());
    expect(redirectMock).not.toHaveBeenCalled();
    expect(getByText('legacy-mcp')).toBeTruthy();
  });
});
