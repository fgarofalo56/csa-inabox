'use client';

/**
 * PowerAutomateDesignerTab — the in-product "Designer" authoring tab for a
 * modern cloud flow.
 *
 * In-product authoring (no deep link): the flow's Logic Apps workflow definition
 * and its connection references are authored here against the real Dataverse Web
 * API (workflow rows; see powerplatform-client getFlowDefinition /
 * updateFlowDefinition / createFlow / setFlowStateViaDataverse). The operator
 * edits the structured definition, manages connection references in a grid, and
 * turns the flow on/off — all without leaving Loom.
 *
 * The VISUAL drag-drop designer specifically cannot be embedded: Microsoft Learn
 * (power-automate/developer/embed-flow-dev) confirms the only embedding path is
 * the Flow widget JS SDK (msflowsdk-1.1.js), whose GET_ACCESS_TOKEN event needs a
 * delegated user JWT (audience https://service.flow.microsoft.com). Loom auths
 * with a UAMI service principal server-side, which is not a valid delegated user
 * credential for the widget. So the visual canvas stays an honest "open visual
 * designer" secondary action — but the definition itself is authored in-product.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Body1, Button, Caption1, Field, Input, Spinner, Switch, Textarea,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Toolbar, ToolbarButton, ToolbarDivider,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Save20Regular, Play20Regular, Stop20Regular, Open16Regular } from '@fluentui/react-icons';
import { openMaker } from './maker-studio';

const useStyles = makeStyles({
  wrap: { display: 'flex', flexDirection: 'column', gap: '12px' },
  metaGrid: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', alignItems: 'baseline' },
  metaKey: { color: tokens.colorNeutralForeground3, fontSize: '12px' },
  cmdBar: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px' },
  editor: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '12px', minHeight: '320px',
  },
  tableWrap: { overflow: 'auto', maxHeight: '240px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '4px' },
  cell: { fontSize: '12px', whiteSpace: 'nowrap', maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis' },
  connRow: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: '8px', alignItems: 'end' },
});

export interface DesignerFlowMeta {
  name: string;
  displayName: string;
  state?: string;
  triggerType?: string;
  createdTime?: string;
  lastModifiedTime?: string;
}

interface FlowDefinition {
  definition: Record<string, any>;
  connectionReferences?: Record<string, { connectionName?: string; id?: string; source?: string }>;
}

interface FlowAuthoringDoc {
  workflowid: string;
  name: string;
  statecode?: number;
  statuscode?: number;
  clientdata?: FlowDefinition | null;
  clientdataRaw?: string;
}

export interface PowerAutomateDesignerTabProps {
  envId?: string | null;
  flowId?: string | null;
  flow?: DesignerFlowMeta | null;
}

/** make.powerautomate.com flow designer URL for a flow in an environment. */
export function flowDesignerHref(envId: string, flowId: string): string {
  return `https://make.powerautomate.com/environments/${encodeURIComponent(envId)}/flows/${encodeURIComponent(flowId)}/details`;
}

type ConnRefRow = { key: string; connectionName: string; id: string; source: string };

