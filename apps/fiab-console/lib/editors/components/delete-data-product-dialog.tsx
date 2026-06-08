'use client';

/**
 * DeleteDataProductDialog — precondition-gated, type-name-to-confirm destructive
 * delete for a data product. Azure-native parity with the Microsoft Purview
 * Unified Catalog "Delete data products" flow
 * (https://learn.microsoft.com/purview/unified-catalog-data-products-create-manage#delete-data-products),
 * which only permits deletion when the product is Draft/Expired with zero data
 * assets, zero linked business concepts, and zero open access requests.
 *
 * No Fabric dependency: the delete acts on the Cosmos `items` record (the
 * Azure-native source of truth). Purview Unified Catalog cleanup is best-effort
 * on the server and honestly gates on the classic Data Map account.
 *
 *   1. On open → GET /api/data-products/[id] to evaluate the four preconditions.
 *   2. Any precondition false → render the blockers, no confirm field, no delete.
 *   3. All preconditions met → show a green receipt + a "type the exact name to
 *      confirm" field. The Delete button is disabled until the typed text equals
 *      the product's display name.
 *   4. Confirm → DELETE /api/data-products/[id]; on { ok:true } call onDeleted
 *      with the workspaceId so the parent routes back to the list.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Input, Field, Spinner, Caption1, Body1,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Delete20Regular, Checkmark20Regular, Warning20Regular } from '@fluentui/react-icons';

interface Preconditions {
  statusAllowed: boolean;
  datasetsEmpty: boolean;
  glossaryEmpty: boolean;
  noOpenAccessRequests: boolean;
  canDelete: boolean;
}

interface CurrentCounts {
  lifecycleStatus: string;
  datasetCount: number;
  glossaryCount: number;
  openAccessRequestCount: number;
}

interface PreflightResponse {
  ok: boolean;
  displayName?: string;
  workspaceId?: string;
  preconditions?: Preconditions;
  current?: CurrentCounts;
  error?: string;
}

interface DeleteDataProductDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Cosmos item id. */
  id: string;
  /** Pre-fetched name for optimistic display before the preflight returns. */
  displayName: string;
  /** Called after a successful delete with the deleted item's workspaceId. */
  onDeleted: (workspaceId: string) => void;
}

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: '14px', minWidth: '460px' },
  hint: { color: tokens.colorNeutralForeground3 },
  checks: { display: 'flex', flexDirection: 'column', gap: '6px', margin: '2px 0' },
  checkRow: { display: 'flex', alignItems: 'center', gap: '8px' },
  okIcon: { color: tokens.colorPaletteGreenForeground1 },
  blockers: { margin: '4px 0 0 18px', display: 'flex', flexDirection: 'column', gap: '6px' },
});

