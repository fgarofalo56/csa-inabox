/**
 * GET  /api/admin/mcp-servers/deploy
 *   Report the MCP Azure Files persistence config gate + whether the
 *   loom-mcp container app already has the share mounted.
 *
 * POST /api/admin/mcp-servers/deploy
 *   { mountPath?, accessMode?, subPath?, workloadProfileName? }
 *   Real two-step ARM operation:
 *     1. listKeys on the MCP Azure Files storage account (identity mounts are
 *        unsupported by Container Apps — Learn).
 *     2. PUT managedEnvironments/storages registering the share.
 *     3. PUT the loom-mcp container app with the volume + volumeMount → new revision.
 *
 * Azure-native by default — no Microsoft Fabric / Power BI dependency. On the
 * AKS boundaries (GCC-High / IL5 / DoD) the client throws AcaPlatformError and
 * the route surfaces the AKS Azure Files PVC remediation (honest 409 gate).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  upsertEnvStorage,
  deployMcpContainerApp,
  getStorageAccountKey,
  readMcpFilesConfig,
  McpFilesNotConfiguredError,
  AcaNotConfiguredError,
  AcaPlatformError,
  ACA_WORKLOAD_PROFILES,
  type AcaAccessMode,
} from '@/lib/azure/container-apps-arm-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACCESS_MODES = new Set<AcaAccessMode>(['ReadWrite', 'ReadOnly']);

export async function GET(_req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const cfg = readMcpFilesConfig();
    return NextResponse.json({ ok: true, configured: true, config: cfg });
  } catch (e: any) {
    if (e instanceof McpFilesNotConfiguredError) {
      return NextResponse.json({
        ok: false, configured: false, error: e.message, hint: `Set ${e.missing.join(', ')}.`,
      }, { status: 503 });
    }
    if (e instanceof AcaNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: `Set ${e.missing.join(', ')}.` }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({})) as {
    mountPath?: string;
    accessMode?: AcaAccessMode;
    subPath?: string;
    workloadProfileName?: string;
  };

  // Structured validation (loom-no-freeform-config): every field is enumerated
  // or constrained — no arbitrary env/secret blob accepted.
  const accessMode: AcaAccessMode = body.accessMode || 'ReadWrite';
  if (!ACCESS_MODES.has(accessMode)) {
    return NextResponse.json({ ok: false, error: 'accessMode must be ReadWrite or ReadOnly' }, { status: 400 });
  }
  if (body.workloadProfileName && !ACA_WORKLOAD_PROFILES.has(body.workloadProfileName)) {
    return NextResponse.json({
      ok: false, error: `workloadProfileName must be one of ${[...ACA_WORKLOAD_PROFILES].join(', ')}`,
    }, { status: 400 });
  }
  if (body.mountPath && !body.mountPath.startsWith('/')) {
    return NextResponse.json({ ok: false, error: 'mountPath must be an absolute path' }, { status: 400 });
  }
  if (body.subPath && body.subPath.startsWith('/')) {
    return NextResponse.json({ ok: false, error: 'subPath must not start with "/"' }, { status: 400 });
  }

  try {
    const cfg = readMcpFilesConfig();
    const mountPath = body.mountPath || cfg.mountPath;

    // 1. Resolve the storage-account key (identity mounts unsupported by ACA).
    const accountKey = await getStorageAccountKey(cfg.storageAccount, cfg.resourceGroup);

    // 2. Register the share on the managed environment.
    const storage = await upsertEnvStorage({
      storageName: cfg.storageName,
      accountName: cfg.storageAccount,
      accountKey,
      shareName: cfg.shareName,
      accessMode,
    });

    // 3. Mount it into the loom-mcp container app (new revision).
    const app = await deployMcpContainerApp({
      name: 'loom-mcp',
      storageName: cfg.storageName,
      mountPath,
      subPath: body.subPath,
      workloadProfileName: body.workloadProfileName,
      env: [{ name: 'LOOM_MCP_DATA_DIR', value: mountPath }],
    });

    return NextResponse.json({ ok: true, storage, app, mountPath });
  } catch (e: any) {
    if (e instanceof McpFilesNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: `Set ${e.missing.join(', ')}.` }, { status: 503 });
    }
    if (e instanceof AcaNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: `Set ${e.missing.join(', ')}.` }, { status: 503 });
    }
    if (e instanceof AcaPlatformError) {
      // AKS boundary — Azure Files PVC path, not a Container Apps storage mount.
      return NextResponse.json({ ok: false, error: e.message }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status: e?.status || 502 });
  }
}
