/**
 * Optional materialization of flat columnar data into plain objects (e.g. for APIs, logging).
 * Does not allocate per row until called — use sparingly on large grids.
 */

import type { LogisticsDataChunk } from './logistics.types';
import { ORG_RT_MONDAY_FLAT, ORG_RT_TUESDAY_FLAT } from './logistics.types';

/** Snapshot of nested `orgRt` built from flat TypedArrays. */
export interface RowObjectSnapshot {
  orgRt: {
    monday: number;
    tuesday: number;
  };
}

/**
 * Reads `orgRt_monday` / `orgRt_tuesday` at a physical row into a nested shape.
 * @param physicalIndex - Index into TypedArrays (not view index)
 * @param numericColumns - Chunk numeric column map
 */
export function buildOrgRtSnapshot(
  physicalIndex: number,
  numericColumns: LogisticsDataChunk['numericColumns']
): RowObjectSnapshot['orgRt'] {
  const mon = numericColumns[ORG_RT_MONDAY_FLAT];
  const tue = numericColumns[ORG_RT_TUESDAY_FLAT];
  return {
    monday:
      mon != null && physicalIndex >= 0 && physicalIndex < mon.length
        ? mon[physicalIndex]!
        : 0,
    tuesday:
      tue != null && physicalIndex >= 0 && physicalIndex < tue.length
        ? tue[physicalIndex]!
        : 0,
  };
}

/**
 * Builds `{ orgRt: { monday, tuesday } }` from flat columns at a physical row.
 */
export function buildRowObjectSnapshot(
  physicalIndex: number,
  numericColumns: LogisticsDataChunk['numericColumns']
): RowObjectSnapshot {
  return { orgRt: buildOrgRtSnapshot(physicalIndex, numericColumns) };
}
