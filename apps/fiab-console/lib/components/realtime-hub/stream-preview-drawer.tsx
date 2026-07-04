'use client';

/**
 * StreamPreviewDrawer — Fabric Real-Time hub "Preview data" / "Explore data in
 * motion" for a KQL table (Eventhouse / KQL database). Reads the most recent
 * rows from the backing Kusto table via the real Kusto query path
 * (POST /api/realtime-hub/preview, which server-builds `["table"] | take N`).
 *
 * Shared by both real-time surfaces (/realtime-hub and /rti-hub) so the preview
 * affordance has ONE implementation. The DB + table are chosen from REAL
 * pickers populated from `.show databases` / `.show tables`
 * (GET /api/realtime-hub/databases) — matching the Fabric/ADX "pick a database,
 * then a table" flow rather than assuming stream-name == table-name. The
 * preview route quotes the identifier server-side so the caller never injects
 * raw KQL.
 */

import { useEffect, useState } from 'react';
import {
  Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Button, Field, Caption1, MessageBar, MessageBarBody, MessageBarTitle,
  Dropdown, Option, Spinner,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Dismiss20Regular, Eye20Regular, ArrowClockwise16Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  section: { marginBottom: tokens.spacingVerticalM },
  pickerRow: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalS },
  pickerGrow: { flex: 1, minWidth: 0 },
  resultMeta: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginBottom: tokens.spacingVerticalS },
  resultScroll: {
    marginTop: tokens.spacingVerticalS,
    maxHeight: '420px', overflow: 'auto',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  resultTable: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
  th: {
    position: 'sticky', top: 0, zIndex: 1,
    textAlign: 'left', fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground2,
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    whiteSpace: 'nowrap',
  },
  tr: { ':nth-child(even)': { backgroundColor: tokens.colorNeutralBackground2 } },
  td: {
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    maxWidth: '280px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums',
  },
  emptyRows: {
    marginTop: tokens.spacingVerticalS, padding: tokens.spacingVerticalL,
    textAlign: 'center', color: tokens.colorNeutralForeground3,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
});

interface PreviewResult { columns: string[]; rows: unknown[][]; rowCount: number; executionMs: number }

export interface StreamPreviewDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Drawer title (usually the stream / table name). */
  title: string;
  /** Default KQL database to pre-select (defaults to the server's loomdb-default when blank). */
  defaultDb?: string;
  /** Default table to pre-select (e.g. a KQL table whose name == the item). */
  defaultTable?: string;
  /** Optional ADX cluster URI to preview a *discovered* cluster (RTI hub ADX
   *  rows) instead of the env-configured default. Forwarded to the preview
   *  + picker routes, which validate it server-side. */
  clusterUri?: string;
}

