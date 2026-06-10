'use client';

/**
 * ConnectSourceDialog — Fabric Real-Time Hub "Get events" / "Connect data
 * source" wizard. Three panes, one-for-one with Fabric:
 *   1. Pick a connector (category list + connector grid).
 *   2. Name the eventstream + target Fabric workspace + fill source-specific
 *      connection fields.
 *   3. POST /api/realtime-hub/connect-source → creates a REAL Fabric
 *      Eventstream item carrying the chosen source.
 *
 * No dead buttons: Connect actually calls the BFF; the result (created id
 * or 202 accepted, or a verbatim FabricError) is shown inline.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Input, Field, Badge, MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Subtitle2, Body1, Caption1, Spinner, Dropdown, Option, Switch, Divider, Link as FluentLink,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowLeft20Regular, Open20Regular, PlugConnected20Regular, Search20Regular,
  ArrowClockwise16Regular, Certificate20Regular,
} from '@fluentui/react-icons';
import {
  SOURCE_CONNECTORS, SOURCE_CATEGORIES, sourceVisual,
  type SourceConnector, type SourceCategory, type SourceField,
} from './source-catalog';

const useStyles = makeStyles({
  surface: { maxWidth: '900px', width: '90vw' },
  layout: { display: 'grid', gridTemplateColumns: '190px 1fr', gap: '16px', minHeight: '440px' },
  catList: {
    display: 'flex', flexDirection: 'column', gap: '2px',
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`, paddingRight: '8px',
  },
  catItem: {
    textAlign: 'left', padding: '8px 12px', borderRadius: '4px', background: 'transparent',
    border: 'none', cursor: 'pointer', color: tokens.colorNeutralForeground1, fontSize: '14px',
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  catItemActive: { backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1, fontWeight: 600 },
  rightCol: { display: 'flex', flexDirection: 'column', gap: '12px', minHeight: 0 },
  grid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
    gap: tokens.spacingHorizontalS, alignContent: 'start',
    overflowY: 'auto', paddingRight: tokens.spacingHorizontalXS,
  },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalM,
    cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    backgroundColor: tokens.colorNeutralBackground1, textAlign: 'left',
    ':hover': { borderColor: tokens.colorBrandStroke1, boxShadow: tokens.shadow4 },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '1px' },
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  chip: {
    flexShrink: 0, width: '32px', height: '32px',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: tokens.borderRadiusMedium,
  },
  cardName: { fontWeight: tokens.fontWeightSemibold, lineHeight: 1.2 },
  cardDesc: { fontSize: '13px', color: tokens.colorNeutralForeground2, lineHeight: 1.4 },
  cardTags: { display: 'flex', gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalXS, flexWrap: 'wrap' },
  formHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  emptyGrid: {
    gridColumn: '1 / -1', padding: tokens.spacingVerticalXXL, textAlign: 'center',
    color: tokens.colorNeutralForeground3,
  },
  form: { display: 'flex', flexDirection: 'column', gap: '12px' },
  sectionHead: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalS,
  },
  sectionTitle: { fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground1 },
  sectionIcon: { color: tokens.colorBrandForeground1, flexShrink: 0 },
  certRow: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalS },
  certGrow: { flex: 1, minWidth: 0 },
  certOption: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0, width: '100%' },
  certOptionIcon: { flexShrink: 0, color: tokens.colorNeutralForeground3 },
  certOptionName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
});

interface Props {
  /** Fabric workspaces the UAMI can see — [{id, name}]. */
  workspaces: Array<{ id: string; name: string }>;
  /** Pre-selected workspace id (optional). */
  defaultWorkspaceId?: string;
  /**
   * Called after a successful connect so the parent can refresh the streams
   * list. Receives the created eventstream's editor link (when the BFF returns
   * one) so the parent can offer an "Open eventstream editor" affordance.
   */
  onConnected?: (result?: { link?: string; eventstreamId?: string }) => void;
  /** Trigger button (rendered by parent). Optional in controlled mode. */
  trigger?: React.ReactElement;
  /**
   * Controlled-open mode (used by the on-page SourceGallery). When `open` is
   * provided the dialog is parent-controlled; `onOpenChange` reports changes.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Pre-select this connector and jump straight to its connection form. */
  initialConnector?: SourceConnector | null;
  /**
   * Pre-fill the connection form's property fields (e.g. an Event Hub name a
   * Subscribe action picked from the RTI hub catalog). Applied when the dialog
   * opens onto `initialConnector`. Keys match the connector's field keys.
   */
  initialProps?: Record<string, string> | null;
  /** Pre-fill the eventstream display name (defaults to a slug of the source). */
  initialDisplayName?: string | null;
}

