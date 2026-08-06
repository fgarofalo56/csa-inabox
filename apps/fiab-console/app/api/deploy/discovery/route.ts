/**
 * POST /api/deploy/discovery
 * --------------------------
 * The multi-subscription adoption scan (deploy-integrity R5.1): "offer a
 * multi-subscription analysis of what already exists that Loom could use".
 *
 * Read-only. Runs an Azure Resource Graph inventory across the subscriptions
 * the operator selected and returns, per service family, the existing
 * candidates plus a per-subscription COVERAGE LEDGER.
 *
 * ## Why this is a POST and not a GET
 *
 * The scan scope is an operator decision — which subscriptions Loom may look at
 * — and it is a list, not a scalar. R5.1 requires the analysis be OFFERED
 * rather than performed silently; the existing wizard scan fires on `useEffect`
 * mount against the whole tenant with no consent step at all. A POST carrying
 * an explicit scope makes the consent structural: the scan cannot happen
 * without the client having said what it may read.
 *
 * ## What it reads, and what it never writes
 *
 * Reads: resource names, resource groups, subscription ids and display names,
 * regions, SKUs, `publicNetworkAccess` / network ACL default action, private
 * endpoint connection counts, ADLS hierarchical-namespace state, and tags.
 * Writes: nothing. There is no mutating path in this route.
 *
 * ## Honesty contract (deploy-integrity R7)
 *
 * Three outcomes are kept strictly distinct and are never collapsed:
 *
 *   - `status:'scanned', matchedResources: 0` — we read the subscription and
 *     there is genuinely nothing to adopt there.
 *   - `status:'no-access'`                    — we could NOT read it. Unknown,
 *     not empty. Every such entry carries an `established` field naming the
 *     observation that produced it.
 *   - `ok:false, code:'no_access'`            — we could read nothing at all.
 *     The message says the scan could not look; it never says the estate is
 *     empty.
 *
 * Full ARM resource ids are returned in the candidate payload (the plan and the
 * RBAC scope need them) but the UI renders them redacted via `redactArmId`, and
 * this route logs none of them.
 *
 * Gated on `admin.deploy-dlz` at Admin — the same gate as POST /api/setup/deploy,
 * because the output drives a subscription-scoped deployment plan.
 */
import { NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { enforceCapability } from '@/lib/auth/feature-gate';
import {
  acquireCredentials,
  scanForAdoptionCandidates,
  type ScanRequest,
} from '@/lib/deploy/discovery-scanner';
import { adoptionArmTypes } from '@/lib/deploy/adoption-catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** A subscription id is a GUID; reject anything else before it reaches ARM. */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Azure region tokens are lowercase alphanumerics. */
const REGION = /^[a-z0-9]{2,40}$/;
const MAX_SUBSCRIPTIONS = 500;

export const POST = withSession(async (req, { session }) => {
  const gate = await enforceCapability(session, 'admin.deploy-dlz', 'Admin');
  if (gate) return gate;

  let raw: any = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }

  const subsIn = Array.isArray(raw?.subscriptions) ? raw.subscriptions : [];
  const invalid = subsIn.filter((s: unknown) => typeof s !== 'string' || !GUID.test(s));
  if (invalid.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        code: 'bad_request',
        error: `${invalid.length} of the ${subsIn.length} supplied subscription ids are not valid GUIDs.`,
      },
      { status: 400 },
    );
  }
  if (subsIn.length > MAX_SUBSCRIPTIONS) {
    return NextResponse.json(
      {
        ok: false,
        code: 'bad_request',
        error: `A single scan covers at most ${MAX_SUBSCRIPTIONS} subscriptions; ${subsIn.length} were supplied.`,
      },
      { status: 400 },
    );
  }

  const hubRegionIn = typeof raw?.hubRegion === 'string' ? raw.hubRegion.toLowerCase() : undefined;
  const hubRegion = hubRegionIn && REGION.test(hubRegionIn) ? hubRegionIn : undefined;

  // Management-group scoping is NOT implemented. Resource Graph accepts a
  // `managementGroups` scope, but the coverage ledger is subscription-keyed and
  // expanding a group to its subscriptions is a separate, unverified path.
  // Rejecting it explicitly beats accepting it and silently scanning something
  // else (a wrong scope reported as a successful scan is an R7 violation).
  if (Array.isArray(raw?.managementGroups) && raw.managementGroups.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        code: 'not_implemented',
        error:
          'Management-group scoping is not implemented in this scan. Select the subscriptions ' +
          'explicitly, or omit the scope entirely to scan every subscription you can see.',
      },
      { status: 400 },
    );
  }

  const scanReq: ScanRequest = { subscriptions: subsIn, hubRegion };
  const creds = await acquireCredentials(session.claims?.oid);
  const outcome = await scanForAdoptionCandidates(scanReq, creds);

  if (!outcome.ok) {
    // 200 with ok:false — this is an honest gate the wizard renders inline, not
    // a transport failure. `established` carries what the code actually saw.
    return NextResponse.json(
      { ok: false, code: outcome.code, error: outcome.error, established: outcome.established },
      { status: 200 },
    );
  }

  return NextResponse.json({
    ok: true,
    ...outcome.result,
    /** What the scan looked for — so the UI can state its own coverage. */
    armTypesQueried: adoptionArmTypes(),
  });
});
