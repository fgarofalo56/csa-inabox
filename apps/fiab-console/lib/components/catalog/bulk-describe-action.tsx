'use client';

/**
 * BulkDescribeAction — "Generate descriptions for all tables/measures" bulk
 * catalog action for a semantic model (Fabric Build 2026 #36: AI
 * Auto-Description for Semantic Models, surfaced from OneLake catalog detail).
 *
 * One click generates business-friendly descriptions for every table, column,
 * and measure via Azure OpenAI (POST /api/items/semantic-model/[id]/describe-bulk
 * with apply:false → proposals), shows them in an editable preview, and persists
 * the approved set (POST apply:true). Azure-native — no Microsoft Fabric / Power
 * BI workspace required; the BFF persists to the Loom-native model state and,
 * when an AAS XMLA endpoint is opted into, also pushes them live.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Spinner, Badge, MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Textarea, Caption1, Subtitle2, Input, Skeleton, SkeletonItem,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Sparkle20Regular, DismissRegular, SearchRegular } from '@fluentui/react-icons';

interface Props {
  /** Semantic-model id: a Loom content id (loom:…) or a live dataset id. */
  modelId: string;
  /** Optional Power BI workspace id (only for an opt-in live dataset). */
  workspaceId?: string;
}

interface ColProposal { name: string; description: string }
interface TableProposal { table: string; description: string; columns: ColProposal[] }
interface MeasureProposal { name: string; description: string }
interface Proposals { tables: TableProposal[]; measures: MeasureProposal[] }
interface Counts { tables: number; tablesDescribed: number; columns: number; measures: number; measuresDescribed: number }

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  hint: { color: tokens.colorNeutralForeground3, maxWidth: '640px' },
  countRow: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
  buttonRow: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'center' },
  ta: { width: '100%', minWidth: '280px' },
  sectionTitle: { marginTop: tokens.spacingVerticalM },
  loadingRow: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', maxWidth: '420px' },
  filterRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
    marginTop: tokens.spacingVerticalS,
  },
  filterInput: { minWidth: '240px' },
  filterMeta: { color: tokens.colorNeutralForeground3, whiteSpace: 'nowrap' },
  tableGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  groupHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
    marginBottom: tokens.spacingVerticalXS,
  },
  groupName: { fontWeight: tokens.fontWeightSemibold },
  colTable: { marginTop: tokens.spacingVerticalXS },
  code: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  emptyFilter: { color: tokens.colorNeutralForeground3, fontStyle: 'italic' },
});

