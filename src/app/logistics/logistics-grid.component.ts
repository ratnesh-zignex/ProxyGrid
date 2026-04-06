import './logistics-flexgrid-filter-virtual-patch';
import { Component, inject, ViewChild, effect, PLATFORM_ID, OnDestroy } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { WjGridModule } from '@mescius/wijmo.angular2.grid';
import * as wjGrid from '@mescius/wijmo.grid';
import { DataType } from '@mescius/wijmo';
import * as wijmoInput from '@mescius/wijmo.input';
import { FlexGridFilter } from '@mescius/wijmo.grid.filter';
import type { CellRangeEventArgs } from '@mescius/wijmo.grid';
import { LogisticsDataService } from './logistics-data.service';
import { coerceToUint32 } from './logistics-editable-columns';
import {
  applyDefaultConditionOperatorsForEditing,
  applyFlexGridFilterCultureOperators,
} from './logistics-flexgrid-filter-culture';
import { serializeFlexGridColumnFilters } from './logistics-wijmo-filter-serialize';
import {
  computeNextSortModel,
  syncCollectionViewSortDescriptions,
} from './logistics-sort-wijmo';
import type { ExportCsvColumnSpec } from './logistics.types';

/** Bindings backed by numeric TypedArrays / numbers — right-align cells; headers centered via CSS. */
const GRID_NUMERIC_BINDINGS = new Set<string>([
  'cid',
  'rNo',
  'sNo',
  'sOLNo',
  'clstId',
  'uqty',
  'uVolVal',
  'srvcOrdrWtVal',
  'srvctm',
  'adTm',
  'totCostTsrvPrYd',
  'tcTsrv',
  'tTsrv',
  'strtm',
  'stptm',
  'oPr',
  'lkFlgD',
  'weekCodeLockFlag',
  'lat',
  'lon',
  'edId',
  'geoSt',
  'srvcUnitFrqByWk',
  'srvcGeocodeConf',
  'dchg',
  'weekChange',
  'srvcUnitRgtAccPnlt',
  'srvcUnitLftAccPnlt',
  'srcRNo',
  'srcSNo',
  'osPkup',
  'mapPageNo',
  'wkNo',
  'orgRt.monday',
  'orgRt.tuesday',
  'creationDtm',
]);

