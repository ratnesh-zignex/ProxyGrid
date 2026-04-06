// Angular component, DOM ref, lifecycle hook, DI tokens, reactive primitives
import {
  Component, // @Component decorator
  ElementRef, // wrapper for native map container element
  OnDestroy, // teardown hook for WebGL + listeners
  ViewChild, // query #mapEl after view init
  inject, // constructor-less DI
  PLATFORM_ID, // 'browser' vs 'server' for SSR
  effect, // sync chunk/colorBy → vector source + style
  signal, // mapReady, counts, colorBy
  afterNextRender, // defer OL init until layout painted
} from '@angular/core';
// *ngIf, isPlatformBrowser guard
import { CommonModule, isPlatformBrowser } from '@angular/common';
// OpenLayers map core (pan/zoom, layers, events)
import Map from 'ol/Map';
// View: center, resolution, projection
import View from 'ol/View';
// Raster tiles underneath vectors
import TileLayer from 'ol/layer/Tile';
// GPU-accelerated vector rendering for many points
import WebGLVectorLayer from 'ol/layer/WebGLVector';
// OpenStreetMap XYZ tile source
import OSM from 'ol/source/OSM';
// In-memory feature store for points
import VectorSource from 'ol/source/Vector';
// Geo feature with geometry + properties
import Feature from 'ol/Feature';
// Point geometry in map projection (EPSG:3857)
import Point from 'ol/geom/Point';
// WGS84 lon/lat → Web Mercator for OL default view
import { fromLonLat } from 'ol/proj';
// Min bounding box of all point coords for fit()
import { boundingExtent } from 'ol/extent';
// Loads chunk, exposes data() signal, selection API
import { LogisticsDataService } from './logistics-data.service';
// Typed chunk: numericColumns, dictColumns, rowOrder, …
import type { LogisticsDataChunk } from './logistics.types';
// Color-by palette, styles, chunk readers, feature prop name
import {
  MAP_COLOR_BY_OPTIONS, // dropdown rows
  COLOR_CAT_PROP, // 'colorCat' on Feature for WebGL match
  type ColorByMode, // union of allowed color dimensions
  buildWebGLCategoricalPointStyle, // flat style with match expression
  buildWebGLDefaultPointStyle, // flat style single fill color
  hashCategoryToPaletteIndex, // string category → 0..15
  readColorByCategory, // phys row → category string from chunk
} from './logistics-map-webgl-style';

/** Upper bound on plotted points (avoids accidental runaway if rowOrder is huge). */
const MAX_MAP_POINTS = 150_000;

/** Console prefix for map timing logs. */
const MAP_PERF = '[MapPerf]';

/**
 * OpenLayers map: OSM basemap + WebGL vector points from worker chunk (lat/lon).
 * Color By uses flat style expressions + lazy `colorCat` on features (main-thread TypedArrays).
 */
