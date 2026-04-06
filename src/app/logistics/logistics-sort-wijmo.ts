import { SortDescription } from '@mescius/wijmo';
import type { ICollectionView } from '@mescius/wijmo';
import type { SortDescriptor, SortDirection } from './logistics.types';

/**
 * Next sort model after a header click.
 * - **`multiColumn === false`**: only this column (asc on first click, then asc/desc
 *   toggle if it is already the sole sort key).
 * - **`multiColumn === true`** (hold **Shift**): append this column, or toggle its
 *   direction if it is already in the sort list.
 */
export function computeNextSortModel(
  current: readonly SortDescriptor[],
  binding: string,
  multiColumn: boolean
): SortDescriptor[] {
  if (!binding) return [...current];

  if (!multiColumn) {
    const single = current.length === 1 && current[0].property === binding;
    if (single) {
      const dir: SortDirection =
        current[0].direction === 'asc' ? 'desc' : 'asc';
      return [{ property: binding, direction: dir }];
    }
    return [{ property: binding, direction: 'asc' as const }];
  }

  const idx = current.findIndex((s) => s.property === binding);
  if (idx >= 0) {
    const next: SortDescriptor[] = current.map((s, i) =>
      i === idx
        ? {
            ...s,
            direction: (s.direction === 'asc' ? 'desc' : 'asc') as SortDirection,
          }
        : s
    );
    return next;
  }
  return [...current, { property: binding, direction: 'asc' as const }];
}

/** Keep Wijmo header glyphs in sync; does not sort items (CV _performSort is a no-op). */
export function syncCollectionViewSortDescriptions(
  cv: ICollectionView,
  model: readonly SortDescriptor[]
): void {
  const sd = cv.sortDescriptions;
  sd.clear();
  for (const s of model) {
    sd.push(new SortDescription(s.property, s.direction === 'asc'));
  }
}
