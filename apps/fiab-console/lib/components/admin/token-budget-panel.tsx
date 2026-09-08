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
import { useState } from 'react';
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
import { clientFetch } from '@/lib/client-fetch';
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
          // #3742 — the agents the attribution ledger has ALREADY seen. They are
          // already in `rows`, so offering them costs no round-trip. This is
          // half the population: the dialog unions it with the Foundry agent
          // REGISTRY, because a budget's job is to cap an agent before it spends
          // and the ledger by construction only knows agents that already have.
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
 * The Dropdown value that means "none of these — let me type one". A sentinel
 * rather than an empty string: `''` is what a cleared Dropdown already reports,
 * so the two would be indistinguishable and a stray clear would silently drop
 * the operator into typed-id mode. The `__loom:` prefix cannot collide with a
 * workspace GUID or a Foundry agent name.
 */
const ENTER_ID_OPTION = '__loom:enter-id__';

/**
 * The message a FAILED scope-list read must carry.
 *
 * `error` alone is NOT it. Both routes behind these pickers answer a denial
 * with `error:'forbidden'` and put the actionable text in `reason` (and, for
 * `requireTenantAdmin`, `remediation`). `/api/admin/workspaces`'s 403 reason is
 * that the deployment shipped without a bootstrap-admin binding — a DEPLOY
 * defect the platform must fix (auto-bind-by-default §5), not something the
 * operator can act on from the word "forbidden".
 *
 * When the body carries neither, the STATUS is reported as the status. It is
 * never converted into a claim about what does or does not exist: a read that
 * failed established nothing about the estate (deploy-integrity R7).
 */
function listReadFailure(body: unknown, status: number, what: string): string {
  const b = (body ?? {}) as { error?: unknown; reason?: unknown; remediation?: unknown };
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const specific = [str(b.reason), str(b.remediation)].filter(Boolean).join(' ');
  if (specific) return specific;
  const generic = str(b.error);
  return generic
    ? `${what} read failed: ${generic} (HTTP ${status}).`
    : `${what} read failed (HTTP ${status}).`;
}

/**
 * The sentence a workspace inventory that DID NOT ESTABLISH ITS OWN CONTENT
 * must carry — or `null` when the response stands on its own.
 *
 * #4348 review, blocker 1. `ok:false` is only ONE of the two ways
 * `/api/admin/workspaces` declines to answer. The other is a 200 that is
 * explicitly self-degraded: `listAllWorkspacesAdmin` returns
 * `workspaces: []` + `degraded: true` + `degradedReasons:
 * ['tenant-scope-unconfirmed']` for a caller whose session carries no Entra
 * `tid` claim (a REFUSAL — "with no caller tenant there is no positive match to
 * make"), and it returns a deliberately SHORT list with
 * `legacyUnstampedExcluded` / `legacyCountUnavailable` on a legacy estate. Both
 * used to fall straight through as `raw = []` with `isError` false, so the Field
 * asserted "No workspace is available." — an absence the response itself says
 * was never established. That is the same deploy-integrity R7 shape the
 * `ok:false` fix closed, one encoding over.
 *
 * KEYED ON SHAPE, NOT ON A LIST OF REASON SPELLINGS, so a reason added later
 * still lands:
 *
 *  - an EMPTY list from a read that flagged itself degraded — whatever the
 *    reason — has established no absence, so the emptiness may not be reported
 *    as one;
 *  - a list the response says was TRIMMED (`legacyUnstampedExcluded > 0`) or
 *    whose exclusions could not even be COUNTED (`legacyCountUnavailable`) is
 *    disclosed whether or not it came back empty, because those rows are
 *    missing from a picker the operator will otherwise read as exhaustive.
 *
 * A non-empty list degraded only in its ENRICHMENT (`item-counts`,
 * `owner-roles`) is deliberately NOT flagged: those degrade fields this picker
 * does not use — it reads `id` and `name` only — and nagging about them would
 * be the "error is not an empty list" regression in the other direction.
 *
 * The route's OWN words are preferred verbatim when it sends them. The fallback
 * states only what the response established: that the read reported itself
 * degraded, and the reason codes it gave. It never names a cause.
 */
