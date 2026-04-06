/**
 * Maps Wijmo nested column bindings to flat TypedArray keys (TypedArrays cannot use nested paths as keys).
 */

import { ORG_RT_MONDAY_FLAT, ORG_RT_TUESDAY_FLAT } from './logistics.types';

const NESTED_BINDING_TO_FLAT_NUMERIC: Readonly<Record<string, string>> = {
  'orgRt.monday': ORG_RT_MONDAY_FLAT,
  'orgRt.tuesday': ORG_RT_TUESDAY_FLAT,
};

/**
 * Resolves a grid column binding to the key used in `numericColumns` / worker clones.
 * Nested bindings like `orgRt.monday` → `orgRt_monday`; unknown bindings pass through.
 */
export function flatNumericColumnKey(binding: string): string {
  return NESTED_BINDING_TO_FLAT_NUMERIC[binding] ?? binding;
}
