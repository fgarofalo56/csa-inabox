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
  Button, Caption1, Spinner, Badge, Field, Input, Combobox, Option, Tooltip,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Wrench16Regular, Open16Regular, ArrowSync16Regular, CheckmarkCircle20Regular,
  CloudDismiss20Regular, ArrowRight16Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { getGate, type GateDef, type GateRequiredSetting } from '@/lib/gates/registry';
import { isSecretEnvKey } from '@/lib/util/secret-env-key';

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

/**
 * Whether this setting's value must be typed into a PASSWORD field.
 *
 * Was a local regex — `…|_KEY$|_KEYS$|_PWD$|TOKEN$/i` — which is the second of
 * two copies of the same question. env-config.ts held the other, with a
 * DIFFERENT list (`_WEBHOOK_URL$` instead of `TOKEN$`), so a Teams webhook URL
 * was masked in the support bundle and typed in cleartext HERE. Both also
 * carried the #2772 mixed-anchor parse trap. One shared rule now — see
 * lib/util/secret-env-key.ts.
 */
function isSecretVar(k: string): boolean {
  return isSecretEnvKey(k);
}

/** Live probe result behind a capability, when the caller has one. */
export interface GateProbeSummary {
  id: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
  remediation?: string;
  /** True when the probe did not complete — it established nothing. */
  inconclusive?: boolean;
}

/**
 * The Fix-it wizard dialog. Loads real ARM options for the gate's settings,
 * PRE-FILLS every field from the running deployment's current values, lets the
 * operator pick/type, applies through the shared resolve route, then polls the
 * registry until the new revision makes the gate configured (honest about the
 * ~1–2 min roll — never a fake instant flip).
 *
 * TWO DIFFERENT BLOCKERS, TWO DIFFERENT REMEDIATIONS (#3729). A gate can be
 * unresolved because (1) its env values are missing — the form below IS the
 * fix — or (2) its env values are all present and a LIVE PROBE is what failed.
 * Until #3729 the dialog rendered case (2) exactly like case (1): three empty
 * inputs with placeholder text, for `LOOM_SUBSCRIPTION_ID`, `LOOM_DLZ_RG` and
 * `LOOM_ADMIN_RG` values the deployment already held and that were never the
 * problem. Retyping them could not have addressed the stated diagnosis, so the
 * button was worse than no button. The dialog now leads with whichever of the
 * two is actually true.
 */
