'use client';

/**
 * HonestGate (G2) — the ONE shared infra-gate surface, driven by the central
 * gate registry (lib/gates/registry.ts, itself derived from self-audit
 * ENV_CHECKS). Replaces the ~50 bespoke `intent="warning"` MessageBars.
 *
 * Anatomy (generalized from lib/components/purview-gate.tsx):
 *   - a Fluent MessageBar naming the EXACT env var(s), bicep module, and RBAC
 *     role the gate needs (never a generic stub banner — no-vaporware.md),
 *   - an inline **Fix it** Button opening a wizard dialog that loads REAL
 *     options (live ARM discovery via GET /api/admin/gates/[id]/options — e.g.
 *     every Synapse workspace / Event Hubs namespace / AOAI deployment in the
 *     subscription), lets the operator pick or type, and applies via
 *     POST /api/admin/gates/[id]/resolve — the SAME whitelisted env-write path
 *     as /admin/env-config (ACA revision roll + Cosmos + audit),
 *   - HONEST apply latency: after apply the dialog shows "new revision rolling
 *     (~1–2 min)" and polls the registry until the gate flips to configured,
 *   - a link to the complete registry at /admin/gates.
 *
 * Usage from any surface that received a not_configured gate response:
 *   <HonestGate gateId="svc-aoai" surface="SQL Copilot"
 *               missing={body.missing} onResolved={refetch} />
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Button, Caption1, Spinner, Badge, Field, Input, Combobox, Option,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Wrench16Regular, Open16Regular, ArrowSync16Regular, CheckmarkCircle20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { getGate, type GateDef, type GateRequiredSetting } from '@/lib/gates/registry';

const useStyles = makeStyles({
  bar: { marginBottom: tokens.spacingVerticalL },
  list: {
    marginTop: tokens.spacingVerticalSNudge,
    marginBottom: tokens.spacingVerticalSNudge,
    paddingLeft: tokens.spacingHorizontalXL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
  },
  meta: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
  fields: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    marginTop: tokens.spacingVerticalS,
  },
  applying: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalS,
  },
  liveRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalM,
  },
});

interface GateOption { value: string; label: string; resourceId: string }

function isSecretVar(k: string): boolean {
  return /SECRET|PASSWORD|CONNECTION_STRING|CONNECTIONSTRING|_KEY$|_KEYS$|_PWD$|TOKEN$/i.test(k);
}

/**
 * The Fix-it wizard dialog. Loads real ARM options for the gate's settings,
 * lets the operator pick/type values, applies through the shared resolve
 * route, then polls the registry until the new revision makes the gate
 * configured (honest about the ~1–2 min roll — never a fake instant flip).
 */
