'use client';

/**
 * SensitivityLabelDialog — apply a Microsoft Information Protection (MIP)
 * sensitivity label to a Loom report (Report-Builder parity, WAVE 9).
 *
 * ── What it is (parity with Power BI "Sensitivity") ─────────────────────────
 * Power BI / Fabric reports carry a tenant MIP sensitivity label that drives
 * downstream protection (export gating, RMS encryption on the rendered file).
 * This dialog is the Loom one-for-one: it lists the TENANT's real sensitivity
 * labels (Microsoft Graph, via the BFF), lets the author pick one (or clear it),
 * and persists the choice on the report so the catalog shows it and the export
 * pipeline stamps/gates on it.
 *
 * ── Backend per control (no-vaporware.md) ───────────────────────────────────
 *   • On open  → GET  /api/items/report/[id]/sensitivity
 *        ok    → { labels: SensitivityLabel[], applied:{labelId,labelName}|null }
 *                labels come from the REAL Microsoft Graph
 *                listSensitivityLabels() call (beta informationProtection).
 *        gate  → { ok:false, code:'mip-gate', gate:<MipNotConfiguredHint>,
 *                  applied } — MIP not wired in this deployment; we still show
 *                the current applied label and an HONEST warning MessageBar.
 *   • Apply    → PUT  /api/items/report/[id]/sensitivity  { labelId }  ('' clears)
 *                persists state.sensitivityLabel (NAME — catalog reads this) +
 *                state.sensitivityLabelId (GUID) in Cosmos. The on-export MIP
 *                stamp/protection enforcement reads the SAME state.
 *
 * ── Rules ───────────────────────────────────────────────────────────────────
 *   no-fabric-dependency: labels come from Microsoft Graph (MIP), never a Fabric
 *     capacity / Power BI workspace. The label drives the Azure-native export
 *     stamp; no Fabric/Power BI surface here.
 *   no-vaporware: every control hits the real route; the gate is an honest
 *     Fluent MessageBar naming the EXACT env var / bicep module / grant script
 *     (verbatim from the route's MipNotConfiguredHint) — no dead controls.
 *   no-freeform-config: label selection is a Dropdown (+ "None"); no JSON, no
 *     free text.
 *   web3-ui: Fluent v9 + Loom design tokens only (no hard-coded px/hex), Shield
 *     iconography, protection badges, dark-legible foregrounds.
 *
 * Mounting: report-designer.tsx mounts this from the Home ribbon's Governance
 * group (`<SensitivityLabelDialog … />`). All logic lives here; the designer
 * edit is mount-only.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Badge, Caption1, Subtitle1, Text, Spinner, Divider,
  Dropdown, Option,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Shield20Regular, ShieldKeyhole20Regular, ShieldCheckmark20Regular,
  LockClosed16Filled, Dismiss24Regular, Warning20Regular, Info16Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
// Type-only imports — fully erased at compile, so this server-side MIP module's
// runtime (Graph credential) is NOT pulled into the client bundle.
import type { SensitivityLabel, MipNotConfiguredHint } from '@/lib/azure/mip-graph-client';

// ── Wire shapes (LOCAL string-validated mirror of the route's JSON contract) ──
interface AppliedLabel { labelId: string; labelName: string }

interface SensitivityGetOk {
  ok: true;
  labels?: SensitivityLabel[];
  applied?: AppliedLabel | null;
}
interface SensitivityGetGate {
  ok: false;
  code?: 'mip-gate';
  gate?: MipNotConfiguredHint;
  applied?: AppliedLabel | null;
  error?: string;
}
type SensitivityGet = SensitivityGetOk | SensitivityGetGate;

interface SensitivityPutResp {
  ok?: boolean;
  applied?: AppliedLabel | null;
  error?: string;
}

/** value used by the "None" / clear option (empty string clears on the route). */
const NONE = '';

