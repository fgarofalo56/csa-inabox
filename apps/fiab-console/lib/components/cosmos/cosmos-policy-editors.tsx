'use client';

/**
 * Form-driven editors for Cosmos container policies — included/excluded index
 * paths, composite-index groups, and unique-key constraints. These are the
 * one-for-one replacement for the portal Data Explorer's policy panels.
 *
 * Hard rule (loom_no_freeform_config): NO raw JSON textareas. Every policy is
 * built from labelled rows + dropdowns; the client serialises to the ARM
 * `properties.resource.indexingPolicy` / `uniqueKeyPolicy` shape.
 */

import {
  Button, Input, Dropdown, Option, Caption1, Field, Badge,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add16Regular, Delete16Regular } from '@fluentui/react-icons';
import type {
  IndexingPath, CompositePath, CosmosUniqueKeyPolicy,
} from '@/lib/azure/cosmos-account-client';

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: 8 },
  rows: { display: 'flex', flexDirection: 'column', gap: 6 },
  row: { display: 'flex', alignItems: 'center', gap: 6 },
  pathInput: { flex: 1 },
  group: {
    display: 'flex', flexDirection: 'column', gap: 6,
    padding: 8, borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  groupHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  orderDd: { minWidth: 130 },
  note: { color: tokens.colorNeutralForeground3 },
  addBtn: { alignSelf: 'flex-start' },
});

// ---------------------------------------------------------------------------
// Included / excluded path rows
// ---------------------------------------------------------------------------

