/**
 * GET  /api/items/activator/[id]/rules?workspaceId=...
 * POST /api/items/activator/[id]/rules?workspaceId=...  body { name, condition?, action?, query?, sourceTable?, severity?, evaluationFrequency?, windowSize? }
 * POST /api/items/activator/[id]/rules?workspaceId=&trigger=<ruleId>   — trigger a rule run
 *
 * Backend (per .claude/rules/no-fabric-dependency.md): the DEFAULT is the
 * Azure-native Azure Monitor backend — each Loom activator rule is a real
 * Microsoft.Insights/scheduledQueryRule (+ action group) and "trigger" runs the
 * rule's KQL against the Log Analytics workspace now. Rules persist on the
 * Cosmos activator item (state.rules). A Fabric Reflex is an OPT-IN alternative
 * selected with LOOM_ACTIVATOR_BACKEND=fabric — only then do we call
 * api.fabric.microsoft.com. No Fabric workspace is required for the default.
 *
 * #3551 — GET is SELF-HEALING. When state.rules is empty AND the item carries
 * evidence its install authored alert rules, it reconciles against the live
 * scheduledQueryRules before falling back to the static bundle projection, so an
 * activator whose install created real alert rules but lost the record shows
 * those rules (and can act on them) instead of an empty list. A rule is claimed
 * only on an authoritative join (the `loom-item-id` ARM tag, else the Loom
 * description marker AND the exact derived name), the write-back is merged under
 * an IfMatch, and a truncated listing is shown but never persisted. The heal's
 * WRITE is separately write-scoped: GET authorizes read roles, so the write-back
 * re-authorizes on the Owner/Admin/Member ladder and a read-only Viewer gets the
 * live rules un-persisted rather than mutating the item through a GET.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import {
  listRules, addRule, triggerRule, setTriggerState, deleteTrigger, ActivatorError,
} from '@/lib/azure/activator-client';
import {
  createMonitorActivatorRule, triggerMonitorActivatorRule,
  enableMonitorRule, disableMonitorRule, deleteMonitorActivatorRule,
  isOnDemandAdxRule, appendRunHistory,
  loomRuleNameFromDescription, ruleBelongsToItem,
  type MonitorRuleRecord, type OnDemandRunRecord,
} from '@/lib/azure/activator-monitor';
import { MonitorNotConfiguredError, MonitorError, listScheduledQueryRulesPaged, type ScheduledQueryRule } from '@/lib/azure/monitor-client';
import { monitorGate, type MonitorGateBodies } from '@/lib/azure/monitor-gate';
import { KustoError } from '@/lib/azure/kusto-client';
import { loadContentBackedItem, activatorRuleFromContent } from '../../../_lib/ai-content-fallback';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const useFabric = () => process.env.LOOM_ACTIVATOR_BACKEND === 'fabric';

/** Bundle fallback: project state.content.rule into the editor's rule shape so a
 *  freshly-installed activator renders FULLY BUILT-OUT before any live rule. */
async function bundleRules(id: string, tenantId: string) {
  const item = await loadContentBackedItem(id, 'activator', tenantId);
  if (!item) return null;
  const rule = activatorRuleFromContent(item);
  return rule ? [rule] : null;
}

// ── #3551 self-heal ────────────────────────────────────────────────────────
/*
 * Rebuild the Loom rule records from the LIVE Azure Monitor scheduledQueryRules
 * when `state.rules` is empty.
 *
 * Install authors REAL scheduledQueryRules and then records them on the item.
 * When that record was lost (the pre-#3551 best-effort write), the alert rules
 * still exist and still fire in Azure, but this GET returned `rules: []` and the
 * editor showed nothing — with no way for the user to recover, since every
 * per-rule action keys off `state.rules`. Rather than leave those items dead,
 * re-derive the records from ARM and write them back, per
 * .claude/rules/auto-bind-by-default.md §3 (a stale binding is repaired
 * automatically, not shown to the user).
 *
 * A claimed rule is not merely DISPLAYED — it is recorded on the item, and
 * DELETE / enable / disable then act on the live Azure resource through it. So
 * the join key must be authoritative, never plausible: `ruleBelongsToItem`
 * answers on the `loom-item-id` ARM tag, else on the description marker AND the
 * exact deterministic name this item's own authoring path produces. See its
 * docstring in lib/azure/activator-monitor.ts.
 */

/** How long a no-match reconcile suppresses the next deployment-wide ARM list. */
const RECONCILE_COOLDOWN_MS = 10 * 60_000;
/** Bounded re-read + retry for the heal write when it loses an etag race. */
const HEAL_WRITE_ATTEMPTS = 3;
/** Cap on the per-item tombstone list (deleted ARM rule names). */
const MAX_TOMBSTONES = 50;

/** ARM rule names this item has deleted. A `listScheduledQueryRules` is
 *  eventually consistent, so a just-deleted rule can still appear in it; without
 *  this the next open would write the deleted rule back into `state.rules`, where
 *  it would stay forever (a non-empty `state.rules` never re-reconciles). */
function tombstonesOf(item: WorkspaceItem | null | undefined): string[] {
  const t = (item?.state as any)?.rulesDeleted;
  return Array.isArray(t) ? t.filter((n: any) => typeof n === 'string') : [];
}

function withTombstone(state: any, azureRuleName?: string): string[] {
  const cur = Array.isArray(state?.rulesDeleted) ? state.rulesDeleted.filter((n: any) => typeof n === 'string') : [];
  if (!azureRuleName) return cur;
  return [...cur.filter((n: string) => n !== azureRuleName), azureRuleName].slice(-MAX_TOMBSTONES);
}

