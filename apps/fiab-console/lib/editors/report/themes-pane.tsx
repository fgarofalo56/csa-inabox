'use client';

/**
 * ThemesPane — the "Themes" right-rail tab of the Loom-native Report Designer
 * (Power BI report-authoring parity, wave 3).
 *
 * Power BI parity (ui-parity.md): PBI's report Theme surface lets an author
 * (1) pick a built-in theme that restyles EVERY visual at once — data palette,
 * structural background, foreground/text color, table accent, and font; (2)
 * build a custom theme with structured pickers (the "Customize theme" dialog —
 * Name & colors / Text / Visuals tabs); and (3) import / export a Power BI
 * theme JSON file (`{ name, dataColors[], background, foreground, tableAccent,
 * firstLevelElements, textClasses.*.fontFace, … }`). This pane reproduces that
 * surface one-for-one with the Loom theme, themed in Fluent v9.
 *
 * Single source of truth (simplification): the theme MODEL, the built-in
 * themes, and the Power-BI-JSON converters all live in the sibling
 * `./themes` module — the SAME `ReportTheme` / `BUILTIN_LOOM_THEMES` /
 * `pbiJsonToTheme` / `themeToPbiJson` the host designer imports for
 * `sanitizeTheme` / `themeChartProps` / `applyThemeCssVars` and that LoomChart
 * and the `/definition` route consume. This pane carries NO parallel model and
 * NO parallel converters (they previously lived here and could silently drift
 * from `./themes`); it owns only the React + picker-UI concerns. The chosen
 * {@link ReportTheme} is owned by the host designer and persisted ADDITIVELY on
 * `state.content.theme` — the same round-trip the wave-2 `bookmarks` /
 * `filterPaneFormat` keys use through PUT /api/items/report/[id]/definition.
 *
 * Rules compliance:
 *  - no-vaporware.md: there are no dead controls. Picking a built-in theme or
 *    editing any structured field calls `onChange` with a real {@link ReportTheme}
 *    the host applies live to every visual and round-trips through /definition.
 *    Export downloads a REAL Power-BI-compatible `.json` (via the shared
 *    `downloadBlob`); Import reads a REAL file (FileReader) and parses it with
 *    `./themes` `pbiJsonToTheme`, surfacing a precise Fluent MessageBar on
 *    malformed input. No "coming soon" / disabled-with-tooltip controls, and no
 *    write-only field with no consumer (the former Transparency slider wrote a
 *    `backgroundTransparency` value that nothing in `./themes` / LoomChart /
 *    the `/definition` sanitizer ever read — it was removed rather than left as
 *    a control with no visual effect).
 *  - no-freeform-config.md: the theme is authored with STRUCTURED pickers only —
 *    swatch chips + native `<input type=color>` per palette slot, a Font
 *    Dropdown, and background / accent / foreground color fields. There is NO
 *    raw-JSON textarea as the primary surface; import/export of a Power BI theme
 *    JSON *file* is the one explicitly-permitted exception ("structured pickers +
 *    import, NOT a raw-JSON-only box").
 *  - no-fabric-dependency.md: Azure-native by construction. A theme is plain
 *    client styling layered over the Synapse/AAS `/query` + `/definition` path;
 *    nothing here reaches a Fabric / Power BI workspace. The Power BI theme JSON
 *    is just an interchange file format — importing/exporting one needs no PBI
 *    tenant.
 *  - web3-ui.md: Fluent UI v9 + Loom design tokens only (no hard-coded
 *    spacing/colors/radii/shadows); theme cards lift on hover with
 *    `borderRadiusLarge`, laid out with the shared {@link TileGrid}, and the pane
 *    mirrors the sibling format-pane / bookmarks-pane layout.
 *
 * No backend call originates in this component — the host owns persistence.
 */

import { useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Badge, Button, Caption1, Divider, Dropdown, Input, MessageBar, MessageBarBody,
  MessageBarTitle, Option, Subtitle2, Text, Tooltip,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowDown20Regular, ArrowDownload20Regular, ArrowUp20Regular,
  ArrowUpload20Regular, Color20Regular, Delete20Regular, Dismiss16Regular,
  PaintBrush20Regular, TextFont20Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { downloadBlob } from '@/lib/editors/components/result-export';
// Re-used so the None-card preview shows the exact Loom default palette the
// charts paint with (type-compatible value import; no cycle — format-pane does
// not import this module).
import { LOOM_DATA_PALETTE } from './format-pane';
// ── Single source of truth for the theme MODEL + built-ins + converters ───────
// The ReportTheme shape, the curated built-in themes, and the bidirectional
// Power-BI-theme-JSON bridge live in ./themes — the SAME module the host
// designer, LoomChart, and the /definition sanitizer use. ThemesPane consumes
// them so the model + converters can never drift from the persistence path.
import {
  type ReportTheme,
  BUILTIN_LOOM_THEMES,
  pbiJsonToTheme,
  themeToPbiJson,
} from './themes';

// ── Picker-UI helpers (React-side; concrete hex for native color inputs) ──────
// These are presentation concerns for the structured builder, NOT a second
// theme model: a native `<input type=color>` requires a concrete 7-char hex, so
// the quick-pick swatches and the builder's starting palette are expressed as
// hex here. The model default (CSS-var tokens, dark-mode-safe) stays in
// ./themes `DEFAULT_PALETTE` for the no-theme render path.

interface HexSwatch { hex: string; label: string }
export const LOOM_PALETTE_HEX: HexSwatch[] = [
  { hex: '#0f6cbd', label: 'Brand' },
  { hex: '#0e700e', label: 'Green' },
  { hex: '#5c2e91', label: 'Purple' },
  { hex: '#835b00', label: 'Marigold' },
  { hex: '#bc2f32', label: 'Red' },
  { hex: '#115ea3', label: 'Blue' },
  { hex: '#038387', label: 'Teal' },
  { hex: '#af1964', label: 'Berry' },
];

/** The builder's concrete-hex starting palette (so color inputs echo it). */
const BUILDER_HEX_PALETTE: string[] = LOOM_PALETTE_HEX.map((s) => s.hex);

/** Curated font choices (id '' ⇒ Loom default / no override). PBI-parity set. */
export const THEME_FONTS: { id: string; label: string }[] = [
  { id: '', label: 'Loom default (Segoe UI)' },
  { id: 'Segoe UI', label: 'Segoe UI' },
  { id: 'Arial', label: 'Arial' },
  { id: 'Calibri', label: 'Calibri' },
  { id: 'Verdana', label: 'Verdana' },
  { id: 'Georgia', label: 'Georgia (serif)' },
  { id: 'Times New Roman', label: 'Times New Roman (serif)' },
  { id: 'Consolas', label: 'Consolas (mono)' },
];

/** Coerce any stored color to the 7-char `#rrggbb` a native color input needs. */
export function toColorInput(v: string | undefined, fallback: string): string {
  const s = (v ?? '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (/^#[0-9a-fA-F]{8}$/.test(s)) return s.slice(0, 7).toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toLowerCase();
  }
  return fallback;
}

/** A filesystem-safe slug for the exported file name. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'loom-theme';
}

/**
 * Friendly display name for a theme's font value on a built-in card. The
 * ./themes built-ins store a CSS-var ('Loom Default' ⇒ `var(--fontFamilyBase)`)
 * or a quoted stack (`'Segoe UI', system-ui, sans-serif`); show a readable label
 * rather than the raw CSS string (web3-ui: no raw token strings in the UI).
 */
function fontLabel(ff?: string): string {
  const s = (ff ?? '').trim();
  if (!s || s.startsWith('var(')) return 'Loom default';
  return s.split(',')[0].trim().replace(/^['"]|['"]$/g, '') || 'Loom default';
}

/** A fresh blank custom theme (when the author starts from None). */
function scaffoldTheme(): ReportTheme {
  return { name: 'Custom theme', dataColors: BUILDER_HEX_PALETTE.slice(0, 6) };
}

// ── styles (Fluent v9 + Loom tokens only) ────────────────────────────────────

const useStyles = makeStyles({
  pane: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL,
    paddingTop: tokens.spacingVerticalM, paddingBottom: tokens.spacingVerticalXL,
    paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    minWidth: 0,
  },
  intro: { color: tokens.colorNeutralForeground3 },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  sectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  muted: { color: tokens.colorNeutralForeground3 },

  // theme picker cards
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    paddingTop: tokens.spacingVerticalS, paddingBottom: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1, cursor: 'pointer', textAlign: 'left',
    boxShadow: tokens.shadow2, transitionProperty: 'box-shadow, border-color, transform',
    transitionDuration: tokens.durationNormal, minWidth: 0,
    ':hover': { boxShadow: tokens.shadow8, transform: 'translateY(-1px)' },
  },
  cardActive: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
    boxShadow: `0 0 0 1px ${tokens.colorBrandStroke1}, ${tokens.shadow8}`,
  },
  cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalS },
  cardName: { fontWeight: tokens.fontWeightSemibold },
  cardFont: { color: tokens.colorNeutralForeground3 },
  swatchStrip: {
    display: 'flex', gap: '3px', flexWrap: 'nowrap', overflow: 'hidden',
    borderRadius: tokens.borderRadiusMedium,
  },
  swatchDot: { width: '16px', height: '16px', borderRadius: tokens.borderRadiusSmall, flexShrink: 0 },

  // custom builder
  slotRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  slotIndex: {
    width: '18px', textAlign: 'center', color: tokens.colorNeutralForeground3, flexShrink: 0,
  },
  hexText: { flex: 1, minWidth: 0, color: tokens.colorNeutralForeground2, fontFamily: tokens.fontFamilyMonospace },
  colorChip: {
    width: '30px', height: '26px', padding: 0, flexShrink: 0, cursor: 'pointer',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: 'transparent',
  },
  rowButtons: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  fieldRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  fieldLabel: { minWidth: '76px', color: tokens.colorNeutralForeground2 },
  quickRow: { display: 'flex', gap: '4px', flexWrap: 'wrap' },
  miniSwatch: {
    width: '20px', height: '20px', padding: 0, cursor: 'pointer', flexShrink: 0,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusSmall,
  },
  miniSwatchActive: { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '1px' },

  // import / export
  ioRow: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  hiddenFile: { display: 'none' },
});