@Component({
  selector: 'app-logistics-grid',
  standalone: true,
  imports: [CommonModule, WjGridModule],
  styleUrls: ['./logistics-grid-visual.scss'],
  template: `
    <div class="grid-container" *ngIf="isBrowser">
      <div class="grid-toolbar">
        <span class="row-count" *ngIf="service.data() as d">
          <ng-container *ngIf="d.rowOrder.length === d.totalRows; else filteredRowCount">
            {{ d.totalRows | number }} rows
          </ng-container>
          <ng-template #filteredRowCount>
            {{ d.rowOrder.length | number }} / {{ d.totalRows | number }} rows
          </ng-template>
        </span>
        <div class="toolbar-actions">
          <input
            type="text"
            class="global-search-input"
            placeholder="Search…"
            (input)="onSearch($event)"
            autocomplete="off"
          />
          <button
            type="button"
            class="toolbar-btn toolbar-export-csv"
            title="Export visible rows to CSV"
            [disabled]="!service.data() || !grid?.columns?.length || service.csvExportPending()"
            (click)="exportCsv()">
            Export CSV
          </button>
          <button
            type="button"
            class="toolbar-btn toolbar-export-json"
            title="Export visible rows to JSON"
            [disabled]="!service.data() || !grid?.columns?.length || service.jsonExportPending()"
            (click)="exportJson()">
            Export JSON
          </button>
          <button
            type="button"
            class="toolbar-btn toolbar-clear-filters"
            title="Clear all column filters"
            aria-label="Clear all column filters"
            [disabled]="!service.data()"
            (click)="clearColumnFilters()">
            <svg class="toolbar-clear-filters-icon" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
              <line x1="4" y1="22" x2="20" y2="6"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="logistics-grid-surface">
        <wj-flex-grid #grid
          [itemsSource]="service.gridItemsSource()"
          [autoGenerateColumns]="false"
          [virtualizationThreshold]="5"
          [isReadOnly]="false"
          [allowSorting]="allowFlexSort"
          (initialized)="initializeGrid($event)">
        </wj-flex-grid>
      </div>
      
      <div *ngIf="service.loading()" class="loading-overlay">
        Loading 100k Rows via SQLite WASM...
      </div>
      <div *ngIf="service.error()" class="error-overlay">
        {{ service.error() }}
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      height: 100%;
      width: 100%;
      min-height: 0;
      box-sizing: border-box;
    }
    .grid-container {
      display: flex;
      flex-direction: column;
      height: 100%;
      width: 100%;
      margin: 0;
      padding: 0;
      min-height: 0;
      position: relative;
      overflow: hidden;
      box-sizing: border-box;
      background: #fff;
      border: none;
    }
    .grid-toolbar {
      flex: 0 0 auto;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 10px;
      padding: 10px 12px 12px;
      border-bottom: 1px solid #e2e8f0;
      background: linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%);
      box-shadow: 0 1px 0 rgba(255, 255, 255, 0.8) inset;
    }
    .row-count {
      flex: 0 0 auto;
      font-size: 13px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: #334155;
      white-space: nowrap;
      padding: 4px 0 2px;
      letter-spacing: 0.01em;
    }
    .toolbar-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .global-search-input {
      flex: 1 1 160px;
      min-width: 120px;
      max-width: 100%;
      padding: 9px 14px;
      font-size: 14px;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      box-sizing: border-box;
      background: #fff;
      color: #0f172a;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .global-search-input::placeholder {
      color: #94a3b8;
    }
    .global-search-input:hover {
      border-color: #94a3b8;
    }
    .global-search-input:focus {
      outline: none;
      border-color: #6366f1;
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
    }
    .toolbar-btn {
      flex: 0 0 auto;
      padding: 9px 16px;
      font-size: 13px;
      font-weight: 500;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      background: #fff;
      color: #1e293b;
      cursor: pointer;
      transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    }
    .toolbar-btn:hover:not(:disabled) {
      background: #f8fafc;
      border-color: #94a3b8;
      color: #0f172a;
    }
    .toolbar-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .toolbar-export-csv {
      border-color: #c7d2fe;
      background: #eef2ff;
      color: #3730a3;
    }
    .toolbar-export-csv:hover:not(:disabled) {
      background: #e0e7ff;
      border-color: #a5b4fc;
    }
    .toolbar-export-json {
      border-color: #bae6fd;
      background: #f0f9ff;
      color: #0369a1;
    }
    .toolbar-export-json:hover:not(:disabled) {
      background: #e0f2fe;
      border-color: #7dd3fc;
    }
    .toolbar-clear-filters {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      padding: 0;
      border-radius: 8px;
      color: #475569;
    }
    .toolbar-clear-filters:hover:not(:disabled) {
      color: #dc2626;
      border-color: #fecaca;
      background: #fef2f2;
    }
    .toolbar-clear-filters-icon {
      display: block;
    }
    .logistics-grid-surface wj-flex-grid {
      display: block;
      height: 100%;
      min-height: 0;
      width: 100%;
    }
    .loading-overlay, .error-overlay {
      position: absolute;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      background: #fff;
      padding: 24px 28px;
      border-radius: 12px;
      border: 1px solid #e2e8f0;
      box-shadow: 0 10px 40px rgba(15, 23, 42, 0.12);
      z-index: 10;
      font-size: 1rem;
      color: #334155;
      max-width: calc(100% - 32px);
      text-align: center;
    }
    .error-overlay {
      color: #b91c1c;
      border-color: #fecaca;
      background: #fef2f2;
    }
  `]
})
export class LogisticsGridComponent implements OnDestroy {
  service = inject(LogisticsDataService);
  platformId = inject(PLATFORM_ID);
  isBrowser = isPlatformBrowser(this.platformId);
  /** Wijmo MultiColumn: multi-level sort glyphs; actual order is `rowOrder`. */
  readonly allowFlexSort = wjGrid.AllowSorting.SingleColumn;
  /**
   * `true` (default): each new header click **adds** a sort key (same as FlexGrid
   * MultiColumn / Wijmo). `false`: add keys only while **Shift** is held; plain
   * click keeps a **single** sort column.
   */
  readonly appendSortWithoutShift = true;
  @ViewChild('grid') grid!: wjGrid.FlexGrid;

