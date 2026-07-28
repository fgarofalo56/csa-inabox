/**
 * Dependency chaos harness — loom-ui-verify drill (CH1).
 *
 * Driven by the `verify` Playwright project (playwright.config.ts) against a
 * live deployment with a pre-minted storageState (no MSAL). This is the CH1
 * dependency-plane sibling of the A13 Spark chaos drill.
 *
 * What it verifies (SAFE by default — it does NOT arm a fault unless the
 * deployment is explicitly a non-prod chaos-enabled one):
 *   1. GET /api/admin/chaos/dependency returns a real status envelope
 *      (enabled / flagOn / armable + the resilience matrix + coverage).
 *   2. The status is internally consistent (armable ⇔ flagOn && enabled).
 *   3. When the harness IS armable (LOOM_DEPENDENCY_CHAOS_ENABLED=true + flag on
 *      + LOOM_INTERNAL_TOKEN provided in CHAOS_INTERNAL_TOKEN), it arms a
 *      short-TTL cosmos-429 fault, confirms it shows armed, then disarms it —
 *      proving the arm/disarm round-trip is real. Otherwise this step is skipped
 *      with an annotation (an honest gate, never a failure).
 *
 * Failure semantics match admin-verify.spec.ts: 401 or a non-gate 5xx fail.
 */
import { test, expect, type APIResponse } from '@playwright/test';

const BASE = process.env.LOOM_URL!;
// A valid LOOM_INTERNAL_TOKEN — only set in a non-prod chaos drill run.
const INTERNAL_TOKEN = process.env.CHAOS_INTERNAL_TOKEN || '';

async function body(res: APIResponse): Promise<Record<string, unknown>> {
  try { return JSON.parse(await res.text()) as Record<string, unknown>; } catch { return {}; }
}

test.describe('CH1 dependency chaos harness', () => {
  test('GET status returns a real, consistent envelope', async ({ request }) => {
    const res = await request.get(`${BASE}/api/admin/chaos/dependency`);
    expect(res.status(), 'admin session must be accepted (not 401)').not.toBe(401);
    expect(res.status(), 'no server crash').toBeLessThan(500);
    if (res.status() !== 200) {
      test.info().annotations.push({ type: 'gate', description: `status ${res.status()} — treated as an honest gate` });
      return;
    }
    const j = await body(res);
    expect(j.ok).toBe(true);
    // armable ⇔ flagOn && enabled
    expect(j.armable).toBe(Boolean(j.flagOn) && Boolean(j.enabled));
    // The resilience matrix is always present + non-empty.
    expect(Array.isArray(j.matrix)).toBe(true);
    expect((j.matrix as unknown[]).length).toBeGreaterThan(4);
    expect(Array.isArray(j.faultPoints)).toBe(true);
    expect((j.faultPoints as unknown[]).length).toBe(5);
  });

  test('arm → confirm → disarm round-trip (chaos-enabled deployments only)', async ({ request }) => {
    const statusRes = await request.get(`${BASE}/api/admin/chaos/dependency`);
    if (statusRes.status() !== 200) { test.skip(true, 'status not 200'); return; }
    const status = await body(statusRes);
    if (!status.armable || !INTERNAL_TOKEN) {
      test.info().annotations.push({
        type: 'gate',
        description: 'harness not armable in this deployment (opt-in flag / LOOM_DEPENDENCY_CHAOS_ENABLED / CHAOS_INTERNAL_TOKEN absent) — arm/disarm step skipped',
      });
      test.skip(true, 'not armable');
      return;
    }
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${INTERNAL_TOKEN}` };

    // Arm a short-TTL cosmos-429 fault.
    const armRes = await request.post(`${BASE}/api/admin/chaos/dependency`, {
      headers, data: { action: 'arm', point: 'cosmos-429', ttlMs: 5000, occurrences: 1, reason: 'loom-ui-verify drill' },
    });
    expect(armRes.status(), await armRes.text()).toBe(200);
    const armed = await body(armRes);
    expect(Array.isArray(armed.armed)).toBe(true);
    expect((armed.armed as Array<{ point: string }>).some((a) => a.point === 'cosmos-429')).toBe(true);

    // Disarm it (leave the deployment clean).
    const disRes = await request.post(`${BASE}/api/admin/chaos/dependency`, {
      headers, data: { action: 'disarm', point: 'cosmos-429' },
    });
    expect(disRes.status()).toBe(200);
    const disarmed = await body(disRes);
    expect((disarmed.armed as Array<{ point: string }>).some((a) => a.point === 'cosmos-429')).toBe(false);
  });
});
