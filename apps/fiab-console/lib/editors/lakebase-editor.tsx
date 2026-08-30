'use client';

/**
 * LakebaseEditor (DBX-4) — serverless Postgres OLTP, Databricks-Lakebase parity.
 *
 * Full surface (Fluent v9 + Loom tokens), every control wired to a real BFF:
 *   • Overview   — bound server (name/fqdn/state/version/SKU/HA), backend badge,
 *                  database picker; honest gates for query / Databricks backend.
 *   • Provision  — wizard (compute SKU, storage, HA mode, PG version, admin) →
 *                  real ARM PUT create; OR bind an existing server from inventory.
 *   • Query      — pg-dialect Monaco + Run → real pg wire-protocol execution.
 *   • Branches   — snapshot markers + create branch (real PITR restore server).
 *   • Replicas   — list + create async read replicas (DR / read-scale).
 *   • pgvector   — enable the vector extension (ARM allowlist + CREATE EXTENSION)
 *                  + a kNN vector-distance search (real rows).
 *
 * Azure-native (PostgreSQL Flexible Server) is the DEFAULT — 100% functional
 * with no Databricks dependency. Databricks Lakebase is an opt-in alternate.
 * The only non-functional states are honest MessageBars naming the exact env
 * var / role to wire (no-vaporware.md + ui-parity.md).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Tab, TabList, Button, Dropdown, Option, Input, Field, Spinner, Badge, Divider,
  Body1, Caption1, Subtitle2,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions, Link,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  DatabasePlugConnected20Regular, Play20Regular, ArrowSync20Regular, Add20Regular,
  BranchFork20Regular, Camera20Regular, DatabaseArrowUp20Regular, Search20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { NewItemCreateGate } from './new-item-gate';
// #3521 — the SAME picker + region list the ADF create-factory form already
// uses. Imported rather than restated: two hand-kept region lists drift, and the
// one in `pipeline-create-factory-form` already carries the US Government
// regions, which a Commercial-only copy here would have dropped
// (`cloud-parity.md`). `AzureResourcePicker` is the shared cross-subscription,
// user-RBAC resource selector — its own docblock records the three defects that
// had to be fixed before anything could adopt it, including the Gov case where
// discovery is denied and it must stay usable rather than becoming a dead end.
import { AzureResourcePicker, type AzureResource } from '@/lib/components/azure/azure-resource-picker';
import { ADF_FACTORY_REGIONS as AZURE_REGIONS } from './pipeline-create-factory-form';
import { getItem } from '@/lib/api/workspaces';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { clientFetch } from '@/lib/client-fetch';
import { openCopilot } from '@/lib/components/copilot-pane';
import { GuidedEmptyState } from '@/lib/components/shared/guided-empty-state';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { DetailsPanel } from '@/lib/components/shared/details-panel';
import { PreviewTable } from '@/lib/components/shared/preview-table';
import { useRegisterRibbonCommands } from '@/lib/components/shared/ribbon-commands';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

// Local props — declared here (not imported from ./registry) so this module has
// no import edge back to the registry barrel (guard:circular). Shape matches
// EditorProps in registry.ts.
interface EditorProps { item: FabricItemType; id: string }

const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  tabBar: { padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL} 0`, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: '220px' },
  card: { padding: tokens.spacingVerticalM, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground1, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  statGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: tokens.spacingVerticalM },
  stat: { display: 'flex', flexDirection: 'column', gap: '2px', padding: tokens.spacingVerticalS, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  statLabel: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  grid: { overflowX: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  err: { overflowWrap: 'anywhere', wordBreak: 'break-word' },
  mono: { fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200 },
  // Overview split: server facts (left, grows) + docked DetailsPanel (right).
  // Wraps the panel below on narrow widths so the surface never overflows.
  detailsRow: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'stretch', flexWrap: 'wrap' },
  detailsMain: { flex: '1 1 380px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
});

interface ServerRef { name: string; id: string; fqdn: string; resourceGroup?: string; location?: string }
interface LakebaseConfig {
  backend?: 'postgres' | 'databricks';
  server?: ServerRef;
  database?: string;
  pgvectorEnabled?: boolean;
  snapshots?: { id: string; label: string; pointInTimeUTC: string; createdAt: string }[];
  branches?: { id: string; name: string; pointInTimeUTC: string; serverId?: string; provisioningState?: string; createdAt: string }[];
}
interface LiveServer {
  name: string; fqdn: string; state?: string; version?: string; location?: string;
  sku?: { name?: string; tier?: string }; storageGb?: number; highAvailability?: string;
}
interface Gate { missing: string; detail: string }
interface SkuOption { name: string; tier: string; label: string; vCores: number; memoryGb: number }
interface WizardCatalog { skus: SkuOption[]; storageGb: number[]; versions: string[]; ha: { value: string; label: string }[] }
interface QueryResult { columns: string[]; rows: unknown[][]; rowCount: number; command?: string; executionMs: number }

/**
 * The Loom item's display name, sanitized DETERMINISTICALLY into a PostgreSQL
 * Flexible Server name (#3521, `auto-bind-by-default.md` §2).
 *
 * Azure's rule for `Microsoft.DBforPostgreSQL/flexibleServers`: 3-63 chars,
 * lowercase letters, digits and hyphens, must start with a letter or digit and
 * must not end with a hyphen. Anything outside that is replaced rather than
 * dropped, so two different display names cannot collapse onto one server name
 * by silently deleting the characters that distinguished them.
 *
 * Returns '' when the name cannot be made legal (empty, or fewer than 3 usable
 * characters) — the caller then leaves the field blank rather than seeding
 * something the ARM PUT would reject with a message about a name the user never
 * typed.
 */
