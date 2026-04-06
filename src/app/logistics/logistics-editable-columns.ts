/** Inline-editable numeric column bindings (main + worker TypedArrays). */
export const EDITABLE_NUMERIC_COLUMN_BINDINGS = ['rNo', 'sOLNo'] as const;
export type EditableNumericColumnBinding = (typeof EDITABLE_NUMERIC_COLUMN_BINDINGS)[number];

export function isEditableNumericColumn(binding: string): binding is EditableNumericColumnBinding {
  return binding === 'rNo' || binding === 'sOLNo';
}

/** Coerce user input to a value suitable for Uint32Array storage. */
export function coerceToUint32(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  if (r < 0) return null;
  return r >>> 0;
}
