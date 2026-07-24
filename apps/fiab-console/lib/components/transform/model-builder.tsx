/**
 * N4 — the transformation-project BUILD surface.
 *
 * A guided (dropdowns + pickers) editor for the engine-neutral model graph:
 * sources, models, medallion layer, materialization, refresh cadence, refs,
 * tests, owners, and tags. Per `loom_no_freeform_config` every control is a
 * dropdown/picker — the per-model SQL body is the ONE allowed freeform surface
 * (the 1:1 transformation-IDE exception), edited in Monaco.
 *
 * The engine SELECTOR lives here too: dbt (default) or SQLMesh. Switching it
 * changes only which project files are generated — the graph is unchanged, which
 * is the whole point of shipping both.
 */
'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  Badge, Body1, Button, Caption1, Divider, Dropdown, Field, Input, Option,
  Subtitle2, Tab, TabList, Tag, TagGroup, Text, Textarea,
  makeStyles, shorthands, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, DatabaseMultiple20Regular, Table20Regular,
} from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { EmptyState } from '@/lib/components/empty-state';
import { SplitPane } from '@/lib/components/shared/split-pane';
import {
  defaultMaterializationForLayer,
  type TransformBackend, type TransformLayer, type TransformMaterialization,
  type TransformModel, type TransformProject, type TransformSource,
} from '@/lib/transform/transform-project-model';

const LAYERS: TransformLayer[] = ['bronze', 'silver', 'gold'];
const MATERIALIZATIONS: TransformMaterialization[] = ['view', 'table', 'incremental', 'ephemeral'];
const CADENCES = ['@hourly', '@daily', '@weekly', '@monthly'] as const;
const ENGINES = [
  { value: 'synapse', label: 'Synapse dedicated SQL pool (Azure-native default)' },
  { value: 'databricks', label: 'Databricks SQL warehouse' },
  { value: 'duckdb', label: 'DuckDB over ADLS (sovereign / disconnected)' },
  { value: 'fabric', label: 'Fabric Warehouse (opt-in)' },
] as const;

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  toolbar: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, alignItems: 'end', minWidth: 0 },
  pane: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0,
    overflowY: 'auto',
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusLarge),
    ...shorthands.padding(tokens.spacingVerticalM, tokens.spacingHorizontalM),
    boxShadow: tokens.shadow4,
  },
  listRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0,
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalXS),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  listRowActive: { backgroundColor: tokens.colorBrandBackground2 },
  rowText: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  tags: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  field: { minWidth: '200px', flex: '1 1 200px' },
  muted: { color: tokens.colorNeutralForeground3 },
  bodyStack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
});

type Selection = { kind: 'model'; index: number } | { kind: 'source'; index: number } | null;

export interface ModelBuilderProps {
  project: TransformProject;
  onChange: (next: TransformProject) => void;
}

