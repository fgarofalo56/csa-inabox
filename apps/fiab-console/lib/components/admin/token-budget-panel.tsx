'use client';

/**
 * TokenBudgetPanel — the "Budgets" tab of /admin/copilot-quality (N13).
 *
 * Renders the REAL per-workspace / per-agent token attribution from
 * GET /api/admin/copilot-quality/budgets (Cosmos `loom-token-budgets` usage rows
 * written by the aoai-chat-client hot path on every attributed AOAI turn),
 * joined with each scope's configured budget and its live verdict — plus the
 * audited budget CRUD.
 *
 * Enforcement itself is NOT here: it happens in the hot path, immediately after
 * the E6 tier router picks the deployment and immediately before the AOAI fetch,
 * where an exhausted budget produces an honest 429-class refusal carrying this
 * page as its Fix-it. This surface is the control plane for that.
 *
 * States mirror the sibling tabs: Skeleton, guided EmptyState, FLAG0 kill-switch
 * notice (n13-token-budgets), clean first-open. Fluent v9 + Loom tokens only;
 * badge rows wrap (flexWrap + minWidth:0) so nothing overlaps at narrow widths.
 * Azure-native, no Fabric/Power BI dependency.
 */
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Badge, Body1, Button, Caption1, Dialog, DialogSurface, DialogTitle, DialogBody,
  DialogContent, DialogActions, Dropdown, Field, Input, Link as FluentLink, MessageBar,
  MessageBarBody, MessageBarTitle, Option, ProgressBar, Skeleton, SkeletonItem, Spinner,
  Subtitle2, Switch, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow,
  Text, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync20Regular, Delete20Regular, Money24Regular, Warning20Regular,
  CheckmarkCircle20Regular, DataUsage24Regular,
} from '@fluentui/react-icons';
import NextLink from 'next/link';
import { clientFetch, describeNonJsonResponse } from '@/lib/client-fetch';
import { EmptyState } from '@/lib/components/empty-state';
import { LoomChart } from '@/lib/components/charts/loom-chart';

type BudgetScope = 'workspace' | 'agent';
type BudgetPeriod = 'daily' | 'monthly';

interface BudgetDoc {
  scope: BudgetScope;
  scopeId: string;
  label?: string;
  period: BudgetPeriod;
  limitTokens: number;
  limitUsd?: number | null;
  warnAt?: number;
  enabled: boolean;
  updatedAt: string;
  updatedBy?: string;
}

interface UsageDoc {
  scope: BudgetScope;
  scopeId: string;
  period: BudgetPeriod;
  periodKey: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usd: number;
  tierUsd: number;
  turns: number;
  byTier: Record<string, { tokens: number; usd: number; turns: number } | undefined>;
  updatedAt: string;
}

interface Verdict {
  over: boolean;
  warning: boolean;
  usedTokens: number;
  limitTokens: number;
  remainingTokens: number;
  pctUsed: number;
  usedUsd: number;
  period: BudgetPeriod;
  periodKey: string;
  resetsAt: string;
}

interface DashboardRow {
  scope: BudgetScope;
  scopeId: string;
  label?: string;
  budget: BudgetDoc | null;
  usage: UsageDoc | null;
  verdict: Verdict | null;
}

interface BudgetsResponse {
  ok: boolean;
  flagEnabled: boolean;
  rows: DashboardRow[];
  totals: { tokens: number; usd: number; turns: number; over: number; warning: number };
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', minWidth: 0 },
  overview: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: tokens.spacingHorizontalM },
  tile: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
  },
  tileLabel: { fontSize: tokens.fontSizeBase100, textTransform: 'uppercase', letterSpacing: '0.06em', color: tokens.colorNeutralForeground3, fontWeight: tokens.fontWeightSemibold },
  tileValue: { fontSize: tokens.fontSizeBase500, fontWeight: tokens.fontWeightBold, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4, transition: 'box-shadow 0.15s ease', ':hover': { boxShadow: tokens.shadow16 },
  },
  sectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  badges: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0, alignItems: 'center' },
  muted: { color: tokens.colorNeutralForeground3 },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  wide: { maxWidth: '760px', width: '92vw' },
  scroll: { overflowX: 'auto', minWidth: 0 },
  num: { fontVariantNumeric: 'tabular-nums' },
});

const fmt = (n: number): string => n.toLocaleString();
const usd = (n: number): string => `$${n.toFixed(n < 1 ? 4 : 2)}`;

