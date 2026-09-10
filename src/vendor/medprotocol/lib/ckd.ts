/**
 * Pure CKD (Chronic Kidney Disease) functions — shared between React component and CLI.
 * Based on KDIGO 2024 guidelines, CKD-EPI 2021 equation, and 4-variable KFRE (Tangri).
 */

import { safeParseFloat } from "./utils/safeParseFloat.ts";

// ─── eGFR (CKD-EPI 2021 Race-Free) ─────────────────────────────────

/**
 * CKD-EPI 2021 race-free equation.
 * 142 × min(Scr/κ, 1)^α × max(Scr/κ, 1)^-1.2 × 0.9938^age × 1.012 [if female]
 * Female: κ=0.7, α=-0.241; Male: κ=0.9, α=-0.302
 */
export const calculateEGFR = (
  creatinine: string,
  age: string,
  sex: string,
): number => {
  const scr = safeParseFloat(creatinine);
  const ageVal = safeParseFloat(age);
  if (scr <= 0 || ageVal <= 0) return 0;

  const isFemale = sex.toLowerCase() === "female" || sex.toLowerCase() === "f";
  const kappa = isFemale ? 0.7 : 0.9;
  const alpha = isFemale ? -0.241 : -0.302;

  const scrOverKappa = scr / kappa;
  const minTerm = Math.pow(Math.min(scrOverKappa, 1), alpha);
  const maxTerm = Math.pow(Math.max(scrOverKappa, 1), -1.2);
  const ageTerm = Math.pow(0.9938, ageVal);
  const sexFactor = isFemale ? 1.012 : 1;

  const egfr = 142 * minTerm * maxTerm * ageTerm * sexFactor;
  return Math.round(egfr * 10) / 10;
};

// ─── GFR Category ───────────────────────────────────────────────────

/**
 * Classify GFR into KDIGO categories G1–G5.
 */
export const classifyGFRCategory = (
  egfr: string,
): string => {
  const val = safeParseFloat(egfr);
  if (val >= 90) return "G1";
  if (val >= 60) return "G2";
  if (val >= 45) return "G3a";
  if (val >= 30) return "G3b";
  if (val >= 15) return "G4";
  return "G5";
};

/**
 * GFR category label descriptions.
 */
export const getGFRCategoryLabel = (category: string): string => {
  const labels: Record<string, string> = {
    G1: "Normal or high",
    G2: "Mildly decreased",
    G3a: "Mildly to moderately decreased",
    G3b: "Moderately to severely decreased",
    G4: "Severely decreased",
    G5: "Kidney failure",
  };
  return labels[category] ?? "Unknown";
};

// ─── Albuminuria Category ───────────────────────────────────────────

/**
 * Classify ACR (mg/g) into KDIGO albuminuria categories A1–A3.
 */
export const classifyAlbuminuriaCategory = (
  acr: string,
): string => {
  const val = safeParseFloat(acr);
  if (val < 30) return "A1";
  if (val < 300) return "A2";
  return "A3";
};

/**
 * Albuminuria category label descriptions.
 */
export const getAlbuminuriaCategoryLabel = (category: string): string => {
  const labels: Record<string, string> = {
    A1: "Normal to mildly increased",
    A2: "Moderately increased",
    A3: "Severely increased",
  };
  return labels[category] ?? "Unknown";
};

// ─── KDIGO Risk Heatmap ─────────────────────────────────────────────

/**
 * KDIGO heatmap risk level based on GFR × Albuminuria grid.
 * Returns: green / yellow / orange / red / deep-red
 */
export const getCKDRiskLevel = (
  gfrCategory: string,
  albCategory: string,
): string => {
  const grid: Record<string, Record<string, string>> = {
    G1:  { A1: "green",  A2: "yellow", A3: "orange" },
    G2:  { A1: "green",  A2: "yellow", A3: "orange" },
    G3a: { A1: "yellow", A2: "orange", A3: "red" },
    G3b: { A1: "orange", A2: "red",    A3: "deep-red" },
    G4:  { A1: "red",    A2: "deep-red", A3: "deep-red" },
    G5:  { A1: "deep-red", A2: "deep-red", A3: "deep-red" },
  };
  return grid[gfrCategory]?.[albCategory] ?? "green";
};

