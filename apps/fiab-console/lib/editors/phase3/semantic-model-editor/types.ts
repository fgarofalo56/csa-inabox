// types.ts — shared model/type declarations for the semantic-model editor.
// Extracted byte-for-byte from ../semantic-model-editor.tsx (pure move).
// No JSX; no 'use client' needed.

export interface DatasetLite {
  id: string; name: string; configuredBy?: string; isRefreshable?: boolean; targetStorageMode?: string; createdDate?: string;
  isEffectiveIdentityRolesRequired?: boolean;
}
export interface TableLite {
  name: string;
  columns?: Array<{ name: string; dataType?: string }>;
  measures?: Array<{ name: string; expression?: string }>;
}
// Full tabular-model column/table shapes returned by the XMLA-backed
// GET /api/items/semantic-model/[id]/model (Azure Analysis Services / Power BI
// Premium XMLA). These carry the editable column metadata (data category,
// format string, summarize-by, display folder, sort-by, hidden, calc DAX).
export interface SmColumn {
  name: string;
  type?: 'data' | 'calculated' | 'calculatedTableColumn' | 'rowNumber';
  dataType?: string;
  dataCategory?: string;
  isHidden?: boolean;
  summarizeBy?: string;
  formatString?: string;
  displayFolder?: string;
  sortByColumn?: string;
  expression?: string;
}
export interface SmTable {
  name: string;
  isCalculatedTable?: boolean;
  calculatedExpression?: string;
  columns: SmColumn[];
  measures: Array<{ name: string; expression?: string }>;
}
export interface RefreshLite {
  requestId?: string; refreshType?: string; startTime?: string; endTime?: string; status?: string; serviceExceptionJson?: string;
}

// ── Copilot model-structure pane types ──────────────────────────────────────
export type StructureOp =
  | { kind: 'rename-measure'; from: string; to: string }
  | { kind: 'set-measure-description'; measure: string; description: string }
  | { kind: 'suggest-relationship'; fromTable: string; fromColumn: string; toTable: string; toColumn: string; cardinality: string; rationale?: string };
export interface CopilotEditPlan { summary: string; ops: StructureOp[] }
export interface CopilotCheckpoint {
  id: string; createdAt: string; label: string;
  source: 'copilot' | 'manual' | 'pre-restore';
  stats: { measures: number; relationships: number };
}

// ── Prep-for-AI types ───────────────────────────────────────────────────────
export interface PfaColumnFlag { column: string; exposed: boolean }
export interface PfaTableFlag { table: string; exposed: boolean; columns: PfaColumnFlag[] }
export interface PfaAnswer {
  id: string; question: string; dax: string;
  lastVerifiedAt?: string; lastVerifiedOk?: boolean; lastVerifiedNote?: string;
  createdAt?: string; updatedAt?: string;
}
export interface PfaState { aiInstructions: string; schema: PfaTableFlag[]; verifiedAnswers: PfaAnswer[] }