export function StreamPreviewDrawer({ open, onClose, title, defaultDb, defaultTable, clusterUri }: StreamPreviewDrawerProps) {
  const styles = useStyles();
  const [db, setDb] = useState(defaultDb || '');
  const [table, setTable] = useState(defaultTable || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<PreviewResult | null>(null);

  // Real DB/table picker state (from `.show databases` / `.show tables`).
  const [databases, setDatabases] = useState<string[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [dbLoading, setDbLoading] = useState(false);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [pickerGate, setPickerGate] = useState<{ missing: string } | null>(null);
  const [pickerErr, setPickerErr] = useState<string | null>(null);

  const clusterQs = clusterUri ? `&clusterUri=${encodeURIComponent(clusterUri)}` : '';

  async function loadDatabases() {
    setDbLoading(true); setPickerErr(null); setPickerGate(null);
    try {
      const res = await fetch(`/api/realtime-hub/databases?_=1${clusterQs}`, { cache: 'no-store' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setPickerErr(j.error || `Could not list databases (HTTP ${res.status}).`); return; }
      if (j.configured === false && j.gate) { setPickerGate(j.gate); return; }
      setDatabases(Array.isArray(j.databases) ? j.databases.map((d: any) => d.name).filter(Boolean) : []);
    } catch (e: any) { setPickerErr(e?.message || String(e)); }
    finally { setDbLoading(false); }
  }

  async function loadTables(forDb: string) {
    const target = forDb.trim();
    setTables([]);
    if (!target) return;
    setTablesLoading(true); setPickerErr(null);
    try {
      const res = await fetch(`/api/realtime-hub/databases?database=${encodeURIComponent(target)}${clusterQs}`, { cache: 'no-store' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setPickerErr(j.error || `Could not list tables (HTTP ${res.status}).`); return; }
      setTables(Array.isArray(j.tables) ? j.tables.map((t: any) => t.name).filter(Boolean) : []);
    } catch (e: any) { setPickerErr(e?.message || String(e)); }
    finally { setTablesLoading(false); }
  }

  // Re-seed the fields + (re)load the database list whenever the drawer is
  // (re)opened onto a new target.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (open && seededFor !== title) {
    setSeededFor(title);
    setDb(defaultDb || '');
    setTable(defaultTable || '');
    setResult(null);
    setErr(null);
    setTables([]);
  }
  if (!open && seededFor !== null) setSeededFor(null);

  // Load databases on open; load tables whenever the selected database changes.
  useEffect(() => { if (open) loadDatabases(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open, clusterUri]);
  useEffect(() => { if (open && db.trim()) loadTables(db); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [db, open, clusterUri]);

  async function run() {
    setBusy(true); setErr(null); setResult(null);
    try {
      const res = await fetch('/api/realtime-hub/preview', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ database: db.trim() || undefined, table: table.trim(), limit: 50, clusterUri: clusterUri || undefined }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(j.error || `Preview failed (HTTP ${res.status}).`); return; }
      setResult({ columns: j.columns, rows: j.rows, rowCount: j.rowCount, executionMs: j.executionMs });
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }

  return (
    <Drawer open={open} position="end" size="medium" onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DrawerHeader>
        <DrawerHeaderTitle action={<Button appearance="subtle" icon={<Dismiss20Regular />} onClick={onClose} aria-label="Close preview" />}>
          Preview — {title}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        <div className={styles.section}>
          <Caption1>Preview reads recent rows from the backing Eventhouse / KQL table via the real Kusto query path. Pick the database and table; the table identifier is quoted server-side — no raw KQL is sent.</Caption1>
        </div>

        {pickerGate && (
          <MessageBar intent="warning" className={styles.section}>
            <MessageBarBody>
              <MessageBarTitle>Kusto cluster not configured</MessageBarTitle>
              Set <code>{pickerGate.missing}</code> to enable database/table discovery for the preview.
            </MessageBarBody>
          </MessageBar>
        )}

        <Field label="KQL database" className={styles.section}>
          <div className={styles.pickerRow}>
            <div className={styles.pickerGrow}>
              <Dropdown
                aria-label="KQL database"
                disabled={!!pickerGate}
                placeholder={
                  pickerGate ? 'No cluster configured'
                    : dbLoading ? 'Loading databases…'
                    : databases.length === 0 ? 'No databases found (defaults to loomdb-default)'
                    : 'Select a database…'
                }
                selectedOptions={db ? [db] : []}
                value={db}
                onOptionSelect={(_, d) => { const v = d.optionValue || ''; setDb(v); setTable(''); }}
              >
                {databases.map((name) => (
                  <Option key={name} value={name} text={name}>{name}</Option>
                ))}
              </Dropdown>
            </div>
            <Button appearance="subtle"
              icon={dbLoading ? <Spinner size="tiny" /> : <ArrowClockwise16Regular />}
              aria-label="Refresh databases" onClick={loadDatabases} disabled={dbLoading || !!pickerGate} />
          </div>
        </Field>

        <Field label="Table" required className={styles.section}>
          <Dropdown
            aria-label="Table"
            disabled={!!pickerGate || tablesLoading || (!db.trim() && databases.length > 0)}
            placeholder={
              !db.trim() && databases.length > 0 ? 'Select a database first'
                : tablesLoading ? 'Loading tables…'
                : tables.length === 0 ? 'No tables found in this database'
                : 'Select a table…'
            }
            selectedOptions={table ? [table] : []}
            value={table}
            onOptionSelect={(_, d) => setTable(d.optionValue || '')}
          >
            {tables.map((name) => (
              <Option key={name} value={name} text={name}>{name}</Option>
            ))}
          </Dropdown>
        </Field>

        {pickerErr && <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalM }}><MessageBarBody>{pickerErr}</MessageBarBody></MessageBar>}

        <Button appearance="primary" icon={<Eye20Regular />} disabled={!table.trim() || busy} onClick={run}>
          {busy ? 'Reading…' : 'Preview recent events'}
        </Button>
        {err && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}><MessageBarBody>{err}</MessageBarBody></MessageBar>}
        {result && (
          <div style={{ marginTop: tokens.spacingVerticalL }}>
            <div className={styles.resultMeta}>
              <Caption1>{result.rowCount} {result.rowCount === 1 ? 'row' : 'rows'} · {result.executionMs} ms</Caption1>
            </div>
            {result.rows.length === 0 ? (
              <div className={styles.emptyRows}>
                Query returned no rows. The table exists but has no events in the previewed window.
              </div>
            ) : (
              <div className={styles.resultScroll}>
                <table className={styles.resultTable}>
                  <thead><tr>{result.columns.map((c) => <th key={c} className={styles.th}>{c}</th>)}</tr></thead>
                  <tbody>
                    {result.rows.slice(0, 50).map((row, i) => (
                      <tr key={i} className={styles.tr}>
                        {row.map((cell, j) => {
                          const text = cell == null ? '' : String(cell);
                          return <td key={j} className={styles.td} title={text}>{text}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </DrawerBody>
    </Drawer>
  );
}
