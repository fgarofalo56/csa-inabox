/**
 * GET /api/synapse/environments — list the Synapse Spark configurations
 * ("environments") on the deployment-default workspace. These back the
 * notebook designer's "Environment" attach picker (the second picker next to
 * the Spark-pool attach in Synapse Studio's notebook header): a named bag of
 * spark.* session settings the notebook session inherits.
 *
 *   GET /api/synapse/environments → { ok: true, environments: [{ name, description, sparkVersion }] }
 *
 * Real Synapse dev-plane REST (api-version 2020-12-01) via the shared
 * synapse-artifacts-client (GET /sparkconfigurations). No mocks.
 *
 * Unlike the notebook list route, the Environment picker is OPTIONAL — a
 * notebook works without one. So this route NEVER hard-gates: when the
 * workspace is unconfigured or the call fails it returns
 * `{ ok: true, environments: [] }` and the picker simply shows "(none)".
 * The honest workspace gate already renders in the notebook editor itself.
 *
 * Learn: https://learn.microsoft.com/rest/api/synapse/data-plane/spark-configuration
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listSparkConfigurations } from '@/lib/azure/synapse-artifacts-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // Optional picker — no gate. Return an empty list when the workspace is unset
  // so the notebook designer's Environment dropdown degrades to "(none)".
  if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
    return NextResponse.json({ ok: true, environments: [] });
  }

  try {
    const configs = await listSparkConfigurations();
    const environments = configs.map((e) => ({
      name: e.name,
      description: e.properties?.description || '',
      sparkVersion: e.properties?.configs?.['spark.version'] || '',
    }));
    return NextResponse.json({ ok: true, environments });
  } catch {
    // Degrade gracefully — the picker is optional and the run path doesn't
    // depend on it. The notebook editor's own gate names the missing config.
    return NextResponse.json({ ok: true, environments: [] });
  }
}