export function ModelBuilder({ project, onChange }: ModelBuilderProps) {
  const s = useStyles();
  const [selection, setSelection] = useState<Selection>(null);
  const [tab, setTab] = useState<'models' | 'settings'>('models');

  const models = project.models || [];
  const sources = project.sources || [];

  const commit = useCallback((patch: Partial<TransformProject>) => {
    onChange({ ...project, ...patch });
  }, [project, onChange]);

  const addSource = useCallback(() => {
    const next: TransformSource = { name: 'raw', schema: 'dbo', table: `table_${sources.length + 1}` };
    commit({ sources: [...sources, next] });
    setSelection({ kind: 'source', index: sources.length });
  }, [sources, commit]);

  const addModel = useCallback((layer: TransformLayer) => {
    const next: TransformModel = {
      name: `${layer}_model_${models.length + 1}`,
      layer,
      materialized: defaultMaterializationForLayer(layer),
      sql: 'SELECT 1 AS id',
      refs: [],
      sources: [],
      tests: [],
      cron: '@daily',
    };
    commit({ models: [...models, next] });
    setSelection({ kind: 'model', index: models.length });
  }, [models, commit]);

  const patchModel = useCallback((index: number, patch: Partial<TransformModel>) => {
    commit({ models: models.map((m, i) => (i === index ? { ...m, ...patch } : m)) });
  }, [models, commit]);

  const patchSource = useCallback((index: number, patch: Partial<TransformSource>) => {
    commit({ sources: sources.map((x, i) => (i === index ? { ...x, ...patch } : x)) });
  }, [sources, commit]);

  const removeSelected = useCallback(() => {
    if (!selection) return;
    if (selection.kind === 'model') commit({ models: models.filter((_m, i) => i !== selection.index) });
    else commit({ sources: sources.filter((_x, i) => i !== selection.index) });
    setSelection(null);
  }, [selection, models, sources, commit]);

  const sourceKeys = useMemo(() => sources.map((x) => `${x.name}.${x.table}`), [sources]);

  const selectedModel = selection?.kind === 'model' ? models[selection.index] : null;
  const selectedSource = selection?.kind === 'source' ? sources[selection.index] : null;

  return (
    <div className={s.root}>
      {/* Engine selector + target — the N4 backend switch. */}
      <div className={s.pane}>
        <Subtitle2>Engine</Subtitle2>
        <Caption1 className={s.muted}>
          dbt keeps the whole ecosystem — adapters, packages, generic tests, and the manifest that
          feeds Loom&apos;s column lineage. SQLMesh adds virtual data environments, plan/apply with
          real breaking vs non-breaking categorization, and column-level diff. The model graph below
          is identical either way.
        </Caption1>
        <div className={s.toolbar}>
          <Field label="Transformation engine" className={s.field}>
            <Dropdown
              value={project.backend === 'sqlmesh' ? 'SQLMesh' : 'dbt (default)'}
              selectedOptions={[project.backend]}
              onOptionSelect={(_e, d) => commit({ backend: String(d.optionValue) as TransformBackend })}
              aria-label="Transformation engine"
            >
              <Option value="dbt" text="dbt (default)">dbt (default) — dbt-core + the dbt ecosystem</Option>
              <Option value="sqlmesh" text="SQLMesh">SQLMesh — virtual environments, plan/apply, column diff</Option>
            </Dropdown>
          </Field>
          <Field label="Target engine" className={s.field}>
            <Dropdown
              value={ENGINES.find((e) => e.value === project.target?.engine)?.label || ''}
              selectedOptions={[project.target?.engine || 'synapse']}
              onOptionSelect={(_e, d) => commit({ target: { ...project.target, engine: String(d.optionValue) as TransformProject['target']['engine'] } })}
              aria-label="Target engine"
            >
              {ENGINES.map((e) => <Option key={e.value} value={e.value} text={e.label}>{e.label}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Default schema" className={s.field}>
            <Input
              value={project.target?.schema || ''}
              onChange={(_e, d) => commit({ target: { ...project.target, schema: d.value } })}
            />
          </Field>
        </div>
        {project.backend === 'sqlmesh' && (
          <div className={s.tags}>
            <Badge appearance="tint" color="brand">Virtual environments</Badge>
            <Badge appearance="tint" color="brand">Plan / apply</Badge>
            <Badge appearance="tint" color="brand">Column-level diff</Badge>
          </div>
        )}
      </div>

      <SplitPane
        direction="horizontal"
        defaultSize={300}
        minSize={220}
        maxSize={480}
        storageKey="transform.model-builder"
        dividerLabel="Resize the model list"
      >
        <div className={s.pane}>
          <TabList selectedValue={tab} onTabSelect={(_e, d) => setTab(d.value as 'models' | 'settings')}>
            <Tab value="models">Graph</Tab>
            <Tab value="settings">Environments</Tab>
          </TabList>
          {tab === 'models' ? (
            <>
              <div className={s.toolbar}>
                <Button size="small" icon={<DatabaseMultiple20Regular />} onClick={addSource}>Source</Button>
                {LAYERS.map((l) => (
                  <Button key={l} size="small" icon={<Add20Regular />} onClick={() => addModel(l)}>{l}</Button>
                ))}
              </div>
              <Divider />
              <Caption1 className={s.muted}>Sources</Caption1>
              {sources.length === 0 && <Caption1 className={s.muted}>None yet.</Caption1>}
              {sources.map((x, i) => (
                <div
                  key={`${x.name}.${x.table}.${i}`}
                  role="button"
                  tabIndex={0}
                  className={selection?.kind === 'source' && selection.index === i ? `${s.listRow} ${s.listRowActive}` : s.listRow}
                  onClick={() => setSelection({ kind: 'source', index: i })}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelection({ kind: 'source', index: i }); }}
                >
                  <DatabaseMultiple20Regular />
                  <Text className={s.rowText}>{x.name}.{x.table}</Text>
                </div>
              ))}
              <Divider />
              <Caption1 className={s.muted}>Models</Caption1>
              {models.length === 0 && <Caption1 className={s.muted}>None yet.</Caption1>}
              {models.map((m, i) => (
                <div
                  key={`${m.name}.${i}`}
                  role="button"
                  tabIndex={0}
                  className={selection?.kind === 'model' && selection.index === i ? `${s.listRow} ${s.listRowActive}` : s.listRow}
                  onClick={() => setSelection({ kind: 'model', index: i })}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelection({ kind: 'model', index: i }); }}
                >
                  <Table20Regular />
                  <Text className={s.rowText}>{m.name}</Text>
                  <Badge size="small" appearance="tint">{m.layer}</Badge>
                </div>
              ))}
            </>
          ) : (
            <div className={s.bodyStack}>
              <Caption1 className={s.muted}>
                {project.backend === 'sqlmesh'
                  ? 'Virtual environments this project plans against. Planning an environment that does not exist yet creates it as a view swap.'
                  : 'dbt has targets rather than virtual environments; these names are still used to label plan history. Switch the engine to SQLMesh for real environment isolation.'}
              </Caption1>
              {(project.environments || []).map((e, i) => (
                <div key={e.name} className={s.toolbar}>
                  <Field label={i === 0 ? 'Environment' : undefined} className={s.field}>
                    <Input
                      value={e.name}
                      onChange={(_ev, d) => commit({
                        environments: (project.environments || []).map((x, j) => (j === i ? { ...x, name: d.value } : x)),
                      })}
                    />
                  </Field>
                  {e.isProd && <Badge appearance="tint" color="danger">production</Badge>}
                  {!e.isProd && (
                    <Button
                      size="small"
                      icon={<Delete20Regular />}
                      appearance="subtle"
                      aria-label={`Remove environment ${e.name}`}
                      onClick={() => commit({ environments: (project.environments || []).filter((_x, j) => j !== i) })}
                    />
                  )}
                </div>
              ))}
              <Button
                size="small"
                icon={<Add20Regular />}
                onClick={() => commit({
                  environments: [...(project.environments || []), { name: `env_${(project.environments || []).length + 1}` }],
                })}
              >
                Add environment
              </Button>
              <Field label="Default environment" className={s.field}>
                <Dropdown
                  value={project.defaultEnvironment || ''}
                  selectedOptions={[project.defaultEnvironment || '']}
                  onOptionSelect={(_e, d) => commit({ defaultEnvironment: String(d.optionValue) })}
                  aria-label="Default environment"
                >
                  {(project.environments || []).map((e) => (
                    <Option key={e.name} value={e.name} text={e.name}>{e.name}</Option>
                  ))}
                </Dropdown>
              </Field>
            </div>
          )}
        </div>

        <div className={s.pane}>
          {!selection && (
            <EmptyState
              icon={<Table20Regular />}
              title="Nothing selected"
              body="Add a source or a model from the list, then select it to configure its layer, materialization, refresh cadence, upstream references, and tests. The SQL body is the one place you write freeform — everything else is a picker."
              primaryAction={{ label: 'Add a silver model', onClick: () => addModel('silver'), appearance: 'primary' }}
              secondaryAction={{ label: 'Add a source', onClick: addSource }}
            />
          )}

          {selectedSource && selection?.kind === 'source' && (
            <>
              <Subtitle2>Source</Subtitle2>
              <div className={s.toolbar}>
                <Field label="Group" className={s.field}>
                  <Input value={selectedSource.name} onChange={(_e, d) => patchSource(selection.index, { name: d.value })} />
                </Field>
                <Field label="Schema" className={s.field}>
                  <Input value={selectedSource.schema} onChange={(_e, d) => patchSource(selection.index, { schema: d.value })} />
                </Field>
                <Field label="Table" className={s.field}>
                  <Input value={selectedSource.table} onChange={(_e, d) => patchSource(selection.index, { table: d.value })} />
                </Field>
              </div>
              <Field label="Description">
                <Textarea
                  value={selectedSource.description || ''}
                  onChange={(_e, d) => patchSource(selection.index, { description: d.value })}
                  resize="vertical"
                />
              </Field>
              <Button icon={<Delete20Regular />} appearance="subtle" onClick={removeSelected}>Remove source</Button>
            </>
          )}

          {selectedModel && selection?.kind === 'model' && (
            <>
              <Subtitle2>Model</Subtitle2>
              <div className={s.toolbar}>
                <Field label="Name" className={s.field}>
                  <Input value={selectedModel.name} onChange={(_e, d) => patchModel(selection.index, { name: d.value })} />
                </Field>
                <Field label="Layer" className={s.field}>
                  <Dropdown
                    value={selectedModel.layer}
                    selectedOptions={[selectedModel.layer]}
                    onOptionSelect={(_e, d) => patchModel(selection.index, {
                      layer: String(d.optionValue) as TransformLayer,
                      materialized: defaultMaterializationForLayer(String(d.optionValue) as TransformLayer),
                    })}
                    aria-label="Medallion layer"
                  >
                    {LAYERS.map((l) => <Option key={l} value={l} text={l}>{l}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Materialization" className={s.field}>
                  <Dropdown
                    value={selectedModel.materialized}
                    selectedOptions={[selectedModel.materialized]}
                    onOptionSelect={(_e, d) => patchModel(selection.index, { materialized: String(d.optionValue) as TransformMaterialization })}
                    aria-label="Materialization"
                  >
                    {MATERIALIZATIONS.map((m) => <Option key={m} value={m} text={m}>{m}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Refresh cadence" className={s.field}>
                  <Dropdown
                    value={selectedModel.cron || '@daily'}
                    selectedOptions={[selectedModel.cron || '@daily']}
                    onOptionSelect={(_e, d) => patchModel(selection.index, { cron: String(d.optionValue) as TransformModel['cron'] })}
                    aria-label="Refresh cadence"
                  >
                    {CADENCES.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
                  </Dropdown>
                </Field>
              </div>
              {selectedModel.materialized === 'incremental' && (
                <Field label="Unique key (merge key)" className={s.field}>
                  <Input
                    value={selectedModel.uniqueKey || ''}
                    onChange={(_e, d) => patchModel(selection.index, { uniqueKey: d.value })}
                  />
                </Field>
              )}
              <Field label="Upstream models (ref)">
                <Dropdown
                  multiselect
                  placeholder="Select upstream models"
                  selectedOptions={selectedModel.refs || []}
                  onOptionSelect={(_e, d) => patchModel(selection.index, { refs: d.selectedOptions })}
                  aria-label="Upstream models"
                >
                  {models.filter((m) => m.name !== selectedModel.name).map((m) => (
                    <Option key={m.name} value={m.name} text={m.name}>{m.name}</Option>
                  ))}
                </Dropdown>
              </Field>
              <Field label="Upstream sources">
                <Dropdown
                  multiselect
                  placeholder="Select upstream sources"
                  selectedOptions={selectedModel.sources || []}
                  onOptionSelect={(_e, d) => patchModel(selection.index, { sources: d.selectedOptions })}
                  aria-label="Upstream sources"
                >
                  {sourceKeys.map((k) => <Option key={k} value={k} text={k}>{k}</Option>)}
                </Dropdown>
              </Field>
              <Field label="Owner" className={s.field}>
                <Input
                  value={(selectedModel.owners || [])[0] || ''}
                  placeholder="team or alias"
                  onChange={(_e, d) => patchModel(selection.index, { owners: d.value ? [d.value] : [] })}
                />
              </Field>
              {(selectedModel.tags || []).length > 0 && (
                <TagGroup className={s.tags} aria-label="Model tags">
                  {(selectedModel.tags || []).map((t) => <Tag key={t} size="small">{t}</Tag>)}
                </TagGroup>
              )}
              <Divider />
              <Body1>SQL</Body1>
              <Caption1 className={s.muted}>
                The one freeform surface. Use <code>{'{{ ref(\'model\') }}'}</code> and{' '}
                <code>{'{{ source(\'group\',\'table\') }}'}</code> — Loom rewrites them for whichever
                engine the project targets.
              </Caption1>
              <MonacoTextarea
                value={selectedModel.sql}
                onChange={(next) => patchModel(selection.index, { sql: next })}
                language="sql"
                sizingKey="transform-model-sql"
                height={260}
                ariaLabel={`SQL for ${selectedModel.name}`}
              />
              <Button icon={<Delete20Regular />} appearance="subtle" onClick={removeSelected}>Remove model</Button>
            </>
          )}
        </div>
      </SplitPane>
    </div>
  );
}
