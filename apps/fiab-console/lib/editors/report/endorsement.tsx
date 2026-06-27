'use client';

/**
 * EndorsementDialog — endorse a Loom report (Promote / Certify), Report-Builder
 * parity · WAVE 9. Azure-native, no Fabric / Power BI dependency.
 *
 * ── What it is (parity with Power BI "Endorsement") ─────────────────────────
 * Power BI/Fabric content carries an endorsement signal that the catalog and
 * pickers surface so consumers know what to trust:
 *   • Promoted  — a soft, self-service "this is good to use" signal any report
 *                 owner/contributor can set.
 *   • Certified — an authoritative org seal of approval, restricted to workspace
 *                 reviewers / admins.
 * This dialog is the Loom one-for-one. It reads + writes a single persisted
 * endorsement on the report item's Cosmos `state.endorsement`
 * ('Promoted' | 'Certified' | absent) — exactly the key the governance catalog
 * (`governance-catalog-shapes.docForGovernanceItem`) renders as the endorsement
 * badge. There is NO Power BI / Fabric endorsement API on this path
 * (no-fabric-dependency.md): the signal lives entirely in the Azure-native
 * Cosmos item and the catalog renders it.
 *
 * ── Backend per control (no-vaporware.md — every control hits a real route) ──
 *   • On open → GET /api/items/report/[id]/endorsement
 *        → { ok:true, endorsement:'Promoted'|'Certified'|null, canCertify:boolean }
 *        `canCertify` is the REAL authorization probe (workspace effective role
 *        Admin/Member via resolveEffectiveRole, the LOOM_REPORT_CERTIFIERS
 *        allow-list, or the RBAC-admin operator) — so the Certify control is
 *        never a dead button.
 *   • Promote / Certify / clear → PUT { endorsement } persists state.endorsement
 *        in Cosmos. A PUT to 'Certified' without `canCertify` returns a real 403
 *        which is surfaced verbatim; the UI also disables the control up front.
 *
 * ── Rules ───────────────────────────────────────────────────────────────────
 *   no-fabric-dependency: stored + read in the Azure-native Cosmos item; never a
 *     Fabric capacity / Power BI workspace.
 *   no-vaporware: the Promote Switch and the Certify Button each issue a real PUT
 *     that persists; the restricted state is an HONEST gate (disabled + tooltip +
 *     MessageBar naming the LOOM_REPORT_CERTIFIERS allow-list and the
 *     workspace-reviewer path) — no dead controls.
 *   no-freeform-config: endorsement is a Switch + a Button (a fixed 3-state
 *     machine None / Promoted / Certified) — no JSON, no free text.
 *   web3-ui: Fluent v9 + Loom design tokens only (no hard-coded px/hex), ribbon /
 *     certification iconography, dark-legible foregrounds; matches the sibling
 *     Sensitivity-label / Visual-export dialogs.
 *
 * Mounting: report-designer.tsx mounts this from the Home ribbon's Governance
 * group (`<EndorsementDialog … />`). All logic lives here; the designer edit is
 * mount-only.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Badge, Caption1, Subtitle1, Text, Spinner, Divider, Switch, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Ribbon20Regular, RibbonStar20Regular, ShieldCheckmark20Regular,
  CheckmarkCircle20Filled, Premium20Regular, Dismiss24Regular, Info16Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';

// ── model ───────────────────────────────────────────────────────────────────

/** The two endorsement levels (absence of both is the implicit "None"). */
export type Endorsement = 'Promoted' | 'Certified';

// ── wire shapes (LOCAL mirror of the route's JSON contract) ─────────────────

interface EndorsementGetResp {
  ok?: boolean;
  endorsement?: Endorsement | null;
  canCertify?: boolean;
  error?: string;
}
interface EndorsementPutResp {
  ok?: boolean;
  endorsement?: Endorsement | null;
  error?: string;
}

