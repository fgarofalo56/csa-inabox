'use client';

/**
 * MirrorSourceWizard — the standalone New/Edit-mirrored-database wizard.
 *
 * Extracted from MirroredDatabaseEditor so the multi-source create/edit flow is
 * a self-contained, testable surface. Four steps:
 *   1. Source type — icon cards (Azure SQL DB/MI, PostgreSQL, Cosmos DB,
 *      Snowflake, SQL Server, Open mirroring).
 *   2. Connection & auth — pick/create a Loom Connection (credentials in Key
 *      Vault, never plaintext) + server/database, with a real Verify probe.
 *   3. Tables — load the source's real tables and pick an include subset (empty
 *      = mirror everything the engine discovers). When editing an existing
 *      mirror, tables load through the credential-aware per-item route that
 *      resolves the connection's Key Vault secretRef; pre-create uses the flat
 *      enumerator.
 *   4. Name & review — POST (create) or PATCH (edit) the mirror.
 *
 * All backends are real (no-vaporware.md): /api/connections, /verify,
 * /[id]/tables, /source-tables, and the create/edit item routes.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Button, Input, Field, Dropdown, Option, Divider, Checkbox,
  Table, TableBody, TableRow, TableCell,
  MessageBar, MessageBarBody,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync20Regular, Database20Regular,
  PlugConnected20Regular, Key16Regular, CheckmarkCircle16Filled,
} from '@fluentui/react-icons';
import { ConnectionBuilder, type ConnectionView } from '@/lib/components/connections/connection-builder';

export interface MirrorTableSpec { schema: string; table: string }

/**
 * Mirroring source types → display name, an accent color, and the Loom
 * Connection types that can back them. Each gets its own card in the wizard.
 */
export const MIRROR_SOURCES: { id: string; name: string; accent: string; connTypes: string[] }[] = [
  { id: 'AzureSqlDatabase', name: 'Azure SQL Database', accent: '#0078d4', connTypes: ['azure-sql', 'generic-sql'] },
  { id: 'AzureSqlMI', name: 'Azure SQL Managed Instance', accent: '#0063b1', connTypes: ['azure-sql', 'generic-sql'] },
  { id: 'AzurePostgreSql', name: 'Azure Database for PostgreSQL', accent: '#336791', connTypes: ['postgres'] },
  { id: 'CosmosDb', name: 'Azure Cosmos DB', accent: '#3999c6', connTypes: ['cosmos'] },
  { id: 'Snowflake', name: 'Snowflake', accent: '#29b5e8', connTypes: ['generic-sql', 'connection-string' as string] },
  { id: 'SqlServer2025', name: 'SQL Server 2025', accent: '#a4262c', connTypes: ['generic-sql'] },
  { id: 'MSSQL', name: 'SQL Server 2016-2022', accent: '#a4262c', connTypes: ['generic-sql'] },
  { id: 'BigQuery', name: 'Google BigQuery', accent: '#4285f4', connTypes: ['bigquery'] },
  { id: 'Oracle', name: 'Oracle Database', accent: '#c74634', connTypes: ['oracle'] },
  { id: 'GenericMirror', name: 'Open mirroring', accent: '#5c2d91', connTypes: ['azure-sql', 'postgres', 'cosmos', 'storage-adls', 'generic-sql'] },
];

/** Cross-cloud sources reached over a data gateway / project id rather than a plain server FQDN. */
const PROJECT_SOURCES = new Set(['BigQuery']);
const GATEWAY_SOURCES = new Set(['BigQuery', 'Oracle']);

const useStyles = makeStyles({
  tableWrap: { overflow: 'auto', maxHeight: 320, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
  cell: { fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'nowrap' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: tokens.spacingHorizontalS },
  card: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge, cursor: 'pointer',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderLeftWidth: '4px',
    backgroundColor: tokens.colorNeutralBackground1,
    transitionProperty: 'transform, box-shadow', transitionDuration: tokens.durationFaster,
    ':hover': { transform: 'translateY(-2px)', boxShadow: tokens.shadow8 },
  },
  cardActive: { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '-1px', backgroundColor: tokens.colorBrandBackground2 },
  cardIcon: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '34px', height: '34px', flexShrink: 0, borderRadius: tokens.borderRadiusMedium, color: '#fff' },
  wizard: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: '560px', maxWidth: '640px' },
  stepHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  stepNum: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '22px', height: '22px', borderRadius: '50%', backgroundColor: tokens.colorBrandBackground, color: tokens.colorNeutralForegroundOnBrand, fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold },
  connRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  summary: { display: 'grid', gridTemplateColumns: '110px 1fr', rowGap: tokens.spacingVerticalXS, columnGap: tokens.spacingHorizontalM, padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground2 },
  sumKey: { color: tokens.colorNeutralForeground3 },
});

