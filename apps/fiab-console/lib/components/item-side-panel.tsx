'use client';

/**
 * ItemSidePanel — four Fabric-style item utility buttons rendered in the
 * editor chrome action row. Each opens a Drawer backed by a real BFF
 * route from Chunk 0 (no vaporware):
 *
 *   Comments → /api/items/[type]/[id]/comments  (Cosmos comments)
 *   History  → /api/items/[type]/[id]/audit     (Cosmos audit-log)
 *   Share    → /api/items/[type]/[id]/share     (Cosmos shares, token URL)
 *   Learn    → static lib/learn/content.ts entry (or honest empty state)
 *
 * 'Don't show again' for Learn is persisted via
 *   POST /api/user-prefs { key: `learnDismissed:${type}`, value: true }
 */

import { useEffect, useState } from 'react';
import {
  Button, Tooltip, Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Textarea, Checkbox, MessageBar, MessageBarBody,
  Spinner, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Comment24Regular, History24Regular, Share24Regular,
  BookOpen24Regular, Dismiss24Regular, Copy16Regular,
} from '@fluentui/react-icons';
import { getLearn } from '@/lib/learn/content';

interface Props { type: string; id: string; }

const useStyles = makeStyles({
  row: { display: 'flex', gap: 4 },
  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  card: {
    padding: 'var(--loom-space-2)',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 'var(--loom-radius-md)',
  },
  meta: { fontSize: 11, color: tokens.colorNeutralForeground3 },
  shareUrl: {
    fontSize: 12, fontFamily: 'monospace',
    padding: 'var(--loom-space-2)',
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: 'var(--loom-radius-sm)',
    wordBreak: 'break-all',
  },
  learnBody: { whiteSpace: 'pre-wrap', lineHeight: 1.5 },
});

export function ItemSidePanel({ type, id }: Props) {
  const styles = useStyles();
  const [open, setOpen] = useState<null | 'comments' | 'history' | 'share' | 'learn'>(null);
  const isNew = id === 'new';

  // Auto-open Learn for first visit, unless dismissed — OR unless the
  // URL carries `?noLearn=1` / `?screenshot=1`, which lets screenshot
  // harnesses and Playwright UATs render the editor in its clean state
  // without manually clicking the drawer closed (the Tutorial pages on
  // the docs site shouldn't bake the Learn drawer into every screenshot).
  useEffect(() => {
    if (isNew) return;
    if (typeof window !== 'undefined') {
      const sp = new URLSearchParams(window.location.search);
      if (sp.has('noLearn') || sp.has('screenshot') || sp.get('learn') === '0') {
        return;
      }
    }
    fetch(`/api/user-prefs?key=learnDismissed:${type}`).then(r => r.json()).then(d => {
      if (!d?.value) {
        const learn = getLearn(type);
        if (learn) setOpen('learn');
      }
    }).catch(() => {});
  }, [type, isNew]);

  return (
    <div className={styles.row}>
      <Tooltip content="Comments" relationship="label">
        <Button appearance="subtle" icon={<Comment24Regular />} onClick={() => !isNew && setOpen('comments')}
          aria-label="Comments" disabled={isNew} />
      </Tooltip>
      <Tooltip content="Version history" relationship="label">
        <Button appearance="subtle" icon={<History24Regular />} onClick={() => !isNew && setOpen('history')}
          aria-label="Version history" disabled={isNew} />
      </Tooltip>
      <Tooltip content="Share" relationship="label">
        <Button appearance="subtle" icon={<Share24Regular />} onClick={() => !isNew && setOpen('share')}
          aria-label="Share" disabled={isNew} />
      </Tooltip>
      <Tooltip content="Learn about this item" relationship="label">
        <Button appearance="subtle" icon={<BookOpen24Regular />} onClick={() => setOpen('learn')}
          aria-label="Learn about this item" />
      </Tooltip>
      <Drawer open={open !== null} onOpenChange={(_, d) => { if (!d.open) setOpen(null); }}
              position="end" size="medium">
        <DrawerHeader>
          <DrawerHeaderTitle action={
            <Button appearance="subtle" icon={<Dismiss24Regular />}
              onClick={() => setOpen(null)} aria-label="Close" />
          }>
            {open === 'comments' && 'Comments'}
            {open === 'history' && 'Version history'}
            {open === 'share' && 'Share'}
            {open === 'learn' && 'Learn about this item'}
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          {open === 'comments' && <CommentsPane type={type} id={id} />}
          {open === 'history' && <HistoryPane type={type} id={id} />}
          {open === 'share'   && <SharePane   type={type} id={id} />}
          {open === 'learn'   && <LearnPane   type={type} onClose={() => setOpen(null)} />}
        </DrawerBody>
      </Drawer>
    </div>
  );
}

