'use client';

// data-product/publish-as-api-dialog.tsx — F21 Publish-as-API dialog,
// extracted verbatim from data-product-editor.tsx (WS-E1 / R8 decomposition,
// pure move — no behavior change).
import {
  Body1, Caption1, Button, Input, Field,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  tokens,
} from '@fluentui/react-components';
import { Copy20Regular, Eye20Regular, EyeOff20Regular, Key20Regular } from '@fluentui/react-icons';

export interface PublishAsApiResult {
  callableUrl: string;
  primaryKey?: string;
  apiId: string;
  productId: string;
  sid: string;
  gatewayUrl: string;
}

export interface PublishAsApiGate {
  hint: string;
  missing?: string;
  bicepModule?: string;
}

/**
 * F21 — Publish-as-API dialog. Captures the backing query endpoint, POSTs to
 * /publish-api, and on success renders the consumable URL + masked subscription
 * key + a copy-paste curl example. Honest-gates when APIM env vars are absent.
 */
export function PublishAsApiDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serviceUrl: string;
  onServiceUrlChange: (v: string) => void;
  busy: boolean;
  result: PublishAsApiResult | null;
  gate: PublishAsApiGate | null;
  err: string | null;
  keyVisible: boolean;
  onToggleKey: () => void;
  onPublish: () => void;
  republish: boolean;
}) {
  const { open, onOpenChange, serviceUrl, onServiceUrlChange, busy, result, gate, err, keyVisible, onToggleKey, onPublish, republish } = props;
  const copy = (text: string) => { try { void navigator.clipboard?.writeText(text); } catch { /* clipboard unavailable */ } };
  const curl = result
    ? `curl "${result.callableUrl}" \\\n  -H "Ocp-Apim-Subscription-Key: ${result.primaryKey || '<your-subscription-key>'}"`
    : '';
  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: 640 }}>
        <DialogBody>
          <DialogTitle>{republish ? 'Re-publish data product as API' : 'Publish data product as API'}</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              <Body1>
                Front this data product&apos;s backing query endpoint with Azure API Management. Loom creates an APIM
                API + published product, mints an active subscription key, and returns a consumable URL. The API ref is
                persisted on the data product.
              </Body1>
              {gate && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Azure API Management is not configured in this deployment</MessageBarTitle>
                    {gate.missing && <>Missing env var: <code>{gate.missing}</code>. </>}
                    {gate.hint}
                    {gate.bicepModule && <> Bicep module: <code>{gate.bicepModule}</code>.</>}
                  </MessageBarBody>
                </MessageBar>
              )}
              {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
              {!result && (
                <Field label="Backing service URL (the query endpoint APIM proxies to)" required
                  hint="The HTTPS endpoint that serves this data product's data — e.g. a Data API Builder route, a Function, or a Synapse SQL serverless REST surface.">
                  <Input value={serviceUrl} onChange={(_, d) => onServiceUrlChange(d.value)} placeholder="https://dab.internal.example.com/api/silver_revenue" />
                </Field>
              )}
              {result && (
                <MessageBar intent="success">
                  <MessageBarBody>
                    <MessageBarTitle>API published — endpoint is live</MessageBarTitle>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalXXS }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
                        <strong>Consumable URL:</strong>
                        <code style={{ wordBreak: 'break-all' }}>{result.callableUrl}</code>
                        <Button size="small" appearance="subtle" icon={<Copy20Regular />} onClick={() => copy(result.callableUrl)}>Copy</Button>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
                        <strong>Header:</strong>
                        <code>Ocp-Apim-Subscription-Key:</code>
                        <code>{keyVisible ? (result.primaryKey || '—') : '••••••••••••••••'}</code>
                        <Button size="small" appearance="subtle" icon={keyVisible ? <EyeOff20Regular /> : <Eye20Regular />} onClick={onToggleKey}>{keyVisible ? 'Hide' : 'Reveal'}</Button>
                        {result.primaryKey && <Button size="small" appearance="subtle" icon={<Copy20Regular />} onClick={() => copy(result.primaryKey!)}>Copy key</Button>}
                      </div>
                      <Caption1>This subscription key is shown once and is not stored on the item — copy it now. Manage or regenerate it in the APIM navigator (subscription <code>{result.sid}</code>).</Caption1>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalS }}>
                        <pre style={{ flex: 1, margin: tokens.spacingVerticalNone, padding: tokens.spacingVerticalS, background: tokens.colorNeutralBackground3, borderRadius: tokens.borderRadiusMedium, fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{curl}</pre>
                        <Button size="small" appearance="subtle" icon={<Copy20Regular />} onClick={() => copy(curl)}>Copy curl</Button>
                      </div>
                      <Caption1>API <code>{result.apiId}</code> · Product <code>{result.productId}</code> · Gateway <code>{result.gatewayUrl}</code></Caption1>
                    </div>
                  </MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            {!result && (
              <Button appearance="primary" icon={<Key20Regular />} onClick={onPublish} disabled={busy || !serviceUrl.trim() || !!gate}>
                {busy ? 'Publishing…' : republish ? 'Re-publish API' : 'Publish API'}
              </Button>
            )}
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">{result ? 'Done' : 'Cancel'}</Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
