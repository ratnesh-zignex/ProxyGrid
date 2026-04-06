import { FlexGridFilter, Operator } from '@mescius/wijmo.grid.filter';
import type { ColumnFilterOperator, SerializedColumnFilter } from './logistics.types';

function mapOperator(op: Operator): ColumnFilterOperator {
  switch (op) {
    case Operator.EQ:
      return 'equals';
    case Operator.NE:
      return 'notEquals';
    case Operator.GT:
      return 'greaterThan';
    case Operator.GE:
      return 'greaterOrEqual';
    case Operator.LT:
      return 'lessThan';
    case Operator.LE:
      return 'lessOrEqual';
    case Operator.BW:
      return 'startsWith';
    case Operator.EW:
      return 'endsWith';
    case Operator.CT:
      return 'contains';
    case Operator.NC:
      return 'notContains';
    case Operator.BLANK:
      return 'isBlank';
    case Operator.NOTBLANK:
      return 'isNotBlank';
    default:
      return 'contains';
  }
}

/**
 * Reads active Wijmo {@link FlexGridFilter} state into worker-safe descriptors.
 */
export function serializeFlexGridColumnFilters(fgFilter: FlexGridFilter): SerializedColumnFilter[] {
  const grid = fgFilter.grid;
  const out: SerializedColumnFilter[] = [];

  for (let i = 0; i < grid.columns.length; i++) {
    const col = grid.columns[i];
    const binding = col.binding as string | undefined;
    if (!binding) continue;

    const cf = fgFilter.getColumnFilter(col, false);
    if (!cf || !cf.isActive) continue;

    const sf: SerializedColumnFilter = { column: binding, conditions: [] };

    const cond = cf.conditionFilter;
    if (cond.isActive) {
      if (cond.condition1.isActive) {
        sf.conditions.push({
          operator: mapOperator(cond.condition1.operator),
          value: cond.condition1.value as string | number | null,
        });
      }
      if (cond.condition2.isActive) {
        sf.conditions.push({
          operator: mapOperator(cond.condition2.operator),
          value: cond.condition2.value as string | number | null,
        });
      }
      sf.orAcrossConditions = !cond.and;
    }

    const vf = cf.valueFilter;
    if (vf.isActive) {
      const sv = vf.showValues as Record<string, boolean> | null;
      if (sv && typeof sv === 'object') {
        sf.valueWhitelist = Object.keys(sv).filter((k) => sv[k]);
      } else {
        sf.valueWhitelist = [];
      }
    }

    out.push(sf);
  }

  return out;
}
