'use client';

/**
 * script-visual — the Power BI "Python visual" / "R visual" surface for the
 * Loom-native Report Designer (report-designer wave 4).
 *
 * ── Power BI parity (ui-parity.md) ──────────────────────────────────────────
 * learn.microsoft.com/power-bi/connect-data/desktop-python-visuals (and the R
 * counterpart). In Power BI Desktop a script visual is, one-for-one, a CODE
 * EDITOR plus a Values well: the fields you drop into Values become a variable
 * named `dataset` — a pandas DataFrame (Python) / data.frame (R) whose COLUMN
 * NAMES are the field names (no rename). Rows are GROUPED + DEDUPED (duplicate
 * rows collapse to one, the default "Don't summarize"). Your script plots to the
 * DEFAULT device and Power BI captures the ACTIVE figure as a STATIC, NON-
 * interactive image. Hard limits: 150,000 rows, a wall-clock timeout, fixed DPI.
 *
 * This file is the one-for-one Loom build of that surface, Azure-native by
 * construction:
 *   • Values fields stay in the right-rail WellEditor (PBI keeps wells in the
 *     Visualizations pane and the script editor separate) — here they show as a
 *     READ-ONLY chip summary so the author sees exactly which columns land in
 *     `dataset`. An EmptyState prompts to add Values when none are bound.
 *   • A Python / R language toggle (structured, not free text) seeds the default
 *     starter template when the editor is empty.
 *   • A CODE EDITOR (Monaco, language python|r — the same surface the notebook
 *     editor uses) authors the script.
 *   • Run POSTs `{ visualId, language, script, rows }` to the wave-4 BFF route
 *     `/api/items/report/[id]/script-visual`, which forwards to a REAL sandboxed
 *     Azure Container Apps executor (script-runner-app.bicep) that runs the
 *     script in a resource-limited subprocess and returns a real PNG. The image
 *     renders inline, bounded + height-capped, exactly like PBI's static figure.
 *
 * ── no-freeform-config.md (EXEMPT, documented) ──────────────────────────────
 * The Power BI R/Python visual IS a code editor — free-form code is the literal
 * 1:1 parity surface, so this editor is EXEMPT from the no-freeform-config rule
 * exactly like the ADF/Synapse expression builder is. Everything AROUND the code
 * (the Values wells, the language toggle) stays structured. No JSON blobs, no
 * "paste a config here" — only the code Power BI itself asks you to write.
 *
 * ── no-vaporware.md ─────────────────────────────────────────────────────────
 * Every control is wired to a real backend. Run actually calls the executor; the
 * returned PNG actually renders. When the executor is not deployed the route
 * returns HTTP 503 and this surface shows an HONEST Fluent warning MessageBar
 * naming the exact remediation (set LOOM_SCRIPT_RUNNER_URL, deploy
 * platform/fiab/bicep/modules/admin-plane/script-runner-app.bicep) while the
 * full editor surface still renders. A script error surfaces the executor's real
 * stderr/stdout in a collapsible — no swallowed failures, no fake success. This
 * is the FIRST new BFF route the report program adds (waves 0–3 added zero),
 * called out honestly in docs/fiab/parity/report-designer.md.
 *
 * ── Sandbox threat model (mirrors Power BI; enforced in the ACA app) ─────────
 * The CONTAINER is the boundary, exactly like Power BI's locked container:
 * arbitrary user code DOES run inside it. Isolation is enforced server-side by
 * the executor (app.py) — non-root `runner` user, INTERNAL-only ingress (never
 * public), per-request ephemeral mkdtemp under /tmp (0700, rmtree in finally), a
 * SCRUBBED minimal env (NO inherited secrets), POSIX rlimits (CPU/AS/FSIZE/NPROC),
 * start_new_session + a wall-clock timeout that SIGKILLs the whole process group,
 * and script-size / row / PNG-size caps. CRITICAL wiring note carried into bicep
 * + README: because the ACA app exposes its assigned UAMI to in-container code
 * via IMDS, the runner MUST use a LEAST-PRIVILEGE identity
 * (`uami-loom-script-runner`, AcrPull only, ZERO data-plane roles). Reusing the
 * broadly-permissioned Console UAMI is a real sandbox hole — documented as a
 * known weakness to tighten, never silently. This UI does not weaken any of that;
 * it only renders the result + the honest gate.
 *
 * ── no-fabric-dependency.md ──────────────────────────────────────────────────
 * Azure-native by construction (ACA executor + the existing Synapse `/query`
 * Path-3 the host already used to fetch `rows`). Nothing here reaches
 * api.fabric.microsoft.com / api.powerbi.com — no Power BI / Fabric service is
 * needed to author or run a script visual.
 *
 * ── web3-ui.md ───────────────────────────────────────────────────────────────
 * Fluent UI v9 + Loom design tokens only — no hard-coded spacing/colors/radii/
 * shadows. The card matches the sibling AI-visual surfaces (qa / smart-narrative):
 * an accent header icon, a tinted segmented language pill (Fluent 9.54 has no
 * SegmentedControl, so a grouped ToggleButton pill like the shared ViewToggle),
 * elevation, and designed empty / loading / gate / error states. The two
 * dark-legible gallery glyphs ({@link pythonGalleryGlyph} / {@link rGalleryGlyph})
 * are exported for the host VISUALS gallery, matching the just-shipped picker.
 *
 * The script visual is just another DVisual with an absolute layout rect — the
 * FreeFormCanvas positions it like any visual; the host renders THIS body inside
 * its frame body slot. Free-form canvas + waves 0–3 + the data E2E + the Copilot
 * are extended, not regressed.
 */