@Component({
  selector: 'app-logistics-map', // host element tag
  standalone: true, // no NgModule
  imports: [CommonModule], // *ngFor, *ngIf, number pipe
  template: `
    <!-- Root fills host; holds map div + floating UI -->
    <div class="map-shell">
      <!-- OpenLayers renders into this element (must stay in DOM for ViewChild) -->
      <div #mapEl class="map-container"></div>
      <!-- Browser-only: controls + stats (SSR skips) -->
      <div class="map-ui-overlay" *ngIf="isBrowser">
        <!-- Color By dropdown (top-right) -->
        <label class="map-color-by">
          <span class="map-color-by__label">Color By</span>
          <select
            class="map-color-by__select"
            [value]="colorBy()"
            (change)="onColorByChange($event)"
            aria-label="Color points by attribute"
          >
            <option *ngFor="let opt of colorByOptions" [value]="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </label>
        <!-- Point counts vs current rowOrder (top-left) -->
        <div class="map-customer-count" aria-live="polite">
          <div class="map-customer-count__value">
            {{ customerPointsInView() | number }}
          </div>
          <div class="map-customer-count__label">customer points in view</div>
          <div
            class="map-customer-count__sample"
            *ngIf="customerPointsPlotted() < customerPointsInView()"
          >
            {{ customerPointsPlotted() | number }} shown on map (sampled)
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      /* Host participates in flex parents (map panel full height) */
      :host {
        display: block;
        height: 100%;
        width: 100%;
        min-height: 0;
        overflow: hidden;
      }
      /* Positioning context for map + overlays */
      .map-shell {
        position: relative;
        width: 100%;
        height: 100%;
        min-height: 0;
      }
      /* OL target: stretch to shell */
      .map-container {
        width: 100%;
        height: 100%;
        min-height: 0;
      }
      /* Full-bleed overlay; pointer-events off except children */
      .map-ui-overlay {
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 10;
      }
      /* Color By card: re-enable clicks */
      .map-color-by {
        pointer-events: auto;
        position: absolute;
        top: 10px;
        right: 10px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 8px 10px;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.95);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
        border: 1px solid rgba(0, 0, 0, 0.08);
        font-size: 12px;
      }
      .map-color-by__label {
        font-weight: 600;
        color: #334155;
      }
      .map-color-by__select {
        min-width: 160px;
        padding: 6px 8px;
        font-size: 12px;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        background: #fff;
        color: #0f172a;
        cursor: pointer;
      }
      /* Stats panel: no hit capture */
      .map-customer-count {
        position: absolute;
        left: 10px;
        top: 10px;
        pointer-events: none;
        padding: 8px 12px;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.92);
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
        font-size: 12px;
        line-height: 1.35;
        max-width: min(240px, calc(100% - 20px));
      }
      .map-customer-count__value {
        font-size: 18px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: #0a1628;
      }
      .map-customer-count__label {
        color: #5a6570;
        margin-top: 2px;
      }
      .map-customer-count__sample {
        margin-top: 6px;
        padding-top: 6px;
        border-top: 1px solid rgba(0, 0, 0, 0.08);
        color: #6b7280;
        font-size: 11px;
      }
    `,
  ],
})
export class LogisticsMapComponent implements OnDestroy {
  // Template ref to .map-container (OpenLayers target)
  @ViewChild('mapEl') mapElement!: ElementRef<HTMLDivElement>;

  readonly service = inject(LogisticsDataService); // chunk + worker-backed data()
  private readonly platformId = inject(PLATFORM_ID); // SSR vs browser
  readonly isBrowser = isPlatformBrowser(this.platformId); // gate UI + OL init

  readonly colorByOptions = MAP_COLOR_BY_OPTIONS; // template *ngFor source
  /** Attribute used for WebGL point coloring. */
  readonly colorBy = signal<ColorByMode>('none'); // drives effect + select binding

  private map: Map | null = null; // OpenLayers Map instance
  private vectorSource: VectorSource | null = null; // Feature store
  private vectorLayer: WebGLVectorLayer<VectorSource> | null = null; // WebGL point layer
  private resizeMapHandler: (() => void) | null = null; // window resize callback ref
  private resizeObserver: ResizeObserver | null = null; // container size → updateSize
  private initAttempts = 0; // retry budget for zero-size container
  private readonly mapReady = signal(false); // true after vectorSource + layer exist
  /** Set after a full feature build; used to skip rebuild when only `colorBy` changes. */
  private lastRenderedChunk: LogisticsDataChunk | null = null;

  readonly customerPointsInView = signal(0); // logical rows with valid lat/lon
  readonly customerPointsPlotted = signal(0); // actual feature count on map

  /** Log elapsed ms since `since` and return `performance.now()` for the next segment. */
  private mapPerfSegment(phase: string, since: number, detail?: string): number {
    if (!this.isBrowser) return performance.now();
    const ms = performance.now() - since;
    const tail = detail ? ` | ${detail}` : '';
    console.log(`${MAP_PERF} ${phase}: ${ms.toFixed(2)}ms${tail}`);
    return performance.now();
  }

