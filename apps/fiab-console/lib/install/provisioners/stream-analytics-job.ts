/**
 * Phase 2 — Stream Analytics job provisioner.
 *
 * #3573. `stream-analytics-job` shipped as a first-class item type with a full
 * editor (`lib/editors/stream-analytics-editor.tsx`) and a real ARM read route,
 * and NOTHING in the platform ever created its backing job. There was no entry
 * in `provisioning-engine.ts`'s PROVISIONERS map, so an app install that
 * carried one wrote a Cosmos row and stopped; the editor then GET'd
 * `/api/items/stream-analytics-job/<id>`, ARM answered 404, and the surface
 * showed "Stream Analytics not configured" forever over a deployment where ASA
 * was configured correctly.
 *
 * Per `.claude/rules/auto-bind-by-default.md` §1 creating the Loom item must
 * PROVISION AND BIND its backing resource, and per §2 the backing object
 * carries the item's display name, sanitized only where the service's naming
 * rules force it and recorded on the item so the mapping is inspectable. Both
 * halves are here: `createOrUpdateJob` (a real ARM PUT — the SAME function
 * `eventstream-standup.ts` uses for its transform job) plus a Cosmos write of
 * `state.jobName` / `state.asaJobId`.
 *
 * Azure-native by construction (`no-fabric-dependency.md`): Azure Stream
 * Analytics is the only backend. There is no Fabric path and no opt-in
 * selector, so nothing here can hard-gate on a Fabric workspace.
 */
import {
  createOrUpdateJob,
  getJob,
  readAsaConfig,
  AsaNotConfiguredError,
  AsaJobNotFoundError,
} from '@/lib/azure/stream-analytics-client';
import { sanitizeBackingName, type BackingNameRules } from '@/lib/azure/backing-name';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import type { Provisioner, ProvisionResult, ProvisionerInput } from './types';
import { resolveInfraResidual } from './types';

/**
 * Microsoft.StreamAnalytics/streamingjobs naming: letters, digits, `-` and `_`
 * only, 3–63 characters. Runs of disallowed characters COLLAPSE to a single
 * `-` (the `+` quantifier), matching `PIPELINE_NAME_RULES`' behaviour so the
 * two read the same way.
 *
 * Not added to `lib/azure/backing-name.ts` alongside the other rule sets
 * because that module holds exactly the mappings TWO code paths must agree on,
 * and this one has a single computer — there is no open-time auto-bind engine
 * for `stream-analytics-job`. The shared, tested `sanitizeBackingName` is still
 * what performs the mapping, so the determinism contract holds.
 */
export const ASA_JOB_NAME_RULES: BackingNameRules = {
  disallowed: /[^A-Za-z0-9_-]+/g,
  replacement: '-',
  trimChars: '-_',
  maxLength: 63,
  fallback: 'loom-asa-job',
};

/** ARM's minimum streaming-job name length. */
const ASA_JOB_NAME_MIN = 3;

/**
 * The backing ASA job name for a Loom item's display name. Deterministic and
 * pure — same displayName in, same job name out, in every process.
 *
 * The `< 3` branch is the one thing `sanitizeBackingName` cannot express (it
 * has no minimum-length concept): ARM rejects a 1–2 character streaming-job
 * name outright, so a Loom item legitimately called "IoT" would otherwise fail
 * the PUT with a validation error rather than provision. Suffixing keeps the
 * mapping deterministic and keeps the operator's name visible in the result.
 */
export function asaJobNameFor(displayName: string): { name: string; sanitized: boolean } {
  const s = sanitizeBackingName(displayName, ASA_JOB_NAME_RULES);
  if (s.name.length >= ASA_JOB_NAME_MIN) return { name: s.name, sanitized: s.sanitized };
  return { name: `${s.name}-job`, sanitized: true };
}

/** The region the streaming job is created in. Mirrors `eventstream-standup.ts`. */
function asaLocation(): string {
  return process.env.LOOM_ASA_LOCATION || process.env.LOOM_LOCATION || 'eastus';
}

