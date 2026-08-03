'use client';

import { clientFetch } from '@/lib/client-fetch';
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
 * Learn is OPT-IN (#2893). It used to AUTO-OPEN on arrival for every item type
 * that had content, and the `size="medium"` Drawer covers ~45% of a 1280px
 * viewport — i.e. exactly the region where a pipeline/eventstream canvas
 * lives. Confirmed on two unrelated editors, so it was the shared chrome, not
 * a per-editor bug. The drawer now opens only from the visible Learn button in
 * this action row; "first visit" is signalled by a quiet dot on that button.
 *
 * 'Don't show this again' for Learn switches that dot off and is persisted the
 * moment it is ticked (not only when the primary button is pressed — closing
 * via the header X or Esc used to silently discard it), via
 *   POST /api/user-prefs { key: `learnDismissed:${type}`, value: boolean }
 * and re-hydrated into the checkbox on the next open, so the promise the
 * checkbox makes is one the surface actually keeps.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Button, Tooltip, Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Textarea, Checkbox, CounterBadge, MessageBar, MessageBarBody,
  Spinner, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Comment24Regular, History24Regular, Share24Regular,
  BookOpen24Regular, Dismiss24Regular, Copy16Regular,
  ShieldLock24Regular, Sparkle16Regular, Tag24Regular,
} from '@fluentui/react-icons';
import { getLearn } from '@/lib/learn/content';
import { SensitivityLabelPane } from './label-flyout';
import { ClassificationPane } from './classification-flyout';
import { COLLAB_COMMENTS_EVENT, type CollabCommentsEventDetail } from '@/lib/collab/collab-stream-model';

interface Props { type: string; id: string; }

const useStyles = makeStyles({
  row: { display: 'flex', gap: tokens.spacingHorizontalXS },
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalS },
  card: {
    padding: 'var(--loom-space-2)',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 'var(--loom-radius-md)',
  },
  meta: { fontSize: '11px', color: tokens.colorNeutralForeground3 },
  shareUrl: {
    fontSize: tokens.fontSizeBase200, fontFamily: 'monospace',
    padding: 'var(--loom-space-2)',
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: 'var(--loom-radius-sm)',
    wordBreak: 'break-all',
  },
  learnBody: { whiteSpace: 'pre-wrap', lineHeight: 1.5 },
  // Anchor for the "unread Learn" dot so it rides the Learn button instead of
  // pushing the action row wider.
  learnAnchor: { position: 'relative', display: 'inline-flex' },
  learnDot: {
    position: 'absolute',
    top: tokens.spacingVerticalXXS,
    insetInlineEnd: tokens.spacingHorizontalXXS,
    pointerEvents: 'none',
  },
});

