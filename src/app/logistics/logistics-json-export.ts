/**
 * Worker-safe JSON export: array of row objects with nested keys from dotted bindings (e.g. `orgRt.monday`).
 */

import type { ExportCsvColumnSpec } from './logistics.types';
import { flatNumericColumnKey } from './logistics-column-bindings';

type NumericCols = {
  [key: string]: Float32Array | Uint32Array | Uint16Array | Uint8Array;
};
type DictCols = { [key: string]: Uint8Array | Uint16Array };
type DictMaps = { [key: string]: (string | number)[] };
type StringCols = { [key: string]: string[] };

/**
 * Sets a value on `target` following a dotted path (`orgRt.monday` → nested object).
 */
function setDeep(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.').filter((p) => p.length > 0);
  if (parts.length === 0) return;
  let cur: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = cur[key];
    if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) {
      const child: Record<string, unknown> = {};
      cur[key] = child;
      cur = child;
    } else {
      cur = next as Record<string, unknown>;
    }
  }
  cur[parts[parts.length - 1]!] = value;
}

/**
 * Cell value suitable for JSON (numbers stay numeric; text as string; missing → null).
 */
export function getCellJsonValue(
  physical: number,
  binding: string,
  numericColumns: NumericCols,
  dictColumns: DictCols,
  dictMaps: DictMaps,
  stringColumns: StringCols
): string | number | boolean | null {
  if (physical < 0) return null;

  const num = numericColumns[flatNumericColumnKey(binding)];
  if (num !== undefined) {
    if (physical >= num.length) return null;
    const v = num[physical];
    const n = Number(v);
    if (Number.isNaN(n)) return null;
    return n;
  }

  const dict = dictColumns[binding];
  if (dict !== undefined) {
    if (physical >= dict.length) return null;
    const map = dictMaps[binding];
    if (!map) return null;
    const code = dict[physical];
    const entry = map[code];
    if (entry === null || entry === undefined) return null;
    return typeof entry === 'number' ? entry : String(entry);
  }

  const str = stringColumns[binding];
  if (str !== undefined) {
    if (physical >= str.length) return null;
    const cell = str[physical];
    if (cell === null || cell === undefined) return null;
    return String(cell);
  }

  return null;
}

/**
 * Builds a JSON array string of visible rows (current `rowOrder`). Compact (no pretty-print).
 */
export function buildJsonFromColumnarData(
  rowOrder: Uint32Array,
  columns: readonly ExportCsvColumnSpec[],
  numericColumns: NumericCols,
  dictColumns: DictCols,
  dictMaps: DictMaps,
  stringColumns: StringCols
): string {
  if (columns.length === 0) return '[]';

  const rows: Record<string, unknown>[] = [];
  const rowCount = rowOrder.length;

  for (let r = 0; r < rowCount; r++) {
    const physical = rowOrder[r]!;
    const row: Record<string, unknown> = {};
    for (let c = 0; c < columns.length; c++) {
      const binding = columns[c]!.binding;
      const value = getCellJsonValue(
        physical,
        binding,
        numericColumns,
        dictColumns,
        dictMaps,
        stringColumns
      );
      setDeep(row, binding, value);
    }
    rows.push(row);
  }

  return JSON.stringify(rows);
}
