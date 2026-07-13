'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * AttachedServicesSection — the "Attached services" panel shown per landing zone
 * (and for the hub) on /admin/landing-zones (§2.2). Lists the EXISTING Azure
 * services attached to a landing zone from the Landing-Zone Service Registry,
 * with an "Attach existing service" entry point (AttachServiceWizard) and a
 * per-service detach action (referential-integrity guarded server-side).
 *
 * Real data (GET /api/landing-zones/[id]/services); Fluent v9 + Loom tokens,
 * EmptyState for the empty pane, honest badges for each service's live posture.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  makeStyles, tokens,
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle,
} from '@fluentui/react-components';
import {
  Add16Regular, ArrowClockwise20Regular, Delete16Regular,
  PlugConnected24Regular, CheckmarkCircle16Filled, Warning16Regular,
  ShieldKeyhole16Regular, Database16Regular, DataUsage16Regular, MoneyHand16Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { getKindDef, kindLabel } from '@/lib/azure/attached-service-kinds';
import { AttachServiceWizard } from './attach-service-wizard';

/** Client-safe base64url encode of a `${sub}/${rg}` landing-zone id. */
function encodeLzIdForPath(id: string): string {
  if (!id.includes('/')) return id;
  const b64 = btoa(unescape(encodeURIComponent(id)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type IntegrationStepStatus =
  | 'granted' | 'registered' | 'wired' | 'included'
  | 'pending-grants' | 'not-configured' | 'skipped' | 'error';
interface IntegrationStepResult {
  status: IntegrationStepStatus;
  detail?: string;
  grantScript?: string;
  checkedAt?: string;
}
interface AttachedServiceIntegration {
  rbac?: IntegrationStepResult;
  purview?: IntegrationStepResult;
  telemetry?: IntegrationStepResult;
  chargeback?: IntegrationStepResult;
}

interface AttachedServiceView {
  id: string;
  landingZoneId: string;
  kind: string;
  displayName: string;
  armResourceId: string;
  subscriptionId: string;
  resourceGroup: string;
  origin: 'day0-byo' | 'day2-attach';
  status: 'attached' | 'pending-grants';
  validation?: {
    reachability?: 'reachable' | 'private-endpoint-needed' | 'blocked' | 'unknown';
    rbacState?: 'granted' | 'pending' | 'manual-gate';
    networkPosture?: 'public' | 'private-endpoint' | 'service-endpoint' | 'unknown';
    rbacRoleName?: string;
    remediation?: string;
  };
  integration?: AttachedServiceIntegration;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalS, paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  row: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
  },
  integrationRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap',
    paddingTop: tokens.spacingVerticalXXS,
  },
  gateBar: { marginTop: tokens.spacingVerticalXS },
  code: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200,
    backgroundColor: tokens.colorNeutralBackground3,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusSmall, wordBreak: 'break-all',
    display: 'inline-block',
  },
  rowIcon: { flexShrink: 0, display: 'inline-flex', fontSize: '20px' },
  rowText: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 },
  rowName: { fontWeight: tokens.fontWeightSemibold, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  rowSub: { color: tokens.colorNeutralForeground3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  badges: { display: 'flex', gap: tokens.spacingHorizontalXS, flexShrink: 0, flexWrap: 'wrap' },
  meta: { color: tokens.colorNeutralForeground3 },
});

function reachBadge(v: AttachedServiceView['validation']) {
  const r = v?.reachability;
  if (r === 'reachable') return <Badge appearance="tint" color="success" size="small" icon={<CheckmarkCircle16Filled />}>Reachable</Badge>;
  if (r === 'private-endpoint-needed') return <Badge appearance="tint" color="warning" size="small" icon={<Warning16Regular />}>PE needed</Badge>;
  if (r === 'blocked') return <Badge appearance="tint" color="danger" size="small">Blocked</Badge>;
  return <Badge appearance="tint" color="informative" size="small">Unknown</Badge>;
}

/** Colour for an auto-integration step status (green = done, amber = gate). */
function stepColor(status?: IntegrationStepStatus): 'success' | 'warning' | 'danger' | 'informative' {
  if (status === 'granted' || status === 'registered' || status === 'wired' || status === 'included') return 'success';
  if (status === 'pending-grants') return 'warning';
  if (status === 'error') return 'danger';
  return 'informative'; // not-configured / skipped / undefined
}

const STEP_LABEL: Record<string, string> = { granted: 'granted', registered: 'registered', wired: 'wired', included: 'in sweep', 'pending-grants': 'action needed', 'not-configured': 'not configured', skipped: 'n/a', error: 'error' };

/** One auto-integration badge (RBAC / Governance / Telemetry / Chargeback). */
function IntegrationBadge({ label, icon, step }: { label: string; icon: ReactElement; step?: IntegrationStepResult }) {
  const status = step?.status;
  const tip = step?.detail || `${label}: ${status ? (STEP_LABEL[status] || status) : 'not run'}`;
  return (
    <Tooltip content={tip} relationship="description" withArrow>
      <Badge appearance="tint" color={stepColor(status)} size="small" icon={icon}>
        {label}: {status ? (STEP_LABEL[status] || status) : '—'}
      </Badge>
    </Tooltip>
  );
}

export function AttachedServicesSection({
  landingZoneId, landingZoneLabel,
}: {
  /** `${sub}/${rg}` of a DLZ, 'hub', or 'all'. */
  landingZoneId: string;
  landingZoneLabel?: string;
}) {
  const s = useStyles();
  const [services, setServices] = useState<AttachedServiceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [detaching, setDetaching] = useState<string | null>(null);

  const encodedLz = useMemo(() => encodeLzIdForPath(landingZoneId), [landingZoneId]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await clientFetch(`/api/landing-zones/${encodedLz}/services`);
      const j = await res.json();
      if (!res.ok || !j.ok) { setError(j?.error || `HTTP ${res.status}`); setServices([]); }
      else setServices(Array.isArray(j.services) ? j.services : []);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [encodedLz]);

  useEffect(() => { void load(); }, [load]);

  const detach = useCallback(async (svc: AttachedServiceView) => {
    setDetaching(svc.id); setError(null);
    try {
      const res = await clientFetch(`/api/landing-zones/${encodedLz}/services/${svc.id}`, { method: 'DELETE' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setError(j?.error || `Could not detach (HTTP ${res.status}).`);
      } else {
        await load();
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setDetaching(null);
    }
  }, [encodedLz, load]);

  return (
    <div className={s.root}>
      <div className={s.head}>
        <Subtitle2>Attached services{landingZoneLabel ? ` · ${landingZoneLabel}` : ''}</Subtitle2>
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS }}>
          <Button appearance="subtle" size="small" icon={<ArrowClockwise20Regular />} onClick={() => void load()}>Refresh</Button>
          <Button appearance="primary" size="small" icon={<Add16Regular />} onClick={() => setWizardOpen(true)}>Attach existing service</Button>
        </div>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load / modify attached services</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {loading ? (
        <Spinner size="tiny" label="Reading the service registry…" />
      ) : services.length === 0 ? (
        <EmptyState
          icon={<PlugConnected24Regular />}
          title="No services attached yet"
          body="Attach an existing Azure service you already own (Synapse, Data Explorer, storage, and more) so it becomes part of Loom — governance, chargeback, and navigators included."
          primaryAction={{ label: 'Attach existing service', onClick: () => setWizardOpen(true) }}
        />
      ) : (
        <div className={s.list}>
          {services.map((svc) => {
            const def = getKindDef(svc.kind);
            const visual = itemVisual(def?.tileSlug || svc.kind);
            const Icon = visual.icon;
            const integ = svc.integration;
            // Honest gates: any step that emitted a grant command to run by hand.
            const gates = [integ?.rbac, integ?.telemetry]
              .filter((st): st is IntegrationStepResult => !!st && st.status === 'pending-grants' && !!st.grantScript);
            return (
              <div key={svc.id} className={s.card}>
                <div className={s.row}>
                  <span className={s.rowIcon} style={{ color: visual.color }}><Icon /></span>
                  <span className={s.rowText}>
                    <span className={s.rowName} title={svc.displayName}>{svc.displayName}</span>
                    <Caption1 className={s.rowSub} title={svc.armResourceId}>
                      {kindLabel(svc.kind)}{svc.resourceGroup ? ` · ${svc.resourceGroup}` : ''}
                    </Caption1>
                  </span>
                  <span className={s.badges}>
                    <Badge appearance="outline" size="small" color={svc.origin === 'day0-byo' ? 'brand' : 'informative'}>
                      {svc.origin === 'day0-byo' ? 'day-0 BYO' : 'attached'}
                    </Badge>
                    <Badge appearance="outline" size="small" color={svc.status === 'attached' ? 'success' : 'warning'}>
                      {svc.status === 'attached' ? 'ready' : 'pending grants'}
                    </Badge>
                    {reachBadge(svc.validation)}
                    <Button
                      appearance="subtle" size="small" icon={detaching === svc.id ? <Spinner size="tiny" /> : <Delete16Regular />}
                      disabled={detaching === svc.id}
                      onClick={() => void detach(svc)}
                    >
                      Detach
                    </Button>
                  </span>
                </div>

                {/* Phase-2 auto-integration status — RBAC / Governance / Telemetry / Chargeback. */}
                <div className={s.integrationRow}>
                  <IntegrationBadge label="RBAC" icon={<ShieldKeyhole16Regular />} step={integ?.rbac} />
                  <IntegrationBadge label="Governance" icon={<Database16Regular />} step={integ?.purview} />
                  <IntegrationBadge label="Telemetry" icon={<DataUsage16Regular />} step={integ?.telemetry} />
                  <IntegrationBadge label="Chargeback" icon={<MoneyHand16Regular />} step={integ?.chargeback} />
                </div>

                {gates.length > 0 && (
                  <MessageBar intent="warning" className={s.gateBar} layout="multiline">
                    <MessageBarBody>
                      <MessageBarTitle>Grant needed to finish integrating</MessageBarTitle>
                      {gates.map((g, i) => (
                        <div key={i} style={{ marginTop: i ? tokens.spacingVerticalXS : 0 }}>
                          <div>{g.detail}</div>
                          <code className={s.code}>{g.grantScript}</code>
                        </div>
                      ))}
                    </MessageBarBody>
                  </MessageBar>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Body1 className={s.meta} as="p">
        Detaching removes only the Loom binding — it never deletes your Azure resource.
      </Body1>

      <AttachServiceWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        landingZoneId={landingZoneId}
        landingZoneLabel={landingZoneLabel}
        onAttached={() => void load()}
      />
    </div>
  );
}

export default AttachedServicesSection;
