# Wijmo FlexGrid — low-level design (logistics module)

This document describes how the logistics **Wijmo FlexGrid** integrates with **columnar data**, a **Web Worker**, and a **virtual row model** so large datasets (~100k–300k rows) stay responsive. It is implementation-focused, not a product requirements document.

**High-level design:** [logistics-high-level-design.md](./logistics-high-level-design.md) (architecture, goals, flow summary).

**Location:** `src/app/logistics/wijmo-grid-flow-design.md` (co-located with the implementation).

---

## 1. Goals and constraints

| Goal | Approach |
|------|----------|
| Keep UI thread responsive | Heavy work (sort, search, column filter) runs in `logistics.worker.ts`. |
| Avoid materializing row objects | Rows are **proxies**; cell values read from **TypedArrays** / dictionaries by **physical index**. |
| Single mutable “view” state | **`rowOrder`** (`Uint32Array`) is the only permutation of rows; it is the **index array** into columnar storage. |
| Wijmo as presentation | **FlexGrid** binds to a **CollectionView**; sorting/filtering **do not** rely on Wijmo’s default row filtering over 300k items for the main path. |

---

## 2. Layered architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Angular UI (logistics-grid.component.ts)                        │
│  • FlexGrid + FlexGridFilter (UI only; CV filter bypassed)       │
│  • Header sort → requestSort()                                   │
│  • Global search input → requestSearch()                         │
│  • Filter apply → serialize filters → requestColumnFilter()      │
│  • Clear filters toolbar                                         │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  LogisticsDataService (logistics-data.service.ts)                │
│  • Owns Worker, signals: data, view, sortModel, searchHighlight  │
│  • Sequences: sortSeq, searchSeq, filterSeq (ignore stale replies)│
│  • Posts: LOAD_DATA, SORT, SEARCH, COLUMN_FILTER, CELL_EDIT, EXPORT_CSV │
│  • Applies: rowOrder swap + cv.updateData() + sortApplyRevision  │
└────────────────────────────┬────────────────────────────────────┘
                             │ postMessage / onmessage
┌────────────────────────────▼────────────────────────────────────┐
│  Web Worker (logistics.worker.ts)                               │
│  • Holds columnar copies for sort/filter (sortNumericColumns…)   │
│  • State: dataTotalRows, currentRowOrder, columnFilterBase        │
│  • Emits: DATA_LOADED, SORT_COMPLETE, SEARCH_COMPLETE,           │
│           FILTER_COMPLETE, CELL_EDIT_COMPLETE, EXPORT_CSV_COMPLETE │
└────────────────────────────┬────────────────────────────────────┘
                             │ rowOrder transferable
┌────────────────────────────▼────────────────────────────────────┐
│  LogisticsVirtualCollectionView (logistics-virtual-collection-view.ts)│
│  • Extends wijmo CollectionView                                   │
│  • sourceCollection = sparse array + Proxy (lazy row proxies)    │
│  • Row i → physical index rowOrder[i] → column bindings            │
│  • _performRefresh: temporarily canSort=false (avoid slice/sort)   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Data model (`LogisticsDataChunk`)

Physical storage is **column-oriented** (see `logistics.types.ts`):

- **`numericColumns`**: `Record<string, Float32Array | Uint8Array | Uint16Array | Uint32Array>`.
- **`dictColumns`**: `Record<string, Uint8Array | Uint16Array>` (dictionary codes per row).
- **`dictMaps`**: `Record<string, (string \| number)[]>` (code → display/raw value).
- **`stringColumns`**: `Record<string, string[]>`.
- **`rowOrder`**: `Uint32Array` — permutation; **view row `i`** uses **physical row** `rowOrder[i]`.
- **`totalRows`**: physical row count (constant after load).

Cell value resolution (conceptually):

```text
physical = rowOrder[viewRowIndex]
value = numericColumns[col][physical] | dictMaps[col][dictColumns[col][physical]] | stringColumns[col][physical]
```

Rows are **not** reordered in memory; only **`rowOrder`** changes.

---

## 4. Worker state (filtering / search composition)

| Variable | Role |
|----------|------|
| `currentRowOrder` | Latest permutation; input to SORT; updated after SORT / SEARCH / COLUMN_FILTER. |
| `columnFilterBase` | Physical indices that pass **column filters** only (`null` = no column filter). |
| `sortNumericColumns` / `sortDictColumns` | Cloned TypedArrays for worker-side sort (buffers transferred to main on load are detached in worker). |

**Global search** (`filterRowIndicesByGlobalSearch` in `logistics-index-operations.ts`) scans candidates: either **all physical rows** or **`columnFilterBase`** when column filters are active.

**Column filter** (`filterRowsByColumnFilters` in `logistics-index-operations.ts`) ANDs predicates across columns; output is a **physical index list** before sort.

---

## 5. End-to-end flows

### 5.1 Initial load

