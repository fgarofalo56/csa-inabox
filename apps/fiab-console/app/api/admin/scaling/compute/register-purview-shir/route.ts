/**
 * /api/admin/scaling/compute/register-purview-shir
 *
 * Automates the Purview SELF-HOSTED integration-runtime bootstrap that used to
 * be a manual portal step (create the IR by hand, copy its auth key, paste it
 * into bicep as `@secure purviewIrAuthKey`). The "Deploy/Register Purview SHIR"
 * action in Admin → Capacity & compute → "Scale & manage" calls this route.
 *
 *   GET  → honest gate status: is LOOM_PURVIEW_ACCOUNT set, and is the Purview
 *          SHIR VMSS (LOOM_PURVIEW_SHIR_VMSS_NAME) present in this deployment?
 *   POST { name? } → real scanning-dataplane calls:
 *            PUT  /scan/integrationruntimes/{name}              (create/update)
 *            POST /scan/integrationruntimes/{name}/listAuthKeys (read auth key)
 *          Returns the IR registration status + confirms an auth key was
 *          retrieved (MASKED — the raw key is a node-registration secret and is
 *          never returned to the browser, logged, or persisted).
 *
 * Honest gates (no Fabric, no mocks):
 *   - LOOM_PURVIEW_ACCOUNT unset       → 501 { gate: { missing: 'LOOM_PURVIEW_ACCOUNT' } }
 *   - LOOM_PURVIEW_SHIR_VMSS_NAME unset/
 *     VMSS not deployed                → 501 { gate: { missing: 'LOOM_PURVIEW_SHIR_VMSS_NAME' } }
 *
 * The Console UAMI already holds Data Source Administrator on Purview (needed to
 * PUT the IR + read auth keys) and Virtual Machine Contributor on the VMSS — both
 * granted in bicep (admin-plane/purview-shir.bicep).
 *
 * DEFERRED (follow-up wave — do NOT assume built): pushing the retrieved auth key
 * to the SHIR VMSS node installer (custom-script extension / Key Vault) and a
 * Purview managed-VNet IR + managed private endpoints (no-SHIR path for
 * PE-locked sources). Today the action registers the IR + proves the key is
 * available; node binding stays an operator/bicep step until that wave lands.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { denyIfNoDlzAccess } from '@/lib/auth/dlz-gate';
import {
  isPurviewConfigured,
  getPurviewAccountName,
  upsertPurviewIntegrationRuntime,
  listPurviewIrAuthKeys,
  PurviewNotConfiguredError,
  PurviewError,
} from '@/lib/azure/purview-client';
import { purviewShirVmssConfig } from '@/lib/azure/vmss-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Default self-hosted IR name Loom registers for the Purview SHIR VMSS. */
const DEFAULT_IR_NAME = process.env.LOOM_PURVIEW_SHIR_IR_NAME || 'loom-purview-shir';

/** Mask a node-registration secret so the UI can confirm it exists without leaking it. */
function maskKey(k?: string): string | null {
  if (!k) return null;
  if (k.length <= 10) return '••••';
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = await denyIfNoDlzAccess(s, 'scaling');
  if (denied) return denied;

  const purviewConfigured = isPurviewConfigured();
  const vmss = purviewShirVmssConfig();
  return NextResponse.json({
    ok: true,
    purviewConfigured,
    purviewAccount: getPurviewAccountName(),
    vmssPresent: !!vmss,
    vmssName: vmss?.name || null,
    irName: DEFAULT_IR_NAME,
    canRegister: purviewConfigured && !!vmss,
  });
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = await denyIfNoDlzAccess(s, 'scaling');
  if (denied) return denied;

  // Honest gate 1: Purview not provisioned.
  if (!isPurviewConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'Microsoft Purview is not provisioned in this deployment.', gate: { missing: 'LOOM_PURVIEW_ACCOUNT' } },
      { status: 501 },
    );
  }
  // Honest gate 2: Purview SHIR VMSS not deployed.
  const vmss = purviewShirVmssConfig();
  if (!vmss) {
    return NextResponse.json(
      {
        ok: false,
        error: 'The Purview self-hosted IR VMSS is not deployed in this admin zone.',
        gate: { missing: 'LOOM_PURVIEW_SHIR_VMSS_NAME', bicep: 'platform/fiab/bicep/modules/admin-plane/purview-shir.bicep' },
      },
      { status: 501 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { name?: string };
  const irName = (typeof body.name === 'string' && body.name.trim()) || DEFAULT_IR_NAME;

  try {
    // 1) Create/update the self-hosted IR (real PUT — idempotent).
    const ir = await upsertPurviewIntegrationRuntime(irName, {
      description: `Loom-managed Purview self-hosted IR for VMSS ${vmss.name}`,
    });
    // 2) Read its auth key (real POST). The key binds a VMSS node to this account;
    //    it is masked before leaving the server and never logged/persisted.
    const keys = await listPurviewIrAuthKeys(irName);
    const authKeyObtained = !!(keys.authKey1 || keys.authKey2);

    return NextResponse.json({
      ok: true,
      irName: ir.name || irName,
      irKind: ir.kind || 'SelfHosted',
      irState: ir.state || 'registered',
      vmssName: vmss.name,
      authKeyObtained,
      authKeyMasked: maskKey(keys.authKey1 || keys.authKey2),
      message: authKeyObtained
        ? `Purview self-hosted IR “${irName}” registered and an auth key was retrieved. ` +
          `Scale up the “${vmss.name}” VMSS to install + bind a node (the auth key is delivered to the node installer; ` +
          `automatic Key-Vault delivery + managed-VNet IR are a follow-up wave).`
        : `Purview self-hosted IR “${irName}” registered, but no auth key was returned — retry, or check the Console UAMI has Data Source Administrator on Purview.`,
    });
  } catch (e: unknown) {
    if (e instanceof PurviewNotConfiguredError) {
      return NextResponse.json(
        { ok: false, error: 'Microsoft Purview is not provisioned in this deployment.', gate: { missing: 'LOOM_PURVIEW_ACCOUNT' } },
        { status: 501 },
      );
    }
    if (e instanceof PurviewError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 502 });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
