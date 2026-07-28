/**
 * Unity Catalog capability discovery — cloud-aware backend + per-capability
 * support map.
 *
 *   GET /api/catalog/unity/capabilities →
 *     { ok, backend: 'databricks'|'oss', cloud, configured, gate?, capabilities[] }
 *
 * One source of truth (`UC_CAPABILITIES` in lib/azure/uc-backend.ts) drives the
 * /catalog/unity panes: each pane asks this route which backend is active and
 * whether its capability is supported, and renders an honest per-cloud
 * capability note (naming the Loom-native fallback) instead of a dead gate
 * (per .claude/rules/no-vaporware.md + no-fabric-dependency.md).
 */
import { NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { resolveUcBackend, UC_CAPABILITIES, ossUcBase, OssUcNotConfiguredError, unityAuthorizationPosture } from '@/lib/azure/uc-backend';
import { isGovCloud, cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';
import { databricksConfigGate } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async () => {

  const backend = resolveUcBackend();
  let configured = true;
  let gate: { title: string; detail: string; envVar?: string; bicepModule?: string } | undefined;

  if (backend === 'oss') {
    try {
      ossUcBase();
    } catch (e: any) {
      configured = false;
      if (e instanceof OssUcNotConfiguredError) {
        gate = {
          title: 'OSS Unity Catalog is not deployed',
          detail: e.hint.bicepStatus,
          envVar: e.hint.missingEnvVar,
          bicepModule: e.hint.bicepModule,
        };
      } else {
        gate = { title: 'OSS Unity Catalog is not configured', detail: e?.message || String(e) };
      }
    }
  } else {
    const cfg = databricksConfigGate();
    if (cfg) {
      configured = false;
      gate = {
        title: 'Databricks Unity Catalog is not configured',
        detail: `Set ${cfg.missing} on the Console (the landing-zone bicep deploys the Databricks workspace), or deploy loom-unity and set LOOM_UC_BACKEND=oss for the Azure-native OSS backend.`,
        envVar: cfg.missing,
      };
    }
  }

  return NextResponse.json({
    ok: true,
    backend,
    cloud: isGovCloud() ? cloudBoundaryLabel() : 'Commercial',
    configured,
    ...(gate ? { gate } : {}),
    // LU-2 — the Loom Unity authorization posture, reported honestly. On the OSS
    // backend an `hardened: false` here means the Console calls the catalog
    // anonymously, i.e. the server is (or must be) running with authorization
    // disabled and anything on the VNet can read/mutate catalog metadata. The UC
    // panes render this as a security bar; the live proof is the
    // `probe-loom-unity-authz` health probe.
    ...(backend === 'oss' ? { authorization: unityAuthorizationPosture() } : {}),
    capabilities: UC_CAPABILITIES.map((c) => ({
      ...c,
      supported: (backend === 'oss' ? c.oss : c.databricks) !== 'none',
      support: backend === 'oss' ? c.oss : c.databricks,
    })),
  });
});
