'use client';

/**
 * SynapseKqlEditor — the Synapse Studio "KQL script" editor for a workspace
 * artifact (Develop hub → KQL scripts → open a script).
 *
 * Synapse-Studio-faithful surface for authoring + running a KQL (Kusto) script
 * against a Synapse Data Explorer (Kusto) pool:
 *   - "Connect to" dropdown   → the workspace's live Kusto pools
 *   - "Use database" dropdown  → the selected pool's databases
 *   - KQL query text area      → the script's content.query
 *   - Toolbar: Run · Save · Refresh
 *   - Results grid             → tabular output of the run
 *
 * Every control hits a real backend (no mocks):
 *   - load / save        → /api/synapse/kqlscripts/[name]   (GET / PUT)
 *   - pools + databases  → /api/synapse/kqlscripts/[name]   (ARM kustoPools)
 *   - Run                → /api/synapse/kqlscripts/[name]/run (Kusto v1 query)
 *
 * Azure-native: the pool is a Synapse-workspace Kusto pool — no Fabric, no
 * standalone ADX. When no pool is assigned, Run shows an honest MessageBar
 * naming the kustoPools resource to create. Rendered as a Drawer overlay by the
 * pipeline editor.
 */

import {
  Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Button, Dropdown, Option, Textarea, Field, Caption1, Badge, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Dismiss24Regular, Play16Regular, Save16Regular, ArrowSync16Regular,
} from '@fluentui/react-icons';
import { useCallback, useEffect, useState } from 'react';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, height: '100%', overflow: 'hidden' },
  conn: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  connField: { minWidth: '220px' },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  editor: {
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase300,
  },
  resultWrap: {
    flex: 1, minHeight: 0, overflow: 'auto',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: tokens.spacingVerticalS,
  },
  meta: {
    display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap',
    color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalXS,
  },
  // Sticky header so column names stay visible while scrolling a tall result set.
  resultHeader: {
    position: 'sticky', top: 0, zIndex: 1,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  // Truncate long cell values with an ellipsis; the full value lives in the title.
  cell: {
    maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums',
  },
  emptyNote: { display: 'block', marginTop: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 },
});

interface KqlScriptProps { content?: { query?: string; currentConnection?: { poolName?: string; databaseName?: string; type?: string } } }
interface PoolRow { name: string; state?: string }
interface RunResult { columns: string[]; columnTypes: string[]; rows: unknown[][]; rowCount: number; truncated: boolean; executionMs: number }

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

export interface SynapseKqlEditorProps {
  /** The KQL script artifact name. */
  name: string;
  /** Close the editor (clears the parent's open state). */
  onClose: () => void;
}