/** Drop a name from the tombstone list — used when the same rule is re-created,
 *  so a legitimate re-create is not permanently shadowed by its own deletion. */
function withoutTombstone(state: any, azureRuleName?: string): string[] {
  const cur = Array.isArray(state?.rulesDeleted) ? state.rulesDeleted.filter((n: any) => typeof n === 'string') : [];
  return azureRuleName ? cur.filter((n: string) => n !== azureRuleName) : cur;
}

/** The `rulesDeleted` state field, omitted entirely on items that have never had
 *  one — a create/edit should not add an empty key to every activator's state. */
function tombstoneField(next: string[], prev: string[]): { rulesDeleted?: string[] } {
  return next.length || prev.length ? { rulesDeleted: next } : {};
}

/** True for a Cosmos optimistic-concurrency rejection (the IfMatch lost). */
function isEtagConflict(e: any): boolean {
  const code = e?.code ?? e?.statusCode ?? e?.status;
  return code === 412 || /precondition\s*failed/i.test(String(e?.message || ''));
}

/**
 * Read the CURRENT document, let `mutate` build the next one from it, and write
 * it back conditionally on that document's etag.
 *
 * The GET path reads the item, then spends a multi-hundred-ms ARM call, then
 * writes. An unconditional `replace` of the pre-call document silently discards
 * anything that landed in between — including a rule the user POSTed during the
 * window, which is exactly the "the rule exists in Azure but not in state.rules"
 * symptom #3551 exists to remove. Re-read + merge + IfMatch, mirroring the
 * install-side pattern in lib/install/provisioners/activator.ts.
 *
 * `mutate` returning null means "nothing to write" and is reported as success.
 */
async function replaceWithMerge(
  item: WorkspaceItem,
  mutate: (cur: WorkspaceItem) => WorkspaceItem | null,
): Promise<{ ok: boolean; error?: string }> {
  let lastError = '';
  for (let attempt = 1; attempt <= HEAL_WRITE_ATTEMPTS; attempt++) {
    try {
      const items = await itemsContainer();
      const { resource } = await items.item(item.id, item.workspaceId).read<WorkspaceItem>();
      const cur = resource || item;
      const next = mutate(cur);
      if (!next) return { ok: true };
      const etag = (cur as any)?._etag;
      await items.item(cur.id, cur.workspaceId).replace(
        next,
        etag ? { accessCondition: { type: 'IfMatch', condition: etag } } : undefined,
      );
      return { ok: true };
    } catch (e: any) {
      lastError = e?.message || String(e);
      // An etag conflict means someone else wrote first — re-read and re-merge
      // against THEIR document rather than overwriting it.
      if (!isEtagConflict(e) || attempt === HEAL_WRITE_ATTEMPTS) return { ok: false, error: lastError };
    }
  }
  return { ok: false, error: lastError };
}

/**
 * Whether this item has any REASON to spend a deployment-wide ARM list.
 *
 * The listing enumerates the whole `LOOM_ALERT_RG`, and a no-match writes no
 * rules — so without a gate every GET of every zero-rule activator lists ARM
 * forever, including the first open of a freshly created item that cannot
 * possibly have install-authored rules. Returns the evidence (for the honest
 * response) or null.
 */
function reconcileEvidence(item: WorkspaceItem, bundleRule: any | null): string | null {
  const created = Number((item.state as any)?.provisioning?.secondaryIds?.rulesCreated);
  if (Number.isFinite(created) && created > 0) {
    return `the install recorded ${created} Azure Monitor alert rule(s) for this item`;
  }
  if (bundleRule) return "this item's content bundle defines an alert rule";
  return null;
}

/** True while a previous reconcile's no-match result is still fresh. */
function inReconcileCooldown(item: WorkspaceItem): boolean {
  const last = (item.state as any)?.rulesReconcile;
  if (!last || last.outcome !== 'none' || typeof last.at !== 'string') return false;
  const at = Date.parse(last.at);
  return Number.isFinite(at) && Date.now() - at < RECONCILE_COOLDOWN_MS;
}

/**
 * Project a live ARM rule onto the Loom rule record.
 *
 * Everything here comes from ARM except:
 *   - `condition` / `action`, which ARM does not return — filled ONLY from the
 *     item's OWN bundle content when it carries a rule of the same name;
 *   - `severity` / `evaluationFrequency` / `windowSize` when the ARM payload
 *     omits them, which fall back to the SAME defaults the create path uses
 *     (severity 3, PT5M, PT5M — see upsertScheduledQueryRule). Those are stated
 *     rather than presented as read values (deploy-integrity.md R7).
 */
