'use client';

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useState } from 'react';
import { CatalogShell } from '@/lib/components/catalog/catalog-shell';
import {
  Spinner, Button, Input, Field, Dropdown, Option, MessageBar, MessageBarBody,
  MessageBarTitle, MessageBarActions, Table, TableHeader, TableRow, TableHeaderCell,
  TableBody, TableCell, Subtitle2, Body1, Caption1, Badge, Divider, tokens,
} from '@fluentui/react-components';
import {
  Add24Regular, ArrowSync24Regular, Database24Regular,
  Cloud24Regular, DatabaseLink24Regular, ShieldTask24Regular, Globe24Regular,
} from '@fluentui/react-icons';

interface UnityMeta { metastore_id: string; name: string; region?: string; workspace_hostname: string; }
interface OneLakeWs { id: string; displayName: string; capacityId?: string; }
interface DiscoverableWs {
  id: string; name: string; workspaceUrl: string;
  location?: string; resourceGroup?: string; subscriptionId: string; sku?: string;
}
interface AccountAdminGate {
  title: string; detail: string;
  remediation: { role: string; identity: string; where: string };
}

const card: React.CSSProperties = {
  padding: 20,
  border: `1px solid ${tokens.colorNeutralStroke2}`,
  borderRadius: tokens.borderRadiusXLarge,
  backgroundColor: tokens.colorNeutralBackground1,
  marginBottom: 20,
  boxShadow: tokens.shadow4,
};

const sectionHead: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14,
};

export default function MetastoresPage() {
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
      const r = await clientFetch('/api/catalog/metastores');
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
      const r = await clientFetch('/api/catalog/metastores', {
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
          {/* ---------- Databricks Unity Catalog ---------- */}
          <div style={card}>
            <div style={sectionHead}>
              <Database24Regular style={{ color: tokens.colorBrandForeground1 }} />
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
              <Body1 style={{ color: tokens.colorNeutralForeground3 }}>
                No metastores discovered. Confirm the Loom UAMI is in the UC metastore admin group,
                or register a workspace below.
              </Body1>
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
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <strong>{m.name}</strong>
                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{m.metastore_id}</Caption1>
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
            <div style={sectionHead}>
              <Add24Regular style={{ color: tokens.colorBrandForeground1 }} />
              <Subtitle2>Register a Databricks workspace</Subtitle2>
            </div>
            <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
              Pick a workspace the Console identity can see, then register it to list its Unity
              Catalog. Listing catalogs does not require account-admin.
            </Body1>

            {data.discoveryError && (
              <MessageBar intent="info" style={{ marginBottom: 12 }}>
                <MessageBarBody>
                  Couldn’t enumerate workspaces over ARM ({data.discoveryError}). Use manual entry below —
                  grant the Console UAMI <strong>Reader</strong> on the target subscriptions to populate the picker.
                </MessageBarBody>
              </MessageBar>
            )}

            <div style={{
              display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, alignItems: 'end',
            }}>
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
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <strong>{w.name}</strong>
                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
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
              style={{ marginTop: 6, paddingLeft: 0 }}
              onClick={() => { setManualMode((m) => !m); setProbeResult(null); setProbeError(null); }}
            >
              {manualMode ? '← Choose from discovered workspaces' : 'Enter a hostname manually instead'}
            </Button>

            {probeError && (
              <MessageBar intent="error" style={{ marginTop: 12 }}>
                <MessageBarBody><MessageBarTitle>Registration failed</MessageBarTitle>{probeError}</MessageBarBody>
              </MessageBar>
            )}

            {probeResult?.ok && (
              <div style={{
                marginTop: 14, padding: 16,
                border: `1px solid ${tokens.colorNeutralStroke2}`,
                borderRadius: tokens.borderRadiusLarge,
                backgroundColor: tokens.colorNeutralBackground2,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <DatabaseLink24Regular style={{ color: tokens.colorPaletteGreenForeground1 }} />
                  <Body1><strong>{probeResult.probed}</strong> registered</Body1>
                  <Badge appearance="tint" color="success">
                    {(probeResult.catalogs?.length ?? 0)} catalog{probeResult.catalogs?.length === 1 ? '' : 's'}
                  </Badge>
                </div>

                {probeResult.accountAdminGate && (
                  <MessageBar intent="warning" style={{ marginBottom: 10 }}>
                    <MessageBarBody>
                      <MessageBarTitle>{probeResult.accountAdminGate.title}</MessageBarTitle>
                      {probeResult.accountAdminGate.detail}
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
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    No catalogs visible to the Console identity in this workspace yet.
                  </Caption1>
                )}

                {probeResult.followUp && (
                  <Caption1 style={{ display: 'block', marginTop: 10, color: tokens.colorNeutralForeground3 }}>
                    To make this registration permanent: {probeResult.followUp.action}
                  </Caption1>
                )}
              </div>
            )}
          </div>

          {/* ---------- Fabric / OneLake ---------- */}
          <div style={card}>
            <div style={sectionHead}>
              <Cloud24Regular style={{ color: tokens.colorBrandForeground1 }} />
              <Subtitle2>Fabric / OneLake</Subtitle2>
              {Array.isArray(data.onelake) && data.onelake.length > 0 && (
                <Badge appearance="tint" color="brand">{data.onelake.length} workspace{data.onelake.length === 1 ? '' : 's'}</Badge>
              )}
            </div>
            {data.onelakeError ? (
              <MessageBar intent="warning"><MessageBarBody>{data.onelakeError}</MessageBarBody></MessageBar>
            ) : data.onelake?.length === 0 ? (
              <Body1 style={{ color: tokens.colorNeutralForeground3 }}>No OneLake workspaces visible.</Body1>
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
          <div style={card}>
            <div style={sectionHead}>
              <ShieldTask24Regular style={{ color: tokens.colorBrandForeground1 }} />
              <Subtitle2>Microsoft Purview</Subtitle2>
            </div>
            {data.purview ? (
              <Body1>
                Account <code>{data.purview.account}</code>
                <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3, marginTop: 4 }}>
                  {data.purview.endpoint}
                </Caption1>
              </Body1>
            ) : (
              <MessageBar intent="warning"><MessageBarBody>{data.purviewError}</MessageBarBody></MessageBar>
            )}
          </div>

          <Button onClick={load} icon={<ArrowSync24Regular />} appearance="secondary">Refresh</Button>
        </>
      )}
    </CatalogShell>
  );
}
