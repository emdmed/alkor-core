/**
 * Pure DKA (Diabetic Ketoacidosis) monitoring functions — shared between React component and CLI.
 *
 * Clinical references:
 * - Glucose targets & resolution criteria: Kitabchi et al., Diabetes Care 2009; ADA 2024
 * - Ketone clearance: Joint British Diabetes Societies (JBDS) Inpatient Care Group, 2023
 * - Insulin adjustment: Savage et al., Diabet Med 2011
 */

import { safeParseFloat } from "./utils/safeParseFloat.ts";

// ─── Clinical Thresholds ─────────────────────────────────────────────

/** Glucose reduction rate targets (per hour) */
const GLUCOSE_TARGET_RATE = { MMOL: 3.0, MGDL: 54 } as const;

/** Glucose thresholds for DKA resolution (Kitabchi et al., Diabetes Care 2009) */
const GLUCOSE_RESOLUTION = { MMOL: 11.1, MGDL: 200 } as const;

/** Glucose threshold for considering insulin dose reduction */
const GLUCOSE_REDUCTION_THRESHOLD = { MMOL: 14, MGDL: 252 } as const;

/** Ketone thresholds (JBDS 2023) */
const KETONE_TARGET_RATE = 0.5;          // mmol/L/hr reduction target
const KETONE_RESOLUTION = 0.6;           // mmol/L — resolved below this

/** Bicarbonate thresholds */
const BICARBONATE_TARGET_RATE = 3.0;     // mmol/L/hr increase target
const BICARBONATE_RESOLUTION = 15;       // mmol/L — resolution criterion

/** pH threshold for DKA resolution */
const PH_RESOLUTION = 7.30;

/** Urine output target */
const URINE_OUTPUT_TARGET = 0.5;         // mL/kg/hr

/** GCS drop threshold for cerebral edema warning */
const GCS_DROP_THRESHOLD = 2;

/** Potassium thresholds (mmol/L) */
const K_CRITICAL_LOW = 3.0;
const K_LOW = 4.0;
const K_HIGH = 5.0;
const K_CRITICAL_HIGH = 6.0;

/**
 * Glucose reduction rate.
 * Target: ≥3.0 mmol/L/hr or ≥54 mg/dL/hr
 */
export const calculateGlucoseReductionRate = (
  current: string,
  previous: string,
  hours: string,
): string | null => {
  const h = safeParseFloat(hours);
  if (h <= 0) return null;
  if (current === "" || previous === "") return null;
  const curr = safeParseFloat(current);
  const prev = safeParseFloat(previous);
  // Rate = (previous - current) / hours  (positive = decreasing, which is good)
  const rate = (prev - curr) / h;
  return rate.toFixed(1);
};

/**
 * Check if glucose reduction rate meets target.
 * Target: ≥3.0 mmol/L/hr (mmol) or ≥54 mg/dL/hr (mgdl)
 */
export const isGlucoseOnTarget = (rate: string | null, unit: "mmol" | "mgdl"): boolean => {
  if (!rate) return false;
  const r = parseFloat(rate);
  if (isNaN(r)) return false;
  return unit === "mmol" ? r >= GLUCOSE_TARGET_RATE.MMOL : r >= GLUCOSE_TARGET_RATE.MGDL;
};

/**
 * Ketone reduction rate.
 * Target: ≥0.5 mmol/L/hr
 */
export const calculateKetoneReductionRate = (
  current: string,
  previous: string,
  hours: string,
): string | null => {
  const h = safeParseFloat(hours);
  if (h <= 0) return null;
  if (current === "" || previous === "") return null;
  const curr = safeParseFloat(current);
  const prev = safeParseFloat(previous);
  const rate = (prev - curr) / h;
  return rate.toFixed(2);
};

/**
 * Check if ketone reduction rate meets target (≥0.5 mmol/L/hr).
 */
export const isKetoneOnTarget = (rate: string | null): boolean => {
  if (!rate) return false;
  const r = parseFloat(rate);
  return !isNaN(r) && r >= KETONE_TARGET_RATE;
};

/**
 * Bicarbonate increase rate.
 * Target: ≥3.0 mmol/L/hr
 */
export const calculateBicarbonateIncreaseRate = (
  current: string,
  previous: string,
  hours: string,
): string | null => {
  const h = safeParseFloat(hours);
  if (h <= 0) return null;
  if (current === "" || previous === "") return null;
  const curr = safeParseFloat(current);
  const prev = safeParseFloat(previous);
  // Rate = (current - previous) / hours  (positive = increasing, which is good)
  const rate = (curr - prev) / h;
  return rate.toFixed(1);
};

/**
 * Check if bicarbonate increase rate meets target (≥3.0 mmol/L/hr).
 */
export const isBicarbonateOnTarget = (rate: string | null): boolean => {
  if (!rate) return false;
  const r = parseFloat(rate);
  return !isNaN(r) && r >= BICARBONATE_TARGET_RATE;
};

/**
 * Classify potassium level.
 */
