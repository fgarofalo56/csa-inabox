'use client';

/**
 * EventSchemaSetEditor — Schema-registry CRUD for Loom event streams.
 *
 * Tabs: Subjects · Versions · Compatibility · Settings
 *
 * Today this is Cosmos-backed: subjects + Avro/JSON/Protobuf schemas are
 * persisted under each item's state. The eventstream runtime reads these
 * directly to validate ingress payloads. If a tenant later attaches an
 * external registry (Confluent / Apicurio / Event Hubs Schema Registry),
 * the Compatibility tab MessageBar surfaces the docs link.
 *
 * Per .claude/rules/no-vaporware.md every action calls a real Cosmos
 * endpoint and the unimplemented compatibility-check is disclosed in a
 * MessageBar with the doc reference.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Caption1, Body1, Badge, Button, Spinner, Input, Textarea, Field, Dropdown, Option,
  Tree, TreeItem, TreeItemLayout, Select,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync20Regular, Save20Regular, BookOpen20Regular, DocumentBulletList20Regular,
  ShieldCheckmark20Regular, BeakerEdit20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 },
  toolbar: { display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' },
  treePad: { padding: 8 },
  tabs: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, padding: '8px 8px 0' },
  tableWrap: { overflow: 'auto', maxHeight: 320, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  cell: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, whiteSpace: 'nowrap' },
  field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 240 },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
  section: { display: 'flex', flexDirection: 'column', gap: 8 },
  policyHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  versionCard: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  versionHead: { display: 'flex', alignItems: 'center', gap: 8 },
  pre: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: 220,
    overflow: 'auto',
    backgroundColor: tokens.colorNeutralBackground3,
    padding: 8,
    borderRadius: tokens.borderRadiusMedium,
    margin: 0,
  },
  violationList: { margin: '4px 0 0', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 },
  settingsGrid: {
    display: 'grid',
    gridTemplateColumns: 'max-content 1fr',
    gap: '6px 16px',
    alignItems: 'center',
    maxWidth: 640,
  },
});

interface WorkspaceLite { id: string; name: string }
interface SetLite { id: string; displayName: string; subjectCount: number; compatibility?: string }
interface SchemaVersion { id: number; schema: string; createdAt: string; createdBy?: string }
interface SchemaSubject { name: string; format: 'AVRO' | 'JSON' | 'PROTOBUF'; versions: SchemaVersion[] }
interface SchemaSet {
  id: string;
  displayName: string;
  description?: string;
  subjects: SchemaSubject[];
  compatibility?: 'BACKWARD' | 'FORWARD' | 'FULL' | 'NONE';
  format?: 'AVRO' | 'JSON' | 'PROTOBUF';
  externalRegistry?: { endpoint?: string; type?: string } | null;
  /** Which backend enforces compatibility: EH Schema Registry vs in-process. */
  compatBackend?: 'eventhubs-sr' | 'cosmos-inprocess';
  /** The Event Hubs Schema Registry schema group, when server-side enforcement is wired. */
  eventHubsSchemaGroup?: string | null;
}

const SAMPLE_AVRO = `{
  "type": "record",
  "name": "OrderEvent",
  "namespace": "loom.events",
  "fields": [
    { "name": "orderId", "type": "string" },
    { "name": "amount", "type": "double" },
    { "name": "createdAt", "type": "string" }
  ]
}`;

interface Props { item: FabricItemType; id: string }

