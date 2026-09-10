/**
 * Diabetes Diagnosis classification functions.
 * Based on ADA Standards of Care 2026, Section 2, Tables 2.1 and 2.2.
 *
 * Table 2.1 — Diabetes diagnostic criteria:
 *   A1C ≥6.5%, FPG ≥126 mg/dL, 2h-PG ≥200 mg/dL, Random PG ≥200 + symptoms
 *
 * Table 2.2 — Prediabetes criteria:
 *   A1C 5.7–6.4%, FPG 100–125 mg/dL, 2h-PG 140–199 mg/dL
 */

import { safeParseFloat } from "./utils/safeParseFloat.ts";

export type Severity = "normal" | "warning" | "critical";
export type DiagnosisCategory = "normal" | "prediabetes-ifg" | "prediabetes-igt" | "diabetes";

// ─── Individual test classifiers ──────────────────────────────────

export function classifyA1C(a1c: string): { label: string; severity: Severity } {
  const v = safeParseFloat(a1c);
  if (v === 0) return { label: "—", severity: "normal" };
  if (v < 5.7) return { label: "Normal", severity: "normal" };
  if (v < 6.5) return { label: "Prediabetes", severity: "warning" };
  return { label: "Diabetes", severity: "critical" };
}

export function classifyFPG(fpg: string): { label: string; severity: Severity } {
  const v = safeParseFloat(fpg);
  if (v === 0) return { label: "—", severity: "normal" };
  if (v < 100) return { label: "Normal", severity: "normal" };
  if (v < 126) return { label: "IFG", severity: "warning" };
  return { label: "Diabetes", severity: "critical" };
}

export function classify2hPG(value: string): { label: string; severity: Severity } {
  const v = safeParseFloat(value);
  if (v === 0) return { label: "—", severity: "normal" };
  if (v < 140) return { label: "Normal", severity: "normal" };
  if (v < 200) return { label: "IGT", severity: "warning" };
  return { label: "Diabetes", severity: "critical" };
}

export function classifyRandomPG(value: string, hasSymptoms: boolean): { label: string; severity: Severity } {
  const v = safeParseFloat(value);
  if (v === 0) return { label: "—", severity: "normal" };
  if (v >= 200 && hasSymptoms) return { label: "Diabetes", severity: "critical" };
  if (v >= 200) return { label: "≥200 (no symptoms)", severity: "warning" };
  return { label: "Normal", severity: "normal" };
}

// ─── Composite diagnosis ──────────────────────────────────────────

export function getDiagnosis(
  a1c: string,
  fpg: string,
  twohPG: string,
  randomPG: string,
  hasSymptoms: boolean,
): { category: DiagnosisCategory; label: string } {
  const a = safeParseFloat(a1c);
  const f = safeParseFloat(fpg);
  const t = safeParseFloat(twohPG);
  const r = safeParseFloat(randomPG);

  // Diabetes thresholds (ADA Table 2.1)
  if (a >= 6.5) return { category: "diabetes", label: "Diabetes" };
  if (f >= 126) return { category: "diabetes", label: "Diabetes" };
  if (t >= 200) return { category: "diabetes", label: "Diabetes" };
  if (r >= 200 && hasSymptoms) return { category: "diabetes", label: "Diabetes" };

  // Prediabetes thresholds (ADA Table 2.2)
  if (a >= 5.7) return { category: "prediabetes-ifg", label: "Prediabetes" };
  if (f >= 100) return { category: "prediabetes-ifg", label: "Prediabetes (IFG)" };
  if (t >= 140) return { category: "prediabetes-igt", label: "Prediabetes (IGT)" };

  // Need at least one value to classify
  if (a === 0 && f === 0 && t === 0 && r === 0) {
    return { category: "normal", label: "—" };
  }

  return { category: "normal", label: "Normal" };
}

// ─── Confirmation logic ───────────────────────────────────────────

export function checkConfirmation(
  readings: { a1c: string; fpg: string; twohPG: string; randomPG: string }[],
  hasSymptoms: boolean,
): { confirmed: boolean; method: string } {
  if (readings.length < 2) return { confirmed: false, method: "" };

  let abnormalCount = 0;
  const methods: string[] = [];

  for (const r of readings) {
    const a = safeParseFloat(r.a1c);
    const f = safeParseFloat(r.fpg);
    const t = safeParseFloat(r.twohPG);
    const rg = safeParseFloat(r.randomPG);
    let abnormal = false;

    if (a >= 6.5) { abnormal = true; methods.push("A1C"); }
    if (f >= 126) { abnormal = true; methods.push("FPG"); }
    if (t >= 200) { abnormal = true; methods.push("2h-PG"); }
    if (rg >= 200 && hasSymptoms) { abnormal = true; methods.push("Random PG"); }

    if (abnormal) abnormalCount++;
  }

  if (abnormalCount >= 2) {
    const unique = [...new Set(methods)];
    return { confirmed: true, method: unique.join(" + ") };
  }

  return { confirmed: false, method: "" };
}
