/**
 * Wiring, not behaviour: loading the environments routes' shared helper must
 * register the observed-inventory findings source (gateways x MCP servers).
 *
 * Breaking value: delete the `observe/register` import from
 * lib/api-gateway/environments/route-helpers.ts and the second assertion
 * fails (`getFindingsSource()` stays undefined, so the findings route
 * answers with no source and no MCP finding can ever appear).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ tenantScopeId: () => 't1' }));

describe('environments findings wiring', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('control: before route-helpers loads, no findings source is registered', async () => {
    const deps = await import('@/lib/api-gateway/environments/deps');
    expect(deps.getFindingsSource()).toBeUndefined();
  });

  it('route-helpers registers the observed findings source on load', async () => {
    const deps = await import('@/lib/api-gateway/environments/deps');
    expect(deps.getFindingsSource()).toBeUndefined();
    await import('@/lib/api-gateway/environments/route-helpers');
    expect(deps.getFindingsSource()).toBeDefined();
  });
});
