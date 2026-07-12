/**
 * CSP frame-src regression — the /admin/usage + /org-reports "Open analytics"
 * embed (and the Power BI report / dashboard / semantic-model editors) render
 * an iframe from the sovereign Power BI app host or Azure Managed Grafana. With
 * no `frame-src` directive the browser falls back to `default-src 'self'` and
 * blocks the frame ("This content is blocked."). This test locks the CSP so the
 * embed hosts stay allow-listed and framing our own app stays denied.
 */
import { describe, it, expect } from 'vitest';
// next.config.mjs lives at the console root; imported relative to __tests__.
import nextConfig from '../next.config.mjs';

async function getCsp(): Promise<string> {
  const headerGroups = await (nextConfig.headers as () => Promise<Array<{ headers: Array<{ key: string; value: string }> }>>)();
  for (const group of headerGroups) {
    const csp = group.headers.find((h) => h.key === 'Content-Security-Policy');
    if (csp) return csp.value;
  }
  throw new Error('no Content-Security-Policy header found in next.config headers()');
}

describe('CSP frame-src (Open-analytics embed unblock)', () => {
  it('declares an explicit frame-src directive', async () => {
    const csp = await getCsp();
    expect(csp).toContain('frame-src ');
  });

  it('allow-lists the sovereign Power BI embed hosts', async () => {
    const csp = await getCsp();
    const frameSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('frame-src'));
    expect(frameSrc).toBeDefined();
    // Commercial/GCC + GCC-High/IL5 + DoD embed app hosts (getPbiEmbedHostname()).
    expect(frameSrc).toContain('https://app.powerbi.com');
    expect(frameSrc).toContain('https://app.powerbigov.us');
    expect(frameSrc).toContain('https://app.mil.powerbigov.us');
  });

  it('allow-lists Azure Managed Grafana (Gov usage backend) hosts', async () => {
    const csp = await getCsp();
    const frameSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('frame-src'));
    expect(frameSrc).toContain('https://*.grafana.azure.com');
    expect(frameSrc).toContain('https://*.grafana.azure.us');
  });

  it('still denies framing our own app (frame-ancestors none) and keeps self', async () => {
    const csp = await getCsp();
    expect(csp).toContain("frame-ancestors 'none'");
    const frameSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('frame-src'));
    expect(frameSrc).toContain("'self'");
  });

  it('does not broaden frame-src to a bare https: wildcard', async () => {
    const csp = await getCsp();
    const frameSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('frame-src'))!;
    // Minimal + explicit: no `https:` scheme-wide wildcard in frame-src.
    expect(/(^|\s)https:(\s|$)/.test(frameSrc)).toBe(false);
  });
});
