/**
 * powerbi-embed-plan — decide whether the selected report entry can mint a
 * Power BI embed token, and build the exact request when it can.
 *
 * WHY THIS EXISTS (#2830 sibling class). `/api/items/report` returns
 * `[...loomEntries, ...reports]` — the SYNTHETIC `loom:<cosmosItemId>` entries
 * for bundle-installed reports come FIRST, so the editor's
 * `setReportId(prev => prev || j.reports?.[0]?.id)` auto-selects one whenever a
 * bundle report exists. The embed effect then POSTed
 * `/api/items/report/loom%3A<id>/embed-token`, which forwards the path id
 * straight to the Power BI REST GenerateToken call. A `loom:` id is not a Power
 * BI report id, so Power BI 400s — every single time that editor opened.
 *
 * That is not an id-RESOLUTION defect (the route never touches Cosmos, which is
 * why `check-loom-content-id-chokepoint.mjs`, whose rule 3 covers Cosmos-by-id
 * sub-routes, cannot see it). It is a request that must never be made:
 * `pbi-content-fallback.ts` states the contract outright — "Synthetic (loom:)
 * ids are config-only previews of the bundle definition until the user pushes
 * them to Power BI". There is no Power BI object to embed, so asking for a token
 * is meaningless, and rendering the resulting failure as a red "Could not mint
 * embed token" MessageBar reports an infrastructure problem that does not exist
 * (ux-baseline.md: a freshly-opened item must not show error banners;
 * no-fabric-dependency.md: the Loom-native path must not surface Power BI
 * errors).
 *
 * WHY A PLANNER AND NOT AN `if` IN THE EFFECT. A bare early-return inside a
 * `useEffect` is only reachable from a rendered component, so the guard could
 * not be unit-tested and a later edit could drop it silently — the
 * "control that reports but measures nothing" failure mode. Returning the
 * request (or `null`) from a pure function makes the decision, the URL encoding
 * and the body all directly assertable, and mutating any of them turns tests
 * red.
 *
 * Dependency-free apart from the shared `loom:` vocabulary, so it is safe in a
 * client bundle (`loom-content-id.ts` is pure string helpers with zero imports —
 * the reason #2830 extracted it in the first place).
 */
import { isLoomContentId } from '@/app/api/items/_lib/loom-content-id';

/** Why no embed-token request is issued. `null` reason ⇒ a request is issued. */
export type EmbedSkipReason =
  /** No Power BI workspace selected yet. */
  | 'no-workspace'
  /** No report selected yet. */
  | 'no-selection'
  /**
   * The selection is a synthetic `loom:` entry — a Cosmos-backed bundle report
   * with no Power BI object. Not an error: the Loom-native content is what this
   * entry has, and it renders from `state.content`.
   */
  | 'loom-native';

/** A ready-to-issue embed-token POST. */
export interface EmbedTokenRequest {
  url: string;
  body: {
    workspaceId: string;
    accessLevel?: 'View' | 'Edit';
    datasetIds?: string[];
  };
}

export interface EmbedPlanInput {
  workspaceId: string;
  reportId: string;
  /** `paginated` (RDL) mints through the multi-resource route. */
  kind: 'report' | 'paginated';
  /** Standard reports only — Edit unlocks the in-place authoring surface. */
  editMode?: boolean;
  /** Paginated only — the referenced semantic-model dataset, when known. */
  datasetId?: string;
}

/**
 * The embed-token request for this selection, or the reason there is none.
 *
 * Exactly one of `request` / `skip` is non-null.
 */
export function planReportEmbedRequest(
  input: EmbedPlanInput,
): { request: EmbedTokenRequest; skip: null } | { request: null; skip: EmbedSkipReason } {
  const { workspaceId, reportId, kind, editMode, datasetId } = input;
  if (!workspaceId) return { request: null, skip: 'no-workspace' };
  if (!reportId) return { request: null, skip: 'no-selection' };
  // The whole point of this module — a synthetic entry has no Power BI object,
  // so no token can exist for it and no request is made.
  if (isLoomContentId(reportId)) return { request: null, skip: 'loom-native' };

  const encoded = encodeURIComponent(reportId);
  if (kind === 'paginated') {
    return {
      request: {
        url: `/api/items/report/${encoded}/paginated-embed-token`,
        body: { workspaceId, datasetIds: datasetId ? [datasetId] : [] },
      },
      skip: null,
    };
  }
  return {
    request: {
      url: `/api/items/report/${encoded}/embed-token`,
      body: { workspaceId, accessLevel: editMode ? 'Edit' : 'View' },
    },
    skip: null,
  };
}

/**
 * True when `reportId` names a live Power BI object, i.e. the Power BI-only
 * ribbon actions (Refresh data, Export …) can succeed against it.
 *
 * Those actions POST `/api/items/report/<id>/refresh` and `/export`, which — like
 * embed-token — forward the path id to Power BI REST. Left enabled for a
 * synthetic entry they are buttons that cannot do what their label says
 * (no-vaporware.md).
 */
export function isPowerBiBackedReport(reportId: string): boolean {
  return !!reportId && !isLoomContentId(reportId);
}
