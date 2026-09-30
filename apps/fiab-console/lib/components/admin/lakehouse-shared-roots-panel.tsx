'use client';

/**
 * LakehouseSharedRootsPanel — the Fix-it for the readiness check "Lakehouses
 * sharing a storage root".
 *
 * One card per group of lakehouses that resolve to one storage directory. Each
 * member is a link to the lakehouse, with its workspace, whether its root is
 * recorded on the item, and whether it is in the recycle bin. "Keep root for
 * <name>" posts `/api/admin/lakehouse-roots/keep`: that lakehouse keeps the
 * directory and its files, and every other member gets a new, empty root of its
 * own. Nothing is copied or deleted, and the confirm dialog says so before
 * anything is written.
 *
 * The shapes below mirror `SharedRootGroup` in
 * `lib/admin/env-checks/lakehouse-shared-roots.ts`; they are restated here so
 * this client component does not import the server module.
 */
import { useState } from 'react';
import Link from 'next/link';
import {
  makeStyles, tokens, Badge, Button, Caption1, Card, Text, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
} from '@fluentui/react-components';
import { FolderLink20Regular, Wrench16Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';

export interface SharedRootMemberView {
  id: string;
  name: string;
  workspaceId: string;
  href: string;
  recorded: boolean;
  recycled: boolean;
}

export interface SharedRootGroupView {
  ids: string[];
  roots: string[];
  members: SharedRootMemberView[];
}

interface KeepResult {
  ok: boolean;
  error?: string;
  kept?: { name: string; container: string; root: string };
  reassigned?: Array<{ id: string; name: string; container: string; root: string }>;
  failed?: Array<{ id: string; name: string; error: string }>;
}

const useStyles = makeStyles({
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalS, minWidth: 0 },
  card: {
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0,
  },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  roots: { fontFamily: tokens.fontFamilyMonospace, color: tokens.colorNeutralForeground2, overflowWrap: 'anywhere', minWidth: 0 },
  member: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0,
    paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS,
    borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  name: { minWidth: 0, overflowWrap: 'anywhere' },
  meta: { color: tokens.colorNeutralForeground3, overflowWrap: 'anywhere', minWidth: 0 },
  spacer: { flex: 1 },
  dialogList: { margin: 0, paddingLeft: tokens.spacingHorizontalXL },
});

export function LakehouseSharedRootsPanel({
  groups,
  onResolved,
}: {
  groups: SharedRootGroupView[];
  /** Called after a keep request completes, so the page can re-run the check. */
  onResolved?: () => void;
}) {
  const s = useStyles();
  const [confirm, setConfirm] = useState<{ group: SharedRootGroupView; keeper: SharedRootMemberView } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<KeepResult | null>(null);

  const keep = async () => {
    if (!confirm) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await clientFetch('/api/admin/lakehouse-roots/keep', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: confirm.keeper.id }),
      });
      const j = (await r.json().catch(() => null)) as KeepResult | null;
      setResult(j && typeof j === 'object' ? { ...j, ok: r.ok && j.ok !== false } : { ok: false, error: `request failed (${r.status})` });
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setBusy(false);
      setConfirm(null);
      onResolved?.();
    }
  };

  if (!groups.length) return null;
  const others = confirm ? confirm.group.members.filter((m) => m.id !== confirm.keeper.id) : [];

  return (
    <div className={s.list} data-testid="lakehouse-shared-roots-panel">
      {result && (
        <MessageBar intent={result.ok ? 'success' : 'error'} layout="multiline" data-testid="lakehouse-keep-result">
          <MessageBarBody>
            <MessageBarTitle>{result.ok ? 'Storage roots updated' : 'Not every lakehouse was updated'}</MessageBarTitle>
            {result.error ? <>{result.error} </> : null}
            {result.kept ? <>“{result.kept.name}” keeps {result.kept.container}/{result.kept.root}. </> : null}
            {(result.reassigned || []).map((m) => (
              <span key={m.id}>“{m.name}” now uses {m.container}/{m.root}. </span>
            ))}
            {(result.failed || []).map((m) => (
              <span key={m.id}>“{m.name}”: {m.error}. </span>
            ))}
          </MessageBarBody>
        </MessageBar>
      )}
      {groups.map((g) => (
        <Card key={g.ids.join('|')} className={s.card} data-testid={`lakehouse-shared-root-${g.ids.join('-')}`}>
          <div className={s.head}>
            <FolderLink20Regular />
            <Text weight="semibold">{g.members.length} lakehouses, one storage root</Text>
            <Caption1 className={s.roots}>{g.roots.join(', ')}</Caption1>
          </div>
          {g.members.map((m) => (
            <div key={m.id} className={s.member}>
              <Link href={m.href} className={s.name}>{m.name || m.id}</Link>
              <Caption1 className={s.meta}>{m.id} · workspace {m.workspaceId || 'unknown'}</Caption1>
              {m.recorded ? <Badge appearance="tint" color="informative" size="small">Recorded</Badge> : null}
              {m.recycled ? <Badge appearance="tint" color="warning" size="small">In recycle bin</Badge> : null}
              <span className={s.spacer} />
              <Button
                size="small"
                icon={<Wrench16Regular />}
                disabled={busy || m.recycled}
                title={m.recycled ? 'Restore this lakehouse before keeping its root.' : undefined}
                onClick={() => setConfirm({ group: g, keeper: m })}
              >
                Keep root for {m.name || m.id}
              </Button>
            </div>
          ))}
        </Card>
      ))}
      <Dialog open={!!confirm} onOpenChange={(_e, d) => { if (!d.open && !busy) setConfirm(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Keep root for {confirm?.keeper.name}</DialogTitle>
            <DialogContent>
              <Text block>
                “{confirm?.keeper.name}” keeps {confirm?.group.roots.join(', ')} and the files in it. Each other lakehouse
                below gets a new, empty root of its own and opens there from now on:
              </Text>
              <ul className={s.dialogList}>
                {others.map((m) => <li key={m.id}><Text>{m.name || m.id} ({m.id})</Text></li>)}
              </ul>
              <Text block>Nothing is copied or deleted.</Text>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" disabled={busy} onClick={() => setConfirm(null)}>Cancel</Button>
              <Button appearance="primary" disabled={busy} icon={busy ? <Spinner size="tiny" /> : undefined} onClick={() => void keep()}>
                Keep root
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
