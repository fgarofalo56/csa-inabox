'use client';

/**
 * DataSourcePicker — choose the DATA SOURCE that backs a Loom report.
 *
 * Report Designer v2 (no-fabric-dependency.md): a report is no longer wired to
 * Azure Analysis Services only. This drawer lets the author pick one of three
 * source kinds, persisted on the report item's `state.dataSource` as a
 * discriminated union (the parent PUTs the chosen value to
 * `/api/items/report/[id]/data-source`):
 *
 *   (a) Semantic model  — DEFAULT, Azure-native. A Loom `semantic-model` item
 *       (itself Loom-native SQL over a warehouse/lakehouse, or AAS-bound). The
 *       dropdown is populated from GET /api/items/by-type?types=semantic-model.
 *   (b) Direct query    — a guarded read-only SELECT over the Azure-native
 *       warehouse (Synapse dedicated pool) or lakehouse (serverless over Delta).
 *       On first save the designer scaffolds a real `semantic-model` item from
 *       it; here the "Preview columns" button hits the scaffold route in dry-run
 *       so the author sees the REAL inferred schema before committing.
 *   (c) Advanced — Azure Analysis Services: the existing XMLA binding
 *       (server URI + database). Strictly advanced; AAS stays one source kind.
 *
 * Power BI is NOT a source kind here — it remains strictly opt-in
 * (NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi + a bound workspace) and is unaffected.
 *
 * Rules: no-vaporware (every control hits a real route; unconfigured branches
 * surface the verbatim backend error / honest gate — never a mock schema),
 * no-freeform-config (kind + model + target are pickers; the only free text is
 * the allowed SQL escape hatch, guarded by `readOnlySelect`, and the advanced
 * AAS XMLA URI), web3-ui (Fluent v9 + Loom tokens, cards/elevation, EmptyState,
 * no hard-coded px).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import {
  OverlayDrawer, DrawerHeader, DrawerHeaderTitle, DrawerBody, DrawerFooter,
  Badge, Button, Caption1, Subtitle2, Text,
  RadioGroup, Radio, Field, Dropdown, Option, Input, Textarea, Divider,
  MessageBar, MessageBarBody, MessageBarTitle, Spinner,
  Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  Dismiss20Regular, Database20Regular, DocumentTable20Regular,
  Server20Regular, ArrowSync16Regular, Checkmark16Regular, TableSearch20Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { readOnlySelect } from '@/lib/thread/sql-guard';

// ── data-source model (mirrored server-side in lib/azure/report-model-resolver.ts) ──

/** Discriminated union persisted on report `state.dataSource`. */
export type ReportDataSource =
  | { kind: 'semantic-model'; itemId: string }
  | { kind: 'direct-query'; target: DirectTarget; sql: string; modelItemId?: string }
  | { kind: 'aas'; server: string; database: string };

export type ReportDataSourceKind = ReportDataSource['kind'];
export type DirectTarget = 'warehouse' | 'lakehouse';

/** A semantic-model item as returned by /api/items/by-type. */
interface ModelItem {
  id: string;
  displayName?: string;
  description?: string;
  workspaceId?: string;
}

/** One column from the scaffold dry-run (real inferred schema, never mock). */
interface PreviewColumn { name: string; dataType?: string; summarizeBy?: string }

const TARGETS: { value: DirectTarget; label: string; hint: string }[] = [
  { value: 'warehouse', label: 'Warehouse', hint: 'Synapse dedicated SQL pool' },
  { value: 'lakehouse', label: 'Lakehouse', hint: 'Serverless SQL over Delta' },
];

// ── styles (Loom tokens only — no hard-coded px) ──────────────────────────────

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0 },
  options: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  optionRow: {
    display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalS,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
    transitionProperty: 'box-shadow, border-color',
    transitionDuration: tokens.durationFaster,
    cursor: 'pointer',
    ':hover': { boxShadow: tokens.shadow8 },
  },
  optionRowActive: {
    border: `${tokens.strokeWidthThick} solid ${tokens.colorBrandStroke1}`,
    boxShadow: tokens.shadow16,
    backgroundColor: tokens.colorBrandBackground2,
  },
  optionIcon: {
    flexShrink: 0,
    color: tokens.colorBrandForeground1,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: tokens.spacingHorizontalXXXL, height: tokens.spacingHorizontalXXXL,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  optionText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0, flex: 1 },
  muted: { color: tokens.colorNeutralForeground3 },
  panel: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  sqlArea: { fontFamily: tokens.fontFamilyMonospace },
  previewWrap: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    maxHeight: '40vh', overflow: 'auto',
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    padding: tokens.spacingVerticalS,
  },
  footer: { display: 'flex', gap: tokens.spacingHorizontalS, justifyContent: 'flex-end' },
});

