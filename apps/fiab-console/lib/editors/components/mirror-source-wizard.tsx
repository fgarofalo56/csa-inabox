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
  Layer20Regular,
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
  { id: 'GoogleBigQuery', name: 'Google BigQuery', accent: '#4285f4', connTypes: ['generic-sql', 'connection-string' as string] },
  { id: 'Oracle', name: 'Oracle Database', accent: '#c74634', connTypes: ['generic-sql', 'connection-string' as string] },
  { id: 'SqlServer2025', name: 'SQL Server 2025', accent: '#a4262c', connTypes: ['generic-sql'] },
  { id: 'MSSQL', name: 'SQL Server 2016-2022', accent: '#a4262c', connTypes: ['generic-sql'] },
  { id: 'GenericMirror', name: 'Open mirroring', accent: '#5c2d91', connTypes: ['azure-sql', 'postgres', 'cosmos', 'storage-adls', 'generic-sql'] },
];

/** Sources whose connection needs a GCP project id + dataset rather than a SQL server FQDN. */
const BIGQUERY_SOURCES = new Set(['GoogleBigQuery']);
/** Sources whose connection needs a self-hosted/on-prem gateway (IR) + sync user. */
const GATEWAY_SOURCES = new Set(['Oracle']);

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
  icebergCard: {
    display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalM,
    marginTop: tokens.spacingVerticalS, padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderLeft: `4px solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorNeutralBackground2,
  },
  icebergIcon: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '28px', height: '28px', flexShrink: 0, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1,
  },
  icebergBody: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
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
  initialSrc?: {
    sourceType?: string; server?: string; database?: string; connectionId?: string;
    tables?: MirrorTableSpec[]; displayName?: string;
    /** Snowflake-only: also mirror Snowflake-managed Iceberg tables. */
    includeIcebergTables?: boolean;
    /** BigQuery: GCP project id (lands in source.typeProperties.projectId). */
    projectId?: string;
    /** Oracle: TNS service name / SID (the connectable "database" surrogate). */
    serviceName?: string;
    /** Oracle: on-prem data gateway / self-hosted IR name that reaches the source. */
    gateway?: string;
    /** Oracle: the source sync user the engine connects as. */
    syncUser?: string;
  };
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
  // Source-specific credential fields. BigQuery uses projectId + dataset (=database);
  // Oracle uses serviceName + gateway (on-prem data gateway / SHIR) + syncUser.
  const [projectId, setProjectId] = useState('');
  const [serviceName, setServiceName] = useState('');
  const [gateway, setGateway] = useState('');
  const [syncUser, setSyncUser] = useState('');
  const [connId, setConnId] = useState('');
  // Snowflake-only: also mirror Snowflake-managed Iceberg tables (Fabric Build
  // 2026 parity). When on, the engine enumerates + replicates Iceberg tables
  // alongside standard tables; the Azure-native path reads the Iceberg metadata
  // from the source and lands the data as Bronze Delta.
  const [includeIceberg, setIncludeIceberg] = useState(false);
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
  const isBigQuery = BIGQUERY_SOURCES.has(createSrc);
  const isOracle = GATEWAY_SOURCES.has(createSrc);

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
      setProjectId(initialSrc.projectId || '');
      setServiceName(initialSrc.serviceName || '');
      setGateway(initialSrc.gateway || '');
      setSyncUser(initialSrc.syncUser || '');
      setSelTables(new Set((initialSrc.tables || []).map(tkey)));
      setIncludeIceberg(!!initialSrc.includeIcebergTables);
    } else {
      setCreateSrc('AzureSqlDatabase'); setCreateServer(''); setCreateDb(''); setConnId(''); setCreateName('');
      setProjectId(''); setServiceName(''); setGateway(''); setSyncUser('');
      setSelTables(new Set());
      setIncludeIceberg(false);
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
      if (pickedConn.host) setCreateServer(pickedConn.host);
      if (pickedConn.database) setCreateDb(pickedConn.database);
    }
  }, [pickedConn]);

  // Effective {server, database} the engine/BFF consume — BigQuery uses
  // projectId/dataset, Oracle uses host/serviceName, everything else server/db.
  const effServer = useMemo(
    () => (isBigQuery ? (projectId.trim() || createServer.trim()) : createServer.trim()),
    [isBigQuery, projectId, createServer],
  );
  const effDb = useMemo(
    () => (isBigQuery ? createDb.trim() : isOracle ? (serviceName.trim() || createDb.trim()) : createDb.trim()),
    [isBigQuery, isOracle, createDb, serviceName],
  );

  const loadSourceTables = useCallback(async () => {
    if (!effServer && createSrc !== 'CosmosDb') { setTablesMsg(isBigQuery ? 'Enter the GCP project and dataset first.' : 'Enter the server/host and database first.'); return; }
    if (!effDb) { setTablesMsg(isBigQuery ? 'Enter the dataset first.' : isOracle ? 'Enter the service name first.' : 'Enter the database first.'); return; }
    setTablesLoading(true); setTablesMsg(null); setAvailTables(null);
    try {
      // Editing an existing mirror → credential-aware per-item route (resolves the
      // stored connection's Key Vault secretRef). Pre-create → flat enumerator.
      const r = mirrorId
        ? await fetch(`/api/items/mirrored-database/${encodeURIComponent(mirrorId)}/tables?workspaceId=${encodeURIComponent(workspaceId)}`)
        : await fetch('/api/items/mirrored-database/source-tables', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sourceType: createSrc, server: effServer, database: effDb }),
          });
      const j = await r.json();
      if (!j.ok) { setTablesMsg(j.error || 'Could not list tables.'); setAvailTables([]); return; }
      setAvailTables(j.tables || []);
      if (!(j.tables || []).length) setTablesMsg('No tables found.');
    } catch (e: any) { setTablesMsg(e?.message || String(e)); setAvailTables([]); }
    finally { setTablesLoading(false); }
  }, [createSrc, effServer, effDb, isBigQuery, isOracle, mirrorId, workspaceId]);

  const runVerify = useCallback(async () => {
    if (!effServer || !effDb) { setVerify({ status: 'err', msg: isBigQuery ? 'Enter the GCP project and dataset first.' : isOracle ? 'Enter the host and service name first.' : 'Enter the server and database first.' }); return; }
    setVerify({ status: 'busy' });
    try {
      const r = await fetch('/api/items/mirrored-database/verify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceType: createSrc, server: effServer, database: effDb }),
      });
      const j = await r.json();
      if (j.ok && j.verified) setVerify({ status: 'ok', msg: j.detail });
      else if (j.ok) setVerify({ status: 'warn', msg: j.detail });
      else setVerify({ status: 'err', msg: j.hint ? `${j.error} — ${j.hint}` : (j.error || 'verification failed') });
    } catch (e: any) { setVerify({ status: 'err', msg: e?.message || String(e) }); }
  }, [createSrc, effServer, effDb, isBigQuery, isOracle]);

  const submit = useCallback(async () => {
    if (!workspaceId || !createName.trim()) return;
    setCreateBusy(true); setCreateErr(null);
    try {
      // Iceberg-table inclusion is Snowflake-only (Fabric Build 2026 parity).
      const wantIceberg = createSrc === 'Snowflake' && includeIceberg;
      // The engine reads a flat {server, database} pair (effServer/effDb,
      // memoized above). BigQuery has no SQL server FQDN — the connectable
      // "database" is the dataset, plus a GCP projectId. Oracle's connectable
      // "database" is the TNS service name, with an on-prem data gateway (SHIR) +
      // a sync user. Map source-specific fields onto the canonical pair so
      // Start/verify/source-tables all work unchanged.
      const sourceTypeProps: Record<string, unknown> = { server: effServer, database: effDb };
      if (isBigQuery && projectId.trim()) sourceTypeProps.projectId = projectId.trim();
      if (isOracle) {
        if (serviceName.trim()) sourceTypeProps.serviceName = serviceName.trim();
        if (gateway.trim()) sourceTypeProps.gateway = gateway.trim();
        if (syncUser.trim()) sourceTypeProps.syncUser = syncUser.trim();
      }
      if (wantIceberg) sourceTypeProps.includeIcebergTables = true;
      const mirroringDef = {
        properties: {
          source: { type: createSrc, typeProperties: sourceTypeProps },
          target: { type: 'MountedRelationalDatabase', typeProperties: { format: 'Delta' } },
        },
      };
      const definition = {
        parts: [{ path: 'mirroring.json', payload: toB64(JSON.stringify(mirroringDef, null, 2)), payloadType: 'InlineBase64' }],
      };
      const payload = {
        displayName: createName.trim(), definition, sourceType: createSrc,
        server: effServer, database: effDb,
        projectId: isBigQuery ? (projectId.trim() || undefined) : undefined,
        serviceName: isOracle ? (serviceName.trim() || undefined) : undefined,
        gateway: isOracle ? (gateway.trim() || undefined) : undefined,
        syncUser: isOracle ? (syncUser.trim() || undefined) : undefined,
        connectionId: connId || undefined,
        tables: (availTables || []).filter((t) => selTables.has(tkey(t))),
        includeIcebergTables: wantIceberg,
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
  }, [workspaceId, createName, createSrc, effServer, effDb, connId, includeIceberg, editing, mirrorId, availTables, selTables, isBigQuery, isOracle, projectId, serviceName, gateway, syncUser, onCreated, onUpdated]);

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
                      onClick={() => { setCreateSrc(src.id); setConnId(''); setAvailTables(null); setSelTables(new Set()); setTablesMsg(null); setProjectId(''); setServiceName(''); setGateway(''); setSyncUser(''); setVerify({ status: 'idle' }); if (src.id !== 'Snowflake') setIncludeIceberg(false); }} role="button" tabIndex={0}>
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
                  {isBigQuery
                    ? 'BigQuery authenticates with a Google service-account key. Create a connection-string connection holding the service-account JSON (stored in Key Vault), then enter the GCP project + dataset below.'
                    : isOracle
                    ? 'Oracle reaches its source through an on-prem data gateway (self-hosted integration runtime). Create a connection-string / SQL-password connection (sync user credential → Key Vault), then enter the host, service name, gateway, and sync user below.'
                    : 'Pick a saved connection or create one. Credentials are stored in Key Vault — choose SQL password / connection string / service principal so the source accepts the login (no “token-identified principal” errors).'}
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
                {isBigQuery ? (
                  <div style={{ display: 'flex', gap: 12, marginTop: 10 }}>
                    <Field label="GCP project id" required hint="The Google Cloud project that owns the dataset." style={{ flex: 1 }}>
                      <Input value={projectId} onChange={(_, d) => { setProjectId(d.value); setVerify({ status: 'idle' }); }} placeholder="my-gcp-project" />
                    </Field>
                    <Field label="Dataset" required hint="The BigQuery dataset to mirror." style={{ flex: 1 }}>
                      <Input value={createDb} onChange={(_, d) => { setCreateDb(d.value); setVerify({ status: 'idle' }); }} placeholder="analytics" disabled={!!pickedConn?.database} />
                    </Field>
                  </div>
                ) : isOracle ? (
                  <>
                    <div style={{ display: 'flex', gap: 12, marginTop: 10 }}>
                      <Field label="Host" required hint="Oracle listener host (and :port if not 1521)." style={{ flex: 1 }}>
                        <Input value={createServer} onChange={(_, d) => { setCreateServer(d.value); setVerify({ status: 'idle' }); }} placeholder="oracle.contoso.com:1521" disabled={!!pickedConn?.host} />
                      </Field>
                      <Field label="Service name / SID" required hint="The TNS service name (e.g. ORCLPDB1)." style={{ flex: 1 }}>
                        <Input value={serviceName} onChange={(_, d) => { setServiceName(d.value); setVerify({ status: 'idle' }); }} placeholder="ORCLPDB1" />
                      </Field>
                    </div>
                    <div style={{ display: 'flex', gap: 12, marginTop: 10 }}>
                      <Field label="On-prem data gateway (SHIR)" required hint="The self-hosted integration runtime / on-prem data gateway that can reach Oracle." style={{ flex: 1 }}>
                        <Input value={gateway} onChange={(_, d) => setGateway(d.value)} placeholder="loom-onprem-ir" />
                      </Field>
                      <Field label="Sync user" hint="The Oracle user the engine connects as (LogMiner + SELECT grants)." style={{ flex: 1 }}>
                        <Input value={syncUser} onChange={(_, d) => setSyncUser(d.value)} placeholder="FABRIC_SYNC" />
                      </Field>
                    </div>
                  </>
                ) : (
                  <div style={{ display: 'flex', gap: 12, marginTop: 10 }}>
                    <Field label="Server / host" style={{ flex: 1 }}>
                      <Input value={createServer} onChange={(_, d) => setCreateServer(d.value)} placeholder="server.database.windows.net" disabled={!!pickedConn?.host} />
                    </Field>
                    <Field label="Database" style={{ flex: 1 }}>
                      <Input value={createDb} onChange={(_, d) => { setCreateDb(d.value); setVerify({ status: 'idle' }); }} placeholder="prod" disabled={!!pickedConn?.database} />
                    </Field>
                  </div>
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
                {createSrc === 'Snowflake' && (
                  <div className={s.icebergCard}>
                    <span className={s.icebergIcon}><Layer20Regular /></span>
                    <div className={s.icebergBody}>
                      <Checkbox
                        checked={includeIceberg}
                        onChange={(_, d) => setIncludeIceberg(!!d.checked)}
                        label="Include Iceberg tables"
                      />
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                        Also mirror Snowflake-managed Apache Iceberg tables, not just standard tables. The engine reads each
                        Iceberg table&apos;s metadata from Snowflake and lands it as Bronze Delta.
                      </Caption1>
                    </div>
                  </div>
                )}
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
                  {isBigQuery ? (
                    <>
                      <span className={s.sumKey}>Project</span><span><code>{projectId || '—'}</code></span>
                      <span className={s.sumKey}>Dataset</span><span><code>{createDb || '—'}</code></span>
                    </>
                  ) : isOracle ? (
                    <>
                      <span className={s.sumKey}>Host</span><span><code>{createServer || '—'}</code></span>
                      <span className={s.sumKey}>Service</span><span><code>{serviceName || '—'}</code></span>
                      <span className={s.sumKey}>Gateway</span><span><code>{gateway || '—'}</code></span>
                      {syncUser && (<><span className={s.sumKey}>Sync user</span><span><code>{syncUser}</code></span></>)}
                    </>
                  ) : (
                    <>
                      <span className={s.sumKey}>Server</span><span><code>{createServer || '—'}</code></span>
                      <span className={s.sumKey}>Database</span><span><code>{createDb || '—'}</code></span>
                    </>
                  )}
                  <span className={s.sumKey}>Tables</span><span>{selTables.size > 0 ? `${selTables.size} selected` : 'all discovered'}</span>
                  {createSrc === 'Snowflake' && (<><span className={s.sumKey}>Iceberg</span><span>{includeIceberg ? 'Iceberg tables included' : 'standard tables only'}</span></>)}
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