// ─── Monitoring Frequency ───────────────────────────────────────────

/**
 * Recommended monitoring frequency (times/year) from KDIGO grid.
 */
export const getMonitoringFrequency = (
  gfrCategory: string,
  albCategory: string,
): number => {
  const grid: Record<string, Record<string, number>> = {
    G1:  { A1: 1, A2: 1, A3: 2 },
    G2:  { A1: 1, A2: 1, A3: 2 },
    G3a: { A1: 1, A2: 2, A3: 3 },
    G3b: { A1: 2, A2: 3, A3: 3 },
    G4:  { A1: 3, A2: 3, A3: 4 },
    G5:  { A1: 4, A2: 4, A3: 4 },
  };
  return grid[gfrCategory]?.[albCategory] ?? 1;
};

// ─── KFRE (Kidney Failure Risk Equation) ────────────────────────────

/**
 * 4-variable KFRE (Tangri et al.).
 * LP = −0.2201×(age/10−7.036) + 0.2467×(male−0.5642) − 0.5567×(eGFR/5−7.222) + 0.4510×(lnACR−5.137)
 * Risk = 1 − S0^exp(LP)
 * S0(2yr) = 0.9832, S0(5yr) = 0.9365
 */
export const calculateKFRE = (
  age: string,
  sex: string,
  egfr: string,
  acr: string,
): { twoYear: number; fiveYear: number } => {
  const ageVal = safeParseFloat(age);
  const egfrVal = safeParseFloat(egfr);
  const acrVal = safeParseFloat(acr);
  if (ageVal <= 0 || egfrVal <= 0 || acrVal <= 0) return { twoYear: 0, fiveYear: 0 };

  const isMale = sex.toLowerCase() === "male" || sex.toLowerCase() === "m";
  const maleIndicator = isMale ? 1 : 0;
  const lnACR = Math.log(acrVal);

  const lp =
    -0.2201 * (ageVal / 10 - 7.036) +
    0.2467 * (maleIndicator - 0.5642) -
    0.5567 * (egfrVal / 5 - 7.222) +
    0.4510 * (lnACR - 5.137);

  const expLP = Math.exp(lp);
  const twoYear = 1 - Math.pow(0.9832, expLP);
  const fiveYear = 1 - Math.pow(0.9365, expLP);

  return {
    twoYear: Math.round(twoYear * 1000) / 10,
    fiveYear: Math.round(fiveYear * 1000) / 10,
  };
};

// ─── Referral Assessment ────────────────────────────────────────────

/**
 * Referral need based on 5-year KFRE (%).
 * <3%: none, 3-5%: nephrology, 5-10%: multidisciplinary, ≥10%: krt-planning (was ≥40% but lowered per KDIGO)
 */
export const assessReferralNeed = (
  kfre5yr: string,
): string => {
  const val = safeParseFloat(kfre5yr);
  if (val >= 40) return "krt-planning";
  if (val >= 10) return "multidisciplinary";
  if (val >= 5) return "nephrology";
  if (val >= 3) return "nephrology";
  return "none";
};

/**
 * Referral label for display.
 */
export const getReferralLabel = (referral: string): string => {
  const labels: Record<string, string> = {
    none: "No referral needed",
    nephrology: "Refer to nephrology",
    multidisciplinary: "Multidisciplinary care",
    "krt-planning": "KRT planning required",
  };
  return labels[referral] ?? "Unknown";
};

// ─── Treatment Eligibility ──────────────────────────────────────────

/**
 * ACEi/ARB (RASi) eligibility: albuminuria A2+ or diabetic CKD.
 */
export const checkRASiEligibility = (
  gfrCategory: string,
  albCategory: string,
  hasDiabetes: boolean,
): { eligible: boolean; grade: string } => {
  if (albCategory === "A3") return { eligible: true, grade: "1B" };
  if (albCategory === "A2") return { eligible: true, grade: "1B" };
  if (hasDiabetes && albCategory === "A1" && gfrCategory !== "G1" && gfrCategory !== "G2") {
    return { eligible: true, grade: "2C" };
  }
  return { eligible: false, grade: "" };
};

/**
 * SGLT2i eligibility: eGFR ≥20 + (ACR ≥200 or heart failure).
 */
