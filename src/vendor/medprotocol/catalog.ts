/**
 * Machine-readable catalog of every calculation the CLI exposes.
 *
 * `medprotocol schema --json` serves this so an agent can discover the whole
 * command surface in one call instead of scraping --help text. The command
 * implementations stay the source of truth for the calculations themselves;
 * tests/cli/schema-cli.test.ts guards this catalog against drifting from them.
 */

export type FlagType = "number" | "string" | "boolean";

export type Flag = {
  flag: string;
  type: FlagType;
  description: string;
  required?: boolean;
  /** Accepted values, when the flag is an enum. */
  values?: string[];
  default?: string;
};

export type Calculation = {
  /** Sub-command name, omitted for flat commands. */
  subcommand?: string;
  description: string;
  flags: Flag[];
  examples: string[];
};

export type CommandEntry = {
  command: string;
  description: string;
  calculations: Calculation[];
};

const num = (
  flag: string,
  description: string,
  required = false,
  extra: Partial<Flag> = {},
): Flag => ({ flag, type: "number", description, required, ...extra });

const bool = (flag: string, description: string): Flag => ({
  flag,
  type: "boolean",
  description,
});

const str = (
  flag: string,
  description: string,
  required = false,
  extra: Partial<Flag> = {},
): Flag => ({ flag, type: "string", description, required, ...extra });

export const GLOBAL_FLAGS: Flag[] = [
  bool("--json", "Emit structured JSON on stdout — always use this from an agent"),
  bool("--help", "Show usage for the command"),
];

