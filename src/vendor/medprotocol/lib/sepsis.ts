/**
 * Pure Sepsis/SOFA monitoring functions — shared between React component and CLI.
 * Based on Sepsis-3 (2016 Third International Consensus) and Surviving Sepsis Campaign.
 */

import { safeParseFloat } from "./utils/safeParseFloat.ts";

// ─── SOFA Organ Scoring (each 0-4) ──────────────────────────────────

/**
 * Respiration SOFA: PaO2/FiO2 ratio thresholds.
 * ≥400→0, <400→1, <300→2, <200+vent→3, <100+vent→4
 */
export const calculateRespirationSOFA = (
  paO2: string,
  fiO2: string,
  onVentilation: boolean,
): number => {
  const pao2 = safeParseFloat(paO2);
  const fio2 = safeParseFloat(fiO2);
  if (pao2 <= 0 || fio2 < 21 || fio2 > 100) return 0;

  const ratio = pao2 / (fio2 / 100);

  if (ratio < 100 && onVentilation) return 4;
  if (ratio < 200 && onVentilation) return 3;
  if (ratio < 300) return 2;
  if (ratio < 400) return 1;
  return 0;
};

/**
 * Coagulation SOFA: Platelet thresholds (×10³/µL).
 * ≥150→0, <150→1, <100→2, <50→3, <20→4
 */
export const calculateCoagulationSOFA = (platelets: string): number => {
  const p = safeParseFloat(platelets);
  if (p === 0 && platelets === "") return 0;
  if (p < 20) return 4;
  if (p < 50) return 3;
  if (p < 100) return 2;
  if (p < 150) return 1;
  return 0;
};

/**
 * Liver SOFA: Bilirubin thresholds (mg/dL).
 * <1.2→0, 1.2-1.9→1, 2.0-5.9→2, 6.0-11.9→3, ≥12→4
 */
export const calculateLiverSOFA = (bilirubin: string): number => {
  const b = safeParseFloat(bilirubin);
  if (b === 0 && bilirubin === "") return 0;
  if (b >= 12) return 4;
  if (b >= 6.0) return 3;
  if (b >= 2.0) return 2;
  if (b >= 1.2) return 1;
  return 0;
};

/**
 * Cardiovascular SOFA: MAP and vasopressor thresholds.
 * MAP≥70→0, MAP<70→1, dopa≤5 or any dobu→2,
 * dopa>5 or epi/norepi≤0.1→3, dopa>15 or epi/norepi>0.1→4
 */
export const calculateCardiovascularSOFA = (
  map: string,
  dopamine: string,
  dobutamine: string,
  epinephrine: string,
  norepinephrine: string,
): number => {
  const mapVal = safeParseFloat(map);
  const dopa = safeParseFloat(dopamine);
  const dobu = safeParseFloat(dobutamine);
  const epi = safeParseFloat(epinephrine);
  const norepi = safeParseFloat(norepinephrine);

  // Score 4: dopa >15 or epi/norepi >0.1
  if (dopa > 15 || epi > 0.1 || norepi > 0.1) return 4;
  // Score 3: dopa >5 or epi/norepi ≤0.1 (but present)
  if (dopa > 5 || (epi > 0 && epi <= 0.1) || (norepi > 0 && norepi <= 0.1)) return 3;
  // Score 2: dopa ≤5 (but present) or any dobutamine
  if ((dopa > 0 && dopa <= 5) || dobu > 0) return 2;
  // Score 1: MAP <70 (no vasopressors)
  if (mapVal > 0 && mapVal < 70) return 1;
  return 0;
};

/**
 * CNS SOFA: Glasgow Coma Scale.
 * 15→0, 13-14→1, 10-12→2, 6-9→3, <6→4
 */
export const calculateCNSSOFA = (gcs: string): number => {
  const g = safeParseFloat(gcs);
  if (g === 0 && gcs === "") return 0;
  if (g < 6) return 4;
  if (g <= 9) return 3;
  if (g <= 12) return 2;
  if (g <= 14) return 1;
  return 0;
};

/**
 * Renal SOFA: Creatinine (mg/dL) and urine output (mL/kg/hr).
 * Cr <1.2→0, 1.2-1.9→1, 2.0-3.4→2, 3.5-4.9→3, ≥5.0→4
 * UO <200 mL/day→4, <500 mL/day→3 (overrides Cr if higher)
 */
export const calculateRenalSOFA = (
  creatinine: string,
  urineOutput: string,
  weight: string,
  hours: string,
): number => {
  const cr = safeParseFloat(creatinine);
  const uo = safeParseFloat(urineOutput);
  const w = safeParseFloat(weight);
  const h = safeParseFloat(hours);

  // Creatinine-based score
  let crScore = 0;
  if (cr === 0 && creatinine === "") {
    crScore = 0;
  } else if (cr >= 5.0) {
    crScore = 4;
  } else if (cr >= 3.5) {
    crScore = 3;
  } else if (cr >= 2.0) {
    crScore = 2;
  } else if (cr >= 1.2) {
    crScore = 1;
  }

  // Urine output rate score (mL/kg/hr)
  let uoScore = 0;
  if (w > 0 && h > 0 && uo >= 0 && urineOutput !== "") {
    const rate = uo / (w * h);
    // <0.3 mL/kg/hr (roughly <200 mL/day for 70kg) → 4
    // <0.5 mL/kg/hr (roughly <500 mL/day for 70kg) → 3
    if (rate < 0.3) {
      uoScore = 4;
    } else if (rate < 0.5) {
      uoScore = 3;
    }
  }

  return Math.max(crScore, uoScore);
};

// ─── Composite SOFA ─────────────────────────────────────────────────

/**
 * Total SOFA score: sum of 6 organ scores (0-24).
 */