export function SynapseKqlEditor({ name, onClose }: SynapseKqlEditorProps) {
  const s = useStyles();
  const base = `/api/synapse/kqlscripts/${encodeURIComponent(name)}`;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [pools, setPools] = useState<PoolRow[]>([]);
  const [databases, setDatabases] = useState<string[]>([]);
  const [pool, setPool] = useState('');
  const [database, setDatabase] = useState('');
  const [dirty, setDirty] = useState(false);

  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runGate, setRunGate] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const body = await fetch(base).then(readJson);
      if (!body.ok) { setError(body.error || 'failed to load KQL script'); setLoading(false); return; }
      const props = body.kqlScript?.properties as KqlScriptProps | undefined;
      setQuery(props?.content?.query || '');
      setPool(props?.content?.currentConnection?.poolName || '');
      setDatabase(props?.content?.currentConnection?.databaseName || '');
      setPools(body.pools || []);
      setDatabases(body.databases || []);
      setDirty(false);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => { load(); }, [load]);

  // When the pool changes, fetch its databases.
  const onPoolChange = useCallback(async (next: string) => {
    setPool(next); setDirty(true); setDatabase(''); setDatabases([]);
    if (!next) return;
    try {
      const body = await fetch(`${base}?pool=${encodeURIComponent(next)}`).then(readJson);
      if (body.ok) setDatabases(body.databases || []);
    } catch { /* dropdown stays empty; user can still save + run with a typed db */ }
  }, [base]);

  const save = useCallback(async () => {
    setSaving(true); setError(null); setSavedNote(null);
    try {
      const properties = {
        content: {
          query,
          currentConnection: { type: 'KustoPool', poolName: pool || undefined, databaseName: database || undefined },
          metadata: { language: 'kql' },
        },
      };
      const body = await fetch(base, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ properties }),
      }).then(readJson);
      if (!body.ok) { setError(body.error || 'save failed'); setSaving(false); return; }
      setDirty(false);
      setSavedNote('Saved');
      setTimeout(() => setSavedNote(null), 2500);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setSaving(false); }
  }, [base, query, pool, database]);

  const run = useCallback(async () => {
    setRunning(true); setRunError(null); setRunGate(null); setResult(null);
    try {
      const body = await fetch(`${base}/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, pool, database }),
      }).then(readJson);
      if (!body.ok) {
        if (body.code === 'no_pool' || body.code === 'no_database') setRunGate(body.error);
        else setRunError(body.error || 'run failed');
        setRunning(false);
        return;
      }
      setResult({
        columns: body.columns || [], columnTypes: body.columnTypes || [],
        rows: body.rows || [], rowCount: body.rowCount || 0,
        truncated: !!body.truncated, executionMs: body.executionMs || 0,
      });
    } catch (e: any) { setRunError(e?.message || String(e)); }
    finally { setRunning(false); }
  }, [base, query, pool, database]);

  return (
    <Drawer open position="end" size="large" onOpenChange={(_, d) => { if (!d.open) onClose(); }} separator>
      <DrawerHeader>
        <DrawerHeaderTitle
          action={<Button appearance="subtle" aria-label="Close" icon={<Dismiss24Regular />} onClick={onClose} />}
        >
          KQL script · {name}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        {loading ? (
          <div style={{ padding: tokens.spacingVerticalL }}><Spinner label="Loading KQL script…" /></div>
        ) : (
          <div className={s.body}>
            {error && (
              <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Error</MessageBarTitle>{error}</MessageBarBody></MessageBar>
            )}

            <div className={s.conn}>
              <Field label="Connect to (Kusto pool)" className={s.connField}>
                <Dropdown
                  placeholder={pools.length ? 'Select a Kusto pool' : 'No Kusto pools on this workspace'}
                  value={pool}
                  selectedOptions={pool ? [pool] : []}
                  disabled={!pools.length}
                  onOptionSelect={(_, d) => onPoolChange(d.optionValue || '')}
                >
                  {pools.map((p) => <Option key={p.name} value={p.name} text={p.name}>{p.name}{p.state ? ` · ${p.state}` : ''}</Option>)}
                </Dropdown>
              </Field>
              <Field label="Use database" className={s.connField}>
                <Dropdown
                  placeholder={pool ? (databases.length ? 'Select a database' : 'No databases (or pool offline)') : 'Pick a pool first'}
                  value={database}
                  selectedOptions={database ? [database] : []}
                  disabled={!pool || !databases.length}
                  onOptionSelect={(_, d) => { setDatabase(d.optionValue || ''); setDirty(true); }}
                >
                  {databases.map((db) => <Option key={db} value={db} text={db}>{db}</Option>)}
                </Dropdown>
              </Field>
            </div>

            <div className={s.toolbar}>
              <Button appearance="primary" icon={running ? <Spinner size="tiny" /> : <Play16Regular />} disabled={running || !query.trim()} onClick={run}>
                {running ? 'Running…' : 'Run'}
              </Button>
              <Button icon={<Save16Regular />} disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</Button>
              <Button appearance="subtle" icon={<ArrowSync16Regular />} disabled={loading} onClick={load}>Refresh</Button>
              {dirty && <Badge appearance="tint" color="warning">Unsaved</Badge>}
              {savedNote && <Badge appearance="tint" color="success">{savedNote}</Badge>}
            </div>

            <Field label="Query (KQL)">
              <Textarea
                className={s.editor}
                resize="vertical"
                value={query}
                onChange={(_, d) => { setQuery(d.value); setDirty(true); }}
                rows={10}
                placeholder="StormEvents | take 100"
              />
            </Field>

            {runGate && (
              <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Connection needed</MessageBarTitle>{runGate}</MessageBarBody></MessageBar>
            )}
            {runError && (
              <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Query failed</MessageBarTitle>{runError}</MessageBarBody></MessageBar>
            )}

            {result && (
              <div className={s.resultWrap}>
                <div className={s.meta}>
                  <Caption1>{result.rowCount} row{result.rowCount === 1 ? '' : 's'}</Caption1>
                  <Caption1>·</Caption1>
                  <Caption1>{result.executionMs} ms</Caption1>
                  {result.truncated && <Badge appearance="tint" color="warning">Truncated to first 5000</Badge>}
                </div>
                {result.columns.length === 0 ? (
                  <Caption1 className={s.emptyNote}>Query returned no columns.</Caption1>
                ) : (
                  <Table size="small" aria-label="Query results">
                    <TableHeader className={s.resultHeader}>
                      <TableRow>
                        {result.columns.map((c, i) => (
                          <TableHeaderCell key={i}>{c}{result.columnTypes[i] ? ` (${result.columnTypes[i]})` : ''}</TableHeaderCell>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.rows.map((row, ri) => (
                        <TableRow key={ri}>
                          {row.map((cell, ci) => {
                            const text = cell == null ? '' : typeof cell === 'object' ? JSON.stringify(cell) : String(cell);
                            return <TableCell key={ci} className={s.cell} title={text}>{text}</TableCell>;
                          })}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            )}
          </div>
        )}
      </DrawerBody>
    </Drawer>
  );
}
