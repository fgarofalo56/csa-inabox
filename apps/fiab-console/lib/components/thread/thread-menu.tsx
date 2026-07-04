'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * ThreadMenu — the universal "Weave" action on every Loom editor.
 *
 * Rendered once in `item-editor-chrome.tsx`, so all ~120 editors get it. It shows
 * the Thread integration edges available for the current item type (grouped),
 * and opens a wizard Drawer whose every input is a dropdown/picker populated from
 * a REAL discovery route (no freeform connection strings — loom-no-freeform-config).
 * Submitting POSTs to the action's BFF route and shows the real result + a deep
 * link to the produced/updated item (no-vaporware).
 */

import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import {
  Button, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuGroup, MenuGroupHeader,
  Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Field, Dropdown, Option, Input, Textarea, Switch, Spinner, Badge,
  MessageBar, MessageBarBody, MessageBarTitle, Caption1, Body1,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Branch20Regular, Dismiss24Regular, Bot20Regular, DataBarVertical20Regular,
  Open16Regular, Sparkle20Regular, Notebook20Regular, PlugConnected20Regular,
} from '@fluentui/react-icons';
import { groupedActionsFor, type ThreadAction, type ThreadField } from '@/lib/thread/thread-actions';

const useStyles = makeStyles({
  drawer: { width: '460px', maxWidth: '92vw' },
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, paddingBottom: tokens.spacingVerticalXXL },
  intro: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  actionsBar: { display: 'flex', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalM },
  result: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  link: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
});

function actionIcon(icon?: string) {
  if (icon === 'bot') return <Bot20Regular />;
  if (icon === 'chart') return <DataBarVertical20Regular />;
  if (icon === 'notebook') return <Notebook20Regular />;
  if (icon === 'api') return <PlugConnected20Regular />;
  return <Sparkle20Regular />;
}

interface LoomItemOpt { id: string; name: string }

/** One wizard field, populated from real discovery routes. */
function ThreadFieldControl({
  field, value, onChange, from,
}: {
  field: ThreadField;
  value: string | boolean | undefined;
  onChange: (v: string | boolean) => void;
  from: { id: string; type: string; name: string };
}) {
  const [opts, setOpts] = useState<{ value: string; label: string }[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        if (field.kind === 'loom-item' && field.itemTypes?.length) {
          const r = await clientFetch(`/api/items/by-type?types=${encodeURIComponent(field.itemTypes.join(','))}`);
          const j = await r.json();
          const items: LoomItemOpt[] = (j.items || []).map((it: any) => ({ id: it.id, name: it.displayName || it.id }));
          const base = items.map((it) => ({ value: it.id, label: it.name }));
          if (!cancelled) setOpts(field.allowCreate ? [{ value: '__new__', label: field.createLabel || '+ Create new' }, ...base] : base);
        } else if (field.kind === 'select' && field.optionsRoute) {
          // Substitute source-item tokens so a field can discover from the item.
          const route = field.optionsRoute
            .replace('{fromId}', encodeURIComponent(from.id))
            .replace('{fromType}', encodeURIComponent(from.type));
          const r = await fetch(route);
          const j = await r.json();
          // Honest discovery gate (route returned ok:false with a reason).
          if (j?.ok === false) {
            if (!cancelled) { setLoadErr(j.error || j.gate?.missing || `HTTP ${r.status}`); setOpts([]); }
            return;
          }
          let mapped: { value: string; label: string }[] = [];
          if (field.optionsMap === 'powerbi-workspaces') {
            const list = j.workspaces || j.value || j.data || [];
            mapped = list.map((w: any) => ({ value: w.id || w.workspaceId, label: w.name || w.displayName || w.id }));
          } else if (Array.isArray(j.options)) {
            mapped = j.options;
          }
          if (!cancelled) setOpts(mapped);
        } else if (field.kind === 'select' && field.options) {
          if (!cancelled) setOpts(field.options);
        }
      } catch (e: any) {
        if (!cancelled) setLoadErr(e?.message || String(e));
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [field, from.id, from.type]);

  if (field.kind === 'toggle') {
    return (
      <Field label={field.label} hint={field.hint}>
        <Switch checked={value === true} onChange={(_, d) => onChange(d.checked)} />
      </Field>
    );
  }
  if (field.kind === 'text') {
    return (
      <Field label={field.label} hint={field.hint} required={field.required}>
        <Input value={typeof value === 'string' ? value : ''} onChange={(_, d) => onChange(d.value)} />
      </Field>
    );
  }
  if (field.kind === 'textarea') {
    return (
      <Field label={field.label} hint={field.hint} required={field.required}>
        <Textarea
          value={typeof value === 'string' ? value : ''}
          onChange={(_, d) => onChange(d.value)}
          resize="vertical"
          textarea={{ style: { fontFamily: 'Consolas, monospace', minHeight: '120px' } }}
        />
      </Field>
    );
  }
  // loom-item or select → Dropdown from real discovery
  const selected = typeof value === 'string' ? value : '';
  const selLabel = opts?.find((o) => o.value === selected)?.label;
  return (
    <Field label={field.label} hint={field.hint} required={field.required}
      validationMessage={loadErr ? `Could not load options: ${loadErr}` : undefined}
      validationState={loadErr ? 'error' : 'none'}>
      <Dropdown
        placeholder={opts == null ? 'Loading…' : opts.length ? 'Select…' : 'No options available'}
        disabled={opts == null || opts.length === 0}
        value={selLabel || ''}
        selectedOptions={selected ? [selected] : []}
        onOptionSelect={(_, d) => onChange(d.optionValue || '')}
      >
        {(opts || []).map((o) => <Option key={o.value} value={o.value} text={o.label}>{o.label}</Option>)}
      </Dropdown>
    </Field>
  );
}