export function PathRowsEditor({
  label, paths, onChange, placeholder = '/*', disabled,
}: {
  label: string;
  paths: IndexingPath[];
  onChange: (next: IndexingPath[]) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const s = useStyles();
  const setAt = (i: number, value: string) => {
    const next = paths.slice();
    next[i] = { path: value };
    onChange(next);
  };
  return (
    <div className={s.section}>
      <Field label={label} />
      <div className={s.rows}>
        {paths.length === 0 && <Caption1 className={s.note}>No paths — add one below.</Caption1>}
        {paths.map((p, i) => (
          <div className={s.row} key={i}>
            <Input
              className={s.pathInput}
              size="small"
              value={p.path}
              placeholder={placeholder}
              disabled={disabled}
              onChange={(_, d) => setAt(i, d.value)}
              aria-label={`${label} path ${i + 1}`}
            />
            <Button
              size="small" appearance="subtle" icon={<Delete16Regular />}
              disabled={disabled}
              aria-label={`Remove ${label} path ${i + 1}`}
              onClick={() => onChange(paths.filter((_, j) => j !== i))}
            />
          </div>
        ))}
      </div>
      <Button
        className={s.addBtn} size="small" appearance="subtle" icon={<Add16Regular />}
        disabled={disabled}
        onClick={() => onChange([...paths, { path: '' }])}
      >
        Add path
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composite-index groups (each group = ordered list of {path, order})
// ---------------------------------------------------------------------------

export function CompositeIndexEditor({
  groups, onChange, disabled,
}: {
  groups: CompositePath[][];
  onChange: (next: CompositePath[][]) => void;
  disabled?: boolean;
}) {
  const s = useStyles();

  const updateGroup = (gi: number, next: CompositePath[]) => {
    const out = groups.slice();
    out[gi] = next;
    onChange(out);
  };
  const setPath = (gi: number, pi: number, value: string) => {
    const g = groups[gi].slice();
    g[pi] = { ...g[pi], path: value };
    updateGroup(gi, g);
  };
  const setOrder = (gi: number, pi: number, order: 'ascending' | 'descending') => {
    const g = groups[gi].slice();
    g[pi] = { ...g[pi], order };
    updateGroup(gi, g);
  };

  return (
    <div className={s.section}>
      <Field label="Composite indexes" />
      <Caption1 className={s.note}>
        Each composite index is an ordered set of paths (used to satisfy <code>ORDER BY</code> on
        multiple properties or filter+sort queries).
      </Caption1>
      {groups.length === 0 && <Caption1 className={s.note}>No composite indexes.</Caption1>}
      {groups.map((group, gi) => (
        <div className={s.group} key={gi}>
          <div className={s.groupHead}>
            <Badge appearance="tint">Composite index {gi + 1}</Badge>
            <Button
              size="small" appearance="subtle" icon={<Delete16Regular />}
              disabled={disabled}
              aria-label={`Remove composite index ${gi + 1}`}
              onClick={() => onChange(groups.filter((_, j) => j !== gi))}
            >
              Remove group
            </Button>
          </div>
          {group.map((p, pi) => (
            <div className={s.row} key={pi}>
              <Input
                className={s.pathInput}
                size="small"
                value={p.path}
                placeholder="/name"
                disabled={disabled}
                onChange={(_, d) => setPath(gi, pi, d.value)}
                aria-label={`Composite ${gi + 1} path ${pi + 1}`}
              />
              <Dropdown
                className={s.orderDd}
                size="small"
                value={p.order === 'descending' ? 'Descending' : 'Ascending'}
                selectedOptions={[p.order || 'ascending']}
                disabled={disabled}
                aria-label={`Composite ${gi + 1} path ${pi + 1} order`}
                onOptionSelect={(_, d) => setOrder(gi, pi, (d.optionValue as 'ascending' | 'descending') || 'ascending')}
              >
                <Option value="ascending" text="Ascending">Ascending</Option>
                <Option value="descending" text="Descending">Descending</Option>
              </Dropdown>
              <Button
                size="small" appearance="subtle" icon={<Delete16Regular />}
                disabled={disabled || group.length <= 1}
                aria-label={`Remove composite ${gi + 1} path ${pi + 1}`}
                onClick={() => updateGroup(gi, group.filter((_, j) => j !== pi))}
              />
            </div>
          ))}
          <Button
            className={s.addBtn} size="small" appearance="subtle" icon={<Add16Regular />}
            disabled={disabled}
            onClick={() => updateGroup(gi, [...group, { path: '', order: 'ascending' }])}
          >
            Add path to group
          </Button>
        </div>
      ))}
      <Button
        className={s.addBtn} size="small" appearance="subtle" icon={<Add16Regular />}
        disabled={disabled}
        onClick={() => onChange([...groups, [{ path: '', order: 'ascending' }]])}
      >
        Add composite index
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unique-key constraints (each key = one or more paths) — create-time only
// ---------------------------------------------------------------------------

export function UniqueKeysEditor({
  policy, onChange, disabled,
}: {
  policy: CosmosUniqueKeyPolicy;
  onChange: (next: CosmosUniqueKeyPolicy) => void;
  disabled?: boolean;
}) {
  const s = useStyles();
  const keys = policy.uniqueKeys;

  const updateKey = (ki: number, paths: string[]) => {
    const out = keys.slice();
    out[ki] = { paths };
    onChange({ uniqueKeys: out });
  };
  const setPath = (ki: number, pi: number, value: string) => {
    const p = keys[ki].paths.slice();
    p[pi] = value;
    updateKey(ki, p);
  };

  return (
    <div className={s.section}>
      <Field label="Unique keys" />
      <Caption1 className={s.note}>
        A unique key constraint guarantees uniqueness of one or more values per partition key.
        Constraints are <strong>immutable</strong> — they can only be set at container creation.
      </Caption1>
      {keys.length === 0 && <Caption1 className={s.note}>No unique-key constraints.</Caption1>}
      {keys.map((k, ki) => (
        <div className={s.group} key={ki}>
          <div className={s.groupHead}>
            <Badge appearance="tint">Unique key {ki + 1}</Badge>
            <Button
              size="small" appearance="subtle" icon={<Delete16Regular />}
              disabled={disabled}
              aria-label={`Remove unique key ${ki + 1}`}
              onClick={() => onChange({ uniqueKeys: keys.filter((_, j) => j !== ki) })}
            >
              Remove key
            </Button>
          </div>
          {k.paths.map((p, pi) => (
            <div className={s.row} key={pi}>
              <Input
                className={s.pathInput}
                size="small"
                value={p}
                placeholder="/email"
                disabled={disabled}
                onChange={(_, d) => setPath(ki, pi, d.value)}
                aria-label={`Unique key ${ki + 1} path ${pi + 1}`}
              />
              <Button
                size="small" appearance="subtle" icon={<Delete16Regular />}
                disabled={disabled || k.paths.length <= 1}
                aria-label={`Remove unique key ${ki + 1} path ${pi + 1}`}
                onClick={() => updateKey(ki, k.paths.filter((_, j) => j !== pi))}
              />
            </div>
          ))}
          <Button
            className={s.addBtn} size="small" appearance="subtle" icon={<Add16Regular />}
            disabled={disabled}
            onClick={() => updateKey(ki, [...k.paths, ''])}
          >
            Add path
          </Button>
        </div>
      ))}
      <Button
        className={s.addBtn} size="small" appearance="subtle" icon={<Add16Regular />}
        disabled={disabled}
        onClick={() => onChange({ uniqueKeys: [...keys, { paths: [''] }] })}
      >
        Add unique key
      </Button>
    </div>
  );
}
