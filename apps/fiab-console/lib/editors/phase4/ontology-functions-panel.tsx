'use client';

/**
 * OntologyFunctionsPanel (WS-4.2) — register + version FUNCTIONS-ON-OBJECTS
 * (Palantir Foundry "functions on objects" parity). A registered function is a
 * versioned, callable unit executed on the Loom UDF runtime (Azure Functions /
 * ACA — `LOOM_UDF_FUNCTION_BASE`); it is referenced by a function-kind derived
 * property and by an ontology action's validation function.
 *
 * Real tenant-scoped registry via `/api/ontology-functions` (Cosmos) — no mocks.
 * Wizard-driven (loom-no-freeform-config): typed Dropdown pickers for runtime,
 * purpose, and parameter types. Honest gate surfaces when the runtime env var is
 * unset (registering still works — it points at code you deploy). Fluent v9 +
 * Loom tokens.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Badge, Body1, Caption1, Subtitle2, Field, Input, Textarea, Dropdown, Option, Divider, Spinner,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle, Card, Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add16Regular, Delete16Regular, Code20Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { EmptyState } from '@/lib/components/empty-state';
import { LearnPopover } from '@/lib/components/ui/learn-popover';
import { loomDocUrl } from '@/lib/learn/content';
import {
  type RegisteredFunction, type FunctionRuntime, type FunctionPurpose, type FunctionParamType, type LoomFunctionParam,
  FUNCTION_RUNTIMES, FUNCTION_RUNTIME_LABELS, FUNCTION_PURPOSES, FUNCTION_PURPOSE_LABELS, FUNCTION_PARAM_TYPES,
  normalizeRegisteredFunctions, functionVersions, functionNames as fnNames,
} from '@/lib/foundry/function-registry-model';

const useLocal = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  icon: { color: tokens.colorBrandForeground1, display: 'inline-flex' },
  spacer: { flex: '1 1 auto' },
  card: { padding: tokens.spacingHorizontalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: tokens.spacingHorizontalM, minWidth: 0 },
  paramRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' },
});

interface Draft {
  name: string; version: string; displayName: string; description: string;
  runtime: FunctionRuntime; purpose: FunctionPurpose; functionPath: string;
  baseUrlOverride: string; functionKeySecret: string; returns: string;
  params: LoomFunctionParam[];
}

function blank(): Draft {
  return {
    name: '', version: '1', displayName: '', description: '', runtime: 'udf', purpose: 'general',
    functionPath: '', baseUrlOverride: '', functionKeySecret: '', returns: '', params: [],
  };
}

export function OntologyFunctionsPanel({ onChanged }: { onChanged?: () => void } = {}) {
  const s = useLocal();
  const [functions, setFunctions] = useState<RegisteredFunction[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [d, setD] = useState<Draft>(blank());
  const [formErr, setFormErr] = useState<string | null>(null);
  const patch = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));

  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await clientFetch('/api/ontology-functions');
      const j = await r.json().catch(() => ({}));
      if (j?.ok) setFunctions(normalizeRegisteredFunctions(j.functions));
      else setError(j?.error || `HTTP ${r.status}`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const names = useMemo(() => fnNames(functions), [functions]);

  const openNew = () => { setD(blank()); setFormErr(null); setOpen(true); };
  const openEdit = (fn: RegisteredFunction) => {
    setD({
      name: fn.name, version: fn.version, displayName: fn.displayName || '', description: fn.description || '',
      runtime: fn.runtime, purpose: fn.purpose, functionPath: fn.functionPath || '',
      baseUrlOverride: fn.baseUrlOverride || '', functionKeySecret: fn.functionKeySecret || '',
      returns: fn.returns || '', params: fn.params.map((p) => ({ ...p })),
    });
    setFormErr(null); setOpen(true);
  };

  const save = async () => {
    setFormErr(null); setBusy(true);
    try {
      const body = {
        name: d.name.trim(), version: d.version.trim(),
        displayName: d.displayName.trim() || undefined, description: d.description.trim() || undefined,
        runtime: d.runtime, purpose: d.purpose,
        functionPath: d.functionPath.trim() || undefined,
        baseUrlOverride: d.baseUrlOverride.trim() || undefined,
        functionKeySecret: d.functionKeySecret.trim() || undefined,
        returns: d.returns.trim() || undefined,
        params: d.params.filter((p) => p.name.trim()),
      };
      const r = await clientFetch('/api/ontology-functions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setFormErr(j?.error || `HTTP ${r.status}`); return; }
      setOpen(false);
      await reload();
      onChanged?.();
    } catch (e) { setFormErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const remove = async (fn: RegisteredFunction) => {
    setBusy(true);
    try {
      await clientFetch(`/api/ontology-functions?name=${encodeURIComponent(fn.name)}&version=${encodeURIComponent(fn.version)}`, { method: 'DELETE' });
      await reload();
      onChanged?.();
    } finally { setBusy(false); }
  };

  const addParam = () => patch({ params: [...d.params, { name: '', type: 'string' as FunctionParamType }] });
  const setParam = (i: number, p: Partial<LoomFunctionParam>) => patch({ params: d.params.map((x, idx) => idx === i ? { ...x, ...p } : x) });
  const delParam = (i: number) => patch({ params: d.params.filter((_, idx) => idx !== i) });

  return (
    <div className={s.root}>
      <div className={s.head}>
        <span className={s.icon}><Code20Regular /></span>
        <Subtitle2>Functions on objects</Subtitle2>
        <LearnPopover
          title="Functions on objects"
          content="Register a versioned function that runs on the Loom UDF runtime (Azure Functions / ACA). Reference it from a function-kind derived property or from an ontology action's validation function. Registering points at code you deploy — it does not deploy the code."
          tips={['Versions let you evolve a function safely', 'Validation functions return { valid: boolean, message? }', 'Runs on LOOM_UDF_FUNCTION_BASE — no Fabric']}
          learnMoreHref={loomDocUrl('fiab/parity/ontology-derived-properties')}
        />
        <span className={s.spacer} />
        <Button appearance="primary" icon={<Add16Regular />} onClick={openNew} disabled={busy}>Register function</Button>
      </div>

      <MessageBar intent="info" layout="multiline">
        <MessageBarBody>
          <MessageBarTitle>Runtime</MessageBarTitle>
          Registered functions execute on the Loom UDF runtime (<code>LOOM_UDF_FUNCTION_BASE</code>, deployed by
          modules/admin-plane/udf-runtime.bicep, default on) as <code>POST {'{base}'}/api/&lt;path&gt;</code>. A dedicated
          Azure Function App can override the base per function. Azure-native — no Microsoft Fabric.
        </MessageBarBody>
      </MessageBar>

      {loading ? (
        <div className={s.head}><Spinner size="tiny" /><Caption1>Loading registry…</Caption1></div>
      ) : error ? (
        <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>
      ) : names.length === 0 ? (
        <EmptyState icon={<Code20Regular />} title="No functions registered"
          body="Register a function to compute a custom derived property or validate an action write. It runs on the Loom UDF runtime." />
      ) : (
        names.map((name) => {
          const versions = functionVersions(functions, name);
          const latest = versions[0];
          return (
            <Card key={name} className={s.card}>
              <div className={s.head}>
                <span className={s.icon}><Code20Regular /></span>
                <Body1><strong>{latest.displayName || name}</strong></Body1>
                <Badge appearance="tint" color="brand">{name}</Badge>
                <Badge appearance="outline" color="informative">{FUNCTION_PURPOSE_LABELS[latest.purpose]}</Badge>
                <Badge appearance="outline">{versions.length} version{versions.length === 1 ? '' : 's'}</Badge>
              </div>
              {latest.description && <Caption1>{latest.description}</Caption1>}
              <Table size="small" aria-label={`${name} versions`}>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Version</TableHeaderCell>
                    <TableHeaderCell>Runtime</TableHeaderCell>
                    <TableHeaderCell>Path</TableHeaderCell>
                    <TableHeaderCell>Params</TableHeaderCell>
                    <TableHeaderCell aria-label="actions" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {versions.map((v) => (
                    <TableRow key={v.version}>
                      <TableCell><Badge appearance="tint">{v.version}</Badge></TableCell>
                      <TableCell><Caption1>{FUNCTION_RUNTIME_LABELS[v.runtime]}</Caption1></TableCell>
                      <TableCell><Caption1>/api/{v.functionPath}</Caption1></TableCell>
                      <TableCell><Caption1>{v.params.map((p) => `${p.name}:${p.type}`).join(', ') || '—'}</Caption1></TableCell>
                      <TableCell>
                        <Button size="small" appearance="subtle" onClick={() => openEdit(v)} disabled={busy}>Edit</Button>
                        <Button size="small" appearance="subtle" icon={<Delete16Regular />} onClick={() => void remove(v)} disabled={busy}>Delete</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          );
        })
      )}

      <Dialog open={open} onOpenChange={(_, data) => setOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Register function</DialogTitle>
            <DialogContent>
              <div className={s.form}>
                {formErr && <MessageBar intent="error"><MessageBarBody>{formErr}</MessageBarBody></MessageBar>}
                <div className={s.grid}>
                  <Field label="Name" required><Input value={d.name} onChange={(_, v) => patch({ name: v.value })} placeholder="e.g. validateCreditLimit" /></Field>
                  <Field label="Version" required><Input value={d.version} onChange={(_, v) => patch({ version: v.value })} placeholder="1.0.0" /></Field>
                  <Field label="Display name"><Input value={d.displayName} onChange={(_, v) => patch({ displayName: v.value })} /></Field>
                  <Field label="Purpose" required>
                    <Dropdown value={FUNCTION_PURPOSE_LABELS[d.purpose]} selectedOptions={[d.purpose]}
                      onOptionSelect={(_, o) => patch({ purpose: o.optionValue as FunctionPurpose })}>
                      {FUNCTION_PURPOSES.map((p) => <Option key={p} value={p}>{FUNCTION_PURPOSE_LABELS[p]}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Runtime" required>
                    <Dropdown value={FUNCTION_RUNTIME_LABELS[d.runtime]} selectedOptions={[d.runtime]}
                      onOptionSelect={(_, o) => patch({ runtime: o.optionValue as FunctionRuntime })}>
                      {FUNCTION_RUNTIMES.map((r) => <Option key={r} value={r}>{FUNCTION_RUNTIME_LABELS[r]}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Function path" hint="Runtime path (blank = the name). Invoked as POST {base}/api/<path>.">
                    <Input value={d.functionPath} onChange={(_, v) => patch({ functionPath: v.value })} placeholder={d.name || 'path'} />
                  </Field>
                  {d.runtime === 'azure-function' && (
                    <Field label="Base URL override" hint="https://my-fn.azurewebsites.net">
                      <Input value={d.baseUrlOverride} onChange={(_, v) => patch({ baseUrlOverride: v.value })} />
                    </Field>
                  )}
                  <Field label="Function key secret" hint="Key Vault secret name (if the function is keyed).">
                    <Input value={d.functionKeySecret} onChange={(_, v) => patch({ functionKeySecret: v.value })} />
                  </Field>
                </div>
                <Field label="Description"><Textarea value={d.description} onChange={(_, v) => patch({ description: v.value })} rows={2} /></Field>
                <Divider />
                <div className={s.head}>
                  <Caption1>Parameters</Caption1>
                  <Button size="small" appearance="subtle" icon={<Add16Regular />} onClick={addParam}>Add parameter</Button>
                </div>
                {d.params.map((p, i) => (
                  <div key={i} className={s.paramRow}>
                    <Field label="Name"><Input value={p.name} onChange={(_, v) => setParam(i, { name: v.value })} /></Field>
                    <Field label="Type">
                      <Dropdown value={p.type} selectedOptions={[p.type]} onOptionSelect={(_, o) => setParam(i, { type: o.optionValue as FunctionParamType })}>
                        {FUNCTION_PARAM_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
                      </Dropdown>
                    </Field>
                    <Button size="small" appearance="subtle" icon={<Delete16Regular />} onClick={() => delParam(i)}>Remove</Button>
                  </div>
                ))}
                <Field label="Returns" hint="What the function returns (a value for derived props; { valid, message } for validation).">
                  <Input value={d.returns} onChange={(_, v) => patch({ returns: v.value })} />
                </Field>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOpen(false)}>Cancel</Button>
              <Button appearance="primary" onClick={() => void save()} disabled={busy}>Register</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
