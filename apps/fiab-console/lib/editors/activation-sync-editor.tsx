'use client';

/**
 * ActivationSyncEditor — the reverse-ETL / activation-sync item (N7c).
 *
 * Pushes a modeled dataset OUT to operational systems: Dataverse/Dynamics first
 * (the estate's S2S app is already wired), plus a webhook, an Event Grid custom
 * topic, or a Service Bus queue/topic. FULL or INCREMENTAL (Delta Change Data
 * Feed) with idempotent upserts and a real, persisted run history. Scheduling
 * rides Loom's software-defined-asset triggers (bind the sync to the source
 * asset in the Assets canvas) — there is no parallel scheduler here.
 *
 * Every config surface is dropdowns / pickers (loom_no_freeform_config): the
 * source is browsed from the lake, the Dataverse destination is picked from live
 * environments + tables, and field mappings pick real source columns → real
 * destination fields. No Fabric dependency; the lake read runs on the in-boundary
 * DuckDB tier. FLAG0 `n7c-activation-sync` reverts the whole surface when off.
 *
 * Fluent v9 + Loom tokens only (web3-ui.md).
 */

import { clientFetch } from '@/lib/client-fetch';
import {
  Subtitle2, Caption1, Button, Badge, Spinner, Skeleton, SkeletonItem, Divider, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle, Field, Dropdown, Option, Input, RadioGroup, Radio,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell, Tab, TabList,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  SettingsRegular, HistoryRegular, ArrowRepeatAll20Regular, DatabaseArrowUp20Regular,
  Table20Regular, Cloud20Regular, Add20Regular, Delete20Regular, PlayRegular, Flowchart20Regular,
  Key20Regular,
} from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ItemEditorChrome } from './item-editor-chrome';
import { NewItemCreateGate } from './new-item-gate';
import { EmptyState } from '@/lib/components/empty-state';
import { GuidedEmptyState } from '@/lib/components/shared/guided-empty-state';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { useRegisterRibbonCommands } from '@/lib/components/shared/ribbon-commands';
import { useRuntimeFlag } from '@/lib/components/ui/use-runtime-flag';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import {
  ACTIVATION_SOURCE_KINDS, ACTIVATION_DESTINATION_KINDS,
  type ActivationSyncSpec, type ActivationSourceKind, type ActivationDestinationKind,
  type ActivationDestination, type FieldMapping, type ActivationMode, type ActivationRun,
} from '@/lib/activation/types';

export const ACTIVATION_SYNC_FLAG_ID = 'n7c-activation-sync';

const useStyles = makeStyles({
  tabBar: {
    paddingTop: tokens.spacingVerticalS, paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL, paddingBottom: 0,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  body: { padding: tokens.spacingVerticalXL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, maxWidth: '960px' },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusXLarge, padding: tokens.spacingVerticalM,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4, transitionProperty: 'box-shadow', transitionDuration: tokens.durationNormal,
    ':hover': { boxShadow: tokens.shadow8 },
  },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, color: tokens.colorNeutralForeground2, flexWrap: 'wrap', minWidth: 0 },
  sectionIcon: { color: tokens.colorBrandForeground1, display: 'inline-flex', fontSize: tokens.fontSizeBase400 },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap', minWidth: 0 },
  grow: { flex: 1, minWidth: '220px' },
  mapRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 },
  mono: { fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200, minWidth: 0, overflowWrap: 'anywhere' },
  label: { color: tokens.colorNeutralForeground3 },
  crumbs: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', alignItems: 'center' },
  folderList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, maxHeight: '220px', overflowY: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingVerticalXS },
  folderBtn: { justifyContent: 'flex-start' },
});

// ── data helpers ────────────────────────────────────────────────────────────

interface ItemDTO { id: string; workspaceId: string; displayName: string; state?: Record<string, any> }

