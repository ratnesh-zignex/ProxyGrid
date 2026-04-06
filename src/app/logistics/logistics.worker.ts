/// <reference lib="webworker" />

import { tableFromArrays, Table } from 'apache-arrow';
import { DictionaryEncoder } from './dictionary-encoder';
import {
  type LogisticsDataChunk,
  type WorkerRequest,
  type SortRequestPayload,
  type ColumnFilterPayload,
  type CellEditPayload,
  type SortDescriptor,
  isSimpleSortPayload,
  ORG_RT_MONDAY_FLAT,
  ORG_RT_TUESDAY_FLAT,
} from './logistics.types';
import {
  filterRowIndicesByGlobalSearch,
  filterRowsByColumnFilters,
  sortRowOrderByModel,
  sortRowOrderBySingleColumn,
} from './logistics-index-operations';
import { buildCsvFromColumnarData } from './logistics-csv-export';
import { buildJsonFromColumnarData } from './logistics-json-export';
import type { ExportCsvPayload, ExportJsonPayload } from './logistics.types';

// State management
let arrowTable: Table | undefined;
/** Physical row count (constant after load). */
let dataTotalRows = 0;
/** Mutable view order in the worker (copy; transferred rowOrder buffer is detached after load). */
let currentRowOrder: Uint32Array | null = null;
let numericColumns: { [key: string]: Float32Array | Uint32Array | Uint16Array | Uint8Array } = {};
let dictColumns: { [key: string]: Uint8Array | Uint16Array } = {};
let dictMaps: { [key: string]: (string | number)[] } = {};
let stringColumns: { [key: string]: string[] } = {};

/**
 * After DATA_LOADED, numeric/dict ArrayBuffers are transferred to the main thread and
 * detached in this worker — reads on `numericColumns`/`dictColumns` are invalid for SORT.
 * These are full copies used only for worker-side sorting.
 */
let sortNumericColumns: typeof numericColumns | null = null;
let sortDictColumns: typeof dictColumns | null = null;

/** Physical indices that pass column filters (unsorted); null = no column filter (all rows). */
let columnFilterBase: Uint32Array | null = null;

/**
 * Columnar buffers we clone in the worker. Uses concrete typed arrays so `.length` / `.set`
 * type-check (plain `ArrayBufferView` in recent TS libs does not expose `length`).
 */
type LogisticsColumnArray =
  | Float32Array
  | Uint32Array
  | Uint16Array
  | Uint8Array;

function cloneTypedColumnViews<T extends Record<string, LogisticsColumnArray>>(src: T): T {
  const out = {} as T;
  for (const key of Object.keys(src)) {
    const a = src[key as keyof T] as LogisticsColumnArray;
    const Ctor = a.constructor as new (len: number) => LogisticsColumnArray;
    const copy = new Ctor(a.length);
    copy.set(a);
    (out as Record<string, LogisticsColumnArray>)[key] = copy;
  }
  return out;
}

/** Drop prior columnar state so a reload does not retain duplicate buffers in the worker heap. */
function releaseWorkerDataset(): void {
  arrowTable = undefined;
  dataTotalRows = 0;
  sortNumericColumns = null;
  sortDictColumns = null;
  currentRowOrder = null;
  columnFilterBase = null;
  numericColumns = {};
  dictColumns = {};
  dictMaps = {};
  stringColumns = {};
}

const initAndLoad = async () => {
  try {
    // Generate data directly into columnar format (Arrow Table)
    generateMockDataDirectly(100000);
  } catch (err: any) {
    postMessage({ type: 'ERROR', error: err.message });
  }
};