function visible(field: ThreadField, values: Record<string, string | boolean>): boolean {
  if (!field.showWhen) return true;
  return values[field.showWhen.field] === field.showWhen.equals;
}

function ThreadWizard({
  action, from, onClose,
}: {
  action: ThreadAction;
  from: { id: string; type: string; name: string };
  onClose: () => void;
}) {
  const styles = useStyles();
  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    const v: Record<string, string | boolean> = {};
    for (const f of action.fields) if (f.default !== undefined) v[f.name] = f.default;
    return v;
  });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message?: string; error?: string; link?: string; linkLabel?: string } | null>(null);

  const shown = action.fields.filter((f) => visible(f, values));
  const missing = shown.some((f) => f.required && !values[f.name]);

  const submit = useCallback(async () => {
    setSubmitting(true); setResult(null);
    try {
      const r = await fetch(action.route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from, values }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) {
        setResult({ ok: false, error: j?.error || j?.hint || `HTTP ${r.status}` });
        return;
      }
      setResult({ ok: true, message: j.message || 'Woven successfully.', link: j.link, linkLabel: j.linkLabel || 'Open' });
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
    } finally { setSubmitting(false); }
  }, [action.route, from, values]);

  return (
    <div className={styles.body}>
      <div className={styles.intro}>
        <Body1>{action.description}</Body1>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Source: <strong>{from.name}</strong> <Badge appearance="tint" size="small" color="brand">{from.type}</Badge>
        </Caption1>
      </div>

      {shown.map((f) => (
        <ThreadFieldControl
          key={f.name}
          field={f}
          value={values[f.name]}
          onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: v }))}
          from={from}
        />
      ))}

      {result && (
        <MessageBar intent={result.ok ? 'success' : 'error'}>
          <MessageBarBody className={styles.result}>
            <MessageBarTitle>{result.ok ? 'Woven' : 'Could not weave'}</MessageBarTitle>
            {result.ok ? result.message : result.error}
            {result.ok && result.link && (
              <a className={styles.link} href={result.link}>{result.linkLabel} <Open16Regular /></a>
            )}
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.actionsBar}>
        <Button appearance="primary" icon={<Branch20Regular />} disabled={submitting || missing} onClick={submit}>
          {submitting ? 'Weaving…' : (action.submitLabel || 'Weave')}
        </Button>
        <Button appearance="subtle" onClick={onClose}>{result?.ok ? 'Done' : 'Cancel'}</Button>
      </div>
    </div>
  );
}

export function ThreadMenu({ type, id, name }: { type: string; id: string; name?: string }) {
  const styles = useStyles();
  const groups = groupedActionsFor(type);
  const [active, setActive] = useState<ThreadAction | null>(null);

  if (groups.length === 0) return null; // no Thread edges for this type yet — show nothing (no dead button)

  const from = { id, type, name: name || id };

  return (
    <>
      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <Button appearance="subtle" icon={<Branch20Regular />} title="Weave this item into another Loom service">Weave</Button>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            {groups.map((g) => (
              <MenuGroup key={g.group}>
                <MenuGroupHeader>{g.group}</MenuGroupHeader>
                {g.actions.map((a) => (
                  <MenuItem key={a.id} icon={actionIcon(a.icon)} onClick={() => setActive(a)}>{a.label}</MenuItem>
                ))}
              </MenuGroup>
            ))}
          </MenuList>
        </MenuPopover>
      </Menu>

      <Drawer type="overlay" position="end" open={!!active} onOpenChange={(_, d) => { if (!d.open) setActive(null); }} className={styles.drawer}>
        <DrawerHeader>
          <DrawerHeaderTitle action={<Button appearance="subtle" icon={<Dismiss24Regular />} onClick={() => setActive(null)} aria-label="Close" />}>
            {active?.label}
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          {active && <ThreadWizard action={active} from={from} onClose={() => setActive(null)} />}
        </DrawerBody>
      </Drawer>
    </>
  );
}
