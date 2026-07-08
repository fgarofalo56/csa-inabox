'use client';

/**
 * VersionHistoryDrawer (Wave-2 W6) — in-editor version-history timeline + visual
 * diff + restore, mounted in the item-editor chrome header next to Lineage/Share.
 *
 * Self-contained: renders its own trigger button and a Fluent `Drawer` (overlay,
 * end). On open it lists prior versions from
 * `GET /api/items/[type]/[id]/versions` (Cosmos change-feed snapshots written at
 * the shared save chokepoint). The timeline shows who / when / a change summary
 * per version. Selecting two versions renders a FIELD-level visual diff (added /
 * removed / changed with old→new values — NOT a raw JSON dump), computed with the
 * shared pure `diffItemContent` util over each version's full content (fetched
 * lazily from the `[versionId]` route). A per-version Restore button (with a
 * confirm dialog) POSTs the restore, which writes the old content back through
 * the real save path and is itself versioned.
 *
 * All controls call real backends (no-vaporware). When Cosmos isn't configured
 * the drawer shows an honest MessageBar naming the missing env var.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Tooltip,
  Drawer,
  DrawerHeader,
  DrawerHeaderTitle,
  DrawerBody,
  Badge,
  Spinner,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogContent,
  DialogActions,
  DialogBody,
  Divider,
  makeStyles,
  shorthands,
  tokens,
} from '@fluentui/react-components';
import {
  Dismiss24Regular,
  History24Regular,
  ArrowClockwise16Regular,
  CheckmarkCircle16Filled,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { diffItemContent, type FieldChange } from '@/lib/versions/item-content-diff';

/** Metadata row from the list route (mirrors ItemVersionListEntry). */
interface VersionEntry {
  id: string;
  savedAt: string;
  savedBy: string;
  savedByName?: string;
  displayName: string;
  baseline?: boolean;
  current?: boolean;
  changeSummary: string;
}

/** Diffable content slice (mirrors ItemVersionContent). */
interface VersionContent {
  displayName: string;
  description?: string;
  state?: Record<string, unknown>;
}

export interface VersionHistoryDrawerProps {
  type: string;
  id: string;
  displayName?: string;
  /** Controlled mode: parent owns the open state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Fired after a successful restore (e.g. so the editor can reload). */
  onRestored?: () => void;
}

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', height: '100%', rowGap: tokens.spacingVerticalM, paddingBottom: tokens.spacingVerticalM },
  hintMeta: { marginTop: tokens.spacingVerticalXS, fontSize: tokens.fontSizeBase100 },
  timeline: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXS },
  row: {
    display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'pointer',
  },
  rowSelected: { ...shorthands.borderColor(tokens.colorBrandStroke1), backgroundColor: tokens.colorBrandBackground2 },
  rowTop: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, justifyContent: 'space-between' },
  rowTitle: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  who: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
  when: { fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3 },
  summary: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
  selBadge: { minWidth: '20px', textAlign: 'center' },
  sectionLabel: { fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground2 },
  diffList: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXS, overflow: 'auto' },
  change: {
    display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalXS, borderRadius: tokens.borderRadiusSmall,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  changePath: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, wordBreak: 'break-all' },
  val: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase100,
    whiteSpace: 'pre-wrap', wordBreak: 'break-all',
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusSmall, backgroundColor: tokens.colorNeutralBackground3,
  },
  valOld: { backgroundColor: tokens.colorStatusDangerBackground1, color: tokens.colorStatusDangerForeground1 },
  valNew: { backgroundColor: tokens.colorStatusSuccessBackground1, color: tokens.colorStatusSuccessForeground1 },
  restoreBtn: { alignSelf: 'flex-start' },
});

/** Compact ISO → "3 min ago" / local time. */
function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const s = Math.round(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(t).toLocaleDateString();
}

/** Render a JSON-ish value to a short, safe string for the diff cells. */
function renderVal(v: unknown): string {
  if (v === undefined) return '∅';
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s == null) s = String(v);
  return s.length > 240 ? `${s.slice(0, 240)}…` : s;
}

