import { culture, DataType } from '@mescius/wijmo';
import type { CellRangeEventArgs } from '@mescius/wijmo.grid';
import type { FlexGridFilter } from '@mescius/wijmo.grid.filter';
import { Operator } from '@mescius/wijmo.grid.filter';

/**
 * Default condition operator when the user opens the filter editor (condition tab).
 * Matches Wijmo {@link DataType} on the column.
 */
export function defaultOperatorForDataType(dataType: DataType | null | undefined): Operator | null {
  switch (dataType) {
    case DataType.String:
      return Operator.CT;
    case DataType.Number:
      return Operator.EQ;
    case DataType.Date:
      return Operator.EQ;
    case DataType.Boolean:
      return Operator.EQ;
    default:
      return null;
  }
}

/**
 * Sets {@link ConditionFilter.condition1} operator when the column has no active condition filter yet,
 * so the first edit starts with a sensible default (Contains vs Equals, etc.).
 */
export function applyDefaultConditionOperatorsForEditing(
  flex: FlexGridFilter,
  e: CellRangeEventArgs
): void {
  const col = e.getColumn?.(true);
  if (!col) return;
  const cf = flex.getColumnFilter(col, true);
  const cond = cf.conditionFilter;
  if (cond.isActive) return;
  const op = defaultOperatorForDataType(col.dataType);
  if (op != null) {
    cond.condition1.operator = op;
  }
}

/**
 * Customizes Excel-style condition filter operator dropdowns via `culture.FlexGridFilter`
 * (see Wijmo {@link ConditionFilterEditor} / `_createOperatorCombo`).
 * Call once after `@mescius/wijmo.grid.filter` is loaded, before creating {@link FlexGridFilter}.
 */
export function applyFlexGridFilterCultureOperators(): void {
  const filter = culture.FlexGridFilter ?? (culture.FlexGridFilter = {});

  filter.stringOperators = [
    { name: '(not set)', op: null },
    { name: 'Contains', op: Operator.CT },
    { name: 'Equals', op: Operator.EQ },
    { name: 'Does not equal', op: Operator.NE },
  ];

  filter.numberOperators = [
    { name: '(not set)', op: null },
    { name: 'Equals', op: Operator.EQ },
    { name: 'Does not equal', op: Operator.NE },
    { name: 'Is bigger than', op: Operator.GT },
    { name: 'Is smaller than', op: Operator.LT },
    { name: 'Is Greater than or equal to', op: Operator.GE },
  ];

  filter.dateOperators = [
    { name: '(not set)', op: null },
    { name: 'Equals', op: Operator.EQ },
    { name: 'Is earlier than', op: Operator.LT },
    { name: 'Is later than', op: Operator.GT },
  ];

  filter.booleanOperators = [
    { name: '(not set)', op: null },
    { name: 'Is', op: Operator.EQ },
    { name: 'Is not', op: Operator.NE },
  ];
}
