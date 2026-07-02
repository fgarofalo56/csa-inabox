'use client';

/**
 * Report settings — REPORT-BUILDER PARITY · WAVE 9 (final wave).
 *
 * The Loom one-for-one of Power BI / Fabric report "Settings": the per-report
 * authoring options that live with the report definition and shape how it reads,
 * refreshes, and exports. This module ships TWO exports:
 *
 *   • {@link useReportSettings} — a tiny host-owned store ({ settings, setSettings })
 *     the report-designer seeds from `detail.state.content.settings` on load and
 *     includes in its existing Save → PUT `/definition` body (report-designer.tsx
 *     F2 / F12). The persisted shape is the additive, optional
 *     {@link PersistedReportSettings} the definition route whitelists + sanitizes,
 *     so the read-only viewer / PBIR provisioner simply ignore it.
 *
 *   • {@link ReportSettingsDialog} — the settings dialog itself: an auto-refresh
 *     interval Dropdown plus the "Allow export of visual data" Switch. Every change
 *     flows through `onChange` (the host's `setSettings`) and is durably persisted by
 *     the next Save — there is no separate route.
 *
 * ── Backend per control (no-vaporware.md — every RENDERED control is wired) ──────
 *   • Auto-refresh interval  → drives a REAL `setInterval` in the designer (F11)
 *     that re-runs every visual's Azure-native `/query`. Off = no timer.
 *   • Allow export           → when off, the designer suppresses the per-visual
 *     "Export data" menu (F11 passes `!allowExport` to drop `onExportData`).
 *
 *   ONLY controls a Loom surface actually consumes are rendered. The
 *   `persistFilters`, `visualHeaders` and `crossReportDrillthrough` keys remain in
 *   {@link PersistedReportSettings} as additive, route-whitelisted persisted schema
 *   (round-tripped on Save) but are intentionally NOT surfaced as toggles here: no
 *   reader/viewer surface reads them yet, so exposing them — or a "reset persistent
 *   filters" action whose browser event nothing listens for — would be a dead
 *   control / fake-success no-op (no-vaporware.md). They will gain UI here when the
 *   read-only viewer consumes them.
 *
 * All wired settings are PERSISTED at `state.content.settings` via the host's
 * existing `/definition` Save.
 *
 * ── Rules ───────────────────────────────────────────────────────────────────────
 *   no-fabric-dependency: settings live on the Azure-native Cosmos report item and
 *     drive the Azure-native query / export paths. Nothing here touches a Fabric
 *     capacity or Power BI workspace.
 *   no-vaporware: every rendered control mutates a persisted setting the designer
 *     actually consumes — no decorative toggles, no fake-success toasts.
 *   no-freeform-config: a Dropdown + a Switch. No JSON, no free text.
 *   web3-ui: Fluent UI v9 + Loom design tokens only (spacing / color / radius /
 *     shadow tokens — no hard-coded px or hex), elevated rows, section iconography,
 *     dark-legible foregrounds; matches the sibling Wave-9 dialogs.
 *
 * Mounting: report-designer.tsx mounts `<ReportSettingsDialog … />` from the View
 * ribbon's Settings group (F10) and seeds the hook from the loaded report. All
 * logic lives here; the designer edits are mount-only.
 */

import { useCallback, useMemo, useState } from 'react';
import type { Dispatch, ReactElement, ReactNode, SetStateAction } from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Badge, Caption1, Subtitle1, Text, Switch, Divider,
  Dropdown, Option,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Settings20Regular, ArrowClockwise20Regular,
  ArrowDownload20Regular,
  Dismiss24Regular, Info16Regular,
} from '@fluentui/react-icons';

// ── persisted shape ──────────────────────────────────────────────────────────
//
// Mirrors the `PersistedReportSettings` interface the definition route whitelists
// + sanitizes (report-designer's /definition route, WAVE-9). Every field is
// optional + additive so the viewer / PBIR provisioner ignore it; the route
// clamps `refreshIntervalSec` to 0..86400 and coerces the rest to booleans.

