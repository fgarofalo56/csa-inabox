/**
 * Data Wrangler operation gallery (UI metadata) — the closed set of cleaning
 * operations the DataWranglerPanel renders. Mirrors the loom-wrangler-host
 * OPERATION_CATALOG (apps/fiab-wrangler-host/app/main.py) one-for-one: the panel
 * collects the fields declared here, the host executes the op with real pandas
 * and generates the pandas/PySpark code. This is UI metadata (the operation menu
 * + its parameter fields), NOT data — every transform runs on the real backend.
 *
 * Per loom_no_freeform_config, every field is a dropdown / typed input — there
 * is NO freeform code operation (Fabric's "custom code" op is deliberately not
 * reproduced). Grounded in Microsoft Fabric's Data Wrangler operation panel:
 *   https://learn.microsoft.com/fabric/data-science/data-wrangler
 */

export type WranglerFieldType = 'column' | 'columns' | 'text' | 'select' | 'bool';

export interface WranglerField {
  name: string;
  label: string;
  type: WranglerFieldType;
  options?: string[];
}

export interface WranglerOp {
  op: string;
  label: string;
  category: string;
  fields: WranglerField[];
}

export const WRANGLER_OPERATIONS: WranglerOp[] = [
  { op: 'drop_columns', label: 'Drop columns', category: 'Schema',
    fields: [{ name: 'columns', label: 'Columns', type: 'columns' }] },
  { op: 'select_columns', label: 'Keep columns', category: 'Schema',
    fields: [{ name: 'columns', label: 'Columns to keep', type: 'columns' }] },
  { op: 'rename_column', label: 'Rename column', category: 'Schema',
    fields: [{ name: 'column', label: 'Column', type: 'column' }, { name: 'newName', label: 'New name', type: 'text' }] },
  { op: 'cast_type', label: 'Change type', category: 'Schema',
    fields: [{ name: 'column', label: 'Column', type: 'column' },
      { name: 'dtype', label: 'New type', type: 'select', options: ['int', 'float', 'str', 'bool', 'datetime'] }] },
  { op: 'filter_rows', label: 'Filter rows', category: 'Rows',
    fields: [{ name: 'column', label: 'Column', type: 'column' },
      { name: 'operator', label: 'Condition', type: 'select', options: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'contains', 'startswith', 'notnull', 'isnull'] },
      { name: 'value', label: 'Value', type: 'text' }] },
  { op: 'sort', label: 'Sort', category: 'Rows',
    fields: [{ name: 'column', label: 'Column', type: 'column' }, { name: 'ascending', label: 'Ascending', type: 'bool' }] },
  { op: 'drop_duplicates', label: 'Drop duplicate rows', category: 'Rows',
    fields: [{ name: 'columns', label: 'Subset (optional)', type: 'columns' }] },
  { op: 'drop_missing', label: 'Drop rows with missing values', category: 'Missing',
    fields: [{ name: 'columns', label: 'Columns (optional)', type: 'columns' },
      { name: 'how', label: 'Drop when', type: 'select', options: ['any', 'all'] }] },
  { op: 'fill_missing', label: 'Fill missing values', category: 'Missing',
    fields: [{ name: 'column', label: 'Column', type: 'column' },
      { name: 'strategy', label: 'Strategy', type: 'select', options: ['value', 'mean', 'median', 'mode', 'ffill', 'bfill'] },
      { name: 'value', label: "Value (for 'value')", type: 'text' }] },
  { op: 'one_hot_encode', label: 'One-hot encode', category: 'Formulas',
    fields: [{ name: 'columns', label: 'Columns', type: 'columns' }] },
  { op: 'split_column', label: 'Split column by delimiter', category: 'Formulas',
    fields: [{ name: 'column', label: 'Column', type: 'column' }, { name: 'delimiter', label: 'Delimiter', type: 'text' }] },
  { op: 'replace_text', label: 'Find and replace', category: 'Text',
    fields: [{ name: 'column', label: 'Column', type: 'column' }, { name: 'find', label: 'Find', type: 'text' }, { name: 'replace', label: 'Replace with', type: 'text' }] },
  { op: 'change_case', label: 'Change text case', category: 'Text',
    fields: [{ name: 'column', label: 'Column', type: 'column' },
      { name: 'mode', label: 'Case', type: 'select', options: ['lower', 'upper', 'title'] }] },
  { op: 'strip_whitespace', label: 'Trim whitespace', category: 'Text',
    fields: [{ name: 'column', label: 'Column', type: 'column' }] },
  { op: 'scale_minmax', label: 'Min-max scale', category: 'Numeric',
    fields: [{ name: 'column', label: 'Column', type: 'column' }, { name: 'min', label: 'New min', type: 'text' }, { name: 'max', label: 'New max', type: 'text' }] },
  { op: 'group_by', label: 'Group by and aggregate', category: 'Aggregate',
    fields: [{ name: 'by', label: 'Group by', type: 'columns' }, { name: 'column', label: 'Aggregate column', type: 'column' },
      { name: 'func', label: 'Aggregation', type: 'select', options: ['sum', 'mean', 'min', 'max', 'count', 'median'] }] },
];

/**
 * Labelled starter sample (the classic Titanic subset Fabric's own Data Wrangler
 * tutorial uses). Clearly a SAMPLE the user replaces with their own CSV — it is
 * the wrangler's INPUT sample (Fabric converts a DataFrame to a pandas sample the
 * same way), not fabricated result data.
 */
export const SAMPLE_CSV = `PassengerId,Name,Sex,Age,Fare,Embarked,Survived
1,Braund Owen, male,22,7.25,S,0
2,Cumings John,female,38,71.28,C,1
3,Heikkinen Laina,female,26,7.92,S,1
4,Futrelle Jacques,female,,53.10,S,1
5,Allen William, male,35,8.05,S,0
6,Moran James, male,,8.46,Q,0
7,McCarthy Timothy, male,54,51.86,S,0
8,Palsson Gosta, male,2,21.07,S,0
9,Johnson Oscar,female,27,11.13,S,1
10,Nasser Nicholas,female,14,30.07,C,1`;
