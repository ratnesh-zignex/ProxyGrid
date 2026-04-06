import { CollectionView } from '@mescius/wijmo';
import { LogisticsDataChunk } from './logistics.types';
import { coerceToUint32, isEditableNumericColumn } from './logistics-editable-columns';
import {
  buildOrgRtSnapshot,
  buildRowObjectSnapshot,
  type RowObjectSnapshot,
} from './logistics-row-object';

export class LogisticsVirtualCollectionView extends CollectionView {
  private _data: LogisticsDataChunk;
  /** Cleared whenever rowOrder changes so sorted rows get fresh proxies. */
  private _rowProxyCache = new Map<number, object>();

  private _logPerf(label: string) {
    const mem = (performance as any).memory;
    if (mem) {
      console.log(`[Perf-CV] ${label}: ${Math.round(mem.usedJSHeapSize / 1024 / 1024)}MB used`);
    } else {
      console.log(`[Perf-CV] ${label}`);
    }
  }

  constructor(data: LogisticsDataChunk, transferTime: number = 0) {
    super();
    /**
     * FlexGrid refuses header sort unless `collectionView.canSort` is true.
     * When true, `_performRefresh` would run `_src.slice()` + sort; `slice` on our
     * virtual Proxy does not invoke indexed `get`, so `_view` would be all holes.
     * We keep `canSort` true for the grid but mask it only inside `_performRefresh`.
     */
    this.canSort = true;
    /** Recommended with FlexGridFilter to avoid redundant refresh paths on virtual/proxy data. */
    this.refreshOnEdit = false;
    const startTime = performance.now();
    this._data = data;
    console.log(`[CV] Initializing with ${this._data.rowOrder.length} rows`);
    this.sourceCollection = this._createVirtualItems();
    
    const endTime = performance.now();
    this._logDetailedStats(endTime - startTime, transferTime);
  }

  private _logDetailedStats(initDuration: number, transferTime: number) {
    const totalRows = this._data.rowOrder.length;
    const numCols = Object.keys(this._data.numericColumns).length + 
                   Object.keys(this._data.dictColumns).length + 
                   Object.keys(this._data.stringColumns).length;

    console.group('%c 🚀 Performance Stats: SQLite to Wijmo ', 'background: #222; color: #bada55; font-size: 14px; font-weight: bold; padding: 4px;');
    console.log(`%c Total Rows:      %c ${totalRows.toLocaleString()}`, 'font-weight: bold', 'color: #2196F3');
    console.log(`%c Total Columns:   %c ${numCols}`, 'font-weight: bold', 'color: #2196F3');
    console.log(`%c Data Transfer:   %c ${transferTime.toFixed(2)}ms`, 'font-weight: bold', 'color: #E91E63');
    console.log(`%c Columnar Load:   %c ${initDuration.toFixed(2)}ms`, 'font-weight: bold', 'color: #4CAF50');
    console.log(`%c Row access:      %c lazy proxies (virtualized)`, 'font-weight: bold', 'color: #9C27B0');
    console.groupEnd();
  }

  /** Patch chunk fields (same reference as LogisticsDataService.data()); refresh the view. */
  updateData(newData: Partial<LogisticsDataChunk>) {
    console.time('CV:Update');
    if (newData.rowOrder) {
      this._data.rowOrder = newData.rowOrder;
      this._rowProxyCache.clear();
      console.log(`[CV] rowOrder replaced; proxy cache cleared (${this._data.rowOrder.length} rows)`);
    }
    if (newData.numericColumns) this._data.numericColumns = newData.numericColumns;
    
    this.refresh();
    console.timeEnd('CV:Update');
    this._logPerf('CV:UpdateEnd');
  }

  /**
   * Clears row-proxy cache and virtual source so the main thread can drop references
   * before replacing this view (reload / explicit release). Safe to call once.
   */
  dispose(): void {
    this._rowProxyCache.clear();
    this.sourceCollection = [];
  }

