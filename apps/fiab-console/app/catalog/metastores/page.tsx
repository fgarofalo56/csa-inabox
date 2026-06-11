'use client';

/**
 * Catalog → Metastores & accounts.
 *
 * Three real governance backends, each on the Azure-native default path:
 *   • Databricks Unity Catalog — listed via the UC REST API. Listing
 *     metastores needs account/metastore admin; listing a workspace's
 *     catalogs does NOT, which is why the "Register a workspace" probe leads
 *     with listCatalogs. The honest account-admin gate is preserved.
 *   • Fabric / OneLake — strictly opt-in and soft-failing (no-fabric-dependency):
 *     the page never blocks when no OneLake workspace is visible.
 *   • Microsoft Purview — account + endpoint derived from the configured
 *     short name; an honest infra-gate renders when not configured.
 *
 * Presentation-only redesign over the existing GET/POST /api/catalog/metastores
 * route: raw <Table> blocks → LoomDataTable, hand-rolled cards → <Section>,
 * and a top summary <TileGrid> of <ItemTile>s for the three backends.
 */

import { useCallback, useEffect, useState } from 'react';
import { CatalogShell } from '@/lib/components/catalog/catalog-shell';
import {
  Spinner, Button, Input, Field, Dropdown, Option, MessageBar, MessageBarBody,
  MessageBarTitle, MessageBarActions, Body1, Caption1, Badge, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add24Regular, ArrowSync24Regular, DatabaseLink24Regular, Globe24Regular,
} from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { ItemTile } from '@/lib/components/ui/item-tile';
import { TileGrid } from '@/lib/components/ui/tile-grid';

interface UnityMeta { metastore_id: string; name: string; region?: string; workspace_hostname: string; }
interface OneLakeWs { id: string; displayName: string; capacityId?: string; }
interface ProbeCatalog { name: string; catalog_type?: string; owner?: string; }
interface DiscoverableWs {
  id: string; name: string; workspaceUrl: string;
  location?: string; resourceGroup?: string; subscriptionId: string; sku?: string;
}
interface AccountAdminGate {
  title: string; detail: string;
  remediation: { role: string; identity: string; where: string };
}