interface Comment { id: string; body: string; name?: string; upn?: string; createdAt: string; }
function CommentsPane({ type, id }: Props) {
  const styles = useStyles();
  const [items, setItems] = useState<Comment[] | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => fetch(`/api/items/${type}/${id}/comments`)
    .then(r => r.json()).then(d => setItems(d?.comments ?? []))
    .catch(() => setItems([]));

  useEffect(() => { load(); }, [type, id]);

  const submit = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    await fetch(`/api/items/${type}/${id}/comments`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: draft.trim() }),
    });
    setDraft('');
    setBusy(false);
    load();
  };

  return (
    <div className={styles.list}>
      <Textarea value={draft} onChange={(_, d) => setDraft(d.value)}
        placeholder="Write a comment…" rows={3} resize="vertical" />
      <Button appearance="primary" onClick={submit} disabled={!draft.trim() || busy}>
        {busy ? 'Posting…' : 'Post comment'}
      </Button>
      {items === null && <Spinner size="tiny" label="Loading…" />}
      {items !== null && items.length === 0 && <div className={styles.meta}>No comments yet.</div>}
      {items?.map(c => (
        <div key={c.id} className={styles.card}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{c.name || c.upn || 'Someone'}</div>
          <div style={{ fontSize: 13 }}>{c.body}</div>
          <div className={styles.meta}>{new Date(c.createdAt).toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
}

interface AuditEntry { id: string; action: string; summary?: string; upn?: string; at: string; }
function HistoryPane({ type, id }: Props) {
  const styles = useStyles();
  const [items, setItems] = useState<AuditEntry[] | null>(null);
  useEffect(() => {
    fetch(`/api/items/${type}/${id}/audit`).then(r => r.json())
      .then(d => setItems(d?.entries ?? []))
      .catch(() => setItems([]));
  }, [type, id]);
  return (
    <div className={styles.list}>
      {items === null && <Spinner size="tiny" label="Loading…" />}
      {items !== null && items.length === 0 && (
        <div className={styles.meta}>No history yet. Changes you save will appear here.</div>
      )}
      {items?.map(e => (
        <div key={e.id} className={styles.card}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{e.action} {e.summary ? `· ${e.summary}` : ''}</div>
          <div className={styles.meta}>{e.upn ?? 'unknown'} · {new Date(e.at).toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
}

interface Share { id: string; token: string; scope: string; createdBy: string; createdAt: string; expiresAt: string; }
function SharePane({ type, id }: Props) {
  const styles = useStyles();
  const [items, setItems] = useState<Share[] | null>(null);
  const [hours, setHours] = useState('24');
  const [busy, setBusy] = useState(false);

  const load = () => fetch(`/api/items/${type}/${id}/share`).then(r => r.json())
    .then(d => setItems(d?.shares ?? [])).catch(() => setItems([]));
  useEffect(() => { load(); }, [type, id]);

  const create = async () => {
    setBusy(true);
    await fetch(`/api/items/${type}/${id}/share`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expiresInHours: Number(hours) || 24 }),
    });
    setBusy(false); load();
  };

  const revoke = async (token: string) => {
    await fetch(`/api/items/${type}/${id}/share?token=${encodeURIComponent(token)}`, { method: 'DELETE' });
    load();
  };

  const urlFor = (s: Share) =>
    `${window.location.origin}/share/${type}/${id}?token=${s.token}`;

  return (
    <div className={styles.list}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <label style={{ fontSize: 12 }}>
          Expires in (hours)&nbsp;
          <input value={hours} onChange={e => setHours(e.target.value)} type="number" min={1} max={720}
                 style={{ width: 64, padding: 4, fontSize: 12 }} />
        </label>
        <Button appearance="primary" onClick={create} disabled={busy}>
          {busy ? 'Creating…' : 'Create share link'}
        </Button>
      </div>
      {items === null && <Spinner size="tiny" label="Loading…" />}
      {items !== null && items.length === 0 && <div className={styles.meta}>No share links yet.</div>}
      {items?.map(s => (
        <div key={s.id} className={styles.card}>
          <div className={styles.shareUrl}>{urlFor(s)}</div>
          <div className={styles.meta}>
            {s.scope} · expires {new Date(s.expiresAt).toLocaleString()} · by {s.createdBy}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <Button size="small" icon={<Copy16Regular />}
              onClick={() => navigator.clipboard?.writeText(urlFor(s))}>Copy</Button>
            <Button size="small" appearance="subtle" onClick={() => revoke(s.token)}>Revoke</Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function LearnPane({ type, onClose }: { type: string; onClose: () => void }) {
  const styles = useStyles();
  const learn = getLearn(type);
  const [dismiss, setDismiss] = useState(false);
  const save = async () => {
    if (dismiss) {
      await fetch('/api/user-prefs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: `learnDismissed:${type}`, value: true }),
      }).catch(() => {});
    }
    onClose();
  };
  if (!learn) {
    return (
      <div className={styles.list}>
        <MessageBar intent="info">
          <MessageBarBody>
            Learn content for <b>{type}</b> hasn't been authored yet. We surface
            only real, written guidance here — never auto-generated placeholder
            text. Contributions are welcome in <code>lib/learn/content.ts</code>.
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }
  return (
    <div className={styles.list}>
      <h3 style={{ marginTop: 0 }}>{learn.title}</h3>
      {learn.summary && <p>{learn.summary}</p>}
      {learn.steps && learn.steps.length > 0 && (
        <ol style={{ paddingLeft: 18 }}>
          {learn.steps.map((s, i) => (
            <li key={i} style={{ marginBottom: 8 }}>
              {typeof s === 'string' ? s : (
                <><b>{s.title}</b>{s.body ? ` — ${s.body}` : ''}</>
              )}
            </li>
          ))}
        </ol>
      )}
      {learn.tip && (
        <MessageBar intent="success"><MessageBarBody>{learn.tip}</MessageBarBody></MessageBar>
      )}
      {learn.docsUrl && (
        <a href={learn.docsUrl} target="_blank" rel="noreferrer">
          Open detailed docs ↗
        </a>
      )}
      <Checkbox checked={dismiss} onChange={(_, d) => setDismiss(!!d.checked)}
        label="Don't show this again" />
      <Button appearance="primary" onClick={save}>{dismiss ? 'Save & close' : 'Close'}</Button>
    </div>
  );
}