function useItem(id: string) {
  const [item, setItem] = useState<ItemDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async () => {
    if (!id || id === 'new') return;
    setLoading(true); setError(null);
    try {
      const r = await clientFetch(`/api/items/activation-sync/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'load failed');
      setItem(j.item);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { reload(); }, [reload]);
  return { item, error, loading, reload };
}

async function saveSpec(id: string, spec: ActivationSyncSpec): Promise<void> {
  const r = await clientFetch(`/api/items/activation-sync/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: spec }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'save failed');
}

function fmtTs(ts?: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

const SOURCE_KIND_LABEL: Record<ActivationSourceKind, string> = { table: 'Table', model: 'Model', audience: 'Audience / segment' };
const DEST_KIND_LABEL: Record<ActivationDestinationKind, string> = {
  dataverse: 'Dataverse / Dynamics', webhook: 'Webhook', 'event-grid': 'Event Grid', 'service-bus': 'Service Bus',
};

function emptySpec(): ActivationSyncSpec { return { mapping: [], mode: 'full', runs: [] }; }

// ── source lake browser (no freeform path) ───────────────────────────────────

interface PathEntry { name: string; isDirectory: boolean }

function SourcePicker({ spec, onChange }: { spec: ActivationSyncSpec; onChange: (s: ActivationSyncSpec) => void }) {
  const styles = useStyles();
  const [containers, setContainers] = useState<string[]>([]);
  const [container, setContainer] = useState<string>(spec.source?.container || '');
  const [prefix, setPrefix] = useState<string>('');
  const [entries, setEntries] = useState<PathEntry[]>([]);
  const [gate, setGate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await clientFetch('/api/items/dataset/browse');
        const j = await r.json();
        if (j.ok && Array.isArray(j.containers)) setContainers(j.containers.map((c: any) => c.name));
        else if (j.gate) setGate(j.gate.remediation || j.gate.reason);
      } catch (e: any) { setGate(e?.message || String(e)); }
    })();
  }, []);

  const listAt = useCallback(async (c: string, p: string) => {
    if (!c) return;
    setBusy(true); setGate(null);
    try {
      const r = await clientFetch(`/api/items/dataset/browse?container=${encodeURIComponent(c)}&prefix=${encodeURIComponent(p)}`);
      const j = await r.json();
      if (!j.ok) { setGate(j.error || 'browse failed'); setEntries([]); }
      else setEntries((j.paths || []).map((x: any) => ({ name: x.name, isDirectory: x.isDirectory })));
    } catch (e: any) { setGate(e?.message || String(e)); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { if (container) listAt(container, prefix); }, [container, prefix, listAt]);

  const crumbSegs = prefix ? prefix.split('/').filter(Boolean) : [];
  const selectTable = (tablePath: string) => {
    onChange({ ...spec, source: { kind: spec.source?.kind || 'table', container, path: tablePath, label: tablePath.split('/').pop() } });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
      {gate && (
        <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Lake not reachable</MessageBarTitle>{gate}</MessageBarBody></MessageBar>
      )}
      <div className={styles.row}>
        <Field label="Source kind" className={styles.grow}>
          <Dropdown
            value={SOURCE_KIND_LABEL[spec.source?.kind || 'table']}
            selectedOptions={[spec.source?.kind || 'table']}
            onOptionSelect={(_, d) => onChange({ ...spec, source: { kind: (d.optionValue as ActivationSourceKind) || 'table', container: spec.source?.container || '', path: spec.source?.path || '' } })}
          >
            {ACTIVATION_SOURCE_KINDS.map((k) => <Option key={k} value={k} text={SOURCE_KIND_LABEL[k]}>{SOURCE_KIND_LABEL[k]}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Container" className={styles.grow}>
          <Dropdown
            placeholder="Pick a lake container"
            value={container}
            selectedOptions={container ? [container] : []}
            onOptionSelect={(_, d) => { setContainer(d.optionValue || ''); setPrefix(''); }}
          >
            {containers.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
          </Dropdown>
        </Field>
      </div>
      {container && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
          <div className={styles.crumbs}>
            <Button size="small" appearance="subtle" onClick={() => setPrefix('')}>{container}</Button>
            {crumbSegs.map((seg, i) => (
              <Button key={i} size="small" appearance="subtle" onClick={() => setPrefix(crumbSegs.slice(0, i + 1).join('/'))}>/ {seg}</Button>
            ))}
            {busy && <Spinner size="tiny" />}
          </div>
          <div className={styles.folderList}>
            {entries.length === 0 && !busy && <Caption1 className={styles.label}>No folders here.</Caption1>}
            {entries.filter((e) => e.isDirectory).map((e) => {
              const seg = e.name.split('/').filter(Boolean).pop() || e.name;
              const full = e.name.replace(/^\/+|\/+$/g, '');
              return (
                <div key={e.name} className={styles.mapRow}>
                  <Button size="small" appearance="subtle" className={styles.folderBtn} icon={<Table20Regular />} onClick={() => setPrefix(full)}>{seg}</Button>
                  <Button size="small" appearance="primary" onClick={() => selectTable(full)}>Use as source table</Button>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {spec.source?.path && (
        <Caption1>Selected: <span className={styles.mono}>{spec.source.container}/{spec.source.path}</span></Caption1>
      )}
    </div>
  );
}

// ── destination picker ───────────────────────────────────────────────────────

interface EnvDTO { name: string; displayName: string }
interface TableDTO { LogicalName: string; EntitySetName?: string; DisplayName?: { UserLocalizedLabel?: { Label?: string } } }

function DestinationPicker({ spec, onChange }: { spec: ActivationSyncSpec; onChange: (s: ActivationSyncSpec) => void }) {
  const styles = useStyles();
  const dest = spec.destination;
  const kind: ActivationDestinationKind = dest?.kind || 'dataverse';
  const [envs, setEnvs] = useState<EnvDTO[]>([]);
  const [tables, setTables] = useState<TableDTO[]>([]);
  const [gate, setGate] = useState<string | null>(null);

  const dv = dest?.kind === 'dataverse' ? dest : undefined;

  useEffect(() => {
    if (kind !== 'dataverse') return;
    (async () => {
      try {
        const r = await clientFetch('/api/powerplatform/environments');
        const j = await r.json();
        if (j.ok) setEnvs(j.environments || []);
        else setGate(j.error || `Set ${j.missing || 'LOOM_UAMI_CLIENT_ID'} to list environments.`);
      } catch (e: any) { setGate(e?.message || String(e)); }
    })();
  }, [kind]);

  useEffect(() => {
    if (kind !== 'dataverse' || !dv?.environmentId) return;
    (async () => {
      try {
        const r = await clientFetch(`/api/powerplatform/tables?envId=${encodeURIComponent(dv.environmentId)}`);
        const j = await r.json();
        if (j.ok) setTables(j.tables || []);
        else setGate(j.error || 'Could not list Dataverse tables.');
      } catch (e: any) { setGate(e?.message || String(e)); }
    })();
  }, [kind, dv?.environmentId]);

  const setDest = (d: ActivationDestination) => onChange({ ...spec, destination: d });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
      <Field label="Destination">
        <Dropdown
          value={DEST_KIND_LABEL[kind]}
          selectedOptions={[kind]}
          onOptionSelect={(_, d) => {
            const k = (d.optionValue as ActivationDestinationKind) || 'dataverse';
            if (k === 'dataverse') setDest({ kind: 'dataverse', environmentId: '', entitySetName: '', keyAttribute: '' });
            else if (k === 'webhook') setDest({ kind: 'webhook', url: '' });
            else if (k === 'event-grid') setDest({ kind: 'event-grid', topicEndpoint: '' });
            else setDest({ kind: 'service-bus', namespace: '', entity: '' });
          }}
        >
          {ACTIVATION_DESTINATION_KINDS.map((k) => <Option key={k} value={k} text={DEST_KIND_LABEL[k]}>{DEST_KIND_LABEL[k]}</Option>)}
        </Dropdown>
      </Field>

      {gate && kind === 'dataverse' && (
        <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Dataverse not reachable</MessageBarTitle>{gate}</MessageBarBody></MessageBar>
      )}

      {kind === 'dataverse' && (
        <>
          <div className={styles.row}>
            <Field label="Environment" className={styles.grow}>
              <Dropdown
                placeholder="Pick an environment"
                value={envs.find((e) => e.name === dv?.environmentId)?.displayName || ''}
                selectedOptions={dv?.environmentId ? [dv.environmentId] : []}
                onOptionSelect={(_, d) => setDest({ kind: 'dataverse', environmentId: d.optionValue || '', entitySetName: '', keyAttribute: '' })}
              >
                {envs.map((e) => <Option key={e.name} value={e.name} text={e.displayName}>{e.displayName}</Option>)}
              </Dropdown>
            </Field>
            <Field label="Table" className={styles.grow}>
              <Dropdown
                placeholder="Pick a table"
                value={tables.find((t) => t.EntitySetName === dv?.entitySetName)?.LogicalName || dv?.entitySetName || ''}
                selectedOptions={dv?.entitySetName ? [dv.entitySetName] : []}
                onOptionSelect={(_, d) => {
                  // New table ⇒ reset the key attribute (it must belong to this table).
                  setDest({ kind: 'dataverse', environmentId: dv?.environmentId || '', entitySetName: d.optionValue || '', keyAttribute: '' });
                }}
              >
                {tables.map((t) => (
                  <Option key={t.LogicalName} value={t.EntitySetName || t.LogicalName} text={t.LogicalName}>
                    {t.DisplayName?.UserLocalizedLabel?.Label || t.LogicalName} ({t.EntitySetName || t.LogicalName})
                  </Option>
                ))}
              </Dropdown>
            </Field>
          </div>
          <Caption1 className={styles.label}>The key attribute (an alternate key or the primary column) makes upserts idempotent — pick it in the Mapping section below.</Caption1>
        </>
      )}

      {kind === 'webhook' && (
        <Field label="Webhook URL (https)" validationMessage={dest?.kind === 'webhook' && dest.url && !/^https:\/\//i.test(dest.url) ? 'Must be an https URL' : undefined}>
          <Input value={dest?.kind === 'webhook' ? dest.url : ''} placeholder="https://example.com/hooks/activation"
            onChange={(_, d) => setDest({ kind: 'webhook', url: d.value })} />
        </Field>
      )}
      {kind === 'event-grid' && (
        <Field label="Event Grid topic endpoint (https)">
          <Input value={dest?.kind === 'event-grid' ? dest.topicEndpoint : ''} placeholder="https://<topic>.<region>.eventgrid.azure.net/api/events"
            onChange={(_, d) => setDest({ kind: 'event-grid', topicEndpoint: d.value, eventType: dest?.kind === 'event-grid' ? dest.eventType : undefined })} />
        </Field>
      )}
      {kind === 'service-bus' && (
        <div className={styles.row}>
          <Field label="Namespace" className={styles.grow}>
            <Input value={dest?.kind === 'service-bus' ? dest.namespace : ''} placeholder="<ns>.servicebus.windows.net"
              onChange={(_, d) => setDest({ kind: 'service-bus', namespace: d.value, entity: dest?.kind === 'service-bus' ? dest.entity : '' })} />
          </Field>
          <Field label="Queue / topic" className={styles.grow}>
            <Input value={dest?.kind === 'service-bus' ? dest.entity : ''} placeholder="activation-queue"
              onChange={(_, d) => setDest({ kind: 'service-bus', namespace: dest?.kind === 'service-bus' ? dest.namespace : '', entity: d.value })} />
          </Field>
        </div>
      )}
      {kind !== 'dataverse' && (
        <Caption1 className={styles.label}>Webhook / Event Grid / Service Bus destinations run air-gapped in IL5 when the endpoint is in-boundary; a public SaaS webhook is honest-gated by reachability. Rows carry a stable dedup id for idempotency.</Caption1>
      )}
    </div>
  );
}

// ── mapping ──────────────────────────────────────────────────────────────────

interface ColDTO { name: string; type?: string }
interface FieldDTO { name: string; label?: string; type?: string }

function MappingPanel({
  spec, onChange, id,
}: { spec: ActivationSyncSpec; onChange: (s: ActivationSyncSpec) => void; id: string }) {
  const styles = useStyles();
  const [cols, setCols] = useState<ColDTO[]>([]);
  const [targets, setTargets] = useState<FieldDTO[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const isDv = spec.destination?.kind === 'dataverse';

  // Source columns
  useEffect(() => {
    if (!spec.source?.container || !spec.source?.path) return;
    (async () => {
      const q = new URLSearchParams({ container: spec.source!.container, path: spec.source!.path });
      const r = await clientFetch(`/api/items/activation-sync/${encodeURIComponent(id)}/schema?${q.toString()}`);
      const j = await r.json().catch(() => ({}));
      if (Array.isArray(j.sourceColumns)) setCols(j.sourceColumns);
      if (j.sourceError) setNote(j.sourceError);
    })();
  }, [id, spec.source?.container, spec.source?.path]);

  // Dataverse target fields — resolve logicalName from entitySetName via tables list is
  // already known, but we can query schema by logicalName. The tables route gives
  // LogicalName; here we approximate logicalName from entitySetName (singular) is
  // unreliable, so we ask the schema route with envId + logicalName the picker set.
  useEffect(() => {
    if (!isDv || spec.destination?.kind !== 'dataverse') return;
    const dv = spec.destination;
    if (!dv.environmentId || !dv.entitySetName) return;
    (async () => {
      // entitySetName plural → logicalName: fetch the tables list to resolve.
      const tr = await clientFetch(`/api/powerplatform/tables?envId=${encodeURIComponent(dv.environmentId)}`);
      const tj = await tr.json().catch(() => ({}));
      const match = (tj.tables || []).find((t: any) => t.EntitySetName === dv.entitySetName);
      const logicalName = match?.LogicalName;
      if (!logicalName) return;
      const q = new URLSearchParams({ envId: dv.environmentId, logicalName });
      const r = await clientFetch(`/api/items/activation-sync/${encodeURIComponent(id)}/schema?${q.toString()}`);
      const j = await r.json().catch(() => ({}));
      if (Array.isArray(j.targetFields)) setTargets(j.targetFields);
      if (j.targetError) setNote(j.targetError);
    })();
  }, [id, isDv, spec.destination]);

  const mapping = spec.mapping || [];
  const setMapping = (m: FieldMapping[]) => onChange({ ...spec, mapping: m });
  const addRow = () => setMapping([...mapping, { source: '', target: '' }]);
  const rmRow = (i: number) => setMapping(mapping.filter((_, idx) => idx !== i));
  const setRow = (i: number, patch: Partial<FieldMapping>) => setMapping(mapping.map((m, idx) => idx === i ? { ...m, ...patch } : m));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
      {note && <MessageBar intent="info"><MessageBarBody>{note}</MessageBarBody></MessageBar>}

      <Field label="Key column (fills the destination key for idempotent upserts)">
        <Dropdown
          placeholder="Pick a source column"
          value={spec.keyColumn || ''}
          selectedOptions={spec.keyColumn ? [spec.keyColumn] : []}
          onOptionSelect={(_, d) => onChange({ ...spec, keyColumn: d.optionValue || undefined })}
        >
          {cols.map((c) => <Option key={c.name} value={c.name} text={c.name}>{c.name}{c.type ? ` (${c.type})` : ''}</Option>)}
        </Dropdown>
      </Field>

      {isDv && spec.destination?.kind === 'dataverse' && (
        <Field label="Dataverse key attribute (alternate key / primary column)">
          <Dropdown
            placeholder="Pick the destination key attribute"
            value={spec.destination.keyAttribute || ''}
            selectedOptions={spec.destination.keyAttribute ? [spec.destination.keyAttribute] : []}
            onOptionSelect={(_, d) => {
              const dv = spec.destination as any;
              onChange({ ...spec, destination: { ...dv, keyAttribute: d.optionValue || '' } });
            }}
          >
            {targets.map((t) => <Option key={t.name} value={t.name} text={t.name}>{t.label || t.name}</Option>)}
          </Dropdown>
        </Field>
      )}

      <Divider />
      <div className={styles.sectionHeader}>
        <Subtitle2>Field mapping</Subtitle2>
        <Button size="small" appearance="secondary" icon={<Add20Regular />} onClick={addRow}>Add mapping</Button>
      </div>
      {mapping.length === 0 && (
        <Caption1 className={styles.label}>
          {isDv ? 'Map at least one source column to a Dataverse field.' : 'With no mappings, all source columns are sent as-is. Add mappings to rename or select a subset.'}
        </Caption1>
      )}
      {mapping.map((m, i) => (
        <div key={i} className={styles.mapRow}>
          <Field label={i === 0 ? 'Source column' : undefined} className={styles.grow}>
            <Dropdown placeholder="Source column" value={m.source} selectedOptions={m.source ? [m.source] : []}
              onOptionSelect={(_, d) => setRow(i, { source: d.optionValue || '', ...(isDv ? {} : { target: d.optionValue || '' }) })}>
              {cols.map((c) => <Option key={c.name} value={c.name} text={c.name}>{c.name}</Option>)}
            </Dropdown>
          </Field>
          <span aria-hidden style={{ color: tokens.colorNeutralForeground3 }}>→</span>
          <Field label={i === 0 ? 'Destination field' : undefined} className={styles.grow}>
            {isDv ? (
              <Dropdown placeholder="Destination field" value={m.target} selectedOptions={m.target ? [m.target] : []}
                onOptionSelect={(_, d) => setRow(i, { target: d.optionValue || '' })}>
                {targets.map((t) => <Option key={t.name} value={t.name} text={t.name}>{t.label || t.name}</Option>)}
              </Dropdown>
            ) : (
              <Input value={m.target} readOnly aria-label="Destination field (same as source)" />
            )}
          </Field>
          <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label="Remove mapping" onClick={() => rmRow(i)} />
        </div>
      ))}
    </div>
  );
}

// ── main editor ──────────────────────────────────────────────────────────────

export function ActivationSyncEditor({ item, id }: { item: FabricItemType; id: string }) {
  const styles = useStyles();
  const enabled = useRuntimeFlag(ACTIVATION_SYNC_FLAG_ID);
  const { item: cosmosItem, error: loadError, loading, reload } = useItem(id);

  const [tab, setTab] = useState<'settings' | 'runs'>('settings');
  const [draft, setDraft] = useState<ActivationSyncSpec>(emptySpec());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [runs, setRuns] = useState<ActivationRun[]>([]);

  useEffect(() => {
    if (cosmosItem?.state) {
      const s = cosmosItem.state as ActivationSyncSpec;
      setDraft({ mapping: [], mode: 'full', ...s, runs: s.runs || [] });
      setRuns(s.runs || []);
    }
  }, [cosmosItem]);

  const loadRuns = useCallback(async () => {
    if (id === 'new') return;
    try {
      const r = await clientFetch(`/api/items/activation-sync/${encodeURIComponent(id)}/runs`);
      const j = await r.json();
      if (j.ok) setRuns(j.runs || []);
    } catch { /* non-fatal */ }
  }, [id]);

  const configured = !!draft.source?.path && !!draft.destination
    && (draft.destination.kind !== 'dataverse' || (!!draft.destination.environmentId && !!draft.destination.entitySetName));

  const onSave = useCallback(async () => {
    setBusy(true); setErr(null); setOkMsg(null);
    try {
      await saveSpec(id, draft);
      await reload();
      setOkMsg('Saved.');
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [id, draft, reload]);

  const run = useCallback(async (mode: ActivationMode) => {
    setBusy(true); setErr(null); setOkMsg(null);
    try {
      await saveSpec(id, draft); // persist latest config before running
      const r = await clientFetch(`/api/items/activation-sync/${encodeURIComponent(id)}/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }),
      });
      const j = await r.json();
      if (!j.ok && !j.run) throw new Error(j.error || 'run failed');
      const rr: ActivationRun | undefined = j.run;
      setOkMsg(rr ? `Run ${rr.status}: ${rr.upserts} upsert, ${rr.deletes} delete, ${rr.errors} error.` : 'Run started.');
      setTab('runs');
      await loadRuns();
      await reload();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [id, draft, loadRuns, reload]);

  const bindTrigger = useCallback(async () => {
    setBusy(true); setErr(null); setOkMsg(null);
    try {
      await saveSpec(id, draft); // ensure the source is persisted before binding
      const r = await clientFetch(`/api/items/activation-sync/${encodeURIComponent(id)}/bind-trigger`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'bind failed');
      setOkMsg('Bound to the source asset — a data-change on the source now triggers an incremental sync.');
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [id, draft]);

  const canRun = !busy && configured;
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Save', actions: [{ label: 'Save', onClick: busy ? undefined : onSave, disabled: busy }] },
      { label: 'Run', actions: [
        { label: busy ? 'Running…' : 'Run full', onClick: canRun ? () => run('full') : undefined, disabled: !canRun },
        { label: 'Run incremental (CDF)', onClick: canRun ? () => run('incremental') : undefined, disabled: !canRun },
        { label: 'Refresh runs', onClick: busy ? undefined : loadRuns, disabled: busy },
      ]},
    ]},
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [busy, canRun, onSave, run, loadRuns]);
  useRegisterRibbonCommands(ribbon, 'activation-sync');

  if (id === 'new') {
    return (
      <NewItemCreateGate item={item} createLabel="Create activation sync"
        intro="An Activation sync (reverse ETL) pushes a modeled table, model, or audience OUT to Dataverse/Dynamics, a webhook, Event Grid, or Service Bus — full or incremental (Delta Change Data Feed), with idempotent upserts. Create it, then pick a source, a destination, and a field mapping." />
    );
  }

  if (!enabled) {
    return (
      <ItemEditorChrome item={item} id={id} ribbon={[]} main={
        <div className={styles.body}>
          <MessageBar intent="warning"><MessageBarBody>
            <MessageBarTitle>Activation sync is turned off</MessageBarTitle>
            An administrator has disabled this surface with the n7c-activation-sync runtime flag. The API routes, already-created items and the asset-trigger binding keep working; turn the flag back on in Admin → Runtime flags to restore the editor.
          </MessageBarBody></MessageBar>
        </div>
      } />
    );
  }

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} commandSearch main={
      <div>
        <div className={styles.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'settings' | 'runs')}>
            <Tab value="settings" icon={<SettingsRegular />}>Settings</Tab>
            <Tab value="runs" icon={<HistoryRegular />}>Runs</Tab>
          </TabList>
        </div>

        <div className={styles.body}>
          {(err || loadError) && (
            <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Operation failed</MessageBarTitle>{err || loadError}</MessageBarBody></MessageBar>
          )}
          {okMsg && <MessageBar intent="success"><MessageBarBody>{okMsg}</MessageBarBody></MessageBar>}
          {loading && (
            <div className={styles.card}><Skeleton aria-label="Loading…"><SkeletonItem size={16} style={{ width: '40%' }} /><SkeletonItem size={12} /><SkeletonItem size={12} style={{ width: '70%' }} /></Skeleton></div>
          )}

          {tab === 'settings' && (
            <>
              <TeachingBanner
                surfaceKey="activation-sync"
                title="Activate modeled data into your operational systems"
                message="Pick a source (a lake table, model, or audience), a destination (Dataverse/Dynamics first, plus webhook / Event Grid / Service Bus), and map source columns to destination fields. Run full or incremental (Delta Change Data Feed); upserts are idempotent. Bind the sync to a software-defined asset in the Assets canvas so a data-change on the source triggers it automatically."
                learnMoreHref="https://learn.microsoft.com/azure/databricks/delta/delta-change-data-feed"
              />

              {!configured && (
                <GuidedEmptyState
                  heroIcon={ArrowRepeatAll20Regular}
                  title="Set up your activation sync"
                  intro="Three steps: choose what to activate, where it goes, and how the columns map."
                  ariaLabel="Activation sync setup"
                  paths={[
                    { key: 'source', title: 'Pick a source', body: 'A modeled table, model, or audience from your lake.', icon: DatabaseArrowUp20Regular, onClick: () => setTab('settings') },
                    { key: 'dest', title: 'Pick a destination', body: 'Dataverse/Dynamics, a webhook, Event Grid, or Service Bus.', icon: Cloud20Regular, onClick: () => setTab('settings') },
                    { key: 'map', title: 'Map fields', body: 'Source columns → destination fields, with a key for upserts.', icon: Key20Regular, onClick: () => setTab('settings') },
                  ]}
                  learnMoreHref="https://learn.microsoft.com/power-apps/developer/data-platform/webapi/update-delete-entities-using-web-api#upsert-a-record"
                  learnMoreLabel="Learn about reverse ETL"
                />
              )}

              <div className={styles.card}>
                <div className={styles.sectionHeader}><DatabaseArrowUp20Regular className={styles.sectionIcon} aria-hidden /><Subtitle2>Source</Subtitle2></div>
                <SourcePicker spec={draft} onChange={setDraft} />
              </div>

              <div className={styles.card}>
                <div className={styles.sectionHeader}><Cloud20Regular className={styles.sectionIcon} aria-hidden /><Subtitle2>Destination</Subtitle2></div>
                <DestinationPicker spec={draft} onChange={setDraft} />
              </div>

              <div className={styles.card}>
                <div className={styles.sectionHeader}><Key20Regular className={styles.sectionIcon} aria-hidden /><Subtitle2>Mapping &amp; key</Subtitle2></div>
                <MappingPanel spec={draft} onChange={setDraft} id={id} />
              </div>

              <div className={styles.card}>
                <div className={styles.sectionHeader}><ArrowRepeatAll20Regular className={styles.sectionIcon} aria-hidden /><Subtitle2>Sync mode</Subtitle2></div>
                <RadioGroup value={draft.mode} onChange={(_, d) => setDraft({ ...draft, mode: d.value as ActivationMode })}>
                  <Radio value="full" label="Full — read and push the whole source on every run." />
                  <Radio value="incremental" label="Incremental — push only rows changed since the last run (Delta Change Data Feed; needs delta.enableChangeDataFeed on the source)." />
                </RadioGroup>
                {typeof draft.lastSyncedVersion === 'number' && (
                  <Caption1 className={styles.label}>Last synced Delta version: <span className={styles.mono}>{draft.lastSyncedVersion}</span></Caption1>
                )}
              </div>

              <div className={styles.card}>
                <div className={styles.sectionHeader}><Flowchart20Regular className={styles.sectionIcon} aria-hidden /><Subtitle2>Scheduling</Subtitle2></div>
                <Caption1 className={styles.label}>
                  Activation syncs are scheduled by data-change triggers, not a clock. Binding this sync to its source asset means a new Delta commit on the source runs it automatically (incremental) — no separate scheduler. A failed run raises an alert through the platform alert convention.
                </Caption1>
                <div className={styles.row}>
                  <Tooltip relationship="label" content={draft.source?.path ? 'Bind an activation-sync materializer to the source asset so a data-change triggers this sync' : 'Pick a source table first'}>
                    <Button appearance="secondary" size="small" icon={<Flowchart20Regular />} disabled={!draft.source?.path || busy} onClick={bindTrigger}>Bind data-change trigger</Button>
                  </Tooltip>
                  <Button as="a" appearance="subtle" size="small" href="/assets" icon={<Flowchart20Regular />}>Open Assets</Button>
                </div>
              </div>

              <Divider />
              <div className={styles.row}>
                <Button appearance="primary" onClick={onSave} disabled={busy}>Save</Button>
                <Tooltip relationship="label" content={!configured ? 'Pick a source and destination first' : 'Read the whole source and push it now'}>
                  <Button appearance="secondary" icon={<PlayRegular />} onClick={() => run('full')} disabled={!canRun}>Run full</Button>
                </Tooltip>
                <Tooltip relationship="label" content={!configured ? 'Pick a source and destination first' : 'Push only Delta CDF changes since the last run'}>
                  <Button appearance="secondary" icon={<ArrowRepeatAll20Regular />} onClick={() => run('incremental')} disabled={!canRun}>Run incremental</Button>
                </Tooltip>
                {busy && <Spinner size="tiny" />}
              </div>
            </>
          )}

          {tab === 'runs' && (
            <div className={styles.card} style={{ minWidth: 0, overflowX: 'auto' }}>
              <div className={styles.sectionHeader}>
                <HistoryRegular className={styles.sectionIcon} aria-hidden />
                <Subtitle2>Run history</Subtitle2>
                <Button appearance="secondary" size="small" onClick={loadRuns} disabled={busy}>Refresh</Button>
              </div>
              {runs.length === 0 ? (
                <EmptyState icon={<HistoryRegular />} title="No runs yet"
                  body="This activation sync hasn't run. Configure the source, destination, and mapping, then run full or incremental — each run appears here with rows read, upserts, deletes, and errors."
                  primaryAction={canRun ? { label: 'Run full', onClick: () => run('full') } : undefined} />
              ) : (
                <Table size="small" aria-label="Activation runs">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Started</TableHeaderCell>
                      <TableHeaderCell>Mode</TableHeaderCell>
                      <TableHeaderCell>Status</TableHeaderCell>
                      <TableHeaderCell>Read</TableHeaderCell>
                      <TableHeaderCell>Upserts</TableHeaderCell>
                      <TableHeaderCell>Deletes</TableHeaderCell>
                      <TableHeaderCell>Errors</TableHeaderCell>
                      <TableHeaderCell>Versions</TableHeaderCell>
                      <TableHeaderCell>Detail</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runs.map((r) => (
                      <TableRow key={r.runId}>
                        <TableCell>{fmtTs(r.startedAt)}</TableCell>
                        <TableCell><Badge appearance="tint" color={r.mode === 'incremental' ? 'brand' : 'informative'}>{r.mode}</Badge></TableCell>
                        <TableCell><Badge appearance="outline" color={r.status === 'succeeded' ? 'success' : r.status === 'failed' ? 'danger' : 'informative'}>{r.status}</Badge></TableCell>
                        <TableCell>{r.rowsRead}</TableCell>
                        <TableCell>{r.upserts}</TableCell>
                        <TableCell>{r.deletes}</TableCell>
                        <TableCell>{r.errors}</TableCell>
                        <TableCell className={styles.mono}>{r.fromVersion != null && r.toVersion != null ? `${r.fromVersion}→${r.toVersion}` : (r.toVersion != null ? `@${r.toVersion}` : '—')}</TableCell>
                        <TableCell style={{ overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 }}>{r.detail || '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          )}
        </div>
      </div>
    } />
  );
}