export const checkSGLT2iEligibility = (
  egfr: string,
  acr: string,
  hasHeartFailure: boolean,
): { eligible: boolean; grade: string } => {
  const egfrVal = safeParseFloat(egfr);
  const acrVal = safeParseFloat(acr);
  if (egfrVal < 20) return { eligible: false, grade: "" };
  if (acrVal >= 200) return { eligible: true, grade: "1A" };
  if (hasHeartFailure) return { eligible: true, grade: "1A" };
  if (acrVal >= 30) return { eligible: true, grade: "2B" };
  return { eligible: false, grade: "" };
};

/**
 * Finerenone (MRA) eligibility: diabetic CKD + eGFR ≥25 + ACR ≥30 + on max RASi + normal K+.
 */
export const checkFinerenoneEligibility = (
  egfr: string,
  acr: string,
  hasDiabetes: boolean,
  onMaxRASi: boolean,
  potassiumNormal: boolean,
): { eligible: boolean; grade: string } => {
  const egfrVal = safeParseFloat(egfr);
  const acrVal = safeParseFloat(acr);
  if (!hasDiabetes) return { eligible: false, grade: "" };
  if (egfrVal < 25) return { eligible: false, grade: "" };
  if (acrVal < 30) return { eligible: false, grade: "" };
  if (!onMaxRASi) return { eligible: false, grade: "" };
  if (!potassiumNormal) return { eligible: false, grade: "" };
  return { eligible: true, grade: "1A" };
};

// ─── Progression Monitoring ─────────────────────────────────────────

/**
 * Calculate eGFR slope (mL/min/1.73m²/year) via linear regression.
 * Input: JSON string of [{egfr: number, date: string}]
 * Returns null if input is invalid or insufficient (< 2 valid readings).
 */
export const calculateEGFRSlope = (
  readings: string,
): number | null => {
  let data: { egfr: number; date: string }[];
  try {
    data = JSON.parse(readings);
  } catch {
    return null;
  }

  if (!Array.isArray(data) || data.length < 2) return null;

  const parsed = data
    .map((r) => ({
      egfr: typeof r.egfr === "number" ? r.egfr : parseFloat(String(r.egfr)),
      time: new Date(r.date).getTime(),
    }))
    .filter((p) => !isNaN(p.egfr) && !isNaN(p.time))
    .sort((a, b) => a.time - b.time);

  // Deduplicate by timestamp — keep last reading per date to avoid division by zero
  const seen = new Set<number>();
  const points: typeof parsed = [];
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (!seen.has(parsed[i].time)) {
      seen.add(parsed[i].time);
      points.unshift(parsed[i]);
    }
  }

  if (points.length < 2) return null;

  // Convert ms to years
  const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
  const years = points.map((p) => (p.time - points[0].time) / msPerYear);
  const egfrs = points.map((p) => p.egfr);

  const n = years.length;
  const sumX = years.reduce((a, b) => a + b, 0);
  const sumY = egfrs.reduce((a, b) => a + b, 0);
  const sumXY = years.reduce((acc, x, i) => acc + x * egfrs[i], 0);
  const sumX2 = years.reduce((acc, x) => acc + x * x, 0);

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;

  const slope = (n * sumXY - sumX * sumY) / denom;
  return Math.round(slope * 10) / 10;
};

/**
 * Rapid decline: eGFR slope ≥5 mL/min/1.73m²/year loss.
 */
export const isRapidDecline = (slope: string): boolean => {
  const val = safeParseFloat(slope);
  return val <= -5;
};

/**
 * Significant eGFR change: >20% decrease from previous.
 */
export const hasSignificantEGFRChange = (
  previous: string,
  current: string,
): boolean => {
  const prev = safeParseFloat(previous);
  const curr = safeParseFloat(current);
  if (prev <= 0) return false;
  const change = (prev - curr) / prev;
  return change > 0.2;
};

/**
 * ACR doubling: current ≥ 2× previous.
 */
export const hasACRDoubling = (
  previous: string,
  current: string,
): boolean => {
  const prev = safeParseFloat(previous);
  const curr = safeParseFloat(current);
  if (prev <= 0) return false;
  return curr >= 2 * prev;
};

// ─── Anemia of CKD (KDIGO 2012 Anemia) ─────────────────────────────

