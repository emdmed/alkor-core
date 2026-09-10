import { parseArgs } from "node:util";
import {
  calculateASCVD,
  getASCVDCategory,
  getASCVDSeverity,
  calculateHEARTScore,
  getHEARTCategory,
  getHEARTAction,
  getHEARTSeverity,
  calculateCHADSVASc,
  getCHADSVAScCategory,
  getCHADSVAScAction,
  getCHADSVAScSeverity,
} from "../lib/cardiology.ts";
import type {
  ASCVDInputs,
  HEARTInputs,
  CHADSVAScInputs,
} from "../lib/cardiology-types.ts";
import { formatHeader, formatTable, printResult, formatError } from "../lib/format.ts";

const USAGE = `Usage: medprotocol cardiology <sub-command> [options]

Sub-commands:
  ascvd        10-year ASCVD risk (Pooled Cohort Equations)
  heart        HEART Score for chest pain triage
  chadsvasc    CHA₂DS₂-VASc stroke risk in atrial fibrillation

ASCVD options:
  --age <number>           Age 40-79 (required)
  --sex <male|female>      Sex (required)
  --race <white|aa|other>  Race (default: white)
  --tc <number>            Total cholesterol mg/dL (required)
  --hdl <number>           HDL cholesterol mg/dL (required)
  --sbp <number>           Systolic BP mmHg (required)
  --bp-treatment           On BP treatment
  --diabetes               Has diabetes
  --smoker                 Current smoker

HEART options:
  --history <0|1|2>        History suspicion (required)
  --ecg <0|1|2>            ECG findings (required)
  --age <0|1|2>            Age category (required)
  --risk-factors <0|1|2>   Risk factors (required)
  --troponin <0|1|2>       Troponin level (required)

CHA₂DS₂-VASc options:
  --chf                    CHF / LV dysfunction (+1)
  --hypertension           Hypertension (+1)
  --age75                  Age ≥ 75 (+2)
  --diabetes               Diabetes (+1)
  --stroke                 Stroke/TIA/TE (+2)
  --vascular               Vascular disease (+1)
  --age65                  Age 65-74 (+1)
  --female                 Female sex (+1)

Global options:
  --json                   Output as JSON
  --help                   Show this help

Examples:
  medprotocol cardiology ascvd --age 55 --sex male --tc 213 --hdl 50 --sbp 120
  medprotocol cardiology heart --history 1 --ecg 0 --age 2 --risk-factors 1 --troponin 0
  medprotocol cardiology chadsvasc --hypertension --age75 --diabetes`;

