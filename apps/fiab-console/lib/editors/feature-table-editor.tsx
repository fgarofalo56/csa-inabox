'use client';

/**
 * Feature Table editor (WS-2.1) — a first-class Feature Store surface over Unity
 * Catalog feature tables + Lakebase/pgvector online serving (Databricks Feature
 * Store parity). One-for-one with the Databricks "Feature Engineering" experience,
 * Loom-themed, and sovereign (the Azure-native default is Databricks UC; Gov uses
 * OSS-UC + Azure Database for PostgreSQL — no Fabric):
 *   - Overview   — backend badges, feature-table identity, online-store status.
 *   - Define     — author the feature table (entity keys + timestamp key + typed
 *                  feature columns); Save creates the REAL offline (Delta/PG) +
 *                  online (pgvector) tables and persists the spec.
 *   - PIT join   — point-in-time (AS-OF) join onto a spine/training set; preview
 *                  the SQL or run it and see real, type-badged rows + timing.
 *   - Serving    — publish the online table, then look up features at inference
 *                  and score a model-serving endpoint (wired to WS-1.2).
 *
 * Every control calls the real BFF (no mocks). When a backend is not configured
 * the surface still renders and shows the shared HonestGate with an inline "Fix
 * it" wizard (gate svc-feature-store) — no dead buttons, no red banner on a
 * freshly created item (ux-baseline G1/G2).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Spinner, Field, Dropdown, Option, Textarea,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tab, TabList, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add20Regular, Delete20Regular, Play20Regular, ArrowClockwise20Regular, CloudArrowUp20Regular } from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { NewItemCreateGate } from './new-item-gate';
import { HonestGate } from '@/lib/components/shared/honest-gate';
import { DetailsPanel, type DetailsSection } from '@/lib/components/shared/details-panel';
import { useSharedEditorStyles } from './shared-styles';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const FEATURE_TYPES = ['DOUBLE', 'FLOAT', 'BIGINT', 'INT', 'STRING', 'BOOLEAN', 'TIMESTAMP', 'DATE'] as const;

const useLocalStyles = makeStyles({
  card: { padding: tokens.spacingVerticalM, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  badges: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center', minWidth: 0, rowGap: tokens.spacingVerticalXXS },
  form: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' },
  featRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' },
  mono: { width: '100%', minHeight: '120px', maxWidth: '100%', boxSizing: 'border-box', fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase300 },
  sqlBox: { whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: '220px', padding: tokens.spacingVerticalM, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3, fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200 },
  grid: { overflowX: 'auto', maxWidth: '100%' },
});

function useStyles() {
  const shared = useSharedEditorStyles();
  const local = useLocalStyles();
  return useMemo(() => ({ ...shared, ...local }), [shared, local]);
}

interface FeatureColumn { name: string; dataType: string }
interface FeatureTableSpec { fullName: string; primaryKeys: string[]; timestampKey: string; features: FeatureColumn[]; offlineBackend?: string; onlineTable?: string; description?: string }
interface Gate { backend: string; missing: string; hint: string; fixEnvVar: string; gateId: string }

export function FeatureTableEditor({ item, id }: { item: FabricItemType; id: string }) {
  const isNew = id === 'new' || !id;
  if (isNew) {
    return (
      <NewItemCreateGate
        item={item}
        createLabel="Create feature table item"
        intro="Creates a feature-table item in your Loom workspace, then opens the editor where you author a Unity Catalog feature table (entity keys + timestamp key + typed feature columns), point-in-time-join it onto a training set, publish it to the Lakebase/pgvector online store, and look up features at inference to score a model-serving endpoint. Azure-native by default; Gov uses OSS-UC + PostgreSQL."
      />
    );
  }
  return <FeatureBody item={item} id={id} />;
}

function FeatureBody({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const apiBase = `/api/items/feature-table/${encodeURIComponent(id)}`;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [backend, setBackend] = useState<string>('databricks');
  const [gate, setGate] = useState<Gate | null>(null);
  const [onlineGate, setOnlineGate] = useState<Gate | null>(null);
  const [spec, setSpec] = useState<FeatureTableSpec | null>(null);
  const [onlineTable, setOnlineTable] = useState<string | null>(null);
  const [tab, setTab] = useState<'overview' | 'define' | 'pit' | 'serve'>('overview');

  // Define form
  const [dCatalog, setDCatalog] = useState('');
  const [dSchema, setDSchema] = useState('');
  const [dTable, setDTable] = useState('');
  const [dKeys, setDKeys] = useState('');
  const [dTs, setDTs] = useState('');
  const [dFeatures, setDFeatures] = useState<FeatureColumn[]>([{ name: '', dataType: 'DOUBLE' }]);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // PIT form
  const [pSpine, setPSpine] = useState('');
  const [pKeys, setPKeys] = useState('');
  const [pTs, setPTs] = useState('');
  const [pCarry, setPCarry] = useState('');
  const [pLimit, setPLimit] = useState('1000');
  const [pitSql, setPitSql] = useState<string | null>(null);
  const [pitBusy, setPitBusy] = useState(false);
  const [pitError, setPitError] = useState<string | null>(null);
  const [pitResult, setPitResult] = useState<{ columns: string[]; rows: unknown[][]; rowCount: number; executionMs: number } | null>(null);

  // Serving form
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishMsg, setPublishMsg] = useState<{ intent: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [svEndpoint, setSvEndpoint] = useState('');
  const [svKeys, setSvKeys] = useState<Record<string, string>>({});
  const [svPayload, setSvPayload] = useState('{\n  "dataframe_records": [\n    {}\n  ]\n}');
  const [svBusy, setSvBusy] = useState(false);
  const [svError, setSvError] = useState<string | null>(null);
  const [svResult, setSvResult] = useState<{ features: Record<string, unknown>; status: number; latencyMs: number; body: unknown } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(apiBase);
      const j = await res.json();
      if (!j.ok) { setError(j.error || `HTTP ${res.status}`); return; }
      setBackend(j.backend || 'databricks');
      setGate(j.gate || null);
      setOnlineGate(j.onlineGate || null);
      setSpec(j.spec || null);
      setOnlineTable(j.onlineTable || null);
      if (j.spec) {
        const parts = String(j.spec.fullName || '').split('.');
        setDTable(parts.pop() || ''); setDSchema(parts.pop() || ''); setDCatalog(parts.pop() || '');
        setDKeys((j.spec.primaryKeys || []).join(', '));
        setDTs(j.spec.timestampKey || '');
        setDFeatures(j.spec.features?.length ? j.spec.features : [{ name: '', dataType: 'DOUBLE' }]);
        if (!pKeys) setPKeys((j.spec.primaryKeys || []).join(', '));
      } else if (j.defaults) {
        setDCatalog((prev) => prev || j.defaults.catalog || '');
        setDSchema((prev) => prev || j.defaults.schema || '');
      }
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [apiBase, pKeys]);

  useEffect(() => { load(); }, [load]);

  const composedFullName = useMemo(
    () => [dCatalog, dSchema, dTable].map((p) => p.trim()).filter(Boolean).join('.'),
    [dCatalog, dSchema, dTable],
  );
  const parsedKeys = useMemo(() => dKeys.split(',').map((k) => k.trim()).filter(Boolean), [dKeys]);
  const canSave = !!composedFullName && parsedKeys.length > 0 && !!dTs.trim() && dFeatures.some((f) => f.name.trim());

  const save = useCallback(async () => {
    setSaving(true); setSaveMsg(null);
    try {
      const res = await fetch(apiBase, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fullName: composedFullName,
          primaryKeys: parsedKeys,
          timestampKey: dTs.trim(),
          features: dFeatures.filter((f) => f.name.trim()).map((f) => ({ name: f.name.trim(), dataType: f.dataType })),
        }),
      });
      const j = await res.json();
      if (!j.ok) { setSaveMsg({ intent: 'error', text: j.error || `HTTP ${res.status}` }); return; }
      setSaveMsg({ intent: 'success', text: j.message || 'Feature table created.' });
      setSpec(j.spec); setOnlineTable(j.spec?.onlineTable || null);
      setPKeys(parsedKeys.join(', '));
      load();
    } catch (e: any) { setSaveMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setSaving(false); }
  }, [apiBase, composedFullName, parsedKeys, dTs, dFeatures, load]);

  const runPit = useCallback(async (preview: boolean) => {
    setPitBusy(true); setPitError(null); if (!preview) setPitResult(null);
    try {
      const res = await fetch(`${apiBase}/pit-join`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          preview,
          spine: {
            fullName: pSpine.trim(),
            entityKeys: pKeys.split(',').map((k) => k.trim()).filter(Boolean),
            timestampKey: pTs.trim(),
            carryColumns: pCarry.split(',').map((c) => c.trim()).filter(Boolean),
            limit: Number(pLimit) || 1000,
          },
        }),
      });
      const j = await res.json();
      if (!j.ok) { setPitError(j.error || `HTTP ${res.status}`); return; }
      setPitSql(j.sql || null);
      if (!preview) setPitResult({ columns: j.columns, rows: j.rows, rowCount: j.rowCount, executionMs: j.executionMs });
    } catch (e: any) { setPitError(e?.message || String(e)); }
    finally { setPitBusy(false); }
  }, [apiBase, pSpine, pKeys, pTs, pCarry, pLimit]);

  const publish = useCallback(async () => {
    setPublishBusy(true); setPublishMsg(null);
    try {
      const res = await fetch(`${apiBase}/online`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const j = await res.json();
      if (!j.ok) { setPublishMsg({ intent: 'error', text: j.error || `HTTP ${res.status}` }); return; }
      setPublishMsg({ intent: j.published ? 'success' : 'info', text: j.published ? `Published ${j.published} entity row(s) to ${j.onlineTable}.` : `No offline rows to publish yet (${j.onlineTable} is ready).` });
    } catch (e: any) { setPublishMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setPublishBusy(false); }
  }, [apiBase]);

  const serve = useCallback(async () => {
    setSvBusy(true); setSvError(null); setSvResult(null);
    try {
      const res = await fetch(`${apiBase}/serve`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: svEndpoint.trim(), entityKeys: svKeys, payload: svPayload }),
      });
      const j = await res.json();
      if (!j.ok) { setSvError(j.error || `HTTP ${res.status}`); return; }
      setSvResult({ features: j.features || {}, status: j.status, latencyMs: j.latencyMs, body: j.result });
    } catch (e: any) { setSvError(e?.message || String(e)); }
    finally { setSvBusy(false); }
  }, [apiBase, svEndpoint, svKeys, svPayload]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Feature table', actions: [
        { label: loading ? 'Reloading…' : 'Reload', onClick: loading ? undefined : load, disabled: loading },
        { label: 'Define', onClick: () => setTab('define') },
      ]},
      { label: 'Operate', actions: [
        { label: 'PIT join', onClick: spec ? () => setTab('pit') : undefined, disabled: !spec },
        { label: 'Serving', onClick: spec ? () => setTab('serve') : undefined, disabled: !spec },
      ]},
    ]},
  ], [loading, load, spec]);

  const detailsPanel = useMemo(() => {
    if (!spec) return undefined;
    const sections: DetailsSection[] = [{
      key: 'ft', title: 'Feature table',
      stats: [
        { key: 'name', label: 'Table', value: spec.fullName },
        { key: 'backend', label: 'Offline', value: (spec.offlineBackend || backend) === 'postgres' ? 'PostgreSQL (sovereign)' : 'Unity Catalog (Delta)' },
        { key: 'keys', label: 'Entity keys', value: (spec.primaryKeys || []).join(', ') || '—' },
        { key: 'ts', label: 'Timestamp key', value: spec.timestampKey || '—' },
        { key: 'feat', label: 'Features', value: String(spec.features?.length ?? 0) },
        { key: 'online', label: 'Online table', value: onlineTable || '—' },
      ],
    }];
    return <DetailsPanel title="Feature Store details" subtitle={spec.fullName} sections={sections} />;
  }, [spec, backend, onlineTable]);

  const setFeat = (i: number, patch: Partial<FeatureColumn>) => setDFeatures((fs) => fs.map((f, k) => (k === i ? { ...f, ...patch } : f)));

  return (
    <ItemEditorChrome
      splitKeyPrefix={item.slug}
      item={item}
      id={id}
      ribbon={ribbon}
      rightPanel={detailsPanel}
      rightPanelLabel="Details"
      main={
        <div className={s.pad}>
          {loading && <Spinner size="small" label="Loading feature table…" labelPosition="after" />}
          {error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Load failed</MessageBarTitle>{error}</MessageBarBody></MessageBar>}

          {gate && (
            <HonestGate gateId={gate.gateId} surface="Feature Store" missing={gate.missing} detail={gate.hint} onResolved={load} />
          )}

          {!loading && (
            <>
              <div className={s.badges}>
                <Badge appearance="filled" color="brand">{backend === 'postgres' ? 'OSS Unity Catalog + PostgreSQL' : 'Unity Catalog feature tables'}</Badge>
                <Badge appearance="outline">{backend === 'postgres' ? 'sovereign / Gov path' : 'Azure-native default'}</Badge>
                <Badge appearance="tint" color="informative">Online: Lakebase / pgvector</Badge>
                {spec && <Badge appearance="tint" color="success">defined</Badge>}
              </div>

              <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as any)}>
                <Tab value="overview">Overview</Tab>
                <Tab value="define">Define</Tab>
                <Tab value="pit" disabled={!spec}>Point-in-time join</Tab>
                <Tab value="serve" disabled={!spec}>Online serving</Tab>
              </TabList>

              {tab === 'overview' && (
                <div className={s.card}>
                  <Subtitle2>Feature table</Subtitle2>
                  {!spec ? (
                    <Body1 style={{ color: tokens.colorNeutralForeground3 }}>No feature table defined yet — author one on the Define tab (entity keys, timestamp key, and feature columns).</Body1>
                  ) : (
                    <>
                      <div className={s.badges}>
                        <Badge appearance="outline">{spec.fullName}</Badge>
                        <Badge appearance="tint" color="brand">{(spec.primaryKeys || []).length} key(s)</Badge>
                        <Badge appearance="tint" color="informative">ts: {spec.timestampKey}</Badge>
                        <Badge appearance="tint">{spec.features?.length ?? 0} feature(s)</Badge>
                      </div>
                      <div className={s.grid}>
                        <Table aria-label="Feature columns" size="small">
                          <TableHeader><TableRow><TableHeaderCell>Feature</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell></TableRow></TableHeader>
                          <TableBody>
                            {(spec.features || []).map((f) => (
                              <TableRow key={f.name}><TableCell><strong>{f.name}</strong></TableCell><TableCell><Badge appearance="tint" color="informative">{f.dataType}</Badge></TableCell></TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Online serving table: <code>{onlineTable}</code></Caption1>
                    </>
                  )}
                </div>
              )}

              {tab === 'define' && (
                <div className={s.card}>
                  <Subtitle2>Define the feature table</Subtitle2>
                  <Body1 style={{ color: tokens.colorNeutralForeground3 }}>
                    Creates a real {backend === 'postgres' ? 'PostgreSQL' : 'Unity Catalog Delta'} feature table (entity keys + an event-time column for point-in-time correctness + typed feature columns) AND its Lakebase/pgvector online serving table.
                  </Body1>
                  <div className={s.form}>
                    {backend !== 'postgres' && (
                      <Field label="Catalog"><Input value={dCatalog} onChange={(_, d) => setDCatalog(d.value)} placeholder="main" disabled={!!gate} /></Field>
                    )}
                    <Field label="Schema"><Input value={dSchema} onChange={(_, d) => setDSchema(d.value)} placeholder="default" disabled={!!gate} /></Field>
                    <Field label="Table" required><Input value={dTable} onChange={(_, d) => setDTable(d.value)} placeholder="customer_features" disabled={!!gate} /></Field>
                    <Field label="Entity (primary) keys" required hint="Comma-separated"><Input value={dKeys} onChange={(_, d) => setDKeys(d.value)} placeholder="customer_id" disabled={!!gate} /></Field>
                    <Field label="Timestamp key" required><Input value={dTs} onChange={(_, d) => setDTs(d.value)} placeholder="event_ts" disabled={!!gate} /></Field>
                  </div>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Full name: <code>{composedFullName || '—'}</code></Caption1>

                  <Subtitle2 style={{ marginTop: tokens.spacingVerticalS }}>Feature columns</Subtitle2>
                  {dFeatures.map((f, i) => (
                    <div key={i} className={s.featRow}>
                      <Field label={i === 0 ? 'Name' : undefined}><Input value={f.name} onChange={(_, d) => setFeat(i, { name: d.value })} placeholder="total_spend_30d" disabled={!!gate} /></Field>
                      <Field label={i === 0 ? 'Type' : undefined}>
                        <Dropdown value={f.dataType} selectedOptions={[f.dataType]} onOptionSelect={(_, d) => setFeat(i, { dataType: (d.optionValue as string) || 'DOUBLE' })} disabled={!!gate}>
                          {FEATURE_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
                        </Dropdown>
                      </Field>
                      <Button appearance="subtle" icon={<Delete20Regular />} disabled={dFeatures.length <= 1 || !!gate} onClick={() => setDFeatures((fs) => fs.filter((_x, k) => k !== i))} aria-label="Remove feature" />
                    </div>
                  ))}
                  <div className={s.badges}>
                    <Button appearance="subtle" icon={<Add20Regular />} disabled={!!gate} onClick={() => setDFeatures((fs) => [...fs, { name: '', dataType: 'DOUBLE' }])}>Add feature</Button>
                    <Button appearance="primary" disabled={saving || !!gate || !canSave} onClick={save}>{saving ? 'Creating…' : (spec ? 'Update feature table' : 'Create feature table')}</Button>
                  </div>
                  {saveMsg && <MessageBar intent={saveMsg.intent}><MessageBarBody>{saveMsg.text}</MessageBarBody></MessageBar>}
                </div>
              )}

              {tab === 'pit' && spec && (
                <div className={s.card}>
                  <Subtitle2>Point-in-time join</Subtitle2>
                  <Body1 style={{ color: tokens.colorNeutralForeground3 }}>
                    Attaches, for each spine (label) row, the LATEST feature values whose timestamp is ≤ the spine event time — a real AS-OF join over <code>{spec.fullName}</code>. Map exactly {spec.primaryKeys.length} spine key column(s) to the feature keys ({spec.primaryKeys.join(', ')}).
                  </Body1>
                  <div className={s.form}>
                    <Field label="Spine / training table" required><Input value={pSpine} onChange={(_, d) => setPSpine(d.value)} placeholder="main.default.training_labels" /></Field>
                    <Field label="Spine entity keys" required hint="Comma-separated, aligned to feature keys"><Input value={pKeys} onChange={(_, d) => setPKeys(d.value)} placeholder={spec.primaryKeys.join(', ')} /></Field>
                    <Field label="Spine timestamp key" required><Input value={pTs} onChange={(_, d) => setPTs(d.value)} placeholder="label_ts" /></Field>
                    <Field label="Carry columns" hint="Comma-separated (labels)"><Input value={pCarry} onChange={(_, d) => setPCarry(d.value)} placeholder="label" /></Field>
                    <Field label="Row limit"><Input type="number" value={pLimit} onChange={(_, d) => setPLimit(d.value)} style={{ width: 96 }} /></Field>
                  </div>
                  <div className={s.badges}>
                    <Button disabled={pitBusy || !pSpine.trim()} onClick={() => runPit(true)}>Preview SQL</Button>
                    <Button appearance="primary" icon={<Play20Regular />} disabled={pitBusy || !pSpine.trim() || !pTs.trim()} onClick={() => runPit(false)}>{pitBusy ? 'Running…' : 'Run join'}</Button>
                    {pitResult && <Badge appearance="tint" color="brand">{pitResult.rowCount} rows · {pitResult.executionMs} ms</Badge>}
                  </div>
                  {pitSql && <div className={s.sqlBox}>{pitSql}</div>}
                  {pitError && <MessageBar intent="error"><MessageBarBody>{pitError}</MessageBarBody></MessageBar>}
                  {pitResult && pitResult.columns.length > 0 && (
                    <div className={s.grid}>
                      <Table aria-label="PIT join result" size="small">
                        <TableHeader><TableRow>{pitResult.columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
                        <TableBody>
                          {pitResult.rows.slice(0, 200).map((row, ri) => (
                            <TableRow key={ri}>{pitResult.columns.map((c, ci) => <TableCell key={c}>{String((row as any[])[ci] ?? '')}</TableCell>)}</TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              )}

              {tab === 'serve' && spec && (
                <>
                  <div className={s.card}>
                    <div className={s.badges}>
                      <Subtitle2>Publish to the online store</Subtitle2>
                      <Button appearance="primary" icon={<CloudArrowUp20Regular />} disabled={publishBusy || !!onlineGate} onClick={publish}>{publishBusy ? 'Publishing…' : 'Publish latest features'}</Button>
                    </div>
                    <Body1 style={{ color: tokens.colorNeutralForeground3 }}>
                      Materialises the latest feature values per entity from <code>{spec.fullName}</code> into the online serving table <code>{onlineTable}</code> on Lakebase / Azure Database for PostgreSQL.
                    </Body1>
                    {onlineGate && <HonestGate gateId={onlineGate.gateId} surface="Online feature store" missing={onlineGate.missing} detail={onlineGate.hint} onResolved={load} />}
                    {publishMsg && <MessageBar intent={publishMsg.intent}><MessageBarBody>{publishMsg.text}</MessageBarBody></MessageBar>}
                  </div>

                  <div className={s.card}>
                    <Subtitle2>Feature lookup at inference</Subtitle2>
                    <Body1 style={{ color: tokens.colorNeutralForeground3 }}>
                      Looks up the entity&apos;s online features, merges them into the scoring payload, and invokes a model-serving endpoint (WS-1.2). Provide the entity key value(s) and a scoring endpoint name.
                    </Body1>
                    <div className={s.form}>
                      <Field label="Serving endpoint" required><Input value={svEndpoint} onChange={(_, d) => setSvEndpoint(d.value)} placeholder="fraud-scorer" /></Field>
                      {spec.primaryKeys.map((k) => (
                        <Field key={k} label={`Entity key: ${k}`} required><Input value={svKeys[k] || ''} onChange={(_, d) => setSvKeys((m) => ({ ...m, [k]: d.value }))} placeholder="value" /></Field>
                      ))}
                    </div>
                    <Field label="Scoring payload (JSON) — features are merged in"><Textarea className={s.mono} value={svPayload} onChange={(_, d) => setSvPayload(d.value)} resize="vertical" /></Field>
                    <div className={s.badges}>
                      <Button appearance="primary" icon={<Play20Regular />} disabled={svBusy || !!onlineGate || !svEndpoint.trim() || spec.primaryKeys.some((k) => !(svKeys[k] || '').trim())} onClick={serve}>{svBusy ? 'Scoring…' : 'Look up + invoke'}</Button>
                      {svResult && <Badge appearance="tint" color={svResult.status < 400 ? 'success' : 'danger'}>HTTP {svResult.status}</Badge>}
                      {svResult && <Badge appearance="tint" color="brand">{svResult.latencyMs} ms</Badge>}
                      <Button appearance="subtle" icon={<ArrowClockwise20Regular />} onClick={load}>Refresh</Button>
                    </div>
                    {svError && <MessageBar intent="error"><MessageBarBody>{svError}</MessageBarBody></MessageBar>}
                    {svResult && (
                      <>
                        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Looked-up features:</Caption1>
                        <div className={s.badges}>
                          {Object.entries(svResult.features).map(([k, v]) => <Badge key={k} appearance="outline">{k}: {String(v)}</Badge>)}
                        </div>
                        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Model response:</Caption1>
                        <div className={s.sqlBox}>{typeof svResult.body === 'string' ? svResult.body : JSON.stringify(svResult.body, null, 2)}</div>
                      </>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      }
    />
  );
}