type Styles = ReturnType<typeof useStyles>;

// ── small presentational helpers ─────────────────────────────────────────────

function SectionHead({ icon, label, styles }: { icon: ReactElement; label: string; styles: Styles }) {
  return (
    <div className={styles.sectionHead}>
      {icon}
      <Subtitle2>{label}</Subtitle2>
    </div>
  );
}

/** A single structural-color field: native color input + Loom quick-picks + clear. */
function ColorField({ label, value, fallback, onChange, allowClear, styles }: {
  label: string;
  value?: string;
  fallback: string;
  onChange: (color?: string) => void;
  allowClear?: boolean;
  styles: Styles;
}): ReactElement {
  return (
    <div className={styles.fieldRow}>
      <Caption1 className={styles.fieldLabel}>{label}</Caption1>
      <input
        type="color"
        aria-label={label}
        className={styles.colorChip}
        value={toColorInput(value, fallback)}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className={styles.quickRow} role="radiogroup" aria-label={`${label} palette`}>
        {LOOM_PALETTE_HEX.map((sw) => {
          const active = (value ?? '').toLowerCase() === sw.hex.toLowerCase();
          return (
            <button
              key={sw.hex}
              type="button" role="radio" aria-checked={active} aria-label={sw.label} title={sw.label}
              className={mergeClasses(styles.miniSwatch, active && styles.miniSwatchActive)}
              style={{ backgroundColor: sw.hex }}
              onClick={() => onChange(sw.hex)}
            />
          );
        })}
      </div>
      {allowClear && value && (
        <Button
          size="small" appearance="subtle" icon={<Dismiss16Regular />}
          aria-label={`Clear ${label}`} onClick={() => onChange(undefined)}
        />
      )}
    </div>
  );
}

