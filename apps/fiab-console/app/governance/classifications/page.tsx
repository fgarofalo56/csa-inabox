'use client';

import { useEffect, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Subtitle2, Button,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular, Open16Regular } from '@fluentui/react-icons';
import { GovernanceShell } from '@/lib/components/governance-shell';

interface Classification {
  name: string; count: number;
  samples: Array<{ id: string; displayName: string; itemType: string; workspaceId: string }>;
}

const useStyles = makeStyles({
  empty: { padding: 32, color: tokens.colorNeutralForeground3, fontSize: 13, textAlign: 'center' },
  chip: { fontSize: 11, padding: '2px 8px', borderRadius: 999, backgroundColor: tokens.colorPaletteBlueBackground2, color: tokens.colorPaletteBlueForeground2 },
});

export default function ClassificationsPage() {
  const s = useStyles();
  const [data, setData] = useState<Classification[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/governance/classifications');
      const j = await r.json();
      if (!j.ok) { setError(j.error); return; }
      setData(j.classifications);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  return (
    <GovernanceShell sectionTitle="Classifications">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        Distinct classifications applied across your tenant's data assets, derived live from each item's
        <code> state.classifications</code> array.
      </Body1>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load classifications</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}
      {loading && !error && <Spinner label="Aggregating classifications…" />}
      {!loading && !error && (data?.length ?? 0) === 0 && (
        <div className={s.empty}>
          No classifications tagged yet. Apply classifications via item editors (Lakehouse, Data Product, Semantic Model).
        </div>
      )}
      {data && data.length > 0 && (
        <Table aria-label="Classifications">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Classification</TableHeaderCell>
              <TableHeaderCell>Hits</TableHeaderCell>
              <TableHeaderCell>Sample items</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((c) => (
              <TableRow key={c.name}>
                <TableCell><span className={s.chip}>{c.name}</span></TableCell>
                <TableCell><strong>{c.count}</strong></TableCell>
                <TableCell>
                  {c.samples.slice(0, 3).map((sm) => (
                    <a key={sm.id} href={`/items/${sm.itemType}/${sm.id}`}
                       style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 12, fontSize: 12 }}>
                      {sm.displayName} <Open16Regular />
                    </a>
                  ))}
                  {c.samples.length > 3 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>+{c.samples.length - 3} more</Caption1>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </GovernanceShell>
  );
}