export function VersionHistoryDrawer({
  type,
  id,
  displayName,
  open: controlledOpen,
  onOpenChange,
  onRestored,
}: VersionHistoryDrawerProps) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  // Up to two selected version ids (base = older, compare = newer) for the diff.
  const [selected, setSelected] = useState<string[]>([]);
  const [contentCache, setContentCache] = useState<Record<string, VersionContent>>({});
  const [restoreTarget, setRestoreTarget] = useState<VersionEntry | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const isControlled = controlledOpen !== undefined;
  const mergedOpen = isControlled ? controlledOpen : open;

  const setOpenState = useCallback((v: boolean) => {
    if (!isControlled) setOpen(v);
    onOpenChange?.(v);
  }, [isControlled, onOpenChange]);

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    setGate(null);
    setNotice(null);
    clientFetch(`/api/items/${encodeURIComponent(type)}/${encodeURIComponent(id)}/versions`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (r.status === 503 || j?.code === 'cosmos_not_configured') {
          setGate(j?.error || 'Version history requires Cosmos DB, which is not configured in this deployment (set LOOM_COSMOS_ENDPOINT).');
          return;
        }
        if (!r.ok || !j?.ok) {
          setErr(j?.error || `Failed to load version history (${r.status})`);
          return;
        }
        const list: VersionEntry[] = Array.isArray(j.versions) ? j.versions : [];
        setVersions(list);
        // Default: compare the two newest (previous ↔ current) so a diff shows
        // immediately; single version selects itself.
        if (list.length >= 2) setSelected([list[1].id, list[0].id]);
        else if (list.length === 1) setSelected([list[0].id]);
        else setSelected([]);
      })
      .catch((e) => setErr(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, [type, id]);

  // Fetch on open; reset caches on close so reopening refetches.
  useEffect(() => {
    if (mergedOpen && !loading && versions.length === 0 && !err && !gate) load();
    if (!mergedOpen) {
      setContentCache({});
      setNotice(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergedOpen]);

  // Lazily fetch full content for any selected version not yet cached.
  useEffect(() => {
    const missing = selected.filter((vid) => !contentCache[vid]);
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(
      missing.map(async (vid) => {
        try {
          const r = await clientFetch(`/api/items/${encodeURIComponent(type)}/${encodeURIComponent(id)}/versions/${encodeURIComponent(vid)}`);
          const j = await r.json().catch(() => ({}));
          if (r.ok && j?.ok && j.version?.content) return [vid, j.version.content as VersionContent] as const;
        } catch { /* leave uncached; diff simply waits */ }
        return null;
      }),
    ).then((pairs) => {
      if (cancelled) return;
      const next: Record<string, VersionContent> = {};
      for (const p of pairs) if (p) next[p[0]] = p[1];
      if (Object.keys(next).length) setContentCache((c) => ({ ...c, ...next }));
    });
    return () => { cancelled = true; };
  }, [selected, contentCache, type, id]);

  const toggleSelect = useCallback((vid: string) => {
    setSelected((cur) => {
      if (cur.includes(vid)) return cur.filter((x) => x !== vid);
      if (cur.length < 2) return [...cur, vid];
      // Replace the oldest selection (keep the most recent click + the new one).
      return [cur[1], vid];
    });
  }, []);

  // Order the two selections older→newer using the timeline (newest first).
  const [baseId, compareId] = useMemo(() => {
    if (selected.length < 2) return [selected[0], undefined] as const;
    const idxA = versions.findIndex((v) => v.id === selected[0]);
    const idxB = versions.findIndex((v) => v.id === selected[1]);
    // Larger index = older. base = older, compare = newer.
    return idxA > idxB ? [selected[0], selected[1]] as const : [selected[1], selected[0]] as const;
  }, [selected, versions]);

  const diff: FieldChange[] | null = useMemo(() => {
    if (!baseId || !compareId) return null;
    const a = contentCache[baseId];
    const b = contentCache[compareId];
    if (!a || !b) return null;
    return diffItemContent(a, b);
  }, [baseId, compareId, contentCache]);

  const doRestore = useCallback(async () => {
    if (!restoreTarget) return;
    setRestoring(true);
    try {
      const r = await clientFetch(
        `/api/items/${encodeURIComponent(type)}/${encodeURIComponent(id)}/versions/${encodeURIComponent(restoreTarget.id)}/restore`,
        { method: 'POST' },
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) {
        setErr(j?.error || `Restore failed (${r.status})`);
      } else {
        setNotice('Version restored. Reload the editor to see the restored content.');
        onRestored?.();
        load(); // refresh the timeline (restore appended a new head version)
      }
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setRestoring(false);
      setRestoreTarget(null);
    }
  }, [restoreTarget, type, id, onRestored, load]);

  const selIndex = (vid: string): number => selected.indexOf(vid); // -1, 0, or 1

  return (
    <>
      {!isControlled && (
        <Tooltip content="Version history" relationship="label">
          <Button
            appearance="subtle"
            size="small"
            icon={<History24Regular />}
            onClick={() => setOpenState(true)}
            aria-label="Version history"
          >
            History
          </Button>
        </Tooltip>
      )}
      <Drawer type="overlay" position="end" size="large" open={mergedOpen} onOpenChange={(_, d) => setOpenState(d.open)}>
        <DrawerHeader>
          <DrawerHeaderTitle
            action={
              <Button appearance="subtle" icon={<Dismiss24Regular />} onClick={() => setOpenState(false)} aria-label="Close version history" />
            }
          >
            Version history{displayName ? ` — ${displayName}` : ''}
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody className={styles.body}>
          {loading && <Spinner label="Loading version history…" />}

          {notice && (
            <MessageBar intent="success">
              <MessageBarBody>{notice}</MessageBarBody>
            </MessageBar>
          )}

          {gate && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Version history not available</MessageBarTitle>
                {gate}
              </MessageBarBody>
            </MessageBar>
          )}

          {err && !gate && (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Could not load version history</MessageBarTitle>
                {err}
              </MessageBarBody>
            </MessageBar>
          )}

          {!loading && !gate && !err && versions.length === 0 && (
            <MessageBar intent="info">
              <MessageBarBody>
                No versions yet. A version is captured every time you save this item — save a change to start the history.
              </MessageBarBody>
            </MessageBar>
          )}

          {versions.length > 0 && (
            <>
              <div className={styles.sectionLabel}>
                Timeline — select two versions to compare ({selected.length}/2 selected)
              </div>
              <div className={styles.timeline}>
                {versions.map((v) => {
                  const si = selIndex(v.id);
                  return (
                    <div
                      key={v.id}
                      className={`${styles.row} ${si >= 0 ? styles.rowSelected : ''}`}
                      role="button"
                      tabIndex={0}
                      aria-pressed={si >= 0}
                      onClick={() => toggleSelect(v.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSelect(v.id); } }}
                    >
                      <div className={styles.rowTop}>
                        <div className={styles.rowTitle}>
                          {si >= 0 && (
                            <Badge className={styles.selBadge} appearance="filled" color="brand" size="small">
                              {si + 1}
                            </Badge>
                          )}
                          {v.current && (
                            <Badge appearance="tint" color="success" size="small" icon={<CheckmarkCircle16Filled />}>
                              Current
                            </Badge>
                          )}
                          {v.baseline && <Badge appearance="tint" color="informative" size="small">Initial</Badge>}
                          <span className={styles.who}>{v.savedByName || v.savedBy}</span>
                        </div>
                        <span className={styles.when} title={new Date(v.savedAt).toLocaleString()}>{relTime(v.savedAt)}</span>
                      </div>
                      <span className={styles.summary}>{v.changeSummary}</span>
                      {!v.current && (
                        <Button
                          className={styles.restoreBtn}
                          appearance="subtle"
                          size="small"
                          icon={<ArrowClockwise16Regular />}
                          onClick={(e) => { e.stopPropagation(); setRestoreTarget(v); }}
                        >
                          Restore this version
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>

              <Divider />

              <div className={styles.sectionLabel}>
                {baseId && compareId ? 'Changes between the two selected versions' : 'Select two versions above to see a field-level diff'}
              </div>
              {baseId && compareId && !diff && <Spinner size="tiny" label="Loading diff…" />}
              {diff && diff.length === 0 && (
                <MessageBar intent="info"><MessageBarBody>These two versions are identical — no field changes.</MessageBarBody></MessageBar>
              )}
              {diff && diff.length > 0 && (
                <div className={styles.diffList}>
                  {diff.map((c, i) => (
                    <div key={`${c.path}-${i}`} className={styles.change}>
                      <div className={styles.rowTop}>
                        <span className={styles.changePath}>{c.path}</span>
                        <Badge
                          appearance="tint"
                          size="small"
                          color={c.kind === 'added' ? 'success' : c.kind === 'removed' ? 'danger' : 'warning'}
                        >
                          {c.kind}
                        </Badge>
                      </div>
                      {c.kind !== 'added' && (
                        <span className={`${styles.val} ${styles.valOld}`}>- {renderVal(c.oldValue)}</span>
                      )}
                      {c.kind !== 'removed' && (
                        <span className={`${styles.val} ${styles.valNew}`}>+ {renderVal(c.newValue)}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </DrawerBody>
      </Drawer>

      {/* Restore confirm */}
      <Dialog open={!!restoreTarget} onOpenChange={(_e, d) => { if (!d.open) setRestoreTarget(null); }} modalType="alert">
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Restore this version?</DialogTitle>
            <DialogContent>
              This writes the selected version&apos;s content back onto the live item as a new save.
              The current content is kept in history, so you can undo the restore afterwards.
              {restoreTarget && (
                <div className={styles.hintMeta}>
                  Restoring the version saved {relTime(restoreTarget.savedAt)} by {restoreTarget.savedByName || restoreTarget.savedBy}.
                </div>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setRestoreTarget(null)} disabled={restoring}>Cancel</Button>
              <Button appearance="primary" onClick={doRestore} disabled={restoring} icon={restoring ? <Spinner size="tiny" /> : <ArrowClockwise16Regular />}>
                Restore
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}

export default VersionHistoryDrawer;