function inventoryNotEstablished(
  body: {
    degraded?: unknown;
    degradedReasons?: unknown;
    legacyUnstampedExcluded?: unknown;
    legacyCountUnavailable?: unknown;
    legacyRemediation?: unknown;
  },
  count: number,
): string | null {
  const trimmed = Number(body.legacyUnstampedExcluded) > 0 || body.legacyCountUnavailable === true;
  const emptyAndDegraded = count === 0 && body.degraded === true;
  if (!trimmed && !emptyAndDegraded) return null;
  const remediation = typeof body.legacyRemediation === 'string' ? body.legacyRemediation.trim() : '';
  if (remediation) return remediation;
  const reasons = (Array.isArray(body.degradedReasons) ? body.degradedReasons : [])
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter(Boolean);
  const why = reasons.length ? ` (${reasons.join(', ')})` : '';
  return count === 0
    ? `The tenant workspace inventory came back empty from a read that reported itself incomplete${why}, so no absence was established.`
    : `The tenant workspace inventory reported itself incomplete${why}, so this list may not be every workspace in the tenant.`;
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
   * #3742 round 2 — THE ADMIN ROUTE, NOT THE OWNER-SCOPED ONE. This dialog only
   * mounts on /admin/copilot-quality, which is already tenant-admin gated, and a
   * budget it writes is enforced tenant-wide. `/api/workspaces` resolves through
   * `listAccessibleWorkspaces`, which is OWNER-ONLY unless LOOM_MULTIUSER_ACL is
   * on (lib/auth/workspace-access.ts) — so on a real estate the admin was
   * offered only the workspaces they personally created and could not budget
   * anyone else's. `/api/admin/workspaces` → `listAllWorkspacesAdmin` is the
   * tenant-wide inventory the sibling /admin/workspaces page already renders,
   * and it enforces its own tenant-admin check plus a `tid` scope, so this is
   * not a widening: a non-admin reaching this code gets its 403 and falls to the
   * typed-id path below.
   */
  const wsQ = useQuery({
    queryKey: ['budget-scope-workspaces'],
    queryFn: async (): Promise<{ workspaces: ScopeOption[]; notEstablished: string | null }> => {
      const r = await clientFetch('/api/admin/workspaces');
      const d: unknown = await r.json();
      // #4348 review — A FAILED READ IS NOT AN EMPTY ESTATE. Repointing this at
      // the admin route made 403 (no bootstrap-admin binding) and 500
      // (apiServerError) REACHABLE, and both fell straight through the
      // `Array.isArray` line below as `raw = []`. `wsQ.isError` therefore stayed
      // false and the Field asserted "No workspace is available" — an absence
      // nothing had established (deploy-integrity R7) — while the route's own
      // `reason`, which names a deploy defect, was discarded. The sibling agent
      // query already checked this; the asymmetry WAS the bug.
      if ((d as { ok?: boolean } | null)?.ok === false) {
        throw new Error(listReadFailure(d, r.status, 'Workspace list'));
      }
      const body = (d ?? {}) as {
        workspaces?: unknown[];
        degraded?: unknown;
        degradedReasons?: unknown;
        legacyUnstampedExcluded?: unknown;
        legacyCountUnavailable?: unknown;
        legacyRemediation?: unknown;
      };
      const raw = Array.isArray(d) ? d : (body.workspaces || []);
      const workspaces = (raw as Record<string, string>[])
        // `/api/admin/workspaces` returns `WorkspaceAdminRecord[]`, whose display
        // field is `name` (lib/clients/workspaces-client.ts:45) — so `w.name` is
        // the operand that actually runs here, and `w.id` is the tail for a
        // nameless doc. `displayName` is a defensive alias only: this route does
        // not emit it today, so a test fixture that supplies it exercises none of
        // the live path and would let `w.name` be deleted with every assertion
        // green.
        .map((w) => ({ id: w.id, label: w.displayName || w.name || w.id }))
        .filter((w) => !!w.id);
      // #4348 review, blocker 1 — the SECOND refusal encoding. A 200 that says
      // `degraded:true` over an empty list, or that reports rows excluded, has
      // not established an absence; see `inventoryNotEstablished`.
      return { workspaces, notEstablished: inventoryNotEstablished(body, workspaces.length) };
    },
    // Editing an existing budget cannot change its scope id, so do not spend a
    // round-trip resolving a list the dialog will render disabled.
    enabled: !row,
  });

  /**
   * #3742 round 2 — THE AGENT REGISTRY, unioned with the ledger.
   *
   * `knownAgents` comes from `budgetDashboard()`, which is configured budgets ∪
   * scopes that have ALREADY SPENT in the current period. So the picker could
   * only offer an agent that had already burned tokens — and a budget's whole
   * purpose is to cap an agent BEFORE it spends. The Foundry agent registry
   * (`/api/admin/agent-quality` → `listAgents(projectId)`) is the set of agents
   * that exist.
   *
   * WHICH KEY THIS UNION IS ON, stated to the limit of what is established
   * (deploy-integrity R7 — an earlier draft of this comment claimed a live join
   * and #4348 review falsified both halves of it):
   *
   *  - `FoundryAgent.name` is the identity those deploy routes REPORT as
   *    `agentId` — `return NextResponse.json({ ok: true, agentId: agentName, … })`
   *    at items/data-agent/[id]/deploy/route.ts:130 and
   *    items/aip-logic/[id]/deploy/route.ts:129. It is a response field. What
   *    those routes PERSIST on the item is `foundryAgentId`; neither writes an
   *    `agentId` anywhere.
   *  - `scopesOf(attribution)` is the function that would charge spend against
   *    that key, and it is NOT REACHED FROM ANY PRODUCTION TURN today.
   *    `enforceTokenBudget` / `recordTurnSpend` are called only from
   *    lib/azure/aoai-chat-client.ts (:438, :470, :493, :524, :551, :605, :723),
   *    always via `resolveAttribution(opts.attribution)`; no production caller
   *    passes `attribution`, and the sole `withTokenAttribution` CALL in the repo
   *    is lib/copilot/__tests__/token-budget.test.ts:239. So `resolveAttribution`
   *    returns undefined and both functions early-return on `if (!attribution)`
   *    (lib/copilot/token-budget.ts:223, :267).
   *
   * That second point is a PRE-EXISTING defect of the token-budget subsystem —
   * it enforces nothing and charges nothing because nothing populates a
   * `TokenAttribution` — tracked as #4378, NOT introduced or fixed here. The
   * honest claim for this union is therefore: the registry name is the INTENDED
   * budget scope key and the one those routes report, so offering it is right;
   * it is not a join against a live spend ledger, because no such ledger is
   * being written.
   *
   * A NOT-CONFIGURED FOUNDRY IS NOT AN ERROR (deploy-integrity R7). That route
   * answers 200 with `agents.configured:false` and a `gate`; this reports the
   * registry as unavailable and keeps the ledger agents, rather than claiming
   * the read failed or that no agents exist.
   */
  const agentQ = useQuery({
    queryKey: ['budget-scope-agents'],
    queryFn: async (): Promise<{ agents: ScopeOption[]; gate: string | null }> => {
      const r = await clientFetch('/api/admin/agent-quality');
      const d = (await r.json()) as {
        ok?: boolean;
        error?: string;
        agents?: { configured?: boolean; list?: Array<{ name?: string; description?: string }>; gate?: { error?: string } };
      };
      if (d?.ok === false) throw new Error(listReadFailure(d, r.status, 'Agent registry'));
      const reg = d?.agents;
      const list = Array.isArray(reg?.list) ? reg.list : [];
      return {
        agents: list
          .map((a) => ({ id: (a?.name || '').trim(), label: (a?.name || '').trim() }))
          .filter((a) => !!a.id),
        gate: reg?.configured === false ? (reg?.gate?.error || 'The Foundry agent registry is not configured.') : null,
      };
    },
    // #4348 review, nit 4 — THE PREFETCH IS DELIBERATE, and the narrowing was
    // MEASURED AND REVERTED. `enabled: !row && scope === 'agent'` looks strictly
    // better (it saves a Foundry Agent Service REST call plus the red-team and
    // SLO reads on the `workspace` scope this dialog opens in), but the Agent
    // Dropdown is `disabled={optionsLoading}` and `optionsLoading` IS
    // `agentQ.isLoading` on this scope (see `optionsLoading` below and the
    // Dropdown's `disabled` prop) — so deferring the read to the moment the
    // operator picks `agent` makes the picker click-dead for the whole Foundry
    // round-trip, with the LEDGER agents already in hand behind it. That is the
    // #3632/#3528 click-dead-picker shape this file's Dropdown comment below
    // exists to prevent.
    //
    // Measured, not argued — I applied the narrowing and re-ran this spec:
    // "a failed AGENT-REGISTRY read keeps the ledger agents pickable" and the
    // new dedup arm both went RED ("Unable to find role=option and name
    // 'SQL helper'"), 2 failed / 7 passed, rc=1; reverting restored 9/9. The
    // read is prefetched so the list is populated before the scope can be
    // switched to it. If the extra Foundry call is ever worth removing, the
    // move is to make the Dropdown usable while it loads, not to defer it.
    enabled: !row,
  });

  /**
   * Registry ∪ ledger, deduped by id, ledger label preferred (it carries the
   * friendly `label` the attribution table already shows). Order: registry
   * first, then any ledger-only agent, so an agent that exists but has not spent
   * is reachable rather than buried.
   */
  const agentOptions: ScopeOption[] = (() => {
    const byId = new Map<string, ScopeOption>();
    for (const a of agentQ.data?.agents ?? []) byId.set(a.id, a);
    for (const a of knownAgents) if (a.id) byId.set(a.id, a);
    return [...byId.values()];
  })();

  const options: ScopeOption[] = scope === 'workspace' ? (wsQ.data?.workspaces ?? []) : agentOptions;
  const optionsLoading = scope === 'workspace' ? wsQ.isLoading : agentQ.isLoading;
  const optionsError = scope === 'workspace'
    ? (wsQ.isError ? ((wsQ.error as Error)?.message || 'Could not list workspaces.') : null)
    : (agentQ.isError ? ((agentQ.error as Error)?.message || 'Could not list agents.') : null);
  /**
   * WHAT THE LIST ITSELF SAID ABOUT ITS OWN COMPLETENESS — non-blocking, and
   * symmetric across the two scopes. For `agent` it is the Foundry registry gate
   * (the list is ledger-only, which is not an error). For `workspace` it is the
   * 200-but-self-degraded case `inventoryNotEstablished` decodes: a tid-less
   * refusal, or an inventory the route says it trimmed.
   *
   * #4348 review, blocker 1 — the workspace half of this did not exist, which is
   * why a refusal rendered as "No workspace is available". The two queries are
   * now the same shape, and the asymmetry that produced BOTH rounds of this
   * defect is gone.
   */
  const scopeNotice: string | null = scope === 'workspace'
    ? (!wsQ.isError ? (wsQ.data?.notEstablished ?? null) : null)
    : (!agentQ.isError ? (agentQ.data?.gate ?? null) : null);
  // The honest fallback, exactly as EntraGroupPicker documents it: a picker that
  // cannot populate must not become a dead end (auto-bind-by-default forbids
  // "no items found" + a disabled control).
  //
  // #4348 review — AN ERROR IS NOT AN EMPTY LIST, and ORing the two here was a
  // regression this PR introduced. `agentOptions` is the registry UNIONED with
  // the attribution ledger, so a failed registry read leaves the ledger agents
  // loaded and correct; ORing `optionsError` in replaced that populated picker
  // with a bare <Input>, and the "Pick from the list instead" escape is gated on
  // `typedIdMode`, so the rows that HAD loaded were unreachable without closing
  // the dialog. The failure is still disclosed — it rides `optionsError` into
  // the hint below — but it no longer suppresses data that is on hand.
  const listUnavailable = !row && !optionsLoading && options.length === 0;
  /**
   * #3742 round 2 — A TYPED ID STAYS REACHABLE WHEN THE LIST IS NON-EMPTY.
   * The previous revision rendered the <Input> ONLY when the list was entirely
   * empty, so with one attributed agent an admin could neither pick nor type an
   * agent the ledger had not seen — a budget capping a newly configured agent
   * before it spends became impossible, which is the same dead end this fix
   * exists to remove. The list is still the DEFAULT path; "Enter an id…" is an
   * explicit option on it, so nothing is typed by accident.
   */
  const [typedIdMode, setTypedIdMode] = useState(false);
  const mustTypeId = listUnavailable || typedIdMode;
  const selectedLabel = options.find((o) => o.id === scopeId)?.label ?? scopeId;

  /**
   * #4348 review — THE HINT, RESOLVED AS ORDERED STATES rather than a nested
   * ternary.
   *
   * As a ternary the registry-gate arm sat BELOW `listUnavailable`, so it was
   * unreachable in the exact state it was written for: an unconfigured Foundry
   * with nothing in the ledger yet has zero options, `listUnavailable` won, and
   * the Field said "No agent is registered or has been attributed any spend
   * yet" — contradicting the gate the SAME response carried. That is the
   * cloud-parity case (`cloud-parity.md`): a boundary with no Foundry agent
   * service must read as a registry that is unavailable, never as an estate
   * that has no agents.
   *
   * Order is by what the operator must know first — a real failure, then a
   * gate or an admitted-incomplete list, then their own choice to type, then a
   * genuine emptiness — and BOTH absence sentences are now reachable ONLY when
   * nothing failed and nothing is gated, which is the only state that
   * establishes them. The instruction suffix follows whichever CONTROL is
   * actually on screen, so it never tells the operator to type while a Dropdown
   * is rendered.
   */
  const idHint: string = (() => {
    const noun = scope === 'workspace' ? 'workspace' : 'agent';
    const exact = 'it must match the id the attribution ledger records, exactly.';
    const howToProceed = mustTypeId
      ? `Enter the ${noun} id directly — ${exact}`
      : `The ${noun}s that did load are listed; pick "Enter an id…" for any other — ${exact}`;
    if (optionsError) return `${optionsError} ${howToProceed}`;
    if (scopeNotice) return `${scopeNotice} ${howToProceed}`;
    if (typedIdMode) return `Entering the ${noun} id by hand — ${exact}`;
    if (listUnavailable) {
      const absence = noun === 'workspace'
        ? 'No workspace is available'
        : 'No agent is registered or has been attributed any spend yet';
      return `${absence}. ${howToProceed}`;
    }
    return 'Enforcement joins on this exact id, so it is picked, never typed.';
  })();

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
                    // being saved against the other scope's identifier. The
                    // typed-id mode is reset too: the other scope has its own
                    // list, and it may well be populated.
                    if (next !== scope) { setScope(next); setScopeId(''); setTypedIdMode(false); }
                  }}>
                  <Option value="workspace">workspace</Option>
                  <Option value="agent">agent</Option>
                </Dropdown>
              </Field>
              <Field
                label={scope === 'workspace' ? 'Workspace' : 'Agent'}
                hint={idHint}
                validationState={optionsError ? 'warning' : 'none'}
              >
                {mustTypeId || row ? (
                  <>
                    <Input value={scopeId} disabled={!!row} onChange={(_, d) => setScopeId(d.value)} />
                    {typedIdMode && !row && (
                      // A one-way door back into a typed id is the same dead end
                      // in the other direction, so the list stays one click away.
                      <Button
                        appearance="transparent"
                        onClick={() => { setTypedIdMode(false); setScopeId(''); }}
                      >
                        Pick from the list instead
                      </Button>
                    )}
                  </>
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
                      if (id === ENTER_ID_OPTION) {
                        // Not a scope id — the explicit escape hatch. Clear any
                        // previously picked id so a half-typed value can never
                        // be saved against a stale selection.
                        setTypedIdMode(true);
                        setScopeId('');
                        return;
                      }
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
                    <Option key={ENTER_ID_OPTION} value={ENTER_ID_OPTION} text="Enter an id…">
                      Enter an id…
                    </Option>
                  </Dropdown>
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
