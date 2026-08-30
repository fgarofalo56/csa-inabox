'use client';

/**
 * N17 — Observability incident console pane (/admin/incident-console).
 *
 * OpenLineage-backed data observability, all real backends (no-vaporware):
 *   • Incidents tab — G3 SplitPane [incident list | detail]. Detail shows the
 *     severity/status, the metric behind the trip, the AUDITED timeline
 *     (open→acknowledged→resolved), the downstream-impact panel (from the
 *     unified lineage graph), the transition actions, and the "Runbook →" link.
 *   • Monitors tab — per-table freshness/volume/schema-drift monitors + a
 *     "New monitor" wizard and a "Record observation" run action.
 *
 * ux-baseline: guided EmptyState (no red on first open), resizable SplitPane
 * (persisted sizingKey), Fluent v9 + Loom tokens only (no raw px/hex). FLAG0:
 * when n17-incident-console is OFF the routes return { flagOff:true } and this
 * pane shows the guided turned-off state.
 */

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { clientFetch } from '@/lib/client-fetch';
import { EmptyState } from '@/lib/components/empty-state';
import { SplitPane } from '@/lib/components/shared/split-pane';
import {
  makeStyles, tokens, Card, Title3, Subtitle2, Body1, Caption1, Badge, Spinner,
  Button, Tab, TabList, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle, Tooltip,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Dropdown, Option, Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent,
  DialogActions, Field, Input, Textarea,
} from '@fluentui/react-components';
import {
  Alert24Regular, CheckmarkCircle20Regular, Eye20Regular, ArrowSync20Regular,
  Add20Regular, Open16Regular, BookOpen20Regular, ArrowClockwise20Regular,
} from '@fluentui/react-icons';

