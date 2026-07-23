'use client';

/**
 * VerifiedQueriesPane — the semantic-model editor's "Verified Queries" tab (N9).
 *
 * Authors the GOVERNED SEMANTIC CONTRACT for the owner's data agents:
 *   • a METRIC REGISTRY (owner / description / synonyms / grain / source), and
 *   • a VERIFIED QUERY REPOSITORY (VQR) — approved question→query pairs the
 *     data-agent-reasoning loop retrieves FIRST, refusing out-of-contract
 *     questions instead of guessing.
 *
 * Every control calls the real BFF (`/api/items/semantic-model/[id]/
 * verified-queries`) which persists to the `loom-semantic-contract` Cosmos
 * container; approval is AUDITED. Fluent v9 + Loom tokens only (no raw px/hex),
 * guided empty state, FLAG0-gated (`n9-verified-queries-tab`, default-ON). No
 * Power BI / Microsoft Fabric dependency.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Caption1, Body1, Badge, Button, Spinner, Field, Input, Textarea,
  Dropdown, Option, Card,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, CheckmarkCircle16Filled, ShieldTask20Regular,
  MathFormula20Regular, DatabaseSearch20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { GuidedEmptyState } from '@/lib/components/shared/guided-empty-state';
import { useRuntimeFlag } from '@/lib/components/ui/use-runtime-flag';

interface MetricRow {
  id: string;
  metricId: string;
  label: string;
  owner: string;
  description: string;
  synonyms: string[];
  grain: string;
  sourceKind: 'metric-view' | 'measure';
  sourceRef: string;
}
interface VqrRow {
  id: string;
  question: string;
  query: string;
  queryLang: 'sql' | 'kql' | 'dax' | 'sparksql';
  sourceName: string;
  status: 'draft' | 'approved';
  version: number;
  metricId?: string;
  approvedBy?: string;
  approvedAt?: string;
}

const useStyles = makeStyles({
  root: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL,
    padding: tokens.spacingHorizontalM,
  },
  sectionHead: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS, flexWrap: 'wrap',
  },
  titleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM,
  },
  tableWrap: { overflowX: 'auto', width: '100%' },
  badgeRow: {
    display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS,
    alignItems: 'center', minWidth: 0,
  },
  code: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    maxWidth: '32rem',
  },
  dialogBody: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  hint: { color: tokens.colorNeutralForeground3 },
});

const LANGS: VqrRow['queryLang'][] = ['sql', 'kql', 'dax', 'sparksql'];

export function VerifiedQueriesPane({ id, modelName }: { id: string; modelName?: string }) {
  const s = useStyles();
  const flagOn = useRuntimeFlag('n9-verified-queries-tab', true);

  const [metrics, setMetrics] = useState<MetricRow[]>([]);
  const [vqrs, setVqrs] = useState<VqrRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [metricOpen, setMetricOpen] = useState(false);
  const [vqOpen, setVqOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(id)}/verified-queries`);
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      setMetrics(Array.isArray(j.metrics) ? j.metrics : []);
      setVqrs(Array.isArray(j.verifiedQueries) ? j.verifiedQueries : []);
    } catch (e: unknown) {
      setErr((e as Error)?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { if (flagOn) void load(); }, [flagOn, load]);

  const post = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    setMsg(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(id)}/verified-queries`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return false; }
      setMsg({ ok: true, text: j.note || 'Saved.' });
      await load();
      return true;
    } catch (e: unknown) {
      setMsg({ ok: false, text: (e as Error)?.message || String(e) });
      return false;
    }
  }, [id, load]);

  const approve = useCallback(async (vqrId: string) => {
    setBusyId(vqrId);
    try { await post({ op: 'approve-verified-query', id: vqrId }); }
    finally { setBusyId(null); }
  }, [post]);

  const remove = useCallback(async (vqrId: string) => {
    setBusyId(vqrId);
    try { await post({ op: 'delete-verified-query', id: vqrId }); }
    finally { setBusyId(null); }
  }, [post]);

  const approvedCount = useMemo(() => vqrs.filter((v) => v.status === 'approved').length, [vqrs]);

  // FLAG0 — kill-switch off: guided notice, no dead surface.
  if (!flagOn) {
    return (
      <div className={s.root}>
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Verified Queries is turned off</MessageBarTitle>
            An admin disabled the <code>n9-verified-queries-tab</code> runtime flag. Re-enable it in
            Admin → Runtime flags to author the governed semantic contract. The data-agent contract
            evaluation and its stored metrics / verified queries are unaffected.
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  if (loading) {
    return <div className={s.root}><Spinner label="Loading the semantic contract…" /></div>;
  }

  const empty = metrics.length === 0 && vqrs.length === 0;

  return (
    <div className={s.root}>
      {err && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Couldn’t load the contract</MessageBarTitle>{err}</MessageBarBody>
        </MessageBar>
      )}
      {msg && (
        <MessageBar intent={msg.ok ? 'success' : 'error'}>
          <MessageBarBody>{msg.text}</MessageBarBody>
        </MessageBar>
      )}

      {empty && !err ? (
        <GuidedEmptyState
          title="Govern this model as a semantic contract"
          intro="Register the metrics your agents may answer with, then bless approved question→query pairs. A data agent retrieves a verified query FIRST and refuses out-of-contract questions instead of guessing."
          heroIcon={ShieldTask20Regular}
          columns={2}
          paths={[
            {
              key: 'metric',
              title: 'Register a governed metric',
              body: 'Owner, definition, synonyms, and grain — the trusted meaning of a measure.',
              icon: MathFormula20Regular,
              onClick: () => setMetricOpen(true),
            },
            {
              key: 'vqr',
              title: 'Add a verified query',
              body: 'An approved question→query pair the agent runs verbatim on the real backend.',
              icon: DatabaseSearch20Regular,
              onClick: () => setVqOpen(true),
            },
          ]}
        />
      ) : (
        <>
          {/* ── Governed metrics ─────────────────────────────────────────── */}
          <Card className={s.card}>
            <div className={s.sectionHead}>
              <div className={s.titleRow}>
                <MathFormula20Regular />
                <Subtitle2>Governed metrics ({metrics.length})</Subtitle2>
              </div>
              <Button appearance="primary" icon={<Add20Regular />} onClick={() => setMetricOpen(true)}>
                Register metric
              </Button>
            </div>
            <Caption1 className={s.hint}>
              The metric-definition substrate — every measure your agents may answer with, with an owner,
              definition, synonyms, and grain.
            </Caption1>
            {metrics.length > 0 && (
              <div className={s.tableWrap}>
                <Table size="small" aria-label="Governed metrics">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Metric</TableHeaderCell>
                      <TableHeaderCell>Definition</TableHeaderCell>
                      <TableHeaderCell>Synonyms</TableHeaderCell>
                      <TableHeaderCell>Grain</TableHeaderCell>
                      <TableHeaderCell>Source</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {metrics.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell>
                          <div className={s.badgeRow}>
                            <Body1>{m.label}</Body1>
                            <Badge appearance="tint" color="informative">{m.metricId}</Badge>
                          </div>
                          {m.owner && <Caption1 className={s.hint}>Owner: {m.owner}</Caption1>}
                        </TableCell>
                        <TableCell><Caption1>{m.description || '—'}</Caption1></TableCell>
                        <TableCell>
                          <div className={s.badgeRow}>
                            {(m.synonyms || []).length
                              ? m.synonyms.map((syn) => <Badge key={syn} appearance="outline">{syn}</Badge>)
                              : <Caption1 className={s.hint}>—</Caption1>}
                          </div>
                        </TableCell>
                        <TableCell><Caption1>{m.grain || '—'}</Caption1></TableCell>
                        <TableCell>
                          <div className={s.badgeRow}>
                            <Badge appearance="tint" color={m.sourceKind === 'measure' ? 'brand' : 'success'}>
                              {m.sourceKind}
                            </Badge>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Card>

          {/* ── Verified queries ─────────────────────────────────────────── */}
          <Card className={s.card}>
            <div className={s.sectionHead}>
              <div className={s.titleRow}>
                <DatabaseSearch20Regular />
                <Subtitle2>Verified queries ({vqrs.length})</Subtitle2>
                <Badge appearance="tint" color="success">{approvedCount} approved</Badge>
              </div>
              <Button appearance="primary" icon={<Add20Regular />} onClick={() => setVqOpen(true)}>
                Add verified query
              </Button>
            </div>
            <Caption1 className={s.hint}>
              Only <strong>approved</strong> pairs are retrieved at run time. A draft is authored but never
              served until a steward approves it (approval is audited + versioned).
            </Caption1>
            {vqrs.length > 0 && (
              <div className={s.tableWrap}>
                <Table size="small" aria-label="Verified queries">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Question</TableHeaderCell>
                      <TableHeaderCell>Query</TableHeaderCell>
                      <TableHeaderCell>Status</TableHeaderCell>
                      <TableHeaderCell>Actions</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {vqrs.map((v) => (
                      <TableRow key={v.id}>
                        <TableCell>
                          <Body1>{v.question}</Body1>
                          <div className={s.badgeRow}>
                            <Badge appearance="outline">{v.queryLang.toUpperCase()}</Badge>
                            <Caption1 className={s.hint}>{v.sourceName || '—'}</Caption1>
                          </div>
                        </TableCell>
                        <TableCell><div className={s.code}>{v.query}</div></TableCell>
                        <TableCell>
                          <div className={s.badgeRow}>
                            {v.status === 'approved' ? (
                              <Badge appearance="filled" color="success" icon={<CheckmarkCircle16Filled />}>
                                Approved v{v.version}
                              </Badge>
                            ) : (
                              <Badge appearance="tint" color="warning">Draft</Badge>
                            )}
                          </div>
                          {v.approvedBy && <Caption1 className={s.hint}>by {v.approvedBy}</Caption1>}
                        </TableCell>
                        <TableCell>
                          <div className={s.badgeRow}>
                            <Button
                              size="small"
                              appearance="primary"
                              icon={busyId === v.id ? <Spinner size="tiny" /> : <ShieldTask20Regular />}
                              disabled={busyId === v.id}
                              onClick={() => approve(v.id)}
                            >
                              {v.status === 'approved' ? 'Re-approve' : 'Approve'}
                            </Button>
                            <Button
                              size="small"
                              appearance="subtle"
                              icon={<Delete20Regular />}
                              disabled={busyId === v.id}
                              onClick={() => remove(v.id)}
                            >
                              Delete
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Card>
        </>
      )}

      <RegisterMetricDialog
        open={metricOpen}
        onOpenChange={setMetricOpen}
        defaultSourceRef={id}
        onSubmit={(metric) => post({ op: 'register-metric', metric })}
      />
      <AddVerifiedQueryDialog
        open={vqOpen}
        onOpenChange={setVqOpen}
        defaultSourceName={modelName || ''}
        metrics={metrics}
        onSubmit={(vq) => post({ op: 'add-verified-query', vq })}
      />
    </div>
  );
}

// ── Dialogs (self-contained; each POSTs through the parent's `onSubmit`) ──────

function RegisterMetricDialog({
  open, onOpenChange, defaultSourceRef, onSubmit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultSourceRef: string;
  onSubmit: (metric: Record<string, unknown>) => Promise<boolean>;
}) {
  const s = useStyles();
  const [metricId, setMetricId] = useState('');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [synonyms, setSynonyms] = useState('');
  const [grain, setGrain] = useState('');
  const [sourceKind, setSourceKind] = useState<'metric-view' | 'measure'>('metric-view');
  const [sourceRef, setSourceRef] = useState(defaultSourceRef);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) setSourceRef(defaultSourceRef); }, [open, defaultSourceRef]);

  const submit = async () => {
    setBusy(true);
    try {
      const ok = await onSubmit({
        metricId, label, description, synonyms, grain, sourceKind, sourceRef,
      });
      if (ok) {
        setMetricId(''); setLabel(''); setDescription(''); setSynonyms(''); setGrain('');
        onOpenChange(false);
      }
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Register a governed metric</DialogTitle>
          <DialogContent className={s.dialogBody}>
            <Field label="Metric id" required hint="Stable key, e.g. net_revenue">
              <Input value={metricId} onChange={(_, d) => setMetricId(d.value)} placeholder="net_revenue" />
            </Field>
            <Field label="Label" required>
              <Input value={label} onChange={(_, d) => setLabel(d.value)} placeholder="Net Revenue" />
            </Field>
            <Field label="Definition">
              <Textarea value={description} onChange={(_, d) => setDescription(d.value)}
                placeholder="Gross revenue minus returns and discounts, recognized on ship date." />
            </Field>
            <Field label="Synonyms" hint="Comma-separated alternate phrasings">
              <Input value={synonyms} onChange={(_, d) => setSynonyms(d.value)} placeholder="sales, top line, turnover" />
            </Field>
            <Field label="Grain">
              <Input value={grain} onChange={(_, d) => setGrain(d.value)} placeholder="per order, daily by region" />
            </Field>
            <Field label="Source kind">
              <Dropdown
                value={sourceKind}
                selectedOptions={[sourceKind]}
                onOptionSelect={(_, d) => setSourceKind((d.optionValue as 'metric-view' | 'measure') || 'metric-view')}
              >
                <Option value="metric-view">metric-view</Option>
                <Option value="measure">measure</Option>
              </Dropdown>
            </Field>
            <Field label="Source ref" hint="metric-view item id, or <model>::<measure>">
              <Input value={sourceRef} onChange={(_, d) => setSourceRef(d.value)} />
            </Field>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary" disabled={busy}>Cancel</Button>
            </DialogTrigger>
            <Button appearance="primary" disabled={busy || !metricId.trim() || !label.trim()} onClick={submit}>
              {busy ? <Spinner size="tiny" /> : 'Register metric'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function AddVerifiedQueryDialog({
  open, onOpenChange, defaultSourceName, metrics, onSubmit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultSourceName: string;
  metrics: MetricRow[];
  onSubmit: (vq: Record<string, unknown>) => Promise<boolean>;
}) {
  const s = useStyles();
  const [question, setQuestion] = useState('');
  const [query, setQuery] = useState('');
  const [queryLang, setQueryLang] = useState<VqrRow['queryLang']>('sql');
  const [sourceName, setSourceName] = useState(defaultSourceName);
  const [metricId, setMetricId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) setSourceName(defaultSourceName); }, [open, defaultSourceName]);

  const submit = async () => {
    setBusy(true);
    try {
      const ok = await onSubmit({
        question, query, queryLang, sourceName,
        metricId: metricId || undefined,
      });
      if (ok) {
        setQuestion(''); setQuery(''); setMetricId('');
        onOpenChange(false);
      }
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Add a verified query</DialogTitle>
          <DialogContent className={s.dialogBody}>
            <Field label="Question" required hint="The natural-language question this query answers">
              <Input value={question} onChange={(_, d) => setQuestion(d.value)}
                placeholder="What was total revenue by region last quarter?" />
            </Field>
            <Field label="Query" required hint="Run verbatim on a hit — read-only SELECT/WITH (SQL) or KQL/DAX">
              <Textarea value={query} onChange={(_, d) => setQuery(d.value)}
                placeholder="SELECT region, SUM(net_revenue) AS revenue FROM sales GROUP BY region" />
            </Field>
            <Field label="Query language">
              <Dropdown
                value={queryLang}
                selectedOptions={[queryLang]}
                onOptionSelect={(_, d) => setQueryLang((d.optionValue as VqrRow['queryLang']) || 'sql')}
              >
                {LANGS.map((l) => <Option key={l} value={l}>{l.toUpperCase()}</Option>)}
              </Dropdown>
            </Field>
            <Field label="Source" hint="The attached agent source the query runs against">
              <Input value={sourceName} onChange={(_, d) => setSourceName(d.value)} />
            </Field>
            <Field label="Associated metric" hint="Optional — link to a governed metric">
              <Dropdown
                value={metricId ? (metrics.find((m) => m.metricId === metricId)?.label || metricId) : '(none)'}
                selectedOptions={metricId ? [metricId] : []}
                onOptionSelect={(_, d) => setMetricId(String(d.optionValue || ''))}
              >
                <Option value="">(none)</Option>
                {metrics.map((m) => <Option key={m.metricId} value={m.metricId}>{m.label}</Option>)}
              </Dropdown>
            </Field>
            <MessageBar intent="info">
              <MessageBarBody>Saved as a <strong>draft</strong>. Approve it to make agents retrieve it first.</MessageBarBody>
            </MessageBar>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary" disabled={busy}>Cancel</Button>
            </DialogTrigger>
            <Button appearance="primary" disabled={busy || !question.trim() || !query.trim()} onClick={submit}>
              {busy ? <Spinner size="tiny" /> : 'Add verified query'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
