/**
 * Formats a rubric weight percentage for people. Repeating floats such as
 * 8.333333333333332 become 8.3. Whole values stay without a decimal.
 */
export function formatWeightPercent(weight: number): string {
  if (!Number.isFinite(weight)) {
    return "n/a";
  }
  const rounded = Math.round(weight * 10) / 10;
  if (Number.isInteger(rounded)) {
    return `${rounded.toFixed(0)}%`;
  }
  return `${rounded.toFixed(1)}%`;
}
