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
import { useCallback, useEffect, useState } from 'react';
import {
  Button, Spinner, Badge, MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Textarea, Caption1, Subtitle2, makeStyles, tokens,
} from '@fluentui/react-components';
import { Sparkle20Regular } from '@fluentui/react-icons';

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
  countRow: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  buttonRow: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  ta: { width: '100%', minWidth: '280px' },
  sectionTitle: { marginTop: tokens.spacingVerticalM },
});

export function BulkDescribeAction({ modelId, workspaceId }: Props) {
  const s = useStyles();
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
  const base = `/api/items/semantic-model/${encodeURIComponent(modelId)}/describe-bulk${qs}`;

  const [counts, setCounts] = useState<Counts | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [proposals, setProposals] = useState<Proposals | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const loadCounts = useCallback(async () => {
    setLoadErr(null);
    try {
      const r = await fetch(base);
      const j = await r.json();
      if (!j.ok) { setLoadErr(j.error || 'Failed to load model'); return; }
      setCounts(j.counts);
      setNotice(j.notice || null);
    } catch (e: any) { setLoadErr(e?.message || String(e)); }
  }, [base]);

  useEffect(() => { void loadCounts(); }, [loadCounts]);

  const generate = useCallback(async () => {
    setBusy(true); setResult(null); setProposals(null);
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
      void loadCounts();
    } catch (e: any) {
      setResult({ ok: false, text: e?.message || String(e) });
    } finally { setBusy(false); }
  }, [base, proposals, loadCounts]);

  const editTableDesc = (ti: number, value: string) => {
    setProposals((p) => {
      if (!p) return p;
      const tables = p.tables.map((t, i) => (i === ti ? { ...t, description: value } : t));
      return { ...p, tables };
    });
  };
  const editColDesc = (ti: number, ci: number, value: string) => {
    setProposals((p) => {
      if (!p) return p;
      const tables = p.tables.map((t, i) =>
        i === ti ? { ...t, columns: t.columns.map((c, j) => (j === ci ? { ...c, description: value } : c)) } : t);
      return { ...p, tables };
    });
  };
  const editMeasureDesc = (mi: number, value: string) => {
    setProposals((p) => {
      if (!p) return p;
      const measures = p.measures.map((m, i) => (i === mi ? { ...m, description: value } : m));
      return { ...p, measures };
    });
  };

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
          Generate descriptions for all tables/measures
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

      {proposals && (proposals.tables.length > 0 || proposals.measures.length > 0) && (
        <>
          {proposals.tables.length > 0 && (
            <>
              <Subtitle2 className={s.sectionTitle}>Tables &amp; columns</Subtitle2>
              {proposals.tables.map((t, ti) => (
                <div key={t.table} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <Caption1><strong>{t.table}</strong></Caption1>
                  <Textarea
                    className={s.ta} value={t.description} rows={2}
                    aria-label={`Description for table ${t.table}`}
                    onChange={(_, d) => editTableDesc(ti, d.value)}
                  />
                  {t.columns.length > 0 && (
                    <Table size="small" aria-label={`Columns of ${t.table}`}>
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>Column</TableHeaderCell>
                          <TableHeaderCell>Description</TableHeaderCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {t.columns.map((c, ci) => (
                          <TableRow key={c.name}>
                            <TableCell><code>{c.name}</code></TableCell>
                            <TableCell>
                              <Textarea
                                className={s.ta} value={c.description} rows={1}
                                aria-label={`Description for column ${t.table}.${c.name}`}
                                onChange={(_, d) => editColDesc(ti, ci, d.value)}
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

          {proposals.measures.length > 0 && (
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
                  {proposals.measures.map((m, mi) => (
                    <TableRow key={m.name}>
                      <TableCell><code>{m.name}</code></TableCell>
                      <TableCell>
                        <Textarea
                          className={s.ta} value={m.description} rows={1}
                          aria-label={`Description for measure ${m.name}`}
                          onChange={(_, d) => editMeasureDesc(mi, d.value)}
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
            <Button appearance="secondary" disabled={busy} onClick={() => setProposals(null)}>Discard</Button>
          </div>
        </>
      )}

      {proposals && proposals.tables.length === 0 && proposals.measures.length === 0 && (
        <MessageBar intent="info">
          <MessageBarBody>The generator returned no descriptions for this model.</MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}