export function DeleteDataProductDialog({
  open, onOpenChange, id, displayName, onDeleted,
}: DeleteDataProductDialogProps) {
  const s = useStyles();
  const [loading, setLoading] = useState(false);
  const [preflight, setPreflight] = useState<PreflightResponse | null>(null);
  const [preflightErr, setPreflightErr] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const [deleteBlockers, setDeleteBlockers] = useState<string[] | null>(null);
  const [done, setDone] = useState(false);

  // The authoritative name to type comes from the preflight (falls back to the
  // optimistic prop until it returns).
  const name = preflight?.displayName ?? displayName;

  // Run the preconditions preflight each time the dialog opens; reset on close.
  useEffect(() => {
    if (!open) {
      setPreflight(null); setPreflightErr(null); setConfirmText('');
      setDeleteErr(null); setDeleteBlockers(null); setDone(false); setBusy(false);
      return;
    }
    let cancelled = false;
    setLoading(true); setPreflightErr(null);
    (async () => {
      try {
        const r = await fetch(`/api/data-products/${encodeURIComponent(id)}`);
        const j: PreflightResponse = await r.json();
        if (cancelled) return;
        if (!j.ok) setPreflightErr(j.error || `HTTP ${r.status}`);
        else setPreflight(j);
      } catch (e: any) {
        if (!cancelled) setPreflightErr(e?.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, id]);

  const canDelete = !!preflight?.preconditions?.canDelete;
  const confirmMatches = confirmText === name && name.length > 0;

  const onConfirm = useCallback(async () => {
    setBusy(true); setDeleteErr(null); setDeleteBlockers(null);
    try {
      const r = await fetch(`/api/data-products/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      if (!j.ok) {
        setDeleteErr(j.error || `HTTP ${r.status}`);
        if (Array.isArray(j.blockers)) setDeleteBlockers(j.blockers);
        setBusy(false);
        return;
      }
      setDone(true);
      // Brief success flash, then route back to the list.
      setTimeout(() => onDeleted(String(j.workspaceId || '')), 700);
    } catch (e: any) {
      setDeleteErr(e?.message || String(e));
      setBusy(false);
    }
  }, [id, onDeleted]);

  const pc = preflight?.preconditions;
  const cur = preflight?.current;

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            {canDelete
              ? <><Delete20Regular style={{ verticalAlign: 'middle', marginRight: 8 }} />Delete &ldquo;{name}&rdquo;</>
              : <><Warning20Regular style={{ verticalAlign: 'middle', marginRight: 8 }} />Cannot delete — preconditions not met</>}
          </DialogTitle>
          <DialogContent>
            <div className={s.body}>
              {loading && <Spinner size="tiny" label="Checking preconditions…" labelPosition="after" />}

              {preflightErr && (
                <MessageBar intent="error">
                  <MessageBarBody>
                    <MessageBarTitle>Could not evaluate preconditions</MessageBarTitle>
                    {preflightErr}
                  </MessageBarBody>
                </MessageBar>
              )}

              {!loading && !preflightErr && pc && cur && !canDelete && (
                <>
                  <Body1>
                    A data product can only be deleted when it is in <strong>Draft</strong> or
                    {' '}<strong>Expired</strong> status with no data assets, no linked glossary
                    terms, and no open access requests. Resolve the items below first.
                  </Body1>
                  <div className={s.blockers}>
                    {!pc.statusAllowed && (
                      <MessageBar intent="error"><MessageBarBody>
                        Status is &lsquo;{cur.lifecycleStatus}&rsquo; — set the lifecycle status to Draft or Expired first.
                      </MessageBarBody></MessageBar>
                    )}
                    {!pc.datasetsEmpty && (
                      <MessageBar intent="error"><MessageBarBody>
                        {cur.datasetCount} data asset(s) attached — remove them in the Datasets tab.
                      </MessageBarBody></MessageBar>
                    )}
                    {!pc.glossaryEmpty && (
                      <MessageBar intent="error"><MessageBarBody>
                        {cur.glossaryCount} glossary term(s) linked — unlink them in the Glossary tab.
                      </MessageBarBody></MessageBar>
                    )}
                    {!pc.noOpenAccessRequests && (
                      <MessageBar intent="error"><MessageBarBody>
                        {cur.openAccessRequestCount} open access request(s) — delete them in Governance → Policies.
                      </MessageBarBody></MessageBar>
                    )}
                  </div>
                </>
              )}

              {!loading && !preflightErr && pc && cur && canDelete && !done && (
                <>
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>This permanently removes the data product.</MessageBarTitle>
                      The Cosmos record is deleted and removed from the catalog index. This cannot be undone.
                    </MessageBarBody>
                  </MessageBar>

                  <div className={s.checks}>
                    <div className={s.checkRow}><Checkmark20Regular className={s.okIcon} /><Caption1>Status is {cur.lifecycleStatus} (Draft/Expired)</Caption1></div>
                    <div className={s.checkRow}><Checkmark20Regular className={s.okIcon} /><Caption1>No data assets attached</Caption1></div>
                    <div className={s.checkRow}><Checkmark20Regular className={s.okIcon} /><Caption1>No glossary terms linked</Caption1></div>
                    <div className={s.checkRow}><Checkmark20Regular className={s.okIcon} /><Caption1>No open access requests</Caption1></div>
                  </div>

                  <Field label={`Type "${name}" to confirm`}>
                    <Input
                      value={confirmText}
                      onChange={(_, d) => setConfirmText(d.value)}
                      placeholder={name}
                      disabled={busy}
                    />
                  </Field>

                  {deleteErr && (
                    <MessageBar intent="error">
                      <MessageBarBody>
                        <MessageBarTitle>Delete failed</MessageBarTitle>
                        {deleteErr}
                        {deleteBlockers && deleteBlockers.length > 0 && (
                          <ul style={{ margin: '6px 0 0 18px' }}>
                            {deleteBlockers.map((b, i) => <li key={i}>{b}</li>)}
                          </ul>
                        )}
                      </MessageBarBody>
                    </MessageBar>
                  )}
                </>
              )}

              {done && (
                <MessageBar intent="success">
                  <MessageBarBody>
                    <MessageBarTitle>Deleted</MessageBarTitle>
                    &ldquo;{name}&rdquo; was deleted. Returning to the workspace…
                  </MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              {canDelete && !done ? 'Cancel' : 'Close'}
            </Button>
            {canDelete && !done && (
              <Button
                appearance="primary"
                icon={<Delete20Regular />}
                onClick={onConfirm}
                disabled={!confirmMatches || busy}
                style={{ backgroundColor: confirmMatches && !busy ? tokens.colorPaletteRedBackground3 : undefined }}
              >
                {busy ? 'Deleting…' : 'Delete data product'}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