  constructor() {
    // Rebuild points when chunk changes; update colorCat in place when only colorBy changes
    effect(
      () => {
        const effectT0 = performance.now(); // wall clock for entire effect run
        const chunk = this.service.data(); // reactive LogisticsDataChunk | null
        const colorMode = this.colorBy(); // reactive ColorByMode
        if (!this.mapReady() || !this.vectorSource || !this.vectorLayer) return; // OL not ready
        if (!chunk) {
          const t = performance.now();
          this.lastRenderedChunk = null;
          this.vectorSource.clear(); // drop all features
          this.customerPointsInView.set(0); // reset stats
          this.customerPointsPlotted.set(0);
          this.vectorLayer.setStyle(buildWebGLDefaultPointStyle()); // neutral style
          this.mapPerfSegment('effect: clear + default style (no chunk)', t);
          this.mapPerfSegment('effect TOTAL', effectT0, 'path=no-chunk');
          return;
        }
        const { numericColumns, rowOrder } = chunk; // destructure columnar buffers
        const lats = numericColumns['lat']; // latitude typed array
        const lons = numericColumns['lon']; // longitude typed array
        // Same dataset as last full build: only refresh colorCat + style (no geometry rebuild / fit)
        if (
          chunk === this.lastRenderedChunk &&
          lats &&
          lons &&
          this.vectorSource.getFeatures().length > 0
        ) {
          const t = performance.now();
          this.applyColorByToExistingFeatures(chunk, colorMode);
          this.mapPerfSegment('effect: colorBy-only (in-place props + setStyle)', t, `colorBy=${colorMode}`);
          this.mapPerfSegment('effect TOTAL', effectT0, 'path=colorBy-only');
          return;
        }
        let t = performance.now();
        this.vectorSource.clear(); // remove old features before rebuild
        t = this.mapPerfSegment('vectorSource.clear (before rebuild)', t);
        if (!lats || !lons) {
          this.lastRenderedChunk = chunk;
          this.customerPointsInView.set(0);
          this.customerPointsPlotted.set(0);
          this.vectorLayer.setStyle(buildWebGLDefaultPointStyle());
          this.mapPerfSegment('effect TOTAL', effectT0, 'path=no-lat-lon');
          return;
        }

        t = performance.now();
        let inViewWithCoords = 0; // count valid coords in current rowOrder
        for (let r = 0; r < rowOrder.length; r++) {
          const phys = rowOrder[r]!; // physical row index into lat/lon arrays
          if (phys < 0 || phys >= lats.length || phys >= lons.length) continue; // skip bad index
          const lat = lats[phys]; // read latitude
          const lon = lons[phys]; // read longitude
          if (lat == null || lon == null) continue; // missing values
          if (Number.isNaN(Number(lat)) || Number.isNaN(Number(lon))) continue; // NaN guard
          inViewWithCoords++; // valid point in current view
        }
        this.customerPointsInView.set(inViewWithCoords); // expose to template
        t = this.mapPerfSegment('count in-view rows with valid lat/lon', t, `${inViewWithCoords} rows`);

        t = performance.now();
        const features = this.buildPointFeatures(chunk, rowOrder, lats, lons, colorMode); // one feature per valid row (up to cap)
        t = this.mapPerfSegment('feature creation (buildPointFeatures)', t, `${features.length} features, colorBy=${colorMode}`);

        t = performance.now();
        this.vectorSource.addFeatures(features); // batch add to OL source
        t = this.mapPerfSegment('vectorSource.addFeatures (feature update to source)', t, `${features.length} features`);

        t = performance.now();
        this.vectorLayer.setStyle(
          colorMode === 'none'
            ? buildWebGLDefaultPointStyle() // constant fill
            : buildWebGLCategoricalPointStyle(), // match on colorCat
        );
        t = this.mapPerfSegment('webglVectorLayer.setStyle', t, `mode=${colorMode}`);

        this.customerPointsPlotted.set(features.length); // may be < inView if MAX_MAP_POINTS cap hits

        t = performance.now();
        this.fitMapToFeatures(features); // zoom to data extent
        this.mapPerfSegment('fitMapToFeatures (view animation)', t, `${features.length} feats`);

        this.lastRenderedChunk = chunk;
        this.mapPerfSegment('effect TOTAL', effectT0, `features=${features.length} colorBy=${colorMode}`);
      },
      { allowSignalWrites: true }, // effect updates customerPoints* signals
    );

    if (this.isBrowser) {
      afterNextRender(() => this.scheduleInitMap()); // run after first paint (layout + ViewChild)
    }
  }