const PERSIST_ATTEMPTS = 3;
const PERSIST_BACKOFF_MS = [150, 400];

type PersistOutcome =
  | { ok: true; attempts: number }
  | { ok: false; attempts: number; reason: 'item-not-found' | 'write-failed'; error: string; cause?: unknown };

/**
 * Record the backing job on the item so the mapping is INSPECTABLE rather than
 * re-derived by every reader (`auto-bind-by-default.md` §2).
 *
 * Fails closed, exactly like `eventstream.ts`'s `persistBackendRefs`: a lost
 * write means the ASA job is live and nothing in Loom points at it, which is a
 * partial outcome the caller must report — not a step-log line under a green
 * `created` (`deploy-integrity.md` R6, "never report success on an unverified
 * outcome").
 */
async function persistJobRef(
  input: ProvisionerInput,
  refs: { jobName: string; asaJobId: string; sanitized: boolean; provisionedAt: string },
  steps: string[],
): Promise<PersistOutcome> {
  let reason: 'item-not-found' | 'write-failed' = 'write-failed';
  let error = '';
  let cause: unknown;
  for (let attempt = 1; attempt <= PERSIST_ATTEMPTS; attempt++) {
    try {
      const items = await itemsContainer();
      const { resource: cur } = await items.item(input.cosmosItemId, input.workspaceId).read<WorkspaceItem>();
      if (!cur) {
        reason = 'item-not-found';
        cause = undefined;
        error = `item '${input.cosmosItemId}' not found in workspace '${input.workspaceId}' (the Cosmos read returned no document)`;
      } else {
        const next: WorkspaceItem = {
          ...cur,
          state: {
            ...(cur.state || {}),
            jobName: refs.jobName,
            asaJobId: refs.asaJobId,
            // Recorded so a reader can tell a sanitized name from an exact one
            // without re-running the sanitizer.
            jobNameSanitized: refs.sanitized,
            provisionedAt: refs.provisionedAt,
          },
          updatedAt: new Date().toISOString(),
        };
        await items.item(cur.id, cur.workspaceId).replace(next);
        steps.push(
          `Recorded backing job '${refs.jobName}' on the item` +
            (attempt > 1 ? ` on attempt ${attempt}/${PERSIST_ATTEMPTS}` : '') +
            '.',
        );
        return { ok: true, attempts: attempt };
      }
    } catch (e: any) {
      reason = 'write-failed';
      cause = e;
      error = e?.message || String(e);
    }
    if (attempt < PERSIST_ATTEMPTS) {
      steps.push(`Job-ref write attempt ${attempt}/${PERSIST_ATTEMPTS} did not complete (${error}); retrying.`);
      await new Promise((r) => setTimeout(r, PERSIST_BACKOFF_MS[attempt - 1] ?? 400));
    }
  }
  return { ok: false, attempts: PERSIST_ATTEMPTS, reason, error, cause };
}

