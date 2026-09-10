/**
 * Safely parse a value to a float, returning 0 for empty/null/undefined/NaN.
 * Use when 0 is a safe default (e.g. summing inputs where missing = "no contribution").
 */
export const safeParseFloat = (value: string | number | null | undefined): number => {
  if (value === "" || value === null || value === undefined) return 0;
  const parsed = parseFloat(String(value));
  return isNaN(parsed) ? 0 : parsed;
};

/**
 * Safely parse a value to a float, returning null for empty/null/undefined/NaN.
 * Use when you need to distinguish "missing input" from "zero" (e.g. required lab values).
 */
export const safeParseFloatOrNull = (value: string | number | null | undefined): number | null => {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = parseFloat(String(value));
  return isNaN(parsed) ? null : parsed;
};