  private _pointerDownClean?: () => void;
  private _sortingColumnHandler?: (s: wjGrid.FlexGrid, e: wjGrid.CellRangeEventArgs) => void;
  private _formatItemHandler?: (s: wjGrid.FlexGrid, e: wjGrid.FormatItemEventArgs) => void;
  private _searchDebounceId: ReturnType<typeof setTimeout> | null = null;
  private _flexGridFilter?: FlexGridFilter;
  private _filterAppliedHandler?: () => void;
  private _cellEditEndedHandler?: (s: wjGrid.FlexGrid, e: wjGrid.CellRangeEventArgs) => void;
  private _beginningEditHandler?: (s: wjGrid.FlexGrid, e: wjGrid.CellRangeEventArgs) => void;

  private _logPerf(label: string) {
    const mem = (performance as any).memory;
    if (mem) {
      console.log(`[Perf] ${label}: ${Math.round(mem.usedJSHeapSize / 1024 / 1024)}MB used`);
    }
  }

  constructor() {
    if (this.isBrowser) {
      this._logPerf('Initial Memory');
      // Data load is triggered once from AppComponent (shared with map).
    }
    
    effect(() => {
      const idx = this.service.selectedRowIndex();
      if (idx !== null && this.isBrowser) {
        console.time('AutoScroll');
        setTimeout(() => {
          if (this.grid) {
            this.grid.select(new wjGrid.CellRange(idx, 0, idx, this.grid.columns.length - 1), true);
            console.timeEnd('AutoScroll');
            this._logPerf('After Scroll');
          }
        });
      }
    });

    effect(() => {
      const rev = this.service.sortApplyRevision();
      if (rev === 0 || !this.isBrowser) return;
      queueMicrotask(() => this.grid?.invalidate());
    });

    effect(() => {
      this.service.searchHighlightQuery();
      if (!this.isBrowser) return;
      queueMicrotask(() => this.grid?.invalidate());
    });
  }

  ngOnDestroy(): void {
    if (this._searchDebounceId !== null) {
      clearTimeout(this._searchDebounceId);
    }
    this._pointerDownClean?.();
    const g = this.grid;
    if (g && this._sortingColumnHandler) {
      g.sortingColumn.removeHandler(this._sortingColumnHandler);
    }
    if (g && this._formatItemHandler) {
      g.formatItem.removeHandler(this._formatItemHandler);
    }
    if (this._flexGridFilter && this._filterAppliedHandler) {
      this._flexGridFilter.filterApplied.removeHandler(this._filterAppliedHandler);
    }
    if (g && this._cellEditEndedHandler) {
      g.cellEditEnded.removeHandler(this._cellEditEndedHandler);
    }
    if (g && this._beginningEditHandler) {
      g.beginningEdit.removeHandler(this._beginningEditHandler);
    }
  }

  /** Debounced worker search; highlight updates immediately via `searchHighlightQuery`. */
  onSearch(ev: Event) {
    const v = (ev.target as HTMLInputElement).value;
    this.service.searchHighlightQuery.set(v);
    if (this._searchDebounceId !== null) {
      clearTimeout(this._searchDebounceId);
    }
    this._searchDebounceId = setTimeout(() => {
      this._searchDebounceId = null;
      this.service.requestSearch(v);
    }, 200);
  }

  /**
   * Clears all column filters in the Wijmo UI and resets the worker `rowOrder`.
   * We clear each column’s {@link ColumnFilter} (FlexGridFilter.clear() is a no-op when
   * `_filters` is still empty) and set `collectionView.filter = null` after {@link FlexGridFilter.apply},
   * matching the normal filterApplied path so the virtual CV is not left with a filter function.
   */
  /**
   * Sends current FlexGrid column order and headers to the worker for CSV built from TypedArrays + dictionaries.
   */
  /** Builds export specs from current FlexGrid columns (order matches visible grid). */
  private collectExportColumns(): ExportCsvColumnSpec[] {
    const grid = this.grid;
    const columns: ExportCsvColumnSpec[] = [];
    if (!grid?.columns?.length) return columns;
    for (let i = 0; i < grid.columns.length; i++) {
      const col = grid.columns[i];
      const binding = col.binding;
      if (binding == null || binding === '') continue;
      const b = String(binding);
      const headerRaw = col.header;
      const header =
        headerRaw != null && String(headerRaw).trim() !== ''
          ? String(headerRaw)
          : b;
      columns.push({ binding: b, header });
    }
    return columns;
  }

  exportCsv(): void {
    const columns = this.collectExportColumns();
    if (columns.length === 0) return;
    this.service.requestCsvExport(columns);
  }

