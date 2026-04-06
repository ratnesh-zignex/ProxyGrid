// OpenLayers flat style typing for WebGL vector circle symbolizer
import type { FlatStyle } from 'ol/style/flat';
// Shared columnar dataset shape (main thread after worker DATA_LOADED)
import type { LogisticsDataChunk } from './logistics.types';

/** Dropdown values → columnar bindings (numeric or dictionary). */
export type ColorByMode =
  | 'none' // single default point color, no colorCat on features
  | 'rNo' // route number column (numeric)
  | 'sOLNo' // load number column (numeric)
  | 'materialType' // dictionary-encoded string column
  | 'srvcUnitFrqByWk' // service frequency (numeric)
  | 'uVolVal'; // container / size column (numeric)

// UI labels bound to ColorByMode values for the map <select>
export const MAP_COLOR_BY_OPTIONS: { value: ColorByMode; label: string }[] = [
  { value: 'none', label: 'None' }, // disable categorical styling
  { value: 'rNo', label: 'Route Number' },
  { value: 'sOLNo', label: 'Load Number' },
  { value: 'materialType', label: 'Material Type' },
  { value: 'srvcUnitFrqByWk', label: 'Service Frequency' },
  { value: 'uVolVal', label: 'Container Size' },
];

/** Distinct palette for categorical WebGL `match` (bounded branch count). */
export const MAP_COLOR_PALETTE = [
  '#2563eb', // blue
  '#dc2626', // red
  '#16a34a', // green
  '#ca8a04', // amber
  '#9333ea', // purple
  '#0891b2', // cyan
  '#ea580c', // orange
  '#db2777', // pink
  '#4f46e5', // indigo
  '#059669', // emerald
  '#b45309', // brown
  '#0d9488', // teal
  '#7c3aed', // violet
  '#e11d48', // rose
  '#64748b', // slate
  '#0e7490', // dark cyan
] as const;

// Number of discrete colors in MAP_COLOR_PALETTE (used by hash modulo)
const PALETTE_LEN = MAP_COLOR_PALETTE.length;

/**
 * Stable bucket 0..PALETTE_LEN-1 for any string category (consistent colors per value).
 */
export function hashCategoryToPaletteIndex(category: string): number {
  if (!category) return 0; // empty category maps to first palette slot
  let h = 2166136261; // FNV-1a offset basis
  for (let i = 0; i < category.length; i++) {
    h ^= category.charCodeAt(i); // XOR next character
    h = Math.imul(h, 16777619); // FNV-1a prime multiply
  }
  return Math.abs(h) % PALETTE_LEN; // bucket into palette size
}

/**
 * Read a display category string for a physical row from the columnar chunk.
 */
export function readColorByCategory(
  chunk: LogisticsDataChunk,
  mode: Exclude<ColorByMode, 'none'>,
  phys: number,
): string {
  if (mode === 'materialType') {
    const dict = chunk.dictColumns['materialType']; // per-row dictionary code
    const map = chunk.dictMaps['materialType']; // code → display string
    if (!dict || !map) return ''; // column missing
    const idx = dict[phys]; // dictionary index for this physical row
    if (idx == null || idx < 0 || idx >= map.length) return ''; // out of range
    return String(map[idx] ?? ''); // resolve to label for hashing
  }
  const col = chunk.numericColumns[mode]; // typed array for numeric color-by columns
  if (!col || phys < 0 || phys >= col.length) return ''; // bounds / missing
  const v = col[phys]; // raw cell value
  if (v == null || (typeof v === 'number' && Number.isNaN(v))) return ''; // skip invalid
  return String(v); // normalize to string for stable hash input
}

/** Feature property used by WebGL style expressions (integer bucket). */
export const COLOR_CAT_PROP = 'colorCat';

/**
 * Default single-color WebGL flat style (no per-feature props).
 */
export function buildWebGLDefaultPointStyle(): FlatStyle {
  return {
    'circle-radius': 6, // point radius in CSS pixels
    'circle-fill-color': 'rgba(0, 90, 220, 0.9)', // solid blue when Color By = None
    'circle-stroke-color': '#ffffff', // white ring for contrast on basemap
    'circle-stroke-width': 1, // stroke thickness
  };
}

/**
 * WebGL flat style: `circle-fill-color` uses `match` on `colorCat` (0..PALETTE_LEN-1).
 */
export function buildWebGLCategoricalPointStyle(): FlatStyle {
  const pairs: unknown[] = []; // interleaved [index, color, ...] for OL match expr
  for (let i = 0; i < PALETTE_LEN; i++) {
    pairs.push(i, MAP_COLOR_PALETTE[i]); // map palette index → hex color
  }
  const colorExpr: unknown[] = [
    'match', // OpenLayers expression: switch on first arg
    ['get', COLOR_CAT_PROP], // read integer bucket from feature
    ...pairs, // all index/color pairs
    MAP_COLOR_PALETTE[0], // fallback if colorCat missing or unmatched
  ];
  return {
    'circle-radius': 6, // same geometry as default mode
    'circle-fill-color': colorExpr as FlatStyle['circle-fill-color'], // expression-typed for TS
    'circle-stroke-color': '#ffffff', // keep stroke consistent
    'circle-stroke-width': 1,
  };
}
