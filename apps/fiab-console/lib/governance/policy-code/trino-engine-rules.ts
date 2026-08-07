/**
 * LU-7 — the Trino engine-rules PUBLICATION store.
 *
 * The compiled Trino authorization document (`compilers/trino.ts`) is worthless
 * unless the ENGINE loads it. This module is the publication half:
 *
 *   reconcile  →  publishTrinoEngineRules()  →  Cosmos
 *                                                 ↓  (engine pulls, authenticated)
 *   loom-trino entrypoint  ←  GET /api/governance/policy-code/engine-rules
 *                                                 ↓
 *                             recordTrinoEngineFetch()  →  the RECEIPT
 *
 * ## Why a pull, not a push
 *
 * The Console cannot write into the engine container's filesystem, and adding
 * an OPA server would be a second thing to deploy, secure and keep alive. Trino
 * already solves this: `security.config-file` accepts an **HTTP URL** and
 * `security.refresh-period` re-reads it on a timer. So the engine pulls its own
 * authorization from the Console on a schedule — policy edits go live with no
 * redeploy, no image rebuild, and no operator plumbing (`auto-bind-by-default`:
 * the URL is produced by the deploy, never typed by a user).
 *
 * ## Why the fetch receipt matters
 *
 * `deploy-integrity.md` R2 — a write is not a deploy. Persisting a rules
 * document proves nothing about what the engine is enforcing. Every engine
 * fetch stamps the version it received, so `/admin/policy-code` can state the
 * TRUE thing: "engine is enforcing version <hash>, fetched <when>" or "engine
 * has NOT fetched version <hash> yet". An unfetched publish reports as drift,
 * never as applied.
 */

import type { PolicyCodeSet } from './dsl';
import type { CompiledArtifact } from './compilers/types';
import {
  buildTrinoRulesDocument,
  buildTrinoGroupFile,
  buildTrinoRego,
  rulesVersion,
  trinoGroupPrincipals,
  type TrinoDocumentOptions,
  type TrinoRulesDocument,
} from './compilers/trino';

export const TRINO_RULES_DOC_KIND = 'trino-engine-rules';

export interface TrinoEngineRulesDoc {
  id: string;
  tenantId: string;
  kind: typeof TRINO_RULES_DOC_KIND;
  /**
   * The POLICY PROJECTION of the document the engine loads — `schemas`,
   * `tables` and `impersonation` as compiled. `catalogs` is deliberately EMPTY
   * here: the catalog section is engine state, rendered around the catalog list
   * the coordinator reports at fetch time, so storing a placeholder would record
   * a catalog rule the engine is never served.
   */
  rules: TrinoRulesDocument;
  /** The equivalent OPA module, for deployments running `access-control.name=opa`. */
  rego: string;
  /** Trino file group-provider content (`groupname:user1,user2`), '' when none. */
  groupFile: string;
  /** Content hash of `rules` — what an engine fetch is checked against. */
  version: string;
  /** Name of the policy set this was compiled from (for the admin surface). */
  policySetName: string;
  publishedAt: string;
  publishedBy: string;
  /** Stamped by the engine-rules route on every authenticated engine pull. */
  lastFetch?: {
    at: string;
    version: string;
    /** Catalogs the engine reported it had wired at fetch time. */
    catalogs: string[];
    /** The caller the route authenticated (workload identity oid, or a session UPN). */
    by: string;
  };
}

export const trinoRulesDocId = (tenantId: string) => `${TRINO_RULES_DOC_KIND}:${tenantId}`;

/** Resolve Entra membership for every group principal a `trino` statement names. */
export async function resolveTrinoGroupMemberships(
  set: PolicyCodeSet,
): Promise<{ memberships: Record<string, string[]>; warnings: string[] }> {
  const groups = trinoGroupPrincipals(set);
  const memberships: Record<string, string[]> = {};
  const warnings: string[] = [];
  if (!groups.length) return { memberships, warnings };
  try {
    const { getGroupTransitiveMembers } = await import('@/lib/azure/graph-identity-client');
    for (const g of groups) {
      try {
        const members = await getGroupTransitiveMembers(g.id);
        memberships[g.id] = members
          .filter((m) => m.type === 'user')
          .map((m) => (m.upn || m.mail || '').trim())
          .filter(Boolean);
        if (!memberships[g.id].length) {
          warnings.push(
            `Entra group "${g.name || g.id}" resolved to 0 user members, so its Trino group is EMPTY and matches `
            + 'nobody. That is fail-closed, not a silent grant — confirm the group id and that the Console '
            + 'identity holds GroupMember.Read.All.',
          );
        }
      } catch (e: any) {
        memberships[g.id] = [];
        warnings.push(
          `Could not resolve members of Entra group "${g.name || g.id}": ${String(e?.message || e).slice(0, 160)}. `
          + 'Its Trino group is published EMPTY (matches nobody) rather than omitted, so the rule fails closed.',
        );
      }
    }
  } catch (e: any) {
    warnings.push(
      `Microsoft Graph is unavailable, so no Trino group memberships could be resolved: ${String(e?.message || e).slice(0, 160)}. `
      + 'Group-keyed engine rules will not match until this succeeds; user-keyed rules are unaffected.',
    );
  }
  return { memberships, warnings };
}

/**
 * Read the published document (the version the engine is meant to be running).
 * Returns null when nothing has ever been published.
 */
