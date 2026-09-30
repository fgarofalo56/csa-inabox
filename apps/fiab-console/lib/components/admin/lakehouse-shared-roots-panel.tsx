'use client';

/**
 * LakehouseSharedRootsPanel — the Fix-it for the readiness check "Lakehouses
 * sharing a storage root".
 *
 * One card per group of lakehouses that resolve to one storage directory. Each
 * member is a link to the lakehouse, with its workspace, whether its root is
 * recorded on the item, and whether it is in the recycle bin. "Keep root for
 * <name>" first asks `/api/admin/lakehouse-roots/keep` for its plan (`dryRun`),
 * and the confirm dialog lists exactly the lakehouses that will get a new,
 * empty root, and the ones that stay as they are and why. Confirming posts the
 * same request without `dryRun`: that lakehouse keeps the directory and its
 * files, and the listed members get roots of their own. Nothing is copied or
 * deleted, and the dialog says so before anything is written.
 *
 * The outcome is handed to the page (`onResolved`), which shows it with
 * {@link LakehouseKeepResultBar} OUTSIDE the check: a keep that resolves the
 * last group makes the check pass, and the check (with this panel) is no longer
 * rendered.
 *
 * The check has no gate-registry entry yet: the registry's entries are
 * environment-variable gates, and it has no entry type for a data-state check
 * (#4817). Until then this panel is the check's only Fix-it surface.
 *
 * The shapes below mirror `SharedRootGroup` in
 * `lib/admin/env-checks/lakehouse-shared-roots.ts`; they are restated here so
 * this client component does not import the server module.
 */
import { useState } from 'react';
import Link from 'next/link';
import {
  makeStyles, tokens, Badge, Button, Caption1, Card, Text, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
} from '@fluentui/react-components';
import { Dismiss16Regular, FolderLink20Regular, Wrench16Regular } from '@fluentui/react-icons';
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

export interface KeepResult {
  ok: boolean;
  error?: string;
  kept?: { name: string; container: string; root: string };
  reassigned?: Array<{ id: string; name: string; container: string; root: string }>;
  unchanged?: Array<{ id: string; name: string; why: string }>;
  failed?: Array<{ id: string; name: string; error: string }>;
}