export interface PersistedReportSettings {
  /** Auto-refresh cadence in seconds; 0 / absent ⇒ off. Clamped 0..86400. WIRED. */
  refreshIntervalSec?: number;
  /** Allow per-visual "Export data" (off hides the export-data menu). WIRED. */
  allowExport?: boolean;
  /**
   * Reserved persisted schema — keep the reader's applied filter / slicer
   * selections across sessions. Route-whitelisted + round-tripped on Save, but NOT
   * surfaced as a dialog control: no reader/viewer surface consumes it yet, so a
   * toggle would be a dead control (no-vaporware.md).
   */
  persistFilters?: boolean;
  /** Reserved persisted schema — show visual headers. Not surfaced yet (no consumer). */
  visualHeaders?: boolean;
  /** Reserved persisted schema — cross-report drillthrough target. Not surfaced yet. */
  crossReportDrillthrough?: boolean;
}

/** The stable handle {@link useReportSettings} returns. */
export interface ReportSettingsHandle {
  /** Current settings (seeded by the host from `state.content.settings`). */
  settings: PersistedReportSettings;
  /** React setter — accepts a value or an updater; persisted on the host Save. */
  setSettings: Dispatch<SetStateAction<PersistedReportSettings>>;
}

/**
 * Host-owned report-settings store. Intentionally minimal: a single `useState`
 * the report-designer SEEDS from `detail.state.content.settings` on load (F2) and
 * folds back into its existing Save body (F12). Kept here so the persisted shape,
 * the dialog, and the seed/save plumbing share one source of truth.
 */
export function useReportSettings(): ReportSettingsHandle {
  const [settings, setSettings] = useState<PersistedReportSettings>({});
  return { settings, setSettings };
}

// ── auto-refresh choices (no-freeform: a fixed Dropdown, never a typed number) ──

interface RefreshChoice { value: string; label: string; sec: number }

const REFRESH_CHOICES: RefreshChoice[] = [
  { value: 'off', label: 'Off', sec: 0 },
  { value: '5m', label: 'Every 5 minutes', sec: 300 },
  { value: '15m', label: 'Every 15 minutes', sec: 900 },
  { value: '30m', label: 'Every 30 minutes', sec: 1800 },
  { value: '1h', label: 'Every hour', sec: 3600 },
];

// ── styles (Fluent v9 + Loom tokens only — no hard-coded px / hex) ─────────────

const useStyles = makeStyles({
  surface: { maxWidth: '600px', width: '92vw' },
  titleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  groupLabel: { color: tokens.colorNeutralForeground2 },

  row: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    padding: tokens.spacingVerticalM,
    boxShadow: tokens.shadow2,
    flexWrap: 'wrap',
    minWidth: 0,
  },
  rowIcon: { flexShrink: 0, color: tokens.colorNeutralForeground2, display: 'flex' },
  rowText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, flex: 1, minWidth: '160px' },
  rowControl: { flexShrink: 0, display: 'flex', alignItems: 'center' },

  dropdown: { minWidth: '200px' },
  muted: { color: tokens.colorNeutralForeground3 },
  legend: { display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalXS, minWidth: 0 },
});

// ── component ─────────────────────────────────────────────────────────────────

export interface ReportSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  /** Current settings (host-owned, from {@link useReportSettings}). */
  settings: PersistedReportSettings;
  /**
   * Persisted-settings setter. Typed as the React dispatch so the host can pass
   * `reportSettings.setSettings` directly; changes are saved on the host's Save.
   */
  onChange: Dispatch<SetStateAction<PersistedReportSettings>>;
}

/**
 * The report Settings dialog. Reads the host-owned {@link PersistedReportSettings}
 * and pushes every change back through `onChange` (the host's `setSettings`), which
 * the designer folds into its existing `/definition` Save. Auto-refresh is a fixed
 * Dropdown; "Allow export of visual data" is a Switch. Both are consumed by the
 * report designer (F11). No mock state, no dead controls, no fake-success toasts
 * (no-vaporware.md); Fluent v9 + Loom tokens (web3-ui.md).
 */
