/**
 * CSV generation helpers for the logistics worker (no DOM). Escapes per RFC-style CSV rules.
 */

import type { ExportCsvColumnSpec } from './logistics.types';
import { flatNumericColumnKey } from './logistics-column-bindings';

type NumericCols = {
  [key: string]: Float32Array | Uint32Array | Uint16Array | Uint8Array;
};
type DictCols = { [key: string]: Uint8Array | Uint16Array };
type DictMaps = { [key: string]: (string | number)[] };
type StringCols = { [key: string]: string[] };

const NEEDS_QUOTE = /[",\r\n]/;

/**
 * Normalizes newlines inside a cell to spaces for single-line CSV rows.
 */
function flattenNewlines(value: string): string {
  return value.replace(/\r\n|\r|\n/g, ' ');
}

/**
 * Escapes a cell for CSV: quotes if needed, doubles internal quotes.
 */
export function escapeCsvCell(raw: string): string {
  const flat = flattenNewlines(raw);
  if (flat.indexOf('"') !== -1) {
    return `"${flat.replace(/"/g, '""')}"`;
  }
  if (NEEDS_QUOTE.test(flat)) {
    return `"${flat}"`;
  }
  return flat;
}

/**
 * Reads display string for one physical row and binding from columnar stores.
 */
export function getCellCsvString(
  physical: number,
  binding: string,
  numericColumns: NumericCols,
  dictColumns: DictCols,
  dictMaps: DictMaps,
  stringColumns: StringCols
): string {
  if (physical < 0) return '';

  const num = numericColumns[flatNumericColumnKey(binding)];
  if (num !== undefined) {
    if (physical >= num.length) return '';
    const v = num[physical];
    if (typeof v === 'number' && Number.isNaN(v)) return '';
    return String(v);
  }

  const dict = dictColumns[binding];
  if (dict !== undefined) {
    if (physical >= dict.length) return '';
    const map = dictMaps[binding];
    if (!map) return '';
    const code = dict[physical];
    const entry = map[code];
    if (entry === null || entry === undefined) return '';
    return String(entry);
  }

  const str = stringColumns[binding];
  if (str !== undefined) {
    if (physical >= str.length) return '';
    const cell = str[physical];
    if (cell === null || cell === undefined) return '';
    return String(cell);
  }

  return '';
}

/**
 * Builds full CSV text for the current view order. Uses batched line joins to limit peak work per slice.
 *
 * @param rowOrder - View permutation (physical index per visible row)
 * @param columns - Bindings and headers in grid order
 * @param rowBatchSize - Lines accumulated before pushing a segment (default 2500)
 */
export function buildCsvFromColumnarData(
  rowOrder: Uint32Array,
  columns: readonly ExportCsvColumnSpec[],
  numericColumns: NumericCols,
  dictColumns: DictCols,
  dictMaps: DictMaps,
  stringColumns: StringCols,
  rowBatchSize = 2500
): string {
  if (columns.length === 0) return '';

  const headerLine = columns
    .map((c) => escapeCsvCell(c.header || c.binding))
    .join(',');
  const segments: string[] = [headerLine];
  const bindings = columns.map((c) => c.binding);

  let batch: string[] = [];
  const rowCount = rowOrder.length;

  for (let r = 0; r < rowCount; r++) {
    const physical = rowOrder[r]!;
    const cells = new Array<string>(bindings.length);
    for (let c = 0; c < bindings.length; c++) {
      const raw = getCellCsvString(
        physical,
        bindings[c]!,
        numericColumns,
        dictColumns,
        dictMaps,
        stringColumns
      );
      cells[c] = escapeCsvCell(raw);
    }
    batch.push(cells.join(','));
    if (batch.length >= rowBatchSize) {
      segments.push(batch.join('\n'));
      batch = [];
    }
  }
  if (batch.length > 0) {
    segments.push(batch.join('\n'));
  }

  return segments.join('\n');
}