export function GateFixitDialog({
  gate,
  open,
  onClose,
  onResolved,
}: {
  gate: GateDef;
  open: boolean;
  onClose: () => void;
  onResolved?: () => void;
}) {
  const s = useStyles();
  const [options, setOptions] = useState<Record<string, GateOption[]>>({});
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applied, setApplied] = useState<{ message: string; driftWarning?: string } | null>(null);
  const [rolled, setRolled] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadOptions = useCallback(async () => {
    setLoadingOptions(true);
    setOptionsError(null);
    try {
      const r = await clientFetch(`/api/admin/gates/${gate.id}/options`);
      const j = await r.json().catch(() => null);
      if (j?.ok) setOptions(j.options || {});
      else setOptionsError(j?.error || `options load failed (${r.status})`);
    } catch (e: any) {
      setOptionsError(e?.message || String(e));
    } finally {
      setLoadingOptions(false);
    }
  }, [gate.id]);

  useEffect(() => {
    if (open) {
      setValues({});
      setApplied(null);
      setApplyError(null);
      setRolled(false);
      void loadOptions();
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [open, loadOptions]);

  // After a successful apply, poll the registry until the revision rolls and
  // the gate reports configured (bounded: 12 × 15 s = 3 min).
  const startPoll = useCallback(() => {
    let tries = 0;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      tries += 1;
      try {
        const r = await clientFetch('/api/admin/gates');
        const j = await r.json().catch(() => null);
        const g = j?.gates?.find((x: any) => x.id === gate.id);
        if (g?.status === 'configured') {
          if (pollRef.current) clearInterval(pollRef.current);
          setRolled(true);
          onResolved?.();
        }
      } catch { /* transient — keep polling */ }
      if (tries >= 12 && pollRef.current) clearInterval(pollRef.current);
    }, 15_000);
  }, [gate.id, onResolved]);

  const apply = useCallback(async () => {
    setApplying(true);
    setApplyError(null);
    try {
      const submit: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) if (v.trim()) submit[k] = v.trim();
      const r = await clientFetch(`/api/admin/gates/${gate.id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: submit }),
      });
      const j = await r.json().catch(() => null);
      if (j?.ok) {
        setApplied({ message: j.message, driftWarning: j.driftWarning });
        if (j.changedCount > 0) startPoll();
      } else {
        setApplyError(j?.error || j?.remediation || `apply failed (${r.status})`);
      }
    } catch (e: any) {
      setApplyError(e?.message || String(e));
    } finally {
      setApplying(false);
    }
  }, [gate.id, values, startPoll]);

  const anyValue = Object.values(values).some((v) => v.trim().length > 0);
  const grantOnly = gate.fixit.kind === 'role-grant' && gate.requiredSettings.length === 0;

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Fix it — {gate.title}</DialogTitle>
          <DialogContent>
            <Caption1 className={s.meta}>{gate.remediation}</Caption1>
            {gate.role && (
              <div className={s.meta} style={{ marginTop: tokens.spacingVerticalS }}>
                <strong>Role required once set:</strong> {gate.role}
              </div>
            )}
            {gate.fixit.grantNote && (
              <MessageBar intent="info" layout="multiline" style={{ marginTop: tokens.spacingVerticalS }}>
                <MessageBarBody>{gate.fixit.grantNote}</MessageBarBody>
              </MessageBar>
            )}
            {optionsError && (
              <MessageBar intent="warning" layout="multiline" style={{ marginTop: tokens.spacingVerticalS }}>
                <MessageBarBody>
                  <MessageBarTitle>Live discovery unavailable</MessageBarTitle>
                  {optionsError} — enter the value(s) manually below.
                </MessageBarBody>
              </MessageBar>
            )}
            {loadingOptions && (
              <div className={s.applying}><Spinner size="tiny" /><Caption1>Discovering live Azure resources…</Caption1></div>
            )}
            {!grantOnly && (
              <div className={s.fields}>
                {gate.requiredSettings.map((setting: GateRequiredSetting) => {
                  const opts = options[setting.envVar] || [];
                  const secret = isSecretVar(setting.envVar);
                  const hint = setting.valueHint || setting.description;
                  return (
                    <Field
                      key={setting.envVar}
                      label={setting.envVar}
                      hint={setting.aliasOf ? `Any ONE of ${setting.aliasOf.join(' / ')} satisfies this.` : hint}
                    >
                      {opts.length > 0 ? (
                        <Combobox
                          freeform
                          placeholder={`Pick a discovered resource or type a value (${opts.length} found)`}
                          value={values[setting.envVar] ?? ''}
                          onOptionSelect={(_, d) =>
                            setValues((v) => ({ ...v, [setting.envVar]: String(d.optionValue ?? d.optionText ?? '') }))}
                          onChange={(e) =>
                            setValues((v) => ({ ...v, [setting.envVar]: e.target.value }))}
                        >
                          {opts.map((o) => (
                            <Option key={o.resourceId + o.value} value={o.value} text={o.value}>
                              {o.label}
                            </Option>
                          ))}
                        </Combobox>
                      ) : (
                        <Input
                          type={secret ? 'password' : 'text'}
                          placeholder={hint}
                          value={values[setting.envVar] ?? ''}
                          onChange={(e) => setValues((v) => ({ ...v, [setting.envVar]: e.target.value }))}
                        />
                      )}
                    </Field>
                  );
                })}
              </div>
            )}
            {applyError && (
              <MessageBar intent="error" layout="multiline" style={{ marginTop: tokens.spacingVerticalS }}>
                <MessageBarBody>{applyError}</MessageBarBody>
              </MessageBar>
            )}
            {applied && (
              <MessageBar intent={rolled ? 'success' : 'info'} layout="multiline" style={{ marginTop: tokens.spacingVerticalS }}>
                <MessageBarBody>
                  <MessageBarTitle>{rolled ? 'Gate resolved' : 'Applying'}</MessageBarTitle>
                  {rolled
                    ? 'The new revision is live and the gate now reports configured.'
                    : applied.message}
                  {!rolled && (
                    <div className={s.applying}>
                      <Spinner size="tiny" />
                      <Caption1>New revision rolling (~1–2 min) — this dialog re-probes the gate automatically.</Caption1>
                    </div>
                  )}
                  {applied.driftWarning && (
                    <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXS }}>
                      {applied.driftWarning}
                    </Caption1>
                  )}
                </MessageBarBody>
              </MessageBar>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Close</Button>
            {!grantOnly && (
              <Button
                appearance="primary"
                icon={applying ? <Spinner size="tiny" /> : <Wrench16Regular />}
                disabled={!anyValue || applying}
                onClick={apply}
              >
                Apply
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/**
 * The gate banner. When `configured` is true renders a compact live chip (so
 * surfaces can always mount it); otherwise the actionable warning bar with the
 * inline Fix-it wizard. `missing` (from the surface's own gate response)
 * narrows the message to the exact unmet vars.
 */
export function HonestGate({
  gateId,
  gate: envelope,
  surface,
  missing,
  configured = false,
  detail,
  onResolved,
}: {
  /** Gate id — OR pass the whole `gate` envelope block below and this is derived. */
  gateId?: string;
  /**
   * WS-D2: the normalized gate block from a route's `buildGateEnvelope` response
   * (`{ ok:false, gated:true, gate:{ id, title, remediation, fixItHref, missing } }`).
   * When provided, gateId/missing/detail are sourced from it so ANY gated route
   * renders through this ONE renderer uniformly — no per-surface re-derivation.
   */
  gate?: { id: string; title?: string; remediation?: string; fixItHref?: string; missing?: string[] };
  /** Human name of the calling surface (e.g. 'SQL Copilot'). */
  surface: string;
  /** The exact missing env var(s) the surface's API reported. */
  missing?: string[] | string;
  /** True renders the compact "live" confirmation chip instead of the bar. */
  configured?: boolean;
  /** Optional extra detail from the surface's gate response. */
  detail?: string;
  /** Called when the Fix-it wizard confirms the gate flipped to configured. */
  onResolved?: () => void;
}) {
  const s = useStyles();
  const [fixOpen, setFixOpen] = useState(false);
  // Envelope-driven: derive id/missing/detail from the route's gate block.
  const resolvedId = gateId ?? envelope?.id ?? '';
  const resolvedMissing = missing ?? envelope?.missing;
  const resolvedDetail = detail ?? envelope?.remediation;
  const gate = useMemo(() => getGate(resolvedId), [resolvedId]);

  if (!gate) {
    // Unknown id — render an honest generic bar rather than nothing.
    return (
      <MessageBar intent="warning" layout="multiline" className={s.bar}>
        <MessageBarBody>
          <MessageBarTitle>{surface} needs configuration</MessageBarTitle>
          {resolvedDetail || `Gate '${resolvedId}' is not in the registry — see /admin/gates.`}
        </MessageBarBody>
      </MessageBar>
    );
  }

  if (configured) {
    return (
      <div className={s.liveRow}>
        <CheckmarkCircle20Regular style={{ color: tokens.colorPaletteGreenForeground1 }} />
        <Caption1>{gate.title} connected</Caption1>
        <Badge appearance="tint" color="success" size="small">live</Badge>
        {onResolved && (
          <Button size="small" appearance="transparent" icon={<ArrowSync16Regular />} onClick={onResolved}>
            Recheck
          </Button>
        )}
      </div>
    );
  }

  const missingList = (Array.isArray(resolvedMissing) ? resolvedMissing : resolvedMissing ? [resolvedMissing] : [])
    .filter(Boolean);

  return (
    <>
      <MessageBar intent="warning" layout="multiline" className={s.bar}>
        <MessageBarBody>
          <MessageBarTitle>{surface} needs {gate.title} wired in this deployment</MessageBarTitle>
          {resolvedDetail || gate.remediation}
          <ul className={s.list}>
            {missingList.length > 0 && (
              <li>Set {missingList.map((m, i) => (
                <span key={m}>{i > 0 && ', '}<code>{m}</code></span>
              ))} on the Loom Console app.</li>
            )}
            {gate.provisionedBy && (
              <li className={s.meta}>Provisioned by <code>{gate.provisionedBy}</code></li>
            )}
            {gate.role && <li className={s.meta}>Role: {gate.role}</li>}
            {gate.canAutoResolve && gate.autoResolveNote && (
              <li className={s.meta}>{gate.autoResolveNote}</li>
            )}
          </ul>
        </MessageBarBody>
        <MessageBarActions>
          <Button size="small" appearance="primary" icon={<Wrench16Regular />} onClick={() => setFixOpen(true)}>
            Fix it
          </Button>
          <Button as="a" size="small" appearance="transparent" icon={<Open16Regular />} href="/admin/gates">
            Gate registry
          </Button>
          {onResolved && (
            <Button size="small" appearance="transparent" icon={<ArrowSync16Regular />} onClick={onResolved}>
              Recheck
            </Button>
          )}
        </MessageBarActions>
      </MessageBar>
      <GateFixitDialog gate={gate} open={fixOpen} onClose={() => setFixOpen(false)} onResolved={onResolved} />
    </>
  );
}