const KIND_META: { kind: ReportDataSourceKind; label: string; hint: string; icon: ReactElement }[] = [
  { kind: 'semantic-model', label: 'Semantic model', hint: 'Recommended · reusable, governed, Azure-native', icon: <Database20Regular /> },
  { kind: 'direct-query', label: 'Direct query', hint: 'Build a model from a SELECT over a warehouse / lakehouse', icon: <DocumentTable20Regular /> },
  { kind: 'aas', label: 'Advanced · Azure Analysis Services', hint: 'Bind an existing XMLA tabular model', icon: <Server20Regular /> },
];

// ── component ─────────────────────────────────────────────────────────────────

export interface DataSourcePickerProps {
  open: boolean;
  /** Report item id (used only to scope the parent PUT — passed through to onChange). */
  reportId?: string;
  /** Currently-persisted data source, if any (pre-selects the form). */
  value?: ReportDataSource | null;
  /** Parent persists the chosen source (PUT /api/items/report/[id]/data-source). */
  onChange: (ds: ReportDataSource) => void;
  onDismiss: () => void;
  /** True while the parent is persisting — disables Confirm + shows a spinner. */
  saving?: boolean;
}

export function DataSourcePicker({ open, value, onChange, onDismiss, saving }: DataSourcePickerProps) {
  const styles = useStyles();

  const [kind, setKind] = useState<ReportDataSourceKind>(value?.kind ?? 'semantic-model');

  // (a) semantic-model
  const [models, setModels] = useState<ModelItem[] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsErr, setModelsErr] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string>(value?.kind === 'semantic-model' ? value.itemId : '');

  // (b) direct-query
  const [target, setTarget] = useState<DirectTarget>(value?.kind === 'direct-query' ? value.target : 'warehouse');
  const [sql, setSql] = useState<string>(value?.kind === 'direct-query' ? value.sql : '');
  const [previewCols, setPreviewCols] = useState<PreviewColumn[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  // (c) aas
  const [aasServer, setAasServer] = useState<string>(value?.kind === 'aas' ? value.server : '');
  const [aasDatabase, setAasDatabase] = useState<string>(value?.kind === 'aas' ? value.database : '');

  // Re-seed the form whenever the drawer (re)opens against a (possibly new) value.
  useEffect(() => {
    if (!open) return;
    setKind(value?.kind ?? 'semantic-model');
    setModelId(value?.kind === 'semantic-model' ? value.itemId : '');
    setTarget(value?.kind === 'direct-query' ? value.target : 'warehouse');
    setSql(value?.kind === 'direct-query' ? value.sql : '');
    setAasServer(value?.kind === 'aas' ? value.server : '');
    setAasDatabase(value?.kind === 'aas' ? value.database : '');
    setPreviewCols(null); setPreviewErr(null);
  }, [open, value]);

  // ── load semantic-model items (real route; honest error on failure) ─────────
  const loadModels = useCallback(async () => {
    setModelsLoading(true); setModelsErr(null);
    try {
      const r = await fetch('/api/items/by-type?types=semantic-model');
      const j = await r.json();
      if (!j.ok) { setModels([]); setModelsErr(j.error || `HTTP ${r.status}`); return; }
      const items: ModelItem[] = (j.items || []).map((it: any) => ({
        id: it.id, displayName: it.displayName, description: it.description, workspaceId: it.workspaceId,
      }));
      setModels(items);
      // Keep a valid selection: clear if the persisted id is no longer present.
      if (modelId && !items.some((m) => m.id === modelId)) setModelId('');
    } catch (e: any) { setModels([]); setModelsErr(e?.message || String(e)); }
    finally { setModelsLoading(false); }
  }, [modelId]);

  useEffect(() => { if (open) loadModels(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);

  // ── direct-query: preview the REAL inferred schema (scaffold dry-run) ────────
  const sqlGuard = useMemo(() => readOnlySelect(sql), [sql]);

  const previewColumns = useCallback(async () => {
    const guard = readOnlySelect(sql);
    if (!guard.ok) { setPreviewErr(guard.error); setPreviewCols(null); return; }
    setPreviewLoading(true); setPreviewErr(null); setPreviewCols(null);
    try {
      const r = await fetch('/api/items/semantic-model/scaffold', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dryRun: true, target, sql: guard.sql }),
      });
      const j = await r.json();
      if (!j.ok) {
        // Honest gate: name the exact remediation the route returns (env var /
        // role / login failure), never swallow it into a fake column list.
        const gate = j.gate?.missing ? ` (missing: ${j.gate.missing})` : '';
        setPreviewErr((j.error || `HTTP ${r.status}`) + gate);
        return;
      }
      setPreviewCols((j.columns || []) as PreviewColumn[]);
    } catch (e: any) { setPreviewErr(e?.message || String(e)); }
    finally { setPreviewLoading(false); }
  }, [sql, target]);

  // ── confirm ──────────────────────────────────────────────────────────────────
  const draft: ReportDataSource | null = useMemo(() => {
    if (kind === 'semantic-model') return modelId ? { kind, itemId: modelId } : null;
    if (kind === 'direct-query') return sqlGuard.ok ? { kind, target, sql: sqlGuard.sql } : null;
    if (kind === 'aas') {
      const s = aasServer.trim(); const d = aasDatabase.trim();
      return s && d ? { kind, server: s, database: d } : null;
    }
    return null;
  }, [kind, modelId, sqlGuard, target, aasServer, aasDatabase]);

  const confirm = useCallback(() => { if (draft) onChange(draft); }, [draft, onChange]);

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <OverlayDrawer open={open} onOpenChange={(_e, d) => { if (!d.open) onDismiss(); }} position="end" size="medium">
      <DrawerHeader>
        <DrawerHeaderTitle
          action={<Button appearance="subtle" icon={<Dismiss20Regular />} aria-label="Close data source picker" onClick={onDismiss} />}
        >
          Report data source
        </DrawerHeaderTitle>
      </DrawerHeader>

      <DrawerBody>
        <div className={styles.body}>
          <Caption1 className={styles.muted}>
            Pick what this report reads from. The default is a Loom semantic model over Azure (Synapse / lakehouse) —
            no Power BI or Fabric workspace required.
          </Caption1>

          <RadioGroup value={kind} onChange={(_e, d) => setKind(d.value as ReportDataSourceKind)} aria-label="Data source kind">
            <div className={styles.options}>
              {KIND_META.map((k) => (
                <label
                  key={k.kind}
                  className={mergeClasses(styles.optionRow, kind === k.kind && styles.optionRowActive)}
                  htmlFor={`ds-kind-${k.kind}`}
                >
                  <span className={styles.optionIcon} aria-hidden>{k.icon}</span>
                  <span className={styles.optionText}>
                    <Subtitle2>{k.label}</Subtitle2>
                    <Caption1 className={styles.muted}>{k.hint}</Caption1>
                  </span>
                  <Radio id={`ds-kind-${k.kind}`} value={k.kind} aria-label={k.label} />
                </label>
              ))}
            </div>
          </RadioGroup>

          <Divider />

          {/* (a) Semantic model ───────────────────────────────────────────── */}
          {kind === 'semantic-model' && (
            <div className={styles.panel}>
              <div className={styles.toolbar}>
                <Subtitle2>Semantic model</Subtitle2>
                <Badge appearance="tint" color="brand" size="small">Azure-native default</Badge>
                <div className={styles.spacer} />
                <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={loadModels} disabled={modelsLoading}>
                  {modelsLoading ? 'Loading…' : 'Refresh'}
                </Button>
              </div>

              {modelsErr && (
                <MessageBar intent="error"><MessageBarBody>{modelsErr}</MessageBarBody></MessageBar>
              )}
              {modelsLoading && models === null && <Spinner size="tiny" label="Loading semantic models…" />}

              {models && models.length === 0 && !modelsErr && (
                <EmptyState
                  icon={<Database20Regular />}
                  title="No semantic models yet"
                  body="A report binds to a semantic model (a dataset). Build one from a warehouse/lakehouse table or a SQL query via Weave, or switch to Direct query below to scaffold one inline."
                  primaryAction={{ label: 'Build from a query / table', onClick: () => setKind('direct-query') }}
                />
              )}

              {models && models.length > 0 && (
                <Field label="Model" required hint="Reports can share one governed model. Lineage (Thread) + Purview onboarding fire when the model is created.">
                  <Dropdown
                    placeholder="Choose a semantic model"
                    value={models.find((m) => m.id === modelId)?.displayName || ''}
                    selectedOptions={modelId ? [modelId] : []}
                    onOptionSelect={(_e, d) => setModelId(String(d.optionValue || ''))}
                  >
                    {models.map((m) => (
                      <Option key={m.id} value={m.id} text={m.displayName || m.id}>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <Text weight="semibold">{m.displayName || m.id}</Text>
                          {m.description && <Caption1 className={styles.muted}>{m.description}</Caption1>}
                        </div>
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              )}
            </div>
          )}

          {/* (b) Direct query ─────────────────────────────────────────────── */}
          {kind === 'direct-query' && (
            <div className={styles.panel}>
              <Subtitle2>Direct query</Subtitle2>
              <Caption1 className={styles.muted}>
                On first save the designer mints a real, reusable <strong>semantic-model</strong> item from this SELECT
                (Azure-native scaffold over {target === 'warehouse' ? 'Synapse' : 'serverless SQL'}). No Power BI / Fabric.
              </Caption1>

              <Field label="Source" required>
                <Dropdown
                  value={TARGETS.find((t) => t.value === target)?.label || ''}
                  selectedOptions={[target]}
                  onOptionSelect={(_e, d) => { setTarget(d.optionValue as DirectTarget); setPreviewCols(null); setPreviewErr(null); }}
                >
                  {TARGETS.map((t) => (
                    <Option key={t.value} value={t.value} text={t.label}>
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <Text weight="semibold">{t.label}</Text>
                        <Caption1 className={styles.muted}>{t.hint}</Caption1>
                      </div>
                    </Option>
                  ))}
                </Dropdown>
              </Field>

              <Field
                label="SQL query"
                required
                validationState={sql && !sqlGuard.ok ? 'error' : 'none'}
                validationMessage={sql && !sqlGuard.ok ? sqlGuard.error : undefined}
                hint="A single read-only SELECT (the allowed escape hatch). Guarded against writes; wrapped as a derived table — never injected."
              >
                <Textarea
                  className={styles.sqlArea}
                  resize="vertical"
                  placeholder="SELECT category, SUM(amount) AS total FROM dbo.Sales GROUP BY category"
                  value={sql}
                  onChange={(_e, d) => { setSql(d.value); setPreviewCols(null); setPreviewErr(null); }}
                  textarea={{ rows: 7 }}
                  aria-label="SQL query"
                />
              </Field>

              <div className={styles.toolbar}>
                <Button
                  appearance="secondary"
                  icon={<TableSearch20Regular />}
                  onClick={previewColumns}
                  disabled={previewLoading || !sqlGuard.ok}
                >
                  {previewLoading ? 'Previewing…' : 'Preview columns'}
                </Button>
                <Caption1 className={styles.muted}>Runs the scaffold in dry-run to infer the real schema.</Caption1>
              </div>

              {previewErr && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Could not infer the schema</MessageBarTitle>
                    {previewErr}
                  </MessageBarBody>
                </MessageBar>
              )}
              {previewCols && previewCols.length > 0 && (
                <div className={styles.previewWrap}>
                  <Caption1 className={styles.muted}>{previewCols.length} column(s) inferred</Caption1>
                  <Table size="small" aria-label="Inferred columns">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>Column</TableHeaderCell>
                        <TableHeaderCell>Type</TableHeaderCell>
                        <TableHeaderCell>Summarize by</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {previewCols.map((c) => (
                        <TableRow key={c.name}>
                          <TableCell>{c.name}</TableCell>
                          <TableCell>{c.dataType || '—'}</TableCell>
                          <TableCell>{c.summarizeBy || '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              {previewCols && previewCols.length === 0 && !previewErr && (
                <Caption1 className={styles.muted}>The query returned no columns.</Caption1>
              )}
            </div>
          )}

          {/* (c) Advanced — Azure Analysis Services ───────────────────────── */}
          {kind === 'aas' && (
            <div className={styles.panel}>
              <Subtitle2>Azure Analysis Services (advanced)</Subtitle2>
              <Caption1 className={styles.muted}>
                Bind an existing XMLA tabular model. Visuals render with DAX (no Power BI workspace).
                The Console UAMI must be a server admin on the AAS instance.
              </Caption1>
              <Field label="XMLA server URI" required hint="e.g. asazure://eastus2.asazure.windows.net/my-server">
                <Input
                  value={aasServer}
                  placeholder="asazure://<region>.asazure.windows.net/<server>"
                  onChange={(_e, d) => setAasServer(d.value)}
                />
              </Field>
              <Field label="Database (model name)" required>
                <Input value={aasDatabase} placeholder="my-tabular-model" onChange={(_e, d) => setAasDatabase(d.value)} />
              </Field>
            </div>
          )}
        </div>
      </DrawerBody>

      <DrawerFooter>
        <div className={styles.footer}>
          <Button appearance="secondary" onClick={onDismiss} disabled={saving}>Cancel</Button>
          <Button
            appearance="primary"
            icon={saving ? <Spinner size="tiny" /> : <Checkmark16Regular />}
            onClick={confirm}
            disabled={!draft || saving}
          >
            {saving ? 'Saving…' : 'Use this source'}
          </Button>
        </div>
      </DrawerFooter>
    </OverlayDrawer>
  );
}

export default DataSourcePicker;