1. `LOAD_DATA` → worker generates columnar data + identity `rowOrder`.
2. `transferables`: `rowOrder` + numeric/dict buffers (zero-copy to main).
3. Main builds `LogisticsVirtualCollectionView`, sets `data` and `view` signals; grid binds `itemsSource` to `view()`.

### 5.2 Header sort (worker path)

1. User clicks header; **sortingColumn** handler **cancels** default FlexGrid sort (`e.cancel = true`).
2. `computeNextSortModel` + `syncCollectionViewSortDescriptions` (glyphs only).
3. `requestSort(model)` → `SORT` with `SimpleSortPayload` (single column) or `SortRequestPayload` (multi).
4. Worker runs `sortRowOrderBySingleColumn` / `sortRowOrderByModel` on **current `currentRowOrder`**.
5. `SORT_COMPLETE` → main replaces `chunk.rowOrder`, `cv.updateData({ rowOrder })`, increments `sortApplyRevision`.
6. Grid `invalidate()` via effect on `sortApplyRevision`.

### 5.3 Global search

1. Debounced input updates `searchHighlightQuery` (for cell highlight); `requestSearch(query)` posts `SEARCH`.
2. Worker: optional `candidateIndices = columnFilterBase`; `filterRowIndicesByGlobalSearch` → then **sort** by `sortModel` in payload.
3. `SEARCH_COMPLETE` → same rowOrder swap as sort.

### 5.4 Column filters (Wijmo FlexGridFilter)

1. `FlexGridFilter` instance **overrides** internal `_filter` with `() => true` so CollectionView does not iterate every row on the UI thread.
2. On **filterApplied**, main sets `collectionView.filter = null`, serializes active filters (`logistics-wijmo-filter-serialize.ts`), posts `COLUMN_FILTER`.
3. Worker: updates `columnFilterBase`; applies **searchQuery** from payload; applies **sortModel**; posts `FILTER_COMPLETE`.
4. Culture / defaults: `logistics-flexgrid-filter-culture.ts` (`culture.FlexGridFilter` operators, `editingFilter` default operators).

### 5.5 Clear column filters (toolbar)

1. For each column: `getColumnFilter(col, true).clear()`; `flexGridFilter.apply()`; `collectionView.filter = null`.
2. `requestColumnFilter([])` to reset worker state and refresh `rowOrder`.

---

## 6. Message contracts (abbrev.)

| Direction | Type | Payload highlights |
|-----------|------|-------------------|
| → Worker | `LOAD_DATA` | — |
| → Worker | `SORT` | `SimpleSortPayload` or `SortRequestPayload` + `seq` |
| → Worker | `SEARCH` | `query`, `seq`, `sortModel` |
| → Worker | `COLUMN_FILTER` | `filters[]`, `seq`, `sortModel`, `searchQuery` |
| → Worker | `CELL_EDIT` | `physicalRowIndex`, `column` (`rNo` \| `sOLNo`), `value` |
| → Worker | `EXPORT_CSV` | `columns[]` (binding + header), `seq` |
| ← Worker | `DATA_LOADED` | `LogisticsDataChunk` (+ transferables) |
| ← Worker | `SORT_COMPLETE` | `{ rowOrder, seq }` |
| ← Worker | `SEARCH_COMPLETE` | `{ rowOrder, seq }` |
| ← Worker | `FILTER_COMPLETE` | `{ rowOrder, seq }` |
| ← Worker | `CELL_EDIT_COMPLETE` | `{ ok, … }` |
| ← Worker | `EXPORT_CSV_COMPLETE` | `{ csvText, seq }` |

Stale responses are dropped when `seq` does not match the latest `sortSeq` / `searchSeq` / `filterSeq` (and export uses a single-flight guard on the main thread).

---

## 7. Supporting modules (file map)

| File | Responsibility |
|------|------------------|
| `logistics-index-operations.ts` | Sort, global search scan, column-filter predicates (main + worker). |
| `logistics-sort-wijmo.ts` | Map FlexGrid sort UI to `SortDescriptor[]`. |
| `logistics-csv-export.ts` | Worker-side CSV escaping and row materialization. |
| `logistics-wijmo-filter-serialize.ts` | Wijmo `ColumnFilter` → `SerializedColumnFilter[]`. |
| `logistics-flexgrid-filter-culture.ts` | Operator lists + default condition `Operator` by `DataType`. |

---

## 8. Invariants and pitfalls

1. **After `postMessage` transfer**, the worker must not read transferred buffers; use **clones** (`sortNumericColumns`) for continued worker reads.
2. **Proxy cache** (`_rowProxyCache`) must clear **when `rowOrder` changes** (done in `updateData`).
3. **FlexGridFilter.apply()** sets `collectionView.filter`; always **null** it on the main path to avoid extra CV filtering on virtual proxies.
4. **Sort** uses **worker** `currentRowOrder` as input; keep **sortModel** on main and worker in sync via payloads.

---

## 9. Revision

Canonical copy lives in this folder (`src/app/logistics/`). Update when worker contracts or CV behavior change.