export function TokenBudgetPanel() {
  const styles = useStyles();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<DashboardRow | 'new' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const q = useQuery<BudgetsResponse>({
    queryKey: ['llmops-budgets'],
    queryFn: async () => {
      const r = await clientFetch('/api/admin/copilot-quality/budgets');
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || `load failed (${r.status})`);
      return j as BudgetsResponse;
    },
  });

  const remove = useMutation({
    mutationFn: async (row: DashboardRow) => {
      const r = await clientFetch(
        `/api/admin/copilot-quality/budgets?scope=${encodeURIComponent(row.scope)}&scopeId=${encodeURIComponent(row.scopeId)}`,
        { method: 'DELETE' },
      );
      const j = await r.json().catch(() => null);
      if (!j?.ok) throw new Error(j?.error || `delete failed (${r.status})`);
      return j;
    },
    onSuccess: (j) => { setError(null); setNote(String(j?.note || 'Budget removed.')); qc.invalidateQueries({ queryKey: ['llmops-budgets'] }); },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  if (q.isLoading) {
    return (
      <Skeleton aria-label="Loading token budgets">
        <div className={styles.overview} style={{ marginBottom: tokens.spacingVerticalL }}>
          {[0, 1, 2, 3].map((i) => <SkeletonItem key={i} style={{ height: '76px', borderRadius: tokens.borderRadiusLarge }} />)}
        </div>
        <SkeletonItem style={{ height: '220px', borderRadius: tokens.borderRadiusLarge }} />
      </Skeleton>
    );
  }
  if (q.isError) {
    return (
      <MessageBar intent="error"><MessageBarBody>
        <MessageBarTitle>Could not load token budgets</MessageBarTitle>{(q.error as Error)?.message}
      </MessageBarBody></MessageBar>
    );
  }

  const data = q.data!;

  // FLAG0 kill-switch — OFF stops enforcement AND attribution; the tab says so.
  if (data.flagEnabled === false) {
    return (
      <MessageBar intent="info" layout="multiline"><MessageBarBody>
        <MessageBarTitle>Token budgets are turned off</MessageBarTitle>
        The <code>n13-token-budgets</code> runtime flag is currently OFF, so no turn is enforced and no spend is
        attributed. Configured budgets and the accumulated usage ledger are retained untouched. Re-enable it under{' '}
        <NextLink href="/admin/runtime-flags" legacyBehavior><FluentLink>Runtime flags</FluentLink></NextLink>.
      </MessageBarBody></MessageBar>
    );
  }

  const tierRows = data.rows.reduce<Record<string, number>>((acc, r) => {
    for (const [tier, v] of Object.entries(r.usage?.byTier ?? {})) {
      if (v) acc[tier] = (acc[tier] ?? 0) + v.tokens;
    }
    return acc;
  }, {});

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <div className={styles.badges}>
          <Money24Regular />
          <Subtitle2>Token budgets &amp; attribution</Subtitle2>
          <Caption1 className={styles.muted}>real AOAI usage per workspace &amp; agent · enforced in the chat hot path</Caption1>
        </div>
        <div className={styles.badges}>
          <Button appearance="secondary" icon={<ArrowSync20Regular />} onClick={() => q.refetch()} disabled={q.isFetching}>Refresh</Button>
          <Button appearance="primary" icon={<Add20Regular />} onClick={() => { setNote(null); setError(null); setEditing('new'); }}>New budget</Button>
        </div>
      </div>

      {error && <MessageBar intent="warning" layout="multiline"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      {note && <MessageBar intent="success"><MessageBarBody>{note}</MessageBarBody></MessageBar>}
      {data.totals.over > 0 && (
        <MessageBar intent="error" layout="multiline"><MessageBarBody>
          <MessageBarTitle>{data.totals.over} scope(s) are over budget</MessageBarTitle>
          Their next Azure OpenAI turn is refused with an honest 429 (never a silent truncation). Raise or disable the
          budget below to release them — the change takes effect on the next turn, no revision roll.
        </MessageBarBody></MessageBar>
      )}

      <div className={styles.overview}>
        <div className={styles.tile}>
          <span className={styles.tileLabel}>Tokens this period</span>
          <span className={styles.tileValue}>{fmt(data.totals.tokens)}</span>
          <Caption1 className={styles.muted}>real AOAI usage</Caption1>
        </div>
        <div className={styles.tile}>
          <span className={styles.tileLabel}>Estimated spend</span>
          <span className={styles.tileValue}>{usd(data.totals.usd)}</span>
          <Caption1 className={styles.muted}>list price × real tokens</Caption1>
        </div>
        <div className={styles.tile}>
          <span className={styles.tileLabel}>Turns</span>
          <span className={styles.tileValue}>{fmt(data.totals.turns)}</span>
          <Caption1 className={styles.muted}>attributed chat calls</Caption1>
        </div>
        <div className={styles.tile}>
          <span className={styles.tileLabel}>Over / warning</span>
          <span className={styles.tileValue} style={{ color: data.totals.over ? tokens.colorPaletteRedForeground1 : undefined }}>
            {data.totals.over} / {data.totals.warning}
          </span>
          <Caption1 className={styles.muted}>scopes at or near the cap</Caption1>
        </div>
      </div>

      {data.rows.length === 0 ? (
        <EmptyState
          icon={<DataUsage24Regular />}
          title="No attributed spend or budgets yet"
          body={
            'Every Azure OpenAI turn that carries a workspace or agent attribution is metered here — real token ' +
            'counts from the model response, priced with the same table the usage dashboard uses. Once spend ' +
            'appears you can set a per-period cap; an exhausted cap refuses the next turn with an honest message ' +
            'and a link back to this tab, never a truncated prompt.'
          }
          primaryAction={{ label: 'New budget', onClick: () => setEditing('new') }}
          secondaryAction={{ label: 'Runtime flags', href: '/admin/runtime-flags' }}
        />
      ) : (
        <>
          <div className={styles.card}>
            <div className={styles.sectionHead}><DataUsage24Regular /><Subtitle2>Attribution</Subtitle2></div>
            <Caption1 className={styles.muted}>
              Real accumulated spend for the current period. Scopes without a budget appear too — set the first cap
              from evidence, not a guess.
            </Caption1>
            <div className={styles.scroll}>
              <Table size="small" aria-label="Token attribution by scope">
                <TableHeader><TableRow>
                  <TableHeaderCell>Scope</TableHeaderCell>
                  <TableHeaderCell>Tokens</TableHeaderCell>
                  <TableHeaderCell>Est. spend</TableHeaderCell>
                  <TableHeaderCell>Budget</TableHeaderCell>
                  <TableHeaderCell>Actions</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {data.rows.map((r) => (
                    <TableRow key={`${r.scope}:${r.scopeId}`}>
                      <TableCell>
                        <div className={styles.badges}>
                          <Badge appearance="tint" size="small" color={r.scope === 'workspace' ? 'brand' : 'informative'}>{r.scope}</Badge>
                          <Text truncate wrap={false} style={{ maxWidth: '220px', display: 'block' }}>{r.label || r.scopeId}</Text>
                        </div>
                        <Caption1 className={styles.muted}>{r.usage ? `${fmt(r.usage.turns)} turns · ${r.usage.periodKey}` : 'no spend yet'}</Caption1>
                      </TableCell>
                      <TableCell className={styles.num}>{fmt(r.usage?.totalTokens ?? 0)}</TableCell>
                      <TableCell className={styles.num}>{usd(r.usage?.usd ?? 0)}</TableCell>
                      <TableCell>
                        {r.verdict ? (
                          <>
                            <ProgressBar
                              value={Math.min(1, r.verdict.pctUsed)}
                              color={r.verdict.over ? 'error' : r.verdict.warning ? 'warning' : 'brand'}
                              thickness="large"
                            />
                            <div className={styles.badges}>
                              <Caption1 className={styles.num}>
                                {fmt(r.verdict.usedTokens)} / {fmt(r.verdict.limitTokens)} ({Math.round(r.verdict.pctUsed * 100)}%)
                              </Caption1>
                              {r.verdict.over
                                ? <Badge appearance="tint" color="danger" size="small" icon={<Warning20Regular />}>over</Badge>
                                : r.verdict.warning
                                  ? <Badge appearance="tint" color="warning" size="small">near cap</Badge>
                                  : <Badge appearance="tint" color="success" size="small" icon={<CheckmarkCircle20Regular />}>ok</Badge>}
                              {r.budget && !r.budget.enabled && <Badge appearance="outline" size="small">disabled</Badge>}
                            </div>
                            <Caption1 className={styles.muted}>resets {new Date(r.verdict.resetsAt).toLocaleString()}</Caption1>
                          </>
                        ) : (
                          <Caption1 className={styles.muted}>no budget (unlimited)</Caption1>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className={styles.badges}>
                          <Button size="small" appearance="secondary" onClick={() => { setNote(null); setError(null); setEditing(r); }}>
                            {r.budget ? 'Edit' : 'Set budget'}
                          </Button>
                          {r.budget && (
                            <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={remove.isPending}
                              onClick={() => remove.mutate(r)}>Remove</Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>

          {Object.keys(tierRows).length > 0 && (
            <div className={styles.card}>
              <div className={styles.sectionHead}><Money24Regular /><Subtitle2>Tokens by model tier</Subtitle2></div>
              <Caption1 className={styles.muted}>
                Which routing tier the spend rode — the same mini / standard / strong tiers the Tier routing tab scores.
              </Caption1>
              <LoomChart type="bar" height={160}
                rows={Object.entries(tierRows).map(([tier, t]) => ({ Tier: tier, Tokens: t }))} />
            </div>
          )}
          <Body1 className={styles.muted}>
            Token counts are the real Azure OpenAI <code>usage</code> from each response; the $ figures are the
            published list price applied to those counts, so they are estimates, not billed amounts.
          </Body1>
        </>
      )}

      {editing && (
        <BudgetDialog
          row={editing === 'new' ? null : editing}
          // #3742 — the agents the attribution ledger has actually seen. They
          // are already in `rows`; the dialog unions them with the Foundry
          // registry so an agent that has not spent yet is still budgetable.
          knownAgents={data.rows
            .filter((r) => r.scope === 'agent')
            .map((r) => ({ id: r.scopeId, label: r.label || r.scopeId }))}
          onClose={() => setEditing(null)}
          onDone={(msg) => { setNote(msg); setError(null); qc.invalidateQueries({ queryKey: ['llmops-budgets'] }); }}
          onError={(msg) => setError(msg)}
        />
      )}
    </div>
  );
}

interface ScopeOption { id: string; label: string }

/**
 * The picker's escape hatch. A sentinel rather than a second control, so the
 * "type it" path is DISCOVERABLE inside the list the operator is already
 * looking at. The value is not a legal scope id (`saveBudget` trims and stores
 * whatever it is given), so it is intercepted before `scopeId` is ever set.
 */
const TYPE_ID_SENTINEL = '__loom_enter_id__';
const TYPE_ID_SENTINEL_LABEL = 'Enter an id…';

/**
 * What a scope-population read ACTUALLY established (deploy-integrity.md R7).
 *
 * The three states are NOT interchangeable and the picker's copy differs for
 * each, because "there are none" and "I could not find out" are different
 * sentences:
 *
 *   `unread`     — the population was never established. An empty `options` here
 *                  means NOTHING about the tenant. Claiming absence over it is
 *                  the R7 violation this type exists to make unrepresentable.
 *   `incomplete` — the read succeeded but the route itself says the list is not
 *                  the whole truth (`degraded`, `legacyUnstampedExcluded`,
 *                  `legacyCountUnavailable`). Options are real; absence is not
 *                  claimable and a short list must not read as complete.
 *   neither      — the read succeeded and is authoritative. An empty `options`
 *                  is a genuine, claimable absence.
 */
interface ScopeSource {
  options: ScopeOption[];
  unread?: string;
  incomplete?: string;
}

const EMPTY_SOURCE: ScopeSource = { options: [] };

/**
 * Read a BFF response ONCE and classify it, without ever letting a failure
 * decay into an empty list.
 *
 * `clientFetch` resolves on a non-2xx (it is a thin `fetch` wrapper — only a
 * timeout/abort rejects), so `!r.ok` is invisible to react-query's `isError`.
 * This is the exact narrow bypass the header of
 * `__tests__/l5a-confident-state-honesty.test.tsx` documents for #3739: a
 * failure test written against `q.isError` passes while the surface still
 * renders a confident empty state. So the verdict is carried in the RESOLVED
 * value, where the failure actually is.
 *
 * `reason` is preferred over `error` when present: `/api/admin/workspaces`
 * answers a non-admin with `error:'forbidden'` (which tells the operator
 * nothing) plus a `reason` carrying the actual remediation. A body that is not
 * JSON is never echoed — `describeNonJsonResponse` states only what the status
 * establishes.
 */
async function readScopeResponse(
  r: Response,
  service: string,
): Promise<{ body: Record<string, unknown> } | { failure: string }> {
  let raw = '';
  try { raw = await r.text(); } catch { /* body unreadable — treated as non-JSON */ }
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  const o = (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : null;
  if (!r.ok || o?.ok === false) {
    const reason = [o?.reason, o?.error, o?.message]
      .find((v) => typeof v === 'string' && v.trim()) as string | undefined;
    return { failure: reason ? `${reason} (HTTP ${r.status})` : describeNonJsonResponse(r.status, service) };
  }
  if (!o) return { failure: describeNonJsonResponse(r.status, service) };
  return { body: o };
}

function BudgetDialog({
  row, knownAgents, onClose, onDone, onError,
}: { row: DashboardRow | null; knownAgents: ScopeOption[]; onClose: () => void; onDone: (msg: string) => void; onError: (msg: string) => void }) {
  const styles = useStyles();
  const [scope, setScope] = useState<BudgetScope>(row?.scope ?? 'workspace');
  const [scopeId, setScopeId] = useState(row?.scopeId ?? '');
  const [label, setLabel] = useState(row?.label ?? row?.budget?.label ?? '');
  const [period, setPeriod] = useState<BudgetPeriod>(row?.budget?.period ?? 'monthly');
  const [limitTokens, setLimitTokens] = useState(String(row?.budget?.limitTokens ?? 1_000_000));
  const [enabled, setEnabled] = useState(row?.budget?.enabled ?? true);

  /**
   * #3742 — "Scope id" was a bare <Input>. Creating a budget meant hand-typing
   * a workspace GUID from memory; one wrong character produced a budget that is
   * saved, enabled, listed as active and can NEVER match a usage row, because
   * enforcement joins on the exact scope id. It fails silently and looks fine.
   * Per loom-no-freeform-config and auto-bind-by-default §"no user-performed
   * plumbing", the platform knows these ids and now offers them.
   *
   * The route is the ADMIN inventory, not `/api/workspaces`. This dialog only
   * ever renders behind `requireTenantAdmin` (admin → Copilot quality), and
   * `/api/workspaces` answers `listAccessibleWorkspaces()`, which returns the
   * caller's OWN workspaces (partition-keyed on their oid) plus the ones they
   * hold a direct, non-group workspace-role assignment on — and nothing else.
   *
   * CORRECTED (review): an earlier draft of this note blamed `LOOM_MULTIUSER_ACL`
   * being unset. That was the wrong reason — `multiUserAclEnabled()` DEFAULTS TO
   * `'on'` (lib/auth/workspace-access.ts:100). The flag is not the cause, and
   * turning it on does not fix this: `listAccessibleWorkspaces` has no
   * tenant-admin branch at ANY flag setting. So a tenant admin budgeting a
   * workspace they neither own nor are assigned to found it simply absent from
   * the list, with "no workspace is available" over a tenant that has plenty.
   */
  const wsQ = useQuery({
    queryKey: ['budget-scope-workspaces'],
    queryFn: async (): Promise<ScopeSource> => {
      const r = await clientFetch('/api/admin/workspaces');
      const read = await readScopeResponse(r, 'The tenant workspace inventory');
      // R7 — a 403/500/non-JSON is NOT "no workspace is available". The route's
      // failure is first-class and by design: a non-admin gets a structured 403
      // (`code:'admin_only'`, `gateId:'bootstrap-admin'`) whose `reason` names
      // the remediation, and which the FIRST cut of this query discarded into an
      // empty array. Report it as unread; the picker will say so instead of
      // asserting an absence over a tenant it never looked at.
      if ('failure' in read) return { options: [], unread: read.failure };
      const d = read.body;
      const raw = Array.isArray(d) ? d : ((d as { workspaces?: unknown[] })?.workspaces || []);
      const options = (raw as Record<string, string>[])
        // `/api/admin/workspaces` returns `{ workspaces: WorkspaceAdminRecord[] }`,
        // whose display field is `name` (lib/clients/workspaces-client.ts) — so
        // `w.name` is the operand that actually runs here, and `w.id` is the
        // tail for a nameless doc. `displayName` is a defensive alias only:
        // neither route emits it today, so a test fixture that supplies it
        // exercises none of the live path and would let `w.name` be deleted
        // with every assertion green.
        .map((w) => ({ id: w.id, label: w.displayName || w.name || w.id }))
        .filter((w) => !!w.id);
      // The route emits these three fields precisely so a SHORT list is not
      // presented as the truth (#3826, rel-T108, #4316). Discarding them and
      // rendering the remainder as the tenant inventory is the same R7 error in
      // a quieter form, so each one is carried through in the route's own words.
      const caveats: string[] = [];
      if (d.degraded) {
        const why = Array.isArray(d.degradedReasons) ? d.degradedReasons.filter((x) => typeof x === 'string').join('; ') : '';
        caveats.push(`Enrichment fell back to defaults${why ? `: ${why}` : ''}.`);
      }
      if (typeof d.legacyUnstampedExcluded === 'number' && d.legacyUnstampedExcluded > 0) {
        caveats.push(`${d.legacyUnstampedExcluded} legacy workspace(s) are excluded from this list.`);
      }
      if (d.legacyCountUnavailable) {
        caveats.push('The number of excluded legacy workspaces could not be read, so it is unknown — not zero.');
      }
      if (caveats.length && typeof d.legacyRemediation === 'string' && d.legacyRemediation.trim()) {
        caveats.push(d.legacyRemediation.trim());
      }
      return { options, ...(caveats.length ? { incomplete: caveats.join(' ') } : {}) };
    },
    // Editing an existing budget cannot change its scope id, so do not spend a
    // round-trip resolving a list the dialog will render disabled.
    enabled: !row,
  });

  /**
   * #3742 AC — the agents worth budgeting are NOT only the ones that already
   * spent. `knownAgents` comes off the attribution dashboard, which is
   * "configured budgets ∪ scopes with spend" (lib/copilot/token-budget.ts
   * budgetDashboard) — so a newly registered agent is invisible until AFTER it
   * has burned tokens, which is exactly when a cap would have mattered. The
   * Foundry registry is the other half of the population.
   *
   * HONESTY NOTE (R7): this offers a Foundry agent by its registry NAME. Nothing
   * in this repo pins the ledger's `attribution.agentId` to that name — there is
   * no production writer of `agentId` today — so the field's hint says the id
   * must match what the ledger records and keeps the typed-id door open rather
   * than asserting an equivalence this code did not establish.
   */
  const agentQ = useQuery({
    queryKey: ['budget-scope-agents'],
    queryFn: async (): Promise<ScopeSource> => {
      const r = await clientFetch('/api/admin/agent-quality');
      const read = await readScopeResponse(r, 'The Foundry agent registry');
      if ('failure' in read) return { options: [], unread: read.failure };
      const agents = (read.body as { agents?: { configured?: boolean; list?: Array<{ name?: string }>; gate?: { code?: string; error?: string; hint?: string; missing?: string } } }).agents;
      // R7 — the route reports an UNREADABLE registry as HTTP 200 with
      // `agents.gate` set and `list: []` (app/api/admin/agent-quality/route.ts).
      // `!r.ok` never fires and react-query's `isError` stays false, so reading
      // only `agents.list` converts "Foundry answered 403" and "Foundry is not
      // configured" alike into "no agent is registered". Both are reported as
      // unread; only `configured` with no gate can claim absence.
      const gate = agents?.gate;
      if (gate?.code) {
        const detail = String(gate.error || '').trim();
        const unread = gate.code === 'not_configured'
          // Not an outage: Foundry simply is not wired in this deployment. Still
          // not absence — there is no registry to have been empty. The route
          // names the env var, so the copy can too.
          ? `Foundry is not configured in this deployment${gate.missing ? ` (${gate.missing} is unset)` : ''}, so its agent registry was not read.${gate.hint ? ` ${gate.hint}` : ''}`
          : `The Foundry agent registry could not be read${detail ? `: ${detail}` : '.'}`;
        return { options: [], unread };
      }
      const options = (agents?.list || [])
        .map((a) => ({ id: String(a?.name || '').trim(), label: String(a?.name || '').trim() }))
        .filter((a) => !!a.id);
      // `configured: false` with no gate is a shape the route does not emit
      // today. Rather than assume which side of the line it falls on, say so.
      return agents?.configured === false
        ? { options, unread: 'The Foundry agent registry reported itself unconfigured without saying why, so it was not read.' }
        : { options };
    },
    enabled: !row && scope === 'agent',
  });

  const agentOptions: ScopeOption[] = useMemo(() => {
    // Ledger-attributed first: it carries the friendlier label, and dedupe by
    // id keeps a registry row from shadowing it.
    const byId = new Map<string, ScopeOption>();
    for (const a of knownAgents) if (a.id) byId.set(a.id, a);
    for (const a of agentQ.data?.options ?? []) if (!byId.has(a.id)) byId.set(a.id, a);
    return [...byId.values()];
  }, [knownAgents, agentQ.data]);

  const source: ScopeSource = scope === 'workspace' ? (wsQ.data ?? EMPTY_SOURCE) : (agentQ.data ?? EMPTY_SOURCE);
  const options: ScopeOption[] = scope === 'workspace' ? source.options : agentOptions;
  const optionsLoading = scope === 'workspace' ? wsQ.isLoading : agentQ.isLoading;
  /**
   * TWO sources, and the RESOLVED one is primary — the narrow bypass (#3739).
   *
   * `clientFetch` RESOLVES on a non-2xx, and `/api/admin/agent-quality` reports
   * an unreadable registry as a 200 with `agents.gate.code:'error'`. In both of
   * those — the two shapes that actually occur in production — react-query's
   * `isError` is FALSE. So `source.unread`, computed from the resolved body, is
   * the primary verdict; keying this on `isError` alone was the defect, and it
   * left the "could not be read" copy below permanently unreachable.
   *
   * `isError` is still read, second, because it is the ONLY signal for what
   * genuinely rejects: a `clientFetch` timeout/abort never produces a body to
   * classify. Each query is named EXPLICITLY rather than through a
   * `scope === 'workspace' ? wsQ : agentQ` alias — an alias hides the reference
   * from `scripts/ci/check-editor-read-failure-honesty.mjs` rule 2, which
   * greps for `<queryVar>.isError`. That guard went red on the alias during
   * this fix, correctly: a reader auditing "does wsQ have an error branch?"
   * could not answer it either.
   */
  const rejected = (qq: { isError: boolean; error: unknown }, what: string): string | null =>
    (qq.isError ? ((qq.error as Error)?.message || `Could not list ${what}.`) : null);
  const optionsUnread: string | null = scope === 'workspace'
    ? (source.unread ?? rejected({ isError: wsQ.isError, error: wsQ.error }, 'workspaces'))
    : (source.unread ?? rejected({ isError: agentQ.isError, error: agentQ.error }, 'Foundry agents'));
  // Distinct from `unread`: the read WORKED and returned real options, but the
  // route says the list is not the whole inventory. Never suppresses options,
  // never claims absence — it only stops a short list from reading as complete.
  const optionsIncomplete: string | null = source.incomplete ?? null;
  // The honest fallback, exactly as EntraGroupPicker documents it: a picker that
  // cannot populate must not become a dead end (auto-bind-by-default forbids
  // "no items found" + a disabled control). Reached by BOTH a genuine absence
  // and an unread population — what differs is the sentence, below.
  const mustTypeId = !row && !optionsLoading && options.length === 0;
  // ...and a NON-empty list is not proof the id is in it. Neither half of the
  // agent union is authoritative, and the workspace inventory can come back
  // `degraded`. So the typed-id door stays reachable at all times, as an
  // explicit choice in the picker rather than a hidden fallback (#3742 AC3).
  const [typingId, setTypingId] = useState(false);
  const typeIdShown = mustTypeId || typingId;
  const selectedLabel = options.find((o) => o.id === scopeId)?.label ?? scopeId;

  const TYPE_IT = `Enter the ${scope} id directly — it must match the id the attribution ledger records, exactly.`;
  /**
   * FOUR states, and the difference between two of them is the whole point.
   *
   * An empty list reached by a FAILED read and an empty list reached by a
   * SUCCESSFUL read look identical to the renderer and mean opposite things.
   * "No agent is registered in Foundry or attributed any spend yet" is a
   * statement of fact about the tenant; over a 403 from the Foundry project, or
   * over a 403 from `/api/admin/workspaces`, it is a fabrication
   * (deploy-integrity.md R7). So the absence sentence is reachable ONLY when
   * `optionsUnread` is null — i.e. only when a read actually established it.
   */
  const scopeHint = mustTypeId
    ? (optionsUnread
      ? `${optionsUnread} ${TYPE_IT}`
      // `incomplete` over an EMPTY list is still not absence: the route said the
      // inventory it returned is partial, and a partial view of nothing is not
      // "there is nothing". Report the caveat instead of the claim.
      : optionsIncomplete
        ? `This list came back empty and the inventory reported itself incomplete, so no ${scope} could be established. ${optionsIncomplete} ${TYPE_IT}`
        : `No ${scope === 'workspace' ? 'workspace is available' : 'agent is registered in Foundry or attributed any spend yet'}. ${TYPE_IT}`)
    : typingId
      ? TYPE_IT
      : [
        scope === 'agent'
          // R7: name what the list IS. It is the union of the spend ledger and
          // the Foundry registry, and neither establishes the ledger's agent id
          // for an agent that has not spent yet — hence the escape hatch below.
          ? `Agents with attributed spend plus the agents registered in Foundry. Enforcement joins on the exact id the ledger records; pick “${TYPE_ID_SENTINEL_LABEL}” if the agent is known by another id.`
          : 'Enforcement joins on this exact id, so it is picked, never typed.',
        // A list that IS populated can still be partial — the other half of the
        // agent union failed, or the workspace route flagged itself degraded.
        // Say so on the list, not only on the empty state.
        optionsUnread ? `(${optionsUnread})` : '',
        optionsIncomplete ? `(This list may be incomplete. ${optionsIncomplete})` : '',
      ].filter(Boolean).join(' ');

  const save = useMutation({
    mutationFn: async () => {
      const r = await clientFetch('/api/admin/copilot-quality/budgets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, scopeId, label, period, limitTokens: Number(limitTokens), enabled }),
      });
      const j = await r.json().catch(() => null);
      if (!j?.ok) throw new Error(j?.error || `save failed (${r.status})`);
      return j;
    },
    onSuccess: (j) => { onDone(String(j?.note || 'Budget saved.')); onClose(); },
    onError: (e) => onError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface className={styles.wide}>
        <DialogBody>
          <DialogTitle>{row?.budget ? 'Edit budget' : 'New budget'}</DialogTitle>
          <DialogContent>
            <div className={styles.form}>
              <Field label="Scope" hint="A workspace budget caps everything spent in that workspace; an agent budget caps one agent across workspaces.">
                <Dropdown value={scope} selectedOptions={[scope]} disabled={!!row}
                  onOptionSelect={(_, d) => {
                    const next = String(d.optionValue) as BudgetScope;
                    // Switching scope invalidates the chosen id — a workspace id
                    // is never a valid agent id. Clearing it stops a budget from
                    // being saved against the other scope's identifier.
                    if (next !== scope) { setScope(next); setScopeId(''); setTypingId(false); }
                  }}>
                  <Option value="workspace">workspace</Option>
                  <Option value="agent">agent</Option>
                </Dropdown>
              </Field>
              <Field
                label={scope === 'workspace' ? 'Workspace' : 'Agent'}
                hint={scopeHint}
                validationState={optionsUnread || optionsIncomplete ? 'warning' : 'none'}
              >
                {typeIdShown || row ? (
                  <Input value={scopeId} disabled={!!row} onChange={(_, d) => setScopeId(d.value)} />
                ) : (
                  /* Kept MOUNTED across loading — a Dropdown swapped for a
                     Spinner is the shape that produced the click-dead pickers
                     in #3632/#3528. Loading is a placeholder + disabled state on
                     the control itself. */
                  <Dropdown
                    value={selectedLabel}
                    selectedOptions={scopeId ? [scopeId] : []}
                    disabled={optionsLoading}
                    placeholder={optionsLoading ? `Loading ${scope}s…` : `Select a ${scope}`}
                    onOptionSelect={(_, d) => {
                      const id = String(d.optionValue ?? '');
                      // The escape hatch is an OPTION, not a hidden fallback:
                      // a non-empty list is not proof the wanted id is in it.
                      if (id === TYPE_ID_SENTINEL) { setTypingId(true); setScopeId(''); return; }
                      setScopeId(id);
                      // Carry the friendly name across so the attribution table
                      // shows a name, not the raw id, for the new budget.
                      const picked = options.find((o) => o.id === id);
                      if (picked && !label.trim()) setLabel(picked.label);
                    }}
                  >
                    {options.map((o) => (
                      <Option key={o.id} value={o.id} text={o.label}>{o.label}</Option>
                    ))}
                    <Option key={TYPE_ID_SENTINEL} value={TYPE_ID_SENTINEL} text={TYPE_ID_SENTINEL_LABEL}>
                      {TYPE_ID_SENTINEL_LABEL}
                    </Option>
                  </Dropdown>
                )}
                {typingId && !mustTypeId && !row && (
                  <Button appearance="transparent" size="small" onClick={() => { setTypingId(false); setScopeId(''); }}>
                    Back to the list
                  </Button>
                )}
              </Field>
              <Field label="Label"><Input value={label} onChange={(_, d) => setLabel(d.value)} /></Field>
              <Field label="Period">
                <Dropdown value={period} selectedOptions={[period]} onOptionSelect={(_, d) => setPeriod(String(d.optionValue) as BudgetPeriod)}>
                  <Option value="monthly">monthly</Option>
                  <Option value="daily">daily</Option>
                </Dropdown>
              </Field>
              <Field label="Token limit per period" hint="Total tokens (prompt + completion). The turn that would cross this cap is refused with an honest 429.">
                <Input type="number" value={limitTokens} onChange={(_, d) => setLimitTokens(d.value)} />
              </Field>
              <Switch checked={enabled} onChange={(_, d) => setEnabled(!!d.checked)}
                label="Enforce this budget (off = tracked but never refuses a turn)" />
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" icon={save.isPending ? <Spinner size="tiny" /> : <Add20Regular />}
              disabled={!scopeId.trim() || !(Number(limitTokens) > 0) || save.isPending}
              onClick={() => save.mutate()}>Save</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