export const streamAnalyticsJobProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const { name: jobName, sanitized } = asaJobNameFor(input.displayName);
  const location = asaLocation();

  // Honest AZURE infra gate (not a Fabric one) — ASA has no cross-cloud
  // equivalent to fall back to, so when the RG/sub are unset there is nothing
  // to create and the exact env vars are named.
  try {
    readAsaConfig();
  } catch (e) {
    if (e instanceof AsaNotConfiguredError) {
      return {
        status: 'remediation',
        gate: {
          reason: 'Azure Stream Analytics is not configured for this deployment.',
          remediation:
            `Set ${e.missing.join(' / ')} on the Console so the streaming job can be created. ` +
            'Deployed by platform/fiab/bicep/modules/landing-zone/stream-analytics.bicep (enableStreamAnalytics=true). ' +
            'No Microsoft Fabric required.',
          link: 'https://learn.microsoft.com/azure/stream-analytics/stream-analytics-quick-create-portal',
        },
        steps,
      };
    }
    throw e;
  }

  try {
    // READ BEFORE WRITE (#4354 review, finding 7). `PUT
    // Microsoft.StreamAnalytics/streamingjobs/{name}` is create-OR-REPLACE on
    // `properties`, and the body above sends a fixed shape — SKU, compatibility
    // level, the out-of-order/late-arrival policies, `contentStoragePolicy` —
    // with no inputs, outputs or transformation. That is the IDENTICAL shape as
    // the action-group defect this same PR fixes on the other side: an "upsert"
    // that silently replaces state it did not compose. This provisioner runs on
    // app install, on the deployment-pipeline promote path AND on the new
    // Fix-it, so a second run over a job the operator had configured would have
    // reset its compatibility level and its policies.
    //
    // A 404 is the only outcome that authorises the PUT. Any other failure
    // (403, throttle, DNS) falls to the outer catch and is classified there —
    // it is NOT treated as absence, because absence was not established (R7).
    let existing: { id: string; name: string } | null = null;
    try {
      const found = await getJob(jobName);
      existing = { id: found.id || '', name: found.name || jobName };
    } catch (e) {
      if (!(e instanceof AsaJobNotFoundError)) throw e;
    }

    const job = existing ?? (await createOrUpdateJob({ name: jobName, location }));
    steps.push(
      existing
        ? `Stream Analytics job '${jobName}' already exists; left its configuration untouched` +
            (sanitized ? ` (name sanitized from display name '${input.displayName}')` : '') +
            '.'
        : `Created Stream Analytics job '${jobName}' in ${location}` +
            (sanitized ? ` (sanitized from display name '${input.displayName}' — ARM allows only letters, digits, '-' and '_')` : '') +
            '.',
    );
    const provisionedAt = new Date().toISOString();
    const persisted = await persistJobRef(
      input,
      { jobName, asaJobId: job.id || '', sanitized, provisionedAt },
      steps,
    );
    if (!persisted.ok) {
      // Only what was ESTABLISHED (R7): the job exists, the record did not land.
      return resolveInfraResidual(
        persisted.cause ?? persisted.error,
        'Retry this install step. The retry is idempotent — the streaming job is READ before anything is written, so a retry re-uses the job that already exists rather than replacing its configuration. ' +
          `Until the reference is recorded the editor cannot resolve this item to its job '${jobName}'. ` +
          'If the retry keeps failing, verify the Console UAMI holds the Cosmos DB Built-in Data Contributor role on the Loom Cosmos account.',
        {
          reason:
            `${existing ? 'Found the existing' : 'Created the'} Stream Analytics job '${jobName}' but could not record it on the item: ` +
            (persisted.reason === 'item-not-found'
              ? `reading item '${input.cosmosItemId}' in workspace '${input.workspaceId}' returned no document.`
              : 'the Cosmos write did not complete.'),
          link: 'https://learn.microsoft.com/azure/cosmos-db/nosql/security/how-to-grant-data-plane-role-based-access',
          errorPrefix: `${existing ? 'Found the existing' : 'Created the'} ASA job but failed to persist its reference: `,
          resourceId: job.id || jobName,
          secondaryIds: { backend: 'stream-analytics', jobName, location, refsPersisted: 'false' },
          steps,
        },
      );
    }
    return {
      status: existing ? 'exists' : 'created',
      resourceId: job.id || jobName,
      secondaryIds: { backend: 'stream-analytics', jobName, location, provisionedAt, refsPersisted: 'true' },
      steps,
    };
  } catch (e: any) {
    return resolveInfraResidual(
      e,
      'Grant the Console UAMI (LOOM_UAMI_CLIENT_ID) the "Stream Analytics Contributor" role on the resource group named by LOOM_ASA_RG so it can read and create streaming jobs, ' +
        `and — if the failure came from the create rather than the read — confirm LOOM_ASA_LOCATION ('${location}') is a region where Azure Stream Analytics is offered in this cloud.`,
      { link: 'https://learn.microsoft.com/azure/stream-analytics/stream-analytics-quick-create-portal', steps },
    );
  }
};