const useStyles = makeStyles({
  surface: { maxWidth: '600px', width: '92vw' },
  titleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
  fieldLabel: { color: tokens.colorNeutralForeground2 },
  muted: { color: tokens.colorNeutralForeground3 },

  statusCard: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground2,
    padding: tokens.spacingVerticalM,
    boxShadow: tokens.shadow4,
    minWidth: 0,
  },
  statusText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },

  controlCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    padding: tokens.spacingVerticalM,
    minWidth: 0,
  },
  controlHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  controlGrow: { flex: 1, minWidth: 0 },

  loadPad: { padding: tokens.spacingVerticalL, display: 'flex', justifyContent: 'center' },
  gateBody: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
  code: {
    fontFamily: tokens.fontFamilyMonospace,
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusSmall,
    paddingInline: tokens.spacingHorizontalXS,
  },
});

export interface EndorsementDialogProps {
  open: boolean;
  onClose: () => void;
  reportId: string;
  /** Current endorsement (seeded by the host's display state). */
  value: Endorsement | null;
  /** Called with the new endorsement after a successful persist ('null' clears). */
  onChange: (value: Endorsement | null) => void;
}

export function EndorsementDialog({
  open, onClose, reportId, value, onChange,
}: EndorsementDialogProps): ReactElement {
  const s = useStyles();

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Authoritative current level (seeded from `value`, refreshed by GET).
  const [current, setCurrent] = useState<Endorsement | null>(value);
  const [canCertify, setCanCertify] = useState(false);

  const base = useMemo(
    () => `/api/items/report/${encodeURIComponent(reportId)}/endorsement`,
    [reportId],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await clientFetch(base, { cache: 'no-store' });
      const j = (await r.json()) as EndorsementGetResp;
      if (r.ok && j && j.ok) {
        setCurrent(j.endorsement ?? null);
        setCanCertify(Boolean(j.canCertify));
      } else {
        // Keep the host-seeded value visible; surface the reason honestly.
        setErr(j?.error || `Failed to load endorsement (HTTP ${r.status}).`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [base]);

  // (Re)load every open; reset transient state on close. Re-seed from `value`.
  useEffect(() => {
    if (open) {
      setCurrent(value);
      void load();
    } else {
      setErr(null);
      setBusy(false);
    }
    // `value` is the host's seed at open-time only — load() is the source of truth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, load]);

  /** Persist an endorsement transition (PUT), then reflect + bubble it up. */
  const apply = useCallback(async (next: Endorsement | null) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await clientFetch(base, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endorsement: next }),
      });
      const j = (await r.json()) as EndorsementPutResp;
      if (r.ok && j && j.ok) {
        const applied = (j.endorsement ?? next) ?? null;
        setCurrent(applied);
        onChange(applied);
      } else {
        // Restricted-certify 403 (and any other failure) surfaced verbatim.
        setErr(j?.error || `Failed to update endorsement (HTTP ${r.status}).`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [base, onChange]);

  const isPromoted = current === 'Promoted';
  const isCertified = current === 'Certified';

  // Promote Switch: None ↔ Promoted. Certification supersedes Promoted, so while
  // Certified the Switch is locked (remove certification first to demote).
  const onPromoteToggle = useCallback((checked: boolean) => {
    void apply(checked ? 'Promoted' : null);
  }, [apply]);

  const certifyDisabled = busy || loading || !canCertify;

  const certifyButton = (
    <Button
      appearance="primary"
      icon={<ShieldCheckmark20Regular />}
      // disabledFocusable keeps the Tooltip reason reachable when gated.
      disabledFocusable={certifyDisabled}
      onClick={() => { if (!certifyDisabled) void apply('Certified'); }}
    >
      Certify
    </Button>
  );

  return (
    <Dialog open={open} onOpenChange={(_e, d) => { if (!d.open && !busy) onClose(); }}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle
            action={(
              <Button
                appearance="subtle" icon={<Dismiss24Regular />}
                aria-label="Close endorsement" disabled={busy} onClick={onClose}
              />
            )}
          >
            <span className={s.titleRow}>
              <RibbonStar20Regular />
              <Subtitle1>Endorsement</Subtitle1>
              <Badge appearance="tint" color="brand" size="small">Azure-native · no Fabric required</Badge>
            </span>
          </DialogTitle>

          <DialogContent>
            <div className={s.body}>
              {err && (
                <MessageBar intent="error">
                  <MessageBarBody>{err}</MessageBarBody>
                </MessageBar>
              )}

              {/* CURRENT LEVEL — always shown */}
              <div className={s.statusCard}>
                {isCertified
                  ? <Premium20Regular />
                  : isPromoted
                    ? <CheckmarkCircle20Filled />
                    : <Ribbon20Regular className={s.muted} />}
                <div className={s.statusText}>
                  <Caption1 className={s.fieldLabel}>Current endorsement</Caption1>
                  <span className={s.titleRow}>
                    <Text weight="semibold">
                      {isCertified ? 'Certified' : isPromoted ? 'Promoted' : 'None'}
                    </Text>
                    {isCertified && (
                      <Badge appearance="filled" color="success" size="small" icon={<ShieldCheckmark20Regular />}>
                        Certified
                      </Badge>
                    )}
                    {isPromoted && (
                      <Badge appearance="tint" color="brand" size="small">Promoted</Badge>
                    )}
                  </span>
                </div>
              </div>

              {loading && (
                <div className={s.loadPad}>
                  <Spinner size="tiny" label="Checking endorsement and your permissions…" />
                </div>
              )}

              {/* PROMOTE — self-service None ↔ Promoted */}
              <div className={s.controlCard}>
                <div className={s.controlHead}>
                  <CheckmarkCircle20Filled />
                  <Text weight="semibold" className={s.controlGrow}>Promote this report</Text>
                  <Switch
                    checked={isPromoted}
                    disabled={busy || loading || isCertified}
                    aria-label="Promote this report"
                    onChange={(_e, d) => onPromoteToggle(d.checked)}
                  />
                </div>
                <Caption1 className={s.muted}>
                  A self-service signal that this report is good to use. Any owner
                  or contributor can promote it.
                </Caption1>
                {isCertified && (
                  <span className={s.titleRow}>
                    <Info16Regular className={s.muted} />
                    <Caption1 className={s.muted}>
                      This report is Certified, which supersedes Promoted. Remove
                      the certification first to change it.
                    </Caption1>
                  </span>
                )}
              </div>

              {/* CERTIFY — restricted to workspace reviewers / admins */}
              <div className={s.controlCard}>
                <div className={s.controlHead}>
                  <ShieldCheckmark20Regular />
                  <Text weight="semibold" className={s.controlGrow}>Certify this report</Text>
                  {isCertified ? (
                    <Button
                      appearance="secondary"
                      disabled={busy || loading}
                      onClick={() => void apply(null)}
                    >
                      Remove certification
                    </Button>
                  ) : canCertify ? certifyButton : (
                    <Tooltip
                      relationship="label"
                      content="Certifying a report is restricted to workspace reviewers / admins."
                    >
                      {certifyButton}
                    </Tooltip>
                  )}
                </div>
                <Caption1 className={s.muted}>
                  An authoritative org seal of approval. Certified reports rank
                  above promoted ones in the catalog and pickers.
                </Caption1>

                {/* HONEST GATE — caller can't certify */}
                {!loading && !canCertify && !isCertified && (
                  <MessageBar intent="info" icon={<Info16Regular />}>
                    <MessageBarBody>
                      <MessageBarTitle>You don’t have permission to certify</MessageBarTitle>
                      <div className={s.gateBody}>
                        <Text>
                          Certification is restricted to a workspace reviewer
                          (effective role Admin or Member) or an identity in the{' '}
                          <span className={s.code}>LOOM_REPORT_CERTIFIERS</span>{' '}
                          allow-list. Ask a reviewer to certify, or have an admin
                          add your account to that env allow-list on the
                          loom-console Container App.
                        </Text>
                      </div>
                    </MessageBarBody>
                  </MessageBar>
                )}
              </div>

              <Divider />
              <Caption1 className={s.muted}>
                The endorsement is stored on the report and shown in the governance
                catalog and item pickers. Promoted and Certified are mutually
                exclusive levels.
              </Caption1>
            </div>
          </DialogContent>

          <DialogActions>
            {busy && <Spinner size="tiny" label="Saving…" />}
            <Button appearance="secondary" onClick={onClose} disabled={busy}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default EndorsementDialog;
