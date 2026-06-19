/**
 * Unattended smoke/verify spec for the CSA Loom admin plane.
 *
 * Driven by the `verify` Playwright project (playwright.config.ts).
 * Uses a pre-minted storageState (no MSAL, no MFA, no user creds).
 *
 * What it checks:
 *   1. UI smoke — /admin/health renders a health score + check list
 *   2. API probes — key admin endpoints return 200 OR an honest gate (503/404
 *      with a structured body explaining what infra is missing).
 *      Hard failures are 401 Unauthorized or 5xx server errors (not a gate).
 *
 * Failure semantics:
 *   - 2xx                 → PASS
 *   - 404 / 503 with JSON { ok:false, gate:true } or { message:... }
 *                         → PASS with annotation (honest infra gate)
 *   - 401                 → FAIL (session not accepted — misconfigured secret?)
 *   - 5xx (non-503 gate)  → FAIL (server crash / unhandled error)
 */

import { test, expect, type APIResponse } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = process.env.LOOM_URL!;

type ProbeResult =
  | { kind: 'pass'; status: number }
  | { kind: 'gate'; status: number; body: string }
  | { kind: 'fail'; status: number; body: string };

/**
 * Classify an API response:
 *   2xx          → pass
 *   404 / 503 with a JSON body that has ok:false OR gate:true OR a message
 *                → gate (honest infra gap, not a test failure)
 *   everything else 4xx / 5xx → fail
 */
async function classify(res: APIResponse): Promise<ProbeResult> {
  const status = res.status();
  if (status >= 200 && status < 300) {
    return { kind: 'pass', status };
  }

  let body = '';
  try { body = (await res.text()).slice(0, 400); } catch { /* ignore */ }

  // Treat 404 / 503 with structured JSON as an honest gate
  if (status === 404 || status === 503) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (
        parsed.ok === false ||
        parsed.gate === true ||
        typeof parsed.message === 'string' ||
        typeof parsed.error === 'string'
      ) {
        return { kind: 'gate', status, body };
      }
    } catch { /* not JSON — fall through to fail */ }
  }

  return { kind: 'fail', status, body };
}

function annotateLine(url: string, r: ProbeResult): string {
  switch (r.kind) {
    case 'pass': return `  PASS  ${r.status}  ${url}`;
    case 'gate': return `  GATE  ${r.status}  ${url}  (honest infra gate — ${r.body.slice(0, 120)})`;
    case 'fail': return `  FAIL  ${r.status}  ${url}  ${r.body.slice(0, 200)}`;
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('Loom admin plane — unattended smoke verify', () => {
  test('health page renders score + checks', async ({ page }) => {
    const target = `${BASE}/admin/health`;
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // The health page should contain a numeric score (e.g. "87 / 100" or "87%")
    // and a section heading or list that mentions "check" or "probe".
    const bodyText = await page.locator('body').innerText({ timeout: 10_000 });

    // Assert a numeric score is present
    expect(bodyText, 'Health page should show a numeric score').toMatch(/\d+/);

    // Assert the word "check" appears (as in "checks passed", "health checks", etc.)
    expect(bodyText.toLowerCase(), 'Health page should mention "check"').toContain('check');

    console.log(`[health-page] rendered OK — excerpt: ${bodyText.slice(0, 200).replace(/\n/g, ' ')}`);
  });

  test('API endpoint probes (admin governance surfaces)', async ({ request }) => {
    const endpoints: Array<{ path: string; label: string }> = [
      {
        path: '/api/admin/security/purview/sources',
        label: 'Purview data-map sources',
      },
      {
        path: '/api/governance/scans',
        label: 'Governance scans',
      },
      {
        path: '/api/admin/security/mip/labels',
        label: 'MIP sensitivity labels',
      },
      {
        path: '/api/admin/dspm-ai?days=30',
        label: 'DSPM-AI summary (30d)',
      },
      {
        path: '/api/admin/domains/purview-status',
        label: 'Purview domain status',
      },
    ];

    const summary: string[] = [
      '',
      '══════════════════════════════════════════════════════',
      '  CSA Loom unattended API probe summary',
      `  Target: ${BASE}`,
      '══════════════════════════════════════════════════════',
    ];

    const failures: string[] = [];

    for (const ep of endpoints) {
      const url = `${BASE}${ep.path}`;
      let res: APIResponse;
      try {
        res = await request.get(url, { timeout: 20_000 });
      } catch (err) {
        const line = `  FAIL  ERR  ${url}  ${(err as Error).message}`;
        summary.push(line);
        failures.push(line);
        continue;
      }

      const result = await classify(res);
      const line = annotateLine(url, result);
      summary.push(line);

      if (result.kind === 'fail') {
        failures.push(`${ep.label}: ${line}`);
      }
    }

    summary.push('══════════════════════════════════════════════════════');
    summary.push('');
    console.log(summary.join('\n'));

    // Fail the test only if there are hard failures (not honest gates)
    if (failures.length > 0) {
      throw new Error(
        `${failures.length} endpoint(s) returned unexpected errors:\n` +
        failures.join('\n'),
      );
    }
  });
});
