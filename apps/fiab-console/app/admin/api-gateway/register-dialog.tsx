'use client';

/**
 * Register a gateway by APIM resource id (W1-5). The API runs the access preflight; whatever it
 * says (invalid id, already registered, missing role + the exact az command) is shown verbatim -
 * the UI never rewrites the cause. A successful registration kicks the first inventory sync
 * automatically (auto-bind-by-default: no second step for the user).
 */
import { useState } from 'react';
import {
  Body1, Button, Caption1, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
  Field, Input, MessageBar, MessageBarBody, makeStyles, tokens,
} from '@fluentui/react-components';
import { Copy16Regular } from '@fluentui/react-icons';
import type { GatewayDoc } from '@/lib/api-gateway/registry/types';
import { registerGateway, syncGateway, type HubResult } from './_lib/hub-api';

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  command: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    padding: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    overflowWrap: 'anywhere',
    whiteSpace: 'pre-wrap',
  },
  muted: { color: tokens.colorNeutralForeground3, overflowWrap: 'anywhere' },
});

export function RegisterGatewayDialog({ open, onClose, onRegistered }: {
  open: boolean;
  onClose: () => void;
  onRegistered: (gw: GatewayDoc) => void;
}) {
  const s = useStyles();
  const [resourceId, setResourceId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<HubResult<GatewayDoc> | null>(null);
  const [copied, setCopied] = useState(false);

  const submit = async () => {
    setBusy(true);
    setFail(null);
    const r = await registerGateway(resourceId.trim(), displayName.trim() || undefined);
    if (!r.ok || !r.data) {
      setBusy(false);
      setFail(r);
      return;
    }
    // First inventory read happens for the user; a failure here is not a registration failure
    // (the detail view offers Sync again), so it is not surfaced as an error on first open.
    await syncGateway(r.data.id);
    setBusy(false);
    setResourceId('');
    setDisplayName('');
    onRegistered(r.data);
  };

  const rg = fail?.missingRole;
  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open && !busy) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Register a gateway</DialogTitle>
          <DialogContent>
            <div className={s.form}>
              <Body1>
                Register an existing Azure API Management service. Loom checks what the Console identity can do
                at that scope and reads its inventory; nothing is changed in the service.
              </Body1>
              <Field label="APIM resource id" required>
                <Input
                  value={resourceId}
                  onChange={(_, d) => setResourceId(d.value)}
                  placeholder="/subscriptions/<guid>/resourceGroups/<rg>/providers/Microsoft.ApiManagement/service/<name>"
                />
              </Field>
              <Field label="Display name (optional)">
                <Input value={displayName} onChange={(_, d) => setDisplayName(d.value)} />
              </Field>
              {fail && (
                <MessageBar intent="warning" data-testid="register-error">
                  <MessageBarBody>{fail.error ?? `Registration failed (HTTP ${fail.status}).`}</MessageBarBody>
                </MessageBar>
              )}
              {rg && (
                <>
                  <Caption1 className={s.muted}>Grant {rg.roleName} at {rg.scope}, then register again.</Caption1>
                  <div className={s.command}>{rg.azCommand}</div>
                  <Button
                    size="small"
                    icon={<Copy16Regular />}
                    onClick={async () => {
                      try { await navigator.clipboard.writeText(rg.azCommand); setCopied(true); } catch { setCopied(false); }
                    }}
                  >
                    {copied ? 'Copied' : 'Copy az command'}
                  </Button>
                </>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" disabled={busy || !resourceId.trim()} onClick={submit}>
              {busy ? 'Registering...' : 'Register'}
            </Button>
            <Button appearance="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