export function PowerAutomateDesignerTab({ envId, flowId, flow }: PowerAutomateDesignerTabProps) {
  const s = useStyles();

  const [loading, setLoading] = useState(false);
  const [doc, setDoc] = useState<FlowAuthoringDoc | null>(null);
  const [defText, setDefText] = useState('');
  const [name, setName] = useState('');
  const [conns, setConns] = useState<ConnRefRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);

  const apiBase = (flowId && envId)
    ? `/api/items/power-automate-flow/${encodeURIComponent(flowId)}/definition?envId=${encodeURIComponent(envId)}`
    : null;

  const load = useCallback(async () => {
    if (!apiBase) return;
    setLoading(true); setMsg(null);
    try {
      const r = await fetch(apiBase);
      const j = await r.json().catch(() => null);
      if (!j?.ok) {
        setMsg({ kind: 'error', text: `${j?.error || `HTTP ${r.status}`}${j?.hint ? ` — ${j.hint}` : ''}` });
        setDoc(null); return;
      }
      const d: FlowAuthoringDoc = j.flow;
      setDoc(d);
      setName(d.name || '');
      setDefText(d.clientdata?.definition ? JSON.stringify(d.clientdata.definition, null, 2) : '');
      const refs = d.clientdata?.connectionReferences || {};
      setConns(Object.entries(refs).map(([key, v]) => ({
        key, connectionName: v.connectionName || '', id: v.id || '', source: v.source || 'Embedded',
      })));
    } catch (e: any) {
      setMsg({ kind: 'error', text: e?.message || String(e) }); setDoc(null);
    } finally { setLoading(false); }
  }, [apiBase]);

  useEffect(() => { void load(); }, [load]);

  const connReferences = useMemo(() => {
    const out: Record<string, { connectionName?: string; id?: string; source?: string }> = {};
    for (const c of conns) {
      if (!c.key.trim()) continue;
      out[c.key.trim()] = {
        connectionName: c.connectionName.trim() || undefined,
        id: c.id.trim() || undefined,
        source: c.source.trim() || undefined,
      };
    }
    return out;
  }, [conns]);

  const save = useCallback(async () => {
    if (!apiBase) return;
    let definition: Record<string, any>;
    try { definition = JSON.parse(defText); }
    catch (e: any) { setMsg({ kind: 'error', text: `Definition is not valid JSON: ${e?.message || String(e)}` }); return; }
    setBusy(true); setMsg({ kind: 'info', text: 'Saving definition…' });
    try {
      const r = await fetch(apiBase, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim() || undefined, definition: { definition, connectionReferences: connReferences } }),
      });
      const j = await r.json().catch(() => null);
      if (!j?.ok) { setMsg({ kind: 'error', text: `Save failed: ${j?.error || r.status}${j?.hint ? ` — ${j.hint}` : ''}` }); return; }
      setMsg({ kind: 'success', text: 'Flow definition saved.' });
      void load();
    } catch (e: any) {
      setMsg({ kind: 'error', text: `Save failed: ${e?.message || String(e)}` });
    } finally { setBusy(false); }
  }, [apiBase, defText, name, connReferences, load]);

  const setState = useCallback(async (on: boolean) => {
    if (!apiBase) return;
    setBusy(true); setMsg({ kind: 'info', text: on ? 'Turning flow on…' : 'Turning flow off…' });
    try {
      const r = await fetch(apiBase, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: on ? 'on' : 'off' }),
      });
      const j = await r.json().catch(() => null);
      if (!j?.ok) { setMsg({ kind: 'error', text: `${on ? 'Turn on' : 'Turn off'} failed: ${j?.error || r.status}${j?.hint ? ` — ${j.hint}` : ''}` }); return; }
      setMsg({ kind: 'success', text: on ? 'Flow turned on.' : 'Flow turned off.' });
      void load();
    } catch (e: any) {
      setMsg({ kind: 'error', text: `Failed: ${e?.message || String(e)}` });
    } finally { setBusy(false); }
  }, [apiBase, load]);

  if (!flowId || !envId) {
    return (
      <div className={s.wrap}>
        <Caption1>Select a cloud flow to open its designer.</Caption1>
      </div>
    );
  }

  const isOn = doc?.statecode === 1 || flow?.state === 'Started';

  return (
    <div className={s.wrap} data-testid="pa-designer">
      {/* In-product authoring command bar — all wired to the real Dataverse write BFF. */}
      <Toolbar aria-label="Flow authoring" className={s.cmdBar}>
        <ToolbarButton icon={<Save20Regular />} disabled={busy || loading} onClick={() => { void save(); }}>
          Save definition
        </ToolbarButton>
        <ToolbarButton icon={<Play20Regular />} disabled={busy || loading || isOn} onClick={() => { void setState(true); }}>
          Turn on
        </ToolbarButton>
        <ToolbarButton icon={<Stop20Regular />} disabled={busy || loading || !isOn} onClick={() => { void setState(false); }}>
          Turn off
        </ToolbarButton>
        <ToolbarDivider />
        <ToolbarButton icon={<Open16Regular />} onClick={() => openMaker(flowDesignerHref(envId, flowId))}>
          Open visual designer
        </ToolbarButton>
      </Toolbar>

      {(busy || loading) && <Spinner size="tiny" label={loading ? 'Loading definition…' : 'Working…'} labelPosition="after" />}
      {msg && (
        <MessageBar intent={msg.kind === 'info' ? 'info' : msg.kind}>
          <MessageBarBody>{msg.text}</MessageBarBody>
        </MessageBar>
      )}

      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Authoring the flow definition in-product</MessageBarTitle>
          Edit the Logic Apps workflow definition (triggers + actions) and connection references below — these
          write back through the Dataverse Web API (<code>workflow</code> rows). The <strong>visual drag-drop
          canvas</strong> needs a delegated user token and can&apos;t be embedded server-side, so
          <strong> Open visual designer</strong> launches it in a new tab. Triggering runs and reviewing history
          remain on the <strong>Runs</strong> view.
        </MessageBarBody>
      </MessageBar>

      <Field label="Flow name">
        <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="Flow display name" />
      </Field>

      {flow && (
        <div className={s.metaGrid}>
          <span className={s.metaKey}>Flow id</span><span><code>{flow.name}</code></span>
          <span className={s.metaKey}>State</span>
          <span>
            <Badge appearance="tint" color={isOn ? 'success' : 'subtle'}>
              {isOn ? 'On' : (flow.state || 'Draft')}
            </Badge>
          </span>
          <span className={s.metaKey}>Trigger</span><span>{flow.triggerType || '—'}</span>
          <span className={s.metaKey}>Modified</span><span>{flow.lastModifiedTime || '—'}</span>
        </div>
      )}

      <Field
        label="Workflow definition (Logic Apps JSON)"
        hint="The triggers/actions definition the flow runs. Validated against the Logic Apps workflowdefinition.json schema on save."
      >
        <Textarea
          className={s.editor}
          value={defText}
          onChange={(_, d) => setDefText(d.value)}
          resize="vertical"
          placeholder='{ "$schema": "...workflowdefinition.json#", "triggers": { ... }, "actions": { ... } }'
        />
      </Field>

      <Body1><strong>Connection references</strong></Body1>
      <Caption1>
        Map each reference key the definition uses to a connector. Add/remove rows below; they save with the definition.
      </Caption1>
      {conns.length > 0 && (
        <div className={s.tableWrap}>
          <Table aria-label="Connection references" size="small">
            <TableHeader><TableRow>
              <TableHeaderCell>Reference key</TableHeaderCell>
              <TableHeaderCell>Connection name</TableHeaderCell>
              <TableHeaderCell>Connector id</TableHeaderCell>
              <TableHeaderCell>Source</TableHeaderCell>
              <TableHeaderCell>—</TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>
              {conns.map((c, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <Input size="small" value={c.key} onChange={(_, d) => setConns((p) => p.map((x, j) => j === i ? { ...x, key: d.value } : x))} placeholder="shared_sharepointonline" />
                  </TableCell>
                  <TableCell>
                    <Input size="small" value={c.connectionName} onChange={(_, d) => setConns((p) => p.map((x, j) => j === i ? { ...x, connectionName: d.value } : x))} placeholder="connection logical name" />
                  </TableCell>
                  <TableCell>
                    <Input size="small" value={c.id} onChange={(_, d) => setConns((p) => p.map((x, j) => j === i ? { ...x, id: d.value } : x))} placeholder="/providers/.../apis/shared_..." />
                  </TableCell>
                  <TableCell>
                    <Input size="small" value={c.source} onChange={(_, d) => setConns((p) => p.map((x, j) => j === i ? { ...x, source: d.value } : x))} placeholder="Embedded" />
                  </TableCell>
                  <TableCell>
                    <Button size="small" appearance="subtle" onClick={() => setConns((p) => p.filter((_, j) => j !== i))}>Remove</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <div>
        <Button appearance="secondary" size="small" onClick={() => setConns((p) => [...p, { key: '', connectionName: '', id: '', source: 'Embedded' }])}>
          Add connection reference
        </Button>
      </div>

      {doc && !doc.clientdata && doc.clientdataRaw && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>This flow&apos;s stored definition could not be parsed as a modern-flow definition</MessageBarTitle>
            It may be a legacy classic workflow or use an unrecognized clientdata shape. Editing here would
            overwrite it — proceed only if you intend to replace it with a modern cloud-flow definition.
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}

/**
 * NewFlowAuthor — in-product creation of a brand-new modern cloud flow.
 * Seeds a valid manual-trigger definition skeleton and POSTs it to the create
 * BFF (real Dataverse workflow row, Draft state).
 */
export function NewFlowAuthor({
  envId, onCreated,
}: { envId?: string | null; onCreated?: (workflowId: string) => void }) {
  const s = useStyles();
  const [name, setName] = useState('');
  const [withManualTrigger, setWithManualTrigger] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const create = useCallback(async () => {
    if (!envId) return;
    if (!name.trim()) { setMsg({ kind: 'error', text: 'Flow name is required.' }); return; }
    setBusy(true); setMsg(null);
    const definition = {
      definition: {
        $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
        contentVersion: '1.0.0.0',
        parameters: {
          $connections: { defaultValue: {}, type: 'Object' },
          $authentication: { defaultValue: {}, type: 'SecureObject' },
        },
        triggers: withManualTrigger
          ? { manual: { type: 'Request', kind: 'Button', inputs: { schema: {} } } }
          : { Recurrence: { type: 'Recurrence', recurrence: { frequency: 'Day', interval: 1 } } },
        actions: {},
      },
      connectionReferences: {},
    };
    try {
      const r = await fetch(`/api/items/power-automate-flow/new/definition?envId=${encodeURIComponent(envId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), definition }),
      });
      const j = await r.json().catch(() => null);
      if (!j?.ok) { setMsg({ kind: 'error', text: `Create failed: ${j?.error || r.status}${j?.hint ? ` — ${j.hint}` : ''}` }); return; }
      setMsg({ kind: 'success', text: `Flow "${name.trim()}" created (Draft).` });
      if (j.workflowId && onCreated) onCreated(j.workflowId);
      setName('');
    } catch (e: any) {
      setMsg({ kind: 'error', text: `Create failed: ${e?.message || String(e)}` });
    } finally { setBusy(false); }
  }, [envId, name, withManualTrigger, onCreated]);

  return (
    <div className={s.wrap}>
      <Field label="New flow name" required>
        <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="e.g. Notify on new item" />
      </Field>
      <Switch
        checked={withManualTrigger}
        onChange={(_, d) => setWithManualTrigger(d.checked)}
        label={withManualTrigger ? 'Manual (button) trigger' : 'Scheduled (daily) trigger'}
      />
      <div>
        <Button appearance="primary" disabled={busy || !name.trim() || !envId} onClick={() => { void create(); }}>
          {busy ? 'Creating…' : 'Create flow'}
        </Button>
      </div>
      {msg && (
        <MessageBar intent={msg.kind}>
          <MessageBarBody>{msg.text}</MessageBarBody>
        </MessageBar>
      )}
      <Caption1>
        Creates a real modern cloud flow (Dataverse <code>workflow</code> row, Draft state) with a seeded
        definition you then edit on the Designer tab. Turn it on when ready.
      </Caption1>
    </div>
  );
}