const generateMockDataDirectly = (totalRows: number) => {
  dataTotalRows = totalRows;
  console.time('Worker: Arrow Table Generation');
  console.log('Worker: Generating Data into Apache Arrow Table...');

  // 1. Initialize Typed Arrays for numeric/date columns
  const cids = new Uint32Array(totalRows);
  const lats = new Float32Array(totalRows);
  const lons = new Float32Array(totalRows);
  const srvctms = new Uint16Array(totalRows);
  const wkNos = new Uint8Array(totalRows);
  // todo: need to change the type of string
  const creationDtms = new Uint32Array(totalRows);
  const rNos = new Uint32Array(totalRows);
  const sNos = new Uint32Array(totalRows);
  const sOLNos = new Uint32Array(totalRows);
  const clstIds = new Uint32Array(totalRows);
  const uqtys = new Uint32Array(totalRows);
  const uVolVals = new Uint32Array(totalRows);
  const srvcOrdrWtVals = new Uint32Array(totalRows);
  const adTms = new Uint32Array(totalRows);
  const totCostTsrvPrYds = new Float32Array(totalRows);
  const tcTsrvs = new Float32Array(totalRows);
  const tTsrvs = new Uint32Array(totalRows);
  const strtms = new Uint8Array(totalRows);
  const stptms = new Uint8Array(totalRows);
  const oPrs = new Uint8Array(totalRows);
  const lkFlgDs = new Uint8Array(totalRows);
  const weekCodeLockFlags = new Uint8Array(totalRows);
  const edIds = new Uint32Array(totalRows);
  const geoSts = new Uint8Array(totalRows);
  const srvcUnitFrqByWks = new Uint8Array(totalRows);
  const srvcGeocodeConfs = new Uint8Array(totalRows);
  const dchgs = new Uint8Array(totalRows);
  const weekChanges = new Uint8Array(totalRows);
  const srvcUnitRgtAccPnlts = new Uint8Array(totalRows);
  const srvcUnitLftAccPnlts = new Uint8Array(totalRows);
  const srcRNos = new Uint32Array(totalRows);
  const srcSNos = new Uint32Array(totalRows);
  const osPkups = new Uint8Array(totalRows);
  const mapPageNos = new Uint32Array(totalRows);
  /** Original route days; flat keys `orgRt_monday` / `orgRt_tuesday` (grid binds `orgRt.monday` / `orgRt.tuesday`). */
  const orgRt_monday = new Uint16Array(totalRows);
  const orgRt_tuesday = new Uint16Array(totalRows);

  // 2. Initialize Arrays for string columns (to be dictionary encoded later)
  const rawStates: string[] = [];
  const rawCities: string[] = [];
  const rawMaterials: string[] = [];
  const rawSrvcOrdrSrcDispCds: string[] = [];
  const rawSrvcUnitAccCds: string[] = [];
  const rawSrvcOrdrCodes: string[] = [];
  const rawZips: string[] = [];
  const rawCntrys: string[] = [];
  const rawSoss: string[] = [];
  const rawSrvcGeocodeSrcDescs: string[] = [];
  const rawSrcDOWs: string[] = [];
  const rawVStLcs: string[] = [];
  const rawVEdLcs: string[] = [];
  const rawRtWkCds: string[] = [];
  const rawUserIds: string[] = [];

  // 3. Initialize Arrays for long text columns
  const addrs: string[] = [];
  const names: string[] = [];
  const note1s: string[] = [];
  const note2s: string[] = [];
  const notes3s: string[] = [];
  const notes4s: string[] = [];
  const notes5s: string[] = [];
  const userCustom1s: string[] = [];
  const userCustom2s: string[] = [];
  const userCustom3s: string[] = [];
  const userCustom4s: string[] = [];
  const userCustom5s: string[] = [];

  // 4. Generate the mock data loop
  for (let i = 0; i < totalRows; i++) {
    cids[i] = i;
    lats[i] = 34.0 + Math.random() * 10;
    lons[i] = -118.0 + Math.random() * 10;
    rawStates.push(['CA', 'NY', 'TX', 'FL'][Math.floor(Math.random() * 4)]);
    rawCities.push(['Los Angeles', 'New York', 'Houston', 'Miami'][Math.floor(Math.random() * 4)]);
    rawMaterials.push(['Plastic', 'Metal', 'Glass', 'Paper'][Math.floor(Math.random() * 4)]);
    srvctms[i] = Math.floor(Math.random() * 1000);
    wkNos[i] = Math.floor(Math.random() * 52);
    addrs.push(`Address ${i}`);
    names.push(`Customer ${i}`);
    creationDtms[i] = Date.now() - Math.floor(Math.random() * 10000000);

    rNos[i] = Math.floor(Math.random() * 100);
    sNos[i] = Math.floor(Math.random() * 1000);
    sOLNos[i] = Math.floor(Math.random() * 10);
    clstIds[i] = Math.floor(Math.random() * 50);
    uqtys[i] = Math.floor(Math.random() * 100);
    uVolVals[i] = Math.floor(Math.random() * 200);
    srvcOrdrWtVals[i] = Math.floor(Math.random() * 500);
    adTms[i] = Math.floor(Math.random() * 60);
    totCostTsrvPrYds[i] = Math.random() * 10.0;
    tcTsrvs[i] = Math.random() * 1000.0;
    tTsrvs[i] = Math.floor(Math.random() * 3600);
    rawSrvcOrdrSrcDispCds.push(['D1', 'D2', 'D3'][Math.floor(Math.random() * 3)]);
    rawSrvcUnitAccCds.push(['F1', 'F2'][Math.floor(Math.random() * 2)]);
    strtms[i] = 8 + Math.floor(Math.random() * 4);
    stptms[i] = 16 + Math.floor(Math.random() * 4);
    oPrs[i] = Math.floor(Math.random() * 5);
    lkFlgDs[i] = Math.random() > 0.5 ? 1 : 0;
    weekCodeLockFlags[i] = Math.random() > 0.5 ? 1 : 0;
    rawSrvcOrdrCodes.push(`SO-${i}`);
    rawZips.push(`9021${Math.floor(Math.random() * 10)}`);
    rawCntrys.push('USA');
    edIds[i] = Math.floor(Math.random() * 100000);
    rawSoss.push(['S1', 'S2'][Math.floor(Math.random() * 2)]);
    geoSts[i] = Math.random() > 0.1 ? 1 : 0;
    srvcUnitFrqByWks[i] = Math.floor(Math.random() * 7);
    rawSrvcGeocodeSrcDescs.push('Google');
    srvcGeocodeConfs[i] = Math.floor(Math.random() * 100);
    dchgs[i] = Math.random() > 0.9 ? 1 : 0;
    weekChanges[i] = Math.random() > 0.9 ? 1 : 0;
    srvcUnitRgtAccPnlts[i] = Math.floor(Math.random() * 50);
    srvcUnitLftAccPnlts[i] = Math.floor(Math.random() * 50);
    rawSrcDOWs.push(['MON', 'TUE', 'WED', 'THU', 'FRI'][Math.floor(Math.random() * 5)]);
    srcRNos[i] = Math.floor(Math.random() * 100);
    srcSNos[i] = Math.floor(Math.random() * 1000);
    rawVStLcs.push('Depot A');
    rawVEdLcs.push('Depot B');
    osPkups[i] = Math.random() > 0.8 ? 1 : 0;
    rawRtWkCds.push('W1');
    mapPageNos[i] = Math.floor(Math.random() * 500);
    orgRt_monday[i] = 101 + (i % 900);
    orgRt_tuesday[i] = 201 + (i % 800);
    note1s.push(`Note 1-${i % 10}`);
    note2s.push(`Note 2-${i % 5}`);
    notes3s.push(i % 2 === 0 ? 'Urgent' : '');
    notes4s.push(i % 3 === 0 ? 'Gate Code: 1234' : '');
    notes5s.push('Standard Delivery');
    userCustom1s.push(`C1-${Math.random().toString(36).substring(7)}`);
    userCustom2s.push(`C2-${Math.random().toString(36).substring(7)}`);
    userCustom3s.push(`C3-${Math.random().toString(36).substring(7)}`);
    userCustom4s.push(`C4-${Math.random().toString(36).substring(7)}`);
    userCustom5s.push(`C5-${Math.random().toString(36).substring(7)}`);
    rawUserIds.push('Admin');
  }

  // 5. Create Arrow Table (Source of Truth)
  arrowTable = tableFromArrays({
    cid: cids, lat: lats, lon: lons, srvctm: srvctms, wkNo: wkNos, creationDtm: creationDtms,
    rNo: rNos, sNo: sNos, sOLNo: sOLNos, clstId: clstIds, uqty: uqtys, uVolVal: uVolVals,
    srvcOrdrWtVal: srvcOrdrWtVals, adTm: adTms, totCostTsrvPrYd: totCostTsrvPrYds, tcTsrv: tcTsrvs,
    tTsrv: tTsrvs, strtm: strtms, stptm: stptms, oPr: oPrs, lkFlgD: lkFlgDs, weekCodeLockFlag: weekCodeLockFlags,
    edId: edIds, geoSt: geoSts, srvcUnitFrqByWk: srvcUnitFrqByWks, srvcGeocodeConf: srvcGeocodeConfs,
    dchg: dchgs, weekChange: weekChanges, srvcUnitRgtAccPnlt: srvcUnitRgtAccPnlts,
    srvcUnitLftAccPnlt: srvcUnitLftAccPnlts, srcRNo: srcRNos, srcSNo: srcSNos, osPkup: osPkups, mapPageNo: mapPageNos,
    [ORG_RT_MONDAY_FLAT]: orgRt_monday,
    [ORG_RT_TUESDAY_FLAT]: orgRt_tuesday,
    state: rawStates, cty: rawCities, materialType: rawMaterials, srvcOrdrSrcDispCd: rawSrvcOrdrSrcDispCds,
    srvcUnitAccCd: rawSrvcUnitAccCds, srvcOrdrCode: rawSrvcOrdrCodes, zip: rawZips, cntry: rawCntrys,
    sos: rawSoss, srvcGeocodeSrcDesc: rawSrvcGeocodeSrcDescs, srcDOW: rawSrcDOWs, vStLc: rawVStLcs,
    vEdLc: rawVEdLcs, rtWkCd: rawRtWkCds, userId: rawUserIds,
    addr: addrs, name: names, note1: note1s, note2: note2s, notes3: notes3s, notes4: notes4s,
    notes5: notes5s, userCustom1: userCustom1s, userCustom2: userCustom2s, userCustom3: userCustom3s,
    userCustom4: userCustom4s, userCustom5: userCustom5s
  });

  // 6. Apply Dictionary Encoding for the UI Response
  const stateEncoded = DictionaryEncoder.encode(rawStates);
  const cityEncoded = DictionaryEncoder.encode(rawCities);
  const materialEncoded = DictionaryEncoder.encode(rawMaterials);
  const srvcOrdrSrcDispCdEncoded = DictionaryEncoder.encode(rawSrvcOrdrSrcDispCds);
  const srvcUnitAccCdEncoded = DictionaryEncoder.encode(rawSrvcUnitAccCds);
  const srvcOrdrCodeEncoded = DictionaryEncoder.encode(rawSrvcOrdrCodes);
  const zipEncoded = DictionaryEncoder.encode(rawZips);
  const cntryEncoded = DictionaryEncoder.encode(rawCntrys);
  const sosEncoded = DictionaryEncoder.encode(rawSoss);
  const srvcGeocodeSrcDescEncoded = DictionaryEncoder.encode(rawSrvcGeocodeSrcDescs);
  const srcDOWEncoded = DictionaryEncoder.encode(rawSrcDOWs);
  const vStLcEncoded = DictionaryEncoder.encode(rawVStLcs);
  const vEdLcEncoded = DictionaryEncoder.encode(rawVEdLcs);
  const rtWkCdEncoded = DictionaryEncoder.encode(rawRtWkCds);
  const userIdEncoded = DictionaryEncoder.encode(rawUserIds);

  numericColumns = {
    cid: cids, lat: lats, lon: lons, srvctm: srvctms, wkNo: wkNos, creationDtm: creationDtms,
    rNo: rNos, sNo: sNos, sOLNo: sOLNos, clstId: clstIds, uqty: uqtys, uVolVal: uVolVals,
    srvcOrdrWtVal: srvcOrdrWtVals, adTm: adTms, totCostTsrvPrYd: totCostTsrvPrYds, tcTsrv: tcTsrvs,
    tTsrv: tTsrvs, strtm: strtms, stptm: stptms, oPr: oPrs, lkFlgD: lkFlgDs, weekCodeLockFlag: weekCodeLockFlags,
    edId: edIds, geoSt: geoSts, srvcUnitFrqByWk: srvcUnitFrqByWks, srvcGeocodeConf: srvcGeocodeConfs,
    dchg: dchgs, weekChange: weekChanges, srvcUnitRgtAccPnlt: srvcUnitRgtAccPnlts,
    srvcUnitLftAccPnlt: srvcUnitLftAccPnlts, srcRNo: srcRNos, srcSNo: srcSNos, osPkup: osPkups, mapPageNo: mapPageNos,
    [ORG_RT_MONDAY_FLAT]: orgRt_monday,
    [ORG_RT_TUESDAY_FLAT]: orgRt_tuesday,
  };

  dictColumns = {
    state: stateEncoded.index, cty: cityEncoded.index, materialType: materialEncoded.index,
    srvcOrdrSrcDispCd: srvcOrdrSrcDispCdEncoded.index, srvcUnitAccCd: srvcUnitAccCdEncoded.index,
    srvcOrdrCode: srvcOrdrCodeEncoded.index, zip: zipEncoded.index, cntry: cntryEncoded.index,
    sos: sosEncoded.index, srvcGeocodeSrcDesc: srvcGeocodeSrcDescEncoded.index, srcDOW: srcDOWEncoded.index,
    vStLc: vStLcEncoded.index, vEdLc: vEdLcEncoded.index, rtWkCd: rtWkCdEncoded.index, userId: userIdEncoded.index
  };

  dictMaps = {
    state: stateEncoded.values, cty: cityEncoded.values, materialType: materialEncoded.values,
    srvcOrdrSrcDispCd: srvcOrdrSrcDispCdEncoded.values, srvcUnitAccCd: srvcUnitAccCdEncoded.values,
    srvcOrdrCode: srvcOrdrCodeEncoded.values, zip: zipEncoded.values, cntry: cntryEncoded.values,
    sos: sosEncoded.values, srvcGeocodeSrcDesc: srvcGeocodeSrcDescEncoded.values, srcDOW: srcDOWEncoded.values,
    vStLc: vStLcEncoded.values, vEdLc: vEdLcEncoded.values, rtWkCd: rtWkCdEncoded.values, userId: userIdEncoded.values
  };

  stringColumns = {
    addr: addrs, name: names, note1: note1s, note2: note2s, notes3: notes3s, notes4: notes4s,
    notes5: notes5s, userCustom1: userCustom1s, userCustom2: userCustom2s, userCustom3: userCustom3s,
    userCustom4: userCustom4s, userCustom5: userCustom5s
  };

  const rowOrderForMain = new Uint32Array(totalRows);
  for (let i = 0; i < totalRows; i++) rowOrderForMain[i] = i;
  currentRowOrder = new Uint32Array(rowOrderForMain);

  // 7. Prepare and send response (Zero-Copy Transfer)
  const response: LogisticsDataChunk & { _workerSendTime: number } = {
    numericColumns,
    dictColumns,
    dictMaps,
    stringColumns,
    rowOrder: rowOrderForMain,
    totalRows,
    _workerSendTime: performance.now()
  };

  sortNumericColumns = cloneTypedColumnViews(numericColumns);
  sortDictColumns = cloneTypedColumnViews(dictColumns);

  const transferables: Transferable[] = [rowOrderForMain.buffer];
  Object.values(numericColumns).forEach(arr => transferables.push(arr.buffer as ArrayBuffer));
  Object.values(dictColumns).forEach(arr => transferables.push(arr.buffer as ArrayBuffer));

  postMessage({ type: 'DATA_LOADED', payload: response }, transferables);
  
  console.timeEnd('Worker: Arrow Table Generation');
  console.log(`Worker: Arrow Table Created as Source of Truth. Zero-Copy Transfer Initiated.`);
};

