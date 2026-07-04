'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * VisualExportDataDialog — REPORT-BUILDER PARITY · WAVE 9
 *
 * The Power BI "Export data" surface for a single report visual, themed Fluent v9
 * + Loom tokens. It mirrors the Power BI service's per-visual export-data dialog
 * one-for-one (ui-parity.md): a Summarized-vs-Underlying choice, a CSV / Excel
 * format choice, and an Export button that streams a REAL file built from REAL
 * rows. Two modes:
 *
 *   • Summarized — the same aggregated rows the visual renders (the exact
 *     wells→SQL / DAX compile the `/query` route runs). Works on every backend.
 *   • Underlying — the row-level detail behind the visual (no GROUP BY), capped
 *     at the Power BI export limits. Requires report ownership AND an Azure-native
 *     SQL (Synapse / lakehouse) source; the route returns an honest 403 / 412
 *     otherwise, surfaced here in a MessageBar.
 *
 * Backend per control (no-vaporware.md): the Export button POSTs to
 * `/api/items/report/[id]/visual-data`, which executes the real Synapse query
 * (loom-native default) / connection executor / AAS XMLA and streams CSV or
 * .xlsx bytes — never a mock. On a non-2xx the route returns a structured
 * `{ ok:false, error }` JSON gate (underlying-ownership, a MIP-protected-CSV
 * block, an unbound source, a backend error) which this dialog reads and shows
 * verbatim in a Fluent MessageBar. A 2xx is the binary stream → read as a Blob →
 * {@link downloadBlobObject} triggers the real download.
 *
 * Rules compliance:
 *  - no-vaporware.md: the Export button always issues a real request that either
 *    downloads real bytes or surfaces the route's honest gate. No dead control.
 *  - no-freeform-config.md: a structured RadioGroup (mode) + Dropdown (format) —
 *    no typed-expression / raw-JSON box.
 *  - no-fabric-dependency.md: Azure-native by construction. The route's default
 *    backend is Synapse `executeQuery`; nothing here reaches a Fabric / Power BI
 *    host. The XLSX writer (`recordsetsToXlsxBuffer`) is dependency-free OOXML.
 *  - web3-ui.md: Fluent UI v9 + Loom design tokens only (no hard-coded px/hex in
 *    chrome); matches the sibling Navigator / Data-source designer dialogs.
 *
 * The `visual` is a minimal structural shape (mirroring the sibling
 * export-report `PrintVisual` / personalize `DVisual` pattern) so this file does
 * NOT import the designer's private DVisual type — the host passes its own DVisual
 * whole (wells + format + analytics …) and it satisfies this shape; the entire
 * object is forwarded to the route in the POST body.
 */

import { useCallback, useState } from 'react';
import {
  makeStyles, tokens,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Badge, Spinner, Caption1, Subtitle1, Field, Divider,
  RadioGroup, Radio, Dropdown, Option,
  MessageBar, MessageBarBody, MessageBarTitle,
} from '@fluentui/react-components';
import {
  ArrowDownload20Regular, Dismiss24Regular, DocumentTable20Regular,
  Table20Regular, DocumentText20Regular,
} from '@fluentui/react-icons';
import { slugify, downloadBlobObject } from './export-report';

// ── model ──────────────────────────────────────────────────────────────────────

/** Summarized = the rows the visual renders; Underlying = raw row-level detail. */
export type VisualExportMode = 'summarized' | 'underlying';
/** The two per-visual export formats Power BI offers (PDF/etc. are report-scope). */
export type VisualExportFormat = 'csv' | 'xlsx';

/**
 * The minimal structural shape of a designer visual this dialog reads. A designer
 * `DVisual` (which also carries wells / format / analytics / …) satisfies it; the
 * whole object is forwarded to the route, so its richer fields are preserved.
 */
export interface ExportVisualShape {
  id: string;
  type: string;
  title?: string;
  wells?: Record<string, unknown>;
}

export interface VisualExportDataDialogProps {
  /** The report item id — scopes the POST to `/api/items/report/[id]/visual-data`. */
  reportId: string;
  /** The visual whose data to export (forwarded whole in the POST body). */
  visual: ExportVisualShape;
  /** The effective report+page filters applied to the visual (forwarded as-is). */
  filters?: unknown[];
  /** The persisted report data source (forwarded for forward-compat resolution). */
  dataSource?: unknown;
  /** Close the dialog (the host unmounts it). */
  onClose: () => void;
}

// ── format catalog (structured — no freeform) ───────────────────────────────────

const FORMATS: { value: VisualExportFormat; label: string; ext: string }[] = [
  { value: 'csv', label: 'CSV (.csv)', ext: 'csv' },
  { value: 'xlsx', label: 'Excel workbook (.xlsx)', ext: 'xlsx' },
];

// ── styles (Fluent v9 + Loom tokens only) ───────────────────────────────────────

const useStyles = makeStyles({
  surface: { maxWidth: '520px' },
  titleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  modeCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
  },
  radioRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalL, flexWrap: 'wrap' },
  formatRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  muted: { color: tokens.colorNeutralForeground3 },
  capNote: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    color: tokens.colorNeutralForeground3,
  },
  footer: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, width: '100%' },
  grow: { flex: 1, minWidth: 0 },
});