const runASCVD = (argv: string[], json: boolean): void => {
  const { values } = parseArgs({
    args: argv,
    options: {
      age: { type: "string" },
      sex: { type: "string" },
      race: { type: "string", default: "white" },
      tc: { type: "string" },
      hdl: { type: "string" },
      sbp: { type: "string" },
      "bp-treatment": { type: "boolean", default: false },
      diabetes: { type: "boolean", default: false },
      smoker: { type: "boolean", default: false },
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
  if (!values.age) missing.push("--age");
  if (!values.sex) missing.push("--sex");
  if (!values.tc) missing.push("--tc");
  if (!values.hdl) missing.push("--hdl");
  if (!values.sbp) missing.push("--sbp");

  if (missing.length > 0) {
    process.stderr.write(
      formatError(`Missing required flags: ${missing.join(", ")}`) + "\n\n" + USAGE + "\n",
    );
    process.exitCode = 1;
    return;
  }

  const inputs: ASCVDInputs = {
    age: values.age!,
    sex: values.sex as "male" | "female",
    race: (values.race || "white") as "white" | "aa" | "other",
    totalCholesterol: values.tc!,
    hdlCholesterol: values.hdl!,
    systolicBP: values.sbp!,
    bpTreatment: values["bp-treatment"]!,
    diabetes: values.diabetes!,
    smoker: values.smoker!,
  };

  const risk = calculateASCVD(inputs);

  if (!risk) {
    process.stderr.write(formatError("Could not calculate ASCVD risk — check input values (age 40-79, cholesterol/BP > 0)") + "\n");
    process.exitCode = 1;
    return;
  }

  const category = getASCVDCategory(risk);
  const severity = getASCVDSeverity(risk);

  const data = {
    risk: parseFloat(risk),
    category,
    severity,
    inputs: {
      age: parseFloat(inputs.age),
      sex: inputs.sex,
      race: inputs.race,
      totalCholesterol: parseFloat(inputs.totalCholesterol),
      hdlCholesterol: parseFloat(inputs.hdlCholesterol),
      systolicBP: parseFloat(inputs.systolicBP),
      bpTreatment: inputs.bpTreatment,
      diabetes: inputs.diabetes,
      smoker: inputs.smoker,
    },
  };

  printResult(data, json, () => {
    return [
      formatHeader("ASCVD 10-Year Risk"),
      formatTable([
        ["Risk", `${risk}%`],
        ["Category", category],
        ["Severity", severity],
        ["Age", inputs.age],
        ["Sex", inputs.sex],
        ["Race", inputs.race],
        ["Total Cholesterol", `${inputs.totalCholesterol} mg/dL`],
        ["HDL Cholesterol", `${inputs.hdlCholesterol} mg/dL`],
        ["Systolic BP", `${inputs.systolicBP} mmHg`],
        ["BP Treatment", inputs.bpTreatment ? "Yes" : "No"],
        ["Diabetes", inputs.diabetes ? "Yes" : "No"],
        ["Smoker", inputs.smoker ? "Yes" : "No"],
      ]),
    ].join("\n");
  });
};

const runHEART = (argv: string[], json: boolean): void => {
  const { values } = parseArgs({
    args: argv,
    options: {
      history: { type: "string" },
      ecg: { type: "string" },
      age: { type: "string" },
      "risk-factors": { type: "string" },
      troponin: { type: "string" },
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
  if (!values.history) missing.push("--history");
  if (!values.ecg) missing.push("--ecg");
  if (!values.age) missing.push("--age");
  if (!values["risk-factors"]) missing.push("--risk-factors");
  if (!values.troponin) missing.push("--troponin");

  if (missing.length > 0) {
    process.stderr.write(
      formatError(`Missing required flags: ${missing.join(", ")}`) + "\n\n" + USAGE + "\n",
    );
    process.exitCode = 1;
    return;
  }

  const parseScore = (v: string): 0 | 1 | 2 => {
    const n = parseInt(v, 10);
    if (n === 0 || n === 1 || n === 2) return n;
    return 0;
  };

  const inputs: HEARTInputs = {
    history: parseScore(values.history!),
    ecg: parseScore(values.ecg!),
    age: parseScore(values.age!),
    riskFactors: parseScore(values["risk-factors"]!),
    troponin: parseScore(values.troponin!),
  };

  const score = calculateHEARTScore(inputs);
  const category = getHEARTCategory(score);
  const action = getHEARTAction(score);
  const severity = getHEARTSeverity(score);

  const data = {
    score,
    category,
    action,
    severity,
    inputs,
  };

  printResult(data, json, () => {
    return [
      formatHeader("HEART Score"),
      formatTable([
        ["Score", `${score}/10`],
        ["Category", category],
        ["Action", action],
        ["History", `${inputs.history}`],
        ["ECG", `${inputs.ecg}`],
        ["Age", `${inputs.age}`],
        ["Risk Factors", `${inputs.riskFactors}`],
        ["Troponin", `${inputs.troponin}`],
      ]),
    ].join("\n");
  });
};

const runCHADSVASc = (argv: string[], json: boolean): void => {
  const { values } = parseArgs({
    args: argv,
    options: {
      chf: { type: "boolean", default: false },
      hypertension: { type: "boolean", default: false },
      age75: { type: "boolean", default: false },
      diabetes: { type: "boolean", default: false },
      stroke: { type: "boolean", default: false },
      vascular: { type: "boolean", default: false },
      age65: { type: "boolean", default: false },
      female: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  const inputs: CHADSVAScInputs = {
    chf: values.chf!,
    hypertension: values.hypertension!,
    age75: values.age75!,
    diabetes: values.diabetes!,
    stroke: values.stroke!,
    vascularDisease: values.vascular!,
    age65: values.age65!,
    sexFemale: values.female!,
  };

  const score = calculateCHADSVASc(inputs);
  const category = getCHADSVAScCategory(score, inputs.sexFemale);
  const action = getCHADSVAScAction(score, inputs.sexFemale);
  const severity = getCHADSVAScSeverity(score, inputs.sexFemale);

  const data = {
    score,
    category,
    action,
    severity,
    inputs,
  };

  printResult(data, json, () => {
    const factors = Object.entries(inputs)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(", ");

    return [
      formatHeader("CHA₂DS₂-VASc Score"),
      formatTable([
        ["Score", `${score}/9`],
        ["Category", category],
        ["Action", action],
        ["Factors", factors || "None"],
      ]),
    ].join("\n");
  });
};

export const run = (argv: string[]): void => {
  const subcommand = argv[0];
  const subArgs = argv.slice(1);

  // Check for --json in the remaining args
  const json = subArgs.includes("--json");

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    process.stdout.write(USAGE + "\n");
    return;
  }

  switch (subcommand) {
    case "ascvd":
      runASCVD(subArgs, json);
      break;
    case "heart":
      runHEART(subArgs, json);
      break;
    case "chadsvasc":
      runCHADSVASc(subArgs, json);
      break;
    default:
      process.stderr.write(
        formatError(`Unknown sub-command: ${subcommand}`) +
          "\n\nAvailable: ascvd, heart, chadsvasc\n",
      );
      process.exitCode = 1;
  }
};
