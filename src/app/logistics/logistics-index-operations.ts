/**
 * Sort, global search, and column-filter predicates on columnar data + `Uint32Array` row indices.
 * Used by `logistics.worker.ts` and main-thread fallback sort in `LogisticsDataService`.
 */

import type {
  SortDescriptor,
  SortDirection,
  SerializedColumnFilter,
  ColumnFilterOperator,
  SearchableChunk,
  LogisticsDataChunk,
} from './logistics.types';
import { flatNumericColumnKey } from './logistics-column-bindings';

export type ChunkColumnar = SearchableChunk;

export type ColumnValueKind = 'number' | 'string' | 'boolean' | 'date';

export function localeCompareAlphanumeric(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function compareNumericLike(a: number, b: number): number {
  const na = Number.isNaN(a);
  const nb = Number.isNaN(b);
  if (na && nb) return 0;
  if (na) return -1;
  if (nb) return 1;
  return a - b;
}

function compareDictResolved(
  a: string | number | null | undefined,
  b: string | number | null | undefined
): number {
  if (a == null && b == null) return 0;
  if (a == null || a === '') return -1;
  if (b == null || b === '') return 1;
  if (typeof a === 'number' && typeof b === 'number') {
    return compareNumericLike(a, b);
  }
  return localeCompareAlphanumeric(String(a), String(b));
}

export function logSortMemory(label: string): void {
  const mem = (performance as { memory?: { usedJSHeapSize: number } }).memory;
  if (mem) {
    console.log(
      `[Sort:Mem] ${label}: ${Math.round(mem.usedJSHeapSize / 1024 / 1024)}MB used (JS heap)`
    );
  } else {
    console.log(`[Sort:Mem] ${label}: performance.memory not available`);
  }
}

const CHUNK_TYPED_LOG = '[Chunk:TypedArray]';

function formatDataBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

/**
 * Logs byte sizes of columnar TypedArrays + `rowOrder` held in main memory (ArrayBuffer-backed).
 * Per-column lines use each view’s `.byteLength`. Totals include sum of views and deduped backing buffers.
 */
export function logChunkTypedArrayMemory(chunk: LogisticsDataChunk, label: string): void {
  const lines: string[] = [];
  let sumViewBytes = 0;
  const seenBuffers = new Set<object>();
  let uniqueBackingBytes = 0;

  const account = (path: string, arr: ArrayBufferView | null | undefined) => {
    if (!arr) return;
    const viewBytes = arr.byteLength;
    sumViewBytes += viewBytes;
    const buf = arr.buffer;
    if (!seenBuffers.has(buf)) {
      seenBuffers.add(buf);
      uniqueBackingBytes += buf.byteLength;
    }
    const el = (arr as ArrayBufferView & { length: number }).length;
    lines.push(
      `  ${path}: ${arr.constructor.name} ${formatDataBytes(viewBytes)} (elements=${el})`,
    );
  };

  for (const key of Object.keys(chunk.numericColumns).sort()) {
    account(`numericColumns.${key}`, chunk.numericColumns[key]);
  }
  for (const key of Object.keys(chunk.dictColumns).sort()) {
    account(`dictColumns.${key}`, chunk.dictColumns[key]);
  }
  account('rowOrder', chunk.rowOrder);

  console.log(
    `${CHUNK_TYPED_LOG} ${label}\n${lines.join('\n')}\n` +
      `  --- sum of TypedArray byteLengths: ${formatDataBytes(sumViewBytes)}\n` +
      `  --- unique ArrayBuffer bytes (backing stores, deduped): ${formatDataBytes(uniqueBackingBytes)}\n` +
      `  totalRows: ${chunk.totalRows}`,
  );
}

export function inferKind(
  chunk: ChunkColumnar,
  property: string,
  overrides?: Readonly<Record<string, ColumnValueKind>>
): ColumnValueKind {
  if (overrides?.[property]) return overrides[property]!;
  const flatNum = flatNumericColumnKey(property);
  if (chunk.numericColumns[flatNum] !== undefined) {
    if (property === 'creationDtm') return 'date';
    return 'number';
  }
  if (chunk.dictColumns[property] !== undefined) return 'string';
  if (chunk.stringColumns[property] !== undefined) return 'string';
  return 'number';
}

export function getSortValue(
  chunk: ChunkColumnar,
  originalRowIndex: number,
  property: string,
  kind: ColumnValueKind
): number | string | boolean | null {
  const n = chunk.numericColumns[flatNumericColumnKey(property)];
  if (n !== undefined) {
    const v = n[originalRowIndex];
    if (kind === 'date') return Number(v);
    if (kind === 'boolean') return v !== 0;
    return Number(v);
  }
  const d = chunk.dictColumns[property];
  if (d !== undefined) {
    const map = chunk.dictMaps[property];
    if (!map) return null;
    const code = d[originalRowIndex];
    return map[code] ?? null;
  }
  const s = chunk.stringColumns[property];
  if (s !== undefined) {
    return s[originalRowIndex] ?? '';
  }
  return null;
}

function comparePair(
  kind: ColumnValueKind,
  va: number | string | boolean | null,
  vb: number | string | boolean | null
): number {
  if (va === null && vb === null) return 0;
  if (va === null || va === undefined) return -1;
  if (vb === null || vb === undefined) return 1;

  if (kind === 'string') {
    return localeCompareAlphanumeric(String(va), String(vb));
  }
  if (kind === 'boolean') {
    return compareNumericLike(Number(va), Number(vb));
  }
  if (kind === 'date' || kind === 'number') {
    return compareNumericLike(Number(va), Number(vb));
  }
  return 0;
}

export function comparePhysicalRowsForColumn(
  chunk: ChunkColumnar,
  originalIndexA: number,
  originalIndexB: number,
  property: string,
  columnKindOverrides?: Readonly<Record<string, ColumnValueKind>>
): number {
  if (chunk.dictColumns[property] !== undefined) {
    const va = getSortValue(chunk, originalIndexA, property, 'string');
    const vb = getSortValue(chunk, originalIndexB, property, 'string');
    return compareDictResolved(
      va as string | number | null,
      vb as string | number | null
    );
  }

  const kind = inferKind(chunk, property, columnKindOverrides);
  const va = getSortValue(chunk, originalIndexA, property, kind);
  const vb = getSortValue(chunk, originalIndexB, property, kind);
  return comparePair(kind, va, vb);
}

export function sortRowOrderBySingleColumn(
  chunk: ChunkColumnar,
  rowOrder: Uint32Array,
  column: string,
  direction: SortDirection,
  columnKindOverrides?: Readonly<Record<string, ColumnValueKind>>,
  opts?: { logPerformance?: boolean }
): Uint32Array {
  const log = opts?.logPerformance !== false;
  if (log) logSortMemory('before');

  const scratch = Array.from(rowOrder);
  const asc = direction === 'asc';
  scratch.sort((oa, ob) => {
    const c = comparePhysicalRowsForColumn(chunk, oa, ob, column, columnKindOverrides);
    return asc ? c : -c;
  });

  const out = new Uint32Array(scratch.length);
  for (let i = 0; i < scratch.length; i++) out[i] = scratch[i]!;

  if (log) logSortMemory('after');
  return out;
}

export function compareRowsBySortModel(
  chunk: ChunkColumnar,
  originalIndexA: number,
  originalIndexB: number,
  model: readonly SortDescriptor[],
  columnKindOverrides?: Readonly<Record<string, ColumnValueKind>>
): number {
  for (const spec of model) {
    const c = comparePhysicalRowsForColumn(
      chunk,
      originalIndexA,
      originalIndexB,
      spec.property,
      columnKindOverrides
    );
    if (c !== 0) return spec.direction === 'asc' ? c : -c;
  }
  return originalIndexA - originalIndexB;
}

export function sortRowOrderByModel(
  chunk: ChunkColumnar,
  rowOrder: Uint32Array,
  model: readonly SortDescriptor[],
  columnKindOverrides?: Readonly<Record<string, ColumnValueKind>>,
  opts?: { timeLabel?: string | null; logPerformance?: boolean }
): Uint32Array {
  if (model.length === 0) return new Uint32Array(rowOrder);

  const timeLabel = opts?.timeLabel !== undefined ? opts.timeLabel : 'sort:index-array';
  const log = opts?.logPerformance !== false;

  if (timeLabel) console.time(timeLabel);
  if (log) logSortMemory('before');

  const scratch = Array.from(rowOrder);
  scratch.sort((oa, ob) =>
    compareRowsBySortModel(chunk, oa, ob, model, columnKindOverrides)
  );

  const out = new Uint32Array(scratch.length);
  for (let i = 0; i < scratch.length; i++) out[i] = scratch[i]!;

  if (log) logSortMemory('after');
  if (timeLabel) console.timeEnd(timeLabel);
  return out;
}

export function filterRowIndicesByGlobalSearch(
  chunk: SearchableChunk,
  totalRows: number,
  queryRaw: string,
  candidateIndices?: Uint32Array
): Uint32Array {
  const q = queryRaw.trim().toLowerCase();
  if (!q) {
    if (candidateIndices) {
      return new Uint32Array(candidateIndices);
    }
    const identity = new Uint32Array(totalRows);
    for (let i = 0; i < totalRows; i++) identity[i] = i;
    return identity;
  }

  const out: number[] = [];
  const { numericColumns, dictColumns, dictMaps, stringColumns } = chunk;

  const scan = (row: number): void => {
    let matched = false;

    for (const key of Object.keys(numericColumns)) {
      const arr = numericColumns[key];
      if (!arr) continue;
      const v = arr[row];
      const hay = String(v).toLowerCase();
      if (hay.includes(q)) {
        matched = true;
        break;
      }
    }

    if (!matched) {
      for (const key of Object.keys(dictColumns)) {
        const idxArr = dictColumns[key];
        const dict = dictMaps[key];
        if (!idxArr || !dict) continue;
        const code = idxArr[row];
        const raw = dict[code];
        const hay =
          raw === null || raw === undefined ? '' : String(raw).toLowerCase();
        if (hay.includes(q)) {
          matched = true;
          break;
        }
      }
    }

    if (!matched) {
      for (const key of Object.keys(stringColumns)) {
        const col = stringColumns[key];
        if (!col) continue;
        const cell = col[row];
        const hay = (cell == null ? '' : String(cell)).toLowerCase();
        if (hay.includes(q)) {
          matched = true;
          break;
        }
      }
    }

    if (matched) out.push(row);
  };

  if (candidateIndices && candidateIndices.length) {
    for (let i = 0; i < candidateIndices.length; i++) {
      scan(candidateIndices[i]!);
    }
  } else if (!candidateIndices) {
    for (let row = 0; row < totalRows; row++) {
      scan(row);
    }
  }

  return Uint32Array.from(out);
}

type PreparedColumnFilter = {
  column: string;
  conditions: Array<{ operator: ColumnFilterOperator; value: string | number | null }>;
  orAcross: boolean;
  whitelist: Set<string> | null;
  isNumericCol: boolean;
  isDictCol: boolean;
};

function normalizedKey(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).toLowerCase();
}