  exportJson(): void {
    const columns = this.collectExportColumns();
    if (columns.length === 0) return;
    this.service.requestJsonExport(columns);
  }

  clearColumnFilters() {
    const fg = this._flexGridFilter;
    const grid = this.grid;
    const h = this._filterAppliedHandler;
    if (fg && h) {
      fg.filterApplied.removeHandler(h);
    }
    try {
      if (fg && grid?.columns?.length) {
        for (let i = 0; i < grid.columns.length; i++) {
          const col = grid.columns[i];
          if (col.binding) {
            fg.getColumnFilter(col, true).clear();
          }
        }
        fg.apply();
        const cv = grid.collectionView;
        if (cv) {
          cv.filter = null;
        }
      }
    } finally {
      if (fg && h) {
        fg.filterApplied.addHandler(h);
      }
    }
    this.service.requestColumnFilter([]);
  }

  initializeGrid(s: wjGrid.FlexGrid, e?: any) {
      console.log('Grid Initialized', s);
      const grid = s || this.grid;
      if (!grid) {
        console.error('Grid instance not found in initializeGrid');
        return;
      }

    this._pointerDownClean?.();
    if (this._sortingColumnHandler) {
      grid.sortingColumn.removeHandler(this._sortingColumnHandler);
    }
    if (this._formatItemHandler) {
      grid.formatItem.removeHandler(this._formatItemHandler);
    }
    if (this._cellEditEndedHandler) {
      grid.cellEditEnded.removeHandler(this._cellEditEndedHandler);
    }
    if (this._beginningEditHandler) {
      grid.beginningEdit.removeHandler(this._beginningEditHandler);
    }
    const host = grid.hostElement;
    /** Fallback if `sortingColumn` ever fires without `e.data` (keyboard / tests). */
    let lastPointerShift = false;
    const onPointerDown = (ev: PointerEvent) => {
      lastPointerShift = ev.shiftKey;
    };
    host.addEventListener('pointerdown', onPointerDown, true);
    this._pointerDownClean = () => host.removeEventListener('pointerdown', onPointerDown, true);

    this._sortingColumnHandler = (_flex: wjGrid.FlexGrid, e: wjGrid.CellRangeEventArgs) => {
      const col = e.getColumn?.(true);
      const binding = col?.binding as string | undefined;
      if (!binding) return;
      e.cancel = true;
      const ev = e.data as MouseEvent | PointerEvent | undefined;
      const shiftFromEvent =
        !!ev && typeof ev === 'object' && 'shiftKey' in ev && !!(ev as MouseEvent).shiftKey;
      /** Wijmo puts the header click on `e.data`; use that so Shift is reliable. */
      const multiColumn =
        this.appendSortWithoutShift || shiftFromEvent || lastPointerShift;
      const next = computeNextSortModel(
        this.service.sortModel(),
        binding,
        multiColumn
      );
      const cv = this.service.view();
      if (cv) syncCollectionViewSortDescriptions(cv, next);
      this.service.requestSort(next);
    };
    grid.sortingColumn.addHandler(this._sortingColumnHandler);

    grid.showAlternatingRows = true;
    grid.alternatingRowStep = 1;
    grid.allowResizing = wjGrid.AllowResizing.Columns;
    grid.deferResizing = true;

    this._formatItemHandler = (flex: wjGrid.FlexGrid, e: wjGrid.FormatItemEventArgs) => {
      if (e.panel !== flex.cells || !e.cell) return;
      let raw: unknown;
      try {
        raw = flex.getCellData(e.row, e.col, false);
      } catch {
        return;
      }
      const text = raw == null || raw === '' ? '' : String(raw);
      e.cell.title = text;
      const q = this.service.searchHighlightQuery().trim().toLowerCase();
      e.cell.classList.remove('grid-search-match');
      if (q && text.toLowerCase().includes(q)) {
        e.cell.classList.add('grid-search-match');
      }
    };
    grid.formatItem.addHandler(this._formatItemHandler);

    this._beginningEditHandler = (_flex: wjGrid.FlexGrid, e: wjGrid.CellRangeEventArgs) => {
      if (e.panel !== _flex.cells) return;
      const col = e.getColumn?.(true);
      const b = col?.binding as string | undefined;
      if (b !== 'rNo' && b !== 'sOLNo') {
        e.cancel = true;
      }
    };
    grid.beginningEdit.addHandler(this._beginningEditHandler);

    this._cellEditEndedHandler = (flex: wjGrid.FlexGrid, e: wjGrid.CellRangeEventArgs) => {
      if (e.panel !== flex.cells) return;
      const col = e.getColumn?.(true);
      const binding = col?.binding as string | undefined;
      if (binding !== 'rNo' && binding !== 'sOLNo') return;
      const cv = this.service.view();
      if (!cv) return;
      const physical = cv.getOriginalIndex(e.row);
      if (physical < 0) return;
      const raw = flex.getCellData(e.row, e.col, false);
      const num = coerceToUint32(raw);
      if (num === null) return;
      const chunk = this.service.data();
      if (chunk?.numericColumns[binding]) {
        chunk.numericColumns[binding]![physical] = num;
      }
      this.service.requestCellEdit({
        physicalRowIndex: physical,
        column: binding as 'rNo' | 'sOLNo',
        value: num,
      });
    };
    grid.cellEditEnded.addHandler(this._cellEditEndedHandler);

    const rNoEditor = new wijmoInput.InputNumber(document.createElement('div'), { format: 'n0' });
    const sOLNoEditor = new wijmoInput.InputNumber(document.createElement('div'), { format: 'n0' });

    const columnDefinitions = [ 
      { binding: 'cid', header: 'Customer #', width: 150, isReadOnly: true }, 
      { binding: 'name', header: 'Customer Name', width: 200, minWidth: 150, isReadOnly: true }, 
      { binding: 'rNo', header: 'Route #', width: 80 }, 
      { binding: 'sNo', header: 'Seq #', width: 60 }, 
      { binding: 'sOLNo', header: 'Load #', width: 65 }, 
      { binding: 'clstId', header: 'Daily Cluster #', width: 81 }, 
      { binding: 'uqty', header: 'Quantity', width: 75 }, 
      { binding: 'uVolVal', header: 'Size', width: 70 }, 
      { binding: 'srvcOrdrWtVal', header: 'Weight per Cont. (Lbs)', width: 100 }, 
      { binding: 'srvctm', header: 'Srvc Time per Cont. (Secs)', width: 105 }, 
      { binding: 'adTm', header: 'Addln Srvc Tm', width: 75 }, 
      { binding: 'totCostTsrvPrYd', header: 'Cost to Serve ($/Yard)', width: 98 }, 
      { binding: 'tcTsrv', header: 'Total Cost to Serve ($)', width: 90 }, 
      { binding: 'tTsrv', header: 'Time to Serve (Secs)', width: 97 }, 
      { binding: 'materialType', header: 'Material Type', width: 80 }, 
      { binding: 'srvcOrdrSrcDispCd', header: 'Disposal Code', width: 80 }, 
      { binding: 'srvcUnitAccCd', header: 'Container Flag', width: 78 }, 
      { binding: 'strtm', header: 'Start Time', width: 82, format: 'HH' }, 
      { binding: 'stptm', header: 'Stop Time', width: 82, format: 'HH' }, 
      { binding: 'oPr', header: 'Priority', width: 65 }, 
      { binding: 'lkFlgD', header: 'DOW Lock', width: 70 }, 
      { binding: 'weekCodeLockFlag', header: 'Week Cd Lock', width: 73 }, 
      { binding: 'srvcOrdrCode', header: 'Service Order Cd', width: 80 }, 
      { binding: 'addr', header: 'Address', width: 250, minWidth: 150 }, 
      { binding: 'cty', header: 'City', width: 95 }, 
      { binding: 'state', header: 'State', width: 67 }, 
      { binding: 'zip', header: 'Zip', width: 65 }, 
      { binding: 'cntry', header: 'Country', width: 75 }, 
      { binding: 'lat', header: 'Latitude', width: 75, format: 'n6' }, 
      { binding: 'lon', header: 'Longitude', width: 80, format: 'n6' }, 
      { binding: 'edId', header: 'Road Id', width: 80 }, 
      { binding: 'sos', header: 'SOS', width: 55 }, 
      { binding: 'geoSt', header: 'Geocoded', width: 80 }, 
      { binding: 'srvcUnitFrqByWk', header: 'Frequency', width: 80 }, 
      { binding: 'srvcGeocodeSrcDesc', header: 'Geocode Source', width: 70 }, 
      { binding: 'srvcGeocodeConf', header: 'Geocode Confidence', width: 112 }, 
      { binding: 'dchg', header: 'Day Change', width: 68 }, 
      { binding: 'weekChange', header: 'Week Change', width: 68 }, 
      { binding: 'srvcUnitRgtAccPnlt', header: 'Right Penalty', width: 70 }, 
      { binding: 'srvcUnitLftAccPnlt', header: 'Left Penalty', width: 70 }, 
      { binding: 'srcDOW', header: 'Source DOW', width: 88 }, 
      { binding: 'srcRNo', header: 'Source Route #', width: 70 }, 
      { binding: 'srcSNo', header: 'Source Seq #', width: 65 }, 
      { binding: 'vStLc', header: 'Vehicle Start Loc', width: 80 }, 
      { binding: 'vEdLc', header: 'Vehicle End Loc', width: 80 }, 
      { binding: 'osPkup', header: 'One Side Pickup', width: 80 }, 
      { binding: 'rtWkCd', header: 'Week Cd', width: 80 }, 
      { binding: 'wkNo', header: 'Week #', width: 80 },
      {
        binding: 'orgRt.monday',
        header: 'Mon',
        width: 60,
        isReadOnly: true,
        isRequired: false,
      },
      {
        binding: 'orgRt.tuesday',
        header: 'Tue',
        width: 60,
        isReadOnly: true,
        isRequired: false,
      },
      { binding: 'mapPageNo', header: 'Map Page #', width: 90 }, 
      { binding: 'note1', header: 'Notes 1', width: 70 }, 
      { binding: 'note2', header: 'Notes 2', width: 70 }, 
      { binding: 'notes3', header: 'Notes 3', width: 70 }, 
      { binding: 'notes4', header: 'Notes 4', width: 70 }, 
      { binding: 'notes5', header: 'Notes 5', width: 70 }, 
      { binding: 'userCustom1', header: 'User Custom 1', width: 100 }, 
      { binding: 'userCustom2', header: 'User Custom 2', width: 100 }, 
      { binding: 'userCustom3', header: 'User Custom 3', width: 100 }, 
      { binding: 'userCustom4', header: 'User Custom 4', width: 100 }, 
      { binding: 'userCustom5', header: 'User Custom 5', width: 100 }, 
      { binding: 'creationDtm', header: 'Creation Date', width: 118 }, 
      { binding: 'userId', header: 'Imported By', width: 110 } 
    ];

    grid.columns.clear();
    columnDefinitions.forEach(colDef => {
      const col = new wjGrid.Column(colDef);
      col.isReadOnly = true;
      const b = colDef.binding as string | undefined;
      if (b && GRID_NUMERIC_BINDINGS.has(b)) {
        col.cssClass = 'grid-num';
      }
      if (b === 'rNo') {
        col.isReadOnly = false;
        col.editor = rNoEditor;
        col.dataType = DataType.Number;
      } else if (b === 'sOLNo') {
        col.isReadOnly = false;
        col.editor = sOLNoEditor;
        col.dataType = DataType.Number;
      }
      grid.columns.push(col);
    });
    grid.itemsSourceChanged.addHandler((s: wjGrid.FlexGrid) => {
      setTimeout(() => {
        if (s.columnHeaders && s.columnHeaders.rows) {
          const row: wjGrid.Row | undefined = s.columnHeaders.rows[0];
          if (row) row.wordWrap = true;
          // autosize first header row
          s.autoSizeRow(0, true);
        }
      });
    });

    if (this._flexGridFilter && this._filterAppliedHandler) {
      this._flexGridFilter.filterApplied.removeHandler(this._filterAppliedHandler);
    }
    applyFlexGridFilterCultureOperators();
    this._flexGridFilter = new FlexGridFilter(grid, {
      showSortButtons: false,
      editingFilter: (s: FlexGridFilter, e: CellRangeEventArgs) => {
        applyDefaultConditionOperatorsForEditing(s, e);
        return true;
      },
    });
    (this._flexGridFilter as any)._filter = () => true;
    this._filterAppliedHandler = () => {
      const cv = grid.collectionView;
      if (cv) {
        cv.filter = null;
      }
      const filters = serializeFlexGridColumnFilters(this._flexGridFilter!);
      this.service.requestColumnFilter(filters);
    };
    this._flexGridFilter.filterApplied.addHandler(this._filterAppliedHandler);

    grid.refresh();
  }
}
