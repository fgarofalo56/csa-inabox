import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { getArmTokenPreferUser } from '@/lib/auth/obo';
import { logSafe, logSafeError } from '@/lib/util/log-safe';
import {
  WIRE_SCRIPTS,
  isAzureLocation,
  isDlzDomainName,
  isSubscriptionId,
  resolveSelectedDlzs,
  runWireScript,
  scanDeployedDlzs,
  type RequestedDlz,
} from '@/lib/setup/wire-existing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/setup/wire-existing — Wire already-deployed DLZ(s) into the Admin Plane.
 *
 * Multi-sub mode Route B: The operator has selected one or more existing DLZs
 * (already deployed in other subscriptions) and wants to wire them into the
 * admin plane WITHOUT re-deploying. This endpoint:
 *
 *   1. Resolves each selected DLZ against Azure Resource Graph (proves the
 *      resource group actually exists; see the L2 note below on what this does
 *      and does NOT establish about the caller)
 *   2. Grants the Console UAMI navigator roles on each DLZ (via grant-navigator-rbac.sh)
 *   3. Discovers and patches navigator env vars (via patch-navigator-env.sh)
 *
 * No bicep deployment happens — only RBAC + environment variable wiring.
 *
 * ── SECURITY ──────────────────────────────────────────────────────────────
 * Request fields NEVER reach a shell. Earlier revisions built the DLZ resource
 * group by string concatenation and interpolated it into `execSync()` command
 * strings; `execSync` evaluates its argument with `/bin/sh -c`, so shell
 * metacharacters in `domainName` / `location` / `subscriptionId` were executed
 * as the console process. The three controls that replace that are documented in
 * `lib/setup/wire-existing.ts`:
 *
 *   L1  no shell        — child processes start via `spawnSync` on an argv array
 *                         with `shell: false`; values ride in `env`.
 *   L2  resolve         — the resource-group name is the one Azure Resource
 *                         Graph returned, not one assembled from request text.
 *   L3  allow-lists     — subscription id / location / domain are matched
 *                         against anchored character-class patterns first.
 *
 * Authorization matches every sibling setup route that performs an admin-tier
 * action (`/api/setup/deploy`, `deploy-preflight`, `discover-services`,
 * `estate-scan`, `landing-zones/grant`, `validate-adoption`): the caller must
 * hold Admin on the `admin.deploy-dlz` capability. The Setup Wizard already
 * renders the 403 body this emits.
 */

interface WireExistingConfig {
  /**
   * Sovereign boundary the wizard is operating in. ACCEPTED BUT NOT USED, and
   * deliberately NOT required: nothing on this path branches on it. Cloud
   * selection comes from the deployment's own configuration via `armBase()`,
   * not from the request — which is the correct source, since a request cannot
   * be allowed to redirect the console at a different ARM endpoint. Requiring a
   * field the handler ignores only manufactures a way for a valid call to fail.
   */
  boundary?: string;
  subscriptionId?: string;  // Admin plane sub
  subscriptionName?: string;
  location?: string;
  selectedExistingDlzs?: Array<{ subscriptionId: string; domainName: string }>;
}

interface WireResult {
  domainName: string;
  subscriptionId: string;
  dlzRg: string;
  success: boolean;
  message: string;
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  // Wiring a Data Landing Zone grants the Console UAMI roles across another
  // subscription and rewrites the live console's environment — an admin-tier
  // action, and the same capability POST /api/setup/deploy enforces. Tenant
  // admins bypass; anyone else must have been delegated it at /admin/permissions.
  const gate = await enforceCapability(session, 'admin.deploy-dlz', 'Admin');
  if (gate) return gate;

  const body = (await req.json().catch(() => ({}))) as WireExistingConfig;

  // ─────────────────────────────────────────────────────────────────────────
  // Validate required fields
  // ─────────────────────────────────────────────────────────────────────────
  const missing: string[] = [];
  if (!body.subscriptionId) missing.push('subscriptionId (admin plane)');
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
  // L3 — allow-list validation, BEFORE a token is acquired or a process spawned
  //
  // Every field below is echoed into an Azure query, a resource coordinate, or
  // a child process environment. Each is confined to the character set Azure
  // itself permits, which contains no shell metacharacter, quote, whitespace or
  // line terminator. Invalid input is refused outright — never escaped, never
  // stripped, never partially accepted.
  // ─────────────────────────────────────────────────────────────────────────
  const invalid: string[] = [];
  if (!isSubscriptionId(body.subscriptionId)) {
    invalid.push('subscriptionId (admin plane) must be a GUID');
  }
  if (!isAzureLocation(body.location)) {
    invalid.push('location must be an Azure region short name (lower-case letters and digits)');
  }
  body.selectedExistingDlzs!.forEach((dlz, i) => {
    if (!isSubscriptionId(dlz?.subscriptionId)) {
      invalid.push(`selectedExistingDlzs[${i}].subscriptionId must be a GUID`);
    }
    if (!isDlzDomainName(dlz?.domainName)) {
      invalid.push(
        `selectedExistingDlzs[${i}].domainName must be alphanumeric with internal hyphens only`,
      );
    }
  });

