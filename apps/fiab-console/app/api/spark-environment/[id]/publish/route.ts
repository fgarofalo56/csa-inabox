/**
 * POST /api/spark-environment/[id]/publish
 *   body: { poolName: string, applyCompute?: boolean }
 *
 * Bakes the persisted spark-environment spec into a Synapse Spark Big Data
 * pool via ARM (Microsoft.Synapse/workspaces/bigDataPools). This is the
 * Azure-native equivalent of Fabric's "Publish environment":
 *
 *   - sessionLevelPackagesEnabled  → always true (so %pip / libraryRequirements work)
 *   - libraryRequirements          → requirements.txt | environment.yml content
 *   - customLibraries              → uploaded .whl / .jar entries (ADLS-staged)
 *   - sparkConfigProperties        → spark-defaults.conf from the properties tab
 *   - (applyCompute) sparkVersion / nodeSize family / autoscale / autoPause
 *
 * Existing pool properties are preserved and merged — we never shrink the
 * pool out from under other workloads. The publish status + timestamp are
 * persisted back onto the item so the editor can show "Published to <pool>".
 *
 * No Microsoft Fabric capacity or workspace is required.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getSparkPool, upsertSparkPool } from '@/lib/azure/synapse-dev-client';
import { loadOwnedItem, updateOwnedItem, jerr } from '@/app/api/items/_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'spark-environment';

interface CustomLib { name: string; path: string; containerName?: string; type?: string }

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const id = (await ctx.params).id;
  const body = await req.json().catch(() => ({}));
  const poolName = (body?.poolName || '').toString().trim();
  const applyCompute = body?.applyCompute !== false; // default true
  if (!poolName) return jerr('poolName is required', 400);

  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('not found', 404);
    const s: any = item.state || {};

    // Read the current pool so we merge onto its existing properties.
    let pool;
    try {
      pool = await getSparkPool(poolName);
    } catch (e: any) {
      return NextResponse.json({
        ok: false,
        error: e?.message || String(e),
        hint: `Spark pool "${poolName}" not found in the Loom Synapse workspace (LOOM_SYNAPSE_WORKSPACE). Deploy it via platform/fiab/bicep/modules/landing-zone/synapse.bicep or pick another pool.`,
      }, { status: 404 });
    }

    const properties: Record<string, any> = { ...(pool.properties || {}) };

    // --- libraries / config (always applied) ---
    properties.sessionLevelPackagesEnabled = true;

    const reqContent: string = (s.requirementsContent || '').trim();
    if (reqContent) {
      properties.libraryRequirements = {
        content: s.requirementsContent,
        filename: s.requirementsType === 'conda' ? 'environment.yml' : 'requirements.txt',
      };
    } else {
      // Empty requirements → clear any previously-applied requirements.
      delete properties.libraryRequirements;
    }

    const sparkProps: Record<string, string> = (s.sparkProperties && typeof s.sparkProperties === 'object')
      ? s.sparkProperties : {};
    const confLines = Object.entries(sparkProps)
      .filter(([k]) => k && k.trim())
      .map(([k, v]) => `${k} ${v}`);
    if (confLines.length) {
      properties.sparkConfigProperties = {
        content: confLines.join('\n'),
        filename: 'spark-defaults.conf',
      };
    } else {
      delete properties.sparkConfigProperties;
    }

    const customLibs: CustomLib[] = Array.isArray(s.customLibraries) ? s.customLibraries : [];
    properties.customLibraries = customLibs.map((l) => ({
      name: l.name,
      path: l.path,
      containerName: l.containerName || 'landing',
      type: l.type || (l.name?.toLowerCase().endsWith('.jar') ? 'jar' : 'whl'),
    }));

    // --- compute (optional) ---
    if (applyCompute) {
      if (s.sparkVersion) properties.sparkVersion = s.sparkVersion;
      if (s.nodeSizeFamily) properties.nodeSizeFamily = s.nodeSizeFamily;
      if (s.nodeSize) properties.nodeSize = s.nodeSize;
      if (s.autoscaleEnabled) {
        properties.autoScale = {
          enabled: true,
          minNodeCount: Math.max(3, Number(s.minNodeCount) || 3),
          maxNodeCount: Math.max(Number(s.maxNodeCount) || 10, Math.max(3, Number(s.minNodeCount) || 3)),
        };
        delete properties.nodeCount;
      } else if (typeof s.nodeCount === 'number' || s.nodeCount) {
        properties.nodeCount = Math.max(3, Number(s.nodeCount) || 3);
        properties.autoScale = { enabled: false, minNodeCount: 3, maxNodeCount: 3 };
      }
      properties.autoPause = s.autoPauseEnabled
        ? { enabled: true, delayInMinutes: Math.max(5, Number(s.autoPauseDelay) || 15) }
        : { enabled: false, delayInMinutes: Math.max(5, Number(s.autoPauseDelay) || 15) };
    }

    // PUT the merged pool spec. ARM triggers the async library-install job;
    // the immediate response carries provisioningState ('Provisioning').
    const result = await upsertSparkPool(poolName, {
      location: pool.location,
      properties,
    });
    const provisioningState = result?.properties?.provisioningState || 'Provisioning';

    const now = new Date().toISOString();
    const publishStatus = provisioningState === 'Succeeded' ? 'succeeded' : 'in_progress';
    await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, {
      state: { ...s, publishedToPool: poolName, publishedAt: now, publishStatus },
    });

    return NextResponse.json({
      ok: true,
      poolName,
      publishedAt: now,
      provisioningState,
      publishStatus,
      libraryCount: properties.customLibraries.length,
      requirementsApplied: !!reqContent,
      hint: provisioningState === 'Succeeded'
        ? undefined
        : 'Pool is installing libraries asynchronously (can take several minutes). Use Validate import to confirm packages once it settles, or check the pool provisioning state.',
    });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
}
