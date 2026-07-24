'use client';

/**
 * DataContractOdcsPanel — N6: the ODCS 3.1 + ENFORCEMENT half of the
 * `data-contract` editor.
 *
 * Three cards, all real-backend:
 *
 *  1. **ODCS 3.1 registry** — Register (PUT /odcs: converts the typed designer
 *     state to ODCS 3.1, validates it, upserts the Cosmos registry doc), Export
 *     (downloads the registered document as `.odcs.json`), and Import (POST
 *     /odcs with a chosen `.json` file — the response's per-field
 *     `{path, message}` errors are rendered verbatim, so an invalid document is
 *     NEVER silently accepted). No free-typed JSON surface: import is a file
 *     picker, everything else is a typed control (loom_no_freeform_config).
 *  2. **Enforcement** — the posture dropdown. `warn-quarantine` is the DEFAULT
 *     and is labelled as such: violating rows go to the Bronze `_rejected`
 *     dead-letter path + alert, the rest still lands. `hard-reject` is the
 *     explicit opt-in that blocks the whole batch.
 *  3. **Ingestion bindings** — which mirrored databases / pipelines /
 *     eventstreams this contract governs, all picked from dropdowns of the
 *     caller's REAL items (/api/items/by-type), never typed by hand.
 *
 * Web-3.0: Fluent v9 + Loom tokens only, elevated cards, wrapped badge rows.
 * Azure-native, no Microsoft Fabric. **IL5**: every call is in-boundary.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge, Button, Caption1, Card, CardHeader, Dropdown, Field, Option, Spinner,
  Subtitle2, Switch, Text, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowDownload20Regular, ArrowUpload20Regular, CheckmarkCircle20Regular,
  Delete20Regular, Link20Regular, ShieldCheckmark20Regular, ArrowSync20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';

export interface OdcsFieldErrorView { path: string; message: string }

interface BindingView {
  id: string; kind: string; targetItemId: string; targetItemName?: string | null;
  dataset: string; enabled: boolean;
}
interface EnforcementView { enabled: boolean; mode: string }
interface RunView {
  id: string; at: string; source: string; dataset: string; decision: string;
  evaluated: number; accepted: number; rejected: number; deadLetterPath?: string;
}
interface TrendView {
  runs: number; clean: number; quarantined: number; rejected: number;
  rowsEvaluated: number; rowsRejected: number; passRate: number | null;
}
interface OdcsPayload {
  registered: boolean;
  odcs: Record<string, unknown>;
  enforcement: EnforcementView;
  bindings: BindingView[];
  runs: RunView[];
  trend: TrendView;
  enforcementModes: string[];
  bindingKinds: string[];
}

interface TargetItem { id: string; displayName: string; itemType: string; state?: Record<string, unknown> }

const MODE_HELP: Record<string, string> = {
  'warn-quarantine':
    'DEFAULT. Conforming rows land; violating rows are written to the Bronze _rejected dead-letter path and an alert fires. The load is never dropped.',
  'hard-reject':
    'OPT-IN. A single error-severity violation blocks the WHOLE batch — nothing lands and everything goes to the dead-letter path. Enable once the contract is proven.',
};

const KIND_LABEL: Record<string, string> = {
  'mirrored-database': 'Mirrored database (mirroring engine)',
  'data-pipeline': 'Data pipeline (sink)',
  eventstream: 'Eventstream',
};

const useStyles = makeStyles({
  card: {
    padding: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  row: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', minWidth: 0 },
  badges: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, alignItems: 'center', minWidth: 0 },
  hint: { color: tokens.colorNeutralForeground3 },
  errorList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, margin: 0, paddingLeft: tokens.spacingHorizontalL },
  bindingRow: {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    minWidth: 0,
  },
  grow: { flex: 1, minWidth: 0 },
  hiddenInput: { display: 'none' },
});

/** Datasets discoverable from a target item's persisted state (dropdown-only). */
function datasetsFor(item: TargetItem | undefined): string[] {
  if (!item) return [];
  const state = (item.state || {}) as Record<string, unknown>;
  const out = new Set<string>();
  const tables = (state.tablesStatus ?? state.mirrorTablesStatus) as Array<{ schema?: string; table?: string }> | undefined;
  for (const t of Array.isArray(tables) ? tables : []) {
    if (t?.schema && t?.table) out.add(`${t.schema}.${t.table}`);
  }
  const sources = state.sources as Array<{ provisionedEndpoint?: { entityPath?: string } }> | undefined;
  for (const src of Array.isArray(sources) ? sources : []) {
    const hub = src?.provisionedEndpoint?.entityPath;
    if (hub) out.add(String(hub));
  }
  return Array.from(out).sort();
}