  findViewIndex(originalIndex: number): number {
    const rowOrder = this._data.rowOrder;
    for (let i = 0; i < rowOrder.length; i++) {
      if (rowOrder[i] === originalIndex) return i;
    }
    return -1;
  }

  getOriginalIndex(viewIndex: number): number {
    if (viewIndex < 0 || viewIndex >= this._data.rowOrder.length) return -1;
    return this._data.rowOrder[viewIndex]!;
  }

  /**
   * Materializes nested `orgRt` (and related flat fields) from TypedArrays for one **view** row.
   * Does not allocate row objects unless called — safe for 300k rows when used occasionally.
   * @param viewIndex - Index in the current sorted/filtered `rowOrder`
   */
  getRowObject(viewIndex: number): RowObjectSnapshot | null {
    if (viewIndex < 0 || viewIndex >= this._data.rowOrder.length) return null;
    const physical = this._data.rowOrder[viewIndex]!;
    return buildRowObjectSnapshot(physical, this._data.numericColumns);
  }

  public override _performRefresh(): void {
    const cv = this as CollectionView & { canSort: boolean };
    const prev = cv.canSort;
    cv.canSort = false;
    try {
      super._performRefresh();
    } finally {
      cv.canSort = prev;
    }
  }

  private _createVirtualItems(): any {
    console.time('CV:ProxyCreate');
    const target = new Array(this._data.totalRows);
    
    const proxy = new Proxy(target, {
      get: (target, prop: string | symbol, receiver) => {
        if (prop === 'length') {
          return this._data.rowOrder.length;
        }

        if (typeof prop === 'string' && !isNaN(Number(prop))) {
          const viewIndex = Number(prop);
          return this._createRowProxy(viewIndex);
        }
        if (typeof prop === 'number' && Number.isInteger(prop)) {
          return this._createRowProxy(prop);
        }

        return Reflect.get(target, prop, receiver);
      }
    });
    console.timeEnd('CV:ProxyCreate');
    return proxy;
  }

  private _createRowProxy(viewIndex: number): any {
    const cached = this._rowProxyCache.get(viewIndex);
    if (cached) return cached;

    const data = this._data;

    const proxy = new Proxy({}, {
      get: (target, prop: string) => {
        if (viewIndex < 0 || viewIndex >= data.rowOrder.length) return undefined;
        const actualIndex = data.rowOrder[viewIndex]!;
        if (prop === 'orgRt') {
          return this._createOrgRtView(actualIndex);
        }
        if (data.numericColumns[prop]) {
          return data.numericColumns[prop][actualIndex];
        }
        if (data.dictColumns[prop]) {
          const dictIdx = data.dictColumns[prop][actualIndex];
          return data.dictMaps[prop][dictIdx];
        }
        if (data.stringColumns[prop]) {
          return data.stringColumns[prop][actualIndex];
        }
        return undefined;
      },
      set: (_target, prop: string, value: unknown) => {
        if (!isEditableNumericColumn(prop)) return false;
        if (viewIndex < 0 || viewIndex >= data.rowOrder.length) return false;
        const coerced = coerceToUint32(value);
        if (coerced === null) return false;
        const actualIndex = data.rowOrder[viewIndex];
        const arr = data.numericColumns[prop];
        if (!arr || actualIndex < 0 || actualIndex >= arr.length) return false;
        arr[actualIndex] = coerced;
        return true;
      },
      has: (target, prop: string) => {
        if (prop === 'orgRt') return true;
        return !!(
          data.numericColumns[prop] ||
          data.dictColumns[prop] ||
          data.stringColumns[prop]
        );
      },
    });
    this._rowProxyCache.set(viewIndex, proxy);
    return proxy;
  }

  /**
   * Nested object for Wijmo `orgRt.monday` / `orgRt.tuesday`; backed by flat `orgRt_monday` / `orgRt_tuesday`.
   */
  private _createOrgRtView(actualIndex: number): RowObjectSnapshot['orgRt'] {
    return buildOrgRtSnapshot(actualIndex, this._data.numericColumns);
  }
}