// ── ThemesPane ───────────────────────────────────────────────────────────────

export interface ThemesPaneProps {
  /** Current report theme, or null for the Loom default (no theme applied). */
  theme: ReportTheme | null;
  /** Emit the next theme (or null to reset to default). Host persists on state.content.theme. */
  onChange: (theme: ReportTheme | null) => void;
}

/**
 * The Themes right-rail tab. Controlled + structured — every control writes a
 * field of {@link ReportTheme} (or imports/exports a Power BI theme JSON). The
 * host wires `onChange` to its model + the /definition round-trip.
 */
export function ThemesPane({ theme, onChange }: ThemesPaneProps): ReactElement {
  const styles = useStyles();
  const baseId = useId();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importedName, setImportedName] = useState<string | null>(null);

  // Mutate the current theme (scaffolding one if the author is on None).
  const update = (patch: Partial<ReportTheme>) => {
    const base = theme ?? scaffoldTheme();
    onChange({ ...base, ...patch });
  };

  // ── palette slot operations (operate on the live theme.dataColors) ──────────
  const colors = theme?.dataColors ?? [];
  const setColorAt = (i: number, hex: string) => {
    const next = colors.slice(); next[i] = hex; update({ dataColors: next });
  };
  const moveColor = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= colors.length) return;
    const next = colors.slice();
    [next[i], next[j]] = [next[j], next[i]];
    update({ dataColors: next });
  };
  const removeColorAt = (i: number) => {
    if (colors.length <= 1) return;
    update({ dataColors: colors.filter((_, k) => k !== i) });
  };
  const addColor = () => {
    const next = colors.length
      ? [...colors, LOOM_PALETTE_HEX[colors.length % LOOM_PALETTE_HEX.length].hex]
      : BUILDER_HEX_PALETTE.slice(0, 6);
    update({ dataColors: next });
  };
  const resetPalette = () => update({ dataColors: BUILDER_HEX_PALETTE.slice() });

  // ── import / export ─────────────────────────────────────────────────────────
  const onPickFile = (file: File | null) => {
    setImportError(null);
    setImportedName(null);
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => setImportError('Could not read that file.');
    reader.onload = () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(reader.result ?? ''));
      } catch {
        setImportError('That file is not valid JSON. Export a theme from Power BI or Loom and try again.');
        return;
      }
      // ./themes pbiJsonToTheme returns null for a non-object or a file with no
      // usable "name" (the one required field in a PBI theme JSON); otherwise it
      // substitutes the Loom palette for missing colors so the result always
      // applies.
      const next = pbiJsonToTheme(parsed);
      if (next) {
        onChange(next);
        setImportedName(next.name);
      } else {
        setImportError('No recognizable theme found. A theme file needs a "name" and color properties (dataColors / background / foreground / tableAccent / textClasses).');
      }
    };
    reader.readAsText(file);
    // allow re-importing the same file name
    if (fileRef.current) fileRef.current.value = '';
  };
  const exportTheme = () => {
    if (!theme) return;
    // ./themes themeToPbiJson yields a Power-BI-compatible object; serialize it
    // to the real .json file (downloadBlob takes a string body).
    downloadBlob(`${slug(theme.name)}.json`, 'application/json', JSON.stringify(themeToPbiJson(theme), null, 2));
  };

  const fontValue = theme?.fontFamily ?? '';

  return (
    <div className={styles.pane}>
      <SectionHead icon={<PaintBrush20Regular />} label="Themes" styles={styles} />
      <Caption1 className={styles.intro}>
        A theme restyles every visual at once — data palette, font, background, accent, and text
        color. Power BI theme files import and export 1:1.
      </Caption1>

      {/* ── 1 · THEMES PICKER ─────────────────────────────────────────────── */}
      <div className={styles.section}>
        <SectionHead icon={<Color20Regular />} label="Built-in themes" styles={styles} />
        <TileGrid minTileWidth={200}>
          {/* None — reset to Loom default */}
          <button
            type="button"
            aria-pressed={!theme}
            className={mergeClasses(styles.card, !theme && styles.cardActive)}
            onClick={() => { onChange(null); setImportedName(null); }}
          >
            <div className={styles.cardHead}>
              <Text className={styles.cardName}>None</Text>
              {!theme && <Badge appearance="filled" color="brand" size="small">Active</Badge>}
            </div>
            <div className={styles.swatchStrip} aria-hidden>
              {LOOM_DATA_PALETTE.slice(0, 8).map((sw) => (
                <span key={sw.token} className={styles.swatchDot} style={{ backgroundColor: sw.token }} />
              ))}
            </div>
            <Caption1 className={styles.cardFont}>Loom default palette &amp; font</Caption1>
          </button>

          {BUILTIN_LOOM_THEMES.map((bt) => {
            const active = (!!bt.id && theme?.id === bt.id) || theme?.name === bt.name;
            return (
              <button
                key={bt.id ?? bt.name}
                type="button"
                aria-pressed={active}
                className={mergeClasses(styles.card, active && styles.cardActive)}
                style={{ backgroundColor: bt.background ?? tokens.colorNeutralBackground1 }}
                onClick={() => { onChange({ ...bt, dataColors: [...bt.dataColors] }); setImportedName(null); }}
              >
                <div className={styles.cardHead}>
                  <Text className={styles.cardName} style={{ color: bt.foreground }}>{bt.name}</Text>
                  {active && <Badge appearance="filled" color="brand" size="small">Active</Badge>}
                </div>
                <div className={styles.swatchStrip} aria-hidden>
                  {bt.dataColors.slice(0, 8).map((c, idx) => (
                    <span key={idx} className={styles.swatchDot} style={{ backgroundColor: c }} />
                  ))}
                </div>
                <Caption1 className={styles.cardFont} style={{ color: bt.foreground }}>
                  {fontLabel(bt.fontFamily)}
                </Caption1>
              </button>
            );
          })}
        </TileGrid>
      </div>

      <Divider />

      {/* ── 2 · CUSTOM THEME BUILDER ──────────────────────────────────────── */}
      <div className={styles.section}>
        <SectionHead icon={<PaintBrush20Regular />} label="Custom theme" styles={styles} />

        {!theme ? (
          <EmptyState
            icon={<PaintBrush20Regular />}
            title="No custom theme yet"
            body="Start from the Loom default and tune the data palette, font, and structural colors — every visual repaints live."
            primaryAction={{ label: 'Start a custom theme', onClick: () => onChange(scaffoldTheme()) }}
          />
        ) : (
          <>
            {/* name */}
            <div className={styles.fieldRow}>
              <Caption1 className={styles.fieldLabel}>Name</Caption1>
              <Input
                size="small"
                id={`${baseId}-name`}
                aria-label="Theme name"
                value={theme.name}
                onChange={(_e, d) => update({ name: d.value })}
                style={{ flex: 1, minWidth: 0 }}
              />
            </div>

            {/* data palette */}
            <Caption1 className={styles.muted}>Data colors — reorder, recolor, add or remove slots.</Caption1>
            {colors.map((c, i) => {
              // Mirror the value the color input echoes (a token-based built-in
              // resolves to its fallback hex) so the row never shows a raw
              // `var(--…)` string next to a swatch that can't render it.
              const shownHex = toColorInput(c, '#0f6cbd');
              return (
                <div key={i} className={styles.slotRow}>
                  <Caption1 className={styles.slotIndex}>{i + 1}</Caption1>
                  <input
                    type="color"
                    aria-label={`Data color ${i + 1}`}
                    className={styles.colorChip}
                    value={shownHex}
                    onChange={(e) => setColorAt(i, e.target.value)}
                  />
                  <Caption1 className={styles.hexText}>{shownHex}</Caption1>
                  <Button
                    size="small" appearance="subtle" icon={<ArrowUp20Regular />}
                    aria-label={`Move data color ${i + 1} up`} disabled={i === 0}
                    onClick={() => moveColor(i, -1)}
                  />
                  <Button
                    size="small" appearance="subtle" icon={<ArrowDown20Regular />}
                    aria-label={`Move data color ${i + 1} down`} disabled={i === colors.length - 1}
                    onClick={() => moveColor(i, 1)}
                  />
                  <Button
                    size="small" appearance="subtle" icon={<Delete20Regular />}
                    aria-label={`Remove data color ${i + 1}`} disabled={colors.length <= 1}
                    onClick={() => removeColorAt(i)}
                  />
                </div>
              );
            })}
            <div className={styles.rowButtons}>
              <Button size="small" appearance="secondary" icon={<Add20Regular />} onClick={addColor}>
                Add color
              </Button>
              <Button size="small" appearance="subtle" onClick={resetPalette}>
                Reset to Loom palette
              </Button>
            </div>

            <Divider />

            {/* font */}
            <div className={styles.fieldRow}>
              <Caption1 className={styles.fieldLabel}>
                <TextFont20Regular style={{ verticalAlign: 'middle', marginRight: 4 }} />
                Font
              </Caption1>
              <Dropdown
                size="small"
                aria-label="Theme font family"
                value={THEME_FONTS.find((f) => f.id === fontValue)?.label ?? 'Loom default (Segoe UI)'}
                selectedOptions={[fontValue]}
                onOptionSelect={(_e, d) => update({ fontFamily: d.optionValue ? d.optionValue : undefined })}
                style={{ flex: 1, minWidth: 0 }}
              >
                {THEME_FONTS.map((f) => (
                  <Option key={f.id || 'default'} value={f.id} text={f.label}>{f.label}</Option>
                ))}
              </Dropdown>
            </div>

            {/* structural colors */}
            <ColorField
              label="Background" value={theme.background} fallback="#ffffff"
              allowClear onChange={(c) => update({ background: c })} styles={styles}
            />
            <ColorField
              label="Accent" value={theme.tableAccent} fallback="#0f6cbd"
              allowClear onChange={(c) => update({ tableAccent: c })} styles={styles}
            />
            <ColorField
              label="Text color" value={theme.foreground} fallback="#242424"
              allowClear onChange={(c) => update({ foreground: c })} styles={styles}
            />
          </>
        )}
      </div>

      <Divider />

      {/* ── 3 · IMPORT / EXPORT ───────────────────────────────────────────── */}
      <div className={styles.section}>
        <SectionHead icon={<ArrowDownload20Regular />} label="Import / export" styles={styles} />
        <Caption1 className={styles.muted}>
          Theme files are interchangeable with Power BI — no Fabric or Power BI workspace required.
        </Caption1>
        <div className={styles.ioRow}>
          <Button
            size="small" appearance="secondary" icon={<ArrowUpload20Regular />}
            onClick={() => fileRef.current?.click()}
          >
            Import theme JSON
          </Button>
          {theme ? (
            <Button
              size="small" appearance="secondary" icon={<ArrowDownload20Regular />}
              onClick={exportTheme}
            >
              Export theme JSON
            </Button>
          ) : (
            <Tooltip content="Pick or build a theme first" relationship="label">
              <span>
                <Button size="small" appearance="secondary" icon={<ArrowDownload20Regular />} disabled>
                  Export theme JSON
                </Button>
              </span>
            </Tooltip>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className={styles.hiddenFile}
            aria-hidden
            onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
          />
        </div>
        {importError && (
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>Could not import theme</MessageBarTitle>
              {importError}
            </MessageBarBody>
          </MessageBar>
        )}
        {importedName && !importError && (
          <MessageBar intent="success">
            <MessageBarBody>
              <MessageBarTitle>Theme imported</MessageBarTitle>
              Applied “{importedName}” to every visual. Save the report to persist it.
            </MessageBarBody>
          </MessageBar>
        )}
      </div>
    </div>
  );
}

export default ThemesPane;