// ── component ────────────────────────────────────────────────────────────────────

/**
 * The per-visual "Export data" dialog. Mounted by the designer only while a visual
 * is selected for export (so it is always `open`); dismiss / Escape / Cancel call
 * {@link VisualExportDataDialogProps.onClose}.
 */
export function VisualExportDataDialog({
  reportId, visual, filters, dataSource, onClose,
}: VisualExportDataDialogProps) {
  const styles = useStyles();

  const [mode, setMode] = useState<VisualExportMode>('summarized');
  const [format, setFormat] = useState<VisualExportFormat>('csv');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const fmtEntry = FORMATS.find((f) => f.value === format) ?? FORMATS[0];
  const title = visual.title || visual.type || 'visual';

  const runExport = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await clientFetch(`/api/items/report/${encodeURIComponent(reportId)}/visual-data`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          visual,
          ...(Array.isArray(filters) && filters.length ? { filters } : {}),
          ...(dataSource ? { dataSource } : {}),
          mode,
          format,
        }),
      });

      if (res.ok) {
        // 2xx → the binary stream (text/csv or the xlsx content-type). Read it as a
        // Blob and trigger the real download, then close.
        const blob = await res.blob();
        downloadBlobObject(`${slugify(title)}-${mode}.${fmtEntry.ext}`, blob);
        onClose();
        return;
      }

      // Non-2xx → the route's structured { ok:false, error } gate (underlying-
      // ownership 403 / MIP-protected-CSV 403 / unbound 412 / backend 502). Surface
      // the precise reason verbatim.
      let message = `Export failed (HTTP ${res.status}).`;
      try {
        const j = (await res.json()) as { error?: string; code?: string } | null;
        if (j?.error) message = j.error;
      } catch {
        /* non-JSON body — keep the HTTP-status fallback */
      }
      setErr(message);
    } catch (e: any) {
      setErr(e?.message || 'The export request could not be sent. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }, [reportId, visual, filters, dataSource, mode, format, fmtEntry.ext, title, onClose]);

  return (
    <Dialog open modalType="modal" onOpenChange={(_, d) => { if (!d.open && !busy) onClose(); }}>
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle
            action={
              <Button
                appearance="subtle"
                icon={<Dismiss24Regular />}
                aria-label="Close export data"
                disabled={busy}
                onClick={onClose}
              />
            }
          >
            <span className={styles.titleRow}>
              <DocumentTable20Regular />
              <Subtitle1>Export data</Subtitle1>
              <Badge appearance="outline" color="subtle" size="small">{title}</Badge>
              <Badge appearance="tint" color="brand" size="small">Azure-native · no Fabric required</Badge>
            </span>
          </DialogTitle>

          <DialogContent>
            <div className={styles.body}>
              {err && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Couldn’t export this data</MessageBarTitle>
                    {err}
                  </MessageBarBody>
                </MessageBar>
              )}

              {/* WHICH ROWS — Summarized vs Underlying (RadioGroup, no freeform) */}
              <Field label="Which data">
                <div className={styles.modeCard}>
                  <RadioGroup
                    value={mode}
                    layout="horizontal"
                    aria-label="Which data to export"
                    disabled={busy}
                    onChange={(_e, d) => setMode(d.value as VisualExportMode)}
                  >
                    <div className={styles.radioRow}>
                      <Radio value="summarized" label="Summarized data" />
                      <Radio value="underlying" label="Underlying data" />
                    </div>
                  </RadioGroup>
                  <Caption1 className={styles.muted}>
                    {mode === 'summarized'
                      ? 'Summarized — the aggregated rows this visual renders (every backend).'
                      : 'Underlying — the row-level detail behind the visual (no grouping). Requires report ownership and an Azure-native SQL (Synapse / lakehouse) source.'}
                  </Caption1>
                </div>
              </Field>

              {/* FILE FORMAT — CSV vs Excel (Dropdown, no freeform) */}
              <Field label="File format">
                <div className={styles.formatRow}>
                  <Dropdown
                    value={fmtEntry.label}
                    selectedOptions={[format]}
                    aria-label="Export file format"
                    disabled={busy}
                    style={{ minWidth: '220px' }}
                    onOptionSelect={(_e, d) => setFormat((d.optionValue as VisualExportFormat) || 'csv')}
                  >
                    {FORMATS.map((f) => (
                      <Option key={f.value} value={f.value} text={f.label}>
                        <span className={styles.formatRow}>
                          {f.value === 'xlsx' ? <Table20Regular /> : <DocumentText20Regular />}
                          {f.label}
                        </span>
                      </Option>
                    ))}
                  </Dropdown>
                </div>
              </Field>

              <Divider />

              <Caption1 className={styles.capNote}>
                CSV ≤30,000 rows · Excel ≤150,000 rows; Underlying requires report ownership
              </Caption1>
            </div>
          </DialogContent>

          <DialogActions>
            <div className={styles.footer}>
              {busy && <Spinner size="tiny" label="Building the file…" />}
              <span className={styles.grow} />
              <Button appearance="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
              <Button
                appearance="primary"
                icon={busy ? <Spinner size="tiny" /> : <ArrowDownload20Regular />}
                disabled={busy}
                onClick={() => void runExport()}
              >
                Export
              </Button>
            </div>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default VisualExportDataDialog;