export const CATALOG: CommandEntry[] = [
  {
    command: "bmi",
    description: "Body Mass Index with WHO category",
    calculations: [
      {
        description:
          "BMI from weight and height. Imperial by default (lbs + feet/inches); pass --metric for kg + meters.",
        flags: [
          num("--weight", "Weight — lbs for imperial, kg with --metric", true),
          num("--height-ft", "Height in feet (imperial)"),
          num("--height-in", "Height in inches (imperial)"),
          num("--height-m", "Height in meters (requires --metric)"),
          bool("--metric", "Use metric units (kg, meters)"),
        ],
        examples: [
          "medprotocol bmi --weight 154 --height-ft 5 --height-in 9 --json",
          "medprotocol bmi --weight 70 --height-m 1.75 --metric --json",
        ],
      },
    ],
  },
  {
    command: "abg",
    description: "Arterial blood gas analysis",
    calculations: [
      {
        description:
          "Primary acid-base disturbance, compensation status, and anion gap when sodium and chloride are supplied.",
        flags: [
          num("--ph", "Arterial pH", true),
          num("--pco2", "pCO2 in mmHg", true),
          num("--hco3", "HCO3 in mEq/L", true),
          num("--na", "Sodium in mEq/L — enables anion gap"),
          num("--cl", "Chloride in mEq/L — enables anion gap"),
          num("--albumin", "Albumin in g/dL — enables corrected anion gap"),
          bool("--chronic", "Chronic respiratory disorder — changes expected compensation"),
        ],
        examples: [
          "medprotocol abg --ph 7.25 --pco2 29 --hco3 14 --json",
          "medprotocol abg --ph 7.25 --pco2 29 --hco3 14 --na 140 --cl 105 --albumin 4.0 --json",
        ],
      },
    ],
  },
  {
    command: "water-balance",
    description: "Fluid intake/output balance",
    calculations: [
      {
        description:
          "Net fluid balance including insensible losses and endogenous water generation.",
        flags: [
          num("--weight", "Patient weight in kg", true),
          num("--oral", "Oral fluid intake in mL", false, { default: "0" }),
          num("--iv", "IV fluid intake in mL", false, { default: "0" }),
          num("--diuresis", "Urine output in mL", false, { default: "0" }),
          num("--stools", "Number of stools", false, { default: "0" }),
        ],
        examples: [
          "medprotocol water-balance --weight 70 --oral 1500 --iv 500 --diuresis 1200 --stools 2 --json",
        ],
      },
    ],
  },
  {
    command: "vitals",
    description: "Vital signs evaluation",
    calculations: [
      {
        description:
          "Evaluate vital signs and flag abnormal values. Pass whichever measurements are available.",
        flags: [
          str("--bp", 'Blood pressure as systolic/diastolic, e.g. "120/80"'),
          num("--hr", "Heart rate in bpm"),
          num("--rr", "Respiratory rate in breaths/min"),
          num("--temp", "Temperature — Celsius unless --fahrenheit"),
          num("--spo2", "SpO2 percentage"),
          num("--fio2", "FiO2 percentage", false, { default: "21" }),
          bool("--fahrenheit", "Temperature is in Fahrenheit"),
        ],
        examples: [
          "medprotocol vitals --bp 120/80 --hr 72 --temp 37.0 --json",
          "medprotocol vitals --spo2 92 --fio2 40 --json",
        ],
      },
    ],
  },
  {
    command: "pafi",
    description: "PaO2/FiO2 ratio with ARDS classification",
    calculations: [
      {
        description: "PaFi ratio and Berlin ARDS severity.",
        flags: [
          num("--pao2", "PaO2 in mmHg", true),
          num("--fio2", "FiO2 as a percentage, 21-100", true),
        ],
        examples: ["medprotocol pafi --pao2 60 --fio2 40 --json"],
      },
    ],
  },
  {
    command: "dka",
    description: "DKA monitoring and resolution",
    calculations: [
      {
        description:
          "Glucose, ketone, and bicarbonate clearance rates, potassium, GCS, urine output, resolution criteria, and insulin adjustment. Supply whichever tracks you have.",
        flags: [
          num("--glucose", "Current glucose", true),
          num("--prev-glucose", "Previous glucose — enables the reduction rate"),
          num("--hours", "Hours between readings — also used for urine output", false, {
            default: "1",
          }),
          num("--ketones", "Current ketones in mmol/L"),
          num("--prev-ketones", "Previous ketones — enables the clearance rate"),
          num("--bicarbonate", "Current bicarbonate in mEq/L"),
          num("--prev-bicarbonate", "Previous bicarbonate — enables the recovery rate"),
          num("--ph", "Current pH"),
          num("--insulin-rate", "Current insulin infusion rate in U/hr"),
          num("--potassium", "Serum potassium in mEq/L"),
          num("--gcs", "Glasgow Coma Scale, 3-15"),
          num("--prev-gcs", "Previous GCS — a drop of 2 or more flags cerebral edema"),
          num("--urine-output", "Urine output volume in mL (requires --weight)"),
          num("--weight", "Patient weight in kg — required with --urine-output"),
          str("--unit", "Glucose unit", false, { values: ["mgdl", "mmol"], default: "mgdl" }),
        ],
        examples: [
          "medprotocol dka --glucose 400 --prev-glucose 460 --hours 2 --unit mgdl --json",
          "medprotocol dka --glucose 300 --potassium 3.1 --gcs 13 --prev-gcs 15 --urine-output 400 --weight 70 --hours 8 --json",
        ],
      },
    ],
  },
  {
    command: "cardiology",
    description: "Cardiology risk scores",
    calculations: [
      {
        subcommand: "ascvd",
        description: "10-year ASCVD risk (Pooled Cohort Equations).",
        flags: [
          num("--age", "Age, 40-79", true),
          str("--sex", "Sex", true, { values: ["male", "female"] }),
          str("--race", "Race", false, { values: ["white", "aa", "other"], default: "white" }),
          num("--tc", "Total cholesterol in mg/dL", true),
          num("--hdl", "HDL cholesterol in mg/dL", true),
          num("--sbp", "Systolic BP in mmHg", true),
          bool("--bp-treatment", "On antihypertensive treatment"),
          bool("--diabetes", "Has diabetes"),
          bool("--smoker", "Current smoker"),
        ],
        examples: [
          "medprotocol cardiology ascvd --age 55 --sex male --tc 213 --hdl 50 --sbp 120 --json",
        ],
      },
      {
        subcommand: "heart",
        description: "HEART Score for chest pain triage. Each component scores 0, 1, or 2.",
        flags: [
          num("--history", "History suspicion: 0, 1, or 2", true),
          num("--ecg", "ECG findings: 0, 1, or 2", true),
          num("--age", "Age category: 0, 1, or 2", true),
          num("--risk-factors", "Risk factors: 0, 1, or 2", true),
          num("--troponin", "Troponin: 0, 1, or 2", true),
        ],
        examples: [
          "medprotocol cardiology heart --history 1 --ecg 0 --age 2 --risk-factors 1 --troponin 0 --json",
        ],
      },
      {
        subcommand: "chadsvasc",
        description: "CHA2DS2-VASc stroke risk in atrial fibrillation.",
        flags: [
          bool("--chf", "CHF or LV dysfunction (+1)"),
          bool("--hypertension", "Hypertension (+1)"),
          bool("--age75", "Age 75 or older (+2)"),
          bool("--diabetes", "Diabetes (+1)"),
          bool("--stroke", "Prior stroke, TIA, or thromboembolism (+2)"),
          bool("--vascular", "Vascular disease (+1)"),
          bool("--age65", "Age 65-74 (+1)"),
          bool("--female", "Female sex (+1)"),
        ],
        examples: [
          "medprotocol cardiology chadsvasc --hypertension --age75 --diabetes --json",
        ],
      },
    ],
  },
  {
    command: "sepsis",
    description: "Sepsis-3 scores and hour-1 bundle",
    calculations: [
      {
        subcommand: "sofa",
        description:
          "SOFA score across all six organ systems, plus sepsis and septic-shock assessment. Omitted systems score 0.",
        flags: [
          num("--pao2", "PaO2 in mmHg"),
          num("--fio2", "FiO2 percentage"),
          bool("--ventilation", "On mechanical ventilation"),
          num("--platelets", "Platelet count in x10^3/uL"),
          num("--bilirubin", "Bilirubin in mg/dL"),
          num("--map", "Mean arterial pressure in mmHg"),
          num("--dopamine", "Dopamine dose in mcg/kg/min"),
          num("--dobutamine", "Dobutamine dose in mcg/kg/min"),
          num("--epinephrine", "Epinephrine dose in mcg/kg/min"),
          num("--norepinephrine", "Norepinephrine dose in mcg/kg/min"),
          num("--gcs", "Glasgow Coma Scale, 3-15"),
          num("--creatinine", "Creatinine in mg/dL"),
          num("--urine-output", "Urine output in mL"),
          num("--weight", "Patient weight in kg"),
          num("--hours", "Hours covered by the urine output", false, { default: "24" }),
          num("--baseline", "Baseline SOFA score", false, { default: "0" }),
          bool("--infection", "Infection suspected — required for the sepsis call"),
          num("--lactate", "Lactate in mmol/L"),
        ],
        examples: [
          "medprotocol sepsis sofa --pao2 80 --fio2 40 --platelets 90 --gcs 13 --creatinine 2.5 --json",
          "medprotocol sepsis sofa --pao2 60 --fio2 80 --ventilation --platelets 40 --infection --lactate 4 --json",
        ],
      },
      {
        subcommand: "qsofa",
        description: "Quick SOFA bedside screening.",
        flags: [
          num("--rr", "Respiratory rate in breaths/min", true),
          num("--sbp", "Systolic blood pressure in mmHg", true),
          num("--gcs", "Glasgow Coma Scale, 3-15", true),
        ],
        examples: ["medprotocol sepsis qsofa --rr 24 --sbp 90 --gcs 13 --json"],
      },
      {
        subcommand: "lactate",
        description: "Lactate clearance between two measurements — adequate at 10% or more.",
        flags: [
          num("--initial", "Initial lactate in mmol/L", true),
          num("--repeat", "Repeat lactate in mmol/L", true),
        ],
        examples: ["medprotocol sepsis lactate --initial 4.2 --repeat 2.1 --json"],
      },
      {
        subcommand: "bundle",
        description:
          "Surviving Sepsis hour-1 bundle compliance. Omit --elapsed when the bundle clock has not started.",
        flags: [
          bool("--lactate-measured", "Lactate measured"),
          bool("--cultures", "Blood cultures obtained before antibiotics"),
          bool("--antibiotics", "Broad-spectrum antibiotics given"),
          bool("--fluids", "30 mL/kg crystalloid bolus given"),
          bool("--vasopressors", "Vasopressors started for persistent hypotension"),
          num("--elapsed", "Minutes since bundle start"),
        ],
        examples: [
          "medprotocol sepsis bundle --lactate-measured --cultures --antibiotics --fluids --vasopressors --elapsed 45 --json",
        ],
      },
    ],
  },
  {
    command: "ckd",
    description: "CKD staging, risk, and nephrology panels",
    calculations: [
      {
        subcommand: "egfr",
        description: "eGFR by the CKD-EPI 2021 race-free equation.",
        flags: [
          num("--creatinine", "Serum creatinine in mg/dL", true),
          num("--age", "Age in years", true),
          str("--sex", "Sex", true, { values: ["male", "female"] }),
        ],
        examples: ["medprotocol ckd egfr --creatinine 1.2 --age 55 --sex male --json"],
      },
      {
        subcommand: "stage",
        description:
          "Full KDIGO CGA staging — eGFR category, albuminuria category, risk level, monitoring frequency.",
        flags: [
          num("--creatinine", "Serum creatinine in mg/dL", true),
          num("--age", "Age in years", true),
          str("--sex", "Sex", true, { values: ["male", "female"] }),
          num("--acr", "Urine albumin-to-creatinine ratio in mg/g", true),
        ],
        examples: [
          "medprotocol ckd stage --creatinine 1.2 --age 55 --sex male --acr 45 --json",
        ],
      },
      {
        subcommand: "kfre",
        description: "Kidney Failure Risk Equation (4-variable) — 2- and 5-year risk, referral guidance.",
        flags: [
          num("--age", "Age in years", true),
          str("--sex", "Sex", true, { values: ["male", "female"] }),
          num("--egfr", "eGFR in mL/min/1.73m2", true),
          num("--acr", "ACR in mg/g", true),
        ],
        examples: ["medprotocol ckd kfre --age 65 --sex female --egfr 35 --acr 300 --json"],
      },
      {
        subcommand: "treatment",
        description: "Treatment eligibility — RASi, SGLT2i, finerenone.",
        flags: [
          num("--egfr", "eGFR in mL/min/1.73m2", true),
          num("--acr", "ACR in mg/g", true),
          bool("--diabetes", "Has diabetes"),
          bool("--heart-failure", "Has heart failure"),
          bool("--on-rasi", "Already on maximum tolerated RASi"),
          bool("--potassium-normal", "Serum potassium is normal"),
        ],
        examples: ["medprotocol ckd treatment --egfr 35 --acr 300 --diabetes --json"],
      },
      {
        subcommand: "anemia",
        description:
          "Anemia of CKD — classification, iron status, and ESA eligibility when ferritin and TSAT are supplied.",
        flags: [
          num("--hb", "Hemoglobin in g/dL", true),
          str("--sex", "Sex", true, { values: ["male", "female"] }),
          num("--ferritin", "Serum ferritin in ng/mL"),
          num("--tsat", "Transferrin saturation percentage"),
        ],
        examples: [
          "medprotocol ckd anemia --hb 9.5 --sex male --ferritin 80 --tsat 15 --json",
        ],
      },
      {
        subcommand: "mbd",
        description:
          "CKD mineral and bone disorder — phosphate, albumin-corrected calcium, PTH, vitamin D, monitoring intervals.",
        flags: [
          str("--gfr-category", "GFR category", true, {
            values: ["G1", "G2", "G3a", "G3b", "G4", "G5"],
          }),
          num("--phosphate", "Serum phosphate in mg/dL"),
          num("--calcium", "Serum calcium in mg/dL"),
          num("--albumin", "Serum albumin in g/dL"),
          num("--pth", "Intact PTH in pg/mL"),
          num("--vitamin-d", "25-OH vitamin D in ng/mL"),
        ],
        examples: [
          "medprotocol ckd mbd --phosphate 5.2 --calcium 8.5 --albumin 3.2 --pth 250 --vitamin-d 18 --gfr-category G4 --json",
        ],
      },
      {
        subcommand: "trend",
        description:
          "Progression monitoring — eGFR slope, rapid decline, >20% eGFR drop, ACR doubling. Supply a readings series, an eGFR pair, an ACR pair, or any combination.",
        flags: [
          str(
            "--readings",
            'JSON array of eGFR readings: \'[{"egfr":52,"date":"2023-01-10"},{"egfr":41,"date":"2024-01-12"}]\' — 2 or more entries',
          ),
          num("--prev-egfr", "Previous eGFR in mL/min/1.73m2"),
          num("--egfr", "Current eGFR in mL/min/1.73m2"),
          num("--prev-acr", "Previous ACR in mg/g"),
          num("--acr", "Current ACR in mg/g"),
        ],
        examples: [
          "medprotocol ckd trend --prev-egfr 52 --egfr 38 --prev-acr 150 --acr 340 --json",
        ],
      },
    ],
  },
  {
    command: "diabetes",
    description: "ADA diabetes diagnosis and screening",
    calculations: [
      {
        subcommand: "diagnose",
        description:
          "ADA diagnosis from any combination of A1C, fasting, 2-hour, and random plasma glucose.",
        flags: [
          num("--a1c", "A1C percentage"),
          num("--fpg", "Fasting plasma glucose in mg/dL"),
          num("--2h-pg", "2-hour plasma glucose in mg/dL"),
          num("--random-pg", "Random plasma glucose in mg/dL"),
          bool("--symptoms", "Classic hyperglycemic symptoms present"),
        ],
        examples: ["medprotocol diabetes diagnose --a1c 6.8 --fpg 130 --json"],
      },
      {
        subcommand: "confirm",
        description:
          "ADA confirmation rule — whether repeat readings confirm the diagnosis, and by which method.",
        flags: [
          str(
            "--readings",
            'JSON array of repeat readings: \'[{"a1c":"6.8"},{"fpg":"140"}]\'. Keys: a1c, fpg, twohPG, randomPG. 2 or more entries',
            true,
          ),
          bool("--symptoms", "Classic hyperglycemic symptoms present"),
        ],
        examples: [
          `medprotocol diabetes confirm --readings '[{"a1c":"6.8"},{"fpg":"140"}]' --json`,
        ],
      },
      {
        subcommand: "t1d-stage",
        description: "Type 1 diabetes staging (ADA Table 2.4) from autoantibody count and glycemia.",
        flags: [
          num("--autoantibodies", "Number of islet autoantibodies", true),
          num("--fpg", "Fasting plasma glucose in mg/dL"),
          num("--2h-pg", "2-hour plasma glucose in mg/dL"),
          num("--a1c", "A1C percentage"),
          bool("--symptoms", "Symptomatic"),
        ],
        examples: ["medprotocol diabetes t1d-stage --autoantibodies 3 --a1c 5.9 --json"],
      },
      {
        subcommand: "t1-vs-t2",
        description: "Type 1 vs type 2 classification using the AABBCC mnemonic.",
        flags: [
          num("--age", "Age at onset", true),
          num("--bmi", "BMI", true),
          bool("--autoantibodies", "Has islet autoantibodies"),
          num("--c-peptide", "C-peptide in pmol/L"),
          bool("--fhx-t1d", "Family history of type 1 diabetes"),
          bool("--fhx-t2d", "Family history of type 2 diabetes"),
          bool("--dka-history", "History of DKA"),
          bool("--autoimmune", "Other autoimmune conditions"),
          bool("--on-insulin", "Currently on insulin"),
        ],
        examples: [
          "medprotocol diabetes t1-vs-t2 --age 25 --bmi 22 --autoantibodies --c-peptide 150 --json",
        ],
      },
      {
        subcommand: "t2d-screen",
        description: "Type 2 diabetes screening eligibility (ADA Table 2.5).",
        flags: [
          num("--age", "Age in years", true),
          num("--bmi", "BMI", true),
          str("--ethnicity", "Ethnicity", false, { default: "other" }),
          bool("--first-degree", "First-degree relative with diabetes"),
          bool("--high-risk-ethnicity", "High-risk ethnicity"),
          bool("--cvd", "Cardiovascular disease history"),
          bool("--hypertension", "Hypertension"),
          bool("--dyslipidemia", "Dyslipidemia"),
          bool("--pcos", "PCOS"),
          bool("--inactive", "Physical inactivity"),
          bool("--insulin-resistance", "Signs of insulin resistance"),
          bool("--prior-prediabetes", "Prior prediabetes"),
          bool("--prior-gdm", "Prior gestational diabetes"),
        ],
        examples: ["medprotocol diabetes t2d-screen --age 40 --bmi 28 --hypertension --json"],
      },
      {
        subcommand: "gdm",
        description: "Gestational diabetes screening — one-step IADPSG or two-step Carpenter-Coustan.",
        flags: [
          str("--strategy", "Screening strategy", true, { values: ["one-step", "two-step"] }),
          num("--fasting", "Fasting glucose in mg/dL", true),
          num("--1h", "1-hour glucose in mg/dL", true),
          num("--2h", "2-hour glucose in mg/dL", true),
          num("--3h", "3-hour glucose in mg/dL (two-step only)"),
        ],
        examples: [
          "medprotocol diabetes gdm --strategy one-step --fasting 95 --1h 185 --2h 160 --json",
        ],
      },
    ],
  },
];

/** Every calculation as a flat list of addressable invocations. */
export const calculationCount = (): number =>
  CATALOG.reduce((total, entry) => total + entry.calculations.length, 0);

export const findCommand = (command: string): CommandEntry | undefined =>
  CATALOG.find((entry) => entry.command === command);