// ── styles (tokens only) ─────────────────────────────────────────────────────
const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  spacer: { flexGrow: 1 },
  split: { minHeight: '520px' },
  listPane: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, paddingRight: tokens.spacingHorizontalS, overflowY: 'auto' },
  detailPane: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, paddingLeft: tokens.spacingHorizontalS, overflowY: 'auto', minWidth: 0 },
  row: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0,
    paddingTop: tokens.spacingVerticalS, paddingBottom: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  // full `border` shorthand, not `borderColor` longhand — griffel forbids mixing
  // the shorthand used in `.row` with a longhand override in the same makeStyles call.
  rowActive: { border: `1px solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2 },
  rowHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  rowTitle: { fontWeight: tokens.fontWeightSemibold, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flexGrow: 1 },
  badgeRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0 },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    paddingTop: tokens.spacingVerticalM, paddingBottom: tokens.spacingVerticalM,
    paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL,
  },
  timeline: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
  tlEntry: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'baseline', minWidth: 0 },
  tlNote: { color: tokens.colorNeutralForeground3, overflowWrap: 'anywhere' },
  metricGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(0, 160px))', gap: tokens.spacingHorizontalM },
  metricCell: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  impactList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  impactItem: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  formGrid: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '320px' },
});

// ── types (mirror the route responses) ───────────────────────────────────────
type Severity = 'info' | 'warning' | 'error';
type Status = 'open' | 'acknowledged' | 'resolved';
interface TimelineEntry { at: string; type: string; by: string; note?: string }
interface Incident {
  id: string; status: Status; severity: Severity; source: 'monitor' | 'dq-finding';
  itemId: string; itemType: string; table?: string; monitorKind?: string;
  title: string; detail: string; occurrences: number; openedAt: string; updatedAt: string;
  runbookUrl?: string; findingIds?: string[];
  metric?: { name: string; value: number; baselineMean?: number; baselineStddev?: number; zScore?: number | null; threshold?: number };
  schemaChange?: { added: string[]; removed: string[] };
  timeline: TimelineEntry[];
}
interface ImpactAsset { id: string; label: string; type?: string; openHref?: string; hops: number }
interface Impact { downstream: ImpactAsset[]; upstream: ImpactAsset[]; downstreamCount: number }
interface Monitor { id: string; kind: string; enabled: boolean; itemId: string; itemType: string; table: string; lastValue?: number; observations: unknown[]; lastRunAt?: string }

async function getJson(url: string) {
  const res = await clientFetch(url, { cache: 'no-store' });
  return { ...(await res.json().catch(() => ({}))), _status: res.status };
}
async function postJson(url: string, body: unknown) {
  const res = await clientFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { ...(await res.json().catch(() => ({}))), _status: res.status };
}

const SEV_COLOR: Record<Severity, 'danger' | 'warning' | 'informative'> = { error: 'danger', warning: 'warning', info: 'informative' };
const STATUS_COLOR: Record<Status, 'danger' | 'warning' | 'success'> = { open: 'danger', acknowledged: 'warning', resolved: 'success' };

function fmt(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

/**
 * Honest transport-failure state (loom-apex A3). A rejected fetch must NEVER
 * fall through to the healthy/empty EmptyState — that masks an outage as
 * "all monitored tables are healthy" (the 2026-07-15 G1 0-count class).
 */
function FetchErrorBar({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => void }) {
  return (
    <MessageBar intent="error" layout="multiline">
      <MessageBarBody>
        <MessageBarTitle>{title}</MessageBarTitle>
        {(error instanceof Error && error.message) || 'The request failed before the service answered (network or timeout).'}{' '}
        This is a transport failure, not a healthy state — retry, and if it persists check the console replica logs.
      </MessageBarBody>
      <MessageBarActions>
        <Button size="small" icon={<ArrowClockwise20Regular />} onClick={onRetry}>Retry</Button>
      </MessageBarActions>
    </MessageBar>
  );
}

// ── main pane ────────────────────────────────────────────────────────────────
export function IncidentConsole() {
  const styles = useStyles();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'incidents' | 'monitors'>('incidents');
  const [statusFilter, setStatusFilter] = useState<'' | Status>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const listUrl = useMemo(() => `/api/observability/incidents${statusFilter ? `?status=${statusFilter}` : ''}`, [statusFilter]);
  const listQ = useQuery({ queryKey: ['incidents', statusFilter], queryFn: () => getJson(listUrl) });
  const flagOff = listQ.data?.flagOff === true;
  const incidents: Incident[] = listQ.data?.incidents || [];

  const consume = useMutation({
    mutationFn: () => postJson('/api/observability/incidents', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['incidents'] }),
  });

  if (flagOff) {
    return (
      <EmptyState
        icon={<Alert24Regular />}
        title="Incident console is turned off"
        body="The n17-incident-console runtime flag is OFF. Re-enable it under Admin → Runtime flags to restore monitors, incidents, and the downstream-impact panel. Already-open incidents and emitted lineage are unaffected."
        primaryAction={{ label: 'Open Runtime flags', href: '/admin/runtime-flags' }}
      />
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'incidents' | 'monitors')}>
          <Tab value="incidents" icon={<Alert24Regular />}>Incidents</Tab>
          <Tab value="monitors" icon={<Eye20Regular />}>Monitors</Tab>
        </TabList>
        <div className={styles.spacer} />
        {tab === 'incidents' && (
          <>
            <Dropdown
              aria-label="Filter by status"
              value={statusFilter || 'All statuses'}
              selectedOptions={[statusFilter]}
              onOptionSelect={(_, d) => setStatusFilter((d.optionValue as '' | Status) ?? '')}
            >
              <Option value="">All statuses</Option>
              <Option value="open">Open</Option>
              <Option value="acknowledged">Acknowledged</Option>
              <Option value="resolved">Resolved</Option>
            </Dropdown>
            <Tooltip content="Consume open N7d data-quality findings into incidents" relationship="label">
              <Button icon={<ArrowSync20Regular />} onClick={() => consume.mutate()} disabled={consume.isPending}>
                {consume.isPending ? 'Consuming…' : 'Consume findings'}
              </Button>
            </Tooltip>
            <Tooltip content="Refresh" relationship="label">
              <Button appearance="subtle" icon={<ArrowClockwise20Regular />} onClick={() => listQ.refetch()} aria-label="Refresh incidents" />
            </Tooltip>
          </>
        )}
      </div>

      {consume.data?.opened != null && (
        <MessageBar intent="success">
          <MessageBarBody>Consumed findings into {consume.data.opened} incident group(s).</MessageBarBody>
        </MessageBar>
      )}

      {tab === 'incidents' ? (
        listQ.isError ? (
          <FetchErrorBar title="Could not load incidents" error={listQ.error} onRetry={() => void listQ.refetch()} />
        ) : (
          <IncidentsTab
            loading={listQ.isLoading}
            incidents={incidents}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        )
      ) : (
        <MonitorsTab />
      )}
    </div>
  );
}

// ── Incidents tab ────────────────────────────────────────────────────────────
function IncidentsTab({ loading, incidents, selectedId, onSelect }: {
  loading: boolean; incidents: Incident[]; selectedId: string | null; onSelect: (id: string) => void;
}) {
  const styles = useStyles();
  if (loading) return <Spinner label="Loading incidents…" />;
  if (!incidents.length) {
    return (
      <EmptyState
        icon={<CheckmarkCircle20Regular />}
        title="No incidents — all monitored tables are healthy"
        body="Freshness, volume and schema-drift monitors are watching your tables. When one trips (or an N7d data-quality finding lands) an incident opens here with its timeline and downstream-impact. Add a monitor on the Monitors tab, or click Consume findings to fold existing data-quality findings in."
      />
    );
  }
  const active = incidents.find((i) => i.id === selectedId) || incidents[0];
  return (
    <SplitPane direction="horizontal" defaultSize="42%" minSize={260} storageKey="incident-console-split" dividerLabel="Resize incident list">
      <div className={styles.listPane}>
        {incidents.map((inc) => (
          <div
            key={inc.id}
            className={`${styles.row} ${inc.id === active?.id ? styles.rowActive : ''}`}
            onClick={() => onSelect(inc.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(inc.id); }}
          >
            <div className={styles.rowHead}>
              <span className={styles.rowTitle}>{inc.title}</span>
            </div>
            <div className={styles.badgeRow}>
              <Badge appearance="filled" color={SEV_COLOR[inc.severity]}>{inc.severity}</Badge>
              <Badge appearance="tint" color={STATUS_COLOR[inc.status]}>{inc.status}</Badge>
              <Badge appearance="outline">{inc.source === 'monitor' ? (inc.monitorKind || 'monitor') : 'data-quality'}</Badge>
              {inc.occurrences > 1 && <Caption1>×{inc.occurrences}</Caption1>}
              <Caption1>{fmt(inc.updatedAt)}</Caption1>
            </div>
          </div>
        ))}
      </div>
      <div className={styles.detailPane}>
        {active ? <IncidentDetail id={active.id} /> : <Body1>Select an incident.</Body1>}
      </div>
    </SplitPane>
  );
}

function IncidentDetail({ id }: { id: string }) {
  const styles = useStyles();
  const qc = useQueryClient();
  const detailQ = useQuery({ queryKey: ['incident', id], queryFn: () => getJson(`/api/observability/incidents/${encodeURIComponent(id)}`) });
  const incident: Incident | undefined = detailQ.data?.incident;
  const impact: Impact | undefined = detailQ.data?.impact;

  const transition = useMutation({
    mutationFn: (vars: { action: string; note?: string }) =>
      postJson(`/api/observability/incidents/${encodeURIComponent(id)}/transition`, vars),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['incident', id] }); qc.invalidateQueries({ queryKey: ['incidents'] }); },
  });

  if (detailQ.isLoading) return <Spinner label="Loading incident…" />;
  if (detailQ.isError) {
    return <FetchErrorBar title="Could not load this incident" error={detailQ.error} onRetry={() => void detailQ.refetch()} />;
  }
  if (!incident) return <MessageBar intent="error"><MessageBarBody>Incident not found.</MessageBarBody></MessageBar>;

  const m = incident.metric;
  return (
    <>
      <Card className={styles.card}>
        <div className={styles.badgeRow}>
          <Badge appearance="filled" color={SEV_COLOR[incident.severity]}>{incident.severity}</Badge>
          <Badge appearance="tint" color={STATUS_COLOR[incident.status]}>{incident.status}</Badge>
          <Badge appearance="outline">{incident.source === 'monitor' ? (incident.monitorKind || 'monitor') : 'data-quality'}</Badge>
          {incident.table && <Badge appearance="ghost">{incident.table}</Badge>}
        </div>
        <Title3>{incident.title}</Title3>
        <Body1>{incident.detail}</Body1>
        <div className={styles.actions}>
          <Button appearance="primary" disabled={incident.status !== 'open' || transition.isPending} onClick={() => transition.mutate({ action: 'acknowledge' })}>Acknowledge</Button>
          <Button disabled={incident.status === 'resolved' || transition.isPending} onClick={() => transition.mutate({ action: 'resolve' })}>Resolve</Button>
          <Button disabled={incident.status !== 'resolved' || transition.isPending} onClick={() => transition.mutate({ action: 'reopen' })}>Reopen</Button>
          {incident.runbookUrl && (
            <Button appearance="subtle" icon={<BookOpen20Regular />} as="a" href={`/${incident.runbookUrl}`.replace(/^\/+/, '/')} target="_blank" rel="noreferrer">Runbook →</Button>
          )}
        </div>
        {transition.data && transition.data._status >= 400 && (
          <MessageBar intent="warning"><MessageBarBody>{transition.data.error || 'Transition not allowed.'}</MessageBarBody></MessageBar>
        )}
      </Card>

      {m && (
        <Card className={styles.card}>
          <Subtitle2>Metric</Subtitle2>
          <div className={styles.metricGrid}>
            <div className={styles.metricCell}><Caption1>{m.name}</Caption1><Body1>{m.value}</Body1></div>
            {m.threshold != null && <div className={styles.metricCell}><Caption1>threshold</Caption1><Body1>{m.threshold}</Body1></div>}
            {m.baselineMean != null && <div className={styles.metricCell}><Caption1>baseline mean</Caption1><Body1>{m.baselineMean}</Body1></div>}
            {m.baselineStddev != null && <div className={styles.metricCell}><Caption1>baseline σ</Caption1><Body1>{m.baselineStddev}</Body1></div>}
            {m.zScore != null && <div className={styles.metricCell}><Caption1>z-score</Caption1><Body1>{m.zScore}</Body1></div>}
          </div>
          {incident.schemaChange && (incident.schemaChange.added.length > 0 || incident.schemaChange.removed.length > 0) && (
            <div className={styles.badgeRow}>
              {incident.schemaChange.added.map((c) => <Badge key={`a-${c}`} appearance="tint" color="success">+{c}</Badge>)}
              {incident.schemaChange.removed.map((c) => <Badge key={`r-${c}`} appearance="tint" color="danger">−{c}</Badge>)}
            </div>
          )}
        </Card>
      )}

      <Card className={styles.card}>
        <Subtitle2>Downstream impact</Subtitle2>
        {!impact ? (
          <Caption1>Lineage unavailable — no downstream impact could be resolved for this asset.</Caption1>
        ) : impact.downstreamCount === 0 ? (
          <Caption1>No downstream consumers found in the lineage graph.</Caption1>
        ) : (
          <div className={styles.impactList}>
            <Caption1>{impact.downstreamCount} downstream asset(s) affected:</Caption1>
            {impact.downstream.map((a) => (
              <div key={a.id} className={styles.impactItem}>
                <Badge appearance="ghost" color="informative">{a.hops}h</Badge>
                {a.type && <Badge appearance="outline">{a.type}</Badge>}
                {a.openHref ? (
                  <a href={a.openHref}><Body1>{a.label}</Body1> <Open16Regular /></a>
                ) : (
                  <Body1>{a.label}</Body1>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className={styles.card}>
        <Subtitle2>Timeline</Subtitle2>
        <div className={styles.timeline}>
          {[...incident.timeline].reverse().map((e, i) => (
            <div key={`${e.at}-${i}`} className={styles.tlEntry}>
              <Badge appearance="tint">{e.type}</Badge>
              <Caption1>{fmt(e.at)} · {e.by}</Caption1>
              {e.note && <span className={styles.tlNote}><Caption1>{e.note}</Caption1></span>}
            </div>
          ))}
        </div>
        <AddNote onAdd={(note) => transition.mutate({ action: 'note', note })} pending={transition.isPending} />
      </Card>
    </>
  );
}

function AddNote({ onAdd, pending }: { onAdd: (note: string) => void; pending: boolean }) {
  const [note, setNote] = useState('');
  return (
    <Field label="Add a note">
      <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
        <Input value={note} onChange={(_, d) => setNote(d.value)} placeholder="e.g. triaging — checked upstream pipeline" />
        <Button disabled={!note.trim() || pending} onClick={() => { onAdd(note.trim()); setNote(''); }}>Add</Button>
      </div>
    </Field>
  );
}

// ── Monitors tab ─────────────────────────────────────────────────────────────
function MonitorsTab() {
  const styles = useStyles();
  const qc = useQueryClient();
  const monQ = useQuery({ queryKey: ['monitors'], queryFn: () => getJson('/api/observability/monitors') });
  const monitors: Monitor[] = monQ.data?.monitors || [];
  const [newOpen, setNewOpen] = useState(false);
  const [observeFor, setObserveFor] = useState<Monitor | null>(null);

  if (monQ.isLoading) return <Spinner label="Loading monitors…" />;
  if (monQ.isError) {
    return <FetchErrorBar title="Could not load monitors" error={monQ.error} onRetry={() => void monQ.refetch()} />;
  }

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <Subtitle2>Table monitors</Subtitle2>
        <div className={styles.spacer} />
        <Button appearance="primary" icon={<Add20Regular />} onClick={() => setNewOpen(true)}>New monitor</Button>
      </div>
      {!monitors.length ? (
        <EmptyState
          icon={<Eye20Regular />}
          title="No monitors yet"
          body="Add a freshness, volume, or schema-drift monitor on a table. Baselines reuse the anomaly detector (no external ML), and a tripped monitor opens an incident with the downstream-impact panel."
          primaryAction={{ label: 'New monitor', onClick: () => setNewOpen(true) }}
        />
      ) : (
        <Table aria-label="Monitors" size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Table</TableHeaderCell>
              <TableHeaderCell>Kind</TableHeaderCell>
              <TableHeaderCell>Enabled</TableHeaderCell>
              <TableHeaderCell>Last value</TableHeaderCell>
              <TableHeaderCell>Last run</TableHeaderCell>
              <TableHeaderCell>Observations</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {monitors.map((mo) => (
              <TableRow key={mo.id}>
                <TableCell>{mo.table}</TableCell>
                <TableCell><Badge appearance="tint">{mo.kind}</Badge></TableCell>
                <TableCell>{mo.enabled ? <Badge color="success" appearance="tint">on</Badge> : <Badge color="subtle" appearance="tint">off</Badge>}</TableCell>
                <TableCell>{mo.lastValue ?? '—'}</TableCell>
                <TableCell>{fmt(mo.lastRunAt) || '—'}</TableCell>
                <TableCell>{mo.observations?.length ?? 0}</TableCell>
                <TableCell>
                  <Button size="small" icon={<ArrowSync20Regular />} onClick={() => setObserveFor(mo)}>Record</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {newOpen && <NewMonitorDialog onClose={() => setNewOpen(false)} onSaved={() => { setNewOpen(false); qc.invalidateQueries({ queryKey: ['monitors'] }); }} />}
      {observeFor && <ObserveDialog monitor={observeFor} onClose={() => setObserveFor(null)} onDone={() => { setObserveFor(null); qc.invalidateQueries({ queryKey: ['monitors'] }); qc.invalidateQueries({ queryKey: ['incidents'] }); }} />}
    </div>
  );
}

/**
 * The item types a monitor can be attached to. A CLOSED SET, because it is one:
 * the observe path reads a lakehouse's Delta tables, and `data-quality` items
 * carry the same table coordinates. It was a freeform `<Input>` pre-filled
 * "lakehouse", which let a typo create a monitor pointed at a type that does not
 * exist (#3734).
 */
const MONITOR_ITEM_TYPES = [
  { value: 'lakehouse', label: 'Lakehouse' },
  { value: 'data-quality', label: 'Data quality' },
] as const;

interface WorkspaceLite { id: string; displayName: string }
interface ItemLite { id: string; displayName: string }
interface DeltaTableLite { name: string; sizeBytes?: number | null }

/**
 * NEW MONITOR — a cascading picker over REAL data, not three raw text boxes.
 *
 * ── WHAT THIS REPLACED, AND WHY IT WAS A DEFECT (#3734) ─────────────────────
 *
 * The dialog used to be three freeform `<Input>`s: an "Item id" the operator had
 * to already know as a GUID, an "Item type" pre-filled `lakehouse` and freely
 * editable, and a "Table" they typed from memory as `catalog.schema.table`.
 * Nothing validated any of them, so a typo silently created a monitor that never
 * trips because it never matches a real table — the worst shape a monitor can
 * take, because it looks like coverage.
 *
 * `.claude/rules/auto-bind-by-default.md` names exactly this: a field asking the
 * user to type a resource id the platform could discover itself is "now a
 * DEFECT, not a compliant state".
 *
 * ── EVERY OPTION COMES FROM A REAL BACKEND CALL ─────────────────────────────
 *
 *   GET /api/workspaces                                       workspaces
 *   GET /api/items/<type>?workspaceId=…                        items of that type
 *   GET /api/marketplace/sharing/publishable-tables?…          a LIVE Delta scan
 *                                                              (ADLS listing +
 *                                                              _delta_log probe)
 *
 * The same three the `LakehouseTablePicker` precedent
 * (`lib/components/marketplace/share-publish-pickers.tsx`) uses. The cascade is
 * rebuilt here rather than imported because that component's `onSelect` hands
 * back the table plus the lakehouse NAME and never its item ID — and the item ID
 * is precisely the field this dialog was asking the operator to type.
 *
 * ── THE MANUAL PATH IS KEPT, AND IS SECONDARY ───────────────────────────────
 *
 * Behind an explicit "Enter identifiers manually" toggle, off by default. It
 * exists for the case the rule allows narrowly — a table Loom's Delta scan
 * cannot see (an external catalog, a view) — and it says so. It is not the
 * default, and it is not the only path.
 */
function NewMonitorDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const styles = useStyles();
  const [kind, setKind] = useState('freshness');
  const [itemType, setItemType] = useState<string>(MONITOR_ITEM_TYPES[0].value);
  const [sla, setSla] = useState('1440');

  // Picker state.
  const [manual, setManual] = useState(false);
  const [wsId, setWsId] = useState('');
  const [itemId, setItemId] = useState('');
  const [table, setTable] = useState('');

  const workspacesQ = useQuery({
    queryKey: ['monitor-picker', 'workspaces'],
    queryFn: async (): Promise<WorkspaceLite[]> => {
      const r = await clientFetch('/api/workspaces');
      const d: unknown = await r.json();
      const raw = Array.isArray(d) ? d : ((d as { workspaces?: unknown[] })?.workspaces || []);
      return (raw as Record<string, string>[]).map((w) => ({
        id: w.id,
        displayName: w.displayName || w.name || w.id,
      }));
    },
    enabled: !manual,
  });

  const itemsQ = useQuery({
    queryKey: ['monitor-picker', 'items', itemType, wsId],
    queryFn: async (): Promise<ItemLite[]> => {
      const r = await clientFetch(
        `/api/items/${encodeURIComponent(itemType)}?workspaceId=${encodeURIComponent(wsId)}`,
      );
      const d: { ok?: boolean; items?: Record<string, string>[]; error?: string } = await r.json();
      if (!d?.ok) throw new Error(d?.error || `Could not list ${itemType} items.`);
      return (d.items || []).map((i) => ({ id: i.id, displayName: i.displayName || i.id }));
    },
    enabled: !manual && Boolean(wsId),
  });

  const tablesQ = useQuery({
    queryKey: ['monitor-picker', 'tables', wsId, itemId],
    queryFn: async (): Promise<DeltaTableLite[]> => {
      const r = await clientFetch(
        `/api/marketplace/sharing/publishable-tables?lakehouseId=${encodeURIComponent(itemId)}` +
          `&workspaceId=${encodeURIComponent(wsId)}`,
      );
      const d: { ok?: boolean; tables?: DeltaTableLite[]; error?: string } = await r.json();
      if (!d?.ok) throw new Error(d?.error || 'Could not list Delta tables.');
      return d.tables || [];
    },
    enabled: !manual && Boolean(wsId) && Boolean(itemId),
  });

  const save = useMutation({
    mutationFn: () => postJson('/api/observability/monitors', {
      kind, itemId, itemType, table,
      ...(wsId ? { workspaceId: wsId } : {}),
      ...(kind === 'freshness' && sla ? { freshnessSlaMinutes: Number(sla) } : {}),
    }),
    onSuccess: (r) => { if (r._status < 400) onSaved(); },
  });

  const valid = Boolean(itemId.trim() && itemType.trim() && table.trim());
  const items = itemsQ.data ?? null;
  const tables = tablesQ.data ?? null;
  // The picker's own read failures are shown where they happened, never swallowed
  // into a disabled control the operator cannot explain (no-vaporware).
  const pickerError =
    (workspacesQ.error as Error | null)?.message
    || (itemsQ.error as Error | null)?.message
    || (tablesQ.error as Error | null)?.message
    || null;

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>New monitor</DialogTitle>
          <DialogContent>
            <div className={styles.formGrid}>
              <Field label="Kind">
                <Dropdown value={kind} selectedOptions={[kind]} onOptionSelect={(_, d) => setKind((d.optionValue as string) || 'freshness')}>
                  <Option value="freshness">Freshness</Option>
                  <Option value="volume">Volume</Option>
                  <Option value="schema-drift">Schema drift</Option>
                </Dropdown>
              </Field>

              <Field label="Item type">
                <Dropdown
                  value={MONITOR_ITEM_TYPES.find((t) => t.value === itemType)?.label || ''}
                  selectedOptions={[itemType]}
                  onOptionSelect={(_, d) => {
                    setItemType((d.optionValue as string) || MONITOR_ITEM_TYPES[0].value);
                    // The cascade below is keyed to the type — a stale item id
                    // from the previous type would be a silently wrong monitor.
                    setItemId('');
                    setTable('');
                  }}
                >
                  {MONITOR_ITEM_TYPES.map((t) => <Option key={t.value} value={t.value}>{t.label}</Option>)}
                </Dropdown>
              </Field>

              {manual ? (
                <>
                  <MessageBar intent="warning" layout="multiline">
                    <MessageBarBody>
                      <MessageBarTitle>Manual entry — nothing here is validated</MessageBarTitle>
                      An id or table name that does not match a real object creates a monitor
                      that never trips. Use this only for a table Loom&apos;s Delta scan cannot
                      see.
                    </MessageBarBody>
                  </MessageBar>
                  <Field label="Item id" required>
                    <Input value={itemId} onChange={(_, d) => setItemId(d.value)} placeholder="the lakehouse / data-quality item id" />
                  </Field>
                  <Field label="Table" required>
                    <Input value={table} onChange={(_, d) => setTable(d.value)} placeholder="catalog.schema.table" />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Workspace" required>
                    <Dropdown
                      placeholder={workspacesQ.isPending ? 'Loading workspaces…' : 'Select a workspace…'}
                      disabled={workspacesQ.isPending}
                      value={(workspacesQ.data || []).find((w) => w.id === wsId)?.displayName || ''}
                      selectedOptions={wsId ? [wsId] : []}
                      onOptionSelect={(_, d) => { setWsId(d.optionValue || ''); setItemId(''); setTable(''); }}
                    >
                      {(workspacesQ.data || []).map((w) => <Option key={w.id} value={w.id}>{w.displayName}</Option>)}
                    </Dropdown>
                  </Field>

                  <Field label="Item" required hint="Listed from this tenant's real catalog — the id is resolved for you.">
                    <Dropdown
                      placeholder={!wsId ? 'Pick a workspace first' : itemsQ.isPending ? 'Loading items…' : 'Select an item…'}
                      disabled={!wsId || itemsQ.isPending}
                      value={(items || []).find((i) => i.id === itemId)?.displayName || ''}
                      selectedOptions={itemId ? [itemId] : []}
                      onOptionSelect={(_, d) => { setItemId(d.optionValue || ''); setTable(''); }}
                    >
                      {(items || []).map((i) => <Option key={i.id} value={i.id}>{i.displayName}</Option>)}
                    </Dropdown>
                  </Field>

                  <Field label="Table" required hint="Scanned live from the item's own storage — only real Delta tables are listed.">
                    <Dropdown
                      placeholder={!itemId ? 'Pick an item first' : tablesQ.isPending ? 'Scanning for Delta tables…' : 'Select a table…'}
                      disabled={!itemId || tablesQ.isPending || !(tables || []).length}
                      value={table}
                      selectedOptions={table ? [table] : []}
                      onOptionSelect={(_, d) => setTable(d.optionValue || '')}
                    >
                      {(tables || []).map((t) => <Option key={t.name} value={t.name}>{t.name}</Option>)}
                    </Dropdown>
                  </Field>

                  {itemId && !tablesQ.isPending && tables !== null && tables.length === 0 && !pickerError && (
                    <MessageBar intent="warning" layout="multiline">
                      <MessageBarBody>
                        <MessageBarTitle>No Delta tables under this item</MessageBarTitle>
                        The scan reached the item&apos;s storage and found none. Pick another item,
                        or switch to manual entry for a table Loom cannot enumerate.
                      </MessageBarBody>
                    </MessageBar>
                  )}
                </>
              )}

              {pickerError && !manual && (
                <MessageBar intent="warning" layout="multiline">
                  <MessageBarBody>
                    <MessageBarTitle>Could not finish the lookup</MessageBarTitle>
                    {pickerError} You can still create this monitor with manual entry.
                  </MessageBarBody>
                </MessageBar>
              )}

              <Button
                appearance="transparent"
                onClick={() => { setManual((m) => !m); setItemId(''); setTable(''); }}
              >
                {manual ? 'Back to picking from the catalog' : 'Enter identifiers manually'}
              </Button>

              {kind === 'freshness' && <Field label="Freshness SLA (minutes)"><Input type="number" value={sla} onChange={(_, d) => setSla(d.value)} /></Field>}
              {save.data && save.data._status >= 400 && <MessageBar intent="error"><MessageBarBody>{save.data.error || 'Save failed.'}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Create monitor'}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function ObserveDialog({ monitor, onClose, onDone }: { monitor: Monitor; onClose: () => void; onDone: () => void }) {
  const styles = useStyles();
  const [value, setValue] = useState('');
  const [columns, setColumns] = useState('');
  const run = useMutation({
    mutationFn: () => postJson(`/api/observability/monitors/${encodeURIComponent(monitor.id)}/observe`, {
      value: Number(value),
      ...(monitor.kind === 'schema-drift' && columns.trim() ? { columns: columns.split(',').map((c) => c.trim()).filter(Boolean) } : {}),
    }),
    onSuccess: (r) => { if (r._status < 400) onDone(); },
  });
  const verdict = run.data?.verdict;
  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Record observation — {monitor.kind} on {monitor.table}</DialogTitle>
          <DialogContent>
            <div className={styles.formGrid}>
              <Field label={monitor.kind === 'freshness' ? 'Data age (minutes)' : monitor.kind === 'volume' ? 'Row count' : 'Column count'} required>
                <Input type="number" value={value} onChange={(_, d) => setValue(d.value)} />
              </Field>
              {monitor.kind === 'schema-drift' && (
                <Field label="Columns (comma-separated)"><Textarea value={columns} onChange={(_, d) => setColumns(d.value)} placeholder="id, name, amount, updated_at" /></Field>
              )}
              {verdict && (
                <MessageBar intent={verdict.tripped ? (verdict.severity === 'error' ? 'error' : 'warning') : 'success'}>
                  <MessageBarBody>
                    <MessageBarTitle>{verdict.tripped ? 'Monitor tripped' : 'Healthy'}</MessageBarTitle>
                    {verdict.detail}
                    {run.data?.incidentId ? ` — incident opened.` : ''}
                  </MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Close</Button>
            <Button appearance="primary" disabled={!value.trim() || run.isPending} onClick={() => run.mutate()}>{run.isPending ? 'Evaluating…' : 'Record & evaluate'}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