const useStyles = makeStyles({
  intro: {
    display: 'block', color: tokens.colorNeutralForeground3,
    marginBottom: tokens.spacingVerticalL, maxWidth: '760px',
  },
  summaryWrap: { marginBottom: tokens.spacingVerticalXXL },
  registerGrid: {
    display: 'grid', gridTemplateColumns: '1fr auto',
    gap: tokens.spacingHorizontalM, alignItems: 'end',
  },
  switchMode: { marginTop: tokens.spacingVerticalXS, paddingLeft: 0 },
  probeResultCard: { marginTop: tokens.spacingVerticalM, marginBottom: 0 },
  desc: {
    display: 'block', color: tokens.colorNeutralForeground3,
    marginBottom: tokens.spacingVerticalM, maxWidth: '720px',
  },
  gateRemediation: {
    marginTop: tokens.spacingVerticalS, fontSize: '12px', lineHeight: 1.6,
  },
  metaName: { display: 'flex', flexDirection: 'column' },
  caption3: { color: tokens.colorNeutralForeground3 },
  hint: { whiteSpace: 'pre-wrap', marginTop: '8px', fontSize: '11px' },
  probeHead: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalS,
  },
  probeFollow: {
    display: 'block', marginTop: tokens.spacingVerticalS,
    color: tokens.colorNeutralForeground3,
  },
  purviewEndpoint: {
    display: 'block', color: tokens.colorNeutralForeground3, marginTop: tokens.spacingVerticalXS,
  },
  mbTop: { marginTop: tokens.spacingVerticalM },
  mbBottom: { marginBottom: tokens.spacingVerticalM },
  spinner: { marginTop: tokens.spacingVerticalXXL },
  errorList: {
    margin: 0, marginTop: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalXXL,
  },
  okIcon: { color: tokens.colorPaletteGreenForeground1 },
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

  async function register() {
    const host = manualMode ? manualHost.trim() : selectedWs;
    if (!host) return;
    setRegistering(true);
    setProbeResult(null);
    setProbeError(null);
    try {
      const r = await fetch('/api/catalog/metastores', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'unity-catalog', hostname: host }),
      });
      const j = await r.json();
      if (!j.ok) { setProbeError(j.error || 'registration failed'); setProbeResult(j); return; }
      setProbeResult(j);
    } catch (e: any) {
      setProbeError(e?.message || String(e));
    } finally {
      setRegistering(false);
    }
  }

  const selectedWsObj = discoverable.find((w) => w.workspaceUrl === selectedWs);
  const gate: AccountAdminGate | undefined = data?.accountAdminGate;

  const unity: UnityMeta[] = Array.isArray(data?.unity) ? data.unity : [];
  const onelake: OneLakeWs[] = Array.isArray(data?.onelake) ? data.onelake : [];

  const scrollTo = (id: string) => () =>
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const unityColumns: LoomColumn<UnityMeta>[] = [
    {
      key: 'name', label: 'Metastore', sortable: true, filterable: true, filterType: 'text',
      getValue: (m) => m.name,
      render: (m) => (
        <span className={s.metaName}>
          <strong>{m.name}</strong>
          <Caption1 className={s.caption3}>{m.metastore_id}</Caption1>
        </span>
      ),
    },
    {
      key: 'region', label: 'Region', sortable: true, filterable: true, filterType: 'select', width: 160,
      getValue: (m) => m.region || '—',
      render: (m) => m.region || '—',
    },
    {
      key: 'workspace_hostname', label: 'Workspace', sortable: true, filterable: true, filterType: 'text',
      getValue: (m) => m.workspace_hostname,
      render: (m) => m.workspace_hostname,
    },
  ];

  const probeColumns: LoomColumn<ProbeCatalog>[] = [
    {
      key: 'name', label: 'Catalog', sortable: true, filterable: true, filterType: 'text',
      getValue: (c) => c.name, render: (c) => <strong>{c.name}</strong>,
    },
    {
      key: 'catalog_type', label: 'Type', sortable: true, filterable: true, filterType: 'select', width: 180,
      getValue: (c) => c.catalog_type || '—', render: (c) => c.catalog_type || '—',
    },
    {
      key: 'owner', label: 'Owner', sortable: true, filterable: true, filterType: 'text',
      getValue: (c) => c.owner || '—', render: (c) => c.owner || '—',
    },
  ];

  const onelakeColumns: LoomColumn<OneLakeWs>[] = [
    {
      key: 'displayName', label: 'Workspace', sortable: true, filterable: true, filterType: 'text',
      getValue: (w) => w.displayName, render: (w) => <strong>{w.displayName}</strong>,
    },
    {
      key: 'capacityId', label: 'Capacity', sortable: true, filterable: true, filterType: 'text',
      getValue: (w) => w.capacityId || '—', render: (w) => w.capacityId || '—',
    },
  ];

  return (
    <CatalogShell sectionTitle="Metastores & accounts">
      <Caption1 className={s.intro}>
        The governance backends wired into this deployment — Databricks Unity Catalog,
        Fabric / OneLake (opt-in), and Microsoft Purview. All are read live from their
        Azure-native data planes; OneLake stays optional and never blocks the page.
      </Caption1>

      {error && (
        <MessageBar intent="error" className={s.mbBottom}>
          <MessageBarBody><MessageBarTitle>Couldn&apos;t load metastores</MessageBarTitle>{error}</MessageBarBody>
          <MessageBarActions>
            <Button size="small" icon={<ArrowSync24Regular />} onClick={load}>Retry</Button>
          </MessageBarActions>
        </MessageBar>
      )}
      {loading && !error && <Spinner label="Loading metastores…" className={s.spinner} />}

      {data && (
        <>
          {/* ---------- Summary tiles ---------- */}
          <div className={s.summaryWrap}>
            <TileGrid minTileWidth={260}>
              <ItemTile
                type="unity-catalog"
                title="Databricks Unity Catalog"
                subtitle="Metastores & catalogs"
                meta="Click to view metastores"
                badge={
                  <Badge appearance="tint" color={unity.length ? 'brand' : 'informative'}>
                    {unity.length ? `${unity.length} metastore${unity.length === 1 ? '' : 's'}` : 'Register a workspace'}
                  </Badge>
                }
                onClick={scrollTo('sec-unity')}
              />
              <ItemTile
                type="onelake-workspace"
                title="Fabric / OneLake"
                subtitle="Opt-in workspaces"
                meta="Click to view workspaces"
                badge={
                  <Badge appearance="tint" color={onelake.length ? 'brand' : 'informative'}>
                    {onelake.length ? `${onelake.length} workspace${onelake.length === 1 ? '' : 's'}` : 'Not configured'}
                  </Badge>
                }
                onClick={scrollTo('sec-onelake')}
              />
              <ItemTile
                type="purview-account"
                title="Microsoft Purview"
                subtitle="Data governance account"
                meta="Click to view account"
                badge={
                  <Badge appearance="tint" color={data.purview ? 'success' : 'warning'}>
                    {data.purview ? 'Configured' : 'Not configured'}
                  </Badge>
                }
                onClick={scrollTo('sec-purview')}
              />
            </TileGrid>
          </div>

          {/* ---------- Databricks Unity Catalog ---------- */}
          <div id="sec-unity">
            <Section
              title="Databricks Unity Catalog"
              actions={
                unity.length > 0 ? (
                  <Badge appearance="tint" color="brand">
                    {unity.length} metastore{unity.length === 1 ? '' : 's'}
                  </Badge>
                ) : undefined
              }
            >
              {/* Honest account-admin gate — the page still renders everything else. */}
              {gate && (
                <MessageBar intent="warning" className={s.mbBottom}>
                  <MessageBarBody>
                    <MessageBarTitle>{gate.title}</MessageBarTitle>
                    {gate.detail}
                    <div className={s.gateRemediation}>
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
                      <pre className={s.hint}>{JSON.stringify(data.unityHint, null, 2)}</pre>
                    )}
                  </MessageBarBody>
                </MessageBar>
              ) : unity.length === 0 && !gate ? (
                <Body1 className={s.caption3}>
                  No metastores discovered. Confirm the Loom UAMI is in the UC metastore admin group,
                  or register a workspace below.
                </Body1>
              ) : unity.length > 0 ? (
                <LoomDataTable<UnityMeta>
                  columns={unityColumns}
                  rows={unity}
                  getRowId={(m) => m.metastore_id}
                  ariaLabel="Unity metastores"
                  empty="No metastores discovered for the Console identity."
                />
              ) : null}

              {/* Per-workspace (non-admin) errors that aren't the account-admin gate. */}
              {Array.isArray(data.unityWorkspaceErrors) &&
                data.unityWorkspaceErrors.filter((w: any) => !w.accountAdmin).length > 0 && (
                <MessageBar intent="warning" className={s.mbTop}>
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
            </Section>
          </div>

          {/* ---------- Register a Databricks workspace ---------- */}
          <Section title="Register a Databricks workspace">
            <Caption1 className={s.desc}>
              Pick a workspace the Console identity can see, then register it to list its Unity
              Catalog. Listing catalogs does not require account-admin.
            </Caption1>

            {data.discoveryError && (
              <MessageBar intent="info" className={s.mbBottom}>
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
                        <div className={s.metaName}>
                          <strong>{w.name}</strong>
                          <Caption1 className={s.caption3}>
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
                {registering ? 'Registering…' : 'Register & list catalogs'}
              </Button>
            </div>

            <Button
              appearance="transparent"
              size="small"
              className={s.switchMode}
              onClick={() => { setManualMode((m) => !m); setProbeResult(null); setProbeError(null); }}
            >
              {manualMode ? '← Choose from discovered workspaces' : 'Enter a hostname manually instead'}
            </Button>

            {probeError && (
              <MessageBar intent="error" className={s.mbTop}>
                <MessageBarBody><MessageBarTitle>Registration failed</MessageBarTitle>{probeError}</MessageBarBody>
              </MessageBar>
            )}

            {probeResult?.ok && (
              <Section bare className={s.probeResultCard}>
                <div className={s.probeHead}>
                  <DatabaseLink24Regular className={s.okIcon} />
                  <Body1><strong>{probeResult.probed}</strong> registered</Body1>
                  <Badge appearance="tint" color="success">
                    {(probeResult.catalogs?.length ?? 0)} catalog{probeResult.catalogs?.length === 1 ? '' : 's'}
                  </Badge>
                </div>

                {probeResult.accountAdminGate && (
                  <MessageBar intent="warning" className={s.mbBottom}>
                    <MessageBarBody>
                      <MessageBarTitle>{probeResult.accountAdminGate.title}</MessageBarTitle>
                      {probeResult.accountAdminGate.detail}
                    </MessageBarBody>
                  </MessageBar>
                )}

                {Array.isArray(probeResult.catalogs) && probeResult.catalogs.length > 0 ? (
                  <LoomDataTable<ProbeCatalog>
                    columns={probeColumns}
                    rows={probeResult.catalogs as ProbeCatalog[]}
                    getRowId={(c) => c.name}
                    ariaLabel="Catalogs in workspace"
                    noFilters
                    empty="No catalogs visible to the Console identity in this workspace yet."
                  />
                ) : (
                  <Caption1 className={s.caption3}>
                    No catalogs visible to the Console identity in this workspace yet.
                  </Caption1>
                )}

                {probeResult.followUp && (
                  <Caption1 className={s.probeFollow}>
                    To make this registration permanent: {probeResult.followUp.action}
                  </Caption1>
                )}
              </Section>
            )}
          </Section>

          {/* ---------- Fabric / OneLake ---------- */}
          <div id="sec-onelake">
            <Section
              title="Fabric / OneLake"
              actions={
                onelake.length > 0 ? (
                  <Badge appearance="tint" color="brand">
                    {onelake.length} workspace{onelake.length === 1 ? '' : 's'}
                  </Badge>
                ) : undefined
              }
            >
              {data.onelakeError ? (
                <MessageBar intent="warning"><MessageBarBody>{data.onelakeError}</MessageBarBody></MessageBar>
              ) : onelake.length === 0 ? (
                <Body1 className={s.caption3}>
                  No OneLake workspaces visible. Fabric / OneLake is opt-in — Loom&apos;s catalog
                  works fully on the Azure-native backends above without it.
                </Body1>
              ) : (
                <LoomDataTable<OneLakeWs>
                  columns={onelakeColumns}
                  rows={onelake}
                  getRowId={(w) => w.id}
                  ariaLabel="OneLake workspaces"
                  empty="No OneLake workspaces visible."
                />
              )}
            </Section>
          </div>

          {/* ---------- Microsoft Purview ---------- */}
          <div id="sec-purview">
            <Section title="Microsoft Purview">
              {data.purview ? (
                <Body1>
                  Account <code>{data.purview.account}</code>
                  <Caption1 className={s.purviewEndpoint}>
                    {data.purview.endpoint}
                  </Caption1>
                </Body1>
              ) : (
                <MessageBar intent="warning"><MessageBarBody>{data.purviewError}</MessageBarBody></MessageBar>
              )}
            </Section>
          </div>

          <Button onClick={load} icon={<ArrowSync24Regular />} appearance="secondary">Refresh</Button>
        </>
      )}
    </CatalogShell>
  );
}
