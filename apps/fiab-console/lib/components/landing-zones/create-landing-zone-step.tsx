'use client';

/**
 * CreateLandingZoneStep — the lightweight "＋ New landing zone" form used by the
 * AttachServiceWizard's step-0 selector (dlz-brownfield Phase A).
 *
 * It creates a LOGICAL landing zone (POST /api/landing-zones) — a durable
 * grouping target the attach flow then hangs existing brownfield services on.
 * It provisions NOTHING in Azure; it is metadata only. Fields are collected via
 * dropdowns / pickers (subscription list from ARM, region dropdown, Entra group
 * pickers) rather than free-form ids where avoidable (loom-no-freeform-config).
 * The boundary + region default from the deployed hub server-side.
 *
 * Fluent v9 + Loom tokens only.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Field, Input, Dropdown, Option, Button, Switch, Spinner, Caption1, Divider,
  MessageBar, MessageBarBody, MessageBarTitle, makeStyles, tokens,
} from '@fluentui/react-components';
import { Add20Regular, ArrowLeft20Regular } from '@fluentui/react-icons';
import { clientFetch, CROSS_SUB_FETCH_TIMEOUT_MS } from '@/lib/client-fetch';
import { EntraGroupPicker } from '@/lib/components/admin/entra-group-picker';

interface AzureSubscription { subscriptionId: string; displayName: string; state: string }

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '520px', maxWidth: '640px' },
  fields: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  toggles: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  footer: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalS },
  note: { color: tokens.colorNeutralForeground3 },
});

const SLUG_RE = /[^a-z0-9-]/g;

export function CreateLandingZoneStep({
  onCreated, onBack,
}: {
  /** Called with the persisted logical LZ's stable id + display name. */
  onCreated: (id: string, name: string) => void;
  onBack: () => void;
}) {
  const s = useStyles();
  const [subs, setSubs] = useState<AzureSubscription[]>([]);
  const [subsLoading, setSubsLoading] = useState(false);

  const [name, setName] = useState('');
  const [subscriptionId, setSubscriptionId] = useState('');
  const [subscriptionName, setSubscriptionName] = useState('');
  const [region, setRegion] = useState('');
  const [costCenter, setCostCenter] = useState('');
  const [adminGroupId, setAdminGroupId] = useState('');
  const [memberGroupId, setMemberGroupId] = useState('');
  const [peeringNeeded, setPeeringNeeded] = useState(false);
  const [privateDnsNeeded, setPrivateDnsNeeded] = useState(false);

  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSubs = useCallback(async () => {
    setSubsLoading(true);
    try {
      const res = await clientFetch('/api/setup/subscriptions', undefined, CROSS_SUB_FETCH_TIMEOUT_MS);
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) setSubs(j.subscriptions || []);
    } catch {
      /* subscription list is best-effort — subscription is optional for a logical LZ */
    } finally {
      setSubsLoading(false);
    }
  }, []);

  useEffect(() => { void loadSubs(); }, [loadSubs]);

  const create = useCallback(async () => {
    if (!name.trim()) return;
    setCreating(true); setError(null);
    try {
      const res = await clientFetch('/api/landing-zones', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          subscriptionId: subscriptionId || undefined,
          region: region || undefined,
          costCenter: costCenter || undefined,
          adminGroupId: adminGroupId || undefined,
          memberGroupId: memberGroupId || undefined,
          network: { peeringNeeded, privateDnsNeeded },
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok || !j.landingZone) {
        setError(j?.error || j?.remediation || `Could not create the landing zone (HTTP ${res.status}).`);
        return;
      }
      onCreated(j.landingZone.id, j.landingZone.name);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setCreating(false);
    }
  }, [name, subscriptionId, region, costCenter, adminGroupId, memberGroupId, peeringNeeded, privateDnsNeeded, onCreated]);

  const slug = name.trim().toLowerCase().replace(SLUG_RE, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');

  return (
    <div className={s.root}>
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>New landing zone</MessageBarTitle>
          This creates a lightweight <b>logical</b> landing zone — a durable grouping target you can
          attach existing Azure services to. It provisions nothing in Azure; the cloud boundary is
          inherited from your deployed hub. To stand up a full greenfield Data Landing Zone instead,
          use <b>Add a landing zone</b>.
        </MessageBarBody>
      </MessageBar>

      <div className={s.fields}>
        <Field
          label="Landing zone name"
          required
          hint={slug ? `Id: ${slug}` : 'Letters, digits, and hyphens. e.g. finance, mission-ops'}
        >
          <Input value={name} placeholder="finance, procurement, mission-ops…" onChange={(_, d) => setName(d.value)} />
        </Field>

        <Field label="Subscription" hint="The subscription the landing zone's services mostly live in (optional).">
          {subsLoading ? (
            <Spinner size="tiny" label="Listing subscriptions…" />
          ) : (
            <Dropdown
              placeholder={subs.length ? 'Select a subscription (optional)' : 'No subscriptions available'}
              disabled={subs.length === 0}
              value={subscriptionName || subscriptionId}
              selectedOptions={subscriptionId ? [subscriptionId] : []}
              onOptionSelect={(_, d) => {
                setSubscriptionId((d.optionValue as string) || '');
                setSubscriptionName(subs.find((x) => x.subscriptionId === d.optionValue)?.displayName || '');
              }}
            >
              {subs.map((sub) => (
                <Option key={sub.subscriptionId} value={sub.subscriptionId} text={sub.displayName}>
                  {sub.displayName} — {sub.subscriptionId} ({sub.state})
                </Option>
              ))}
            </Dropdown>
          )}
        </Field>

        <Field label="Region" hint="Defaults to the hub region when left blank.">
          <Input value={region} placeholder="e.g. eastus2" onChange={(_, d) => setRegion(d.value.trim())} />
        </Field>

        <EntraGroupPicker label="Admin group (Entra)" value={adminGroupId} onChange={setAdminGroupId}
          hint="Entra security group granted admin over this landing zone." />
        <EntraGroupPicker label="Member group (Entra)" value={memberGroupId} onChange={setMemberGroupId}
          hint="Entra security group granted member access." />

        <Field label="Cost center" hint="Chargeback code for this landing zone (optional).">
          <Input value={costCenter} placeholder="e.g. CC-1042" onChange={(_, d) => setCostCenter(d.value)} />
        </Field>

        <Divider />
        <Caption1 className={s.note}>Network posture (recorded so guided remediation can wire it later):</Caption1>
        <div className={s.toggles}>
          <Switch checked={peeringNeeded} onChange={(_, d) => setPeeringNeeded(!!d.checked)}
            label="Hub↔spoke VNet peering still needed" />
          <Switch checked={privateDnsNeeded} onChange={(_, d) => setPrivateDnsNeeded(!!d.checked)}
            label="Private DNS zone links still needed" />
        </div>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not create the landing zone</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={s.footer}>
        <Button appearance="subtle" icon={<ArrowLeft20Regular />} onClick={onBack}>Back</Button>
        <Button
          appearance="primary"
          icon={creating ? <Spinner size="tiny" /> : <Add20Regular />}
          disabled={!name.trim() || creating}
          onClick={() => void create()}
        >
          {creating ? 'Creating…' : 'Create + continue'}
        </Button>
      </div>
    </div>
  );
}

export default CreateLandingZoneStep;
