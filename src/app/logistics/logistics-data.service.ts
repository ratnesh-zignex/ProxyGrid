import { Injectable, signal, computed, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { CollectionView } from '@mescius/wijmo';
import { LogisticsVirtualCollectionView } from './logistics-virtual-collection-view';
import {
  WorkerResponse,
  WorkerRequest,
  LogisticsDataChunk,
  SortDescriptor,
  SortCompletePayload,
  SortRequestPayload,
  SimpleSortPayload,
  SearchCompletePayload,
  ColumnFilterCompletePayload,
  SerializedColumnFilter,
  CellEditPayload,
  CellEditCompletePayload,
  ExportCsvColumnSpec,
  ExportCsvCompletePayload,
  ExportJsonCompletePayload,
} from './logistics.types';
import {
  sortRowOrderByModel,
  logSortMemory,
  logChunkTypedArrayMemory,
} from './logistics-index-operations';

@Injectable({
  providedIn: 'root'
})
export class LogisticsDataService {
  private worker: Worker | undefined;
  private platformId = inject(PLATFORM_ID);
  private sortSeq = 0;
  private searchSeq = 0;
  private filterSeq = 0;
  private exportCsvSeq = 0;
  private exportJsonSeq = 0;
  /** True while worker is building CSV; disables duplicate export clicks. */
  readonly csvExportPending = signal(false);
  /** True while worker is building JSON export. */
  readonly jsonExportPending = signal(false);

  readonly view = signal<LogisticsVirtualCollectionView | null>(null);
  /**
   * Lazily created in the browser only — `CollectionView` uses `window` and breaks SSR
   * if constructed in the service constructor.
   */
  private _emptyGridView: CollectionView | null = null;

  private getEmptyGridView(): CollectionView {
    if (!this._emptyGridView) {
      this._emptyGridView = new CollectionView<any>([]);
    }
    return this._emptyGridView!;
  }

  /** Use for `[itemsSource]` — real CV when loaded, otherwise a shared empty CV (browser). */
  readonly gridItemsSource = computed((): CollectionView<any> => {
    const v = this.view();
    if (v) return v;
    if (!isPlatformBrowser(this.platformId)) {
      // Grid is under `*ngIf="isBrowser"`; prerender does not bind this.
      return undefined as unknown as CollectionView;
    }
    return this.getEmptyGridView();
  });
  readonly data = signal<LogisticsDataChunk | null>(null);
  readonly loading = signal<boolean>(true);
  readonly error = signal<string | null>(null);

  /** Mirrors FlexGrid sortDescriptions after header clicks (shift = multi-column). */
  readonly sortModel = signal<SortDescriptor[]>([]);
  /** When true, SORT is posted to the worker so the main thread stays responsive. */
  readonly useWorkerSort = signal(true);

  /** Incremented after each successful indexArray swap (grid can invalidate). */
  readonly sortApplyRevision = signal(0);

  /** Current search text for cell highlighting (synced from grid input; may lead worker search). */
  readonly searchHighlightQuery = signal('');

  readonly selectedRowIndex = signal<number | null>(null);

  constructor() {
    if (isPlatformBrowser(this.platformId)) {
      this.worker = new Worker(new URL('./logistics.worker', import.meta.url));
      this.worker.onmessage = this.handleMessage.bind(this);
    }
  }

  loadData() {
    if (!this.worker) return;
    this.releasePreviousDataset();
    this.loading.set(true);
    this.worker.postMessage({ type: 'LOAD_DATA' } as WorkerRequest);
  }

  /**
   * Drops main-thread references to the previous chunk + collection view so TypedArrays
   * and row proxies can be GC’d while the worker builds the next dataset. Does not change
   * business rules: grid binds to an empty CollectionView until data returns.
   */
  private releasePreviousDataset(): void {
    const prev = this.view();
    if (prev) {
      prev.dispose();
    }
    this.view.set(null);
    this.data.set(null);
  }

  /**
   * Global search: worker scans all columns; only `rowOrder` (indexArray) is replaced.
   */
  requestSearch(query: string) {
    if (!this.worker || !this.data()) return;
    const seq = ++this.searchSeq;
    console.time('grid-search-request');
    this.worker.postMessage({
      type: 'SEARCH',
      payload: { query, seq, sortModel: this.sortModel() },
    } as WorkerRequest);
  }

  /**
   * Column filters (Wijmo UI) — worker updates `rowOrder` only; optional `searchQuery`
   * keeps global search in sync in one round trip.
   */
  requestColumnFilter(filters: SerializedColumnFilter[]) {
    if (!this.worker || !this.data()) return;
    const seq = ++this.filterSeq;
    console.time('grid-filter-request');
    this.worker.postMessage({
      type: 'COLUMN_FILTER',
      payload: {
        filters,
        seq,
        sortModel: this.sortModel(),
        searchQuery: this.searchHighlightQuery(),
      },
    } as WorkerRequest);
  }

  /**
   * Persist a cell edit to the worker’s sort/filter column copies (main TypedArrays already updated via row proxy set).
   */
  requestCellEdit(payload: CellEditPayload) {
    if (!this.worker || !this.data()) return;
    console.time('cell-edit-request');
    this.worker.postMessage({ type: 'CELL_EDIT', payload } as WorkerRequest);
  }

  /**
   * Exports the current view (`rowOrder` in worker) to CSV. Generation runs in the worker.
   * @param columns - Bindings and headers in display order (from FlexGrid columns)
   */
  requestCsvExport(columns: ExportCsvColumnSpec[]): void {
    if (!this.worker || !this.data() || columns.length === 0) return;
    if (this.csvExportPending()) return;
    this.csvExportPending.set(true);
    const seq = ++this.exportCsvSeq;
    console.time('csv-export-request');
    this.worker.postMessage({
      type: 'EXPORT_CSV',
      payload: { columns, seq },
    } as WorkerRequest);
  }

  /**
   * Exports the current view as a JSON array of row objects (nested keys from dotted bindings).
   */
  requestJsonExport(columns: ExportCsvColumnSpec[]): void {
    if (!this.worker || !this.data() || columns.length === 0) return;
    if (this.jsonExportPending()) return;
    this.jsonExportPending.set(true);
    const seq = ++this.exportJsonSeq;
    console.time('json-export-request');
    this.worker.postMessage({
      type: 'EXPORT_JSON',
      payload: { columns, seq },
    } as WorkerRequest);
  }

  selectRow(index: number) {
    this.selectedRowIndex.set(index);
  }

  /**
   * Sort by reordering rowOrder only. TypedArrays stay fixed; CollectionView proxies read rowOrder.
   */
  requestSort(model: SortDescriptor[]) {
    const chunk = this.data();
    const cv = this.view();
    if (!chunk || !cv || model.length === 0) return;

    this.sortModel.set(model);
    const seq = ++this.sortSeq;

    if (this.useWorkerSort() && this.worker) {
      console.time('grid-sort-request');
      logSortMemory('sort:request (main)');
      const payload: SimpleSortPayload | SortRequestPayload =
        model.length === 1
          ? {
              column: model[0].property,
              direction: model[0].direction,
              seq,
            }
          : { model, seq };
      this.worker.postMessage({ type: 'SORT', payload } as WorkerRequest);
      return;
    }

    console.time('sort:main-thread-total');
    logSortMemory('sort:main:before');
    const sorted = sortRowOrderByModel(chunk, chunk.rowOrder, model);
    this.applySortedRowOrder(sorted, seq);
    logSortMemory('sort:main:after');
    console.timeEnd('sort:main-thread-total');
  }

  private applySortedRowOrder(
    sorted: Uint32Array,
    seq: number,
    opts?: { fromWorker?: boolean }
  ) {
    if (seq !== this.sortSeq) {
      console.warn('[Sort] Ignoring stale result', seq, 'current', this.sortSeq);
      return;
    }
    const chunk = this.data();
    const cv = this.view();
    if (!chunk || !cv) return;
    chunk.rowOrder = sorted;
    cv.updateData({ rowOrder: sorted });
    if (opts?.fromWorker) {
      console.timeEnd('grid-sort-request');
    }
    this.sortApplyRevision.update((n) => n + 1);
  }

  selectRowByOriginalIndex(originalIndex: number) {
    const currentView = this.view();
    if (currentView) {
      const viewIndex = currentView.findViewIndex(originalIndex);
      if (viewIndex !== -1) {
        this.selectRow(viewIndex);
      }
    }
  }

  private handleMessage({ data }: { data: WorkerResponse }) {
    const receiveTime = performance.now();
    switch (data.type) {
      case 'DATA_LOADED':
        const payload = data.payload as LogisticsDataChunk & { _workerSendTime?: number };
        const transferTime = payload._workerSendTime ? (receiveTime - payload._workerSendTime) : 0;
        
        console.log(`%c Service: Total Transfer Time (Worker -> Main Thread): ${transferTime.toFixed(2)}ms`, 'color: #E91E63; font-weight: bold;');

        logChunkTypedArrayMemory(payload, 'main thread after DATA_LOADED');

        const cv = new LogisticsVirtualCollectionView(payload, transferTime);
        this.data.set(payload);
        this.view.set(cv);
        this.sortModel.set([]);
        this.searchHighlightQuery.set('');
        this.loading.set(false);
        break;

      case 'SORT_COMPLETE': {
        const p = data.payload as SortCompletePayload;
        logSortMemory('sort:worker-complete (main)');
        this.applySortedRowOrder(p.rowOrder, p.seq, { fromWorker: true });
        break;
      }

      case 'SEARCH_COMPLETE': {
        const p = data.payload as SearchCompletePayload;
        if (p.seq !== this.searchSeq) {
          console.warn('[Search] Ignoring stale result', p.seq, 'current', this.searchSeq);
          return;
        }
        const chunk = this.data();
        const cv = this.view();
        if (!chunk || !cv) return;
        chunk.rowOrder = p.rowOrder;
        cv.updateData({ rowOrder: p.rowOrder });
        console.timeEnd('grid-search-request');
        this.sortApplyRevision.update((n) => n + 1);
        break;
      }

      case 'FILTER_COMPLETE': {
        const p = data.payload as ColumnFilterCompletePayload;
        if (p.seq !== this.filterSeq) {
          console.warn('[ColumnFilter] Ignoring stale result', p.seq, 'current', this.filterSeq);
          return;
        }
        const chunk = this.data();
        const cv = this.view();
        if (!chunk || !cv) return;
        chunk.rowOrder = p.rowOrder;
        cv.updateData({ rowOrder: p.rowOrder });
        console.timeEnd('grid-filter-request');
        this.sortApplyRevision.update((n) => n + 1);
        break;
      }

      case 'CELL_EDIT_COMPLETE': {
        const p = data.payload as CellEditCompletePayload;
        console.timeEnd('cell-edit-request');
        if (p.ok) {
          this.sortApplyRevision.update((n) => n + 1);
        }
        break;
      }

      case 'EXPORT_CSV_COMPLETE': {
        const p = data.payload as ExportCsvCompletePayload;
        this.csvExportPending.set(false);
        console.timeEnd('csv-export-request');
        if (p.seq !== this.exportCsvSeq) {
          console.warn('[CSV] Ignoring stale export', p.seq, 'current', this.exportCsvSeq);
          break;
        }
        this.downloadCsvText(p.csvText);
        break;
      }

      case 'EXPORT_JSON_COMPLETE': {
        const p = data.payload as ExportJsonCompletePayload;
        this.jsonExportPending.set(false);
        console.timeEnd('json-export-request');
        if (p.seq !== this.exportJsonSeq) {
          console.warn('[JSON] Ignoring stale export', p.seq, 'current', this.exportJsonSeq);
          break;
        }
        this.downloadJsonText(p.jsonText);
        break;
      }

      case 'ERROR':
        console.error('Worker Error:', data.error);
        this.csvExportPending.set(false);
        this.jsonExportPending.set(false);
        this.error.set(data.error || 'Unknown Error');
        this.loading.set(false);
        break;
    }
  }

  /**
   * Triggers a browser download of UTF-8 CSV. Revokes the object URL after click.
   */
  private downloadCsvText(csvText: string): void {
    if (!isPlatformBrowser(this.platformId)) return;
    const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `grid-export-${new Date().toISOString().slice(0, 10)}.csv`;
    link.rel = 'noopener';
    link.click();
    URL.revokeObjectURL(url);
  }

  private downloadJsonText(jsonText: string): void {
    if (!isPlatformBrowser(this.platformId)) return;
    const blob = new Blob([jsonText], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `grid-export-${new Date().toISOString().slice(0, 10)}.json`;
    link.rel = 'noopener';
    link.click();
    URL.revokeObjectURL(url);
  }
}