  // User changed Color By <select>
  onColorByChange(ev: Event): void {
    const v = (ev.target as HTMLSelectElement).value as ColorByMode; // read option value
    if (this.isBrowser) {
      console.log(`${MAP_PERF} colorBy UI change → "${v}" (triggers effect: in-place props or full rebuild)`);
    }
    this.colorBy.set(v); // triggers effect → update colorCat or full rebuild if chunk changed
  }

  /** Update `colorCat` on each feature from `rowIndex`; unset when Color By is None. */
  private applyColorByToExistingFeatures(chunk: LogisticsDataChunk, colorMode: ColorByMode): void {
    const source = this.vectorSource;
    const layer = this.vectorLayer;
    if (!source || !layer) return;
    for (const f of source.getFeatures()) {
      const phys = f.get('rowIndex');
      if (typeof phys !== 'number') continue;
      if (colorMode === 'none') {
        f.unset(COLOR_CAT_PROP);
      } else {
        const cat = readColorByCategory(chunk, colorMode, phys);
        f.set(COLOR_CAT_PROP, hashCategoryToPaletteIndex(cat));
      }
    }
    layer.setStyle(
      colorMode === 'none' ? buildWebGLDefaultPointStyle() : buildWebGLCategoricalPointStyle(),
    );
  }

  /**
   * Minimal feature payload: geometry + rowIndex + optional colorCat for WebGL expressions.
   * Customer id is set as feature id when available.
   */
  private buildPointFeatures(
    chunk: LogisticsDataChunk,
    rowOrder: Uint32Array,
    lats: Float32Array | Uint32Array | Uint16Array | Uint8Array,
    lons: Float32Array | Uint32Array | Uint16Array | Uint8Array,
    colorMode: ColorByMode,
  ): Feature[] {
    const cids = chunk.numericColumns['cid']; // optional customer id column
    const features: Feature[] = []; // output batch
    for (let i = 0; i < rowOrder.length; i++) {
      if (features.length >= MAX_MAP_POINTS) break;
      const phys = rowOrder[i]!; // logical view order → physical row
      if (phys < 0 || phys >= lats.length || phys >= lons.length) continue;
      const lat = lats[phys];
      const lon = lons[phys];
      if (lat == null || lon == null) continue;
      const f = new Feature(new Point(fromLonLat([Number(lon), Number(lat)]))); // WGS84 → 3857 point
      f.set('rowIndex', phys); // click → selectRowByOriginalIndex
      if (cids && phys < cids.length) {
        f.setId(String(cids[phys])); // stable id from data
      } else {
        f.setId(String(phys)); // fallback to physical index
      }

      if (colorMode !== 'none') {
        const cat = readColorByCategory(chunk, colorMode, phys); // string category from chunk
        f.set(COLOR_CAT_PROP, hashCategoryToPaletteIndex(cat)); // integer for WebGL match
      } else {
        f.unset(COLOR_CAT_PROP); // remove prop when not coloring
      }

      features.push(f); // collect feature
    }
    return features;
  }

  // Wait for DOM + non-zero size before new Map()
  private scheduleInitMap(): void {
    if (!this.isBrowser || this.map) return; // only browser, once
    const el = this.mapElement?.nativeElement; // map container div
    this.initAttempts++; // count scheduling tries
    if (!el) {
      if (this.initAttempts < 30) {
        requestAnimationFrame(() => this.scheduleInitMap()); // retry next frame
      }
      return;
    }
    const w = el.getBoundingClientRect().width; // layout width
    const h = el.getBoundingClientRect().height; // layout height
    if ((w < 2 || h < 2) && this.initAttempts < 60) {
      requestAnimationFrame(() => this.scheduleInitMap()); // flex not sized yet
      return;
    }
    if (this.isBrowser) {
      console.log(`${MAP_PERF} scheduleInitMap → calling initMap (attempts=${this.initAttempts}, size=${w.toFixed(0)}×${h.toFixed(0)})`);
    }
    this.initMap(el); // create OpenLayers map
  }

