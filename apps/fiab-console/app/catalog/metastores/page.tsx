'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CatalogShell } from '@/lib/components/catalog/catalog-shell';
import {
  Spinner, Button, Input, Field, Dropdown, Option, Checkbox, MessageBar, MessageBarBody,
  MessageBarTitle, MessageBarActions, Table, TableHeader, TableRow, TableHeaderCell,
  TableBody, TableCell, Subtitle2, Body1, Caption1, Badge, Divider, SearchBox,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add24Regular, ArrowSync24Regular, Database24Regular,
  Cloud24Regular, DatabaseLink24Regular, ShieldTask24Regular, Globe24Regular,
  CheckmarkCircle24Filled, Link24Regular, DatabaseSearch24Regular,
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

const useStyles = makeStyles({
  card: {
    padding: tokens.spacingHorizontalXL,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    marginBottom: tokens.spacingVerticalXL,
    boxShadow: tokens.shadow4,
  },
  sectionHead: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalM,
  },
  sectionHeadIcon: { color: tokens.colorBrandForeground1, flexShrink: 0 },
  spacer: { flexGrow: 1 },
  mutedBlock: { color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalM },
  muted: { color: tokens.colorNeutralForeground3 },
  cellStack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  filterRow: { marginBottom: tokens.spacingVerticalM, maxWidth: '320px' },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalXXL} ${tokens.spacingHorizontalL}`,
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
  },
  emptyIcon: { color: tokens.colorNeutralForeground4 },
  registerGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gap: tokens.spacingHorizontalM,
    alignItems: 'end',
  },
  scanGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: tokens.spacingHorizontalM,
    marginTop: tokens.spacingVerticalS,
  },
  receipt: {
    marginTop: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalL,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  receiptHead: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalM,
    flexWrap: 'wrap',
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    marginTop: tokens.spacingVerticalL,
  },
  linkBtn: { marginTop: tokens.spacingVerticalXS, paddingLeft: 0 },
});

type SortCol = 'workspace' | 'metastore' | 'purview' | 'registered';
type SortDir = 'ascending' | 'descending';

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

  // Persisted-registrations table: filter + sort.
  const [regFilter, setRegFilter] = useState('');
  const [sortCol, setSortCol] = useState<SortCol>('registered');
  const [sortDir, setSortDir] = useState<SortDir>('descending');

  // Attach + Purview options.
  const [selectedMetastore, setSelectedMetastore] = useState<string>('');
  const [registerPurview, setRegisterPurview] = useState(false);
  const [runScan, setRunScan] = useState(false);
  const [scanHttpPath, setScanHttpPath] = useState('');
  const [scanCredential, setScanCredential] = useState('');
  const [scanIR, setScanIR] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/catalog/metastores');
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
  const selectedWsObj = discoverable.find((w) => w.workspaceUrl === selectedWs);

  const purviewRank = (r: Registration) => (r.purviewScanned ? 2 : r.purviewRegistered ? 1 : 0);

  const visibleRegistrations = useMemo(() => {
    const q = regFilter.trim().toLowerCase();
    const filtered = q
      ? registrations.filter((r) =>
          (r.workspaceName || '').toLowerCase().includes(q) ||
          (r.workspaceUrl || '').toLowerCase().includes(q) ||
          (r.metastoreId || '').toLowerCase().includes(q))
      : registrations;
    const dir = sortDir === 'ascending' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      switch (sortCol) {
        case 'workspace':
          cmp = (a.workspaceName || a.workspaceUrl).localeCompare(b.workspaceName || b.workspaceUrl);
          break;
        case 'metastore':
          cmp = Number(a.ucAttached) - Number(b.ucAttached) ||
            (a.metastoreId || '').localeCompare(b.metastoreId || '');
          break;
        case 'purview':
          cmp = purviewRank(a) - purviewRank(b);
          break;
        case 'registered':
        default:
          cmp = (new Date(a.registeredAt).getTime() || 0) - (new Date(b.registeredAt).getTime() || 0);
          break;
      }
      return cmp * dir;
    });
  }, [registrations, regFilter, sortCol, sortDir]);

  const onSort = (col: SortCol) => {
    if (col === sortCol) {
      setSortDir((d) => (d === 'ascending' ? 'descending' : 'ascending'));
    } else {
      setSortCol(col);
      setSortDir(col === 'registered' ? 'descending' : 'ascending');
    }
  };
  const headerProps = (col: SortCol) => ({
    sortable: true,
    sortDirection: sortCol === col ? sortDir : undefined,
    onClick: () => onSort(col),
  });

  async function register() {
    const host = manualMode ? manualHost.trim() : selectedWs;
    if (!host) return;
    setRegistering(true);
    setProbeResult(null);
    setProbeError(null);
    try {
      const r = await fetch('/api/catalog/metastores', {
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
            httpPath: scanHttpPath.trim() || undefined,
            credentialName: scanCredential.trim() || undefined,
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

  const gate: AccountAdminGate | undefined = data?.accountAdminGate;

  return (
    <CatalogShell sectionTitle="Metastores & accounts">
      {error && (
        <MessageBar intent="error" style={{ marginBottom: 16 }}>
          <MessageBarBody><MessageBarTitle>Couldn’t load metastores</MessageBarTitle>{error}</MessageBarBody>
          <MessageBarActions>
            <Button size="small" icon={<ArrowSync24Regular />} onClick={load}>Retry</Button>
          </MessageBarActions>
        </MessageBar>
      )}
      {loading && !error && <Spinner label="Loading metastores…" style={{ marginTop: 32 }} />}

      {data && (
        <>
          {/* ---------- Persisted registrations ---------- */}
          {registrations.length > 0 && (
            <div className={s.card}>
              <div className={s.sectionHead}>
                <Link24Regular className={s.sectionHeadIcon} />
                <Subtitle2>Registered Databricks workspaces</Subtitle2>
                <Badge appearance="tint" color="brand">{registrations.length}</Badge>
              </div>
              <Body1 className={s.mutedBlock}>
                These registrations persist across Console reloads — no bicep redeploy required.
              </Body1>
              {registrations.length > 4 && (
                <div className={s.filterRow}>
                  <SearchBox
                    placeholder="Filter by workspace or metastore…"
                    value={regFilter}
                    onChange={(_, d) => setRegFilter(d.value ?? '')}
                  />
                </div>
              )}
              <Table aria-label="Persisted registrations" size="medium" sortable>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell {...headerProps('workspace')}>Workspace</TableHeaderCell>
                    <TableHeaderCell {...headerProps('metastore')}>UC metastore</TableHeaderCell>
                    <TableHeaderCell {...headerProps('purview')}>Purview</TableHeaderCell>
                    <TableHeaderCell {...headerProps('registered')}>Registered</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleRegistrations.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        <div className={s.cellStack}>
                          <strong>{r.workspaceName || r.workspaceUrl}</strong>
                          <Caption1 className={s.muted}>{r.workspaceUrl}</Caption1>
                        </div>
                      </TableCell>
                      <TableCell>
                        {r.ucAttached ? (
                          <Badge appearance="tint" color="success" icon={<CheckmarkCircle24Filled />}>
                            Attached
                          </Badge>
                        ) : (
                          <Badge appearance="outline" color="informative">Not attached</Badge>
                        )}
                        {r.metastoreId && (
                          <Caption1 className={s.muted} style={{ display: 'block', marginTop: 2 }}>
                            {r.metastoreId}
                          </Caption1>
                        )}
                      </TableCell>
                      <TableCell>
                        {r.purviewScanned ? (
                          <Badge appearance="tint" color="success">Scanned</Badge>
                        ) : r.purviewRegistered ? (
                          <Badge appearance="tint" color="brand">Source registered</Badge>
                        ) : (
                          <Badge appearance="outline" color="informative">—</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Caption1 className={s.muted}>
                          {r.registeredAt ? new Date(r.registeredAt).toLocaleString() : '—'}
                        </Caption1>
                      </TableCell>
                    </TableRow>
                  ))}
                  {visibleRegistrations.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4}>
                        <Caption1 className={s.muted}>No registrations match “{regFilter}”.</Caption1>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}

          {/* ---------- Databricks Unity Catalog ---------- */}
          <div className={s.card}>
            <div className={s.sectionHead}>
              <Database24Regular className={s.sectionHeadIcon} />
              <Subtitle2>Databricks Unity Catalog</Subtitle2>
              {data.unity?.length > 0 && (
                <Badge appearance="tint" color="brand">{data.unity.length} metastore{data.unity.length === 1 ? '' : 's'}</Badge>
              )}
            </div>

            {/* Honest account-admin gate — the page still renders everything else. */}
            {gate && (
              <MessageBar intent="warning" style={{ marginBottom: 14 }}>
                <MessageBarBody>
                  <MessageBarTitle>{gate.title}</MessageBarTitle>
                  {gate.detail}
                  <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.6 }}>
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
                    <pre style={{ marginTop: 8, fontSize: 11, whiteSpace: 'pre-wrap' }}>
                      {JSON.stringify(data.unityHint, null, 2)}
                    </pre>
                  )}
                </MessageBarBody>
              </MessageBar>
            ) : data.unity?.length === 0 && !gate ? (
              <div className={s.emptyState}>
                <DatabaseSearch24Regular fontSize={32} className={s.emptyIcon} />
                <Body1>No metastores discovered</Body1>
                <Caption1 className={s.muted}>
                  Confirm the Loom UAMI is in the UC metastore admin group, or register a workspace below.
                </Caption1>
              </div>
            ) : data.unity?.length > 0 ? (
              <Table aria-label="Unity metastores" size="medium">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Metastore</TableHeaderCell>
                    <TableHeaderCell>Region</TableHeaderCell>
                    <TableHeaderCell>Workspace</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data.unity as UnityMeta[]).map((m) => (
                    <TableRow key={m.metastore_id}>
                      <TableCell>
                        <div className={s.cellStack}>
                          <strong>{m.name}</strong>
                          <Caption1 className={s.muted}>{m.metastore_id}</Caption1>
                        </div>
                      </TableCell>
                      <TableCell>{m.region || '—'}</TableCell>
                      <TableCell>{m.workspace_hostname}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : null}

            {/* Per-workspace (non-admin) errors that aren't the account-admin gate. */}
            {Array.isArray(data.unityWorkspaceErrors) &&
              data.unityWorkspaceErrors.filter((w: any) => !w.accountAdmin).length > 0 && (
              <MessageBar intent="warning" style={{ marginTop: 14 }}>
                <MessageBarBody>
                  <MessageBarTitle>Some workspaces were unreachable</MessageBarTitle>
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {data.unityWorkspaceErrors
                      .filter((w: any) => !w.accountAdmin)
                      .map((w: any) => <li key={w.workspace_hostname}><code>{w.workspace_hostname}</code>: {w.message}</li>)}
                  </ul>
                </MessageBarBody>
              </MessageBar>
            )}

            <Divider style={{ margin: '20px 0 16px' }} />

            {/* ---------- Register a Databricks workspace ---------- */}
            <div className={s.sectionHead}>
              <Add24Regular className={s.sectionHeadIcon} />
              <Subtitle2>Register a Databricks workspace</Subtitle2>
            </div>
            <Body1 className={s.mutedBlock}>
              Pick a workspace the Console identity can see, then register it. The registration is
              saved and survives Console reloads. Optionally attach it to a UC metastore and catalog
              it in Purview.
            </Body1>

            {data.discoveryError && (
              <MessageBar intent="info" style={{ marginBottom: 12 }}>
                <MessageBarBody>
                  Couldn’t enumerate workspaces over ARM ({data.discoveryError}). Use manual entry below —
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
            <Divider style={{ margin: '16px 0' }} />
            <div className={s.sectionHead}>
              <Link24Regular className={s.sectionHeadIcon} />
              <Subtitle2>Attach to a Unity Catalog metastore (optional)</Subtitle2>
            </div>
            {data.accountApiConfigured === false ? (
              <MessageBar intent="info" style={{ marginBottom: 12 }}>
                <MessageBarBody>
                  <MessageBarTitle>One-click attach not configured</MessageBarTitle>
                  {data.accountApiHint?.detail || 'Set LOOM_DATABRICKS_ACCOUNT_ID to enable metastore attach.'}
                  {data.accountApiHint?.missingEnvVar && (
                    <div style={{ marginTop: 6, fontSize: 12 }}>
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
            <Divider style={{ margin: '16px 0' }} />
            <div className={s.sectionHead}>
              <ShieldTask24Regular className={s.sectionHeadIcon} />
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
                      style={{ marginTop: 4 }}
                    />
                    {runScan && (
                      <div className={s.scanGrid}>
                        <Field label="SQL Warehouse HTTP path" hint="/sql/1.0/warehouses/…">
                          <Input value={scanHttpPath} onChange={(_, d) => setScanHttpPath(d.value)} placeholder="/sql/1.0/warehouses/abc123" />
                        </Field>
                        <Field label="Purview credential (Key Vault Access Token)" hint="Name of the PAT credential in Purview">
                          <Input value={scanCredential} onChange={(_, d) => setScanCredential(d.value)} placeholder="dbx-pat-credential" />
                        </Field>
                        <Field label="Integration runtime (optional)" hint="Defaults to the managed Azure IR">
                          <Input value={scanIR} onChange={(_, d) => setScanIR(d.value)} placeholder="AzureAutoResolveIntegrationRuntime" />
                        </Field>
                      </div>
                    )}
                    <Caption1 className={s.muted} style={{ display: 'block', marginTop: 6 }}>
                      Databricks scans require an Access Token stored in Key Vault (managed identity is not supported for
                      Databricks) plus a running SQL Warehouse. Without scan config, only the source is registered.
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
              <MessageBar intent="error" style={{ marginTop: 12 }}>
                <MessageBarBody><MessageBarTitle>Registration failed</MessageBarTitle>{probeError}</MessageBarBody>
              </MessageBar>
            )}

            {probeResult?.ok && (
              <div className={s.receipt}>
                <div className={s.receiptHead}>
                  <DatabaseLink24Regular style={{ color: tokens.colorPaletteGreenForeground1 }} />
                  <Body1><strong>{probeResult.probed}</strong> registered &amp; persisted</Body1>
                  <Badge appearance="tint" color="success">
                    {(probeResult.catalogs?.length ?? 0)} catalog{probeResult.catalogs?.length === 1 ? '' : 's'}
                  </Badge>
                  {probeResult.registration?.ucAttached && <Badge appearance="tint" color="brand">UC attached</Badge>}
                  {probeResult.registration?.purviewRegistered && <Badge appearance="tint" color="brand">Purview source</Badge>}
                  {probeResult.registration?.purviewScanned && <Badge appearance="tint" color="success">Scan triggered</Badge>}
                </div>

                {probeResult.accountAdminGate && (
                  <MessageBar intent="warning" style={{ marginBottom: 10 }}>
                    <MessageBarBody>
                      <MessageBarTitle>{probeResult.accountAdminGate.title}</MessageBarTitle>
                      {probeResult.accountAdminGate.detail}
                    </MessageBarBody>
                  </MessageBar>
                )}

                {/* Per-step honest outcomes */}
                {probeResult.steps?.attach?.gate && (
                  <MessageBar intent="info" style={{ marginBottom: 10 }}>
                    <MessageBarBody>{probeResult.steps.attach.gate.detail}</MessageBarBody>
                  </MessageBar>
                )}
                {probeResult.steps?.attach?.error && (
                  <MessageBar intent="warning" style={{ marginBottom: 10 }}>
                    <MessageBarBody>Attach: {probeResult.steps.attach.error}</MessageBarBody>
                  </MessageBar>
                )}
                {probeResult.steps?.purview?.gate && (
                  <MessageBar intent="info" style={{ marginBottom: 10 }}>
                    <MessageBarBody>{probeResult.steps.purview.gate.detail || probeResult.steps.purview.gate.followUp}</MessageBarBody>
                  </MessageBar>
                )}
                {probeResult.steps?.purview?.error && (
                  <MessageBar intent="warning" style={{ marginBottom: 10 }}>
                    <MessageBarBody>Purview: {probeResult.steps.purview.error}</MessageBarBody>
                  </MessageBar>
                )}
                {probeResult.steps?.purview?.scanGate && (
                  <MessageBar intent="info" style={{ marginBottom: 10 }}>
                    <MessageBarBody>
                      <MessageBarTitle>{probeResult.steps.purview.scanGate.title}</MessageBarTitle>
                      {probeResult.steps.purview.scanGate.detail}
                    </MessageBarBody>
                  </MessageBar>
                )}

                {Array.isArray(probeResult.catalogs) && probeResult.catalogs.length > 0 ? (
                  <Table aria-label="Catalogs in workspace" size="small">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>Catalog</TableHeaderCell>
                        <TableHeaderCell>Type</TableHeaderCell>
                        <TableHeaderCell>Owner</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {probeResult.catalogs.map((c: any) => (
                        <TableRow key={c.name}>
                          <TableCell><strong>{c.name}</strong></TableCell>
                          <TableCell>{c.catalog_type || '—'}</TableCell>
                          <TableCell>{c.owner || '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <Caption1 className={s.muted}>
                    No catalogs visible to the Console identity in this workspace yet.
                  </Caption1>
                )}
              </div>
            )}
          </div>

          {/* ---------- Fabric / OneLake ---------- */}
          <div className={s.card}>
            <div className={s.sectionHead}>
              <Cloud24Regular className={s.sectionHeadIcon} />
              <Subtitle2>Fabric / OneLake</Subtitle2>
              {Array.isArray(data.onelake) && data.onelake.length > 0 && (
                <Badge appearance="tint" color="brand">{data.onelake.length} workspace{data.onelake.length === 1 ? '' : 's'}</Badge>
              )}
            </div>
            {data.onelakeError ? (
              <MessageBar intent="warning"><MessageBarBody>{data.onelakeError}</MessageBarBody></MessageBar>
            ) : data.onelake?.length === 0 ? (
              <Body1 className={s.muted}>No OneLake workspaces visible.</Body1>
            ) : (
              <Table aria-label="OneLake workspaces" size="medium">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Workspace</TableHeaderCell>
                    <TableHeaderCell>Capacity</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data.onelake as OneLakeWs[]).map((w) => (
                    <TableRow key={w.id}>
                      <TableCell><strong>{w.displayName}</strong></TableCell>
                      <TableCell>{w.capacityId || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          {/* ---------- Microsoft Purview ---------- */}
          <div className={s.card}>
            <div className={s.sectionHead}>
              <ShieldTask24Regular className={s.sectionHeadIcon} />
              <Subtitle2>Microsoft Purview</Subtitle2>
            </div>
            {data.purview ? (
              <Body1>
                Account <code>{data.purview.account}</code>
                <Caption1 className={s.muted} style={{ display: 'block', marginTop: 4 }}>
                  {data.purview.endpoint}
                </Caption1>
              </Body1>
            ) : (
              <MessageBar intent="warning"><MessageBarBody>{data.purviewError}</MessageBarBody></MessageBar>
            )}
          </div>

          <div className={s.footer}>
            <Button onClick={load} icon={<ArrowSync24Regular />} appearance="secondary">Refresh</Button>
          </div>
        </>
      )}
    </CatalogShell>
  );
}