export function DataContractOdcsPanel({ id, workspaceId, reloadKey = 0 }: { id: string; workspaceId?: string; reloadKey?: number }) {
  const s = useStyles();
  const [data, setData] = useState<OdcsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<OdcsFieldErrorView[]>([]);
  const [ok, setOk] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [targets, setTargets] = useState<TargetItem[]>([]);
  const [bindKind, setBindKind] = useState('mirrored-database');
  const [bindTarget, setBindTarget] = useState('');
  const [bindDataset, setBindDataset] = useState('*');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await clientFetch(`/api/items/data-contract/${encodeURIComponent(id)}/odcs`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'Could not read the contract registry.');
      setData(j as OdcsPayload);
    } catch (e) {
      setError((e as Error)?.message || 'Could not read the contract registry.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { if (id && id !== 'new') void load(); }, [id, reloadKey, load]);

  // Real item list for the binding picker (dropdown-only, no typed ids).
  useEffect(() => {
    if (!bindKind) return;
    (async () => {
      try {
        const ws = workspaceId ? `&workspaceId=${encodeURIComponent(workspaceId)}` : '';
        const r = await clientFetch(`/api/items/by-type?type=${encodeURIComponent(bindKind)}${ws}`);
        const j = await r.json();
        const items: TargetItem[] = Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : [];
        setTargets(items);
        setBindTarget('');
        setBindDataset('*');
      } catch {
        setTargets([]);
      }
    })();
  }, [bindKind, workspaceId]);

  const selectedTarget = useMemo(() => targets.find((t) => t.id === bindTarget), [targets, bindTarget]);
  const datasetOptions = useMemo(() => ['*', ...datasetsFor(selectedTarget)], [selectedTarget]);

  const post = useCallback(async (label: string, path: string, init: RequestInit) => {
    setBusy(label);
    setError(null);
    setOk(null);
    setImportErrors([]);
    try {
      const r = await clientFetch(path, init);
      const j = await r.json();
      if (!j.ok) {
        if (Array.isArray(j.errors) && j.errors.length) setImportErrors(j.errors as OdcsFieldErrorView[]);
        throw new Error(j.error || `${label} failed`);
      }
      setOk(`${label} succeeded.`);
      await load();
      return true;
    } catch (e) {
      setError((e as Error)?.message || `${label} failed`);
      return false;
    } finally {
      setBusy(null);
    }
  }, [load]);

  const register = useCallback(() => post('Register', `/api/items/data-contract/${encodeURIComponent(id)}/odcs`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: String((data?.odcs as Record<string, unknown>)?.status || 'draft') }),
  }), [post, id, data]);

  const exportOdcs = useCallback(() => {
    if (!data?.odcs) return;
    const blob = new Blob([JSON.stringify(data.odcs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${String((data.odcs as Record<string, unknown>).id || id)}.odcs.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [data, id]);

  const onImportFile = useCallback(async (file: File) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setImportErrors([{ path: '', message: 'The file is not valid JSON. Export a contract first to see the expected ODCS 3.1 shape.' }]);
      setError('Import failed — the file is not valid JSON.');
      return;
    }
    await post('Import', `/api/items/data-contract/${encodeURIComponent(id)}/odcs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ odcs: parsed }),
    });
  }, [post, id]);

  const setMode = useCallback((mode: string) => post('Enforcement update', `/api/items/data-contract/${encodeURIComponent(id)}/odcs`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }),
  }), [post, id]);

  const setEnabled = useCallback((enabled: boolean) => post('Enforcement update', `/api/items/data-contract/${encodeURIComponent(id)}/odcs`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
  }), [post, id]);

  const bind = useCallback(() => post('Bind', `/api/items/data-contract/${encodeURIComponent(id)}/odcs`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'bind', kind: bindKind, targetItemId: bindTarget,
      targetItemName: selectedTarget?.displayName, dataset: bindDataset,
    }),
  }), [post, id, bindKind, bindTarget, bindDataset, selectedTarget]);

  const unbind = useCallback((bindingId: string) => post('Unbind', `/api/items/data-contract/${encodeURIComponent(id)}/odcs`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'unbind', bindingId }),
  }), [post, id]);

  if (loading) return <Spinner label="Loading the ODCS registry…" />;

  const odcs = (data?.odcs || {}) as Record<string, unknown>;
  const enforcement = data?.enforcement || { enabled: true, mode: 'warn-quarantine' };
  const modes = data?.enforcementModes?.length ? data.enforcementModes : ['warn-quarantine', 'hard-reject'];
  const kinds = data?.bindingKinds?.length ? data.bindingKinds : ['mirrored-database', 'data-pipeline', 'eventstream'];

  return (
    <>
      {error && (
        <MessageBar intent="error" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>{importErrors.length ? 'The document is not a valid ODCS 3.1 data contract' : 'Action failed'}</MessageBarTitle>
            {error}
            {importErrors.length > 0 && (
              <ul className={s.errorList}>
                {importErrors.map((e, i) => (
                  <li key={`${e.path}-${i}`}>
                    <code>{e.path || '(document)'}</code> — {e.message}
                  </li>
                ))}
              </ul>
            )}
          </MessageBarBody>
        </MessageBar>
      )}
      {ok && !error && (
        <MessageBar intent="success">
          <MessageBarBody>{ok}</MessageBarBody>
        </MessageBar>
      )}

      {/* ── 1. ODCS 3.1 registry ─────────────────────────────────────────── */}
      <Card className={s.card}>
        <CardHeader
          image={<CheckmarkCircle20Regular />}
          header={<Subtitle2>Open Data Contract Standard 3.1</Subtitle2>}
          description={<Caption1 className={s.hint}>Register this contract as a portable ODCS 3.1 document so it can be enforced, exported, and reviewed outside Loom.</Caption1>}
        />
        <div className={s.badges}>
          <Badge appearance="tint" color={data?.registered ? 'success' : 'warning'}>
            {data?.registered ? 'registered' : 'not registered yet'}
          </Badge>
          <Badge appearance="outline">{String(odcs.apiVersion || 'v3.1.0')}</Badge>
          <Badge appearance="tint" color="brand">v{String(odcs.version || '1.0.0')}</Badge>
          <Badge appearance="tint" color="informative">{String(odcs.status || 'draft')}</Badge>
          {data?.trend && data.trend.runs > 0 && (
            <Badge appearance="tint" color={data.trend.rejected ? 'danger' : data.trend.quarantined ? 'warning' : 'success'}>
              {data.trend.runs} enforcement run{data.trend.runs === 1 ? '' : 's'}
            </Badge>
          )}
        </div>
        <div className={s.row}>
          <Button appearance="primary" icon={busy === 'Register' ? <Spinner size="tiny" /> : <ShieldCheckmark20Regular />} disabled={!!busy} onClick={() => void register()}>
            {data?.registered ? 'Re-register' : 'Register as ODCS 3.1'}
          </Button>
          <Button icon={<ArrowDownload20Regular />} disabled={!!busy} onClick={exportOdcs}>Export</Button>
          <Button icon={busy === 'Import' ? <Spinner size="tiny" /> : <ArrowUpload20Regular />} disabled={!!busy} onClick={() => fileRef.current?.click()}>
            Import…
          </Button>
          <Button appearance="subtle" icon={<ArrowSync20Regular />} disabled={!!busy} onClick={() => void load()}>Refresh</Button>
          <input
            ref={fileRef}
            className={s.hiddenInput}
            type="file"
            accept="application/json,.json"
            aria-label="ODCS 3.1 contract document"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void onImportFile(f);
            }}
          />
        </div>
        <Caption1 className={s.hint}>
          Import validates the document against the ODCS 3.1 shape and reports the exact offending field — it never silently accepts a
          malformed contract. Registering overwrites the stored document from this editor&apos;s typed designer.
        </Caption1>
      </Card>

      {/* ── 2. Enforcement posture ──────────────────────────────────────── */}
      <Card className={s.card}>
        <CardHeader
          image={<ShieldCheckmark20Regular />}
          header={<Subtitle2>Enforcement at ingestion</Subtitle2>}
          description={<Caption1 className={s.hint}>How this contract behaves when a row violates it on the way in.</Caption1>}
        />
        <div className={s.row}>
          <Field label="Mode" hint={MODE_HELP[enforcement.mode] || ''}>
            <Dropdown
              value={enforcement.mode}
              selectedOptions={[enforcement.mode]}
              disabled={!!busy || !data?.registered}
              onOptionSelect={(_, d) => { if (d.optionValue) void setMode(d.optionValue); }}
            >
              {modes.map((m) => (
                <Option key={m} value={m} text={m}>
                  {m === 'warn-quarantine' ? 'warn-quarantine (default — quarantine the bad rows, land the rest)' : 'hard-reject (opt-in — block the whole batch)'}
                </Option>
              ))}
            </Dropdown>
          </Field>
          <Switch
            checked={enforcement.enabled}
            disabled={!!busy || !data?.registered}
            label={enforcement.enabled ? 'Enforcing' : 'Not enforcing'}
            onChange={(_, d) => void setEnabled(!!d.checked)}
          />
        </div>
        {!data?.registered && (
          <MessageBar intent="info" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>Register the contract to enforce it</MessageBarTitle>
              Enforcement reads the registered ODCS document. Click <strong>Register as ODCS 3.1</strong> above, then bind an ingestion path below.
            </MessageBarBody>
          </MessageBar>
        )}
      </Card>

      {/* ── 3. Ingestion bindings ───────────────────────────────────────── */}
      <Card className={s.card}>
        <CardHeader
          image={<Link20Regular />}
          header={<Subtitle2>Ingestion bindings</Subtitle2>}
          description={<Caption1 className={s.hint}>The mirroring-engine tables, pipeline sinks, and eventstreams this contract governs. Binding is what turns a document into enforcement.</Caption1>}
        />
        {(data?.bindings || []).map((b) => (
          <div key={b.id} className={s.bindingRow}>
            <Badge appearance="tint" color="informative">{KIND_LABEL[b.kind] || b.kind}</Badge>
            <Text className={s.grow}>{b.targetItemName || b.targetItemId}</Text>
            <Badge appearance="outline">{b.dataset === '*' ? 'every dataset' : b.dataset}</Badge>
            <Tooltip content="Remove this binding" relationship="label">
              <Button appearance="subtle" icon={<Delete20Regular />} disabled={!!busy} onClick={() => void unbind(b.id)} aria-label={`Unbind ${b.targetItemName || b.targetItemId}`} />
            </Tooltip>
          </div>
        ))}
        {!(data?.bindings || []).length && (
          <Caption1 className={s.hint}>No ingestion path is bound yet, so nothing is being enforced. Pick a target below.</Caption1>
        )}
        <div className={s.row}>
          <Field label="Ingestion path">
            <Dropdown value={KIND_LABEL[bindKind] || bindKind} selectedOptions={[bindKind]} disabled={!!busy}
              onOptionSelect={(_, d) => setBindKind(d.optionValue || 'mirrored-database')}>
              {kinds.map((k) => <Option key={k} value={k} text={KIND_LABEL[k] || k}>{KIND_LABEL[k] || k}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Target item">
            <Dropdown
              value={selectedTarget?.displayName || ''}
              selectedOptions={bindTarget ? [bindTarget] : []}
              placeholder={targets.length ? 'Select an item' : 'No items of this type'}
              disabled={!!busy || !targets.length}
              onOptionSelect={(_, d) => { setBindTarget(d.optionValue || ''); setBindDataset('*'); }}
            >
              {targets.map((t) => <Option key={t.id} value={t.id} text={t.displayName}>{t.displayName}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Dataset">
            <Dropdown value={bindDataset === '*' ? 'Every dataset' : bindDataset} selectedOptions={[bindDataset]} disabled={!!busy || !bindTarget}
              onOptionSelect={(_, d) => setBindDataset(d.optionValue || '*')}>
              {datasetOptions.map((ds) => (
                <Option key={ds} value={ds} text={ds === '*' ? 'Every dataset' : ds}>{ds === '*' ? 'Every dataset' : ds}</Option>
              ))}
            </Dropdown>
          </Field>
          <Button appearance="primary" icon={busy === 'Bind' ? <Spinner size="tiny" /> : <Link20Regular />}
            disabled={!!busy || !bindTarget || !data?.registered} onClick={() => void bind()}>
            Bind
          </Button>
        </div>
      </Card>

      {/* ── Recent enforcement decisions (the trend the registry charts) ── */}
      {!!(data?.runs || []).length && (
        <Card className={s.card}>
          <CardHeader
            header={<Subtitle2>Recent enforcement decisions</Subtitle2>}
            description={<Caption1 className={s.hint}>Every batch this contract judged, newest first.</Caption1>}
          />
          {(data?.runs || []).slice(0, 8).map((r) => (
            <div key={r.id} className={s.bindingRow}>
              <Badge appearance="tint" color={r.decision === 'landed' ? 'success' : r.decision === 'rejected-batch' ? 'danger' : 'warning'}>
                {r.decision}
              </Badge>
              <Text className={s.grow}>{r.source} · {r.dataset}</Text>
              <Caption1>{r.accepted}/{r.evaluated} landed · {r.rejected} quarantined</Caption1>
              <Caption1 className={s.hint}>{new Date(r.at).toLocaleString()}</Caption1>
            </div>
          ))}
          <Caption1 className={s.hint}>
            Quarantined rows are written as JSONL to the Bronze <code>_rejected</code> dead-letter path beside the clean data, so they are
            replayable once the producer or the contract is fixed.
          </Caption1>
        </Card>
      )}
    </>
  );
}
