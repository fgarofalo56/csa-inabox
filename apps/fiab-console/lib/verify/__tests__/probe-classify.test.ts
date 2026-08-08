/**
 * classify() contract — pinned against REAL live response bodies.
 *
 * The defect (F1): classify() parsed a body that had ALREADY been truncated to
 * 400 chars, so any honest gate with an envelope longer than that threw
 * SyntaxError and was reported as a hard failure. The richer the remediation,
 * the more certainly it was misclassified.
 *
 * The fixtures below are the ACTUAL bodies the live Commercial console returned
 * on 2026-08-07, captured with a minted session — not hand-written shapes that
 * would model the code rather than the server.
 */
import { describe, it, expect } from 'vitest';
import { classifyProbeResponse } from '../probe-classify';

/** Real body: GET /api/admin/security/mip/labels → 503 (~1.2 kB). */
const MIP_GATE_BODY = JSON.stringify({
  ok: false,
  error: 'Microsoft Information Protection is not wired in this deployment: missing LOOM_MIP_ENABLED',
  code: 'mip_not_configured',
  hint: {
    missingEnvVar: 'LOOM_MIP_ENABLED',
    bicepModule: 'platform/fiab/bicep/modules/admin-plane/main.bicep',
    bicepStatus:
      'Wire LOOM_MIP_ENABLED=true into apps[].env in admin-plane/main.bicep alongside the '
      + 'existing LOOM_UAMI_CLIENT_ID. The Container App env block already supports it once added.',
    rolesRequired: [
      {
        name: 'InformationProtectionPolicy.Read.All',
        appRoleId: '19da66cb-0fb0-4390-b071-ebc76a349482',
        scope: 'Microsoft Graph (app permission, admin-consented)',
        reason: 'Required to list tenant-wide sensitivity labels and label policies.',
      },
      {
        name: 'SensitivityLabel.Evaluate',
        appRoleId: '57f0b71b-a759-45a0-9a0f-cc099fbd9a44',
        scope: 'Microsoft Graph (app permission, admin-consented)',
        reason: 'Required for the "apply label to a Loom item" action.',
      },
    ],
    followUp:
      'Operator action: (1) set LOOM_MIP_ENABLED=true on the loom-console Container App, '
      + '(2) run scripts/csa-loom/grant-graph-approles.sh, (3) Tenant Admin issues admin consent.',
  },
});

describe('classifyProbeResponse', () => {
  it('classifies the REAL 1.2 kB MIP gate as a GATE, not a failure', async () => {
    // The regression test. Before F1 this returned kind:'fail' — solely because
    // the body exceeded the 400-char display truncation.
    expect(MIP_GATE_BODY.length).toBeGreaterThan(400);
    const r = await classifyProbeResponse(503, async () => MIP_GATE_BODY);
    expect(r.kind).toBe('gate');
    expect(r.status).toBe(503);
  });

  it('still truncates the body it REPORTS, so a huge envelope cannot flood the log', async () => {
    const r = await classifyProbeResponse(503, async () => MIP_GATE_BODY);
    expect(r.kind === 'gate' && r.body.length).toBe(400);
  });

  it('a 2xx is a pass', async () => {
    expect((await classifyProbeResponse(200, async () => '{"ok":true}')).kind).toBe('pass');
  });

  it('a 503 that is NOT structured JSON is still a hard FAIL (non-vacuity)', async () => {
    // The classifier must not have become a rubber stamp for every 503: an
    // upstream HTML error page is a real outage, not an honest gate.
    const r = await classifyProbeResponse(503, async () => '<html><body>Service unavailable</body></html>');
    expect(r.kind).toBe('fail');
  });

  it('a 500 is a hard FAIL even with a perfect gate envelope', async () => {
    // Only 404/503 can be gates. A 500 means the route threw.
    expect((await classifyProbeResponse(500, async () => MIP_GATE_BODY)).kind).toBe('fail');
  });

  it('a 503 with valid JSON that carries no gate signal is a FAIL', async () => {
    expect((await classifyProbeResponse(503, async () => '{"foo":1}')).kind).toBe('fail');
  });
});
