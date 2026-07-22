'use client';

// constants.tsx — value/const declarations for the semantic-model editor.
// Extracted byte-for-byte from ../semantic-model-editor.tsx (pure move).
// Has JSX (SM_KIND_ICON element map) so this file uses .tsx + 'use client'.

import type { ReactElement } from 'react';
import {
  TextQuote20Regular, NumberSymbol20Regular, Clock20Regular, CheckboxChecked20Regular,
  Globe20Regular, BracesVariable20Regular, Column20Regular, Tag20Regular, KeyMultiple20Regular,
} from '@fluentui/react-icons';
import type { EntityColumnKind } from '@/lib/components/shared/entity-diagram-sources';
import type { StructureOp } from './types';

export const SM_DATA_CATEGORIES = ['WebUrl', 'ImageUrl', 'Country', 'StateOrProvince', 'City', 'PostalCode', 'County', 'Continent', 'Address', 'Place', 'Latitude', 'Longitude', 'Barcode'];
export const SM_SUMMARIZE = ['default', 'none', 'sum', 'min', 'max', 'count', 'average', 'distinctCount'];
export const SM_DATA_TYPES = ['string', 'int64', 'double', 'dateTime', 'decimal', 'boolean'];
export const SM_FORMATS: Array<{ value: string; label: string }> = [
  { value: '', label: '— none —' },
  { value: '#,0', label: 'Integer (#,0)' },
  { value: '#,0.00', label: '2 decimals (#,0.00)' },
  { value: '0%', label: 'Percent (0%)' },
  { value: '0.00%', label: 'Percent 2dp (0.00%)' },
  { value: '$#,0.##;($#,0.##)', label: 'Currency ($)' },
  { value: 'yyyy-mm-dd', label: 'Date (yyyy-mm-dd)' },
  { value: 'yyyy-mm-dd hh:mm:ss', label: 'DateTime' },
  { value: 'General Date', label: 'General Date' },
];

// ── Fabric fields-pane visual vocabulary ─────────────────────────────────────
// A coarse column-kind → Fluent icon map (identical set to the shared
// EntityDiagram) so numeric / text / date / bool / geo / key columns are
// type-differentiated at a glance, matching the Power BI fields pane.
export const SM_KIND_ICON: Record<EntityColumnKind, ReactElement> = {
  text: <TextQuote20Regular />,
  number: <NumberSymbol20Regular />,
  datetime: <Clock20Regular />,
  bool: <CheckboxChecked20Regular />,
  geo: <Globe20Regular />,
  json: <BracesVariable20Regular />,
  binary: <Column20Regular />,
  guid: <Tag20Regular />,
  key: <KeyMultiple20Regular />,
  unknown: <Column20Regular />,
};

// "Get data" starter mashup — a self-contained inline table so the wizard runs
// end-to-end with zero external connection config; the source picker replaces
// the Source step when a connector is chosen.
export const INGEST_STARTER_M = `section Section1;

shared IngestQuery = let
    Source = #table({"id","name","value"}, {{1, "item_a", 100}, {2, "item_b", 200}}),
    Filtered = Table.SelectRows(Source, each [value] > 0)
in
    Filtered;`;

// Source picker connectors. Only the INLINE sample is a placeholder-free,
// zero-config real source (a literal #table). Every EXTERNAL source is bound
// through the shared GetDataGallery (real Loom Connection / uploaded file),
// which yields a REAL Power Query M `Source =` step via `mExprFromReportSource`
// — no `<server>` / `<account>` token to hand-edit (W3, no-vaporware.md).
export const INGEST_SOURCES: Array<{ key: string; label: string; hint: string; m: string }> = [
  { key: 'inline', label: 'Sample table (inline)', hint: 'A literal #table — runs with no connection config.',
    m: '#table({"id","name","value"}, {{1, "item_a", 100}, {2, "item_b", 200}})' },
];

export const OP_LABEL: Record<StructureOp['kind'], string> = {
  'rename-measure': 'Rename',
  'set-measure-description': 'Describe',
  'suggest-relationship': 'Relationship',
};