export function EventSchemaSetEditor({ item, id }: Props) {
  const s = useStyles();
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [sets, setSets] = useState<SetLite[] | null>(null);
  const [setId, setSetId] = useState(id !== 'new' ? id : '');
  const [active, setActive] = useState<SchemaSet | null>(null);
  const [activeSubject, setActiveSubject] = useState<string | null>(null);
  const [tab, setTab] = useState<string>('subjects');
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [cName, setCName] = useState('');
  const [cDesc, setCDesc] = useState('');
  const [cFormat, setCFormat] = useState<'AVRO' | 'JSON' | 'PROTOBUF'>('AVRO');
  const [cBusy, setCBusy] = useState(false);
  const [cErr, setCErr] = useState<string | null>(null);

  // Register version dialog
  const [regOpen, setRegOpen] = useState(false);
  const [regSubject, setRegSubject] = useState('');
  const [regSchema, setRegSchema] = useState(SAMPLE_AVRO);
  const [regBusy, setRegBusy] = useState(false);
  const [regErr, setRegErr] = useState<string | null>(null);
  // Pre-publish dry-run compatibility check (POST .../check-compat) — answers
  // "would this register?" without persisting, so the author sees breaking
  // changes before committing.
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkResult, setCheckResult] = useState<{ compatible: boolean; violations: string[]; checkedVia: string } | null>(null);

  useEffect(() => {
    fetch('/api/loom/workspaces').then(r => r.json()).then(j => {
      if (j.ok) setWorkspaces(j.workspaces || []);
      else setWorkspaces([]);
    }).catch(() => setWorkspaces([]));
  }, []);

  const loadList = useCallback(async (wsId: string) => {
    try {
      const r = await fetch(`/api/items/event-schema-set?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setSets([]); return; }
      setSets(j.schemaSets || []);
      if (!setId && (j.schemaSets || []).length) setSetId(j.schemaSets[0].id);
    } catch { setSets([]); }
  }, [setId]);

  const loadDetail = useCallback(async (wsId: string, sid: string) => {
    try {
      const r = await fetch(`/api/items/event-schema-set/${encodeURIComponent(sid)}?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setActive(null); return; }
      setActive(j.schemaSet);
      if ((j.schemaSet?.subjects || []).length && !activeSubject) {
        setActiveSubject(j.schemaSet.subjects[0].name);
      }
    } catch { setActive(null); }
  }, [activeSubject]);

  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  useEffect(() => { if (workspaceId && setId) loadDetail(workspaceId, setId); }, [workspaceId, setId, loadDetail]);

  const create = useCallback(async () => {
    if (!workspaceId || !cName.trim()) return;
    setCBusy(true); setCErr(null);
    try {
      const r = await fetch(`/api/items/event-schema-set?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: cName.trim(), description: cDesc.trim() || undefined, format: cFormat }),
      });
      const j = await r.json();
      if (!j.ok) { setCErr(j.error || 'create failed'); return; }
      setCreateOpen(false); setCName(''); setCDesc('');
      await loadList(workspaceId);
      if (j.schemaSet?.id) setSetId(j.schemaSet.id);
    } finally { setCBusy(false); }
  }, [workspaceId, cName, cDesc, cFormat, loadList]);

  const registerVersion = useCallback(async () => {
    if (!workspaceId || !setId || !regSubject.trim() || !regSchema.trim()) return;
    setRegBusy(true); setRegErr(null);
    try {
      // Validate JSON shape locally so an obvious typo doesn't roundtrip.
      try { JSON.parse(regSchema); }
      catch (e: any) { setRegErr(`Schema is not valid JSON: ${e?.message || String(e)}`); setRegBusy(false); return; }
      const r = await fetch(`/api/items/event-schema-set/${encodeURIComponent(setId)}/versions?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subject: regSubject.trim(), schema: regSchema, format: active?.format || 'AVRO' }),
      });
      const j = await r.json();
      if (!j.ok) {
        // 409 = the new schema violates the set's compatibility policy. The
        // server message already names the policy + the specific breaking
        // changes; prefix it so the cause is unmistakable in the dialog.
        if (r.status === 409) {
          setRegErr(`Incompatible schema — registration blocked. ${j.error || ''}`.trim());
        } else {
          setRegErr(j.error || 'register failed');
        }
        return;
      }
      setActionMsg(`Registered ${regSubject} v${j.version}`);
      setRegOpen(false); setRegSubject('');
      await loadDetail(workspaceId, setId);
    } catch (e: any) { setRegErr(e?.message || String(e)); }
    finally { setRegBusy(false); }
  }, [workspaceId, setId, regSubject, regSchema, active?.format, loadDetail]);

  const checkCompat = useCallback(async () => {
    if (!workspaceId || !setId || !regSubject.trim() || !regSchema.trim()) return;
    setCheckBusy(true); setCheckResult(null); setRegErr(null);
    try {
      try { JSON.parse(regSchema); }
      catch (e: any) { setRegErr(`Schema is not valid JSON: ${e?.message || String(e)}`); return; }
      const r = await fetch(`/api/items/event-schema-set/${encodeURIComponent(setId)}/check-compat?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subject: regSubject.trim(), newSchema: regSchema, format: active?.format || 'AVRO' }),
      });
      const j = await r.json();
      if (!j.ok) { setRegErr(j.error || 'compatibility check failed'); return; }
      setCheckResult({ compatible: !!j.compatible, violations: j.violations || [], checkedVia: j.checkedVia || 'cosmos-inprocess' });
    } catch (e: any) { setRegErr(e?.message || String(e)); }
    finally { setCheckBusy(false); }
  }, [workspaceId, setId, regSubject, regSchema, active?.format]);

  const updateCompatibility = useCallback(async (compat: SchemaSet['compatibility']) => {
    if (!workspaceId || !setId) return;
    setActionErr(null);
    try {
      const r = await fetch(`/api/items/event-schema-set/${encodeURIComponent(setId)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ compatibility: compat }),
      });
      const j = await r.json();
      if (!j.ok) setActionErr(j.error);
      else { setActionMsg(`Compatibility set to ${compat}`); await loadDetail(workspaceId, setId); }
    } catch (e: any) { setActionErr(e?.message || String(e)); }
  }, [workspaceId, setId, loadDetail]);

  const subjects = active?.subjects || [];
  const subject = subjects.find(x => x.name === activeSubject) || null;

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Item', actions: [
        { label: 'New schema set', onClick: workspaceId ? () => setCreateOpen(true) : undefined, disabled: !workspaceId },
        { label: 'Refresh', onClick: workspaceId ? () => loadList(workspaceId) : undefined, disabled: !workspaceId },
      ]},
      { label: 'Subjects', actions: [
        { label: 'Register version', onClick: setId ? () => setRegOpen(true) : undefined, disabled: !setId },
      ]},
      { label: 'View', actions: [
        { label: 'Subjects', onClick: () => setTab('subjects') },
        { label: 'Versions', onClick: () => setTab('versions'), disabled: !setId },
        { label: 'Compatibility', onClick: () => setTab('compatibility'), disabled: !setId },
      ]},
    ]},
  ], [workspaceId, setId, loadList]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 style={{ marginBottom: 8 }}>Schema sets</Subtitle2>
          {!workspaceId && <Caption1>Select a workspace.</Caption1>}
          {workspaceId && sets === null && <Spinner size="tiny" label="Loading…" />}
          {sets && sets.length === 0 && <Caption1>No schema sets yet.</Caption1>}
          <Tree aria-label="Schema sets">
            {(sets || []).map(set => (
              <TreeItem key={set.id} itemType="leaf" value={set.id} onClick={() => setSetId(set.id)}>
                <TreeItemLayout iconBefore={<BookOpen20Regular />}>
                  {setId === set.id ? <strong>{set.displayName}</strong> : set.displayName}
                  <br /><Caption1>{set.subjectCount} subjects · {set.compatibility || 'BACKWARD'}</Caption1>
                </TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <>
          <div className={s.tabs}>
            <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
              <Tab value="subjects">Subjects</Tab>
              <Tab value="versions">Versions</Tab>
              <Tab value="compatibility">Compatibility</Tab>
              <Tab value="settings">Settings</Tab>
            </TabList>
          </div>
          <div className={s.pad}>
            <div className={s.toolbar}>
              <Badge appearance="filled" color="brand">EventSchemaSet</Badge>
              <div className={s.field}>
                <Caption1>Workspace</Caption1>
                <Select value={workspaceId} onChange={(_, d) => setWorkspaceId(d.value)} disabled={(workspaces?.length ?? 0) === 0}>
                  {!workspaceId && <option value="">{workspaces === null ? 'Loading…' : 'Select a workspace'}</option>}
                  {(workspaces || []).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                </Select>
              </div>
              <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
                <DialogTrigger disableButtonEnhancement>
                  <Button appearance="outline" icon={<Add20Regular />} disabled={!workspaceId}>New set</Button>
                </DialogTrigger>
                <DialogSurface>
                  <DialogBody>
                    <DialogTitle>Create event schema set</DialogTitle>
                    <DialogContent>
                      <Field label="Display name" required><Input value={cName} onChange={(_, d) => setCName(d.value)} /></Field>
                      <Field label="Description"><Textarea value={cDesc} onChange={(_, d) => setCDesc(d.value)} /></Field>
                      <Field label="Default schema format">
                        <Dropdown
                          selectedOptions={[cFormat]}
                          value={cFormat}
                          onOptionSelect={(_, d) => setCFormat((d.optionValue as any) || 'AVRO')}
                        >
                          <Option value="AVRO">Avro</Option>
                          <Option value="JSON">JSON Schema</Option>
                          <Option value="PROTOBUF">Protobuf</Option>
                        </Dropdown>
                      </Field>
                      {cErr && <MessageBar intent="error"><MessageBarBody>{cErr}</MessageBarBody></MessageBar>}
                    </DialogContent>
                    <DialogActions>
                      <Button appearance="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
                      <Button appearance="primary" disabled={cBusy || !cName.trim()} onClick={create}>{cBusy ? 'Creating…' : 'Create'}</Button>
                    </DialogActions>
                  </DialogBody>
                </DialogSurface>
              </Dialog>
              <Dialog open={regOpen} onOpenChange={(_, d) => { setRegOpen(d.open); if (!d.open) { setCheckResult(null); setRegErr(null); } }}>
                <DialogTrigger disableButtonEnhancement>
                  <Button appearance="primary" icon={<Add20Regular />} disabled={!setId}>Register version</Button>
                </DialogTrigger>
                <DialogSurface style={{ maxWidth: '720px', width: '90vw' }}>
                  <DialogBody>
                    <DialogTitle>Register a new schema version</DialogTitle>
                    <DialogContent>
                      <div className={s.section}>
                        <Field label="Subject" required>
                          <Input value={regSubject} onChange={(_, d) => { setRegSubject(d.value); setCheckResult(null); }} placeholder="orders.OrderEvent" />
                        </Field>
                        <Field
                          label="Schema (JSON)"
                          hint={`Checked against the latest version under the ${active?.compatibility || 'BACKWARD'} policy before it is registered.`}
                        >
                          <Textarea value={regSchema} onChange={(_, d) => { setRegSchema(d.value); setCheckResult(null); }} rows={12} className={s.mono} />
                        </Field>
                        {checkResult && (
                          <MessageBar intent={checkResult.compatible ? 'success' : 'error'}>
                            <MessageBarBody>
                              <MessageBarTitle>
                                {checkResult.compatible
                                  ? `Compatible with the ${active?.compatibility || 'BACKWARD'} policy`
                                  : `Incompatible with the ${active?.compatibility || 'BACKWARD'} policy`}
                              </MessageBarTitle>
                              {checkResult.compatible ? (
                                <>Registration will be accepted. Verified via {checkResult.checkedVia === 'eventhubs-sr' ? 'Azure Event Hubs Schema Registry' : 'in-process Avro validator'}.</>
                              ) : (
                                <>
                                  Registration will be blocked. Fix the breaking changes below, then re-check.
                                  <ul className={s.violationList}>
                                    {checkResult.violations.map((v, i) => <li key={i} className={s.mono}>{v}</li>)}
                                  </ul>
                                </>
                              )}
                            </MessageBarBody>
                          </MessageBar>
                        )}
                        {regErr && <MessageBar intent="error"><MessageBarBody>{regErr}</MessageBarBody></MessageBar>}
                      </div>
                    </DialogContent>
                    <DialogActions>
                      <Button appearance="secondary" onClick={() => { setRegOpen(false); setCheckResult(null); }}>Cancel</Button>
                      <Button
                        appearance="outline"
                        icon={checkBusy ? <Spinner size="tiny" /> : <BeakerEdit20Regular />}
                        disabled={checkBusy || regBusy || !regSubject.trim() || !regSchema.trim()}
                        onClick={checkCompat}
                      >{checkBusy ? 'Checking…' : 'Check compatibility'}</Button>
                      <Button
                        appearance="primary"
                        icon={regBusy ? <Spinner size="tiny" /> : <Save20Regular />}
                        disabled={regBusy || checkBusy || !regSubject.trim() || !regSchema.trim()}
                        onClick={registerVersion}
                      >{regBusy ? 'Registering…' : 'Register'}</Button>
                    </DialogActions>
                  </DialogBody>
                </DialogSurface>
              </Dialog>
              <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => workspaceId && setId && loadDetail(workspaceId, setId)} disabled={!setId}>Refresh</Button>
            </div>

            {actionErr && <MessageBar intent="error"><MessageBarBody>{actionErr}</MessageBarBody></MessageBar>}
            {actionMsg && <MessageBar intent="success"><MessageBarBody>{actionMsg}</MessageBarBody></MessageBar>}

            {tab === 'subjects' && (
              <>
                {!active && <Caption1>Select a schema set.</Caption1>}
                {active && subjects.length === 0 && (
                  <MessageBar intent="info">
                    <MessageBarBody>No subjects yet. Click <strong>Register version</strong> to create the first one.</MessageBarBody>
                  </MessageBar>
                )}
                {active && subjects.length > 0 && (
                  <div className={s.tableWrap}>
                    <Table aria-label="Subjects" size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Subject</TableHeaderCell>
                        <TableHeaderCell>Format</TableHeaderCell>
                        <TableHeaderCell>Versions</TableHeaderCell>
                        <TableHeaderCell>Latest registered</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {subjects.map(sub => (
                          <TableRow key={sub.name} onClick={() => setActiveSubject(sub.name)} style={{ cursor: 'pointer' }}>
                            <TableCell className={s.cell}>{activeSubject === sub.name ? <strong>{sub.name}</strong> : sub.name}</TableCell>
                            <TableCell>{sub.format}</TableCell>
                            <TableCell className={s.cell}>{sub.versions.length}</TableCell>
                            <TableCell className={s.cell}>{sub.versions.at(-1)?.createdAt?.replace('T', ' ').replace(/\..*/, '') || '—'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </>
            )}

            {tab === 'versions' && (
              <>
                {!active && <Caption1>Select a schema set.</Caption1>}
                {active && (
                  <>
                    <div className={s.toolbar}>
                      <Caption1>Subject</Caption1>
                      <Dropdown
                        selectedOptions={activeSubject ? [activeSubject] : []}
                        value={activeSubject || ''}
                        onOptionSelect={(_, d) => setActiveSubject(d.optionValue || null)}
                      >
                        {subjects.map(sub => <Option key={sub.name} value={sub.name}>{sub.name}</Option>)}
                      </Dropdown>
                    </div>
                    {!subject && <Caption1>Pick a subject above.</Caption1>}
                    {subject && subject.versions.length === 0 && <Caption1>No versions yet.</Caption1>}
                    {subject && subject.versions.length > 0 && (
                      <div className={s.section}>
                        {subject.versions.slice().reverse().map((v, idx) => (
                          <div key={v.id} className={s.versionCard}>
                            <div className={s.versionHead}>
                              <Badge appearance="filled" color={idx === 0 ? 'brand' : 'informative'}>v{v.id}</Badge>
                              {idx === 0 && <Badge appearance="tint" color="success">Latest</Badge>}
                              <Caption1>{v.createdAt}{v.createdBy ? ` · ${v.createdBy}` : ''}</Caption1>
                            </div>
                            <pre className={s.pre}>{v.schema}</pre>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            {tab === 'compatibility' && active && (
              <div className={s.section}>
                <div className={s.policyHeader}>
                  <ShieldCheckmark20Regular />
                  <Subtitle2>Compatibility policy</Subtitle2>
                  <Badge
                    appearance="tint"
                    color={active.compatBackend === 'eventhubs-sr' ? 'success' : 'informative'}
                  >
                    {active.compatBackend === 'eventhubs-sr' ? 'Event Hubs Schema Registry' : 'In-process validator'}
                  </Badge>
                </div>
                <Caption1>Applies when registering a new version under any subject in this set.</Caption1>
                <Field label="Policy" className={s.field}>
                  <Dropdown
                    selectedOptions={[active.compatibility || 'BACKWARD']}
                    value={active.compatibility || 'BACKWARD'}
                    onOptionSelect={(_, d) => updateCompatibility((d.optionValue as any) || 'BACKWARD')}
                  >
                    <Option value="BACKWARD">BACKWARD (default)</Option>
                    <Option value="FORWARD">FORWARD</Option>
                    <Option value="FULL">FULL</Option>
                    <Option value="NONE">NONE (no check)</Option>
                  </Dropdown>
                </Field>
                {active.compatBackend === 'eventhubs-sr' ? (
                  <MessageBar intent="success">
                    <MessageBarBody>
                      <MessageBarTitle>Enforced server-side by Azure Event Hubs Schema Registry</MessageBarTitle>
                      New versions are registered into the Event Hubs schema group
                      {' '}<code>{active.eventHubsSchemaGroup || 'loom-schemas'}</code>, which enforces this
                      compatibility policy at registration time and rejects breaking changes (HTTP 400) before
                      they are persisted. Avro evolution is checked by the service; JSON Schema and Protobuf
                      use NONE per Event Hubs Schema Registry behavior. See <a href="/docs/fiab/event-schema-registry.md">docs/fiab/event-schema-registry.md</a>.
                    </MessageBarBody>
                  </MessageBar>
                ) : (
                  <MessageBar intent="info">
                    <MessageBarBody>
                      <MessageBarTitle>Enforced in-process against the Avro structural rules</MessageBarTitle>
                      When you register a new version, Loom checks it against the subject's latest version under
                      this policy and rejects breaking changes (HTTP 409) before persisting — no external
                      registry required. Avro is structurally checked (added/removed fields, defaults, type
                      promotion); JSON Schema and Protobuf use NONE, matching Event Hubs Schema Registry. To
                      delegate enforcement to a real Azure Event Hubs Schema Registry instead, set
                      {' '}<code>LOOM_EH_SCHEMA_GROUP</code>. See <a href="/docs/fiab/event-schema-registry.md">docs/fiab/event-schema-registry.md</a>.
                    </MessageBarBody>
                  </MessageBar>
                )}
              </div>
            )}

            {tab === 'settings' && active && (
              <div className={s.section}>
                <Subtitle2>{active.displayName}</Subtitle2>
                <div className={s.settingsGrid}>
                  <Caption1>Id</Caption1><code className={s.mono}>{active.id}</code>
                  <Caption1>Default format</Caption1><code className={s.mono}>{active.format || 'AVRO'}</code>
                  <Caption1>Compatibility</Caption1><code className={s.mono}>{active.compatibility || 'BACKWARD'}</code>
                  <Caption1>Enforced by</Caption1>
                  <code className={s.mono}>{active.compatBackend === 'eventhubs-sr' ? 'Azure Event Hubs Schema Registry' : 'In-process Avro validator (Cosmos-backed)'}</code>
                  <Caption1>External registry</Caption1>
                  <code className={s.mono}>{active.externalRegistry?.endpoint || '(none — Cosmos-backed)'}</code>
                </div>
                <div>
                  <Button appearance="subtle" icon={<DocumentBulletList20Regular />} onClick={() => setTab('compatibility')}>Open compatibility settings</Button>
                </div>
              </div>
            )}
          </div>
        </>
      }
    />
  );
}