const useStyles = makeStyles({
  surface: { maxWidth: '640px', width: '92vw' },
  titleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
  fieldLabel: { color: tokens.colorNeutralForeground2 },

  appliedCard: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground2,
    padding: tokens.spacingVerticalM,
    boxShadow: tokens.shadow4,
    minWidth: 0,
  },
  appliedText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  swatch: {
    width: '14px', height: '14px', borderRadius: tokens.borderRadiusCircular, flexShrink: 0,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1}`,
  },

  dropdown: { width: '100%' },
  optRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0, width: '100%' },
  optName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 },
  optMeta: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexShrink: 0 },

  gateBody: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
  gateList: {
    margin: 0,
    paddingInlineStart: tokens.spacingHorizontalL,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
  },
  code: {
    fontFamily: tokens.fontFamilyMonospace,
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusSmall,
    paddingInline: tokens.spacingHorizontalXS,
  },
  loadPad: { padding: tokens.spacingVerticalL, display: 'flex', justifyContent: 'center' },
  muted: { color: tokens.colorNeutralForeground3 },
});

export interface SensitivityLabelDialogProps {
  open: boolean;
  onClose: () => void;
  reportId: string;
  /** Display NAME of the label currently applied (seeded by the host). */
  appliedName?: string;
  /** Called with the new label NAME on apply ('' when cleared). */
  onApplied: (name: string) => void;
}

export function SensitivityLabelDialog({
  open, onClose, reportId, appliedName, onApplied,
}: SensitivityLabelDialogProps): ReactElement {
  const s = useStyles();

  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [labels, setLabels] = useState<SensitivityLabel[]>([]);
  const [gate, setGate] = useState<MipNotConfiguredHint | null>(null);
  // Currently-persisted applied label (from GET; seeded by the appliedName prop).
  const [appliedId, setAppliedId] = useState<string>('');
  const [appliedLabelName, setAppliedLabelName] = useState<string>(appliedName || '');
  // Pending selection in the Dropdown.
  const [selectedId, setSelectedId] = useState<string>('');

  const base = useMemo(
    () => `/api/items/report/${encodeURIComponent(reportId)}/sensitivity`,
    [reportId],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    setGate(null);
    try {
      const r = await clientFetch(base, { cache: 'no-store' });
      const j = (await r.json()) as SensitivityGet;
      if (j && j.ok) {
        setLabels(Array.isArray(j.labels) ? j.labels : []);
        const id = j.applied?.labelId || '';
        setAppliedId(id);
        setAppliedLabelName(j.applied?.labelName || '');
        setSelectedId(id);
      } else if (j && (j as SensitivityGetGate).code === 'mip-gate') {
        const g = j as SensitivityGetGate;
        setGate(g.gate || null);
        setLabels([]);
        const id = g.applied?.labelId || '';
        setAppliedId(id);
        setAppliedLabelName(g.applied?.labelName || appliedName || '');
        setSelectedId(id);
      } else {
        setErr((j as SensitivityGetGate)?.error || 'Failed to load sensitivity labels.');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [base, appliedName]);

  // (Re)load every time the dialog opens; reset transient state on close.
  useEffect(() => {
    if (open) {
      void load();
    } else {
      setErr(null);
      setApplying(false);
    }
  }, [open, load]);

  const dirty = selectedId !== appliedId;

  const selectedLabel = useMemo(
    () => labels.find((l) => l.id === selectedId) || null,
    [labels, selectedId],
  );

  const selectedDisplay = selectedId === NONE
    ? 'None (no label)'
    : (selectedLabel?.displayName || selectedLabel?.name || selectedId);

  const apply = useCallback(async () => {
    setApplying(true);
    setErr(null);
    try {
      const r = await clientFetch(base, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ labelId: selectedId }),
      });
      const j = (await r.json()) as SensitivityPutResp;
      if (r.ok && j && j.ok) {
        const name = j.applied?.labelName || '';
        setAppliedId(j.applied?.labelId || '');
        setAppliedLabelName(name);
        onApplied(name);
        onClose();
      } else {
        setErr(j?.error || `Failed to apply label (HTTP ${r.status}).`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }, [base, selectedId, onApplied, onClose]);

  return (
    <Dialog open={open} onOpenChange={(_e, d) => { if (!d.open) onClose(); }}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle
            action={(
              <Button
                appearance="subtle" icon={<Dismiss24Regular />}
                aria-label="Close sensitivity label" onClick={onClose}
              />
            )}
          >
            <span className={s.titleRow}>
              <Shield20Regular />
              <Subtitle1>Sensitivity label</Subtitle1>
              <Badge appearance="outline" color="subtle" size="small">
                Microsoft Information Protection
              </Badge>
            </span>
          </DialogTitle>

          <DialogContent>
            <div className={s.body}>
              {err && (
                <MessageBar intent="error">
                  <MessageBarBody>{err}</MessageBarBody>
                </MessageBar>
              )}

              {/* Currently-applied summary (always shown — even behind the gate) */}
              <div className={s.appliedCard}>
                {appliedId
                  ? <ShieldCheckmark20Regular />
                  : <Shield20Regular className={s.muted} />}
                <div className={s.appliedText}>
                  <Caption1 className={s.fieldLabel}>Currently applied</Caption1>
                  <Text weight="semibold">
                    {appliedId ? (appliedLabelName || 'Labeled') : 'None (no label)'}
                  </Text>
                </div>
              </div>

              {loading && (
                <div className={s.loadPad}>
                  <Spinner size="tiny" label="Loading tenant sensitivity labels…" />
                </div>
              )}

              {/* HONEST GATE — MIP not wired in this deployment */}
              {!loading && gate && (
                <MessageBar intent="warning" icon={<Warning20Regular />}>
                  <MessageBarBody>
                    <MessageBarTitle>Sensitivity labels are not enabled in this deployment</MessageBarTitle>
                    <div className={s.gateBody}>
                      <Text>
                        Microsoft Information Protection is not wired here, so the
                        tenant label list cannot be read. The currently-applied
                        label above is preserved. To enable labels:
                      </Text>
                      <ol className={s.gateList}>
                        <li>
                          <Text>
                            Set <span className={s.code}>{gate.missingEnvVar || 'LOOM_MIP_ENABLED'}=true</span>{' '}
                            on the loom-console Container App (
                            <span className={s.code}>{gate.bicepModule || 'platform/fiab/bicep/modules/admin-plane/main.bicep'}</span>).
                          </Text>
                        </li>
                        <li>
                          <Text>
                            Grant the Console UAMI the Microsoft Graph app-roles via{' '}
                            <span className={s.code}>scripts/csa-loom/grant-graph-approles.sh</span>{' '}
                            (or the post-deploy-bootstrap "Grant MIP+DLP Graph AppRoles" job), then admin-consent.
                          </Text>
                        </li>
                      </ol>
                      {Array.isArray(gate.rolesRequired) && gate.rolesRequired.length > 0 && (
                        <Caption1 className={s.muted}>
                          App-roles required: {gate.rolesRequired.map((x) => x.name).join(', ')}
                        </Caption1>
                      )}
                      {gate.followUp && (
                        <Caption1 className={s.muted}>{gate.followUp}</Caption1>
                      )}
                    </div>
                  </MessageBarBody>
                </MessageBar>
              )}

              {/* LABEL PICKER — real tenant labels */}
              {!loading && !gate && (
                <div className={s.section}>
                  <Caption1 className={s.fieldLabel}>Choose a label</Caption1>
                  <Dropdown
                    className={s.dropdown}
                    aria-label="Sensitivity label"
                    value={selectedDisplay}
                    selectedOptions={[selectedId]}
                    disabled={applying}
                    onOptionSelect={(_e, d) => setSelectedId(d.optionValue ?? NONE)}
                  >
                    <Option value={NONE} text="None (no label)">
                      <span className={s.optRow}>
                        <span className={s.optName}>None (no label)</span>
                      </span>
                    </Option>
                    {labels.map((l) => {
                      const name = l.displayName || l.name || l.id;
                      return (
                        <Option key={l.id} value={l.id} text={name}>
                          <span className={s.optRow}>
                            {l.color
                              ? <span className={s.swatch} style={{ backgroundColor: l.color }} />
                              : <Shield20Regular />}
                            <span className={s.optName}>{name}</span>
                            <span className={s.optMeta}>
                              {typeof l.sensitivity === 'number' && (
                                <Badge appearance="tint" color="informative" size="small">
                                  Level {l.sensitivity}
                                </Badge>
                              )}
                              {l.hasProtection && (
                                <Badge appearance="tint" color="danger" size="small" icon={<LockClosed16Filled />}>
                                  Protected
                                </Badge>
                              )}
                            </span>
                          </span>
                        </Option>
                      );
                    })}
                  </Dropdown>

                  {/* Selected-label detail / protection hint */}
                  {selectedLabel && (
                    <div className={s.section}>
                      {selectedLabel.tooltip && (
                        <Caption1 className={s.muted}>{selectedLabel.tooltip}</Caption1>
                      )}
                      {selectedLabel.hasProtection && (
                        <span className={s.titleRow}>
                          <ShieldKeyhole20Regular />
                          <Caption1>
                            This label applies RMS protection — protected exports
                            (CSV/text) are blocked and Office/PDF files are encrypted on export.
                          </Caption1>
                        </span>
                      )}
                    </div>
                  )}

                  {labels.length === 0 && (
                    <span className={s.titleRow}>
                      <Info16Regular className={s.muted} />
                      <Caption1 className={s.muted}>
                        No sensitivity labels are published to this tenant.
                      </Caption1>
                    </span>
                  )}

                  <Divider />
                  <Caption1 className={s.muted}>
                    The label is stored on the report and shown in the governance
                    catalog. It drives MIP enforcement when this report is exported.
                  </Caption1>
                </div>
              )}
            </div>
          </DialogContent>

          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={applying}>
              {gate ? 'Close' : 'Cancel'}
            </Button>
            {!gate && (
              <Button
                appearance="primary"
                onClick={() => void apply()}
                disabled={loading || applying || !dirty}
                icon={applying ? <Spinner size="tiny" /> : undefined}
              >
                {selectedId === NONE && appliedId ? 'Remove label' : 'Apply'}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default SensitivityLabelDialog;
