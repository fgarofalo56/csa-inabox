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
  ArrowClockwise16Regular, Certificate20Regular, Add16Regular, Dismiss16Regular,
} from '@fluentui/react-icons';
import {
  SOURCE_CONNECTORS, SOURCE_CATEGORIES, sourceVisual, SCOPE_KEYS,
  type SourceConnector, type SourceCategory, type SourceField, type ResourceSelectSource,
} from './source-catalog';

/** Sentinel option value for the inline "+ Create new…" affordance. */
const CREATE_SENTINEL = '__loom_create_new__';

const useStyles = makeStyles({
  surface: { maxWidth: '900px', width: '90vw' },
  layout: { display: 'grid', gridTemplateColumns: '190px 1fr', gap: '16px', minHeight: '440px' },
  catList: {
    display: 'flex', flexDirection: 'column', gap: '2px',
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`, paddingRight: '8px',
  },
  catItem: {
    textAlign: 'left', padding: '8px 12px', borderRadius: tokens.borderRadiusMedium, background: 'transparent',
    border: 'none', cursor: 'pointer', color: tokens.colorNeutralForeground1, fontSize: '14px',
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '1px' },
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
    gridColumn: '1 / -1', padding: tokens.spacingVerticalXXL,
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalS,
    textAlign: 'center', color: tokens.colorNeutralForeground3,
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
  createPanel: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorBrandStroke2}`, borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalXS,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  createPanelHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, fontWeight: tokens.fontWeightSemibold },
  createTwoCol: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.spacingHorizontalS },
  createActions: { display: 'flex', gap: tokens.spacingHorizontalS, justifyContent: 'flex-end' },
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

  // ---- Cascading resource-select state (Event Hubs / IoT Hub dropdowns) ----
  interface ResourceOption { id?: string; name: string; description?: string; subscriptionId?: string; resourceGroup?: string; location?: string }
  const [optCache, setOptCache] = useState<Record<string, ResourceOption[]>>({});
  const [optLoading, setOptLoading] = useState<Record<string, boolean>>({});
  const [optError, setOptError] = useState<Record<string, string | null>>({});
  // Filter facets returned alongside the namespaces list (configured subscription
  // scope + regions) — drives the inline "Create new namespace" picker.
  const [optFacets, setOptFacets] = useState<Record<string, { subscriptions?: string[]; resourceGroups?: string[]; locations?: string[] }>>({});
  // Global honest infra-gate when no subscription is configured for discovery.
  const [optGate, setOptGate] = useState<{ hint: string; bicep?: string } | null>(null);
  // Inline create-if-missing state, keyed by field.
  const [createField, setCreateField] = useState<string | null>(null);
  const [createName, setCreateName] = useState('');
  const [createPartitions, setCreatePartitions] = useState('2');
  const [createRetention, setCreateRetention] = useState('1');
  // Namespace-create inputs (top-level "+ Create new namespace…").
  const [createSubscription, setCreateSubscription] = useState('');
  const [createResourceGroup, setCreateResourceGroup] = useState('');
  const [createLocation, setCreateLocation] = useState('');
  const [createSku, setCreateSku] = useState('Standard');
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  const hasResourceFields = !!picked?.fields.some((f) => f.kind === 'resource-select');

  /** Build the /options query string for a resource-select field from current props. */
  function optionsQuery(src: ResourceSelectSource): string {
    const q = new URLSearchParams();
    q.set('kind', src.optionsKind);
    if (src.optionsKind === 'namespaces') q.set('service', src.service || 'eventhub');
    if (src.optionsKind === 'connections' && src.connectionType) q.set('type', src.connectionType);
    if (props.subscriptionId) q.set('subscriptionId', props.subscriptionId);
    if (props.resourceGroup) q.set('resourceGroup', props.resourceGroup);
    if (props.namespace) q.set('namespace', props.namespace);
    if (props.eventHubName) q.set('eventHub', props.eventHubName);
    if (props.iotHubName) q.set('hubName', props.iotHubName);
    return q.toString();
  }

  const depsSatisfied = (f: SourceField) => (f.source?.dependsOn || []).every((k) => (props[k] || '').trim());

  async function loadOptions(f: SourceField) {
    const src = f.source;
    if (!src) return;
    setOptLoading((l) => ({ ...l, [f.key]: true }));
    setOptError((e) => ({ ...e, [f.key]: null }));
    try {
      const res = await fetch(`/api/realtime-hub/options?${optionsQuery(src)}`, { cache: 'no-store' });
      const j = await res.json().catch(() => ({}));
      if (res.status === 503 && j.code === 'not_configured') {
        setOptGate({ hint: j.hint || 'Set LOOM_SUBSCRIPTION_ID so source discovery can enumerate resources.', bicep: j.bicep });
        return;
      }
      if (!res.ok || !j.ok) {
        setOptError((e) => ({ ...e, [f.key]: j.error || `Could not list options (HTTP ${res.status}).` }));
        return;
      }
      setOptGate(null);
      setOptCache((c) => ({ ...c, [f.key]: Array.isArray(j.options) ? j.options : [] }));
      if (j.facets && typeof j.facets === 'object') setOptFacets((m) => ({ ...m, [f.key]: j.facets }));
    } catch (e: any) {
      setOptError((er) => ({ ...er, [f.key]: e?.message || String(e) }));
    } finally {
      setOptLoading((l) => ({ ...l, [f.key]: false }));
    }
  }

  // Lazily load each resource-select field's options once its parent selections
  // are satisfied. Re-runs whenever a parent scope value changes (cascade).
  const scopeSig = picked
    ? `${picked.id}|${props.subscriptionId || ''}|${props.resourceGroup || ''}|${props.namespace || ''}|${props.eventHubName || ''}|${props.iotHubName || ''}`
    : '';
  useEffect(() => {
    if (!open || !picked || optGate) return;
    for (const f of picked.fields) {
      if (f.kind !== 'resource-select' || !f.source) continue;
      if (!depsSatisfied(f)) continue;
      if (optCache[f.key] || optLoading[f.key] || optError[f.key]) continue;
      loadOptions(f);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scopeSig, optGate]);

  /** Select a resource-select value, capturing scope + clearing dependents (cascade). */
  function selectResource(f: SourceField, value: string, option?: ResourceOption) {
    const fields = picked?.fields || [];
    // Transitively collect every field that (directly or indirectly) depends on f.
    const cleared = new Set<string>();
    let frontier = [f.key];
    while (frontier.length) {
      const nextFrontier: string[] = [];
      for (const df of fields) {
        if (cleared.has(df.key)) continue;
        if ((df.source?.dependsOn || []).some((k) => frontier.includes(k))) {
          cleared.add(df.key);
          nextFrontier.push(df.key);
        }
      }
      frontier = nextFrontier;
    }
    setProps((p) => {
      const next: Record<string, string> = { ...p, [f.key]: value };
      if (f.source?.captureScope) {
        next.subscriptionId = option?.subscriptionId || '';
        next.resourceGroup = option?.resourceGroup || '';
      }
      for (const k of cleared) next[k] = '';
      return next;
    });
    setOptCache((c) => { const n = { ...c }; for (const k of cleared) delete n[k]; return n; });
    setOptError((e) => { const n = { ...e }; for (const k of cleared) n[k] = null; return n; });
  }

  function openCreate(f: SourceField) {
    setCreateField(f.key); setCreateName(''); setCreatePartitions('2'); setCreateRetention('1'); setCreateErr(null);
    // Seed the namespace-create panel from the discovery facets (configured
    // subscription scope + any region already seen) so the picker is pre-filled.
    const facets = optFacets[f.key] || {};
    setCreateSubscription((facets.subscriptions || [])[0] || props.subscriptionId || '');
    setCreateResourceGroup('');
    setCreateLocation((facets.locations || [])[0] || '');
    setCreateSku('Standard');
  }

  async function runCreate(f: SourceField) {
    const src = f.source;
    if (!src?.createKind) return;
    const name = createName.trim();
    if (!name) { setCreateErr('Name is required.'); return; }
    setCreateBusy(true); setCreateErr(null);
    try {
      const body: Record<string, unknown> = { kind: src.createKind };
      let createdOption: ResourceOption | undefined;
      if (src.createKind === 'eventhub') {
        Object.assign(body, {
          subscriptionId: props.subscriptionId, resourceGroup: props.resourceGroup, namespace: props.namespace,
          eventHub: name, partitionCount: Number(createPartitions) || 2, retentionDays: Number(createRetention) || 1,
        });
      } else if (src.createKind === 'consumerGroup') {
        Object.assign(body, {
          subscriptionId: props.subscriptionId, resourceGroup: props.resourceGroup, namespace: props.namespace,
          eventHub: props.eventHubName, consumerGroup: name,
        });
      } else if (src.createKind === 'iotConsumerGroup') {
        Object.assign(body, {
          hubName: props.iotHubName, consumerGroup: name,
          subscriptionId: props.subscriptionId, resourceGroup: props.resourceGroup,
        });
      } else if (src.createKind === 'namespace') {
        const sub = createSubscription.trim();
        const rg = createResourceGroup.trim();
        const loc = createLocation.trim();
        if (!sub) { setCreateErr('Subscription is required.'); setCreateBusy(false); return; }
        if (!rg) { setCreateErr('Resource group is required.'); setCreateBusy(false); return; }
        if (!loc) { setCreateErr('Location (Azure region) is required, e.g. eastus.'); setCreateBusy(false); return; }
        Object.assign(body, {
          subscriptionId: sub, resourceGroup: rg, namespace: name, location: loc, sku: createSku || 'Standard',
        });
        // Carry the new namespace's scope so captureScope wires the dependent
        // event-hub / consumer-group dropdowns immediately after selection.
        createdOption = { name, subscriptionId: sub, resourceGroup: rg, location: loc };
      }
      const res = await fetch('/api/realtime-hub/provision', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setCreateErr(j.error || `Create failed (HTTP ${res.status}).`); return; }
      const created = String(j?.created?.name || name);
      // Refresh the list so the new resource appears, then select it.
      setOptCache((c) => { const n = { ...c }; delete n[f.key]; return n; });
      setOptError((e) => ({ ...e, [f.key]: null }));
      selectResource(f, created, createdOption);
      setCreateField(null);
      await loadOptions(f);
    } catch (e: any) {
      setCreateErr(e?.message || String(e));
    } finally {
      setCreateBusy(false);
    }
  }

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
    setOptCache({}); setOptLoading({}); setOptError({}); setOptGate(null); setOptFacets({});
    setCreateField(null); setCreateName(''); setCreateErr(null); setCreateBusy(false);
    setCreateSubscription(''); setCreateResourceGroup(''); setCreateLocation(''); setCreateSku('Standard');
  }

  function pick(c: SourceConnector, preProps?: Record<string, string>, preName?: string) {
    setPicked(c);
    setDisplayName(preName?.trim() || `${c.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-stream`);
    // Seed defaults, then keep pre-filled values whose keys this connector
    // exposes — plus the canonical scope keys (subscriptionId / resourceGroup /
    // namespace) that the RTI hub Subscribe action carries even though they
    // aren't user-visible fields.
    const allowed: Record<string, string> = {};
    for (const f of c.fields) if (f.defaultValue) allowed[f.key] = f.defaultValue;
    if (preProps) {
      for (const f of c.fields) {
        const v = preProps[f.key];
        if (v != null && String(v).trim()) allowed[f.key] = String(v);
      }
      for (const k of SCOPE_KEYS) {
        const v = preProps[k];
        if (v != null && String(v).trim()) allowed[k] = String(v);
      }
    }
    setProps(allowed);
    setOptCache({}); setOptLoading({}); setOptError({}); setOptGate(null); setOptFacets({});
    setCreateField(null);
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
      // Forward the captured Azure scope (namespace's subscription + RG) so the
      // eventstream source can bind against the exact discovered resource — even
      // though these are not user-visible form fields.
      for (const k of SCOPE_KEYS) {
        const v = (props[k] || '').trim();
        if (v && !properties[k]) properties[k] = v;
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
                    } else if (f.kind === 'resource-select') {
                      const src = f.source!;
                      const opts = optCache[f.key] || [];
                      const loading = !!optLoading[f.key];
                      const err = optError[f.key];
                      const deps = src.dependsOn || [];
                      const depsOk = deps.every((k) => (props[k] || '').trim());
                      const cur = props[f.key] || '';
                      // Options may bind an id distinct from their display name
                      // (e.g. Loom connections: value=id, label=name). Resolve the
                      // label for the collapsed Dropdown from the current value.
                      const curOpt = opts.find((o) => (o.id ?? o.name) === cur);
                      const curLabel = curOpt?.name ?? cur;
                      const isCreating = createField === f.key;
                      const parentLabel = deps.length
                        ? (picked!.fields.find((x) => x.key === deps[deps.length - 1])?.label?.toLowerCase() || 'parent')
                        : '';
                      const placeholder =
                        optGate ? 'Subscription not configured'
                        : !depsOk ? `Select ${parentLabel} first`
                        : loading ? 'Loading…'
                        : opts.length === 0 ? (src.creatable ? 'None found — create one below' : 'None found')
                        : 'Select…';
                      nodes.push(
                        <Field key={f.key} label={f.label} required={f.required} hint={f.help}
                          validationState={err ? 'error' : undefined} validationMessage={err || undefined}>
                          <div className={styles.certRow}>
                            <div className={styles.certGrow}>
                              <Dropdown
                                aria-label={f.label}
                                disabled={!!optGate || !depsOk || loading}
                                placeholder={placeholder}
                                selectedOptions={cur ? [cur] : []}
                                value={curLabel}
                                onOptionSelect={(_, d) => {
                                  if (d.optionValue === CREATE_SENTINEL) { openCreate(f); return; }
                                  const opt = opts.find((o) => (o.id ?? o.name) === d.optionValue);
                                  selectResource(f, d.optionValue || '', opt);
                                }}
                              >
                                {opts.map((o) => {
                                  const optVal = o.id ?? o.name;
                                  return (
                                  <Option key={optVal} value={optVal} text={o.name}>
                                    <span className={styles.certOption}>
                                      <span className={styles.certOptionName}>{o.name}</span>
                                      {o.description && (
                                        <Caption1 style={{ color: tokens.colorNeutralForeground3, flexShrink: 0 }}>{o.description}</Caption1>
                                      )}
                                    </span>
                                  </Option>
                                  );
                                })}
                                {src.creatable && depsOk && (
                                  <Option key={CREATE_SENTINEL} value={CREATE_SENTINEL} text="Create new…">
                                    <span className={styles.certOption}>
                                      <Add16Regular className={styles.certOptionIcon} />
                                      <span className={styles.certOptionName}>Create new…</span>
                                    </span>
                                  </Option>
                                )}
                              </Dropdown>
                            </div>
                            <Button appearance="subtle" icon={<ArrowClockwise16Regular />}
                              aria-label={`Refresh ${f.label}`}
                              disabled={!!optGate || !depsOk || loading}
                              onClick={() => {
                                setOptCache((c) => { const n = { ...c }; delete n[f.key]; return n; });
                                setOptError((e) => ({ ...e, [f.key]: null }));
                                loadOptions(f);
                              }} />
                          </div>
                          {isCreating && (
                            <div className={styles.createPanel}>
                              <div className={styles.createPanelHead}>
                                <Add16Regular /> Create new {f.label.toLowerCase()}
                              </div>
                              <Field label="Name" required>
                                <Input value={createName} onChange={(_, d) => setCreateName(d.value)}
                                  placeholder={src.createKind === 'eventhub' ? 'telemetry' : src.createKind === 'namespace' ? 'loom-eventhubs-ns' : 'loom-receiver'} />
                              </Field>
                              {src.createKind === 'eventhub' && (
                                <div className={styles.createTwoCol}>
                                  <Field label="Partitions" hint="1–32">
                                    <Input type="number" value={createPartitions} onChange={(_, d) => setCreatePartitions(d.value)} />
                                  </Field>
                                  <Field label="Retention (days)" hint="1–7">
                                    <Input type="number" value={createRetention} onChange={(_, d) => setCreateRetention(d.value)} />
                                  </Field>
                                </div>
                              )}
                              {src.createKind === 'namespace' && (
                                <>
                                  <Field label="Subscription" required hint="Where the new namespace is created (Reader-discovered scope).">
                                    {(optFacets[f.key]?.subscriptions || []).length > 0 ? (
                                      <Dropdown
                                        aria-label="Subscription"
                                        placeholder="Select a subscription…"
                                        selectedOptions={createSubscription ? [createSubscription] : []}
                                        value={createSubscription}
                                        onOptionSelect={(_, d) => setCreateSubscription(d.optionValue || '')}
                                      >
                                        {(optFacets[f.key]?.subscriptions || []).map((s) => <Option key={s} value={s}>{s}</Option>)}
                                      </Dropdown>
                                    ) : (
                                      <Input value={createSubscription} onChange={(_, d) => setCreateSubscription(d.value)} placeholder="00000000-0000-0000-0000-000000000000" />
                                    )}
                                  </Field>
                                  <div className={styles.createTwoCol}>
                                    <Field label="Resource group" required>
                                      <Input value={createResourceGroup} onChange={(_, d) => setCreateResourceGroup(d.value)} placeholder="rg-loom-streaming" />
                                    </Field>
                                    <Field label="Location" required hint="Azure region">
                                      <Input value={createLocation} onChange={(_, d) => setCreateLocation(d.value)} placeholder="eastus" />
                                    </Field>
                                  </div>
                                  <Field label="Pricing tier" hint="Standard supports Kafka + Entra auth.">
                                    <Dropdown
                                      aria-label="Pricing tier"
                                      selectedOptions={[createSku]}
                                      value={createSku}
                                      onOptionSelect={(_, d) => setCreateSku(d.optionValue || 'Standard')}
                                    >
                                      {['Basic', 'Standard', 'Premium'].map((s) => <Option key={s} value={s}>{s}</Option>)}
                                    </Dropdown>
                                  </Field>
                                </>
                              )}
                              {createErr && (
                                <MessageBar intent="error"><MessageBarBody>{createErr}</MessageBarBody></MessageBar>
                              )}
                              <div className={styles.createActions}>
                                <Button appearance="subtle" icon={<Dismiss16Regular />} disabled={createBusy}
                                  onClick={() => { setCreateField(null); setCreateErr(null); }}>Cancel</Button>
                                <Button appearance="primary" icon={createBusy ? <Spinner size="tiny" /> : <Add16Regular />}
                                  disabled={createBusy || !createName.trim()} onClick={() => runCreate(f)}>
                                  {createBusy ? 'Creating…' : 'Create & select'}
                                </Button>
                              </div>
                            </div>
                          )}
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
                {hasResourceFields && optGate && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>Source discovery not configured</MessageBarTitle>
                      {optGate.hint}{optGate.bicep ? <> See <code>{optGate.bicep}</code>.</> : null}
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
                      <div className={styles.emptyGrid}>
                        <Search20Regular style={{ width: 32, height: 32, color: tokens.colorNeutralForeground4 }} aria-hidden />
                        <Body1>No sources match &quot;{query}&quot;.</Body1>
                        <Button appearance="subtle" size="small" onClick={() => setQuery('')}>Clear search</Button>
                      </div>
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
