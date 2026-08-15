'use client';

/**
 * DP-5 — Certification panel for the data-product editor.
 *
 * Renders the LIVE certification checklist (red/green rows with "what's
 * missing"), the automated score, the certification-state badge, and the
 * Certify / Revoke / Promote actions. The Certify button is VISIBLY GATED — it
 * is disabled with a reason until every automated row is green AND the signer is
 * a reviewer distinct from the creator (no silent allow, no human override of a
 * failing score) per no-vaporware.md. Backed by the real
 * GET /certification + POST /certify routes (Cosmos + tenant DQ rules).
 *
 * The `dq` row renders the MEASURED reason the route computed, not the generic
 * one baked into the pure engine. `certification.ts` can only say "No DQ score
 * yet — configure DQ rules…", which in an ADX-skipped estate with twenty rules
 * defined is FALSE; the route knows whether the truth is "ADX unprovisioned",
 * "no applicable rules", "the rules could not run" or "never measured", and this
 * panel shows that — with an inline Fix-it (`HonestGate`, gate registry) when
 * the reason is infrastructure, and an inline "Measure data quality" action when
 * the reason is that nothing has been measured yet (ux-baseline.md G2).
 */

import { useCallback, useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  Badge, Body1Strong, Button, Caption1, Spinner, Text,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  CheckmarkCircle20Filled, DismissCircle20Filled, ShieldCheckmark20Regular,
  Star20Regular, StarOff20Regular, BeakerEdit20Regular,
} from '@fluentui/react-icons';
import { HonestGate } from '@/lib/components/shared/honest-gate';

interface CertCheck { id: string; label: string; pass: boolean; forValidated: boolean; detail: string }
/** The measured DQ input behind the `dq` check (GET /certification `dq` block). */
interface CertDq {
  /** Passing-rule ratio 0–100, or null when nothing was measured. */
  score: number | null;
  /** Exact reason + remediation when `score` is null. */
  gate: string | null;
  /** Gate-registry id when the reason is infrastructure a Fix-it can resolve. */
  gateId: string | null;
  /** The env var(s) that gate needs. */
  missing?: string[];
  ruleCount: number;
  passingRules: number;
  /** ISO-8601 of the measurement, or null when never measured. */
  measuredAt: string | null;
  /** True when the measurement is older than the freshness window. */
  stale?: boolean;
}
interface CertResponse {
  ok: boolean;
  certification: { state: 'draft' | 'validated' | 'certified'; score: number; certifiedBy?: { oid: string; name?: string }; certifiedAt?: string };
  endorsement: 'none' | 'promoted' | 'certified';
  checks: CertCheck[];
  validated: boolean;
  certifiable: boolean;
  isCreator: boolean;
  /** Present on every response from the certification route; older builds omit it. */
  dq?: CertDq;
  error?: string;
}

type CertAction = 'certify' | 'revoke' | 'promote' | 'unpromote' | 'measure-dq';

/**
 * The DERIVED certification state for a header badge, from the same route the
 * Certification tab renders.
 *
 * The editor header read `state.certificationState` straight off the item — a
 * field written ONLY by certify/revoke. So a product certified before its DQ
 * score was ever really measured showed a green **Certified** badge in its own
 * header while the tab two clicks away said **Validated / never measured**: one
 * screen contradicting itself. Deriving both from one server evaluation is the
 * fix; the route is a Cosmos point-read now (it executes no rules), so this is
 * cheap enough to run on mount.
 *
 * Fails CLOSED: an unreachable or failed evaluation yields `null` and the caller
 * shows NO certification badge, never a stale green one.
 */
export function useDerivedCertificationState(id: string, isNew?: boolean) {
  const [state, setState] = useState<'draft' | 'validated' | 'certified' | null>(null);

  useEffect(() => {
    if (isNew || !id || id === 'new') { setState(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await clientFetch(`/api/data-products/${encodeURIComponent(id)}/certification`);
        const j = await r.json();
        if (!cancelled) setState(j?.ok ? (j.certification?.state ?? null) : null);
      } catch {
        if (!cancelled) setState(null);
      }
    })();
    return () => { cancelled = true; };
  }, [id, isNew]);

  return state;
}