/**
 * Classify anemia by hemoglobin level and sex.
 * KDIGO: Hb <13 g/dL (male), <12 g/dL (female) → anemia.
 * Severity: ≥threshold = none; <threshold & ≥10 = mild; <10 & ≥7 = moderate; <7 = severe.
 */
export const classifyAnemia = (
  hemoglobin: string,
  sex: string,
): { anemic: boolean; severity: string } => {
  const hb = safeParseFloat(hemoglobin);
  if (hb <= 0) return { anemic: false, severity: "unknown" };

  const isFemale = sex.toLowerCase() === "female" || sex.toLowerCase() === "f";
  const threshold = isFemale ? 12 : 13;

  if (hb >= threshold) return { anemic: false, severity: "none" };
  if (hb >= 10) return { anemic: true, severity: "mild" };
  if (hb >= 7) return { anemic: true, severity: "moderate" };
  return { anemic: true, severity: "severe" };
};

/**
 * Assess iron status for CKD anemia workup.
 * KDIGO Anemia 2012: ferritin <100 ng/mL OR TSAT <20% in non-dialysis CKD → iron deficient.
 */
export const assessIronStatus = (
  ferritin: string,
  tsat: string,
): { ironDeficient: boolean; recommendation: string } => {
  const ferritinVal = safeParseFloat(ferritin);
  const tsatVal = safeParseFloat(tsat);
  if (ferritinVal <= 0 || tsatVal <= 0) {
    return { ironDeficient: false, recommendation: "Insufficient data for iron assessment" };
  }

  if (ferritinVal < 100 || tsatVal < 20) {
    return {
      ironDeficient: true,
      recommendation: "Iron supplementation recommended before considering ESA therapy",
    };
  }
  return {
    ironDeficient: false,
    recommendation: "Iron stores adequate; reassess periodically",
  };
};

/**
 * Check ESA eligibility: Hb <10 g/dL AND iron replete (ferritin ≥100, TSAT ≥20%).
 */
export const checkESAEligibility = (
  hemoglobin: string,
  ferritin: string,
  tsat: string,
  sex: string,
): { eligible: boolean; reason: string } => {
  const hb = safeParseFloat(hemoglobin);
  const ferritinVal = safeParseFloat(ferritin);
  const tsatVal = safeParseFloat(tsat);
  if (hb <= 0) return { eligible: false, reason: "Invalid hemoglobin value" };

  const isFemale = sex.toLowerCase() === "female" || sex.toLowerCase() === "f";
  const threshold = isFemale ? 12 : 13;

  if (hb >= threshold) return { eligible: false, reason: "Not anemic; ESA not indicated" };
  if (hb >= 10) return { eligible: false, reason: "Hb ≥10 g/dL; ESA not yet indicated" };
  if (ferritinVal < 100 || tsatVal < 20) {
    return { eligible: false, reason: "Iron deficient; replete iron before ESA" };
  }
  return { eligible: true, reason: "Hb <10 g/dL with adequate iron stores; ESA may be considered" };
};

// ─── CKD-MBD (KDIGO 2017 CKD-MBD) ─────────────────────────────────

/**
 * Assess phosphate level relative to GFR category.
 * KDIGO CKD-MBD 2017: maintain toward normal range; G3a-G5 target 2.5–4.5 mg/dL.
 */
export const assessPhosphate = (
  phosphate: string,
  gfrCategory: string,
): { status: string; recommendation: string } => {
  const phos = safeParseFloat(phosphate);
  if (phos <= 0) return { status: "unknown", recommendation: "Invalid phosphate value" };

  const advanced = ["G3a", "G3b", "G4", "G5"].includes(gfrCategory);

  if (!advanced) {
    if (phos >= 2.5 && phos <= 4.5) {
      return { status: "normal", recommendation: "Phosphate within normal range" };
    }
    return {
      status: phos < 2.5 ? "low" : "high",
      recommendation: phos < 2.5
        ? "Phosphate below normal range; evaluate cause"
        : "Phosphate above normal range; evaluate cause",
    };
  }

  if (phos < 2.5) return { status: "low", recommendation: "Phosphate below target; evaluate cause" };
  if (phos <= 4.5) return { status: "normal", recommendation: "Phosphate within target range (2.5–4.5 mg/dL)" };
  return { status: "high", recommendation: "Phosphate elevated; consider dietary restriction and phosphate binders" };
};

