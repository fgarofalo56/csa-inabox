'use client';

/**
 * FoundryAccountTree — the Azure AI Foundry / Azure OpenAI account navigator.
 *
 * The AI Foundry equivalent of the ADF Factory Resources / Synapse Workspace
 * Resources / Databricks Workspace / AI Search service navigators. Once an
 * account is chosen via the EXISTING cross-sub AzureResourcePicker in the Hub
 * editor, the editor's left pane becomes this typed navigator: one group per
 * Foundry object type with a live count and a ＋ New affordance, a "Filter by
 * name" box, and a top "Add new" menu — collapsing the portal's left rail
 * (Model deployments / Connections / Online endpoints / Model catalog) into one
 * tree.
 *
 * Every count comes from a real ARM list call; every create/delete hits the
 * real REST through the Foundry BFF routes:
 *   - Model deployments → /api/foundry/model-deployments  (list / deploy / delete; account-scoped)
 *   - Available models  → /api/foundry/models-catalog      (read-only deployable catalog; feeds the deploy dialog)
 *   - Connections       → /api/foundry/connections          (hub workspace; read)
 *   - Online endpoints  → /api/foundry/deployments          (hub workspace; read)
 *
 * Things the portal/Foundry exposes but we don't author *here* (fine-tuning
 * jobs, evaluations, content filters / RAI policies, Prompt flow — the last
 * lives in the dedicated Foundry project editor) render as honest ⚠️ "coming"
 * rows naming what's missing and which surface owns it — never a fake list.
 * No mocks (per .claude/rules/no-vaporware.md + ui-parity.md).
 *
 * Account-scoped groups (deployments, models) re-query whenever the selected
 * account changes; when no account is configured the routes 503 and the tree
 * shows a single honest infra-gate MessageBar naming the env var + role.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Tree, TreeItem, TreeItemLayout,
  Button, Input, Field, Caption1, Badge, Spinner, Dropdown, Option,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Tooltip, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync16Regular, Delete16Regular, Open16Regular,
  Search20Regular, Warning20Regular,
  BrainCircuit20Regular, Connector20Regular, Globe20Regular, AppsList20Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: 8, padding: 8, height: '100%', minWidth: 260 },
  header: { display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'space-between' },
  title: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300 },
  acctLine: { color: tokens.colorNeutralForeground3, fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  groupLayout: { display: 'flex', alignItems: 'center', gap: 6, width: '100%' },
  groupActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 },
  leafRow: { display: 'flex', alignItems: 'center', gap: 4, width: '100%' },
  leafActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 },
});

const R = {
  deployments: '/api/foundry/model-deployments',
  catalog: '/api/foundry/models-catalog',
  connections: '/api/foundry/connections',
  endpoints: '/api/foundry/deployments',
};

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

// ---- Row shapes (mirror the BFF responses) ----
interface DeploymentRow { name: string; modelName?: string; modelVersion?: string; skuName?: string; capacity?: number; provisioningState?: string }
interface CatalogModelRow { id: string; name: string; publisher?: string; format?: string; version?: string; skus?: string[]; defaultCapacity?: number; maxCapacity?: number; lifecycleStatus?: string }
interface ConnectionRow { id?: string; name: string; category?: string; authType?: string; target?: string }
interface EndpointRow { id?: string; name: string; authMode?: string; provisioningState?: string; scoringUri?: string }

function stateColor(state?: string) {
  const s = (state || '').toLowerCase();
  if (s === 'succeeded') return 'success' as const;
  if (s === 'creating' || s === 'updating' || s === 'accepted' || s === 'deleting') return 'warning' as const;
  if (s === 'failed' || s === 'canceled') return 'danger' as const;
  return 'informative' as const;
}

/** The selected AI Foundry / Azure OpenAI account the tree targets. */
export interface FoundryTreeAccount {
  id?: string;
  name: string;
  endpoint?: string;
  location?: string;
  kind?: string;
  resourceGroup?: string;
}

export interface FoundryAccountTreeProps {
  /** The account chosen by the Hub editor's cross-sub picker. Drives every account-scoped group. */
  account: FoundryTreeAccount | null;
  /** Currently selected deployment name (highlighted). */
  selectedDeployment?: string | null;
  /** Open / focus a deployment in the host editor (selecting a deployment). */
  onOpenDeployment?: (name: string) => void;
  /** Increment to force a refresh from the parent (e.g. after a save/create elsewhere). */
  refreshKey?: number;
}