function recordFromLiveRule(r: ScheduledQueryRule, bundleRule?: any): MonitorRuleRecord {
  // createMonitorActivatorRule stamps the Loom-facing rule name into the ARM
  // description: "Loom Activator rule '<name>'" (+ " (Eventhouse / ADX)").
  const named = loomRuleNameFromDescription(r.description);
  // The alert SCOPE is the authoritative source backend — an ADX-scoped rule is
  // scoped to the Kusto cluster, an LA rule to the workspace.
  const sourceKind: 'log-analytics' | 'adx' =
    (r.scopes || []).some((s) => /\/providers\/Microsoft\.Kusto\/clusters\//i.test(s)) ? 'adx' : 'log-analytics';
  const defaulted: string[] = [];
  if (typeof r.severity !== 'number') defaulted.push('severity');
  if (!r.evaluationFrequency) defaulted.push('evaluationFrequency');
  if (!r.windowSize) defaulted.push('windowSize');
  return {
    id: r.name,
    name: named || r.name,
    query: r.query || '',
    azureRuleName: r.name,
    ...(bundleRule?.condition ? { condition: bundleRule.condition } : {}),
    ...(bundleRule?.action ? { action: bundleRule.action } : {}),
    ...(r.actionGroupIds?.[0] ? { actionGroupId: r.actionGroupIds[0] } : {}),
    severity: typeof r.severity === 'number' ? r.severity : 3,
    evaluationFrequency: r.evaluationFrequency || 'PT5M',
    windowSize: r.windowSize || 'PT5M',
    state: r.enabled ? 'Active' : 'Disabled',
    backend: 'azure-monitor',
    sourceKind,
    scheduled: true,
    // ARM's scheduledQueryRules listing does not return a creation time, so this
    // is the RECOVERY time, not the rule's creation time — said plainly in the
    // note rather than presented as the original (deploy-integrity.md R7).
    createdAt: new Date().toISOString(),
    note:
      'Recovered from the live Azure Monitor alert rule: this rule was created by the install but its record was missing from the item. ' +
      'The created timestamp is when it was recovered — Azure Monitor does not report the rule\'s original creation time.' +
      (defaulted.length
        ? ` The Azure listing did not return ${defaulted.join(' / ')}; the create path's default was used for ${defaulted.length > 1 ? 'those' : 'that'}.`
        : ''),
  };
}

/** What a read-only caller is told when the heal was withheld. States what
 *  happened, not a remediation the caller cannot perform (deploy-integrity R7). */
const READ_ONLY_HEAL_NOTE =
  'These rules were read live from Azure Monitor and are real, but they were NOT recorded on the item: '
  + 'recording is a write and your role on this workspace is read-only. '
  + 'The next open by a workspace Owner/Admin/Member records them, after which every caller gets a plain read.';

/**
 * Returns the reconciled records (written back to the item when the listing was
 * COMPLETE, the caller may WRITE, and the write succeeded), or null when there
 * is nothing to reconcile / no reason to look / Azure Monitor cannot be listed.
 * NEVER throws: a reconcile that can't run must not break a GET that would
 * otherwise fall through to the bundle projection.
 *
 * `canPersist` — THE READ/WRITE SPLIT. This function runs inside a GET that is
 * authorized with `allowReadRoles: true`, i.e. any workspace role including a
 * read-only Viewer. Both of its `replaceWithMerge` calls are WRITES to the
 * Cosmos item (the second rewrites `state.rules` and bumps `updatedAt`), so
 * running them on the read-scoped authorization alone would let a Viewer mutate
 * through a GET — precisely what lib/auth/workspace-guard.ts's contract forbids
 * ("Mutating handlers must NOT pass it — they stay write-scoped so a read-only
 * Viewer can never mutate through a route that only 'made the read work'").
 * The caller therefore hands in a WRITE-scoped authorization probe, evaluated
 * only when a write is actually about to happen, and a read-only caller still
 * gets the correct live rules — just un-persisted, and told so.
 */
async function reconcileFromAzureMonitor(
  item: WorkspaceItem,
  bundleRule: any | null,
  canPersist: () => Promise<boolean>,
): Promise<{ rules: MonitorRuleRecord[]; healed: boolean; partial: boolean; note?: string } | null> {
  try {
    const evidence = reconcileEvidence(item, bundleRule);
    if (!evidence) return null;
    if (inReconcileCooldown(item)) return null;

    const listed = await listScheduledQueryRulesPaged();
    const tombstoned = new Set(tombstonesOf(item));
    const mine = listed.rules.filter((r) => ruleBelongsToItem(r, item) && !tombstoned.has(r.name));

    if (mine.length === 0) {
      // Remember the miss so the next open is a plain read. Not on a truncated
      // listing: "I did not find it in the part I read" is not "it is not there"
      // (deploy-integrity.md R7). And not for a read-only caller — the cooldown
      // marker is still a write to the item.
      if (!listed.truncatedBy && (await canPersist())) {
        const at = new Date().toISOString();
        await replaceWithMerge(item, (cur) => ({
          ...cur,
          // updatedAt is deliberately NOT bumped: nothing about the item changed.
          state: { ...(cur.state || {}), rulesReconcile: { at, outcome: 'none', evidence } },
        }));
      }
      return null;
    }

    const records = mine.map((r) => {
      const named = loomRuleNameFromDescription(r.description);
      const match = bundleRule && (bundleRule.name === named || bundleRule.name === r.name) ? bundleRule : undefined;
      return recordFromLiveRule(r, match);
    });

    if (listed.truncatedBy) {
      // The listing stopped at its paging ceiling, so this set is what fit — not
      // "this item's rules". Persisting it would freeze a PARTIAL record: a
      // non-empty state.rules never reconciles again, so the rules that were cut
      // off would be unreachable permanently. Show what was found, persist
      // nothing, and reconcile again on the next open.
      return {
        rules: records,
        healed: false,
        partial: true,
        note:
          `The Azure Monitor listing stopped at its ${listed.truncatedBy} ceiling after ${listed.pagesFetched} page(s), ` +
          'so this may not be every rule for this activator. Nothing was recorded on the item — the next open re-reads Azure. ' +
          `Raise ${listed.truncatedBy === 'pages' ? 'LOOM_ARM_PAGING_MAX_PAGES' : 'LOOM_ARM_PAGING_BUDGET_MS'} if this alert resource group is legitimately larger.`,
      };
    }

    // Write the recovered records back so the NEXT open is a plain read and every
    // per-rule action (Start/Stop/Edit/Delete) resolves. Merged against the
    // CURRENT document under an IfMatch, so a rule added during the ARM call
    // survives. Honestly reported: the response is correct either way, and a
    // failed write just means the next GET reconciles again.
    //
    // A READ-ONLY caller gets the same rules and no write at all: the records
    // above are derived from a live ARM READ, which any workspace role may do;
    // persisting them is a mutation, which a Viewer may not.
    if (!(await canPersist())) {
      return { rules: records, healed: false, partial: false, note: READ_ONLY_HEAL_NOTE };
    }
    let view: MonitorRuleRecord[] = records;
    const at = new Date().toISOString();
    const write = await replaceWithMerge(item, (cur) => {
      const curTomb = new Set(tombstonesOf(cur));
      const keep = records.filter((r) => !curTomb.has(r.azureRuleName));
      const existing: MonitorRuleRecord[] = Array.isArray((cur.state as any)?.rules) ? (cur.state as any).rules : [];
      const merged = [...existing.filter((e) => !keep.some((k) => k.id === e.id)), ...keep];
      view = merged;
      if (keep.length === 0) return null;
      return {
        ...cur,
        state: { ...(cur.state || {}), rules: merged, rulesReconcile: { at, outcome: 'healed', count: keep.length } },
        updatedAt: at,
      };
    });
    if (view.length === 0) return null;
    return { rules: view, healed: write.ok, partial: false };
  } catch {
    // Monitor not configured / not authorized / unreachable — fall through to
    // the bundle projection. The caller's existing gates cover the write paths.
    return null;
  }
}

/** Honest Azure infra-gate (NOT a Fabric gate) for Monitor errors. */
const monitorGateBodies: MonitorGateBodies = {
  notConfigured: (missing) => ({ error: `Azure Monitor not configured: set ${missing?.join(' / ') || 'LOOM_LOG_ANALYTICS_RESOURCE_ID / LOOM_ALERT_RG'}.`,
      gate: { reason: 'The Azure-native Activator creates scheduled-query alert rules on Azure Monitor.', remediation: `Set ${missing?.join(' / ') || 'LOOM_LOG_ANALYTICS_RESOURCE_ID + LOOM_ALERT_RG'} on the Console. No Microsoft Fabric required.` },
    }),
  unauthorized: (status) => ({ error: `Azure Monitor ${status}: not authorized to create alert rules.`,
      gate: { reason: 'The Console UAMI needs rights on the alert resource group.', remediation: 'Grant the Console UAMI "Monitoring Contributor" on LOOM_ALERT_RG so it can create scheduledQueryRules + action groups.' },
    }),
};

/** Honest Azure infra-gate for ADX / Eventhouse (Kusto) trigger/preview errors.
 *  A rule authored over Eventhouse data evaluates against the ADX cluster; when
 *  LOOM_KUSTO_* is unset (a non-ADX deploy) or the UAMI lacks cluster rights the
 *  query fails — surface it as a precise 503/403 gate, NOT a Fabric gate. */
function kustoGate(e: any): NextResponse | null {
  if (!(e instanceof KustoError)) return null;
  if (e.status === 401 || e.status === 403) {
    return NextResponse.json({
      ok: false,
      error: `Azure Data Explorer ${e.status}: not authorized to query the Eventhouse cluster.`,
      gate: { reason: 'The Console UAMI needs query rights on the ADX / Eventhouse cluster.', remediation: 'Grant the Console UAMI Database Viewer (or AllDatabasesViewer) on the ADX cluster so it can run the rule KQL. No Microsoft Fabric required.' },
    }, { status: 403 });
  }
  return NextResponse.json({
    ok: false,
    error: `Azure Data Explorer error: ${e.message}`,
    gate: { reason: 'The Eventhouse / ADX cluster is not reachable for this rule.', remediation: 'Set LOOM_KUSTO_CLUSTER_URI (and LOOM_KUSTO_DEFAULT_DB) to your Eventhouse cluster, or choose a Log Analytics source. No Microsoft Fabric required.' },
  }, { status: e.status && e.status >= 400 ? e.status : 503 });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  // #2947 — was owner-only `assertOwner` ("did you CREATE this workspace"),
  // which 404'd a tenant admin / shared member. Canonical ladder, read-scoped.
  {
    const denied = await authorizeItemWorkspace(session, {
      workspaceId, itemId: (await ctx.params).id, itemType: 'activator',
      allowReadRoles: true,
      notFound: 'activator not found',
    });
    if (denied) return denied;
  }
  const { id } = await ctx.params;

  // ── Fabric Reflex (opt-in) ──
  if (useFabric()) {
    try {
      const rules = await listRules(workspaceId, id);
      if (!rules || rules.length === 0) {
        const fb = await bundleRules(id, session.claims.oid);
        if (fb) return NextResponse.json({ ok: true, rules: fb, source: 'bundle', backend: 'fabric' });
      }
      return NextResponse.json({ ok: true, rules, backend: 'fabric' });
    } catch (e: any) {
      const fb = await bundleRules(id, session.claims.oid);
      if (fb) return NextResponse.json({ ok: true, rules: fb, source: 'bundle', fabricError: e?.message || String(e) });
      const status = e instanceof ActivatorError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
    }
  }

  // ── Azure Monitor (DEFAULT) ── rules persist on the Cosmos item.
  try {
    const item = await loadContentBackedItem(id, 'activator', session.claims.oid);
    const persisted = Array.isArray((item?.state as any)?.rules) ? (item!.state as any).rules : [];
    if (persisted.length > 0) return NextResponse.json({ ok: true, rules: persisted, backend: 'azure-monitor' });

    // state.rules is empty. Before falling back to the STATIC bundle projection
    // (which carries no azureRuleName, so no per-rule Start/Stop/Edit/Delete can
    // resolve), check whether the install DID create real Azure Monitor rules
    // whose record was lost — #3551 — and heal the item from them.
    const bundleRule = item ? activatorRuleFromContent(item) : null;
    if (item) {
      // WRITE-scoped probe for the self-heal's write-back, evaluated lazily so a
      // GET that never reaches a write pays nothing for it, and at most once.
      // The read above ran on `allowReadRoles: true` (any workspace role); the
      // heal PERSISTS to the item, so it needs the write ladder
      // (Owner/Admin/Member) — see the `canPersist` note on
      // reconcileFromAzureMonitor. A denial is NOT returned to the caller: the
      // READ is legitimately theirs, and turning it into a 404 would break the
      // editor for every read-only member.
      let writeScoped: boolean | undefined;
      const canPersist = async (): Promise<boolean> => {
        if (writeScoped === undefined) {
          // The guard's answer is TESTED, not returned: its 404 means "this
          // caller may not write", which withholds the heal — it is NOT this
          // request's response, because the READ is legitimately theirs.
          writeScoped = true;
          if (await authorizeItemWorkspace(session, {
            workspaceId, itemId: id, itemType: 'activator',
            notFound: 'activator not found',
          })) writeScoped = false;
        }
        return writeScoped;
      };
      const reconciled = await reconcileFromAzureMonitor(item, bundleRule, canPersist);
      if (reconciled) {
        return NextResponse.json({
          ok: true,
          rules: reconciled.rules,
          source: 'azure-monitor-reconciled',
          backend: 'azure-monitor',
          healed: reconciled.healed,
          ...(reconciled.partial ? { partial: true } : {}),
          ...(reconciled.note ? { note: reconciled.note } : {}),
        });
      }
    }
    if (bundleRule) return NextResponse.json({ ok: true, rules: [bundleRule], source: 'bundle', backend: 'azure-monitor' });
    return NextResponse.json({ ok: true, rules: [], backend: 'azure-monitor' });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  // #2947 — was owner-only `assertOwner` ("did you CREATE this workspace"),
  // which 404'd a tenant admin / shared member. Canonical ladder, write-scoped.
  {
    const denied = await authorizeItemWorkspace(session, {
      workspaceId, itemId: (await ctx.params).id, itemType: 'activator',
      notFound: 'activator not found',
    });
    if (denied) return denied;
  }
  const { id } = await ctx.params;
  const triggerId = req.nextUrl.searchParams.get('trigger');

  // ── Fabric Reflex (opt-in) ──
  if (useFabric()) {
    if (triggerId) {
      try { return NextResponse.json(await triggerRule(workspaceId, id, triggerId)); }
      catch (e: any) { return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e instanceof ActivatorError ? e.status : 502 }); }
    }
    const body = await req.json().catch(() => ({}));
    const name = String(body?.name || '').trim();
    if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
    try {
      const rule = await addRule(workspaceId, id, { name, condition: body?.condition || undefined, action: body?.action || undefined });
      return NextResponse.json({ ok: true, rule, backend: 'fabric' });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e instanceof ActivatorError ? e.status : 502 });
    }
  }

  // ── Azure Monitor (DEFAULT) ──
  const item = await loadContentBackedItem(id, 'activator', session.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'activator not found' }, { status: 404 });
  const rules: MonitorRuleRecord[] = Array.isArray((item.state as any)?.rules) ? (item.state as any).rules : [];

  // Trigger now = run the rule's KQL against its source (ADX/Eventhouse for RTI
  // rules, Log Analytics for LA rules) and report rows / would-fire.
  if (triggerId) {
    const rule = rules.find((r) => r.id === triggerId || r.name === triggerId);
    if (!rule) return NextResponse.json({ ok: false, error: `rule '${triggerId}' not found` }, { status: 404 });
    if (!rule.query && rule.sourceKind !== 'adx') {
      return NextResponse.json({ ok: false, error: `rule '${triggerId}' has no query to run` }, { status: 400 });
    }
    try {
      const out = await triggerMonitorActivatorRule(rule);
      // Persist the evaluation to the item's CAPPED on-demand run history so the
      // Run history tab shows Trigger/Preview runs — on-demand ADX rules (the
      // RTI default when LOOM_ADX_ALERT_SCOPE is unset) have NO Azure Monitor
      // alert instances, so this record is their ONLY history. Best-effort: the
      // trigger result is still returned if the write fails, and the response
      // says honestly whether the run was recorded.
      let historyRecorded = false;
      try {
        const run: OnDemandRunRecord = {
          ruleId: rule.id,
          ruleName: rule.name || rule.azureRuleName || rule.id,
          at: new Date().toISOString(),
          rowCount: out.count,
          fired: out.fired,
          backend: out.backend,
        };
        const runHistory = appendRunHistory(item.state, run);
        const items = await itemsContainer();
        const next: WorkspaceItem = { ...item, state: { ...(item.state || {}), runHistory }, updatedAt: new Date().toISOString() };
        await items.item(item.id, item.workspaceId).replace(next);
        historyRecorded = true;
      } catch { /* run result still returned below */ }
      return NextResponse.json({ ok: true, ...out, historyRecorded });
    } catch (e: any) {
      return kustoGate(e) || monitorGate(e, monitorGateBodies) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  const body = await req.json().catch(() => ({}));
  const name = String(body?.name || '').trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  try {
    const rule = await createMonitorActivatorRule(item.displayName, {
      name,
      // Stamp the owning Loom item onto the ARM rule so a later read can join it
      // back on an identity instead of on the derived, user-controlled name.
      loomItemId: item.id,
      condition: body?.condition || undefined,
      action: body?.action || undefined,
      query: typeof body?.query === 'string' ? body.query : undefined,
      sourceTable: typeof body?.sourceTable === 'string' ? body.sourceTable : undefined,
      severity: typeof body?.severity === 'number' ? body.severity : undefined,
      evaluationFrequency: typeof body?.evaluationFrequency === 'string' ? body.evaluationFrequency : undefined,
      windowSize: typeof body?.windowSize === 'string' ? body.windowSize : undefined,
      existingActionGroupId: typeof body?.existingActionGroupId === 'string' ? body.existingActionGroupId : undefined,
      sourceKind: body?.sourceKind === 'adx' ? 'adx' : (body?.sourceKind === 'log-analytics' ? 'log-analytics' : undefined),
      adxDatabase: typeof body?.adxDatabase === 'string' ? body.adxDatabase : undefined,
      adxClusterUri: typeof body?.adxClusterUri === 'string' ? body.adxClusterUri : undefined,
      // Trigger-model depth (FGC-13).
      ruleKind: typeof body?.ruleKind === 'string' ? body.ruleKind : undefined,
      objectKey: typeof body?.objectKey === 'string' ? body.objectKey : undefined,
      propertyConditionType: typeof body?.propertyConditionType === 'string' ? body.propertyConditionType : undefined,
      changePercent: typeof body?.changePercent === 'number' ? body.changePercent : undefined,
      rangeMin: typeof body?.rangeMin === 'number' ? body.rangeMin : undefined,
      rangeMax: typeof body?.rangeMax === 'number' ? body.rangeMax : undefined,
      noDataMinutes: typeof body?.noDataMinutes === 'number' ? body.noDataMinutes : undefined,
      timestampColumn: typeof body?.timestampColumn === 'string' ? body.timestampColumn : undefined,
    });
    // Persist onto the Cosmos item so the rule list survives reload. Re-creating
    // a previously deleted rule lifts its tombstone, so a later reconcile is not
    // shadowed by the old deletion.
    const nextRules = [...rules.filter((r) => r.id !== rule.id), rule];
    const items = await itemsContainer();
    const next: WorkspaceItem = {
      ...item,
      state: {
        ...(item.state || {}),
        rules: nextRules,
        ...tombstoneField(withoutTombstone(item.state, rule.azureRuleName), tombstonesOf(item)),
      },
      updatedAt: new Date().toISOString(),
    };
    await items.item(item.id, item.workspaceId).replace(next);
    return NextResponse.json({ ok: true, rule, backend: 'azure-monitor' });
  } catch (e: any) {
    return kustoGate(e) || monitorGate(e, monitorGateBodies) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

/**
 * PATCH /api/items/activator/[id]/rules?workspaceId=&ruleId=<id>&enabled=<true|false>
 *
 * Enable/disable a single rule. Azure-native (DEFAULT): an in-place ARM PATCH
 * of the backing scheduledQueryRule's properties.enabled — preserves the query,
 * scopes, action group, and schedule. The new state is persisted onto the Cosmos
 * item so the list reflects it across reloads. Fabric opt-in: PATCH the trigger
 * to Active/Stopped.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  // #2947 — was owner-only `assertOwner` ("did you CREATE this workspace"),
  // which 404'd a tenant admin / shared member. Canonical ladder, write-scoped.
  {
    const denied = await authorizeItemWorkspace(session, {
      workspaceId, itemId: (await ctx.params).id, itemType: 'activator',
      notFound: 'activator not found',
    });
    if (denied) return denied;
  }
  const { id } = await ctx.params;
  const ruleId = req.nextUrl.searchParams.get('ruleId');
  if (!ruleId) return NextResponse.json({ ok: false, error: 'ruleId required' }, { status: 400 });
  const enabledParam = req.nextUrl.searchParams.get('enabled');
  if (enabledParam !== 'true' && enabledParam !== 'false') {
    return NextResponse.json({ ok: false, error: 'enabled=true|false required' }, { status: 400 });
  }
  const enabled = enabledParam === 'true';

  // ── Fabric Reflex (opt-in) ──
  if (useFabric()) {
    try {
      await setTriggerState(workspaceId, id, ruleId, enabled ? 'Active' : 'Stopped');
      return NextResponse.json({ ok: true, backend: 'fabric', enabled });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e instanceof ActivatorError ? e.status : 502 });
    }
  }

  // ── Azure Monitor (DEFAULT) ──
  const item = await loadContentBackedItem(id, 'activator', session.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'activator not found' }, { status: 404 });
  const rules: MonitorRuleRecord[] = Array.isArray((item.state as any)?.rules) ? (item.state as any).rules : [];
  const rule = rules.find((r) => r.id === ruleId || r.name === ruleId || r.azureRuleName === ruleId);
  if (!rule?.azureRuleName) return NextResponse.json({ ok: false, error: `rule '${ruleId}' not found` }, { status: 404 });

  try {
    // Unscheduled Eventhouse/ADX rules have NO backing scheduledQueryRule on
    // ARM (LOOM_ADX_ALERT_SCOPE unset) — the ARM PATCH would 404 and the toggle
    // would silently no-op. Their enable/disable IS the persisted flag: the
    // Trigger/Preview path is their evaluation plane. Scheduled rules (LA, or
    // ADX with an alert host) get the real in-place ARM PATCH.
    const onDemand = isOnDemandAdxRule(rule);
    if (!onDemand) {
      if (enabled) await enableMonitorRule(rule.azureRuleName);
      else await disableMonitorRule(rule.azureRuleName);
    }
    // Persist the new state on the Cosmos item.
    const updatedRule: MonitorRuleRecord = { ...rule, state: enabled ? 'Active' : 'Disabled', updatedAt: new Date().toISOString() };
    const nextRules = rules.map((r) => (r.id === rule.id ? updatedRule : r));
    const items = await itemsContainer();
    const next: WorkspaceItem = { ...item, state: { ...(item.state || {}), rules: nextRules }, updatedAt: new Date().toISOString() };
    await items.item(item.id, item.workspaceId).replace(next);
    return NextResponse.json({
      ok: true, rule: updatedRule, backend: 'azure-monitor',
      ...(onDemand ? {
        onDemand: true,
        message: `On-demand Eventhouse/ADX rule — no Azure Monitor scheduledQueryRule to ${enabled ? 'enable' : 'disable'}; enabled flag updated. The rule evaluates via Trigger/Preview.`,
      } : {}),
    });
  } catch (e: any) {
    return monitorGate(e, monitorGateBodies) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

/**
 * DELETE /api/items/activator/[id]/rules?workspaceId=&ruleId=<id>
 *
 * Delete a single rule. Azure-native (DEFAULT): ARM DELETE of the backing
 * scheduledQueryRule, then splice the record out of the Cosmos item's
 * state.rules. Fabric opt-in: DELETE the trigger.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  // #2947 — was owner-only `assertOwner` ("did you CREATE this workspace"),
  // which 404'd a tenant admin / shared member. Canonical ladder, write-scoped.
  {
    const denied = await authorizeItemWorkspace(session, {
      workspaceId, itemId: (await ctx.params).id, itemType: 'activator',
      notFound: 'activator not found',
    });
    if (denied) return denied;
  }
  const { id } = await ctx.params;
  const ruleId = req.nextUrl.searchParams.get('ruleId');
  if (!ruleId) return NextResponse.json({ ok: false, error: 'ruleId required' }, { status: 400 });

  // ── Fabric Reflex (opt-in) ──
  if (useFabric()) {
    try {
      await deleteTrigger(workspaceId, id, ruleId);
      return NextResponse.json({ ok: true, backend: 'fabric' });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e instanceof ActivatorError ? e.status : 502 });
    }
  }

  // ── Azure Monitor (DEFAULT) ──
  const item = await loadContentBackedItem(id, 'activator', session.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'activator not found' }, { status: 404 });
  const rules: MonitorRuleRecord[] = Array.isArray((item.state as any)?.rules) ? (item.state as any).rules : [];
  const rule = rules.find((r) => r.id === ruleId || r.name === ruleId || r.azureRuleName === ruleId);
  if (!rule) return NextResponse.json({ ok: false, error: `rule '${ruleId}' not found` }, { status: 404 });

  try {
    if (rule.azureRuleName) await deleteMonitorActivatorRule(rule.azureRuleName);
    const nextRules = rules.filter((r) => r.id !== rule.id);
    const items = await itemsContainer();
    // Record the deleted ARM name. The scheduledQueryRules listing is eventually
    // consistent, so a reopen right after this can still see the rule; without
    // the tombstone the #3551 reconcile would write it back into state.rules and
    // — since a non-empty state.rules never re-reconciles — it would stay there
    // permanently, pointing at a rule that no longer exists.
    const next: WorkspaceItem = {
      ...item,
      state: { ...(item.state || {}), rules: nextRules, rulesDeleted: withTombstone(item.state, rule.azureRuleName) },
      updatedAt: new Date().toISOString(),
    };
    await items.item(item.id, item.workspaceId).replace(next);
    return NextResponse.json({ ok: true, backend: 'azure-monitor' });
  } catch (e: any) {
    return monitorGate(e, monitorGateBodies) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

/**
 * PUT /api/items/activator/[id]/rules?workspaceId=&ruleId=<id>
 *   body { name?, condition?, action?, query?, sourceTable?, severity?, evaluationFrequency?, windowSize?, existingActionGroupId? }
 *
 * Update an existing rule (the editor's structured Edit-rule flow re-opens the
 * same wizard pre-filled and PUTs the full body — never a freeform JSON box).
 * Azure-native (DEFAULT): re-run createMonitorActivatorRule, which UPSERTS the
 * backing scheduledQueryRule by name, with the new body (omitted fields fall
 * back to the existing record so a partial edit never silently resets config).
 * If a rename changed the azureRuleName, the orphaned ARM rule left under the
 * old name is deleted (best-effort). A paused ('Disabled') rule keeps its state
 * — editing must not surprise-re-enable it. The replaced record is persisted to
 * the Cosmos item's state.rules via the SAME itemsContainer replace path
 * POST/PATCH/DELETE use, so the editor/pane/Start all see the edit on reload.
 * Fabric opt-in: editing a Reflex rule's body is an opt-in follow-up; use
 * enable/disable/delete on that path, or the Azure-native default.
 */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  // #2947 — was owner-only `assertOwner` ("did you CREATE this workspace"),
  // which 404'd a tenant admin / shared member. Canonical ladder, write-scoped.
  {
    const denied = await authorizeItemWorkspace(session, {
      workspaceId, itemId: (await ctx.params).id, itemType: 'activator',
      notFound: 'activator not found',
    });
    if (denied) return denied;
  }
  const { id } = await ctx.params;
  const ruleId = req.nextUrl.searchParams.get('ruleId');
  if (!ruleId) return NextResponse.json({ ok: false, error: 'ruleId required' }, { status: 400 });

  // ── Fabric Reflex (opt-in) ── editing a trigger body is an opt-in follow-up.
  if (useFabric()) {
    return NextResponse.json({
      ok: false,
      error: 'Editing a Fabric Reflex rule body is not supported on the opt-in Fabric backend yet — use enable/disable/delete, or the Azure-native default.',
    }, { status: 501 });
  }

  // ── Azure Monitor (DEFAULT) ──
  const body = await req.json().catch(() => ({}));
  const item = await loadContentBackedItem(id, 'activator', session.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'activator not found' }, { status: 404 });
  const rules: MonitorRuleRecord[] = Array.isArray((item.state as any)?.rules) ? (item.state as any).rules : [];
  const old = rules.find((r) => r.id === ruleId || r.name === ruleId || r.azureRuleName === ruleId);
  if (!old) return NextResponse.json({ ok: false, error: `rule '${ruleId}' not found` }, { status: 404 });

  try {
    // Upsert the backing scheduledQueryRule by name. Omitted body fields fall
    // back to the existing record so a partial PUT doesn't reset live config.
    //
    // The condition builder rebuilds the query ONLY when the body actually
    // carries a condition (a property/field/metric) or a typed trigger model.
    // The editor always sends `condition` and `ruleKind:'event'`, even when the
    // builder is empty — and a rule recovered from ARM (#3551) has a real KQL
    // query but NO structured condition, so its Edit dialog opens empty. Treating
    // that empty shape as "rebuild" made a severity-only edit push buildRuleQuery's
    // defaults (property='value', operator='==', value=0) over a working query.
    const bodyConditionHasShape = !!(
      body?.condition && (body.condition.property || body.condition.field || body.condition.metric)
    );
    const bodyHasTriggerModel = !!(
      body?.propertyConditionType || (typeof body?.ruleKind === 'string' && body.ruleKind !== 'event')
    );
    const rebuildFromCondition = bodyConditionHasShape || bodyHasTriggerModel;
    const rec = await createMonitorActivatorRule(item.displayName, {
      name: typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : old.name,
      loomItemId: item.id,
      condition: body?.condition ?? old.condition ?? undefined,
      action: body?.action ?? old.action ?? undefined,
      // A new verbatim query wins; else a new structured condition rebuilds it;
      // else keep the rule's existing query (don't lose a verbatim KQL rule).
      query: typeof body?.query === 'string' && body.query.trim()
        ? body.query
        : (rebuildFromCondition ? undefined : old.query),
      sourceTable: typeof body?.sourceTable === 'string' ? body.sourceTable : undefined,
      severity: typeof body?.severity === 'number' ? body.severity : old.severity,
      evaluationFrequency: typeof body?.evaluationFrequency === 'string' ? body.evaluationFrequency : old.evaluationFrequency,
      windowSize: typeof body?.windowSize === 'string' ? body.windowSize : old.windowSize,
      existingActionGroupId: typeof body?.existingActionGroupId === 'string' ? body.existingActionGroupId : undefined,
      // Preserve (or update) the source backend + ADX target across an edit so a
      // partial PUT never silently flips an Eventhouse rule back to Log Analytics.
      sourceKind: body?.sourceKind === 'adx' ? 'adx' : (body?.sourceKind === 'log-analytics' ? 'log-analytics' : (old.sourceKind || undefined)),
      adxDatabase: typeof body?.adxDatabase === 'string' ? body.adxDatabase : old.adxDatabase,
      adxClusterUri: typeof body?.adxClusterUri === 'string' ? body.adxClusterUri : old.adxClusterUri,
      // Trigger-model depth (FGC-13) — a partial edit preserves the prior kind/condition.
      ruleKind: typeof body?.ruleKind === 'string' ? body.ruleKind : old.ruleKind,
      objectKey: typeof body?.objectKey === 'string' ? body.objectKey : old.objectKey,
      propertyConditionType: typeof body?.propertyConditionType === 'string' ? body.propertyConditionType : old.propertyConditionType,
      changePercent: typeof body?.changePercent === 'number' ? body.changePercent : old.changePercent,
      rangeMin: typeof body?.rangeMin === 'number' ? body.rangeMin : old.rangeMin,
      rangeMax: typeof body?.rangeMax === 'number' ? body.rangeMax : old.rangeMax,
      noDataMinutes: typeof body?.noDataMinutes === 'number' ? body.noDataMinutes : old.noDataMinutes,
      timestampColumn: typeof body?.timestampColumn === 'string' ? body.timestampColumn : old.timestampColumn,
    });
    // Rename → drop the orphan ARM rule left behind under the old name.
    let renamedFrom: string | undefined;
    if (rec.azureRuleName !== old.azureRuleName) {
      renamedFrom = old.azureRuleName;
      try { await deleteMonitorActivatorRule(old.azureRuleName); } catch { /* best-effort */ }
    }
    // Preserve a paused rule's state — an edit must not surprise-re-enable it.
    // Unscheduled ADX rules have no ARM rule to PATCH; the persisted flag alone
    // carries their paused state.
    if (old.state === 'Disabled') {
      if (!isOnDemandAdxRule(rec)) {
        try { await disableMonitorRule(rec.azureRuleName); } catch { /* best-effort */ }
      }
      rec.state = 'Disabled';
    }
    // Keep the original creation time; stamp the edit.
    rec.createdAt = old.createdAt || rec.createdAt;
    rec.updatedAt = new Date().toISOString();
    const nextRules = rules.map((r) => (r.id === old.id ? rec : r));
    const items = await itemsContainer();
    // A rename deletes the ARM rule under the OLD name — tombstone it (and lift
    // the new name's tombstone) so a later reconcile cannot resurrect the orphan.
    const rulesDeleted = withoutTombstone({ rulesDeleted: withTombstone(item.state, renamedFrom) }, rec.azureRuleName);
    const next: WorkspaceItem = {
      ...item,
      state: { ...(item.state || {}), rules: nextRules, ...tombstoneField(rulesDeleted, tombstonesOf(item)) },
      updatedAt: new Date().toISOString(),
    };
    await items.item(item.id, item.workspaceId).replace(next);
    return NextResponse.json({ ok: true, rule: rec, backend: 'azure-monitor' });
  } catch (e: any) {
    return kustoGate(e) || monitorGate(e, monitorGateBodies) || NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