  if (invalid.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        error: `Wire-existing config invalid — ${invalid.join('; ')}`,
        invalid,
      },
      { status: 400 },
    );
  }

  const adminSubscriptionId = body.subscriptionId!;
  const requested: RequestedDlz[] = body.selectedExistingDlzs!.map((d) => ({
    subscriptionId: d.subscriptionId,
    domainName: d.domainName,
  }));

  // ─────────────────────────────────────────────────────────────────────────
  // L2 — resolve each selection against real estate state
  //
  // The resource-group name used downstream is the one AZURE returned; the
  // request never supplies a resource coordinate of its own construction. That
  // is an EXISTENCE proof and it is the property this control rests on.
  //
  // It is NOT a per-caller entitlement check, and must not be read as one:
  // `getArmTokenPreferUser` prefers the signed-in user's OBO token but FALLS
  // BACK to the Console UAMI, so the scan honours whichever identity the token
  // belongs to. Authorization for this route is the `admin.deploy-dlz` gate
  // above, not the reach of this scan.
  // ─────────────────────────────────────────────────────────────────────────
  let token: string;
  try {
    ({ token } = await getArmTokenPreferUser(session));
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: `Could not acquire an ARM token to verify the selected Data Landing Zones: ${logSafeError(e)}`,
        remediation: {
          message:
            'Grant the Console UAMI (or your signed-in account) Reader on the subscriptions ' +
            'whose DLZs you want to wire, then retry.',
          commands: [],
        },
      },
      { status: 502 },
    );
  }

  let discovered;
  try {
    discovered = await scanDeployedDlzs(token);
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: `Azure Resource Graph lookup of deployed Data Landing Zones failed: ${logSafeError(e)}`,
        remediation: {
          message:
            'The selected DLZs could not be verified, so nothing was wired. Confirm the Console ' +
            'identity has Reader on the target subscriptions and retry.',
          commands: [],
        },
      },
      { status: 502 },
    );
  }

  const resolved = resolveSelectedDlzs(requested, discovered);

  // ─────────────────────────────────────────────────────────────────────────
  // Wire each resolved DLZ
  // ─────────────────────────────────────────────────────────────────────────
  const wireResults: WireResult[] = [];

  for (const entry of resolved) {
    if (!entry.ok) {
      wireResults.push({
        domainName: entry.requested.domainName,
        subscriptionId: entry.requested.subscriptionId,
        dlzRg: '',
        success: false,
        message: `Failed to wire DLZ '${entry.requested.domainName}': ${entry.reason}`,
      });
      continue;
    }

    const dlzRg = entry.discovered.rg;

    // L1 — argv array + `shell: false`; the coordinates travel as environment
    // variables, which is also the only form these scripts read.
    const scriptEnv = {
      SUB: adminSubscriptionId,
      DLZ_RG: dlzRg,
      LOCATION: body.location!,
    };

    const grant = runWireScript(WIRE_SCRIPTS.grantRbac, scriptEnv);
    if (!grant.ok) {
      // An RBAC grant can legitimately fail on permissions; env patching is still
      // worth attempting, so this is recorded rather than fatal.
      console.warn(`RBAC grant for ${logSafe(dlzRg)} failed:`, logSafe(grant.reason));
    }

    const patch = runWireScript(WIRE_SCRIPTS.patchEnv, scriptEnv);
    if (!patch.ok) {
      console.warn(`Env patching for ${logSafe(dlzRg)} failed:`, logSafe(patch.reason));
    }

    // Report what actually happened. Claiming success for a step that did not
    // run would be exactly the dishonest outcome deploy-integrity.md R6/R7 forbid.
    const success = grant.ok && patch.ok;
    wireResults.push({
      domainName: entry.requested.domainName,
      subscriptionId: entry.requested.subscriptionId,
      dlzRg,
      success,
      message: success
        ? `Wired DLZ '${entry.requested.domainName}' — RBAC + env vars patched.`
        : `DLZ '${entry.requested.domainName}' (${dlzRg}) was found, but wiring did not complete. ` +
          `RBAC grant: ${grant.reason} Env patch: ${patch.reason}`,
    });
  }

  const allSuccess = wireResults.every((r) => r.success);

  if (!allSuccess) {
    return NextResponse.json(
      {
        ok: false,
        error: `Wire-existing: ${wireResults.filter((r) => !r.success).length} of ${wireResults.length} DLZ(s) failed to wire`,
        wireResults,
        remediation: {
          message:
            'Some DLZ(s) could not be wired. Each message above states what failed. You can retry ' +
            'after correcting the issue.',
          // Every value below has passed the L3 allow-list (or is an Azure-returned
          // resource-group name), so these copy-paste commands cannot smuggle shell
          // syntax into the operator's own terminal either.
          commands: wireResults
            .filter((r) => !r.success)
            .map((r) =>
              r.dlzRg
                ? `# For DLZ '${r.domainName}' in ${r.subscriptionId}:\n` +
                  `az group show --name ${r.dlzRg} --subscription ${r.subscriptionId}`
                : `# DLZ '${r.domainName}' was not found in subscription ${r.subscriptionId}.\n` +
                  `az group list --subscription ${r.subscriptionId} --query "[?starts_with(name,'rg-csa-loom-dlz-')].name" -o tsv`,
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