export function ConnectSourceDialog({
  workspaces, defaultWorkspaceId, onConnected, trigger,
  open: openProp, onOpenChange, initialConnector, initialProps, initialDisplayName,
}: Props) {
  const styles = useStyles();
  const [openState, setOpenState] = useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? !!openProp : openState;
  const setOpen = (v: boolean) => { if (controlled) onOpenChange?.(v); else setOpenState(v); };
  const [category, setCategory] = useState<SourceCategory>('Microsoft sources');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<SourceConnector | null>(null);

  // When opened with a pre-selected connector, jump straight to its form —
  // honoring any pre-filled property values / display name from the caller
  // (e.g. the RTI hub Subscribe action carrying the chosen Event Hub).
  useEffect(() => {
    if (open && initialConnector) pick(initialConnector, initialProps || undefined, initialDisplayName || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialConnector, initialProps, initialDisplayName]);

  const [displayName, setDisplayName] = useState('');
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId || '');
  const [props, setProps] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorHint, setErrorHint] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [createdLink, setCreatedLink] = useState<string | null>(null);

  // ---- Key Vault certificate picker state (mTLS sources, e.g. MQTT) --------
  interface KvCert { name: string; id: string; enabled: boolean; expires?: string }
  const [certs, setCerts] = useState<KvCert[]>([]);
  const [certVaultUri, setCertVaultUri] = useState<string | null>(null);
  const [certGate, setCertGate] = useState<{ missing: string; detail: string } | null>(null);
  const [certsLoading, setCertsLoading] = useState(false);
  const [certError, setCertError] = useState<string | null>(null);

  /** Does this connector expose any KV-cert pickers? (drives the lazy fetch). */
  const hasCertFields = !!picked?.fields.some((f) => f.kind === 'cert');

  /**
   * Expiry status for a Key Vault certificate. Surfaced inline in the picker so
   * operators don't pick a cert that's already expired or about to lapse —
   * matching the Azure portal's cert-expiry affordance.
   */
  function certExpiryStatus(expires?: string): { label: string; tone: 'expired' | 'soon' | 'ok' } | null {
    if (!expires) return null;
    const ts = Date.parse(expires);
    if (Number.isNaN(ts)) return null;
    const days = Math.floor((ts - Date.now()) / 86_400_000);
    if (days < 0) return { label: 'expired', tone: 'expired' };
    if (days <= 30) return { label: `expires in ${days}d`, tone: 'soon' };
    return { label: `exp ${expires.slice(0, 10)}`, tone: 'ok' };
  }

  async function loadCerts() {
    setCertsLoading(true); setCertError(null);
    try {
      const res = await fetch('/api/realtime-hub/keyvault-certificates', { cache: 'no-store' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setCertError(j.error || `Could not list certificates (HTTP ${res.status}).`); return; }
      setCerts(Array.isArray(j.certificates) ? j.certificates : []);
      setCertVaultUri(typeof j.vaultUri === 'string' ? j.vaultUri : null);
      setCertGate(j.configured === false && j.gate ? j.gate : null);
    } catch (e: any) {
      setCertError(e?.message || String(e));
    } finally {
      setCertsLoading(false);
    }
  }

  // Fetch the KV cert list once the user opens a connector that needs it.
  useEffect(() => {
    if (open && hasCertFields && certs.length === 0 && !certsLoading && !certGate && !certError) loadCerts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hasCertFields]);

  const connectors = useMemo(() => {
    const q = query.trim().toLowerCase();
    return SOURCE_CONNECTORS.filter((c) =>
      q ? (c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)) : c.category === category);
  }, [category, query]);

  function reset() {
    setPicked(null); setDisplayName(''); setProps({});
    setError(null); setErrorHint(null); setSuccess(null); setBusy(false);
    setCreatedLink(null);
    setCerts([]); setCertVaultUri(null); setCertGate(null); setCertError(null); setCertsLoading(false);
  }

  function pick(c: SourceConnector, preProps?: Record<string, string>, preName?: string) {
    setPicked(c);
    setDisplayName(preName?.trim() || `${c.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-stream`);
    // Keep only property values whose keys this connector actually exposes.
    const allowed: Record<string, string> = {};
    if (preProps) {
      for (const f of c.fields) {
        const v = preProps[f.key];
        if (v != null && String(v).trim()) allowed[f.key] = String(v);
      }
    }
    setProps(allowed);
    setError(null); setErrorHint(null); setSuccess(null); setCreatedLink(null);
  }

  /** A field is visible unless it's gated by a toggle (`showWhen`) that's off. */
  const isFieldVisible = (f: SourceField) => !f.showWhen || (props[f.showWhen] || '') === 'true';
  const missingRequired = picked
    ? picked.fields.some((f) => f.required && isFieldVisible(f) && !(props[f.key] || '').trim())
    : false;
  const canConnect = !!picked && !!displayName.trim() && !!workspaceId && !missingRequired && !busy;

  async function connect() {
    if (!picked || !canConnect) return;
    setBusy(true); setError(null); setErrorHint(null); setSuccess(null);
    try {
      const properties: Record<string, string> = {};
      for (const f of picked.fields) {
        if (!isFieldVisible(f)) continue;            // skip fields hidden by an off toggle
        const v = (props[f.key] || '').trim();
        if (v) properties[f.key] = v;
      }
      // Tell the backend which Key Vault the chosen mTLS certs live in so it can
      // persist a resolvable {vaultUri, certName} reference (never the material).
      if (hasCertFields && (props.useMtls === 'true') && certVaultUri) {
        properties.certVaultUri = certVaultUri;
      }
      const res = await fetch('/api/realtime-hub/connect-source', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          displayName: displayName.trim(),
          sourceType: picked.sourceType,
          sourceName: picked.id,
          properties,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setError(j.error || `Connect failed (HTTP ${res.status}).`);
        setErrorHint(j.hint || null);
        return;
      }
      setSuccess(
        j.accepted
          ? `Eventstream creation accepted (long-running). It will appear in All data streams shortly.`
          : `Connected. Created eventstream "${displayName.trim()}" — open it to wire processing + destinations.`,
      );
      setCreatedLink(typeof j.link === 'string' ? j.link : null);
      onConnected?.({
        link: typeof j.link === 'string' ? j.link : undefined,
        eventstreamId: typeof j.eventstreamId === 'string' ? j.eventstreamId : undefined,
      });
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(_, d) => { setOpen(d.open); if (!d.open) reset(); }}>
      {trigger != null ? <span onClick={() => setOpen(true)}>{trigger}</span> : <></>}
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>{picked ? `Connect ${picked.name}` : 'Get events — connect a source'}</DialogTitle>
          <DialogContent>
            {picked ? (
              <div className={styles.form}>
                <Button appearance="subtle" icon={<ArrowLeft20Regular />} onClick={() => { setPicked(null); setSuccess(null); }}>
                  Back to sources
                </Button>
                {(() => {
                  const v = sourceVisual(picked);
                  const Icon = v.icon;
                  return (
                    <div className={styles.formHead}>
                      <span className={styles.chip} style={{ backgroundColor: `${v.color}1f`, color: v.color }} aria-hidden>
                        <Icon style={{ width: 20, height: 20, color: v.color }} />
                      </span>
                      <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>{picked.description}</Caption1>
                    </div>
                  );
                })()}
                <Field label="Eventstream name" required>
                  <Input value={displayName} onChange={(_, d) => setDisplayName(d.value)} />
                </Field>
                <Field label="Workspace" required
                  hint="The Loom workspace to create the eventstream in (Azure-native — Event Hubs backed).">
                  <Dropdown
                    aria-label="Workspace"
                    placeholder="Select a workspace…"
                    selectedOptions={workspaceId ? [workspaceId] : []}
                    value={workspaces.find((w) => w.id === workspaceId)?.name || ''}
                    onOptionSelect={(_, d) => setWorkspaceId(d.optionValue || '')}
                  >
                    {workspaces.map((w) => <Option key={w.id} value={w.id}>{w.name}</Option>)}
                  </Dropdown>
                </Field>
                {(() => {
                  let lastSection: string | undefined;
                  return picked.fields.map((f) => {
                    if (!isFieldVisible(f)) return null;
                    const setVal = (v: string) => setProps((p) => ({ ...p, [f.key]: v }));
                    const nodes: React.ReactNode[] = [];
                    // Emit a section divider+header the first time a new section appears.
                    if (f.section && f.section !== lastSection) {
                      lastSection = f.section;
                      nodes.push(
                        <div key={`sec-${f.section}`}>
                          <Divider />
                          <div className={styles.sectionHead}>
                            <Certificate20Regular className={styles.sectionIcon} />
                            <span className={styles.sectionTitle}>{f.section}</span>
                            {picked.preview && <Badge appearance="outline" color="warning" size="small">Preview</Badge>}
                          </div>
                        </div>,
                      );
                    }

                    if (f.kind === 'toggle') {
                      nodes.push(
                        <Field key={f.key} hint={f.help}>
                          <Switch
                            label={f.label}
                            checked={(props[f.key] || '') === 'true'}
                            onChange={(_, d) => setVal(d.checked ? 'true' : '')}
                          />
                        </Field>,
                      );
                    } else if (f.kind === 'select') {
                      const cur = props[f.key] || '';
                      const curLabel = f.options?.find((o) => o.value === cur)?.label || '';
                      nodes.push(
                        <Field key={f.key} label={f.label} required={f.required} hint={f.help}>
                          <Dropdown
                            aria-label={f.label}
                            placeholder={f.placeholder || 'Select…'}
                            selectedOptions={cur ? [cur] : []}
                            value={curLabel}
                            onOptionSelect={(_, d) => setVal(d.optionValue || '')}
                          >
                            {(f.options || []).map((o) => <Option key={o.value} value={o.value}>{o.label}</Option>)}
                          </Dropdown>
                        </Field>,
                      );
                    } else if (f.kind === 'cert') {
                      const usableCerts = certs.filter((c) => c.enabled);
                      const chosen = usableCerts.find((c) => c.name === props[f.key]);
                      const chosenStatus = chosen ? certExpiryStatus(chosen.expires) : null;
                      const expiryWarn =
                        chosenStatus?.tone === 'expired'
                          ? `Selected certificate has expired (${chosen?.expires?.slice(0, 10)}). Rotate it in Key Vault before connecting.`
                          : chosenStatus?.tone === 'soon'
                          ? `Selected certificate ${chosenStatus.label} — rotate it soon to avoid an ingestion outage.`
                          : null;
                      nodes.push(
                        <Field key={f.key} label={f.label} required={f.required} hint={f.help}
                          validationState={certError ? 'error' : expiryWarn ? 'warning' : undefined}
                          validationMessage={certError || expiryWarn || undefined}>
                          <div className={styles.certRow}>
                            <div className={styles.certGrow}>
                              <Dropdown
                                aria-label={f.label}
                                disabled={!!certGate || certsLoading || usableCerts.length === 0}
                                placeholder={
                                  certGate ? 'No cert vault configured'
                                    : certsLoading ? 'Loading certificates…'
                                    : usableCerts.length === 0 ? 'No certificates in vault'
                                    : 'Select a certificate…'
                                }
                                selectedOptions={props[f.key] ? [props[f.key]] : []}
                                value={props[f.key] || ''}
                                onOptionSelect={(_, d) => setVal(d.optionValue || '')}
                              >
                                {usableCerts.map((c) => {
                                  const st = certExpiryStatus(c.expires);
                                  return (
                                    <Option key={c.id} value={c.name} text={c.name}>
                                      <span className={styles.certOption}>
                                        <Certificate20Regular className={styles.certOptionIcon} />
                                        <span className={styles.certOptionName}>{c.name}</span>
                                        {st && (
                                          <Badge
                                            appearance="tint"
                                            size="small"
                                            color={st.tone === 'expired' ? 'danger' : st.tone === 'soon' ? 'warning' : 'informative'}
                                          >
                                            {st.label}
                                          </Badge>
                                        )}
                                      </span>
                                    </Option>
                                  );
                                })}
                              </Dropdown>
                            </div>
                            <Button appearance="subtle" icon={<ArrowClockwise16Regular />}
                              aria-label="Refresh certificates" onClick={loadCerts}
                              disabled={certsLoading || !!certGate} />
                          </div>
                        </Field>,
                      );
                    } else {
                      nodes.push(
                        <Field key={f.key} label={f.label} required={f.required} hint={f.help}>
                          <Input
                            type={f.kind === 'password' ? 'password' : 'text'}
                            placeholder={f.placeholder}
                            value={props[f.key] || ''}
                            onChange={(_, d) => setVal(d.value)}
                          />
                        </Field>,
                      );
                    }
                    return <div key={`wrap-${f.key}`}>{nodes}</div>;
                  });
                })()}
                {hasCertFields && (props.useMtls === 'true') && certGate && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>Key Vault not configured for mTLS certificates</MessageBarTitle>
                      Set <code>{certGate.missing}</code> (or <code>LOOM_KEY_VAULT_URI</code>) and grant the Console
                      identity the <strong>Key Vault Certificate User</strong> role. {certGate.detail}{' '}
                      <FluentLink href="https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/add-source-mqtt" target="_blank">
                        MQTT mTLS certificate requirements
                      </FluentLink>
                    </MessageBarBody>
                  </MessageBar>
                )}
                {picked.fields.length === 0 && (
                  <MessageBar intent="info">
                    <MessageBarBody>This source needs no extra connection settings — Connect creates the eventstream and subscribes immediately.</MessageBarBody>
                  </MessageBar>
                )}
                {error && (
                  <MessageBar intent="error">
                    <MessageBarBody>
                      <MessageBarTitle>Could not connect source</MessageBarTitle>
                      {error}{errorHint ? ` — ${errorHint}` : ''}
                    </MessageBarBody>
                  </MessageBar>
                )}
                {success && (
                  <MessageBar intent="success">
                    <MessageBarBody>{success}</MessageBarBody>
                    {createdLink && (
                      <MessageBarActions>
                        <Link href={createdLink} style={{ textDecoration: 'none' }}>
                          <Button appearance="primary" size="small" icon={<Open20Regular />}>
                            Open eventstream editor
                          </Button>
                        </Link>
                      </MessageBarActions>
                    )}
                  </MessageBar>
                )}
              </div>
            ) : (
              <div className={styles.layout}>
                <div className={styles.catList} role="tablist" aria-label="Source category">
                  {SOURCE_CATEGORIES.map((c) => (
                    <button key={c} type="button" role="tab" aria-selected={category === c}
                      className={`${styles.catItem} ${category === c && !query ? styles.catItemActive : ''}`}
                      onClick={() => { setCategory(c); setQuery(''); }}>
                      {c}
                    </button>
                  ))}
                </div>
                <div className={styles.rightCol}>
                  <Input contentBefore={<Search20Regular />} placeholder="Search sources"
                    value={query} onChange={(_, d) => setQuery(d.value)} />
                  <div className={styles.grid}>
                    {connectors.map((c) => {
                      const v = sourceVisual(c);
                      const Icon = v.icon;
                      return (
                        <button key={c.id} type="button" className={styles.card}
                          onClick={() => pick(c)} aria-label={`Connect ${c.name}`}>
                          <div className={styles.cardHead}>
                            <span className={styles.chip} style={{ backgroundColor: `${v.color}1f`, color: v.color }} aria-hidden>
                              <Icon style={{ width: 20, height: 20, color: v.color }} />
                            </span>
                            <Subtitle2 className={styles.cardName}>{c.name}</Subtitle2>
                          </div>
                          <Body1 className={styles.cardDesc}>{c.description}</Body1>
                          <div className={styles.cardTags}>
                            <Badge appearance="outline" size="small">{c.sourceType}</Badge>
                            {c.preview && <Badge appearance="outline" color="warning" size="small">Preview</Badge>}
                          </div>
                        </button>
                      );
                    })}
                    {connectors.length === 0 && (
                      <Body1 className={styles.emptyGrid}>No sources match &quot;{query}&quot;.</Body1>
                    )}
                  </div>
                </div>
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => { setOpen(false); reset(); }}>Close</Button>
            {picked && (
              <Button appearance="primary"
                icon={busy ? <Spinner size="tiny" /> : <PlugConnected20Regular />}
                disabled={!canConnect} onClick={connect}>
                {busy ? 'Connecting…' : 'Connect'}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