export function ReportSettingsDialog({
  open, onClose, settings, onChange,
}: ReportSettingsDialogProps): ReactElement {
  const s = useStyles();
  const sx = settings || {};

  /** Merge a partial change into the persisted settings (updater form). */
  const patch = useCallback((p: Partial<PersistedReportSettings>) => {
    onChange((prev) => ({ ...(prev || {}), ...p }));
  }, [onChange]);

  // Auto-refresh: map the persisted seconds → the matching fixed choice (or an
  // honest "custom" display when a value outside the preset list was persisted).
  const curSec = Number.isFinite(sx.refreshIntervalSec) ? Number(sx.refreshIntervalSec) : 0;
  const curChoice = useMemo(
    () => REFRESH_CHOICES.find((c) => c.sec === curSec),
    [curSec],
  );
  const refreshValue = curChoice?.value ?? 'custom';
  const refreshLabel = curChoice?.label
    ?? `Every ${curSec.toLocaleString()} seconds`;

  const onRefreshSelect = useCallback((value: string | undefined) => {
    const choice = REFRESH_CHOICES.find((c) => c.value === value);
    patch({ refreshIntervalSec: choice ? choice.sec : 0 });
  }, [patch]);

  /** One toggle row (icon + title + hint + Switch). Closes over `s`. */
  const toggleRow = (
    icon: ReactNode,
    title: string,
    hint: string,
    checked: boolean,
    onToggle: (next: boolean) => void,
  ): ReactElement => (
    <div className={s.row}>
      <span className={s.rowIcon}>{icon}</span>
      <div className={s.rowText}>
        <Text weight="semibold">{title}</Text>
        <Caption1 className={s.muted}>{hint}</Caption1>
      </div>
      <span className={s.rowControl}>
        <Switch
          checked={checked}
          aria-label={title}
          onChange={(_e, d) => onToggle(!!d.checked)}
        />
      </span>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(_e, d) => { if (!d.open) onClose(); }}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle
            action={(
              <Button
                appearance="subtle" icon={<Dismiss24Regular />}
                aria-label="Close report settings" onClick={onClose}
              />
            )}
          >
            <span className={s.titleRow}>
              <Settings20Regular />
              <Subtitle1>Report settings</Subtitle1>
              <Badge appearance="tint" color="brand" size="small">Azure-native · no Fabric required</Badge>
            </span>
          </DialogTitle>

          <DialogContent>
            <div className={s.body}>
              <Caption1 className={s.groupLabel}>
                These options are saved with the report and take effect on the next Save.
              </Caption1>

              {/* Auto-refresh interval (fixed Dropdown → refreshIntervalSec).
                  Drives a real setInterval re-query in the designer (F11). */}
              <div className={s.row}>
                <span className={s.rowIcon}><ArrowClockwise20Regular /></span>
                <div className={s.rowText}>
                  <Text weight="semibold">Auto-refresh</Text>
                  <Caption1 className={s.muted}>
                    Re-run every visual&apos;s Azure-native query on a timer. Off
                    keeps the report static until you refresh manually.
                  </Caption1>
                </div>
                <span className={s.rowControl}>
                  <Dropdown
                    className={s.dropdown}
                    aria-label="Auto-refresh interval"
                    value={refreshLabel}
                    selectedOptions={[refreshValue]}
                    onOptionSelect={(_e, d) => onRefreshSelect(d.optionValue)}
                  >
                    {REFRESH_CHOICES.map((c) => (
                      <Option key={c.value} value={c.value} text={c.label}>
                        {c.label}
                      </Option>
                    ))}
                  </Dropdown>
                </span>
              </div>

              {/* Allow export — the designer suppresses the per-visual "Export
                  data" menu when this is off (F11 passes !allowExport). */}
              {toggleRow(
                <ArrowDownload20Regular />,
                'Allow export of visual data',
                'Show the per-visual “Export data” menu (CSV / Excel). Off hides it.',
                sx.allowExport !== false,
                (next) => patch({ allowExport: next }),
              )}

              <Divider />

              <span className={s.legend}>
                <Info16Regular className={s.muted} />
                <Caption1 className={s.muted}>
                  Settings are stored on the Azure-native report item
                  (state.content.settings) and applied by the report editor — no
                  Fabric capacity or Power BI workspace is involved.
                </Caption1>
              </span>
            </div>
          </DialogContent>

          <DialogActions>
            <Button appearance="primary" onClick={onClose}>Done</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default ReportSettingsDialog;
