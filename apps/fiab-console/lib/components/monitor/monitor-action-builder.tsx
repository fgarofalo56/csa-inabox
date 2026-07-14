'use client';

/**
 * MonitorActionBuilder — the reusable "THEN — action" surface for an Azure
 * Monitor rule/condition/action builder (G3). Renders the typed action config
 * (email / Teams / webhook / SMS / Logic App) OR a pick-existing action-group
 * flow, all via structured dropdowns + inputs (no freeform JSON —
 * loom_no_freeform_config). Fluent v9 + Loom tokens (web3-ui / ux-baseline).
 *
 * Real backends (no-vaporware):
 *   - GET  /api/monitor/action-groups     → the pick-existing list.
 *   - POST /api/monitor/logic-app-callback → resolve a Logic App trigger's
 *     listCallbackUrl (SAS) so the receiver can be invoked when the alert fires.
 * The composed action is mapped to the rule POST body by monitorActionToBody().
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Field, Dropdown, Option, Input, Button, Checkbox, Caption1, Spinner,
  MessageBar, MessageBarBody,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Flash20Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import {
  MONITOR_ACTION_KINDS, monitorActionSummary,
  type MonitorActionKind, type MonitorActionState,
} from './monitor-action-model';

interface ActionGroupLite {
  id: string; name: string; shortName: string;
  emailCount: number; smsCount: number; webhookCount: number; logicAppCount: number;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  row: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'flex-end' },
  colField: { flex: 1, minWidth: '220px' },
  preview: { fontFamily: 'Consolas, monospace', color: tokens.colorBrandForeground1 },
});

export function MonitorActionBuilder({
  value,
  onChange,
}: {
  value: MonitorActionState;
  onChange: (next: MonitorActionState) => void;
}) {
  const s = useStyles();
  const set = useCallback((patch: Partial<MonitorActionState>) => onChange({ ...value, ...patch }), [value, onChange]);

  // Pick-existing action groups (non-fatal on error — compose-new still works).
  const [groups, setGroups] = useState<ActionGroupLite[]>([]);
  useEffect(() => {
    let live = true;
    clientFetch('/api/monitor/action-groups')
      .then((r) => r.json())
      .then((j) => { if (live && j?.ok) setGroups(j.actionGroups || []); })
      .catch(() => { /* pick-existing simply has no options */ });
    return () => { live = false; };
  }, []);

  // Logic App callback URL resolution (real ARM listCallbackUrl).
  const [fetchingCb, setFetchingCb] = useState(false);
  const [cbErr, setCbErr] = useState<string | null>(null);
  const fetchCallback = useCallback(async () => {
    if (!value.logicAppResourceId.trim()) { setCbErr('Enter the Logic App resource id first.'); return; }
    setFetchingCb(true); setCbErr(null);
    try {
      const r = await clientFetch('/api/monitor/logic-app-callback', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowResourceId: value.logicAppResourceId.trim(), triggerName: value.logicAppTrigger.trim() || undefined }),
      });
      const j = await r.json();
      if (!j?.ok) setCbErr(j?.gate?.remediation || j?.error || 'failed to resolve callback URL');
      else set({ logicAppCallbackUrl: j.callbackUrl || '' });
    } catch (e: any) {
      setCbErr(e?.message || String(e));
    } finally { setFetchingCb(false); }
  }, [value.logicAppResourceId, value.logicAppTrigger, set]);

  const targetLabel =
    value.kind === 'Email' ? 'To address'
    : value.kind === 'TeamsMessage' ? 'Teams webhook URL'
    : 'Webhook URL';

  return (
    <div className={s.root}>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>THEN — action</Caption1>
      <Checkbox
        label="Attach an existing action group (skip building a new one)"
        checked={value.useExisting}
        disabled={groups.length === 0}
        onChange={(_, d) => set({ useExisting: !!d.checked })}
      />

      {value.useExisting ? (
        <Field label="Action group" hint="A Microsoft.Insights/actionGroups resource in the Loom alert resource group.">
          <Dropdown
            value={groups.find((g) => g.id === value.existingActionGroupId)?.name || ''}
            selectedOptions={value.existingActionGroupId ? [value.existingActionGroupId] : []}
            placeholder={groups.length ? 'Select an action group…' : 'No action groups found'}
            onOptionSelect={(_, d) => d.optionValue != null && set({ existingActionGroupId: d.optionValue })}
          >
            {groups.map((g) => (
              <Option key={g.id} value={g.id}>
                {`${g.name} (${g.emailCount} email · ${g.smsCount} SMS · ${g.webhookCount} webhook · ${g.logicAppCount} logic app)`}
              </Option>
            ))}
          </Dropdown>
        </Field>
      ) : (
        <>
          <div className={s.row}>
            <Field label="Do" style={{ width: '200px' }}>
              <Dropdown
                value={MONITOR_ACTION_KINDS.find((k) => k.value === value.kind)?.label || ''}
                selectedOptions={[value.kind]}
                onOptionSelect={(_, d) => d.optionValue && set({ kind: d.optionValue as MonitorActionKind })}
              >
                {MONITOR_ACTION_KINDS.map((k) => <Option key={k.value} value={k.value}>{k.label}</Option>)}
              </Dropdown>
            </Field>
            {(value.kind === 'Email' || value.kind === 'TeamsMessage' || value.kind === 'Webhook') && (
              <Field label={targetLabel} className={s.colField}>
                <Input value={value.target} onChange={(_, d) => set({ target: d.value })}
                  placeholder={value.kind === 'Email' ? 'alerts@example.com' : 'https://…'} />
              </Field>
            )}
          </div>

          {(value.kind === 'Email' || value.kind === 'TeamsMessage') && (
            <Field label={value.kind === 'Email' ? 'Subject' : 'Message'}>
              <Input value={value.message} onChange={(_, d) => set({ message: d.value })} />
            </Field>
          )}

          {value.kind === 'SMS' && (
            <div className={s.row}>
              <Field label="Country code" style={{ width: '140px' }} hint="e.g. 1 for US">
                <Input value={value.countryCode} onChange={(_, d) => set({ countryCode: d.value })} />
              </Field>
              <Field label="Phone number" className={s.colField}>
                <Input value={value.phone} onChange={(_, d) => set({ phone: d.value })} placeholder="5551234567" />
              </Field>
            </div>
          )}

          {value.kind === 'LogicApp' && (
            <div className={s.root}>
              <Field label="Logic App resource id" hint="Microsoft.Logic/workflows resource id (Consumption workflow with an HTTP trigger).">
                <Input value={value.logicAppResourceId} onChange={(_, d) => set({ logicAppResourceId: d.value })}
                  placeholder="/subscriptions/…/providers/Microsoft.Logic/workflows/wf-alert" />
              </Field>
              <div className={s.row}>
                <Field label="Trigger name" style={{ width: '160px' }}>
                  <Input value={value.logicAppTrigger} onChange={(_, d) => set({ logicAppTrigger: d.value })} />
                </Field>
                <Button appearance="secondary" icon={<Flash20Regular />} disabled={fetchingCb || !value.logicAppResourceId.trim()} onClick={fetchCallback}>
                  {fetchingCb ? 'Resolving…' : 'Fetch callback URL from ARM'}
                </Button>
                {fetchingCb && <Spinner size="tiny" />}
              </div>
              <Field label="Trigger callback URL" hint="Auto-filled by 'Fetch callback URL', or paste a listCallbackUrl SAS URL.">
                <Input value={value.logicAppCallbackUrl} onChange={(_, d) => set({ logicAppCallbackUrl: d.value })} />
              </Field>
              {cbErr && <MessageBar intent="warning"><MessageBarBody>{cbErr}</MessageBarBody></MessageBar>}
            </div>
          )}
        </>
      )}

      <Caption1 className={s.preview}>→ {monitorActionSummary(value)}</Caption1>
    </div>
  );
}
