import { parseArgs } from "node:util";
import {
  classifyA1C,
  classifyFPG,
  classify2hPG,
  classifyRandomPG,
  getDiagnosis,
  checkConfirmation,
} from "../lib/diabetes-dx.ts";
import {
  classifyT1DStage,
  classifyT1vsT2,
  getT2DScreeningRecommendation,
  classifyGDM_OneStep,
  classifyGDM_TwoStep,
} from "../lib/endocrine.ts";
import { formatHeader, formatTable, printResult, formatError } from "../lib/format.ts";

const USAGE = `Usage: medprotocol diabetes <sub-command> [options]

Sub-commands:
  diagnose     Diabetes diagnosis classifier (ADA Table 2.1/2.2)
  t1d-stage    T1D staging (ADA Table 2.4)
  t1-vs-t2     T1 vs T2 classification (AABBCC mnemonic)
  t2d-screen   T2D screening eligibility (ADA Table 2.5)
  gdm          GDM screening (one-step IADPSG / two-step Carpenter-Coustan)
  confirm      Confirm diagnosis across repeat readings (ADA confirmation rule)

Diagnose options:
  --a1c <number>          A1C percentage
  --fpg <number>          Fasting plasma glucose (mg/dL)
  --2h-pg <number>        2-hour plasma glucose (mg/dL)
  --random-pg <number>    Random plasma glucose (mg/dL)
  --symptoms              Classic hyperglycemic symptoms present

T1D Stage options:
  --autoantibodies <number>  Number of islet autoantibodies (required)
  --fpg <number>             Fasting plasma glucose (mg/dL)
  --2h-pg <number>           2-hour plasma glucose (mg/dL)
  --a1c <number>             A1C percentage
  --symptoms                 Symptomatic

T1 vs T2 options:
  --age <number>          Age at onset (required)
  --bmi <number>          BMI (required)
  --autoantibodies        Has islet autoantibodies
  --c-peptide <number>    C-peptide (pmol/L)
  --fhx-t1d               Family history of T1D
  --fhx-t2d               Family history of T2D
  --dka-history            History of DKA
  --autoimmune             Other autoimmune conditions
  --on-insulin             Currently on insulin

T2D Screen options:
  --age <number>          Age (required)
  --bmi <number>          BMI (required)
  --ethnicity <string>    Ethnicity (default: other)
  --first-degree           First-degree relative with diabetes
  --high-risk-ethnicity    High-risk ethnicity
  --cvd                    CVD history
  --hypertension           Hypertension
  --dyslipidemia           Dyslipidemia
  --pcos                   PCOS
  --inactive               Physical inactivity
  --insulin-resistance     Signs of insulin resistance
  --prior-prediabetes      Prior prediabetes
  --prior-gdm              Prior GDM

GDM options:
  --strategy <one-step|two-step>  Screening strategy (required)
  --fasting <number>              Fasting glucose mg/dL (required)
  --1h <number>                   1-hour glucose mg/dL (required)
  --2h <number>                   2-hour glucose mg/dL (required)
  --3h <number>                   3-hour glucose mg/dL (two-step only)

Confirm options:
  --readings <json>       Repeat readings JSON array, e.g.
                          '[{"a1c":"6.8"},{"fpg":"140"}]' (required, 2+ entries)
                          Keys: a1c, fpg, twohPG, randomPG
  --symptoms              Classic hyperglycemic symptoms present

Global options:
  --json                   Output as JSON
  --help                   Show this help

Examples:
  medprotocol diabetes diagnose --a1c 6.8 --fpg 130
  medprotocol diabetes t1d-stage --autoantibodies 3 --a1c 5.9
  medprotocol diabetes t1-vs-t2 --age 25 --bmi 22 --autoantibodies --c-peptide 150
  medprotocol diabetes t2d-screen --age 40 --bmi 28 --hypertension
  medprotocol diabetes gdm --strategy one-step --fasting 95 --1h 185 --2h 160
  medprotocol diabetes confirm --readings '[{"a1c":"6.8"},{"fpg":"140"}]'`;

