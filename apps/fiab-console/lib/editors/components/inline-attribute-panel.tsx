'use client';

/**
 * Inline attribute panels for the data-product details right rail — a 1:1 of
 * the Microsoft Purview Unified Catalog data-product details page attributes:
 *
 *   SelectAttributePanel   → F5  Update frequency (single-select, dirty-check)
 *   LinkListAttributePanel  → F11 Terms of use / F12 Documentation (add+remove)
 *
 * Each panel renders a read view with an Edit affordance; editing happens inline
 * (no modal) exactly like the portal. Every mutation calls an async on*-handler
 * supplied by the parent that performs the real PATCH and returns an AttrReceipt
 * (request body + response) which the panel surfaces per .claude/rules/
 * no-vaporware.md — no dead controls, no mock state.
 */

import { useState } from 'react';
import {
  Body1Strong, Caption1, Button, Select, Input, Field, Spinner, Link, Tooltip,
  MessageBar, MessageBarBody, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Edit16Regular, Delete16Regular, Add16Regular, Checkmark16Regular, Dismiss16Regular,
} from '@fluentui/react-icons';
import type { ExternalLink } from '@/lib/dataproducts/attributes';

/** Receipt returned by every attribute mutation — body sent + response received. */
export interface AttrReceipt {
  method: string;
  url: string;
  requestBody: unknown;
  status: number;
  response: unknown;
  at: string;
}

const useStyles = makeStyles({
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '12px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
  value: { color: tokens.colorNeutralForeground1 },
  muted: { color: tokens.colorNeutralForeground3 },
  editRow: { display: 'flex', flexDirection: 'column', gap: '8px' },
  actions: { display: 'flex', gap: '8px', alignItems: 'center' },
  list: { display: 'flex', flexDirection: 'column', gap: '4px', margin: 0, padding: 0, listStyle: 'none' },
  listRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
    padding: '4px 6px', borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  listText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '210px' },
  addForm: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' },
  receipt: {
    margin: 0, padding: '8px', maxHeight: '160px', overflow: 'auto',
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: '11px',
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusSmall,
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  },
});

function ReceiptView({ receipt }: { receipt: AttrReceipt | null }) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  if (!receipt) return null;
  return (
    <div>
      <Button appearance="transparent" size="small" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide receipt' : `Saved ${new Date(receipt.at).toLocaleTimeString()} — show receipt`}
      </Button>
      {open && (
        <pre className={s.receipt}>
{`${receipt.method} ${receipt.url}  →  HTTP ${receipt.status}
request: ${JSON.stringify(receipt.requestBody)}
response: ${JSON.stringify(receipt.response)}`}
        </pre>
      )}
    </div>
  );
}

// ============================================================
// SelectAttributePanel — F5 Update frequency
// ============================================================

export interface SelectAttributePanelProps {
  title: string;
  value: string;
  options: readonly string[];
  placeholder?: string;
  /** Persist the chosen value; returns the PATCH receipt. */
  onSave: (value: string) => Promise<AttrReceipt>;
}

export function SelectAttributePanel({ title, value, options, placeholder, onSave }: SelectAttributePanelProps) {
  const s = useStyles();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<AttrReceipt | null>(null);

  const begin = () => { setDraft(value); setError(null); setEditing(true); };
  const cancel = () => { setEditing(false); setError(null); };

  const done = async () => {
    // Dirty-check on close — no PATCH when the value is unchanged.
    if (draft === value) { setEditing(false); return; }
    setBusy(true); setError(null);
    try {
      const r = await onSave(draft);
      setReceipt(r);
      setEditing(false);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.panel}>
      <div className={s.header}>
        <Body1Strong>{title}</Body1Strong>
        {!editing && (
          <Tooltip content={`Edit ${title.toLowerCase()}`} relationship="label">
            <Button appearance="subtle" size="small" icon={<Edit16Regular />}
              aria-label={`Edit ${title.toLowerCase()}`} onClick={begin} />
          </Tooltip>
        )}
      </div>

      {!editing ? (
        value
          ? <Caption1 className={s.value}>{value}</Caption1>
          : <Caption1 className={s.muted}>{placeholder ?? 'Not set'}</Caption1>
      ) : (
        <div className={s.editRow}>
          <Field>
            <Select value={draft} disabled={busy} onChange={(_, d) => setDraft(d.value)}
              aria-label={title}>
              <option value="">{placeholder ?? 'Not set'}</option>
              {options.map((o) => <option key={o} value={o}>{o}</option>)}
            </Select>
          </Field>
          <div className={s.actions}>
            <Button appearance="primary" size="small" icon={busy ? <Spinner size="tiny" /> : <Checkmark16Regular />}
              disabled={busy} onClick={done}>Done</Button>
            <Button appearance="secondary" size="small" icon={<Dismiss16Regular />}
              disabled={busy} onClick={cancel}>Cancel</Button>
          </div>
        </div>
      )}

      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      <ReceiptView receipt={receipt} />
    </div>
  );
}

