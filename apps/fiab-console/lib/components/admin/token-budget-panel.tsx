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
          onClose={() => setEditing(null)}
          onDone={(msg) => { setNote(msg); setError(null); qc.invalidateQueries({ queryKey: ['llmops-budgets'] }); }}
          onError={(msg) => setError(msg)}
        />
      )}
    </div>
  );
}

function BudgetDialog({
  row, onClose, onDone, onError,
}: { row: DashboardRow | null; onClose: () => void; onDone: (msg: string) => void; onError: (msg: string) => void }) {
  const styles = useStyles();
  const [scope, setScope] = useState<BudgetScope>(row?.scope ?? 'workspace');
  const [scopeId, setScopeId] = useState(row?.scopeId ?? '');
  const [label, setLabel] = useState(row?.label ?? row?.budget?.label ?? '');
  const [period, setPeriod] = useState<BudgetPeriod>(row?.budget?.period ?? 'monthly');
  const [limitTokens, setLimitTokens] = useState(String(row?.budget?.limitTokens ?? 1_000_000));
  const [enabled, setEnabled] = useState(row?.budget?.enabled ?? true);

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
                  onOptionSelect={(_, d) => setScope(String(d.optionValue) as BudgetScope)}>
                  <Option value="workspace">workspace</Option>
                  <Option value="agent">agent</Option>
                </Dropdown>
              </Field>
              <Field label="Scope id">
                <Input value={scopeId} disabled={!!row} onChange={(_, d) => setScopeId(d.value)} />
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
