'use client';

/**
 * McpCatalogPanel — admin "Deploy from catalog" surface for vetted MCP servers.
 *
 * Mounted inside MCPServersPanel (Copilot & Agents → External MCP Tools). Lets a
 * tenant admin:
 *   • Browse the vetted, gov-safe MCP catalog (GET /api/admin/mcp-catalog)
 *   • Deploy a server as an Azure Container App (POST .../deploy) — choosing from
 *     a dropdown (no free-form image strings), with an egress warning + optional
 *     Key Vault secret name for secret-gated servers
 *   • See live deployment status of each deployed server (GET .../status)
 *   • Tear a deployment down (DELETE .../delete)
 *
 * Honest gate: when the Container Apps platform isn't wired the catalog still
 * renders but Deploy is disabled and a MessageBar names the missing env var.
 * Fluent v9 + Loom tokens; no JSON config.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Button, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Dropdown, Option, Field, Input, Spinner, Badge,
  MessageBar, MessageBarBody, MessageBarTitle,
  Caption1, Body2, Body1Strong, makeStyles, tokens,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, ArrowClockwise20Regular, CloudArrowUp20Regular,
} from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import type { McpServerConfigDoc } from '@/lib/types/mcp-config';

interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  image: string;
  license: string;
  maintainer: string;
  egress: 'air-gap-safe' | 'azure-internal' | 'external-saas';
  port: number;
  needsStorage: boolean;
  secretEnv?: string;
}

interface DeployStatus {
  name: string;
  provisioningState: string;
  runningStatus?: string;
  fqdn?: string;
}

const useStyles = makeStyles({
  tableWrap: { overflowX: 'auto' },
  hint: { color: tokens.colorNeutralForeground3, fontSize: '12px' },
  bar: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  spacer: { flex: 1 },
  dialogGrid: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '420px' },
  actions: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  cellStack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  gateVars: { marginTop: tokens.spacingVerticalXS, fontSize: '12px' },
  code: {
    fontFamily: tokens.fontFamilyMonospace,
    backgroundColor: tokens.colorNeutralBackground3,
    padding: `0 ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusSmall,
  },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalXXL,
    color: tokens.colorNeutralForeground3,
    textAlign: 'center',
  },
});

function egressBadge(egress: CatalogEntry['egress']) {
  if (egress === 'air-gap-safe') return <Badge appearance="tint" color="success" size="small">Air-gap safe</Badge>;
  if (egress === 'azure-internal') return <Badge appearance="tint" color="brand" size="small">Azure-internal</Badge>;
  return <Badge appearance="tint" color="warning" size="small">External SaaS</Badge>;
}

function provBadge(state?: string) {
  const v = (state || '').toLowerCase();
  if (v === 'succeeded') return <Badge appearance="outline" color="success" size="small">Succeeded</Badge>;
  if (v === 'failed' || v === 'canceled') return <Badge appearance="outline" color="danger" size="small">{state}</Badge>;
  if (!state) return <Badge appearance="outline" color="subtle" size="small">—</Badge>;
  return <Badge appearance="outline" color="warning" size="small">{state}</Badge>;
}

export function McpCatalogPanel({
  onChanged,
}: {
  /** Bump this whenever the parent reloads so the panel re-syncs its deployed list. */
  onChanged: () => void;
}) {
  const s = useStyles();
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [deployed, setDeployed] = useState<McpServerConfigDoc[]>([]);
  const [deployConfigured, setDeployConfigured] = useState(false);
  const [gate, setGate] = useState<{ missing: string[]; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selected, setSelected] = useState<CatalogEntry | null>(null);
  const [deployName, setDeployName] = useState('');
  const [secretName, setSecretName] = useState('');
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);

  const [statuses, setStatuses] = useState<Record<string, DeployStatus>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const r = await fetch('/api/admin/mcp-catalog');
      const j = await r.json();
      if (!j.ok) { setLoadError(j.error || `HTTP ${r.status}`); return; }
      setCatalog(Array.isArray(j.catalog) ? j.catalog : []);
      setDeployed(Array.isArray(j.deployed) ? j.deployed : []);
      setDeployConfigured(!!j.deployConfigured);
      setGate(j.gate || null);
    } catch (e: any) {
      setLoadError(e?.message || String(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const deployedServers = deployed.filter((sv) => sv.deployment);

  const openDeploy = (entry: CatalogEntry) => {
    setSelected(entry);
    setDeployName('');
    setSecretName('');
    setDeployError(null);
  };

  const doDeploy = useCallback(async () => {
    if (!selected) return;
    setDeploying(true); setDeployError(null);
    try {
      const r = await fetch('/api/admin/mcp-catalog/deploy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          catalogId: selected.id,
          name: deployName.trim() || undefined,
          keyVaultSecretName: secretName.trim() || undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setDeployError(j.gate ? j.gate.message : (j.error || `HTTP ${r.status}`));
        return;
      }
      setSelected(null);
      onChanged();
      void load();
    } catch (e: any) {
      setDeployError(e?.message || String(e));
    } finally { setDeploying(false); }
  }, [selected, deployName, secretName, onChanged, load]);

  const refreshStatus = useCallback(async (server: McpServerConfigDoc) => {
    setBusyId(server.serverId);
    try {
      const r = await fetch(`/api/admin/mcp-catalog/status?id=${encodeURIComponent(server.serverId)}`);
      const j = await r.json();
      if (j.ok && j.status) {
        setStatuses((prev) => ({ ...prev, [server.serverId]: j.status }));
      }
    } catch { /* surfaced via stored snapshot below */ } finally { setBusyId(null); }
  }, []);

  const teardown = useCallback(async (server: McpServerConfigDoc) => {
    if (!confirm(`Delete the deployed MCP server "${server.name}"? This removes the Azure Container App.`)) return;
    setBusyId(server.serverId);
    try {
      const r = await fetch(`/api/admin/mcp-catalog/delete?id=${encodeURIComponent(server.serverId)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { alert(`Delete failed: ${j.gate ? j.gate.message : (j.error || `HTTP ${r.status}`)}`); return; }
      onChanged();
      void load();
    } catch (e: any) {
      alert(`Delete failed: ${e?.message || e}`);
    } finally { setBusyId(null); }
  }, [onChanged, load]);

  if (loading) {
    return (
      <Section title="Deploy MCP servers from the catalog">
        <Spinner label="Loading MCP catalog..." />
      </Section>
    );
  }

  return (
    <Section title="Deploy MCP servers from the catalog">
      <Body2 className={s.hint}>
        Stand up a vetted, gov-safe MCP server as an Azure Container App. Servers are chosen from the
        curated allow-list below (no arbitrary images). Air-gap-safe servers make zero external calls.
      </Body2>

      {loadError && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Load failed</MessageBarTitle>{loadError}</MessageBarBody>
        </MessageBar>
      )}

      {!deployConfigured && gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Deploy not configured</MessageBarTitle>
            {gate.message}
            {gate.missing.length > 0 && (
              <div className={s.gateVars}>
                Set{' '}
                {gate.missing.map((v, i) => (
                  <span key={v}>
                    {i > 0 ? ', ' : ''}<code className={s.code}>{v}</code>
                  </span>
                ))}{' '}
                on the loom-console container app.
              </div>
            )}
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Deployed catalog servers */}
      {deployedServers.length > 0 && (
        <div className={s.tableWrap}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Deployed server</TableHeaderCell>
                <TableHeaderCell>Container App</TableHeaderCell>
                <TableHeaderCell>State</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deployedServers.map((server) => {
                const live = statuses[server.serverId];
                const state = live?.provisioningState || server.deployment?.provisioningState;
                return (
                  <TableRow key={server.serverId}>
                    <TableCell>
                      <div className={s.cellStack}>
                        <Body1Strong>{server.name}</Body1Strong>
                        <Caption1>{server.deployment?.image}</Caption1>
                      </div>
                    </TableCell>
                    <TableCell><Caption1>{server.deployment?.containerAppName}</Caption1></TableCell>
                    <TableCell>
                      {provBadge(state)}
                      {(live?.runningStatus || server.deployment?.runningStatus) && (
                        <div><Caption1>{live?.runningStatus || server.deployment?.runningStatus}</Caption1></div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className={s.actions}>
                        <Button
                          icon={<ArrowClockwise20Regular />}
                          size="small"
                          onClick={() => void refreshStatus(server)}
                          disabled={busyId === server.serverId}
                        >Status</Button>
                        <Button
                          icon={<Delete20Regular />}
                          size="small"
                          onClick={() => void teardown(server)}
                          disabled={busyId === server.serverId}
                        >Delete</Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Catalog */}
      {catalog.length === 0 ? (
        <div className={s.empty}>
          <CloudArrowUp20Regular />
          <Body2>No catalog servers are available in this deployment.</Body2>
          <Caption1>The vetted allow-list ships with Loom; try refreshing.</Caption1>
        </div>
      ) : (
        <div className={s.tableWrap}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Server</TableHeaderCell>
                <TableHeaderCell>Egress</TableHeaderCell>
                <TableHeaderCell>License</TableHeaderCell>
                <TableHeaderCell>Deploy</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {catalog.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>
                    <div className={s.cellStack}>
                      <Body1Strong>{entry.name}</Body1Strong>
                      <Caption1>{entry.description}</Caption1>
                    </div>
                  </TableCell>
                  <TableCell>{egressBadge(entry.egress)}</TableCell>
                  <TableCell><Caption1>{entry.license} · {entry.maintainer}</Caption1></TableCell>
                  <TableCell>
                    <Button
                      icon={<CloudArrowUp20Regular />}
                      size="small"
                      appearance="primary"
                      disabled={!deployConfigured}
                      onClick={() => openDeploy(entry)}
                    >Deploy</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className={s.bar}>
        <div className={s.spacer} />
        <Button icon={<ArrowClockwise20Regular />} appearance="secondary" onClick={() => void load()}>Refresh catalog</Button>
      </div>

      {/* Deploy dialog */}
      <Dialog open={!!selected} onOpenChange={(_, d) => { if (!d.open) setSelected(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Deploy {selected?.name}</DialogTitle>
            <DialogContent>
              <div className={s.dialogGrid}>
                <Caption1>{selected?.description}</Caption1>
                {selected?.egress === 'external-saas' && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      This server reaches an external SaaS API. Ensure your boundary has an approved egress path.
                    </MessageBarBody>
                  </MessageBar>
                )}
                <Field label="Name (optional)" hint="Lowercase letters, digits, hyphens; starts with a letter, ≤ 32 chars. Auto-generated if blank.">
                  <Input
                    value={deployName}
                    onChange={(_, d) => setDeployName(d.value)}
                    placeholder={`mcp-${selected?.id || 'server'}`}
                  />
                </Field>
                {selected?.secretEnv && (
                  <Field
                    label="Key Vault secret name"
                    hint={`Resolved into the ${selected.secretEnv} env var via secretRef (read by the MCP UAMI). Leave blank to deploy without it.`}
                  >
                    <Input value={secretName} onChange={(_, d) => setSecretName(d.value)} placeholder="my-secret-name" />
                  </Field>
                )}
                {selected?.needsStorage && (
                  <Caption1 className={s.hint}>
                    Mounts the Loom MCP Azure Files share at /data when LOOM_MCP_STORAGE_NAME is configured.
                  </Caption1>
                )}
                {deployError && (
                  <MessageBar intent="error">
                    <MessageBarBody><MessageBarTitle>Deploy failed</MessageBarTitle>{deployError}</MessageBarBody>
                  </MessageBar>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setSelected(null)} disabled={deploying}>Cancel</Button>
              <Button appearance="primary" icon={<Add20Regular />} onClick={() => void doDeploy()} disabled={deploying}>
                {deploying ? 'Deploying…' : 'Deploy'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </Section>
  );
}
