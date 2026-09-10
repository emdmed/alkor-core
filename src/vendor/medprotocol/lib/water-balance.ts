/**
 * Pure water-balance calculation functions — shared between React component and CLI.
 *
 * Clinical references:
 * - Insensible loss: ~10–15 mL/kg/day (Rose & Post, Clinical Physiology of Acid-Base and Electrolyte Disorders, 5th ed.)
 * - Endogenous water generation: ~4–5 mL/kg/day from oxidative metabolism (Matz, Am J Med 2007)
 * - Stool water: ~100–200 mL per bowel movement (Levitt & Bond, Gastroenterology 1980)
 */

import { safeParseFloat } from "./utils/safeParseFloat.ts";
export { safeParseFloat };

// ─── Clinical Constants ──────────────────────────────────────────────
const INSENSIBLE_LOSS_ML_PER_KG_DAY = 12;
const ENDOGENOUS_GENERATION_ML_PER_KG_DAY = 4.5;
const DEFECATION_LOSS_ML_PER_STOOL = 120;

export const calculateInsensibleLoss = (weightKg: string | number | null | undefined): string => {
  return (safeParseFloat(weightKg) * INSENSIBLE_LOSS_ML_PER_KG_DAY).toFixed(0);
};

export const calculateEndogenousGeneration = (weightKg: string | number | null | undefined): string => {
  return (safeParseFloat(weightKg) * ENDOGENOUS_GENERATION_ML_PER_KG_DAY).toFixed(0);
};

export const calculateDefecationLoss = (count: string | number | null | undefined): string => {
  return (safeParseFloat(count) * DEFECATION_LOSS_ML_PER_STOOL).toFixed(0);
};

export const calculateWaterBalance = (
  weight: string,
  fluidIntakeOral: string,
  fluidIntakeIV: string,
  diuresis: string,
  defecationCount: string,
): string => {
  const weightNum = safeParseFloat(weight);
  const insensibleLoss = safeParseFloat(calculateInsensibleLoss(weightNum));
  const endogenousGeneration = safeParseFloat(
    calculateEndogenousGeneration(weightNum),
  );
  const defecationLoss = safeParseFloat(
    calculateDefecationLoss(defecationCount),
  );

  const intake =
    safeParseFloat(fluidIntakeOral) +
    safeParseFloat(fluidIntakeIV) +
    endogenousGeneration;
  const output = safeParseFloat(diuresis) + defecationLoss + insensibleLoss;
  return (intake - output).toFixed(0);
};
