'use client';

/**
 * admin/policy-code — Governance-as-Code (WS-10.2 / BTB-8).
 *
 * Author a policy-as-code set (principals × resources × actions × conditions)
 * via a structured wizard (no freeform JSON), see it compile to every backend
 * in one pass (Synapse SQL / Unity Catalog / ADX / Purview / API scopes), and
 * run the reconcile loop (dry-run drift + apply/self-heal). Real data end to
 * end — the compiled statements are the exact SQL/KQL/REST the reconcile runs.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Caption1, Card, Checkbox, Dropdown, Option, Input,
  MessageBar, MessageBarBody, MessageBarTitle, Spinner, Subtitle2,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Tab, TabList, Tooltip, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ShieldCheckmark24Regular, Add16Regular, Delete16Regular, Edit16Regular,
  ArrowSync16Regular, PlayCircle16Regular, DocumentBulletList16Regular, Save16Regular,
} from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { clientFetch } from '@/lib/client-fetch';
import { EmptyState } from '@/lib/components/empty-state';
import { SplitPane } from '@/lib/components/shared/split-pane';
import {
  POLICY_BACKENDS, BACKEND_LABELS, POLICY_ACTIONS,
  type PolicyBackend, type PolicyCodeSet, type PolicyStatement, type PolicyAction,
} from '@/lib/governance/policy-code/dsl';
import type { CompiledArtifact } from '@/lib/governance/policy-code/compilers/types';

const useStyles = makeStyles({
  toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalS, marginBottom: tokens.spacingVerticalL },
  spacer: { flexGrow: 1 },
  loading: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, padding: tokens.spacingVerticalXXL },
  shell: { height: '620px' },
  pane: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingVerticalM, overflow: 'auto', height: '100%', minWidth: 0 },
  card: { padding: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  cardActions: { display: 'flex', gap: tokens.spacingHorizontalXS, marginLeft: 'auto' },
  meta: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  code: { fontFamily: 'monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: tokens.colorNeutralBackground3, borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingVerticalS },
  opRow: { display: 'flex', flexDirection: 'column', gap: '2px', paddingBottom: tokens.spacingVerticalS, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, marginBottom: tokens.spacingVerticalS },
  row: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  receiptRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', padding: tokens.spacingVerticalXS },
});

interface LoadResp {
  ok: boolean;
  set: PolicyCodeSet;
  exists: boolean;
  yaml: string;
  backends: PolicyBackend[];
  validation: { ok: boolean; errors: string[]; warnings: string[] };
  artifacts: CompiledArtifact[];
  compiledBackends: PolicyBackend[];
  totalOps: number;
  lastReceipt: any;
  error?: string;
}

const STATUS_COLOR: Record<string, 'success' | 'warning' | 'danger' | 'informative' | 'brand'> = {
  converged: 'success', applied: 'success', drift: 'warning', gated: 'warning', partial: 'danger', skipped: 'informative',
};

export default function AdminPolicyCodePage() {
  const s = useStyles();
  const [data, setData] = useState<LoadResp | null>(null);
  const [set, setSet] = useState<PolicyCodeSet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<PolicyBackend | 'reconcile'>('reconcile');
  const [receipt, setReceipt] = useState<any>(null);
  const [editing, setEditing] = useState<PolicyStatement | null>(null);
  const [dirty, setDirty] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await clientFetch('/api/admin/policy-code');
      const j = (await r.json().catch(() => null)) as LoadResp | null;
      if (j?.ok) {
        setData(j);
        setSet(j.set);
        setReceipt(j.lastReceipt || null);
        setDirty(false);
      } else {
        setError(j?.error || `load failed (${r.status})`);
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const compiled = data?.artifacts || [];
  const artifactFor = (b: PolicyBackend) => compiled.find((a) => a.backend === b);

  const save = useCallback(async () => {
    if (!set) return;
    setBusy('save');
    setError(null);
    try {
      const r = await clientFetch('/api/admin/policy-code', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ set }),
      });
      const j = await r.json().catch(() => null);
      if (j?.ok) {
        await reload();
      } else {
        setError(j?.error || `save failed (${r.status})`);
        if (j?.validation?.errors?.length) setError(j.validation.errors.join('; '));
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(null);
    }
  }, [set, reload]);

  const loadSample = useCallback(async () => {
    setBusy('sample');
    try {
      const mod = await import('@/lib/governance/policy-code/samples');
      setSet(mod.samplePolicyCodeSet());
      setDirty(true);
    } finally {
      setBusy(null);
    }
  }, []);

  const reconcile = useCallback(async (apply: boolean) => {
    setBusy(apply ? 'apply' : 'preview');
    setError(null);
    try {
      const r = await clientFetch('/api/admin/policy-code/reconcile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apply }),
      });
      const j = await r.json().catch(() => null);
      if (j?.ok) {
        setReceipt(j.receipt);
        setTab('reconcile');
      } else {
        setError(j?.error || j?.hint || `reconcile failed (${r.status})`);
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const upsertStatement = (stmt: PolicyStatement) => {
    setSet((prev) => {
      if (!prev) return prev;
      const exists = prev.statements.some((x) => x.id === stmt.id);
      const statements = exists ? prev.statements.map((x) => (x.id === stmt.id ? stmt : x)) : [...prev.statements, stmt];
      return { ...prev, statements };
    });
    setDirty(true);
    setEditing(null);
  };
  const removeStatement = (id: string) => {
    setSet((prev) => (prev ? { ...prev, statements: prev.statements.filter((x) => x.id !== id) } : prev));
    setDirty(true);
  };

  const backendsUsed = useMemo(() => data?.compiledBackends || [], [data]);

  return (
    <AdminShell
      sectionTitle="Policy as code"
      learn={{
        title: 'Governance as code',
        content:
          'Author one governance policy set — principals × resources × actions × conditions — and compile it to every ' +
          'backend in a single pass: Synapse SQL DENY/RLS, Unity Catalog grants + row filters/column masks (Databricks or ' +
          'OSS-UC with no capacity), ADX row-level security, Purview markings, and API scope gates. The reconcile loop reads ' +
          'live state, applies the delta, and self-heals drift.',
        tips: [
          'Dry-run "Preview drift" is safe — it mutates nothing.',
          'Unconfigured backends show an honest gate; the others still reconcile.',
          'loom policy apply runs this same reconcile from the CLI.',
        ],
      }}
    >
      <div className={s.toolbar}>
        <Button icon={<Save16Regular />} appearance="primary" disabled={!set || !dirty || busy === 'save'} onClick={save}>
          {busy === 'save' ? 'Saving…' : 'Save set'}
        </Button>
        <Button icon={<DocumentBulletList16Regular />} disabled={!!busy} onClick={loadSample}>Load sample</Button>
        <Button icon={<Add16Regular />} disabled={!set} onClick={() => setEditing(newStatement(set))}>Add statement</Button>
        <div className={s.spacer} />
        <Button icon={<ArrowSync16Regular />} disabled={!!busy} onClick={() => reconcile(false)}>
          {busy === 'preview' ? 'Checking…' : 'Preview drift'}
        </Button>
        <Button icon={<PlayCircle16Regular />} appearance="primary" disabled={!!busy || dirty} onClick={() => reconcile(true)}>
          {busy === 'apply' ? 'Applying…' : 'Apply & reconcile'}
        </Button>
        <Button icon={<ArrowSync16Regular />} appearance="subtle" onClick={reload}>Refresh</Button>
      </div>

      {dirty && (
        <MessageBar intent="info" layout="multiline" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody><MessageBarTitle>Unsaved changes</MessageBarTitle>Save the set before running Apply so the reconcile uses the persisted policy.</MessageBarBody>
        </MessageBar>
      )}
      {error && (
        <MessageBar intent="error" layout="multiline" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody><MessageBarTitle>Something went wrong</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      )}
      {data?.validation && data.validation.warnings.length > 0 && (
        <MessageBar intent="warning" layout="multiline" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody><MessageBarTitle>Compiler notes</MessageBarTitle>{data.validation.warnings.join(' • ')}</MessageBarBody>
        </MessageBar>
      )}

      {loading && !data ? (
        <div className={s.loading}><Spinner size="small" /><Caption1>Loading policy set…</Caption1></div>
      ) : !set ? (
        <EmptyState icon={<ShieldCheckmark24Regular />} title="No policy set" body="Load the sample or add a statement to begin." primaryAction={{ label: 'Load sample', onClick: loadSample }} />
      ) : (
        <div className={s.shell}>
          <SplitPane direction="horizontal" primary="first" defaultSize="46%" minSize={320} storageKey="admin-policy-code" dividerLabel="Resize">
            {/* ── Left: the authored policy set ─────────────────────────────── */}
            <div className={s.pane}>
              <Subtitle2>{set.name}</Subtitle2>
              {set.description && <Caption1>{set.description}</Caption1>}
              <div className={s.meta}>
                <Badge appearance="tint" color="brand">{set.statements.length} statement(s)</Badge>
                {backendsUsed.map((b) => <Badge key={b} appearance="outline">{b}</Badge>)}
                <Badge appearance="tint" color={backendsUsed.length >= 4 ? 'success' : 'informative'}>
                  compiles to {backendsUsed.length} backend(s)
                </Badge>
              </div>
              {set.statements.length === 0 ? (
                <EmptyState icon={<Add16Regular />} title="No statements yet" body="Add a statement or load the sample." primaryAction={{ label: 'Add statement', onClick: () => setEditing(newStatement(set)) }} />
              ) : (
                set.statements.map((stmt) => (
                  <Card key={stmt.id} className={s.card}>
                    <div className={s.cardHead}>
                      <Subtitle2>{stmt.id}</Subtitle2>
                      <div className={s.cardActions}>
                        <Tooltip content="Edit" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Edit16Regular />} onClick={() => setEditing(stmt)} />
                        </Tooltip>
                        <Tooltip content="Delete" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Delete16Regular />} onClick={() => removeStatement(stmt.id)} />
                        </Tooltip>
                      </div>
                    </div>
                    {stmt.description && <Caption1>{stmt.description}</Caption1>}
                    <div className={s.meta}>
                      {stmt.actions.map((a) => <Badge key={a} appearance="tint" color="brand">{a}</Badge>)}
                      {stmt.principals.map((p) => <Badge key={p.id} appearance="outline">{p.name || p.id}</Badge>)}
                    </div>
                    <div className={s.meta}>
                      {stmt.resources.map((r, i) => <Badge key={i} appearance="ghost" color="informative">{r.backend}: {r.object}</Badge>)}
                    </div>
                    {stmt.condition && (
                      <Caption1>
                        {stmt.condition.rowFilter ? `row: ${stmt.condition.rowFilter} ` : ''}
                        {stmt.condition.maskColumns?.length ? `mask: ${stmt.condition.maskColumns.join(', ')} ` : ''}
                        {stmt.condition.marking ? `mark: ${stmt.condition.marking}` : ''}
                      </Caption1>
                    )}
                  </Card>
                ))
              )}
            </div>

            {/* ── Right: compiled output + reconcile ────────────────────────── */}
            <div className={s.pane}>
              <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as any)}>
                <Tab value="reconcile">Reconcile</Tab>
                {POLICY_BACKENDS.map((b) => (
                  <Tab key={b} value={b}>
                    {b}{artifactFor(b)?.applicable ? ` (${artifactFor(b)!.ops.length})` : ''}
                  </Tab>
                ))}
              </TabList>

              {tab === 'reconcile' ? (
                <ReconcilePanel receipt={receipt} styles={s} />
              ) : (
                <BackendPanel artifact={artifactFor(tab as PolicyBackend)} styles={s} backend={tab as PolicyBackend} />
              )}
            </div>
          </SplitPane>
        </div>
      )}

      {editing && set && (
        <StatementDialog
          initial={editing}
          existingIds={set.statements.map((x) => x.id).filter((id) => id !== editing.id)}
          onCancel={() => setEditing(null)}
          onSave={upsertStatement}
        />
      )}
    </AdminShell>
  );
}