export function ItemSidePanel({ type, id }: Props) {
  const styles = useStyles();
  const [open, setOpen] = useState<null | 'comments' | 'history' | 'share' | 'learn' | 'sensitivity' | 'classifications'>(null);
  const isNew = id === 'new';

  // #2893 — Learn NEVER auto-opens. A first visit only lights a dot on the
  // Learn button; the drawer is opened by the user from that visible
  // affordance. `learnDismissed` also seeds the drawer's checkbox so the
  // stored preference is visibly honoured on reopen. Both stay false when the
  // pref lookup fails — the safe default is "no dot", never "occlude the
  // canvas".
  const [learnHint, setLearnHint] = useState(false);
  const [learnDismissed, setLearnDismissed] = useState(false);

  useEffect(() => {
    if (isNew || !getLearn(type)) { setLearnHint(false); setLearnDismissed(false); return; }
    let cancelled = false;
    clientFetch(`/api/user-prefs?key=learnDismissed:${type}`).then(r => r.json()).then(d => {
      if (cancelled) return;
      setLearnDismissed(!!d?.value);
      setLearnHint(!d?.value);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [type, isNew]);

  const onLearnDismissChange = useCallback((next: boolean) => {
    setLearnDismissed(next);
    setLearnHint(!next && !!getLearn(type) && !isNew);
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
      <Tooltip content="Sensitivity label" relationship="label">
        <Button appearance="subtle" icon={<ShieldLock24Regular />} onClick={() => !isNew && setOpen('sensitivity')}
          aria-label="Sensitivity label" disabled={isNew} />
      </Tooltip>
      <Tooltip content="Classifications" relationship="label">
        <Button appearance="subtle" icon={<Tag24Regular />} onClick={() => !isNew && setOpen('classifications')}
          aria-label="Classifications" disabled={isNew} />
      </Tooltip>
      <span className={styles.learnAnchor}>
        <Tooltip content="Learn about this item" relationship="label">
          <Button appearance="subtle" icon={<BookOpen24Regular />} onClick={() => setOpen('learn')}
            aria-label="Learn about this item" data-testid="item-learn-button" />
        </Tooltip>
        {/* Quiet "there's guidance here you haven't dismissed" affordance — the
            replacement for the drawer opening itself over the canvas. This is
            what "Don't show this again" turns off. */}
        {learnHint && (
          <CounterBadge className={styles.learnDot} dot color="brand" size="small"
            aria-hidden data-testid="item-learn-hint" />
        )}
      </span>
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
            {open === 'sensitivity' && 'Sensitivity label'}
            {open === 'classifications' && 'Classifications'}
            {open === 'learn' && 'Learn about this item'}
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          {open === 'comments' && <CommentsPane type={type} id={id} />}
          {open === 'history' && <HistoryPane type={type} id={id} />}
          {open === 'share'   && <SharePane   type={type} id={id} />}
          {open === 'sensitivity' && <SensitivityLabelPane type={type} id={id} />}
          {open === 'classifications' && <ClassificationPane type={type} id={id} />}
          {open === 'learn'   && (
            <LearnPane type={type} id={id} dismissed={learnDismissed}
              onDismissChange={onLearnDismissChange} onClose={() => setOpen(null)} />
          )}
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

  const load = () => clientFetch(`/api/items/${type}/${id}/comments`)
    .then(r => r.json()).then(d => setItems(d?.comments ?? []))
    .catch(() => setItems([]));

  useEffect(() => { load(); }, [type, id]);

  // A14 push transport: when the item's collab stream reports the review
  // thread changed (a peer posted/edited/resolved a comment), reload while the
  // pane is open — session B sees session A's comment live. Additive: with
  // push off nothing dispatches and the pane behaves exactly as before.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<CollabCommentsEventDetail>).detail;
      if (detail?.itemId === id && detail.scope === 'item') load();
    };
    window.addEventListener(COLLAB_COMMENTS_EVENT, onChanged);
    return () => window.removeEventListener(COLLAB_COMMENTS_EVENT, onChanged);
  }, [type, id]);

  const submit = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    await clientFetch(`/api/items/${type}/${id}/comments`, {
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
          <div style={{ fontWeight: 600, fontSize: tokens.fontSizeBase200 }}>{c.name || c.upn || 'Someone'}</div>
          <div style={{ fontSize: tokens.fontSizeBase200 }}>{c.body}</div>
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
    clientFetch(`/api/items/${type}/${id}/audit`).then(r => r.json())
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
          <div style={{ fontWeight: 600, fontSize: tokens.fontSizeBase200 }}>{e.action} {e.summary ? `· ${e.summary}` : ''}</div>
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

  const load = () => clientFetch(`/api/items/${type}/${id}/share`).then(r => r.json())
    .then(d => setItems(d?.shares ?? [])).catch(() => setItems([]));
  useEffect(() => { load(); }, [type, id]);

  const create = async () => {
    setBusy(true);
    await clientFetch(`/api/items/${type}/${id}/share`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expiresInHours: Number(hours) || 24 }),
    });
    setBusy(false); load();
  };

  const revoke = async (token: string) => {
    await clientFetch(`/api/items/${type}/${id}/share?token=${encodeURIComponent(token)}`, { method: 'DELETE' });
    load();
  };

  const urlFor = (s: Share) =>
    `${window.location.origin}/share/${type}/${id}?token=${s.token}`;

  return (
    <div className={styles.list}>
      <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' }}>
        <label style={{ fontSize: tokens.fontSizeBase200 }}>
          Expires in (hours)&nbsp;
          <input value={hours} onChange={e => setHours(e.target.value)} type="number" min={1} max={720}
                 style={{ width: 64, padding: tokens.spacingVerticalXS, fontSize: tokens.fontSizeBase200 }} />
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
          <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalXS }}>
            <Button size="small" icon={<Copy16Regular />}
              onClick={() => navigator.clipboard?.writeText(urlFor(s))}>Copy</Button>
            <Button size="small" appearance="subtle" onClick={() => revoke(s.token)}>Revoke</Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function LearnPane({ type, id, dismissed = false, onDismissChange, onClose }: {
  type: string; id?: string; dismissed?: boolean;
  onDismissChange?: (next: boolean) => void; onClose: () => void;
}) {
  const styles = useStyles();
  const learn = getLearn(type);
  // Seeded from the PERSISTED preference so reopening shows the real state.
  const [dismiss, setDismiss] = useState(dismissed);
  const [activeStep, setActiveStep] = useState(0);
  // Persist on TOGGLE, not on the primary button: the drawer can also be closed
  // via the header X, the Esc key, or a click outside, and all three used to
  // throw the ticked checkbox away (#2893). Un-ticking writes `false`, so the
  // preference is reversible instead of a one-way door.
  const setDismissPersisted = async (next: boolean) => {
    setDismiss(next);
    onDismissChange?.(next);
    await clientFetch('/api/user-prefs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: `learnDismissed:${type}`, value: next }),
    }).catch(() => {});
  };
  /** Hand the active step to the Help Copilot (tutorial-step awareness +
   *  auto-error-detect). Dispatches the same CustomEvent the widget listens
   *  for, then opens the widget. */
  const helpWithStep = (index: number) => {
    if (typeof window === 'undefined' || !learn?.steps) return;
    const raw = learn.steps[index];
    const stepTitle = typeof raw === 'string' ? `Step ${index + 1}` : raw.title;
    const stepBody = typeof raw === 'string' ? raw : `${raw.title}${raw.body ? ` — ${raw.body}` : ''}`;
    window.dispatchEvent(new CustomEvent('csaloom:tutorial-step', {
      detail: {
        id: `editor:${type}${id && id !== 'new' ? `#${id}` : ''}`,
        stepIndex: index,
        stepTitle,
        stepBody,
        totalSteps: learn.steps.length,
      },
    }));
    window.dispatchEvent(new Event('csaloom:open-copilot'));
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
      <h3 style={{ marginTop: tokens.spacingVerticalNone }}>{learn.title}</h3>
      {learn.summary && <p>{learn.summary}</p>}
      {learn.steps && learn.steps.length > 0 && (
        <ol style={{ paddingLeft: tokens.spacingHorizontalXL }}>
          {learn.steps.map((s, i) => {
            const isActive = i === activeStep;
            return (
              <li
                key={i}
                aria-current={isActive ? 'step' : undefined}
                style={{
                  marginBottom: tokens.spacingVerticalS,
                  padding: isActive ? 'var(--loom-space-2)' : 0,
                  borderRadius: 'var(--loom-radius-sm)',
                  backgroundColor: isActive ? tokens.colorNeutralBackground2 : 'transparent',
                  transition: 'background-color 120ms ease, padding 120ms ease',
                }}
                onMouseEnter={() => setActiveStep(i)}
                onFocus={() => setActiveStep(i)}
              >
                {typeof s === 'string' ? s : (
                  <><b>{s.title}</b>{s.body ? ` — ${s.body}` : ''}</>
                )}
                <div style={{ marginTop: tokens.spacingVerticalXS }}>
                  <Button
                    appearance="subtle"
                    size="small"
                    icon={<Sparkle16Regular />}
                    onClick={() => helpWithStep(i)}
                    aria-label={`Get Copilot help with step ${i + 1}`}
                    data-testid={`learn-step-help-${i}`}
                  >
                    Help with this step
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {learn.tip && (
        <MessageBar intent="success"><MessageBarBody>{learn.tip}</MessageBarBody></MessageBar>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalM, alignItems: 'center' }}>
        {learn.docsUrl && (
          <a href={learn.docsUrl} target="_blank" rel="noreferrer"
             style={{ fontWeight: 600 }}>
            {learn.hasLoomDoc ? 'Open the CSA Loom guide ↗' : 'Open detailed docs ↗'}
          </a>
        )}
        {/* Secondary MS Learn link only when distinct from the primary Loom link. */}
        {learn.hasLoomDoc && learn.msLearnUrl && (
          <a href={learn.msLearnUrl} target="_blank" rel="noreferrer"
             style={{ fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 }}>
            MS Learn ↗
          </a>
        )}
      </div>
      {!learn.hasLoomDoc && (
        <MessageBar intent="info">
          <MessageBarBody>
            A dedicated CSA Loom guide for this item is on the way. The link
            above points to Microsoft Learn in the meantime.
          </MessageBarBody>
        </MessageBar>
      )}
      <Checkbox checked={dismiss} onChange={(_, d) => { void setDismissPersisted(!!d.checked); }}
        label="Don't show this again" data-testid="learn-dismiss" />
      <Button appearance="primary" onClick={onClose}>Close</Button>
    </div>
  );
}
