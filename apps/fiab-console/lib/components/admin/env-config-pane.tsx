'use client';

/**
 * Runtime configuration pane — /admin/env-config.
 *
 * View and set the loom-console deployment env vars (Cosmos endpoint, AOAI,
 * Synapse, ADX, Event Hubs, AI Search, …) from inside Loom — replacing the
 * "Azure portal → Container Apps → Environment variables" hand-off (the exact
 * portalSteps the self-audit emits). Every Save hits POST /api/admin/env-config
 * which performs a REAL ARM PATCH (new revision) + persists desired state to
 * Cosmos + writes an audit entry. Secret-typed keys (SESSION_SECRET, *_KEY,
 * *CONNECTION*) render as password inputs, never echo their value, and are
 * stored as ACA secrets.
 *
 * Honest gates (no-vaporware.md): when the ACA write path isn't configured, a
 * warning MessageBar names the missing env var and the table stays read-only;
 * the bicep-reconcile snippet is shown after every Save so a UI change can be
 * folded into IaC before the next deployment reverts it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, MessageBar, MessageBarBody, MessageBarTitle, Button, Badge,
  Subtitle2, Body1, Body1Strong, Caption1, Divider, Input, tokens,
} from '@fluentui/react-components';
import {
  Settings24Regular, ArrowSync24Regular, Save24Regular,
  CheckmarkCircle24Filled, Warning24Filled, Eye24Regular, EyeOff24Regular,
  Copy16Regular, Checkmark16Regular, Edit16Filled, ArrowResetRegular,
  Info16Regular, Wrench16Regular,
} from '@fluentui/react-icons';

type Category = 'identity' | 'data-plane' | 'azure-services' | 'permissions' | 'security' | 'enrichment';
interface EditableEnvVar {
  key: string; category: Category; severity: 'critical' | 'recommended' | 'optional';
  label: string; valueHint: string; secret: boolean; required: boolean; il5Restricted?: boolean;
  provisionedBy?: string; role?: string; derived?: boolean;
}
interface CurrentVal { set: boolean; status?: 'set' | 'derived' | 'unset'; value?: string; secret: boolean }
interface EnvConfigGet {
  ok: boolean; error?: string;
  editable: EditableEnvVar[];
  current: Record<string, CurrentVal>;
  acaConfigured: boolean; acaError?: string; cosmosError?: string;
  desired: { values: Record<string, string>; secretsSet: string[]; updatedAt?: string; updatedBy?: string } | null;
  drift: Array<{ key: string; desired: string; current: string }>;
  cloud: string; app: string; adminRg: string;
}

const CATEGORY_LABEL: Record<Category, string> = {
  'identity': 'Identity & session',
  'data-plane': 'Data plane (Loom store)',
  'azure-services': 'Azure services',
  'permissions': 'Permissions',
  'security': 'Security posture',
  'enrichment': 'Enrichment',
};
const CATEGORY_ORDER: Category[] = ['identity', 'data-plane', 'permissions', 'azure-services', 'enrichment', 'security'];

const card: React.CSSProperties = {
  padding: 20, border: `1px solid ${tokens.colorNeutralStroke2}`,
  borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1,
  marginBottom: 20, boxShadow: tokens.shadow4,
};
const head: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 };
const codeBox: React.CSSProperties = {
  marginTop: 6, padding: 10, borderRadius: 6, background: tokens.colorNeutralBackground4,
  color: tokens.colorNeutralForeground1, overflowX: 'auto', fontSize: 12,
  fontFamily: 'Consolas, "Cascadia Code", monospace', whiteSpace: 'pre', lineHeight: 1.5,
};

export function EnvConfigPane() {
  const [data, setData] = useState<EnvConfigGet | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null); setForbidden(null);
    try {
      const r = await fetch('/api/admin/env-config', { cache: 'no-store' });
      const j = await r.json();
      if (r.status === 401) { setForbidden('Sign in as a tenant admin to manage runtime configuration.'); return; }
      if (r.status === 403) { setForbidden(j?.remediation || 'Access denied — tenant admin required.'); return; }
      if (!j.ok) { setError(j.error || 'failed to load'); return; }
      setData(j); setEdits({});
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const copy = useCallback((id: string, text: string) => {
    try { void navigator.clipboard?.writeText(text); } catch { /* blocked */ }
    setCopied(id); setTimeout(() => setCopied((c) => (c === id ? null : c)), 2000);
  }, []);

  const dirtyKeys = useMemo(() => Object.keys(edits).filter((k) => edits[k]?.trim()), [edits]);

  const coverage = useMemo(() => {
    if (!data) return { set: 0, total: 0, missingCritical: 0 };
    const set = data.editable.filter((e) => data.current[e.key]?.set).length;
    const missingCritical = data.editable.filter(
      (e) => e.severity === 'critical' && !data.current[e.key]?.set,
    ).length;
    return { set, total: data.editable.length, missingCritical };
  }, [data]);

  const save = useCallback(async () => {
    if (dirtyKeys.length === 0) return;
    setSaving(true); setResult(null); setError(null);
    const values: Record<string, string> = {};
    for (const k of dirtyKeys) values[k] = edits[k];
    try {
      const r = await fetch('/api/admin/env-config', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'save failed'); return; }
      setResult(j);
      await load();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setSaving(false); }
  }, [dirtyKeys, edits, load]);

  if (loading && !data) {
    return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner label="Loading runtime configuration…" /></div>;
  }
  if (forbidden) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody><MessageBarTitle>Tenant admin required</MessageBarTitle> {forbidden}</MessageBarBody>
      </MessageBar>
    );
  }
  if (error && !data) {
    return (
      <MessageBar intent="error">
        <MessageBarBody><MessageBarTitle>Failed to load</MessageBarTitle> {error}</MessageBarBody>
      </MessageBar>
    );
  }
  if (!data) return null;

  const isGov = data.cloud === 'GCC-High' || data.cloud === 'DoD';
  const grouped = CATEGORY_ORDER
    .map((cat) => ({ cat, items: data.editable.filter((e) => e.category === cat) }))
    .filter((g) => g.items.length > 0);

  return (
    <div>
      {/* Intro + actions */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Settings24Regular style={{ color: tokens.colorBrandForeground1 }} />
          <div style={{ flex: 1, minWidth: 240 }}>
            <Subtitle2>Deployment runtime configuration</Subtitle2>
            <Body1 style={{ display: 'block', color: tokens.colorNeutralForeground2, marginTop: 2 }}>
              View and set the <strong>{data.app}</strong> container-app environment variables from
              inside Loom — no Azure portal. Saving applies a real ARM revision and persists the
              desired value to the Loom store. Cloud boundary: <strong>{data.cloud}</strong>.
            </Body1>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <Badge appearance="tint" size="medium"
                color={coverage.set === coverage.total ? 'success' : 'informative'}
                icon={<CheckmarkCircle24Filled />}>
                {coverage.set} of {coverage.total} configured
              </Badge>
              {coverage.missingCritical > 0 && (
                <Badge appearance="tint" size="medium" color="danger" icon={<Warning24Filled />}>
                  {coverage.missingCritical} critical not set
                </Badge>
              )}
              {data.desired?.updatedAt && (
                <Badge appearance="outline" size="medium" color="subtle">
                  last saved {new Date(data.desired.updatedAt).toLocaleString()}
                  {data.desired.updatedBy ? ` · ${data.desired.updatedBy}` : ''}
                </Badge>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button icon={<ArrowSync24Regular />} appearance="outline" onClick={load} disabled={loading}>Re-check</Button>
            {dirtyKeys.length > 0 && (
              <Button icon={<ArrowResetRegular />} appearance="subtle" onClick={() => setEdits({})} disabled={saving}>
                Discard
              </Button>
            )}
            <Button icon={<Save24Regular />} appearance="primary" onClick={save}
              disabled={saving || dirtyKeys.length === 0 || !data.acaConfigured}>
              {saving ? 'Applying…' : `Save ${dirtyKeys.length || ''} change${dirtyKeys.length === 1 ? '' : 's'}`}
            </Button>
          </div>
        </div>
      </div>

      {/* ACA write gate */}
      {!data.acaConfigured && (
        <MessageBar intent="warning" style={{ marginBottom: 16 }}>
          <MessageBarBody>
            <MessageBarTitle>Write path not configured</MessageBarTitle>
            {data.acaError} The table below is read-only until the Container Apps management env is set.
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Drift banner */}
      {data.drift.length > 0 && (
        <MessageBar intent="warning" style={{ marginBottom: 16 }}>
          <MessageBarBody>
            <MessageBarTitle>Configuration drift ({data.drift.length})</MessageBarTitle>
            The desired value saved in the Loom store differs from what the running revision sees.
            Either a new revision is still rolling out, or a redeploy reverted the change. Fold the
            change into the loom-console env array in modules/admin-plane/main.bicep to make it permanent.
            <div style={{ marginTop: 8, display: 'grid', gap: 4 }}>
              {data.drift.map((d) => (
                <div key={d.key} style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <Body1Strong style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}>{d.key}</Body1Strong>
                  <Caption1 style={{ fontFamily: 'Consolas, monospace', color: tokens.colorPaletteGreenForeground1, wordBreak: 'break-all' }}>
                    desired: {d.desired}
                  </Caption1>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>→</Caption1>
                  <Caption1 style={{ fontFamily: 'Consolas, monospace', color: tokens.colorNeutralForeground2, wordBreak: 'break-all' }}>
                    running: {d.current}
                  </Caption1>
                </div>
              ))}
            </div>
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Save result + reconcile artifacts */}
      {result?.ok && (
        <MessageBar intent="success" style={{ marginBottom: 16 }}>
          <MessageBarBody>
            <MessageBarTitle>{result.changedCount} change(s) applied</MessageBarTitle>
            {result.driftWarning}
            {Array.isArray(result.rejected) && result.rejected.length > 0 && (
              <div style={{ marginTop: 6 }}>Rejected: {result.rejected.join(', ')}</div>
            )}
          </MessageBarBody>
        </MessageBar>
      )}
      {result?.sync?.bicepEnvSnippet && (
        <div style={card}>
          <div style={head}>
            <CheckmarkCircle24Filled style={{ color: tokens.colorPaletteGreenForeground1 }} />
            <Subtitle2>Reconcile into infrastructure-as-code</Subtitle2>
          </div>
          <Body1 style={{ display: 'block', color: tokens.colorNeutralForeground2, marginBottom: 10 }}>
            The change is live now via a new revision, but the next bicep deployment will revert it
            unless you fold it in. Copy these into your IaC / pipeline.
          </Body1>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>bicep — loom-console env entries (modules/admin-plane/main.bicep)</Caption1>
            <Button size="small" appearance="outline"
              icon={copied === 'bicep' ? <Checkmark16Regular /> : <Copy16Regular />}
              onClick={() => copy('bicep', result.sync.bicepEnvSnippet)}>
              {copied === 'bicep' ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <pre style={codeBox}>{result.sync.bicepEnvSnippet}</pre>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 12 }}>
            <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>Az CLI — apply directly (equivalent)</Caption1>
            <Button size="small" appearance="outline"
              icon={copied === 'cli' ? <Checkmark16Regular /> : <Copy16Regular />}
              onClick={() => copy('cli', result.sync.cliScript)}>
              {copied === 'cli' ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <pre style={codeBox}>{result.sync.cliScript}</pre>
        </div>
      )}
      {error && (
        <MessageBar intent="error" style={{ marginBottom: 16 }}>
          <MessageBarBody><MessageBarTitle>Error</MessageBarTitle> {error}</MessageBarBody>
        </MessageBar>
      )}

      {/* Grouped editable table */}
      {grouped.map(({ cat, items }) => (
        <div key={cat} style={card}>
          <div style={head}>
            <Settings24Regular style={{ color: tokens.colorBrandForeground1 }} />
            <Subtitle2>{CATEGORY_LABEL[cat]}</Subtitle2>
            <Badge appearance="tint" size="small">{items.length}</Badge>
          </div>
          {items.map((e, i) => {
            const cur = data.current[e.key];
            const disabledIl5 = !!e.il5Restricted && isGov;
            const editing = edits[e.key] ?? '';
            const shown = !!reveal[e.key];
            const modified = editing.trim().length > 0;
            return (
              <div key={e.key}>
                {i > 0 && <Divider style={{ margin: '12px 0' }} />}
                <div style={{
                  display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap',
                  ...(modified ? {
                    margin: '-6px -10px', padding: '6px 10px', borderRadius: tokens.borderRadiusMedium,
                    backgroundColor: tokens.colorNeutralBackground1Selected,
                  } : null),
                }}>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <Body1Strong style={{ fontFamily: 'Consolas, monospace' }}>{e.key}</Body1Strong>
                      <Badge appearance="outline" size="small"
                        color={e.severity === 'critical' ? 'danger' : e.severity === 'recommended' ? 'warning' : 'informative'}>
                        {e.severity}
                      </Badge>
                      {e.secret && <Badge appearance="tint" size="small" color="brand">secret</Badge>}
                      {cur?.set
                        ? <Badge appearance="tint" size="small" color="success" icon={<CheckmarkCircle24Filled />}>set</Badge>
                        : (e.derived
                          ? <Badge appearance="tint" size="small" color="informative" icon={<Info16Regular />}>derived</Badge>
                          : <Badge appearance="tint" size="small" color="warning" icon={<Warning24Filled />}>not set</Badge>)}
                      {modified && <Badge appearance="filled" size="small" color="brand" icon={<Edit16Filled />}>modified</Badge>}
                      {disabledIl5 && <Badge appearance="tint" size="small" color="danger">restricted in {data.cloud}</Badge>}
                    </div>
                    <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground2, marginTop: 2 }}>{e.label}</Caption1>
                    {!e.secret && cur?.set && (
                      <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3, marginTop: 2, fontFamily: 'Consolas, monospace', wordBreak: 'break-all' }}>
                        current: {cur.value}
                      </Caption1>
                    )}
                    {/* When unset/derived, name the exact bicep module + role that
                        provisions this var (the "how to fill it" acceptance row). */}
                    {!cur?.set && (e.provisionedBy || e.role) && (
                      <div style={{ marginTop: 4, display: 'grid', gap: 2 }}>
                        {e.provisionedBy && (
                          <Caption1 style={{ display: 'flex', alignItems: 'flex-start', gap: 4, color: tokens.colorNeutralForeground3 }}>
                            <Wrench16Regular style={{ flexShrink: 0, marginTop: 1, color: tokens.colorBrandForeground2 }} />
                            <span>{e.derived ? 'Derived by' : 'Provisioned by'}: {e.provisionedBy}</span>
                          </Caption1>
                        )}
                        {e.role && (
                          <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3, paddingLeft: 20 }}>
                            Role / action: {e.role}
                          </Caption1>
                        )}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 280 }}>
                    <Input
                      style={{ width: 280 }}
                      aria-label={`Value for ${e.key}`}
                      type={e.secret && !shown ? 'password' : 'text'}
                      placeholder={e.secret ? (cur?.set ? '•••••• (set — enter to replace)' : (e.valueHint || 'enter secret value')) : (cur?.value || e.valueHint || `set ${e.key}`)}
                      value={editing}
                      disabled={!data.acaConfigured || disabledIl5}
                      onChange={(_, d) => setEdits((s) => ({ ...s, [e.key]: d.value }))}
                    />
                    {e.secret && (
                      <Button size="small" appearance="subtle" aria-label={shown ? 'Hide value' : 'Show value'}
                        icon={shown ? <EyeOff24Regular /> : <Eye24Regular />}
                        onClick={() => setReveal((s) => ({ ...s, [e.key]: !s[e.key] }))} />
                    )}
                    {modified && (
                      <Button size="small" appearance="subtle" aria-label={`Discard change to ${e.key}`}
                        icon={<ArrowResetRegular />}
                        onClick={() => setEdits((s) => { const n = { ...s }; delete n[e.key]; return n; })} />
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ))}

      {grouped.length === 0 && (
        <div style={card}>
          <div style={head}>
            <Settings24Regular style={{ color: tokens.colorNeutralForeground3 }} />
            <Subtitle2>No editable runtime variables</Subtitle2>
          </div>
          <Body1 style={{ color: tokens.colorNeutralForeground2 }}>
            The deployment catalog returned no editable environment variables for this console.
            Use Re-check to reload, or fold configuration changes directly into admin-plane/main.bicep.
          </Body1>
        </div>
      )}
    </div>
  );
}