function toB64(s: string): string {
  return typeof window === 'undefined' ? Buffer.from(s, 'utf-8').toString('base64')
    : btoa(unescape(encodeURIComponent(s)));
}

export interface MirrorSourceWizardProps {
  open: boolean;
  editing: boolean;
  workspaceId: string;
  /** Present when editing — the mirror being edited (enables credential-aware table load). */
  mirrorId?: string;
  /** Prefill for the edit flow. */
  initialSrc?: { sourceType?: string; server?: string; database?: string; connectionId?: string; tables?: MirrorTableSpec[]; displayName?: string };
  onClose: () => void;
  onCreated: (mirrorId: string, displayName: string) => void;
  onUpdated: (mirrorId: string) => void;
}

const tkey = (t: MirrorTableSpec) => `${t.schema}.${t.table}`;

export function MirrorSourceWizard(props: MirrorSourceWizardProps) {
  const { open, editing, workspaceId, mirrorId, initialSrc, onClose, onCreated, onUpdated } = props;
  const s = useStyles();

  const [createSrc, setCreateSrc] = useState('AzureSqlDatabase');
  const [createServer, setCreateServer] = useState('');
  const [createDb, setCreateDb] = useState('');
  const [createName, setCreateName] = useState('');
  const [connId, setConnId] = useState('');
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [connBuilderOpen, setConnBuilderOpen] = useState(false);
  const [availTables, setAvailTables] = useState<MirrorTableSpec[] | null>(null);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [tablesMsg, setTablesMsg] = useState<string | null>(null);
  const [selTables, setSelTables] = useState<Set<string>>(new Set());
  const [verify, setVerify] = useState<{ status: 'idle' | 'busy' | 'ok' | 'warn' | 'err'; msg?: string }>({ status: 'idle' });
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  const srcDef = useMemo(() => MIRROR_SOURCES.find((x) => x.id === createSrc) || MIRROR_SOURCES[0], [createSrc]);

  const loadConnections = useCallback(async () => {
    try {
      const r = await fetch('/api/connections');
      const j = await r.json();
      if (j.ok) setConnections(j.connections || []);
    } catch { /* honest empty */ }
  }, []);

  // Prefill on open. Edit → initialSrc; New → defaults.
  useEffect(() => {
    if (!open) return;
    void loadConnections();
    if (editing && initialSrc) {
      setCreateSrc(initialSrc.sourceType || 'AzureSqlDatabase');
      setCreateServer(initialSrc.server || '');
      setCreateDb(initialSrc.database || '');
      setConnId(initialSrc.connectionId || '');
      setCreateName(initialSrc.displayName || '');
      setSelTables(new Set((initialSrc.tables || []).map(tkey)));
    } else {
      setCreateSrc('AzureSqlDatabase'); setCreateServer(''); setCreateDb(''); setConnId(''); setCreateName('');
      setSelTables(new Set());
    }
    setAvailTables(null); setTablesMsg(null); setVerify({ status: 'idle' }); setCreateErr(null);
  }, [open, editing, initialSrc, loadConnections]);

  const compatibleConns = useMemo(
    () => connections.filter((c) => srcDef.connTypes.includes(c.type)),
    [connections, srcDef],
  );
  const pickedConn = useMemo(() => connections.find((c) => c.id === connId) || null, [connections, connId]);
  useEffect(() => {
    if (pickedConn) {
      // BigQuery has no server FQDN — its "server" coordinate is the GCP project id,
      // so the engine/ADF connector knows which project to read. Oracle uses host.
      const srv = pickedConn.host || pickedConn.projectId;
      if (srv) setCreateServer(srv);
      if (pickedConn.database) setCreateDb(pickedConn.database);
    }
  }, [pickedConn]);

  const usesProject = PROJECT_SOURCES.has(createSrc);
  const usesGateway = GATEWAY_SOURCES.has(createSrc);

  const loadSourceTables = useCallback(async () => {
    if (!createServer.trim() && createSrc !== 'CosmosDb') { setTablesMsg('Enter the server/host and database first.'); return; }
    if (!createDb.trim()) { setTablesMsg('Enter the database first.'); return; }
    setTablesLoading(true); setTablesMsg(null); setAvailTables(null);
    try {
      // Editing an existing mirror → credential-aware per-item route (resolves the
      // stored connection's Key Vault secretRef). Pre-create → flat enumerator.
      const r = mirrorId
        ? await fetch(`/api/items/mirrored-database/${encodeURIComponent(mirrorId)}/tables?workspaceId=${encodeURIComponent(workspaceId)}`)
        : await fetch('/api/items/mirrored-database/source-tables', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sourceType: createSrc, server: createServer.trim(), database: createDb.trim() }),
          });
      const j = await r.json();
      if (!j.ok) { setTablesMsg(j.error || 'Could not list tables.'); setAvailTables([]); return; }
      setAvailTables(j.tables || []);
      if (!(j.tables || []).length) setTablesMsg('No tables found.');
    } catch (e: any) { setTablesMsg(e?.message || String(e)); setAvailTables([]); }
    finally { setTablesLoading(false); }
  }, [createSrc, createServer, createDb, mirrorId, workspaceId]);

  const runVerify = useCallback(async () => {
    if (!createServer.trim() || !createDb.trim()) { setVerify({ status: 'err', msg: 'Enter the server and database first.' }); return; }
    setVerify({ status: 'busy' });
    try {
      const r = await fetch('/api/items/mirrored-database/verify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceType: createSrc, server: createServer.trim(), database: createDb.trim() }),
      });
      const j = await r.json();
      if (j.ok && j.verified) setVerify({ status: 'ok', msg: j.detail });
      else if (j.ok) setVerify({ status: 'warn', msg: j.detail });
      else setVerify({ status: 'err', msg: j.hint ? `${j.error} — ${j.hint}` : (j.error || 'verification failed') });
    } catch (e: any) { setVerify({ status: 'err', msg: e?.message || String(e) }); }
  }, [createSrc, createServer, createDb]);

  const submit = useCallback(async () => {
    if (!workspaceId || !createName.trim()) return;
    setCreateBusy(true); setCreateErr(null);
    try {
      const mirroringDef = {
        properties: {
          source: { type: createSrc, typeProperties: { server: createServer, database: createDb } },
          target: { type: 'MountedRelationalDatabase', typeProperties: { format: 'Delta' } },
        },
      };
      const definition = {
        parts: [{ path: 'mirroring.json', payload: toB64(JSON.stringify(mirroringDef, null, 2)), payloadType: 'InlineBase64' }],
      };
      const payload = {
        displayName: createName.trim(), definition, sourceType: createSrc,
        server: createServer.trim(), database: createDb.trim(),
        connectionId: connId || undefined,
        tables: (availTables || []).filter((t) => selTables.has(tkey(t))),
      };
      const r = editing && mirrorId
        ? await fetch(`/api/items/mirrored-database/${encodeURIComponent(mirrorId)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
            method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
          })
        : await fetch(`/api/items/mirrored-database?workspaceId=${encodeURIComponent(workspaceId)}`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
          });
      const j = await r.json();
      if (!j.ok) { setCreateErr(j.error || (editing ? 'save failed' : 'create failed')); return; }
      if (editing && mirrorId) {
        onUpdated(mirrorId);
      } else {
        const newId = j.mirroredDatabase?.id;
        onCreated(newId || '', createName.trim());
      }
    } finally { setCreateBusy(false); }
  }, [workspaceId, createName, createSrc, createServer, createDb, connId, editing, mirrorId, availTables, selTables, onCreated, onUpdated]);

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: '680px' }}>
        <DialogBody>
          <DialogTitle><span className={s.connRow}><Database20Regular /> {editing ? 'Edit mirrored database' : 'Create mirrored database'}</span></DialogTitle>
          <DialogContent>
            <div className={s.wizard}>
              {/* Step 1 — source type */}
              <div>
                <div className={s.stepHead}><span className={s.stepNum}>1</span><Subtitle2>Choose a source</Subtitle2></div>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Each source mirrors into ADLS Bronze Delta — no Fabric capacity required.</Caption1>
                <div className={s.grid} style={{ marginTop: 8 }}>
                  {MIRROR_SOURCES.map((src) => (
                    <div key={src.id} className={`${s.card} ${createSrc === src.id ? s.cardActive : ''}`}
                      style={{ borderLeftColor: src.accent }}
                      onClick={() => { setCreateSrc(src.id); setConnId(''); setAvailTables(null); setSelTables(new Set()); setTablesMsg(null); }} role="button" tabIndex={0}>
                      <span className={s.cardIcon} style={{ backgroundColor: src.accent }}><Database20Regular /></span>
                      <span><Body1 style={{ fontWeight: 600, display: 'block' }}>{src.name}</Body1></span>
                    </div>
                  ))}
                </div>
              </div>

              <Divider />

              {/* Step 2 — connection (Key Vault-backed auth) */}
              <div>
                <div className={s.stepHead}><span className={s.stepNum}>2</span><Subtitle2>Connection &amp; authentication</Subtitle2></div>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  Pick a saved connection or create one. Credentials are stored in Key Vault — choose SQL password /
                  connection string / service principal so the source accepts the login (no “token-identified principal” errors).
                </Caption1>
                <div className={s.connRow} style={{ marginTop: 8 }}>
                  <Field style={{ flex: 1 }}>
                    <Dropdown placeholder={compatibleConns.length ? 'Select a connection' : 'No saved connections for this source'}
                      value={pickedConn ? pickedConn.name : ''} selectedOptions={connId ? [connId] : []}
                      onOptionSelect={(_, d) => setConnId(d.optionValue || '')}>
                      {compatibleConns.map((c) => (
                        <Option key={c.id} value={c.id} text={c.name}>
                          {c.name} · {c.authMethod}{c.hasSecret ? ' · Key Vault' : ''}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>
                  <Button appearance="outline" icon={<PlugConnected20Regular />} onClick={() => setConnBuilderOpen(true)}>New connection</Button>
                </div>
                {pickedConn && (
                  <div className={s.connRow} style={{ marginTop: 6 }}>
                    {pickedConn.hasSecret ? <Key16Regular /> : <CheckmarkCircle16Filled style={{ color: tokens.colorPaletteGreenForeground1 }} />}
                    <Caption1>Auth: <strong>{pickedConn.authMethod}</strong>{pickedConn.hasSecret ? ' (secret in Key Vault)' : ''}</Caption1>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 12, marginTop: 10 }}>
                  <Field label={usesProject ? 'Project id' : 'Server / host'} style={{ flex: 1 }}>
                    <Input value={createServer} onChange={(_, d) => setCreateServer(d.value)}
                      placeholder={usesProject ? 'my-gcp-project' : createSrc === 'Oracle' ? 'host:1521/service' : 'server.database.windows.net'}
                      disabled={!!(pickedConn?.host || pickedConn?.projectId)} />
                  </Field>
                  <Field label={usesProject ? 'Dataset' : 'Database'} style={{ flex: 1 }}>
                    <Input value={createDb} onChange={(_, d) => { setCreateDb(d.value); setVerify({ status: 'idle' }); }}
                      placeholder={usesProject ? 'analytics' : createSrc === 'Oracle' ? 'ORCLPDB1' : 'prod'} disabled={!!pickedConn?.database} />
                  </Field>
                </div>
                {usesGateway && (
                  <Caption1 style={{ display: 'block', marginTop: 6, color: tokens.colorNeutralForeground3 }}>
                    {createSrc === 'Oracle'
                      ? `Oracle mirroring reads via LogMiner over a self-hosted integration runtime / on-premises data gateway${pickedConn?.dataGateway ? ` (${pickedConn.dataGateway})` : ' — set it on the connection'}. The Azure-native path lands changes as Delta in ADLS Bronze.`
                      : `BigQuery is read with a GCP service-account key${pickedConn?.serviceAccountEmail ? ` (${pickedConn.serviceAccountEmail})` : ''}${pickedConn?.dataGateway ? ` over the ${pickedConn.dataGateway} gateway` : ''}. The Azure-native path stages to ADLS Bronze Delta — no real Fabric.`}
                  </Caption1>
                )}
                <div style={{ marginTop: 10 }}>
                  <Button size="small" appearance="outline" icon={<CheckmarkCircle16Filled />} disabled={verify.status === 'busy'} onClick={runVerify}>
                    {verify.status === 'busy' ? 'Verifying…' : 'Verify connection'}
                  </Button>
                </div>
                {verify.status === 'ok' && <MessageBar intent="success" style={{ marginTop: 8 }}><MessageBarBody>{verify.msg}</MessageBarBody></MessageBar>}
                {verify.status === 'warn' && <MessageBar intent="info" style={{ marginTop: 8 }}><MessageBarBody>{verify.msg}</MessageBarBody></MessageBar>}
                {verify.status === 'err' && <MessageBar intent="error" style={{ marginTop: 8 }}><MessageBarBody>{verify.msg}</MessageBarBody></MessageBar>}
              </div>

              <Divider />

              {/* Step 3 — tables to mirror (optional subset) */}
              <div>
                <div className={s.stepHead}><span className={s.stepNum}>3</span><Subtitle2>Tables to mirror</Subtitle2></div>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  Optional — leave all unchecked to mirror <strong>every</strong> table the engine discovers. Or load + pick a subset.
                </Caption1>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                  <Button size="small" appearance="outline" icon={<ArrowSync20Regular />} disabled={tablesLoading} onClick={loadSourceTables}>
                    {tablesLoading ? 'Loading…' : 'Load tables'}
                  </Button>
                  {availTables && availTables.length > 0 && (
                    <>
                      <Caption1>{selTables.size} of {availTables.length} selected</Caption1>
                      <Button size="small" appearance="subtle" onClick={() => setSelTables(new Set(availTables.map(tkey)))}>All</Button>
                      <Button size="small" appearance="subtle" onClick={() => setSelTables(new Set())}>None</Button>
                    </>
                  )}
                </div>
                {tablesMsg && <Caption1 style={{ display: 'block', marginTop: 6, color: tokens.colorNeutralForeground3 }}>{tablesMsg}</Caption1>}
                {availTables && availTables.length > 0 && (
                  <div className={s.tableWrap} style={{ maxHeight: 180, marginTop: 8 }}>
                    <Table size="small" aria-label="Source tables">
                      <TableBody>
                        {availTables.map((t) => {
                          const k = tkey(t);
                          return (
                            <TableRow key={k}>
                              <TableCell style={{ width: 36 }}>
                                <Checkbox checked={selTables.has(k)} onChange={(_, d) => setSelTables((prev) => { const n = new Set(prev); if (d.checked) n.add(k); else n.delete(k); return n; })} />
                              </TableCell>
                              <TableCell className={s.cell}>{t.schema}.{t.table}</TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>

              <Divider />

              {/* Step 4 — name + review */}
              <div>
                <div className={s.stepHead}><span className={s.stepNum}>4</span><Subtitle2>Name &amp; create</Subtitle2></div>
                <Field label="Name" required style={{ marginTop: 8 }}>
                  <Input value={createName} onChange={(_, d) => setCreateName(d.value)} placeholder="prod-sales-mirror" />
                </Field>
                <div className={s.summary} style={{ marginTop: 10 }}>
                  <span className={s.sumKey}>Source</span><span>{srcDef.name}</span>
                  <span className={s.sumKey}>Connection</span><span>{pickedConn ? `${pickedConn.name} (${pickedConn.authMethod})` : 'manual / managed identity'}</span>
                  <span className={s.sumKey}>{usesProject ? 'Project' : 'Server'}</span><span><code>{createServer || '—'}</code></span>
                  <span className={s.sumKey}>{usesProject ? 'Dataset' : 'Database'}</span><span><code>{createDb || '—'}</code></span>
                  {usesGateway && pickedConn?.dataGateway && (
                    <><span className={s.sumKey}>Gateway</span><span><code>{pickedConn.dataGateway}</code></span></>
                  )}
                  <span className={s.sumKey}>Tables</span><span>{selTables.size > 0 ? `${selTables.size} selected` : 'all discovered'}</span>
                  <span className={s.sumKey}>Target</span><span>ADLS Bronze Delta</span>
                </div>
                {createErr && <MessageBar intent="error" style={{ marginTop: 8 }}><MessageBarBody>{createErr}</MessageBarBody></MessageBar>}
              </div>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" icon={<Add20Regular />} disabled={createBusy || !createName.trim()} onClick={submit}>
              {createBusy ? (editing ? 'Saving…' : 'Creating…') : (editing ? 'Save changes' : 'Create mirror')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
      <ConnectionBuilder open={connBuilderOpen} onClose={() => setConnBuilderOpen(false)}
        onCreated={(c) => { setConnections((prev) => [...prev.filter((x) => x.id !== c.id), c]); setConnId(c.id); }} />
    </Dialog>
  );
}
