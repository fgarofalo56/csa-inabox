'use client';

/**
 * ModelTabsExtra — the single new Model-view surface the editor mounts for the
 * Wave-3 "Modeling" tab. It is a thin COMPOSITION shell over four already-wired,
 * self-contained Azure-native modeling sections, so the only edit phase3-editors
 * needs is one new tab value + one `<ModelTabsExtra … />` render (everything
 * else lives here).
 *
 * The four sections it lays out — each owns its own list, empty state, dialog,
 * validation, and real BFF save flow:
 *   • WhatIfParameterDialog  → structured 5-field dialog that GENERATES the
 *     GENERATESERIES table + SELECTEDVALUE measure + slicer binding, persisted to
 *     `item.state.model.whatIfParameters`.
 *   • QuickMeasureDialog     → template GALLERY (YTD / YoY / running-total / …)
 *     that GENERATES DAX from field pickers, persisted to `item.state.model.measures`.
 *   • CalculatedTableDialog  → name + language toggle + the one sanctioned
 *     free-form expression box, persisted to `item.state.model.calculatedTables`.
 *   • SynonymsEditor         → per-object linguistic-schema (Q&A / Copilot) terms,
 *     persisted to `item.state.model.synonyms` via the synonyms route.
 *
 * NO-FABRIC-DEPENDENCY (`.claude/rules/no-fabric-dependency.md`): every section is
 * Azure-native by DEFAULT — it persists to the owned Cosmos item and drives the
 * Loom-native `/query` DAX path, with NO Power BI / Fabric / AAS workspace
 * required. `datasetId` is threaded through only for the opt-in tabular path and
 * is unused on the default render/save path. The full surface renders + saves
 * with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET.
 *
 * NO-VAPORWARE (`.claude/rules/no-vaporware.md`): nothing here is a stub. Every
 * control belongs to a child that POSTs/PUTs to a real route; the tab counts are
 * read from the item's real persisted model state (never a mock); switching tabs
 * keeps each section mounted so in-session work is preserved.
 *
 * loom_no_freeform_config (`.claude/rules/loom_no_freeform_config`): the only
 * free-form surfaces are the sanctioned 1:1 expression exceptions inside the
 * calculated-table / measure DAX boxes; everything else is structured pickers,
 * galleries, and tag inputs owned by the children.
 *
 * web3-ui (`.claude/rules/web3-ui.md`): Fluent v9 + Loom tokens only (no raw
 * px/hex), an elevated intro card, a sub-tab strip with per-section icons and
 * live count badges, and a bounded content surface that matches the sibling
 * Model-view dialogs and the Security tab.
 */

import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import {
  TabList, Tab, Badge, Caption1, Title3,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Table24Regular, Beaker20Regular, Sparkle20Regular, Table20Regular,
  LocalLanguage24Regular,
} from '@fluentui/react-icons';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { WhatIfParameterDialog } from './what-if-parameter-dialog';
import { QuickMeasureDialog } from './quick-measure-dialog';
import { CalculatedTableDialog } from './calculated-table-dialog';
import { SynonymsEditor } from './synonyms-editor';

// ── Shared prop shapes ────────────────────────────────────────────────────────
//
// Loose table/measure shapes that are a structural SUPERSET of what each child
// accepts (the warehouse `ModelTable`, the semantic-model `SmTable`, and the
// canvas/model-route GET shape all satisfy this), so one `tables` prop feeds all
// four sections without per-child remapping.

export interface ModelTableLike {
  name: string;
  schema?: string;
  columns?: Array<{ name: string; type?: string; dataType?: string; isPk?: boolean }>;
  measures?: Array<{ name?: string; expression?: string }>;
}

export interface ModelMeasureLike {
  name: string;
  expression?: string;
}

export interface ModelTabsExtraProps {
  /** The owned model item — its `state.model` seeds every section + the counts. */
  item: WorkspaceItem;
  /** The model item id (route path segment). */
  id: string;
  /** Optional live Power BI/Fabric dataset id (opt-in tabular path only; unused
   *  on the Azure-native default — threaded for the shared section contract). */
  datasetId?: string;
  /** Real loaded model tables — the column/table pickers populate from these. */
  tables?: ModelTableLike[];
  /** Real persisted model measures — the quick-measure base-measure picker pool. */
  measures?: ModelMeasureLike[];
  /** Item-type route segment (defaults to 'semantic-model'); fed to the synonyms
   *  section so the warehouse / lakehouse models hit their own route. */
  itemType?: string;
  /** Sub-tab to open on first render. */
  defaultSection?: ModelSection;
  /** Bubbled after any section saves, so the parent editor can refresh its model
   *  (e.g. re-pull the canvas tables to pick up a new calculated table). */
  onModelChanged?: () => void;
}

// ── Sub-tab registry ──────────────────────────────────────────────────────────

type ModelSection = 'whatif' | 'quickMeasure' | 'calcTable' | 'synonyms';

interface SectionDef {
  key: ModelSection;
  label: string;
  icon: ReactElement;
}