const runDiagnose = (argv: string[], json: boolean): void => {
  const { values } = parseArgs({
    args: argv,
    options: {
      a1c: { type: "string", default: "" },
      fpg: { type: "string", default: "" },
      "2h-pg": { type: "string", default: "" },
      "random-pg": { type: "string", default: "" },
      symptoms: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  const a1c = values.a1c!;
  const fpg = values.fpg!;
  const twohPG = values["2h-pg"]!;
  const randomPG = values["random-pg"]!;
  const hasSymptoms = values.symptoms!;

  if (!a1c && !fpg && !twohPG && !randomPG) {
    process.stderr.write(
      formatError("At least one test value required (--a1c, --fpg, --2h-pg, or --random-pg)") +
        "\n\n" +
        USAGE +
        "\n",
    );
    process.exitCode = 1;
    return;
  }

  const diagnosis = getDiagnosis(a1c, fpg, twohPG, randomPG, hasSymptoms);
  const rows: [string, string][] = [];

  if (a1c) {
    const cls = classifyA1C(a1c);
    rows.push(["A1C", `${a1c}% — ${cls.label}`]);
  }
  if (fpg) {
    const cls = classifyFPG(fpg);
    rows.push(["FPG", `${fpg} mg/dL — ${cls.label}`]);
  }
  if (twohPG) {
    const cls = classify2hPG(twohPG);
    rows.push(["2h-PG", `${twohPG} mg/dL — ${cls.label}`]);
  }
  if (randomPG) {
    const cls = classifyRandomPG(randomPG, hasSymptoms);
    rows.push(["Random PG", `${randomPG} mg/dL — ${cls.label}`]);
  }

  rows.push(["Diagnosis", diagnosis.label]);
  rows.push(["Category", diagnosis.category]);

  const data = {
    a1c: a1c ? parseFloat(a1c) : null,
    fpg: fpg ? parseFloat(fpg) : null,
    twohPG: twohPG ? parseFloat(twohPG) : null,
    randomPG: randomPG ? parseFloat(randomPG) : null,
    hasSymptoms,
    diagnosis: diagnosis.label,
    category: diagnosis.category,
  };

  printResult(data, json, () => {
    return [formatHeader("Diabetes Diagnosis (ADA 2026)"), formatTable(rows)].join("\n");
  });
};

const runT1DStage = (argv: string[], json: boolean): void => {
  const { values } = parseArgs({
    args: argv,
    options: {
      autoantibodies: { type: "string" },
      fpg: { type: "string", default: "" },
      "2h-pg": { type: "string", default: "" },
      a1c: { type: "string", default: "" },
      symptoms: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  if (!values.autoantibodies) {
    process.stderr.write(
      formatError("--autoantibodies is required") + "\n\n" + USAGE + "\n",
    );
    process.exitCode = 1;
    return;
  }

  const result = classifyT1DStage(
    values.autoantibodies!,
    values.fpg!,
    values["2h-pg"]!,
    values.a1c!,
    values.symptoms!,
  );

  const rows: [string, string][] = [
    ["Autoantibodies", values.autoantibodies!],
    ["Stage", `${result.stage}`],
    ["Classification", result.label],
    ["Severity", result.severity],
  ];
  if (values.fpg) rows.push(["FPG", `${values.fpg} mg/dL`]);
  if (values["2h-pg"]) rows.push(["2h-PG", `${values["2h-pg"]} mg/dL`]);
  if (values.a1c) rows.push(["A1C", `${values.a1c}%`]);

  const data = {
    autoantibodyCount: parseInt(values.autoantibodies!, 10),
    stage: result.stage,
    classification: result.label,
    severity: result.severity,
  };

  printResult(data, json, () => {
    return [formatHeader("T1D Staging (ADA Table 2.4)"), formatTable(rows)].join("\n");
  });
};

const runT1vsT2 = (argv: string[], json: boolean): void => {
  const { values } = parseArgs({
    args: argv,
    options: {
      age: { type: "string" },
      bmi: { type: "string" },
      autoantibodies: { type: "boolean", default: false },
      "c-peptide": { type: "string", default: "0" },
      "fhx-t1d": { type: "boolean", default: false },
      "fhx-t2d": { type: "boolean", default: false },
      "dka-history": { type: "boolean", default: false },
      autoimmune: { type: "boolean", default: false },
      "on-insulin": { type: "boolean", default: false },
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
  if (!values.bmi) missing.push("--bmi");

  if (missing.length > 0) {
    process.stderr.write(
      formatError(`Missing required flags: ${missing.join(", ")}`) + "\n\n" + USAGE + "\n",
    );
    process.exitCode = 1;
    return;
  }

  const result = classifyT1vsT2(
    values.age!,
    values.bmi!,
    values.autoantibodies!,
    values["c-peptide"]!,
    values["fhx-t1d"]!,
    values["fhx-t2d"]!,
    values["dka-history"]!,
    values.autoimmune!,
    values["on-insulin"]!,
  );

  const rows: [string, string][] = [
    ["Classification", result.classification],
    ["Severity", result.severity],
    ["T1 Features", result.features.t1.join(", ") || "None"],
    ["T2 Features", result.features.t2.join(", ") || "None"],
  ];

  const data = {
    classification: result.classification,
    severity: result.severity,
    features: result.features,
    inputs: {
      age: parseFloat(values.age!),
      bmi: parseFloat(values.bmi!),
      autoantibodies: values.autoantibodies!,
      cPeptide: parseFloat(values["c-peptide"]!),
    },
  };

  printResult(data, json, () => {
    return [formatHeader("T1 vs T2 Classification (AABBCC)"), formatTable(rows)].join("\n");
  });
};

const runT2DScreen = (argv: string[], json: boolean): void => {
  const { values } = parseArgs({
    args: argv,
    options: {
      age: { type: "string" },
      bmi: { type: "string" },
      ethnicity: { type: "string", default: "other" },
      "first-degree": { type: "boolean", default: false },
      "high-risk-ethnicity": { type: "boolean", default: false },
      cvd: { type: "boolean", default: false },
      hypertension: { type: "boolean", default: false },
      dyslipidemia: { type: "boolean", default: false },
      pcos: { type: "boolean", default: false },
      inactive: { type: "boolean", default: false },
      "insulin-resistance": { type: "boolean", default: false },
      "prior-prediabetes": { type: "boolean", default: false },
      "prior-gdm": { type: "boolean", default: false },
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
  if (!values.bmi) missing.push("--bmi");

  if (missing.length > 0) {
    process.stderr.write(
      formatError(`Missing required flags: ${missing.join(", ")}`) + "\n\n" + USAGE + "\n",
    );
    process.exitCode = 1;
    return;
  }

  const riskFactors: Record<string, boolean> = {
    firstDegreeRelative: values["first-degree"]!,
    highRiskEthnicity: values["high-risk-ethnicity"]!,
    cvdHistory: values.cvd!,
    hypertension: values.hypertension!,
    dyslipidemia: values.dyslipidemia!,
    pcos: values.pcos!,
    physicalInactivity: values.inactive!,
    insulinResistanceSigns: values["insulin-resistance"]!,
    priorPrediabetes: values["prior-prediabetes"]!,
    priorGDM: values["prior-gdm"]!,
  };

  const result = getT2DScreeningRecommendation(
    values.age!,
    values.bmi!,
    values.ethnicity!,
    riskFactors,
  );

  const activeFactors = Object.entries(riskFactors)
    .filter(([, v]) => v)
    .map(([k]) => k);

  const rows: [string, string][] = [
    ["Action", result.action],
    ["Interval", result.interval],
    ["Severity", result.severity],
    ["Risk Factors", `${result.riskFactorCount} (${activeFactors.join(", ") || "none"})`],
    ["Age", values.age!],
    ["BMI", values.bmi!],
    ["Ethnicity", values.ethnicity!],
  ];

  const data = {
    action: result.action,
    interval: result.interval,
    severity: result.severity,
    riskFactorCount: result.riskFactorCount,
    riskFactors: activeFactors,
    inputs: {
      age: parseFloat(values.age!),
      bmi: parseFloat(values.bmi!),
      ethnicity: values.ethnicity!,
    },
  };

  printResult(data, json, () => {
    return [formatHeader("T2D Screening (ADA Table 2.5)"), formatTable(rows)].join("\n");
  });
};

const runGDM = (argv: string[], json: boolean): void => {
  const { values } = parseArgs({
    args: argv,
    options: {
      strategy: { type: "string" },
      fasting: { type: "string" },
      "1h": { type: "string" },
      "2h": { type: "string" },
      "3h": { type: "string", default: "0" },
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
  if (!values.strategy) missing.push("--strategy");
  if (!values.fasting) missing.push("--fasting");
  if (!values["1h"]) missing.push("--1h");
  if (!values["2h"]) missing.push("--2h");

  if (values.strategy === "two-step" && !values["3h"]) {
    missing.push("--3h");
  }

  if (missing.length > 0) {
    process.stderr.write(
      formatError(`Missing required flags: ${missing.join(", ")}`) + "\n\n" + USAGE + "\n",
    );
    process.exitCode = 1;
    return;
  }

  const strategy = values.strategy as "one-step" | "two-step";

  const result =
    strategy === "one-step"
      ? classifyGDM_OneStep(values.fasting!, values["1h"]!, values["2h"]!)
      : classifyGDM_TwoStep(values.fasting!, values["1h"]!, values["2h"]!, values["3h"]!);

  const rows: [string, string][] = [
    ["Strategy", strategy === "one-step" ? "One-step (IADPSG)" : "Two-step (Carpenter-Coustan)"],
    ["Result", result.positive ? "GDM Positive" : "GDM Negative"],
    ["Exceeded", result.exceededCount > 0 ? result.exceededValues.join(", ") : "None"],
    ["Fasting", `${values.fasting} mg/dL`],
    ["1-hour", `${values["1h"]} mg/dL`],
    ["2-hour", `${values["2h"]} mg/dL`],
  ];

  if (strategy === "two-step") {
    rows.push(["3-hour", `${values["3h"]} mg/dL`]);
  }

  const data = {
    strategy,
    positive: result.positive,
    exceededValues: result.exceededValues,
    exceededCount: result.exceededCount,
    inputs: {
      fasting: parseFloat(values.fasting!),
      oneHour: parseFloat(values["1h"]!),
      twoHour: parseFloat(values["2h"]!),
      threeHour: strategy === "two-step" ? parseFloat(values["3h"]!) : null,
    },
  };

  printResult(data, json, () => {
    return [
      formatHeader(`GDM Screening — ${strategy === "one-step" ? "IADPSG" : "Carpenter-Coustan"}`),
      formatTable(rows),
    ].join("\n");
  });
};

const runConfirm = (argv: string[], json: boolean): void => {
  const { values } = parseArgs({
    args: argv,
    options: {
      readings: { type: "string" },
      symptoms: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  if (!values.readings) {
    process.stderr.write(
      formatError("Missing required flags: --readings") + "\n\n" + USAGE + "\n",
    );
    process.exitCode = 1;
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(values.readings);
  } catch {
    process.stderr.write(formatError("--readings must be valid JSON") + "\n");
    process.exitCode = 1;
    return;
  }

  if (!Array.isArray(parsed) || parsed.length < 2) {
    process.stderr.write(
      formatError("--readings must be a JSON array with at least 2 readings") + "\n",
    );
    process.exitCode = 1;
    return;
  }

  const readings = parsed.map((r) => {
    const entry = (r ?? {}) as Record<string, unknown>;
    const str = (key: string) =>
      entry[key] === undefined || entry[key] === null ? "" : String(entry[key]);
    return {
      a1c: str("a1c"),
      fpg: str("fpg"),
      twohPG: str("twohPG"),
      randomPG: str("randomPG"),
    };
  });

  const result = checkConfirmation(readings, values.symptoms!);

  const data = {
    confirmed: result.confirmed,
    method: result.method,
    readingCount: readings.length,
    hasSymptoms: values.symptoms!,
  };

  printResult(data, json, () => {
    const rows: [string, string][] = [
      ["Readings", String(readings.length)],
      ["Symptoms", values.symptoms ? "Yes" : "No"],
      ["Confirmed", result.confirmed ? "Yes" : "No"],
      ["Method", result.method || "—"],
    ];
    return [
      formatHeader("Diabetes Diagnosis Confirmation"),
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
    case "diagnose":
      runDiagnose(subArgs, json);
      break;
    case "t1d-stage":
      runT1DStage(subArgs, json);
      break;
    case "t1-vs-t2":
      runT1vsT2(subArgs, json);
      break;
    case "t2d-screen":
      runT2DScreen(subArgs, json);
      break;
    case "confirm":
      runConfirm(subArgs, json);
      break;
    case "gdm":
      runGDM(subArgs, json);
      break;
    default:
      process.stderr.write(
        formatError(`Unknown sub-command: ${subcommand}`) +
          "\n\nAvailable: diagnose, t1d-stage, t1-vs-t2, t2d-screen, gdm, confirm\n",
      );
      process.exitCode = 1;
  }
};