function isBlankValue(raw: number | string | boolean | null): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === 'string' && raw.trim() === '') return true;
  if (typeof raw === 'number' && Number.isNaN(raw)) return true;
  return false;
}

function isNumericCompareOp(op: ColumnFilterOperator): boolean {
  return (
    op === 'greaterThan' ||
    op === 'lessThan' ||
    op === 'greaterOrEqual' ||
    op === 'lessOrEqual'
  );
}

function testCondition(
  kind: ColumnValueKind,
  isNumericCol: boolean,
  isDictCol: boolean,
  raw: number | string | boolean | null,
  op: ColumnFilterOperator,
  condVal: string | number | null
): boolean {
  const sVal = condVal == null ? '' : String(condVal);
  const sRaw = raw == null ? '' : String(raw);
  const nRaw = Number(raw);
  const nCond = Number(condVal);
  const usePlainNumeric = isNumericCol && !isDictCol;

  switch (op) {
    case 'isBlank':
      return isBlankValue(raw);
    case 'isNotBlank':
      return !isBlankValue(raw);
    case 'equals': {
      if (usePlainNumeric) {
        if (Number.isNaN(nCond)) return false;
        return !Number.isNaN(nRaw) && nRaw === nCond;
      }
      return sRaw.toLowerCase() === sVal.toLowerCase();
    }
    case 'notEquals': {
      if (usePlainNumeric) {
        if (Number.isNaN(nCond)) return true;
        return Number.isNaN(nRaw) || nRaw !== nCond;
      }
      return sRaw.toLowerCase() !== sVal.toLowerCase();
    }
    case 'greaterThan':
    case 'lessThan':
    case 'greaterOrEqual':
    case 'lessOrEqual': {
      if (usePlainNumeric || (isDictCol && isNumericCompareOp(op))) {
        if (Number.isNaN(nCond)) return false;
        if (Number.isNaN(nRaw)) return false;
        if (op === 'greaterThan') return nRaw > nCond;
        if (op === 'lessThan') return nRaw < nCond;
        if (op === 'greaterOrEqual') return nRaw >= nCond;
        return nRaw <= nCond;
      }
      if (kind === 'string' || isDictCol) {
        const cmp = sRaw.localeCompare(sVal, undefined, {
          numeric: true,
          sensitivity: 'base',
        });
        if (op === 'greaterThan') return cmp > 0;
        if (op === 'lessThan') return cmp < 0;
        if (op === 'greaterOrEqual') return cmp >= 0;
        return cmp <= 0;
      }
      if (Number.isNaN(nCond)) return false;
      if (Number.isNaN(nRaw)) return false;
      if (op === 'greaterThan') return nRaw > nCond;
      if (op === 'lessThan') return nRaw < nCond;
      if (op === 'greaterOrEqual') return nRaw >= nCond;
      return nRaw <= nCond;
    }
    case 'contains':
      return sRaw.toLowerCase().includes(sVal.toLowerCase());
    case 'notContains':
      return !sRaw.toLowerCase().includes(sVal.toLowerCase());
    case 'startsWith':
      return sRaw.toLowerCase().startsWith(sVal.toLowerCase());
    case 'endsWith':
      return sRaw.toLowerCase().endsWith(sVal.toLowerCase());
    default:
      return true;
  }
}

