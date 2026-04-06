/**
 * Wijmo FlexGridFilter._init registers rowEditEnding / cellEditEnded handlers that call
 * _excludeRowFromFilter(rowIndex). The stock implementation reads `grid.rows[rowIndex].dataItem`
 * without ensuring `rows[rowIndex]` exists. With virtualization + proxy row models, that slot
 * can be undefined when selection changes during commit, causing:
 *   TypeError: Cannot read properties of undefined (reading 'dataItem')
 *
 * This module replaces FlexGridFilter.prototype._init with an equivalent that guards `rows[i]`.
 * Import for side effects before constructing FlexGridFilter.
 */
import { FlexGridFilter } from '@mescius/wijmo.grid.filter';
import type { FlexGrid } from '@mescius/wijmo.grid';
import { _NewRowTemplate } from '@mescius/wijmo.grid';

const P = FlexGridFilter.prototype as FlexGridFilter & { _init(): void };
const mark = P as unknown as { __logisticsVirtualPatch?: boolean };

if (!mark.__logisticsVirtualPatch) {
  mark.__logisticsVirtualPatch = true;

  P._init = function (this: FlexGridFilter) {
    const filter = this;
    const _excludeRowFromFilter = (rowIndex: number) => {
      const g = filter.grid;
      const excluded = filter.excludedRowsSet;
      if (g == null || rowIndex < 0 || rowIndex >= g.rows.length) {
        return;
      }
      const row = g.rows[rowIndex];
      if (!row) {
        return;
      }
      if (!g.itemsSource) {
        excluded.add(row);
        return;
      }
      if (row instanceof _NewRowTemplate) {
        const cv = g.editableCollectionView;
        const n = cv?.currentAddItem ?? row.dataItem;
        if (n) {
          excluded.add(n);
        }
      } else if (row.dataItem) {
        excluded.add(row.dataItem);
      }
    };

    const grid = filter.grid;
    const g = grid as FlexGrid & {
      rowChanged?: { addHandler(fn: (s: FlexGrid, t: { added?: boolean; index: number }) => void): void };
    };
    if (g.rowChanged) {
      g.rowChanged.addHandler((_s: FlexGrid, t: { added?: boolean; index: number }) => {
        if (t.added) {
          _excludeRowFromFilter(t.index);
        }
      });
    }
    grid.rowEditEnding.addHandler((_s: FlexGrid, e) => {
      _excludeRowFromFilter(e.row);
    });
    grid.cellEditEnded.addHandler((_s: FlexGrid, e) => {
      _excludeRowFromFilter(e.row);
    });
  };
}
