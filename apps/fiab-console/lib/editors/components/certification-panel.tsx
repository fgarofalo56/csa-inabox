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
  Star20Regular, StarOff20Regular,
} from '@fluentui/react-icons';

interface CertCheck { id: string; label: string; pass: boolean; forValidated: boolean; detail: string }
interface CertResponse {
  ok: boolean;
  certification: { state: 'draft' | 'validated' | 'certified'; score: number; certifiedBy?: { oid: string; name?: string }; certifiedAt?: string };
  endorsement: 'none' | 'promoted' | 'certified';
  checks: CertCheck[];
  validated: boolean;
  certifiable: boolean;
  isCreator: boolean;
  error?: string;
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

  const act = useCallback(async (action: 'certify' | 'revoke' | 'promote' | 'unpromote') => {
    setBusy(action); setNote(null);
    try {
      const r = await clientFetch(`/api/data-products/${encodeURIComponent(id)}/certify`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const j = await r.json();
      if (!j.ok) {
        setNote({ kind: 'err', msg: j.code === 'checks_failed'
          ? `Certification blocked — ${(j.blockers || []).map((b: any) => b.label).join(', ')} still failing.`
          : (j.error || `HTTP ${r.status}`) });
      } else {
        setNote({ kind: 'ok', msg: action === 'certify' ? 'Certified.' : action === 'revoke' ? 'Certification revoked.' : action === 'promote' ? 'Promoted.' : 'Promotion removed.' });
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
              <Caption1 className={s.detail}>{c.detail}</Caption1>
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