  // Construct OL Map, layers, listeners, then mapReady = true
  private initMap(el: HTMLDivElement): void {
    if (this.map) return; // idempotent

    const initT0 = performance.now();
    this.vectorSource = new VectorSource({ wrapX: false }); // no world copies

    this.vectorLayer = new WebGLVectorLayer({
      source: this.vectorSource, // GPU layer reads this source
      style: buildWebGLDefaultPointStyle(), // initial flat style
      zIndex: 10, // above OSM tiles
    });

    this.map = new Map({
      target: el, // render into #mapEl
      layers: [new TileLayer({ source: new OSM(), zIndex: 0 }), this.vectorLayer], // basemap + points
      view: new View({
        center: fromLonLat([-98, 39]), // US center until fit()
        zoom: 4, // continental default
      }),
    });

    this.map.on('click', (evt) => {
      const clickT0 = performance.now();
      this.map!.forEachFeatureAtPixel(evt.pixel, (feature) => {
        const phys = feature.get('rowIndex'); // physical row from feature prop
        if (typeof phys === 'number') {
          this.service.selectRowByOriginalIndex(phys); // sync app selection (e.g. grid)
        }
      });
      if (this.isBrowser) {
        console.log(`${MAP_PERF} map click (forEachFeatureAtPixel + select): ${(performance.now() - clickT0).toFixed(2)}ms`);
      }
    });

    this.mapReady.set(true); // allow data effect to populate source

    const resizeMap = () => {
      this.map?.updateSize(); // fix canvas after layout/CSS changes
    };
    this.resizeMapHandler = resizeMap; // store for removeEventListener
    resizeMap(); // immediate
    requestAnimationFrame(() => {
      resizeMap(); // after next paint
      requestAnimationFrame(resizeMap); // one more frame for flex settle
    });
    window.addEventListener('resize', resizeMap); // browser window resize

    this.resizeObserver = new ResizeObserver(() => resizeMap()); // panel split / fullscreen
    this.resizeObserver.observe(el); // watch map container

    if (this.isBrowser) {
      console.log(
        `${MAP_PERF} initMap (VectorSource + WebGLVectorLayer + Map + listeners + mapReady): ${(performance.now() - initT0).toFixed(2)}ms`,
      );
    }
  }

  // Fit view to min bounding box of plotted points
  private fitMapToFeatures(features: Feature[]): void {
    if (!this.map || features.length === 0) return; // nothing to fit
    const t0 = performance.now();
    const coords = features
      .map((f) => {
        const g = f.getGeometry(); // Point in 3857
        if (!g) return null;
        return (g as Point).getCoordinates(); // [x, y]
      })
      .filter((c): c is [number, number] => c != null && c.length >= 2); // type guard
    const t1 = performance.now();
    if (coords.length === 0) return;
    const extent = boundingExtent(coords); // [minX, minY, maxX, maxY]
    const t2 = performance.now();
    if (!extent.every((n) => Number.isFinite(n))) return; // invalid extent guard
    this.map.getView().fit(extent, {
      padding: [48, 48, 48, 48], // inset from edges
      maxZoom: 14, // avoid excessive zoom when extent is tight
      duration: 200, // ms animation
    });
    const t3 = performance.now();
    if (this.isBrowser) {
      console.log(
        `${MAP_PERF} fitMapToFeatures detail: collect coords ${(t1 - t0).toFixed(2)}ms | boundingExtent ${(t2 - t1).toFixed(2)}ms | view.fit ${(t3 - t2).toFixed(2)}ms | n=${coords.length}`,
      );
    }
  }

  // Release WebGL context, listeners, map target
  ngOnDestroy(): void {
    const t0 = performance.now();
    this.lastRenderedChunk = null;
    this.mapReady.set(false); // block effect from writing after teardown
    this.resizeObserver?.disconnect(); // stop ResizeObserver
    this.resizeObserver = null;
    if (this.resizeMapHandler) {
      window.removeEventListener('resize', this.resizeMapHandler); // match addEventListener
      this.resizeMapHandler = null;
    }
    this.map?.setTarget(undefined); // detach OL from DOM
    this.map = null;
    this.vectorSource?.clear(); // drop features before WebGL dispose (release GPU + feature refs)
    this.vectorLayer?.dispose(); // WebGLVectorLayer requires dispose per OL docs
    this.vectorLayer = null;
    this.vectorSource = null;
    if (this.isBrowser) {
      console.log(`${MAP_PERF} ngOnDestroy (teardown): ${(performance.now() - t0).toFixed(2)}ms`);
    }
  }
}