interface KeepPlan {
  ok: boolean;
  error?: string;
  kept?: { name: string; container: string; root: string };
  moving?: Array<{ id: string; name: string }>;
  unchanged?: Array<{ id: string; name: string; why: string }>;
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

async function postKeep(itemId: string, dryRun: boolean): Promise<{ status: number; body: any }> {
  const r = await clientFetch('/api/admin/lakehouse-roots/keep', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(dryRun ? { itemId, dryRun: true } : { itemId }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/**
 * The outcome of a keep: which lakehouse kept the root, which moved where, which
 * were left as they were, and which failed. Rendered by the page, outside the
 * check, so it stays after the check passes; dismissed by the admin.
 */
export function LakehouseKeepResultBar({ result, onDismiss }: { result: KeepResult; onDismiss: () => void }) {
  return (
    <MessageBar
      intent={result.ok ? 'success' : 'error'}
      layout="multiline"
      data-testid="lakehouse-keep-result"
      style={{ marginBottom: tokens.spacingVerticalM }}
    >
      <MessageBarBody>
        <MessageBarTitle>{result.ok ? 'Storage roots updated' : 'Not every lakehouse was updated'}</MessageBarTitle>
        {result.error ? <>{result.error} </> : null}
        {result.kept ? <>“{result.kept.name}” keeps {result.kept.container}/{result.kept.root}. </> : null}
        {(result.reassigned || []).map((m) => (
          <span key={m.id}>“{m.name}” now uses {m.container}/{m.root}. </span>
        ))}
        {(result.unchanged || []).map((m) => (
          <span key={m.id}>“{m.name}” was left as it is: {m.why}. </span>
        ))}
        {(result.failed || []).map((m) => (
          <span key={m.id}>“{m.name}”: {m.error}. </span>
        ))}
      </MessageBarBody>
      <MessageBarActions
        containerAction={<Button appearance="transparent" aria-label="Dismiss" icon={<Dismiss16Regular />} onClick={onDismiss} />}
      />
    </MessageBar>
  );
}

export function LakehouseSharedRootsPanel({
  groups,
  onResolved,
}: {
  groups: SharedRootGroupView[];
  /** Called with the outcome after a keep request completes, so the page can show it and re-run the check. */
  onResolved?: (result: KeepResult) => void;
}) {
  const s = useStyles();
  const [confirm, setConfirm] = useState<{ group: SharedRootGroupView; keeper: SharedRootMemberView } | null>(null);
  const [plan, setPlan] = useState<KeepPlan | 'loading' | null>(null);
  const [busy, setBusy] = useState(false);

  const open = async (group: SharedRootGroupView, keeper: SharedRootMemberView) => {
    setConfirm({ group, keeper });
    setPlan('loading');
    try {
      const { status, body } = await postKeep(keeper.id, true);
      setPlan(body && typeof body === 'object'
        ? { ...body, ok: status < 400 && body.ok !== false }
        : { ok: false, error: `request failed (${status})` });
    } catch (e: any) {
      setPlan({ ok: false, error: e?.message || String(e) });
    }
  };

  const keep = async () => {
    if (!confirm) return;
    setBusy(true);
    let result: KeepResult;
    try {
      const { status, body } = await postKeep(confirm.keeper.id, false);
      result = body && typeof body === 'object'
        ? { ...body, ok: status < 400 && body.ok !== false }
        : { ok: false, error: `request failed (${status})` };
    } catch (e: any) {
      result = { ok: false, error: e?.message || String(e) };
    }
    setBusy(false);
    setConfirm(null);
    setPlan(null);
    onResolved?.(result);
  };

  if (!groups.length) return null;
  const ready = plan !== null && plan !== 'loading' && plan.ok;

  return (
    <div className={s.list} data-testid="lakehouse-shared-roots-panel">
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
                onClick={() => void open(g, m)}
              >
                Keep root for {m.name || m.id}
              </Button>
            </div>
          ))}
        </Card>
      ))}
      <Dialog open={!!confirm} onOpenChange={(_e, d) => { if (!d.open && !busy) { setConfirm(null); setPlan(null); } }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Keep root for {confirm?.keeper.name}</DialogTitle>
            <DialogContent>
              {plan === 'loading' && <Spinner size="small" label="Working out what changes…" labelPosition="after" />}
              {plan !== null && plan !== 'loading' && !plan.ok && (
                <MessageBar intent="error" layout="multiline" data-testid="lakehouse-keep-plan-error">
                  <MessageBarBody>{plan.error || 'The plan could not be read.'}</MessageBarBody>
                </MessageBar>
              )}
              {ready && plan.kept && (
                <>
                  <Text block>
                    “{confirm?.keeper.name}” keeps {plan.kept.container}/{plan.kept.root} and the files in it.
                    {(plan.moving || []).length
                      ? ' Each lakehouse below gets a new, empty root of its own and opens there from now on:'
                      : ' No other lakehouse changes.'}
                  </Text>
                  {(plan.moving || []).length > 0 && (
                    <ul className={s.dialogList} data-testid="lakehouse-keep-plan-moving">
                      {(plan.moving || []).map((m) => <li key={m.id}><Text>{m.name || m.id} ({m.id})</Text></li>)}
                    </ul>
                  )}
                  {(plan.unchanged || []).length > 0 && (
                    <>
                      <Text block>These stay as they are:</Text>
                      <ul className={s.dialogList} data-testid="lakehouse-keep-plan-unchanged">
                        {(plan.unchanged || []).map((m) => <li key={m.id}><Text>{m.name || m.id} ({m.id}): {m.why}</Text></li>)}
                      </ul>
                    </>
                  )}
                  <Text block>Nothing is copied or deleted.</Text>
                </>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" disabled={busy} onClick={() => { setConfirm(null); setPlan(null); }}>Cancel</Button>
              <Button appearance="primary" disabled={busy || !ready} icon={busy ? <Spinner size="tiny" /> : undefined} onClick={() => void keep()}>
                Keep root
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