export const classifyPotassium = (value: string): string => {
  const v = safeParseFloat(value);
  if (v === 0 && value === "") return "Unknown";
  if (v < K_CRITICAL_LOW) return "Critical Low";
  if (v < K_LOW) return "Low";
  if (v <= K_HIGH) return "Normal";
  if (v <= K_CRITICAL_HIGH) return "High";
  return "Critical High";
};

/**
 * Get potassium severity for badge coloring.
 */
export const getPotassiumSeverity = (value: string): string => {
  const v = safeParseFloat(value);
  if (v === 0 && value === "") return "default";
  if (v < K_CRITICAL_LOW) return "critical";
  if (v < K_LOW) return "warning";
  if (v <= K_HIGH) return "normal";
  if (v <= K_CRITICAL_HIGH) return "warning";
  return "critical";
};

/**
 * Calculate urine output rate.
 * Target: ≥0.5 mL/kg/hr
 */
export const calculateUrineOutputRate = (
  volume: string,
  weight: string,
  hours: string,
): string | null => {
  const w = safeParseFloat(weight);
  const h = safeParseFloat(hours);
  if (w <= 0 || h <= 0) return null;
  const vol = safeParseFloat(volume);
  // Rate = volume / (weight × hours) in mL/kg/hr
  const rate = vol / (w * h);
  return rate.toFixed(2);
};

/**
 * Check if urine output rate meets target (≥0.5 mL/kg/hr).
 */
export const isUrineOutputOnTarget = (rate: string | null): boolean => {
  if (!rate) return false;
  const r = parseFloat(rate);
  return !isNaN(r) && r >= URINE_OUTPUT_TARGET;
};

/**
 * Classify GCS (Glasgow Coma Scale).
 */
export const classifyGCS = (value: string): string => {
  const v = safeParseFloat(value);
  if (v === 0 && value === "") return "Unknown";
  if (v < 3 || v > 15) return "Invalid";
  if (v === 15) return "Normal";
  if (v >= 13) return "Mild";
  if (v >= 9) return "Moderate";
  return "Severe";
};

/**
 * Check if GCS is decreasing (drop ≥2 = cerebral edema warning).
 */
export const isGCSDecreasing = (current: string, previous: string): boolean => {
  const curr = safeParseFloat(current);
  const prev = safeParseFloat(previous);
  if (curr === 0 || prev === 0) return false;
  return (prev - curr) >= GCS_DROP_THRESHOLD;
};

/**
 * Assess DKA resolution — all 4 criteria must be met.
 * 1. Glucose < 11.1 mmol/L (< 200 mg/dL)
 * 2. Ketones < 0.6 mmol/L
 * 3. Bicarbonate ≥ 15 mmol/L
 * 4. pH > 7.30
 */
export const assessDKAResolution = (
  glucose: string,
  ketones: string,
  bicarbonate: string,
  pH: string,
  unit: "mmol" | "mgdl",
): { resolved: boolean; criteria: Record<string, boolean> } => {
  const glu = safeParseFloat(glucose);
  const ket = safeParseFloat(ketones);
  const bic = safeParseFloat(bicarbonate);
  const ph = safeParseFloat(pH);

  const glucoseThreshold = unit === "mmol" ? GLUCOSE_RESOLUTION.MMOL : GLUCOSE_RESOLUTION.MGDL;
  const glucoseMet = glu > 0 && glu < glucoseThreshold;
  const ketonesMet = ket >= 0 && ketones !== "" && ket < KETONE_RESOLUTION;
  const bicarbonateMet = bic >= BICARBONATE_RESOLUTION;
  const pHMet = ph > PH_RESOLUTION;

  return {
    resolved: glucoseMet && ketonesMet && bicarbonateMet && pHMet,
    criteria: {
      glucose: glucoseMet,
      ketones: ketonesMet,
      bicarbonate: bicarbonateMet,
      pH: pHMet,
    },
  };
};

/**
 * Suggest insulin adjustment based on glucose level and reduction rate.
 */
export const suggestInsulinAdjustment = (
  glucose: string,
  rate: string | null,
  insulinRate: string,
  unit: "mmol" | "mgdl",
): string => {
  const glu = safeParseFloat(glucose);
  const ins = safeParseFloat(insulinRate);

  if (glu === 0 && glucose === "") return "Insufficient data";
  if (ins <= 0) return "Insufficient data";

  const lowThreshold = unit === "mmol" ? GLUCOSE_REDUCTION_THRESHOLD.MMOL : GLUCOSE_REDUCTION_THRESHOLD.MGDL;
  const targetThreshold = unit === "mmol" ? GLUCOSE_RESOLUTION.MMOL : GLUCOSE_RESOLUTION.MGDL;

  if (glu < targetThreshold) {
    return "Consider switching to subcutaneous insulin";
  }

  if (glu < lowThreshold) {
    return "Consider reducing insulin rate and adding dextrose";
  }

  // Check reduction rate
  if (rate) {
    const r = parseFloat(rate);
    if (!isNaN(r)) {
      const targetRate = unit === "mmol" ? GLUCOSE_TARGET_RATE.MMOL : GLUCOSE_TARGET_RATE.MGDL;
      if (r < targetRate) {
        return "Consider increasing insulin rate";
      }
    }
  }

  return "Maintain current insulin rate";
};