export async function readTrinoEngineRules(tenantId: string): Promise<TrinoEngineRulesDoc | null> {
  const { tenantSettingsContainer } = await import('@/lib/azure/cosmos-client');
  const c = await tenantSettingsContainer();
  const { resource } = await c
    .item(trinoRulesDocId(tenantId), tenantId)
    .read<TrinoEngineRulesDoc>()
    .catch(() => ({ resource: undefined as TrinoEngineRulesDoc | undefined }));
  return resource || null;
}

export interface PublishTrinoRulesArgs {
  set: PolicyCodeSet;
  artifact: CompiledArtifact;
  tenantId: string;
  publishedBy: string;
  memberships: Record<string, string[]>;
  docOptions: TrinoDocumentOptions;
}

/** Compile + persist the engine document. Returns the published doc. */
export async function publishTrinoEngineRules(args: PublishTrinoRulesArgs): Promise<TrinoEngineRulesDoc> {
  const { set, artifact, tenantId, publishedBy, memberships, docOptions } = args;
  const prior = await readTrinoEngineRules(tenantId).catch(() => null);
  const rules = buildTrinoRulesDocument(artifact, docOptions);
  // The STORED document is the policy projection, not a servable artifact. The
  // engine is served a document rendered around the catalog list it reports at
  // fetch time (the route recompiles), so persisting the placeholder catalog
  // section here would record "deny every catalog" as though it were the policy
  // — misleading to anyone inspecting what the engine should be running. The
  // section is emptied and the reason is carried on the type.
  const storedRules: TrinoRulesDocument = { ...rules, catalogs: [] };
  const doc: TrinoEngineRulesDoc = {
    id: trinoRulesDocId(tenantId),
    tenantId,
    kind: TRINO_RULES_DOC_KIND,
    rules: storedRules,
    rego: buildTrinoRego(set, docOptions),
    groupFile: buildTrinoGroupFile(set, memberships),
    // Hashed over the POLICY sections only, so the publisher and the engine —
    // which sees a different catalog list — agree. See `rulesVersion`.
    version: rulesVersion(rules),
    policySetName: set.name,
    publishedAt: new Date().toISOString(),
    publishedBy,
    // Preserve the engine's last fetch across a republish — it is evidence about
    // the ENGINE, not about this write, and dropping it would erase the only
    // proof of what is actually enforcing.
    ...(prior?.lastFetch ? { lastFetch: prior.lastFetch } : {}),
  };
  const { tenantSettingsContainer } = await import('@/lib/azure/cosmos-client');
  const c = await tenantSettingsContainer();
  await c.items.upsert(doc);
  return doc;
}

/** Stamp an engine pull onto the published doc — the enforcement receipt. */
export async function recordTrinoEngineFetch(
  tenantId: string,
  fetch: NonNullable<TrinoEngineRulesDoc['lastFetch']>,
): Promise<void> {
  const doc = await readTrinoEngineRules(tenantId);
  if (!doc) return;
  const { tenantSettingsContainer } = await import('@/lib/azure/cosmos-client');
  const c = await tenantSettingsContainer();
  await c.items.upsert({ ...doc, lastFetch: fetch });
}

export type TrinoEnforcementState = 'enforcing' | 'stale' | 'never-fetched' | 'unpublished';

export interface TrinoEnforcementStatus {
  state: TrinoEnforcementState;
  publishedVersion?: string;
  enforcingVersion?: string;
  lastFetchAt?: string;
  /** Honest, human-readable — surfaced verbatim on /admin/policy-code. */
  detail: string;
}

/**
 * The TRUE enforcement state. `stale` means the engine is still running an
 * older version than what is published — a real, nameable condition, not
 * "applied".
 */
export function trinoEnforcementStatus(
  doc: TrinoEngineRulesDoc | null,
  refreshSeconds = 60,
): TrinoEnforcementStatus {
  if (!doc) {
    return {
      state: 'unpublished',
      detail: 'No Trino engine rules have been published for this tenant yet; the engine is running the '
        + 'catalog-level floor its entrypoint rendered at start-up.',
    };
  }
  if (!doc.lastFetch) {
    return {
      state: 'never-fetched',
      publishedVersion: doc.version,
      detail: `Rules version ${doc.version} is published, but the engine has NEVER fetched it. It is still `
        + 'enforcing the catalog floor from its start-up. Confirm LOOM_TRINO_POLICY_URL is wired on the '
        + 'loom-trino Container App and that the engine has been restarted or has reached a refresh interval.',
    };
  }
  if (doc.lastFetch.version !== doc.version) {
    return {
      state: 'stale',
      publishedVersion: doc.version,
      enforcingVersion: doc.lastFetch.version,
      lastFetchAt: doc.lastFetch.at,
      detail: `The engine last fetched version ${doc.lastFetch.version} at ${doc.lastFetch.at}; version `
        + `${doc.version} is published. The engine re-reads on its ${refreshSeconds}s refresh period — if this `
        + 'does not converge, the engine cannot reach the Console rules endpoint.',
    };
  }
  return {
    state: 'enforcing',
    publishedVersion: doc.version,
    enforcingVersion: doc.lastFetch.version,
    lastFetchAt: doc.lastFetch.at,
    detail: `The engine fetched and is enforcing rules version ${doc.version} (last confirmed ${doc.lastFetch.at}).`,
  };
}