// Handle messages from main thread
addEventListener('message', ({ data }: { data: WorkerRequest }) => {
  switch (data.type) {
    case 'LOAD_DATA':
      releaseWorkerDataset();
      initAndLoad();
      break;
    case 'SORT': {
      const payload = data.payload;
      if (!currentRowOrder) {
        break;
      }
      console.time('worker-sort');
      const chunk = {
        numericColumns: sortNumericColumns ?? numericColumns,
        dictColumns: sortDictColumns ?? dictColumns,
        dictMaps,
        stringColumns,
      };
      let sorted: Uint32Array;
      let seq: number;

      if (isSimpleSortPayload(payload)) {
        seq = payload.seq;
        sorted = sortRowOrderBySingleColumn(
          chunk,
          currentRowOrder,
          payload.column,
          payload.direction,
          undefined,
          { logPerformance: false }
        );
      } else {
        const rp = payload as SortRequestPayload;
        seq = rp.seq;
        if (!rp.model?.length) {
          postMessage({
            type: 'SORT_COMPLETE',
            payload: { rowOrder: new Uint32Array(currentRowOrder), seq },
          });
          console.timeEnd('worker-sort');
          break;
        }
        sorted = sortRowOrderByModel(chunk, currentRowOrder, rp.model, undefined, {
          timeLabel: null,
          logPerformance: false,
        });
      }

      const workerCopy = new Uint32Array(sorted);
      postMessage(
        { type: 'SORT_COMPLETE', payload: { rowOrder: sorted, seq } },
        [sorted.buffer]
      );
      currentRowOrder = workerCopy;
      console.timeEnd('worker-sort');
      break;
    }
    case 'SEARCH': {
      const payload = data.payload as {
        query: string;
        seq: number;
        sortModel?: SortDescriptor[];
      };
      if (!sortNumericColumns || !sortDictColumns || dataTotalRows === 0) {
        break;
      }
      console.time('worker-search');
      const chunk = {
        numericColumns: sortNumericColumns,
        dictColumns: sortDictColumns,
        dictMaps,
        stringColumns,
      };
      const candidate = columnFilterBase ?? undefined;
      const filtered = filterRowIndicesByGlobalSearch(
        chunk,
        dataTotalRows,
        payload.query,
        candidate
      );
      const sortModel = payload.sortModel ?? [];
      const ordered =
        sortModel.length > 0
          ? sortRowOrderByModel(chunk, filtered, sortModel, undefined, {
              timeLabel: null,
              logPerformance: false,
            })
          : new Uint32Array(filtered);
      const workerCopy = new Uint32Array(ordered);
      postMessage(
        {
          type: 'SEARCH_COMPLETE',
          payload: { rowOrder: ordered, seq: payload.seq },
        },
        [ordered.buffer]
      );
      currentRowOrder = workerCopy;
      console.timeEnd('worker-search');
      break;
    }
    case 'COLUMN_FILTER': {
      const payload = data.payload as ColumnFilterPayload;
      if (!sortNumericColumns || !sortDictColumns || dataTotalRows === 0 || !currentRowOrder) {
        break;
      }
      console.time('worker-filter');
      const chunk = {
        numericColumns: sortNumericColumns,
        dictColumns: sortDictColumns,
        dictMaps,
        stringColumns,
      };
      const sortModel = payload.sortModel ?? [];
      if (!payload.filters?.length) {
        columnFilterBase = null;
      } else {
        const filtered = filterRowsByColumnFilters(
          chunk,
          dataTotalRows,
          payload.filters
        );
        columnFilterBase = new Uint32Array(filtered);
      }

      const searchQuery = (payload.searchQuery ?? '').trim();
      let visible: Uint32Array;
      if (searchQuery) {
        visible = filterRowIndicesByGlobalSearch(
          chunk,
          dataTotalRows,
          searchQuery,
          columnFilterBase ?? undefined
        );
      } else if (columnFilterBase) {
        visible = new Uint32Array(columnFilterBase);
      } else {
        visible = new Uint32Array(dataTotalRows);
        for (let i = 0; i < dataTotalRows; i++) visible[i] = i;
      }

      const ordered =
        sortModel.length > 0
          ? sortRowOrderByModel(chunk, visible, sortModel, undefined, {
              timeLabel: null,
              logPerformance: false,
            })
          : new Uint32Array(visible);
      const workerCopy = new Uint32Array(ordered);
      postMessage(
        {
          type: 'FILTER_COMPLETE',
          payload: { rowOrder: ordered, seq: payload.seq },
        },
        [ordered.buffer]
      );
      currentRowOrder = workerCopy;
      console.timeEnd('worker-filter');
      break;
    }
    case 'CELL_EDIT': {
      const payload = data.payload as CellEditPayload;
      if (!sortNumericColumns || dataTotalRows === 0) {
        postMessage({
          type: 'CELL_EDIT_COMPLETE',
          payload: { ok: false, error: 'worker not ready' },
        });
        break;
      }
      const { physicalRowIndex, column, value } = payload;
      if (column !== 'rNo' && column !== 'sOLNo') {
        postMessage({
          type: 'CELL_EDIT_COMPLETE',
          payload: { ok: false, error: 'invalid column' },
        });
        break;
      }
      if (physicalRowIndex < 0 || physicalRowIndex >= dataTotalRows) {
        postMessage({
          type: 'CELL_EDIT_COMPLETE',
          payload: { ok: false, error: 'invalid row' },
        });
        break;
      }
      console.time('worker-cell-edit');
      const arr = sortNumericColumns[column];
      if (!arr) {
        console.timeEnd('worker-cell-edit');
        postMessage({
          type: 'CELL_EDIT_COMPLETE',
          payload: { ok: false, error: 'unknown column' },
        });
        break;
      }
      arr[physicalRowIndex] = value;
      console.timeEnd('worker-cell-edit');
      postMessage({
        type: 'CELL_EDIT_COMPLETE',
        payload: { ok: true, physicalRowIndex, column, value },
      });
      break;
    }
    case 'EXPORT_CSV': {
      const payload = data.payload as ExportCsvPayload;
      if (!payload?.columns?.length) {
        postMessage({
          type: 'EXPORT_CSV_COMPLETE',
          payload: { csvText: '', seq: payload?.seq ?? 0 },
        });
        break;
      }
      if (!sortNumericColumns || !sortDictColumns || !currentRowOrder) {
        postMessage({
          type: 'EXPORT_CSV_COMPLETE',
          payload: { csvText: '', seq: payload.seq },
        });
        break;
      }
      console.time('worker-csv-export');
      const csvText = buildCsvFromColumnarData(
        currentRowOrder,
        payload.columns,
        sortNumericColumns,
        sortDictColumns,
        dictMaps,
        stringColumns
      );
      console.timeEnd('worker-csv-export');
      postMessage({
        type: 'EXPORT_CSV_COMPLETE',
        payload: { csvText, seq: payload.seq },
      });
      break;
    }
    case 'EXPORT_JSON': {
      const payload = data.payload as ExportJsonPayload;
      if (!payload?.columns?.length) {
        postMessage({
          type: 'EXPORT_JSON_COMPLETE',
          payload: { jsonText: '[]', seq: payload?.seq ?? 0 },
        });
        break;
      }
      if (!sortNumericColumns || !sortDictColumns || !currentRowOrder) {
        postMessage({
          type: 'EXPORT_JSON_COMPLETE',
          payload: { jsonText: '[]', seq: payload.seq },
        });
        break;
      }
      console.time('worker-json-export');
      const jsonText = buildJsonFromColumnarData(
        currentRowOrder,
        payload.columns,
        sortNumericColumns,
        sortDictColumns,
        dictMaps,
        stringColumns
      );
      console.timeEnd('worker-json-export');
      postMessage({
        type: 'EXPORT_JSON_COMPLETE',
        payload: { jsonText, seq: payload.seq },
      });
      break;
    }
    default:
      break;
  }
});