const SECTIONS: SectionDef[] = [
  { key: 'whatif', label: 'What-if parameters', icon: <Beaker20Regular /> },
  { key: 'quickMeasure', label: 'Quick measures', icon: <Sparkle20Regular /> },
  { key: 'calcTable', label: 'Calculated tables', icon: <Table20Regular /> },
  { key: 'synonyms', label: 'Synonyms', icon: <LocalLanguage24Regular /> },
];

// ── Count seeding (real persisted model state, never mocked) ──────────────────

interface ModelSlice {
  whatIfParameters?: unknown[];
  calculatedTables?: unknown[];
  measures?: unknown[];
  synonyms?: unknown[];
}

function modelSlice(item: WorkspaceItem): ModelSlice {
  const m = (item.state as Record<string, unknown> | undefined)?.model;
  return (m && typeof m === 'object' ? (m as ModelSlice) : {});
}

function lenOf(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },

  // Elevated intro card — gradient brand wash, matches the polished editor banners.
  intro: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundImage: `linear-gradient(135deg, ${tokens.colorBrandBackground2}, ${tokens.colorNeutralBackground2})`,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow4,
  },
  introHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  introIcon: { color: tokens.colorBrandForeground1 },
  introHint: { color: tokens.colorNeutralForeground2, maxWidth: '880px' },

  // Sub-tab strip.
  tabBar: {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap',
    gap: tokens.spacingHorizontalM,
  },
  tabLabel: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },

  // Bounded content surface that hosts the active section.
  surface: {
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow4,
    minWidth: 0,
  },
  panelHidden: { display: 'none' },
});

export function ModelTabsExtra({
  item, id, datasetId, tables, measures, itemType = 'semantic-model',
  defaultSection = 'whatif', onModelChanged,
}: ModelTabsExtraProps) {
  const s = useStyles();
  const [active, setActive] = useState<ModelSection>(defaultSection);

  // Live counts off the REAL persisted model state (+ the measures prop, which is
  // the freshest source for the quick-measure pool when the editor has loaded it).
  const counts = useMemo(() => {
    const m = modelSlice(item);
    return {
      whatif: lenOf(m.whatIfParameters),
      quickMeasure: measures?.length ?? lenOf(m.measures),
      calcTable: lenOf(m.calculatedTables),
      synonyms: lenOf(m.synonyms),
    } as Record<ModelSection, number>;
  }, [item, measures]);

  const handleSaved = () => onModelChanged?.();

  return (
    <div className={s.root}>
      <div className={s.intro}>
        <div className={s.introHead}>
          <Table24Regular className={s.introIcon} />
          <Title3>Modeling</Title3>
          <Badge appearance="tint" color="brand">Azure-native</Badge>
        </div>
        <Caption1 className={s.introHint}>
          Shape the model the way you would in Power BI&apos;s Model view — what-if parameters, quick measures,
          calculated tables, and Q&amp;A synonyms — built one-for-one and saved Azure-native to this model. Each
          object drives real query results immediately; no Power BI or Fabric workspace is required.
        </Caption1>
      </div>

      <div className={s.tabBar}>
        <TabList
          selectedValue={active}
          onTabSelect={(_, d) => setActive(d.value as ModelSection)}
          aria-label="Modeling sections"
        >
          {SECTIONS.map((sec) => {
            const n = counts[sec.key];
            return (
              <Tab key={sec.key} value={sec.key} icon={sec.icon}>
                <span className={s.tabLabel}>
                  {sec.label}
                  {n > 0 && (
                    <Badge appearance="tint" color="informative" size="small">{n}</Badge>
                  )}
                </span>
              </Tab>
            );
          })}
        </TabList>
      </div>

      {/* All four sections stay mounted so in-session work survives a tab switch;
          only the active one is shown. Each is fully wired to its real route. */}
      <div className={s.surface}>
        <div role="tabpanel" aria-label="What-if parameters" hidden={active !== 'whatif'}
          className={active === 'whatif' ? undefined : s.panelHidden}>
          <WhatIfParameterDialog item={item} id={id} datasetId={datasetId} onSaved={handleSaved} />
        </div>

        <div role="tabpanel" aria-label="Quick measures" hidden={active !== 'quickMeasure'}
          className={active === 'quickMeasure' ? undefined : s.panelHidden}>
          <QuickMeasureDialog
            item={item} id={id} datasetId={datasetId}
            tables={tables} measures={measures} onSaved={handleSaved}
          />
        </div>

        <div role="tabpanel" aria-label="Calculated tables" hidden={active !== 'calcTable'}
          className={active === 'calcTable' ? undefined : s.panelHidden}>
          <CalculatedTableDialog
            item={item} id={id} datasetId={datasetId}
            tables={tables} onSaved={handleSaved}
          />
        </div>

        <div role="tabpanel" aria-label="Synonyms" hidden={active !== 'synonyms'}
          className={active === 'synonyms' ? undefined : s.panelHidden}>
          <SynonymsEditor
            item={item} id={id} datasetId={datasetId}
            tables={tables} itemType={itemType}
          />
        </div>
      </div>
    </div>
  );
}

export default ModelTabsExtra;
