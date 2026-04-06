export type SortDirection = 'asc' | 'desc';

export interface SortDescriptor {
  property: string;
  direction: SortDirection;
}

export interface SortRequestPayload {
  model: SortDescriptor[];
  /** Ignore stale worker responses when a newer sort was requested. */
  seq: number;
}

/** Single-column SORT message (worker sorts indexArray only). */
export interface SimpleSortPayload {
  column: string;
  direction: SortDirection;
  seq: number;
}

export function isSimpleSortPayload(p: unknown): p is SimpleSortPayload {
  return (
    p !== null &&
    typeof p === 'object' &&
    'column' in p &&
    typeof (p as SimpleSortPayload).column === 'string' &&
    'direction' in p &&
    ((p as SimpleSortPayload).direction === 'asc' ||
      (p as SimpleSortPayload).direction === 'desc')
  );
}

export interface SortCompletePayload {
  rowOrder: Uint32Array;
  seq: number;
}

export interface SearchPayload {
  query: string;
  seq: number;
  /** Applied after search so clearing search restores sort on filtered rows. */
  sortModel: SortDescriptor[];
}

export interface SearchCompletePayload {
  rowOrder: Uint32Array;
  seq: number;
}

export interface LogisticsDataChunk {
  /** Typed numeric columns (Float32 / Uint8 / Uint16 / Uint32; Float16 supported at runtime via `Number(arr[i])`). */
  numericColumns: {
    [key: string]: Float32Array | Uint32Array | Uint16Array | Uint8Array;
  };
  dictColumns: { [key: string]: Uint8Array | Uint16Array };
  dictMaps: { [key: string]: (string | number)[] };
  stringColumns: { [key: string]: string[] };
  rowOrder: Uint32Array;
  totalRows: number;
}

/** Flat TypedArray keys for original route days (grid still binds `orgRt.monday` / `orgRt.tuesday`). */
export const ORG_RT_MONDAY_FLAT = 'orgRt_monday' as const;
export const ORG_RT_TUESDAY_FLAT = 'orgRt_tuesday' as const;

/** Columnar slice for sort / search / column filters (no `rowOrder`). */
export type SearchableChunk = Pick<
  LogisticsDataChunk,
  'numericColumns' | 'dictColumns' | 'dictMaps' | 'stringColumns'
>;

export type ColumnFilterOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'greaterThan'
  | 'lessThan'
  | 'greaterOrEqual'
  | 'lessOrEqual'
  | 'isBlank'
  | 'isNotBlank';

/** One column’s filter (condition + optional Excel value list), serialized for the worker. */
export interface SerializedColumnFilter {
  column: string;
  conditions: Array<{ operator: ColumnFilterOperator; value: string | number | null }>;
  /** If true, condition1 OR condition2 (Wijmo OR). Otherwise AND. */
  orAcrossConditions?: boolean;
  /** Selected display keys from value filter; AND with conditions when both active. */
  valueWhitelist?: string[] | null;
}

export interface ColumnFilterPayload {
  filters: SerializedColumnFilter[];
  seq: number;
  sortModel: SortDescriptor[];
  /** Current global search text so one worker pass can apply column filters + search. */
  searchQuery?: string;
}

export interface ColumnFilterCompletePayload {
  rowOrder: Uint32Array;
  seq: number;
}

export interface CellEditPayload {
  /** Physical row index into columnar arrays (not view index). */
  physicalRowIndex: number;
  column: 'rNo' | 'sOLNo';
  value: number;
}

export interface CellEditCompletePayload {
  ok: boolean;
  error?: string;
  physicalRowIndex?: number;
  column?: 'rNo' | 'sOLNo';
  value?: number;
}

/** One visible grid column for CSV export (binding + header text). */
export interface ExportCsvColumnSpec {
  binding: string;
  header: string;
}

export interface ExportCsvPayload {
  columns: ExportCsvColumnSpec[];
  /** Matches latest export request; stale responses are ignored on main. */
  seq: number;
}

export interface ExportCsvCompletePayload {
  csvText: string;
  seq: number;
}

/** Same shape as CSV export: visible columns + sequence. */
export type ExportJsonPayload = ExportCsvPayload;

export interface ExportJsonCompletePayload {
  jsonText: string;
  seq: number;
}

export interface WorkerResponse {
  type:
    | 'DATA_LOADED'
    | 'FILTER_COMPLETE'
    | 'SORT_COMPLETE'
    | 'SEARCH_COMPLETE'
    | 'CELL_EDIT_COMPLETE'
    | 'EXPORT_CSV_COMPLETE'
    | 'EXPORT_JSON_COMPLETE'
    | 'ERROR';
  payload?:
    | LogisticsDataChunk
    | Uint32Array
    | SortCompletePayload
    | SearchCompletePayload
    | ColumnFilterCompletePayload
    | CellEditCompletePayload
    | ExportCsvCompletePayload
    | ExportJsonCompletePayload
    | any;
  error?: string;
}

export interface WorkerRequest {
  type:
    | 'LOAD_DATA'
    | 'SORT'
    | 'SEARCH'
    | 'COLUMN_FILTER'
    | 'CELL_EDIT'
    | 'EXPORT_CSV'
    | 'EXPORT_JSON';
  payload?: any;
}
