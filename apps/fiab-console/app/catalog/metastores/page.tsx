'use client';

/**
 * Catalog → Metastores & accounts (Loom-parity redesign).
 *
 * Presentation-only migration onto the shared Loom primitives — the data
 * contract from /api/catalog/metastores is unchanged. The page now stacks
 * Section cards (Section/Toolbar from lib/components/ui/section), summarizes the
 * catalog back-ends with ItemTile/TileGrid, and renders every tabular surface
 * with LoomDataTable (which supplies sort + typed per-column filters + sticky
 * header + empty/loading states), replacing the five hand-rolled Fluent
 * <Table>s and the bespoke sort/filter machinery.
 *
 * Azure-native is the default and never gated on Fabric: Unity Catalog +
 * Microsoft Purview are the primary Sections; Fabric / OneLake is one optional
 * read-only Section + tile that gates nothing. Honest account-admin / config
 * gates are preserved verbatim per no-vaporware.
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useState } from 'react';
import { CatalogShell } from '@/lib/components/catalog/catalog-shell';
import { Section } from '@/lib/components/ui/section';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { ItemTile } from '@/lib/components/ui/item-tile';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import {
  Spinner, Button, Input, Field, Dropdown, Option, Checkbox, MessageBar, MessageBarBody,
  MessageBarTitle, MessageBarActions, Body1, Caption1, Badge, Divider, Subtitle2,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  Add24Regular, ArrowSync24Regular,
  DatabaseLink24Regular, ShieldTask24Regular, Globe24Regular,
  CheckmarkCircle24Filled, Link24Regular,
} from '@fluentui/react-icons';

interface UnityMeta { metastore_id: string; name: string; region?: string; workspace_hostname: string; }
interface OneLakeWs { id: string; displayName: string; capacityId?: string; }
interface DiscoverableWs {
  id: string; name: string; workspaceUrl: string; workspaceNumericId?: string;
  location?: string; resourceGroup?: string; subscriptionId: string; sku?: string;
}
interface AccountMetastore { metastore_id: string; name: string; region?: string; }
interface Registration {
  id: string; workspaceUrl: string; workspaceName?: string; metastoreId?: string;
  ucAttached: boolean; purviewRegistered: boolean; purviewScanned: boolean;
  purviewSourceName?: string; lastScanRunId?: string; registeredAt: string;
}
interface AccountAdminGate {
  title: string; detail: string;
  remediation: { role: string; identity: string; where: string };
}
interface ProbeCatalog { name: string; catalog_type?: string; owner?: string; }

const useStyles = makeStyles({
  // small form-specific helpers — no primitive covers these.
  muted: { color: tokens.colorNeutralForeground3 },
  mutedBlock: { color: tokens.colorNeutralForeground3, display: 'block', marginBottom: tokens.spacingVerticalM },
  cellStack: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word',
  },
  formHead: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalL,
  },
  formHeadIcon: { color: tokens.colorBrandForeground1, flexShrink: 0 },
  registerGrid: {
    display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: tokens.spacingHorizontalM, alignItems: 'end',
  },
  scanGrid: {
    display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
    gap: tokens.spacingHorizontalM, marginTop: tokens.spacingVerticalS,
  },
  receipt: {
    marginTop: tokens.spacingVerticalM, padding: tokens.spacingHorizontalL,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  receiptHead: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalM, flexWrap: 'wrap',
  },
  linkBtn: { marginTop: tokens.spacingVerticalXS, paddingLeft: 0 },
  footer: {
    display: 'flex', justifyContent: 'flex-end',
    marginTop: tokens.spacingVerticalL, paddingTop: tokens.spacingVerticalM,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  mb: { marginBottom: tokens.spacingVerticalM },
  // spacing helpers — token-driven, replaces scattered inline magic numbers
  spinner: { marginTop: tokens.spacingVerticalXXL },
  msgMt: { marginTop: tokens.spacingVerticalM },
  formHeadTight: { marginTop: 0 },
  dividerTop: { marginTop: tokens.spacingVerticalL },
  dividerMid: { marginTop: tokens.spacingVerticalM, marginBottom: tokens.spacingVerticalM },
  // honest-gate remediation block — identity values can be long resource IDs,
  // so wrap them rather than overflow the MessageBar.
  remediation: {
    marginTop: tokens.spacingVerticalS,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase300,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    overflowWrap: 'anywhere', wordBreak: 'break-word',
  },
  // pre blocks for diagnostic JSON hints — wrap + bound + scroll so a large
  // hint blob never overflows horizontally or leaves dead vertical space.
  hintPre: {
    marginTop: tokens.spacingVerticalS,
    marginBottom: 0,
    padding: tokens.spacingHorizontalS,
    fontSize: tokens.fontSizeBase200,
    fontFamily: tokens.fontFamilyMonospace,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    overflowWrap: 'anywhere',
    maxWidth: '100%',
    maxHeight: '320px',
    overflowY: 'auto',
    overflowX: 'auto',
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
  },
  envLine: {
    marginTop: tokens.spacingVerticalXS, fontSize: tokens.fontSizeBase200,
    overflowWrap: 'anywhere', wordBreak: 'break-word',
  },
  errorList: {
    margin: 0, marginTop: tokens.spacingVerticalXS, paddingLeft: tokens.spacingHorizontalXL,
    overflowWrap: 'anywhere', wordBreak: 'break-word',
  },
  captionBlock: {
    display: 'block', marginTop: tokens.spacingVerticalXS,
    overflowWrap: 'anywhere', wordBreak: 'break-word',
  },
  receiptIcon: { color: tokens.colorPaletteGreenForeground1, flexShrink: 0 },
  endorseMb: { marginBottom: tokens.spacingVerticalS },
  emptyCentered: {
    alignItems: 'center', textAlign: 'center',
    paddingTop: tokens.spacingVerticalM, paddingBottom: tokens.spacingVerticalM,
  },
  purviewEndpoint: {
    display: 'block', marginTop: tokens.spacingVerticalXXS,
    overflowWrap: 'anywhere', wordBreak: 'break-word',
  },
});

export default function MetastoresPage() {
  const s = useStyles();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Registration: dropdown of discovered workspaces + manual fallback.
  const [selectedWs, setSelectedWs] = useState<string>('');
  const [manualMode, setManualMode] = useState(false);
  const [manualHost, setManualHost] = useState('');
  const [registering, setRegistering] = useState(false);
  const [probeResult, setProbeResult] = useState<any>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  // Attach + Purview options.
  const [selectedMetastore, setSelectedMetastore] = useState<string>('');
  const [registerPurview, setRegisterPurview] = useState(false);
  const [runScan, setRunScan] = useState(false);
  const [scanAuth, setScanAuth] = useState<'managed-identity' | 'access-token'>('managed-identity');
  const [scanHttpPath, setScanHttpPath] = useState('');
  const [scanCredential, setScanCredential] = useState('');
  const [scanIR, setScanIR] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await clientFetch('/api/catalog/metastores');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setData(j);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const discoverable: DiscoverableWs[] = data?.discoverableWorkspaces ?? [];
  const accountMetastores: AccountMetastore[] = data?.accountMetastores ?? [];
  const registrations: Registration[] = data?.registrations ?? [];
  const unity: UnityMeta[] = data?.unity ?? [];
  const onelake: OneLakeWs[] = data?.onelake ?? [];
  const selectedWsObj = discoverable.find((w) => w.workspaceUrl === selectedWs);
  const gate: AccountAdminGate | undefined = data?.accountAdminGate;

  async function register() {
    const host = manualMode ? manualHost.trim() : selectedWs;
    if (!host) return;
    setRegistering(true);
    setProbeResult(null);
    setProbeError(null);
    try {
      const r = await clientFetch('/api/catalog/metastores', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'unity-catalog',
          hostname: host,
          workspaceName: selectedWsObj?.name,
          workspaceArmId: selectedWsObj?.id,
          workspaceNumericId: selectedWsObj?.workspaceNumericId,
          metastoreId: selectedMetastore || undefined,
          registerPurview,
          runScan,
          scan: runScan ? {
            auth: scanAuth,
            httpPath: scanHttpPath.trim() || undefined,
            credentialName: scanAuth === 'access-token' ? (scanCredential.trim() || undefined) : undefined,
            integrationRuntimeName: scanIR.trim() || undefined,
          } : undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setProbeError(j.error || 'registration failed'); setProbeResult(j); return; }
      setProbeResult(j);
      // Refresh the persisted list so the new row + badges appear.
      load();
    } catch (e: any) {
      setProbeError(e?.message || String(e));
    } finally {
      setRegistering(false);
    }
  }

  // ---- Column definitions (sort + typed per-column filters supplied by LoomDataTable) ----
  const registrationColumns: LoomColumn<Registration>[] = [
    {
      key: 'workspace', label: 'Workspace', width: 280, filterType: 'text',
      getValue: (r) => r.workspaceName || r.workspaceUrl,
      render: (r) => (
        <div className={s.cellStack}>
          <strong>{r.workspaceName || r.workspaceUrl}</strong>
          <Caption1 className={s.muted}>{r.workspaceUrl}</Caption1>
        </div>
      ),
    },
    {
      key: 'metastore', label: 'UC metastore', width: 220, filterType: 'text',
      getValue: (r) => (r.ucAttached ? `attached ${r.metastoreId || ''}` : 'not attached'),
      render: (r) => (
        <div className={s.cellStack}>
          {r.ucAttached ? (
            <Badge appearance="tint" color="success" icon={<CheckmarkCircle24Filled />}>Attached</Badge>
          ) : (
            <Badge appearance="outline" color="informative">Not attached</Badge>
          )}
          {r.metastoreId && <Caption1 className={s.muted}>{r.metastoreId}</Caption1>}
        </div>
      ),
    },
    {
      key: 'purview', label: 'Purview', width: 170, filterType: 'select',
      filterOptions: ['Scanned', 'Source registered', 'Not catalogued'],
      getValue: (r) => (r.purviewScanned ? 'Scanned' : r.purviewRegistered ? 'Source registered' : 'Not catalogued'),
      render: (r) => (
        r.purviewScanned ? <Badge appearance="tint" color="success">Scanned</Badge>
          : r.purviewRegistered ? <Badge appearance="tint" color="brand">Source registered</Badge>
          : <Badge appearance="outline" color="informative">—</Badge>
      ),
    },
    {
      key: 'registered', label: 'Registered', width: 180, filterType: 'date',
      getValue: (r) => r.registeredAt || '',
      render: (r) => (
        <Caption1 className={s.muted}>
          {r.registeredAt ? new Date(r.registeredAt).toLocaleString() : '—'}
        </Caption1>
      ),
    },
  ];

  const unityColumns: LoomColumn<UnityMeta>[] = [
    {
      key: 'name', label: 'Metastore', width: 300, filterType: 'text',
      getValue: (m) => m.name,
      render: (m) => (
        <div className={s.cellStack}>
          <strong>{m.name}</strong>
          <Caption1 className={s.muted}>{m.metastore_id}</Caption1>
        </div>
      ),
    },
    { key: 'region', label: 'Region', width: 160, getValue: (m) => m.region || '—', render: (m) => m.region || '—' },
    { key: 'workspace_hostname', label: 'Workspace', filterType: 'text', getValue: (m) => m.workspace_hostname },
  ];

  const onelakeColumns: LoomColumn<OneLakeWs>[] = [
    { key: 'displayName', label: 'Workspace', filterType: 'text', getValue: (w) => w.displayName, render: (w) => <strong>{w.displayName}</strong> },
    { key: 'capacityId', label: 'Capacity', getValue: (w) => w.capacityId || '—', render: (w) => w.capacityId || '—' },
  ];

  const catalogColumns: LoomColumn<ProbeCatalog>[] = [
    { key: 'name', label: 'Catalog', filterType: 'text', getValue: (c) => c.name, render: (c) => <strong>{c.name}</strong> },
    { key: 'catalog_type', label: 'Type', getValue: (c) => c.catalog_type || '—', render: (c) => c.catalog_type || '—' },
    { key: 'owner', label: 'Owner', getValue: (c) => c.owner || '—', render: (c) => c.owner || '—' },
  ];

  return (
    <CatalogShell sectionTitle="Metastores & accounts">
      {error && (
        <MessageBar intent="error" className={s.mb}>
          <MessageBarBody><MessageBarTitle>Couldn&apos;t load metastores</MessageBarTitle>{error}</MessageBarBody>
          <MessageBarActions>
            <Button size="small" icon={<ArrowSync24Regular />} onClick={load}>Retry</Button>
          </MessageBarActions>
        </MessageBar>
      )}
      {loading && !error && <Spinner label="Loading metastores…" className={s.spinner} />}

      {data && (
        <>
          {/* ---------- Overview tiles ---------- */}
          <Section title="Catalog back-ends">
            <TileGrid>
              <ItemTile
                type="unity-catalog"
                title="Databricks Unity Catalog"
                subtitle="Portable across Azure / AWS / GCP"
                meta={`${unity.length} metastore${unity.length === 1 ? '' : 's'} reachable`}
                badge={
                  gate
                    ? <Badge appearance="outline" color="warning">Account admin needed</Badge>
                    : unity.length > 0
                      ? <Badge appearance="tint" color="success">Live</Badge>
                      : <Badge appearance="outline" color="informative">None discovered</Badge>
                }
              />
              <ItemTile
                type="purview-account"
                title="Microsoft Purview"
                subtitle={data.purview ? data.purview.account : 'Azure-native data catalog'}
                meta={data.purview ? data.purview.endpoint : 'Optional — set LOOM_PURVIEW_ACCOUNT'}
                badge={
                  data.purview
                    ? <Badge appearance="tint" color="brand">Configured</Badge>
                    : <Badge appearance="outline" color="informative">Not configured</Badge>
                }
              />
              <ItemTile
                type="onelake-workspace"
                title="Fabric / OneLake"
                subtitle="Optional read-only mirror"
                meta={data.onelakeError ? 'Not available' : `${onelake.length} workspace${onelake.length === 1 ? '' : 's'} visible`}
                badge={
                  data.onelakeError
                    ? <Badge appearance="outline" color="informative">Optional</Badge>
                    : onelake.length > 0
                      ? <Badge appearance="tint" color="informative">{onelake.length}</Badge>
                      : <Badge appearance="outline" color="informative">Optional</Badge>
                }
              />
            </TileGrid>
          </Section>

          {/* ---------- Persisted registrations ---------- */}
          {registrations.length > 0 && (
            <Section
              title="Registered Databricks workspaces"
              actions={<Badge appearance="tint" color="brand">{registrations.length}</Badge>}
            >
              <Body1 className={s.mutedBlock}>
                These registrations persist across Console reloads — no bicep redeploy required.
              </Body1>
              <LoomDataTable<Registration>
                ariaLabel="Persisted Databricks registrations"
                columns={registrationColumns}
                rows={registrations}
                getRowId={(r) => r.id}
                empty="No registrations yet — register a workspace below."
              />
            </Section>
          )}

          {/* ---------- Databricks Unity Catalog ---------- */}
          <Section
            title="Databricks Unity Catalog"
            actions={unity.length > 0
              ? <Badge appearance="tint" color="brand">{unity.length} metastore{unity.length === 1 ? '' : 's'}</Badge>
              : undefined}
          >
            {/* Honest account-admin gate — the page still renders everything else. */}
            {gate && (
              <MessageBar intent="warning" className={s.mb}>
                <MessageBarBody>
                  <MessageBarTitle>{gate.title}</MessageBarTitle>
                  {gate.detail}
                  <div className={s.remediation}>
                    <div><strong>Role:</strong> {gate.remediation.role}</div>
                    <div><strong>Identity:</strong> <code>{gate.remediation.identity}</code></div>
                    <div><strong>Where:</strong> {gate.remediation.where}</div>
                  </div>
                </MessageBarBody>
              </MessageBar>
            )}

            {data.unityError ? (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Unity Catalog not configured</MessageBarTitle>{data.unityError}
                  {data.unityHint && (
                    <pre className={s.hintPre}>
                      {JSON.stringify(data.unityHint, null, 2)}
                    </pre>
                  )}
                </MessageBarBody>
              </MessageBar>
            ) : (
              <LoomDataTable<UnityMeta>
                ariaLabel="Unity Catalog metastores"
                columns={unityColumns}
                rows={unity}
                getRowId={(m) => m.metastore_id}
                empty={
                  <div className={mergeClasses(s.cellStack, s.emptyCentered)}>
                    <Body1>No metastores discovered</Body1>
                    <Caption1 className={s.muted}>
                      Confirm the Loom UAMI is in the UC metastore admin group, or register a workspace below.
                    </Caption1>
                  </div>
                }
              />
            )}

            {/* Per-workspace (non-admin) errors that aren't the account-admin gate. */}
            {Array.isArray(data.unityWorkspaceErrors) &&
              data.unityWorkspaceErrors.filter((w: any) => !w.accountAdmin).length > 0 && (
              <MessageBar intent="warning" className={s.msgMt}>
                <MessageBarBody>
                  <MessageBarTitle>Some workspaces were unreachable</MessageBarTitle>
                  <ul className={s.errorList}>
                    {data.unityWorkspaceErrors
                      .filter((w: any) => !w.accountAdmin)
                      .map((w: any) => <li key={w.workspace_hostname}><code>{w.workspace_hostname}</code>: {w.message}</li>)}
                  </ul>
                </MessageBarBody>
              </MessageBar>
            )}

            <Divider className={s.dividerTop} />

            {/* ---------- Register a Databricks workspace ---------- */}
            <div className={s.formHead}>
              <Add24Regular className={s.formHeadIcon} />
              <Subtitle2>Register a Databricks workspace</Subtitle2>
            </div>
            <Body1 className={s.mutedBlock}>
              Pick a workspace the Console identity can see, then register it. The registration is
              saved and survives Console reloads. Optionally attach it to a UC metastore and catalog
              it in Purview.
            </Body1>

            {data.discoveryError && (
              <MessageBar intent="info" className={s.mb}>
                <MessageBarBody>
                  Couldn&apos;t enumerate workspaces over ARM ({data.discoveryError}). Use manual entry below —
                  grant the Console UAMI <strong>Reader</strong> on the target subscriptions to populate the picker.
                </MessageBarBody>
              </MessageBar>
            )}

            <div className={s.registerGrid}>
              {manualMode ? (
                <Field label="Workspace hostname" hint="e.g. adb-1234567890.19.azuredatabricks.net">
                  <Input
                    value={manualHost}
                    onChange={(_, d) => setManualHost(d.value)}
                    placeholder="adb-…azuredatabricks.net"
                    contentBefore={<Globe24Regular />}
                  />
                </Field>
              ) : (
                <Field
                  label="Databricks workspace"
                  hint={discoverable.length ? `${discoverable.length} discovered across your subscriptions` : 'None discovered — switch to manual entry'}
                >
                  <Dropdown
                    placeholder={discoverable.length ? 'Select a workspace…' : 'No workspaces discovered'}
                    disabled={discoverable.length === 0}
                    value={selectedWsObj ? `${selectedWsObj.name} — ${selectedWsObj.workspaceUrl}` : ''}
                    selectedOptions={selectedWs ? [selectedWs] : []}
                    onOptionSelect={(_, d) => setSelectedWs(d.optionValue || '')}
                  >
                    {discoverable.map((w) => (
                      <Option key={w.id || w.workspaceUrl} value={w.workspaceUrl} text={`${w.name} — ${w.workspaceUrl}`}>
                        <div className={s.cellStack}>
                          <strong>{w.name}</strong>
                          <Caption1 className={s.muted}>
                            {w.workspaceUrl}{w.location ? ` · ${w.location}` : ''}{w.resourceGroup ? ` · ${w.resourceGroup}` : ''}
                          </Caption1>
                        </div>
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              )}
              <Button
                appearance="primary"
                icon={<Add24Regular />}
                onClick={register}
                disabled={registering || (manualMode ? !manualHost.trim() : !selectedWs)}
              >
                {registering ? 'Registering…' : 'Register'}
              </Button>
            </div>

            <Button
              appearance="transparent"
              size="small"
              className={s.linkBtn}
              onClick={() => { setManualMode((m) => !m); setProbeResult(null); setProbeError(null); }}
            >
              {manualMode ? '← Choose from discovered workspaces' : 'Enter a hostname manually instead'}
            </Button>

            {/* ---------- Attach to a UC metastore ---------- */}
            <Divider className={s.dividerMid} />
            <div className={mergeClasses(s.formHead, s.formHeadTight)}>
              <Link24Regular className={s.formHeadIcon} />
              <Subtitle2>Attach to a Unity Catalog metastore (optional)</Subtitle2>
            </div>
            {data.accountApiConfigured === false ? (
              <MessageBar intent="info" className={s.mb}>
                <MessageBarBody>
                  <MessageBarTitle>One-click attach not configured</MessageBarTitle>
                  {data.accountApiHint?.detail || 'Set LOOM_DATABRICKS_ACCOUNT_ID to enable metastore attach.'}
                  {data.accountApiHint?.missingEnvVar && (
                    <div className={s.envLine}>
                      Env var: <code>{data.accountApiHint.missingEnvVar}</code> · Bicep: <code>{data.accountApiHint.bicepModule}</code>
                    </div>
                  )}
                </MessageBarBody>
              </MessageBar>
            ) : (
              <Field
                label="UC metastore"
                hint={accountMetastores.length
                  ? 'Select the metastore to attach the workspace to (needs Databricks account admin).'
                  : (data.accountMetastoresError || 'No account metastores listable — the UAMI may not be an account admin.')}
              >
                <Dropdown
                  placeholder={accountMetastores.length ? 'Leave unset to skip attach…' : 'None listable'}
                  disabled={accountMetastores.length === 0}
                  value={accountMetastores.find((m) => m.metastore_id === selectedMetastore)?.name || ''}
                  selectedOptions={selectedMetastore ? [selectedMetastore] : []}
                  onOptionSelect={(_, d) => setSelectedMetastore(d.optionValue || '')}
                >
                  {accountMetastores.map((m) => (
                    <Option key={m.metastore_id} value={m.metastore_id} text={`${m.name} — ${m.metastore_id}`}>
                      <div className={s.cellStack}>
                        <strong>{m.name}</strong>
                        <Caption1 className={s.muted}>
                          {m.metastore_id}{m.region ? ` · ${m.region}` : ''}
                        </Caption1>
                      </div>
                    </Option>
                  ))}
                </Dropdown>
              </Field>
            )}

            {/* ---------- Purview registration + scan ---------- */}
            <Divider className={s.dividerMid} />
            <div className={mergeClasses(s.formHead, s.formHeadTight)}>
              <ShieldTask24Regular className={s.formHeadIcon} />
              <Subtitle2>Catalog in Microsoft Purview (optional)</Subtitle2>
            </div>
            {data.purview ? (
              <>
                <Checkbox
                  checked={registerPurview}
                  onChange={(_, d) => setRegisterPurview(!!d.checked)}
                  label="Register this workspace as an Azure Databricks Unity Catalog source in Purview"
                />
                {registerPurview && (
                  <>
                    <Checkbox
                      checked={runScan}
                      onChange={(_, d) => setRunScan(!!d.checked)}
                      label="Define + run a scan to catalog its metadata"
                    />
                    {runScan && (
                      <div className={s.scanGrid}>
                        <Field label="Scan credential" hint="Managed identity is recommended (no Key Vault)">
                          <Dropdown
                            value={scanAuth === 'access-token' ? 'Access token (Key Vault PAT)' : 'Managed identity (recommended)'}
                            selectedOptions={[scanAuth]}
                            onOptionSelect={(_, d) => setScanAuth((d.optionValue as 'managed-identity' | 'access-token') || 'managed-identity')}
                          >
                            <Option value="managed-identity" text="Managed identity (recommended)">
                              <div className={s.cellStack}>
                                <strong>Managed identity (recommended)</strong>
                                <Caption1 className={s.muted}>Uses the Purview account&apos;s system identity — no Key Vault</Caption1>
                              </div>
                            </Option>
                            <Option value="access-token" text="Access token (Key Vault PAT)">
                              <div className={s.cellStack}>
                                <strong>Access token (Key Vault PAT)</strong>
                                <Caption1 className={s.muted}>Databricks PAT stored as a Key-Vault-backed Purview credential</Caption1>
                              </div>
                            </Option>
                          </Dropdown>
                        </Field>
                        <Field label="SQL Warehouse HTTP path" hint="/sql/1.0/warehouses/…">
                          <Input value={scanHttpPath} onChange={(_, d) => setScanHttpPath(d.value)} placeholder="/sql/1.0/warehouses/abc123" />
                        </Field>
                        {scanAuth === 'access-token' && (
                          <Field required label="Purview credential (Key Vault Access Token)" hint="Name of the PAT credential in Purview">
                            <Input value={scanCredential} onChange={(_, d) => setScanCredential(d.value)} placeholder="dbx-pat-credential" />
                          </Field>
                        )}
                        <Field label="Integration runtime (optional)" hint="Defaults to the managed Azure IR">
                          <Input value={scanIR} onChange={(_, d) => setScanIR(d.value)} placeholder="AzureAutoResolveIntegrationRuntime" />
                        </Field>
                      </div>
                    )}
                    <Caption1 className={mergeClasses(s.muted, s.captionBlock)}>
                      Databricks UC scans authenticate with the Purview account&apos;s system-assigned managed identity
                      (default — register it as a Databricks service principal with UC SELECT/USE privileges via
                      <code> scripts/csa-loom/setup-purview-databricks-scan.sh</code>) or a Key-Vault Access Token (PAT),
                      plus a running SQL Warehouse. Table/column lineage additionally needs the <code>system.access</code>
                      schema enabled in Unity Catalog. Without scan config, only the source is registered.
                    </Caption1>
                  </>
                )}
              </>
            ) : (
              <MessageBar intent="warning">
                <MessageBarBody>{data.purviewError || 'Purview not configured'}</MessageBarBody>
              </MessageBar>
            )}

            {probeError && (
              <MessageBar intent="error" className={s.msgMt}>
                <MessageBarBody><MessageBarTitle>Registration failed</MessageBarTitle>{probeError}</MessageBarBody>
              </MessageBar>
            )}

            {probeResult?.ok && (
              <div className={s.receipt}>
                <div className={s.receiptHead}>
                  <DatabaseLink24Regular className={s.receiptIcon} />
                  <Body1><strong>{probeResult.probed}</strong> registered &amp; persisted</Body1>
                  <Badge appearance="tint" color="success">
                    {(probeResult.catalogs?.length ?? 0)} catalog{probeResult.catalogs?.length === 1 ? '' : 's'}
                  </Badge>
                  {probeResult.registration?.ucAttached && <Badge appearance="tint" color="brand">UC attached</Badge>}
                  {probeResult.registration?.purviewRegistered && <Badge appearance="tint" color="brand">Purview source</Badge>}
                  {probeResult.registration?.purviewScanned && <Badge appearance="tint" color="success">Scan triggered</Badge>}
                </div>

                {probeResult.accountAdminGate && (
                  <MessageBar intent="warning" className={s.endorseMb}>
                    <MessageBarBody>
                      <MessageBarTitle>{probeResult.accountAdminGate.title}</MessageBarTitle>
                      {probeResult.accountAdminGate.detail}
                    </MessageBarBody>
                  </MessageBar>
                )}

                {/* Per-step honest outcomes */}
                {probeResult.steps?.attach?.gate && (
                  <MessageBar intent="info" className={s.endorseMb}>
                    <MessageBarBody>{probeResult.steps.attach.gate.detail}</MessageBarBody>
                  </MessageBar>
                )}
                {probeResult.steps?.attach?.error && (
                  <MessageBar intent="warning" className={s.endorseMb}>
                    <MessageBarBody>Attach: {probeResult.steps.attach.error}</MessageBarBody>
                  </MessageBar>
                )}
                {probeResult.steps?.purview?.gate && (
                  <MessageBar intent="info" className={s.endorseMb}>
                    <MessageBarBody>{probeResult.steps.purview.gate.detail || probeResult.steps.purview.gate.followUp}</MessageBarBody>
                  </MessageBar>
                )}
                {probeResult.steps?.purview?.error && (
                  <MessageBar intent="warning" className={s.endorseMb}>
                    <MessageBarBody>Purview: {probeResult.steps.purview.error}</MessageBarBody>
                  </MessageBar>
                )}
                {probeResult.steps?.purview?.scanGate && (
                  <MessageBar intent="info" className={s.endorseMb}>
                    <MessageBarBody>
                      <MessageBarTitle>{probeResult.steps.purview.scanGate.title}</MessageBarTitle>
                      {probeResult.steps.purview.scanGate.detail}
                    </MessageBarBody>
                  </MessageBar>
                )}

                {Array.isArray(probeResult.catalogs) && probeResult.catalogs.length > 0 ? (
                  <LoomDataTable<ProbeCatalog>
                    ariaLabel="Catalogs in workspace"
                    columns={catalogColumns}
                    rows={probeResult.catalogs as ProbeCatalog[]}
                    getRowId={(c) => c.name}
                    noFilters
                    empty="No catalogs visible to the Console identity in this workspace yet."
                  />
                ) : (
                  <Caption1 className={s.muted}>
                    No catalogs visible to the Console identity in this workspace yet.
                  </Caption1>
                )}
              </div>
            )}
          </Section>

          {/* ---------- Fabric / OneLake (optional, read-only, gates nothing) ---------- */}
          <Section
            title="Fabric / OneLake"
            actions={onelake.length > 0
              ? <Badge appearance="tint" color="brand">{onelake.length} workspace{onelake.length === 1 ? '' : 's'}</Badge>
              : undefined}
          >
            <Body1 className={s.mutedBlock}>
              Optional read-only mirror — Loom never requires a Fabric capacity or workspace; Unity Catalog
              and Purview above are the Azure-native defaults.
            </Body1>
            {data.onelakeError ? (
              <MessageBar intent="warning"><MessageBarBody>{data.onelakeError}</MessageBarBody></MessageBar>
            ) : (
              <LoomDataTable<OneLakeWs>
                ariaLabel="OneLake workspaces"
                columns={onelakeColumns}
                rows={onelake}
                getRowId={(w) => w.id}
                empty="No OneLake workspaces visible."
              />
            )}
          </Section>

          {/* ---------- Microsoft Purview ---------- */}
          <Section title="Microsoft Purview">
            {data.purview ? (
              <Body1>
                Account <code>{data.purview.account}</code>
                <Caption1 className={mergeClasses(s.muted, s.purviewEndpoint)}>
                  {data.purview.endpoint}
                </Caption1>
              </Body1>
            ) : (
              <MessageBar intent="warning"><MessageBarBody>{data.purviewError}</MessageBarBody></MessageBar>
            )}
          </Section>

          <div className={s.footer}>
            <Button onClick={load} icon={<ArrowSync24Regular />} appearance="secondary">Refresh</Button>
          </div>
        </>
      )}
    </CatalogShell>
  );
}
