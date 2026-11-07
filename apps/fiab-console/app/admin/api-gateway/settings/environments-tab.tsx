'use client';

/**
 * Settings -> Environments (W1-4, ADR-008). Catalog list + detail editor in a
 * SplitPane (persisted size), the require-classification switch, the derived
 * compatibility matrix, and one-click tag suggestions. Every verdict shown here
 * comes from the matrix route; the console never reimplements permits().
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Badge, Body1, Button, Caption1, Field, Input, MessageBar, MessageBarBody, MessageBarTitle, Spinner, Subtitle2,
  Switch, Table, TableBody, TableCell, TableCellLayout, TableHeader, TableHeaderCell, TableRow, Textarea, Tooltip,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, CheckmarkCircle20Filled, DeleteRegular, ErrorCircle20Filled, ShieldCheckmark24Regular, Warning20Filled,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { SplitPane } from '@/lib/components/shared/split-pane';
import type { EnvironmentDef, Verdict } from '@/lib/api-gateway/environments/types';
import {
  call, getCatalog, getMatrix, getSuggestions, type ApiResult, type Blocking, type CatalogData, type MatrixData, type SuggestionsData,
} from './api';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0,
    padding: tokens.spacingHorizontalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
  },
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', minWidth: 0 },
  grow: { flexGrow: 1, minWidth: 0 },
  split: { minHeight: '360px', height: '420px', minWidth: 0 },
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, padding: tokens.spacingHorizontalS, minWidth: 0, overflowY: 'auto', height: '100%' },
  row: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0, textAlign: 'left', cursor: 'pointer',
    padding: tokens.spacingHorizontalM, borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    ':hover': { boxShadow: tokens.shadow8 },
  },
  rowSelected: { border: `1px solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2 },
  badges: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 },
  detail: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingHorizontalL, minWidth: 0, overflowY: 'auto', height: '100%' },
  muted: { color: tokens.colorNeutralForeground3 },
  matrixWrap: { overflowX: 'auto', minWidth: 0 },
  cellAllowed: { color: tokens.colorPaletteGreenForeground1 },
  cellWarning: { color: tokens.colorPaletteYellowForeground2 },
  cellBlocked: { color: tokens.colorPaletteRedForeground1 },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
});

function VerdictIcon({ v }: { v: Verdict }) {
  const s = useStyles();
  const label = `${v.level}: ${v.message}`;
  return (
    <Tooltip content={label} relationship="description">
      <span aria-label={label} className={mergeClasses(v.level === 'allowed' && s.cellAllowed, v.level === 'warning' && s.cellWarning, v.level === 'blocked' && s.cellBlocked)}>
        {v.level === 'allowed' ? <CheckmarkCircle20Filled /> : v.level === 'warning' ? <Warning20Filled /> : <ErrorCircle20Filled />}
      </span>
    </Tooltip>
  );
}

function Refusal({ title, error, blocking }: { title: string; error: string; blocking?: Blocking[] }) {
  return (
    <MessageBar intent="error">
      <MessageBarBody>
        <MessageBarTitle>{title}</MessageBarTitle>
        {error}
        {blocking && blocking.length > 0 && (
          <ul>{blocking.map((b) => <li key={b.id}>{b.displayName}: {b.reason}</li>)}</ul>
        )}
      </MessageBarBody>
    </MessageBar>
  );
}

const csv = (v: string): string[] => v.split(',').map((x) => x.trim()).filter(Boolean);

function EnvDetail({ env, all, usage, onChanged }: { env: EnvironmentDef; all: EnvironmentDef[]; usage: number; onChanged: () => void }) {
  const s = useStyles();
  const [name, setName] = useState(env.displayName);
  const [desc, setDesc] = useState(env.description);
  const [aliases, setAliases] = useState(env.aliases.join(', '));
  const [exceptions, setExceptions] = useState(env.exceptions.join(', '));
  const [prod, setProd] = useState(env.isProductionClass);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<ApiResult<unknown> | null>(null);

  const save = async () => {
    setBusy(true);
    const r = await call(`/${encodeURIComponent(env.key)}`, { method: 'PUT', body: { displayName: name, description: desc, aliases: csv(aliases), exceptions: csv(exceptions), isProductionClass: prod } });
    setBusy(false);
    setFail(r.ok ? null : r);
    if (r.ok) onChanged();
  };
  const remove = async () => {
    setBusy(true);
    const r = await call(`/${encodeURIComponent(env.key)}`, { method: 'DELETE' });
    setBusy(false);
    setFail(r.ok ? null : r);
    if (r.ok) onChanged();
  };

  return (
    <div className={s.detail}>
      <div className={s.header}>
        <Subtitle2 className={s.grow}>{env.displayName}</Subtitle2>
        <div className={s.badges}>
          <Badge appearance="tint" color={env.badgeColor}>{env.key}</Badge>
          {env.builtIn && <Badge appearance="outline">Built in</Badge>}
          <Badge appearance="outline">{usage} in use</Badge>
        </div>
      </div>
      {fail && <Refusal title="Not saved" error={fail.error ?? 'The change was refused.'} blocking={fail.blocking} />}
      <Field label="Display name"><Input value={name} onChange={(_, d) => setName(d.value)} /></Field>
      <Field label="Description"><Textarea value={desc} onChange={(_, d) => setDesc(d.value)} resize="vertical" /></Field>
      <Switch checked={prod} onChange={(_, d) => setProd(d.checked)} label="Production-class" />
      <Field label="Aliases" hint="Comma-separated. Used only to suggest this environment from Azure tags."><Input value={aliases} onChange={(_, d) => setAliases(d.value)} /></Field>
      <Field label="Exceptions" hint={`Environment keys whose resources this environment's gateways may front. Available: ${all.filter((e) => e.key !== env.key).map((e) => e.key).join(', ')}.`}>
        <Input value={exceptions} onChange={(_, d) => setExceptions(d.value)} />
      </Field>
      <div className={s.actions}>
        <Button appearance="primary" disabled={busy} onClick={save}>Save changes</Button>
        {!env.builtIn && <Button icon={<DeleteRegular />} disabled={busy} onClick={remove}>Delete</Button>}
      </div>
    </div>
  );
}

function AddEnvironment({ onAdded }: { onAdded: () => void }) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [fail, setFail] = useState<string | null>(null);
  if (!open) return <Button icon={<Add20Regular />} onClick={() => setOpen(true)}>Add environment</Button>;
  const add = async () => {
    const r = await call('', { method: 'POST', body: { displayName: name } });
    if (r.ok) { setOpen(false); setName(''); setFail(null); onAdded(); } else setFail(r.error ?? 'Could not add the environment.');
  };
  return (
    <div className={s.actions}>
      <Field validationMessage={fail ?? undefined} validationState={fail ? 'error' : 'none'}>
        <Input placeholder="Environment name" value={name} onChange={(_, d) => setName(d.value)} />
      </Field>
      <Button appearance="primary" disabled={!name.trim()} onClick={add}>Add</Button>
      <Button onClick={() => { setOpen(false); setFail(null); }}>Cancel</Button>
    </div>
  );
}

export function EnvironmentsTab() {
  const s = useStyles();
  const [catalog, setCatalog] = useState<ApiResult<CatalogData> | null>(null);
  const [matrix, setMatrix] = useState<ApiResult<MatrixData> | null>(null);
  const [sugg, setSugg] = useState<ApiResult<SuggestionsData> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [fail, setFail] = useState<ApiResult<unknown> | null>(null);

  const load = useCallback(async () => {
    const [c, m, g] = await Promise.all([getCatalog(), getMatrix(), getSuggestions()]);
    setCatalog(c); setMatrix(m); setSugg(g);
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (!catalog) return <Spinner label="Loading environments" />;
  if (!catalog.ok || !catalog.data) {
    return <Refusal title="Could not load environments" error={catalog.error ?? 'The environment catalog is unavailable.'} />;
  }
  const { environments, settings, usage, unclassified, registryAvailable } = catalog.data;
  const current = environments.find((e) => e.key === selected) ?? environments[0];
  const nameOf = (k: string | null) => (k === null ? 'Unclassified' : environments.find((e) => e.key === k)?.displayName ?? k);

  const toggleRequire = async (checked: boolean) => {
    const r = await call('', { method: 'PUT', body: { requireClassification: checked } });
    setFail(r.ok ? null : r);
    await load();
  };
  const applySuggestion = async (kind: string, id: string, environmentKey: string) => {
    const r = await call('/reclassify', { method: 'POST', body: { changes: [{ kind, id, environmentKey }] } });
    setFail(r.ok ? null : r);
    await load();
  };

  return (
    <div className={s.root}>
      {fail && <Refusal title="Not applied" error={fail.error ?? 'The change was refused.'} blocking={fail.blocking} />}

      <div className={s.card}>
        <div className={s.header}>
          <ShieldCheckmark24Regular />
          <div className={s.grow}>
            <Subtitle2>Require classification</Subtitle2>
            <Body1 className={s.muted}> Block any pairing that involves an unclassified gateway or resource. Refused if it would block an applied publication.</Body1>
          </div>
          <Switch checked={settings.requireClassification} onChange={(_, d) => void toggleRequire(d.checked)} label={settings.requireClassification ? 'On' : 'Off'} />
        </div>
        <Caption1 className={s.muted}>{unclassified} unclassified {unclassified === 1 ? 'resource' : 'resources'}.</Caption1>
      </div>

      <div className={s.card}>
        <div className={s.header}>
          <Subtitle2 className={s.grow}>Environment catalog</Subtitle2>
          <AddEnvironment onAdded={load} />
        </div>
        <div className={s.split}>
          <SplitPane direction="horizontal" storageKey="apigw-settings-environments" defaultSize={280} minSize={200}>
            <div className={s.list} role="listbox" aria-label="Environments">
              {environments.map((e) => (
                <button key={e.key} type="button" role="option" aria-selected={e.key === current.key} className={mergeClasses(s.row, e.key === current.key && s.rowSelected)} onClick={() => setSelected(e.key)}>
                  <Body1>{e.displayName}</Body1>
                  <span className={s.badges}>
                    <Badge appearance="tint" color={e.badgeColor}>{e.key}</Badge>
                    {e.isProductionClass && <Badge appearance="filled" color="danger">Production-class</Badge>}
                    <Badge appearance="outline">{usage[e.key] ?? 0} in use</Badge>
                  </span>
                </button>
              ))}
            </div>
            <EnvDetail key={`${current.key}:${JSON.stringify(current)}`} env={current} all={environments} usage={usage[current.key] ?? 0} onChanged={load} />
          </SplitPane>
        </div>
      </div>

      <div className={s.card}>
        <Subtitle2>Compatibility matrix</Subtitle2>
        <Caption1 className={s.muted}>Rows are the gateway&apos;s environment, columns the resource it fronts. Hover a cell for the plain-language reason.</Caption1>
        {matrix?.ok && matrix.data ? (
          <div className={s.matrixWrap}>
            <Table size="small" aria-label="Environment compatibility matrix">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Gateway \ Resource</TableHeaderCell>
                  {matrix.data.keys.map((k) => <TableHeaderCell key={k ?? 'unclassified'}>{nameOf(k)}</TableHeaderCell>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {matrix.data.keys.map((g) => (
                  <TableRow key={g ?? 'unclassified'}>
                    <TableCell><TableCellLayout>{nameOf(g)}</TableCellLayout></TableCell>
                    {matrix.data!.keys.map((r) => {
                      const cell = matrix.data!.cells.find((c) => c.gatewayEnv === g && c.resourceEnv === r);
                      return <TableCell key={r ?? 'unclassified'}>{cell && <VerdictIcon v={cell.verdict} />}</TableCell>;
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : <Spinner label="Loading matrix" />}
      </div>

      <div className={s.card}>
        <Subtitle2>Suggestions from Azure tags</Subtitle2>
        <Caption1 className={s.muted}>An <code>environment</code> or <code>env</code> tag is a hint, never a decision. Nothing changes until you apply it, and tags are never written back.</Caption1>
        {sugg?.ok && sugg.data && sugg.data.suggestions.length > 0 ? (
          sugg.data.suggestions.map((x) => (
            <div key={`${x.resourceKind}:${x.resourceId}`} className={s.header}>
              <div className={s.grow}>
                <Body1>{x.displayName}</Body1>
                <span className={s.badges}>
                  <Badge appearance="outline">{x.tagName}={x.tagValue}</Badge>
                  <Badge appearance="tint" color="brand">suggest {nameOf(x.environmentKey)}</Badge>
                </span>
              </div>
              <Button size="small" appearance="primary" onClick={() => void applySuggestion(x.resourceKind, x.resourceId, x.environmentKey)}>Apply</Button>
            </div>
          ))
        ) : (
          <EmptyState
            icon={<ShieldCheckmark24Regular />}
            title={registryAvailable ? 'No suggestions' : 'No gateways registered yet'}
            body={registryAvailable ? 'No unclassified gateway carries an environment or env tag that matches the catalog.' : 'Register a gateway and Loom will suggest its environment from its Azure tags.'}
          />
        )}
      </div>
    </div>
  );
}