/**
 * Corrected calcium = measured Ca + 0.8 × (4.0 − albumin).
 */
export const correctCalcium = (
  calcium: string,
  albumin: string,
): number => {
  const ca = safeParseFloat(calcium);
  const alb = safeParseFloat(albumin);
  if (ca <= 0 || alb <= 0) return 0;
  const corrected = ca + 0.8 * (4.0 - alb);
  return Math.round(corrected * 10) / 10;
};

/**
 * Assess PTH relative to GFR category.
 * KDIGO CKD-MBD 2017: G3a-G3b keep within normal range (10–65 pg/mL);
 * G4-G5 accept 2–9× upper normal limit (~130–585 pg/mL for UNL 65).
 */
export const assessPTH = (
  pth: string,
  gfrCategory: string,
): { status: string; recommendation: string } => {
  const pthVal = safeParseFloat(pth);
  if (pthVal <= 0) return { status: "unknown", recommendation: "Invalid PTH value" };

  const UNL = 65;

  if (gfrCategory === "G4" || gfrCategory === "G5") {
    const lower = 2 * UNL;  // 130
    const upper = 9 * UNL;  // 585
    if (pthVal < lower) return { status: "low", recommendation: "PTH below 2× UNL; avoid over-suppression" };
    if (pthVal <= upper) return { status: "acceptable", recommendation: `PTH within acceptable range for ${gfrCategory} (2–9× UNL)` };
    return { status: "high", recommendation: "PTH exceeds 9× UNL; consider active vitamin D or calcimimetics" };
  }

  // G1-G3b: normal range
  if (pthVal <= UNL) return { status: "normal", recommendation: "PTH within normal range" };
  return { status: "high", recommendation: "PTH elevated; evaluate for secondary hyperparathyroidism" };
};

/**
 * Assess 25-OH vitamin D status.
 * KDIGO CKD-MBD 2017: <20 ng/mL → deficient, 20–29 → insufficient, ≥30 → sufficient.
 */
export const assessVitaminD = (
  vitaminD25OH: string,
): { status: string; recommendation: string } => {
  const vd = safeParseFloat(vitaminD25OH);
  if (vd <= 0) return { status: "unknown", recommendation: "Invalid vitamin D value" };

  if (vd < 20) return { status: "deficient", recommendation: "Vitamin D deficient; supplement with cholecalciferol" };
  if (vd < 30) return { status: "insufficient", recommendation: "Vitamin D insufficient; consider supplementation" };
  return { status: "sufficient", recommendation: "Vitamin D sufficient; maintain current intake" };
};

/**
 * CKD-MBD monitoring frequency by GFR category (KDIGO CKD-MBD 2017).
 */
export const getCKDMBDMonitoring = (
  gfrCategory: string,
): { phosphate: string; calcium: string; pth: string; vitaminD: string } => {
  if (gfrCategory === "G5") {
    return {
      phosphate: "Every 1–3 months",
      calcium: "Every 1–3 months",
      pth: "Every 3–6 months",
      vitaminD: "Baseline, then per clinical indication",
    };
  }
  if (gfrCategory === "G4") {
    return {
      phosphate: "Every 6–12 months",
      calcium: "Every 6–12 months",
      pth: "Every 6–12 months",
      vitaminD: "Baseline, then per clinical indication",
    };
  }
  if (gfrCategory === "G3a" || gfrCategory === "G3b") {
    return {
      phosphate: "Baseline, then per clinical indication",
      calcium: "Baseline, then per clinical indication",
      pth: "Baseline, then per clinical indication",
      vitaminD: "Baseline, then per clinical indication",
    };
  }
  return {
    phosphate: "Not routinely monitored",
    calcium: "Not routinely monitored",
    pth: "Not routinely monitored",
    vitaminD: "Per clinical indication",
  };
};

// ─── Utilities ──────────────────────────────────────────────────────

/**
 * CKD severity for UI styling based on GFR category.
 */
export const getCKDSeverity = (
  gfrCategory: string,
): "normal" | "warning" | "critical" => {
  if (gfrCategory === "G1" || gfrCategory === "G2") return "normal";
  if (gfrCategory === "G3a" || gfrCategory === "G3b") return "warning";
  return "critical";
};