import { useCallback, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, ToggleButton, Spinner, Divider, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle,
  Accordion, AccordionItem, AccordionHeader, AccordionPanel,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  Play16Regular, Code20Regular, DocumentData16Regular, Beaker20Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';

// ── types ───────────────────────────────────────────────────────────────────

export type ScriptLanguage = 'python' | 'r';

/**
 * A bound Values-well field (structurally a subset of the report-designer
 * `WellField`, so the host passes its `WellField[]` straight in). Only the
 * fields needed to label the column that lands in `dataset` are read here.
 */
export interface WellField {
  uid: string;
  table?: string;
  column?: string;
  measure?: string;
  aggregation?: string;
}

export interface ScriptVisualProps {
  /** The report's Loom item id — the BFF route shares it on the path. */
  reportId: string;
  /** Selected script language (PBI Python / R visual). */
  language: ScriptLanguage;
  /** The authored script source. */
  script: string;
  /**
   * The visual's bound Values-well rows, ALREADY fetched by the host's
   * `runVisual` for this visual (the same Path-3 `/query` result every visual
   * gets). Sent to the executor as `dataset` (grouped + deduped server-side).
   */
  rows: Array<Record<string, unknown>>;
  /** The bound Values fields (column names for `dataset`); shown as chips. */
  valueFields: WellField[];
  /** Persist a structured patch back to the DVisual (script / language). */
  onChange: (patch: { script?: string; language?: ScriptLanguage }) => void;
  /**
   * Optional canvas visual id (sent in the request body for the executor's
   * per-request log/cache key). Omitted when the host has no id yet.
   */
  visualId?: string;
}

// ── PBI-parity starter templates (reference the `dataset` variable verbatim) ──

const PY_TEMPLATE =
  `# 'dataset' is a pandas DataFrame of your Values fields\n` +
  `import matplotlib.pyplot as plt\n` +
  `dataset.plot()\n` +
  `plt.show()\n`;

const R_TEMPLATE =
  `# 'dataset' is a data.frame of your Values fields\n` +
  `library(ggplot2)\n` +
  `plot(dataset)\n`;

/** The default starter script Power BI seeds for a fresh Python / R visual. */
export function defaultScriptTemplate(language: ScriptLanguage): string {
  return language === 'r' ? R_TEMPLATE : PY_TEMPLATE;
}

// ── run state ────────────────────────────────────────────────────────────────

type RunState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; image: string; mime: string }
  | { kind: 'gate' }
  | { kind: 'error'; message: string; stderr?: string; stdout?: string };

// ── styles ───────────────────────────────────────────────────────────────────

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    height: '100%',
    minHeight: 0,
    minWidth: 0,
    padding: tokens.spacingHorizontalS,
    boxSizing: 'border-box',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
  },
  headerIcon: { color: tokens.colorBrandForeground1, display: 'inline-flex' },
  grow: { flexGrow: 1, minWidth: 0 },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
  chips: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalXS,
    alignItems: 'center',
  },
  // Grouped ToggleButton "pill" — Fluent 9.54 has no SegmentedControl; matches
  // the shared ViewToggle affordance (raised pill = active segment).
  seg: {
    display: 'inline-flex',
    alignItems: 'stretch',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground3,
    padding: '2px',
    gap: '2px',
  },
  segBtn: {
    border: 'none',
    borderRadius: tokens.borderRadiusSmall,
    minWidth: '72px',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground2,
    fontWeight: tokens.fontWeightRegular,
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground3Hover,
      color: tokens.colorNeutralForeground1,
    },
  },
  segBtnChecked: {
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    fontWeight: tokens.fontWeightSemibold,
    boxShadow: tokens.shadow2,
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1,
      color: tokens.colorNeutralForeground1,
    },
  },
  editorWrap: { minWidth: 0 },
  // Output frame — bounded + height-capped so the static figure never overflows
  // the canvas card (a layout bound, like the canvas page dims).
  output: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    padding: tokens.spacingHorizontalS,
    maxHeight: '420px',
    overflow: 'auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '160px',
  },
  outputImg: { maxWidth: '100%', height: 'auto', display: 'block' },
  running: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground2,
  },
  notes: { color: tokens.colorNeutralForeground3 },
  stderr: {
    margin: 0,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: '200px',
    overflow: 'auto',
    color: tokens.colorNeutralForeground2,
  },
  fieldCaption: { color: tokens.colorNeutralForeground3 },
});

