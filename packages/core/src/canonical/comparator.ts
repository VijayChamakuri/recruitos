import { z } from "zod";

export const OrderingSchema = z.union([z.literal(-1), z.literal(0), z.literal(1)]);
export type Ordering = z.infer<typeof OrderingSchema>;

export type Comparator<T> = (left: T, right: T) => Ordering;

export function compareBigInt(left: bigint, right: bigint): Ordering {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareSafeInteger(left: number, right: number): Ordering {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareCodeUnits(left: string, right: string): Ordering {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareBy<T, U>(
  select: (value: T) => U,
  comparator: Comparator<U>
): Comparator<T> {
  return (left, right) => comparator(select(left), select(right));
}

export function combineComparators<T>(...comparators: readonly Comparator<T>[]): Comparator<T> {
  return (left, right) => {
    for (const comparator of comparators) {
      const ordering = comparator(left, right);
      if (ordering !== 0) {
        return ordering;
      }
    }
    return 0;
  };
}

export function reverseComparator<T>(comparator: Comparator<T>): Comparator<T> {
  return (left, right) => {
    const ordering = comparator(left, right);
    return ordering === 0 ? 0 : ordering === 1 ? -1 : 1;
  };
}

export function sortDeterministically<T>(
  values: readonly T[],
  comparator: Comparator<T>
): readonly T[] {
  return [...values].sort(comparator);
}
