import { parseArgs } from "node:util";
import {
  calculateTotalSOFA,
  calculateSOFADelta,
  getSOFASeverityLevel,
  getSOFASeverity,
  assessSepsis,
  assessSepticShock,
  hasVasopressors,
  calculateQSOFA,
  isQSOFAPositive,
  calculateLactateClearance,
  isLactateClearanceAdequate,
} from "../lib/sepsis.ts";
import { assessBundleCompliance } from "../lib/sepsis.ts";
import { formatHeader, formatTable, printResult, formatError } from "../lib/format.ts";

const USAGE = `Usage: medprotocol sepsis <sub-command> [options]

Sub-commands:
  sofa         SOFA score (Sepsis-3 organ dysfunction)
  qsofa        Quick SOFA screening
  lactate      Lactate clearance calculation
  bundle       Hour-1 bundle compliance

SOFA options:
  --pao2 <number>            PaO2 mmHg
  --fio2 <number>            FiO2 percentage (21-100)
  --ventilation              On mechanical ventilation
  --platelets <number>       Platelet count (×10³/µL)
  --bilirubin <number>       Bilirubin (mg/dL)
  --map <number>             Mean arterial pressure (mmHg)
  --dopamine <number>        Dopamine dose (µg/kg/min)
  --dobutamine <number>      Dobutamine dose (µg/kg/min)
  --epinephrine <number>     Epinephrine dose (µg/kg/min)
  --norepinephrine <number>  Norepinephrine dose (µg/kg/min)
  --gcs <number>             Glasgow Coma Scale (3-15)
  --creatinine <number>      Creatinine (mg/dL)
  --urine-output <number>    Urine output (mL)
  --weight <number>          Patient weight (kg)
  --hours <number>           Hours for urine output (default: 24)
  --baseline <number>        Baseline SOFA score (default: 0)
  --infection                Suspected infection
  --lactate <number>         Lactate level (mmol/L)

qSOFA options:
  --rr <number>              Respiratory rate (required)
  --sbp <number>             Systolic blood pressure (required)
  --gcs <number>             Glasgow Coma Scale (required)

Lactate options:
  --initial <number>         Initial lactate (required)
  --repeat <number>          Repeat lactate (required)

Bundle options:
  --lactate-measured         Lactate measured
  --cultures                 Blood cultures obtained before antibiotics
  --antibiotics              Broad-spectrum antibiotics given
  --fluids                   30 mL/kg crystalloid bolus given
  --vasopressors             Vasopressors started (for hypotension/lactate ≥4)
  --elapsed <number>         Minutes since bundle start (omit if not started)

Global options:
  --json                     Output as JSON
  --help                     Show this help

Examples:
  medprotocol sepsis sofa --pao2 80 --fio2 40 --platelets 90 --gcs 13 --creatinine 2.5
  medprotocol sepsis sofa --pao2 60 --fio2 80 --ventilation --platelets 40 --infection --lactate 4
  medprotocol sepsis qsofa --rr 24 --sbp 90 --gcs 13
  medprotocol sepsis lactate --initial 4.2 --repeat 2.1
  medprotocol sepsis bundle --lactate-measured --cultures --antibiotics --fluids --vasopressors --elapsed 45`;

