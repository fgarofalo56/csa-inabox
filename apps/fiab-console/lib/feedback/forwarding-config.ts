/**
 * Auto-error forwarding config (rel-T79).
 *
 * Governs whether the /api/feedback route forwards AUTO-CAPTURED errors
 * (`kind=auto-error`) upstream to the product's GitHub issue tracker. User-
 * initiated bug/feature reports are NOT governed by this switch — those are an
 * explicit, deliberate action by a signed-in user and always forward (subject to
 * the existing rate limits).
 *
 * Why a dedicated singleton (not the per-admin /admin/tenant-settings doc):
 * the auto-error path is anonymous — the client error boundary fires it before
 * the user can act, so there is no session to key a per-user settings doc on.
 * This config is therefore stored as ONE deployment-wide singleton keyed by the
 * Entra tenant id (`AZURE_TENANT_ID`), which BOTH the admin write path AND the
 * anonymous feedback read path resolve to the same way — a deterministic match.
 *
 * Persistence: a single doc in the existing `tenant-settings` Cosmos container
 * (partition key `/tenantId`), id = `feedback-forwarding`. It coexists with the
 * per-tenant TenantSettingsDoc rows (id = oid) without collision — different id,
 * and the tenant-settings route only ever point-reads its own `(oid, oid)` doc.
 *
 * Default: ON (true) — preserves the pre-T79 behavior where auto-error
 * forwarding is active whenever LOOM_FEEDBACK_GITHUB_TOKEN is configured. A
 * missing doc, an unconfigured tenant id, or a Cosmos read failure all fall back
 * to the default so a transient storage blip never silently changes behavior.
 */
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';

/** Well-known singleton doc id in the tenant-settings container. */
export const FEEDBACK_FORWARDING_DOC_ID = 'feedback-forwarding';

/** Default auto-error forwarding state — ON, matching pre-T79 behavior. */
export const AUTO_ERROR_FORWARDING_DEFAULT = true;

export interface FeedbackForwardingDoc {
  id: typeof FEEDBACK_FORWARDING_DOC_ID;
  /** Partition key. The deployment's Entra tenant id (AZURE_TENANT_ID). */
  tenantId: string;
  /** When false, auto-captured errors are accepted locally and NOT forwarded. */
  autoErrorForwarding: boolean;
  updatedAt: string;
  updatedBy: string;
}

/**
 * The stable partition-key value both read + write paths agree on. Uses the
 * deployment's Entra tenant id; falls back to a constant so a deployment without
 * AZURE_TENANT_ID still reads/writes ONE consistent doc.
 */
export function feedbackForwardingScope(): string {
  return process.env.AZURE_TENANT_ID || 'unknown';
}

/**
 * Resolve whether auto-error forwarding is enabled for this deployment.
 * Safe to call from the anonymous feedback path — no session required.
 * Returns the default (true) when no doc exists or the read fails.
 */
export async function getAutoErrorForwarding(): Promise<boolean> {
  const scope = feedbackForwardingScope();
  try {
    const c = await tenantSettingsContainer();
    const { resource } = await c
      .item(FEEDBACK_FORWARDING_DOC_ID, scope)
      .read<FeedbackForwardingDoc>();
    if (resource && typeof resource.autoErrorForwarding === 'boolean') {
      return resource.autoErrorForwarding;
    }
  } catch (e: any) {
    // 404 = never configured → default. Any other error → also default (never
    // let a storage blip flip behavior). Logged for traceability.
    if (e?.code !== 404) {
      // eslint-disable-next-line no-console
      console.error('[feedback-forwarding] read failed, using default', e?.message || e);
    }
  }
  return AUTO_ERROR_FORWARDING_DEFAULT;
}

/** Read the full config doc for the admin surface (seeds the default view). */
export async function readFeedbackForwardingDoc(): Promise<{
  autoErrorForwarding: boolean;
  updatedAt?: string;
  updatedBy?: string;
}> {
  const scope = feedbackForwardingScope();
  try {
    const c = await tenantSettingsContainer();
    const { resource } = await c
      .item(FEEDBACK_FORWARDING_DOC_ID, scope)
      .read<FeedbackForwardingDoc>();
    if (resource) {
      return {
        autoErrorForwarding: resource.autoErrorForwarding,
        updatedAt: resource.updatedAt,
        updatedBy: resource.updatedBy,
      };
    }
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  return { autoErrorForwarding: AUTO_ERROR_FORWARDING_DEFAULT };
}

/** Upsert the singleton. Returns the persisted doc. */
export async function setAutoErrorForwarding(
  value: boolean,
  who: string,
): Promise<FeedbackForwardingDoc> {
  const scope = feedbackForwardingScope();
  const c = await tenantSettingsContainer();
  const doc: FeedbackForwardingDoc = {
    id: FEEDBACK_FORWARDING_DOC_ID,
    tenantId: scope,
    autoErrorForwarding: value,
    updatedAt: new Date().toISOString(),
    updatedBy: who,
  };
  await c.items.upsert(doc);
  return doc;
}
