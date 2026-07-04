/**
 * GET /api/onelake/governance
 *
 * Aggregates Cosmos item metadata + (optional) Microsoft Purview classic
 * Data Map classifications to compute the OneLake catalog governance score
 * surfaced by the OneLake catalog "Govern" tab.
 *
 * Score (always computed from REAL Cosmos item state — no mocks):
 *   labeledPct   — % of catalog items carrying a sensitivity label
 *                  (state.sensitivityLabel)
 *   endorsedPct  — % endorsed (state.endorsement || state.certified)
 *   ownedPct     — % with a known owner (createdBy)
 *
 * Classification table — count of items per classification, derived from the
 * item's Azure-native state.classifications. When LOOM_PURVIEW_ACCOUNT is set
 * AND the Data Map is reachable, each row is additionally overlaid with the
 * number of scan-classified Purview assets (real Discovery query), and
 * Purview-only classifications are appended. This is the Azure-native DEFAULT:
 * Purview merely ENRICHES; it is never required (no Fabric / Power BI).
 *
 * Items needing attention — catalog items missing a label, owner, endorsement,
 * or classification, each with a deep-link to /items/{type}/{id}.
 *
 * Honest gate (per .claude/rules/no-vaporware.md): when LOOM_PURVIEW_ACCOUNT is
 * unset (or the Data Map is unreachable / the UAMI lacks a Data Map role), the
 * Cosmos-only metrics are STILL returned in full and `purviewGate` carries the
 * actionable hint naming LOOM_PURVIEW_ACCOUNT + catalog.bicep. The govern-view
 * renders that as a Fluent MessageBar — never fabricated classification data.
 *
 * Source backends:
 *   items / workspaces → Cosmos (cosmos-client)
 *   classifications    → Purview classic Data Map Discovery (purview-client),
 *                        optional overlay only.
 *
 * Bicep: LOOM_PURVIEW_ACCOUNT is wired from
 * platform/fiab/bicep/modules/admin-plane/catalog.bicep (output
 * purviewAccountName) through admin-plane/main.bicep apps[] env list. No new
 * infra is introduced by this route — it reads only.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import {
  isPurviewConfigured,
  getPurviewAccountName,
  searchDataMapAssets,
  PurviewNotConfiguredError,
  type PurviewNotConfiguredHint,
} from '@/lib/azure/purview-client';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── Item types surfaced by the OneLake catalog (matches onelake/page.tsx) ──
const ONELAKE_CATALOG_TYPES = new Set([
  'lakehouse',
  'warehouse',
  'sql-database',
  'mirrored-database',
  'mirrored-databricks',
  'kql-database',
  'eventhouse',
]);

// Atlas entity types that map to OneLake-catalog data assets in the Data Map.
const PURVIEW_DATA_ENTITY_TYPES = [
  'fabric_lakehouse',
  'azure_datalake_gen2_resource_set',
  'azure_datalake_gen2_path',
];

interface ClassificationRow {
  classification: string;
  /** Count of Cosmos catalog items carrying this classification. */
  count: number;
  /** Count of Purview scan-classified assets (only when Purview is reachable). */
  purviewAssets?: number;
}

