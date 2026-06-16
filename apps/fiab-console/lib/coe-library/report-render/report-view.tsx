'use client';

/**
 * ReportView — the interactive CoE report surface: fetches a report's render
 * model from a session-gated BFF endpoint and renders it with {@link ReportCanvas},
 * adding a Live data / Sample toggle and a parameter panel.
 *
 * Live (default for admins) resolves each visual against the deployment's OWN
 * Azure estate (Cost Management, Log Analytics, Azure Resource Graph, Defender)
 * with ZERO manual entry — the parameters are pre-filled from the deployment's
 * environment. The parameter panel lets an admin point the render at a different
 * subscription / billing scope and re-render. Every tile is labelled with its
 * true provenance (live / sample / honest gate).
 *
 * Azure-native: no Microsoft Fabric / Power BI workspace is required.
 */

import * as React from 'react';
import {
  Switch, Spinner, Button, Field, Input, Popover, PopoverTrigger, PopoverSurface,
  MessageBar, MessageBarBody, Caption1, makeStyles, tokens,
} from '@fluentui/react-components';
import { Settings20Regular } from '@fluentui/react-icons';
import { ReportCanvas } from './report-canvas';
import { useReportModel, type FetchSpec, type ReportPayload, type ReportParams } from './use-report';

const useStyles = makeStyles({
  center: { display: 'flex', justifyContent: 'center', padding: tokens.spacingVerticalXXL },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
    gap: tokens.spacingHorizontalM, flexWrap: 'wrap',
  },
  spacer: { flex: 1 },
  panel: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    minWidth: '320px', padding: tokens.spacingHorizontalXS,
  },
  panelActions: { display: 'flex', gap: tokens.spacingHorizontalS, justifyContent: 'flex-end', marginTop: tokens.spacingVerticalS },
  hint: { color: tokens.colorNeutralForeground3 },
});

interface Overrides {
  subscriptionId?: string;
  billingScope?: string;
  tenantId?: string;
  managementApiBase?: string;
}

function hasOverrides(o: Overrides): boolean {
  return !!(o.subscriptionId || o.billingScope || o.tenantId || o.managementApiBase);
}

/** Build the fetch spec for the current live/override state. */
function buildSpec(fetchUrl: string | null, live: boolean, applied: Overrides): FetchSpec | null {
  if (!fetchUrl) return null;
  if (!live) return { url: fetchUrl, method: 'GET' };
  if (hasOverrides(applied)) {
    return { url: fetchUrl, method: 'POST', body: { mode: 'live', params: applied } };
  }
  const sep = fetchUrl.includes('?') ? '&' : '?';
  return { url: `${fetchUrl}${sep}mode=live`, method: 'GET' };
}

export interface ReportViewProps {
  /** Base GET url, e.g. `/api/admin/coe-library/render?cloneId=…`. */
  fetchUrl: string | null;
  /** Default to live data (admins) — falls back per-entity automatically. */
  defaultLive?: boolean;
  /** Notified whenever a payload loads (so a parent can read template/published). */
  onLoaded?: (payload: ReportPayload) => void;
}

function ParamPanel({
  params, draft, setDraft, onApply, onReset, dirty,
}: {
  params?: ReportParams;
  draft: Overrides;
  setDraft: (o: Overrides) => void;
  onApply: () => void;
  onReset: () => void;
  dirty: boolean;
}) {
  const s = useStyles();
  return (
    <div className={s.panel}>
      <Caption1 className={s.hint}>
        Pre-filled from this deployment&apos;s environment. Override to render against a different scope.
      </Caption1>
      <Field label="Subscription ID">
        <Input
          value={draft.subscriptionId ?? ''}
          placeholder={params?.subscriptionId || 'LOOM_SUBSCRIPTION_ID'}
          onChange={(_, d) => setDraft({ ...draft, subscriptionId: d.value })}
        />
      </Field>
      <Field label="Billing scope">
        <Input
          value={draft.billingScope ?? ''}
          placeholder={params?.billingScope || '/subscriptions/<id>'}
          onChange={(_, d) => setDraft({ ...draft, billingScope: d.value })}
        />
      </Field>
      <Field label="Tenant ID">
        <Input
          value={draft.tenantId ?? ''}
          placeholder={params?.tenantId || 'LOOM_TENANT_ID'}
          onChange={(_, d) => setDraft({ ...draft, tenantId: d.value })}
        />
      </Field>
      <Field label="Log Analytics workspace" hint="Uses the deployment's configured workspace (LOOM_LOG_ANALYTICS_WORKSPACE_ID).">
        <Input value={params?.logAnalyticsWorkspaceId || ''} readOnly disabled />
      </Field>
      <div className={s.panelActions}>
        <Button appearance="secondary" size="small" onClick={onReset} disabled={!hasOverrides(draft)}>Reset</Button>
        <Button appearance="primary" size="small" onClick={onApply} disabled={!dirty}>Apply</Button>
      </div>
    </div>
  );
}

export function ReportView({ fetchUrl, defaultLive = true, onLoaded }: ReportViewProps): React.ReactElement {
  const s = useStyles();
  const [live, setLive] = React.useState(defaultLive);
  const [draft, setDraft] = React.useState<Overrides>({});
  const [applied, setApplied] = React.useState<Overrides>({});
  const [panelOpen, setPanelOpen] = React.useState(false);

  const spec = React.useMemo(() => buildSpec(fetchUrl, live, applied), [fetchUrl, live, applied]);
  const { data, loading, error } = useReportModel(spec);

  React.useEffect(() => { if (data) onLoaded?.(data); }, [data, onLoaded]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);
  const apply = () => { setApplied(draft); setPanelOpen(false); };
  const reset = () => { setDraft({}); setApplied({}); };

  const header = (
    <div className={s.header}>
      <div className={s.spacer} />
      <Switch
        checked={live}
        onChange={(_, d) => setLive(!!d.checked)}
        label={live ? 'Live data' : 'Sample data'}
      />
      {live && (
        <Popover open={panelOpen} onOpenChange={(_, d) => setPanelOpen(d.open)} trapFocus>
          <PopoverTrigger disableButtonEnhancement>
            <Button appearance="subtle" size="small" icon={<Settings20Regular />}>Parameters</Button>
          </PopoverTrigger>
          <PopoverSurface>
            <ParamPanel
              params={data?.params}
              draft={draft}
              setDraft={setDraft}
              onApply={apply}
              onReset={reset}
              dirty={dirty}
            />
          </PopoverSurface>
        </Popover>
      )}
    </div>
  );

  if (loading) return <div className={s.center}><Spinner label={live ? 'Rendering live report…' : 'Rendering report…'} /></div>;
  if (error) return <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>;
  if (!data) return <div className={s.center}><Spinner label="Rendering report…" /></div>;

  const liveMode = live && !!data.dataSources;
  const renderData = liveMode ? (data.live || data.sample) : data.sample;

  return (
    <>
      {live && data.liveError && (
        <MessageBar intent="warning">
          <MessageBarBody>Live render fell back to sample: {data.liveError}</MessageBarBody>
        </MessageBar>
      )}
      <ReportCanvas
        model={data.model}
        sample={renderData}
        dataSources={data.dataSources}
        liveMode={liveMode}
        header={header}
      />
    </>
  );
}

export default ReportView;
