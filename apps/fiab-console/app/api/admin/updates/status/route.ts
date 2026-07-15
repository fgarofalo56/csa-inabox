/**
 * GET /api/admin/updates/status — live progress for an in-flight update.
 *
 *   ?mode=roll               → real ARM state of every Loom Container App
 *                              (provisioningState + running image tag) so the
 *                              Updates page can show "revision rolling →
 *                              healthy" per app after a direct image roll.
 *   ?mode=pipeline&since=iso → status of the build+roll GitHub workflow run
 *                              dispatched by POST /api/admin/updates/apply
 *                              (queued → in_progress → completed/conclusion).
 *
 * Read-only; same admin gate as the apply route. Never fakes progress: the roll
 * mode reports ARM verbatim, the pipeline mode reports the GitHub run verbatim,
 * and a missing token/run is an honest error (no-vaporware.md).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { denyIfNoDlzAccess } from '@/lib/auth/dlz-gate';
import {
  getContainerApp,
  getContainerAppImage,
  AcaArmError,
} from '@/lib/azure/container-apps-arm-client';
import { LOOM_APPS } from '@/lib/updates/update-apply';
import { resolveCurrentVersion } from '@/lib/updates/current-version';
import { readPipelineConfig, getPipelineRunStatus } from '@/lib/updates/pipeline-dispatch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface AppRollState {
  app: string;
  /** ARM provisioningState (Succeeded | InProgress | Updating | Failed | …). */
  provisioningState: string;
  /** The image the app is currently configured to run (tag = version proof). */
  image?: string;
  /** True when the app is not deployed on this boundary. */
  notDeployed?: boolean;
  error?: string;
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = await denyIfNoDlzAccess(s, 'scaling');
  if (denied) return denied;

  const mode = req.nextUrl.searchParams.get('mode') || 'roll';

  if (mode === 'pipeline') {
    const cfg = readPipelineConfig();
    if (!cfg.available) {
      return NextResponse.json(
        { ok: false, error: `GitHub token not configured — set ${cfg.missingEnv.join(', ')}.` },
        { status: 503 },
      );
    }
    try {
      const run = await getPipelineRunStatus(cfg, req.nextUrl.searchParams.get('since') || undefined);
      return NextResponse.json({ ok: run.ok, mode: 'pipeline', run, workflow: cfg.workflow, monitorUrl: cfg.monitorUrl });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  // mode=roll — per-app ARM state, sequential (same pacing as the roll itself).
  const apps: AppRollState[] = [];
  for (const app of LOOM_APPS) {
    try {
      const [info, image] = [await getContainerApp(app.acaName), await getContainerAppImage(app.acaName)];
      apps.push({
        app: app.acaName,
        provisioningState: info.provisioningState || 'Unknown',
        image: image || undefined,
      });
    } catch (e) {
      if (e instanceof AcaArmError && e.status === 404) {
        apps.push({ app: app.acaName, provisioningState: 'NotDeployed', notDeployed: true });
      } else {
        apps.push({
          app: app.acaName,
          provisioningState: 'Unknown',
          error: (e as Error).message,
        });
      }
    }
  }
  const deployed = apps.filter((a) => !a.notDeployed);
  const allHealthy = deployed.length > 0 && deployed.every((a) => a.provisioningState === 'Succeeded');
  return NextResponse.json({
    ok: true,
    mode: 'roll',
    apps,
    allHealthy,
    // The version THIS serving process runs — after the console itself rolls,
    // a poll lands on the new process and this flips to the new version.
    current: resolveCurrentVersion(),
  });
}
