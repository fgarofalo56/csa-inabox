'use client';

/**
 * StreamPreviewDrawer — Fabric Real-Time hub "Preview data" / "Explore data in
 * motion" for a KQL table (Eventhouse / KQL database). Reads the most recent
 * rows from the backing Kusto table via the real Kusto query path
 * (POST /api/realtime-hub/preview, which server-builds `["table"] | take N`).
 *
 * Shared by both real-time surfaces (/realtime-hub and /rti-hub) so the preview
 * affordance has ONE implementation. No raw KQL is entered by the caller — the
 * table + database are picked and the route quotes the identifier server-side.
 */

import { useState } from 'react';
import {
  Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Button, Input, Field, Caption1, MessageBar, MessageBarBody,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Dismiss20Regular, Eye20Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  section: { marginBottom: tokens.spacingVerticalM },
  resultTable: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
  th: { textAlign: 'left', borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, padding: '4px' },
  td: { padding: '4px', borderBottom: `1px solid ${tokens.colorNeutralStroke3}` },
});

interface PreviewResult { columns: string[]; rows: unknown[][]; rowCount: number; executionMs: number }

export interface StreamPreviewDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Drawer title (usually the stream / table name). */
  title: string;
  /** Default KQL database to pre-fill (defaults to the server's loomdb-default when blank). */
  defaultDb?: string;
  /** Default table to pre-fill (e.g. a KQL table whose name == the item). */
  defaultTable?: string;
}

export function StreamPreviewDrawer({ open, onClose, title, defaultDb, defaultTable }: StreamPreviewDrawerProps) {
  const styles = useStyles();
  const [db, setDb] = useState(defaultDb || '');
  const [table, setTable] = useState(defaultTable || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<PreviewResult | null>(null);

  // Re-seed the fields whenever the drawer is (re)opened onto a new target.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (open && seededFor !== title) {
    setSeededFor(title);
    setDb(defaultDb || '');
    setTable(defaultTable || '');
    setResult(null);
    setErr(null);
  }
  if (!open && seededFor !== null) setSeededFor(null);

  async function run() {
    setBusy(true); setErr(null); setResult(null);
    try {
      const res = await fetch('/api/realtime-hub/preview', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ database: db.trim() || undefined, table: table.trim(), limit: 50 }),
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
          <Caption1>Preview reads recent rows from the backing Eventhouse / KQL table via the real Kusto query path. The table identifier is quoted server-side — no raw KQL is sent.</Caption1>
        </div>
        <Field label="KQL database" className={styles.section}>
          <Input value={db} placeholder="Eventhouse / KQL database name (defaults to loomdb-default)"
            onChange={(_, d) => setDb(d.value)} />
        </Field>
        <Field label="Table" required className={styles.section}>
          <Input value={table} placeholder="KQL table to preview (e.g. Events)" onChange={(_, d) => setTable(d.value)} />
        </Field>
        <Button appearance="primary" icon={<Eye20Regular />} disabled={!table.trim() || busy} onClick={run}>
          {busy ? 'Reading…' : 'Preview recent events'}
        </Button>
        {err && <MessageBar intent="error" style={{ marginTop: 12 }}><MessageBarBody>{err}</MessageBarBody></MessageBar>}
        {result && (
          <div style={{ marginTop: 16 }}>
            <Caption1>{result.rowCount} rows · {result.executionMs} ms</Caption1>
            <div style={{ overflowX: 'auto', marginTop: 8 }}>
              <table className={styles.resultTable}>
                <thead><tr>{result.columns.map((c) => <th key={c} className={styles.th}>{c}</th>)}</tr></thead>
                <tbody>
                  {result.rows.slice(0, 50).map((row, i) => (
                    <tr key={i}>{row.map((cell, j) => <td key={j} className={styles.td}>{cell == null ? '' : String(cell)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </DrawerBody>
    </Drawer>
  );
}