/** Append the account selector to a URL as `?account=&rg=`. */
function withAccount(url: string, a: FoundryTreeAccount | null): string {
  if (!a?.name) return url;
  const sep = url.includes('?') ? '&' : '?';
  const rg = a.resourceGroup ? `&rg=${encodeURIComponent(a.resourceGroup)}` : '';
  return `${url}${sep}account=${encodeURIComponent(a.name)}${rg}`;
}

/** A typed, AI-Foundry-faithful account navigator. */
export function FoundryAccountTree({
  account, selectedDeployment = null, onOpenDeployment, refreshKey = 0,
}: FoundryAccountTreeProps) {
  const s = useStyles();

  const [filter, setFilter] = useState('');
  const [gate, setGate] = useState<{ msg: string; hint?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [deployments, setDeployments] = useState<DeploymentRow[]>([]);
  const [models, setModels] = useState<CatalogModelRow[]>([]);
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [endpoints, setEndpoints] = useState<EndpointRow[]>([]);

  // ---- deploy dialog ----
  const [deployOpen, setDeployOpen] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [dModel, setDModel] = useState('');
  const [dName, setDName] = useState('');
  const [dSku, setDSku] = useState('GlobalStandard');
  const [dCapacity, setDCapacity] = useState('10');

  const accountKey = `${account?.name || ''}|${account?.resourceGroup || ''}`;

  // ---------------------------------------------------------------
  // Load — account-scoped groups + hub-scoped groups in parallel.
  // ---------------------------------------------------------------
  const loadAll = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [dep, cat, conn, eps] = await Promise.all([
        fetch(withAccount(R.deployments, account)).then(readJson),
        fetch(withAccount(R.catalog, account)).then(readJson),
        fetch(R.connections).then(readJson),
        fetch(R.endpoints).then(readJson),
      ]);
      // The account-scoped routes own the infra gate (the CS account). If
      // deployments 503s with notDeployed, surface the honest gate for the
      // whole tree — there is nothing account-scoped to show.
      if (dep?.notDeployed) { setGate({ msg: dep.error, hint: dep.hint }); setLoading(false); return; }
      setGate(null);
      if (dep.ok) setDeployments(dep.deployments || []); else setError(dep.error || 'failed to list model deployments');
      if (cat.ok) setModels(cat.models || []);
      if (conn.ok) setConnections(conn.connections || []);
      if (eps.ok) setEndpoints(eps.endpoints || []);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [account]);

  useEffect(() => { loadAll(); }, [loadAll, refreshKey, accountKey]);

  // ---------------------------------------------------------------
  // Deploy a model (real PUT) — model dropdown from the read-only catalog.
  // ---------------------------------------------------------------
  const openDeploy = useCallback(() => {
    setDeployOpen(true); setDeployError(null);
    const first = models[0];
    setDModel(first?.name || 'gpt-4o-mini');
    setDName(first?.name || 'gpt-4o-mini');
    setDSku(first?.skus?.[0] || 'GlobalStandard');
    setDCapacity(String(first?.defaultCapacity || 10));
  }, [models]);

  const submitDeploy = useCallback(async () => {
    if (!dModel.trim() || !dName.trim()) { setDeployError('Model and deployment name are required.'); return; }
    setBusy(true); setDeployError(null);
    try {
      const picked = models.find((m) => m.name === dModel);
      const payload: any = {
        modelName: dModel.trim(),
        deploymentName: dName.trim(),
        skuName: dSku,
        capacity: Number(dCapacity) || 10,
        ...(picked?.format ? { modelFormat: picked.format } : {}),
        ...(picked?.version ? { modelVersion: picked.version } : {}),
      };
      if (account?.name) { payload.account = account.name; if (account.resourceGroup) payload.rg = account.resourceGroup; }
      const res = await fetch(R.deployments, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const body = await readJson(res);
      if (!body.ok) { setDeployError(body.error || 'deploy failed'); setBusy(false); return; }
      setDeployOpen(false);
      await loadAll();
    } catch (e: any) {
      setDeployError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [dModel, dName, dSku, dCapacity, models, account, loadAll]);

  const delDeployment = useCallback(async (name: string) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(withAccount(`${R.deployments}?name=${encodeURIComponent(name)}`, account), { method: 'DELETE' });
      const body = await readJson(res);
      if (!body.ok) { setError(body.error || 'delete failed'); setBusy(false); return; }
      await loadAll();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [account, loadAll]);

  // ---------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------
  const f = filter.trim().toLowerCase();
  const match = (n: string) => !f || n.toLowerCase().includes(f);
  const fDeployments = useMemo(() => deployments.filter((x) => match(x.name)), [deployments, f]);
  const fModels = useMemo(() => models.filter((x) => match(x.name)), [models, f]);
  const fConnections = useMemo(() => connections.filter((x) => match(x.name)), [connections, f]);
  const fEndpoints = useMemo(() => endpoints.filter((x) => match(x.name)), [endpoints, f]);

  // ---------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------
  const groupHeader = (label: string, icon: React.ReactElement, count: number, onAdd?: () => void, addTitle?: string) => (
    <TreeItemLayout iconBefore={icon}>
      <span className={s.groupLayout}>
        <span>{label} ({count})</span>
        <span className={s.groupActions} onClick={(e) => e.stopPropagation()}>
          {onAdd && (
            <Tooltip content={addTitle || `New ${label.toLowerCase()}`} relationship="label">
              <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={onAdd} disabled={busy} aria-label={addTitle || `New ${label}`} />
            </Tooltip>
          )}
        </span>
      </span>
    </TreeItemLayout>
  );

  if (gate) {
    return (
      <div className={s.root}>
        <div className={s.header}><span className={s.title}>AI Foundry account</span></div>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Azure AI Foundry account not configured</MessageBarTitle>
            {gate.msg}
            {gate.hint ? <><br /><Caption1>{gate.hint}</Caption1></> : null}
            <br />
            <Caption1>
              Pick an account from the picker above, or set <code>LOOM_AOAI_ACCOUNT</code> (+ optional
              {' '}<code>LOOM_AOAI_RG</code>) to a deployed <code>Microsoft.CognitiveServices/accounts</code>{' '}
              (kind <code>AIServices</code>/<code>OpenAI</code>). The Loom UAMI needs{' '}
              <strong>Cognitive Services Contributor</strong> to deploy models. Provisioned by{' '}
              <code>platform/fiab/bicep/modules/admin-plane/ai-foundry.bicep</code>.
            </Caption1>
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  return (
    <div className={s.root}>
      <div className={s.header}>
        <span className={s.title}>AI Foundry account</span>
        <span style={{ display: 'flex', gap: 2 }}>
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Tooltip content="Add new" relationship="label">
                <Button size="small" appearance="primary" icon={<Add20Regular />} aria-label="Add new" />
              </Tooltip>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem icon={<BrainCircuit20Regular />} onClick={openDeploy}>Model deployment</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
          <Tooltip content="Refresh" relationship="label">
            <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={loadAll} disabled={loading} aria-label="Refresh AI Foundry account" />
          </Tooltip>
        </span>
      </div>

      {account?.name && (
        <span className={s.acctLine}>
          <Badge appearance="outline">{account.name}</Badge>
          {account.kind && <Badge size="small" appearance="tint" color="brand">{account.kind}</Badge>}
          {account.location && <span>· {account.location}</span>}
        </span>
      )}

      <Field>
        <Input size="small" contentBefore={<Search20Regular />} placeholder="Filter by name" value={filter} onChange={(_, d) => setFilter(d.value)} />
      </Field>

      {loading && <div style={{ padding: 8 }}><Spinner size="tiny" label="Loading account…" /></div>}
      {error && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Account error</MessageBarTitle>{error}</MessageBarBody></MessageBar>
      )}

      <div style={{ overflow: 'auto', flex: 1 }}>
        <Tree aria-label="Azure AI Foundry account" defaultOpenItems={['g-deployments']}>
          {/* Model deployments */}
          <TreeItem itemType="branch" value="g-deployments">
            {groupHeader('Model deployments', <BrainCircuit20Regular />, deployments.length, openDeploy, 'Deploy a model')}
            <Tree>
              {fDeployments.length === 0 && <TreeItem itemType="leaf" value="dep-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No model deployments'}</Caption1></TreeItemLayout></TreeItem>}
              {fDeployments.map((d) => (
                <TreeItem key={d.name} itemType="leaf" value={`dep-${d.name}`}>
                  <TreeItemLayout iconBefore={<BrainCircuit20Regular />}>
                    <span className={s.leafRow}>
                      <span
                        role="button" tabIndex={0}
                        style={{ cursor: onOpenDeployment ? 'pointer' : undefined, fontWeight: selectedDeployment === d.name ? tokens.fontWeightSemibold : undefined }}
                        onClick={() => onOpenDeployment?.(d.name)}
                        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && onOpenDeployment) { e.preventDefault(); onOpenDeployment(d.name); } }}
                      >
                        {d.name}
                      </span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {d.modelName && <Caption1>{d.modelName}{d.modelVersion ? ` v${d.modelVersion}` : ''}</Caption1>}
                        {typeof d.capacity === 'number' && <Badge size="small" appearance="tint">{d.capacity}K TPM</Badge>}
                        {d.provisioningState && <Badge size="small" appearance="filled" color={stateColor(d.provisioningState)}>{d.provisioningState}</Badge>}
                        {onOpenDeployment && <Tooltip content="Open" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => onOpenDeployment(d.name)} aria-label={`Open ${d.name}`} /></Tooltip>}
                        <Tooltip content="Delete deployment" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => delDeployment(d.name)} aria-label={`Delete ${d.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Connections (hub workspace) */}
          <TreeItem itemType="branch" value="g-connections">
            {groupHeader('Connections', <Connector20Regular />, connections.length)}
            <Tree>
              {fConnections.length === 0 && <TreeItem itemType="leaf" value="conn-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No connections on the hub'}</Caption1></TreeItemLayout></TreeItem>}
              {fConnections.map((c) => (
                <TreeItem key={c.id || c.name} itemType="leaf" value={`conn-${c.name}`}>
                  <TreeItemLayout iconBefore={<Connector20Regular />}>
                    <span className={s.leafRow}>
                      <span>{c.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {c.category && <Badge size="small" appearance="tint">{c.category}</Badge>}
                        {c.authType && <Caption1>{c.authType}</Caption1>}
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Online endpoints (hub workspace) */}
          <TreeItem itemType="branch" value="g-endpoints">
            {groupHeader('Online endpoints', <Globe20Regular />, endpoints.length)}
            <Tree>
              {fEndpoints.length === 0 && <TreeItem itemType="leaf" value="ep-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No managed online endpoints'}</Caption1></TreeItemLayout></TreeItem>}
              {fEndpoints.map((e) => (
                <TreeItem key={e.id || e.name} itemType="leaf" value={`ep-${e.name}`}>
                  <TreeItemLayout iconBefore={<Globe20Regular />}>
                    <span className={s.leafRow}>
                      <span>{e.name}</span>
                      <span className={s.leafActions} onClick={(ev) => ev.stopPropagation()}>
                        {e.authMode && <Caption1>{e.authMode}</Caption1>}
                        {e.provisioningState && <Badge size="small" appearance="filled" color={stateColor(e.provisioningState)}>{e.provisioningState}</Badge>}
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Available models (read-only deployable catalog for this account/region) */}
          <TreeItem itemType="branch" value="g-models">
            {groupHeader('Available models', <AppsList20Regular />, models.length, openDeploy, 'Deploy a model')}
            <Tree>
              {fModels.length === 0 && <TreeItem itemType="leaf" value="mdl-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No deployable models returned for this account/region'}</Caption1></TreeItemLayout></TreeItem>}
              {fModels.slice(0, 200).map((m) => (
                <TreeItem key={m.id} itemType="leaf" value={`mdl-${m.id}`}>
                  <TreeItemLayout iconBefore={<AppsList20Regular />}>
                    <span className={s.leafRow}>
                      <span>{m.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {m.publisher && <Badge size="small" appearance="tint">{m.publisher}</Badge>}
                        {m.version && <Caption1>v{m.version}</Caption1>}
                        <Tooltip content={`Deploy ${m.name}`} relationship="label">
                          <Button
                            size="small" appearance="subtle" icon={<Add20Regular />} disabled={busy}
                            aria-label={`Deploy ${m.name}`}
                            onClick={() => {
                              setDeployOpen(true); setDeployError(null);
                              setDModel(m.name); setDName(m.name);
                              setDSku(m.skus?.[0] || 'GlobalStandard');
                              setDCapacity(String(m.defaultCapacity || 10));
                            }}
                          />
                        </Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Honest gate rows — Foundry exposes these; not authored in THIS navigator. */}
          <TreeItem itemType="branch" value="g-not-wired">
            <TreeItemLayout iconBefore={<Warning20Regular />}>Not yet wired here</TreeItemLayout>
            <Tree>
              {[
                ['Fine-tuning jobs', 'Foundry fine-tuning (Microsoft.CognitiveServices/accounts fine-tuning, or AML jobs) — submit + monitor a fine-tune. Not authored in this navigator yet.'],
                ['Evaluations', 'Foundry evaluations run via the AML data-plane; the Foundry project editor surfaces them. A navigator entry is not wired here yet.'],
                ['Content filters (RAI policies)', 'Responsible-AI / content-filter policies (raiPolicies on the account) — attach per deployment. Authoring not wired here yet; deployments accept a raiPolicyName.'],
                ['Prompt flow', 'Prompt flow is authored in the dedicated AI Foundry project editor (AML data-plane PromptFlows API), not in this account navigator.'],
              ].map(([label, why]) => (
                <TreeItem key={label} itemType="leaf" value={`nw-${label}`}>
                  <Tooltip content={why} relationship="description">
                    <TreeItemLayout iconBefore={<Warning20Regular />}>
                      <span style={{ color: tokens.colorNeutralForeground3 }}>{label}</span>{' '}
                      <Badge size="small" appearance="tint" color="warning">coming</Badge>
                    </TreeItemLayout>
                  </Tooltip>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>
        </Tree>
      </div>

      {/* Deploy dialog — real PUT against the selected account. */}
      <Dialog open={deployOpen} onOpenChange={(_, d) => { if (!d.open) setDeployOpen(false); }}>
        <DialogSurface style={{ maxWidth: 520 }}>
          <DialogBody>
            <DialogTitle>Deploy a model</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Field label="Model" required>
                  {models.length > 0 ? (
                    <Dropdown
                      value={dModel}
                      selectedOptions={dModel ? [dModel] : []}
                      placeholder="Select a deployable model"
                      onOptionSelect={(_, d) => {
                        if (!d.optionValue) return;
                        setDModel(d.optionValue); setDName(d.optionValue);
                        const m = models.find((x) => x.name === d.optionValue);
                        setDSku(m?.skus?.[0] || 'GlobalStandard');
                        setDCapacity(String(m?.defaultCapacity || 10));
                      }}
                    >
                      {models.map((m) => (
                        <Option key={m.id} value={m.name} text={m.name}>
                          {`${m.name}${m.version ? ` (v${m.version})` : ''}${m.publisher ? ` · ${m.publisher}` : ''}${m.lifecycleStatus ? ` · ${m.lifecycleStatus}` : ''}`}
                        </Option>
                      ))}
                    </Dropdown>
                  ) : (
                    <Input value={dModel} onChange={(_, d) => { setDModel(d.value); setDName(d.value); }} placeholder="gpt-4o-mini" />
                  )}
                </Field>
                <Field label="Deployment name" required>
                  <Input value={dName} onChange={(_, d) => setDName(d.value)} placeholder="lowercase-with-dashes" />
                </Field>
                <Field label="SKU">
                  <Dropdown value={dSku} selectedOptions={[dSku]} onOptionSelect={(_, d) => d.optionValue && setDSku(d.optionValue)}>
                    {(() => {
                      const picked = models.find((m) => m.name === dModel);
                      const skus = picked?.skus?.length ? picked.skus : ['GlobalStandard', 'Standard', 'DataZoneStandard', 'ProvisionedManaged'];
                      return skus.map((sk) => <Option key={sk} value={sk} text={sk}>{sk}</Option>);
                    })()}
                  </Dropdown>
                </Field>
                <Field label="Capacity (K TPM)">
                  <Input type="number" value={dCapacity} onChange={(_, d) => setDCapacity(d.value)} />
                </Field>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  Sends <code>PUT …/accounts/{account?.name || '<account>'}/deployments/{'{name}'}</code> with{' '}
                  <code>sku.capacity</code> + <code>properties.model</code>. Capacity is tokens-per-minute / 1000.
                </Caption1>
                {deployError && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Deploy failed</MessageBarTitle>{deployError}</MessageBarBody></MessageBar>}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setDeployOpen(false)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={submitDeploy} disabled={busy || !dModel.trim() || !dName.trim()}>{busy ? 'Deploying…' : 'Deploy'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
