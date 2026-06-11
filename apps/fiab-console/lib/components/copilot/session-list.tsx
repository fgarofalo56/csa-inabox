'use client';

/**
 * SessionList — the Loom Copilot console left rail (audit-T121).
 *
 * Fully manageable session history: search/filter, recency grouping
 * (Pinned / Today / Yesterday / This week / Older), active-session state, a
 * hover "…" menu (Rename · Pin/Unpin · Duplicate · Delete), inline rename, a
 * delete-confirm dialog, an honest empty state, and a prominent "New chat"
 * CTA. Every mutation is wired to a real Cosmos-backed BFF route by the parent
 * (PATCH title/pinned, DELETE) — no dead controls.
 */

import { useMemo, useState } from 'react';
import {
  Button, Caption1, Subtitle2, Body1, SearchBox, Spinner, Input,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Tooltip, makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  Add20Regular, MoreHorizontal20Regular, Rename16Regular, Delete16Regular,
  Pin16Regular, PinOff16Regular, Copy16Regular, Chat24Regular,
} from '@fluentui/react-icons';
import type { SessionSummary } from './types';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minHeight: 0, height: '100%' },
  newBtn: { flexShrink: 0 },
  search: { flexShrink: 0, width: '100%' },
  list: { flex: 1, overflow: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, marginRight: `calc(-1 * ${tokens.spacingHorizontalXS})`, paddingRight: tokens.spacingHorizontalXS },
  groupLabel: {
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalXS} 2px`,
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    border: `1px solid transparent`,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '-2px' },
  },
  itemActive: {
    backgroundColor: tokens.colorBrandBackground2,
    border: `1px solid ${tokens.colorBrandStroke1}`,
    ':hover': { backgroundColor: tokens.colorBrandBackground2Hover },
  },
  itemText: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
  title: { fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  sub: { color: tokens.colorNeutralForeground3 },
  menuBtn: { flexShrink: 0, opacity: 0.65 },
  empty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: tokens.spacingVerticalS, textAlign: 'center', padding: tokens.spacingVerticalXXL,
    color: tokens.colorNeutralForeground3, flex: 1,
  },
  pinDot: { color: tokens.colorBrandForeground1, flexShrink: 0 },
});

const DAY = 24 * 60 * 60 * 1000;

type Bucket = 'Pinned' | 'Today' | 'Yesterday' | 'This week' | 'Older';
const BUCKET_ORDER: Bucket[] = ['Pinned', 'Today', 'Yesterday', 'This week', 'Older'];

function bucketFor(s: SessionSummary, now: number): Bucket {
  if (s.pinned) return 'Pinned';
  const t = new Date(s.updatedAt).getTime();
  if (!Number.isFinite(t)) return 'Older';
  const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
  const startTodayMs = startToday.getTime();
  if (t >= startTodayMs) return 'Today';
  if (t >= startTodayMs - DAY) return 'Yesterday';
  if (t >= startTodayMs - 7 * DAY) return 'This week';
  return 'Older';
}

function sessionLabel(s: SessionSummary): string {
  return (s.title || s.prompt || 'Untitled chat').trim() || 'Untitled chat';
}

export interface SessionListProps {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  loading?: boolean;
  onSelect: (sessionId: string) => void;
  onNew: () => void;
  onRename: (sessionId: string, title: string) => void;
  onTogglePin: (sessionId: string, pinned: boolean) => void;
  onDuplicate: (session: SessionSummary) => void;
  onDelete: (sessionId: string) => void;
}

export function SessionList(props: SessionListProps) {
  const s = useStyles();
  const { sessions, activeSessionId, loading } = props;
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<SessionSummary | null>(null);
  const now = Date.now();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((x) => sessionLabel(x).toLowerCase().includes(q));
  }, [sessions, query]);

  const groups = useMemo(() => {
    const map = new Map<Bucket, SessionSummary[]>();
    for (const sess of filtered) {
      const b = bucketFor(sess, now);
      if (!map.has(b)) map.set(b, []);
      map.get(b)!.push(sess);
    }
    return BUCKET_ORDER.filter((b) => map.has(b)).map((b) => ({ bucket: b, items: map.get(b)! }));
  }, [filtered, now]);

  const startRename = (sess: SessionSummary) => {
    setRenaming(sess.sessionId);
    setRenameValue(sessionLabel(sess));
  };
  const commitRename = (sessionId: string) => {
    const v = renameValue.trim();
    if (v) props.onRename(sessionId, v);
    setRenaming(null);
  };

  return (
    <div className={s.root}>
      <Button className={s.newBtn} appearance="primary" icon={<Add20Regular />} onClick={props.onNew}>
        New chat
      </Button>
      {sessions.length > 0 && (
        <SearchBox
          className={s.search}
          placeholder="Search chats…"
          value={query}
          onChange={(_e, d) => setQuery(d.value)}
          aria-label="Search chats"
        />
      )}

      {loading && sessions.length === 0 ? (
        <div className={s.empty}><Spinner size="tiny" /> <Caption1>Loading chats…</Caption1></div>
      ) : sessions.length === 0 ? (
        <div className={s.empty}>
          <Chat24Regular />
          <Subtitle2>Start your first chat</Subtitle2>
          <Caption1>Ask Copilot to orchestrate across your wired Azure services.</Caption1>
        </div>
      ) : filtered.length === 0 ? (
        <div className={s.empty}><Caption1>No chats match “{query}”.</Caption1></div>
      ) : (
        <div className={s.list}>
          {groups.map(({ bucket, items }) => (
            <div key={bucket}>
              <div className={s.groupLabel}>{bucket}</div>
              {items.map((sess) => {
                const active = activeSessionId === sess.sessionId;
                if (renaming === sess.sessionId) {
                  return (
                    <div key={sess.id} className={s.item}>
                      <Input
                        size="small"
                        value={renameValue}
                        autoFocus
                        style={{ flex: 1 }}
                        onChange={(_e, d) => setRenameValue(d.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename(sess.sessionId);
                          if (e.key === 'Escape') setRenaming(null);
                        }}
                        onBlur={() => commitRename(sess.sessionId)}
                        aria-label="Rename chat"
                      />
                    </div>
                  );
                }
                return (
                  <div
                    key={sess.id}
                    className={mergeClasses(s.item, active && s.itemActive)}
                    role="button"
                    tabIndex={0}
                    aria-current={active ? 'true' : undefined}
                    onClick={() => props.onSelect(sess.sessionId)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onSelect(sess.sessionId); } }}
                  >
                    {sess.pinned && <Pin16Regular className={s.pinDot} aria-label="Pinned" />}
                    <span className={s.itemText}>
                      <span className={s.title}>{sessionLabel(sess)}</span>
                      <Caption1 className={s.sub}>
                        {sess.stepCount} step{sess.stepCount === 1 ? '' : 's'} · {new Date(sess.updatedAt).toLocaleDateString()}
                      </Caption1>
                    </span>
                    <Menu positioning="below-end">
                      <MenuTrigger disableButtonEnhancement>
                        <Tooltip content="Chat actions" relationship="label">
                          <Button
                            className={s.menuBtn}
                            appearance="subtle"
                            size="small"
                            icon={<MoreHorizontal20Regular />}
                            aria-label="Chat actions"
                            onClick={(e) => e.stopPropagation()}
                          />
                        </Tooltip>
                      </MenuTrigger>
                      <MenuPopover onClick={(e) => e.stopPropagation()}>
                        <MenuList>
                          <MenuItem icon={<Rename16Regular />} onClick={() => startRename(sess)}>Rename</MenuItem>
                          <MenuItem
                            icon={sess.pinned ? <PinOff16Regular /> : <Pin16Regular />}
                            onClick={() => props.onTogglePin(sess.sessionId, !sess.pinned)}
                          >
                            {sess.pinned ? 'Unpin' : 'Pin'}
                          </MenuItem>
                          <MenuItem icon={<Copy16Regular />} onClick={() => props.onDuplicate(sess)}>Duplicate</MenuItem>
                          <MenuItem icon={<Delete16Regular />} onClick={() => setConfirmDelete(sess)}>Delete</MenuItem>
                        </MenuList>
                      </MenuPopover>
                    </Menu>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      <Dialog open={!!confirmDelete} onOpenChange={(_e, d) => { if (!d.open) setConfirmDelete(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete chat?</DialogTitle>
            <DialogContent>
              <Body1>
                “{confirmDelete ? sessionLabel(confirmDelete) : ''}” will be permanently removed. This can’t be undone.
              </Body1>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirmDelete(null)}>Cancel</Button>
              <Button
                appearance="primary"
                onClick={() => { if (confirmDelete) props.onDelete(confirmDelete.sessionId); setConfirmDelete(null); }}
              >
                Delete
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