// ── Compiled-artifact panel ──────────────────────────────────────────────────
function BackendPanel({ artifact, styles, backend }: { artifact?: CompiledArtifact; styles: any; backend: PolicyBackend }) {
  if (!artifact || !artifact.applicable) {
    return (
      <EmptyState
        icon={<DocumentBulletList16Regular />}
        title={`No ${BACKEND_LABELS[backend]} ops`}
        body="This policy set produces no statements for this backend. Add a resource targeting it."
      />
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
      <Caption1>{BACKEND_LABELS[backend]} — {artifact.ops.length} op(s)</Caption1>
      {artifact.summary.map((sm, i) => <Caption1 key={i}>• {sm}</Caption1>)}
      {artifact.warnings.length > 0 && (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>{artifact.warnings.join(' • ')}</MessageBarBody>
        </MessageBar>
      )}
      {artifact.ops.map((op) => (
        <div key={op.key} className={styles.opRow}>
          <div className={styles.meta}>
            <Badge appearance="tint" color="brand">{op.kind}</Badge>
            <Caption1>{op.target}</Caption1>
          </div>
          <div className={styles.code}>{op.statement}</div>
        </div>
      ))}
    </div>
  );
}

// ── Reconcile receipt panel ──────────────────────────────────────────────────
function ReconcilePanel({ receipt, styles }: { receipt: any; styles: any }) {
  if (!receipt) {
    return (
      <EmptyState
        icon={<PlayCircle16Regular />}
        title="No reconcile run yet"
        body="Run “Preview drift” for a safe dry-run, or “Apply & reconcile” to converge every configured backend."
      />
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
      <div className={styles.meta}>
        <Badge appearance="filled" color={receipt.mode === 'apply' ? 'brand' : 'informative'}>{receipt.mode}</Badge>
        <Badge appearance="tint" color={receipt.totalDrift > 0 ? 'warning' : 'success'}>drift: {receipt.totalDrift}</Badge>
        <Caption1>{new Date(receipt.at).toLocaleString()}</Caption1>
      </div>
      {(receipt.backends || []).map((b: any) => (
        <div key={b.backend} className={styles.receiptRow}>
          <Badge appearance="filled" color={STATUS_COLOR[b.status] || 'informative'}>{b.status}</Badge>
          <Subtitle2>{b.backend}</Subtitle2>
          <Caption1>
            desired {b.desired} · in-sync {b.inSync} · applied {b.applied} · revoked {b.revoked}
            {b.drift ? ` · drift ${b.drift}` : ''}{b.errors ? ` · errors ${b.errors}` : ''}
          </Caption1>
          {b.gate && (
            <MessageBar intent="warning" layout="multiline">
              <MessageBarBody><MessageBarTitle>Configure to enforce</MessageBarTitle>{b.gate}</MessageBarBody>
            </MessageBar>
          )}
          {(b.detail || []).map((d: string, i: number) => <Caption1 key={i}>{d}</Caption1>)}
        </div>
      ))}
    </div>
  );
}

// ── Statement authoring dialog (structured — no freeform JSON) ───────────────
function newStatement(set: PolicyCodeSet | null): PolicyStatement {
  const n = (set?.statements.length || 0) + 1;
  return { id: `statement-${n}`, principals: [{ kind: 'group', id: '' }], resources: [{ backend: 'synapse', object: '' }], actions: ['read'] };
}

function StatementDialog({
  initial, existingIds, onCancel, onSave,
}: { initial: PolicyStatement; existingIds: string[]; onCancel: () => void; onSave: (s: PolicyStatement) => void }) {
  const s = useStyles();
  const [id, setId] = useState(initial.id);
  const [description, setDescription] = useState(initial.description || '');
  const [pKind, setPKind] = useState(initial.principals[0]?.kind || 'group');
  const [pId, setPId] = useState(initial.principals[0]?.id || '');
  const [pName, setPName] = useState(initial.principals[0]?.name || '');
  const [backend, setBackend] = useState<PolicyBackend>(initial.resources[0]?.backend || 'synapse');
  const [object, setObject] = useState(initial.resources[0]?.object || '');
  const [actions, setActions] = useState<PolicyAction[]>(initial.actions.length ? initial.actions : ['read']);
  const [rowFilter, setRowFilter] = useState(initial.condition?.rowFilter || '');
  const [maskColumns, setMaskColumns] = useState((initial.condition?.maskColumns || []).join(', '));
  const [marking, setMarking] = useState(initial.condition?.marking || '');
  const [extraResources] = useState(initial.resources.slice(1));

  const idError = !id.trim() ? 'id is required' : existingIds.includes(id.trim()) ? 'id must be unique' : '';
  const valid = !idError && pId.trim() && object.trim() && actions.length > 0;

  const toggleAction = (a: PolicyAction, on: boolean) =>
    setActions((prev) => (on ? [...new Set([...prev, a])] : prev.filter((x) => x !== a)));

  const submit = () => {
    const condition = {
      ...(rowFilter.trim() ? { rowFilter: rowFilter.trim() } : {}),
      ...(maskColumns.trim() ? { maskColumns: maskColumns.split(',').map((c) => c.trim()).filter(Boolean) } : {}),
      ...(marking.trim() ? { marking: marking.trim() } : {}),
    };
    const stmt: PolicyStatement = {
      id: id.trim(),
      description: description.trim() || undefined,
      principals: [{ kind: pKind as any, id: pId.trim(), name: pName.trim() || undefined }],
      resources: [{ backend, object: object.trim() }, ...extraResources],
      actions,
      condition: Object.keys(condition).length ? condition : undefined,
    };
    onSave(stmt);
  };

  return (
    <Dialog open modalType="modal" onOpenChange={(_, d) => { if (!d.open) onCancel(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Policy statement</DialogTitle>
          <DialogContent>
            <div className={s.field}>
              <Caption1>Statement id</Caption1>
              <Input value={id} onChange={(_, d) => setId(d.value)} />
              {idError && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{idError}</Caption1>}
            </div>
            <div className={s.field}>
              <Caption1>Description (optional)</Caption1>
              <Input value={description} onChange={(_, d) => setDescription(d.value)} />
            </div>
            <div className={s.row}>
              <div className={s.field} style={{ minWidth: 140 }}>
                <Caption1>Principal kind</Caption1>
                <Dropdown value={pKind} selectedOptions={[pKind]} onOptionSelect={(_, d) => setPKind(d.optionValue as any)}>
                  <Option value="group">group</Option>
                  <Option value="user">user</Option>
                </Dropdown>
              </div>
              <div className={s.field} style={{ flexGrow: 1, minWidth: 220 }}>
                <Caption1>Entra object id</Caption1>
                <Input value={pId} onChange={(_, d) => setPId(d.value)} placeholder="00000000-0000-0000-0000-000000000000" />
              </div>
              <div className={s.field} style={{ flexGrow: 1, minWidth: 180 }}>
                <Caption1>Display name / UPN</Caption1>
                <Input value={pName} onChange={(_, d) => setPName(d.value)} placeholder="Finance-Analysts" />
              </div>
            </div>
            <div className={s.row}>
              <div className={s.field} style={{ minWidth: 240 }}>
                <Caption1>Backend</Caption1>
                <Dropdown value={backend} selectedOptions={[backend]} onOptionSelect={(_, d) => setBackend(d.optionValue as PolicyBackend)}>
                  {POLICY_BACKENDS.map((b) => <Option key={b} value={b} text={b}>{BACKEND_LABELS[b]}</Option>)}
                </Dropdown>
              </div>
              <div className={s.field} style={{ flexGrow: 1, minWidth: 260 }}>
                <Caption1>Object (fully-qualified)</Caption1>
                <Input value={object} onChange={(_, d) => setObject(d.value)} placeholder={objectHint(backend)} />
              </div>
            </div>
            {extraResources.length > 0 && (
              <Caption1>+ {extraResources.length} more resource(s) from import (edit in place preserves them).</Caption1>
            )}
            <div className={s.field}>
              <Caption1>Actions</Caption1>
              <div className={s.row}>
                {POLICY_ACTIONS.map((a) => (
                  <Checkbox key={a} label={a} checked={actions.includes(a)} onChange={(_, d) => toggleAction(a, !!d.checked)} />
                ))}
              </div>
            </div>
            <div className={s.field}>
              <Caption1>Row filter — DAX boolean (optional)</Caption1>
              <Input value={rowFilter} onChange={(_, d) => setRowFilter(d.value)} placeholder="[Region] = USERPRINCIPALNAME()" />
            </div>
            <div className={s.row}>
              <div className={s.field} style={{ flexGrow: 1, minWidth: 220 }}>
                <Caption1>Mask columns (comma-separated, optional)</Caption1>
                <Input value={maskColumns} onChange={(_, d) => setMaskColumns(d.value)} placeholder="Email, SSN" />
              </div>
              <div className={s.field} style={{ flexGrow: 1, minWidth: 200 }}>
                <Caption1>Purview marking (optional)</Caption1>
                <Input value={marking} onChange={(_, d) => setMarking(d.value)} placeholder="Confidential" />
              </div>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCancel}>Cancel</Button>
            <Button appearance="primary" disabled={!valid} onClick={submit}>Save statement</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function objectHint(b: PolicyBackend): string {
  switch (b) {
    case 'synapse': return 'schema.table  (e.g. dbo.FactSales)';
    case 'unity-catalog': return 'catalog.schema.table  (e.g. main.sales.fact_sales)';
    case 'adx': return 'database/table  (e.g. Telemetry/SalesEvents)';
    case 'purview': return 'asset qualifiedName';
    case 'api-scope': return '/api/items/warehouse/*';
    default: return '';
  }
}
