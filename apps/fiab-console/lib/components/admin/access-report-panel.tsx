'use client';

/**
 * AccessReportPanel — the unified "who has access" report (access-governance W1).
 * Reads GET /api/access-governance/report in three modes (tenant-wide / by
 * principal / by resource), renders the merged effective grants, exports CSV,
 * and can seed the ledger via POST /api/access-governance/backfill. All real
 * backends; an empty result is an honest "nothing granted / run backfill" state,
 * never a stub. Fluent v9 + Loom tokens throughout (web3-ui + ux-baseline §9.5).
 */
import { useState, useEffect, useCallback } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  makeStyles, tokens, Badge, Button, Input, Caption1, Subtitle2, Spinner,
  Dropdown, Option, Field, MessageBar, MessageBarBody, MessageBarTitle, Tooltip,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell, TableCellLayout,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, ArrowDownload20Regular, DatabaseArrowUp20Regular,
  Person20Regular, Group20Regular, Search20Regular, ShieldTask24Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { isUnauthorized } from '@/lib/components/sign-in-required';

interface Entry {
  principalId: string; principalUpn?: string; principalType: string;
  resourceType: string; resourceRef: string; resourceName?: string;
  role: string; permission?: string; source: string;
  grantedBy?: string; grantedAt?: string; expiresAt?: string | null; state: string;
  viaGroupId?: string; viaGroupName?: string;
}
type Mode = 'tenant' | 'principal' | 'resource';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  controls: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap' },
  spacer: { flex: 1 },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  badges: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0 },
  principalCell: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  via: { color: tokens.colorNeutralForeground3 },
  count: { color: tokens.colorNeutralForeground2 },
  scroll: { overflowX: 'auto', minWidth: 0 },
});

const SOURCE_LABEL: Record<string, string> = {
  'direct': 'Governed request',
  'data-product': 'Data product',
  'workspace-acl': 'Workspace role',
  'self-serve': 'Self-serve',
};

function sourceBadge(source: string) {
  const label = SOURCE_LABEL[source] || (source.startsWith('package:') ? 'Package' : source.startsWith('group:') ? 'Group' : source);
  const color = source === 'workspace-acl' ? 'brand' : source === 'data-product' ? 'informative' : 'subtle';
  return <Badge appearance="tint" color={color as any} size="small">{label}</Badge>;
}
function stateBadge(state: string) {
  const color = state === 'active' ? 'success' : state === 'revoked' ? 'danger' : 'warning';
  return <Badge appearance="tint" color={color as any} size="small">{state}</Badge>;
}

