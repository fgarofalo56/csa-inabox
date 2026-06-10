'use client';

/**
 * CosmosScriptEditor — the Azure Cosmos DB Data Explorer **script authoring**
 * surface for stored procedures, triggers, and user-defined functions, parity
 * with the portal's New/Edit Stored Procedure / Trigger / UDF tabs.
 *
 * Workflow mirrored from the portal Data Explorer:
 *   - the tree opens this tab for a New script (blank id + JS template) or an
 *     existing one (id locked, body loaded from ARM)
 *   - a Monaco JavaScript editor holds the script body
 *   - triggers add two dropdowns (Trigger type Pre/Post + Operation
 *     All/Create/Delete/Replace/Update) above the editor, exactly like the
 *     portal's trigger form
 *   - Save (PUT) creates or replaces the script on the real ARM control plane;
 *     Delete removes it; for stored procedures an Execute action runs the sproc
 *     on the real data plane and shows the result + RU charge inline
 *
 * Every control calls a real backend (ARM authoring via /api/cosmos/scripts,
 * data-plane execute via /api/cosmos/scripts/execute) — no mocks. When the env
 * isn't wired the routes 503 (not_configured) and when the UAMI lacks the
 * Cosmos data-plane role the execute route 403s (dataplane_rbac); both surface
 * as honest Fluent MessageBars while the full surface still renders (per
 * no-vaporware.md + ui-parity.md).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Caption1, Badge, Spinner, Tooltip, Divider, Field, Input, Dropdown, Option,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Save16Regular, Delete16Regular, Play16Regular } from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import type { CosmosAction } from '@/lib/components/cosmos/cosmos-tree';

const SCRIPTS_ROUTE = '/api/cosmos/scripts';
const EXECUTE_ROUTE = '/api/cosmos/scripts/execute';

type TriggerType = 'Pre' | 'Post';
type TriggerOperation = 'All' | 'Create' | 'Delete' | 'Replace' | 'Update';
type ScriptKind = 'storedProcedure' | 'trigger' | 'udf';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '10px', height: '100%', minHeight: '0' },
  toolbar: { display: 'flex', alignItems: 'flex-end', gap: '8px', flexWrap: 'wrap' },
  spacer: { flex: '1' },
  editorWrap: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column', gap: '6px' },
  muted: { color: tokens.colorNeutralForeground3 },
  resultPre: {
    margin: '0', padding: '8px', maxHeight: '220px', overflow: 'auto',
    backgroundColor: tokens.colorNeutralBackground3,
    fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200,
    borderRadius: '4px', whiteSpace: 'pre', color: tokens.colorNeutralForeground1,
  },
  execRow: { display: 'flex', alignItems: 'flex-end', gap: '8px', flexWrap: 'wrap' },
});

const SPROC_TEMPLATE =
  'function storedProcedure(args) {\n' +
  '  var context = getContext();\n' +
  '  var response = context.getResponse();\n' +
  '  response.setBody("Hello, World");\n' +
  '}\n';
const TRIGGER_TEMPLATE =
  'function trigger() {\n' +
  '  var context = getContext();\n' +
  '  var request = context.getRequest();\n' +
  '  // inspect/modify request.getBody() here\n' +
  '}\n';
const UDF_TEMPLATE =
  'function userDefinedFunction(input) {\n' +
  '  return input;\n' +
  '}\n';

function kindOf(action: CosmosAction): ScriptKind {
  if (action === 'storedProcedure' || action === 'newStoredProcedure') return 'storedProcedure';
  if (action === 'udf' || action === 'newUdf') return 'udf';
  return 'trigger';
}

function nounOf(kind: ScriptKind): string {
  return kind === 'storedProcedure' ? 'stored procedure'
    : kind === 'udf' ? 'user-defined function' : 'trigger';
}

function templateOf(kind: ScriptKind): string {
  return kind === 'storedProcedure' ? SPROC_TEMPLATE
    : kind === 'udf' ? UDF_TEMPLATE : TRIGGER_TEMPLATE;
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

export interface CosmosScriptEditorProps {
  kind: CosmosAction;
  db?: string;
  container?: string;
  /** Set when editing an existing script (name === id); unset for New. */
  scriptName?: string;
  /** Partition-key path of the container (e.g. "/tenantId"), for sproc execute. */
  partitionKey?: string;
  /** Called after a successful Save/Delete so the host can refresh + close. */
  onSaved?: () => void;
}