const runSOFA = (argv: string[], json: boolean): void => {
  const { values } = parseArgs({
    args: argv,
    options: {
      pao2: { type: "string", default: "" },
      fio2: { type: "string", default: "" },
      ventilation: { type: "boolean", default: false },
      platelets: { type: "string", default: "" },
      bilirubin: { type: "string", default: "" },
      map: { type: "string", default: "" },
      dopamine: { type: "string", default: "" },
      dobutamine: { type: "string", default: "" },
      epinephrine: { type: "string", default: "" },
      norepinephrine: { type: "string", default: "" },
      gcs: { type: "string", default: "" },
      creatinine: { type: "string", default: "" },
      "urine-output": { type: "string", default: "" },
      weight: { type: "string", default: "" },
      hours: { type: "string", default: "24" },
      baseline: { type: "string", default: "0" },
      infection: { type: "boolean", default: false },
      lactate: { type: "string", default: "" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  const reading = {
    paO2: values.pao2!,
    fiO2: values.fio2!,
    onVentilation: values.ventilation!,
    platelets: values.platelets!,
    bilirubin: values.bilirubin!,
    map: values.map!,
    dopamine: values.dopamine!,
    dobutamine: values.dobutamine!,
    epinephrine: values.epinephrine!,
    norepinephrine: values.norepinephrine!,
    gcs: values.gcs!,
    creatinine: values.creatinine!,
    urineOutput: values["urine-output"]!,
  };

  const score = calculateTotalSOFA(reading, values.weight!, values.hours!);
  const delta = calculateSOFADelta(score, values.baseline!);
  const severityLevel = getSOFASeverityLevel(score);
  const severity = getSOFASeverity(score);

  const data: Record<string, unknown> = {
    score,
    delta,
    severityLevel,
    severity,
    baseline: parseFloat(values.baseline!) || 0,
  };

  const rows: [string, string][] = [
    ["SOFA Score", `${score}/24`],
    ["Delta", `${delta >= 0 ? "+" : ""}${delta}`],
    ["Severity", severityLevel],
  ];

  if (values.infection) {
    const isSepsis = assessSepsis(score, delta, true);
    data.sepsis = isSepsis;
    rows.push(["Sepsis", isSepsis ? "Yes" : "No"]);

    if (isSepsis && values.lactate !== "") {
      const vasopressorsNeeded = hasVasopressors(
        values.dopamine!,
        values.dobutamine!,
        values.epinephrine!,
        values.norepinephrine!,
      );
      const septicShock = assessSepticShock(true, vasopressorsNeeded, values.lactate!);
      data.septicShock = septicShock;
      data.lactate = parseFloat(values.lactate!);
      rows.push(["Lactate", `${values.lactate} mmol/L`]);
      rows.push(["Septic Shock", septicShock ? "Yes" : "No"]);
    }
  }

  printResult(data, json, () => {
    return [formatHeader("SOFA Score (Sepsis-3)"), formatTable(rows)].join("\n");
  });
};

const runQSOFA = (argv: string[], json: boolean): void => {
  const { values } = parseArgs({
    args: argv,
    options: {
      rr: { type: "string" },
      sbp: { type: "string" },
      gcs: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  const missing: string[] = [];
  if (!values.rr) missing.push("--rr");
  if (!values.sbp) missing.push("--sbp");
  if (!values.gcs) missing.push("--gcs");

  if (missing.length > 0) {
    process.stderr.write(
      formatError(`Missing required flags: ${missing.join(", ")}`) + "\n\n" + USAGE + "\n",
    );
    process.exitCode = 1;
    return;
  }

  const score = calculateQSOFA(values.rr!, values.sbp!, values.gcs!);
  const positive = isQSOFAPositive(score);

  const data = {
    score,
    positive,
    rr: parseFloat(values.rr!),
    sbp: parseFloat(values.sbp!),
    gcs: parseFloat(values.gcs!),
  };

  printResult(data, json, () => {
    return [
      formatHeader("Quick SOFA (qSOFA)"),
      formatTable([
        ["Score", `${score}/3`],
        ["Positive", positive ? "Yes" : "No"],
        ["Respiratory Rate", values.rr!],
        ["Systolic BP", `${values.sbp} mmHg`],
        ["GCS", values.gcs!],
      ]),
    ].join("\n");
  });
};

const runLactate = (argv: string[], json: boolean): void => {
  const { values } = parseArgs({
    args: argv,
    options: {
      initial: { type: "string" },
      repeat: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  const missing: string[] = [];
  if (!values.initial) missing.push("--initial");
  if (!values.repeat) missing.push("--repeat");

  if (missing.length > 0) {
    process.stderr.write(
      formatError(`Missing required flags: ${missing.join(", ")}`) + "\n\n" + USAGE + "\n",
    );
    process.exitCode = 1;
    return;
  }

  const clearance = calculateLactateClearance(values.initial!, values.repeat!);
  const adequate = isLactateClearanceAdequate(clearance);

  const data: Record<string, unknown> = {
    initial: parseFloat(values.initial!),
    repeat: parseFloat(values.repeat!),
    clearance: clearance ? parseFloat(clearance) : null,
    adequate,
  };

  printResult(data, json, () => {
    return [
      formatHeader("Lactate Clearance"),
      formatTable([
        ["Initial", `${values.initial} mmol/L`],
        ["Repeat", `${values.repeat} mmol/L`],
        ["Clearance", clearance ? `${clearance}%` : "N/A"],
        ["Adequate", adequate ? "Yes" : "No"],
      ]),
    ].join("\n");
  });
};

const runBundle = (argv: string[], json: boolean): void => {
  const { values } = parseArgs({
    args: argv,
    options: {
      "lactate-measured": { type: "boolean", default: false },
      cultures: { type: "boolean", default: false },
      antibiotics: { type: "boolean", default: false },
      fluids: { type: "boolean", default: false },
      vasopressors: { type: "boolean", default: false },
      elapsed: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  let elapsedMinutes: number | null = null;
  if (values.elapsed !== undefined) {
    const parsed = parseFloat(values.elapsed);
    if (isNaN(parsed) || parsed < 0) {
      process.stderr.write(
        formatError("--elapsed must be a non-negative number of minutes") + "\n",
      );
      process.exitCode = 1;
      return;
    }
    elapsedMinutes = parsed;
  }

  const items = {
    lactateMeasured: values["lactate-measured"]!,
    bloodCulturesObtained: values.cultures!,
    antibioticsGiven: values.antibiotics!,
    fluidBolusGiven: values.fluids!,
    vasopressorsStarted: values.vasopressors!,
  };

  // assessBundleCompliance works in seconds. Anchor the start at a non-zero
  // epoch (0 reads as "not started" in the lib) and derive "now" from --elapsed.
  const BUNDLE_START = 1;
  const compliance = assessBundleCompliance(
    { ...items, bundleStartTime: elapsedMinutes === null ? null : BUNDLE_START },
    elapsedMinutes === null ? BUNDLE_START : BUNDLE_START + elapsedMinutes * 60,
  );

  const data = { ...items, elapsedMinutes, ...compliance };

  printResult(data, json, () => {
    const yesNo = (done: boolean) => (done ? "Done" : "Pending");
    const rows: [string, string][] = [
      ["Lactate measured", yesNo(items.lactateMeasured)],
      ["Blood cultures", yesNo(items.bloodCulturesObtained)],
      ["Antibiotics", yesNo(items.antibioticsGiven)],
      ["Fluid bolus", yesNo(items.fluidBolusGiven)],
      ["Vasopressors", yesNo(items.vasopressorsStarted)],
      [
        "Elapsed",
        elapsedMinutes === null ? "Bundle not started" : `${elapsedMinutes} min`,
      ],
      ["All items done", compliance.allItemsDone ? "Yes" : "No"],
      ["Within 60 min", compliance.withinTimeLimit ? "Yes" : "No"],
      ["Bundle complete", compliance.complete ? "Yes" : "No"],
    ];
    return [
      formatHeader("Sepsis Hour-1 Bundle"),
      formatTable(rows),
    ].join("\n");
  });
};

export const run = (argv: string[]): void => {
  const subcommand = argv[0];
  const subArgs = argv.slice(1);

  const json = subArgs.includes("--json");

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    process.stdout.write(USAGE + "\n");
    return;
  }

  switch (subcommand) {
    case "sofa":
      runSOFA(subArgs, json);
      break;
    case "qsofa":
      runQSOFA(subArgs, json);
      break;
    case "bundle":
      runBundle(subArgs, json);
      break;
    case "lactate":
      runLactate(subArgs, json);
      break;
    default:
      process.stderr.write(
        formatError(`Unknown sub-command: ${subcommand}`) +
          "\n\nAvailable: sofa, qsofa, lactate, bundle\n",
      );
      process.exitCode = 1;
  }
};
