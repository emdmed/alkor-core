/**
 * Pure PaFi (PaO2/FiO2) calculation functions — shared between React component and CLI.
 */

import { safeParseFloat } from "./utils/safeParseFloat.ts";

export const calculatePaFi = (paO2: string, fiO2: string): string | null => {
  const paO2Num = safeParseFloat(paO2);
  const fiO2Num = safeParseFloat(fiO2);

  if (paO2Num <= 0) return null;
  if (fiO2Num < 21 || fiO2Num > 100) return null;

  // PaFi = PaO2 / (FiO2 / 100)
  const ratio = paO2Num / (fiO2Num / 100);
  return ratio.toFixed(0);
};

export const getPaFiClassification = (paFi: string | null): string => {
  if (!paFi) return "Unknown";
  const value = parseFloat(paFi);
  if (isNaN(value)) return "Unknown";
  if (value > 300) return "Normal";
  if (value >= 200) return "Mild ARDS";
  if (value >= 100) return "Moderate ARDS";
  return "Severe ARDS";
};

export const getPaFiSeverity = (paFi: string | null): string => {
  if (!paFi) return "default";
  const value = parseFloat(paFi);
  if (isNaN(value)) return "default";
  if (value > 300) return "normal";
  if (value >= 200) return "mild";
  if (value >= 100) return "moderate";
  return "severe";
};