interface AttentionItem {
  id: string;
  itemType: string;
  displayName: string;
  workspaceId: string;
  workspaceName: string;
  issues: string[];
  href: string;
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  try {
    const wsC = await workspacesContainer();
    const { resources: workspaces } = await wsC.items
      .query(
        {
          query: 'SELECT c.id, c.name FROM c WHERE c.tenantId = @t',
          parameters: [{ name: '@t', value: s.claims.oid }],
        },
        { partitionKey: s.claims.oid },
      )
      .fetchAll();

    const wsName = new Map<string, string>(workspaces.map((w: any) => [w.id, w.name]));
    const callerWorkspaceIds = Array.from(wsName.keys());

    // ── Cosmos catalog items (real data-plane query) ──────────────────────
    let catalogItems: any[] = [];
    if (callerWorkspaceIds.length > 0) {
      const itC = await itemsContainer();
      const { resources: items } = await itC.items
        .query({
          query:
            'SELECT c.id, c.workspaceId, c.itemType, c.displayName, c.createdBy, c.updatedAt, c.state FROM c WHERE ARRAY_CONTAINS(@ws, c.workspaceId)',
          parameters: [{ name: '@ws', value: callerWorkspaceIds }],
        })
        .fetchAll();
      catalogItems = items.filter((i: any) => ONELAKE_CATALOG_TYPES.has(i.itemType));
    }

    // ── Governance score (pure arithmetic over real Cosmos state) ─────────
    const totalItems = catalogItems.length;
    const labeled = catalogItems.filter((i) => i.state?.sensitivityLabel).length;
    const endorsed = catalogItems.filter(
      (i) => i.state?.endorsement || i.state?.certified,
    ).length;
    const owned = catalogItems.filter((i) => i.createdBy).length;

    const pct = (n: number) => (totalItems ? Math.round((n / totalItems) * 100) : 0);
    const labeledPct = pct(labeled);
    const endorsedPct = pct(endorsed);
    const ownedPct = pct(owned);

    // ── Classification table (Cosmos item state) ──────────────────────────
    const classMap = new Map<string, number>();
    for (const i of catalogItems) {
      const cls: string[] = Array.isArray(i.state?.classifications) ? i.state.classifications : [];
      for (const c of cls) classMap.set(c, (classMap.get(c) ?? 0) + 1);
    }

    // ── Optional Purview classification overlay (Azure-native ENRICHMENT) ──
    let purviewGate: PurviewNotConfiguredHint | undefined;
    let purviewAssetCount: number | null = null;
    const purviewClassMap = new Map<string, number>();

    if (isPurviewConfigured()) {
      try {
        const hits = await searchDataMapAssets({
          q: '*',
          entityTypes: PURVIEW_DATA_ENTITY_TYPES,
          limit: 200,
        });
        purviewAssetCount = hits.length;
        for (const h of hits) {
          for (const c of h.classification ?? []) {
            purviewClassMap.set(c, (purviewClassMap.get(c) ?? 0) + 1);
          }
        }
      } catch (e: any) {
        // Honest gate: unreachable Data Map / missing role still returns the
        // full Cosmos-only metrics + a named hint (never fabricated data).
        if (e instanceof PurviewNotConfiguredError) {
          purviewGate = e.hint;
        } else {
          purviewGate = onelakePurviewHint(
            (e?.message as string) ||
              'Purview Data Map is unreachable or the Console UAMI lacks a Data Map read role.',
          );
        }
      }
    } else {
      purviewGate = onelakePurviewHint();
    }

    // Merge Cosmos counts + Purview overlay into a single sorted table.
    const allClassifications = new Set<string>([...classMap.keys(), ...purviewClassMap.keys()]);
    const classificationTable: ClassificationRow[] = [...allClassifications]
      .map((classification) => ({
        classification,
        count: classMap.get(classification) ?? 0,
        ...(purviewAssetCount !== null
          ? { purviewAssets: purviewClassMap.get(classification) ?? 0 }
          : {}),
      }))
      .sort((a, b) => b.count - a.count || (b.purviewAssets ?? 0) - (a.purviewAssets ?? 0));

    // ── Items needing attention (deep-linked) ─────────────────────────────
    const attention: AttentionItem[] = catalogItems
      .filter(
        (i) =>
          !i.state?.sensitivityLabel ||
          !i.createdBy ||
          (!i.state?.endorsement && !i.state?.certified) ||
          !(Array.isArray(i.state?.classifications) && i.state.classifications.length > 0),
      )
      .slice(0, 25)
      .map((i) => ({
        id: i.id,
        itemType: i.itemType,
        displayName: i.displayName,
        workspaceId: i.workspaceId,
        workspaceName: wsName.get(i.workspaceId) ?? '—',
        issues: [
          !i.state?.sensitivityLabel && 'No sensitivity label',
          !i.createdBy && 'No owner',
          !i.state?.endorsement && !i.state?.certified && 'Not endorsed',
          !(Array.isArray(i.state?.classifications) && i.state.classifications.length > 0) &&
            'No classifications',
        ].filter(Boolean) as string[],
        href: `/items/${i.itemType}/${i.id}`,
      }));

    return NextResponse.json({
      ok: true,
      purviewConfigured: isPurviewConfigured(),
      purviewAccount: getPurviewAccountName(),
      purviewAssetCount,
      totalItems,
      labeled,
      endorsed,
      owned,
      labeledPct,
      endorsedPct,
      ownedPct,
      attentionCount: attention.length,
      classificationTable,
      attention,
      ...(purviewGate ? { purviewGate } : {}),
    });
  } catch (e: any) {
    return apiServerError(e);
  }
}

/**
 * Honest-gate hint for the OneLake Govern tab when the Purview classification
 * overlay is unavailable. Names the exact env var + bicep module so the
 * operator has an actionable next step (per no-vaporware.md). Cosmos-only
 * metrics are still returned alongside this hint.
 */
function onelakePurviewHint(reason?: string): PurviewNotConfiguredHint {
  return {
    missingEnvVar: 'LOOM_PURVIEW_ACCOUNT',
    bicepModule: 'platform/fiab/bicep/modules/admin-plane/catalog.bicep',
    bicepStatus:
      reason ||
      'Deploys a CLASSIC Microsoft.Purview/accounts (Data Map). Set LOOM_PURVIEW_ACCOUNT ' +
        'to the deployed account short name to overlay scan-based classifications.',
    rolesRequired: [
      {
        name: 'Data Reader',
        scope: 'Root collection (Data Map metadata policy — NOT ARM RBAC)',
        reason: 'Read scan-classified assets from the Data Map Discovery plane.',
      },
    ],
    followUp:
      'Governance score (% labeled, % endorsed, % with owner) is computed from Azure-native ' +
      'Cosmos item metadata and is shown above without Purview. To overlay Purview scan-based ' +
      'classifications: (1) deploy catalog.bicep, (2) set LOOM_PURVIEW_ACCOUNT in ' +
      'admin-plane/main.bicep apps[] env list, (3) grant the Console UAMI Data Reader on the ' +
      'root collection via scripts/csa-loom/grant-purview-datamap-role.sh, then redeploy.',
  };
}