const useStyles = makeStyles({
  wrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, padding: tokens.spacingHorizontalL, maxWidth: '760px' },
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  scoreRing: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '56px', height: '56px', borderRadius: tokens.borderRadiusCircular,
    border: `3px solid ${tokens.colorBrandStroke1}`, fontWeight: tokens.fontWeightBold,
    color: tokens.colorBrandForeground1, flexShrink: 0,
  },
  checks: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  row: {
    display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingHorizontalS, borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`, minWidth: 0,
  },
  rowText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  detail: { color: tokens.colorNeutralForeground3, overflowWrap: 'anywhere' },
  pass: { color: tokens.colorPaletteGreenForeground1, flexShrink: 0 },
  fail: { color: tokens.colorPaletteRedForeground1, flexShrink: 0 },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
});

const STATE_BADGE: Record<string, { label: string; color: 'informative' | 'brand' | 'success' }> = {
  draft: { label: 'Draft', color: 'informative' },
  validated: { label: 'Validated', color: 'brand' },
  certified: { label: 'Certified', color: 'success' },
};

export function CertificationPanel({ id, isNew }: { id: string; isNew?: boolean }) {
  const s = useStyles();
  const [data, setData] = useState<CertResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await clientFetch(`/api/data-products/${encodeURIComponent(id)}/certification`);
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      setData(j);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [id]);

  useEffect(() => { if (!isNew) load(); else setLoading(false); }, [isNew, load]);

  const act = useCallback(async (action: CertAction) => {
    setBusy(action); setNote(null);
    try {
      const r = await clientFetch(`/api/data-products/${encodeURIComponent(id)}/certify`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const j = await r.json();
      if (!j.ok) {
        // The 422 carries WHY data quality blocked it. Dropping `dqGate` here is
        // how the false "No DQ score yet — configure DQ rules" reached users on
        // estates that had twenty rules and no ADX.
        const blocked = j.code === 'checks_failed'
          ? `Certification blocked — ${(j.blockers || []).map((b: any) => b.label).join(', ')} still failing.${j.dqGate ? ` ${j.dqGate}` : ''}`
          : (j.error || `HTTP ${r.status}`);
        setNote({ kind: 'err', msg: blocked });
      } else {
        setNote({ kind: 'ok', msg:
          action === 'certify' ? 'Certified.'
          : action === 'revoke' ? 'Certification revoked.'
          : action === 'promote' ? 'Promoted.'
          : action === 'unpromote' ? 'Promotion removed.'
          : j.dq?.gate
            ? `Data quality measured — ${j.dq.gate}`
            : `Data quality measured: ${j.dq?.passingRules ?? 0} of ${j.dq?.ruleCount ?? 0} rules passing (score ${j.dq?.score ?? '—'}).` });
      }
      await load();
    } catch (e: any) { setNote({ kind: 'err', msg: e?.message || String(e) }); }
    finally { setBusy(null); }
  }, [id, load]);

  if (isNew) {
    return (
      <div className={s.wrap}>
        <MessageBar intent="info">
          <MessageBarBody><MessageBarTitle>Save first</MessageBarTitle>
            Save the data product before running the certification pipeline.</MessageBarBody>
        </MessageBar>
      </div>
    );
  }
  if (loading) return <div className={s.wrap}><Spinner size="tiny" label="Evaluating certification…" /></div>;
  if (err) return <div className={s.wrap}><MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar></div>;
  if (!data) return null;

  const cert = data.certification;
  const badge = STATE_BADGE[cert.state];
  const certified = cert.state === 'certified';
  const dq = data.dq;
  // The route's measured reason beats the pure engine's generic string, which
  // can only ever say "configure DQ rules" — false whenever the real reason is
  // an unprovisioned ADX, a rule set that could not run, or a product that has
  // simply never been measured.
  const checkDetail = (c: CertCheck) => (c.id === 'dq' && dq?.gate ? dq.gate : c.detail);
  const measuring = busy === 'measure-dq';
  // The "Measure data quality" action IS the fix for a never-measured product —
  // one click, no wizard, no other page (ux-baseline.md G2).
  const showMeasure = !!dq && (dq.score === null || dq.stale === true);
  // The Certify action is gated: all checks green AND signer ≠ creator.
  const certifyDisabledReason = !data.certifiable
    ? 'Blocked — all automated checks must pass first (see the red rows below).'
    : data.isCreator
      ? 'Blocked — a reviewer other than the creator must certify.'
      : null;

  return (
    <div className={s.wrap}>
      <div className={s.header}>
        <div className={s.scoreRing}>{cert.score}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
            <Body1Strong>Certification</Body1Strong>
            <Badge appearance="filled" color={badge.color} icon={certified ? <ShieldCheckmark20Regular /> : undefined}>
              {badge.label}
            </Badge>
            {data.endorsement === 'promoted' && <Badge appearance="tint" color="brand">Promoted</Badge>}
          </div>
          {certified && cert.certifiedBy && (
            <Caption1>Certified by {cert.certifiedBy.name || cert.certifiedBy.oid}{cert.certifiedAt ? ` on ${new Date(cert.certifiedAt).toLocaleDateString()}` : ''}</Caption1>
          )}
          {!certified && (
            <Caption1>{data.validated ? 'Meets the validated bar — awaiting reviewer sign-off.' : 'Not yet validated — complete the checks below.'}</Caption1>
          )}
        </div>
      </div>

      {/* The DQ input, stated: when it could not be measured the reason is the
          route's, and an INFRA reason renders the shared registry gate with its
          Fix-it wizard instead of a dead-end sentence. */}
      {dq?.gate && dq.gateId && (
        <HonestGate
          gateId={dq.gateId}
          surface="Certification data quality"
          missing={dq.missing}
          detail={dq.gate}
          onResolved={load}
        />
      )}

      <div className={s.checks}>
        {data.checks.map((c) => (
          <div key={c.id} className={s.row}>
            {c.pass
              ? <CheckmarkCircle20Filled className={s.pass} />
              : <DismissCircle20Filled className={s.fail} />}
            <div className={s.rowText}>
              <Text weight="semibold">
                {c.label}{c.forValidated && <Caption1 style={{ marginLeft: tokens.spacingHorizontalXS }}>· required to validate</Caption1>}
              </Text>
              <Caption1 className={s.detail}>{checkDetail(c)}</Caption1>
              {c.id === 'dq' && dq && (
                <Caption1 className={s.detail}>
                  {dq.measuredAt
                    ? `${dq.passingRules}/${dq.ruleCount} rules passing · measured ${new Date(dq.measuredAt).toLocaleString()}${dq.stale ? ' (stale — re-measure for a current reading)' : ''}`
                    : 'Never measured — the rules have not been executed against this product.'}
                </Caption1>
              )}
            </div>
          </div>
        ))}
      </div>

      {certifyDisabledReason && (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>{certifyDisabledReason}</MessageBarBody>
        </MessageBar>
      )}
      {note && (
        <MessageBar intent={note.kind === 'ok' ? 'success' : 'error'}>
          <MessageBarBody>{note.msg}</MessageBarBody>
        </MessageBar>
      )}

      <div className={s.actions}>
        {showMeasure && (
          <Button
            icon={<BeakerEdit20Regular />}
            disabled={busy !== null}
            onClick={() => act('measure-dq')}
          >
            {measuring ? 'Measuring…' : dq?.measuredAt ? 'Re-measure data quality' : 'Measure data quality'}
          </Button>
        )}
        {!certified ? (
          <Button
            appearance="primary"
            icon={<ShieldCheckmark20Regular />}
            disabled={!!certifyDisabledReason || busy !== null}
            onClick={() => act('certify')}
          >
            {busy === 'certify' ? 'Certifying…' : 'Certify'}
          </Button>
        ) : (
          <Button icon={<DismissCircle20Filled />} disabled={busy !== null} onClick={() => act('revoke')}>
            {busy === 'revoke' ? 'Revoking…' : 'Revoke certification'}
          </Button>
        )}
        {data.endorsement !== 'certified' && (
          data.endorsement === 'promoted' ? (
            <Button icon={<StarOff20Regular />} disabled={busy !== null} onClick={() => act('unpromote')}>
              {busy === 'unpromote' ? 'Removing…' : 'Remove Promoted'}
            </Button>
          ) : (
            <Button icon={<Star20Regular />} disabled={busy !== null} onClick={() => act('promote')}>
              {busy === 'promote' ? 'Promoting…' : 'Promote'}
            </Button>
          )
        )}
      </div>
    </div>
  );
}

export default CertificationPanel;