function rowPassesColumnFilter(
  chunk: SearchableChunk,
  row: number,
  pf: PreparedColumnFilter
): boolean {
  const kind = inferKind(chunk, pf.column);
  const raw = getSortValue(chunk, row, pf.column, kind);

  if (pf.whitelist) {
    if (!pf.whitelist.has(normalizedKey(raw))) return false;
  }

  if (!pf.conditions.length) {
    return true;
  }

  const results = pf.conditions.map((c) =>
    testCondition(kind, pf.isNumericCol, pf.isDictCol, raw, c.operator, c.value)
  );
  return pf.orAcross ? results.some(Boolean) : results.every(Boolean);
}

function prepareColumnFilters(
  chunk: SearchableChunk,
  filters: SerializedColumnFilter[]
): PreparedColumnFilter[] {
  return filters.map((f) => ({
    column: f.column,
    conditions: f.conditions ?? [],
    orAcross: !!f.orAcrossConditions,
    whitelist:
      f.valueWhitelist != null
        ? new Set(f.valueWhitelist.map((k) => k.toLowerCase()))
        : null,
    isNumericCol:
      chunk.numericColumns[flatNumericColumnKey(f.column)] !== undefined,
    isDictCol: chunk.dictColumns[f.column] !== undefined,
  }));
}

export function filterRowsByColumnFilters(
  chunk: SearchableChunk,
  totalRows: number,
  filters: SerializedColumnFilter[]
): Uint32Array {
  if (!filters.length) {
    const identity = new Uint32Array(totalRows);
    for (let i = 0; i < totalRows; i++) identity[i] = i;
    return identity;
  }

  const prepared = prepareColumnFilters(chunk, filters);
  const out: number[] = [];

  for (let row = 0; row < totalRows; row++) {
    let ok = true;
    for (let i = 0; i < prepared.length; i++) {
      if (!rowPassesColumnFilter(chunk, row, prepared[i]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(row);
  }

  return Uint32Array.from(out);
}