// ============================================================
// LinkListAttributePanel — F11 Terms of use / F12 Documentation
// ============================================================

export interface LinkListAttributePanelProps {
  title: string;
  entries: ExternalLink[];
  /** Append an entry; returns the PATCH receipt. */
  onAdd: (entry: ExternalLink) => Promise<AttrReceipt>;
  /** Remove the entry at index; returns the PATCH receipt. */
  onRemove: (index: number) => Promise<AttrReceipt>;
}

export function LinkListAttributePanel({ title, entries, onAdd, onRemove }: LinkListAttributePanelProps) {
  const s = useStyles();
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [assetId, setAssetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [removingIdx, setRemovingIdx] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<AttrReceipt | null>(null);

  const resetForm = () => { setLabel(''); setUrl(''); setAssetId(''); setError(null); };
  const beginAdd = () => { resetForm(); setAdding(true); };
  const cancelAdd = () => { resetForm(); setAdding(false); };

  const create = async () => {
    const l = label.trim();
    const u = url.trim();
    if (!l) { setError('Friendly name is required.'); return; }
    if (!u) { setError('URL is required.'); return; }
    try { new URL(u); } catch { setError('URL must be a valid absolute URL (e.g. https://…).'); return; }
    const entry: ExternalLink = assetId.trim() ? { label: l, url: u, assetId: assetId.trim() } : { label: l, url: u };
    setBusy(true); setError(null);
    try {
      const r = await onAdd(entry);
      setReceipt(r);
      resetForm();
      setAdding(false);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (idx: number) => {
    setRemovingIdx(idx); setError(null);
    try {
      const r = await onRemove(idx);
      setReceipt(r);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setRemovingIdx(null);
    }
  };

  return (
    <div className={s.panel}>
      <div className={s.header}>
        <Body1Strong>{title}</Body1Strong>
        {!adding && (
          <Button appearance="subtle" size="small" icon={<Add16Regular />} onClick={beginAdd}>Add link</Button>
        )}
      </div>

      {entries.length === 0 && !adding && <Caption1 className={s.muted}>No links yet.</Caption1>}

      {entries.length > 0 && (
        <ul className={s.list}>
          {entries.map((e, i) => (
            <li key={`${e.url}-${i}`} className={s.listRow}>
              <div className={s.listText}>
                <Caption1 className={s.ellipsis}><strong>{e.label}</strong></Caption1>
                <Link href={e.url} target="_blank" rel="noreferrer" className={s.ellipsis}>{e.url}</Link>
                {e.assetId && <Caption1 className={`${s.muted} ${s.ellipsis}`}>asset: {e.assetId}</Caption1>}
              </div>
              <Tooltip content="Remove link" relationship="label">
                <Button appearance="subtle" size="small"
                  icon={removingIdx === i ? <Spinner size="tiny" /> : <Delete16Regular />}
                  aria-label={`Remove ${e.label}`} disabled={removingIdx !== null}
                  onClick={() => remove(i)} />
              </Tooltip>
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <div className={s.addForm}>
          <Field label="Friendly name" required>
            <Input value={label} disabled={busy} onChange={(_, d) => setLabel(d.value)}
              placeholder="Terms of service" />
          </Field>
          <Field label="URL" required>
            <Input value={url} disabled={busy} onChange={(_, d) => setUrl(d.value)}
              placeholder="https://contoso.gov/terms" />
          </Field>
          <Field label="Data asset scope (optional)" hint="Restrict the link to a specific data asset id.">
            <Input value={assetId} disabled={busy} onChange={(_, d) => setAssetId(d.value)}
              placeholder="optional data asset id" />
          </Field>
          <div className={s.actions}>
            <Button appearance="primary" size="small" icon={busy ? <Spinner size="tiny" /> : <Checkmark16Regular />}
              disabled={busy} onClick={create}>Create</Button>
            <Button appearance="secondary" size="small" icon={<Dismiss16Regular />}
              disabled={busy} onClick={cancelAdd}>Cancel</Button>
          </div>
        </div>
      )}

      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      <ReceiptView receipt={receipt} />
    </div>
  );
}