export const calculateTotalSOFA = (
  reading: {
    paO2: string; fiO2: string; onVentilation: boolean;
    platelets: string; bilirubin: string;
    map: string; dopamine: string; dobutamine: string;
    epinephrine: string; norepinephrine: string;
    gcs: string; creatinine: string; urineOutput: string;
  },
  weight: string,
  hours: string,
): number => {
  return (
    calculateRespirationSOFA(reading.paO2, reading.fiO2, reading.onVentilation) +
    calculateCoagulationSOFA(reading.platelets) +
    calculateLiverSOFA(reading.bilirubin) +
    calculateCardiovascularSOFA(
      reading.map, reading.dopamine, reading.dobutamine,
      reading.epinephrine, reading.norepinephrine,
    ) +
    calculateCNSSOFA(reading.gcs) +
    calculateRenalSOFA(reading.creatinine, reading.urineOutput, weight, hours)
  );
};

/**
 * SOFA delta: change from baseline.
 */
export const calculateSOFADelta = (current: number, baseline: string): number => {
  const base = safeParseFloat(baseline);
  return current - base;
};

// ─── qSOFA Screening ────────────────────────────────────────────────

/**
 * qSOFA score (0-3): RR≥22 (+1), SBP≤100 (+1), GCS<15 (+1).
 */
export const calculateQSOFA = (
  respiratoryRate: string,
  sbp: string,
  gcs: string,
): number => {
  let score = 0;
  const rr = safeParseFloat(respiratoryRate);
  const s = safeParseFloat(sbp);
  const g = safeParseFloat(gcs);

  if (rr >= 22) score++;
  if (s > 0 && s <= 100) score++;
  if (g > 0 && g < 15) score++;

  return score;
};

/**
 * qSOFA positive if score ≥ 2.
 */
export const isQSOFAPositive = (score: number): boolean => score >= 2;

// ─── Sepsis-3 Assessment ────────────────────────────────────────────

/**
 * Sepsis-3: suspected infection + SOFA ≥ 2 (or delta ≥ 2 from baseline).
 */
export const assessSepsis = (
  sofaScore: number,
  sofaDelta: number,
  suspectedInfection: boolean,
): boolean => {
  if (!suspectedInfection) return false;
  return sofaScore >= 2 || sofaDelta >= 2;
};

/**
 * Septic shock: sepsis + vasopressors needed to maintain MAP ≥65 + lactate >2.
 */
export const assessSepticShock = (
  hasSepsis: boolean,
  vasopressorsNeeded: boolean,
  lactate: string,
): boolean => {
  if (!hasSepsis) return false;
  if (!vasopressorsNeeded) return false;
  const lac = safeParseFloat(lactate);
  return lac > 2;
};

// ─── Hour-1 Bundle ──────────────────────────────────────────────────

/**
 * Check bundle compliance: all 5 items completed within 60 minutes.
 */
export const assessBundleCompliance = (
  bundle: {
    lactateMeasured: boolean;
    bloodCulturesObtained: boolean;
    antibioticsGiven: boolean;
    fluidBolusGiven: boolean;
    vasopressorsStarted: boolean;
    bundleStartTime: number | null;
  },
  currentTime: number,
): { complete: boolean; allItemsDone: boolean; withinTimeLimit: boolean } => {
  const allItemsDone =
    bundle.lactateMeasured &&
    bundle.bloodCulturesObtained &&
    bundle.antibioticsGiven &&
    bundle.fluidBolusGiven &&
    bundle.vasopressorsStarted;

  if (!bundle.bundleStartTime) {
    return { complete: false, allItemsDone, withinTimeLimit: false };
  }

  const elapsedMinutes = (currentTime - bundle.bundleStartTime) / 60;
  const withinTimeLimit = elapsedMinutes <= 60;

  return {
    complete: allItemsDone && withinTimeLimit,
    allItemsDone,
    withinTimeLimit,
  };
};

// ─── Lactate Clearance ──────────────────────────────────────────────

/**
 * Calculate lactate clearance: % decrease from initial to repeat.
 * Returns null if inputs are invalid.
 */
export const calculateLactateClearance = (
  initial: string,
  repeat: string,
): string | null => {
  const init = safeParseFloat(initial);
  const rep = safeParseFloat(repeat);
  if (init <= 0 || initial === "") return null;
  if (repeat === "") return null;
  const clearance = ((init - rep) / init) * 100;
  return clearance.toFixed(1);
};

/**
 * Adequate lactate clearance: ≥10% decrease.
 */
export const isLactateClearanceAdequate = (clearance: string | null): boolean => {
  if (!clearance) return false;
  const c = parseFloat(clearance);
  return !isNaN(c) && c >= 10;
};

// ─── Utilities ──────────────────────────────────────────────────────

/**
 * SOFA severity level based on total score.
 */
export const getSOFASeverityLevel = (
  score: number,
): "Low" | "Moderate" | "High" | "Very High" => {
  if (score <= 5) return "Low";
  if (score <= 10) return "Moderate";
  if (score <= 15) return "High";
  return "Very High";
};

/**
 * Get severity color key for SOFA level.
 */
export const getSOFASeverity = (
  score: number,
): "normal" | "warning" | "critical" => {
  if (score <= 5) return "normal";
  if (score <= 10) return "warning";
  return "critical";
};

/**
 * Check if any vasopressors are being used.
 */
export const hasVasopressors = (
  dopamine: string,
  dobutamine: string,
  epinephrine: string,
  norepinephrine: string,
): boolean => {
  return (
    safeParseFloat(dopamine) > 0 ||
    safeParseFloat(dobutamine) > 0 ||
    safeParseFloat(epinephrine) > 0 ||
    safeParseFloat(norepinephrine) > 0
  );
};
