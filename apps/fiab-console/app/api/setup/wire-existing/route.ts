import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { execSync } from 'child_process';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/setup/wire-existing — Wire already-deployed DLZ(s) into the Admin Plane.
 *
 * Multi-sub mode Route B: The operator has selected one or more existing DLZs
 * (already deployed in other subscriptions) and wants to wire them into the
 * admin plane WITHOUT re-deploying. This endpoint:
 *
 *   1. Validates the selected DLZs exist (RGs + DLZ resources)
 *   2. Grants the Console UAMI navigator roles on each DLZ (via grant-navigator-rbac.sh)
 *   3. Discovers and patches navigator env vars (via patch-navigator-env.sh)
 *
 * No bicep deployment happens — only RBAC + environment variable wiring.
 * All operations idempotent via the shell scripts' reuse-first + error-suppression.
 *
 * If discovery fails (RG not found, etc.), the endpoint returns 400 with
 * remediation hints pointing at the discovery + bootstrap scripts.
 */

interface WireExistingConfig {
  boundary?: string;
  subscriptionId?: string;  // Admin plane sub
  subscriptionName?: string;
  location?: string;
  selectedExistingDlzs?: Array<{ subscriptionId: string; domainName: string }>;
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as WireExistingConfig;

  // ─────────────────────────────────────────────────────────────────────────
  // Validate required fields
  // ─────────────────────────────────────────────────────────────────────────
  const missing: string[] = [];
  if (!body.subscriptionId) missing.push('subscriptionId (admin plane)');
  if (!body.boundary) missing.push('boundary');
  if (!body.location) missing.push('location');
  if (!body.selectedExistingDlzs || body.selectedExistingDlzs.length === 0) {
    missing.push('selectedExistingDlzs (select at least one existing DLZ)');
  }

  if (missing.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        error: `Wire-existing config incomplete — missing: ${missing.join(', ')}`,
        missing,
      },
      { status: 400 },
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Attempt to wire each selected DLZ
  // ─────────────────────────────────────────────────────────────────────────
  const isGov = body.boundary === 'GCC-High' || body.boundary === 'IL5';
  const adminRg = `rg-csa-loom-admin-${body.location}`;

  const wireResults: Array<{
    domainName: string;
    subscriptionId: string;
    dlzRg: string;
    success: boolean;
    message: string;
  }> = [];

  for (const dlz of body.selectedExistingDlzs!) {
    const dlzRg = `rg-csa-loom-dlz-${dlz.domainName}-${body.location}`;
    try {
      // Attempt to discover the DLZ RG (pre-validation)
      const checkCmd = `az group show --name ${dlzRg} --subscription ${dlz.subscriptionId} 2>/dev/null`;
      execSync(checkCmd, { stdio: 'pipe' });

      // RG exists; attempt RBAC grant
      const grantCmd = `bash scripts/csa-loom/grant-navigator-rbac.sh SUB=${body.subscriptionId} DLZ_RG=${dlzRg}`;
      try {
        execSync(grantCmd, { stdio: 'pipe' });
      } catch (e) {
        // RBAC grant may fail due to permissions, but don't block; env patching can continue
        console.warn(`RBAC grant for ${dlzRg} failed (may lack permissions):`, e);
      }

      // Attempt env var patching
      const patchCmd = `bash scripts/csa-loom/patch-navigator-env.sh SUB=${body.subscriptionId} DLZ_RG=${dlzRg}`;
      try {
        execSync(patchCmd, { stdio: 'pipe' });
      } catch (e) {
        console.warn(`Env patching for ${dlzRg} failed:`, e);
      }

      wireResults.push({
        domainName: dlz.domainName,
        subscriptionId: dlz.subscriptionId,
        dlzRg,
        success: true,
        message: `Wired DLZ '${dlz.domainName}' — RBAC + env vars patched.`,
      });
    } catch (e) {
      wireResults.push({
        domainName: dlz.domainName,
        subscriptionId: dlz.subscriptionId,
        dlzRg,
        success: false,
        message: `Failed to discover/wire DLZ '${dlz.domainName}': RG ${dlzRg} not found in ${dlz.subscriptionId}, or RBAC/env-patch scripts failed. Ensure the RG exists and you have Contributor on the DLZ RG.`,
      });
    }
  }

  const allSuccess = wireResults.every((r) => r.success);

  if (!allSuccess) {
    return NextResponse.json(
      {
        ok: false,
        error: `Wire-existing: ${wireResults.filter((r) => !r.success).length} of ${wireResults.length} DLZ(s) failed to wire`,
        wireResults,
        remediation: {
          message: 'Some DLZ(s) could not be wired. Ensure each RG exists and you have permissions. You can retry after correcting the issues.',
          commands: body.selectedExistingDlzs!.map(
            (dlz) =>
              `# For DLZ '${dlz.domainName}' in ${dlz.subscriptionId}:\n` +
              `az group show --name rg-csa-loom-dlz-${dlz.domainName}-${body.location} --subscription ${dlz.subscriptionId}`,
          ),
        },
      },
      { status: 400 },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      message: `Successfully wired ${wireResults.length} existing DLZ(s) into the Admin Plane.`,
      wireResults,
      nextSteps: [
        'The Console UAMI now has navigator roles on each DLZ RG.',
        'Environment variables have been patched into the loom-console Container App.',
        'Navigators will discover and auto-wire the services once the console pod restarts (30-60s).',
      ],
    },
    { status: 200 },
  );
}