export function BulkDescribeAction({ modelId, workspaceId }: Props) {
  const s = useStyles();
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
  const base = `/api/items/semantic-model/${encodeURIComponent(modelId)}/describe-bulk${qs}`;

  const [counts, setCounts] = useState<Counts | null>(null);
  const [countsLoading, setCountsLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [proposals, setProposals] = useState<Proposals | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [filter, setFilter] = useState('');

  const loadCounts = useCallback(async () => {
    setLoadErr(null);
    setCountsLoading(true);
    try {
      const r = await fetch(base);
      const j = await r.json();
      if (!j.ok) { setLoadErr(j.error || 'Failed to load model'); return; }
      setCounts(j.counts);
      setNotice(j.notice || null);
    } catch (e: any) { setLoadErr(e?.message || String(e)); }
    finally { setCountsLoading(false); }
  }, [base]);

  useEffect(() => { void loadCounts(); }, [loadCounts]);

  const generate = useCallback(async () => {
    setBusy(true); setResult(null); setProposals(null); setFilter('');
    try {
      const r = await fetch(base, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apply: false }),
      });
      const j = await r.json();
      if (!j.ok) { setResult({ ok: false, text: j.error || j.hint || 'Generation failed' }); return; }
      setProposals(j.proposals);
      if (j.notice) setNotice(j.notice);
    } catch (e: any) {
      setResult({ ok: false, text: e?.message || String(e) });
    } finally { setBusy(false); }
  }, [base]);

  const apply = useCallback(async () => {
    if (!proposals) return;
    setBusy(true); setResult(null);
    try {
      const r = await fetch(base, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apply: true, tables: proposals.tables, measures: proposals.measures }),
      });
      const j = await r.json();
      if (!j.ok) { setResult({ ok: false, text: j.error || 'Apply failed' }); return; }
      const xmlaNote = j.xmla
        ? (j.xmla.ok ? ` Pushed ${j.xmla.pushed} description(s) live via XMLA.` : ` (XMLA push skipped: ${j.xmla.error})`)
        : '';
      setResult({ ok: true, text: `Applied ${j.tables} table, ${j.columns} column, and ${j.measures} measure description(s).${xmlaNote}` });
      setProposals(null);
      setFilter('');
      void loadCounts();
    } catch (e: any) {
      setResult({ ok: false, text: e?.message || String(e) });
    } finally { setBusy(false); }
  }, [base, proposals, loadCounts]);

  const editTableDesc = (table: string, value: string) => {
    setProposals((p) => {
      if (!p) return p;
      const tables = p.tables.map((t) => (t.table === table ? { ...t, description: value } : t));
      return { ...p, tables };
    });
  };
  const editColDesc = (table: string, col: string, value: string) => {
    setProposals((p) => {
      if (!p) return p;
      const tables = p.tables.map((t) =>
        t.table === table ? { ...t, columns: t.columns.map((c) => (c.name === col ? { ...c, description: value } : c)) } : t);
      return { ...p, tables };
    });
  };
  const editMeasureDesc = (name: string, value: string) => {
    setProposals((p) => {
      if (!p) return p;
      const measures = p.measures.map((m) => (m.name === name ? { ...m, description: value } : m));
      return { ...p, measures };
    });
  };

  // Client-side filter across table / column / measure names so large models
  // stay navigable. Filtering is non-destructive — edits persist to the full set.
  const q = filter.trim().toLowerCase();
  const filtered = useMemo<Proposals | null>(() => {
    if (!proposals) return null;
    if (!q) return proposals;
    const tables = proposals.tables
      .map((t) => {
        const tableHit = t.table.toLowerCase().includes(q);
        const columns = tableHit ? t.columns : t.columns.filter((c) => c.name.toLowerCase().includes(q));
        return { tableHit, t, columns };
      })
      .filter((x) => x.tableHit || x.columns.length > 0)
      .map((x) => ({ ...x.t, columns: x.columns }));
    const measures = proposals.measures.filter((m) => m.name.toLowerCase().includes(q));
    return { tables, measures };
  }, [proposals, q]);

  const totalProposed = proposals ? proposals.tables.length + proposals.measures.length : 0;
  const shownProposed = filtered ? filtered.tables.length + filtered.measures.length : 0;
  const noMatches = !!proposals && totalProposed > 0 && !!q && shownProposed === 0;

  return (
    <div className={s.root}>
      <Caption1 className={s.hint}>
        Generate concise, business-friendly descriptions for every table, column, and measure on this
        semantic model in one pass, using Azure OpenAI. Review and edit the proposals, then apply them to
        the model catalog. No Microsoft Fabric or Power BI workspace required.
      </Caption1>

      {loadErr && (
        <MessageBar intent="error"><MessageBarBody>{loadErr}</MessageBarBody></MessageBar>
      )}
      {notice && (
        <MessageBar intent="warning"><MessageBarBody>{notice}</MessageBarBody></MessageBar>
      )}

      {countsLoading && !counts && !loadErr && (
        <Skeleton aria-label="Loading model coverage">
          <div className={s.loadingRow}>
            <SkeletonItem shape="rectangle" style={{ width: 150, height: 20 }} />
            <SkeletonItem shape="rectangle" style={{ width: 90, height: 20 }} />
            <SkeletonItem shape="rectangle" style={{ width: 160, height: 20 }} />
          </div>
        </Skeleton>
      )}

      {counts && (
        <div className={s.countRow}>
          <Badge appearance="tint" color="brand">{counts.tablesDescribed}/{counts.tables} tables described</Badge>
          <Badge appearance="tint">{counts.columns} columns</Badge>
          <Badge appearance="tint" color="brand">{counts.measuresDescribed}/{counts.measures} measures described</Badge>
        </div>
      )}

      <div className={s.buttonRow}>
        <Button
          appearance="primary"
          icon={busy && !proposals ? <Spinner size="tiny" /> : <Sparkle20Regular />}
          disabled={busy || (!!counts && counts.tables === 0 && counts.measures === 0)}
          onClick={generate}
          data-testid="bulk-describe-generate"
        >
          {busy && !proposals ? 'Generating…' : 'Generate descriptions for all tables/measures'}
        </Button>
      </div>

      {result && (
        <MessageBar intent={result.ok ? 'success' : 'error'}>
          <MessageBarBody>
            <MessageBarTitle>{result.ok ? 'Descriptions applied' : 'Action failed'}</MessageBarTitle>
            {result.text}
          </MessageBarBody>
        </MessageBar>
      )}

      {proposals && totalProposed > 0 && (
        <>
          <div className={s.filterRow}>
            <Input
              className={s.filterInput}
              size="small"
              value={filter}
              placeholder="Filter tables, columns, or measures…"
              aria-label="Filter proposed descriptions"
              contentBefore={<SearchRegular />}
              contentAfter={
                filter ? (
                  <Button
                    appearance="transparent" size="small" icon={<DismissRegular />}
                    aria-label="Clear filter" onClick={() => setFilter('')}
                  />
                ) : undefined
              }
              onChange={(_, d) => setFilter(d.value)}
            />
            {q && (
              <Caption1 className={s.filterMeta}>
                {shownProposed} of {totalProposed} shown
              </Caption1>
            )}
          </div>

          {noMatches && (
            <Caption1 className={s.emptyFilter}>No tables, columns, or measures match “{filter}”.</Caption1>
          )}

          {filtered && filtered.tables.length > 0 && (
            <>
              <Subtitle2 className={s.sectionTitle}>Tables &amp; columns</Subtitle2>
              {filtered.tables.map((t) => (
                <div key={t.table} className={s.tableGroup}>
                  <div className={s.groupHeader}>
                    <span className={s.groupName}>{t.table}</span>
                    {t.columns.length > 0 && (
                      <Badge appearance="outline" size="small">{t.columns.length} columns</Badge>
                    )}
                  </div>
                  <Textarea
                    className={s.ta} value={t.description} rows={2}
                    aria-label={`Description for table ${t.table}`}
                    onChange={(_, d) => editTableDesc(t.table, d.value)}
                  />
                  {t.columns.length > 0 && (
                    <Table size="small" className={s.colTable} aria-label={`Columns of ${t.table}`}>
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>Column</TableHeaderCell>
                          <TableHeaderCell>Description</TableHeaderCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {t.columns.map((c) => (
                          <TableRow key={c.name}>
                            <TableCell><span className={s.code}>{c.name}</span></TableCell>
                            <TableCell>
                              <Textarea
                                className={s.ta} value={c.description} rows={1}
                                aria-label={`Description for column ${t.table}.${c.name}`}
                                onChange={(_, d) => editColDesc(t.table, c.name, d.value)}
                              />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>
              ))}
            </>
          )}

          {filtered && filtered.measures.length > 0 && (
            <>
              <Subtitle2 className={s.sectionTitle}>Measures</Subtitle2>
              <Table size="small" aria-label="Measure descriptions">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Measure</TableHeaderCell>
                    <TableHeaderCell>Description</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.measures.map((m) => (
                    <TableRow key={m.name}>
                      <TableCell><span className={s.code}>{m.name}</span></TableCell>
                      <TableCell>
                        <Textarea
                          className={s.ta} value={m.description} rows={1}
                          aria-label={`Description for measure ${m.name}`}
                          onChange={(_, d) => editMeasureDesc(m.name, d.value)}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}

          <div className={s.buttonRow}>
            <Button appearance="primary" disabled={busy} onClick={apply} data-testid="bulk-describe-apply">
              {busy ? <Spinner size="tiny" /> : 'Apply all descriptions'}
            </Button>
            <Button appearance="secondary" disabled={busy} onClick={() => { setProposals(null); setFilter(''); }}>
              Discard
            </Button>
          </div>
        </>
      )}

      {proposals && totalProposed === 0 && (
        <MessageBar intent="info">
          <MessageBarBody>The generator returned no descriptions for this model.</MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}