export function CosmosScriptEditor({ kind: action, db, container, scriptName, partitionKey, onSaved }: CosmosScriptEditorProps) {
  const s = useStyles();
  const kind = kindOf(action);
  const noun = nounOf(kind);
  const isExisting = !!scriptName;

  const [id, setId] = useState(scriptName || '');
  const [bodyText, setBodyText] = useState(templateOf(kind));
  const [triggerType, setTriggerType] = useState<TriggerType>('Pre');
  const [triggerOperation, setTriggerOperation] = useState<TriggerOperation>('All');

  const [loading, setLoading] = useState(isExisting);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [rbacGate, setRbacGate] = useState<{ role: string; hint: string } | null>(null);
  const [configGate, setConfigGate] = useState<{ missing: string; hint?: string } | null>(null);

  // --- stored-proc execute panel ---
  const [execPk, setExecPk] = useState('');
  const [execParams, setExecParams] = useState('[]');
  const [execResult, setExecResult] = useState<{ result: unknown; requestCharge: number } | null>(null);
  const [execError, setExecError] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);

  function applyGates(b: any): boolean {
    if (b?.code === 'not_configured' && b?.missing) {
      setConfigGate({ missing: b.missing, hint: b.hint });
      return true;
    }
    if (b?.code === 'dataplane_rbac') {
      setRbacGate({ role: b.role || 'Cosmos DB Built-in Data Contributor', hint: b.hint || b.error });
      return true;
    }
    return false;
  }

  // Load the existing script body (and trigger metadata) from ARM.
  useEffect(() => {
    let cancelled = false;
    if (!isExisting || !db || !container || !scriptName) { setLoading(false); return; }
    (async () => {
      setLoading(true); setError(null);
      try {
        const url = `${SCRIPTS_ROUTE}?db=${encodeURIComponent(db)}&container=${encodeURIComponent(container)}`
          + `&kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(scriptName)}`;
        const r = await fetch(url).then(readJson);
        if (cancelled) return;
        if (applyGates(r)) { setLoading(false); return; }
        if (!r.ok) { setError(r.error || `failed to load ${noun}`); setLoading(false); return; }
        const sc = r.script || {};
        setId(sc.name || sc.id || scriptName);
        setBodyText(sc.body || templateOf(kind));
        if (kind === 'trigger') {
          if (sc.triggerType === 'Post' || sc.triggerType === 'Pre') setTriggerType(sc.triggerType);
          if (['All', 'Create', 'Delete', 'Replace', 'Update'].includes(sc.triggerOperation)) {
            setTriggerOperation(sc.triggerOperation);
          }
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isExisting, db, container, scriptName, kind, noun]);

  const save = useCallback(async () => {
    const trimmedId = id.trim();
    if (!db || !container) { setError('No container is selected for this script.'); return; }
    if (!trimmedId) { setError(`A ${noun} id is required.`); return; }
    setBusy(true); setError(null); setSuccess(null); setRbacGate(null); setConfigGate(null);
    try {
      const r = await fetch(SCRIPTS_ROUTE, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          db, container, kind, id: trimmedId, body: bodyText,
          ...(kind === 'trigger' ? { triggerType, triggerOperation } : {}),
        }),
      }).then(readJson);
      if (applyGates(r)) { setBusy(false); return; }
      if (!r.ok) { setError(r.error || 'save failed'); setBusy(false); return; }
      setSuccess(`Saved ${noun} "${trimmedId}" to ${db}/${container}.`);
      onSaved?.();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [id, db, container, kind, bodyText, triggerType, triggerOperation, noun, onSaved]);

  const remove = useCallback(async () => {
    if (!db || !container || !scriptName) return;
    setBusy(true); setError(null); setSuccess(null);
    try {
      const url = `${SCRIPTS_ROUTE}?db=${encodeURIComponent(db)}&container=${encodeURIComponent(container)}`
        + `&kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(scriptName)}`;
      const r = await fetch(url, { method: 'DELETE' }).then(readJson);
      if (applyGates(r)) { setBusy(false); return; }
      if (!r.ok) { setError(r.error || 'delete failed'); setBusy(false); return; }
      onSaved?.();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [db, container, scriptName, kind, onSaved]);

  const execute = useCallback(async () => {
    if (!db || !container) { setExecError('No container selected.'); return; }
    const sprocName = (scriptName || id).trim();
    if (!sprocName) { setExecError('Save the stored procedure before executing it.'); return; }
    let params: unknown[];
    try {
      const parsed = execParams.trim() ? JSON.parse(execParams) : [];
      if (!Array.isArray(parsed)) throw new Error('params must be a JSON array');
      params = parsed;
    } catch (e: any) {
      setExecError(`Invalid params JSON: ${e?.message || e}`);
      return;
    }
    setExecuting(true); setExecError(null); setExecResult(null); setRbacGate(null); setConfigGate(null);
    try {
      const r = await fetch(EXECUTE_ROUTE, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          db, container, sprocName, params,
          partitionKey: execPk.trim() === '' ? null : execPk,
        }),
      }).then(readJson);
      if (applyGates(r)) { setExecuting(false); return; }
      if (!r.ok) { setExecError(r.error || 'execute failed'); setExecuting(false); return; }
      setExecResult({ result: r.result, requestCharge: r.requestCharge || 0 });
    } catch (e: any) {
      setExecError(e?.message || String(e));
    } finally {
      setExecuting(false);
    }
  }, [db, container, scriptName, id, execParams, execPk]);

  const heading = useMemo(
    () => isExisting ? `${scriptName}` : `New ${noun}`,
    [isExisting, scriptName, noun],
  );

  if (!db || !container) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Pick a container first</MessageBarTitle>
          A {noun} lives on a single container. Expand a database in the tree and choose a
          container (then its Stored Procedures / Triggers / User Defined Functions node, or
          use ＋New… while a container is selected).
        </MessageBarBody>
      </MessageBar>
    );
  }

  return (
    <div className={s.root}>
      {configGate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Cosmos DB account not configured</MessageBarTitle>
            Set <code>{configGate.missing}</code> on the Console Container App. {configGate.hint}
          </MessageBarBody>
        </MessageBar>
      )}
      {rbacGate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Cosmos DB data-plane role required</MessageBarTitle>
            Executing a stored procedure runs on the data plane. Grant the{' '}
            <strong>{rbacGate.role}</strong> data-plane role to the Console managed identity via a
            Cosmos DB <code>sqlRoleAssignments</code>{' '}
            (<code>Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments</code>) at the account
            scope. {rbacGate.hint}
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={s.toolbar}>
        <Field label={`${noun.charAt(0).toUpperCase()}${noun.slice(1)} id`} required style={{ minWidth: 220 }}>
          <Input
            value={id}
            onChange={(_, d) => setId(d.value)}
            placeholder={kind === 'storedProcedure' ? 'mySproc' : kind === 'udf' ? 'myUdf' : 'myTrigger'}
            disabled={isExisting || busy}
          />
        </Field>

        {kind === 'trigger' && (
          <>
            <Field label="Trigger type" style={{ minWidth: 130 }}>
              <Dropdown
                value={triggerType}
                selectedOptions={[triggerType]}
                onOptionSelect={(_, d) => setTriggerType((d.optionValue as TriggerType) || 'Pre')}
                disabled={busy}
              >
                <Option value="Pre" text="Pre">Pre</Option>
                <Option value="Post" text="Post">Post</Option>
              </Dropdown>
            </Field>
            <Field label="Operation" style={{ minWidth: 150 }}>
              <Dropdown
                value={triggerOperation}
                selectedOptions={[triggerOperation]}
                onOptionSelect={(_, d) => setTriggerOperation((d.optionValue as TriggerOperation) || 'All')}
                disabled={busy}
              >
                {(['All', 'Create', 'Delete', 'Replace', 'Update'] as TriggerOperation[]).map((o) => (
                  <Option key={o} value={o} text={o}>{o}</Option>
                ))}
              </Dropdown>
            </Field>
          </>
        )}

        <span className={s.spacer} />
        <Tooltip content={`Save ${noun} (real ARM control plane)`} relationship="label">
          <Button appearance="primary" icon={<Save16Regular />} onClick={() => void save()} disabled={busy || loading}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </Tooltip>
        {isExisting && (
          <Tooltip content={`Delete ${noun}`} relationship="label">
            <Button appearance="secondary" icon={<Delete16Regular />} onClick={() => void remove()} disabled={busy}>
              Delete
            </Button>
          </Tooltip>
        )}
        {kind === 'storedProcedure' && (
          <Tooltip content="Execute stored procedure (real Cosmos data plane)" relationship="label">
            <Button appearance="secondary" icon={<Play16Regular />} onClick={() => void execute()} disabled={executing || busy}>
              {executing ? 'Executing…' : 'Execute'}
            </Button>
          </Tooltip>
        )}
      </div>

      {success && (
        <MessageBar intent="success">
          <MessageBarBody><MessageBarTitle>{heading}</MessageBarTitle>{success}</MessageBarBody>
        </MessageBar>
      )}
      {error && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Cannot save</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      )}

      <div className={s.editorWrap}>
        <Caption1 className={s.muted}>
          {noun.charAt(0).toUpperCase()}{noun.slice(1)} body (JavaScript) — container{' '}
          <code>{db}/{container}</code>. {loading ? 'Loading…' : null}
        </Caption1>
        {loading ? (
          <Spinner size="tiny" label={`Loading ${noun}…`} />
        ) : (
          <MonacoTextarea
            value={bodyText}
            onChange={setBodyText}
            language="javascript"
            height={300}
            ariaLabel={`${noun} body`}
          />
        )}
      </div>

      {kind === 'storedProcedure' && (
        <>
          <Divider />
          <Caption1 className={s.muted}>
            Execute — runs the saved stored procedure against one partition. The partition key is
            required for partitioned containers (the container&apos;s pk path is{' '}
            <code>{partitionKey || '/id'}</code>). Params are passed positionally to the function.
          </Caption1>
          <div className={s.execRow}>
            <Field label="Partition key value" style={{ minWidth: 200 }}>
              <Input value={execPk} onChange={(_, d) => setExecPk(d.value)} placeholder="e.g. tenant-123" />
            </Field>
            <Field label="Params (JSON array)" style={{ flex: 1, minWidth: 240 }}>
              <Input value={execParams} onChange={(_, d) => setExecParams(d.value)} placeholder='["arg1", 42]' />
            </Field>
          </div>
          {execError && (
            <MessageBar intent="error">
              <MessageBarBody><MessageBarTitle>Execute failed</MessageBarTitle>{execError}</MessageBarBody>
            </MessageBar>
          )}
          {execResult && (
            <div>
              <Badge size="small" appearance="tint" color="informative">
                {execResult.requestCharge.toFixed(2)} RU
              </Badge>
              <pre className={s.resultPre}>{JSON.stringify(execResult.result, null, 2)}</pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default CosmosScriptEditor;