export function AccessReportPanel() {
  const s = useStyles();
  const [mode, setMode] = useState<Mode>('tenant');
  const [value, setValue] = useState('');
  const [rows, setRows] = useState<Entry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [groupExpansion, setGroupExpansion] = useState<string>('n/a');
  const [busy, setBusy] = useState(false);

  const queryString = useCallback(() => {
    const p = new URLSearchParams();
    if (mode === 'principal' && value.trim()) p.set('principalId', value.trim());
    if (mode === 'resource' && value.trim()) p.set('resourceRef', value.trim());
    return p.toString();
  }, [mode, value]);

  const load = useCallback(async () => {
    setErr(null); setNote(null);
    // Principal/resource modes need a value; tenant mode lists everything.
    if (mode !== 'tenant' && !value.trim()) { setRows(null); return; }
    setRows(null);
    try {
      const qs = queryString();
      const r = await clientFetch(`/api/access-governance/report${qs ? `?${qs}` : ''}`);
      const j = await r.json();
      if (!j.ok) { setErr(isUnauthorized(r) ? 'Tenant-admin access required.' : (j.error || `HTTP ${r.status}`)); setRows([]); return; }
      setRows(j.entries || []);
      setGroupExpansion(j.groupExpansion || 'n/a');
    } catch (e: any) { setErr(e?.message || String(e)); setRows([]); }
  }, [mode, value, queryString]);

  // Auto-load the tenant-wide view on mount + whenever mode switches to tenant.
  useEffect(() => { if (mode === 'tenant') void load(); }, [mode, load]);

  const runBackfill = useCallback(async () => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await clientFetch('/api/access-governance/backfill', { method: 'POST' });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      setNote(j.message || `Seeded ${j.seeded} assignments.`);
      await load();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [load]);

  const downloadCsv = useCallback(() => {
    const qs = queryString();
    const sep = qs ? '&' : '';
    window.open(`/api/access-governance/report?${qs}${sep}format=csv`, '_blank', 'noreferrer');
  }, [queryString]);

  return (
    <div className={s.root}>
      <div className={s.controls}>
        <Field label="View">
          <Dropdown
            value={mode === 'tenant' ? 'All grants' : mode === 'principal' ? 'By principal' : 'By resource'}
            selectedOptions={[mode]}
            onOptionSelect={(_, d) => { setMode((d.optionValue as Mode) || 'tenant'); setRows(null); setValue(''); }}
            style={{ minWidth: 160 }}
          >
            <Option value="tenant" text="All grants"><Person20Regular /> All grants</Option>
            <Option value="principal" text="By principal"><Person20Regular /> By principal</Option>
            <Option value="resource" text="By resource"><Group20Regular /> By resource</Option>
          </Dropdown>
        </Field>
        {mode !== 'tenant' && (
          <Field label={mode === 'principal' ? 'Principal object id (oid)' : 'Resource ref (workspace / container / db / item id)'} style={{ minWidth: 320, flex: 1 }}>
            <Input
              value={value}
              onChange={(_, d) => setValue(d.value)}
              placeholder={mode === 'principal' ? 'e.g. 8f2a…-oid' : 'e.g. ws-123 or salescontainer'}
              onKeyDown={(e) => { if (e.key === 'Enter') void load(); }}
              contentAfter={<Button appearance="transparent" size="small" icon={<Search20Regular />} onClick={() => void load()} aria-label="Search" />}
            />
          </Field>
        )}
        <div className={s.spacer} />
        <div className={s.actions}>
          <Tooltip content="Reload" relationship="label">
            <Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={() => void load()} aria-label="Reload" />
          </Tooltip>
          <Button appearance="secondary" icon={<ArrowDownload20Regular />} disabled={!rows || rows.length === 0} onClick={downloadCsv}>Export CSV</Button>
          <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <DatabaseArrowUp20Regular />} disabled={busy} onClick={() => void runBackfill()}>Backfill ledger</Button>
        </div>
      </div>

      {note && <MessageBar intent="success"><MessageBarBody>{note}</MessageBarBody></MessageBar>}
      {err && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Could not load report</MessageBarTitle>{err}</MessageBarBody></MessageBar>}
      {mode === 'resource' && groupExpansion === 'unavailable' && rows && rows.length > 0 && (
        <MessageBar intent="info"><MessageBarBody>
          Entra group expansion is not configured, so group members are not enumerated. Configure Graph identity (LOOM_GRAPH_*) to expand groups to their members here.
        </MessageBarBody></MessageBar>
      )}

      {rows === null && (mode === 'tenant' || value.trim()) && <Spinner size="tiny" label="Loading report…" labelPosition="after" />}
      {rows === null && mode !== 'tenant' && !value.trim() && (
        <Caption1 className={s.count}>Enter {mode === 'principal' ? 'a principal object id' : 'a resource ref'} and search.</Caption1>
      )}

      {rows && rows.length === 0 && !err && (
        <EmptyState
          icon={<ShieldTask24Regular />}
          title="No access grants to show"
          body="Nothing has been granted yet in this view, or the entitlement ledger hasn't been seeded. Run Backfill to populate it from existing data-product and workspace grants."
          primaryAction={{ label: 'Backfill ledger', onClick: () => void runBackfill() }}
        />
      )}

      {rows && rows.length > 0 && (
        <>
          <Caption1 className={s.count}>{rows.length} grant{rows.length === 1 ? '' : 's'}</Caption1>
          <div className={s.scroll}>
            <Table size="small" aria-label="Access grants">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Principal</TableHeaderCell>
                  <TableHeaderCell>Resource</TableHeaderCell>
                  <TableHeaderCell>Role</TableHeaderCell>
                  <TableHeaderCell>Source</TableHeaderCell>
                  <TableHeaderCell>Granted</TableHeaderCell>
                  <TableHeaderCell>State</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((e, i) => (
                  <TableRow key={`${e.principalId}-${e.resourceType}-${e.resourceRef}-${e.source}-${i}`}>
                    <TableCell>
                      <TableCellLayout media={e.principalType === 'Group' ? <Group20Regular /> : <Person20Regular />}>
                        <div className={s.principalCell}>
                          <span>{e.principalUpn || e.principalId}</span>
                          {e.viaGroupName && <Caption1 className={s.via}>via group {e.viaGroupName}</Caption1>}
                        </div>
                      </TableCellLayout>
                    </TableCell>
                    <TableCell>
                      <div className={s.principalCell}>
                        <span>{e.resourceName || e.resourceRef}</span>
                        <Caption1 className={s.via}>{e.resourceType}</Caption1>
                      </div>
                    </TableCell>
                    <TableCell>{e.role}{e.permission ? <Caption1 className={s.via}> · {e.permission}</Caption1> : null}</TableCell>
                    <TableCell><div className={s.badges}>{sourceBadge(e.source)}</div></TableCell>
                    <TableCell>
                      <div className={s.principalCell}>
                        <span>{e.grantedAt ? new Date(e.grantedAt).toLocaleDateString() : '—'}</span>
                        {e.grantedBy && <Caption1 className={s.via}>by {e.grantedBy}</Caption1>}
                      </div>
                    </TableCell>
                    <TableCell><div className={s.badges}>{stateBadge(e.state)}</div></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
