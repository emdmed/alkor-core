/**
 * CLI-safe acid-base analysis wrapper — typed interface over analyze.ts.
 */
export { analyze } from "./analyze.ts";

export interface ABGValues {
  pH: string;
  pCO2: string;
  HCO3: string;
  Na?: string;
  Cl?: string;
  Albumin?: string;
}

export interface ABGResult {
  disorder: string;
  compensatoryResponse: string;
  additionalDisorders: string[];
  compensation: string;
  interpretation: string;
  expectedValues: { low?: string; high?: string };
  anionGap: string | null;
  uncorrectedAG: string | null;
  correctedAG: string | null;
  agStatus: string | null;
  deltaRatio: string | null;
  deltaRatioInterpretation: string | null;
  allDisorders: string[];
  hhConsistency: {
    expectedPH: string;
    measured: string;
    deviation: string;
    isCoherent: boolean;
    warning: string | null;
  };
}