export function GateFixitDialog({
  gate,
  open,
  onClose,
  onResolved,
  probe = null,
  capabilityState,
  onRecheck,
}: {
  gate: GateDef;
  open: boolean;
  onClose: () => void;
  onResolved?: () => void;
  /** The capability's live probe result, when the caller has one. */
  probe?: GateProbeSummary | null;
  /** The capability's readiness state, when the caller has one. */
  capabilityState?: 'ready' | 'partial' | 'blocked' | 'opt-in' | 'unknown';
  /** Re-run the live probes (bypassing the probe cache) and reload the caller. */
  onRecheck?: () => void;
}) {
  const s = useStyles();
  const [options, setOptions] = useState<Record<string, GateOption[]>>({});
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  /** Values as they are RIGHT NOW in the running deployment (non-secret only). */
  const [currentValues, setCurrentValues] = useState<Record<string, string>>({});
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applied, setApplied] = useState<{ message: string; driftWarning?: string } | null>(null);
  const [rolled, setRolled] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadOptions = useCallback(async () => {
    // Skip the ARM discovery call entirely when NO required setting has a live
    // loader (an env-picker-only / free-text gate, e.g. svc-loom-trino). The
    // route can only 503 (no LOOM_SUBSCRIPTION_ID), 502 (ARM token), or return
    // an empty {} for these — so the fetch surfaces a spurious "Live discovery
    // unavailable" error on a gate that never needed discovery (issue #2753).
    const anyLoader = gate.requiredSettings.some((s) => !!s.loader);
    if (!anyLoader) {
      setOptions({});
      setOptionsError(null);
      setLoadingOptions(false);
      return;
    }
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
  }, [gate.id, gate.requiredSettings]);

  /**
   * Load the CURRENT values from the running deployment so every field opens
   * pre-filled instead of blank.
   *
   * `/api/admin/env-config` is the same authoritative read `/admin/env-config`
   * renders and is behind the SAME `admin.env-config` capability this dialog
   * already requires, so this adds no new authorization surface. Secret-typed
   * keys report `{ set: true }` with NO value — they stay blank here, by design.
   */
  const loadCurrent = useCallback(async () => {
    setCurrentError(null);
    try {
      const r = await clientFetch('/api/admin/env-config');
      const j = await r.json().catch(() => null);
      if (!j?.ok) { setCurrentError(j?.error || `current config unavailable (${r.status})`); return; }
      const cur: Record<string, string> = {};
      for (const setting of gate.requiredSettings) {
        const row = j.current?.[setting.envVar];
        if (row && !row.secret && typeof row.value === 'string' && row.value.length > 0) {
          cur[setting.envVar] = row.value;
        }
      }
      setCurrentValues(cur);
      // Seed the editable form with what is live. An admin who changes nothing
      // and clicks Apply therefore submits no delta — the resolve route diffs
      // against the running env, so a no-op stays a no-op.
      setValues((v) => ({ ...cur, ...v }));
    } catch (e: any) {
      setCurrentError(e?.message || String(e));
    }
  }, [gate.requiredSettings]);

  useEffect(() => {
    if (open) {
      setValues({});
      setCurrentValues({});
      setApplied(null);
      setApplyError(null);
      setRolled(false);
      void loadOptions();
      void loadCurrent();
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [open, loadOptions, loadCurrent]);

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

  /** True when the operator has actually changed something vs the running env. */
  const anyChange = useMemo(
    () => gate.requiredSettings.some((setting) => {
      const next = (values[setting.envVar] ?? '').trim();
      return next.length > 0 && next !== (currentValues[setting.envVar] ?? '').trim();
    }),
    [gate.requiredSettings, values, currentValues],
  );

  /**
   * Which of the two blockers is real (#3729).
   *
   * `envComplete` — every required setting already holds a value in the running
   * deployment, so the form below cannot be the fix. `probeBlocked` — a live
   * probe is the thing that failed. `probeInconclusive` — it did not even
   * finish, so nothing was established and the honest action is to re-check.
   */
  const envComplete = useMemo(
    () => gate.requiredSettings.length > 0
      && gate.requiredSettings.every((setting) => {
        if ((currentValues[setting.envVar] ?? '').trim().length > 0) return true;
        // An anyOf alias satisfies the requirement just as well.
        return (setting.aliasOf || []).some((a) => (currentValues[a] ?? '').trim().length > 0);
      }),
    [gate.requiredSettings, currentValues],
  );
  const probeInconclusive = !!probe && probe.status !== 'pass' && !!probe.inconclusive;
  const probeBlocked = !!probe && probe.status !== 'pass';
  // The env form is only the remediation when a value is genuinely missing.
  const envIsTheFix = !envComplete || !probeBlocked;

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            {probeInconclusive ? 'Re-check' : 'Fix it'} — {gate.title}
          </DialogTitle>
          <DialogContent>
            {/* Lead with the ACTUAL blocker. A gate whose env is complete and
                whose live probe is what failed must never open on a form asking
                for values the deployment already holds (#3729). */}
            {probeBlocked && envComplete ? (
              <MessageBar intent={probeInconclusive ? 'info' : 'warning'} layout="multiline">
                <MessageBarBody>
                  <MessageBarTitle>
                    {probeInconclusive
                      ? 'Not established — the live check did not complete'
                      : 'The configuration is complete; the live check is what failed'}
                  </MessageBarTitle>
                  {probeInconclusive
                    ? 'Nothing was observed either way. Re-check to run the probes again — the values below are already set and were not the problem.'
                    : 'Every value this gate needs is already set in the running deployment, so re-entering them changes nothing. The remediation is the live-check finding below.'}
                  <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXS }}>
                    <strong>{probe!.id}:</strong> {probe!.detail}
                  </Caption1>
                  {probe!.remediation && (
                    <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXS }}>
                      {probe!.remediation}
                    </Caption1>
                  )}
                </MessageBarBody>
                {onRecheck && (
                  <MessageBarActions>
                    <Button
                      appearance="primary"
                      size="small"
                      icon={<ArrowSync16Regular />}
                      onClick={() => { onRecheck(); onClose(); }}
                    >
                      Re-check now
                    </Button>
                  </MessageBarActions>
                )}
              </MessageBar>
            ) : (
              <Caption1 className={s.meta}>{gate.remediation}</Caption1>
            )}
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
            {currentError && (
              <MessageBar intent="warning" layout="multiline" style={{ marginTop: tokens.spacingVerticalS }}>
                <MessageBarBody>
                  <MessageBarTitle>Current values unavailable</MessageBarTitle>
                  {currentError} — the fields below could not be pre-filled from the running
                  deployment, so an empty field here does NOT mean the value is unset.
                </MessageBarBody>
              </MessageBar>
            )}
            {loadingOptions && (
              <div className={s.applying}><Spinner size="tiny" /><Caption1>Discovering live Azure resources…</Caption1></div>
            )}
            {!grantOnly && (
              <div className={s.fields}>
                {!envIsTheFix && (
                  <Caption1 className={s.meta}>
                    Already set in this deployment — change one only if it is wrong.
                  </Caption1>
                )}
                {gate.requiredSettings.map((setting: GateRequiredSetting) => {
                  const opts = options[setting.envVar] || [];
                  const secret = isSecretVar(setting.envVar);
                  const hint = setting.valueHint || setting.description;
                  const live = currentValues[setting.envVar];
                  const aliasLive = (setting.aliasOf || []).find((a) => (currentValues[a] ?? '').length > 0);
                  const baseHint = setting.aliasOf ? `Any ONE of ${setting.aliasOf.join(' / ')} satisfies this.` : hint;
                  // Say what is live NOW. A blank field used to be the only
                  // signal and it read as "unset" even when the value was set.
                  const fieldHint = live
                    ? `Currently set in this deployment. ${baseHint}`
                    : secret
                      ? `Secret — the current value is never shown. ${baseHint}`
                      : aliasLive
                        ? `Unset, but satisfied by ${aliasLive}. ${baseHint}`
                        : `Not set in this deployment. ${baseHint}`;
                  return (
                    <Field key={setting.envVar} label={setting.envVar} hint={fieldHint}>
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
            {onRecheck && probeBlocked && (
              <Button
                appearance={envIsTheFix ? 'secondary' : 'primary'}
                icon={<ArrowSync16Regular />}
                onClick={() => { onRecheck(); onClose(); }}
              >
                Re-check now
              </Button>
            )}
            {!grantOnly && (
              <Tooltip
                content={
                  anyChange
                    ? 'Write the changed value(s) through the audited env-config path'
                    : anyValue
                      ? 'Nothing to apply — every field still matches the running deployment'
                      : 'Enter a value to apply'
                }
                // `description`, never `label`: a Fluent tooltip with
                // relationship="label" REPLACES the button's accessible name
                // with the tooltip text, so the button stops being findable as
                // "Apply" by a screen reader (and by the tests).
                relationship="description"
              >
                <Button
                  appearance={envIsTheFix ? 'primary' : 'secondary'}
                  icon={applying ? <Spinner size="tiny" /> : <Wrench16Regular />}
                  // Pre-filling made "has a value" meaningless as an enablement
                  // test — every field has one on open. Enable only on a real
                  // DELTA, so Apply can never be a no-op revision roll.
                  disabled={!anyChange || applying}
                  onClick={apply}
                >
                  Apply
                </Button>
              </Tooltip>
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
  cloudUnavailable,
  fallbackNote,
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
  gate?: {
    id: string; title?: string; remediation?: string; fixItHref?: string; missing?: string[];
    /** X2 — 'cloud-unavailable' when the backing service does not exist in the active cloud. */
    state?: 'blocked' | 'cloud-unavailable';
    /** X2 — the Azure-native / OSS / Loom-native fallback for the active cloud. */
    fallbackNote?: string;
  };
  /** Human name of the calling surface (e.g. 'SQL Copilot'). */
  surface: string;
  /** The exact missing env var(s) the surface's API reported. */
  missing?: string[] | string;
  /** True renders the compact "live" confirmation chip instead of the bar. */
  configured?: boolean;
  /** Optional extra detail from the surface's gate response. */
  detail?: string;
  /** X2 — force the cloud-unavailable rendering (derived from the envelope's
   * `state` when omitted): honest bar naming the fallback, NO Fix-it. */
  cloudUnavailable?: boolean;
  /** X2 — the fallback note override (defaults to the envelope's, then the
   * registry availability declaration). */
  fallbackNote?: string;
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

  // X2 — cloud-unavailable: the backing service does not exist in this cloud.
  // Honest bar naming the Azure-native/OSS/Loom-native fallback, NO Fix-it (no
  // wizard can provision an impossible resource) — a "Use the Loom-native
  // equivalent" CTA instead (G2 stays satisfied: never a bare remediation bar).
  const isCloudUnavailable = cloudUnavailable ?? envelope?.state === 'cloud-unavailable';
  if (isCloudUnavailable) {
    const note = fallbackNote
      || envelope?.fallbackNote
      || gate.availability?.fallbackNote
      || gate.remediation;
    return (
      <MessageBar intent="warning" layout="multiline" className={s.bar} icon={<CloudDismiss20Regular />}>
        <MessageBarBody>
          <MessageBarTitle>{gate.title} is not available in this cloud</MessageBarTitle>
          {note}
        </MessageBarBody>
        <MessageBarActions>
          {onResolved ? (
            <Button size="small" appearance="primary" icon={<ArrowRight16Regular />} onClick={onResolved}>
              Use the Loom-native equivalent
            </Button>
          ) : (
            <Button as="a" size="small" appearance="primary" icon={<ArrowRight16Regular />} href="/admin/gates">
              Use the Loom-native equivalent
            </Button>
          )}
          <Button as="a" size="small" appearance="transparent" icon={<Open16Regular />} href="/admin/gates">
            Gate registry
          </Button>
        </MessageBarActions>
      </MessageBar>
    );
  }

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