/**
 * A PostgreSQL Flexible Server admin password, MINTED BY THE PLATFORM (#3521).
 *
 * Azure requires an administrator login + password at create time, and this form
 * used to ask the operator to invent one — the one field on it that no discovery
 * call could ever answer, and therefore, per `auto-bind-by-default.md` §5, the
 * one whose remediation is "the platform produces it" rather than "a better
 * picker".
 *
 * Azure's own complexity rule (8-128 chars from at least three of: uppercase,
 * lowercase, digits, non-alphanumerics) is satisfied CONSTRUCTIVELY — one
 * character taken from each class first, the rest filled from the union, then
 * shuffled — rather than by generating and hoping. `crypto.getRandomValues` is
 * the entropy source; `Math.random()` is not a credential generator.
 *
 * Characters Azure's own docs exclude from the set (`'`, `"`, `\`, `/`, `@`, `%`)
 * are left out, so a value cannot break a connection string or an ARM payload.
 */
export function mintPostgresAdminPassword(len = 28): string {
  const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const LOWER = 'abcdefghijkmnopqrstuvwxyz';
  const DIGIT = '23456789';
  const SYM = '!#$*+-=?_~';
  const all = UPPER + LOWER + DIGIT + SYM;
  const n = Math.max(12, Math.min(128, len));
  const bytes = new Uint32Array(n);
  crypto.getRandomValues(bytes);
  const pick = (set: string, i: number) => set[bytes[i] % set.length];
  const chars = [pick(UPPER, 0), pick(LOWER, 1), pick(DIGIT, 2), pick(SYM, 3)];
  for (let i = 4; i < n; i++) chars.push(pick(all, i));
  // Fisher-Yates over the SAME entropy source, so the four seeded classes are
  // not always in positions 0-3 (a predictable prefix is a weaker password than
  // its length suggests).
  const swap = new Uint32Array(chars.length);
  crypto.getRandomValues(swap);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = swap[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export function postgresServerName(displayName: string): string {
  const slug = String(displayName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  return slug.length >= 3 ? slug : '';
}

export function LakebaseEditor({ item, id }: EditorProps) {
  const s = useStyles();
  const isNew = id === 'new';

  const [tab, setTab] = useState('overview');
  const [cfg, setCfg] = useState<LakebaseConfig>({});
  const [live, setLive] = useState<LiveServer | null>(null);
  const [databases, setDatabases] = useState<string[]>([]);
  const [queryGate, setQueryGate] = useState<Gate | null>(null);
  const [databricksGate, setDatabricksGate] = useState<Gate | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // provision wizard
  const [catalog, setCatalog] = useState<WizardCatalog | null>(null);
  const [inventory, setInventory] = useState<{ name: string }[]>([]);
  // #3521 — the admin credential is MINTED, not asked for: a deterministic login
  // and a browser-generated password, both filled before the operator arrives.
  // `useState`'s lazy initializer so the password is generated ONCE per editor
  // mount rather than on every render.
  const [wz, setWz] = useState(() => ({
    name: '', resourceGroup: '', location: '',
    administratorLogin: 'loomadmin',
    administratorLoginPassword: mintPostgresAdminPassword(),
    skuName: '', storageGb: 32, version: '16', ha: 'Disabled',
  }));
  // #3521 — the picked RG, kept whole so its ARM id round-trips through
  // AzureResourcePicker (which preserves a value it cannot resolve rather than
  // blanking it) and its LOCATION can default the region below. The wire shape
  // the provision route takes is still the RG NAME.
  const [rgPick, setRgPick] = useState<AzureResource | null>(null);

  // query
  const [sql, setSql] = useState('SELECT version();');
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);

  // branch / replica / vector forms
  const [branchName, setBranchName] = useState('');
  const [snapLabel, setSnapLabel] = useState('');
  const [replicaName, setReplicaName] = useState('');
  const [replicas, setReplicas] = useState<LiveServer[]>([]);
  const [vec, setVec] = useState({ table: '', vectorColumn: 'embedding', distance: 'cosine', limit: 10, vector: '[0.1,0.2,0.3]' });
  const [vectorRows, setVectorRows] = useState<QueryResult | null>(null);

  const base = `/api/items/lakebase-postgres/${id}`;

  const loadItem = useCallback(async () => {
    if (isNew) return;
    setLoading(true); setErr(null);
    try {
      const res = await clientFetch(base);
      const j = await res.json();
      if (!res.ok || !j.ok) { setErr(j.error || 'Failed to load'); return; }
      setCfg(j.config || {});
      setLive(j.live?.server || null);
      setDatabases(Array.isArray(j.live?.databases) ? j.live.databases.map((d: any) => d.name || d) : []);
      setQueryGate(j.queryGate || null);
      setDatabricksGate(j.databricksGate || null);
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
    finally { setLoading(false); }
  }, [base, isNew]);

  useEffect(() => { void loadItem(); }, [loadItem]);

  const loadProvision = useCallback(async () => {
    try {
      const res = await clientFetch(`${base}/provision`);
      const j = await res.json();
      if (res.ok && j.ok) {
        setCatalog(j.catalog || null);
        setInventory(Array.isArray(j.servers) ? j.servers : []);
        if (j.catalog?.skus?.[0] && !wz.skuName) setWz((w) => ({ ...w, skuName: j.catalog.skus[0].name }));
      }
    } catch { /* honest inventory error already surfaced by GET */ }
  }, [base, wz.skuName]);

  useEffect(() => { if (tab === 'provision') void loadProvision(); }, [tab, loadProvision]);

  // #3521 — SEED THE SERVER NAME FROM THE LOOM ITEM.
  //
  // `auto-bind-by-default.md` §2: the backing Azure object carries the SAME
  // display name as the Loom item, "sanitized only where the service's naming
  // rules force it — and then deterministically". This form opened with an empty
  // Server name box, so the operator had to invent a name for a thing Loom had
  // already named. The item's own name is not in this editor's GET (that route
  // returns config + live server state), so it is read from the item document
  // through the shared `getItem` client — the same call `ItemEditorChrome` makes
  // for the header title.
  //
  // Best-effort by design: a failure leaves the field empty and typeable, which
  // is the pre-existing behaviour. It never OVERWRITES — a name already typed,
  // or one seeded on a previous visit to the tab, wins.
  useEffect(() => {
    if (isNew) return;
    let cancelled = false;
    getItem('lakebase-postgres', id)
      .then((it) => {
        const seeded = postgresServerName(it?.displayName || '');
        if (!cancelled && seeded) setWz((w) => (w.name ? w : { ...w, name: seeded }));
      })
      .catch(() => { /* the field stays empty and typeable */ });
    return () => { cancelled = true; };
  }, [id, isNew]);
  useEffect(() => { if (tab === 'replicas' && cfg.server) void loadReplicas(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tab, cfg.server]);

  async function patch(bodyObj: Record<string, unknown>, label: string) {
    setBusy(label); setErr(null); setNotice(null);
    try {
      const res = await clientFetch(base, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodyObj) });
      const j = await res.json();
      if (!res.ok || !j.ok) { setErr(j.error || 'Update failed'); return; }
      await loadItem();
      setNotice('Saved.');
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(null); }
  }

  // Returning variant used by the DetailsPanel inline-policy pencils (SC-2): it
  // PATCHes the SAME real backend as patch() but resolves { ok, error } so the
  // panel can show the error inline and only collapse the editor on success.
  async function patchReturning(bodyObj: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await clientFetch(base, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodyObj) });
      const j = await res.json();
      if (!res.ok || !j.ok) return { ok: false, error: j.error || 'Update failed' };
      await loadItem();
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e instanceof Error ? e.message : e) }; }
  }

  async function doProvision() {
    setBusy('provision'); setErr(null); setNotice(null);
    try {
      const res = await clientFetch(`${base}/provision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(wz) });
      const j = await res.json();
      if (!res.ok || !j.ok) { setErr(j.error || 'Provision failed'); return; }
      setNotice(`Provisioning started for ${wz.name}. It binds automatically; refresh in a few minutes.`);
      await loadItem();
      setTab('overview');
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(null); }
  }

  async function runQuery() {
    setBusy('query'); setErr(null); setQueryResult(null);
    try {
      const res = await clientFetch(`${base}/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql, database: cfg.database }) }, 60000);
      const j = await res.json();
      if (!res.ok || !j.ok) { setErr(j.error || 'Query failed'); return; }
      setQueryResult(j.result);
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(null); }
  }

  async function createSnapshot() {
    setBusy('snapshot'); setErr(null);
    try {
      const res = await clientFetch(`${base}/snapshot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: snapLabel }) });
      const j = await res.json();
      if (!res.ok || !j.ok) { setErr(j.error || 'Snapshot failed'); return; }
      setSnapLabel(''); setCfg((c) => ({ ...c, snapshots: j.snapshots }));
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(null); }
  }

  async function createBranch(snapshotId?: string) {
    if (!branchName) { setErr('Enter a branch server name'); return; }
    setBusy('branch'); setErr(null);
    try {
      const res = await clientFetch(`${base}/branches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newServerName: branchName, snapshotId }) });
      const j = await res.json();
      if (!res.ok || !j.ok) { setErr(j.error || 'Branch failed'); return; }
      setBranchName(''); setCfg((c) => ({ ...c, branches: j.branches }));
      setNotice(`Branch restore started (server ${j.branch?.name}).`);
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(null); }
  }

  async function loadReplicas() {
    try {
      const res = await clientFetch(`${base}/replicas`);
      const j = await res.json();
      if (res.ok && j.ok) setReplicas(j.replicas || []);
    } catch { /* surfaced on create */ }
  }

  async function createReplica() {
    if (!replicaName) { setErr('Enter a replica server name'); return; }
    setBusy('replica'); setErr(null);
    try {
      const res = await clientFetch(`${base}/replicas`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newServerName: replicaName }) });
      const j = await res.json();
      if (!res.ok || !j.ok) { setErr(j.error || 'Replica failed'); return; }
      setReplicaName(''); setNotice('Read replica create started.'); await loadReplicas();
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(null); }
  }

  async function enablePgvector() {
    setBusy('pgvector'); setErr(null); setNotice(null);
    try {
      const res = await clientFetch(`${base}/pgvector`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'enable' }) });
      const j = await res.json();
      if (!res.ok || !j.ok) { setErr(j.error || 'Enable failed'); return; }
      setNotice(j.extensionCreated ? 'pgvector enabled (extension created).' : (j.note || 'azure.extensions allowlist updated.'));
      await loadItem();
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(null); }
  }

  async function runVectorSearch() {
    setBusy('vsearch'); setErr(null); setVectorRows(null);
    let vector: number[];
    try { vector = JSON.parse(vec.vector); if (!Array.isArray(vector)) throw new Error('vector must be a JSON array'); }
    catch (e) { setErr(`Query vector: ${e instanceof Error ? e.message : 'invalid'}`); setBusy(null); return; }
    try {
      const res = await clientFetch(`${base}/pgvector`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'search', table: vec.table, vectorColumn: vec.vectorColumn, distance: vec.distance, limit: vec.limit, vector }) }, 60000);
      const j = await res.json();
      if (!res.ok || !j.ok) { setErr(j.error || 'Vector search failed'); return; }
      setVectorRows(j.result);
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(null); }
  }

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Data', actions: [
        { label: 'Refresh', icon: <ArrowSync20Regular />, onClick: loadItem, disabled: loading || !!busy },
        { label: 'Query', icon: <Play20Regular />, onClick: () => setTab('query'), disabled: !cfg.server },
      ]},
      { label: 'Lifecycle', actions: [
        { label: 'Provision / bind', icon: <DatabaseArrowUp20Regular />, onClick: () => setTab('provision') },
        { label: 'Branch', icon: <BranchFork20Regular />, onClick: () => setTab('branches'), disabled: !cfg.server },
      ]},
    ]},
  ], [loadItem, loading, busy, cfg.server]);

  // SC-9 — publish the ribbon actions to the shared command registry so the
  // in-ribbon command search (Ctrl+Q / Alt+Q) and Ctrl+K palette can find them.
  useRegisterRibbonCommands(ribbon, 'lakebase-postgres');

  if (isNew) {
    return <NewItemCreateGate item={item} createLabel="Create Lakebase database"
      intro="Create a Lakebase serverless Postgres OLTP database. The default backend is Azure Database for PostgreSQL Flexible Server — provision one with the wizard (compute, storage, HA), run SQL over the real pg wire protocol, branch via point-in-time restore, add read replicas, and enable pgvector for hybrid vector search. No Databricks or Fabric required; Databricks Lakebase is an opt-in alternate backend." />;
  }

  const backend = cfg.backend === 'databricks' ? 'databricks' : 'postgres';

  const banners = (
    <>
      {err ? <MessageBar intent="error"><MessageBarBody><span className={s.err}>{err}</span></MessageBarBody></MessageBar> : null}
      {notice ? <MessageBar intent="success"><MessageBarBody><span className={s.err}>{notice}</span></MessageBarBody></MessageBar> : null}
      {backend === 'databricks' && databricksGate ? (
        <MessageBar intent="warning"><MessageBarBody>
          <MessageBarTitle>Databricks Lakebase backend not fully opted in</MessageBarTitle>
          <span className={s.err}>{databricksGate.detail}</span>
        </MessageBarBody></MessageBar>
      ) : null}
    </>
  );

  const workingDb = cfg.database || 'postgres';
  const serverDetails = cfg.server ? (
    <DetailsPanel
      title="Server details"
      subtitle={cfg.server.name}
      icon={<DatabasePlugConnected20Regular />}
      sections={[
        {
          key: 'overview', title: 'Overview',
          stats: [
            { key: 'state', label: 'State', value: live?.state || '—' },
            { key: 'version', label: 'Version', value: `PostgreSQL ${live?.version || '—'}` },
            { key: 'compute', label: 'Compute', value: live?.sku?.name || '—' },
            { key: 'storage', label: 'Storage', value: live?.storageGb ? `${live.storageGb} GiB` : '—' },
            { key: 'ha', label: 'High availability', value: live?.highAvailability || 'Disabled' },
            { key: 'region', label: 'Region', value: live?.location || cfg.server.location || '—' },
            { key: 'pgvector', label: 'pgvector', value: cfg.pgvectorEnabled ? 'Enabled' : 'Not enabled' },
          ],
        },
        {
          key: 'endpoints', title: 'Endpoints',
          uris: [
            { key: 'fqdn', label: 'Server FQDN', value: cfg.server.fqdn },
            { key: 'conn', label: 'Connection string', value: `host=${cfg.server.fqdn} port=5432 dbname=${workingDb} sslmode=require` },
            { key: 'psql', label: 'psql command', value: `psql "host=${cfg.server.fqdn} port=5432 dbname=${workingDb} sslmode=require"` },
          ],
        },
        {
          key: 'policies', title: 'Configuration',
          policies: [
            {
              key: 'database', label: 'Working database',
              value: workingDb, type: 'select' as const,
              options: (databases.length ? databases : ['postgres']).map((d) => ({ value: d, label: d })),
              hint: 'The database SQL, branches and vector search run against.',
              onSave: (next) => patchReturning({ action: 'setDatabase', database: String(next) }),
            },
            {
              key: 'backend', label: 'Backend',
              value: backend, type: 'select' as const,
              options: [
                { value: 'postgres', label: 'Azure PostgreSQL Flexible Server (default)' },
                { value: 'databricks', label: 'Databricks Lakebase (opt-in)' },
              ],
              hint: 'Azure PostgreSQL is the default. Databricks Lakebase is opt-in.',
              onSave: (next) => patchReturning({ action: 'setBackend', backend: String(next) }),
            },
          ],
        },
      ]}
      related={{
        title: 'Databases',
        items: (databases.length ? databases : ['postgres']).map((d) => ({
          id: d, name: d, kind: d === workingDb ? 'Working' : 'Database',
          icon: <DatabasePlugConnected20Regular />,
          onClick: () => patch({ action: 'setDatabase', database: d }, 'setDatabase'),
        })),
        emptyText: 'No databases discovered yet.',
      }}
    />
  ) : null;

  const overview = (
    <div className={s.pad}>
      {/* SC-6 teaching banner — Fabric-style "what can I do here" guidance. */}
      <TeachingBanner
        surfaceKey="lakebase-analyze"
        title="Serverless Postgres OLTP"
        message="Provision an Azure Database for PostgreSQL Flexible Server, run SQL over the real pg wire protocol, branch with point-in-time restore, add read replicas, and enable pgvector for hybrid vector search — no Databricks or Fabric required."
        learnMoreHref="https://learn.microsoft.com/azure/postgresql/flexible-server/overview"
      />
      {banners}
      <div className={s.row}>
        <Badge appearance="tint" color={backend === 'postgres' ? 'brand' : 'informative'}>
          Backend: {backend === 'postgres' ? 'Azure PostgreSQL Flexible Server (default)' : 'Databricks Lakebase (opt-in)'}
        </Badge>
        {cfg.pgvectorEnabled ? <Badge appearance="tint" color="success">pgvector enabled</Badge> : null}
      </div>
      {!cfg.server ? (
        // SC-4 guided empty state — multi-path launcher replacing the plain
        // "no server bound" MessageBar (Fabric's guided empty designers).
        <GuidedEmptyState
          title="Bring your Lakebase online"
          intro="No server is bound yet. Start from one of these paths — every one runs a real Azure action."
          heroIcon={DatabaseArrowUp20Regular}
          paths={[
            { key: 'provision', title: 'Provision a new server', body: 'Create an Azure PostgreSQL Flexible Server (compute, storage, HA).', icon: DatabaseArrowUp20Regular, onClick: () => setTab('provision') },
            { key: 'bind', title: 'Bind an existing server', body: 'Attach a Flexible Server already in your subscription.', icon: DatabasePlugConnected20Regular, onClick: () => setTab('provision') },
          ]}
          askCopilot={{ onClick: () => openCopilot(), body: 'Describe the workload and let Copilot size and provision the server.' }}
          learnMoreHref="https://learn.microsoft.com/azure/postgresql/flexible-server/quickstart-create-server-portal"
        />
      ) : (
        <div className={s.detailsRow}>
          <div className={s.detailsMain}>
            <div className={s.card}>
              <Subtitle2>{cfg.server.name}</Subtitle2>
              <Caption1 className={s.mono}>{cfg.server.fqdn}</Caption1>
              <div className={s.statGrid}>
                <div className={s.stat}><span className={s.statLabel}>State</span><Body1>{live?.state || '—'}</Body1></div>
                <div className={s.stat}><span className={s.statLabel}>Version</span><Body1>PostgreSQL {live?.version || '—'}</Body1></div>
                <div className={s.stat}><span className={s.statLabel}>Compute</span><Body1>{live?.sku?.name || '—'}</Body1></div>
                <div className={s.stat}><span className={s.statLabel}>Storage</span><Body1>{live?.storageGb ? `${live.storageGb} GiB` : '—'}</Body1></div>
                <div className={s.stat}><span className={s.statLabel}>HA</span><Body1>{live?.highAvailability || 'Disabled'}</Body1></div>
                <div className={s.stat}><span className={s.statLabel}>Region</span><Body1>{live?.location || cfg.server.location || '—'}</Body1></div>
              </div>
              <Divider />
              <div className={s.row}>
                <Field label="Working database" className={s.field}>
                  <Dropdown value={workingDb} selectedOptions={[workingDb]}
                    onOptionSelect={(_, d) => d.optionValue && patch({ action: 'setDatabase', database: d.optionValue }, 'setDatabase')}>
                    {(databases.length ? databases : ['postgres']).map((d) => <Option key={d} value={d}>{d}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Backend" className={s.field}>
                  <Dropdown value={backend} selectedOptions={[backend]}
                    onOptionSelect={(_, d) => d.optionValue && patch({ action: 'setBackend', backend: d.optionValue }, 'setBackend')}>
                    <Option value="postgres">Azure PostgreSQL Flexible Server (default)</Option>
                    <Option value="databricks">Databricks Lakebase (opt-in)</Option>
                  </Dropdown>
                </Field>
              </div>
            </div>
            {/* In-database query IS wired (Query tab → real pg wire execution).
                The only non-functional case is the one-time Entra-principal
                setup; that honest Fix-it gate lives on the Query tab itself,
                so the overview no longer carries a stale query banner here. */}
          </div>
          {serverDetails}
        </div>
      )}
    </div>
  );

  const provision = (
    <div className={s.pad}>
      {banners}
      <div className={s.card}>
        <Subtitle2>Bind an existing server</Subtitle2>
        <div className={s.row}>
          <Field label="PostgreSQL Flexible Server" className={s.field}>
            <Dropdown placeholder="Select a server" onOptionSelect={(_, d) => d.optionValue && patch({ action: 'bind', server: d.optionValue }, 'bind')}>
              {inventory.map((sv) => <Option key={sv.name} value={sv.name}>{sv.name}</Option>)}
            </Dropdown>
          </Field>
          <Button icon={<ArrowSync20Regular />} onClick={loadProvision} appearance="subtle">Refresh inventory</Button>
        </div>
      </div>
      <div className={s.card}>
        <Subtitle2>Provision a new server</Subtitle2>
        {/* #3521 — pickers, not free text, and a name Loom already knows.
            This row was three raw <Input>s: an empty Server name, a typed
            resource-group NAME, and a typed region string with an "e.g. eastus"
            placeholder — while the sibling ADF create-factory form next door had
            already moved to the shared AzureResourcePicker + a real region
            Dropdown. Typing a region is not merely inconvenient: `usgovvirginia`
            mistyped is an ARM 400 the operator has to decode, and it is the
            per-cloud value a Commercial-shaped example is least likely to help
            with. */}
        <div className={s.row}>
          <Field label="Server name" className={s.field}
            hint={wz.name ? 'Pre-filled from this item\'s name; 3-63 lowercase letters, digits or hyphens.' : 'Globally unique; 3-63 lowercase letters, digits or hyphens.'}>
            <Input value={wz.name} onChange={(_, d) => setWz({ ...wz, name: d.value })} />
          </Field>
          <div className={s.field}>
            <AzureResourcePicker
              type="Microsoft.Resources/subscriptions/resourceGroups"
              label="Resource group"
              placeholder="Select a resource group (across all subscriptions)"
              value={rgPick?.id}
              onChange={(r) => {
                setRgPick(r);
                // The provision route takes the resource-group NAME (its own
                // contract, `provision/route.ts:67`), so the picker's richer
                // object is projected down to it here rather than changing a
                // wire shape this editor does not own. The RG's location becomes
                // the default region — the answer that is right far more often
                // than any constant, and still overridable below.
                setWz((w) => ({
                  ...w,
                  resourceGroup: r?.name || '',
                  location: w.location || r?.location || '',
                }));
              }}
            />
          </div>
          <Field label="Location" className={s.field} hint="Azure region for the new server. Defaults to the resource group's region.">
            <Dropdown placeholder="Select a region" value={wz.location} selectedOptions={wz.location ? [wz.location] : []}
              onOptionSelect={(_, d) => d.optionValue && setWz({ ...wz, location: d.optionValue })}>
              {AZURE_REGIONS.map((r) => <Option key={r} value={r} text={r}>{r}</Option>)}
            </Dropdown>
          </Field>
        </div>
        <div className={s.row}>
          <Field label="Compute SKU" className={s.field}>
            <Dropdown value={catalog?.skus.find((k) => k.name === wz.skuName)?.label || wz.skuName} selectedOptions={[wz.skuName]}
              onOptionSelect={(_, d) => d.optionValue && setWz({ ...wz, skuName: d.optionValue })}>
              {(catalog?.skus || []).map((k) => <Option key={k.name} value={k.name}>{k.label}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Storage (GiB)" className={s.field}>
            <Dropdown value={String(wz.storageGb)} selectedOptions={[String(wz.storageGb)]}
              onOptionSelect={(_, d) => d.optionValue && setWz({ ...wz, storageGb: Number(d.optionValue) })}>
              {(catalog?.storageGb || [32]).map((g) => <Option key={g} value={String(g)} text={`${g} GiB`}>{g} GiB</Option>)}
            </Dropdown>
          </Field>
          <Field label="PostgreSQL version" className={s.field}>
            <Dropdown value={wz.version} selectedOptions={[wz.version]}
              onOptionSelect={(_, d) => d.optionValue && setWz({ ...wz, version: d.optionValue })}>
              {(catalog?.versions || ['16']).map((v) => <Option key={v} value={v} text={`PostgreSQL ${v}`}>PostgreSQL {v}</Option>)}
            </Dropdown>
          </Field>
          <Field label="High availability" className={s.field}>
            <Dropdown value={catalog?.ha.find((h) => h.value === wz.ha)?.label || wz.ha} selectedOptions={[wz.ha]}
              onOptionSelect={(_, d) => d.optionValue && setWz({ ...wz, ha: d.optionValue })}>
              {(catalog?.ha || [{ value: 'Disabled', label: 'No high availability' }]).map((h) => <Option key={h.value} value={h.value}>{h.label}</Option>)}
            </Dropdown>
          </Field>
        </div>
        {/* #3521 boy-scout — THE PLATFORM MINTS THE ADMIN CREDENTIAL.
            This was a bare "Admin password" text box: the last thing on this form
            the operator was asked to invent, and the one thing no discovery call
            could ever have supplied. `auto-bind-by-default.md` §5 says the answer
            to that is not a better picker, it is for the platform to produce the
            value so nothing is asked at all — which is what
            `mintPostgresAdminPassword()` does, in the browser, from
            `crypto.getRandomValues`.
            The value is DISCLOSED, not hidden: it is shown once, copyable, with
            the plain statement that Loom does not keep it. Day-to-day access to
            this server is Entra (the Console UAMI), not this credential — ARM
            simply requires one at create time. */}
        <div className={s.row}>
          <Field label="Admin login" className={s.field} hint="Pre-set by Loom; ARM requires an administrator at create time.">
            <Input value={wz.administratorLogin} onChange={(_, d) => setWz({ ...wz, administratorLogin: d.value })} />
          </Field>
          <div className={s.field}>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>ADMIN PASSWORD</Caption1>
            <Caption1 className={s.mono} data-testid="lakebase-generated-admin-password">
              {wz.administratorLoginPassword || 'generating…'}
            </Caption1>
            <div className={s.row}>
              <Button size="small" appearance="secondary" icon={<ArrowSync20Regular />}
                onClick={() => setWz((w) => ({ ...w, administratorLoginPassword: mintPostgresAdminPassword() }))}>
                Regenerate
              </Button>
              <Button size="small" appearance="subtle"
                onClick={() => { void navigator.clipboard?.writeText(wz.administratorLoginPassword); }}>
                Copy
              </Button>
            </div>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              Generated in your browser and sent once to create the server. Loom does not store it — copy it now if
              you want SQL-auth access later. Everyday access uses Microsoft Entra via the Console managed identity.
            </Caption1>
          </div>
        </div>
        <div className={s.row}>
          <Button appearance="primary" icon={busy === 'provision' ? <Spinner size="tiny" /> : <DatabaseArrowUp20Regular />}
            disabled={!!busy || !wz.name || !wz.resourceGroup || !wz.location || !wz.skuName || !wz.administratorLogin || !wz.administratorLoginPassword}
            onClick={doProvision}>Provision (ARM)</Button>
        </div>
      </div>
    </div>
  );

  const query = (
    <div className={s.pad}>
      {banners}
      {/* In-database query is wired end-to-end (Run → POST /query → real pg
          wire execution). The one honest gate is a ONE-TIME Entra-principal
          registration; we surface it as a guided Fix-it (the exact SQL + a
          Learn link) rather than a "not wired" banner. The Query editor still
          renders + runs the moment the principal is registered. */}
      {queryGate ? (
        <MessageBar intent="warning" layout="multiline"><MessageBarBody>
          <MessageBarTitle>One-time Entra setup enables in-database query</MessageBarTitle>
          <span className={s.err}>{queryGate.detail}</span>
        </MessageBarBody>
        <MessageBarActions>
          <Link href="https://learn.microsoft.com/azure/postgresql/flexible-server/how-to-configure-sign-in-azure-ad-authentication" target="_blank" rel="noreferrer">Set up Entra sign-in</Link>
        </MessageBarActions></MessageBar>
      ) : null}
      <div className={s.row}><Caption1>Database: <b>{cfg.database || 'postgres'}</b> · Server: <b>{cfg.server?.name || '—'}</b></Caption1></div>
      <div style={{ height: 220 }}>
        <MonacoTextarea value={sql} onChange={setSql} language="sql" ariaLabel="PostgreSQL query" />
      </div>
      <div className={s.row}>
        <Button appearance="primary" icon={busy === 'query' ? <Spinner size="tiny" /> : <Play20Regular />} disabled={!!busy || !cfg.server} onClick={runQuery}>Run</Button>
      </div>
      {queryResult ? (
        <PreviewTable
          sources={[{ id: 'lakebase-query', label: 'Results', data: { columns: queryResult.columns, rows: queryResult.rows, elapsedMs: queryResult.executionMs, rowCount: queryResult.rowCount, note: queryResult.command } }]}
          showTabs={false} maxRows={1000} maxHeight={360} ariaLabel="Query results"
        />
      ) : null}
    </div>
  );

  const branches = (
    <div className={s.pad}>
      {banners}
      <div className={s.card}>
        <Subtitle2>Snapshots (point-in-time markers)</Subtitle2>
        <div className={s.row}>
          <Field label="Label" className={s.field}><Input value={snapLabel} onChange={(_, d) => setSnapLabel(d.value)} placeholder="Before migration X" /></Field>
          <Button icon={busy === 'snapshot' ? <Spinner size="tiny" /> : <Camera20Regular />} disabled={!!busy || !cfg.server} onClick={createSnapshot}>Capture snapshot</Button>
        </div>
        {(cfg.snapshots || []).length ? (
          <div className={s.grid}><Table size="small"><TableHeader><TableRow><TableHeaderCell>Label</TableHeaderCell><TableHeaderCell>Point in time (UTC)</TableHeaderCell><TableHeaderCell>Action</TableHeaderCell></TableRow></TableHeader>
            <TableBody>{(cfg.snapshots || []).map((sn) => <TableRow key={sn.id}><TableCell>{sn.label}</TableCell><TableCell className={s.mono}>{sn.pointInTimeUTC}</TableCell><TableCell><Button size="small" icon={<BranchFork20Regular />} disabled={!!busy || !branchName} onClick={() => createBranch(sn.id)}>Branch from this</Button></TableCell></TableRow>)}</TableBody></Table></div>
        ) : <Caption1>No snapshots yet.</Caption1>}
      </div>
      <div className={s.card}>
        <Subtitle2>Branches (point-in-time restore → new server)</Subtitle2>
        <div className={s.row}>
          <Field label="Branch server name" className={s.field}><Input value={branchName} onChange={(_, d) => setBranchName(d.value)} /></Field>
          <Button appearance="primary" icon={busy === 'branch' ? <Spinner size="tiny" /> : <BranchFork20Regular />} disabled={!!busy || !cfg.server || !branchName} onClick={() => createBranch()}>Branch from now</Button>
        </div>
        {(cfg.branches || []).length ? (
          <div className={s.grid}><Table size="small"><TableHeader><TableRow><TableHeaderCell>Server</TableHeaderCell><TableHeaderCell>Restored to (UTC)</TableHeaderCell><TableHeaderCell>State</TableHeaderCell></TableRow></TableHeader>
            <TableBody>{(cfg.branches || []).map((b) => <TableRow key={b.id}><TableCell>{b.name}</TableCell><TableCell className={s.mono}>{b.pointInTimeUTC}</TableCell><TableCell>{b.provisioningState || 'Creating'}</TableCell></TableRow>)}</TableBody></Table></div>
        ) : <Caption1>No branches yet.</Caption1>}
      </div>
    </div>
  );

  const replicasTab = (
    <div className={s.pad}>
      {banners}
      <div className={s.card}>
        <Subtitle2>Read replicas (DR / read-scale)</Subtitle2>
        <div className={s.row}>
          <Field label="Replica server name" className={s.field}><Input value={replicaName} onChange={(_, d) => setReplicaName(d.value)} /></Field>
          <Button appearance="primary" icon={busy === 'replica' ? <Spinner size="tiny" /> : <Add20Regular />} disabled={!!busy || !cfg.server || !replicaName} onClick={createReplica}>Create replica</Button>
          <Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={loadReplicas}>Refresh</Button>
        </div>
        {replicas.length ? (
          <div className={s.grid}><Table size="small"><TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>State</TableHeaderCell><TableHeaderCell>Region</TableHeaderCell></TableRow></TableHeader>
            <TableBody>{replicas.map((rp) => <TableRow key={rp.name}><TableCell>{rp.name}</TableCell><TableCell>{rp.state || '—'}</TableCell><TableCell>{rp.location || '—'}</TableCell></TableRow>)}</TableBody></Table></div>
        ) : <Caption1>No read replicas.</Caption1>}
      </div>
    </div>
  );

  const vector = (
    <div className={s.pad}>
      {banners}
      <div className={s.card}>
        <Subtitle2>pgvector (hybrid vector + full-text search)</Subtitle2>
        <div className={s.row}>
          <Badge appearance="tint" color={cfg.pgvectorEnabled ? 'success' : 'informative'}>{cfg.pgvectorEnabled ? 'Enabled' : 'Not enabled'}</Badge>
          <Button appearance="primary" icon={busy === 'pgvector' ? <Spinner size="tiny" /> : <DatabaseArrowUp20Regular />} disabled={!!busy || !cfg.server} onClick={enablePgvector}>Enable pgvector</Button>
        </div>
        <Caption1>Adds VECTOR to the server&apos;s azure.extensions allowlist (ARM) and runs CREATE EXTENSION over the pg wire protocol.</Caption1>
      </div>
      <div className={s.card}>
        <Subtitle2>Vector-distance (kNN) search</Subtitle2>
        <div className={s.row}>
          <Field label="Table" className={s.field}><Input value={vec.table} onChange={(_, d) => setVec({ ...vec, table: d.value })} placeholder="documents" /></Field>
          <Field label="Vector column" className={s.field}><Input value={vec.vectorColumn} onChange={(_, d) => setVec({ ...vec, vectorColumn: d.value })} /></Field>
          <Field label="Distance" className={s.field}>
            <Dropdown value={vec.distance} selectedOptions={[vec.distance]} onOptionSelect={(_, d) => d.optionValue && setVec({ ...vec, distance: d.optionValue })}>
              <Option value="cosine">Cosine (&lt;=&gt;)</Option>
              <Option value="l2">Euclidean / L2 (&lt;-&gt;)</Option>
              <Option value="inner_product">Inner product (&lt;#&gt;)</Option>
            </Dropdown>
          </Field>
          <Field label="Top N" className={s.field}><Input type="number" value={String(vec.limit)} onChange={(_, d) => setVec({ ...vec, limit: Number(d.value) })} /></Field>
        </div>
        <Field label="Query vector (JSON array)"><Input value={vec.vector} onChange={(_, d) => setVec({ ...vec, vector: d.value })} className={s.mono} /></Field>
        <div className={s.row}><Button appearance="primary" icon={busy === 'vsearch' ? <Spinner size="tiny" /> : <Search20Regular />} disabled={!!busy || !cfg.server || !vec.table} onClick={runVectorSearch}>Search</Button></div>
        {vectorRows ? (
          <PreviewTable
            sources={[{ id: 'lakebase-vector', label: 'Vector matches', data: { columns: vectorRows.columns, rows: vectorRows.rows, elapsedMs: vectorRows.executionMs, rowCount: vectorRows.rowCount, note: vectorRows.command } }]}
            showTabs={false} maxRows={1000} maxHeight={360} ariaLabel="Vector search matches"
          />
        ) : null}
      </div>
    </div>
  );

  const main = (
    <div style={{ minWidth: 0 }}>
      <div className={s.tabBar}>
        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
          <Tab value="overview" icon={<DatabasePlugConnected20Regular />}>Overview</Tab>
          <Tab value="provision" icon={<DatabaseArrowUp20Regular />}>Provision</Tab>
          <Tab value="query" icon={<Play20Regular />}>Query</Tab>
          <Tab value="branches" icon={<BranchFork20Regular />}>Branches</Tab>
          <Tab value="replicas" icon={<Add20Regular />}>Replicas</Tab>
          <Tab value="vector" icon={<Search20Regular />}>pgvector</Tab>
        </TabList>
      </div>
      {loading ? <div className={s.pad}><Spinner label="Loading…" /></div> : null}
      {!loading && tab === 'overview' ? overview : null}
      {!loading && tab === 'provision' ? provision : null}
      {!loading && tab === 'query' ? query : null}
      {!loading && tab === 'branches' ? branches : null}
      {!loading && tab === 'replicas' ? replicasTab : null}
      {!loading && tab === 'vector' ? vector : null}
    </div>
  );

  return <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={main} displayName={item.displayName} commandSearch />;
}