// ── helpers ──────────────────────────────────────────────────────────────────

/** Column name a Values field contributes to `dataset` (parity: no rename). */
function fieldLabel(f: WellField): string {
  return f.measure || f.column || f.table || 'field';
}

/** Clamp the executor's diagnostic text to a sane display length. */
function clip(s?: string, max = 4000): string | undefined {
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more chars)` : s;
}

// ── gallery glyphs (exported for the host VISUALS gallery) ────────────────────
// Dark-legible: a Fluent code/beaker glyph on the brand foreground, matching the
// just-shipped visual picker. The host imports these for the two gallery entries.

/** Gallery glyph for the Python visual entry. */
export const pythonGalleryGlyph: ReactElement = <Code20Regular />;
/** Gallery glyph for the R visual entry. */
export const rGalleryGlyph: ReactElement = <Beaker20Regular />;

// ── component ─────────────────────────────────────────────────────────────────

/**
 * ScriptVisual — the Power BI Python/R script-visual card body. Renders the
 * Values-chip summary + language toggle + Monaco editor + Run + the static
 * image output / honest gate, all wired to the real ACA executor BFF route.
 */
export function ScriptVisual({
  reportId, language, script, rows, valueFields, onChange, visualId,
}: ScriptVisualProps): ReactElement {
  const styles = useStyles();
  const [run, setRun] = useState<RunState>({ kind: 'idle' });

  const hasFields = (valueFields?.length || 0) > 0;
  const canRun = script.trim().length > 0 && run.kind !== 'running';

  // Language switch — seed the default template when the editor is empty (PBI
  // seeds a starter script on a fresh visual). Structured toggle, not free text.
  const switchLanguage = useCallback((lang: ScriptLanguage) => {
    if (lang === language) return;
    if (script.trim() === '') onChange({ language: lang, script: defaultScriptTemplate(lang) });
    else onChange({ language: lang });
  }, [language, script, onChange]);

  const insertTemplate = useCallback(() => {
    onChange({ script: defaultScriptTemplate(language) });
  }, [language, onChange]);

  const onScript = useCallback((next: string) => {
    onChange({ script: next });
  }, [onChange]);

  const doRun = useCallback(async () => {
    if (script.trim().length === 0) return;
    setRun({ kind: 'running' });
    try {
      const r = await fetch(`/api/items/report/${encodeURIComponent(reportId)}/script-visual`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visualId, language, script, rows }),
      });
      // Honest infra-gate: the executor isn't deployed/configured (no-vaporware).
      if (r.status === 503) { setRun({ kind: 'gate' }); return; }
      let j: any = {};
      try { j = await r.json(); } catch { j = {}; }
      if (r.ok && j && j.ok && j.image) {
        setRun({ kind: 'ok', image: String(j.image), mime: String(j.mime || 'image/png') });
        return;
      }
      // Surface the executor's REAL failure (stderr/stdout) — never a fake pass.
      setRun({
        kind: 'error',
        message: (j && (j.error || j.message)) || `HTTP ${r.status}`,
        stderr: clip(j && j.stderr),
        stdout: clip(j && j.stdout),
      });
    } catch (e: any) {
      setRun({ kind: 'error', message: e?.message || String(e) });
    }
  }, [reportId, visualId, language, script, rows]);

  return (
    // data-ff-nodrag: the whole interactive body never starts a canvas move
    // (the FreeFormCanvas header is the drag grip; this protects text selection
    // inside the Monaco editor and the toolbar controls).
    <div className={styles.root} data-ff-nodrag>
      {/* Header */}
      <div className={styles.header}>
        <span className={styles.headerIcon}><Code20Regular /></span>
        <Subtitle2 className={styles.grow}>{language === 'r' ? 'R script visual' : 'Python script visual'}</Subtitle2>
        <Badge appearance="tint" color="brand" size="small">Script</Badge>
      </div>

      {/* Values-well chip summary (read-only — the canonical drag-target lives in
          the right-rail WellEditor, PBI parity). */}
      <div>
        <Caption1 className={styles.fieldCaption}>
          Values → <code>dataset</code> columns
        </Caption1>
        {hasFields ? (
          <div className={styles.chips}>
            {valueFields.map((f) => (
              <Badge key={f.uid} appearance="outline" size="medium" icon={<DocumentData16Regular />}>
                {fieldLabel(f)}
              </Badge>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<DocumentData16Regular />}
            title="No Values fields"
            body="Add fields to the Values well (right rail) — their column names become the dataset passed to your script."
          />
        )}
      </div>

      {/* Toolbar: language toggle + template + Run */}
      <div className={styles.toolbar}>
        <div className={styles.seg} role="group" aria-label="Script language">
          <ToggleButton
            className={mergeClasses(styles.segBtn, language === 'python' && styles.segBtnChecked)}
            appearance="subtle"
            checked={language === 'python'}
            aria-pressed={language === 'python'}
            onClick={() => switchLanguage('python')}
          >
            Python
          </ToggleButton>
          <ToggleButton
            className={mergeClasses(styles.segBtn, language === 'r' && styles.segBtnChecked)}
            appearance="subtle"
            checked={language === 'r'}
            aria-pressed={language === 'r'}
            onClick={() => switchLanguage('r')}
          >
            R
          </ToggleButton>
        </div>

        {script.trim() === '' && (
          <Button appearance="transparent" size="small" icon={<Code20Regular />} onClick={insertTemplate}>
            Insert starter template
          </Button>
        )}

        <span className={styles.grow} />

        <Tooltip content="Run the script in the sandboxed executor" relationship="label">
          <Button appearance="primary" icon={<Play16Regular />} disabled={!canRun} onClick={doRun}>
            Run
          </Button>
        </Tooltip>
      </div>

      {/* Code editor — PBI 1:1 parity surface (EXEMPT from no-freeform-config). */}
      <div className={styles.editorWrap}>
        <MonacoTextarea
          value={script}
          onChange={onScript}
          language={language === 'r' ? 'r' : 'python'}
          height={220}
          ariaLabel={`${language === 'r' ? 'R' : 'Python'} script`}
        />
      </div>

      <Divider />

      {/* Output */}
      {run.kind === 'gate' && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Script executor not configured</MessageBarTitle>
            The R/Python script executor isn’t deployed in this environment. Set{' '}
            <code>LOOM_SCRIPT_RUNNER_URL</code> on the console app and deploy{' '}
            <code>platform/fiab/bicep/modules/admin-plane/script-runner-app.bicep</code>{' '}
            (a least-privilege Azure Container App). The editor stays fully usable; Run renders once it’s wired.
          </MessageBarBody>
        </MessageBar>
      )}

      {run.kind === 'error' && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Script failed</MessageBarTitle>
            {run.message}
            {(run.stderr || run.stdout) && (
              <Accordion collapsible>
                <AccordionItem value="diag">
                  <AccordionHeader>Output (stderr / stdout)</AccordionHeader>
                  <AccordionPanel>
                    {run.stderr && <pre className={styles.stderr}>{run.stderr}</pre>}
                    {run.stdout && <pre className={styles.stderr}>{run.stdout}</pre>}
                  </AccordionPanel>
                </AccordionItem>
              </Accordion>
            )}
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.output}>
        {run.kind === 'running' ? (
          <span className={styles.running}><Spinner size="tiny" /> <Body1>Running script…</Body1></span>
        ) : run.kind === 'ok' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className={styles.outputImg} alt="script visual" src={`data:${run.mime};base64,${run.image}`} />
        ) : run.kind === 'idle' || run.kind === 'gate' ? (
          <EmptyState
            icon={<Play16Regular />}
            title="Run script to render the visual"
            body="The script runs in a sandboxed executor and returns a static image — Power BI parity."
          />
        ) : (
          <Caption1 className={styles.notes}>No image — see the error above.</Caption1>
        )}
      </div>

      {/* PBI-parity notes */}
      <Caption1 className={styles.notes}>
        Image is static and non-interactive · rows are grouped + deduped · 150,000-row cap · 96 DPI
        {` · ${rows?.length || 0} row${(rows?.length || 0) === 1 ? '' : 's'} bound`}
      </Caption1>
    </div>
  );
}

export default ScriptVisual;
