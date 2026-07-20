'use client';

/**
 * RequestAccessInline (access-governance W4, AG-13) — the ONE shared "Request
 * access" affordance rendered on any 403 / honest access-gate, pre-scoped to the
 * resource the caller was denied. It discovers the access PACKAGE(s) that would
 * grant that resource (GET /api/access-packages?resourceRef=…) and lets the user
 * request one in a click (POST /api/access-packages/[id]/request → the real F16
 * approval spine). When no package grants the resource, it links to the governed
 * catalog request flow — never a dead end.
 *
 * Real backends only (no mock packages). Fluent v9 + Loom tokens; badges wrap
 * (flexWrap + minWidth:0) per ux-baseline. Drop it beside any HonestGate:
 *   <RequestAccessInline resourceType="workspace" resourceRef={id} resourceName={name} />
 */
import { useCallback, useEffect, useState } from 'react';
import {
  makeStyles, tokens, Button, Caption1, Badge, Spinner, Text,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Radio, RadioGroup,
} from '@fluentui/react-components';
import { KeyReset20Regular, Open16Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';

interface QualifyingPackage {
  id: string;
  name: string;
  description?: string;
  defaultLifetimeDays?: number | null;
  activationRequired?: boolean;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  pkgRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  badges: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0, marginTop: tokens.spacingVerticalXXS },
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalS },
  meta: { color: tokens.colorNeutralForeground3 },
});

export function RequestAccessInline({
  resourceType,
  resourceRef,
  resourceName,
  buttonAppearance = 'primary',
}: {
  resourceType?: string;
  resourceRef: string;
  resourceName?: string;
  buttonAppearance?: 'primary' | 'secondary' | 'outline';
}) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [packages, setPackages] = useState<QualifyingPackage[] | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null); setNote(null); setPackages(null);
    try {
      const r = await clientFetch(`/api/access-packages?resourceRef=${encodeURIComponent(resourceRef)}`);
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); setPackages([]); return; }
      const pkgs: QualifyingPackage[] = j.packages || [];
      setPackages(pkgs);
      if (pkgs.length === 1) setSelected(pkgs[0].id);
    } catch (e: any) { setErr(e?.message || String(e)); setPackages([]); }
  }, [resourceRef]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  const submit = useCallback(async () => {
    if (!selected) return;
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await clientFetch(`/api/access-packages/${encodeURIComponent(selected)}/request`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) { setErr(j.detail || j.error || `HTTP ${r.status}`); return; }
      setNote(j.message || `Requested — ${j.created} approval(s) opened.`);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [selected]);

  return (
    <div className={s.root}>
      <Button appearance={buttonAppearance} icon={<KeyReset20Regular />} onClick={() => setOpen(true)}>
        Request access
      </Button>

      <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) { setOpen(false); setNote(null); setErr(null); } }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Request access to {resourceName || resourceRef}</DialogTitle>
            <DialogContent>
              <Caption1 className={s.meta}>
                {resourceType ? `${resourceType} · ` : ''}{resourceRef}
              </Caption1>

              {packages === null && <div style={{ marginTop: tokens.spacingVerticalM }}><Spinner size="tiny" label="Finding access packages…" labelPosition="after" /></div>}

              {note && <MessageBar intent="success" style={{ marginTop: tokens.spacingVerticalM }}><MessageBarBody>{note}</MessageBarBody></MessageBar>}
              {err && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}><MessageBarBody><MessageBarTitle>Request failed</MessageBarTitle>{err}</MessageBarBody></MessageBar>}

              {packages && packages.length > 0 && !note && (
                <div className={s.list}>
                  <Text weight="semibold">Choose an access package that grants this resource:</Text>
                  <RadioGroup value={selected} onChange={(_, d) => setSelected(d.value)}>
                    {packages.map((p) => (
                      <Radio
                        key={p.id}
                        value={p.id}
                        label={
                          <div className={s.pkgRow}>
                            <Text>{p.name}</Text>
                            {p.description && <Caption1 className={s.meta}>{p.description}</Caption1>}
                            <div className={s.badges}>
                              {p.activationRequired && <Badge appearance="tint" color="brand" size="small">Activation required</Badge>}
                              {typeof p.defaultLifetimeDays === 'number' && p.defaultLifetimeDays > 0 && (
                                <Badge appearance="tint" color="informative" size="small">{p.defaultLifetimeDays}-day access</Badge>
                              )}
                            </div>
                          </div>
                        }
                      />
                    ))}
                  </RadioGroup>
                </div>
              )}

              {packages && packages.length === 0 && !err && (
                <MessageBar intent="info" layout="multiline" style={{ marginTop: tokens.spacingVerticalM }}>
                  <MessageBarBody>
                    <MessageBarTitle>No access package grants this resource</MessageBarTitle>
                    Request it directly through the governed access-request workflow — an approver can grant scoped access to this resource.
                  </MessageBarBody>
                </MessageBar>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => { setOpen(false); setNote(null); setErr(null); }}>
                {note ? 'Done' : 'Cancel'}
              </Button>
              {packages && packages.length > 0 && !note && (
                <Button appearance="primary" disabled={!selected || busy} icon={busy ? <Spinner size="tiny" /> : undefined} onClick={() => void submit()}>
                  Request package
                </Button>
              )}
              {packages && packages.length === 0 && (
                <Button as="a" appearance="primary" icon={<Open16Regular />} href="/governance/access-requests">
                  Open request workflow
                </Button>
              )}
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
