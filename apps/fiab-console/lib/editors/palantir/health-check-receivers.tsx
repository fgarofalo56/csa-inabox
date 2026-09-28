'use client';

/**
 * Health-check notification receiver rows that bind to an Azure resource —
 * the Azure Function (#4740) and Logic App (#4748) channels.
 *
 * Both follow ONE rule (`auto-bind-by-default.md`): the user PICKS a resource,
 * the platform works out the binding, and anything secret-bearing (a function
 * key, a Logic App SAS callback) is resolved server-side at save — never typed,
 * never stored on the item, never rendered here.
 *
 *   Azure Function  Function App via the `function-app-id` picker (the same kind
 *                   `event-grid-topic-editor` uses), then the function inside it
 *                   from `GET /api/azure/function-apps/functions`, each marked
 *                   usable or not with the reason.
 *   Logic App       workflow via the `logic-app` picker, then its HTTP-request
 *                   trigger read from the workflow definition by
 *                   `GET /api/monitor/logic-app-triggers` — reported BEFORE
 *                   save, so a workflow that cannot be invoked says so on pick,
 *                   and a workflow with several request triggers offers the
 *                   choice instead of making it silently.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import {
  Button, Caption1, Dropdown, Field, MessageBar, MessageBarBody, MessageBarTitle, Option, Spinner, Switch,
  tokens,
} from '@fluentui/react-components';
import { Dismiss16Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { AzureBackedField } from '@/lib/components/azure/azure-backed-field';
import type { FunctionReceiverView, LogicAppReceiverRow } from '@/app/api/items/health-check/_lib/notification-receivers';

const rowStyle: CSSProperties = { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' };
const stackStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 };
const pickerStyle: CSSProperties = { flex: 1, minWidth: 280 };

interface FunctionInfo { name: string; httpTrigger: boolean; authLevel: string; isDisabled: boolean; usable: boolean; reason?: string }

function gateText(j: any, status: number): string {
  const base = j?.error || `HTTP ${status}`;
  return j?.gate?.remediation ? `${base} ${j.gate.remediation}` : base;
}

// ───────────────────────────── Azure Function ─────────────────────────────

export function FunctionReceiverRow({
  row, onChange, onRemove,
}: {
  row: FunctionReceiverView;
  onChange: (next: FunctionReceiverView) => void;
  onRemove: () => void;
}) {
  const appId = row.functionAppResourceId || '';
  const [fns, setFns] = useState<FunctionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!appId) { setFns([]); setError(null); return; }
    let cancelled = false;
    setLoading(true); setError(null);
    void (async () => {
      try {
        const r = await clientFetch(`/api/azure/function-apps/functions?siteId=${encodeURIComponent(appId)}`);
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!j?.ok) { setFns([]); setError(gateText(j, r.status)); return; }
        setFns(Array.isArray(j.functions) ? j.functions : []);
      } catch (e: any) {
        if (!cancelled) { setFns([]); setError(e?.message || String(e)); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [appId]);

  const usable = fns.filter((f) => f.usable);
  // Exactly one function can receive alerts → bind it; the user has nothing to choose.
  useEffect(() => {
    if (appId && !row.functionName && usable.length === 1) onChange({ ...row, functionName: usable[0].name });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, row.functionName, usable.length === 1 ? usable[0].name : '']);

  const isLegacy = !!row.legacyEndpoint && !appId;
  const selected = fns.find((f) => f.name === row.functionName);

  return (
    <div style={stackStyle} data-testid="hc-function-receiver">
      {isLegacy && (
        <MessageBar intent="warning" data-testid="hc-function-legacy">
          <MessageBarBody>
            <MessageBarTitle>Re-bind this Azure Function</MessageBarTitle>
            It was saved as a hand-typed trigger URL (<code>{row.legacyEndpoint}</code>), so its function key is stored on this item.
            It keeps receiving alerts until you pick its Function App below; after that the key is resolved server-side at save and nothing secret is stored here.
          </MessageBarBody>
        </MessageBar>
      )}
      <div style={rowStyle}>
        <div style={pickerStyle}>
          <AzureBackedField
            kind="function-app-id"
            value={appId}
            label="Function App"
            surface="Health check notification"
            hint="The function's trigger URL and key are resolved from the Function App at save — never typed, never stored."
            onChange={(v) => onChange({
              ...(row.name ? { name: row.name } : {}),
              functionAppResourceId: v || '',
              functionName: '',
              useCommonAlertSchema: row.useCommonAlertSchema,
              // Picking an app replaces a legacy URL; clearing the pick keeps it.
              ...(!v && row.legacyEndpoint ? { legacyEndpoint: row.legacyEndpoint } : {}),
            })}
          />
        </div>
        <Field
          label="Function"
          style={{ minWidth: 220 }}
          validationState={error ? 'error' : (appId && !loading && fns.length > 0 && usable.length === 0 ? 'warning' : 'none')}
          validationMessage={
            error
              || (appId && !loading && fns.length > 0 && usable.length === 0
                ? 'No function in this app can receive alerts (needs an enabled HTTP trigger with function or anonymous auth).'
                : undefined)
          }
          hint={!appId ? 'Pick a Function App first.' : loading ? 'Reading the functions in this app…' : (!error && fns.length === 0 ? 'This Function App reports no functions.' : undefined)}
        >
          <Dropdown
            data-testid="hc-function-name"
            value={row.functionName || ''}
            selectedOptions={row.functionName ? [row.functionName] : []}
            disabled={!appId || loading}
            placeholder={appId ? 'Select a function' : ''}
            onOptionSelect={(_, d) => onChange({ ...row, functionName: d.optionValue || '' })}
          >
            {fns.map((f) => (
              <Option key={f.name} value={f.name} text={f.name} disabled={!f.usable}>
                {f.usable ? `${f.name} · ${f.authLevel}` : `${f.name} — ${f.reason}`}
              </Option>
            ))}
          </Dropdown>
        </Field>
        {loading && <Spinner size="tiny" />}
        <Switch checked={row.useCommonAlertSchema !== false} label="Common Alert Schema" onChange={(_, d) => onChange({ ...row, useCommonAlertSchema: d.checked })} />
        <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={onRemove}>Remove</Button>
      </div>
      {selected?.usable && (
        <Caption1>HTTP trigger · {selected.authLevel === 'anonymous' ? 'anonymous (no key needed)' : 'function key resolved from ARM at save'}</Caption1>
      )}
    </div>
  );
}

// ───────────────────────────── Logic App ─────────────────────────────

interface TriggerInfo { name: string; type: string; kind?: string; callbackCapable: boolean }
interface TriggerReport {
  workflowName: string;
  triggers: TriggerInfo[];
  triggerName?: string;
  chosenBy?: 'explicit' | 'only' | 'designer-default' | 'first-by-name';
  problem?: string;
}

const CHOSEN_BY_TEXT: Record<NonNullable<TriggerReport['chosenBy']>, string> = {
  explicit: 'chosen by you',
  only: 'its only HTTP-request trigger',
  'designer-default': 'the designer default among several — change it below',
  'first-by-name': 'first by name among several — change it below',
};

export function LogicAppReceiverRowEditor({
  row, onChange, onRemove,
}: {
  row: LogicAppReceiverRow;
  onChange: (next: LogicAppReceiverRow) => void;
  onRemove: () => void;
}) {
  const wfId = row.resourceId || '';
  const [report, setReport] = useState<TriggerReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!wfId) { setReport(null); setError(null); return; }
    let cancelled = false;
    setLoading(true); setError(null);
    void (async () => {
      try {
        const q = `workflowResourceId=${encodeURIComponent(wfId)}${row.triggerName ? `&triggerName=${encodeURIComponent(row.triggerName)}` : ''}`;
        const r = await clientFetch(`/api/monitor/logic-app-triggers?${q}`);
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!j?.ok) { setReport(null); setError(gateText(j, r.status)); return; }
        setReport(j as TriggerReport);
      } catch (e: any) {
        if (!cancelled) { setReport(null); setError(e?.message || String(e)); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [wfId, row.triggerName]);

  const requestTriggers = (report?.triggers || []).filter((t) => t.callbackCapable);

  // A trigger the user picked earlier that the workflow no longer has (renamed
  // or deleted out-of-band): drop the stale pick so the row re-resolves to a
  // request trigger that exists — the binding repairs itself, visibly, via the
  // caption below (`auto-bind-by-default.md` §3).
  const stalePick = !!row.triggerName && !!report?.problem && requestTriggers.length > 0;
  useEffect(() => {
    if (stalePick) onChange({ ...row, triggerName: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stalePick]);

  return (
    <div style={stackStyle} data-testid="hc-logic-app-receiver">
      <div style={rowStyle}>
        <div style={{ flex: 1, minWidth: 320 }}>
          {/* #3541 — the resource id is DISCOVERED (Resource Graph over
              Microsoft.Logic/workflows), never hand-typed. Same picker and
              same `logic-app` kind the activator action uses, so the two
              surfaces cannot store differently shaped values. */}
          <AzureBackedField
            kind="logic-app"
            value={wfId}
            label="Logic App"
            surface="Health check notification"
            onChange={(v) => onChange({
              ...(row.name ? { name: row.name } : {}),
              resourceId: v || '',
              useCommonAlertSchema: row.useCommonAlertSchema,
            })}
          />
        </div>
        {requestTriggers.length > 1 && (
          <Field label="HTTP-request trigger" style={{ minWidth: 220 }}>
            <Dropdown
              data-testid="hc-logic-app-trigger"
              value={report?.triggerName || ''}
              selectedOptions={report?.triggerName ? [report.triggerName] : []}
              onOptionSelect={(_, d) => onChange({ ...row, triggerName: d.optionValue || undefined })}
            >
              {requestTriggers.map((t) => <Option key={t.name} value={t.name} text={t.name}>{t.name}</Option>)}
            </Dropdown>
          </Field>
        )}
        {loading && <Spinner size="tiny" />}
        <Switch checked={row.useCommonAlertSchema !== false} label="Common Alert Schema" onChange={(_, d) => onChange({ ...row, useCommonAlertSchema: d.checked })} />
        <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={onRemove}>Remove</Button>
      </div>
      {error && (
        <MessageBar intent="warning" data-testid="hc-logic-app-trigger-error"><MessageBarBody>{error}</MessageBarBody></MessageBar>
      )}
      {report?.problem && (
        <MessageBar intent="warning" data-testid="hc-logic-app-trigger-problem">
          <MessageBarBody><MessageBarTitle>This Logic App cannot be notified</MessageBarTitle>{report.problem}</MessageBarBody>
        </MessageBar>
      )}
      {report?.triggerName && report.chosenBy && (
        <Caption1 data-testid="hc-logic-app-trigger-resolved">
          Trigger <code>{report.triggerName}</code> — {CHOSEN_BY_TEXT[report.chosenBy]}. Its callback URL is resolved via ARM listCallbackUrl at save.
        </Caption1>
      )}
    </div>
  );
}
