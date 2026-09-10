/** Shared interfaces for cardiology risk calculators. */

// ── ASCVD ──────────────────────────────────────────────
export interface ASCVDInputs {
  age: string;
  sex: "male" | "female";
  race: "white" | "aa" | "other";
  totalCholesterol: string;
  hdlCholesterol: string;
  systolicBP: string;
  bpTreatment: boolean;
  diabetes: boolean;
  smoker: boolean;
}

// ── HEART Score ────────────────────────────────────────
export interface HEARTInputs {
  history: 0 | 1 | 2;
  ecg: 0 | 1 | 2;
  age: 0 | 1 | 2;
  riskFactors: 0 | 1 | 2;
  troponin: 0 | 1 | 2;
}

// ── CHA₂DS₂-VASc ──────────────────────────────────────
export interface CHADSVAScInputs {
  chf: boolean;
  hypertension: boolean;
  age75: boolean;
  diabetes: boolean;
  stroke: boolean;
  vascularDisease: boolean;
  age65: boolean;
  sexFemale: boolean;
}

